/**
 * assistant-voice-opencode-plugin — server part (v0.0.1 stub).
 *
 * A thin shell over audioq.py: one `voice_speak` tool, plus opt-in auto-speak
 * on turn end. Auto-speak is off unless the project has .dev/audiomode.jsonc
 * and the plugin is not explicitly disabled with `auto: false`.
 *
 * The full design lives in PROPOSAL.md. Nothing here throws into a session:
 * every failure is logged and returned as tool content.
 */
import { spawn } from "node:child_process"
import {
  accessSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
  writeSync,
  constants as fsConstants,
} from "node:fs"
import path from "node:path"
import { Plugin } from "@opencode/plugin"
import {
  readState,
  resolveMutes,
  setAudio,
  setCache,
  setMute,
  setPurgeAttempt,
  setQueue,
  setGenerating,
  setLastAction,
  setSidebar,
  recordVoiceEvent,
  type VoiceStats,
} from "./state.ts"
import { Voice } from "./rpc.ts"

type Mode = "auto" | "host" | "client" | "remote"
type ResolvedMode = Exclude<Mode, "auto">

type Options = {
  mode?: Mode
  autoUnmute?: boolean
  speakSubagents?: boolean
  root?: string
  auto?: boolean
  maxChars?: number
  emptyNotice?: string
}

const DEFAULT_ROOT = "/media/share/opencode-audio-tool"
const DEFAULT_NOTICE = "{session} here: my last message was untranscribable, check the app"
const DEFAULT_MAX_CHARS = 2000

/**
 * `auto` decides from the machine: only a Linux box with an executable piper
 * binary is a host. macOS (and any box without piper) is a client that reads
 * the shared host stats.
 */
function resolveMode(requested: Mode, root: string): ResolvedMode {
  if (requested !== "auto") return requested
  if (process.platform !== "linux") return "client"
  const piper = path.join(root, "piper", "piper")
  try {
    accessSync(piper, fsConstants.X_OK)
    return "host"
  } catch {
    return "client"
  }
}

function log(message: string, detail?: unknown) {
  console.log(`[assistant-voice] ${message}`, detail === undefined ? "" : detail)
}

function run(
  cmd: string,
  args: string[],
  opts: { cwd?: string; timeoutMs?: number; input?: string } = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd: opts.cwd, stdio: ["pipe", "pipe", "pipe"] })
    let stdout = ""
    let stderr = ""
    child.stdout.on("data", (chunk) => (stdout += String(chunk)))
    child.stderr.on("data", (chunk) => (stderr += String(chunk)))
    child.stdin.on("error", () => {})
    if (opts.input !== undefined) child.stdin.write(opts.input)
    child.stdin.end()
    const timer = setTimeout(() => child.kill("SIGKILL"), opts.timeoutMs ?? 120_000)
    child.on("error", (error) => {
      clearTimeout(timer)
      resolve({ code: -1, stdout, stderr: String(error) })
    })
    child.on("close", (code) => {
      clearTimeout(timer)
      resolve({ code: code ?? -1, stdout, stderr })
    })
  })
}

function splitIdentifier(value: string): string {
  return value
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
}

/**
 * Turn markdown into something worth hearing: no fences, no inline code, no
 * URLs, paths, tables or hashes. Sentences left with almost nothing are
 * dropped rather than read as fragments.
 */
export function sanitise(input: string): string {
  let text = input
  text = text.replace(/```[\s\S]*?```/g, " ")
  text = text.replace(/`([^`]*)`/g, (_match, code: string) =>
    /^[A-Za-z0-9_./-]{1,40}$/.test(code) ? ` ${splitIdentifier(code)} ` : " ",
  )
  text = text.replace(/https?:\/\/\S+/g, " ")
  text = text.replace(/\b[0-9a-f]{7,40}\b/gi, " ")
  text = text.replace(/(^|\s)\/\S+/g, " ")
  text = text.replace(/^\s*\|.*\|\s*$/gm, " ")
  text = text.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
  text = text.replace(/[*_#>~]/g, " ")
  text = text.replace(/->/g, " to ").replace(/>=/g, " at least ").replace(/&&/g, " and ")

  const sentences = text.split(/(?<=[.!?])\s+/)
  const kept = sentences.filter((sentence) => {
    const trimmed = sentence.trim()
    if (!trimmed) return false
    const words = trimmed.split(/\s+/).filter(Boolean)
    return words.length >= 2
  })
  return kept.join(" ").replace(/\s+/g, " ").trim()
}

async function sessionTitle(root: string, sessionID: string | undefined): Promise<string | null> {
  if (!sessionID) return null
  const script = [
    "import os,sqlite3,sys",
    "sid=sys.argv[1]",
    "db=os.path.expanduser('~/.local/share/opencode/opencode.db')",
    "if not os.path.exists(db): sys.exit(0)",
    "con=sqlite3.connect('file:%s?mode=ro' % db, uri=True, timeout=0.25)",
    "row=con.execute('select title from session_v2 where id = ?', (sid,)).fetchone()",
    "print((row[0] or '').strip() if row else '')",
  ].join("\n")
  const result = await run("python3", ["-c", script, sessionID], { cwd: root, timeoutMs: 5000 })
  const title = result.stdout.trim()
  return title || null
}

type SpeakResult = {
  title?: string | null
  path?: string
  queue?: string
  seconds?: number
  gen?: number
  via?: string
  id?: string
}

type ReplyConfig = {
  profiles?: { active?: string }
  output?: {
    directory?: string
    format?: "auto" | "mp3" | "m4a" | "wav"
    link_format?: "mp3" | "m4a"
    link_bitrate?: string
    mp3_bitrate?: string
    ffmpeg?: string
    retention?: {
      max_age_days?: number
      auto_purge_minutes?: number
      max_files?: number
      sweep_on_start?: boolean
      sweep_interval_minutes?: number
    }
  }
  playback?: { speak_subagents?: boolean }
  synthesis?: {
    model?: string
    length_scale?: number
    voice_per_session?: boolean
    voices?: string[]
  }
}

const DEFAULT_OUTPUT_DIR = "/media/share/tmp/audio/opencode-audio-tool"

type Retention = {
  days: number
  autoMinutes: number
  maxFiles: number
  onStart: boolean
  intervalMin: number
}

function retentionFor(config: ReplyConfig): Retention {
  const value = config.output?.retention ?? {}
  const days = Number.isFinite(value.max_age_days) ? Number(value.max_age_days) : 14
  const autoMinutes = Number.isFinite(value.auto_purge_minutes) ? Number(value.auto_purge_minutes) : 30
  const maxFiles = Number.isFinite(value.max_files) ? Number(value.max_files) : 200
  const intervalMin = Number.isFinite(value.sweep_interval_minutes)
    ? Math.max(1, Number(value.sweep_interval_minutes))
    : 5
  return { days, autoMinutes, maxFiles, onStart: value.sweep_on_start !== false, intervalMin }
}

/**
 * Pick the piper model for one utterance. Explicit voice wins; otherwise a
 * per-session voice is chosen by hashing the session id, so two sessions keep
 * two distinguishable voices for their whole life.
 */
function voiceModel(config: ReplyConfig, root: string, sessionID?: string, explicit?: string): string {
  const resolve = (name: string) => (name.includes("/") ? name : path.join(root, "voices", name))
  if (explicit) return resolve(explicit)
  const voices = config.synthesis?.voices ?? []
  if (config.synthesis?.voice_per_session !== false && voices.length > 0 && sessionID) {
    let hash = 0
    for (const char of sessionID) hash = (hash * 31 + char.charCodeAt(0)) >>> 0
    return resolve(voices[hash % voices.length])
  }
  return config.synthesis?.model || path.join(root, "voices", "voice.onnx")
}

/** Append-only action log so failures are visible outside the panel/model. */
function logAction(root: string, kind: string, status: string, detail?: string): void {
  const file = path.join(root, ".voice-log.jsonl")
  const line = JSON.stringify({ at: new Date().toISOString(), kind, status, ...(detail ? { detail } : {}) })
  try {
    writeFileSync(file, `${line}\n`, { flag: "a" })
  } catch {
    /* logging must never break a command */
  }
}

async function fileReady(target: string, ms = 2000): Promise<boolean> {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    try {
      if (existsSync(target) && statSync(target).size > 0) return true
    } catch {
      /* not yet visible */
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  try {
    return existsSync(target) && statSync(target).size > 0
  } catch {
    return false
  }
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`
}

