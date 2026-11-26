/**
 * File-backed stores for custom nudge rules. Kept separate from policy so the
 * policy module has no filesystem imports.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import {
  NUDGE_RULE_LIMIT,
  normalizeNudgeRule,
  type CustomNudgeRule,
  type NudgeRuleFile,
  type NudgeScope,
} from "./custom-nudges.js";

// --- Stores -----------------------------------------------------------------

export interface NudgePaths {
  globalFile: string;
  projectFile: string;
  sessionFile: string;
  projectRoot: string;
}

/** Nearest ancestor with `.git` or `.opencode`; falls back to the directory. */
export function findProjectRoot(
  directory: string,
  exists: (candidate: string) => boolean = existsSync
): string {
  let current = path.resolve(directory);
  while (true) {
    if (exists(path.join(current, ".git")) || exists(path.join(current, ".opencode"))) {
      return current;
    }
    const parent = path.dirname(current);
    if (parent === current) return path.resolve(directory);
    current = parent;
  }
}

export function resolveNudgePaths(options: {
  directory: string;
  home?: string;
}): NudgePaths {
  const home = options.home ?? homedir();
  const config = path.join(home, ".config", "opencode");
  const projectRoot = findProjectRoot(options.directory);
  return {
    globalFile: path.join(config, "progress-nudge.json"),
    projectFile: path.join(projectRoot, ".opencode", "progress-nudge.json"),
    sessionFile: path.join(config, "progress-nudge-sessions.json"),
    projectRoot,
  };
}

function readJson(file: string): unknown {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return undefined;
  }
}

function atomicWriteJson(file: string, value: unknown): void {
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  renameSync(tmp, file);
}

export interface ReadRulesResult {
  rules: CustomNudgeRule[];
  errors: string[];
}

export function readNudgeRuleFile(
  file: string,
  scope: NudgeScope
): ReadRulesResult {
  const raw = readJson(file) as Record<string, unknown> | undefined;
  if (!raw || typeof raw !== "object") return { rules: [], errors: [] };
  const list = Array.isArray(raw.rules) ? raw.rules : [];
  const rules: CustomNudgeRule[] = [];
  const errors: string[] = [];
  for (const item of list) {
    const result = normalizeNudgeRule({ ...(item as Record<string, unknown>), scope }, scope);
    if (result.ok && result.rule) {
      rules.push(result.rule);
    } else {
      errors.push(
        `${scope}:${String((item as Record<string, unknown>)?.id ?? "?")}: ${result.errors.join("; ")}`
      );
    }
  }
  return { rules: rules.slice(0, NUDGE_RULE_LIMIT), errors };
}

export function writeNudgeRuleFile(file: string, rules: readonly CustomNudgeRule[]): void {
  const payload: NudgeRuleFile = { version: 1, rules: rules.slice(0, NUDGE_RULE_LIMIT) };
  atomicWriteJson(file, payload);
}

export function upsertNudgeRule(
  file: string,
  scope: NudgeScope,
  rule: CustomNudgeRule
): ReadRulesResult {
  const existing = readNudgeRuleFile(file, scope);
  const rules = existing.rules.filter((candidate) => candidate.id !== rule.id);
  rules.push({ ...rule, scope });
  if (rules.length > NUDGE_RULE_LIMIT) {
    return {
      rules: existing.rules,
      errors: [`${scope} scope is limited to ${NUDGE_RULE_LIMIT} rules`],
    };
  }
  writeNudgeRuleFile(file, rules);
  return { rules, errors: existing.errors };
}

