/**
 * Shared nudge contract. Pure types + constants; no host imports.
 */

export const NUDGE_STATE_VERSION = 1;
export const NUDGE_STANDING_KEY = "nudge";
/** Legacy key removed once after the first adapter write. */
export const NUDGE_LEGACY_STANDING_KEY = "progress-reminder";
export const NUDGE_STATE_FILENAME = "nudge-state.json";
export const NUDGE_GLOBAL_CONFIG = "nudge.json";
export const NUDGE_PROJECT_CONFIG = ".opencode/nudge.json";
export const NUDGE_LEGACY_GLOBAL_CONFIG = "progress-nudge.json";
export const NUDGE_LEGACY_PROJECT_CONFIG = ".opencode/progress-nudge.json";

export type NudgeSeverity = "info" | "warn" | "block";
export type NudgeChannel = "context" | "synthetic";
export type NudgeDeliveryPolicy = "context" | "synthetic" | "escalate";
export type NudgeWordingVariation = "off" | "low" | "high";
export type NudgeStatus = "pending" | "running" | "waiting" | "done" | "error";

export interface NudgeTarget {
  id: string;
  title?: string;
  status?: string;
  ageMs?: number;
  producer?: string;
}

/**
 * A producer's fully rendered, policy-ready nudge. Producers own signal
 * detection and product copy; the gate owns whether/how it is delivered.
 */
export interface NudgeCandidate {
  /** Session the reminder belongs to. */
  sessionId: string;
  /** Stable producer identity, e.g. progress.tree, progress.relay, say, voice. */
  producer: string;
  /** Rule id within the producer. */
  ruleId: string;
  severity: NudgeSeverity;
  text: string;
  channel: NudgeChannel;
  dedupeKey?: string;
  target?: NudgeTarget;
  at: number;
  metadata?: Record<string, string | number | boolean | null>;
}

export type NudgeSuppressionReason =
  | "muted"
  | "gap"
  | "grace"
  | "cap"
  | "duplicate"
  | "lower-priority"
  | "custom-replace";

export interface NudgeGateResult {
  applied: boolean;
  reason?: NudgeSuppressionReason;
  /** The text actually standing after the gate. */
  text?: string;
  severity?: NudgeSeverity;
}

export type NudgeTrigger =
  | { type: "interval"; everyMs: number }
  | { type: "steps"; everySteps: number }
  | { type: "turns"; everyTurns: number }
  | { type: "either"; everyMs?: number; everySteps?: number; everyTurns?: number }
  | { type: "event" };

export interface NudgeCriteria {
  statuses?: NudgeStatus[];
  staleAfterMs?: number;
  noProgressAfterMs?: number;
  noProgressAfterSteps?: number;
  inFlight?: "only" | "never" | "any";
  tree?: "empty" | "nonempty";
  idleOnly?: boolean;
  entryIds?: string[];
  sessions?: "self" | "children" | "all";
}

export interface NudgeRule {
  id: string;
  producer: string;
  enabled: boolean;
  severity: NudgeSeverity;
  /** One static template, or a pool for non-token variation. */
  text: string | string[];
  trigger: NudgeTrigger;
  cooldownMs: number;
  criteria: NudgeCriteria;
  delivery: NudgeDeliveryPolicy;
  ttlMs: number;
  maxFires: number;
  wordingVariation?: NudgeWordingVariation;
  createdAt?: number;
  source?: "user" | "agent" | "config";
}

export interface NudgeStanding {
  severity: NudgeSeverity;
  source: string;
  text: string;
  hash: string;
  at: number;
}

export interface NudgeSessionState {
  mutedUntil: number;
  lastReminderAt: number;
  lastProgressAt: number;
  fires: number;
  standing?: NudgeStanding;
}

export interface NudgeStateFile {
  version: typeof NUDGE_STATE_VERSION;
  sessions: Record<string, NudgeSessionState>;
}

export interface NudgeProducerConfig {
  producer: string;
  enabled?: boolean;
  severity?: NudgeSeverity;
  cooldownMs?: number;
  triggers?: NudgeTrigger;
  criteria?: NudgeCriteria;
  delivery?: NudgeDeliveryPolicy;
  wordingVariation?: NudgeWordingVariation;
}

export interface NudgeConfigFile {
  version: 1;
  defaults?: {
    gapMs?: number;
    graceMs?: number;
    capPerSession?: number;
    wordingVariation?: NudgeWordingVariation;
  };
  producers?: Record<string, NudgeProducerConfig>;
  rules?: NudgeRule[];
}
