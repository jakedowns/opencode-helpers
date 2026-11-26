/**
 * assistant-voice — TUI part.
 *
 * - sidebar/content: recent audio + a button that opens the audio tool page
 * - home footer: the same button on the new-tab page
 * - route "voice": the audio tool (recent items, mute toggles)
 * - palette: Voice group commands for the three mute scopes
 *
 * All state is read from disk (.voice-index.json / .voice-state.json), so the
 * server and TUI parts stay decoupled.
 */
import { readFileSync } from "node:fs"
import path from "node:path"
import { createSignal } from "solid-js"
import { Plugin } from "@opencode/plugin/tui"
import { readState, resolveMutes, setMute, setSidebar } from "../state.ts"
import { Voice } from "../rpc.ts"

type Scope = "session" | "project" | "global"
type IndexEntry = { path: string; seconds?: number; at: number; session?: string }

function readIndex(root: string, limit = 4): IndexEntry[] {
  try {
    const parsed = JSON.parse(readFileSync(path.join(root, ".voice-index.json"), "utf8"))
    if (!Array.isArray(parsed)) return []
    return parsed.filter((entry) => entry && typeof entry.path === "string").slice(0, limit)
  } catch {
    return []
  }
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`
}

function entryLabel(entry: IndexEntry): string {
  const name = path.basename(entry.path)
  if (!entry.session) return name
  const title = entry.session.length > 10 ? `${entry.session.slice(0, 9)}…` : entry.session
  return `${title} ${name}`
}

function age(at: number): string {
  const seconds = Math.max(0, Math.round((Date.now() - at) / 1000))
  if (seconds < 60) return `${seconds}s`
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`
  return `${Math.round(seconds / 3600)}h`
}

