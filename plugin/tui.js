// src/tui.tsx
import { readFileSync as readFileSync2 } from "node:fs";
import path2 from "node:path";
import { createSignal } from "solid-js";
import { Plugin } from "@opencode/plugin/tui";

// state.ts
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
var EMPTY = { global: false, projects: {}, sessions: {}, sidebar: true };
function statePath(root) {
  return path.join(root, ".voice-state.json");
}
function readState(root) {
  try {
    const parsed = JSON.parse(readFileSync(statePath(root), "utf8"));
    return {
      global: parsed?.global === true,
      projects: parsed?.projects && typeof parsed.projects === "object" ? parsed.projects : {},
      sessions: parsed?.sessions && typeof parsed.sessions === "object" ? parsed.sessions : {},
      sidebar: parsed?.sidebar !== false,
      queue: parsed?.queue && typeof parsed.queue.at === "number" ? {
        at: parsed.queue.at,
        queued: Number(parsed.queue.queued) || 0,
        playing: Number(parsed.queue.playing) || 0,
        failed: Number(parsed.queue.failed) || 0
      } : void 0,
      audio: parsed?.audio && typeof parsed.audio.at === "number" ? {
        at: parsed.audio.at,
        available: parsed.audio.available === true,
        muted: parsed.audio.muted === true,
        volume: Number(parsed.audio.volume) || 0
      } : void 0,
      cache: parsed?.cache && typeof parsed.cache.at === "number" ? {
        at: parsed.cache.at,
        files: Number(parsed.cache.files) || 0,
        bytes: Number(parsed.cache.bytes) || 0
      } : void 0,
      lastPurge: parsed?.lastPurge && typeof parsed.lastPurge.at === "number" ? {
        at: parsed.lastPurge.at,
        removed: Number(parsed.lastPurge.removed) || 0,
        bytes: Number(parsed.lastPurge.bytes) || 0
      } : void 0
    };
  } catch {
    return EMPTY;
  }
}
function writeState(root, state) {
  const file = statePath(root);
  const tmp = `${file}.part`;
  writeFileSync(tmp, `${JSON.stringify(state, null, 2)}
`);
  renameSync(tmp, file);
  return state;
}
function resolveMutes(state, location, sessionID) {
  return {
    global: state.global,
    project: state.projects[location] === true,
    session: sessionID ? state.sessions[sessionID] === true : false
  };
}
function setMute(root, scope, location, sessionID, value) {
  const state = readState(root);
  if (scope === "global") state.global = value;
  else if (scope === "project") state.projects[location] = value;
  else if (sessionID) state.sessions[sessionID] = value;
  writeState(root, state);
  const mutes = resolveMutes(state, location, sessionID);
  return { state, mutes, effective: mutes.global || mutes.project || mutes.session };
}
function setSidebar(root, visible) {
  const state = readState(root);
  state.sidebar = visible;
  return writeState(root, state);
}

