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
import { existsSync, mkdirSync } from "node:fs"
import path from "node:path"
import { Plugin } from "@opencode/plugin"

type Options = {
  root?: string
  auto?: boolean
  maxChars?: number
  emptyNotice?: string
}

const DEFAULT_ROOT = "/media/share/opencode-audio-tool"
const DEFAULT_NOTICE = "{session} here: my last message was untranscribable, check the app"
const DEFAULT_MAX_CHARS = 2000

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
  path?: string
  queue?: string
  seconds?: number
  gen?: number
  via?: string
  id?: string
}

type ReplyConfig = {
  output?: { directory?: string }
  synthesis?: { model?: string; length_scale?: number }
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

/**
 * Tool path: synthesise to a durable file under output.directory, then enqueue
 * that file. `say` alone would move the item into played/ and leave the caller
 * with a path that stops resolving.
 */
async function speakDurable(
  root: string,
  cwd: string,
  text: string,
  sessionID?: string,
): Promise<SpeakResult> {
  const sessionArgs: string[] = []
  if (sessionID) {
    const title = await sessionTitle(root, sessionID)
    if (title) sessionArgs.push("--session", title)
  }

  const dry = await run("python3", [path.join(root, "audioq.py"), "say", "--dry-run", ...sessionArgs, text], { cwd })
  if (dry.code !== 0) throw new Error(dry.stderr.trim().split("\n").filter(Boolean).pop() || "preamble failed")
  const spoken = dry.stdout.trim() || text

  const config = await readConfig(root, cwd)
  const outputDir = config.output?.directory || "/media/share/tmp/audio/opencode-audio-tool"
  const model = config.synthesis?.model || path.join(root, "voices", "voice.onnx")
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
  const gen = (Date.now() - started) / 1000

  const enq = await run(
    "python3",
    [path.join(root, "audioq.py"), "enqueue", outFile, "--text", spoken],
    { cwd },
  )
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
  return {
    path: outFile,
    queue: queued.path,
    id: queued.id,
    seconds: queued.seconds,
    gen: Number(gen.toFixed(3)),
    via: "piper+enqueue",
  }
}

async function speak(
  root: string,
  cwd: string,
  text: string,
  opts: { sessionID?: string; noPreamble?: boolean } = {},
): Promise<SpeakResult> {
  const args = [path.join(root, "audioq.py"), "say"]
  if (opts.noPreamble) args.push("--no-preamble")
  if (opts.sessionID) {
    const title = await sessionTitle(root, opts.sessionID)
    if (title) args.push("--session", title)
  }
  args.push(text)

  const result = await run("python3", args, { cwd })
  if (result.code !== 0) {
    const lines = result.stderr.trim().split("\n").filter(Boolean)
    throw new Error(lines.pop() || `audioq exited ${result.code}`)
  }
  const lines = result.stdout.trim().split("\n").filter(Boolean)
  const line = lines.pop() || ""
  try {
    return JSON.parse(line) as SpeakResult
  } catch {
    throw new Error(`audioq returned no JSON: ${line.slice(0, 200)}`)
  }
}

export default Plugin.define({
  id: "assistant-voice",
  async setup(ctx) {
    const options = (ctx.options ?? {}) as Options
    const root = options.root ?? DEFAULT_ROOT
    const maxChars = typeof options.maxChars === "number" ? options.maxChars : DEFAULT_MAX_CHARS
    const noticeTemplate = options.emptyNotice ?? DEFAULT_NOTICE
    const location = ctx.location?.directory ?? process.cwd()
    const hasConfig = existsSync(path.join(location, ".dev", "audiomode.jsonc"))
    const auto = options.auto !== false && hasConfig
    const spoken = new Set<string>()

    try {
      await ctx.tool.transform((editor) => {
        editor.namespace({ name: "voice", description: "Local text-to-speech through the Piper queue" })
        editor.add({
          name: "speak",
          description:
            "Synthesise text to a WAV in the reply directory and enqueue it for local playback. Returns path, duration and generation time.",
          input: {
            type: "object",
            properties: { text: { type: "string" } },
            required: ["text"],
            additionalProperties: false,
          },
          options: { namespace: "voice", codemode: true },
          execute: async (input: unknown, context?: { sessionID?: string }) => {
            const text = String((input as { text?: unknown })?.text ?? "").trim()
            if (!text) return { content: "voice: empty text; nothing to speak." }
            try {
              const result = await speakDurable(root, location, text, context?.sessionID)
              return { content: JSON.stringify({ ok: true, ...result }) }
            } catch (error) {
              log("voice_speak failed", String(error))
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
      return
    }

    try {
      await ctx.session.hook("experimental.idle", async (event) => {
        try {
          const messages = await ctx.session.context({ sessionID: event.sessionID })
          const last = [...messages].reverse().find((message) => message.type === "assistant")
          if (!last || spoken.has(last.id)) return
          const text = (last.content ?? [])
            .filter((part) => part.type === "text")
            .map((part) => part.text ?? "")
            .join("\n")
          const cleaned = sanitise(text)
          if (cleaned.length > maxChars) {
            log(`skip ${last.id}: ${cleaned.length} chars over ${maxChars}`)
            return
          }
          spoken.add(last.id)
          if (!cleaned) {
            const title = (await sessionTitle(root, event.sessionID)) ?? "this session"
            const notice = noticeTemplate.replaceAll("{session}", title)
            log(`nothing speakable in ${last.id}; announcing`)
            await speak(root, location, notice, { noPreamble: true })
            return
          }
          await speak(root, location, cleaned, { sessionID: event.sessionID })
        } catch (error) {
          log("auto-speak failed", String(error))
        }
      })
      log("auto-speak hook registered")
    } catch (error) {
      log("auto-speak hook failed", String(error))
    }
  },
})
