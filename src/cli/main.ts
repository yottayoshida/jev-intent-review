#!/usr/bin/env node
// Command line entry. Exit codes are spec §26 (see EXIT in types.ts).

import { realpathSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { analyzeChange, type ChangeAnalysis } from "../change/seeds.ts";
import { loadConfig } from "../config/config.ts";
import { pathFilter } from "../config/glob.ts";
import { parseIntentSpec } from "../intent/schema.ts";
import { JEV_MODEL } from "../judgments/jev.ts";
import { QUESTIONS_HASH } from "../judgments/questions.ts";
import { renderJson, renderMarkdown } from "../report/markdown.ts";
import { Git } from "../repository/git.ts";
import { resolveRevisions } from "../repository/revisions.ts";
import { EXIT, ToolError, type IntentSpec, type ReviewReport } from "../types.ts";
import { VERSION } from "../version.ts";

const HELP = `Usage: jev-intent-review [options]

Checks the repository after a change against the intent behind it, including code the change
did not touch.

Options:
  --base <rev>          the branch or commit the change starts from
                        (in a GitHub pull_request workflow: the merge commit's first parent)
  --head <rev>          the commit after the change (default: HEAD)
  --intent-spec <file>  the requirements, as an IntentSpec JSON file
  --json                print the report as JSON instead of Markdown
  --trace               print what was analysed to stderr
  -h, --help            show this help
  --version             show the version

Exit codes: 0 no confident violation, 1 violation, 2 analysis incomplete,
10 configuration error, 11 intent could not be resolved, 12 judgment provider failed,
13 repository could not be read.
`;

export interface Io {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  cwd: string;
  env: NodeJS.ProcessEnv;
}

function parse(argv: string[]) {
  try {
    return parseArgs({
      args: argv,
      strict: true,
      allowPositionals: false,
      options: {
        base: { type: "string" },
        head: { type: "string" },
        "intent-spec": { type: "string" },
        json: { type: "boolean", default: false },
        trace: { type: "boolean", default: false },
        help: { type: "boolean", short: "h", default: false },
        version: { type: "boolean", default: false },
      },
    }).values;
  } catch (error) {
    throw new ToolError(`${error instanceof Error ? error.message : String(error)} (see --help)`, EXIT.config);
  }
}

function traceChange(trace: (line: string) => void, change: ChangeAnalysis): void {
  trace(`changed files: ${change.changedPaths.length}`);
  for (const s of change.skipped) trace(`  skipped ${s.path}: ${s.reason}`);
  for (const r of change.regions) {
    trace(`region ${r.path}:${r.block.startLine}-${r.block.endLine}${r.block.name ? ` ${r.block.name}` : ""}${r.block.windowed ? " (window)" : ""}, changed lines ${r.changedLines.join(",")}`);
  }
  const around = change.calledSymbols.filter((s) => !s.onChangedLine).map((s) => s.name);
  const on = change.calledSymbols.filter((s) => s.onChangedLine).map((s) => s.name);
  trace(`calls around the changed lines: ${around.join(", ") || "(none)"}`);
  trace(`calls on the changed lines: ${on.join(", ") || "(none)"}`);
  trace(`symbols defined by changed blocks: ${change.definedSymbols.join(", ") || "(none)"}`);
  trace(`identifiers on changed lines: ${change.changedIdentifiers.join(", ") || "(none)"}`);
}

export async function main(argv: string[], io: Io): Promise<number> {
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
    const trace = args.trace ? (line: string) => io.stderr(`[trace] ${line}\n`) : () => {};

    let intent: IntentSpec;
    const specPath = args["intent-spec"];
    if (specPath === undefined) throw new ToolError("no intent given: pass --intent-spec <file>", EXIT.intent);
    try {
      intent = parseIntentSpec(await readFile(specPath, "utf8"), specPath);
    } catch (error) {
      if (error instanceof ToolError) throw error;
      throw new ToolError(`cannot read ${specPath}: ${error instanceof Error ? error.message : String(error)}`, EXIT.intent);
    }
    if (intent.requirements.length === 0) throw new ToolError(`${specPath} has no requirements`, EXIT.intent);

    const git = await Git.open(io.cwd);
    const revisions = await resolveRevisions(git, { ...(args.base !== undefined ? { base: args.base } : {}), ...(args.head !== undefined ? { head: args.head } : {}), env: io.env });
    trace(`before ${revisions.before}, after ${revisions.after} (${revisions.how})`);
    const loaded = await loadConfig(git, revisions.before, revisions.after);
    trace(`config: ${loaded.source}${loaded.changedInPullRequest ? " (the change edits the config file; the version before it applies)" : ""}`);

    const change = await analyzeChange(git, revisions.before, revisions.after, pathFilter(loaded.config.repository.include, loaded.config.repository.ignore));
    traceChange(trace, change);

    const notes: string[] = [];
    if (loaded.changedInPullRequest) notes.push("The change edits .jev-intent-review.yml; the version before the change was used.");
    const report: ReviewReport = {
      version: 1,
      tool: { name: "jev-intent-review", version: VERSION },
      verdict: "incomplete",
      exitCode: EXIT.incomplete,
      intent,
      sources: [{ id: `file:${specPath}`, type: "spec", authority: 100 }],
      requirements: intent.requirements.map((r) => ({
        requirementId: r.id,
        status: "unknown",
        coverage: "none",
        candidates: [],
        notes: ["Requirement verification is not implemented in this build yet."],
      })),
      unexpectedChanges: [],
      discovery: { candidateCount: 0, changedCandidates: 0, unchangedCandidates: 0, incompleteReasons: ["discovery is not implemented in this build yet"], searches: [] },
      sent: { requests: 0, bytes: 0, locations: [] },
      metadata: {
        repository: io.env.GITHUB_REPOSITORY ?? git.dir,
        base: revisions.before,
        head: revisions.after,
        model: JEV_MODEL,
        questionsHash: QUESTIONS_HASH,
        configSource: loaded.source,
        notes,
      },
    };
    io.stdout(args.json ? renderJson(report) : renderMarkdown(report));
    return report.exitCode;
  } catch (error) {
    if (error instanceof ToolError) {
      io.stderr(`jev-intent-review: ${error.message}\n`);
      return error.exitCode;
    }
    io.stderr(`jev-intent-review: unexpected error: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
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
