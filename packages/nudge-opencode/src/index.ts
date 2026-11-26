/**
 * @jakedowns/opencode-nudge
 *
 * Phase 0 exports the adapter contract. Implementation lands in Phase 2.
 */

export * from "./contract.js";

export const NUDGE_ADAPTER_PHASE = "phase-0-contract" as const;

export function createNudgeAdapter(): never {
  throw new Error(
    "nudge-opencode is in Phase 0 (contract only); the adapter implementation is not available yet"
  );
}
