/**
 * assistant-voice — GUI part (OpenCode Desktop).
 *
 * Palette and slash commands (the "Voice" group), a side-panel tab, and a
 * launcher entry on the New tab page. All state comes from the server part
 * through RPC because a window has no filesystem.
 */
import { Command, MenuItem, Panel, Plugin, usePlugin } from "@opencode/plugin/gui"
import type { PanelTab } from "@opencode/plugin/gui"
import { For, Show, createSignal, onCleanup, onMount } from "solid-js"
import { Voice } from "../rpc.ts"
import { VOICE_PALETTE, VOICE_SLASH, parseVoiceInput, voiceSlashName } from "../commands.ts"

type Entry = { path: string; seconds?: number; at: number; session?: string; child?: boolean }
type Mutes = { session: boolean; project: boolean; global: boolean }
type Purge = { at: number; removed: number; bytes: number }
type Cache = { at: number; files: number; bytes: number }
type Audio = { at: number; available: boolean; muted: boolean; volume: number }
type QueueStats = { queued: number; playing: number; failed: number; playingSession?: string }
type LastSpeaker = { at: number; session: string }
type VoiceStatsRow = { turns: number; spoken: number; skipped: Record<string, number> }
type VoiceStats = {
  at: number
  windowStart: number
  turns: number
  spoken: number
  skipped: Record<string, number>
  sessions: Record<string, VoiceStatsRow>
}
type State = {
  entries: Entry[]
  mutes: Mutes
  sidebar: boolean
  mode?: "host" | "client" | "remote"
  source?: "local" | "host"
  statsAgeMs?: number
  cache?: Cache
  audio?: Audio
  queue?: QueueStats
  generating?: number
  stats?: VoiceStats
  lastSpeaker?: LastSpeaker
  lastPurge?: Purge
  lastAttempt?: Purge
  lastAction?: { at: number; kind: string; status: "running" | "ok" | "empty" | "error"; detail?: string }
  log?: Array<{ at: string; kind: string; status: string; detail?: string }>
}

type Session = { id: string; directory: string }

const tab: PanelTab = {
  id: "main",
  get title() {
    return "Audio"
  },
  closable: "compact",
  fallback: true,
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`
}

function entryLabel(entry: Entry): string {
  const name = entry.path.split("/").pop() ?? entry.path
  if (!entry.session) return name
  const title = entry.session.length > 10 ? `${entry.session.slice(0, 9)}…` : entry.session
  return `${entry.child ? "↳ " : ""}${title} ${name}`
}

function age(at: number): string {
  const seconds = Math.max(0, Math.round((Date.now() - at) / 1000))
  if (seconds < 60) return `${seconds}s`
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`
  return `${Math.round(seconds / 3600)}h`
}

