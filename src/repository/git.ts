// Every read of the repository goes through git objects, never the working tree: the before and
// after commits are read the same way, untracked files (a stray .env) are out of reach, and a
// symbolic link is read as the link, not as the file it points to.
//
// git still consults the working tree's .gitattributes (and the user's git config) when it diffs
// or greps two commits; in a pull request the working tree is the pull request's own. So `diff`
// and `grep` run with `--text` (binary is decided here, by a NUL byte), and every option whose
// config default could change the output is passed explicitly.
//
// Arguments are passed as an array (no shell). Search words arrive from pull request text and
// from the changed code, so they only ever follow `-e`, and revisions follow `--end-of-options`.

import { execFile, spawn } from "node:child_process";
import { EXIT, ToolError } from "../types.ts";

const MAX_OUTPUT = 64 * 1024 * 1024;
export const MAX_BLOB_BYTES = 1024 * 1024;

// git needs none of this run's secrets; a token in its environment would only be one more place
// it could surface.
const SECRET_NAME = /TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|API_KEY|PRIVATE_KEY/i;

function gitEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) if (!SECRET_NAME.test(key)) env[key] = value;
  return { ...env, GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0", LC_ALL: "C" };
}

const GIT_PREFIX = ["--no-pager", "-c", "core.quotePath=false"];

export interface TreeEntry {
  path: string;
  size: number;
}

export interface GrepHit {
  path: string;
  line: number;
  text: string;
}

/** Paths with control characters cannot be shown or parsed safely; they are skipped everywhere. */
export function isSafePath(path: string): boolean {
  return path !== "" && !/[\u0000-\u001f\u007f]/.test(path);
}

function repositoryError(message: string): ToolError {
  return new ToolError(message, EXIT.repository);
}

export class Git {
  readonly dir: string;
  private readonly trees = new Map<string, Promise<Map<string, number>>>();
  private readonly texts = new Map<string, Promise<string | null>>();

  constructor(dir: string) {
    this.dir = dir;
  }

  /** Runs git and returns stdout. Exit codes listed in `ok` count as success. */
  run(args: string[], ok: readonly number[] = [0]): Promise<{ stdout: Buffer; code: number }> {
    return new Promise((resolve, reject) => {
      execFile(
        "git",
        [...GIT_PREFIX, ...args],
        { cwd: this.dir, encoding: "buffer", maxBuffer: MAX_OUTPUT, env: gitEnv() },
        (error, stdout, stderr) => {
          const code = error ? (typeof error.code === "number" ? error.code : -1) : 0;
          if (ok.includes(code)) {
            resolve({ stdout, code });
            return;
          }
          const detail = stderr.toString("utf8").trim().split("\n")[0] || String(error?.message ?? "");
          reject(repositoryError(`git ${args[0]} failed: ${detail}`));
        },
      );
    });
  }

  async text(args: string[], ok?: readonly number[]): Promise<string> {
    return (await this.run(args, ok)).stdout.toString("utf8");
  }

  static async open(dir: string): Promise<Git> {
    const probe = new Git(dir);
    const top = (await probe.text(["rev-parse", "--show-toplevel"])).trim();
    return new Git(top);
  }

  /** The full commit id, or a repository error naming the revision. */
  async resolve(rev: string): Promise<string> {
    const { stdout, code } = await this.run(["rev-parse", "--verify", "--quiet", "--end-of-options", `${rev}^{commit}`], [0, 1, 128]);
    const sha = stdout.toString("utf8").trim();
    if (code !== 0 || !/^[0-9a-f]{40,64}$/.test(sha)) throw repositoryError(`cannot find commit '${rev}' in this clone`);
    return sha;
  }

  async isShallow(): Promise<boolean> {
    return (await this.text(["rev-parse", "--is-shallow-repository"])).trim() === "true";
  }

  async parents(sha: string): Promise<string[]> {
    const line = (await this.text(["rev-list", "--parents", "-n", "1", "--end-of-options", sha])).trim();
    return line.split(" ").slice(1);
  }

