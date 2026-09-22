// Optional JevFuzz interchange. This module never receives transport headers or endpoint data.

import { constants } from "node:fs";
import { lstat, mkdir, open } from "node:fs/promises";
import { dirname, join, parse, relative, resolve, sep } from "node:path";

import type { ChoiceAnswer } from "../types.ts";
import { JUDGMENT_SECRET_ENV, ProviderError } from "./client.ts";
import type { Questions } from "./provider.ts";

type Environment = Readonly<Record<string, string | undefined>>;

export interface TraceEntry {
  version: 1;
  source: "jev-intent-review";
  timestamp: string;
  request: { state: unknown; model: string; questions: Questions };
  response: { answers: Record<string, ChoiceAnswer>; model?: string };
}

function traceError(message: string): ProviderError {
  return new ProviderError("bad_response", message);
}

function secrets(env: Environment): string[] {
  return JUDGMENT_SECRET_ENV.flatMap((name) => {
    const value = env[name];
    return typeof value === "string" ? [value, value.trim()] : [];
  }).filter((value) => value.length > 0);
}

// macOS exposes these two fixed system aliases as symlinks. Normalize only those aliases before
// inspecting components; every caller-controlled component is still checked with lstat.
function canonicalSystemAlias(path: string): string {
  for (const [alias, canonical] of [["/var", "/private/var"], ["/tmp", "/private/tmp"]] as const) {
    if (path === alias || path.startsWith(`${alias}/`)) return `${canonical}${path.slice(alias.length)}`;
  }
  return path;
}

/** Creates missing parents one level at a time and refuses every non-system symlink on the route. */
async function privateParent(target: string): Promise<void> {
  const parent = canonicalSystemAlias(resolve(dirname(target)));
  const parsed = parse(parent);
  const parts = relative(parsed.root, parent).split(sep).filter(Boolean);
  let current = parsed.root;
  for (const part of parts) {
    current = join(current, part);
    let stats;
    try {
      stats = await lstat(current);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      try { await mkdir(current, { mode: 0o700 }); }
      catch (mkdirError) {
        if ((mkdirError as NodeJS.ErrnoException).code !== "EEXIST") throw mkdirError;
      }
      stats = await lstat(current);
    }
    if (stats.isSymbolicLink()) throw traceError("Jev trace path must not contain a symlink");
    if (!stats.isDirectory()) throw traceError("Jev trace parent must be a directory");
  }
  const stats = await lstat(parent);
  if ((stats.mode & 0o077) !== 0) throw traceError("Jev trace directory is not private");
}

/** Returns no writer unless tracing was deliberately enabled. */
export function traceFromEnv(env: Environment = process.env): TraceWriter | null {
  const target = env.JEV_TRACE_FILE?.trim();
  return target ? new TraceWriter(target, env) : null;
}

/** Appends one complete private JSON line. No trace line includes a transport object or API key. */
export class TraceWriter {
  readonly #target: string;
  readonly #secrets: readonly string[];

  constructor(target: string, env: Environment = process.env) {
    if (target.trim() === "" || target.includes("\0")) throw traceError("invalid Jev trace target");
    this.#target = target;
    this.#secrets = secrets(env);
  }

  async append(entry: TraceEntry): Promise<void> {
    let line: string;
    try { line = JSON.stringify(entry); }
    catch { throw traceError("Jev trace entry is not serializable"); }
    if (!line) throw traceError("Jev trace entry is not serializable");
    if (this.#secrets.some((secret) => line.includes(secret))) throw traceError("Jev trace entry contains a credential");
    line += "\n";

    try {
      await privateParent(this.#target);
      const existing = await lstat(this.#target).catch((error: unknown) => {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw error;
      });
      if (existing?.isSymbolicLink()) throw traceError("Jev trace target must not be a symlink");
      const handle = await open(this.#target, constants.O_APPEND | constants.O_CREAT | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
      try {
        const stats = await handle.stat();
        if (!stats.isFile()) throw traceError("Jev trace target must be a regular file");
        if ((stats.mode & 0o077) !== 0) throw traceError("Jev trace file is not private");
        const content = Buffer.from(line, "utf8");
        const { bytesWritten } = await handle.write(content);
        if (bytesWritten !== content.length) throw traceError("Jev trace write did not complete");
      } finally { await handle.close(); }
    } catch (error) {
      if (error instanceof ProviderError) throw error;
      // Paths can contain arbitrary text. Do not surface them through an API error.
      throw traceError("Jev trace could not be written");
    }
  }
}
