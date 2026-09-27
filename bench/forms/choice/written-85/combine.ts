// Builds `bench/forms/choice/sentences-v3.json` from the three truth files and the three draft files,
// by README.md's rule and nothing else: a pull request's truth is the answer at least two of three give;
// `other`, `unclear`, a three-way split, a missing answer or a missing sentence leaves it out, with why.
//
//   node bench/forms/choice/written-85/combine.ts          writes the set
//   node bench/forms/choice/written-85/combine.ts --check  exits 1 if the set on disk differs

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { majorityTruth as majority, type Set3File, type Sentence3, type Truth } from "../v3.ts";

const HERE = new URL("./", import.meta.url).pathname;
const OUT = join(HERE, "../sentences-v3.json");
const REL = "bench/forms/choice/written-85";

const prs = readFileSync(join(HERE, "prs.txt"), "utf8").split("\n").filter(Boolean);
const truths = ["a", "b", "c"].map((k) => {
  const list = JSON.parse(readFileSync(join(HERE, `truth-${k}.json`), "utf8")) as { ref: string; answer: string }[];
  return new Map(list.map((x) => [x.ref, x.answer]));
});
const drafts = ["a", "b", "c"].flatMap((k) => {
  const doc = JSON.parse(readFileSync(join(HERE, `drafts-${k}.json`), "utf8")) as { drafts: { ref: string; sentence?: string }[] };
  return doc.drafts.map((d) => ({ ...d, file: `${REL}/drafts-${k}.json` }));
});

const sentences: Sentence3[] = [];
const dropped: { ref: string; why: string }[] = [];
for (const ref of prs) {
  const votes = truths.map((m) => m.get(ref)) as (Truth | undefined)[];
  const truth = majority(votes);
  const draft = drafts.find((d) => d.ref === ref);
  if ("why" in truth) dropped.push({ ref, why: truth.why });
  else if (truth.decided === "other" || truth.decided === "unclear") dropped.push({ ref, why: `the fixed code's handling is ${truth.decided} (${votes.join(", ")})` });
  else if (typeof draft?.sentence !== "string" || draft.sentence.trim() === "") dropped.push({ ref, why: "no sentence was written" });
  else {
    const [repo, n] = ref.split("#") as [string, string];
    sentences.push({
      id: `w85-${repo.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-${n}`,
      label: truth.decided === "handles_locally" ? "failure_handling" : "failure_propagation",
      origin: { kind: "written-85", file: draft.file, ref },
      text: draft.sentence,
      repo,
      truth: { decided: truth.decided, votes: votes as Truth[] },
    });
  }
}

const set: Set3File = {
  about: "Sentences written from the text of dev pull requests, labelled by how their fixed code handles the failure, read from the diff (#85, ADR 0026, written-85/README.md). Built by written-85/combine.ts.",
  sentences,
  dropped,
};
const text = `${JSON.stringify(set, null, 2)}\n`;
if (process.argv.includes("--check")) {
  const same = readFileSync(OUT, "utf8") === text;
  console.log(same ? "sentences-v3.json is what combine.ts builds" : "sentences-v3.json differs from what combine.ts builds");
  process.exitCode = same ? 0 : 1;
} else {
  writeFileSync(OUT, text);
  const by = (t: Truth) => sentences.filter((s) => s.truth?.decided === t).length;
  console.log(`${sentences.length} sentences (handles_locally ${by("handles_locally")}, returns_to_caller ${by("returns_to_caller")}); dropped ${dropped.length}`);
}