function AudioPanel(props: { session: Session }) {
  const ctx = usePlugin()
  const [state, setState] = createSignal<State | undefined>()

  const refresh = () =>
    ctx.client
      .rpc(Voice)
      .state({ directory: props.session.directory, sessionID: props.session.id })
      .then((next: unknown) => setState(next as State))
      .catch((error) => fail("refresh", error))

  onMount(() => {
    void refresh()
    const timer = setInterval(() => void refresh(), 2_000)
    onCleanup(() => clearInterval(timer))
  })

  const replay = (file: string) =>
    ctx.client
      .rpc(Voice)
      .replay({ directory: props.session.directory, sessionID: props.session.id, path: file })
      .then((next: unknown) => setState(next as State))
      .catch((error) => fail("replay", error))

  const remove = (file: string) =>
    ctx.client
      .rpc(Voice)
      .remove({ directory: props.session.directory, sessionID: props.session.id, path: file })
      .then((next: unknown) => setState(next as State))
      .catch((error) => fail("delete", error))

  const purge = (days?: number) =>
    ctx.client
      .rpc(Voice)
      .purge({
        directory: props.session.directory,
        sessionID: props.session.id,
        ...(typeof days === "number" ? { days } : {}),
      })
      .then((next: unknown) => setState(next as State))
      .catch((error) => fail("mute", error))

  const setVolume = (value: number) =>
    ctx.client
      .rpc(Voice)
      .setVolume({ directory: props.session.directory, sessionID: props.session.id, value })
      .then((next: unknown) => setState(next as State))
      .catch((error) => fail("purge", error))

  const toggle = (scope: "session" | "project" | "global") => {
    const current = state()?.mutes
    const value = scope === "session" ? current?.session : scope === "project" ? current?.project : current?.global
    void ctx.client
      .rpc(Voice)
      .setMute({
        directory: props.session.directory,
        sessionID: props.session.id,
        scope,
        value: !value,
      })
      .then((next: unknown) => setState(next as State))
      .catch(() => {})
  }

  const purgeText = () => {
    const last = state()?.lastPurge
    const attempt = state()?.lastAttempt
    if (attempt && attempt.removed === 0 && (!last || attempt.at >= last.at)) {
      return last && last.removed > 0
        ? `Last purge: nothing to remove · previous freed ${formatBytes(last.bytes)}`
        : "Last purge: nothing to remove"
    }
    if (last) {
      return `Last purge: removed ${last.removed} file${last.removed === 1 ? "" : "s"}, freed ${formatBytes(last.bytes)}`
    }
    return null
  }

  const muteLabel = (scope: "session" | "project" | "global", value?: boolean) =>
    `${value ? "✓" : "○"} ${scope} ${value ? "muted" : "on"}`

  const activeMute = () => {
    const m = state()?.mutes
    if (!m) return ""
    if (m.session) return "session"
    if (m.project) return "project"
    if (m.global) return "global"
    return ""
  }

  const missedCount = (row?: VoiceStatsRow) => {
    if (!row) return 0
    return ["noText", "tooLong", "error", "remote"].reduce(
      (sum, key) => sum + (row.skipped[key] ?? 0),
      0,
    )
  }
  const sessionStats = () => state()?.stats?.sessions?.[props.session.id]
  const statsTitle = () => {
    const global = state()?.stats
    const row = sessionStats()
    const fmt = (value: VoiceStatsRow | undefined) => {
      if (!value) return "no turns yet"
      const reasons = Object.entries(value.skipped)
        .map(([key, count]) => `${key} ${count}`)
        .join(", ")
      return `turns ${value.turns}, spoken ${value.spoken}, missed ${missedCount(value)}${
        reasons ? ` (${reasons})` : ""
      }`
    }
    return `This session: ${fmt(row)}\nLast 24h: ${fmt(global)}`
  }

  return (
    <div
      style={{
        height: "100%",
        "overflow-y": "auto",
        "overflow-x": "hidden",
        "box-sizing": "border-box",
      }}
    >
      <div
        style={{
          display: "flex",
          "flex-direction": "column",
          gap: "8px",
          padding: "12px",
          "font-size": "12px",
          "min-height": "100%",
          "box-sizing": "border-box",
        }}
      >
      <style>{`
        .voice-btn {
          padding: 4px 10px;
          border: 1px solid currentColor;
          border-radius: 4px;
          background: rgba(127, 127, 127, 0.12);
          color: inherit;
          font: inherit;
          font-size: 12px;
          line-height: 1.4;
          cursor: pointer;
        }
        .voice-btn:hover { background: rgba(127, 127, 127, 0.22); }
        .voice-btn:active { background: rgba(127, 127, 127, 0.32); }
        .voice-btn[data-danger="true"] { border-color: #c0504d; color: #c0504d; }
        .voice-btn[data-danger="true"]:hover { background: rgba(192, 80, 77, 0.18); }
        .voice-btn[aria-pressed="true"] { background: rgba(127, 127, 127, 0.3); font-weight: 600; }
        .voice-btn-icon { padding: 0 6px; }
      `}</style>
      <div style={{ display: "flex", "justify-content": "space-between", "align-items": "center" }}>
        <strong>Audio</strong>
        <button type="button" className="voice-btn" onClick={() => void refresh()}>
          Refresh
        </button>
      </div>
      <button
        type="button"
        className="voice-btn"
        aria-pressed={!!activeMute()}
        title={activeMute() ? "Turn auto-speak back on" : "Mute auto-speak everywhere"}
        onClick={() => void quickToggle()}
        style={{
          display: "flex",
          "justify-content": "space-between",
          "align-items": "center",
          gap: "8px",
        }}
      >
        <span>
          Mode: {state()?.mode ?? "?"} · Data: {state()?.source ?? "?"}
          {typeof state()?.statsAgeMs === "number"
            ? ` (${Math.max(0, Math.round((state()?.statsAgeMs ?? 0) / 1000))}s old)`
            : ""}{" "}
          · Auto-speak:{" "}
          {activeMute() ? <strong>muted ({activeMute()})</strong> : <strong>on</strong>}
        </span>
        <span style={{ opacity: 0.6 }}>{activeMute() ? "turn on" : "mute all"}</span>
      </button>
      <Show when={state()?.cache}>
        <div style={{ opacity: 0.7 }}>
          Cache (all): {formatBytes(state()?.cache?.bytes ?? 0)} · {state()?.cache?.files ?? 0} file
          {(state()?.cache?.files ?? 0) === 1 ? "" : "s"}
        </div>
      </Show>
      <Show when={state()?.queue}>
        <div style={{ opacity: 0.7 }}>
          Queue: {state()?.queue?.queued ?? 0} queued · {state()?.queue?.playing ?? 0} playing
          {(state()?.generating ?? 0) > 0 ? ` · ${state()?.generating} generating` : ""}
          {state()?.queue?.playingSession
            ? ` — ${state()?.queue?.playingSession}`
            : state()?.lastSpeaker
              ? ` · latest: ${state()?.lastSpeaker?.session}`
              : ""}
        </div>
      </Show>
      <Show when={state()?.stats}>
        <div style={{ opacity: 0.7 }} title={statsTitle()}>
          Voice: this {sessionStats()?.turns ?? 0} turns · {sessionStats()?.spoken ?? 0} spoken
          {" · "}{missedCount(sessionStats())} missed
          {" | 24h "}{state()?.stats?.turns ?? 0} turns · {state()?.stats?.spoken ?? 0} spoken
          {" · "}{missedCount(state()?.stats)} missed
        </div>
      </Show>
      <Show when={state()?.audio?.available}>
        <div style={{ display: "flex", "align-items": "center", gap: "8px" }}>
          <span>Volume</span>
          <input
            type="range"
            min="0"
            max="100"
            step="1"
            value={Math.round((state()?.audio?.volume ?? 0) * 100)}
            onChange={(event) => void setVolume(Number(event.currentTarget.value) / 100)}
            style={{ flex: "1 1 auto", "min-width": "0" }}
          />
          <span style={{ width: "4ch", "text-align": "right", opacity: 0.7 }}>
            {Math.round((state()?.audio?.volume ?? 0) * 100)}%
          </span>
          {state()?.audio?.muted ? <span style={{ opacity: 0.7 }}>muted</span> : null}
        </div>
      </Show>
      <Show when={state()?.audio && !state()?.audio?.available}>
        <div style={{ opacity: 0.7 }}>Volume: host</div>
      </Show>
      <div style={{ display: "flex", gap: "6px", "flex-wrap": "wrap" }}>
        <button
          type="button"
          className="voice-btn"
          aria-pressed={state()?.mutes.session === true}
          onClick={() => toggle("session")}
        >
          {muteLabel("session", state()?.mutes.session)}
        </button>
        <button
          type="button"
          className="voice-btn"
          aria-pressed={state()?.mutes.project === true}
          onClick={() => toggle("project")}
        >
          {muteLabel("project", state()?.mutes.project)}
        </button>
        <button
          type="button"
          className="voice-btn"
          aria-pressed={state()?.mutes.global === true}
          onClick={() => toggle("global")}
        >
          {muteLabel("global", state()?.mutes.global)}
        </button>
        <button type="button" className="voice-btn" title="Delete replies older than the retention policy" onClick={() => void purge()}>
          Purge older
        </button>
        <button
          type="button"
          className="voice-btn"
          data-danger="true"
          title="Delete every generated reply, ignoring retention"
          onClick={() => void purge(0)}
        >
          Purge all
        </button>
      </div>
      <Show when={state()?.lastAction}>
        <div style={{ opacity: 0.8 }}>
          Last: {state()?.lastAction?.kind}{" "}
          {state()?.lastAction?.status === "ok"
            ? "✓"
            : state()?.lastAction?.status === "error"
              ? "✗"
              : state()?.lastAction?.status === "empty"
                ? "—"
                : "…"}{" "}
          {state()?.lastAction?.detail ?? ""}
          {" · "}
          {Math.max(0, Math.round((Date.now() - (state()?.lastAction?.at ?? Date.now())) / 1000))}s ago
        </div>
      </Show>
      <Show when={purgeText()}>
        <div style={{ opacity: 0.7 }}>{purgeText()}</div>
      </Show>
      <Show when={state()?.log?.length}>
        <div style={{ "border-top": "1px solid rgba(127,127,127,0.3)", "padding-top": "6px" }}>
          <div style={{ opacity: 0.7 }}>Log</div>
          <div
            style={{
              display: "flex",
              "flex-direction": "column",
              gap: "2px",
              "font-family": "ui-monospace, SFMono-Regular, Menlo, monospace",
              "font-size": "11px",
              "max-height": "140px",
              "overflow-y": "auto",
            }}
          >
            <For each={[...(state()?.log ?? [])].reverse()}>
              {(line) => (
                <div style={{ opacity: line.status === "error" ? 1 : 0.75 }}>
                  {line.at.slice(11, 19)} {line.kind} {line.status}
                  {line.detail ? ` · ${line.detail}` : ""}
                </div>
              )}
            </For>
          </div>
        </div>
      </Show>
      <Show when={state()?.entries.length} fallback={<div style={{ opacity: 0.6 }}>No audio yet.</div>}>
        <div
          style={{
            display: "flex",
            "flex-direction": "column",
            gap: "4px",
            "padding-right": "4px",
          }}
        >
          <For each={state()?.entries ?? []}>
            {(entry: Entry) => (
              <div
                title="Click to replay"
                onClick={() => void replay(entry.path)}
                style={{
                  display: "flex",
                  "align-items": "center",
                  gap: "8px",
                  cursor: "pointer",
                  padding: "2px 4px",
                  "border-radius": "4px",
                }}
              >
                <span
                  style={{
                    overflow: "hidden",
                    "text-overflow": "ellipsis",
                    "white-space": "nowrap",
                    flex: 1,
                  }}
                >
                  {entryLabel(entry)}
                </span>
                <span style={{ opacity: 0.6 }}>
                  {entry.seconds ? `${entry.seconds}s · ` : ""}
                  {age(entry.at)}
                </span>
                <button
                  type="button"
                  className="voice-btn voice-btn-icon"
                  title="Delete this file from disk"
                  aria-label={`Delete ${entryLabel(entry)}`}
                  onClick={(event) => {
                    event.stopPropagation()
                    void remove(entry.path)
                  }}
                >
                  ✕
                </button>
              </div>
            )}
          </For>
        </div>
      </Show>
      </div>
    </div>
  )
}

