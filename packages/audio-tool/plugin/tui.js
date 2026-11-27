var __defProp = Object.defineProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};

// src/tui.tsx
import { readFileSync as readFileSync2 } from "node:fs";
import path2 from "node:path";
import { createSignal } from "solid-js";
import { Plugin } from "@opencode/plugin/tui";

// state.ts
import { readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
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
      generating: parsed?.generating && typeof parsed.generating.at === "number" ? { at: parsed.generating.at, count: Number(parsed.generating.count) || 0 } : void 0,
      lastSpeaker: parsed?.lastSpeaker && typeof parsed.lastSpeaker.at === "number" && parsed.lastSpeaker.session ? { at: parsed.lastSpeaker.at, session: String(parsed.lastSpeaker.session) } : void 0,
      queue: parsed?.queue && typeof parsed.queue.at === "number" ? {
        at: parsed.queue.at,
        queued: Number(parsed.queue.queued) || 0,
        playing: Number(parsed.queue.playing) || 0,
        failed: Number(parsed.queue.failed) || 0,
        ...typeof parsed.queue.playingSession === "string" && parsed.queue.playingSession ? { playingSession: parsed.queue.playingSession } : {}
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
      lastAttempt: parsed?.lastAttempt && typeof parsed.lastAttempt.at === "number" ? {
        at: parsed.lastAttempt.at,
        removed: Number(parsed.lastAttempt.removed) || 0,
        bytes: Number(parsed.lastAttempt.bytes) || 0
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
function writeState(root, state2) {
  const file = statePath(root);
  const tmp = `${file}.${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}.part`;
  const payload = `${JSON.stringify(state2, null, 2)}
`;
  try {
    writeFileSync(tmp, payload);
    renameSync(tmp, file);
  } catch {
    try {
      writeFileSync(file, payload);
    } catch {
    }
    try {
      unlinkSync(tmp);
    } catch {
    }
  }
  return state2;
}
function resolveMutes(state2, location2, sessionID) {
  return {
    global: state2.global,
    project: state2.projects[location2] === true,
    session: sessionID ? state2.sessions[sessionID] === true : false
  };
}
function setMute(root, scope, location2, sessionID, value) {
  const state2 = readState(root);
  if (scope === "global") state2.global = value;
  else if (scope === "project") state2.projects[location2] = value;
  else if (sessionID) state2.sessions[sessionID] = value;
  writeState(root, state2);
  const mutes2 = resolveMutes(state2, location2, sessionID);
  return { state: state2, mutes: mutes2, effective: mutes2.global || mutes2.project || mutes2.session };
}
function setSidebar(root, visible) {
  const state2 = readState(root);
  state2.sidebar = visible;
  return writeState(root, state2);
}

// node_modules/@opencode/schema/dist/rpc.js
var rpc_exports = {};
__export(rpc_exports, {
  Rpc: () => rpc_exports,
  define: () => define
});
function define(definition) {
  const reserved = Object.values(definition.methods).flatMap((method) => Object.keys(method.errors ?? {})).find((name) => name.startsWith("rpc."));
  if (reserved)
    throw new Error(`RPC error names starting with "rpc." are reserved: ${reserved}`);
  return definition;
}

// rpc.ts
var entry = {
  type: "object",
  properties: {
    path: { type: "string" },
    seconds: { type: "number" },
    at: { type: "number" },
    session: { type: "string" },
    child: { type: "boolean" }
  },
  required: ["path", "at"],
  additionalProperties: false
};
var mutes = {
  type: "object",
  properties: {
    session: { type: "boolean" },
    project: { type: "boolean" },
    global: { type: "boolean" }
  },
  required: ["session", "project", "global"],
  additionalProperties: false
};
var state = {
  type: "object",
  properties: {
    entries: { type: "array", items: entry },
    mutes,
    sidebar: { type: "boolean" },
    mode: { type: "string", enum: ["host", "client", "remote"] },
    source: { type: "string", enum: ["local", "host"] },
    statsAgeMs: { type: "number" },
    generating: { type: "number" },
    queue: {
      type: "object",
      properties: {
        queued: { type: "number" },
        playing: { type: "number" },
        failed: { type: "number" },
        playingSession: { type: "string" }
      },
      required: ["queued", "playing", "failed"],
      additionalProperties: false
    },
    audio: {
      type: "object",
      properties: {
        at: { type: "number" },
        available: { type: "boolean" },
        muted: { type: "boolean" },
        volume: { type: "number" }
      },
      required: ["at", "available", "muted", "volume"],
      additionalProperties: false
    },
    cache: {
      type: "object",
      properties: {
        at: { type: "number" },
        files: { type: "number" },
        bytes: { type: "number" }
      },
      required: ["at", "files", "bytes"],
      additionalProperties: false
    },
    lastSpeaker: {
      type: "object",
      properties: {
        at: { type: "number" },
        session: { type: "string" },
        child: { type: "boolean" }
      },
      required: ["at", "session"],
      additionalProperties: false
    },
    lastAttempt: {
      type: "object",
      properties: {
        at: { type: "number" },
        removed: { type: "number" },
        bytes: { type: "number" }
      },
      required: ["at", "removed", "bytes"],
      additionalProperties: false
    },
    lastPurge: {
      type: "object",
      properties: {
        at: { type: "number" },
        removed: { type: "number" },
        bytes: { type: "number" }
      },
      required: ["at", "removed", "bytes"],
      additionalProperties: false
    }
  },
  required: ["entries", "mutes", "sidebar", "mode", "source", "statsAgeMs", "generating"],
  additionalProperties: false
};
var location = {
  directory: { type: "string" },
  sessionID: { type: "string" }
};
var Voice = rpc_exports.define({
  id: "assistant-voice",
  methods: {
    state: {
      input: {
        type: "object",
        properties: location,
        required: ["directory"],
        additionalProperties: false
      },
      output: state
    },
    setMute: {
      input: {
        type: "object",
        properties: {
          ...location,
          scope: { type: "string", enum: ["session", "project", "global"] },
          value: { type: "boolean" }
        },
        required: ["directory", "scope", "value"],
        additionalProperties: false
      },
      output: state
    },
    setVolume: {
      input: {
        type: "object",
        properties: {
          ...location,
          value: { type: "number" }
        },
        required: ["directory", "value"],
        additionalProperties: false
      },
      output: state
    },
    repeat: {
      input: {
        type: "object",
        properties: location,
        required: ["directory", "sessionID"],
        additionalProperties: false
      },
      output: state
    },
    summary: {
      input: {
        type: "object",
        properties: location,
        required: ["directory", "sessionID"],
        additionalProperties: false
      },
      output: state
    },
    replay: {
      input: {
        type: "object",
        properties: {
          ...location,
          path: { type: "string" }
        },
        required: ["directory", "path"],
        additionalProperties: false
      },
      output: state
    },
    remove: {
      input: {
        type: "object",
        properties: {
          ...location,
          path: { type: "string" }
        },
        required: ["directory", "path"],
        additionalProperties: false
      },
      output: state
    },
    purge: {
      input: {
        type: "object",
        properties: {
          ...location,
          days: { type: "number" }
        },
        required: ["directory"],
        additionalProperties: false
      },
      output: state
    },
    setSidebar: {
      input: {
        type: "object",
        properties: { visible: { type: "boolean" } },
        required: ["visible"],
        additionalProperties: false
      },
      output: state
    }
  }
});

// commands.ts
var VOICE_SLASH = {
  name: "voice",
  aliases: ["audio"],
  usage: "/voice [open|status|mute|unmute|toggle|repeat|summary|purge|sidebar] [session|project|global|days]"
};
var VOICE_PALETTE = [
  {
    id: "open",
    title: "Voice: open audio tool",
    keywords: "audio speech tts panel show",
    input: "open",
    clients: ["gui", "tui"]
  },
  {
    id: "status",
    title: "Voice: show auto-speak status",
    keywords: "mute muted state",
    input: "status",
    clients: ["gui", "tui"]
  },
  {
    id: "repeat",
    title: "Voice: speak previous reply",
    keywords: "again replay last read aloud",
    input: "repeat",
    clients: ["gui", "tui"]
  },
  {
    id: "summary",
    title: "Voice: summarize where we're at",
    keywords: "status recap progress spoken",
    input: "summary",
    clients: ["gui", "tui"]
  },
  {
    id: "mute-session",
    title: "Voice: toggle mute (session)",
    keywords: "silence quiet this session",
    input: "toggle session",
    clients: ["gui", "tui"]
  },
  {
    id: "mute-project",
    title: "Voice: toggle mute (project)",
    keywords: "silence quiet project",
    input: "toggle project",
    clients: ["gui", "tui"]
  },
  {
    id: "mute-global",
    title: "Voice: toggle mute (all)",
    keywords: "silence quiet everything global",
    input: "toggle global",
    clients: ["gui", "tui"]
  },
  {
    id: "sidebar",
    title: "Voice: toggle audio sidebar",
    keywords: "panel show hide sidebar",
    input: "sidebar",
    clients: ["tui"]
  },
  {
    id: "purge-old",
    title: "Voice: purge audio older than retention",
    keywords: "cleanup delete cache files",
    input: "purge",
    clients: ["gui", "tui"]
  },
  {
    id: "purge-all",
    title: "Voice: purge all generated audio",
    keywords: "wipe destructive cache files",
    input: "purge 0",
    clients: ["gui", "tui"]
  }
];
function parseVoiceInput(input) {
  const parts = (input ?? "").trim().split(/\s+/).filter(Boolean);
  return { verb: (parts[0] ?? "").toLowerCase(), arg: parts[1]?.toLowerCase(), parts };
}

// src/tui.tsx
function readIndex(root, limit = 4) {
  try {
    const parsed = JSON.parse(readFileSync2(path2.join(root, ".voice-index.json"), "utf8"));
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((entry2) => entry2 && typeof entry2.path === "string").slice(0, limit);
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
function entryLabel(entry2) {
  const name = path2.basename(entry2.path);
  if (!entry2.session) return name;
  const title = entry2.session.length > 10 ? `${entry2.session.slice(0, 9)}\u2026` : entry2.session;
  return `${entry2.child ? "\u21B3 " : ""}${title} ${name}`;
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
    const location2 = ctx.location?.directory ?? process.cwd();
    const [sidebarVisible, setSidebarVisible] = createSignal(readState(root).sidebar);
    const toggleSidebar = () => {
      const next = !sidebarVisible();
      setSidebarVisible(next);
      setSidebar(root, next);
      ctx.ui.toast.show({ message: `voice: sidebar ${next ? "shown" : "hidden"}`, variant: "info" });
    };
    const runVoiceCommand = (input) => {
      const { verb, parts } = parseVoiceInput(input);
      const args = parts;
      const scope = parts[1] ?? "session";
      const validScope = scope === "session" || scope === "project" || scope === "global";
      if (!verb || verb === "open" || verb === "tool") return openAudioTool();
      if (verb === "status") {
        return ctx.ui.toast.show({ message: `voice: ${statusLine()}`, variant: "info" });
      }
      if (verb === "sidebar") return toggleSidebar();
      if ((verb === "repeat" || verb === "last" || verb === "summary" || verb === "summarize") && currentSession()) {
        const sessionID = currentSession();
        const call = verb === "repeat" || verb === "last" ? ctx.client.rpc(Voice).repeat({ directory: location2, sessionID }) : ctx.client.rpc(Voice).summary({ directory: location2, sessionID });
        ctx.ui.toast.show({
          message: verb === "summary" || verb === "summarize" ? "voice: summarising\u2026" : "voice: replaying previous reply\u2026",
          variant: "info"
        });
        void call.catch(() => {
        });
        return;
      }
      if (verb === "purge") {
        const days = args[1] !== void 0 ? Number(args[1]) : void 0;
        void purge(typeof days === "number" && Number.isFinite(days) ? days : void 0);
        return;
      }
      if (verb === "mute" || verb === "unmute") {
        if (!validScope) {
          return ctx.ui.toast.show({ message: "voice: scope must be session, project, or global", variant: "warning" });
        }
        const result = setMute(root, scope, location2, currentSession(), verb === "mute");
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
      return ctx.ui.toast.show({ message: `voice: usage ${VOICE_SLASH.usage}`, variant: "warning" });
    };
    const currentSession = () => {
      const route = ctx.ui.router.current();
      return route?.type === "session" ? route.sessionID : void 0;
    };
    const mutes2 = () => resolveMutes(readState(root), location2, currentSession());
    const toggle = (scope) => {
      const current = (() => {
        const state2 = mutes2();
        return scope === "global" ? state2.global : scope === "project" ? state2.project : state2.session;
      })();
      const result = setMute(root, scope, location2, currentSession(), !current);
      ctx.ui.toast.show({
        message: `voice: ${scope} auto-speak ${result.effective ? "muted" : "on"}`,
        variant: "info"
      });
    };
    const openAudioTool = () => {
      void ctx.ui.router.navigate({ type: "plugin", name: "voice" });
    };
    const statusLine = () => {
      const state2 = mutes2();
      const label = (value) => value ? "muted" : "on";
      return `session ${label(state2.session)} \xB7 project ${label(state2.project)} \xB7 global ${label(state2.global)}`;
    };
    const AudioToolPage = () => {
      const entries = readIndex(root, 12);
      const stored = readState(root);
      const cache = stored.cache;
      const queue = stored.queue;
      const speaker = stored.lastSpeaker?.session;
      const generating = stored.generating?.count ?? 0;
      const audio = stored.audio;
      return /* @__PURE__ */ React.createElement("box", { flexDirection: "column", padding: 1, gap: 1 }, /* @__PURE__ */ React.createElement("text", null, "Audio tool"), /* @__PURE__ */ React.createElement("text", null, statusLine()), cache ? /* @__PURE__ */ React.createElement("text", null, `cache (all) ${formatBytes(cache.bytes)} \xB7 ${cache.files} file${cache.files === 1 ? "" : "s"}`) : null, queue ? /* @__PURE__ */ React.createElement("text", null, `queue ${queue.queued} \xB7 playing ${queue.playing}${generating > 0 ? ` \xB7 ${generating} generating` : ""}${queue.playingSession ? ` (${queue.playingSession})` : speaker ? ` \xB7 latest: ${speaker}` : ""}`) : null, audio ? /* @__PURE__ */ React.createElement("text", null, `volume ${audio.available ? audio.muted ? "MUTED" : `${Math.round(audio.volume * 100)}%` : "host"}`) : null, /* @__PURE__ */ React.createElement("box", { flexDirection: "column" }, /* @__PURE__ */ React.createElement("text", null, "Recent"), entries.length === 0 ? /* @__PURE__ */ React.createElement("text", null, "  nothing yet") : entries.map((entry2) => /* @__PURE__ */ React.createElement("box", { onMouseDown: () => replay(entry2.path) }, /* @__PURE__ */ React.createElement("text", null, `  ${entryLabel(entry2)}  ${entry2.seconds ? `${entry2.seconds}s` : ""}  ${age(entry2.at)}`)))), /* @__PURE__ */ React.createElement("box", { flexDirection: "column" }, /* @__PURE__ */ React.createElement("text", null, "Mute"), /* @__PURE__ */ React.createElement("box", { onMouseDown: () => toggle("session") }, /* @__PURE__ */ React.createElement("text", null, `  [${mutes2().session ? "x" : " "}] this session`)), /* @__PURE__ */ React.createElement("box", { onMouseDown: () => toggle("project") }, /* @__PURE__ */ React.createElement("text", null, `  [${mutes2().project ? "x" : " "}] this project`)), /* @__PURE__ */ React.createElement("box", { onMouseDown: () => toggle("global") }, /* @__PURE__ */ React.createElement("text", null, `  [${mutes2().global ? "x" : " "}] everywhere`))), /* @__PURE__ */ React.createElement("text", null, "esc to go back \xB7 palette: Voice"));
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
        commands: VOICE_PALETTE.filter((entry2) => entry2.clients.includes("tui")).map((spec) => ({
          id: `assistant-voice.${spec.id}`,
          title: spec.title,
          group: "Voice",
          palette: true,
          ...spec.id === "open" ? {
            slash: {
              name: VOICE_SLASH.name,
              aliases: [...VOICE_SLASH.aliases],
              arguments: true
            }
          } : {},
          run: (value) => runVoiceCommand(value ?? spec.input)
        }))
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
          const speaker = stored.lastSpeaker?.session;
          const generating = stored.generating?.count ?? 0;
          const audio = stored.audio;
          return /* @__PURE__ */ React.createElement("box", { flexDirection: "column" }, /* @__PURE__ */ React.createElement("box", { onMouseDown: openAudioTool }, /* @__PURE__ */ React.createElement("text", null, "\u{1F399} voice \xB7 open audio tool")), entries.map((entry2) => /* @__PURE__ */ React.createElement("text", null, `  ${entryLabel(entry2)}  ${entry2.seconds ? `${entry2.seconds}s` : ""}  ${age(entry2.at)}`)), cache ? /* @__PURE__ */ React.createElement("text", null, `  cache (all) ${formatBytes(cache.bytes)} \xB7 ${cache.files} file${cache.files === 1 ? "" : "s"}`) : null, queue ? /* @__PURE__ */ React.createElement("text", null, `  queue ${queue.queued} \xB7 playing ${queue.playing}${generating > 0 ? ` \xB7 ${generating} generating` : ""}${queue.playingSession ? ` (${queue.playingSession})` : speaker ? ` \xB7 latest: ${speaker}` : ""}`) : null, audio ? /* @__PURE__ */ React.createElement("text", null, `  volume ${audio.available ? audio.muted ? "MUTED" : `${Math.round(audio.volume * 100)}%` : "host"}`) : null);
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
