# jev-intent-review

## Intent-conditioned repository verification for pull requests

Status: Draft
Target: v0.1
Primary interface: CLI + GitHub Actions
Judgment engine: Jev
Primary design principle: **The diff is a search hint, not the object being verified.**

> This is the design draft the project started from (2026-09-19), kept as written except for
> the tool's name, which was `jev-diff-review` in the draft. Where the implementation departs
> from it, the change and the reason are listed in the README under "Differences from the spec".

---

## 1. Summary

`jev-intent-review` is a pull-request verification tool that determines whether the repository produced by a PR satisfies the intent that motivated the change.

Traditional AI code review generally asks:

> Is there anything wrong with these changed lines?

`jev-intent-review` asks a different question:

> Given the requested behavior, does the repository after this PR satisfy that behavior everywhere it matters?

The tool derives explicit requirements from an Issue, task, acceptance criteria, or equivalent source of intent, discovers repository locations and execution paths relevant to each requirement, gathers bounded evidence, and asks Jev narrowly defined typed questions about that evidence.

The primary output is not an overall quality score. It is a requirement-to-evidence verification report.

Example:

```text
R1: Disabled API keys must never authenticate.

REST authentication       VERIFIED
GraphQL authentication    VERIFIED
WebSocket handshake       VIOLATION
CLI authentication        VERIFIED

Finding:
WebSocket authentication checks key existence but does not check disabled_at.

Evidence:
src/ws/authenticate.ts:48-72

Confidence:
high
```

The system must also detect semantic changes introduced by the PR that have no apparent relationship to the stated intent.

---

# 2. Problem

A git diff only shows code that changed.

Many important PR defects exist precisely in code that did not change.

Examples:

* A new authorization rule is added to one endpoint but omitted from another endpoint.
* A migration changes a data invariant but one background job still assumes the previous invariant.
* A feature is added to the REST API but not the GraphQL implementation.
* A bug fix addresses one caller while another caller reaches the same defective path.
* A PR claims backward compatibility while an untouched adapter now violates the new internal contract.
* A code change introduces behavior that was never requested by the Issue.

A diff-only reviewer cannot reliably detect these because its evidence universe is bounded by the changed lines.

`jev-intent-review` therefore defines review as:

```text
desired repository behavior
            vs
actual repository behavior after the PR
```

rather than:

```text
PR description
      vs
git diff
```

---

# 3. Core terminology

## Intent

The human-described desired outcome.

Typical sources:

1. linked GitHub Issue
2. acceptance criteria
3. Issue comments containing specification changes
4. PR description
5. task file
6. explicit CLI input

The Issue or task is considered more authoritative than an implementation summary written after the change.

---

## Requirement

An atomic, externally meaningful statement derived from Intent.

Example:

```text
R1: Disabled users cannot obtain a new session.
```

A requirement should be independently testable or inspectable.

Bad requirement:

```text
Improve authentication.
```

Good requirements:

```text
R1: A disabled user cannot authenticate with a password.
R2: A disabled user cannot authenticate through OAuth.
R3: Existing sessions belonging to a disabled user cannot be refreshed.
```

---

## Invariant

A condition that must remain true across multiple execution paths or states.

Example:

```text
Every path that creates a session must reject disabled users.
```

Many repository-wide defects are invariant violations rather than incorrect changed lines.

---

## Semantic surface

The set of repository locations potentially capable of satisfying or violating a requirement.

It can include:

* functions
* methods
* handlers
* commands
* jobs
* message consumers
* schema definitions
* configuration
* migrations
* tests
* documentation
* API contracts

---

## Evidence packet

A deliberately small bundle of code and metadata submitted to Jev for one bounded judgment.

Example:

```json
{
  "requirement": "Disabled users cannot obtain a new session",
  "candidate": "src/oauth/callback.ts",
  "role": "session_creation_path",
  "code": "...",
  "related_symbols": ["createSession", "user.disabledAt"],
  "changed": false
}
```

