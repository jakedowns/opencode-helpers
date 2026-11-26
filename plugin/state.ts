/**
 * Shared mute state for the server and TUI parts.
 *
 * One small JSON file at the plugin root, written atomically. It lives outside
 * `.dev/` so it works even when a project has no reply config, and it is
 * git-ignored like the voice index.
 */
import { readFileSync, renameSync, writeFileSync } from "node:fs"
import path from "node:path"

export type Scope = "session" | "project" | "global"

export type LastPurge = { at: number; removed: number; bytes: number }

export type VoiceState = {
  global: boolean
  projects: Record<string, boolean>
  sessions: Record<string, boolean>
  sidebar: boolean
  lastPurge?: LastPurge
}

const EMPTY: VoiceState = { global: false, projects: {}, sessions: {}, sidebar: true }

export function statePath(root: string): string {
  return path.join(root, ".voice-state.json")
}

export function readState(root: string): VoiceState {
  try {
    const parsed = JSON.parse(readFileSync(statePath(root), "utf8"))
    return {
      global: parsed?.global === true,
      projects: parsed?.projects && typeof parsed.projects === "object" ? parsed.projects : {},
      sessions: parsed?.sessions && typeof parsed.sessions === "object" ? parsed.sessions : {},
      sidebar: parsed?.sidebar !== false,
      lastPurge:
        parsed?.lastPurge && typeof parsed.lastPurge.at === "number"
          ? {
              at: parsed.lastPurge.at,
              removed: Number(parsed.lastPurge.removed) || 0,
              bytes: Number(parsed.lastPurge.bytes) || 0,
            }
          : undefined,
    }
  } catch {
    return EMPTY
  }
}

export function writeState(root: string, state: VoiceState): VoiceState {
  const file = statePath(root)
  const tmp = `${file}.part`
  writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`)
  renameSync(tmp, file)
  return state
}

export function resolveMutes(state: VoiceState, location: string, sessionID?: string) {
  return {
    global: state.global,
    project: state.projects[location] === true,
    session: sessionID ? state.sessions[sessionID] === true : false,
  }
}

export function setMute(
  root: string,
  scope: Scope,
  location: string,
  sessionID: string | undefined,
  value: boolean,
): { state: VoiceState; mutes: ReturnType<typeof resolveMutes>; effective: boolean } {
  const state = readState(root)
  if (scope === "global") state.global = value
  else if (scope === "project") state.projects[location] = value
  else if (sessionID) state.sessions[sessionID] = value
  writeState(root, state)
  const mutes = resolveMutes(state, location, sessionID)
  return { state, mutes, effective: mutes.global || mutes.project || mutes.session }
}

export function setSidebar(root: string, visible: boolean): VoiceState {
  const state = readState(root)
  state.sidebar = visible
  return writeState(root, state)
}

export function setLastPurge(root: string, removed: number, bytes: number): VoiceState {
  const state = readState(root)
  state.lastPurge = { at: Date.now(), removed, bytes }
  return writeState(root, state)
}
