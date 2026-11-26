/**
 * @jakedowns/opencode-nudge-core
 *
 * Phase 1: pure policy aggregated from reminders, strict/wall/idle monitors,
 * say-nudge decisions, and custom-rule evaluation. Product message builders
 * are still colocated for regression parity; Phase 3 can move copy back into
 * producers.
 */

export * from "./contract.js";
export * from "./reminders.js";
export * from "./monitor.js";
export * from "./say-monitor.js";
export * from "./custom-nudges.js";
export * from "./custom-nudge-store.js";