---

# 4. Goals

v0.1 must support the following capabilities.

### Requirement verification

For every extracted requirement:

1. identify relevant code locations;
2. verify whether relevant paths satisfy the requirement;
3. identify potential violations;
4. identify missing evidence;
5. report coverage.

### Missed-path detection

The tool must detect cases where:

* one implementation path changed;
* another semantically equivalent path did not;
* the unchanged path now violates the requested invariant.

This is one of the defining capabilities of the project.

### Unrequested-change detection

The tool must inspect semantic changes introduced by the PR and determine whether they can be justified by any requirement.

Example:

```text
Requirement:
Fix OAuth retry handling.

Observed semantic change:
Session expiration changed from 24h to 1h.

Mapped requirement:
none
```

This should be surfaced as an unrequested semantic change.

### Evidence-oriented reporting

Every significant finding must contain:

* requirement
* affected location
* evidence
* judgment
* confidence
* reason for uncertainty where applicable

No unsupported free-form review comments.

### Explicit uncertainty

The system must distinguish:

```text
VERIFIED
VIOLATION
UNKNOWN
NOT_APPLICABLE
```

`UNKNOWN` is preferable to invented certainty.

---

# 5. Non-goals

v0.1 is not intended to replace:

* compiler diagnostics
* linters
* unit tests
* security scanners
* dependency vulnerability scanners
* style review
* generic maintainability scoring
* architecture scoring
* human approval

The tool should not attempt to find arbitrary bugs unrelated to the stated intent.

It should not produce generic comments such as:

```text
This function is too complex.
Consider refactoring this module.
Add more comments.
```

unless such an issue directly affects an explicit requirement.

---

# 6. Central design rule

The diff MUST NOT define the review scope.

The diff may be used to:

* seed repository exploration;
* identify changed symbols;
* identify likely domain concepts;
* discover semantic deltas;
* prioritize evidence.

But unchanged repository code MUST be eligible for inspection.

Formally:

```text
review_scope != changed_files
```

Instead:

```text
review_scope =
semantic_surface(requirements, repository_after)
```

---

# 7. High-level architecture

```text
GitHub Issue / task
        │
        ▼
┌─────────────────────┐
│ 1. Intent Resolver  │
└─────────────────────┘
        │
        ▼
 raw intent context
        │
        ▼
┌─────────────────────┐
│ 2. Intent Compiler  │
└─────────────────────┘
        │
        ▼
requirements + invariants
        │
        ├──────────────────────────┐
        │                          │
        ▼                          ▼
 repository BEFORE          repository AFTER
        │                          │
        └─────────┬────────────────┘
                  ▼
        ┌──────────────────────┐
        │ 3. Change Analyzer   │
        └──────────────────────┘
                  │
           semantic seeds
                  │
                  ▼
        ┌──────────────────────┐
        │ 4. Surface Discovery │
        └──────────────────────┘
                  │
          candidate locations
                  │
                  ▼
        ┌──────────────────────┐
        │ 5. Evidence Builder  │
        └──────────────────────┘
                  │
          bounded packets
                  │
                  ▼
        ┌──────────────────────┐
        │ 6. Jev Verifier      │
        └──────────────────────┘
                  │
          typed judgments
                  │
                  ▼
        ┌──────────────────────┐
        │ 7. Aggregator        │
        └──────────────────────┘
                  │
                  ▼
        Requirement Coverage Report
```

---

# 8. Stage 1 — Intent Resolver

## Purpose

Collect the most authoritative description of what the PR is supposed to accomplish.

## Supported inputs

CLI:

```bash
jev-intent-review review \
  --issue 123 \
  --repo owner/repository \
  --base main \
  --head HEAD
```

Alternative:

```bash
jev-intent-review review \
  --intent-file task.md
```

or:

```bash
jev-intent-review review \
  --intent "Disabled users must not be able to create new sessions"
```

