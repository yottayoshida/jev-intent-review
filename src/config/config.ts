// `.jev-intent-review.yml`. Read from the commit *before* the change, so a pull request cannot
// widen its own ignore list or lower its own thresholds (see loadConfig).

import { parse } from "yaml";
import { EXIT, ToolError } from "../types.ts";
import type { Git } from "../repository/git.ts";

export const CONFIG_PATH = ".jev-intent-review.yml";

export interface Config {
  version: 1;
  intent: {
    prefer_issue: boolean;
    include_pr_description: boolean;
    pr_body_only: "allow" | "unknown";
  };
  repository: { include: string[]; ignore: string[] };
  discovery: {
    max_candidates_per_requirement: number;
    lexical_search: boolean;
    reference_search: "auto" | "off";
  };
  evidence: { max_primary_chars: number; max_related_chars: number };
  judgment: { violation_probability: number; satisfaction_probability: number; relevance_probability: number };
  /**
   * `max_requests_per_pull_request`: what the runs of one pull request may send together, counted in
   * the directory of kept answers (`--answers`, ADR 0014). Absent: no such limit.
   */
  limits: { max_requests: number; max_sent_bytes: number; max_seconds: number; max_requests_per_pull_request?: number };
  policy: {
    /** `finding`: exit 1 when a call is worth checking. `violation` in a file is read as `finding`. */
    fail_on: "finding"[];
    unknown: "warn" | "fail";
    missing_credentials: "skip" | "fail";
    no_intent: "skip" | "fail";
  };
}

/**
 * Keys that governed the generic run and no longer apply (ADR 0007). A file that sets one is not
 * refused — a repository must not stop on upgrade — but the run says so in its notes. Gone in the
 * next minor version.
 */
const NO_LONGER_APPLIES: Record<string, string> = {
  "discovery.max_candidates_per_requirement": "the run reads the functions the change touched and their callers, not a repository-wide search",
  "discovery.lexical_search": "the run reads the functions the change touched and their callers, not a repository-wide search",
  "discovery.reference_search": "the run reads the functions the change touched and their callers, not a repository-wide search",
  "judgment.satisfaction_probability": "no satisfaction question is asked; each call is read at the bar of its form",
  "judgment.relevance_probability": "no relevance question is asked; each call is read at the bar of its form",
  "evidence.max_related_chars": "the local check sends a function's own body and nothing around it",
  "policy.unknown": "no requirement-level UNKNOWN is stated",
};

// `policy.missing_credentials` is `skip`, settled in ADR 0009: read by a maintainer on a pull
// request, `fail` would turn every pull request without secrets — every one from a fork — red, and
// a skipped run is told apart from a clean one by the Action's check run, which is neutral.
export function defaultConfig(): Config {
  return {
    version: 1,
    intent: { prefer_issue: true, include_pr_description: true, pr_body_only: "allow" },
    repository: {
      include: [],
      ignore: ["vendor/**", "node_modules/**", "dist/**", "**/*.generated.*", "**/*.min.js", "**/*.lock", "**/package-lock.json"],
    },
    discovery: { max_candidates_per_requirement: 30, lexical_search: true, reference_search: "auto" },
    evidence: { max_primary_chars: 8000, max_related_chars: 4000 },
    // Measured with the real model. On the fixtures, violating paths answered `violates` at
    // 0.79-0.92 and were called paths at 0.98-0.99; other paths gave `violates` at most 0.04, and
    // a middleware that does protect its route answered `satisfies` at 0.61-0.71. On a real pull
    // request (omamori #559) places that were not violations drew `violates` at up to 0.87, and
    // were called paths at 0.50-0.62: a false violation fails CI, so a violation needs 0.7 on both
    // answers. Satisfaction at 0.5 (the answer outweighs all others together) because VERIFIED
    // needs far more than one answer: every relevant path, complete evidence, complete discovery.
    // Relevance decides what is excluded, and excluding a real path is how a false VERIFIED would
    // happen, so 0.6.
    judgment: { violation_probability: 0.7, satisfaction_probability: 0.5, relevance_probability: 0.6 },
    limits: { max_requests: 400, max_sent_bytes: 4_000_000, max_seconds: 600 },
    // A listed call is a candidate, not a verdict: nothing fails on it unless the repository says so.
    policy: { fail_on: [], unknown: "warn", missing_credentials: "skip", no_intent: "skip" },
  };
}

type Rule =
  | { kind: "boolean" }
  | { kind: "number"; min: number; max: number }
  | { kind: "enum"; values: readonly string[] }
  | { kind: "strings" }
  | { kind: "enums"; values: readonly string[] };

const RULES: Record<string, Record<string, Rule>> = {
  intent: {
    prefer_issue: { kind: "boolean" },
    include_pr_description: { kind: "boolean" },
    pr_body_only: { kind: "enum", values: ["allow", "unknown"] },
  },
  repository: { include: { kind: "strings" }, ignore: { kind: "strings" } },
  discovery: {
    max_candidates_per_requirement: { kind: "number", min: 1, max: 200 },
    lexical_search: { kind: "boolean" },
    reference_search: { kind: "enum", values: ["auto", "off"] },
  },
  evidence: {
    max_primary_chars: { kind: "number", min: 500, max: 60_000 },
    max_related_chars: { kind: "number", min: 0, max: 60_000 },
  },
  judgment: {
    violation_probability: { kind: "number", min: 0, max: 1 },
    satisfaction_probability: { kind: "number", min: 0, max: 1 },
    relevance_probability: { kind: "number", min: 0, max: 1 },
  },
  limits: {
    max_requests: { kind: "number", min: 1, max: 100_000 },
    max_sent_bytes: { kind: "number", min: 1_000, max: 1_000_000_000 },
    max_seconds: { kind: "number", min: 10, max: 86_400 },
    max_requests_per_pull_request: { kind: "number", min: 1, max: 1_000_000 },
  },
  policy: {
    fail_on: { kind: "enums", values: ["finding", "violation"] },
    unknown: { kind: "enum", values: ["warn", "fail"] },
    missing_credentials: { kind: "enum", values: ["skip", "fail"] },
    no_intent: { kind: "enum", values: ["skip", "fail"] },
  },
};

