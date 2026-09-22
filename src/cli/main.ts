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
import { intentSection, renderJson, renderMarkdown } from "../report/markdown.ts";
import { Git } from "../repository/git.ts";
import { resolveRevisions, type Revisions } from "../repository/revisions.ts";
import { DEFAULT_LOCAL_CHECK, renderLocalCheck, runLocalCheck } from "../review/local-check-run.ts";
import { pathFilter } from "../config/glob.ts";
import { runReview } from "../review/run.ts";
import { EXIT, ToolError, type IntentSource, type IntentSpec, type ReviewReport } from "../types.ts";
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

Experimental:
  --experimental-local-check
                        the v0.1 path. For each requirement, take the Rust functions the
                        change touched and their callers one hop out, and ask Jev two
                        things about each call, as the requirement's "form" says. The
                        default, failure_propagation: whether the requirement requires
                        that a failure of the call not reach the caller as a success,
                        and what the function returns when it does. The other,
                        check_before_action (set "form" in --intent-spec): whether the
                        requirement requires a check to pass before the call, and whether
                        the function still makes the call when the check does not pass.
                        One rule reads each call as holding, worth checking, not settled,
                        or not required of. A call worth checking is listed with the
                        requirement's words, the code, the assumption and both answers.
                        Requirements come from --intent-spec or, as written, from the
                        issue and pull request as under Intent below; no file, function
                        or expected answer is named on the command line. No requirement
                        verdict is stated. Findings do not cause a nonzero exit code;
                        configuration, intent, repository and provider failures can.
                        Nothing listed means no call met the conditions -- including
                        calls left undetermined -- and exit 0 does not establish that the
                        requirement holds.
  --experimental-candidates-only
                        with the above: build the set and stop. Prints which calls fit the
                        budget and which do not, with a reason each, and asks nothing --
                        no credentials needed.

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

Exit codes: 0 no confident violation, 1 violation, 2 analysis incomplete,
10 configuration error, 11 intent could not be resolved, 12 judgment provider failed
(including an endpoint that answered no judgment at all), 13 repository could not be read.
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

function defaultJudges(endpoint: Endpoint, config: Config, deadline: number, fetch?: typeof globalThis.fetch) {
  const client = new JevClient(endpoint, { deadline, maxRequests: config.limits.max_requests, maxBytes: config.limits.max_sent_bytes, ...(fetch ? { fetch } : {}) });
  return {
    provider: new LimitedProvider(new JevProvider(client), { concurrency: 8, deadline }),
    sent: () => ({ ...client.sent }),
    origin: client.origin,
  };
}

async function defaultGithub(env: NodeJS.ProcessEnv): Promise<GitHub> {
  const token = await githubToken(env);
  return new GitHub({ ...(token ? { token } : {}), ...(env.GITHUB_API_URL ? { apiUrl: env.GITHUB_API_URL } : {}), ...(env.GITHUB_GRAPHQL_URL ? { graphqlUrl: env.GITHUB_GRAPHQL_URL } : {}) });
}