function removeReplyWavs(dir: string, maxAgeMs: number, maxFiles?: number): { removed: number; bytes: number } {
  let names: string[] = []
  try {
    names = readdirSync(dir).filter(
      (name) =>
        name.startsWith("reply-") && (name.endsWith(".wav") || name.endsWith(".mp3") || name.endsWith(".m4a")),
    )
  } catch {
    return { removed: 0, bytes: 0 }
  }
  const cutoff = maxAgeMs > 0 ? Date.now() - maxAgeMs : Number.POSITIVE_INFINITY
  let removed = 0
  let bytes = 0
  const survivors: Array<{ file: string; mtime: number }> = []
  for (const name of names) {
    const file = path.join(dir, name)
    try {
      const stat = statSync(file)
      if (maxAgeMs === 0 || stat.mtimeMs < cutoff) {
        unlinkSync(file)
        removed += 1
        bytes += stat.size
      } else {
        survivors.push({ file, mtime: stat.mtimeMs })
      }
    } catch {
      /* vanished or unreadable */
    }
  }
  if (maxFiles !== undefined && survivors.length > maxFiles) {
    survivors.sort((left, right) => right.mtime - left.mtime)
    for (const old of survivors.slice(maxFiles)) {
      try {
        const stat = statSync(old.file)
        unlinkSync(old.file)
        removed += 1
        bytes += stat.size
      } catch {
        /* raced */
      }
    }
  }
  return { removed, bytes }
}

async function purgeGenerated(
  root: string,
  cwd: string,
  days?: number,
  options: { recordZero?: boolean; all?: boolean } = {},
): Promise<{ removed: number; bytes: number; freed: string }> {
  const config = await readConfig(root, cwd)
  const retention = retentionFor(config)
  const projectDir = config.output?.directory || DEFAULT_OUTPUT_DIR
  const maxAgeMs =
    typeof days === "number"
      ? days <= 0
        ? 0
        : days * 86_400_000
      : retention.autoMinutes > 0
        ? Math.min(retention.autoMinutes * 60_000, retention.days * 86_400_000)
        : retention.days * 86_400_000

  const dirs = options.all ? [AUDIO_ROOT] : [projectDir]
  if (options.all) {
    try {
      for (const entry of readdirSync(AUDIO_ROOT, { withFileTypes: true })) {
        if (entry.isDirectory()) dirs.push(path.join(AUDIO_ROOT, entry.name))
      }
    } catch {
      /* root missing */
    }
  }

  let removed = 0
  let bytes = 0
  for (const dir of dirs) {
    const partial = removeReplyWavs(dir, maxAgeMs, typeof days === "number" ? undefined : retention.maxFiles)
    removed += partial.removed
    bytes += partial.bytes
  }
  const result = { removed, bytes }
  if (typeof days === "number" && days <= 0) {
    try {
      writeFileSync(path.join(root, ".voice-index.json"), "[]\n")
    } catch {
      /* index may not exist yet */
    }
  }
  // A zero-removal run (scheduled sweep, or a purge racing another host) must
  // not erase the result of the run that actually deleted the files.
  if (result.removed > 0 || options.recordZero !== false) {
    setPurgeAttempt(root, result.removed, result.bytes)
  }
  {
    const usage = cacheUsage()
    setCache(root, usage.files, usage.bytes)
    setQueue(root, queueCounts())
    setAudio(root, await audioStatus())
  }
  return { ...result, freed: formatBytes(result.bytes) }
}

/** Read the project's reply config through audioq's own JSONC loader. */
async function readConfig(root: string, cwd: string): Promise<ReplyConfig> {
  const script = [
    "import json,sys",
    `sys.path.insert(0, ${JSON.stringify(root)})`,
    "from audioq import load_reply_config",
    "print(json.dumps(load_reply_config()))",
  ].join("\n")
  const result = await run("python3", ["-c", script], { cwd, timeoutMs: 5000 })
  if (result.code !== 0) return {}
  try {
    return JSON.parse(result.stdout) as ReplyConfig
  } catch {
    return {}
  }
}

function slug(text: string): string {
  return (
    text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .split("-")
      .filter(Boolean)
      .slice(0, 4)
      .join("-") || "reply"
  )
}

type IndexEntry = { path: string; seconds?: number; at: number; via?: string; session?: string; child?: boolean }

/**
 * Newest-first list the TUI sidebar reads. Kept at the repo root so the TUI
 * part does not have to parse the reply config to find output.directory.
 */
function recordIndex(root: string, entry: IndexEntry): void {
  const file = path.join(root, ".voice-index.json")
  let list: IndexEntry[] = []
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8"))
    if (Array.isArray(parsed)) list = parsed.filter((item) => item && typeof item.path === "string")
  } catch {
    /* no index yet */
  }
  list.unshift(entry)
  const tmp = `${file}.${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}.part`
  try {
    writeFileSync(tmp, `${JSON.stringify(list.slice(0, 50), null, 2)}\n`)
    renameSync(tmp, file)
  } catch (error) {
    try {
      unlinkSync(tmp)
    } catch {
      /* ignore */
    }
    log("index write failed", String(error))
  }
}

/**
 * Tool path: synthesise to a durable file under output.directory, then enqueue
 * that file. `say` alone would move the item into played/ and leave the caller
 * with a path that stops resolving.
 */
function assistantText(message: any): string {
  const parts = message?.content ?? message?.parts ?? []
  if (!Array.isArray(parts)) return ""
  return parts
    .filter((part: any) => part?.type === "text")
    .map((part: any) => String(part.text ?? ""))
    .join("\n")
    .trim()
}

function pickLastAssistant(messages: any[]): { id: string; text: string } | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message?.type !== "assistant") continue
    const text = assistantText(message)
    if (text) return { id: message.id, text }
  }
  return null
}

/** Link format: home keeps WAV (no encode at all); away/link mode encodes. */
function effectiveFormat(config: ReplyConfig): "wav" | "mp3" | "m4a" {
  const requested = config.output?.format ?? "auto"
  if (requested !== "auto") return requested
  const profile = (config.profiles?.active ?? "home").toLowerCase()
  if (profile !== "away") return "wav"
  return config.output?.link_format ?? "m4a"
}

