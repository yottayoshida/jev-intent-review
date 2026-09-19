// Parses `git diff -U0` output (see Git.diff) into files and hunks.

export interface Hunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  removed: string[];
  added: string[];
}

export interface FileChange {
  oldPath: string | null; // null when the file was added
  newPath: string | null; // null when the file was deleted
  status: "added" | "deleted" | "modified" | "renamed";
  binary: boolean;
  hunks: Hunk[];
}

/** Undoes git's C-style quoting of a path ("a\tb", "\303\251"). */
export function unquotePath(raw: string): string {
  if (!raw.startsWith('"')) return raw;
  const bytes: number[] = [];
  const escapes: Record<string, number> = { a: 7, b: 8, t: 9, n: 10, v: 11, f: 12, r: 13, '"': 34, "\\": 92 };
  for (let i = 1; i < raw.length - 1; i++) {
    const ch = raw[i] as string;
    if (ch !== "\\") {
      bytes.push(...Buffer.from(ch, "utf8"));
      continue;
    }
    const next = raw[i + 1] as string;
    if (/[0-7]/.test(next)) {
      bytes.push(parseInt(raw.slice(i + 1, i + 4), 8));
      i += 3;
    } else {
      bytes.push(escapes[next] ?? next.charCodeAt(0));
      i += 1;
    }
  }
  return Buffer.from(bytes).toString("utf8");
}

/** `a/foo` → `foo`; `/dev/null` → null. */
function stripSide(raw: string, side: "a/" | "b/"): string | null {
  const path = unquotePath(raw.trim());
  if (path === "/dev/null") return null;
  return path.startsWith(side) ? path.slice(2) : path;
}

/** Index of the quote that closes a quoted path starting at `start`, skipping `\"` escapes. */
function closingQuote(text: string, start: number): number {
  for (let i = start + 1; i < text.length; i++) {
    if (text[i] === "\\") i++;
    else if (text[i] === '"') return i;
  }
  return -1;
}

/** Both paths from `diff --git a/X b/X`, used when no ---/+++ lines follow (binary, pure rename). */
function headerPaths(rest: string): [string, string] | null {
  if (rest.startsWith('"')) {
    const end = closingQuote(rest, 0);
    if (end < 0 || rest[end + 1] !== " ") return null;
    const a = stripSide(rest.slice(0, end + 1), "a/");
    const b = stripSide(rest.slice(end + 2), "b/");
    return a !== null && b !== null ? [a, b] : null;
  }
  // Unquoted and not a rename: "a/P b/P" with the same P on both sides.
  const half = (rest.length - 1) / 2;
  if (!Number.isInteger(half)) return null;
  const a = rest.slice(0, half);
  const b = rest.slice(half + 1);
  return a.startsWith("a/") && b.startsWith("b/") && a.slice(2) === b.slice(2) ? [a.slice(2), b.slice(2)] : null;
}

const HUNK = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

export function parseDiff(text: string): FileChange[] {
  const files: FileChange[] = [];
  let file: FileChange | null = null;
  let hunk: Hunk | null = null;

  for (const line of text.split("\n")) {
    if (line.startsWith("diff --git ")) {
      const paths = headerPaths(line.slice("diff --git ".length));
      file = { oldPath: paths?.[0] ?? null, newPath: paths?.[1] ?? null, status: "modified", binary: false, hunks: [] };
      files.push(file);
      hunk = null;
      continue;
    }
    if (!file) continue;
    const match = HUNK.exec(line);
    if (match) {
      hunk = {
        oldStart: Number(match[1]),
        oldLines: match[2] === undefined ? 1 : Number(match[2]),
        newStart: Number(match[3]),
        newLines: match[4] === undefined ? 1 : Number(match[4]),
        removed: [],
        added: [],
      };
      file.hunks.push(hunk);
      continue;
    }
    if (hunk) {
      if (line.startsWith("-")) hunk.removed.push(line.slice(1));
      else if (line.startsWith("+")) hunk.added.push(line.slice(1));
      continue; // "\ No newline at end of file" and the trailing empty line
    }
    if (line.startsWith("new file mode")) file.status = "added";
    else if (line.startsWith("deleted file mode")) file.status = "deleted";
    else if (line.startsWith("rename from ")) {
      file.oldPath = unquotePath(line.slice("rename from ".length));
      file.status = "renamed";
    } else if (line.startsWith("rename to ")) {
      file.newPath = unquotePath(line.slice("rename to ".length));
      file.status = "renamed";
    } else if (line.startsWith("Binary files ")) file.binary = true;
    else if (line.startsWith("--- ")) file.oldPath = stripSide(line.slice(4), "a/");
    else if (line.startsWith("+++ ")) file.newPath = stripSide(line.slice(4), "b/");
  }

  for (const f of files) {
    if (f.status === "added") f.oldPath = null;
    if (f.status === "deleted") f.newPath = null;
  }
  return files;
}
