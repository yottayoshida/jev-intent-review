// What a checkout's `src/` held when a bench ran, as one hash.
//
// A run made before its own commit can name no commit id. Every `.ts` file under `src/` on disk —
// tracked or not, since a new file is exactly what such a run measures — is hashed by path with its
// bytes. Recomputed at a commit, it says whether that commit is the code a log was taken with, and
// two logs carrying the same value were taken with the same code.

import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export function srcDigest(root: string): string {
  const hash = createHash("sha256");
  const paths = (readdirSync(join(root, "src"), { recursive: true }) as string[]).filter((p) => p.endsWith(".ts")).sort();
  for (const path of paths) hash.update(`src/${path}\0`).update(readFileSync(join(root, "src", path))).update("\0");
  return hash.digest("hex");
}
