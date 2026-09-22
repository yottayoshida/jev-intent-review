// Collecting the intent (spec §8, §28): where it came from, who wrote it, and how much it counts
// when sources disagree. Text the pull request's author wrote about their own change is kept apart
// from the issue it answers, so the report can say whose words the requirements are.

import { readFile } from "node:fs/promises";
import { EXIT, ToolError, type IntentSource, type IntentSpec } from "../types.ts";
import type { GitHub, Issue, PullRequest } from "./github.ts";
import { parseIntentSpec } from "./schema.ts";

export interface IntentArgs {
  pr?: number;
  issue?: number;
  intent?: string;
  intentFile?: string;
  intentSpec?: string;
  repo?: { owner: string; name: string };
}

export interface ResolvedIntent {
  sources: IntentSource[];
  spec?: IntentSpec; // given directly with --intent-spec: no compiling
  pullRequest?: PullRequest;
  notes: string[]; // for the report: what was looked for and not found
}

// Spec §28. The pull request's description is written after the change exists and can describe
// accidental changes as intended, so it ranks below the issue it answers.
const AUTHORITY = { spec: 100, cli: 100, file: 100, acceptance_criteria: 100, github_issue: 90, pr_description: 50 } as const;

/** Said in the notes of every run, and as a blocker of a review: intent that exists and was not read. */
export function issuesNotListed(count: number): string {
  return `The pull request closes ${count} more issue(s) than GitHub listed (the first 10); they were not read.`;
}

export async function resolveIntent(
  args: IntentArgs,
  options: { github: () => Promise<GitHub>; includePrDescription: boolean; preferIssue: boolean },
): Promise<ResolvedIntent> {
  const sources: IntentSource[] = [];
  let spec: IntentSpec | undefined;
  let pullRequest: PullRequest | undefined;

  const read = async (path: string) => {
    try {
      return await readFile(path, "utf8");
    } catch (error) {
      throw new ToolError(`cannot read ${path}: ${error instanceof Error ? error.message : String(error)}`, EXIT.intent);
    }
  };

  if (args.intentSpec !== undefined) {
    spec = parseIntentSpec(await read(args.intentSpec), args.intentSpec);
    sources.push({ id: `file:${args.intentSpec}`, type: "spec", authority: AUTHORITY.spec, text: "" });
  }
  if (args.intent !== undefined && args.intent.trim() !== "") sources.push({ id: "cli", type: "cli", authority: AUTHORITY.cli, text: args.intent });
  if (args.intentFile !== undefined) sources.push({ id: `file:${args.intentFile}`, type: "file", authority: AUTHORITY.file, text: await read(args.intentFile) });

  if (args.issue !== undefined || args.pr !== undefined) {
    if (!args.repo) throw new ToolError("--pr and --issue need the repository: pass --repo owner/name (or set GITHUB_REPOSITORY)", EXIT.intent);
    const github = await options.github();
    const issueSource = (issue: Issue): IntentSource => ({
      id: `issue#${issue.number}`,
      type: "github_issue",
      authority: AUTHORITY.github_issue,
      ...(issue.author ? { author: issue.author } : {}),
      ...(issue.url ? { url: issue.url } : {}),
      text: `${issue.title}\n\n${issue.body}`.trim(),
    });
    if (args.issue !== undefined) sources.push(issueSource(await github.issue(args.repo, args.issue)));
    if (args.pr !== undefined) {
      pullRequest = await github.pullRequest(args.repo, args.pr);
      for (const issue of pullRequest.issues) if (!sources.some((s) => s.id === `issue#${issue.number}`)) sources.push(issueSource(issue));
      if (options.includePrDescription) {
        sources.push({
          id: `pr#${pullRequest.number}`,
          type: "pr_description",
          authority: options.preferIssue ? AUTHORITY.pr_description : AUTHORITY.github_issue + 5,
          ...(pullRequest.author ? { author: pullRequest.author } : {}),
          ...(pullRequest.url ? { url: pullRequest.url } : {}),
          text: `${pullRequest.title}\n\n${pullRequest.body}`.trim(),
        });
      }
    }
  }

  const withText = sources.filter((s) => s.type === "spec" || s.text.trim() !== "");
  // Whether the requirements are the pull request author's own words is decided from where the
  // requirements were read (`onlyFromPullRequest`), not from which sources had text.
  const notes = [
    ...(pullRequest?.missingIssues ?? []).map((n) => `The pull request's text closes #${n}, which is not an issue in this repository; it was not read.`),
    ...(pullRequest?.foreignIssues ?? []).map((ref) => `The pull request closes ${ref}, an issue in another repository; it was not read.`),
    ...(pullRequest?.issuesNotListed ? [issuesNotListed(pullRequest.issuesNotListed)] : []),
  ];
  return { sources: withText, ...(spec ? { spec } : {}), ...(pullRequest ? { pullRequest } : {}), notes };
}
