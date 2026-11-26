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
export type CacheStats = { at: number; files: number; bytes: number }
export type AudioStatus = { at: number; available: boolean; muted: boolean; volume: number }
export type QueueStats = { at: number; queued: number; playing: number; failed: number }

export type VoiceState = {
  global: boolean
  projects: Record<string, boolean>
  sessions: Record<string, boolean>
  sidebar: boolean
  lastPurge?: LastPurge
  cache?: CacheStats
  audio?: AudioStatus
  queue?: QueueStats
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
      queue:
        parsed?.queue && typeof parsed.queue.at === "number"
          ? {
              at: parsed.queue.at,
              queued: Number(parsed.queue.queued) || 0,
              playing: Number(parsed.queue.playing) || 0,
              failed: Number(parsed.queue.failed) || 0,
            }
          : undefined,
      audio:
        parsed?.audio && typeof parsed.audio.at === "number"
          ? {
              at: parsed.audio.at,
              available: parsed.audio.available === true,
              muted: parsed.audio.muted === true,
              volume: Number(parsed.audio.volume) || 0,
            }
          : undefined,
      cache:
        parsed?.cache && typeof parsed.cache.at === "number"
          ? {
              at: parsed.cache.at,
              files: Number(parsed.cache.files) || 0,
              bytes: Number(parsed.cache.bytes) || 0,
            }
          : undefined,
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

export function setCache(root: string, files: number, bytes: number): VoiceState {
  const state = readState(root)
  state.cache = { at: Date.now(), files, bytes }
  return writeState(root, state)
}

export function setAudio(root: string, status: AudioStatus): VoiceState {
  const state = readState(root)
  state.audio = { ...status, at: Date.now() }
  return writeState(root, state)
}

export function setQueue(root: string, counts: { queued: number; playing: number; failed: number }): VoiceState {
  const state = readState(root)
  state.queue = { at: Date.now(), ...counts }
  return writeState(root, state)
}
