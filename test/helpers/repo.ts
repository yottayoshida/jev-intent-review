// Throwaway git repositories for tests. A fixture directory holds `base/` (the tree before the
// change), `head/` (files the change adds or rewrites, laid over base) and optionally `fixed/`
// (laid over head: the change with every path fixed).

import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

export const FIXTURES = join(import.meta.dirname, "..", "fixtures");

export interface TempRepo {
  dir: string;
  git(...args: string[]): string;
  write(files: Record<string, string>): void;
  commit(message: string): string;
  remove(): void;
}

export function tempRepo(): TempRepo {
  const dir = mkdtempSync(join(tmpdir(), "jir-test-"));
  const git = (...args: string[]) =>
    execFileSync("git", ["-c", "user.name=fixture", "-c", "user.email=fixture@example.com", "-c", "commit.gpgsign=false", ...args], {
      cwd: dir,
      encoding: "utf8",
    });
  git("init", "-q", "-b", "main");
  return {
    dir,
    git,
    write(files) {
      for (const [path, text] of Object.entries(files)) {
        mkdirSync(dirname(join(dir, path)), { recursive: true });
        writeFileSync(join(dir, path), text);
      }
    },
    commit(message) {
      git("add", "-A");
      git("commit", "-q", "--allow-empty", "-m", message);
      return git("rev-parse", "HEAD").trim();
    },
    remove() {
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

export interface FixtureRepo extends TempRepo {
  base: string;
  head: string;
  fixed?: string;
  /** Any further layer the fixture has, laid over the one before it, by directory name. */
  layers: Record<string, string>;
}

export function fixtureRepo(name: string): FixtureRepo {
  const root = join(FIXTURES, name);
  const repo = tempRepo();
  cpSync(join(root, "base"), repo.dir, { recursive: true });
  const base = repo.commit("base");
  cpSync(join(root, "head"), repo.dir, { recursive: true });
  const head = repo.commit("head");
  const layers: Record<string, string> = {};
  if (!existsSync(join(root, "fixed"))) return { ...repo, base, head, layers };
  cpSync(join(root, "fixed"), repo.dir, { recursive: true });
  const fixed = repo.commit("fixed");
  // A fixture may carry more layers than these three: `one-guard-removed` is `fixed` with a single
  // check taken out, so a run over it has to stop calling the requirement verified.
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || ["base", "head", "fixed"].includes(entry.name)) continue;
    cpSync(join(root, entry.name), repo.dir, { recursive: true });
    layers[entry.name] = repo.commit(entry.name);
    // Each further layer is laid over `fixed`, not over the one before it.
    repo.git("checkout", "-q", fixed, "--", ".");
    repo.commit(`back to fixed after ${entry.name}`);
  }
  return { ...repo, base, head, fixed, layers };
}