## GitHub intent resolution

When a PR is supplied:

```bash
jev-intent-review review --pr 456
```

the resolver should inspect:

1. PR metadata
2. linked Issues
3. closing keywords
4. PR body
5. linked acceptance criteria where available

The resolver should preserve source provenance.

Example:

```json
{
  "sources": [
    {
      "type": "github_issue",
      "id": "123",
      "authority": 100
    },
    {
      "type": "pr_description",
      "id": "456",
      "authority": 50
    }
  ]
}
```

Contradictory sources must not silently overwrite each other.

They should produce an ambiguity record.

---

# 9. Stage 2 — Intent Compiler

## Purpose

Convert human-written intent into atomic reviewable requirements.

Output:

```json
{
  "requirements": [
    {
      "id": "R1",
      "text": "Disabled users cannot authenticate using a password.",
      "kind": "behavior",
      "priority": "required",
      "source": {
        "type": "issue",
        "id": 123
      }
    },
    {
      "id": "R2",
      "text": "Disabled users cannot authenticate through OAuth.",
      "kind": "behavior",
      "priority": "required"
    }
  ]
}
```

## Requirement classes

Initial set:

```text
behavior
invariant
compatibility
security
data
interface
test
documentation
non_goal
```

## Important constraint

Jev should NOT be forced to perform unconstrained requirement generation.

Jev is best used for bounded judgments.

Requirement compilation should therefore be implemented separately.

Recommended architecture:

```text
Intent text
   ↓
deterministic extraction where possible
   ↓
optional generative intent compiler
   ↓
schema validation
   ↓
Jev atomicity / ambiguity checks
```

For v0.1, a generic LLM-backed compiler may be used behind an interface.

```ts
interface IntentCompiler {
  compile(input: IntentContext): Promise<IntentSpec>;
}
```

The rest of the system must not depend on a specific generative provider.

---

# 10. IntentSpec schema

```ts
interface IntentSpec {
  version: 1;
  title: string;
  summary: string;

  requirements: Requirement[];
  nonGoals: NonGoal[];
  ambiguities: Ambiguity[];
}

interface Requirement {
  id: string;
  text: string;

  kind:
    | "behavior"
    | "invariant"
    | "compatibility"
    | "security"
    | "data"
    | "interface"
    | "test"
    | "documentation";

  priority:
    | "required"
    | "expected"
    | "optional";

  sourceRefs: SourceRef[];
}
```

---

# 11. Stage 3 — Change Analyzer

## Purpose

Understand what the PR changed semantically.

This stage does NOT determine review scope.

It produces seeds.

Input:

```text
base repository
head repository
git diff
```

Output examples:

```json
{
  "changedFiles": [
    "src/auth/password.ts"
  ],
  "changedSymbols": [
    "authenticatePassword"
  ],
  "concepts": [
    "authentication",
    "disabled user",
    "session creation"
  ]
}
```

Later versions can support AST-level semantic deltas.

v0 may begin with:

* changed filenames
* changed function names
* imports
* identifiers
* string literals
* comments
* test names

---

# 12. Stage 4 — Semantic Surface Discovery

This is the core differentiator.

## Input

```text
Requirement R
repository_after
semantic seeds
```

## Output

Candidate locations that could satisfy or violate R.

Example:

```json
{
  "requirement": "R1",
  "candidates": [
    {
      "path": "src/auth/password.ts",
      "symbol": "authenticatePassword",
      "reason": "changed authentication path"
    },
    {
      "path": "src/auth/oauth.ts",
      "symbol": "oauthCallback",
      "reason": "alternative session creation path"
    },
    {
      "path": "src/session/refresh.ts",
      "symbol": "refreshSession",
      "reason": "creates renewed authentication state"
    }
  ]
}
```

---

# 13. Discovery strategy

Discovery should be layered.

## Layer A — Diff seeds

Extract:

