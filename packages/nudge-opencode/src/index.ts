/**
 * @jakedowns/opencode-nudge
 *
 * Shared host adapter. Producers submit candidates; this layer owns delivery.
 */

export * from "./contract.js";
export { createNudgeAdapter } from "./adapter.js";
export { createNudgeTool } from "./tool.js";
export * from "./config.js";
export type { NudgeToolDefinition, NudgeToolOptions } from "./tool.js";
