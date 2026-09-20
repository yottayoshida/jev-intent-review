# 実要件 1 件を、実コードで確かめた記録（2026-09-20）

これまでの局所問の実験は、測定のために書いたコードを測っていた——`collect_listing` を bench に
写したもの、読み取りループを wrapper に移したもの。今回は**調整に使っていない実要件を 1 件選び、
実リポジトリの実関数に、既存の証拠生成を通して当てた**。

指示は `docs/next-step-real-requirement.md`。計画は `bench/plans/omamori-553-r2.json`
（**送信前に書いた**。回答を見てからの変更はしていない）。実行器は
`bench/real-requirement-check.ts`、ログは `bench/logs/real-requirement-v3.json`。
ログからの再集計は `node bench/recount.ts <log>`（API 呼び出しなし）。

このファイルは `docs/local-check-design.md` の続きで、言語もそちらに合わせている。

## 結論を先に

**実関数では外れた。統合へは進まない。**

正しい実装と挙動不変版は 3/3 で読めた。**本物の欠陥を入れた変異版は 0/3 で読めず、3 回のうち
1 回は閾値を越えて「性質を満たす」と判定した**。診断の結果、誤答を運んでいたのは問いの文面でも
要件文でもなく、**`buildEvidence` が引き込む関連証拠**だった。

## 1. 何を選び、なぜそれか

| 項目 | 内容 |
|---|---|
| 要件 | **omamori#553 R2** — 一次資料は [PR #553](https://github.com/yottayoshida/omamori/pull/553) の Summary、発端は [issue #485](https://github.com/yottayoshida/omamori/issues/485) |
| 原文の性質 | 「`omamori doctor` reports `[Staging] empty` or a file count only for a staging directory it read in full. Otherwise it says `[Staging] cannot read: …`（以下略）」 |
| 対象 | `src/cli/doctor.rs` の `staging_info_from`、固定コミット `916d954` |
| 列挙操作 | 引数 `entries: impl Iterator<Item = std::io::Result<OsString>>` |
| 対応の根拠 | 同じ PR 本文が「`doctor`'s staging section reads through `staging_info_at` / `staging_info_from` (an iterator seam…)」と機構を名指しし、読み切れない経路の筆頭に "listing stopped" を挙げている |

**使用歴**（隠さずに書く）: omamori#553 **R1** は `bench/local-check.ts` で `collect_listing` を
測るのに使った。**R2 は未使用**、`staging_info_from` はどの bench にも出ていない。同じ PR・同じ
issue の**別の節・別の関数**であって、無関係な事例ではない。

**corpus の要件は原文として扱っていない。** `bench/corpus/omamori-553.spec.json` の R2 は
要件生成モデルの出力を機械修復したもので、文の途中（「…and a」）で切れており正解ラベルも無い。
送った本文は PR 本文からの逐語引用。

**なぜ他ではないか**: omamori で「列挙の失敗を関数の成功として返さない」を原文が要求している
issue は #485 と #470 の 2 件しかなく（本文に `read_dir` / `.lines()` / `per-entry` 等を含む
issue を全件走査して確認）、#470 は `show_entries` として既に使用済み。関数側から見ても、
`Result` を返して Result の iterator を回す関数は omamori に 4 つだけ
（`remove_dir_if_empty` 7 行 / `staging_info_from` / `show_entries` / `verify_chain` 762 行）。

## 2. 送る前に固定したもの

**問いは新しい版（v3、`bench/check-questions-v3.ts`）。** 返す結果の選択肢を排他の 3 つにした:

```
returns_error / returns_success / cannot_determine
```

v2 は `an_error` / `a_success_with_what_it_had` / `a_success_with_nothing` / `cannot_determine`
で、**うち 2 つがどちらも成功**だった。性質は「失敗か成功か」なので、成功値が空かどうかで
点が割れるのは採点の欠陥で、実際に v2 で割れた。**v2 の成績は v3 の成績ではない**ので、
既知ケース 2 件で回帰を取り直している。

**制御の問いは残したが集約に入れない。** `verdictOfV3` は結果の問いしか読まない。