* changed symbols
* changed types
* changed APIs
* changed routes
* changed tables
* changed config keys

## Layer B — lexical search

Search repository for:

* identifiers
* relevant terminology from requirement
* API names
* model names
* event names
* database fields

## Layer C — structural relations

Where available:

* references
* callers
* callees
* imports
* implementations
* interface implementors
* route registration
* command registration
* event consumers

## Layer D — semantic ranking

Candidate snippets can be ranked using Jev.

Example Choice judgment:

```text
Question:
How relevant is this code region to requirement R1?

Choices:
- directly_enforces
- can_violate
- indirectly_related
- unrelated
```

Only sufficiently relevant candidates proceed to expensive verification.

---

# 14. Repository adapters

v0 should define a generic interface:

```ts
interface RepositoryIndex {
  listFiles(): Promise<string[]>;

  searchText(query: string): Promise<SearchHit[]>;

  getFile(path: string): Promise<FileContent>;

  getChangedFiles(): Promise<ChangedFile[]>;

  getChangedSymbols?(): Promise<SymbolChange[]>;

  findReferences?(
    symbol: SymbolRef
  ): Promise<ReferenceHit[]>;
}
```

Initial implementation can use:

* git
* ripgrep
* filesystem

Language-aware adapters can be added later.

---

# 15. Stage 5 — Evidence Builder

Jev calls should remain small.

Do not submit entire repositories.

For each:

```text
Requirement × Candidate
```

build one bounded packet.

Example:

```json
{
  "requirement": {
    "id": "R1",
    "text": "Disabled users cannot authenticate through OAuth."
  },

  "candidate": {
    "path": "src/oauth/callback.ts",
    "symbol": "completeOAuthLogin",
    "changed": false
  },

  "evidence": {
    "code": "...",
    "relatedCode": [
      "..."
    ]
  }
}
```

Size limits must be explicit and configurable.

Suggested v0 defaults:

```text
primary snippet:     2,000 chars
related context:     2,000 chars
requirement:           600 chars
metadata:              500 chars
```

If required evidence exceeds the limit, split by coherent semantic region.

Never silently truncate code in the middle of a logical unit without reporting it.

---

# 16. Stage 6 — Jev verifier

Jev should answer bounded questions.

It should not be asked:

```text
Review this code.
```

It should be asked questions whose answer space is fixed.

---

# 17. Core Jev judgments

## J1 — Relevance

```text
Question:
What relationship does this code region have to requirement R1?

Choice:
- directly_enforces
- may_violate
- supporting
- unrelated
- cannot_tell
```

---

## J2 — Requirement satisfaction

```text
Question:
Given only this evidence, does this execution path satisfy R1?

Choice:
- satisfies
- violates
- insufficient_evidence
- not_applicable
```

---

## J3 — Confidence

Use Jev Score or equivalent bounded confidence.

```text
0.0 → no useful evidence
1.0 → direct explicit evidence
```

---

## J4 — Change justification

For semantic changes:

```text
Question:
Is this observed behavior change justified by any supplied requirement?

Choice:
- clearly_required
- plausibly_required
- unrelated
- cannot_tell
```

---

## J5 — Candidate completeness signal

For groups of discovered paths:

```text
Question:
Does the discovered set appear to cover the named behavior category?

Choice:
- likely_complete
- likely_incomplete
- cannot_tell
```

This must NOT be treated as proof of completeness.

It is a search-quality signal only.

---

# 18. Critical Jev design rule

Jev findings should not directly become final report findings.

Instead:

```text
Jev judgment
      ↓
deterministic policy
      ↓
Finding
```

Example:

```ts
if (
  result.answer === "violates" &&
  result.confidence >= config.violationThreshold
) {
  findings.push(...)
}
```

Thresholds belong in code.

They must not be hidden inside prompts.

---

# 19. Stage 7 — Aggregation

Individual path judgments are aggregated into requirement status.

Recommended states:

```text
VERIFIED
VIOLATION
UNKNOWN
NOT_APPLICABLE
```

Rules:

### VIOLATION

At least one sufficiently confident candidate violates the requirement.

```text
one violation is sufficient
```

### VERIFIED

All discovered relevant candidates satisfy the requirement AND discovery confidence is adequate.

This wording is important.

Never claim mathematical proof.

Report:

```text
VERIFIED over 6 discovered paths
```

not:

```text
Proven correct
```

### UNKNOWN

Used when:

* relevant candidate cannot be evaluated;
* discovery coverage is uncertain;
* source intent is ambiguous;
* evidence had to be truncated;
* Jev confidence is below threshold.

---

# 20. Coverage model

Each requirement receives a coverage object.

```json
{
  "requirementId": "R1",
  "candidatesFound": 5,
  "candidatesVerified": 4,
  "violations": 0,
  "unknown": 1,
  "coverage": "partial"
}
```

Coverage states:

```text
full
partial
weak
none
```

The exact numeric formula should initially be avoided.

Counts and explicit reasons are easier to interpret than synthetic percentages.

---

# 21. Unexpected semantic changes

Requirement verification only checks:

```text
Intent → Code
```

The reverse direction is equally important:

```text
Code → Intent
```

For each meaningful changed behavior, determine whether it maps to a requirement.

Output:

```json
{
  "change": "Session expiry changed from 24h to 1h",
  "location": "src/session/config.ts",
  "mappedRequirements": [],
  "judgment": "unrequested",
  "confidence": 0.91
}
```

Possible states:

```text
required
supporting
unrequested
cannot_tell
```

This catches scope creep and accidental behavior changes.

---

# 22. Final report format

Primary presentation:

```text
jev-intent-review

Intent
------
Issue #123: Prevent disabled users from authenticating

Requirements
------------

R1 Disabled users cannot authenticate with passwords
Status: VERIFIED
Paths checked: 2
Unknown: 0

  ✓ src/auth/password.ts
  ✓ src/api/login.ts

R2 Disabled users cannot authenticate through OAuth
Status: VIOLATION

  ✗ src/oauth/callback.ts:72

  Evidence:
  User existence is checked, but disabled_at is not checked
  before createSession().

R3 Existing sessions belonging to disabled users cannot refresh
Status: UNKNOWN

  ? src/session/refresh.ts

  Reason:
  Session owner state is loaded indirectly and available evidence
  was insufficient to determine whether disabled state is enforced.

Unexpected changes
------------------

U1 Session expiration changed from 24h to 1h
Location: src/session/constants.ts
Intent mapping: none
Confidence: high

Coverage
--------

Requirements: 3
Verified:     1
Violations:   1
Unknown:      1

Repository candidates examined: 9
Changed-file candidates:        4
Unchanged-file candidates:      5
```

The last two lines are valuable because they demonstrate that review extended beyond the diff.

---

# 23. JSON report schema

```ts
interface ReviewReport {
  version: 1;

  intent: IntentSpec;

  requirements: RequirementResult[];

  unexpectedChanges: UnexpectedChange[];

  discovery: {
    candidateCount: number;
    changedCandidates: number;
    unchangedCandidates: number;
    incompleteReasons: string[];
  };

  metadata: {
    base: string;
    head: string;
    repository: string;
  };
}
```

Requirement result:

```ts
interface RequirementResult {
  requirementId: string;

  status:
    | "verified"
    | "violation"
    | "unknown"
    | "not_applicable";

  candidates: CandidateResult[];

  coverage:
    | "full"
    | "partial"
    | "weak"
    | "none";

  notes: string[];
}
```

---

# 24. CLI

Initial command surface should stay small.

```bash
jev-intent-review review
```

Examples:

```bash
jev-intent-review review \
  --issue 123
```

```bash
jev-intent-review review \
  --pr 456
```

```bash
jev-intent-review review \
  --intent-file task.md
```

