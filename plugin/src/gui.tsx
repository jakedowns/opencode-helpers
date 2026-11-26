/**
 * assistant-voice — GUI part (OpenCode Desktop).
 *
 * Palette and slash commands (the "Voice" group), a side-panel tab, and a
 * launcher entry on the New tab page. All state comes from the server part
 * through RPC because a window has no filesystem.
 */
import { Command, MenuItem, Panel, Plugin, usePlugin } from "@opencode/plugin/gui"
import type { PanelTab } from "@opencode/plugin/gui"
import { For, Show, createSignal } from "solid-js"
import { Voice } from "../rpc.ts"

type Entry = { path: string; seconds?: number; at: number }
type Mutes = { session: boolean; project: boolean; global: boolean }
type State = { entries: Entry[]; mutes: Mutes; sidebar: boolean }

type Session = { id: string; directory: string }

const tab: PanelTab = {
  id: "main",
  get title() {
    return "Audio"
  },
  closable: "compact",
  fallback: true,
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
      .catch(() => {})

  void refresh()

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

  return (
    <div style={{ display: "flex", "flex-direction": "column", gap: "8px", padding: "12px", "font-size": "12px" }}>
      <div style={{ display: "flex", "justify-content": "space-between", "align-items": "center" }}>
        <strong>Audio</strong>
        <button type="button" onClick={() => void refresh()}>
          Refresh
        </button>
      </div>
      <div style={{ opacity: 0.7 }}>
        session {state()?.mutes.session ? "muted" : "on"} · project {state()?.mutes.project ? "muted" : "on"} · global{" "}
        {state()?.mutes.global ? "muted" : "on"}
      </div>
      <div style={{ display: "flex", gap: "6px", "flex-wrap": "wrap" }}>
        <button type="button" onClick={() => toggle("session")}>
          Mute session
        </button>
        <button type="button" onClick={() => toggle("project")}>
          Mute project
        </button>
        <button type="button" onClick={() => toggle("global")}>
          Mute all
        </button>
      </div>
      <Show when={state()?.entries.length} fallback={<div style={{ opacity: 0.6 }}>No audio yet.</div>}>
        <div style={{ display: "flex", "flex-direction": "column", gap: "4px" }}>
          <For each={state()?.entries ?? []}>
            {(entry: Entry) => (
              <div style={{ display: "flex", "justify-content": "space-between", gap: "8px" }}>
                <span style={{ overflow: "hidden", "text-overflow": "ellipsis", "white-space": "nowrap" }}>
                  {entry.path.split("/").pop()}
                </span>
                <span style={{ opacity: 0.6 }}>
                  {entry.seconds ? `${entry.seconds}s · ` : ""}
                  {age(entry.at)}
                </span>
              </div>
            )}
          </For>
        </div>
      </Show>
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

    const runCommand = (input?: string) => {
      const parts = (input ?? "").trim().split(/\s+/).filter(Boolean)
      const verb = (parts[0] ?? "").toLowerCase()
      const scope = (parts[1] ?? "session").toLowerCase()
      if (!verb || verb === "open" || verb === "tool") return openTool()
      const session = current()
      if (!session) return
      if (verb === "status") return openTool()
      if (verb === "mute" || verb === "unmute") {
        if (scope !== "session" && scope !== "project" && scope !== "global") return
        void ctx.client.rpc(Voice).setMute({
          directory: session.directory,
          sessionID: session.id,
          scope,
          value: verb === "mute",
        })
        return
      }
    }

    ctx.add(
      Command,
      (): Command => ({
        id: "open",
        title: "Voice: open audio tool",
        group: "Voice",
        keywords: "audio speech tts voice",
        slash: { name: "voice", arguments: true },
        featured: true,
        run: (input) => runCommand(input),
      }),
    )

    ctx.add(
      Command,
      (): Command => ({
        id: "status",
        title: "Voice: auto-speak status",
        group: "Voice",
        keywords: "audio mute status",
        run: () => openTool(),
      }),
    )

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
