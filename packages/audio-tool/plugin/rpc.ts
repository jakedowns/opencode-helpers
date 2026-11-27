/**
 * RPC contract between the server part and the GUI/TUI clients.
 *
 * The GUI window has no filesystem access, so every read and every mute goes
 * through here and the server owns the files.
 */
import { Rpc } from "@opencode/plugin/rpc"

const entry = {
  type: "object",
  properties: {
    path: { type: "string" },
    seconds: { type: "number" },
    at: { type: "number" },
    session: { type: "string" },
    child: { type: "boolean" },
  },
  required: ["path", "at"],
  additionalProperties: false,
} as const

const mutes = {
  type: "object",
  properties: {
    session: { type: "boolean" },
    project: { type: "boolean" },
    global: { type: "boolean" },
  },
  required: ["session", "project", "global"],
  additionalProperties: false,
} as const

const state = {
  type: "object",
  properties: {
    entries: { type: "array", items: entry },
    mutes,
    sidebar: { type: "boolean" },
    mode: { type: "string", enum: ["host", "client", "remote"] },
    modeSource: { type: "string", enum: ["option", "override", "auto"] },
    modeOverride: {
      type: "object",
      properties: {
        at: { type: "number" },
        mode: { type: "string", enum: ["auto", "host", "client"] },
      },
      required: ["at", "mode"],
      additionalProperties: false,
    },
    canHost: { type: "boolean" },
    version: { type: "string" },
    hostHeartbeat: {
      type: "object",
      properties: {
        machine: { type: "string" },
        at: { type: "number" },
      },
      required: ["machine", "at"],
      additionalProperties: false,
    },
    otherHost: {
      type: "object",
      properties: {
        machine: { type: "string" },
        at: { type: "number" },
      },
      required: ["machine", "at"],
      additionalProperties: false,
    },
    playback: {
      type: "object",
      properties: {
        at: { type: "number" },
        file: { type: "string" },
        session: { type: "string" },
        seconds: { type: "number" },
        position: { type: "number" },
        paused: { type: "boolean" },
        source: { type: "string", enum: ["local", "host"] },
      },
      required: ["at", "seconds", "position", "paused", "source"],
      additionalProperties: false,
    },
    source: { type: "string", enum: ["local", "host"] },
    statsAgeMs: { type: "number" },
    generating: { type: "number" },
    queue: {
      type: "object",
      properties: {
        queued: { type: "number" },
        playing: { type: "number" },
        failed: { type: "number" },
        playingSession: { type: "string" },
      },
      required: ["queued", "playing", "failed"],
      additionalProperties: false,
    },
    audio: {
      type: "object",
      properties: {
        at: { type: "number" },
        available: { type: "boolean" },
        muted: { type: "boolean" },
        volume: { type: "number" },
      },
      required: ["at", "available", "muted", "volume"],
      additionalProperties: false,
    },
    cache: {
      type: "object",
      properties: {
        at: { type: "number" },
        files: { type: "number" },
        bytes: { type: "number" },
      },
      required: ["at", "files", "bytes"],
      additionalProperties: false,
    },
    stats: {
      type: "object",
      properties: {
        at: { type: "number" },
        windowStart: { type: "number" },
        turns: { type: "number" },
        spoken: { type: "number" },
        skipped: { type: "object", additionalProperties: true },
        sessions: { type: "object", additionalProperties: true },
      },
      required: ["at", "windowStart", "turns", "spoken", "skipped", "sessions"],
      additionalProperties: false,
    },
    clientPlayback: {
      type: "object",
      properties: {
        at: { type: "number" },
        enabled: { type: "boolean" },
      },
      required: ["at", "enabled"],
      additionalProperties: false,
    },
    log: {
      type: "array",
      items: {
        type: "object",
        properties: {
          at: { type: "string" },
          kind: { type: "string" },
          status: { type: "string" },
          detail: { type: "string" },
        },
        required: ["at", "kind", "status"],
        additionalProperties: false,
      },
    },
    lastAction: {
      type: "object",
      properties: {
        at: { type: "number" },
        kind: { type: "string" },
        status: { type: "string", enum: ["running", "ok", "empty", "error"] },
        detail: { type: "string" },
      },
      required: ["at", "kind", "status"],
      additionalProperties: false,
    },
    lastSpeaker: {
      type: "object",
      properties: {
        at: { type: "number" },
        session: { type: "string" },
    child: { type: "boolean" },
      },
      required: ["at", "session"],
      additionalProperties: false,
    },
    lastAttempt: {
      type: "object",
      properties: {
        at: { type: "number" },
        removed: { type: "number" },
        bytes: { type: "number" },
      },
      required: ["at", "removed", "bytes"],
      additionalProperties: false,
    },
    lastPurge: {
      type: "object",
      properties: {
        at: { type: "number" },
        removed: { type: "number" },
        bytes: { type: "number" },
      },
      required: ["at", "removed", "bytes"],
      additionalProperties: false,
    },
  },
  required: [
    "entries",
    "mutes",
    "sidebar",
    "mode",
    "modeSource",
    "modeOverride",
    "canHost",
    "version",
    "source",
    "statsAgeMs",
    "generating",
  ],  additionalProperties: false,
} as const