  /** The best common ancestor, or null when the history needed to find one is not in this clone. */
  async mergeBase(a: string, b: string): Promise<string | null> {
    const { stdout, code } = await this.run(["merge-base", "--end-of-options", a, b], [0, 1]);
    return code === 0 ? stdout.toString("utf8").trim() : null;
  }

  /** Every tracked file at `rev` with its size in bytes. */
  tree(rev: string): Promise<Map<string, number>> {
    let entries = this.trees.get(rev);
    if (!entries) {
      entries = this.text(["ls-tree", "-r", "-l", "-z", "--full-tree", "--end-of-options", rev]).then((out) => {
        const map = new Map<string, number>();
        for (const record of out.split("\0")) {
          // <mode> SP <type> SP <object> SP+ <size> TAB <path>
          const tab = record.indexOf("\t");
          if (tab < 0) continue;
          const [, type, , size] = record.slice(0, tab).split(/ +/);
          const path = record.slice(tab + 1);
          if (type !== "blob" || !isSafePath(path)) continue;
          map.set(path, Number(size));
        }
        return map;
      });
      this.trees.set(rev, entries);
    }
    return entries;
  }

  /**
   * A text file at `rev`, or null when it does not exist there, is larger than MAX_BLOB_BYTES,
   * or looks binary (a NUL byte in the first 8000 bytes, the same test git uses).
   */
  readText(rev: string, path: string): Promise<string | null> {
    const key = `${rev}:${path}`;
    let text = this.texts.get(key);
    if (!text) {
      text = (async () => {
        const size = (await this.tree(rev)).get(path);
        if (size === undefined || size > MAX_BLOB_BYTES) return null;
        const { stdout } = await this.run(["cat-file", "blob", `${rev}:${path}`]);
        if (stdout.subarray(0, 8000).includes(0)) return null;
        return stdout.toString("utf8");
      })();
      this.texts.set(key, text);
    }
    return text;
  }

