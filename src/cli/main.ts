#!/usr/bin/env node
// Command line entry. Exit codes are spec §26 (see EXIT in types.ts).

import { readFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { loadConfig, type Config } from "../config/config.ts";
import { onlyFromPullRequest, readingBlockers, readRequirements, type Reading } from "../intent/compiler.ts";
import { GitHub, githubToken, parseRepository, type PullRequest } from "../intent/github.ts";
import { issuesNotListed, resolveIntent } from "../intent/resolver.ts";
import { JevClient, endpointFromEnv, EndpointError, hostName, jevModel, namedProvider, PROVIDER_KEYS, ProviderError, type Endpoint } from "../judgments/client.ts";
import { JevProvider } from "../judgments/jev.ts";
import { LimitedProvider, type JudgmentProvider } from "../judgments/provider.ts";
import { QUESTIONS_HASH } from "../judgments/questions.ts";
import { isSensitivePath } from "../evidence/redact.ts";
import { renderJson, renderMarkdown } from "../report/markdown.ts";
import { Git } from "../repository/git.ts";
import { resolveRevisions, type Revisions } from "../repository/revisions.ts";
import { DEFAULT_LOCAL_CHECK, runLocalCheck, type LocalCheckResult } from "../review/local-check-run.ts";
import { pathFilter } from "../config/glob.ts";
import { reviewChanges } from "../review/unexpected-change.ts";
import { EXIT, ToolError, type IntentSource, type IntentSpec, type ReviewReport, type SkipKind, type UnexpectedChange } from "../types.ts";
import { VERSION } from "../version.ts";

const HELP = `Usage: jev-intent-review [options]

Checks the repository after a change against the intent behind it, including code the change
did not touch.

Intent (one or more):
  --pr <number>         a pull request: the issues it closes, then its description
                        (in a GitHub pull_request workflow, the event's pull request by default)
  --issue <number>      an issue
  --intent <text>       the intent as text
  --intent-file <file>  the intent as a text file
  --intent-spec <file>  requirements as an IntentSpec JSON file (no compiling)
  --repo <owner/name>   the GitHub repository (default: GITHUB_REPOSITORY, then the origin remote)

Change:
  --base <rev>          the branch or commit the change starts from
                        (with --pr: the pull request's base branch; in a pull_request workflow:
                        the merge commit's first parent)
  --head <rev>          the commit after the change (default: HEAD; with --pr outside a
                        pull_request workflow, the pull request's head commit)

What a run does: for each requirement, take the Rust functions the change touched and their
callers one hop out, and ask Jev two things about each call, as the requirement's "form" says.
The default, failure_propagation: whether the requirement requires that a failure of the call
not reach the caller as a success, and what the function returns when it does. The other,
check_before_action: whether the requirement requires a check to pass before the call, and
whether the function still makes the call when the check does not pass. A spec names a
requirement's form; one read from an issue, a pull request, --intent or --intent-file is first
asked of Jev, once, which form its sentence says, and is read under that form when Jev is sure
(0.6), else under the default. One rule reads each call as holding, worth checking, not
settled, or not required of. A
call worth checking is listed with the requirement's words, the code, the assumption and both
answers. Then every change the pull request made is asked about once: is it asked for by any
requirement? No file, function or expected answer is named on the command line. No requirement
verdict is stated. A call worth checking leaves the exit code at 0 unless .jev-intent-review.yml
says policy.fail_on: [finding]. Nothing listed means no call met the conditions -- including
calls left undetermined -- and exit 0 does not establish that the requirement holds.

Run:
  --candidates-only     build the set and stop. Prints which calls fit the budget and which do
                        not, with a reason each, and asks nothing -- no credentials needed
  --skip-change-check   do not ask whether each change was asked for; only the calls are read
  --experimental-local-check
                        accepted: this is the run now. The report and the exit code are the
                        same without it; one line on stderr says so

Output:
  --json                print the report as JSON instead of Markdown
  --trace               print searches, candidates and answers to stderr
  -h, --help            show this help
  --version             show the version

Model: Jev, and nothing else -- typesafe/jev on Cloudflare and for JEV_API_URL, jev-latest on
TypeSafe, typesafe-ai/jev on Vercel AI Gateway. A request for any other model is refused
before it is built, so no other model can be reached from here.

Intent: --intent-spec, or two forms read as written from the issue, the pull request,
--intent or --intent-file: the items of a requirements section ("Acceptance criteria",
"Acceptance", "Requirements", "Definition of done", "Done when"), and a paragraph that
begins "Property:" (docs/writing-requirements.md). No model writes or picks requirements.
Whenever the tool prints its report, or stops because it could not read the requirements,
every issue and pull request it read is either read into requirements as written -- leaving
out only HTML comments, code blocks, link reference definitions and characters that display
as nothing -- or named with the reason it was not. With credentials, a run that reads
nothing stops (exit 11); without them it is skipped. Failures that print no report (exit 10,
12, 13) are outside this.

Environment: JEV_PROVIDER names where Jev is asked -- cloudflare (CLOUDFLARE_ACCOUNT_ID and
CLOUDFLARE_API_TOKEN), typesafe (TYPESAFE_API_KEY) or vercel (AI_GATEWAY_API_KEY). Each key
goes only to its own host's fixed address. Without JEV_PROVIDER: JEV_API_URL and JEV_API_TOKEN
for an endpoint that serves a Workers AI run request, else the Cloudflare pair; TYPESAFE_API_KEY
or AI_GATEWAY_API_KEY alone is not used. GITHUB_TOKEN or GH_TOKEN (or a logged-in gh) for --pr
and --issue.

Exit codes: 0 the run finished (or was skipped), 1 a call worth checking with
policy.fail_on: [finding], 2 the run did not finish, 10 configuration error, 11 intent could
not be resolved, 12 judgment provider failed (including an endpoint that answered no judgment
at all), 13 repository could not be read.
`;

export interface Io {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  cwd: string;
  env: NodeJS.ProcessEnv;
}

/**
 * One line, whatever was put in it. Everything written to stderr goes through this: a message can
 * carry text from the repository, the pull request or the endpoint, and in GitHub Actions a line
 * that starts with `::` is a command to the runner.
 */
function flat(text: string): string {
  return text.replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, " ");
}

