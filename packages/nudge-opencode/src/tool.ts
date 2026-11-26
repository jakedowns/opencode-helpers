/**
 * Generic agent tool for the shared nudge adapter.
 *
 * The host plugin decides the final tool name (first loader wins) and supplies
 * the adapter. This module has no OpenCode imports; the definition shape
 * matches the plugin tool API used by the progress and voice plugins.
 */

import type { NudgeAdapter } from "./contract.js";

export interface NudgeToolDefinition {
  name: string;
  description: string;
  input: {
    type: "object";
    properties: Record<string, unknown>;
    required: string[];
    additionalProperties: boolean;
  };
  options: { codemode: boolean };
  execute: (
    input: {
      action?: "status" | "mute" | "unmute" | "clear";
      minutes?: number;
      producer?: string;
    },
    context: { sessionID: string }
  ) => Promise<{ content: string }>;
}

export interface NudgeToolOptions {
  name?: string;
}

function muteRemaining(mutedUntil: number, now = Date.now()): string {
  if (!mutedUntil || mutedUntil <= now) return "Not muted.";
  return `Muted for another ${Math.ceil((mutedUntil - now) / 60_000)}m.`;
}

export function createNudgeTool(
  adapter: NudgeAdapter,
  options: NudgeToolOptions = {}
): NudgeToolDefinition {
  return {
    name: options.name ?? "nudge",
    description:
      "Inspect or quiet shared reminders for this session. Reminders come from progress, say, voice, and other tools; they are model-facing, not user-facing. Actions: status, mute, unmute, clear. Mute suppresses non-block reminders only; block-level safety reminders still land.",
    input: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["status", "mute", "unmute", "clear"],
          description: "What to do. Defaults to status.",
        },
        minutes: {
          type: "number",
          description: "For mute: minutes to quiet non-block reminders (1-240, default 30).",
        },
        producer: {
          type: "string",
          description:
            "For clear: only remove the standing reminder from this producer (e.g. progress.tree, say, voice). Omit to clear any standing reminder.",
        },
      },
      required: [],
      additionalProperties: false,
    },
    options: { codemode: true },
    execute: async (input, context) => {
      const action = input?.action ?? "status";
      const sessionID = context.sessionID;
      if (action === "mute") {
        const raw = Number(input?.minutes);
        const minutes =
          Number.isFinite(raw) && raw > 0 ? Math.min(240, Math.max(1, Math.floor(raw))) : 30;
        await adapter.mute(sessionID, minutes);
        return {
          content: `Session reminders muted for ${minutes}m (non-block only). Block reminders still land. Run action "unmute" to restore.`,
        };
      }
      if (action === "unmute") {
        await adapter.unmute(sessionID);
        return { content: "Session reminders unmuted." };
      }
      if (action === "clear") {
        await adapter.clear(sessionID, input?.producer);
        return {
          content: input?.producer
            ? `Cleared the standing reminder from ${input.producer}.`
            : "Cleared the standing reminder.",
        };
      }
      const status = adapter.status(sessionID);
      const lines = [
        muteRemaining(status.mutedUntil),
        status.standing
          ? `Standing [${status.standing.severity}] ${status.standing.source}: ${status.standing.text}`
          : "No standing reminder.",
        `Fires this session: ${status.fires}.`,
      ];
      return { content: lines.join("\n") };
    },
  };
}