export default Plugin.define({
  i18n: {
    en: {
      title: "Audio",
      open: "Voice: open audio tool",
      status: "Voice: auto-speak status",
      mute: "Voice: mute auto-speak",
      unmute: "Voice: unmute auto-speak",
      menu: "Audio",
      menuDetail: "recent replies",
    },
  },
  setup(ctx) {
    const current = (): Session | undefined => ctx.sessions.current() as Session | undefined

    const openTool = () => {
      const session = current()
      if (session) ctx.layout.open(`${ctx.id}:main`, session)
    }

    const fail = (action: string, error: unknown) => {
      ctx.toast.show({
        title: `Voice: ${action} failed`,
        description: String(error).slice(0, 300),
        variant: "error",
        duration: 8000,
      })
    }

    const runCommand = (input?: string) => {
      const { verb, parts } = parseVoiceInput(input)
      const scope = (parts[1] ?? "session").toLowerCase()
      if (!verb || verb === "open" || verb === "tool") return openTool()
      const session = current()
      if (!session) return
      if (verb === "status") return openTool()
      if (verb === "repeat" || verb === "last") {
        openTool()
        void ctx.client
          .rpc(Voice)
          .repeat({ directory: session.directory, sessionID: session.id })
          .catch((error) => fail("speak previous reply", error))
        return
      }
      if (verb === "summary" || verb === "summarize") {
        openTool()
        void ctx.client
          .rpc(Voice)
          .summary({ directory: session.directory, sessionID: session.id })
          .catch((error) => fail("summarise", error))
        return
      }
      if (verb === "sidebar") return // TUI-only surface
      if (verb === "purge") {
        const days = parts[1] !== undefined ? Number(parts[1]) : undefined
        void ctx.client
          .rpc(Voice)
          .purge({
            directory: session.directory,
            sessionID: session.id,
            ...(typeof days === "number" && Number.isFinite(days) ? { days } : {}),
          })
          .then(() => openTool())
          .catch((error) => fail("purge", error))
        return
      }
      if (verb === "mute" || verb === "unmute" || verb === "toggle") {
        if (scope !== "session" && scope !== "project" && scope !== "global") return
        if (verb === "toggle") {
          void ctx.client
            .rpc(Voice)
            .state({ directory: session.directory, sessionID: session.id })
            .then((current: unknown) => {
              const mutes = (current as { mutes?: Record<string, boolean> })?.mutes ?? {}
              const value = !(scope === "global" ? mutes.global : scope === "project" ? mutes.project : mutes.session)
              return ctx.client
                .rpc(Voice)
                .setMute({ directory: session.directory, sessionID: session.id, scope, value })
            })
            .catch((error) => fail("toggle mute", error))
          return
        }
        void ctx.client.rpc(Voice).setMute({
          directory: session.directory,
          sessionID: session.id,
          scope,
          value: verb === "mute",
        })
      }
    }

    for (const spec of VOICE_PALETTE.filter((entry) => entry.clients.includes("gui"))) {
      ctx.add(
        Command,
        (): Command => ({
          id: spec.id,
          title: spec.title,
          group: "Voice",
          keywords: spec.keywords,
          slash:
            spec.id === "open"
              ? {
                  name: VOICE_SLASH.name,
                  aliases: [...VOICE_SLASH.aliases],
                  arguments: true as const,
                }
              : { name: voiceSlashName(spec) },
          ...(spec.id === "open" ? { featured: true } : {}),
          run: (value?: string) => runCommand(value?.trim() ? value : spec.input),
        }),
      )
    }

    ctx.add(
      MenuItem,
      (): MenuItem => ({
        menu: "session.panel",
        id: "main",
        title: "Audio",
        description: "recent replies and mute",
        run: openTool,
      }),
    )

    ctx.add(Panel, {
      id: "main",
      region: "side",
      width: "narrow",
      list: (input) => (input.open.includes("main") ? [tab] : []),
      render: (props) => <AudioPanel session={props.session as unknown as Session} />,
    })
  },
})