/** What talks to the outside world; tests pass scripted ones. */
export interface Deps {
  judges?: (endpoint: Endpoint, config: Config, deadline: number) => { provider: JudgmentProvider; sent: () => { requests: number; bytes: number }; origin: string };
  /** The network under the real client: a test stands in for a host here and keeps the wiring from host to request shape. */
  fetch?: typeof fetch;
  github?: (env: NodeJS.ProcessEnv) => Promise<GitHub>;
}

function parse(argv: string[]) {
  let values;
  try {
    values = parseArgs({
      args: argv,
      strict: true,
      allowPositionals: false,
      options: {
        pr: { type: "string" },
        issue: { type: "string" },
        intent: { type: "string" },
        "intent-file": { type: "string" },
        "intent-spec": { type: "string" },
        repo: { type: "string" },
        base: { type: "string" },
        head: { type: "string" },
        "candidates-only": { type: "boolean", default: false },
        "skip-change-check": { type: "boolean", default: false },
        // Accepted from 0.1, when they selected the local check; the run is the local check now.
        "experimental-local-check": { type: "boolean", default: false },
        "experimental-candidates-only": { type: "boolean", default: false },
        json: { type: "boolean", default: false },
        trace: { type: "boolean", default: false },
        help: { type: "boolean", short: "h", default: false },
        version: { type: "boolean", default: false },
      },
    }).values;
  } catch (error) {
    throw new ToolError(`${error instanceof Error ? error.message : String(error)} (see --help)`, EXIT.config);
  }
  const number = (name: "pr" | "issue") => {
    const raw = values[name];
    if (raw === undefined) return undefined;
    if (!/^[1-9]\d{0,9}$/.test(raw)) throw new ToolError(`--${name} must be a number`, EXIT.config);
    return Number(raw);
  };
  return { ...values, prNumber: number("pr"), issueNumber: number("issue") };
}

