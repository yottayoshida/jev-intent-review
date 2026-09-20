// Reading intent from GitHub: a pull request, the issues it closes, or one issue. With a token the
// linked issues come from GraphQL (`closingIssuesReferences`, which also covers issues linked by
// hand); without one, from the closing keywords in the pull request's text over the public REST API.

import { execFile } from "node:child_process";
import { EXIT, ToolError } from "../types.ts";

export interface Issue {
  number: number;
  title: string;
  body: string;
  author?: string;
  url: string;
}

export interface PullRequest extends Issue {
  baseRefName: string;
  /** The base branch as it was when the pull request was opened, which is what it changed. */
  baseSha: string;
  headSha: string;
  issues: Issue[];
  missingIssues?: number[]; // named with a closing keyword but not found
}

/** A 404: callers decide whether a missing thing ends the run. */
export class NotFound extends ToolError {
  constructor(message: string) {
    super(message, EXIT.intent);
    this.name = "NotFound";
  }
}

export interface GitHubOptions {
  token?: string;
  apiUrl?: string;
  graphqlUrl?: string;
  fetch?: typeof fetch;
}

/** GITHUB_TOKEN or GH_TOKEN, else what `gh auth token` prints, else nothing. */
export async function githubToken(env: NodeJS.ProcessEnv): Promise<string | undefined> {
  const fromEnv = env.GITHUB_TOKEN?.trim() || env.GH_TOKEN?.trim();
  if (fromEnv) return fromEnv;
  return new Promise((resolve) => {
    execFile("gh", ["auth", "token"], { timeout: 5000 }, (error, stdout) => resolve(error ? undefined : String(stdout).trim() || undefined));
  });
}