```bash
jev-intent-review review \
  --intent-spec intent.json
```

Machine output:

```bash
jev-intent-review review --pr 456 --json
```

Debugging:

```bash
jev-intent-review review --pr 456 --trace
```

`--trace` should show:

* resolved intent sources
* extracted requirements
* search queries
* candidate locations
* evidence packets
* Jev answers

Secrets and source snippets must be redacted where appropriate.

---

# 25. GitHub Actions integration

Typical workflow:

```yaml
name: Intent Review

on:
  pull_request:
    types: [opened, synchronize, reopened]

permissions:
  contents: read
  issues: read
  pull-requests: read

jobs:
  intent-review:
    runs-on: ubuntu-latest

    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0

      - uses: yottayoshida/jev-intent-review@v0
        with:
          pr: ${{ github.event.pull_request.number }}
```

Action should create a Check Run summary rather than dozens of inline comments.

Inline annotations should be restricted to confident violations with precise file locations.

---

# 26. Exit codes

Suggested:

```text
0  review completed, no confident violation
1  one or more confident requirement violations
2  analysis incomplete / unknown coverage
10 configuration error
11 intent resolution failed
12 Jev provider failure
13 repository discovery failed
```

CI policy should be configurable.

Example:

```yaml
policy:
  fail_on:
    - violation

  unknown:
    action: warn
```

---

# 27. Configuration

`.jev-intent-review.yml`

```yaml
version: 1

intent:
  prefer_issue: true
  include_pr_description: true

repository:
  ignore:
    - vendor/**
    - node_modules/**
    - dist/**
    - "**/*.generated.*"

discovery:
  max_candidates_per_requirement: 30
  lexical_search: true
  reference_search: auto

evidence:
  max_primary_chars: 2000
  max_related_chars: 2000

judgment:
  violation_confidence: 0.75
  relevance_confidence: 0.60

policy:
  fail_on:
    - violation

  unknown: warn
```

---

# 28. Source prioritization

When intent sources conflict, preserve both.

Suggested authority:

```text
explicit acceptance criteria
        >
Issue body
        >
Issue specification comments
        >
PR description
        >
commit message
```

Do not silently assume PR description overrides Issue intent.

A PR description often describes the implementation after it exists and can therefore normalize accidental changes.

---

# 29. Security

Repository content will potentially be sent to a remote judgment provider.

Requirements:

* never send `.env`
* ignore obvious secret files
* redact common token formats
* provide `--no-network` dry-run mode
* show exactly what evidence would be submitted under `--trace`
* cap evidence size
* never upload the entire repository automatically

Provider interface:

```ts
interface JudgmentProvider {
  judge<T>(
    state: unknown,
    question: TypedQuestion<T>
  ): Promise<TypedAnswer<T>>;
}
```

Initial adapter:

```text
Jev
```

Future adapters should not require architecture changes.

---

# 30. Suggested implementation language

Use TypeScript / Node.js.

Reasons:

* aligns naturally with current Jev ecosystem;
* easiest GitHub Action packaging;
* straightforward CLI distribution;
* easier reuse of Jev clients and schemas;
* aligns with `jev-sscope`;
* AST support is available for JS/TS while remaining language-neutral at the orchestration layer.

Recommended runtime:

```text
Node.js 22+
TypeScript
```

Avoid Cloudflare-specific primitives in the core package.

`jev-sscope` is a Worker application.

`jev-intent-review` should primarily be a local/CI executable.

---

# 31. Repository structure

