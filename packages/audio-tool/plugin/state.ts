/**
 * Shared mute state for the server and TUI parts.
 *
 * One small JSON file at the plugin root, written atomically. It lives outside
 * `.dev/` so it works even when a project has no reply config, and it is
 * git-ignored like the voice index.
 */
import { readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs"
import { hostname } from "node:os"
import path from "node:path"

export type Scope = "session" | "project" | "global"

export type LastPurge = { at: number; removed: number; bytes: number }
export type CacheStats = { at: number; files: number; bytes: number }
export type AudioStatus = { at: number; available: boolean; muted: boolean; volume: number }
export type QueueStats = {
  at: number
  queued: number
  playing: number
  failed: number
  playingSession?: string
}
export type LastSpeaker = { at: number; session: string }
export type Generating = { at: number; count: number }
export type ClientPlayback = { at: number; enabled: boolean }
export type LastAction = { at: number; kind: string; status: "running" | "ok" | "empty" | "error"; detail?: string }
export type HostHeartbeat = { machine: string; at: number }
export type Playback = {
  at: number
  file?: string
  session?: string
  seconds: number
  position: number
  paused: boolean
  source: "local" | "host"
}
export type Mode = "auto" | "host" | "client"
export type ModeOverride = { at: number; mode: Mode }

export type VoiceSessionStats = {
  turns: number
  spoken: number
  skipped: Record<string, number>
}

export type VoiceStats = {
  at: number
  windowStart: number
  turns: number
  spoken: number
  skipped: Record<string, number>
  sessions: Record<string, VoiceSessionStats>
}

export type VoiceState = {
  global: boolean
  projects: Record<string, boolean>
  sessions: Record<string, boolean>
  sidebar: boolean
  lastAction?: LastAction
  lastPurge?: LastPurge
  lastAttempt?: LastPurge
  cache?: CacheStats
  audio?: AudioStatus
  queue?: QueueStats
  lastSpeaker?: LastSpeaker
  generating?: Generating
  stats?: VoiceStats
  hostHeartbeat?: HostHeartbeat
  hosts?: Record<string, number>
  playback?: Playback
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
      lastAction:
        parsed?.lastAction && typeof parsed.lastAction.at === "number"
          ? {
              at: parsed.lastAction.at,
              kind: String(parsed.lastAction.kind ?? ""),
              status: (["running", "ok", "empty", "error"] as const).includes(parsed.lastAction.status)
                ? parsed.lastAction.status
                : "ok",
              ...(typeof parsed.lastAction.detail === "string" && parsed.lastAction.detail
                ? { detail: parsed.lastAction.detail }
                : {}),
            }
          : undefined,
      generating:
        parsed?.generating && typeof parsed.generating.at === "number"
          ? { at: parsed.generating.at, count: Number(parsed.generating.count) || 0 }
          : undefined,
      lastSpeaker:
        parsed?.lastSpeaker && typeof parsed.lastSpeaker.at === "number" && parsed.lastSpeaker.session
          ? { at: parsed.lastSpeaker.at, session: String(parsed.lastSpeaker.session) }
          : undefined,
      queue:
        parsed?.queue && typeof parsed.queue.at === "number"
          ? {
              at: parsed.queue.at,
              queued: Number(parsed.queue.queued) || 0,
              playing: Number(parsed.queue.playing) || 0,
              failed: Number(parsed.queue.failed) || 0,
              ...(typeof parsed.queue.playingSession === "string" && parsed.queue.playingSession
                ? { playingSession: parsed.queue.playingSession }
                : {}),
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
      lastAttempt:
        parsed?.lastAttempt && typeof parsed.lastAttempt.at === "number"
          ? {
              at: parsed.lastAttempt.at,
              removed: Number(parsed.lastAttempt.removed) || 0,
              bytes: Number(parsed.lastAttempt.bytes) || 0,
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
      stats:
        parsed?.stats && typeof parsed.stats.at === "number"
          ? {
              at: parsed.stats.at,
              windowStart: Number(parsed.stats.windowStart) || parsed.stats.at,
              turns: Number(parsed.stats.turns) || 0,
              spoken: Number(parsed.stats.spoken) || 0,
              skipped:
                parsed.stats.skipped && typeof parsed.stats.skipped === "object"
                  ? parsed.stats.skipped
                  : {},
              sessions:
                parsed.stats.sessions && typeof parsed.stats.sessions === "object"
                  ? parsed.stats.sessions
                  : {},
            }
          : undefined,
      hostHeartbeat:
        parsed?.hostHeartbeat &&
        typeof parsed.hostHeartbeat.at === "number" &&
        typeof parsed.hostHeartbeat.machine === "string"
          ? { machine: String(parsed.hostHeartbeat.machine), at: Number(parsed.hostHeartbeat.at) }
          : undefined,
      hosts:
        parsed?.hosts && typeof parsed.hosts === "object" && !Array.isArray(parsed.hosts)
          ? Object.fromEntries(
              Object.entries(parsed.hosts)
                .filter(([, at]) => typeof at === "number" && Number.isFinite(at))
                .map(([machine, at]) => [machine, Number(at)]),
            )
          : undefined,
      playback:
        parsed?.playback && typeof parsed.playback.at === "number"
          ? {
              at: Number(parsed.playback.at),
              seconds: Number(parsed.playback.seconds) || 0,
              position: Number(parsed.playback.position) || 0,
              paused: parsed.playback.paused === true,
              source: parsed.playback.source === "host" ? "host" : "local",
              ...(typeof parsed.playback.file === "string" && parsed.playback.file
                ? { file: parsed.playback.file }
                : {}),
              ...(typeof parsed.playback.session === "string" && parsed.playback.session
                ? { session: parsed.playback.session }
                : {}),
            }
          : undefined,
    }
  } catch {
    return EMPTY
  }
}

export function writeState(root: string, state: VoiceState): VoiceState {
  const file = statePath(root)
  // Unique temp name: two hosts sharing this folder must not rename each
  // other's .part away (rename then fails ENOENT and takes the plugin down).
  const tmp = `${file}.${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}.part`
  const payload = `${JSON.stringify(state, null, 2)}\n`
  try {
    writeFileSync(tmp, payload)
    renameSync(tmp, file)
  } catch {
    // Best effort: state is a convenience, not a source of truth.
    try {
      writeFileSync(file, payload)
    } catch {
      /* ignore */
    }
    try {
      unlinkSync(tmp)
    } catch {
      /* ignore */
    }
  }
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

export function setQueue(
  root: string,
  counts: { queued: number; playing: number; failed: number; playingSession?: string },
): VoiceState {
  const state = readState(root)
  state.queue = { at: Date.now(), ...counts }
  if (counts.playingSession) {
    state.lastSpeaker = { at: Date.now(), session: counts.playingSession }
  }
  return writeState(root, state)
}

export function setPurgeAttempt(root: string, removed: number, bytes: number): VoiceState {
  const state = readState(root)
  state.lastAttempt = { at: Date.now(), removed, bytes }
  if (removed > 0) state.lastPurge = state.lastAttempt
  return writeState(root, state)
}

export function setGenerating(root: string, count: number): VoiceState {
  const state = readState(root)
  state.generating = { at: Date.now(), count: Math.max(0, count) }
  return writeState(root, state)
}

const STATS_WINDOW_MS = 24 * 60 * 60 * 1000
const MAX_STATS_SESSIONS = 100

/**
 * Count one auto-speak turn and its outcome. The window is a simple 24h
 * bucket (reset wholesale once it expires); this is a debug panel, not an
 * analytics store. `spoken` is a real durable reply; every other outcome is a
 * skip reason (`noText`, `tooLong`, `duplicate`, `muted`, `subagent`,
 * `remote`, `error`).
 */
export function recordVoiceEvent(
  root: string,
  sessionID: string,
  outcome: "spoken" | string,
): VoiceStats {
  const now = Date.now()
  const state = readState(root)
  let stats = state.stats
  if (!stats || now - stats.windowStart > STATS_WINDOW_MS) {
    stats = { at: now, windowStart: now, turns: 0, spoken: 0, skipped: {}, sessions: {} }
  }
  stats.at = now
  stats.turns += 1
  const row = (stats.sessions[sessionID] ??= { turns: 0, spoken: 0, skipped: {} })
  row.turns += 1
  if (outcome === "spoken") {
    stats.spoken += 1
    row.spoken += 1
  } else {
    stats.skipped[outcome] = (stats.skipped[outcome] ?? 0) + 1
    row.skipped[outcome] = (row.skipped[outcome] ?? 0) + 1
  }
  const ids = Object.keys(stats.sessions)
  if (ids.length > MAX_STATS_SESSIONS) delete stats.sessions[ids[0]]
  state.stats = stats
  writeState(root, state)
  return stats
}

export function setLastAction(
  root: string,
  kind: string,
  status: LastAction["status"],
  detail?: string,
): VoiceState {
  const state = readState(root)
  state.lastAction = {
    at: Date.now(),
    kind,
    status,
    ...(detail ? { detail } : {}),
  }
  return writeState(root, state)
}

/** Truncate the append-only action log; returns how many lines were removed. */
export function clearLog(root: string): number {
  const file = path.join(root, ".voice-log.jsonl")
  let lines = 0
  try {
    lines = readFileSync(file, "utf8").split("\n").filter((line) => line.trim()).length
  } catch {
    return 0
  }
  try {
    writeFileSync(file, "")
  } catch {
    return 0
  }
  return lines
}

/** Client-playback flag: its own file, never rewritten by host stat updates. */
export function clientPlaybackPath(root: string): string {
  return path.join(root, ".client-playback.json")
}

export function readClientPlayback(root: string): ClientPlayback {
  try {
    const raw = JSON.parse(readFileSync(clientPlaybackPath(root), "utf8")) as {
      at?: number
      enabled?: boolean
    }
    return { at: Number(raw.at) || 0, enabled: raw.enabled === true }
  } catch {
    return { at: 0, enabled: false }
  }
}

export function writeClientPlayback(root: string, enabled: boolean): ClientPlayback {
  const value = { at: Date.now(), enabled }
  const file = clientPlaybackPath(root)
  const tmp = `${file}.${process.pid}-${Date.now().toString(36)}.part`
  try {
    writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`)
    renameSync(tmp, file)
  } catch {
    try {
      writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`)
    } catch {
      /* ignore */
    }
    try {
      unlinkSync(tmp)
    } catch {
      /* ignore */
    }
  }
  return value
}

