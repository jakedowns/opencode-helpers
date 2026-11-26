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
  },
  required: ["entries", "mutes", "sidebar"],
  additionalProperties: false,
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