**採点は 2 本**: 選択肢が合ったか／合ったうえで 0.6 を越えたか。閾値は 0.6 に固定し、
結果を見てから動かしていない。

**条件**（テンプレートは固定、データだけ対象ごと）:

> `code` を読む。**次だけを前提にする**: `dir` is a path and the function has just been entered.
> The iterator `entries` returns `Err(io_error)` at one iteration. Every other operation the
> function reaches succeeds. The iterator is finite. この条件で: 呼び出し元へ何を返すか。

「伝播する」「べき」は条件に入れていない（テストで検査している）。**エラーの位置は固定していない**
——v3 の選択肢では、`Err` が何番目でも正しい版は `Err`、変異版は `Ok` なので性質が一意に決まる。
v2 で位置を固定しなかったのが問題になったのは、選択肢が排他でなかったからだった。

**要求数**: 1 回の judge = 1 HTTP。計画 15（回帰 6 + 対象 9）、再試行 0、上限 30 は
`CloudflareClient` の `maxRequests` に渡して製品側に守らせた。実績は **15/30、81 KB**。

## 3. 4 条件と、ローカルでの事前確認

変異版・挙動不変版は**実リポジトリの隔離した複製の上の 1 コミット**。モデル用に書き直したコードは
1 行も無い。

| 条件 | 中身 | 性質について期待 |
|---|---|---|
| 正しい実装 | `916d954` のまま。`collect_listing(entries).map_err(…)?` | 満たす |
| 変異版 | `Err(stop) => stop.seen` ——止まった listing を成功として返す | 違反 |
| 挙動不変版 | `oldest_mtime` の選び方を `map_or(mtime, |prev| prev.min(mtime))` に | 正しい実装と同じ |
| 証拠を削った版 | 同じ関数、`maxPrimaryChars` を本体より小さく | UNKNOWN |

**Jev に聞く前に `cargo test --lib` を 3 ブランチで走らせた**（隔離した複製、`CARGO_TARGET_DIR`
はリポ外）:

| ブランチ | 結果 |
|---|---|
| correct | 1458 passed / 0 failed |
| variant | **1458 passed / 0 failed** — correct と同一。「挙動不変」はこれで言う |
| mutant | **1457 passed / 1 failed** — 落ちたのは `staging_listing_that_stops_partway_is_reported_as_unreadable` ただ 1 本で、`got "  [Staging] empty\n"` |

つまり変異は**実際にその列挙で起き、観測できる結果を変え**、しかも変えた先が
**issue #485 が報告したその文字列**だった。1459 本中 1 本だけが変異版を分けるので、最小の差分でもある。

証拠の切り出しは `DRY_RUN=1`（送信なし）で先に確認した——3 版とも
`src/cli/doctor.rs` の `staging_info_from` の本体が入り、判別する行
（`map_err(|stop| …)?` と `Err(stop) => stop.seen`）がそれぞれ正しく出ている。

## 4. 局所の観測（第 1 段階）

| ケース | 答え | 選択肢一致 | 0.6 も越えた | 判定一致 |
|---|---|---|---|---|
| 回帰: `collect_listing` 正しい版 | `returns_error` 0.99 | 3/3 | 3/3 | 3/3 |
| 回帰: `collect_listing` 止まるが成功を返す | `returns_success` 0.99 | 3/3 | 3/3 | 3/3 |
| **実関数 正しい実装** | `returns_error` 0.96-0.98 | 3/3 | 3/3 | 3/3 |
| **実関数 変異版** | **`returns_error` 0.51 / 0.60 / 0.53** | **0/3** | **0/3** | **0/3** |
| **実関数 挙動不変版** | `returns_error` 0.97-0.98 | 3/3 | 3/3 | 3/3 |
| 実関数 証拠を削った版 | **要求を送らずローカルで UNKNOWN**（`cut.own`） | — | — | 期待どおり |

回帰の 2 件は `bench/logs/local-check.json` からコード文字列を読み、**記録されたハッシュと
照合してから**送っている（文字列がずれないため。実装差でこの検査が一度発火し、直した）。

**変異版の 0.60 は閾値を越えて `property_holds` になった。** 本物の欠陥を「満たす」と言った回が
3 回に 1 回ある、ということ。向きが悪い。

