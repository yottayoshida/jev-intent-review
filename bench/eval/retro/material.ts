// What existed when the original pull request merged, and nothing after (#89, bench/eval/RETRO.md).
//
// The annotator who writes the retrospective requirement is given this bundle and nothing else. Every
// text is taken as it stood at the merge: a body edited later is read back from its edit history, a title
// renamed later is renamed back, and a comment, a review, or a link to an issue made later is left out.
// A text whose version at the merge cannot be recovered is not guessed: it is named in `unavailable`,
// and the case counts as one whose requirement could not be written.

import { execFileSync } from "node:child_process";
import { PIPED } from "./gh.ts";

/** One version of a text, as GitHub's `userContentEdits` returns it: the whole text at `editedAt`. */
export interface Edit {
  editedAt: string | null;
  deletedAt: string | null;
  diff: string | null;
}

/** A text as GitHub has it now, with what is needed to read it back. */
export interface Text {
  /**
   * When others could first read it: a review's `submittedAt`, a comment's `publishedAt`. A review
   * begun before the merge and submitted after it was not there at the merge (measured on
   * rust-lang/cargo#15000: a review created 16:31:15, submitted 16:31:37). `null` for one never published.
   */
  createdAt: string | null;
  body: string;
  lastEditedAt: string | null;
  edits: Edit[];
}

export interface Rename {
  createdAt: string;
  previousTitle: string;
  currentTitle: string;
}

export interface RawItem {
  number: number;
  title: string;
  renames: Rename[];
  text: Text;
  comments: Text[];
}

export interface RawPull extends RawItem {
  repo: string;
  mergedAt: string;
  reviews: (Text & { state: string })[];
  reviewComments: Text[];
  /** Issues connected to the pull request, with when the connection was made. */
  connected: { number: number; at: string }[];
}

export interface Bundle {
  repo: string;
  pull: { number: number; title: string; body: string; comments: string[]; reviews: string[] };
  issues: { number: number; title: string; body: string; comments: string[] }[];
  /** Where a text could not be read back to its version at the merge. */
  unavailable: string[];
}

/** The fields an annotator is shown. A test holds the bundle to exactly these. */
export const BUNDLE_FIELDS = ["repo", "pull", "issues", "unavailable"] as const;

const before = (at: string | null, cutoff: string) => at !== null && at <= cutoff;

/**
 * The text as it stood at `cutoff`, or `null` when that version cannot be recovered. A text never
 * edited after the cutoff is read as it is; otherwise the latest version from the edit history at or
 * before the cutoff. A text with no history but edited after the cutoff has no recoverable version,
 * and neither has one whose version at the cutoff was deleted from the history: an older version is
 * not what stood at the cutoff.
 */
export function textAt(t: Text, cutoff: string): string | null {
  if (t.lastEditedAt === null || t.lastEditedAt <= cutoff) return t.body;
  const latest = t.edits.filter((e) => before(e.editedAt, cutoff)).sort((a, b) => (a.editedAt! < b.editedAt! ? 1 : -1))[0];
  return latest === undefined || latest.deletedAt !== null || latest.diff === null ? null : latest.diff;
}

/** The title at `cutoff`: renames after it undone, the earliest of them first. */
export function titleAt(item: Pick<RawItem, "title" | "renames">, cutoff: string): string {
  const later = item.renames.filter((r) => r.createdAt > cutoff).sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1));
  return later.length > 0 ? later[0]!.previousTitle : item.title;
}

/** Texts created at or before the cutoff, each as it stood then; the unrecoverable ones are named. */
function textsAt(texts: readonly Text[], cutoff: string, what: string, unavailable: string[]): string[] {
  const out: string[] = [];
  texts.forEach((t, i) => {
    if (t.createdAt === null || t.createdAt > cutoff) return;
    const v = textAt(t, cutoff);
    if (v === null) unavailable.push(`${what} ${i + 1}`);
    else out.push(v);
  });
  return out;
}

/** The bundle of the original pull request at its merge. */
export function bundleAt(pull: RawPull, issues: readonly RawItem[]): Bundle {
  const cutoff = pull.mergedAt;
  const unavailable: string[] = [];
  const body = textAt(pull.text, cutoff);
  if (body === null) unavailable.push(`#${pull.number} body`);
  const wanted = new Set(pull.connected.filter((c) => c.at <= cutoff).map((c) => c.number));
  return {
    repo: pull.repo,
    pull: {
      number: pull.number,
      title: titleAt(pull, cutoff),
      body: body ?? "",
      comments: textsAt(pull.comments, cutoff, `#${pull.number} comment`, unavailable),
      reviews: [...textsAt(pull.reviews, cutoff, `#${pull.number} review`, unavailable), ...textsAt(pull.reviewComments, cutoff, `#${pull.number} review comment`, unavailable)].filter((t) => t.trim() !== ""),
    },
    issues: issues
      .filter((i) => wanted.has(i.number) && i.text.createdAt !== null && i.text.createdAt <= cutoff)
      .map((i) => {
        const b = textAt(i.text, cutoff);
        if (b === null) unavailable.push(`#${i.number} body`);
        return { number: i.number, title: titleAt(i, cutoff), body: b ?? "", comments: textsAt(i.comments, cutoff, `#${i.number} comment`, unavailable) };
      }),
    unavailable,
  };
}

// ---- Fetching ----------------------------------------------------------------------------------

// GitHub refuses a query that could return more than 500,000 nodes, so the nested lists are capped.
// A list cut by its cap is never taken for the whole: `totalCount` is asked with each, and a cut list
// is named in `unavailable` (the case then counts as one whose material is not complete). Edits come
// newest first, so a cut history still gives the right version when one at or before the merge is in it.
const edits = (n: number) => `lastEditedAt createdAt body userContentEdits(first:${n}){totalCount nodes{editedAt deletedAt diff}}`;
const texts = (n: number) => `totalCount nodes{publishedAt ${edits(n)}}`;

