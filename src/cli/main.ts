#!/usr/bin/env node
// Command line entry. Exit codes are spec §26 (see EXIT in types.ts).

import { readFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { loadConfig, type Config } from "../config/config.ts";
import { compileChecklist, WorkersAiCompiler, type IntentCompiler } from "../intent/compiler.ts";
import { GitHub, githubToken, parseRepository, type PullRequest } from "../intent/github.ts";
import { resolveIntent } from "../intent/resolver.ts";
import { CloudflareClient, endpointFromEnv, EndpointError, ProviderError, type Endpoint } from "../judgments/cloudflare.ts";
import { JevProvider, JEV_MODEL } from "../judgments/jev.ts";
import { LimitedProvider, type JudgmentProvider } from "../judgments/provider.ts";
import { QUESTIONS_HASH } from "../judgments/questions.ts";
import { renderJson, renderMarkdown } from "../report/markdown.ts";
import { Git } from "../repository/git.ts";
import { resolveRevisions, type Revisions } from "../repository/revisions.ts";
import { modelPlanner } from "../plan/planner.ts";
import { modelMapper, type Mapper } from "../plan/mapping.ts";
import type { Planner } from "../review/local-check-run.ts";
import { DEFAULT_LOCAL_CHECK, renderLocalCheck, runLocalCheck } from "../review/local-check-run.ts";
import { pathFilter } from "../config/glob.ts";
import { runReview } from "../review/run.ts";
import { EXIT, ToolError, type IntentSource, type ReviewReport } from "../types.ts";
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
                        instead of the usual report, ask about particular calls: start from
                        the functions the change touched and the functions that call them,
                        add the calls the requirement's own words lead the planner to, and
                        observe what each function returns when one of its calls fails.
                        Where a requirement is read as governing such a call and the
                        reading contradicts it, the call is listed as worth checking, with
                        the words, the code, the condition and the reading. Never a
                        requirement verdict, and never a failing exit code.
                        Nothing about a target is given on the command line.
  --experimental-candidates-only
                        with the above: build the set and stop. Prints which calls are
                        reachable and which fit the budget, and asks no model at all.

Output:
  --json                print the report as JSON instead of Markdown
  --trace               print searches, candidates and answers to stderr
  -h, --help            show this help
  --version             show the version

Environment: CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN for judgments on Cloudflare
Workers AI, or JEV_API_URL and JEV_API_TOKEN for any other endpoint that runs this tool's
models from a Workers AI run request; GITHUB_TOKEN or GH_TOKEN (or a logged-in gh) for
--pr and --issue.

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
  judges?: (endpoint: Endpoint, config: Config, deadline: number) => { provider: JudgmentProvider; compiler: IntentCompiler; sent: () => { requests: number; bytes: number }; origin: string; planner?: Planner; mapper?: Mapper };
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

function defaultJudges(endpoint: Endpoint, config: Config, deadline: number) {
  const client = new CloudflareClient(endpoint, { deadline, maxRequests: config.limits.max_requests, maxBytes: config.limits.max_sent_bytes });
  return {
    provider: new LimitedProvider(new JevProvider(client), { concurrency: 8, deadline }),
    compiler: new WorkersAiCompiler(client),
    planner: modelPlanner(client),
    mapper: modelMapper(client),
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

function skippedReport(reason: string, revisions: Revisions, repository: string, configSource: string, sources: IntentSource[]): ReviewReport {
  return {
    version: 1,
    tool: { name: "jev-intent-review", version: VERSION },
    verdict: "skipped",
    exitCode: EXIT.ok,
    skipReason: reason,
    intent: { version: 1, title: "", summary: "", requirements: [], nonGoals: [], ambiguities: [] },
    sources: sources.map(({ text: _text, ...source }) => source),
    requirements: [],
    unexpectedChanges: [],
    discovery: { candidateCount: 0, changedCandidates: 0, unchangedCandidates: 0, incompleteReasons: [], searches: [] },
    sent: { requests: 0, bytes: 0, locations: [] },
    metadata: { repository, base: revisions.before, head: revisions.after, model: JEV_MODEL, questionsHash: QUESTIONS_HASH, configSource, notes: [] },
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
    if (endpoint) trace(`judgments go to ${new URL(endpoint.url).origin} (from ${endpoint.source})`);

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
    if (resolved.sources.length === 0) {
      if (config.policy.no_intent === "fail") throw new ToolError("no intent was found: the pull request links no issue and has no description, and no --intent was given", EXIT.intent);
      return output(skippedReport("No statement of intent was found (no linked issue, no pull request description, no --intent).", revisions, repository, loaded.source, []));
    }

    if (args["experimental-candidates-only"]) {
      // Before the credentials gate on purpose: this asks nothing, so it must not need an account
      // to run. The planner and the judge are stubs that throw — if the path ever reaches one, the
      // run fails loudly rather than quietly making the request this flag promises not to make.
      if (!args["experimental-local-check"]) throw new ToolError("--experimental-candidates-only only applies with --experimental-local-check", EXIT.config);
      if (!resolved.spec) throw new ToolError("--experimental-candidates-only asks no model, so the requirements have to come from --intent-spec", EXIT.intent);
      const asksNothing = () => {
        throw new Error("--experimental-candidates-only reached a model");
      };
      const results = await runLocalCheck(
        git,
        revisions,
        resolved.spec.requirements,
        { pick: asksNothing } as unknown as Planner,
        { map: asksNothing } as unknown as Mapper,
        { model: "none", judge: asksNothing } as unknown as JudgmentProvider,
        pathFilter(config.repository.include, config.repository.ignore),
        { ...DEFAULT_LOCAL_CHECK, candidatesOnly: true },
      );
      io.stdout(args.json ? `${JSON.stringify({ revisions, requirements: results }, null, 2)}\n` : `${renderLocalCheck(results)}\n`);
      return EXIT.ok;
    }

    if (!endpoint) {
      if (config.policy.missing_credentials === "fail") throw new ToolError("no credentials for the judgments: set CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN, or JEV_API_URL and JEV_API_TOKEN", EXIT.provider);
      return output(skippedReport("No credentials for the judgments (CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN, or JEV_API_URL and JEV_API_TOKEN) were available, so nothing was judged.", revisions, repository, loaded.source, resolved.sources));
    }
    const deadline = Date.now() + config.limits.max_seconds * 1000;
    const judges = (deps.judges ?? defaultJudges)(endpoint, config, deadline);

    const intent = resolved.spec ?? compileChecklist(resolved.sources) ?? (await judges.compiler.compile(resolved.sources));
    if (intent.requirements.length === 0) throw new ToolError("the intent holds no requirement to check", EXIT.intent);
    for (const r of intent.requirements) trace(`${r.id}: ${r.text}`);

    if (args["experimental-local-check"]) {
      // The experimental path (docs/local-check-cli.md): from each requirement to observations
      // about particular calls. It reports observations and what it did not check, never a
      // violation, and it does not go through `runReview`.
      const include = pathFilter(config.repository.include, config.repository.ignore);
      // The planner and the mapper are the same model doing two different jobs, so they share one
      // client and one budget: choosing where to look, and saying whether the requirement governs
      // what was found. The judgment provider is separate and is never asked either question.
      const client = judges.planner && judges.mapper ? null : new CloudflareClient(endpoint, { deadline });
      const planner = judges.planner ?? modelPlanner(client!);
      const mapper = judges.mapper ?? modelMapper(client!);
      // `--experimental-candidates-only` returned above, before the credentials gate, so there is
      // nothing to pass through here.
      const results = await runLocalCheck(git, revisions, intent.requirements, planner, mapper, judges.provider, include, DEFAULT_LOCAL_CHECK);
      io.stdout(args.json ? `${JSON.stringify({ revisions, requirements: results }, null, 2)}\n` : `${renderLocalCheck(results)}\n`);
      return EXIT.ok;
    }

    const report = await runReview({ git, revisions, loaded, intent, sources: resolved.sources, prBodyOnly: resolved.prBodyOnly, provider: judges.provider, sent: judges.sent, repository, trace, notes: resolved.notes, endpoint: judges.origin });
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