export function setNudgeRuleEnabled(
  file: string,
  scope: NudgeScope,
  id: string,
  enabled: boolean
): ReadRulesResult {
  const existing = readNudgeRuleFile(file, scope);
  const found = existing.rules.find((rule) => rule.id === id);
  if (!found) {
    if (!enabled) {
      // A tombstone: mute a broader rule with this id without inventing text.
      const tombstone: CustomNudgeRule = {
        id,
        enabled: false,
        scope,
        text: "disabled",
        severity: "warn",
        trigger: { type: "event" },
        cooldownMs: 0,
        criteria: {},
        delivery: "context-alongside",
        ttlMs: 0,
        maxFires: 0,
        createdAt: Date.now(),
      };
      const rules = [...existing.rules, tombstone];
      writeNudgeRuleFile(file, rules);
      return { rules, errors: existing.errors };
    }
    return { rules: existing.rules, errors: [`${scope}:${id} not found`] };
  }
  const rules = existing.rules.map((rule) => (rule.id === id ? { ...rule, enabled } : rule));
  writeNudgeRuleFile(file, rules);
  return { rules, errors: existing.errors };
}

export function clearNudgeRule(
  file: string,
  scope: NudgeScope,
  id: string
): ReadRulesResult {
  const existing = readNudgeRuleFile(file, scope);
  const rules = existing.rules.filter((rule) => rule.id !== id);
  writeNudgeRuleFile(file, rules);
  return { rules, errors: existing.errors };
}

interface SessionRuleFile {
  version: 1;
  sessions: Record<string, CustomNudgeRule[]>;
}

export function readSessionNudgeRules(file: string, sessionID: string): ReadRulesResult {
  const raw = readJson(file) as SessionRuleFile | undefined;
  const list = raw?.sessions?.[sessionID];
  if (!Array.isArray(list)) return { rules: [], errors: [] };
  const rules: CustomNudgeRule[] = [];
  const errors: string[] = [];
  for (const item of list) {
    const result = normalizeNudgeRule({ ...(item as Record<string, unknown>), scope: "session" }, "session");
    if (result.ok && result.rule) rules.push(result.rule);
    else {
      errors.push(
        `session:${String((item as Record<string, unknown>)?.id ?? "?")}: ${result.errors.join("; ")}`
      );
    }
  }
  return { rules: rules.slice(0, NUDGE_RULE_LIMIT), errors };
}

function readSessionMapFile(file: string): SessionRuleFile {
  const raw = readJson(file) as SessionRuleFile | undefined;
  if (!raw || typeof raw !== "object" || typeof raw.sessions !== "object" || raw.sessions == null) {
    return { version: 1, sessions: {} };
  }
  return { version: 1, sessions: raw.sessions };
}

export function upsertSessionNudgeRule(
  file: string,
  sessionID: string,
  rule: CustomNudgeRule
): ReadRulesResult {
  const store = readSessionMapFile(file);
  const existing = readSessionNudgeRules(file, sessionID);
  const rules = existing.rules.filter((candidate) => candidate.id !== rule.id);
  rules.push({ ...rule, scope: "session" });
  if (rules.length > NUDGE_RULE_LIMIT) {
    return {
      rules: existing.rules,
      errors: [`session scope is limited to ${NUDGE_RULE_LIMIT} rules`],
    };
  }
  store.sessions[sessionID] = rules;
  atomicWriteJson(file, store);
  return { rules, errors: existing.errors };
}

export function setSessionNudgeRuleEnabled(
  file: string,
  sessionID: string,
  id: string,
  enabled: boolean
): ReadRulesResult {
  const existing = readSessionNudgeRules(file, sessionID);
  const found = existing.rules.find((rule) => rule.id === id);
  if (!found) {
    return { rules: existing.rules, errors: [`session:${id} not found`] };
  }
  const rules = existing.rules.map((rule) => (rule.id === id ? { ...rule, enabled } : rule));
  const store = readSessionMapFile(file);
  store.sessions[sessionID] = rules;
  atomicWriteJson(file, store);
  return { rules, errors: existing.errors };
}

export function clearSessionNudgeRule(
  file: string,
  sessionID: string,
  id: string
): ReadRulesResult {
  const existing = readSessionNudgeRules(file, sessionID);
  const rules = existing.rules.filter((rule) => rule.id !== id);
  const store = readSessionMapFile(file);
  if (rules.length > 0) store.sessions[sessionID] = rules;
  else delete store.sessions[sessionID];
  atomicWriteJson(file, store);
  return { rules, errors: existing.errors };
}

/** Include descendant sessions when a rule asks for children/all. */