function defaultJudges(endpoint: Endpoint, config: Config, deadline: number, env: NodeJS.ProcessEnv, fetch?: typeof globalThis.fetch) {
  const client = new JevClient(endpoint, { deadline, maxRequests: config.limits.max_requests, maxBytes: config.limits.max_sent_bytes, ...(fetch ? { fetch } : {}) });
  return {
    provider: new LimitedProvider(new JevProvider(client, { env }), { concurrency: 8, deadline }),
    sent: () => ({ ...client.sent }),
    origin: client.origin,
  };
}

async function defaultGithub(env: NodeJS.ProcessEnv): Promise<GitHub> {
  const token = await githubToken(env);
  return new GitHub({ ...(token ? { token } : {}), ...(env.GITHUB_API_URL ? { apiUrl: env.GITHUB_API_URL } : {}), ...(env.GITHUB_GRAPHQL_URL ? { graphqlUrl: env.GITHUB_GRAPHQL_URL } : {}) });
}

/**
 * What the pull_request event says about where this pull request came from. GitHub gives a run
 * started by another repository's pull request no secrets, and gives Dependabot's none either, so a
 * run that asked nothing for want of a key says which of the three it was (ADR 0010).
 *
 * The head repository's own `fork` flag is not read: it says that repository is a fork of something,
 * which is true of a pull request opened inside a fork as well, and those do get the secrets.
 */
export function eventOrigin(env: NodeJS.ProcessEnv): "same_repository" | "fork" | "dependabot" | "unknown" {
  const pr = eventPullRequestOf(env);
  if (!pr) return "unknown";
  // A deleted fork leaves `head.repo` empty. The pull request still came from another repository:
  // this one cannot be deleted while its own pull request is open.
  const headRepo = pr.head?.repo;
  if (headRepo === null) return "fork";
  const head = headRepo?.full_name;
  const base = pr.base?.repo?.full_name ?? env.GITHUB_REPOSITORY;
  if (typeof head !== "string" || typeof base !== "string") return "unknown";
  if (head !== base) return "fork";
  return pr.user?.login === "dependabot[bot]" ? "dependabot" : "same_repository";
}

/** The pull request of the pull_request event this workflow runs for, read once for every caller. */
function eventPullRequestOf(env: NodeJS.ProcessEnv): EventPullRequest | undefined {
  if (env.GITHUB_EVENT_NAME !== "pull_request" || !env.GITHUB_EVENT_PATH) return undefined;
  try {
    return (JSON.parse(readFileSync(env.GITHUB_EVENT_PATH, "utf8")) as { pull_request?: EventPullRequest }).pull_request;
  } catch {
    return undefined;
  }
}

interface EventPullRequest {
  number?: unknown;
  user?: { login?: unknown };
  head?: { repo?: { full_name?: unknown } | null };
  base?: { repo?: { full_name?: unknown } };
}

/** The pull request number of the pull_request event this workflow runs for, if any. */
function eventPullRequest(env: NodeJS.ProcessEnv): number | undefined {
  const number = eventPullRequestOf(env)?.number;
  return typeof number === "number" ? number : undefined;
}

/**
 * The commit a pull request started from: of the places it could be, the latest point the head
 * still shares with one of them. Two ways of naming it are each wrong on their own — the base
 * branch has the head in it once the pull request is merged with a merge commit, leaving nothing
 * to compare (five of the ten pull requests in the first measurement silently did that), and the
 * base oid GitHub recorded stays where the pull request started, so a head that took the branch
 * in later would carry other people's commits into the change. A stale `origin/<branch>` in the
 * clone is the same mistake as the second. The latest shared point is right in all three.
 */
