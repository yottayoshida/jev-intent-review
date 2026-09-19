// Validation of an IntentSpec (spec §10), whether it comes from `--intent-spec` or from the
// intent compiler. Fields the shape does not know are rejected rather than ignored.

import {
  EXIT,
  PRIORITIES,
  REQUIREMENT_KINDS,
  ToolError,
  type Ambiguity,
  type IntentSpec,
  type NonGoal,
  type Requirement,
  type SourceRef,
} from "../types.ts";

export const MAX_REQUIREMENT_CHARS = 600;
const ID = /^[A-Za-z][\w.-]{0,31}$/;

type Obj = Record<string, unknown>;

function bad(source: string, message: string): never {
  throw new ToolError(`${source}: ${message}`, EXIT.intent);
}

function object(source: string, where: string, value: unknown, allowed: readonly string[]): Obj {
  if (!value || typeof value !== "object" || Array.isArray(value)) bad(source, `${where} must be an object`);
  const extra = Object.keys(value as Obj).find((k) => !allowed.includes(k));
  if (extra !== undefined) bad(source, `${where} has an unknown field '${extra}'`);
  return value as Obj;
}

function text(source: string, where: string, value: unknown, max: number, required: boolean): string {
  if (value === undefined && !required) return "";
  if (typeof value !== "string" || (required && value.trim() === "")) bad(source, `${where} must be a non-empty string`);
  if (value.length > max) bad(source, `${where} is longer than ${max} characters`);
  return value;
}

function list(source: string, where: string, value: unknown): unknown[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) bad(source, `${where} must be a list`);
  return value;
}

function sourceRefs(source: string, where: string, value: unknown): SourceRef[] {
  return list(source, where, value).map((item, i) => {
    const ref = object(source, `${where}[${i}]`, item, ["sourceId", "quote"]);
    return { sourceId: text(source, `${where}[${i}].sourceId`, ref.sourceId, 100, true), quote: text(source, `${where}[${i}].quote`, ref.quote, 2000, true) };
  });
}

function oneOf<T extends string>(source: string, where: string, value: unknown, values: readonly T[], fallback: T): T {
  if (value === undefined) return fallback;
  if (typeof value !== "string" || !values.includes(value as T)) bad(source, `${where} must be one of: ${values.join(", ")}`);
  return value as T;
}

function uniqueIds<T extends { id: string }>(source: string, where: string, items: T[]): T[] {
  const seen = new Set<string>();
  for (const item of items) {
    if (!ID.test(item.id)) bad(source, `${where} id '${item.id}' must be a letter followed by up to 31 letters, digits, '.', '_' or '-'`);
    if (seen.has(item.id)) bad(source, `${where} id '${item.id}' is used twice`);
    seen.add(item.id);
  }
  return items;
}

export function validateIntentSpec(value: unknown, source: string): IntentSpec {
  const spec = object(source, "the spec", value, ["version", "title", "summary", "requirements", "nonGoals", "ambiguities"]);
  if (spec.version !== 1) bad(source, "version must be 1");

  const requirements: Requirement[] = list(source, "requirements", spec.requirements).map((item, i) => {
    const where = `requirements[${i}]`;
    const r = object(source, where, item, ["id", "text", "kind", "priority", "sourceRefs", "searchHints"]);
    return {
      id: text(source, `${where}.id`, r.id, 32, true),
      text: text(source, `${where}.text`, r.text, MAX_REQUIREMENT_CHARS, true),
      kind: oneOf(source, `${where}.kind`, r.kind, REQUIREMENT_KINDS, "behavior"),
      priority: oneOf(source, `${where}.priority`, r.priority, PRIORITIES, "required"),
      sourceRefs: sourceRefs(source, `${where}.sourceRefs`, r.sourceRefs),
      searchHints: list(source, `${where}.searchHints`, r.searchHints).map((h, j) => text(source, `${where}.searchHints[${j}]`, h, 100, true)),
    };
  });

  const notes = (field: "nonGoals" | "ambiguities"): (NonGoal | Ambiguity)[] =>
    list(source, field, spec[field]).map((item, i) => {
      const n = object(source, `${field}[${i}]`, item, ["id", "text", "sourceRefs"]);
      return {
        id: text(source, `${field}[${i}].id`, n.id, 32, true),
        text: text(source, `${field}[${i}].text`, n.text, MAX_REQUIREMENT_CHARS, true),
        sourceRefs: sourceRefs(source, `${field}[${i}].sourceRefs`, n.sourceRefs),
      };
    });

  return {
    version: 1,
    title: text(source, "title", spec.title, 300, false),
    summary: text(source, "summary", spec.summary, 2000, false),
    requirements: uniqueIds(source, "requirement", requirements),
    nonGoals: uniqueIds(source, "non-goal", notes("nonGoals")),
    ambiguities: uniqueIds(source, "ambiguity", notes("ambiguities")),
  };
}

export function parseIntentSpec(json: string, source: string): IntentSpec {
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch (error) {
    bad(source, `not valid JSON (${error instanceof Error ? error.message : String(error)})`);
  }
  return validateIntentSpec(value, source);
}
