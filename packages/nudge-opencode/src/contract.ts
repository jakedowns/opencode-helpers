/**
 * Host adapter contract. Kept free of concrete OpenCode types so tests can use
 * a fake host and consumers only depend on this narrow surface.
 */

import type {
  NudgeCandidate,
  NudgeGateResult,
  NudgeProducerConfig,
  NudgeSessionState,
} from "@jakedowns/opencode-nudge-core";

export interface NudgeHost {
  /** Write/replace the one standing context entry. */
  putContext(sessionID: string, key: string, text: string): Promise<void> | void;
  removeContext(sessionID: string, key: string): Promise<void> | void;
  /** Admit a synthetic user message (block/experiment arms only). */
  synthetic(sessionID: string, text: string): Promise<void> | void;
  log?(event: Record<string, unknown>): void;
  now?(): number;
}

export interface NudgeAdapterOptions {
  /** Producer identity for diagnostics; not used as a policy gate. */
  producer: string;
  /** Defaults to "nudge". */
  standingKey?: string;
  /** Defaults to ~/.config/opencode/nudge-state.json. */
  statePath?: string;
  /** Defaults to "context"; synthetic is block-only until the experiment. */
  delivery?: NudgeProducerConfig["delivery"];
  gapMs?: number;
  graceMs?: number;
  capPerSession?: number;
  wordingVariation?: NudgeProducerConfig["wordingVariation"];
  /** Gate and record, but do not touch host context/synthetic. */
  shadow?: boolean;
}

export interface NudgeAdapterStatus {
  sessionID: string;
  mutedUntil: number;
  standing?: NudgeSessionState["standing"];
  fires: number;
}

export interface NudgeAdapter {
  submit(candidate: NudgeCandidate): Promise<NudgeGateResult> | NudgeGateResult;
  clear(sessionID: string, producer?: string): Promise<void> | void;
  touch(sessionID: string): Promise<void> | void;
  mute(sessionID: string, minutes: number): Promise<void> | void;
  unmute(sessionID: string): Promise<void> | void;
  status(sessionID: string): NudgeAdapterStatus;
  /** Prompt reset: clear standing/fires; preserve mute and last progress. */
  reset(sessionID: string): Promise<void> | void;
}