let activeSpeak = 0

function processingCount(root: string): number {
  try {
    return readdirSync(path.join(root, ".voice-requests")).filter((name) => name.endsWith(".processing"))
      .length
  } catch {
    return 0
  }
}

function refreshGenerating(root: string): void {
  setGenerating(root, activeSpeak + processingCount(root))
}

async function speakDurable(
  root: string,
  cwd: string,
  text: string,
  opts: { sessionID?: string; noPreamble?: boolean; title?: string | null; voice?: string } = {},
): Promise<SpeakResult> {
  activeSpeak += 1
  refreshGenerating(root)
  try {
    return await speakDurableInner(root, cwd, text, opts)
  } finally {
    activeSpeak -= 1
    refreshGenerating(root)
  }
}

async function lastAssistantText(
  ctx: { session: { context: (input: { sessionID: string }) => Promise<any> } },
  sessionID: string,
): Promise<string | null> {
  try {
    const messages = await ctx.session.context({ sessionID })
    return pickLastAssistant(messages as any[])?.text ?? null
  } catch {
    return null
  }
}

async function speakLastReply(
  ctx: any,
  root: string,
  location: string,
  sessionID: string,
): Promise<SpeakResult | null> {
  const text = await lastAssistantText(ctx, sessionID)
  if (!text) return null
  const cleaned = sanitise(text) || "The previous reply was all code, so there is nothing to read aloud."
  const result = await speakDurable(root, location, cleaned, { sessionID })
  recordIndex(root, {
    path: String(result.path),
    seconds: result.seconds,
    at: Date.now(),
    via: result.via,
    session: result.title ?? undefined,
  })
  return result
}

async function speakSummary(
  ctx: any,
  root: string,
  location: string,
  sessionID: string,
): Promise<SpeakResult | null> {
  const prompt =
    "In at most 70 words, state where this session stands: what is done, what is next. " +
    "Plain spoken prose. No markdown, lists, code, paths or URLs."
  let text = ""
  try {
    const generated = await ctx.session.generate({ sessionID, prompt })
    text = String((generated as { text?: string })?.text ?? "")
  } catch (error) {
    log("summary generation failed", String(error))
    return null
  }
  const cleaned = sanitise(text)
  if (!cleaned) return null
  const result = await speakDurable(root, location, cleaned, { sessionID })
  recordIndex(root, {
    path: String(result.path),
    seconds: result.seconds,
    at: Date.now(),
    via: result.via,
    session: result.title ?? undefined,
  })
  return result
}

function queueDirectory(): string {
  return process.env.AUDIOQ_DIR || "/tmp/opencode/audio-replies/queue"
}

/** The queue's played archive keeps WAVs; reuse one when the basename matches. */
function findPlayedWav(file: string): string | null {
  const dir = path.join(queueDirectory(), "played")
  const base = path.basename(file).replace(/\.(wav|mp3|m4a)$/i, "")
  try {
    for (const name of readdirSync(dir).filter((entry) => entry.endsWith(".json"))) {
      const data = JSON.parse(readFileSync(path.join(dir, name), "utf8")) as { source?: string }
      const source = typeof data.source === "string" ? data.source : ""
      if (!source) continue
      if (path.basename(source).replace(/\.(wav|mp3|m4a)$/i, "") !== base) continue
      const wav = path.join(dir, name.replace(/\.json$/, ".wav"))
      if (existsSync(wav)) return wav
    }
  } catch {
    /* no archive */
  }
  return null
}

/** Re-enqueue an existing reply. WAVs go straight in; encoded links reuse the
 * queue's played WAV when it is still archived, and only transcode otherwise. */
async function replayFile(root: string, cwd: string, target: string): Promise<boolean> {
  const file = path.resolve(target)
  if (!existsSync(file)) return false
  const entry = readIndex(root, 500).find((item) => path.resolve(item.path) === file)
  let wav = file
  let tmp: string | undefined
  if (!/\.wav$/i.test(file)) {
    const archived = findPlayedWav(file)
    if (archived) {
      wav = archived
    } else {
      const config = await readConfig(root, cwd)
      const ffmpeg = config.output?.ffmpeg || process.env.FFMPEG || "/media/share/tmp/tools/ffmpeg/ffmpeg"
      tmp = path.join("/tmp/opencode/audio-replies", `replay-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}.wav`)
      const convert = await run(ffmpeg, ["-y", "-hide_banner", "-loglevel", "error", "-i", file, "-acodec", "pcm_s16le", tmp], {
        cwd,
        timeoutMs: 60_000,
      })
      if (convert.code !== 0 || !existsSync(tmp)) {
        log("replay transcode failed", convert.stderr.slice(0, 200))
        if (tmp) {
          try {
            unlinkSync(tmp)
          } catch {
            /* ignore */
          }
        }
        return false
      }
      wav = tmp
    }
  }
  const args = [path.join(root, "audioq.py"), "enqueue", wav, "--text", ""]
  if (entry?.session) args.push("--session", entry.session)
  const queued = await run("python3", args, { cwd })
  if (tmp) {
    try {
      unlinkSync(tmp)
    } catch {
      /* queue holds its own link */
    }
  }
  if (queued.code !== 0) {
    log("replay enqueue failed", queued.stderr.slice(0, 200))
    return false
  }
  setQueue(root, queueCounts())
  return true
}

/** Delete one indexed reply from disk and from the index. Only paths the index
 * knows about can be removed, and both format variants of the basename go. */
function removeEntry(root: string, target: string): boolean {
  const file = path.resolve(target)
  const entries = readIndex(root, 500)
  if (!entries.some((entry) => path.resolve(entry.path) === file)) return false
  const base = file.replace(/\.(wav|mp3|m4a)$/i, "")
  for (const candidate of new Set([`${base}.wav`, `${base}.mp3`, file])) {
    try {
      unlinkSync(candidate)
    } catch {
      /* already gone */
    }
  }
  const next = entries.filter((entry) => path.resolve(entry.path) !== file).slice(0, 50)
  try {
    writeFileSync(path.join(root, ".voice-index.json"), `${JSON.stringify(next, null, 2)}\n`)
  } catch {
    /* index write failed; files are gone */
  }
  return true
}