function fail(source: string, message: string): never {
  throw new ToolError(`${source}: ${message}`, EXIT.config);
}

function check(source: string, key: string, rule: Rule, value: unknown): unknown {
  switch (rule.kind) {
    case "boolean":
      if (typeof value !== "boolean") fail(source, `${key} must be true or false`);
      return value;
    case "number":
      if (typeof value !== "number" || !Number.isFinite(value) || value < rule.min || value > rule.max) {
        fail(source, `${key} must be a number from ${rule.min} to ${rule.max}`);
      }
      return value;
    case "enum":
      if (typeof value !== "string" || !rule.values.includes(value)) {
        fail(source, `${key} must be one of: ${rule.values.join(", ")}`);
      }
      return value;
    case "strings":
    case "enums":
      if (!Array.isArray(value) || value.some((v) => typeof v !== "string" || v === "")) {
        fail(source, `${key} must be a list of non-empty strings`);
      }
      if (rule.kind === "enums") {
        const bad = (value as string[]).find((v) => !rule.values.includes(v));
        if (bad !== undefined) fail(source, `${key} may only contain: ${rule.values.join(", ")}`);
      }
      return value;
  }
}

/**
 * Parses a config file. Unknown keys are an error: a misspelt key would otherwise do nothing. A key
 * that no longer applies is kept and reported in `notes`, and `violation` under `policy.fail_on` is
 * read as `finding`.
 */
export function readConfig(text: string, source: string): { config: Config; notes: string[] } {
  let raw: unknown;
  try {
    raw = parse(text);
  } catch (error) {
    fail(source, `not valid YAML (${error instanceof Error ? error.message.split("\n")[0] : String(error)})`);
  }
  const config = defaultConfig();
  const notes: string[] = [];
  if (raw === null || raw === undefined) return { config, notes };
  if (typeof raw !== "object" || Array.isArray(raw)) fail(source, "must be a mapping");
  for (const [section, value] of Object.entries(raw as Record<string, unknown>)) {
    if (section === "version") {
      if (value !== 1) fail(source, "version must be 1");
      continue;
    }
    // Object.hasOwn: `__proto__:` or `constructor:` must be unknown sections, not the prototype.
    const rules = Object.hasOwn(RULES, section) ? RULES[section] : undefined;
    if (!rules) fail(source, `unknown section '${section}'`);
    if (value === null) continue;
    if (typeof value !== "object" || Array.isArray(value)) fail(source, `${section} must be a mapping`);
    const target = config[section as keyof Config] as unknown as Record<string, unknown>;
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      const rule = Object.hasOwn(rules, key) ? rules[key] : undefined;
      if (!rule) fail(source, `unknown key '${section}.${key}'`);
      const name = `${section}.${key}`;
      let checked = check(source, name, rule, item);
      if (name === "policy.fail_on" && (checked as string[]).includes("violation")) {
        notes.push(`${name} in ${source} says \`violation\`, which is read as \`finding\`: exit 1 when a call is worth checking (ADR 0007)`);
        checked = [...new Set((checked as string[]).map((v) => (v === "violation" ? "finding" : v)))];
      }
      if (Object.hasOwn(NO_LONGER_APPLIES, name)) notes.push(`${name} in ${source} no longer applies: ${NO_LONGER_APPLIES[name]} (ADR 0007)`);
      if (name === "intent.pr_body_only" && checked === "unknown") notes.push(`${name} in ${source} no longer applies: no requirement-level verdict is stated for it to withhold; that the requirements come only from the pull request's own description is still said (ADR 0007)`);
      target[key] = checked;
    }
  }
  return { config, notes };
}

/** Parses a config file (see `readConfig`); the notes are dropped. */
export function parseConfig(text: string, source: string): Config {
  return readConfig(text, source).config;
}

export interface LoadedConfig {
  config: Config;
  source: string; // where the config came from, for the report
  changedInPullRequest: boolean;
  /** Settings in the file that the run no longer reads, said once each. */
  notes: string[];
}

/**
 * Reads the config at `before`. If the change adds, edits or removes the file, the `before`
 * version still applies and the caller is told, so it can refuse to report VERIFIED.
 */
export async function loadConfig(git: Git, before: string, after: string): Promise<LoadedConfig> {
  const [old, next] = await Promise.all([git.readText(before, CONFIG_PATH), git.readText(after, CONFIG_PATH)]);
  const changedInPullRequest = old !== next;
  if (old === null) return { config: defaultConfig(), source: "defaults", changedInPullRequest, notes: [] };
  const read = readConfig(old, `${CONFIG_PATH} at ${before.slice(0, 12)}`);
  return { config: read.config, source: `${CONFIG_PATH}@${before.slice(0, 12)}`, changedInPullRequest, notes: read.notes };
}
