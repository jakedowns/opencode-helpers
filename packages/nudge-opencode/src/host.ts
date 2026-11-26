/**
 * OpenCode host attachment for the shared nudge adapter.
 *
 * The concrete context is passed in structurally so this package stays free of
 * @opencode imports; consumers pass their plugin context.
 */

import {
  createNudgeAdapter,
} from "./adapter.js";
import { readNudgeConfig, resolveNudgeConfigPaths } from "./config.js";
import { createNudgeTool } from "./tool.js";
import type { NudgeAdapter } from "./contract.js";

export interface NudgePluginContext {
  location?: { directory?: string };
  options?: Record<string, unknown>;
  tool: {
    list(): Promise<Array<{ id: string }>>;
    transform(editor: {
      add(tool: unknown): void;
    }): Promise<{ dispose?: () => void } | void>;
    hook?(
      name: string,
      handler: (event: unknown) => void
    ): Promise<{ dispose?: () => void } | void>;
  };
  session: {
    hook(name: string, handler: (event: any) => unknown): Promise<{ dispose?: () => void } | void>;
    instructions: {
      entry: {
        put(input: { sessionID: string; key: string; value: string }): Promise<unknown>;
        remove(input: { sessionID: string; key: string }): Promise<unknown>;
      };
    };
    synthetic(input: { sessionID: string; text: string }): Promise<unknown>;
  };
}

export interface AttachNudgeOptions {
  statePath?: string;
  standingKey?: string;
  gapMs?: number;
  graceMs?: number;
  capPerSession?: number;
  tickMs?: number;
  toolName?: string;
  registerTool?: boolean;
  shadow?: boolean;
  log?: (event: Record<string, unknown>) => void;
}

export interface AttachedNudge {
  adapter: NudgeAdapter;
  configFiles: string[];
  configErrors: string[];
  onTick(callback: (now: number) => void): () => void;
  onIdle(callback: (sessionID: string) => void): () => void;
  onTool(callback: (sessionID: string, tool: string) => void): () => void;
  dispose(): Promise<void>;
}

export async function attachNudge(
  ctx: NudgePluginContext,
  options: AttachNudgeOptions = {}
): Promise<AttachedNudge> {
  const loaded = readNudgeConfig(
    resolveNudgeConfigPaths({ directory: ctx.location?.directory })
  );
  const defaults = loaded.config.defaults ?? {};
  const standingKey = options.standingKey ?? "nudge";
  const log = options.log ?? ((event) => console.log("[nudge]", JSON.stringify(event)));

  const adapter = createNudgeAdapter(
    {
      putContext: (sessionID, key, text) =>
        ctx.session.instructions.entry.put({ sessionID, key, value: text }),
      removeContext: (sessionID, key) =>
        ctx.session.instructions.entry.remove({ sessionID, key }),
      synthetic: (sessionID, text) => ctx.session.synthetic({ sessionID, text }),
      log,
    },
    {
      producer: "host",
      standingKey,
      statePath: options.statePath,
      gapMs: options.gapMs ?? defaults.gapMs,
      graceMs: options.graceMs ?? defaults.graceMs,
      capPerSession: options.capPerSession ?? defaults.capPerSession,
      shadow: options.shadow,
    }
  );

  const tickCallbacks = new Set<(now: number) => void>();
  const idleCallbacks = new Set<(sessionID: string) => void>();
  const toolCallbacks = new Set<(sessionID: string, tool: string) => void>();
  const cleanups: Array<() => void> = [];
  const timer = setInterval(() => {
    const now = Date.now();
    for (const callback of tickCallbacks) callback(now);
  }, Math.max(1000, options.tickMs ?? 5_000));
  cleanups.push(() => clearInterval(timer));

  try {
    const promptHook = await ctx.session.hook("prompt", (event) => {
      const sessionID = (event as { sessionID?: string })?.sessionID;
      if (!sessionID) return;
      void adapter.reset(sessionID);
      void Promise.resolve(
        ctx.session.instructions.entry.remove({ sessionID, key: standingKey })
      ).catch(() => {});
    });
    if (promptHook?.dispose) cleanups.push(promptHook.dispose);
  } catch (error) {
    log({ event: "hook-error", hook: "prompt", error: String(error) });
  }

  try {
    const idleHook = await ctx.session.hook("experimental.idle", (event) => {
      const sessionID = (event as { sessionID?: string })?.sessionID;
      if (!sessionID) return;
      for (const callback of idleCallbacks) callback(sessionID);
    });
    if (idleHook?.dispose) cleanups.push(idleHook.dispose);
  } catch (error) {
    log({ event: "hook-error", hook: "idle", error: String(error) });
  }

  try {
    const toolHook = await ctx.tool.hook?.("execute.after", (event: any) => {
      const sessionID = event?.sessionID;
      if (!sessionID) return;
      for (const callback of toolCallbacks) callback(sessionID, String(event?.tool ?? ""));
    });
    if (toolHook?.dispose) cleanups.push(toolHook.dispose);
  } catch (error) {
    log({ event: "hook-error", hook: "tool", error: String(error) });
  }

  // One nudge tool, first loader wins.
  if (options.registerTool !== false) try {
    const taken = new Set((await ctx.tool.list()).map((tool) => tool.id));
    const name = options.toolName ?? "nudge";
    if (!taken.has(name)) {
      const registration = await ctx.tool.transform((editor) => {
        editor.add(createNudgeTool(adapter, { name }) as never);
      });
      if (registration?.dispose) cleanups.push(registration.dispose);
    }
  } catch (error) {
    log({ event: "tool-registration-failed", error: String(error) });
  }

  return {
    adapter,
    configFiles: loaded.files,
    configErrors: loaded.errors,
    onTick(callback) {
      tickCallbacks.add(callback);
      return () => tickCallbacks.delete(callback);
    },
    onIdle(callback) {
      idleCallbacks.add(callback);
      return () => idleCallbacks.delete(callback);
    },
    onTool(callback) {
      toolCallbacks.add(callback);
      return () => toolCallbacks.delete(callback);
    },
    async dispose() {
      for (const cleanup of cleanups) cleanup();
      cleanups.length = 0;
    },
  };
}
