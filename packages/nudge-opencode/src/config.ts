/**
 * Unified nudge config loader.
 *
 * Reads the global and project files, merges defaults/producers, concatenates
 * rules with project precedence, and falls back to the legacy progress rule
 * file when no nudge file exists.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { NudgeConfigFile, NudgeRule } from "@jakedowns/opencode-nudge-core";

export interface NudgeConfigPaths {
  globalFile: string;
  projectFile: string;
  legacyGlobalFile: string;
  legacyProjectFile: string;
}

export interface NudgeConfigResult {
  config: NudgeConfigFile;
  files: string[];
  errors: string[];
}

export function resolveNudgeConfigPaths(options: {
  directory?: string;
  home?: string;
  env?: NodeJS.ProcessEnv;
}): NudgeConfigPaths {
  const env = options.env ?? process.env;
  const home = options.home ?? env.HOME ?? env.USERPROFILE ?? os.homedir();
  const xdg = env.XDG_CONFIG_HOME || path.join(home, ".config");
  const configDir = path.join(xdg, "opencode");
  const project = options.directory ? path.resolve(options.directory) : process.cwd();
  return {
    globalFile: path.join(configDir, "nudge.json"),
    projectFile: path.join(project, ".opencode", "nudge.json"),
    legacyGlobalFile: path.join(configDir, "progress-nudge.json"),
    legacyProjectFile: path.join(project, ".opencode", "progress-nudge.json"),
  };
}

function readJson(file: string): { value?: unknown; error?: string } {
  try {
    return { value: JSON.parse(fs.readFileSync(file, "utf8")) };
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return {};
    return { error: `${file}: ${String(error)}` };
  }
}

function rulesFrom(value: unknown): NudgeRule[] {
  if (!value || typeof value !== "object") return [];
  const list = (value as { rules?: unknown }).rules;
  return Array.isArray(list) ? (list as NudgeRule[]) : [];
}

function readLayer(file: string, errors: string[]): NudgeConfigFile | null {
  const { value, error } = readJson(file);
  if (error) errors.push(error);
  if (!value || typeof value !== "object") return null;
  const raw = value as Partial<NudgeConfigFile>;
  if (raw.version !== 1) {
    errors.push(`${file}: unsupported config version ${String(raw.version)}`);
    return null;
  }
  return {
    version: 1,
    defaults: raw.defaults ?? {},
    producers: raw.producers ?? {},
    rules: Array.isArray(raw.rules) ? raw.rules : [],
  };
}

export function readNudgeConfig(paths: NudgeConfigPaths): NudgeConfigResult {
  const errors: string[] = [];
  const files: string[] = [];
  const global = readLayer(paths.globalFile, errors);
  if (global) files.push(paths.globalFile);
  const project = readLayer(paths.projectFile, errors);
  if (project) files.push(paths.projectFile);

  // Legacy fallback: rules only, global then project.
  let legacyRules: NudgeRule[] = [];
  if (!global) {
    const legacy = readJson(paths.legacyGlobalFile);
    if (legacy.error) errors.push(legacy.error);
    if (legacy.value) {
      files.push(paths.legacyGlobalFile);
      legacyRules = legacyRules.concat(rulesFrom(legacy.value));
    }
  }
  if (!project) {
    const legacy = readJson(paths.legacyProjectFile);
    if (legacy.error) errors.push(legacy.error);
    if (legacy.value) {
      files.push(paths.legacyProjectFile);
      legacyRules = legacyRules.concat(rulesFrom(legacy.value));
    }
  }

  const projectRules = project?.rules ?? [];
  const globalRules = global?.rules ?? [];
  const projectIds = new Set(projectRules.map((rule) => rule.id));
  const rules = [
    ...projectRules,
    ...globalRules.filter((rule) => !projectIds.has(rule.id)),
    ...legacyRules.filter(
      (rule) => !projectIds.has(rule.id) && !globalRules.some((g) => g.id === rule.id)
    ),
  ];

  return {
    config: {
      version: 1,
      defaults: { ...(global?.defaults ?? {}), ...(project?.defaults ?? {}) },
      producers: { ...(global?.producers ?? {}), ...(project?.producers ?? {}) },
      rules,
    },
    files,
    errors,
  };
}