async function speakDurableInner(
  root: string,
  cwd: string,
  text: string,
  opts: { sessionID?: string; noPreamble?: boolean; title?: string | null; voice?: string } = {},
): Promise<SpeakResult> {
  const sessionArgs: string[] = []
  const resolvedTitle =
    opts.title ?? (opts.sessionID ? await sessionTitle(root, opts.sessionID) : null)
  if (!opts.noPreamble && resolvedTitle) sessionArgs.push("--session", resolvedTitle)

  let spoken = text
  if (!opts.noPreamble) {
    const dry = await run("python3", [path.join(root, "audioq.py"), "say", "--dry-run", ...sessionArgs, text], { cwd })
    if (dry.code !== 0) throw new Error(dry.stderr.trim().split("\n").filter(Boolean).pop() || "preamble failed")
    spoken = dry.stdout.trim() || text
  }

  const config = await readConfig(root, cwd)
  const outputDir = config.output?.directory || "/media/share/tmp/audio/opencode-audio-tool"
  const model = voiceModel(config, root, opts.sessionID, opts.voice)
  const lengthScale = config.synthesis?.length_scale ?? 0.67

  mkdirSync(outputDir, { recursive: true })
  const outFile = path.join(outputDir, `reply-${slug(text)}-${Date.now().toString(36).slice(-4)}.wav`)

  const started = Date.now()
  const synth = await run(
    path.join(root, "piper", "piper"),
    ["--model", model, "--output_file", outFile, "--length_scale", String(lengthScale)],
    { cwd, input: `${spoken}\n`, timeoutMs: 180_000 },
  )
  if (synth.code !== 0) {
    const lines = synth.stderr.trim().split("\n").filter(Boolean)
    throw new Error(lines.pop() || `piper exited ${synth.code}`)
  }
  if (!(await fileReady(outFile))) {
    const lines = synth.stderr.trim().split("\n").filter(Boolean)
    throw new Error(`piper wrote no file (${lines.slice(-2).join(" / ") || "no stderr"})`)
  }
  const gen = (Date.now() - started) / 1000

  const enqueueArgs = [path.join(root, "audioq.py"), "enqueue", outFile, "--text", spoken]
  if (resolvedTitle) enqueueArgs.push("--session", resolvedTitle)
  let enq = await run("python3", enqueueArgs, { cwd })
  if (enq.code !== 0 && /no such file/i.test(enq.stderr)) {
    // SMB writeback can lag the piper exit; give the file one more chance.
    await new Promise((resolve) => setTimeout(resolve, 400))
    if (await fileReady(outFile, 1000)) {
      enq = await run("python3", enqueueArgs, { cwd })
    }
  }
  if (enq.code !== 0) {
    const lines = enq.stderr.trim().split("\n").filter(Boolean)
    throw new Error(lines.pop() || `audioq enqueue exited ${enq.code}`)
  }
  const line = enq.stdout.trim().split("\n").filter(Boolean).pop() || ""
  let queued: { id?: string; seconds?: number; path?: string } = {}
  try {
    queued = JSON.parse(line)
  } catch {
    throw new Error(`audioq enqueue returned no JSON: ${line.slice(0, 200)}`)
  }
  const format = effectiveFormat(config)
  let linkFile = outFile
  let via = "piper+enqueue"
  if (format !== "wav") {
    const encoded = outFile.replace(/\.wav$/, format === "m4a" ? ".m4a" : ".mp3")
    const ffmpeg =
      config.output?.ffmpeg || process.env.FFMPEG || "/media/share/tmp/tools/ffmpeg/ffmpeg"
    const bitrate =
      config.output?.link_bitrate || (format === "m4a" ? "96k" : config.output?.mp3_bitrate || "128k")
    const codec = format === "m4a"
      ? ["-c:a", "aac", "-b:a", bitrate, "-movflags", "+faststart"]
      : ["-codec:a", "libmp3lame", "-b:a", bitrate]
    const convert = await run(
      ffmpeg,
      ["-y", "-hide_banner", "-loglevel", "error", "-i", outFile, ...codec, encoded],
      { cwd, timeoutMs: 60_000 },
    )
    if (convert.code === 0 && existsSync(encoded) && statSync(encoded).size > 0) {
      linkFile = encoded
      via = `piper+${format}+enqueue`
      try {
        unlinkSync(outFile) // the queue holds its own link or copy
      } catch {
        /* keep the wav if SMB still holds it */
      }
    } else {
      log(`${format} transcode failed; keeping wav`, convert.stderr.slice(0, 200))
    }
  }
  {
    const usage = cacheUsage(outputDir)
    setCache(root, usage.files, usage.bytes)
    setQueue(root, queueCounts())
    setAudio(root, await audioStatus())
  }
  return {
    title: resolvedTitle,
    path: linkFile,
    queue: queued.path,
    id: queued.id,
    seconds: queued.seconds,
    gen: Number(gen.toFixed(3)),
    via,
  }
}

/** Host-directed control request (purge/remove) for client mode. */
function writeControl(root: string, body: Record<string, unknown>): string {
  const dir = path.join(root, ".voice-requests")
  mkdirSync(dir, { recursive: true })
  const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
  const file = path.join(dir, `req-${id}.json`)
  const tmp = `${file}.part`
  writeFileSync(tmp, `${JSON.stringify({ id, ...body, created_at: Date.now() })}\n`)
  renameSync(tmp, file)
  return id
}

async function waitForState(root: string, before: number, ms = 8000): Promise<void> {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    const state = readState(root)
    const latest = Math.max(state.lastPurge?.at ?? 0, state.lastAttempt?.at ?? 0)
    if (latest > before) return
    await new Promise((resolve) => setTimeout(resolve, 300))
  }
}

type MuteState = { session: boolean; project: boolean; global: boolean }

type SessionMeta = { parentID?: string }
const sessionMetaCache = new Map<string, SessionMeta>()

async function sessionMeta(ctx: any, sessionID?: string): Promise<SessionMeta> {
  if (!sessionID) return {}
  const cached = sessionMetaCache.get(sessionID)
  if (cached) return cached
  try {
    const info = await ctx.session.get({ sessionID })
    const meta: SessionMeta = { parentID: (info as { parentID?: string })?.parentID }
    sessionMetaCache.set(sessionID, meta)
    return meta
  } catch {
    return {}
  }
}