  /**
   * Fixed-string search of the tree at `rev`. `word: true` matches whole words only. Hits in files
   * readText would refuse (binary, oversized) are dropped. Returns at most `limit` hits and whether
   * more existed; git is stopped once enough output has arrived, however common the word is.
   */
  async grep(rev: string, pattern: string, options: { word: boolean; limit: number }): Promise<{ hits: GrepHit[]; more: boolean }> {
    if (pattern === "" || /[\r\n\0]/.test(pattern)) throw new Error("grep pattern must be a single non-empty line");
    // git grep (2.39) reads --end-of-options as a revision, so the revision must be a commit id,
    // which can never be taken for an option.
    if (!/^[0-9a-f]{40,64}$/.test(rev)) throw new Error("grep needs a resolved commit id");
    const args = [...GIT_PREFIX, "grep", "-n", "--text", "-F", "-z", "--no-color", "--no-column"];
    if (options.word) args.push("-w");
    args.push("-e", pattern, rev, "--");

    // Files readText refuses for their size are known from the tree and never count; room is left
    // for hits in binary files, which are only recognised (and dropped) afterwards.
    const sizes = await this.tree(rev);
    const rawCap = options.limit * 2 + 100;
    const raw: GrepHit[] = [];
    const prefix = `${rev}:`;
    const stopped = await new Promise<boolean>((resolve, reject) => {
      const child = spawn("git", args, { cwd: this.dir, env: gitEnv(), stdio: ["ignore", "pipe", "pipe"] });
      let pending = "";
      let stderr = "";
      let full = false;
      let overlong = false; // inside a line longer than any file we would read: drop it
      const take = (record: string) => {
        // <rev>:<path> NUL <line> NUL <text>
        const parts = record.split("\0");
        if (parts.length !== 3) return;
        const [where, line, text] = parts as [string, string, string];
        if (!where.startsWith(prefix)) return;
        const path = where.slice(prefix.length);
        if (!isSafePath(path) || (sizes.get(path) ?? Number.POSITIVE_INFINITY) > MAX_BLOB_BYTES) return;
        raw.push({ path, line: Number(line), text });
        if (raw.length >= rawCap) {
          full = true;
          child.kill();
        }
      };
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        if (full) return;
        let start = 0;
        for (let nl = chunk.indexOf("\n"); nl >= 0 && !full; nl = chunk.indexOf("\n", start)) {
          if (!overlong) take(pending + chunk.slice(start, nl));
          pending = "";
          overlong = false;
          start = nl + 1;
        }
        if (full || overlong) return;
        // Only the unfinished tail is kept, so a long line costs its length once, not per chunk.
        pending += chunk.slice(start);
        if (pending.length > MAX_BLOB_BYTES * 2) {
          pending = "";
          overlong = true;
        }
      });
      child.stderr.on("data", (chunk: Buffer) => {
        if (stderr.length < 2000) stderr += chunk.toString("utf8");
      });
      child.on("error", (error) => reject(repositoryError(`git grep failed: ${error.message}`)));
      child.on("close", (code) => {
        if (full || code === 0 || code === 1) resolve(full);
        else reject(repositoryError(`git grep failed: ${stderr.trim().split("\n")[0] || `exit ${code}`}`));
      });
    });

    const readable = new Map<string, boolean>();
    await Promise.all([...new Set(raw.map((h) => h.path))].map(async (path) => readable.set(path, (await this.readText(rev, path)) !== null)));
    const hits = raw.filter((h) => readable.get(h.path));
    return { hits: hits.slice(0, options.limit), more: stopped || hits.length > options.limit };
  }

  /**
   * Every file the change touched. `--name-status` does not look at file contents or attributes,
   * so nothing here can be hidden by a .gitattributes.
   */
  async changedFiles(before: string, after: string): Promise<ChangedFile[]> {
    const out = await this.text(["diff", "--name-status", "-z", ...DIFF_SETTINGS, "--end-of-options", before, after, "--"]);
    const fields = out.split("\0");
    const files: ChangedFile[] = [];
    for (let i = 0; i < fields.length - 1; ) {
      const status = fields[i++] as string;
      const letter = status[0];
      if (letter === "R" || letter === "C") {
        const oldPath = fields[i++] as string;
        const newPath = fields[i++] as string;
        if (isSafePath(oldPath) && isSafePath(newPath)) files.push({ status: letter === "R" ? "renamed" : "added", oldPath: letter === "R" ? oldPath : null, newPath });
        continue;
      }
      const path = fields[i++] as string;
      if (!isSafePath(path)) continue;
      if (letter === "A") files.push({ status: "added", oldPath: null, newPath: path });
      else if (letter === "D") files.push({ status: "deleted", oldPath: path, newPath: null });
      else files.push({ status: "modified", oldPath: path, newPath: path });
    }
    return files;
  }

  /**
   * Unified diff with no context lines. `--text` because a .gitattributes in the working tree
   * could otherwise mark any file binary and so hide its change; callers pass only paths already
   * known to be text within MAX_BLOB_BYTES, which also bounds the output. Without `paths`, the
   * whole change (tests only).
   */
  diffText(before: string, after: string, paths?: readonly string[]): Promise<string> {
    const pathspec = paths ?? [];
    return this.text([
      ...(paths ? ["--literal-pathspecs"] : []),
      "diff",
      "--text",
      "-U0",
      ...DIFF_SETTINGS,
      "--end-of-options",
      before,
      after,
      "--",
      ...pathspec,
    ]);
  }
}

export interface ChangedFile {
  status: "added" | "deleted" | "modified" | "renamed";
  oldPath: string | null;
  newPath: string | null;
}

// Everything git config could otherwise decide about the diff (~/.gitconfig and the repository's
// own config both apply): the algorithm and heuristics move hunk boundaries, the rename limit
// turns renames into additions, the prefixes and relative mode change the paths.
const DIFF_SETTINGS = [
  "--no-color",
  "--no-ext-diff",
  "--no-textconv",
  "--src-prefix=a/",
  "--dst-prefix=b/",
  "--diff-algorithm=myers",
  "--indent-heuristic",
  "--inter-hunk-context=0",
  "--no-relative",
  "-M",
  "-l1000",
];