```text
jev-intent-review/
├── src/
│   ├── cli/
│   │   └── review.ts
│   │
│   ├── intent/
│   │   ├── resolver.ts
│   │   ├── compiler.ts
│   │   ├── schema.ts
│   │   └── github.ts
│   │
│   ├── repository/
│   │   ├── git.ts
│   │   ├── files.ts
│   │   ├── search.ts
│   │   └── index.ts
│   │
│   ├── change/
│   │   ├── diff.ts
│   │   └── semantic-seeds.ts
│   │
│   ├── discovery/
│   │   ├── discover.ts
│   │   ├── lexical.ts
│   │   ├── symbols.ts
│   │   └── ranking.ts
│   │
│   ├── evidence/
│   │   ├── builder.ts
│   │   └── limits.ts
│   │
│   ├── judgments/
│   │   ├── provider.ts
│   │   ├── jev.ts
│   │   ├── relevance.ts
│   │   ├── satisfaction.ts
│   │   └── justification.ts
│   │
│   ├── review/
│   │   ├── requirement.ts
│   │   ├── unexpected-change.ts
│   │   └── aggregate.ts
│   │
│   ├── report/
│   │   ├── types.ts
│   │   ├── json.ts
│   │   └── markdown.ts
│   │
│   └── config/
│       └── config.ts
│
├── test/
│   ├── fixtures/
│   ├── discovery/
│   ├── judgments/
│   └── integration/
│
├── action.yml
├── package.json
└── README.md
```

Dependency direction:

```text
cli
 ↓
review
 ↓
intent / change / discovery / evidence
 ↓
repository / judgments
 ↓
domain types
```

Avoid cross-layer imports.

---

# 32. v0.1 scope

The first release should deliberately avoid trying to understand every programming language deeply.

Implement:

1. Git repository handling
2. GitHub Issue/PR intent resolution
3. IntentSpec compilation
4. git diff semantic seeds
5. repository-wide lexical search
6. file/symbol candidate ranking
7. bounded Jev relevance judgment
8. bounded Jev requirement satisfaction judgment
9. reverse mapping of changed regions to requirements
10. Markdown + JSON reports
11. GitHub Action
12. fixtures demonstrating missed unchanged paths

Do NOT block v0.1 on:

* full call graph
* compiler integration
* Tree-sitter for every language
* embeddings database
* daemon mode
* hosted dashboard

---

# 33. Mandatory demo fixture

The repository should contain at least one fixture specifically proving the differentiator.

Example application:

```text
src/
  auth/
    password.ts
    oauth.ts
    websocket.ts
```

Issue:

```text
Prevent disabled users from authenticating.
```

PR diff:

```text
password.ts
+ if (user.disabled) reject()
```

Unchanged:

```text
oauth.ts
websocket.ts
```

Expected result:

```text
R1

password authentication    VERIFIED
oauth authentication       VIOLATION
websocket authentication   VIOLATION
```

If the tool cannot detect this scenario, it has failed the core product requirement.

---

# 34. Second mandatory fixture — scope creep

Issue:

```text
Fix OAuth retry behavior.
```

PR also changes:

```text
SESSION_TTL = 24h
```

to:

```text
SESSION_TTL = 1h
```

Expected result:

```text
Unexpected semantic change:
session lifetime changed

Mapped requirement:
none
```

---

# 35. Third mandatory fixture — unknown

Issue:

```text
Audit every deletion operation.
```

A deletion occurs through dynamically loaded plugin code that static repository discovery cannot confidently trace.

Expected result:

```text
R1 UNKNOWN

Reason:
Potential deletion path discovered through dynamic plugin registration;
available evidence is insufficient to verify audit logging.
```

The system must prefer UNKNOWN over a false VERIFIED result.

---

# 36. Evaluation methodology

Do not evaluate quality by whether the report "looks good."

Create labeled fixtures.

Each fixture should define:

```json
{
  "requirements": ["R1"],
  "expectedFindings": [
    {
      "requirement": "R1",
      "path": "src/oauth.ts",
      "expected": "violation"
    }
  ]
}
```

Track:

```text
violation precision
violation recall
candidate discovery recall
unknown rate
false verified rate
Jev calls per review
tokens/evidence bytes per review
runtime
```

The most important metric is:

```text
false VERIFIED rate
```