async function readMutes(ctx: any, root: string, location: string, sessionID?: string): Promise<MuteState> {
  const state = readState(root)
  const mutes = resolveMutes(state, location, sessionID)
  // A session mute covers its subagents: walk the parent chain.
  if (!mutes.session && sessionID) {
    let current: string | undefined = sessionID
    for (let depth = 0; depth < 8; depth += 1) {
      const meta = await sessionMeta(ctx, current)
      if (!meta.parentID) break
      current = meta.parentID
      if (state.sessions[current] === true) {
        mutes.session = true
        break
      }
    }
  }
  return mutes
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function waitFor(predicate: () => boolean, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (predicate()) return true
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  return predicate()
}

/**
 * Start the resident daemon once. A pid file created with O_EXCL is the lock:
 * two plugin instances cannot both spawn, and a stale file is replaced only
 * after its owner is confirmed dead. Retries follow a 1 s / 5 s / 30 s backoff
 * without blocking setup; one-shot synthesis covers the gap.
 */
function ensureDaemon(root: string, queueDir: string, sock: string): void {
  void (async () => {
    if (existsSync(sock)) return
    mkdirSync(queueDir, { recursive: true })
    const pidFile = path.join(queueDir, ".voice-plugin.pid")
    try {
      const existing = Number(readFileSync(pidFile, "utf8").trim())
      if (existing && pidAlive(existing)) {
        log(`daemon already live (pid ${existing})`)
        return
      }
      unlinkSync(pidFile)
    } catch {
      /* no pid file */
    }

    for (const delay of [0, 5000, 30000]) {
      if (existsSync(sock)) return
      if (delay) await new Promise((resolve) => setTimeout(resolve, delay))
      let fd: number
      try {
        fd = openSync(pidFile, "wx")
      } catch {
        return /* another instance owns it */
      }
      const child = spawn("python3", [path.join(root, "piperd.py"), "--serve", "--drain"], {
        cwd: root,
        detached: true,
        stdio: "ignore",
      })
      child.on("error", () => {})
      child.unref()
      try {
        writeSync(fd, String(child.pid))
        closeSync(fd)
      } catch {
        /* best effort */
      }
      if (await waitFor(() => existsSync(sock), 10_000)) {
        log(`daemon started (pid ${child.pid})`)
        return
      }
      log(`daemon attempt failed (pid ${child.pid}); socket absent after 10s`)
      try {
        if (!pidAlive(child.pid)) unlinkSync(pidFile)
      } catch {
        /* ignore */
      }
    }
    log("daemon unavailable after backoff; one-shot synthesis remains")
  })().catch((error) => log("daemon start failed", String(error)))
}

function readIndex(root: string, limit = 20): IndexEntry[] {
  try {
    const parsed = JSON.parse(readFileSync(path.join(root, ".voice-index.json"), "utf8"))
    if (!Array.isArray(parsed)) return []
    return parsed.filter((entry) => entry && typeof entry.path === "string").slice(0, limit)
  } catch {
    return []
  }
}

type AudioStatus = { at: number; available: boolean; muted: boolean; volume: number }
let audioCache: { at: number; value: AudioStatus } | null = null

async function setSinkVolume(value: number): Promise<void> {
  const clamped = Math.min(1, Math.max(0, value))
  await run("wpctl", ["set-volume", "@DEFAULT_AUDIO_SINK@", clamped.toFixed(2)], { timeoutMs: 3000 })
  if (clamped > 0) {
    await run("wpctl", ["set-mute", "@DEFAULT_AUDIO_SINK@", "0"], { timeoutMs: 3000 })
  }
  audioCache = null
}

async function audioStatus(): Promise<AudioStatus> {
  if (audioCache && Date.now() - audioCache.at < 5000) return audioCache.value
  const result = await run("wpctl", ["get-volume", "@DEFAULT_AUDIO_SINK@"], { timeoutMs: 3000 })
  let available = false
  let muted = false
  let volume = 0
  if (result.code === 0) {
    available = true
    const match = result.stdout.match(/Volume:\s*([0-9.]+)/)
    if (match) volume = Number(match[1]) || 0
    muted = /MUTED/.test(result.stdout)
  }
  const value = { at: Date.now(), available, muted, volume }
  audioCache = { at: Date.now(), value }
  return value
}

function playingSession(queueDir: string): string | null {
  try {
    const folder = path.join(queueDir, "playing")
    const sidecar = readdirSync(folder).find((name) => name.endsWith(".json"))
    if (!sidecar) return null
    const data = JSON.parse(readFileSync(path.join(folder, sidecar), "utf8")) as { session?: string }
    return typeof data.session === "string" && data.session ? data.session : null
  } catch {
    return null
  }
}

function queueCounts(): { queued: number; playing: number; failed: number; playingSession?: string } {
  const dir = process.env.AUDIOQ_DIR || "/tmp/opencode/audio-replies/queue"
  const count = (sub: string): number => {
    try {
      return readdirSync(sub ? path.join(dir, sub) : dir).filter((name) => name.endsWith(".wav")).length
    } catch {
      return 0
    }
  }
  const result: { queued: number; playing: number; failed: number; playingSession?: string } = {
    queued: count(""),
    playing: count("playing"),
    failed: count("failed"),
  }
  const session = playingSession(dir)
  if (session) result.playingSession = session
  return result
}

const AUDIO_ROOT = "/media/share/tmp/audio"

/**
 * One canonical number: every project writes its replies somewhere under the
 * shared audio root, so summing that tree gives the same answer from any host,
 * instead of oscillating with whichever project asked last.
 */
function cacheUsage(_dir?: string): { files: number; bytes: number } {
  const roots = [AUDIO_ROOT]
  try {
    for (const entry of readdirSync(AUDIO_ROOT, { withFileTypes: true })) {
      if (entry.isDirectory()) roots.push(path.join(AUDIO_ROOT, entry.name))
    }
  } catch {
    /* root missing */
  }
  let files = 0
  let bytes = 0
  for (const dir of roots) {
    try {
      for (const name of readdirSync(dir)) {
        if (!name.startsWith("reply-")) continue
        if (!name.endsWith(".wav") && !name.endsWith(".mp3") && !name.endsWith(".m4a")) continue
        try {
          const stat = statSync(path.join(dir, name))
          files += 1
          bytes += stat.size
        } catch {
          /* raced with a purge */
        }
      }
    } catch {
      /* missing subdir */
    }
  }
  return { files, bytes }
}

async function voiceState(
  root: string,
  directory: string,
  sessionID?: string,
  mode: ResolvedMode = "host",
) {
  const state = readState(root)
  let cache: { at: number; files: number; bytes: number }
  let audio: AudioStatus
  let queue: { queued: number; playing: number; failed: number }
  if (mode === "client") {
    // The client shares the folder but not the queue or the sound device: read
    // the host's published stats instead of measuring local zeroes.
    cache = state.cache ?? { at: 0, files: 0, bytes: 0 }
    audio = state.audio ?? { at: 0, available: false, muted: false, volume: 0 }
    queue = state.queue
      ? {
          queued: state.queue.queued,
          playing: state.queue.playing,
          failed: state.queue.failed,
          ...(state.queue.playingSession ? { playingSession: state.queue.playingSession } : {}),
        }
      : { queued: 0, playing: 0, failed: 0 }
  } else {
    const config = await readConfig(root, directory)
    const outputDir = config.output?.directory || DEFAULT_OUTPUT_DIR
    cache = { at: Date.now(), ...cacheUsage(outputDir) }
    audio = await audioStatus()
    queue = queueCounts()
  }
  // Optional fields must be absent, not null: RPC validates the encoded JSON,
  // and `undefined` becomes `null`, which fails the declared type.
  const entries = readIndex(root).map((entry) => {
    const row: { path: string; at: number; seconds?: number; session?: string; child?: boolean } = {
      path: entry.path,
      at: entry.at,
    }
    if (typeof entry.seconds === "number") row.seconds = entry.seconds
    if (typeof entry.session === "string" && entry.session) row.session = entry.session
    if (entry.child === true) row.child = true
    return row
  })
  const result: {
    entries: typeof entries
    mutes: ReturnType<typeof resolveMutes>
    sidebar: boolean
    mode: ResolvedMode
    source: "local" | "host"
    statsAgeMs: number
    cache: { files: number; bytes: number }
    audio: AudioStatus
    queue: { queued: number; playing: number; failed: number }
    generating: number
    stats?: VoiceStats
    lastSpeaker?: { at: number; session: string }
    lastAction?: { at: number; kind: string; status: string; detail?: string }
    lastPurge?: { at: number; removed: number; bytes: number }
    lastAttempt?: { at: number; removed: number; bytes: number }
  } = {
    entries,
    mutes: resolveMutes(state, directory, sessionID),
    sidebar: state.sidebar,
    mode,
    source: mode === "client" ? "host" : "local",
    statsAgeMs: Math.max(
      0,
      Date.now() - Math.min(cache.at || Date.now(), audio.at || Date.now()),
    ),
    generating: activeSpeak + processingCount(root),
    cache,
    audio,
    queue,
  }
  if (state.stats) result.stats = state.stats
  if (state.lastSpeaker) result.lastSpeaker = state.lastSpeaker
  if (state.lastAction) result.lastAction = state.lastAction
  if (state.lastPurge) result.lastPurge = state.lastPurge
  if (state.lastAttempt) result.lastAttempt = state.lastAttempt
  return result
}

type RequestResult = { requested: true; id: string }

/** Client mode: hand the text to the host through the shared folder. */
function writeRequest(
  root: string,
  text: string,
  sessionID?: string,
  sessionTitle?: string | null,
  child = false,
): RequestResult {
  const dir = path.join(root, ".voice-requests")
  mkdirSync(dir, { recursive: true })
  const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
  const file = path.join(dir, `req-${id}.json`)
  const tmp = `${file}.part`
  writeFileSync(
    tmp,
    `${JSON.stringify({ id, text, sessionID, sessionTitle, child, created_at: Date.now() })}\n`,
  )
  renameSync(tmp, file)
  return { requested: true, id }
}

/**
 * Host mode: watch the shared request directory and synthesise whatever a
 * client drops there. Polling, not fs.watch — SMB/virtiofs events are not
 * reliable, and two seconds is invisible next to synthesis.
 */
function startRequestWatcher(root: string, location: string): () => void {
  const dir = path.join(root, ".voice-requests")
  mkdirSync(dir, { recursive: true })
  const seen = new Set<string>()
  const timer = setInterval(() => {
    void (async () => {
      let names: string[] = []
      try {
        names = readdirSync(dir).filter((name) => name.endsWith(".json")).sort()
      } catch {
        return
      }
      // Recover claims left behind by a crash: nothing is synthesising a file
      // this old.
      for (const name of readdirSync(dir).filter((entry) => entry.endsWith(".json.processing"))) {
        const stale = path.join(dir, name)
        try {
          if (Date.now() - statSync(stale).mtimeMs > 15 * 60_000) {
            const name = stale.slice(0, -".processing".length)
            renameSync(stale, name)
            seen.delete(path.basename(name))
          }
        } catch {
          /* raced with the owner */
        }
      }

      for (const name of names) {
        if (!name.endsWith(".json")) continue
        if (seen.has(name)) continue
        const file = path.join(dir, name)
        const claim = `${file}.processing`
        try {
          renameSync(file, claim) // atomic: the other host's rename now fails
        } catch {
          seen.add(name)
          continue
        }
        seen.add(name)
        try {
          const request = JSON.parse(readFileSync(claim, "utf8")) as {
            kind?: string
            text?: string
            sessionID?: string
            sessionTitle?: string
            child?: boolean
            days?: number
            path?: string
          }
          if (request.kind === "purge") {
            const days = typeof request.days === "number" ? request.days : undefined
            await purgeGenerated(root, location, days)
            try {
              unlinkSync(claim)
            } catch {
              /* sweep will clean it */
            }
            log("purge request served")
            continue
          }
          if (request.kind === "replay" && request.path) {
            await replayFile(root, location, request.path)
            try {
              unlinkSync(claim)
            } catch {
              /* sweep will clean it */
            }
            log("replay request served")
            continue
          }
          if (request.kind === "volume" && typeof (request as { value?: number }).value === "number") {
            await setSinkVolume(Number((request as { value?: number }).value))
            try {
              unlinkSync(claim)
            } catch {
              /* sweep will clean it */
            }
            log("volume request served")
            continue
          }
          if (request.kind === "remove" && request.path) {
            removeEntry(root, request.path)
            try {
              unlinkSync(claim)
            } catch {
              /* sweep will clean it */
            }
            log("remove request served")
            continue
          }
          const text = String(request.text ?? "").trim()
          if (!text) {
            unlinkSync(claim)
            continue
          }
          const result = await speakDurable(root, location, text, {
            sessionID: request.sessionID,
            title: request.sessionTitle ?? null,
          })
          recordIndex(root, {
            path: String(result.path),
            seconds: result.seconds,
            at: Date.now(),
            via: "request",
            session: request.sessionTitle ?? result.title ?? undefined,
            child: request.child === true,
          })
          try {
            unlinkSync(claim)
          } catch {
            // SMB can hold a handle open; a renamed file is still out of the queue.
            try {
              renameSync(claim, `${file}.done`)
            } catch {
              /* a stale sweep will retry it eventually */
            }
          }
          log(`request ${name} spoken`)
        } catch (error) {
          log(`request ${name} failed`, String(error))
          try {
            renameSync(claim, `${file}.failed`)
          } catch {
            /* leave it */
          }
        }
      }
    })()
  }, 2000)
  return () => clearInterval(timer)
}

export default Plugin.define({
  id: "assistant-voice",
  async setup(ctx) {
    const options = (ctx.options ?? {}) as Options
    const root = options.root ?? DEFAULT_ROOT
    const location = ctx.location?.directory ?? process.cwd()
    const startupConfig = await readConfig(root, location)
    const speakSubagents =
      options.speakSubagents ?? startupConfig.playback?.speak_subagents ?? false
    const requestedMode: Mode = options.mode ?? "auto"
    const mode: ResolvedMode = resolveMode(requestedMode, root)
    const maxChars = typeof options.maxChars === "number" ? options.maxChars : DEFAULT_MAX_CHARS
    const noticeTemplate = options.emptyNotice ?? DEFAULT_NOTICE
    const hasConfig = existsSync(path.join(location, ".dev", "audiomode.jsonc"))
    // Explicit `auto: true` speaks even in a project without .dev/audiomode.jsonc;
    // an absent option still follows the per-project opt-in.
    const auto = options.auto === true || (options.auto !== false && hasConfig)
    const spoken = new Set<string>()
    const queueDir = process.env.AUDIOQ_DIR || "/tmp/opencode/audio-replies/queue"
    const sock = process.env.AUDIOQ_SOCK || "/tmp/opencode/audio-replies/piperd.sock"
    log(`mode ${mode} (requested ${requestedMode}, platform ${process.platform})`)

    const cleanups: Array<() => void> = []
    if (mode === "host") {
      cleanups.push(startRequestWatcher(root, location))
      log("host mode: watching .voice-requests")

      const status = await audioStatus()
      setAudio(root, status)
      setQueue(root, queueCounts())
      if (status.muted || status.volume === 0) {
        if (options.autoUnmute === true) {
          await run("wpctl", ["set-mute", "@DEFAULT_AUDIO_SINK@", "0"], { timeoutMs: 3000 })
          if (status.volume === 0) {
            await run("wpctl", ["set-volume", "@DEFAULT_AUDIO_SINK@", "0.7"], { timeoutMs: 3000 })
          }
          audioCache = null
          log("output was silent; unmuted the default sink")
        } else {
          log(`warning: output sink is ${status.muted ? "muted" : "at zero volume"}`)
        }
      }

      const hostConfig = startupConfig
      const outputDir = hostConfig.output?.directory || DEFAULT_OUTPUT_DIR
      const refreshStats = () => {
        void (async () => {
          const usage = cacheUsage(outputDir)
          setCache(root, usage.files, usage.bytes)
          setQueue(root, queueCounts())
          setGenerating(root, activeSpeak + processingCount(root))
          setAudio(root, await audioStatus())
        })().catch((error) => log("stats refresh failed", String(error)))
      }
      refreshStats()
      const statsTimer = setInterval(refreshStats, 2_000)
      cleanups.push(() => clearInterval(statsTimer))

      const retention = retentionFor(hostConfig)
      const sweep = () => {
        void purgeGenerated(root, location, undefined, { recordZero: false, all: true })
          .then((result) => {
            if (result.removed > 0) log(`retention removed ${result.removed} files (${result.freed})`)
          })
          .catch((error) => log("retention sweep failed", String(error)))
      }
      if (retention.onStart) {
        const startTimer = setTimeout(sweep, 30_000)
        cleanups.push(() => clearTimeout(startTimer))
      }
      const interval = setInterval(sweep, retention.intervalMin * 60_000)
      cleanups.push(() => clearInterval(interval))
    }

    try {
      await ctx.command.transform((editor) => {
        editor.add({
          name: "voice",
          description: "Voice: mute or unmute auto-speak (session, project, global)",
          execute: async ({ sessionID, prompt }) => {
            const parts = String((prompt as { text?: string } | undefined)?.text ?? "")
              .trim()
              .split(/\s+/)
              .filter(Boolean)
            const verb = (parts[0] ?? "").toLowerCase()
            const scope = (parts[1] ?? "session").toLowerCase()
            if (scope !== "session" && scope !== "project" && scope !== "global") return
            if (verb === "mute" || verb === "unmute") {
              setMute(root, scope, location, sessionID, verb === "mute")
              return
            }
            if (verb === "sidebar") {
              setSidebar(root, scope !== "off")
              return
            }
            if ((verb === "repeat" || verb === "last") && sessionID) {
              void speakLastReply(ctx, root, location, sessionID)
              return
            }
            if ((verb === "summary" || verb === "summarize") && sessionID) {
              void speakSummary(ctx, root, location, sessionID)
              return
            }
            if (verb === "purge") {
              const days = parts[1] !== undefined ? Number(parts[1]) : undefined
              void purgeGenerated(root, location, Number.isFinite(days) ? Number(days) : undefined)
            }
          },
        })
      })
    } catch (error) {
      log("command registration failed", String(error))
    }

    try {
      await ctx.rpc.register(Voice, {
        state: async (input: unknown) => {
          const args = (input ?? {}) as { directory?: string; sessionID?: string }
          return await voiceState(root, args.directory ?? location, args.sessionID, mode)
        },
        setMute: async (input: unknown) => {
          const args = (input ?? {}) as {
            directory?: string
            sessionID?: string
            scope?: string
            value?: boolean
          }
          const scope = (args.scope ?? "session") as "session" | "project" | "global"
          setMute(root, scope, args.directory ?? location, args.sessionID, args.value === true)
          return await voiceState(root, args.directory ?? location, args.sessionID, mode)
        },
        replay: async (input: unknown) => {
          const args = (input ?? {}) as { directory?: string; sessionID?: string; path?: string }
          if (args.path) {
            setLastAction(root, "replay", "running", path.basename(args.path))
            if (mode === "client") {
              writeControl(root, { kind: "replay", path: args.path })
              await new Promise((resolve) => setTimeout(resolve, 1500))
            } else {
              const ok = await replayFile(root, args.directory ?? location, args.path)
              setLastAction(root, "replay", ok ? "ok" : "error", path.basename(args.path))
              logAction(root, "replay", ok ? "ok" : "error", path.basename(args.path))
            }
          }
          return await voiceState(root, args.directory ?? location, args.sessionID, mode)
        },
        remove: async (input: unknown) => {
          const args = (input ?? {}) as { directory?: string; sessionID?: string; path?: string }
          if (args.path) {
            if (mode === "client") {
              writeControl(root, { kind: "remove", path: args.path })
              const deadline = Date.now() + 8000
              while (Date.now() < deadline) {
                await new Promise((resolve) => setTimeout(resolve, 300))
                if (!readIndex(root, 500).some((entry) => entry.path === args.path)) break
              }
            } else {
              removeEntry(root, args.path)
            }
          }
          return await voiceState(root, args.directory ?? location, args.sessionID, mode)
        },
        setVolume: async (input: unknown) => {
          const args = (input ?? {}) as { directory?: string; sessionID?: string; value?: number }
          const value = Math.min(1, Math.max(0, Number(args.value) || 0))
          if (mode === "client") {
            writeControl(root, { kind: "volume", value })
            await new Promise((resolve) => setTimeout(resolve, 800))
          } else {
            await setSinkVolume(value)
          }
          return await voiceState(root, args.directory ?? location, args.sessionID, mode)
        },
        repeat: async (input: unknown) => {
          const args = (input ?? {}) as { directory?: string; sessionID?: string }
          const dir = args.directory ?? location
          if (args.sessionID) {
            setLastAction(root, "repeat", "running", "speaking the previous reply")
            logAction(root, "repeat", "running")
            try {
              const result = await speakLastReply(ctx, root, dir, args.sessionID)
              const outcome = result ? "ok" : "empty"
              const detail = result ? `${result.seconds ?? "?"}s` : "no text to replay"
              setLastAction(root, "repeat", outcome, detail)
              logAction(root, "repeat", outcome, detail)
            } catch (error) {
              setLastAction(root, "repeat", "error", String(error))
              logAction(root, "repeat", "error", String(error))
            }
          }
          return await voiceState(root, dir, args.sessionID, mode)
        },
        summary: async (input: unknown) => {
          const args = (input ?? {}) as { directory?: string; sessionID?: string }
          const dir = args.directory ?? location
          if (args.sessionID) {
            setLastAction(root, "summary", "running", "summarising")
            logAction(root, "summary", "running")
            try {
              const result = await speakSummary(ctx, root, dir, args.sessionID)
              const outcome = result ? "ok" : "empty"
              const detail = result ? `${result.seconds ?? "?"}s` : "no summary produced"
              setLastAction(root, "summary", outcome, detail)
              logAction(root, "summary", outcome, detail)
            } catch (error) {
              setLastAction(root, "summary", "error", String(error))
              logAction(root, "summary", "error", String(error))
            }
          }
          return await voiceState(root, dir, args.sessionID, mode)
        },
        purge: async (input: unknown) => {
          const args = (input ?? {}) as { directory?: string; sessionID?: string; days?: number }
          if (mode === "client") {
            const before = readState(root).lastPurge?.at ?? 0
            writeControl(root, { kind: "purge", days: args.days })
            await waitForState(root, before)
          } else {
            await purgeGenerated(root, args.directory ?? location, args.days)
          }
          return await voiceState(root, args.directory ?? location, args.sessionID, mode)
        },
        setSidebar: async (input: unknown) => {
          const args = (input ?? {}) as { visible?: boolean }
          setSidebar(root, args.visible === true)
          return await voiceState(root, location, undefined, mode)
        },
      })
    } catch (error) {
      log("rpc registration failed", String(error))
    }

    try {
      await ctx.tool.transform((editor) => {
        editor.namespace({ name: "voice", description: "Local text-to-speech through the Piper queue" })
        editor.add({
          name: "speak",
          description:
            "Synthesise text to a WAV in the reply directory and enqueue it for local playback. Returns path, duration and generation time.",
          input: {
            type: "object",
            properties: {
              text: { type: "string" },
              voice: { type: "string", description: "Piper model file name from voices/" },
            },
            required: ["text"],
            additionalProperties: false,
          },
          options: { namespace: "voice", codemode: true },
          execute: async (input: unknown, context?: { sessionID?: string }) => {
            const text = String((input as { text?: unknown })?.text ?? "").trim()
            const voice = (input as { voice?: unknown })?.voice
              ? String((input as { voice?: unknown }).voice)
              : undefined
            if (!text) return { content: "voice: empty text; nothing to speak." }
            const meta = await sessionMeta(ctx, context?.sessionID)
            if (mode === "remote") {
              return {
                content:
                  "voice: remote mode is specified but not implemented; see docs/remote-audio-pairing.md.",
              }
            }
            if (mode === "client") {
              const title = await sessionTitle(root, context?.sessionID)
              const request = writeRequest(root, text, context?.sessionID, title, Boolean(meta.parentID))
              return { content: JSON.stringify({ ok: true, ...request }) }
            }
            try {
              const result = await speakDurable(root, location, text, {
                sessionID: context?.sessionID,
                voice,
              })
              recordIndex(root, {
                path: String(result.path),
                seconds: result.seconds,
                at: Date.now(),
                via: result.via,
                session: result.title ?? undefined,
                child: Boolean(meta.parentID),
              })
              return { content: JSON.stringify({ ok: true, ...result }) }
            } catch (error) {
              log("voice_speak failed", String(error))
              return { content: `voice: ${String(error)}` }
            }
          },
        })

        editor.add({
          name: "control",
          description:
            "Mute, unmute, or report auto-speak. Scopes: session, project, global. Returns the effective state.",
          input: {
            type: "object",
            properties: {
              action: { type: "string", enum: ["mute", "unmute", "status"] },
              scope: { type: "string", enum: ["session", "project", "global"] },
            },
            required: ["action"],
            additionalProperties: false,
          },
          options: { namespace: "voice", codemode: true },
          execute: async (input: unknown, context?: { sessionID?: string }) => {
            try {
              const args = (input ?? {}) as { action?: string; scope?: string }
              const scope = (args.scope ?? "session") as "session" | "project" | "global"
              if (args.action === "status") {
                const mutes = await readMutes(ctx, root, location, context?.sessionID)
                const effective = mutes.global || mutes.project || mutes.session
                return { content: JSON.stringify({ ok: true, mutes, effective }) }
              }
              if (args.action !== "mute" && args.action !== "unmute") {
                return { content: "voice: action must be mute, unmute, or status" }
              }
              const result = setMute(root, scope, location, context?.sessionID, args.action === "mute")
              return { content: JSON.stringify({ ok: true, scope, mutes: result.mutes, effective: result.effective }) }
            } catch (error) {
              log("voice_control failed", String(error))
              return { content: `voice: ${String(error)}` }
            }
          },
        })

        editor.add({
          name: "purge",
          description:
            "Delete generated reply audio. Omit days to apply the configured retention; days 0 deletes everything. Returns files removed and bytes freed.",
          input: {
            type: "object",
            properties: { days: { type: "number" } },
            additionalProperties: false,
          },
          options: { namespace: "voice", codemode: true },
          execute: async (input: unknown) => {
            try {
              const args = (input ?? {}) as { days?: number }
              const days = typeof args.days === "number" ? args.days : undefined
              let result: { removed: number; bytes: number; freed: string }
              if (mode === "client") {
                const before = Math.max(
                  readState(root).lastPurge?.at ?? 0,
                  readState(root).lastAttempt?.at ?? 0,
                )
                writeControl(root, { kind: "purge", days })
                await waitForState(root, before)
                const state = readState(root)
                const thisAttempt = state.lastAttempt
                const latest = thisAttempt ?? state.lastPurge
                result = {
                  removed: latest?.removed ?? 0,
                  bytes: latest?.bytes ?? 0,
                  freed: formatBytes(latest?.bytes ?? 0),
                }
              } else {
                result = await purgeGenerated(root, location, days)
              }
              return {
                content: JSON.stringify({
                  ok: true,
                  removed: result.removed,
                  bytes: result.bytes,
                  freed: result.freed,
                }),
              }
            } catch (error) {
              log("voice_purge failed", String(error))
              return { content: `voice: ${String(error)}` }
            }
          },
        })
      })
    } catch (error) {
      log("tool registration failed", String(error))
    }

    if (!auto) {
      log(`auto-speak off (config ${hasConfig ? "found" : "missing"}, option auto=${String(options.auto)})`)
      return () => cleanups.forEach((cleanup) => cleanup())
    }

    ensureDaemon(root, queueDir, sock)

    try {
      await ctx.session.hook("experimental.idle", async (event) => {
        let outcome = "error"
        try {
          const meta = await sessionMeta(ctx, event.sessionID)
          if (meta.parentID && !speakSubagents) {
            outcome = "subagent"
            log(`skip subagent ${event.sessionID} (speakSubagents off)`)
            return
          }
          const mutes = await readMutes(ctx, root, location, event.sessionID)
          if (mutes.global || mutes.project || mutes.session) {
            outcome = "muted"
            log(`muted (${JSON.stringify(mutes)})`)
            return
          }
          const messages = await ctx.session.context({ sessionID: event.sessionID })
          const last = pickLastAssistant(messages as any[])
          if (!last) {
            outcome = "noText"
            return
          }
          if (spoken.has(last.id)) {
            outcome = "duplicate"
            return
          }
          const cleaned = sanitise(last.text)
          if (cleaned.length > maxChars) {
            outcome = "tooLong"
            log(`skip ${last.id}: ${cleaned.length} chars over ${maxChars}`)
            return
          }
          spoken.add(last.id)
          if (mode === "remote") {
            outcome = "remote"
            log("remote mode: not implemented, skipping auto-speak")
            return
          }
          if (mode === "client") {
            const resolved = await sessionTitle(root, event.sessionID)
            const title = cleaned ? resolved : (resolved ?? "this session")
            const payload = cleaned || noticeTemplate.replaceAll("{session}", title)
            const request = writeRequest(root, payload, event.sessionID, resolved, Boolean(meta.parentID))
            log(`requested ${request.id}${cleaned ? "" : " (untranscribable notice)"}`)
            outcome = cleaned ? "spoken" : "noText"
            return
          }
          if (!cleaned) {
            const title = (await sessionTitle(root, event.sessionID)) ?? "this session"
            const notice = noticeTemplate.replaceAll("{session}", title)
            log(`nothing speakable in ${last.id}; announcing`)
            const result = await speakDurable(root, location, notice, { sessionID: event.sessionID, noPreamble: true })
            recordIndex(root, {
              path: String(result.path),
              seconds: result.seconds,
              at: Date.now(),
              via: result.via,
              session: result.title ?? title,
              child: Boolean(meta.parentID),
            })
            outcome = "noText"
            return
          }
          const result = await speakDurable(root, location, cleaned, { sessionID: event.sessionID })
          recordIndex(root, {
            path: String(result.path),
            seconds: result.seconds,
            at: Date.now(),
            via: result.via,
            session: result.title ?? undefined,
            child: Boolean(meta.parentID),
          })
          outcome = "spoken"
        } catch (error) {
          outcome = "error"
          log("auto-speak failed", String(error))
        } finally {
          recordVoiceEvent(root, event.sessionID, outcome)
        }
      })
      log("auto-speak hook registered")
    } catch (error) {
      log("auto-speak hook failed", String(error))
    }

    return () => cleanups.forEach((cleanup) => cleanup())
  },
})