export default Plugin.define({
  id: "assistant-voice.tui",
  setup(ctx) {
    const root = String((ctx.options as Record<string, unknown> | undefined)?.root ?? "/media/share/opencode-audio-tool")
    const location = ctx.location?.directory ?? process.cwd()
    const [sidebarVisible, setSidebarVisible] = createSignal(readState(root).sidebar)

    const toggleSidebar = () => {
      const next = !sidebarVisible()
      setSidebarVisible(next)
      setSidebar(root, next)
      ctx.ui.toast.show({ message: `voice: sidebar ${next ? "shown" : "hidden"}`, variant: "info" })
    }

    /**
     * One `/voice` namespace mirroring the palette:
     *   /voice                      open the audio tool
     *   /voice status
     *   /voice mute|unmute [scope]
     *   /voice toggle [scope]
     *   /voice sidebar
     */
    const runVoiceCommand = (input?: string) => {
      const args = (input ?? "").trim().split(/\s+/).filter(Boolean)
      const verb = (args[0] ?? "").toLowerCase()
      const scope = (args[1] ?? "session") as Scope
      const validScope = scope === "session" || scope === "project" || scope === "global"

      if (!verb || verb === "open" || verb === "tool") return openAudioTool()
      if (verb === "status") {
        return ctx.ui.toast.show({ message: `voice: ${statusLine()}`, variant: "info" })
      }
      if (verb === "sidebar") return toggleSidebar()
      if ((verb === "repeat" || verb === "last" || verb === "summary" || verb === "summarize") && currentSession()) {
        const sessionID = currentSession() as string
        const call =
          verb === "repeat" || verb === "last"
            ? ctx.client.rpc(Voice).repeat({ directory: location, sessionID })
            : ctx.client.rpc(Voice).summary({ directory: location, sessionID })
        ctx.ui.toast.show({
          message: verb === "summary" || verb === "summarize" ? "voice: summarising…" : "voice: replaying previous reply…",
          variant: "info",
        })
        void call.catch(() => {})
        return
      }
      if (verb === "purge") {
        const days = args[1] !== undefined ? Number(args[1]) : 0
        void purge(Number.isFinite(days) ? days : 0)
        return
      }
      if (verb === "mute" || verb === "unmute") {
        if (!validScope) {
          return ctx.ui.toast.show({ message: "voice: scope must be session, project, or global", variant: "warning" })
        }
        const result = setMute(root, scope, location, currentSession(), verb === "mute")
        return ctx.ui.toast.show({
          message: `voice: ${scope} auto-speak ${result.effective ? "muted" : "on"}`,
          variant: "info",
        })
      }
      if (verb === "toggle") {
        if (!validScope) {
          return ctx.ui.toast.show({ message: "voice: scope must be session, project, or global", variant: "warning" })
        }
        return toggle(scope)
      }
      return ctx.ui.toast.show({
        message: "voice: /voice [open|status|mute|unmute|toggle|sidebar|repeat|summary|purge]",
        variant: "warning",
      })
    }

    const currentSession = (): string | undefined => {
      const route = ctx.ui.router.current() as { type?: string; sessionID?: string } | undefined
      return route?.type === "session" ? route.sessionID : undefined
    }

    const mutes = () => resolveMutes(readState(root), location, currentSession())

    const toggle = (scope: Scope) => {
      const current = (() => {
        const state = mutes()
        return scope === "global" ? state.global : scope === "project" ? state.project : state.session
      })()
      const result = setMute(root, scope, location, currentSession(), !current)
      ctx.ui.toast.show({
        message: `voice: ${scope} auto-speak ${result.effective ? "muted" : "on"}`,
        variant: "info",
      })
    }

    const openAudioTool = () => {
      void ctx.ui.router.navigate({ type: "plugin", name: "voice" })
    }

    const statusLine = () => {
      const state = mutes()
      const label = (value: boolean) => (value ? "muted" : "on")
      return `session ${label(state.session)} · project ${label(state.project)} · global ${label(state.global)}`
    }

    const AudioToolPage = () => {
      const entries = readIndex(root, 12)
      const stored = readState(root)
      const cache = stored.cache
      const queue = stored.queue
      const audio = stored.audio
      return (
        <box flexDirection="column" padding={1} gap={1}>
          <text>Audio tool</text>
          <text>{statusLine()}</text>
          {cache ? <text>{`cache ${formatBytes(cache.bytes)} · ${cache.files} file${cache.files === 1 ? "" : "s"}`}</text> : null}
          {queue ? (
            <text>{`queue ${queue.queued} · playing ${queue.playing}${queue.playingSession ? ` (${queue.playingSession})` : ""}`}</text>
          ) : null}
          {audio ? (
            <text>{`output ${audio.available ? (audio.muted ? "MUTED" : `${Math.round(audio.volume * 100)}%`) : "host"}`}</text>
          ) : null}
          <box flexDirection="column">
            <text>Recent</text>
            {entries.length === 0 ? (
              <text>  nothing yet</text>
            ) : (
              entries.map((entry) => (
                <text>{`  ${entryLabel(entry)}  ${entry.seconds ? `${entry.seconds}s` : ""}  ${age(entry.at)}`}</text>
              ))
            )}
          </box>
          <box flexDirection="column">
            <text>Mute</text>
            <box onMouseDown={() => toggle("session")}>
              <text>{`  [${mutes().session ? "x" : " "}] this session`}</text>
            </box>
            <box onMouseDown={() => toggle("project")}>
              <text>{`  [${mutes().project ? "x" : " "}] this project`}</text>
            </box>
            <box onMouseDown={() => toggle("global")}>
              <text>{`  [${mutes().global ? "x" : " "}] everywhere`}</text>
            </box>
          </box>
          <text>esc to go back · palette: Voice</text>
        </box>
      )
    }

    let disposeRoute: (() => void) | undefined
    try {
      disposeRoute = ctx.ui.router.register({ name: "voice", render: () => <AudioToolPage /> })
    } catch {
      /* routing is optional; palette and sidebar still work */
    }

    try {
      ctx.keymap.layer(() => ({
        mode: "global",
        priority: 10,
        commands: [
          {
            id: "assistant-voice.open",
            title: "Voice: open audio tool",
            group: "Voice",
            palette: true,
            slash: { name: "voice", aliases: ["audio"], arguments: true },
            run: (input?: string) => runVoiceCommand(input),
          },
          {
            id: "assistant-voice.sidebar",
            title: "Voice: toggle audio sidebar",
            group: "Voice",
            palette: true,
            run: toggleSidebar,
          },
          {
            id: "assistant-voice.mute-session",
            title: "Voice: toggle mute (session)",
            group: "Voice",
            palette: true,
            run: () => toggle("session"),
          },
          {
            id: "assistant-voice.mute-project",
            title: "Voice: toggle mute (project)",
            group: "Voice",
            palette: true,
            run: () => toggle("project"),
          },
          {
            id: "assistant-voice.mute-global",
            title: "Voice: toggle mute (all)",
            group: "Voice",
            palette: true,
            run: () => toggle("global"),
          },
          {
            id: "assistant-voice.repeat",
            title: "Voice: speak previous reply",
            group: "Voice",
            palette: true,
            run: () => runVoiceCommand("repeat"),
          },
          {
            id: "assistant-voice.summary",
            title: "Voice: summarize where we're at",
            group: "Voice",
            palette: true,
            run: () => runVoiceCommand("summary"),
          },
          {
            id: "assistant-voice.purge",
            title: "Voice: purge generated audio",
            group: "Voice",
            palette: true,
            run: () => void purge(0),
          },
          {
            id: "assistant-voice.status",
            title: "Voice: show auto-speak status",
            group: "Voice",
            palette: true,
            run: () => ctx.ui.toast.show({ message: `voice: ${statusLine()}`, variant: "info" }),
          },
        ],
        bindings: [],
      }))
    } catch {
      /* a TUI without keymap support still gets the buttons */
    }

    const disposers: Array<() => void> = []
    if (disposeRoute) disposers.push(disposeRoute)

    try {
      const slot = ctx.ui.slot({
        append: "sidebar.content",
        render: () => {
          if (!sidebarVisible()) return null
          const entries = readIndex(root)
          const stored = readState(root)
          const cache = stored.cache
          const queue = stored.queue
          const audio = stored.audio
          return (
            <box flexDirection="column">
              <box onMouseDown={openAudioTool}>
                <text>🎙 voice · open audio tool</text>
              </box>
              {entries.map((entry) => (
                <text>{`  ${entryLabel(entry)}  ${entry.seconds ? `${entry.seconds}s` : ""}  ${age(entry.at)}`}</text>
              ))}
              {cache ? (
                <text>{`  cache ${formatBytes(cache.bytes)} · ${cache.files} file${cache.files === 1 ? "" : "s"}`}</text>
              ) : null}
              {queue ? (
                <text>{`  queue ${queue.queued} · playing ${queue.playing}${queue.playingSession ? ` (${queue.playingSession})` : ""}`}</text>
              ) : null}
              {audio ? (
                <text>{`  output ${audio.available ? (audio.muted ? "MUTED" : `${Math.round(audio.volume * 100)}%`) : "host"}`}</text>
              ) : null}
            </box>
          )
        },
      })
      if (typeof slot === "function") disposers.push(slot)
    } catch {
      /* sidebar slot unavailable */
    }

    try {
      const chip = ctx.ui.slot({
        append: "home.footer.status",
        render: () => (
          <box onMouseDown={openAudioTool}>
            <text>🎙 voice</text>
          </box>
        ),
      })
      if (typeof chip === "function") disposers.push(chip)
    } catch {
      /* home footer unavailable */
    }

    return () => {
      for (const dispose of disposers) dispose()
    }
  },
})