/** The pull request number of the pull_request event this workflow runs for, if any. */
function eventPullRequest(env: NodeJS.ProcessEnv): number | undefined {
  if (env.GITHUB_EVENT_NAME !== "pull_request" || !env.GITHUB_EVENT_PATH) return undefined;
  try {
    const number = (JSON.parse(readFileSync(env.GITHUB_EVENT_PATH, "utf8")) as { pull_request?: { number?: unknown } }).pull_request?.number;
    return typeof number === "number" ? number : undefined;
  } catch {
    return undefined;
  }
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

function skippedReport(
  reason: string,
  revisions: Revisions,
  repository: string,
  configSource: string,
  sources: IntentSource[],
  model: string,
  read: { intent?: IntentSpec; notes: string[]; prAuthor?: string | undefined },
): ReviewReport {
  const intent = read.intent ?? NO_INTENT;
  return {
    version: 1,
    tool: { name: "jev-intent-review", version: VERSION },
    verdict: "skipped",
    exitCode: EXIT.ok,
    skipReason: reason,
    // What would have been checked, and what could not be read: a skipped run still says both.
    intent,
    sources: sources.map(({ text: _text, ...source }) => source),
    requirements: [],
    unexpectedChanges: [],
    discovery: { candidateCount: 0, changedCandidates: 0, unchangedCandidates: 0, incompleteReasons: [], searches: [] },
    sent: { requests: 0, bytes: 0, locations: [] },
    metadata: { repository, base: revisions.before, head: revisions.after, model, questionsHash: QUESTIONS_HASH, configSource, notes: read.notes, ...(read.prAuthor ? { pullRequestAuthor: read.prAuthor } : {}) },
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
    const stop = (headline: string, intent: IntentSpec, sources: Omit<IntentSource, "text">[], message: string): never => {
      io.stdout(
        args.json
          ? `${JSON.stringify({ revisions, sources, intent, notes }, null, 2)}\n`
          : `${["# jev-intent-review", "", `**Result: nothing was checked.** ${headline}`, "", ...intentSection(intent, sources, { prAuthor, notes })].join("\n")}\n`,
      );
      throw new ToolError(message, EXIT.intent);
    };
    if (resolved.sources.length === 0) {
      const none = "nothing was read from an issue, the pull request's description or --intent";
      if (config.policy.no_intent === "fail") stop("No statement of intent was found.", NO_INTENT, [], `no intent was found: ${none}${notes.length > 0 ? ` (${notes.join(" ")})` : ""}`);
      return output(skippedReport(`No statement of intent was found: ${none}.`, revisions, repository, loaded.source, [], model, { notes, prAuthor }));
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
        shownSources,
        `${unreadable}: ${howToWrite}`,
      );
    const localCheckOutput = (results: unknown[]) =>
      io.stdout(
        args.json
          ? `${JSON.stringify({ revisions, sources: shownSources, intent, notes, requirements: results }, null, 2)}\n`
          : `${renderLocalCheck(results as Parameters<typeof renderLocalCheck>[0], { intent, sources: shownSources, notes, ...(prAuthor ? { prAuthor } : {}) })}\n`,
      );

    if (args["experimental-candidates-only"]) {
      // Before the credentials gate on purpose: this asks nothing, so it must not need an account
      // to run. The planner and the judge are stubs that throw — if the path ever reaches one, the
      // run fails loudly rather than quietly making the request this flag promises not to make.
      if (!args["experimental-local-check"]) throw new ToolError("--experimental-candidates-only only applies with --experimental-local-check", EXIT.config);
      if (unreadable) stopUnread();
      const asksNothing = () => {
        throw new Error("--experimental-candidates-only reached a model");
      };
      const results = await runLocalCheck(
        git,
        revisions,
        intent.requirements,
        { model: "none", judge: asksNothing } as unknown as JudgmentProvider,
        pathFilter(config.repository.include, config.repository.ignore),
        { ...DEFAULT_LOCAL_CHECK, candidatesOnly: true },
      );
      localCheckOutput(results);
      return EXIT.ok;
    }

    if (!endpoint) {
      if (config.policy.missing_credentials === "fail") throw new ToolError(`no credentials for the judgments: set ${needed}`, EXIT.provider);
      // Skipped, not failed, even when nothing could be read: a fork's pull request has no
      // credentials and must not turn red for being written in prose. The report still says what
      // would have been checked and what was not read.
      return output(skippedReport(`No credentials for the judgments (${needed}) were available, so nothing was judged.`, revisions, repository, loaded.source, resolved.sources, model, { intent, notes, prAuthor }));
    }
    if (unreadable) stopUnread();
    const deadline = Date.now() + config.limits.max_seconds * 1000;
    const judges = deps.judges ? deps.judges(endpoint, config, deadline) : defaultJudges(endpoint, config, deadline, deps.fetch);

    if (args["experimental-local-check"]) {
      // The experimental path (docs/local-check-cli.md): from each requirement to observations
      // about particular calls. It reports observations and what it did not check, never a
      // violation, and it does not go through `runReview`.
      const include = pathFilter(config.repository.include, config.repository.ignore);
      // One provider, two questions. Both go to Jev; there is nothing else to send to.
      // `--experimental-candidates-only` returned above, before the credentials gate.
      localCheckOutput(await runLocalCheck(git, revisions, intent.requirements, judges.provider, include, DEFAULT_LOCAL_CHECK));
      return EXIT.ok;
    }

    // Intent this run did not check against, which no verdict can overcome (ADR 0004): a source as
    // high as anything read and itself unread, requirements past the first twenty, and issues the
    // pull request closes beyond what GitHub listed.
    const intentBlockers = [...readingBlockers(reading, resolved.sources), ...(resolved.pullRequest?.issuesNotListed ? [issuesNotListed(resolved.pullRequest.issuesNotListed)] : [])];
    const report = await runReview({
      git,
      revisions,
      loaded,
      intent,
      sources: resolved.sources,
      prBodyOnly: onlyFromPullRequest(intent, resolved.sources),
      provider: judges.provider,
      sent: judges.sent,
      repository,
      trace,
      notes,
      endpoint: judges.origin,
      host: endpoint.host,
      intentBlockers,
      ...(prAuthor ? { pullRequestAuthor: prAuthor } : {}),
    });
    return output(report);
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