const location = {
  directory: { type: "string" },
  sessionID: { type: "string" },
} as const

export const Voice = Rpc.define({
  id: "assistant-voice",
  methods: {
    state: {
      input: {
        type: "object",
        properties: location,
        required: ["directory"],
        additionalProperties: false,
      },
      output: state,
    },
    setMute: {
      input: {
        type: "object",
        properties: {
          ...location,
          scope: { type: "string", enum: ["session", "project", "global"] },
          value: { type: "boolean" },
        },
        required: ["directory", "scope", "value"],
        additionalProperties: false,
      },
      output: state,
    },
    setClientPlayback: {
      input: {
        type: "object",
        properties: {
          ...location,
          enabled: { type: "boolean" },
        },
        required: ["enabled"],
        additionalProperties: false,
      },
      output: state,
    },
    setMode: {
      input: {
        type: "object",
        properties: {
          ...location,
          mode: { type: "string", enum: ["auto", "host", "client"] },
        },
        required: ["directory", "mode"],
        additionalProperties: false,
      },
      output: state,
    },
    clearLog: {
      input: {
        type: "object",
        properties: location,
        required: ["directory"],
        additionalProperties: false,
      },
      output: state,
    },
    playback: {
      input: {
        type: "object",
        properties: {
          ...location,
          action: { type: "string", enum: ["pause", "resume", "seek"] },
          position: { type: "number" },
        },
        required: ["directory", "action"],
        additionalProperties: false,
      },
      output: state,
    },
    setVolume: {
      input: {
        type: "object",
        properties: {
          ...location,
          value: { type: "number" },
        },
        required: ["directory", "value"],
        additionalProperties: false,
      },
      output: state,
    },
    repeat: {
      input: {
        type: "object",
        properties: location,
        required: ["directory", "sessionID"],
        additionalProperties: false,
      },
      output: state,
    },
    summary: {
      input: {
        type: "object",
        properties: location,
        required: ["directory", "sessionID"],
        additionalProperties: false,
      },
      output: state,
    },
    replay: {
      input: {
        type: "object",
        properties: {
          ...location,
          path: { type: "string" },
        },
        required: ["directory", "path"],
        additionalProperties: false,
      },
      output: state,
    },
    remove: {
      input: {
        type: "object",
        properties: {
          ...location,
          path: { type: "string" },
        },
        required: ["directory", "path"],
        additionalProperties: false,
      },
      output: state,
    },
    purge: {
      input: {
        type: "object",
        properties: {
          ...location,
          days: { type: "number" },
        },
        required: ["directory"],
        additionalProperties: false,
      },
      output: state,
    },
    setSidebar: {
      input: {
        type: "object",
        properties: { visible: { type: "boolean" } },
        required: ["visible"],
        additionalProperties: false,
      },
      output: state,
    },
  },
})
