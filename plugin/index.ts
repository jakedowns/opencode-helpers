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
} from "node:fs"
import path from "node:path"
import { Plugin } from "@opencode/plugin"
import { readState, resolveMutes, setMute, setSidebar } from "./state.ts"
import { Voice } from "./rpc.ts"

type Mode = "host" | "client" | "remote"

type Options = {
  mode?: Mode
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

type IndexEntry = { path: string; seconds?: number; at: number; via?: string }

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
  const tmp = `${file}.part`
  try {
    writeFileSync(tmp, `${JSON.stringify(list.slice(0, 50), null, 2)}\n`)
    renameSync(tmp, file)
  } catch (error) {
    log("index write failed", String(error))
  }
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
  opts: { sessionID?: string; noPreamble?: boolean } = {},
): Promise<SpeakResult> {
  const sessionArgs: string[] = []
  if (!opts.noPreamble && opts.sessionID) {
    const title = await sessionTitle(root, opts.sessionID)
    if (title) sessionArgs.push("--session", title)
  }

  let spoken = text
  if (!opts.noPreamble) {
    const dry = await run("python3", [path.join(root, "audioq.py"), "say", "--dry-run", ...sessionArgs, text], { cwd })
    if (dry.code !== 0) throw new Error(dry.stderr.trim().split("\n").filter(Boolean).pop() || "preamble failed")
    spoken = dry.stdout.trim() || text
  }

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

type MuteState = { session: boolean; project: boolean; global: boolean }

async function readMutes(_ctx: any, root: string, location: string, sessionID?: string): Promise<MuteState> {
  const state = readState(root)
  return resolveMutes(state, location, sessionID)
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

function voiceState(root: string, directory: string, sessionID?: string) {
  const state = readState(root)
  return {
    entries: readIndex(root).map((entry) => ({ path: entry.path, seconds: entry.seconds, at: entry.at })),
    mutes: resolveMutes(state, directory, sessionID),
    sidebar: state.sidebar,
  }
}

type RequestResult = { requested: true; id: string }

/** Client mode: hand the text to the host through the shared folder. */
function writeRequest(root: string, text: string, sessionID?: string): RequestResult {
  const dir = path.join(root, ".voice-requests")
  mkdirSync(dir, { recursive: true })
  const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
  const file = path.join(dir, `req-${id}.json`)
  const tmp = `${file}.part`
  writeFileSync(tmp, `${JSON.stringify({ id, text, sessionID, created_at: Date.now() })}\n`)
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
            text?: string
            sessionID?: string
          }
          const text = String(request.text ?? "").trim()
          if (!text) {
            unlinkSync(claim)
            continue
          }
          const result = await speakDurable(root, location, text, { sessionID: request.sessionID })
          recordIndex(root, {
            path: String(result.path),
            seconds: result.seconds,
            at: Date.now(),
            via: "request",
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
    const mode: Mode = options.mode ?? "host"
    const maxChars = typeof options.maxChars === "number" ? options.maxChars : DEFAULT_MAX_CHARS
    const noticeTemplate = options.emptyNotice ?? DEFAULT_NOTICE
    const location = ctx.location?.directory ?? process.cwd()
    const hasConfig = existsSync(path.join(location, ".dev", "audiomode.jsonc"))
    // Explicit `auto: true` speaks even in a project without .dev/audiomode.jsonc;
    // an absent option still follows the per-project opt-in.
    const auto = options.auto === true || (options.auto !== false && hasConfig)
    const spoken = new Set<string>()
    const queueDir = process.env.AUDIOQ_DIR || "/tmp/opencode/audio-replies/queue"
    const sock = process.env.AUDIOQ_SOCK || "/tmp/opencode/audio-replies/piperd.sock"
    const cleanups: Array<() => void> = []
    if (mode === "host") {
      cleanups.push(startRequestWatcher(root, location))
      log("host mode: watching .voice-requests")
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
          return voiceState(root, args.directory ?? location, args.sessionID)
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
          return voiceState(root, args.directory ?? location, args.sessionID)
        },
        setSidebar: async (input: unknown) => {
          const args = (input ?? {}) as { visible?: boolean }
          setSidebar(root, args.visible === true)
          return voiceState(root, location)
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
            properties: { text: { type: "string" } },
            required: ["text"],
            additionalProperties: false,
          },
          options: { namespace: "voice", codemode: true },
          execute: async (input: unknown, context?: { sessionID?: string }) => {
            const text = String((input as { text?: unknown })?.text ?? "").trim()
            if (!text) return { content: "voice: empty text; nothing to speak." }
            if (mode === "remote") {
              return {
                content:
                  "voice: remote mode is specified but not implemented; see docs/remote-audio-pairing.md.",
              }
            }
            if (mode === "client") {
              const request = writeRequest(root, text, context?.sessionID)
              return { content: JSON.stringify({ ok: true, ...request }) }
            }
            try {
              const result = await speakDurable(root, location, text, { sessionID: context?.sessionID })
              recordIndex(root, {
                path: String(result.path),
                seconds: result.seconds,
                at: Date.now(),
                via: result.via,
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
                const mutes = resolveMutes(readState(root), location, context?.sessionID)
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
        try {
          const mutes = await readMutes(ctx, root, location, event.sessionID)
          if (mutes.global || mutes.project || mutes.session) {
            log(`muted (${JSON.stringify(mutes)})`)
            return
          }
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
          if (mode === "remote") {
            log("remote mode: not implemented, skipping auto-speak")
            return
          }
          if (mode === "client") {
            const title = cleaned ? "" : ((await sessionTitle(root, event.sessionID)) ?? "this session")
            const payload = cleaned || noticeTemplate.replaceAll("{session}", title)
            const request = writeRequest(root, payload, event.sessionID)
            log(`requested ${request.id}${cleaned ? "" : " (untranscribable notice)"}`)
            return
          }
          if (!cleaned) {
            const title = (await sessionTitle(root, event.sessionID)) ?? "this session"
            const notice = noticeTemplate.replaceAll("{session}", title)
            log(`nothing speakable in ${last.id}; announcing`)
            const result = await speakDurable(root, location, notice, { noPreamble: true })
            recordIndex(root, { path: String(result.path), seconds: result.seconds, at: Date.now(), via: result.via })
            return
          }
          const result = await speakDurable(root, location, cleaned, { sessionID: event.sessionID })
          recordIndex(root, { path: String(result.path), seconds: result.seconds, at: Date.now(), via: result.via })
        } catch (error) {
          log("auto-speak failed", String(error))
        }
      })
      log("auto-speak hook registered")
    } catch (error) {
      log("auto-speak hook failed", String(error))
    }

    return () => cleanups.forEach((cleanup) => cleanup())
  },
})