False confidence is worse than UNKNOWN.

---

# 37. Design philosophy for Jev

The product must not treat Jev as a miniature general-purpose coding agent.

Use Jev where a bounded judgment exists.

Good:

```text
Does this path satisfy this requirement?

Is this code relevant?

Is this behavior change justified?
```

Bad:

```text
Find all bugs in this PR.

Understand this whole repository.

Tell me what the developer intended.
```

The orchestration layer is responsible for decomposing large reasoning problems into small judgment problems.

This mirrors the design principle already demonstrated by `jev-sscope`:

```text
large process
→ small observations
→ fixed questions
→ typed judgments
```

For `jev-intent-review`:

```text
large repository
→ candidate semantic surfaces
→ small evidence packets
→ fixed questions
→ typed judgments
```

---

# 38. Relationship to previous intent-diff

The old `intent-diff` compared:

```text
PR description
      vs
git diff
```

Its job was primarily discrepancy triage.

`jev-intent-review` should not simply port that pipeline to Jev.

The new definition is:

```text
Issue / specification
        vs
repository behavior after the PR
```

Reusable concepts from the previous project:

* intent source handling
* diff parsing
* structured reporting
* GitHub Action
* config handling
* mismatch terminology
* secret redaction
* CI packaging

Concepts that should not be carried forward unchanged:

* diff as complete evidence universe
* global A–E grading
* one-shot LLM analysis
* changed-file-only evidence validation
* PR description as primary intent source

---

# 39. Relationship to other Jev review tools

The project should position itself distinctly.

Generic Jev review:

```text
code
 ↓
quality / correctness / security judgments
```

Task-aware diff review:

```text
task + diff
 ↓
does this changed block fit the task?
```

`jev-intent-review`:

```text
intent
 ↓
derive requirements
 ↓
discover all relevant repository paths
 ↓
verify each relevant path
```

The core product promise should therefore not be:

> Better AI code review.

It should be:

> Verify that a pull request actually implements the requested behavior across the repository.

---

# 40. Definition of done for v0.1

v0.1 is complete when:

1. A GitHub PR can be reviewed from one command.
2. The linked Issue can be resolved automatically.
3. Intent can be compiled into atomic requirements.
4. Relevant unchanged files can be discovered.
5. Jev can classify candidate relevance.
6. Jev can evaluate requirement satisfaction.
7. At least one unchanged-path defect is detected in integration tests.
8. Unrequested changed behavior can be surfaced.
9. UNKNOWN is emitted when evidence is insufficient.
10. Reports show requirement-level evidence and coverage.
11. GitHub Actions integration works without a hosted backend.
12. The report never implies that absence of findings proves correctness.

---

# 41. Initial implementation sequence

Phase 1:

```text
IntentSpec schema
Git diff reader
repository text search
Jev adapter
report schema
```

Phase 2:

```text
Issue resolver
requirement compiler
candidate discovery
requirement verifier
```

Phase 3:

```text
reverse change→intent mapping
GitHub Action
trace/debug mode
fixture benchmark
```

Phase 4:

```text
language-aware symbol extraction
references/call graph
incremental caching
```

---

# 42. One-sentence product definition

**jev-intent-review verifies a pull request against the intent that caused it by searching the post-change repository for every relevant implementation path and using Jev to make small, typed judgments over bounded evidence.**

---

# 43. Implementation guardrails

If an implementation decision conflicts with these rules, these rules win:

1. Issue/spec intent is more important than the PR's implementation summary.
2. Diff is a discovery seed, not the review boundary.
3. Unchanged files must be reviewable.
4. Requirements must be evaluated independently.
5. Jev receives bounded evidence and fixed questions.
6. Orchestration and thresholds live in code.
7. UNKNOWN is an acceptable and important result.
8. Every violation must point to concrete evidence.
9. Do not invent a global quality score.
10. The principal output is requirement coverage, not generic review commentary.