/** Per-machine mode override.
 *
 * The plugin root is a shared folder, so a plain `{ mode }` would flip every
 * machine. The file keeps one entry per hostname and each machine reads only
 * its own; the plan's shape is preserved inside `hosts`.
 */
export function modeOverridePath(root: string): string {
  return path.join(root, ".mode-override.json")
}

type ModeOverrideFile = { hosts?: Record<string, { at?: number; mode?: string }>; at?: number; mode?: string }

function normaliseOverride(raw: { at?: number; mode?: string } | undefined): ModeOverride {
  const mode = raw?.mode === "host" || raw?.mode === "client" ? raw.mode : "auto"
  return { at: Number(raw?.at) || 0, mode }
}

export function readModeOverride(root: string): ModeOverride {
  try {
    const raw = JSON.parse(readFileSync(modeOverridePath(root), "utf8")) as ModeOverrideFile
    const own = raw.hosts && typeof raw.hosts === "object" ? raw.hosts[hostname()] : undefined
    if (own) return normaliseOverride(own)
    // Legacy file from before per-host storage: it was written by whoever last
    // flipped the switch, so honour it only when it names this machine.
    if (raw.mode && raw.hosts === undefined) return normaliseOverride(raw)
    return { at: 0, mode: "auto" }
  } catch {
    return { at: 0, mode: "auto" }
  }
}