**制御の問い（集約に入れない）**: 正しい版・挙動不変版は `stops_there` 0.99-1.00。変異版も
`stops_there` 0.97-0.99 だった。**ここで計画側の誤りが 1 つ見つかった**——変異版の制御の期待を
`keeps_going` と書いていたが、`collect_listing(entries)` が iterator を消費して最初の `Err` で
止まるのは**両版とも同じ**で、変異版が変えるのは止まったあとの扱いだけ。正解は `stops_there` で、
モデルの答えのほうが正しい。**計画は書いたまま残し、直していない**（集約に入らないので判定は動かない）。

## 5. 性質の判定（第 2 段階）

原文のどの節について、どの範囲で何が言えるか。

- **言えること**: 固定コミット `916d954` の `staging_info_from` は、`entries` が `Err` を返し
  他の操作が成功する条件で、**成功を返さない**。局所の答えは 3/3 で `returns_error`、0.96-0.98。
  挙動不変版でも同じ。
- **言えないこと**: **この計画は、同じ性質が破れている版を検出できなかった。** 検出できない
  計画が正しい版に○を付けても、その○は「読んだ」ことの証拠にならない。**したがって、上の
  「言えること」も局所の答えとして記録するだけで、要件の充足として扱わない。**

これは VERIFIED を出す条件を満たしていない。件数を目標にしていないので、ここで止める。

## 6. 元の要件の状態（第 3 段階）

原文の性質のうち、**確認したのは 1 節だけ**:

- ✅（局所の答えとしてのみ）`entries` が失敗したとき `staging_info_from` が成功を返さないこと

**確認していない**（いずれもこの run の対象外）:

- 表示そのもの。`[Staging] cannot read: …` と `[Staging] empty` を作るのは `staging_section_text`
- `--json` の形（`summary.staging.status`、null の件数、パスを含まない reason）
- 読み切れない他の 5 経路——list できない / lstat できない / symlink / ディレクトリでない /
  HOME が解決できない。どれも `staging_info_at` 側で、今回判定した関数の中には無い
- 一覧された staging ファイルを stat できない場合（`entry_unreadable`）。要件の一部だが、
  条件の「他の操作は成功する」で今回は除外している
- `fold_key_dir_entries`（同じ PR が変えた鍵ディレクトリ側の継ぎ目）
- staging prune の件数パスと `gc_stale_temps`（同じ PR 本文が挙げている）

## 7. なぜ外れたか（診断、`bench/logs/real-requirement-v3-diagnostic.json`）

**これは初回測定ではない。** 結果を見てから走らせた別の版で、packet の中身を振って、誤答を
どの部分が運んでいるかを特定する。上の測定・計画・問いは一切変えていない。

疑いは 2 つで、**予測を先に表にしてから**走らせた:

| ケース | 要件文が漏れているなら | 関連証拠が効いているなら | どちらでもないなら | 実測 |
|---|---|---|---|---|
| 変異版・要件文を伏せる | returns_success | returns_error | returns_error | **returns_error 0.48-0.58** |
| 変異版・関連証拠を空に | returns_error | returns_success | returns_error | **returns_success 0.65-0.71** |
| 対照: 正しい版・要件文を伏せる | returns_error | returns_error | returns_error | **returns_error 0.98-0.99** ✓ |

**言えるのはここまで**: 要件文（「読み切れなければエラーを報告する」）を伏せても変異版の答えは
変わらない。**関連証拠を「まとめて」空にすると、変異版は 3/3 で `returns_success` に変わる。**

> **訂正（2026-09-20、この節の初版に対して）。** 初版はここで「関連証拠だった。`collect_listing`
> と `staging_info_at` について答えている。同じ packet で両方は聞けない」と書いた。**断定しすぎで、
> 測定はそこまで分けていない。** 下に実際の中身を置く。

**関連証拠 4 件の実際の中身**（診断ログの `state` から。初版はこれを数えずに書いた）:

| 入っていたコード | 役割 | 件数 | 大きさ |
|---|---|---|---|
| `src/cli/doctor.rs:663-695` `staging_info_at` | 呼び元 | 1 | 1235 字 |
| `src/cli/doctor.rs:2569-2593` `staging_listing_that_stops_partway_is_reported_as_unreadable` | **期待値を書いたテスト** | **2（同じ関数の重複）** | 各 1064 字 |
| `src/util.rs:317-328` `collect_listing` | 呼び先 | 1 | 355 字 |

**そのテストは、変異版で落ちたテストそのもの**で、中に
`assert_eq!(json["status"], "error")` と `assert_eq!(json["reason"], "listing_stopped")` が
書いてある。**「この実装はエラーを返すはず」という期待値が、実装の挙動を読むための証拠に
混ざっていた。** しかも量では関連証拠の過半（2128 / 約 3700 字）を占める。

**重複の入り口**: `builder.ts` の定義収集（`realDefinitions`）はテスト領域を除外するが、
**呼び出し箇所の収集（`outside`）は除外していない**。同じテスト関数の中の 2 か所の呼び出しが、
どちらも同じ囲みブロックに解決され、そのまま 2 回 push される。固定コミットから証拠を
作り直しても同じ構成になる。

したがって**未特定のまま**なのは:

- 呼び元（`staging_info_at`）への取り違え
- 呼び先（`collect_listing`）への取り違え
- **テストの期待値への追従**
- その重複による重み
- 複数の組み合わせ

なお、関連証拠を外しても変異版の確信は 0.65-0.71 で、正しい版の 0.98-0.99 より低い。非対称は残る。

**「関連証拠を外す」は直し方として未検証でもある。** 診断の対照は「正しい版＋要件文を伏せる」で
あって「**正しい版＋関連証拠を空に**」は測っていない。正しい版で「`entries` の失敗が
`collect_listing` の `Err` になる」を読むには呼び先の挙動が要るので、一律に外すとその参照先まで
落ちる。外して正しい版がどうなるかは、まだ分かっていない。

## 8. 次にどうするか

指示が実行前に固定した規則に従う:

> 人が条件を書いても実関数では外れるなら、失敗した packet とケースを保存し、統合へ進まない。

**統合へ進まない。** 通常のレビューを局所問に切り替える根拠は無い。

> **訂正（2026-09-20）。** 初版はここで「失敗した packet はログに全文が残っている
> （`real-requirement-v3.json` の各 run に `state` として）」と書いた。**嘘だった。**
> 初回ログの target 9 run は `state` を持たない——保存しているのは `located` / `cut` /
> `sent`（上限と related のパス一覧）/ 全回答だけで、送った本文は入っていない。`state` が
> あるのは診断ログのほう（3 ケース分）。`real-requirement-check.ts` の保存処理が packet を
> 書いていなかった。
>
> 以後は**送信した秘匿処理済み packet とその hash を run ごとに保存する**（この PR で修正）。
> 初回の 9 run 分は当時の送信記録が無いので、**再構成したものを当時の記録として扱わない**
> ——固定コミットから作り直したものが要るときは、別のファイルに「再構成」と明記して置く。

閾値を上げれば変異版の 0.51-0.60 は全部 UNKNOWN になり、偽の「満たす」は消える——が、これは
**結果を見たあとの数字いじり**なので採らない。記録だけ残す。

この失敗は開発用のケースになった。**次は「まだ使っていない別の実要件」ではない。** まず
この正しい版・変異版を使って、**問いに必要な証拠を選ぶ規則**を決める——関連証拠を
「現状」「テストだけ除外」「必要な呼び先だけ」「関連なし」の 4 条件で比べ、上に挙げた未特定の
内訳を分ける。「関連なし」は診断用の条件で、採用候補にはしない（呼び先が要るため）。
規則が決まってから、未使用の実要件へ進む。**この開発用ケースでの改善は、一般化の成功に数えない。**

**今回の 3 版は再現できる形で残した。** ブランチを作ったのは 7 日で消える一時ディレクトリなので、
そこに置いたままでは「残した」が偽になる——ログのときと同じ形の欠陥だった。実体は
`bench/fixtures/omamori-553-r2/`（公開コミットに当てる 2 本のパッチと、その挙動差の実測値）。
