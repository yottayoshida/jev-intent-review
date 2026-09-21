# The local check (v0.1)

This is the reference for `--experimental-local-check`: what to give it, how to read what comes
back, what the exit code means, and what has been measured. The README says what the tool is for;
this says exactly what v0.1 does. The sections after [the record](#record-of-the-experiments) are
the working record of how v0.1 got here, in Japanese.

## Writing a requirement

One checkable sentence per requirement, saying what must happen when something fails. No file
name, no function name, no expected answer.

```json
{
  "version": 1, "title": "", "summary": "", "nonGoals": [], "ambiguities": [],
  "requirements": [{
    "id": "R1",
    "text": "If reading an existing integrity baseline fails, the baseline-loading operation must return an error to its caller. It must not return a successful result saying that no baseline exists.",
    "kind": "behavior", "priority": "required", "sourceRefs": [], "searchHints": []
  }]
}
```

An acceptance-criteria list in the issue or the pull request works too — a heading such as
`## Acceptance criteria` and one item per line, read as written. Ordinary prose is not turned into
requirements: no model writes them, so a description that is neither a spec file nor such a list
stops the run and names those two forms.

## What it asks

For each requirement it takes the Rust functions the change touched and the functions that call
them, one hop out, and every call inside those functions whose callee is defined in the repository
and returns a `Result`. Each such call, up to a budget of 20 per requirement, gets two questions to
Jev, in separate requests:

1. does the requirement require that a failure of this call not reach the caller as a success?
   (`applies` / `does_not_apply` / `unknown`)
2. when this call fails, what does the function return? (`returns_error` / `returns_success` /
   `cannot_determine`)

Both are read at 0.6. `--experimental-candidates-only` stops before the first question and prints
which calls are inside the budget and which are not, with a reason each; it needs no credentials.

## Reading the output

```
### Worth checking

#### src/integrity.rs:210-220 · read_baseline — `crate::atomic_file::read_to_string_capped(&path, MAX)`
- **Requirement R1**: "If reading an existing integrity baseline fails, …"
- **Assumed**: Execution reaches the call … There, `…` returns an error. Every other operation …
- **Jev, on whether the requirement requires it here**: applies (0.96)
- **Jev, on what the function returns**: returns_success (1.00)
- **Why it is listed**: … Both are Jev's readings and neither checks the other.
```

| section | what it holds |
|---|---|
| **Worth checking** | both answers cleared the bar and disagree |
| **Read as required by the requirement** | Jev read the requirement as applying to this call. The behavior observation is reported separately — a call under *Worth checking* is in here too |
| **Read, but not required of by the requirement** | `does_not_apply`, `unknown`, below the bar, or no answer — each says which |
| **Not checked** | the callee has no definition here, the target returns no `Result`, the body did not fit, the call could not be located, or the budget was spent |
| **Notes** | caps that dropped candidates, files that could not be read, and what the change did not reach |

A listed call rests on two Jev readings that do not check each other. Everything either of them
used is printed so it can be thrown out. `--json` carries every mapping, every reading and every
option's probability.

## Exit codes

Findings do not cause a nonzero exit code. Configuration, intent, repository and provider failures
can (10, 11, 13 and 12). **Exit 0 does not establish that the requirement holds.**

"Nothing listed" means no call met the conditions for being listed — both answers over the bar and
disagreeing. It covers calls whose mapping or whose behaviour came back undetermined, below the
bar, or unanswered, as well as calls that agreed. What was not reached is under *Not checked*, and
the enumeration's own caps are counted in the notes.

## What has been measured

### Cases that were not used to tune anything

Forty merged pull requests from outside this project were examined in a fixed order
(`bench/acceptance/candidates.json`; the rules are in `bench/acceptance/README.md`), looking for one
that states how a failure must be handled, fixes it at a call v0.1 can put a question to, and lets
the defect be observed by running it. The plan asked for three; two passed, and how the others
failed is the first result. Twenty-eight of the forty do not fit v0.1's question at all. In many,
the fix logs the failure, warns, blocks, or reports it in the result instead of returning it, and a
question about whether a failure reaches the caller as a success cannot tell such a fix from the
defect; the rest are about something other than a failed call. Of the twelve that fit, the fixed
call could be asked about in three. Eight could not: the call goes to the standard library or
another crate, to a name defined more than once in the repository, or to a `Result` under another
name (`CostResult`), or it never entered the tool's listing at all — a cap on the fixed file and
methods the listing does not read in one case, a change the tool reports as touching no Rust
function in another. Three of the eight were settled from the definitions of the callee, the count
`applicabilityOf` uses, without running the tool. The twelfth, iota#10136, was not run through the
tool: cloning its 470 MB monorepo to run the pre-check, and building it for a probe, are both far
outside a one-crate test. Of the three, two could be built and
run to observe the defect; the third needs a WebAssembly toolchain to build at all. At forty
candidates, the cap, the owner chose to measure the two rather than stop
(`bench/acceptance/candidates.json`, `gateExtension`).

The two cases are moltis-org/moltis#1064 and dashpay/grovedb#500. Each has four versions: the
shipped code, a defect at the fixed call whose effect was observed by running it, a rewrite that
does not change behaviour, and a version where the decision is moved into a helper whose body is
not sent, so no confident reading is right. moltis also carries two defects outside the diff,
placed at the merge base so the pull request did not fix them: one in an unchanged caller of a
changed function — the README's example — and one in a function that neither changed nor calls one
that did. Every branch whose target is inside the budget was run three times.

<!-- acceptance:begin -->
Candidates examined: 40 (cap 40). Passed condition (a): 12, (b): 3, (c): 2. Measured: 2 requirements from 2 repositories.

| case | version | target | expected | reach | readings (mapping / behaviour) | result |
|---|---|---|---|---|---|---|
| grovedb-500 | shipped | A `finalize` | not listed | asked | applies 1.00 / returns_error 1.00; applies 1.00 / returns_error 0.99; applies 1.00 / returns_error 0.99 | 3/3 agrees |
| grovedb-500 | defect-A | A `finalize` | listed | asked | applies 0.99 / returns_success 0.89 · listed; applies 0.99 / returns_success 0.92 · listed; applies 0.99 / returns_success 0.94 · listed | 3/3 agrees |
| grovedb-500 | rewrite-A | A `finalize` | not listed | asked | applies 1.00 / returns_error 1.00; applies 1.00 / returns_error 1.00; applies 1.00 / returns_error 1.00 | 3/3 agrees |
| grovedb-500 | hidden-A | A `finalize` | no confident reading | asked | applies 1.00 / returns_error 0.96; applies 1.00 / returns_error 0.94; applies 1.00 / returns_error 0.95 | 0/3 differs |
| moltis-1064 | shipped | A `generate_title_for_session` | not listed | asked | applies 0.99 / returns_error 0.99; applies 0.99 / returns_error 1.00; applies 1.00 / returns_error 0.99 | 3/3 agrees |
| moltis-1064 | shipped | B `dispatch_command` | not listed | held before any question (target_not_result) | — | not reached |
| moltis-1064 | shipped | C `generate_title` | not listed | not enumerated (a cap fired; cap or structure) | — | not reached |
| moltis-1064 | defect-A | A `generate_title_for_session` | listed | asked | applies 0.98 / returns_success 0.99 · listed; applies 0.98 / returns_success 1.00 · listed; applies 0.99 / returns_success 1.00 · listed | 3/3 agrees |
| moltis-1064 | rewrite-A | A `generate_title_for_session` | not listed | asked | applies 0.99 / returns_error 0.99; applies 1.00 / returns_error 1.00; applies 0.99 / returns_error 1.00 | 3/3 agrees |
| moltis-1064 | hidden-A | A `generate_title_for_session` | no confident reading | asked | applies 0.98 / returns_error 0.92; applies 0.98 / returns_error 0.92; applies 0.99 / returns_error 0.94 | 0/3 differs |
| moltis-1064 | defect-B | B `dispatch_command` | listed | held before any question (target_not_result) | — | not reached |
| moltis-1064 | defect-C | C `generate_title` | listed | not enumerated (a cap fired; cap or structure) | — | not reached |

Calls other than the targets that were listed in these runs, not scored: 0. Requests sent to Jev: 205, over 24 runs.
<!-- acceptance:end -->

What it shows, and no more than that:

- **Inside the diff, v0.1 read both unseen cases right.** Each defect was listed at its own call in
  three runs of three, and neither the shipped code nor the rewrite listed it, or anything else.
  That is two requirements from two repositories.
- **No question reached a defect placed outside the diff.** The unchanged caller in moltis was held
  before any question: its return type is `ChannelResult<String>`, a `Result` alias the check does
  not recognise, and the report says it does not return a `Result`. The other function is outside
  what v0.1 enumerates by construction; the table says "cap or structure" because the rule fixed
  beforehand gives that label whenever a cap fired in the run. Among the three candidates whose
  fixed call could be asked, the call from the unchanged caller to the changed function reached no
  question in any: held for the alias here, held for a callee signature wrapped past four lines in
  Kontor#385, and dropped by the forty-call cap of its function in grovedb#500
  (`bench/acceptance/precheck-shipped.json`). In grovedb#500 the unchanged caller itself was
  reached: three other calls in it were asked about in every run, and read as not governed by the
  requirement. In moltis#1064 and Kontor#385 every call in it was held before a question.
- **Jev reads through a helper it was not shown.** With the decision moved into a helper whose body
  was not sent, Jev answered `returns_error` at 0.92–0.96 in every run of both cases. The helpers do
  pass the failure through, so the reading happens to be right, but nothing Jev was sent
  established it. The version was fixed beforehand as "no confident reading", and it is scored
  against that.

Reproducible from what is committed, without sending anything:

```sh
node bench/acceptance/replay.ts
```

A test compares the table above with that output byte for byte, and the script refuses to print a
table for fewer than two repositories, no defect outside the diff, a branch sent to Jev fewer than
three times, or commits other than the ones each case fixed.

### The case v0.1 was tuned on

One repository (omamori `#468` / PR `#476`), two requirements that state how a failure must be
handled, five branches, one run each: the shipped code, two single-call mutations and two
behaviour-preserving rewrites of the same calls. Each mutation was listed at its own call and
nowhere else; the shipped code and both rewrites listed nothing — ten cells of ten, against a table
fixed before the first request. 76 requests per run, 380 in all, every one to `typesafe/jev` on
Cloudflare Workers AI. TypeSafe's `jev-latest` and Vercel's `typesafe-ai/jev` were not measured, and
may be a different version of Jev.

Reproducible from what is committed, without sending anything:

```sh
node bench/replay-scoring.ts bench/logs/stated-requirements-v1.json
```

The wording of the questions was worked out on these same functions, so this case is a regression
check and does not count as unseen. The same targets asked under PR `#476`'s own sentence did
**not** pass — Jev read the refusal itself as the governed call, not the functions that receive it
(`bench/logs/jev-only-v1.json`). Nothing yet measures a second language or a second kind of
requirement.

## Only Jev

The transport refuses any model but Jev's name on the host it sends to — `typesafe/jev` on
Cloudflare and for `JEV_API_URL`, `jev-latest` on TypeSafe, `typesafe-ai/jev` on Vercel AI Gateway —
before a request is built, so nothing else can be reached from this tool. `test/only-jev.test.ts`
checks it at the transport on every host, and over a whole run against a capturing endpoint and
against a stand-in for each named host.

## Record of the experiments

以下は v0.1 に至るまでの作業記録（日本語）。

---

### 実験用 CLI（2026-09-21）

`docs/selection-materials.md` の続き。もう一枚の選択成績表ではなく、**コードを渡すと根拠付きの
結果が返るコマンド**。

```sh
jev-intent-review --experimental-local-check --base <rev> --head <rev> --intent-spec <file>
jev-intent-review --experimental-local-check --experimental-candidates-only ...   # 何も問い合わせない
```

**利用者は対象ファイル・関数・call ID・期待回答を入力しない。** 製品コードに評価用の名前も
入っていない。

### 経路

候補を出すものが **2 つ**あり、性質が違う。

1. **差分**——変更行を含む関数と、その 1 ホップ先の呼び出し元（`src/plan/from-diff.ts`）。
   これは**探す手掛かり**であって、要件が当てはまるという主張ではない。
2. **要件の語**——既存の字句探索でファイルを開き、計画側のモデルがその中の呼び出しを
   **id で**選び、各選択に「原文のどの節か」を書く（`src/plan/planner.ts`）。

**どちらも他方を却下しない。** モデルが選ばなかったことを理由に差分由来の候補は落とさない。
逆も同じ。

3. どちらが届いた関数も、**中を機械的に広げる**——欠陥は同じ本体の別の呼び出しであることが
   多い（実測: 正しい関数に 3/3、正しい呼び出しに 1/3）
4. **問いを置ける候補だけ判定する**（`src/plan/applicability.ts`）。呼び先の**定義を引いて**
   `Result` を返すと確認できたものだけ
5. **予算は要件ごとに 1 回**、関数を 1 件ずつ回って配る（`roundRobin`）。ファイルごとに
   配っていたのを直した——3 ファイル開いた要件は予算の 3 倍を使えていた

**局所の観測は要件の判定ではない。** **変更行はそこで作業したことを言うだけ**で、要件が
当てはまるとは言わない。観測が要件にかかるかどうかは**対応付け**が決める（下の節）。
**要件全体の判定（VERIFIED）は出さない。指摘が出ても終了コードは 0 のまま**——ただし設定・リポジトリ・エンドポイントの失敗は 0 以外で終わる。
出るのは「**要確認の欠陥候補**」——根拠を全部添えて、読んだ人が否定できる形で。

### 実機の結果（omamori #468 / PR #476）

**base は 5 枝すべて `52a58fa`**——PR #476 が squash された先の親。正例から変異版への差分を
渡すと、変異した場所を探索器に教えることになるので、base を揃える。

変異・挙動不変の 4 パッチは PR #476 の head `e58c04f` にそのまま当たり、**期待挙動を
probe で取り直した**（`bench/fixtures/omamori-468/probe_*.rs`、ディレクトリを植えて観測）。

| 枝 | `read_baseline` の実挙動 | `raw_override_disables` の実挙動 | CLI の観測（同順） |
|---|---|---|---|
| correct | `Err(… is a directory …)` | `Err(…)` | returns_error 0.99 / returns_error 1.00 |
| m-read-baseline | **`Ok(None)`** | `Err(…)` | **returns_success 1.00** / returns_error 1.00 |
| v-read-baseline | `Err(…)` | `Err(…)` | returns_error 0.98 / returns_error 1.00 |
| m-raw-override | `Err(…)` | **`Ok(false)`** | returns_error 0.99 / **returns_success 0.99** |
| v-raw-override | `Err(…)` | `Err(…)` | returns_error 0.99 / returns_error 0.99 |

**10 マスすべて実挙動と一致。** 変異版はそれぞれ自分の対象だけを裏返し、挙動不変版は正例と
同じ。記録は `bench/logs/diff-reach-v1.json`。

到達のほうは**通信なし**で先に確かめられる（`--experimental-candidates-only`）。5 枝とも
関数 23（変更）+ 20（呼び出し元）、問いを置けるもの 37、予算 20 に**両方の対象呼び出しが
入る**。呼び出しの総数だけは枝で違う（correct・m-read-baseline・m-raw-override が 739、
v-read-baseline が 738、v-raw-override が 740）——挙動不変版は書き方を変えているので当然で、
ここを「5 枝とも同じ」と書いていたのは誤り。

| 枝 | 予算内に `read_baseline` | 予算内に `raw_override_disables` |
|---|---|---|
| 5 枝すべて | はい | はい |

#### 正例でも `returns_success` になるマスが 1 つある

`src/integrity.rs · generate_baseline` は **5 枝すべてで returns_success（0.94–0.97）**。
実際のコードが

```rust
if let Ok(content) = crate::atomic_file::read_to_string_capped(&path, MAX_TRACKED_FILE_BYTES) {
```

で、読めなかった hook ファイルを飛ばして続ける。**観測としては、関数が何を返すかについて
正しい。**

**ただしこれを「合法だから指摘しなくてよい」と採点してはいけない。** 実装がそう動くことと、
要件がそれを許すことは別の問いで、後者はここでは答えていない。原文から確定できなければ
`unknown` で残す。

### 途中で見つけて直したもの

**① モデルへ送る一覧が秘匿処理を通っていなかった。** `listingFor` は数百行のソース行を
そのまま出していた。定数に書かれた鍵がちょうどそこに来る。証拠パケットと同じ処理を通す。

**② 予算がファイルごとだった。** 「要件あたり 5 件」が 3 ファイルで 15 件になっていた。
要件全体で 1 回だけ配る。ついでに id をファイル込みにした（`src/config.rs:call-7`）——
素の `call-1` は**別ファイル同士が同じ id** になり、片方の選択がもう片方の一覧に解決する。

**③ 本体が切れていても答えを採っていた。** `evidence.cut.own` が真なら、半分だけの本体
についての答えになる。理由付きで保留する（実機で 1 件発火: `verify_chain`）。

**④ `#[cfg(all(test, unix))]` がテスト領域として認識されていなかった。**
`/^\s*#\[cfg\(test\)\]/` しか見ておらず、**プラットフォーム条件が付いた test モジュールが
製品コードとして読まれていた**。omamori では 1 箇所、しかも PR #476 が追加したファイル。
実機で気づいた——`a_fifo_is_refused_rather_than_waited_on` が候補に出ていた。
これは `enumerate` だけでなく `realDefinitions`（証拠の構築）と適用検査も使う関数なので、
通常のレビュー経路にも効く。

**最初の直し方は行き過ぎていた。** 「行のどこかに `test` があれば除外」にしたので、
`#[cfg(any(test, feature = "production"))]`——その feature が有効なら**通常ビルドで使われる
コード**——まで消していた。今は**テスト専用と確認できる式だけ**除外する:
`all(...)` はどれか 1 つがテスト専用なら全体もそう、`any(...)` は全部がそうでなければ違う、
`not(...)` と判別できない式は**残す**。消しすぎるほうが悪い——**無いものは誰も報告しない**。

**⑦ 質問文が秘匿処理を通っていなかった。** 1 回のリクエストは**パケットと質問の両方**だが、
清めていたのはパケットだけ。`conditionFor` は呼び出し式をそのまま質問文に埋めるので、
引数に機密らしい文字列があると**何も触らない欄から出ていく**。`locateCall` が生の式で
照合していた間は保留されて表に出なかっただけで、それ自体が別の欠陥だった。
条件も照合も同じ秘匿済みの式を使う。**レポートの印字も同じ**——レポートは配布物なので。

**⑤ 予算に入った呼び出しだけがレポートに出ていなかった。** `--experimental-candidates-only`
は「どれが予算に入るか」を答えるためにあるのに、**選ばれたものだけが印字されない**形に
なっていた。最初の実機確認で「対象に届いていない」と読み違えた——届いていた。

**⑥ 計画が答えなかったのか、該当なしと答えたのか区別できなかった。** `modelPlanner` の
`catch` が `{picks: []}` を返していた。今は理由を持って返す。**この修正が最初に出した答えが
これ**——

```
the planner did not answer about src/audit/mod.rs (… answered 429: … you have used up your
daily free allocation of 10,000 neurons …), so no call there carries a clause
```

### Jev 以外に何も送らない（2026-09-21）

**この道具は Jev に小さな型付きの問いを聞くもの**なのに、一般の instruct モデル（llama-3.3-70b）
を 3 箇所で使っていた。要件のコンパイル（元から）、計画（#26 で私が）、対応付け（#28 で私が）。
どれもその場では妥当に見え、**どれも宣言されていなかった**。

| 直し | 中身 |
|---|---|
| 送信境界で拒否 | `CloudflareClient.post` が `typesafe/jev` 以外を**組み立てる前に**拒む。CLI も bench も同じ経路を通る。件数にもバイト数にも数えない |
| 要件のコンパイル | モデルに書かせない。`--intent-spec` か、**コードで読める受け入れ条件の箇条書き**。それ以外の散文は理由と使える 2 つの形を案内して止まる |
| 計画 | **廃止**。候補は差分・参照探索・適用検査・予算配分だけで作る（要件の語でファイルを開く経路も消えた） |
| 対応付け | **Jev の 3 択**（`applies` / `does_not_apply` / `unknown`）。確率分布を全部保存し、採用規則は実測前に固定（`applies` かつ 0.6 以上） |
| 引用と説明 | **別モデルを残さない**。引用は入力原文そのもの、説明は原文・コード位置・仮定・2 つの答えから定型的に組み立てる。**モデルが書いたようには表示しない** |
| CI | 実 API を使わず、**送信された全ボディのモデル名**を読む。実験経路を通しで走らせて全件 Jev を確認 |

**消えた欠陥が 1 つある。** Jev の回答に `callId` は無いので、「別の呼び出しへの回答が結合する」
（#29）という形が**検査されるのではなく存在しなくなった**。Jev は送った state について、
送った問いに答える。

**引用を原文に照合する検査も要らなくなった。** モデルが断片を選ぶからこそ必要だった検査で、
引用が要件そのものなら照合するものが無い。

### 対応付けを Jev に聞いた最初の実測（2026-09-21、正例、PR #476 の原文）

```
asked 19, mapped 19, governed 3, findings 0
```

**既知の 2 対象は、どちらも `does_not_apply`**（0.51 / 0.63）。Jev が `applies` と読んだのは
`reject_non_regular`（0.90 / 0.77）——**拒否そのもの**を行う呼び出し。原文は
「a path omamori reads **is now refused by name**」と書いていて、拒否を受け取った側が何を返すかは
書いていない。**関門は NOT READY、残り 4 枝は送っていない。**

**この結果は変更しない。** 下は**別の評価入力**での測定で、原文の忠実な言い換えではないし、
原文からの推論が成功したとも主張しない。

### 失敗時の扱いを明示した要件での実測（2026-09-21）

確かめたのは「**利用者が失敗時の扱いを明示した要件を、この CLI が検査できるか**」。

入力（`bench/fixtures/omamori-468/stated-failure-handling.spec.json`、**関数名・ヘルパ名・
call ID・期待回答は書いていない**）:

> **R1** If reading an existing integrity baseline fails, the baseline-loading operation must
> return an error to its caller. It must not return a successful result saying that no baseline
> exists.
>
> **R2** If reading an existing configuration file fails while checking whether a rule override
> disables a rule, that check must return an error to its caller. It must not return a successful
> result saying that the rule is not disabled.

**条件と期待結果は最初の 1 リクエストより前に保存した**（ツール commit `ee35665`、base は 5 枝
とも `52a58fa`、予算 20、閾値 0.6、モデルは `typesafe/jev` のみ）。通信なしの候補確認で、
**両対象が 5 枝 × 2 要件すべてで予算内**にあることも先に確認した。

採点の単位は**要件 ID・ファイル・関数・呼び出し式**。関数名だけでは判定しない。

#### 結果: 10 マスすべて一致

| 枝 | R1 `read_baseline` | R2 `raw_override_disables` |
|---|---|---|
| correct | 指摘なし（applies 0.97 / returns_error 1.00） | 指摘なし（applies 1.00 / returns_error 1.00） |
| m-read-baseline | **指摘あり**（applies 0.96 / **returns_success 1.00**） | 指摘なし（applies 1.00 / returns_error 1.00） |
| v-read-baseline | 指摘なし（applies 0.98 / returns_error 1.00） | 指摘なし（applies 1.00 / returns_error 1.00） |
| m-raw-override | 指摘なし（applies 0.98 / returns_error 1.00） | **指摘あり**（applies 1.00 / **returns_success 0.99**） |
| v-raw-override | 指摘なし（applies 0.98 / returns_error 1.00） | 指摘なし（applies 1.00 / returns_error 1.00） |

**変異版はそれぞれ自分の対象にだけ指摘が出て、もう一方は静か。** 正例と挙動不変版は両方とも
静か。**採点対象外の指摘は 0 件**（他の呼び出しには 1 件も立たなかった）。

各 run は **76 要求**（2 要件 × 19 呼び出し × 2 問）、5 枝で **380**。
記録は `bench/logs/stated-requirements-v1.json`——入力 spec、実行前に固定した条件、
**5 枝 × 2 要件の全 38 呼び出しについて対応付けと観測（全選択肢の確率つき）**、全 finding、
種類別の未確認件数、note。**採点はこのファイルだけで再現できる**:

```sh
node bench/replay-scoring.ts bench/logs/stated-requirements-v1.json
```

証拠パケット（送った関数本体）は保存していない——固定コミットの git オブジェクトから
再構成できるため。秘匿処理は保存物にもそのまま効いている。

#### 関門で直したもの

正例の関門が **`requirements[0]` だけを読んでいた**。要件が 2 つある spec では R2 の対象が
R1 の答えで採点される。要件 ID ごとに照合する形に直した。

もう 1 つ、**正例に対象の指摘があっても、対応付けが usable なら READY になっていた**。
正例は他の 4 枝を比べる基準なので、そこで指摘が立っていれば表はもう壊れている。
**両方（使える対応付け・指摘なし）**を要求する形にし、手書きのログで回帰テストにした。

#### 言えること

**失敗時の扱いを明示した要件について、場所を利用者が指定せずに、既知の欠陥候補まで到達した。**

これは既知の 2 対象についての採点で、1 リポジトリ・2 要件・各枝 1 回。
`bench/logs/jev-only-v1.json` の原文による測定は NOT READY のまま残してある——
**原文の言い換えが成功したのではなく、別の入力で成立した**ということ。

### 列挙そのものが取りこぼしている量

上限を note に出すようにしたら、**1 関数 40 件の上限で 261 件の呼び出しが落ちていた**ことが
分かった（7 ファイル、`src/integrity.rs` だけで 80 件）。加えて、変更された関数への参照
**84 件**が「この経路が読む関数の中に無い」（`use` 行・`impl` のメソッド・マクロ本体）。
対象 2 件には届いているが、**列挙は完全ではない**。数えられていなかった間は、
短い一覧と短いファイルの区別が付かなかった。

### 節（clause）はモデルの文である

`clause` は**モデルの散文がそのまま Markdown に入る唯一の欄**だった。schema には
`maxLength: 300` があるが、`readModelJson` は `JSON.parse` するだけで**強制していない**。
改行 1 つで箇条書きが崩れるし、バッククォートでコードスパンを開ける。

そして**この経路が違反を出さないことを製品側で保証しているのは、`describe()` に判定の欄が
無いことだけ**——`clause` は判定の文がそのまま収まる欄だった。

意味で弾くことはできない（節は原文を引用するので「silently treated as…」のような語が正当に
入る）。なので**封じ込める**: 1 行・300 字・コードスパンなし、そして
`The plan said this call checks: "…"` と**引用して誰の文かを示す**。

### 測っていないこと

**節（clause）は今回 1 件も付かなかった。理由は 2 つあり、片方は確定している。**

**確定しているほう: 計画に対象のファイルを見せていない。** 計画へ渡すファイルは今も
`filesFor` だけで決めていて、渡したのは `src/audit/mod.rs` と `src/actions.rs`。
観測できた対象がある `src/config.rs` と `src/integrity.rs` は**渡していない**。
したがって**枠が戻って再実行するだけでは、対象の節は付かない**。

**もう片方: 5 回とも `picks: []` で、理由が記録されていない**（⑥ の修正より前）。理由を出す
ようにして再実行したら 429——その日の無料枠切れ。断ったのか落ちたのかは**分からない**。

判定側の要求は全部通っている（各実行 19 観測）ので、上の表は影響を受けない。
なお、散文の節が 1 つ付いたとしても、それ自体は**要件への対応が正しい証拠にはならない**。

したがって**この段階で示せたのは「欠陥箇所の挙動を自動で観測できる」ところまで**。
観測を根拠付きの指摘へ結ぶには、節が付くことを測る必要がある。

計画に聞くのは**要件の語が開いたファイルだけ**で、変更されたファイルには聞いていない
（要件との対応付けと候補列挙を分けるため）。今回そこは重ならなかった——原文は症状
（FIFO・ディレクトリ・symlink）を名指し、機構は共有の読み取りヘルパで、語では届かない。

**要件が N 件あると、差分由来の同じ呼び出しを N 回判定する。** 問い自体は要件を含まないが、
証拠パケットには要件が入っているので、答えを要件をまたいで使い回してよいかは**測っていない**。
問いを置けるかどうかの判定（`applicabilityOf`）は commit だけで決まるので 1 回にした。
残りを直すなら、差分由来の集合を 1 回だけ判定して各要件のレポートに付ける形になる。
今回の実測は要件 1 件なので、**この形はデータに出ていない**。

`--intent`（自由文）だと要件を書くモデルが毎回別の文に直すので、**開くファイルが run ごとに
変わる**。比較するときは `--intent-spec` で固定する。

### 終了条件に対して

| 条件 | 状態 |
|---|---|
| CLI から両ケースの変異した呼び出しへ届く | **満たす**（5 枝すべて、通信なしでも確認） |
| 正例・変異版・挙動不変版を区別できる | **満たす**（10 マス全部が実挙動と一致） |
| 対応付けから根拠付きの欠陥候補を返す | **通信なしで満たす**。実機は対応付けのモデルが 429 で未達 |
| 正例・挙動不変版に誤った違反を出さない | **検査していない**（下記） |
| 未対応・適用未確定・予算外が理由付きで残る | **満たす**（正例で 720 件、種類別に集計） |
| 個別の関数名・正解ラベルが製品側に無い | **満たす**（`src/plan/` と `src/review/local-check-run.ts` に固有名詞は無い） |

3 行目を「満たす——この経路は違反を報告しない」と書いていたが、**それは検査ではない**。
前件が構造上偽にならないので、何を測っても満たす。実データで誤検知に一番近いのは
`generate_baseline` の 5 枝 `returns_success` で、上に書いたとおり**観測としては正しい**。
誤った違反を出さないことを本当に測れるのは、観測が指摘に変わってから。