export function writeModeOverride(root: string, mode: Mode): ModeOverride {
  const file = modeOverridePath(root)
  let hosts: Record<string, { at: number; mode: Mode }> = {}
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as ModeOverrideFile
    if (parsed.hosts && typeof parsed.hosts === "object") {
      hosts = Object.fromEntries(
        Object.entries(parsed.hosts).map(([machine, value]) => [machine, normaliseOverride(value)]),
      )
    }
  } catch {
    /* first write */
  }
  const value: ModeOverride = { at: Date.now(), mode }
  hosts[hostname()] = value
  const tmp = `${file}.${process.pid}-${Date.now().toString(36)}.part`
  const payload = `${JSON.stringify({ hosts }, null, 2)}\n`
  try {
    writeFileSync(tmp, payload)
    renameSync(tmp, file)
  } catch {
    try {
      writeFileSync(file, payload)
    } catch {
      /* ignore */
    }
    try {
      unlinkSync(tmp)
    } catch {
      /* ignore */
    }
  }
  return value
}

const HEARTBEAT_KEEP_MS = 5 * 60_000

/**
 * Mark this machine as an active host. The single `hostHeartbeat` field is the
 * most recent host; `hosts` keeps one timestamp per machine so a panel can see
 * a *different* host that is still ticking (two hosts must not both play).
 */
export function setHostHeartbeat(root: string, machine: string): VoiceState {
  const state = readState(root)
  const now = Date.now()
  state.hostHeartbeat = { machine, at: now }
  const hosts: Record<string, number> = { ...(state.hosts ?? {}) }
  hosts[machine] = now
  for (const [name, at] of Object.entries(hosts)) {
    if (now - at > HEARTBEAT_KEEP_MS) delete hosts[name]
  }
  state.hosts = hosts
  return writeState(root, state)
}

/** Publish (or clear) the item a host's drainer is currently playing. */
export function setPlayback(root: string, playback: Playback | null): VoiceState {
  const state = readState(root)
  if (playback) state.playback = playback
  else delete state.playback
  return writeState(root, state)
}
