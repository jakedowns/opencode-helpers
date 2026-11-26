/**
 * OpenCode-agnostic nudge gate adapter.
 *
 * One shared state file per user, keyed by session. Every producer in every
 * plugin process submits candidates here; the gate owns mute/gap/grace/cap,
 * dedupe, priority, the one standing key, and block-only synthetic delivery.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  NUDGE_LEGACY_STANDING_KEY,
  NUDGE_STANDING_KEY,
  NUDGE_STATE_VERSION,
  formatReminder,
  reminderGapAllows,
  reminderHash,
  shouldReplaceReminder,
  type NudgeCandidate,
  type NudgeGateResult,
  type NudgeSessionState,
  type NudgeSeverity,
  type NudgeStanding,
  type NudgeStateFile,
} from "@jakedowns/opencode-nudge-core";
import type {
  NudgeAdapter,
  NudgeAdapterOptions,
  NudgeAdapterStatus,
  NudgeHost,
} from "./contract.js";

const CAP_PRODUCERS = ["say", "progress.tree", "progress.stale"];
const GRACE_PRODUCERS = ["say", "progress.tree", "progress.stale"];

function defaultStatePath(): string {
  const xdg = process.env.XDG_CONFIG_HOME;
  const base = xdg ? path.join(xdg, "opencode") : path.join(os.homedir(), ".config", "opencode");
  return path.join(base, "nudge-state.json");
}

function emptyState(): NudgeStateFile {
  return { version: NUDGE_STATE_VERSION, sessions: {} };
}

function emptySession(): NudgeSessionState {
  return { mutedUntil: 0, lastReminderAt: 0, lastProgressAt: 0, fires: 0 };
}

function readState(file: string): NudgeStateFile {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as NudgeStateFile;
    if (!parsed || parsed.version !== NUDGE_STATE_VERSION) return emptyState();
    if (!parsed.sessions || typeof parsed.sessions !== "object") parsed.sessions = {};
    return parsed;
  } catch {
    return emptyState();
  }
}

function acquireLock(lock: string): boolean {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    try {
      fs.writeFileSync(lock, String(process.pid), { flag: "wx" });
      return true;
    } catch {
      try {
        if (Date.now() - fs.statSync(lock).mtimeMs > 15_000) fs.unlinkSync(lock);
      } catch {
        // Lock vanished; retry.
      }
      try {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
      } catch {
        // Restricted context; retry immediately.
      }
    }
  }
  return false;
}

function withState<T>(file: string, fn: (state: NudgeStateFile) => T): T {
  const lock = `${file}.lock`;
  if (!acquireLock(lock)) throw new Error("nudge state is locked");
  try {
    const state = readState(file);
    const result = fn(state);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
    fs.renameSync(tmp, file);
    return result;
  } finally {
    try {
      fs.unlinkSync(lock);
    } catch {
      // Already released.
    }
  }
}

function formatCandidate(candidate: NudgeCandidate): string {
  return /^\[(info|warn|block)\]\s/.test(candidate.text)
    ? candidate.text.trim()
    : formatReminder(candidate.severity, candidate.text);
}

function producerMatches(producer: string, prefixes: readonly string[]): boolean {
  return prefixes.some((prefix) => producer === prefix || producer.startsWith(`${prefix}.`));
}

export function createNudgeAdapter(host: NudgeHost, options: NudgeAdapterOptions): NudgeAdapter {
  const file = options.statePath ?? defaultStatePath();
  const standingKey = options.standingKey ?? NUDGE_STANDING_KEY;
  const gapMs = options.gapMs ?? 60_000;
  const graceMs = options.graceMs ?? 10 * 60_000;
  const capPerSession = options.capPerSession ?? 2;
  const now = () => host.now?.() ?? Date.now();
  const legacyCleared = new Set<string>();

  const removeLegacy = (sessionID: string) => {
    if (legacyCleared.has(sessionID)) return;
    legacyCleared.add(sessionID);
    try {
      void host.removeContext(sessionID, NUDGE_LEGACY_STANDING_KEY);
    } catch {
      // Legacy cleanup is best-effort.
    }
  };

  const adapter: NudgeAdapter = {
    async submit(candidate) {
      const at = candidate.at ?? now();
      const muting = candidate.severity !== "block";
      const severity: NudgeSeverity = candidate.severity;
      const text = formatCandidate({ ...candidate, severity });

      let outcome: NudgeGateResult = { applied: false };
      withState(file, (state) => {
        const sessionID = candidate.sessionId;
        const session = (state.sessions[sessionID] ??= emptySession());

        if (muting && session.mutedUntil > at) {
          outcome = { applied: false, reason: "muted" };
          return;
        }
        if (!reminderGapAllows(session.lastReminderAt, at, gapMs, severity)) {
          outcome = { applied: false, reason: "gap" };
          return;
        }
        if (
          muting &&
          graceMs > 0 &&
          session.lastProgressAt > 0 &&
          at - session.lastProgressAt < graceMs &&
          producerMatches(candidate.producer, GRACE_PRODUCERS)
        ) {
          outcome = { applied: false, reason: "grace" };
          return;
        }
        if (
          muting &&
          capPerSession > 0 &&
          session.fires >= capPerSession &&
          producerMatches(candidate.producer, CAP_PRODUCERS)
        ) {
          outcome = { applied: false, reason: "cap" };
          return;
        }

        const next: NudgeStanding = {
          severity,
          source: candidate.producer,
          text,
          hash: reminderHash(text),
          at,
        };
        if (!shouldReplaceReminder(session.standing, next)) {
          const same = session.standing?.hash === next.hash && session.standing?.text === text;
          outcome = { applied: false, reason: same ? "duplicate" : "lower-priority" };
          return;
        }

        session.standing = next;
        session.lastReminderAt = at;
        session.fires += 1;
        outcome = { applied: true, text, severity };
      });

      if (!outcome.applied) {
        host.log?.({ event: "nudge", sessionID: candidate.sessionId, producer: candidate.producer, reason: outcome.reason });
        return outcome;
      }

      await host.putContext(
        candidate.sessionId,
        standingKey,
        outcome.text ?? text
      );
      removeLegacy(candidate.sessionId);

      const synthetic = candidate.channel === "synthetic" && severity === "block";
      if (synthetic) {
        await host.synthetic(
          candidate.sessionId,
          outcome.text ?? text
        );
      }
      host.log?.({
        event: "nudge",
        sessionID: candidate.sessionId,
        producer: candidate.producer,
        severity,
        delivery: synthetic ? "synthetic" : "context",
      });
      return outcome;
    },

    async clear(sessionID, producer) {
      const cleared = withState(file, (state) => {
        const session = state.sessions[sessionID];
        if (!session?.standing) return false;
        if (producer && !session.standing.source.startsWith(producer)) return false;
        delete session.standing;
        return true;
      });
      if (cleared) await host.removeContext(sessionID, standingKey);
    },

    async touch(sessionID) {
      const at = now();
      withState(file, (state) => {
        const session = (state.sessions[sessionID] ??= emptySession());
        session.lastProgressAt = at;
        session.fires = 0;
      });
    },

    async mute(sessionID, minutes) {
      const clamped = Math.min(240, Math.max(1, Math.floor(minutes || 30)));
      withState(file, (state) => {
        const session = (state.sessions[sessionID] ??= emptySession());
        session.mutedUntil = now() + clamped * 60_000;
      });
    },

    async unmute(sessionID) {
      withState(file, (state) => {
        const session = (state.sessions[sessionID] ??= emptySession());
        session.mutedUntil = 0;
      });
    },

    status(sessionID): NudgeAdapterStatus {
      const state = readState(file);
      const session = state.sessions[sessionID] ?? emptySession();
      return {
        sessionID,
        mutedUntil: session.mutedUntil,
        standing: session.standing,
        fires: session.fires,
      };
    },
  };

  return adapter;
}