/** `owner/name` from --repo, GITHUB_REPOSITORY, or the origin remote's URL. */
export function parseRepository(value: string): { owner: string; name: string } | null {
  const match = /^(?:https?:\/\/[^/]+\/|git@[^:]+:|ssh:\/\/git@[^/]+\/)?([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/.exec(value.trim());
  return match ? { owner: match[1] as string, name: match[2] as string } : null;
}

const CLOSING = /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s*:?\s+(?:([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+))?#(\d+)\b/gi;

/** Issue numbers in this repository that `text` closes with a keyword (`Fixes #12`). */
export function closedIssueNumbers(text: string, repo: { owner: string; name: string }): number[] {
  const numbers = new Set<number>();
  for (const match of text.matchAll(CLOSING)) {
    const [, owner, name, number] = match;
    if (owner && (owner.toLowerCase() !== repo.owner.toLowerCase() || name?.toLowerCase() !== repo.name.toLowerCase())) continue;
    numbers.add(Number(number));
  }
  return [...numbers].sort((a, b) => a - b);
}

export class GitHub {
  readonly #token: string | undefined;
  readonly #api: string;
  readonly #graphql: string;
  readonly #fetch: typeof fetch;
  readonly #pulls = new Map<string, Promise<PullRequest>>();

  constructor(options: GitHubOptions = {}) {
    this.#token = options.token;
    this.#api = (options.apiUrl ?? "https://api.github.com").replace(/\/$/, "");
    this.#graphql = options.graphqlUrl ?? `${this.#api}/graphql`;
    this.#fetch = options.fetch ?? fetch;
  }

  async #request(url: string, init: RequestInit = {}): Promise<unknown> {
    const headers: Record<string, string> = { Accept: "application/vnd.github+json", "User-Agent": "jev-intent-review", ...(init.headers as Record<string, string>) };
    if (this.#token) headers.Authorization = `Bearer ${this.#token}`;
    let response: Response | undefined;
    let text = "";
    // One retry for a server error or a dropped connection; a 4xx is an answer, not a hiccup.
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        response = await this.#fetch(url, { ...init, headers, signal: AbortSignal.timeout(20_000) });
        text = await response.text();
        if (response.status < 500) break;
      } catch (error) {
        if (attempt === 1) throw new ToolError(`GitHub request failed: ${error instanceof Error ? error.message : String(error)}`, EXIT.intent);
      }
      if (attempt === 0) await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    if (!response) throw new ToolError("GitHub request failed", EXIT.intent);
    if (response.status === 404) throw new NotFound(`GitHub has nothing at ${url.replace(this.#api, "")}`);
    if (!response.ok) throw new ToolError(`GitHub ${response.status} for ${url.replace(this.#api, "")}: ${text.slice(0, 160)}`, EXIT.intent);
    try {
      return JSON.parse(text);
    } catch {
      throw new ToolError(`GitHub returned something other than JSON for ${url.replace(this.#api, "")}`, EXIT.intent);
    }
  }

  async issue(repo: { owner: string; name: string }, number: number): Promise<Issue> {
    const data = (await this.#request(`${this.#api}/repos/${repo.owner}/${repo.name}/issues/${number}`)) as Record<string, unknown>;
    // The issues endpoint also answers for pull requests; a pull request's text is not an issue's.
    if (data.pull_request) throw new NotFound(`#${number} in ${repo.owner}/${repo.name} is a pull request, not an issue`);
    return toIssue(data);
  }

  /** Asked once per run and cached: the command line needs the base branch before the intent. */
  pullRequest(repo: { owner: string; name: string }, number: number): Promise<PullRequest> {
    const key = `${repo.owner}/${repo.name}#${number}`;
    let pr = this.#pulls.get(key);
    if (!pr) {
      pr = this.#fetchPullRequest(repo, number);
      this.#pulls.set(key, pr);
    }
    return pr;
  }

  async #fetchPullRequest(repo: { owner: string; name: string }, number: number): Promise<PullRequest> {
    if (this.#token) {
      const query = `query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){pullRequest(number:$number){number title body url author{login} baseRefName baseRefOid headRefOid closingIssuesReferences(first:10){nodes{number title body url author{login}}}}}}`;
      const data = (await this.#request(this.#graphql, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query, variables: { owner: repo.owner, name: repo.name, number } }),
      })) as { data?: { repository?: { pullRequest?: Record<string, unknown> | null } | null }; errors?: { message?: string }[] };
      const pr = data.data?.repository?.pullRequest;
      if (!pr) throw new ToolError(`GitHub has no pull request #${number} in ${repo.owner}/${repo.name}${data.errors?.[0]?.message ? ` (${data.errors[0].message})` : ""}`, EXIT.intent);
      const nodes = ((pr.closingIssuesReferences as { nodes?: Record<string, unknown>[] } | undefined)?.nodes ?? []).map(toIssue);
      return { ...toIssue(pr), baseRefName: String(pr.baseRefName ?? ""), baseSha: String(pr.baseRefOid ?? ""), headSha: String(pr.headRefOid ?? ""), issues: nodes };
    }
    const pr = (await this.#request(`${this.#api}/repos/${repo.owner}/${repo.name}/pulls/${number}`)) as Record<string, unknown>;
    const base = pr.base as { ref?: string; sha?: string } | undefined;
    const head = pr.head as { sha?: string } | undefined;
    const issues: Issue[] = [];
    const missing: number[] = [];
    for (const n of closedIssueNumbers(`${String(pr.title ?? "")}\n${String(pr.body ?? "")}`, repo)) {
      try {
        issues.push(await this.issue(repo, n));
      } catch (error) {
        // "Fixes #12" pointing at nothing (or at a pull request) is a typo in the text, not a reason to stop.
        if (error instanceof NotFound) missing.push(n);
        else throw error;
      }
    }
    return { ...toIssue(pr), baseRefName: base?.ref ?? "", baseSha: base?.sha ?? "", headSha: head?.sha ?? "", issues, ...(missing.length ? { missingIssues: missing } : {}) };
  }
}

function toIssue(data: Record<string, unknown>): Issue {
  const author = (data.author ?? data.user) as { login?: string } | null | undefined;
  return {
    number: Number(data.number),
    title: String(data.title ?? ""),
    body: String(data.body ?? ""),
    ...(author?.login ? { author: author.login } : {}),
    url: String(data.html_url ?? data.url ?? ""), // REST's `url` is the API address; GraphQL's is the page
  };
}