const PULL_QUERY = `query($owner:String!,$name:String!,$n:Int!){repository(owner:$owner,name:$name){pullRequest(number:$n){
  number title mergedAt ${edits(50)}
  comments(first:100){${texts(20)}}
  reviews(first:50){totalCount nodes{state submittedAt ${edits(20)} comments(first:50){${texts(10)}}}}
  timelineItems(first:100,itemTypes:[RENAMED_TITLE_EVENT,CONNECTED_EVENT]){filteredCount nodes{__typename
    ... on RenamedTitleEvent{createdAt previousTitle currentTitle}
    ... on ConnectedEvent{createdAt subject{... on Issue{number}}}}}}}}`;

const ISSUE_QUERY = `query($owner:String!,$name:String!,$n:Int!){repository(owner:$owner,name:$name){issue(number:$n){
  number title ${edits(50)}
  comments(first:100){${texts(20)}}
  timelineItems(first:100,itemTypes:[RENAMED_TITLE_EVENT]){filteredCount nodes{... on RenamedTitleEvent{createdAt previousTitle currentTitle}}}}}}`;

/**
 * A list GitHub returned fewer of than it has: its name, for `unavailable`. A timeline filtered by
 * `itemTypes` is compared by `filteredCount`: its `totalCount` counts every event, measured on 2026-09-25.
 */
export function cut(list: { totalCount?: number; filteredCount?: number; nodes: unknown[] } | undefined, what: string): string[] {
  const has = list?.filteredCount ?? list?.totalCount;
  return list && typeof has === "number" && has > list.nodes.length ? [`${what}: ${list.nodes.length} of ${has} fetched`] : [];
}

type Graph = (query: string, vars: Record<string, string | number>) => any;

const gh: Graph = (query, vars) => {
  const args = ["api", "graphql", "-f", `query=${query}`];
  for (const [k, v] of Object.entries(vars)) args.push(typeof v === "number" ? "-F" : "-f", `${k}=${v}`);
  return JSON.parse(execFileSync("gh", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, stdio: PIPED })).data;
};

/** A text, visible from `at`: the body's `createdAt`, a comment's `publishedAt`, a review's `submittedAt`. */
const text = (n: any, at: string | null = n.createdAt): Text => ({ createdAt: at ?? null, body: n.body ?? "", lastEditedAt: n.lastEditedAt ?? null, edits: n.userContentEdits?.nodes ?? [] });
const published = (n: any) => text(n, n.publishedAt ?? null);

/**
 * Closing keywords in the body as it stood at the merge: an issue the pull request said it closes,
 * even when GitHub made no connection event for it.
 */
export function closesIn(body: string): number[] {
  return [...body.matchAll(/\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s*:?\s+#(\d+)\b/gi)].map((m) => Number(m[1]));
}

/** The pull request and the issues it connected before the merge, fetched, then cut at the merge. */
export function fetchBundle(repo: string, number: number, graph: Graph = gh): Bundle {
  const [owner, name] = repo.split("/");
  const p = graph(PULL_QUERY, { owner: owner!, name: name!, n: number }).repository.pullRequest;
  if (!p.mergedAt) throw new Error(`${repo}#${number} did not merge`);
  const events = p.timelineItems.nodes as any[];
  const pull: RawPull = {
    repo,
    number: p.number,
    title: p.title,
    mergedAt: p.mergedAt,
    renames: events.filter((e) => e.__typename === "RenamedTitleEvent"),
    text: text(p),
    comments: p.comments.nodes.map(published),
    reviews: p.reviews.nodes.map((r: any) => ({ ...text(r, r.submittedAt ?? null), state: r.state })),
    reviewComments: p.reviews.nodes.flatMap((r: any) => r.comments.nodes.map(published)),
    connected: events.filter((e) => e.__typename === "ConnectedEvent" && e.subject?.number).map((e) => ({ number: e.subject.number, at: e.createdAt })),
  };
  const incomplete = [
    ...cut(p.comments, `#${number} comments`),
    ...cut(p.reviews, `#${number} reviews`),
    ...p.reviews.nodes.flatMap((r: any, i: number) => cut(r.comments, `#${number} review ${i + 1} comments`)),
    ...cut(p.timelineItems, `#${number} renames and links`),
  ];
  const body = textAt(pull.text, pull.mergedAt);
  for (const n of closesIn(body ?? "")) if (!pull.connected.some((c) => c.number === n)) pull.connected.push({ number: n, at: pull.mergedAt });
  const issues: RawItem[] = [];
  for (const n of new Set(pull.connected.filter((c) => c.at <= pull.mergedAt).map((c) => c.number))) {
    let i: any;
    try {
      i = graph(ISSUE_QUERY, { owner: owner!, name: name!, n }).repository.issue;
    } catch (error) {
      // `issue(number:)` refuses a pull request's number, or one that is gone. Anything else — a rate
      // limit, the network — is not a fact about the case, and stops the fetch rather than deciding it.
      if (!/Could not resolve to an Issue/.test(String(error))) throw error;
      i = null;
    }
    if (!i) {
      incomplete.push(`#${n}, named before the merge, could not be read as an issue (a pull request's number, or one that is gone)`);
      continue;
    }
    incomplete.push(...cut(i.comments, `#${n} comments`), ...cut(i.timelineItems, `#${n} renames`));
    issues.push({ number: i.number, title: i.title, renames: i.timelineItems.nodes, text: text(i), comments: i.comments.nodes.map(published) });
  }
  const bundle = bundleAt(pull, issues);
  bundle.unavailable.push(...incomplete);
  return bundle;
}