async function baseOf(git: Git, pr: PullRequest, head: string): Promise<string> {
  const after = await git.resolve(head);
  let best: { rev: string; at: string } | undefined;
  let shared: string | undefined; // resolves and shares history, but leaves nothing to compare
  let known: string | undefined; // resolves at all
  const branch = pr.baseRefName === "" ? [] : [`origin/${pr.baseRefName}`, pr.baseRefName];
  for (const rev of [...branch, pr.baseSha]) {
    if (rev === "") continue;
    const sha = await git.resolve(rev).catch(() => undefined);
    if (sha === undefined) continue;
    known ??= rev;
    const at = await git.mergeBase(sha, after);
    if (at === null) continue;
    if (at === after) {
      shared ??= rev;
      continue;
    }
    if (best === undefined || (at !== best.at && (await git.mergeBase(best.at, at)) === best.at)) best = { rev, at };
  }
  // With nothing to compare anywhere, keep a candidate that exists so the run stops with the
  // message about the two commits rather than one about a revision that cannot be found.
  return best?.rev ?? shared ?? known ?? pr.baseRefName;
}

const NO_INTENT: IntentSpec = { version: 1, title: "", summary: "", requirements: [], nonGoals: [], ambiguities: [] };

interface ReportParts {
  exitCode: number;
  skipReason?: string;
  skipKind?: SkipKind;
  intent?: IntentSpec;
  sources: readonly IntentSource[];
  requirements?: LocalCheckResult[];
  unexpectedChanges?: UnexpectedChange[];
  sent?: ReviewReport["sent"];
  notes: string[];
  prAuthor?: string | undefined;
}

/**
 * The one report shape, whichever way the run ended (ADR 0007). A skipped or stopped run still says
 * what would have been checked and what could not be read.
 */
function reportOf(revisions: Revisions, repository: string, configSource: string, model: string, parts: ReportParts): ReviewReport {
  return {
    version: 2,
    tool: { name: "jev-intent-review", version: VERSION },
    exitCode: parts.exitCode,
    ...(parts.skipReason === undefined ? {} : { skipReason: parts.skipReason }),
    ...(parts.skipKind === undefined ? {} : { skipKind: parts.skipKind }),
    intent: parts.intent ?? NO_INTENT,
    sources: parts.sources.map(({ text: _text, ...source }) => source),
    requirements: parts.requirements ?? [],
    unexpectedChanges: parts.unexpectedChanges ?? [],
    sent: parts.sent ?? { requests: 0, bytes: 0, answered: 0 },
    metadata: { repository, base: revisions.before, head: revisions.after, model, questionsHash: QUESTIONS_HASH, configSource, notes: parts.notes, ...(parts.prAuthor ? { pullRequestAuthor: parts.prAuthor } : {}) },
  };
}