// src/tui.tsx
function readIndex(root, limit = 4) {
  try {
    const parsed = JSON.parse(readFileSync2(path2.join(root, ".voice-index.json"), "utf8"));
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((entry) => entry && typeof entry.path === "string").slice(0, limit);
  } catch {
    return [];
  }
}
function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}
function entryLabel(entry) {
  const name = path2.basename(entry.path);
  if (!entry.session) return name;
  const title = entry.session.length > 10 ? `${entry.session.slice(0, 9)}\u2026` : entry.session;
  return `${title} ${name}`;
}
function age(at) {
  const seconds = Math.max(0, Math.round((Date.now() - at) / 1e3));
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  return `${Math.round(seconds / 3600)}h`;
}
var tui_default = Plugin.define({
  id: "assistant-voice.tui",
  setup(ctx) {
    const root = String(ctx.options?.root ?? "/media/share/opencode-audio-tool");
    const location = ctx.location?.directory ?? process.cwd();
    const [sidebarVisible, setSidebarVisible] = createSignal(readState(root).sidebar);
    const toggleSidebar = () => {
      const next = !sidebarVisible();
      setSidebarVisible(next);
      setSidebar(root, next);
      ctx.ui.toast.show({ message: `voice: sidebar ${next ? "shown" : "hidden"}`, variant: "info" });
    };
    const runVoiceCommand = (input) => {
      const args = (input ?? "").trim().split(/\s+/).filter(Boolean);
      const verb = (args[0] ?? "").toLowerCase();
      const scope = args[1] ?? "session";
      const validScope = scope === "session" || scope === "project" || scope === "global";
      if (!verb || verb === "open" || verb === "tool") return openAudioTool();
      if (verb === "status") {
        return ctx.ui.toast.show({ message: `voice: ${statusLine()}`, variant: "info" });
      }
      if (verb === "sidebar") return toggleSidebar();
      if (verb === "purge") {
        const days = args[1] !== void 0 ? Number(args[1]) : 0;
        void purge(Number.isFinite(days) ? days : 0);
        return;
      }
      if (verb === "mute" || verb === "unmute") {
        if (!validScope) {
          return ctx.ui.toast.show({ message: "voice: scope must be session, project, or global", variant: "warning" });
        }
        const result = setMute(root, scope, location, currentSession(), verb === "mute");
        return ctx.ui.toast.show({
          message: `voice: ${scope} auto-speak ${result.effective ? "muted" : "on"}`,
          variant: "info"
        });
      }
      if (verb === "toggle") {
        if (!validScope) {
          return ctx.ui.toast.show({ message: "voice: scope must be session, project, or global", variant: "warning" });
        }
        return toggle(scope);
      }
      return ctx.ui.toast.show({
        message: "voice: /voice [open|status|mute|unmute|toggle|sidebar|purge] [session|project|global|days]",
        variant: "warning"
      });
    };
    const currentSession = () => {
      const route = ctx.ui.router.current();
      return route?.type === "session" ? route.sessionID : void 0;
    };
    const mutes = () => resolveMutes(readState(root), location, currentSession());
    const toggle = (scope) => {
      const current = (() => {
        const state = mutes();
        return scope === "global" ? state.global : scope === "project" ? state.project : state.session;
      })();
      const result = setMute(root, scope, location, currentSession(), !current);
      ctx.ui.toast.show({
        message: `voice: ${scope} auto-speak ${result.effective ? "muted" : "on"}`,
        variant: "info"
      });
    };
    const openAudioTool = () => {
      void ctx.ui.router.navigate({ type: "plugin", name: "voice" });
    };
    const statusLine = () => {
      const state = mutes();
      const label = (value) => value ? "muted" : "on";
      return `session ${label(state.session)} \xB7 project ${label(state.project)} \xB7 global ${label(state.global)}`;
    };
    const AudioToolPage = () => {
      const entries = readIndex(root, 12);
      const stored = readState(root);
      const cache = stored.cache;
      const queue = stored.queue;
      const audio = stored.audio;
      return /* @__PURE__ */ React.createElement("box", { flexDirection: "column", padding: 1, gap: 1 }, /* @__PURE__ */ React.createElement("text", null, "Audio tool"), /* @__PURE__ */ React.createElement("text", null, statusLine()), cache ? /* @__PURE__ */ React.createElement("text", null, `cache ${formatBytes(cache.bytes)} \xB7 ${cache.files} file${cache.files === 1 ? "" : "s"}`) : null, queue ? /* @__PURE__ */ React.createElement("text", null, `queue ${queue.queued} \xB7 playing ${queue.playing}`) : null, audio ? /* @__PURE__ */ React.createElement("text", null, `output ${audio.available ? audio.muted ? "MUTED" : `${Math.round(audio.volume * 100)}%` : "host"}`) : null, /* @__PURE__ */ React.createElement("box", { flexDirection: "column" }, /* @__PURE__ */ React.createElement("text", null, "Recent"), entries.length === 0 ? /* @__PURE__ */ React.createElement("text", null, "  nothing yet") : entries.map((entry) => /* @__PURE__ */ React.createElement("text", null, `  ${entryLabel(entry)}  ${entry.seconds ? `${entry.seconds}s` : ""}  ${age(entry.at)}`))), /* @__PURE__ */ React.createElement("box", { flexDirection: "column" }, /* @__PURE__ */ React.createElement("text", null, "Mute"), /* @__PURE__ */ React.createElement("box", { onMouseDown: () => toggle("session") }, /* @__PURE__ */ React.createElement("text", null, `  [${mutes().session ? "x" : " "}] this session`)), /* @__PURE__ */ React.createElement("box", { onMouseDown: () => toggle("project") }, /* @__PURE__ */ React.createElement("text", null, `  [${mutes().project ? "x" : " "}] this project`)), /* @__PURE__ */ React.createElement("box", { onMouseDown: () => toggle("global") }, /* @__PURE__ */ React.createElement("text", null, `  [${mutes().global ? "x" : " "}] everywhere`))), /* @__PURE__ */ React.createElement("text", null, "esc to go back \xB7 palette: Voice"));
    };
    let disposeRoute;
    try {
      disposeRoute = ctx.ui.router.register({ name: "voice", render: () => /* @__PURE__ */ React.createElement(AudioToolPage, null) });
    } catch {
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
            run: (input) => runVoiceCommand(input)
          },
          {
            id: "assistant-voice.sidebar",
            title: "Voice: toggle audio sidebar",
            group: "Voice",
            palette: true,
            run: toggleSidebar
          },
          {
            id: "assistant-voice.mute-session",
            title: "Voice: toggle mute (session)",
            group: "Voice",
            palette: true,
            run: () => toggle("session")
          },
          {
            id: "assistant-voice.mute-project",
            title: "Voice: toggle mute (project)",
            group: "Voice",
            palette: true,
            run: () => toggle("project")
          },
          {
            id: "assistant-voice.mute-global",
            title: "Voice: toggle mute (all)",
            group: "Voice",
            palette: true,
            run: () => toggle("global")
          },
          {
            id: "assistant-voice.purge",
            title: "Voice: purge generated audio",
            group: "Voice",
            palette: true,
            run: () => void purge(0)
          },
          {
            id: "assistant-voice.status",
            title: "Voice: show auto-speak status",
            group: "Voice",
            palette: true,
            run: () => ctx.ui.toast.show({ message: `voice: ${statusLine()}`, variant: "info" })
          }
        ],
        bindings: []
      }));
    } catch {
    }
    const disposers = [];
    if (disposeRoute) disposers.push(disposeRoute);
    try {
      const slot = ctx.ui.slot({
        append: "sidebar.content",
        render: () => {
          if (!sidebarVisible()) return null;
          const entries = readIndex(root);
          const stored = readState(root);
          const cache = stored.cache;
          const queue = stored.queue;
          const audio = stored.audio;
          return /* @__PURE__ */ React.createElement("box", { flexDirection: "column" }, /* @__PURE__ */ React.createElement("box", { onMouseDown: openAudioTool }, /* @__PURE__ */ React.createElement("text", null, "\u{1F399} voice \xB7 open audio tool")), entries.map((entry) => /* @__PURE__ */ React.createElement("text", null, `  ${entryLabel(entry)}  ${entry.seconds ? `${entry.seconds}s` : ""}  ${age(entry.at)}`)), cache ? /* @__PURE__ */ React.createElement("text", null, `  cache ${formatBytes(cache.bytes)} \xB7 ${cache.files} file${cache.files === 1 ? "" : "s"}`) : null, queue ? /* @__PURE__ */ React.createElement("text", null, `  queue ${queue.queued} \xB7 playing ${queue.playing}`) : null, audio ? /* @__PURE__ */ React.createElement("text", null, `  output ${audio.available ? audio.muted ? "MUTED" : `${Math.round(audio.volume * 100)}%` : "host"}`) : null);
        }
      });
      if (typeof slot === "function") disposers.push(slot);
    } catch {
    }
    try {
      const chip = ctx.ui.slot({
        append: "home.footer.status",
        render: () => /* @__PURE__ */ React.createElement("box", { onMouseDown: openAudioTool }, /* @__PURE__ */ React.createElement("text", null, "\u{1F399} voice"))
      });
      if (typeof chip === "function") disposers.push(chip);
    } catch {
    }
    return () => {
      for (const dispose of disposers) dispose();
    };
  }
});
export {
  tui_default as default
};
