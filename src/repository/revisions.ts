// Which two commits the review compares.
//
// In a GitHub `pull_request` workflow, actions/checkout checks out a merge commit of the pull
// request into its base branch: that merge commit is "after", and its first parent (the base
// branch as it was) is "before". The diff between them is exactly what merging would change.
// Elsewhere, `--base` names the branch or commit the change started from, and "before" is its
// merge base with `--head`.

import { EXIT, ToolError } from "../types.ts";
import type { Git } from "./git.ts";

export interface Revisions {
  before: string;
  after: string;
  how: string;
}

const HISTORY_HINT = "In GitHub Actions, check out with `fetch-depth: 0` (actions/checkout).";

export async function resolveRevisions(git: Git, options: { base?: string; head?: string; env: NodeJS.ProcessEnv }): Promise<Revisions> {
  const after = await git.resolve(options.head ?? "HEAD");

  if (options.base !== undefined) {
    let base: string;
    try {
      base = await git.resolve(options.base);
    } catch (error) {
      if (await git.isShallow()) throw new ToolError(`cannot find '${options.base}' in this shallow clone. ${HISTORY_HINT}`, EXIT.repository);
      throw error;
    }
    const before = await git.mergeBase(base, after);
    if (before === null) {
      const hint = (await git.isShallow()) ? ` This clone is shallow. ${HISTORY_HINT}` : "";
      throw new ToolError(`'${options.base}' and the head share no history, so there is no point the change started from.${hint}`, EXIT.repository);
    }
    const how = `merge base of ${options.base} and ${options.head ?? "HEAD"}`;
    // Nothing between the two commits is not an empty review, it is a review that never happened:
    // reporting "no violation found" over no change at all is the one answer that cannot be right.
    // It is what a pull request merged with a merge commit gives when the base is resolved from
    // the branch name, because the branch then contains the head. (The Actions path below cannot
    // reach this: a merge commit is never its own first parent.)
    if (before === after) {
      const hint = (await git.isShallow()) ? ` This clone is shallow, so the commit the change starts from may be missing. ${HISTORY_HINT}` : "";
      throw new ToolError(`there is nothing to compare: the ${how} is the head commit itself (${after.slice(0, 12)}). Pass --base with the commit the change starts from.${hint}`, EXIT.config);
    }
    return { before, after, how };
  }

  // Only the commit GitHub made for this pull_request event is known to be "base + the pull
  // request". Any other two-parent commit (a head checked out by sha, which "Update branch" made a
  // merge) has the pull request's own history as its first parent.
  const env = options.env;
  if (env.GITHUB_ACTIONS === "true" && options.head === undefined) {
    // Not pull_request_target: there GITHUB_SHA is the base branch, not a merge commit.
    if (env.GITHUB_EVENT_NAME !== "pull_request" || env.GITHUB_SHA !== after) {
      throw new ToolError(
        "in GitHub Actions without --base, the checkout must be the pull request merge commit (GITHUB_SHA of a pull_request event); otherwise pass --base",
        EXIT.config,
      );
    }
    const parents = await git.parents(after);
    if (parents.length === 2) return { before: parents[0] as string, after, how: "the pull request merge commit and its first parent" };
    if (parents.length === 0) {
      throw new ToolError(`the checked-out commit has no parent in this clone, so there is nothing to compare it with. Use \`fetch-depth: 2\` or more. ${HISTORY_HINT}`, EXIT.repository);
    }
    throw new ToolError("the checked-out commit is not a pull request merge commit; pass --base with the branch the change starts from", EXIT.config);
  }

  throw new ToolError("pass --base with the branch or commit the change starts from (for example --base main)", EXIT.config);
}