export async function main(argv: string[], io: Io, deps: Deps = {}): Promise<number> {
  try {
    const args = parse(argv);
    if (args.help) {
      io.stdout(HELP);
      return EXIT.ok;
    }
    if (args.version) {
      io.stdout(`${VERSION}\n`);
      return EXIT.ok;
    }
    // Trace lines carry text from the repository and the pull request. Control characters are
    // flattened so no value can start a line of its own (in GitHub Actions, a line starting with
    // `::` is a workflow command).
    const trace = args.trace ? (line: string) => io.stderr(`[trace] ${flat(line)}\n`) : () => {};
    const explicitIntent = args.prNumber !== undefined || args.issueNumber !== undefined || args.intent !== undefined || args["intent-file"] !== undefined;
    if (args["intent-spec"] !== undefined && explicitIntent) {
      throw new ToolError("--intent-spec takes the requirements as written; it cannot be combined with --pr, --issue, --intent or --intent-file", EXIT.config);
    }
    const output = (report: ReviewReport) => {
      io.stdout(args.json ? renderJson(report) : renderMarkdown(report));
      return report.exitCode;
    };

    // Before anything is read or resolved: a malformed endpoint is a setting to fix, and a run
    // that is skipped for want of an intent must not hide one.
    let endpoint: Endpoint | null;
    try {
      endpoint = endpointFromEnv(io.env);
    } catch (error) {
      throw new ToolError(error instanceof EndpointError ? error.message : String(error), EXIT.config);
    }
    if (endpoint) trace(`judgments go to ${hostName(endpoint.host)} (${new URL(endpoint.url).origin})`);
    // What a skipped report says would have been asked: Jev under the chosen host's name, which is
    // the named host's even when its key is missing. And what is missing, said as exactly as it can
    // be: a secret name mistyped in a workflow is otherwise a green run that judged nothing.
    const named = namedProvider(io.env);
    const model = jevModel(endpoint?.host ?? named ?? "cloudflare");
    const needed =
      named === undefined
        ? "JEV_PROVIDER and that host's key, CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN, or JEV_API_URL and JEV_API_TOKEN"
        : `${PROVIDER_KEYS[named].join(" and ")}, which JEV_PROVIDER=${named} needs`;

    const git = await Git.open(io.cwd);
    const origin = await git.text(["remote", "get-url", "origin"], [0, 2, 128]).catch(() => "");
    const repo = parseRepository(args.repo ?? io.env.GITHUB_REPOSITORY ?? origin);
    if (args.repo !== undefined && !repo) throw new ToolError("--repo must look like owner/name", EXIT.config);
    const repository = repo ? `${repo.owner}/${repo.name}` : git.dir;
    // The event's pull request stands in for --pr, unless the requirements were given as written.
    const prNumber = args.prNumber ?? (args["intent-spec"] === undefined ? eventPullRequest(io.env) : undefined);
    let github: Promise<GitHub> | undefined;
    const getGithub = () => (github ??= (deps.github ?? defaultGithub)(io.env));

    // Outside a pull_request workflow, --pr names the change as well as the intent: its base
    // branch and its head commit, not whatever is checked out.
    let base = args.base;
    let head = args.head;
    // Only a pull_request event checks out the pull request (as a merge commit); an issue_comment
    // or workflow_dispatch run has the default branch checked out, so --pr must name the head there too.
    if (prNumber !== undefined && repo && io.env.GITHUB_EVENT_NAME !== "pull_request" && (base === undefined || head === undefined)) {
      const pr = await (await getGithub()).pullRequest(repo, prNumber);
      // The head first: which base leaves something to compare is a question about it.
      if (head === undefined) {
        if (!pr.headSha) throw new ToolError(`GitHub gave no head commit for pull request #${prNumber}; pass --head`, EXIT.intent);
        await git.resolve(pr.headSha).catch(() => {
          throw new ToolError(`the head of pull request #${prNumber} (${pr.headSha.slice(0, 12)}) is not in this clone; run \`git fetch origin pull/${prNumber}/head\` or pass --head`, EXIT.repository);
        });
        head = pr.headSha;
      }
      if (base === undefined) base = await baseOf(git, pr, head);
    }
    const revisions = await resolveRevisions(git, { ...(base !== undefined ? { base } : {}), ...(head !== undefined ? { head } : {}), env: io.env });
    trace(`before ${revisions.before}, after ${revisions.after} (${revisions.how})`);
    const loaded = await loadConfig(git, revisions.before, revisions.after);
    const config = loaded.config;
    trace(`config: ${loaded.source}`);
    const report = (parts: ReportParts) => reportOf(revisions, repository, loaded.source, model, parts);
    if (args["experimental-local-check"]) io.stderr("jev-intent-review: --experimental-local-check is the run now; the report and the exit code are the same without it\n");

    const resolved = await resolveIntent(
      {
        ...(prNumber !== undefined ? { pr: prNumber } : {}),
        ...(args.issueNumber !== undefined ? { issue: args.issueNumber } : {}),
        ...(args.intent !== undefined ? { intent: args.intent } : {}),
        ...(args["intent-file"] !== undefined ? { intentFile: args["intent-file"] } : {}),
        ...(args["intent-spec"] !== undefined ? { intentSpec: args["intent-spec"] } : {}),
        ...(repo ? { repo } : {}),
      },
      { github: getGithub, includePrDescription: config.intent.include_pr_description, preferIssue: config.intent.prefer_issue },
    );
    for (const source of resolved.sources) trace(`intent source ${source.id} (${source.type}, authority ${source.authority}${source.author ? `, by ${source.author}` : ""})`);
    // Issues the pull request closes that were not read — in another repository, missing, or past
    // what GitHub listed — are named by every way this run can end, not only by a finished review.
    const notes = resolved.notes;
    const prAuthor = resolved.pullRequest?.author;
    // A run that stops for want of intent still prints what was read: stdout carries the same Intent
    // section a finished run does, stderr the one line.
    const stop = (headline: string, intent: IntentSpec, sources: readonly IntentSource[], message: string): never => {
      // The same shape as every other way the run ends, with the exit code it ends with.
      io.stdout(args.json ? renderJson(report({ exitCode: EXIT.intent, intent, sources, notes: [headline, ...notes], prAuthor })) : renderMarkdown(report({ exitCode: EXIT.intent, intent, sources, notes: [headline, ...notes], prAuthor })));
      throw new ToolError(message, EXIT.intent);
    };
    if (resolved.sources.length === 0) {
      const none = "nothing was read from an issue, the pull request's description or --intent";
      if (config.policy.no_intent === "fail") stop("No statement of intent was found.", NO_INTENT, [], `no intent was found: ${none}${notes.length > 0 ? ` (${notes.join(" ")})` : ""}`);
      return output(report({ exitCode: EXIT.ok, skipReason: `No statement of intent was found: ${none}.`, skipKind: "no_intent", sources: [], notes, prAuthor }));
    }

    // No model writes or chooses the requirements (ADR 0004): the documented forms are read as
    // written, each source on its own. That asks nothing, so it happens before the credentials gate,
    // and every way this run ends below says what was read and what was not.
    const reading: Reading = resolved.spec ? { spec: resolved.spec, unread: [], notChecked: [] } : readRequirements(resolved.sources);
    const intent = reading.spec;
    for (const r of intent.requirements) trace(`${r.id}: ${r.text}`);
    for (const u of reading.unread) trace(`not read: ${u.sourceId} (${u.reason})`);
    const shownSources = resolved.sources.map(({ text: _text, ...source }) => source);
    // Intent given on the command line was given on purpose; it is not dropped quietly because
    // something else could be read.
    const explicitUnread = reading.unread.filter((u) => u.type === "cli" || u.type === "file");
    const specFile = resolved.spec ? resolved.sources.find((s) => s.type === "spec")?.id.replace(/^file:/, "") : undefined;
    const unreadable =
      intent.requirements.length === 0
        ? specFile !== undefined
          ? `the IntentSpec file ${specFile} lists no requirement`
          : `no requirement could be read as written from ${reading.unread.map((u) => `${u.sourceId} (${u.reason})`).join("; ") || "the intent given"}`
        : explicitUnread.length > 0
          ? `the intent given on the command line could not be read as written: ${explicitUnread.map((u) => `${u.sourceId} (${u.reason})`).join("; ")}`
          : undefined;
    const howToWrite = specFile !== undefined ? "list at least one in its requirements" : "state requirements under an 'Acceptance criteria' heading, one per item, or in a 'Property:' paragraph (docs/writing-requirements.md), or give --intent-spec";
    const stopUnread = (): never =>
      stop(
        intent.requirements.length === 0 ? "No requirement could be read as written." : "The intent given on the command line could not be read as written.",
        intent,
        resolved.sources,
        `${unreadable}: ${howToWrite}`,
      );

    // Everything the run has to say beside the calls it read (ADR 0004, 0007): intent that exists
    // and was not checked — a source as high as anything read and itself unread, requirements past
    // the first twenty, issues the pull request closes beyond what GitHub listed — and what the
    // change did to this tool's own footing. Said in the notes; nothing withholds a verdict, as
    // there is none.
    notes.push(...readingBlockers(reading, resolved.sources));
    if (resolved.pullRequest?.issuesNotListed) notes.push(issuesNotListed(resolved.pullRequest.issuesNotListed));
    notes.push(...loaded.notes);
    if (loaded.changedInPullRequest) notes.push("The change edits .jev-intent-review.yml; the version before the change was used.");
    const prBodyOnly = onlyFromPullRequest(intent, resolved.sources);
    if (prBodyOnly) {
      const author = resolved.sources.find((s) => s.type === "pr_description")?.author;
      notes.push(`The requirements come only from the pull request's own description${author ? `, written by its author ${author}` : ""}.`);
    }
    // A path this tool must never read is not part of the change either: the pass over the changes
    // sends the lines as they were before, so a pull request that removes a hardcoded key would
    // hand it over. The change pass and the discoverer each refuse such a path on their own; this
    // keeps it out of the change from the start as well.
    const configured = pathFilter(config.repository.include, config.repository.ignore);
    const include = (path: string) => configured(path) && !isSensitivePath(path);
    const localOptions = { ...DEFAULT_LOCAL_CHECK, maxPrimaryChars: config.evidence.max_primary_chars };
    // What the change did to this tool's own footing, said whichever way the run ends after reading it.
    const footing = (changedPaths: readonly string[]) => {
      if (changedPaths.some((p) => p.startsWith(".github/workflows/"))) notes.push("The change edits a GitHub Actions workflow, which may run this tool differently.");
    };
    // A call worth checking is a candidate, not a verdict: only a repository that asks for it fails on one.
    const exitCodeFor = (requirements: LocalCheckResult[]) => (config.policy.fail_on.includes("finding") && requirements.some((r) => r.findings.length > 0) ? EXIT.finding : EXIT.ok);

    if (args["candidates-only"] || args["experimental-candidates-only"]) {
      // Before the credentials gate on purpose: this asks nothing, so it must not need an account
      // to run. The judge is a stub that throws — if the path ever reaches it, the run fails loudly
      // rather than quietly making the request this flag promises not to make.
      if (unreadable) stopUnread();
      const asksNothing = () => {
        throw new Error("--candidates-only reached a model");
      };
      // `askForm` is passed so the report can say the form was not asked here; the run asks nothing
      // when it builds the set only.
      const run = await runLocalCheck(git, revisions, intent.requirements, { model: "none", judge: asksNothing } as unknown as JudgmentProvider, include, { ...localOptions, candidatesOnly: true, askForm: !resolved.spec });
      footing(run.change.changedPaths);
      return output(report({ exitCode: EXIT.ok, intent, sources: resolved.sources, requirements: run.requirements, notes, prAuthor }));
    }

    if (!endpoint) {
      if (config.policy.missing_credentials === "fail") throw new ToolError(`no credentials for the judgments: set ${needed}`, EXIT.provider);
      // Skipped, not failed, even when nothing could be read: a fork's pull request has no
      // credentials and must not turn red for being written in prose. The report still says what
      // would have been checked and what was not read.
      //
      // Which of the three it was decides what a reader should do about it: add the keys, or leave
      // this pull request alone, since GitHub withholds them from another repository's and from
      // Dependabot's whatever the repository sets (ADR 0010).
      // The kind and the sentence come out of one table, so a change to one cannot leave the other
      // behind — which is the failure this whole distinction exists to prevent.
      const origin = eventOrigin(io.env);
      const skipKind = origin === "fork" || origin === "dependabot" ? origin : ("no_credentials" as const);
      const why: Record<typeof skipKind, string> = {
        fork: "This pull request comes from another repository, and GitHub gives such a run no secrets, so nothing was judged.",
        dependabot: "Dependabot's pull requests are given no secrets, so nothing was judged.",
        no_credentials: `No credentials for the judgments (${needed}) were available, so nothing was judged.`,
      };
      return output(report({ exitCode: EXIT.ok, skipReason: why[skipKind], skipKind, intent, sources: resolved.sources, notes, prAuthor }));
    }
    if (unreadable) stopUnread();
    const deadline = Date.now() + config.limits.max_seconds * 1000;
    const judges = deps.judges ? deps.judges(endpoint, config, deadline) : defaultJudges(endpoint, config, deadline, io.env, deps.fetch);

    // The calls first, then the changes. One provider for both; there is nothing else to send to.
    // A requirement read from text names no form, so Jev is asked which form its sentence says
    // (ADR 0008); a spec's requirements keep the spec's word and are not asked.
    const run = await runLocalCheck(git, revisions, intent.requirements, judges.provider, include, { ...localOptions, askForm: !resolved.spec });
    footing(run.change.changedPaths);
    trace(`changed files: ${run.change.changedPaths.length}`);
    for (const s of run.change.skipped) trace(`  skipped ${s.path}: ${s.reason}`);
    for (const r of run.requirements) trace(`${r.requirementId} -> ${r.findings.length} worth checking of ${r.counts.asked} read`);

    // The other direction: every change the pull request made, against the requirements it names.
    // Not with the pull request's own description, though: a requirement its author wrote after the
    // change could justify any line of it (ADR 0004). An issue the same person wrote still counts.
    const typeOf = new Map(resolved.sources.map((s) => [s.id, s.type]));
    const justifying = intent.requirements.filter((r) => r.sourceRefs.length === 0 || !r.sourceRefs.every((ref) => typeOf.get(ref.sourceId) === "pr_description"));
    let changes = { unexpected: [] as UnexpectedChange[], reached: 0, answered: 0, notes: [] as string[] };
    if (args["skip-change-check"]) notes.push("The changes were not checked against the requirements (--skip-change-check).");
    else if (justifying.length === 0) notes.push("The changes were not checked against the requirements: every requirement came from the pull request's own description, which cannot justify the change it describes.");
    else changes = await reviewChanges({ change: run.change, requirements: justifying, provider: judges.provider, maxChars: config.evidence.max_primary_chars, threshold: config.judgment.violation_probability, trace });
    notes.push(...changes.notes);
    trace(`changes no requirement asked for: ${changes.unexpected.length}`);
    // Reached the host and could not read one answer from it, over both passes: the host is wrong
    // or not answering, and a report of nothing settled would pass for a run that judged. The local
    // check stops on its own when it asked; this covers a run whose only questions were the changes'.
    // An answer to a form question is not a judgment and does not count here (ADR 0008).
    if (run.reached + changes.reached > 0 && run.answered + changes.answered === 0) {
      throw new ToolError(`no judgment came back from ${judges.origin}: ${run.reached + changes.reached} request(s) were sent and none was answered`, EXIT.provider);
    }

    const sent = judges.sent();
    return output(
      report({
        exitCode: exitCodeFor(run.requirements),
        intent,
        sources: resolved.sources,
        requirements: run.requirements,
        unexpectedChanges: changes.unexpected,
        sent: { requests: sent.requests, bytes: sent.bytes, answered: run.answered + run.form.answered + changes.answered, endpoint: judges.origin, host: endpoint.host },
        notes,
        prAuthor,
      }),
    );
  } catch (error) {
    if (error instanceof ToolError) {
      io.stderr(`jev-intent-review: ${flat(error.message)}\n`);
      return error.exitCode;
    }
    if (error instanceof ProviderError) {
      io.stderr(`jev-intent-review: the judgment provider failed: ${flat(error.message)}\n`);
      return EXIT.provider;
    }
    io.stderr(`jev-intent-review: unexpected error: ${flat(error instanceof Error ? (error.stack ?? error.message) : String(error))}\n`);
    return EXIT.incomplete;
  }
}

// Run when executed directly, including through a symbolic link (an npm bin), not when imported.
function isEntryPoint(): boolean {
  const script = process.argv[1];
  if (script === undefined) return false;
  try {
    return realpathSync(script) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isEntryPoint()) {
  main(process.argv.slice(2), {
    stdout: (text) => process.stdout.write(text),
    stderr: (text) => process.stderr.write(text),
    cwd: process.cwd(),
    env: process.env,
  }).then((code) => {
    process.exitCode = code;
  });
}
