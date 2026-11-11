# design.md の危険箇所の Quint / TLC 検査

`docs/design.md` のプロトコルのうち、壊れると直列化可能性・原子性・データ損失につながる 6 箇所を Quint でモデル化し、TLC で有限モデルを全探索した。

注意: ここでの「全探索で違反なし」は、**各モデルに書いた小さな定数 (シャード 2、取引 2〜3、キー 4、時刻は小さな整数) の範囲で反例が存在しない**ことを意味する。任意サイズの証明ではない。M4 だけは Apalache で帰納的不変条件も確認した (こちらは定数の範囲内で帰納的であることの証明になる)。

## 実行

```sh
cd specs
./check.sh            # green の全探索 + red の反例確認 + witness + run テスト + M4 の帰納的不変条件
HEAVY=1 ./check.sh    # 加えて M1 を取引 3 件で全探索 (数分〜)
```

個別には `export JAVA_HOME=$PWD/.tools/jdk PATH=$PWD/.tools/jdk/bin:$PATH` の後、

```sh
npx quint verify --backend=tlc --main=m1_green --invariant=serializable m1_serializable_commit.qnt
npx quint test   --main=m1_red_g m1_serializable_commit.qnt
npx quint run    --main=m1_red_g --invariant=serializable --mbt --out-itf=traces/x.itf.json m1_serializable_commit.qnt
```

red と green は同じ core モジュールを `const` フラグで切り替えたインスタンスである (`import m1_core(RED_A = true, ...)`)。モデルの整理で危険な条件を消してしまわないよう、各 red の反例は `run xxxTest = init.then(...).expect(not(inv))` の決定的テストとしても固定している。`traces/` には `quint run --mbt` で出力した ITF トレース (各状態に `mbt::actionTaken` と `mbt::nondetPicks` が付く) を置いた。実装への再生に使える。

## 結果一覧

| モデル | invariant | 定数 | 到達状態数 (distinct) | 深さ | 結果 |
|---|---|---|---|---|---|
| M1 `m1_green` | `serializable` | 2 shard, 4 key, 2 txn, tick 上限 2 | 635,205 (生成 1,362,029) | 19 | No violation |
| M1 `m1_green3` | `serializable` | 同上、3 txn | 25 分で打ち切り: 2.4 億 distinct、キュー 4,000 万 | 19 (未完) | 未完 (違反は見つかっていない。完全探索ではない) |
| M1 `m1_red_a`〜`e`, `g` | `serializable` | 同上 | 各 3〜30 万で反例 | 13〜14 | 反例 (6 本すべて) |
| M2 `m2_green` | `atomicVisibility` | M1 と同じ | 635,205 | 19 | No violation |
| M2 `m2_red` | `atomicVisibility` | 同上 | 295,642 で反例 | 13 | 反例 |
| M3 `m3_green` | `recovery` | 参加者 2、restart 2 回まで | 12,488 | 22 | No violation |
| M3 `m3_red` | `recovery` | 同上 | 3,612 で反例 | 12 | 反例 |
| M4 `m4_green` | `commitAfterRead` | 時計 0..3、T 0..3、commit 2 回 | 226 | 8 | No violation |
| M4 `m4_green_lease` | `commitAfterRead` | 同上、LEASE 2 | 394 | 8 | No violation |
| M4 `m4_green` | `inductive ⇒ commitAfterRead` | 同上 | (Apalache) | | 帰納的不変条件を確認 |
| M4 `m4_red` | `commitAfterRead` | 同上 | 252 で反例 | 8 | 反例 |
| M5 `m5_green` | `splitSafe` | key 2、write 3、intent 2、worker 2 | 14,592 (生成 68,013) | 8 | No violation |
| M5 `m5_red_switch` / `m5_red_intents` | `splitSafe` | 同上 | 反例 | | 反例 |
| M6 `m6_green` | `watermarkSafe` | shard 2、SKEW 1、MARGIN 2、DELAY 1、now 0..6、write 2/shard | 34,053,946 (生成 1.9 億、251 s) | 22 | No violation |
| M6 `m6_red_dirty` / `m6_red_resolved` / `m6_red_skew` | `watermarkSafe` | 同上 (skew は SKEW 2) | 反例 | | 反例 |
| M6 `m6_red_skew` | `watermarkSafeOrDetected` | SKEW 2 | 90,863,609 (569 s、HEAVY) | 24 | No violation (遅延検出で補える) |
| M5b `m5b_green` | `migrationSafe` | P/C、group 2、write 2、intent 1、worker 2、tick 2、T 0..6 | 9,512,226 (生成 9,356 万、112 s) | 22 | No violation |
| M5b `m5b_red_s3` / `_s3_parent` / `_p2` / `_p2_window` / `_intents` | `migrationSafe` | 同上 | 反例 | | 反例 (5 本すべて) |
| M5b `m5b_green_range` | `migrationSafe` (`noWriteBelowRead` を含む) | 同上で T 0..3、答えた読みの時刻を覚える、範囲の移動を終える手順あり | 8,306,186 (76 s) | | No violation |
| M5b `m5b_red_range` | `noWriteBelowRead` | 同上、移動を終えるときに親の時計を子へ渡さない | 25,013 で反例 | | 反例 |
| M7 `m7_green` | `restoreCorrect` | shard 2、APPROX 1、MARGIN 1、now 0..4、write 2/shard | 46,114,036 (生成 1.5 億、123 s) | 26 | No violation |
| M7 `m7_red` | `restoreCorrect` | 同上 | 反例 | | 反例 |

| M1b `m1b_green` | `serializable` / `atomicVisibility` | M1 + read-time refresh、2 txn、tick 2 | 741,431 (生成 1,639,085) | 21 | No violation |
| M1b `m1b_green_bump` | `freshReadPicked` (claim 3、修正案あり) | 同上 | 720,951 | 21 | No violation |
| M1b `m1b_green` | `freshReadPicked` (claim 3、修正前) | 同上 | 反例 | | 反例 (autocommit の 1 シャード読み) |
| M1b `m1b_green_bump` | `freshReadSeq` (claim 3、取引の 2 文目) | 同上 | 反例 | | 反例 (範囲外) |
| M1b `m1b_red_ra` / `m1b_red_rc` | `serializable` | (a) は 3 txn・tick なし (深さ 14 で反例)、(c) は 2 txn | 反例 | 14 / 13 | 反例 |
| M1b `m1b_red_rb` | `serializable` | 2 txn | 746,359 | 21 | No violation (保守的で安全) |
| M8 `m8_green` | `fcw` | key 2、commit 3 回、prune / DROP / restart | 387 | 8 | No violation |
| M8 `m8_red_drop` | `fcw` | 同上 | 反例 | | 反例 |
| M8 `m8_red_latest` | `fcw` | 同上 | 387 | 8 | No violation |

| M9 `m9_green` | `protocolSafe` (= serializable ∧ atomicVisibility ∧ writeSerial ∧ noDeadlock ∧ atomicWrites)、`noLostWakeup`、`noYoungDie` | 2 txn、11 テンプレート、tick 1、ロック TTL / 再起動 / 待ち行列あり | 1,365,302 | 22 | No violation |
| M9 `m9_red_*` (9 本) | `protocolSafe` / `noYoungDie` | 同上 | 反例 | | 反例 |
| M9 `m9_green3` | `noLostWakeup` | 3 txn、他は `m9_green` と同じ | 2.2 億以上 (未完了) | 16 まで全探索 | 違反なし。深さ 17 の途中でディスク (約 42 GB) が尽きて中断。全探索の証明ではない。`check.sh` には含めない |
| M9 `m9_green3` (ランダム探索) | `noLostWakeup` | 同上。`quint run --max-steps=40 --max-samples=3000000` | 約 300 万本の経路 (最長 33 手) | | 違反なし。同じ設定で `m9_red_leave_silent` の反例は 6 秒で見つかる |
| M9 `m9_impl_wake` / `m9_red_leave_silent` | `noLostWakeup` | 実装どおりの起こし方 / 去るとき起こさない (3 txn) | 反例 | | 反例 (実装の欠陥) |
| M10 `m10_green` | `safe` (= noCommitAfterIgnored ∧ noLostCommit) | 取引 2 件、時計 0〜6、保持 R = 3、受付年齢 G = 1、anchor 再起動と COMMIT の再配送あり | 94,653 | 25 | No violation |
| M10 `m10_red_*` (3 本) | `safe` | 年齢の検査なし / 適用前の記録を消す / G ≥ R | 反例 | | 反例 |
| M11 `m11_green` | `schemaSafe` (= indexComplete ∧ noDangling ∧ uniqueSafe ∧ noLostWrite ∧ noResurrect) | shard 2、行 2、値 0〜2、取引 2 件、DDL は CREATE INDEX (グローバル) 1 本、修正案あり | 790,150 (生成 2,564,343、7 s) | 21 | No violation |
| M11 `m11_green_unique` | `schemaSafe` | 同上、DDL は CREATE UNIQUE INDEX | 643,171 (生成 2,143,445、5 s) | 21 | No violation |
| M11 `m11_green_unique_colocated` | `schemaSafe` | 同上、2 行とも S1 (取引は 1 シャードだけ) | 36,495 (生成 118,777、2 s) | 15 | No violation |
| M11 `m11_green_recreate` | `schemaSafe` | DDL は DROP TABLE と CREATE TABLE (作り直し) | 175,899 (生成 447,925、3 s) | 17 | No violation |
| M11 `m11_fix_recheck_only` / `m11_fix_drain_only` | `schemaSafe` | `m11_green` から修正案を 1 つ外す (適用前の決着 / anchor の確認し直し) | 1,046,920 / 834,214 (8 s / 7 s) | 21 | No violation (index の DDL はどちらか一方で足りる) |
| M11 `m11_index_no_sync` | `schemaSafe` | `m11_green` から全シャードへの先行適用を外す | 886,050 (生成 3,652,387、11 s) | 21 | No violation (index の DDL では先行適用がなくても安全) |
| M11 `m11_impl` | `schemaSafe` | 実装どおり (修正案を 5 つとも外す)、取引 2 件 | 約 15 万で反例 | 反例は 12 状態 | 反例 (実装の欠陥) |
| M11 `m11_impl_wait` / `_inflight` / `_backfill` / `_chunk` / `_drop` | `schemaSafe` | 修正案を 1 つずつ外す、取引 1 件 | 各 約 700〜3,900 で反例 | 反例は 12 / 13 / 11 / 12 / 8 状態 | 反例 (5 本すべて、実装の欠陥) |
| M11 `m11_red_no_reject` / `_early_public` / `_no_write_only` / `_no_sync` | `schemaSafe` | 実装にある防御を 1 つずつ外す、取引 1 件 | 各 約 80〜3,000 で反例 | 反例は 12 / 3 / 11 / 7 状態 | 反例 (4 本すべて) |
| M12 `m12_green` | `buildSafe` (= indexMatches ∧ noWriteWhileLocked ∧ notRelied ∧ oneExit ∧ noIntentWhileLocked) | 行 2 (シャード 2)、値 0〜2 (最初の値は任意、重複あり)、取引 2 件、DDL は CREATE UNIQUE INDEX 1 本、期限切れあり | 50,428 (生成 174,301、1 s) | 13 | No violation |
| M12 `m12_green_shard_only` | `buildSafe` | 同上、Worker は先に断らない | 99,418 (生成 365,322、1 s) | 13 | No violation |
| M12 `m12_red_online` | `indexMatches` / `notRelied` | 2026-11 までの設計 (作りながら書く) | 反例 | 反例は 11 / 4 状態 | 反例 (実装の欠陥) |
| M12 `m12_red_repin` | `indexMatches` | 取引が、計画し直さずに新しい版を名乗る | 反例 | 反例は 12 状態 | 反例 (実装の欠陥) |
| M12 `m12_red_no_lock` / `_visible` / `_no_drain` / `_stale` / `_two_exits` / `_scan_early` | `indexMatches` / `notRelied` / `noWriteWhileLocked` / `indexMatches` / `oneExit` / `indexMatches` | 決めた設計から条件を 1 つずつ外す | 反例 | 反例は 10 / 3 / 6 / 11 / 7 / 8 状態 | 反例 (6 本すべて) |
| M12 `m12_clock_green` | `publishIsAPoint` | シャード 2、時計 0〜3、index を使わない書き込みと使う文、公開の版が時刻を運ぶ | 1,788 (生成 5,213、1 s) | 15 | No violation |
| M12 `m12_clock_red_no_clock` / `_skip_empty` | `publishIsAPoint` | 公開の版が時刻を運ばない / 行のないシャードを読まない | 反例 | 反例は 13 / 9 状態 | 反例 (2 本とも) |
| M13 `m13_green` | `boundarySafe` (= prefixOfScript ∧ pinned ∧ ownDdlVisible ∧ completeWhenOk) | 1 つの接続の文 (書き込み、DDL、書き込み、DDL、書き込み、COMMIT)、別の接続の DDL 1 回、確定の競合、1 度のやり直し | 52 | 10 | No violation |
| M13 `m13_red_main` / `_pin_only` / `_repin` / `_retry_whole` / `_ddl_anyway` | `prefixOfScript` / `ownDdlVisible` / `pinned` / `prefixOfScript` / `prefixOfScript` | 決めた設計から条件を 1 つずつ外す (`_main` は 2026-11 までの実装) | 反例 | 反例は 4 / 5 / 11 / 10 / 10 手 | 反例 (5 本すべて) |
| M14 `m14_green` | `guardSafe` (= noLostWrite ∧ oneExit) | 古い表の行を持つシャード 2、別の接続の書き込み 2 回 (prepare と確定)、時計 0〜5、禁止の期限切れあり | 92,634 | 20 | No violation |
| M14 `m14_red_no_lock` / `_no_check` / `_check_early` / `_no_drain` / `_untied` / `_commit_ts` | `noLostWrite` | 決めた設計から条件を 1 つずつ外す | 反例 | 反例は 15 / 11 / 14 / 14 / 17 / 15 手 | 反例 (6 本すべて) |
| M15 `m15_green` | `servable` | 親、子、分割に関わらないシャード 1 つ (最新の版の適用に失敗して取り消すことがある)、版 0〜3、要求は最新の版で計画、枠の期限切れと、分割を進める側の停止あり | 2,524 | 21 | No violation |
| M15 `m15_red_no_slot` / `_stale_begin` / `_early_release` / `_no_based_on` / `_late_start` | `servable` | 決めた設計から条件を 1 つずつ外す (`_no_slot` は 2026-11 までの実装) | 反例 | 反例は 12 / 16 / 12 / 13 / 14 手 | 反例 (5 本すべて) |

witness (vacuous でないことの確認。`not(到達したい状態)` を invariant にして違反 = 到達可能):

| モデル | witness | 内容 |
|---|---|---|
| M1 | `witnessCrossCommit` | クロスシャード取引が commit し両シャードに適用される |
| M1 | `witnessRefreshCommit` | refresh を経由して commit する取引がある |
| M1 | `witnessROSeesCross` | 読み取り専用取引がクロスシャード書き込みを両方のシャードで見る |
| M3 | `witnessAllApplied` | 全参加者に適用され Worker が Committed を受け取る |
| M3 | `witnessTombstoneAfterRestart` | restart 後に tombstone で決着し Worker が status 照会で Aborted を知る |
| M4 | `witnessCommitAfterRestartRead` | 読みの後に commit が起きる |
| M5 | `witnessDoneWithBoth` | 親と子の両方で write を受理して Done に到達 |
| M5 | `witnessIntentResolvedAtChild` | 親に置かれた intent が子で解決される |
| M6 | `witnessPublished`, `witnessIntentApplied` | W が公開され、intent が適用された commit も flush される |
| M5b | `witnessMovedAndWritten` | 全グループが移動し、子で write を受理し、X も適用された |
| M5b | `witnessIntentMovedThenApplied` | 親で prepare した intent が子へ移り、子で適用された |
| M7 | `witnessRestoredNonEmpty` | 全シャードを復元し、復元結果が空でない |
| M9 | `witnessPessWaitedCommit` / `witnessWoundTaken` / `witnessImmROValidated` / `witnessSecondDml` | 待った悲観取引が commit、wound で奪う、IMMEDIATE 読み取り専用が検証を通して commit、2 回目の DML を経て commit |
| M11 | `witnessPublicWithWriters` | DDL の途中に、index を知らない計画の取引と write-only の計画の取引が 1 件ずつ確定し、index が 2 行とも持って public になる |
| M11 | `witnessStaleRejected` | 古い catalog の要求がシャードに拒否され、index は public になる |
| M11 | `witnessCrossDuringDdl` | 2PC の取引が DDL の途中で確定し、両方のシャードに適用された後で public になる |
| M11 | `witnessUniqueFailed` / `witnessUniquePublic` | 重複があって UNIQUE index の作成が失敗する。重複がなければ 2 行を持って public になる |
| M11 | `witnessRecreateWritten` | 表を作り直した後に書いた行が残る |
| M12 | `witnessPublicThenWrite` | index が公開された後で、index を使う書き込みが 2 件確定し、2 行とも値と項目を持つ |
| M12 | `witnessWithdrawnOnDuplicate` | 最初から同じ値の行が 2 つあり、index の作成が取り消される |
| M12 | `witnessRefusedByLock` (`m12_green_shard_only`) | 作っている最中の版で計画された書き込みを、シャードが断る |
| M12 | `witnessAwareOnSlowShard` (`m12_clock_green`) | 時計の遅いシャードが公開の版を適用し、そこで index を使う文が、別のシャードの古い書き込みを全部見る |
| M13 | `witnessRetriedAndDone` / `witnessOtherDdlThenDone` | 確定を断られた区切りをやり直して最後まで進む / 別の接続の DDL の後で最後まで進む |
| M14 | `witnessDroppedAfterWrites` / `witnessRefusedByCheck` | 別の接続の書き込みの後で DROP まで進む / copy の後の書き込みを見つけて禁止を取り消す |
| M15 | `witnessRecordedBeforeAndServed` / `witnessRecordedAfterDeath` | 分割の前に記録された版で分割が始まり、子へ移った行がグループの到着で読める / 分割を進める側が枠を取った後で止まっても、期限で枠が消え、DDL が記録される |

## 新しく見つかった設計バグ (M1、green が破れた)

設計書どおりにモデル化した最初の green は TLC で破れた。モデルの誤りではなく設計の穴と判定し、`RED_G` として固定した。

**push が c 決定後の refresh 窓で受理される。** design.md「読み取り」は、intent の取引が in-flight なら anchor に `min_commit_ts = T + 1` を push し、成功したら intent を無視してよいとしている。しかし anchor 主導 2PC には「全参加者の prepare が揃い `c` を決めたが、未保護 span の refresh が終わっておらず record は未確定」という窓 (手順 4〜5 の間) があり、この窓では push を受理しても `c` は動かない。

時系列 (`m1_red_g.counterexampleTest`、TLC の反例と同じ):

1. W1 が S2 を述語読み (T = 0)、x@S1 と y@S2 を書く。anchor = S1。S2 の prepare_ts = 1。anchor の prepare_ts = c = 2。S2 は未保護 span を持つので refresh 待ち (Refreshing)。
2. 読み手 R が S1 の HLC = 2 を T にして開始。x の intent (prepare_ts 2 ≤ T、W1 は in-flight) に当たり push。anchor は `pushed = 2` を記録するが c = 2 は既に決まっている。R は push 成功とみなし x の古い値を読む。
3. R が y の intent (prepare_ts 1 ≤ T) でも同様に push → 古い y。R は T = 2 で完了。
4. W1 の S2 refresh が通り、c = 2 ≤ T = 2 で commit。
5. R は (c, rank) 順で W1 の後ろにいるのに W1 の書き込みを見ていない。Serializable が破れる。

修正 (green に入れた): push は `c` 未決定 (prepare 収集中) のときだけ受理する。`c` 決定後の未確定取引に当たった読み手は、`c > T` なら無視、`c ≤ T` なら決着 (commit なら代行適用、abort なら intent 除去) を待ってから読む。design.md 側では「push が間に合わず committed(c) が返り」の分岐を「c が決定済み (refresh 中を含む) で返り」に広げる必要がある。

### M5b で見つかった穴 (S3 の pull 型再構成)

`m5b_red_p2_window.counterexampleTest`。S3 は「intent はグループと一緒に移る」「anchor の `__txn` は親に残る」としているが、
pull の応答が飛んでいる間 (親は m を決めて応答を送ったが、子はまだ受け取っていない) は intent が物理的に親にある。
この窓で phase 2 が親に届くと、親は intent を持っているので自分の行に適用する。しかし応答に載せたスナップショットには
その書き込みが無いので、子はそれを含まない状態で所有を始める。書き込みが消える。

1. X の intent を P に置く (prepare_ts 1)。Meta が経路を C へ切り替える。
2. C が pull。P は `moved[g] = m = 2` を永続化し、行イメージと intent を応答に載せる。応答は飛行中。
3. anchor が c = 2 を決め、phase 2 が P に届く。P は intent を持っているので適用する (P の行 = X)。
4. C が応答を受け取る。スナップショットは X を含まない。C の最新値は初期値、真の最新値は X。

修正 (green): 親は m を決めた瞬間から、そのグループについて phase 2 も prepare も write も読みも受けない。
phase 2 は moved 表で現オーナー (子) へ転送し、子が未到着なら適用せず anchor の alarm に再駆動させる。
「intent がある DO に適用する」ではなく「moved 表で決めた DO に適用する」。

S3 の字義そのものの反例 (`m5b_red_s3`, `m5b_red_s3_parent`) は報告本文に時系列で書いた。

### M1b で見つかった穴 (claim 3: 「読みの開始前に確定した書き込みは必ず見える」)

`m1b_green` で `freshReadPicked` が破れる。autocommit の 1 シャード読みでも成立しない。

1. W (x@S1, y@S2 に書く、anchor S1) が S2 で prepare (prepare_ts 1)、anchor で c = 2 を決めて Worker に応答する。phase 2 は未到着。
2. autocommit の読み R が y@S2 だけを読む。`exec()` は `settleIntents` の前に `T = issue()` で T = 1 を取る。
3. settle で W の intent が finalize され (c = 2)、S2 の HLC は 2 になる。
4. R は T = 1 の rollback-read で y を読む。c = 2 > T なので W の書き込みは見えない。W は R の開始前に応答していた。

取引 (fresh) の読みなら、finalize 後の `changedSince(span, T)` が ReadTooOld を出し、read-time refresh で T が進むので見える。
autocommit (fresh でない) の読みだけが落ちる。pickT (1 文で複数シャード) は anchor が対象に含まれるので T >= c となり成立する。

修正 (`BUMP_FIRST`、`m1b_green_bump`): 最初の読み (まだ何も読んでいない) では T を settleIntents の後に発行する
(または finalize した c の max まで上げる)。読みがまだ無いので T を上げても snapshot は壊れない。
取引の 2 文目以降 (`freshReadSeq`) は、refresh が通らなければ T が留まるので主張の範囲外。これは Serializable だが実時間順序ではない。

### M9 (新プロトコル統合) で確定した修正点

1. **prepare は他のロックを待たない** (`m9_red_prepare_waits`)。古い X が x, y をロック → x の TTL 切れ → 若い Y が x をロック →
   X の prepare が S2 で y を intent にし、anchor の S1 で Y のロックに当たって待つ → Y が y を要求して X の intent (prepare 済み) を待つ → 閉路。
   prepare が abort すれば prepare 済み取引は待ちグラフの sink になり閉路は起きない (green で確認)。
2. **DML の dry-run の前に settleIntents(F)**。committed で未適用 (c ≤ F) の intent は適用を待つ、c 未決定は F より上へ push、c 決定済み (c ≤ F) は待つ。
   抜くと X (xi insert、c = 1、phase 2 未到着) の後に Y の `UPDATE ... WHERE g` が F = 1 で {x} を読み、検証窓 (1, c] に c = 1 が入らず commit する。
3. **DML が参照する表すべてに F からの span** (サブクエリ、INSERT ... SELECT、UPDATE ... FROM)。trigger 捕捉は変更行しか見ない。モデルは述語 span で代表 (`m9_red_no_pred`)。

案 A (述語 span) の反例は見つからなかった。条件: 述語に使う conjunct は別名の列だけを参照し、サブクエリ・非決定的関数を含まない。他は表単位に落とす。
窓の全 commit の before / after を見る限り「途中の版だけが述語を満たす」ことはない (途中の版は前後どちらかの commit の before か after)。

## 各モデルの要点

### M1 `m1_serializable_commit.qnt` — anchor 2PC の Serializable

- invariant `serializable`: committed な取引 t の各読みが、(c, rank) 順で t より前の committed 書き込みの最新と一致する (述語読みは存在キー集合の一致)。rank は書き手 = tid、読み取り専用 = NTXN + tid (読み手は c ≤ T の書き手を見る側)。「読みが commit_ts 順の直列実行と一致する」の形式化で、同値の c も探索対象 (tiebreak は tid)。正しいプロトコルでは他取引の書き込みを見た取引の c は厳密に大きくなるので、この tiebreak で偽陽性は出ない。
- 取引は 12 テンプレートから選ぶ: RW (x 読み y 書き / 逆)、RMW + 他シャード書き、述語読み + 読んだ行と他シャード書き、insert、blind write、読み取り専用。
- アクション: begin (T = 最初に触るシャードの HLC)、readKey / readPred (rollback-read 相当で T 時点の版を返す、intent の処理、push)、sendCommit (anchor は参加者から nondet)、prepare、anchorPrepare (fold + c 決定 + refresh 要否)、refresh、apply (phase 2、参加者ごと)、tick (時計ずれ)。
- red: (a) 読み専用参加者に prepare しない、(b) anchor が prepare_ts を取り込まない、(c) refresh が HLC を c まで進めない、(d) 述語読みを保護済み扱い、(e) intent を照合しない、(g) 上記の push 窓。すべて TLC で反例、決定的 run で固定。

### M2 — マルチシャード読みの atomic visibility

M1 と同じモデルで invariant `atomicVisibility`: 読み取り専用取引が、書き手 w の書いたキーを 2 つ以上読んだとき、見た版が全キーで c_w 以上か全キーで c_w 未満のどちらかで、かつ「見た ⇔ c_w ≤ T」。red (`RED_F`) は in-flight intent を push せず通過 (タイムアウト通過)。反例: S2 で prepare 済みの W を R が通過 → S2 の時計が進んで T が c 以上 → W が S1 に適用された後に R が x を読む。

### M3 `m3_anchor_recovery.qnt` — presumed abort と障害

- anchor の record は「書いた (pending) → sync で確定」の 2 段。restart で in-memory (in-flight、ack) と pending が消える。ack / prepare / phase 2 / abort は遅延・重複する。参加者は intent に対して anchor に照会し、記録なし & in-flight でなければ tombstone。runtime の自動 retry による commit 要求の再配送 (`redeliverCommit`) も入れた。
- invariant `recovery` = 適用済み ⇒ record Committed、適用済みと破棄済みが同居しない、record Committed ⇒ 全参加者が intent 保持 or 適用済み、Worker への応答と record の一致。
- red: `sync()` 前に phase 2 と応答を送る。反例: 参加者 1 が適用 → anchor restart で pending が消える → 参加者 2 の照会で tombstone。
- 補足: `redeliverCommit` を入れても green は破れない。tombstone があれば decide できず、tombstone がなければ正当な再実行になる。

### M4 `m4_hlc_restart.qnt` — 再起動を跨ぐ HLC

- invariant `commitAfterRead`: 読み手が T を持ち込んだ後の commit は c > T。
- red: commit 時刻だけ永続化 → 読みで進めた HLC が restart で消え、別ホストの遅い時計から再開して c ≤ T。
- green: 読みで HLC が persisted を超えたときに `persisted = hlc + LEASE` を書く (LEASE 0 と 2 を検査)。
- Apalache で帰納的不変条件 `inductive` (本質は `hlc ≥ maxReadT ∧ persisted ≥ maxReadT`、Apalache の要請で各変数の到達範囲も含む) が step で保たれ、`commitAfterRead` を含意することを確認した。

### M5 `m5_split_fence.qnt` — split の cutover

- フェーズ Copying → Fenced → Handed → Switched → Done。Worker は経路をキャッシュし NotOwner で直す。親は Copying のときだけ受理、子は active のときだけ受理。
- invariant `splitSafe` = 親子が同時に受理しない、Handed 以降は親で受理した write が子に存在、Switched 以降は子の値が最後に受理された write と一致、intent は解決済みか現オーナーにある。
- red: Meta 切替と子の active 化を fence 前に行う (親子が同時に受理し、handoff で子の write が上書きされる)。intent を運ばない handoff。

### M1b `m1b_read_refresh.qnt` — read-time refresh、__ver 廃止、T = max HLC

- M1 の green を固定し、3 点を加えた。(1) fresh な取引の読みは span に T より新しい commit があると `startReadRefresh` (to = HLC) →
  既読シャードごとに `readRefreshStep` (HLC を to へ、(T, ∞) の変更と他 intent を照合) → 全部通れば T = to、1 つでも落ちれば fresh を捨て T のまま。
  (2) 書きの first-committer-wins は「キーの最新 commit > T」(索引) だけ。(3) `PICK_MAX`: 1 文で複数シャードを読むとき T = 対象 HLC の最大。
- red: `RED_RA` refresh が HLC を進めない (3 取引で反例: R が T を 1 に進めた後、S1 で pts 1 の blind write が c = 1 で入る)、
  `RED_RB` 進めた後も旧 T の検証窓 (保守的、違反なし)、`RED_RC` 失敗後も T を進める (R が x を旧値、y を新値で読む)。
- claim 3 は `freshReadPicked` (1 文の読み: 1 シャードも複数シャードも) と `freshReadSeq` (取引の 2 文目) に分けた。

### M8 `m8_recent_index.qnt` — __ver 廃止後の first-committer-wins

- 索引 (key → 最新 commit) はメモリだけ。prune で捨てて recentLowWater = HLC、flush 後の世代 DROP で logLowWater を上げる、
  再起動で索引と recentLowWater を失い __log から作り直す。検証は T < logLowWater / recentLowWater なら abort、索引[key] > T なら競合。
- invariant `fcw`: 検証を通した書き込みのキーに、T より新しい commit が (全履歴で) 無い。
- red: 世代 DROP で logLowWater を上げない → 再起動後の索引が空で T が古い書き込みが通る。
  「最新世代だけから作り直す」は、DROP が logLowWater を上げていれば破れない。

### M9 `m9_protocol.qnt` — 新プロトコルの統合 (実装に揃えた版)

実装との対応:

| 実装 (core.ts / db.ts) | モデル |
|---|---|
| `lockedExec`: settleIntents(F) → F で dry-run → 変更行のロック (`grant`)、span の since = F | `dmlRequest` / `dmlAcquire` / `woundTake` の `dryRun`。`since[k]`、`blockedBy` / `pushTargets` で settle |
| BEGIN IMMEDIATE の主キー SELECT (`shardRead` → `dml` with `lockRows`) | `tmpl.imm`、`lockKeys` に reads を含め、`readVals` を F の版で記録 |
| 読み取りだけでも since があれば commitLocal / prepare (`commit()` の `latest`) | `needsValidate`、`finishRO` は since 無しのみ、`sendCommit` が読み取り専用参加者を通す |
| `waitForRow`: 古い待ち手は WOUND_DELAY 後に保持者のロックを削除 (フラグ無し)、若い待ち手は待つ、prepare 済み intent は待つ | `woundTake` (prepared を奪わない)、`dmlRequest` の待ち、`waitEdge` は奪える相手を閉路に数えない |
| `validate`: ロックを信用せず since から `changedSince`、他ロック / intent なら abort (prepare は待たない) | `writeConflict`、`prepareSpanConflict`、`RED_PREPARE_WAITS` |
| 2 回目の DML は since = min (db.ts の overlay 併合) | `dryRun` の `newSince`、`tmpl.twice` |
| `execAuto`: autocommit は開始時刻を持って同じ待ち行列に入り、起きたら文を実行し直す | テンプレート J (DML 1 文の悲観取引) |
| 失敗時の `releaseLocks` (commitLocal / prepare 失敗、abort、rollback の unlock) | `releaseAll` / `abortRelease`、`locksWithout` |
| `wakeNext` (解放・期限切れ検出で先頭 1 件)、`wakeAll` (finalize / abort) | `wakeOne` / `wakeAllOn`、`awake`。`EXPIRE_WAKES` (TTL 切れで起こす) と `LEAVE_WAKES` (去るとき起こす) は修正案 |
| ロック TTL、再起動 | `lockExpire` (保持者は気づかない)、`restart` (ロックと待ち行列が消え、待ち手は abort) |

抽象化した点: 文は 1 キーか 1 述語の読み / 書きだけ (11 テンプレート)。述語は「g = true」の 1 種類。wound の 200 ms と LOCK_WAIT の deadline は
nondet の順序で表し、時間は持たない (deadline による abort は `waiterLeave` で代表)。ロック読みの SELECT は主キー 1 行のみ (impl と同じ)。
楽観取引の read-time refresh 失敗は abort として表す (impl は T のまま読み続けて commit 検証で競合する。結果は同じ)。
anchor の record の durability (M3)、HLC の再起動 (M4)、移動 (M5b)、索引の再構築 (M8) は含まない。

red: (a) `RED_RO_SKIP` 読み取り専用の検証を飛ばす → IMMEDIATE で x を F=0、y を F=1 で読んだ取引が、間に入った 2 シャード書き込みの片方だけを見る。
(b) `RED_SECOND_F_NEW` 2 回目の DML で since を新しい F に → 消えたロックの間の他の commit を見ずに上書き。
(c) `RED_IMM_READ_T` ロック読みを T で読んで since = F → (T, F] の commit を読み落として commit。
ほか `RED_SKIP_LOST` (trustLocks)、`RED_F_IS_T`、`RED_WOUND_PREPARED`、`RED_WAIT_DIE`、`RED_NO_PRED`、`RED_PREPARE_WAITS`。

lost wakeup (`noLostWakeup`: ロックも intent も無いのに待ち手が全員眠っている): 実装どおり (`m9_impl_wake`) は TTL 切れで破れる。
起こされた待ち手が取らずに去るときに次を起こさない (`m9_red_leave_silent`) も破れる。両方を直した green は保たれる。

M1 / M1b / M2 の green は M9 が同じ機構を含むが、個別の red フラグは元のモデルに残す。

### M10 `m10_txn_record_gc.qnt` — 取引記録の GC

anchor は決着した取引の記録 (committed と tombstone) を保持時間 R の後に消す。
tombstone を消した後に、再配送された同じ取引の COMMIT が届いて確定すると、中止と判断して intent を無視した読み手と矛盾する。
`m10_red_no_guard` の反例は 13 手で、COMMIT の受付、anchor の再起動、読み手の問い合わせと tombstone、時間の経過、GC、COMMIT の再配送、確定の順である。
実装は、開始 (`T`) から R/2 を過ぎた取引の COMMIT を anchor が拒否する (`core.ts` の `commit`)。
GC の時点では tombstone の作成から R が経ち、tombstone は取引の開始より後に作られるので、その後の COMMIT は必ず拒否される。

仮定は次の 2 つで、モデルの外にある。
`T` の物理時刻と anchor の時計のずれが R/2 (30 分) より小さいこと。
適用済みの参加者に届いた prepare の重複は intent を置かないこと。`validate` が書き込み行の `T` (悲観的な取引では F) 以降の変更を調べ、自分の commit がそれに当たるので拒否する。窓が GC されていれば `T older than conflict window` で拒否する (コードで確認、テストはない)。

### M11 `m11_schema_change.qnt` — 取引と並行に進む表定義の変更

2026-11-10 追記：このモデルの修正案は実装に入れた。
待ちの後の版の確かめ直し、anchor での確かめ直し、DDL の適用前の intent の決着、backfill の走査の検証、同じ取引の中の重複の検出である。
以下で「実装どおり」と呼ぶ `m11_impl` と `m11_impl_*` は、修正前の実装を表す。対応する再現テストは `test/ddl-concurrent.test.ts` にあり、いまは通常のテストとして通る。
分割と index の作成が重なる場合 (BUG-6) はモデルに入っていない。実装は backfill を範囲表が変わらなくなるまで繰り返す。
当初この場面で残っていた「読みが稀に 1 行を取りこぼす」現象は、index とは無関係だった。分割の後、古い範囲表を持つ読み手の全表読みを、親が残った行だけで答えていた (BUG-8)。
shard key を絞らない span に読み手の範囲表のスロットを付け、手放した範囲と重なれば親が NotOwner を返すように直した。M5b は読みを shard key 単位で扱うので、この欠陥はモデルの外にあった。

2026-11-10 追記 (2 回目の全体レビューの後)：次の規則は実装とシミュレータの試験にはあるが、どのモデルにも入っていない。
モデルが扱うのは、取引と DDL (M11)、取引と移動 (M5b、M6) のそれぞれで、DDL と移動を同時には扱わない。

- 範囲の移動の途中のシャードは DDL を適用しない。親は fence の前に子の版まで追いつく (`test/split-ddl.test.ts`)。
- Meta は、全シャードが前の版を適用した後でしか次の版を記録しない。シャードが適用できなかった版は、次の版で取り消す (`test/schema-failure.test.ts`)。
- index 経由の読みと書きは、shard key ではなく押し下げた条件を span にする (`test/gidx-write.test.ts`、`test/review-regressions.test.ts`)。M11 は index の保守だけを扱い、index 経由の読みの span は扱わない。
- 直近の書き込みの索引を捨てた後は、それより前から続く検証と読み直しの確認を失敗させる (`test/review2-regressions.test.ts`)。M8 は検証だけを扱い、読み直しの確認は扱わない。

DDL と移動を合わせたモデルは、復元や分岐を載せる前に書く。

DDL の仕組みを実装のとおりに写した。
Meta が表定義の版を上げ、DDL を実行した Worker が全シャードへ適用してから先へ進む。
要求は計画に使った catalog の版を持ち、シャードは自分より古い版の要求を拒否する。
グローバル index は write-only で作り、既存の行を 1 シャードずつ埋め、最後に public にする。
Worker は古い catalog (index を知らない、write-only、public) で計画できる。
取引は 1 シャードの autocommit と 2 シャードの 2PC で、DDL のどの段階とも交互に進む。
DDL は 1 本で、CREATE INDEX、CREATE UNIQUE INDEX、表の作り直し (DROP TABLE と CREATE TABLE) を定数で選ぶ。

invariant は 5 つである。

- `indexComplete`: public な index は、すべての行の項目を持つ。
- `noDangling`: public な index に、行のない項目がない。
- `uniqueSafe`: public な UNIQUE index があるなら、同じ値の行が 2 つない。
- `noLostWrite`: DDL が完了を返した後に成功を返した書き込みは、DDL の適用で消えない。
- `noResurrect`: DDL の発行前に確定した書き込みは、作り直した表に現れない。

実装どおりの `m11_impl` は `schemaSafe` を破る。
green は実装そのものではなく、次の 5 つの修正案を入れた版である。
修正案を外したインスタンスは、それぞれ `packages/cf-d-infinity/test/ddl-concurrent.test.ts` の再現テスト (BUG-1 から BUG-5) に対応する。

| 修正案 (定数) | 外したインスタンス | 反例 | 実装での再現 |
|---|---|---|---|
| autocommit の書き込みが、待ちの後で版を確かめ直す (`RECHECK_AUTO`) | `m11_impl_wait` | 版を確かめた書き込みが待つ間に DDL が public まで進み、その後で index を更新せずに書く。行が index から見えない | BUG-3 |
| anchor が、参加者の応答を待った後で版を確かめ直す (`RECHECK_ANCHOR`)。または、シャードが intent を持つ間は DDL を適用しない (`DRAIN`) | `m11_impl_inflight` (両方を外す) | 参加者が intent を置いた後に DDL が進み、backfill は未確定の intent を読み飛ばす。取引は public の後で確定する | BUG-4 |
| backfill の書き込みが、読んだ後に行が変わっていないことを確かめる (`BF_VALIDATE`) | `m11_impl_backfill` | backfill が読んだ後に行の値が変わり、古い値の項目が後から書かれて残る | BUG-2 |
| UNIQUE の backfill が、同じ取引の中の重複を失敗にする (`CHUNK_DEDUP`) | `m11_impl_chunk` | 同じシャードの 2 行が同じ値を持つのに、2 件目が 1 件目の項目を上書きして public になる | BUG-1 |
| シャードが intent を持つ間は DDL を適用しない (`DRAIN`) | `m11_impl_drop` | 確定済みで未適用の intent が DROP の後に残り、作り直した表へ適用される | BUG-5 |

BUG-4 は、anchor の確認し直しと適用前の決着のどちらか一方で塞がる (`m11_fix_recheck_only` と `m11_fix_drain_only` がどちらも No violation)。
表の作り直しでは適用前の決着が要る。確認し直しだけでは、発行前に確定して未適用の intent が残るからである。
`m11_fix_drain_only` が通るのは、2PC の取引が commit の検証 (計画の後に同じ行へ確定した書き込みがあれば中止) を受けるからで、この検証をモデルから抜くと破れる。
破れる経路は、write-only の計画の書き込みが index に項目を足した後で、古い計画の取引が同じ行を index を更新せずに消すものである。

実装にある防御を 1 つずつ外した red は 4 本で、どれも反例が出る。
`m11_red_no_reject` はシャードが古い版の要求を拒否しない、`m11_red_early_public` は backfill の前に public にする、
`m11_red_no_write_only` は write-only の index を書き込みが更新しない、`m11_red_no_sync` は全シャードへ適用する前に DDL が完了を返す。
`m11_red_no_sync` の反例は 7 状態で、`test/migration.test.ts` の「DROP and CREATE」の消失と同じ経路である。
全シャードへの先行適用が効くのは表の作り直しである。
index の作成では、先行適用を外しても破れない (`m11_index_no_sync`)。
backfill の読みが新しい版の要求なので、読まれたシャードは必ず適用を済ませているからである。

モデルが示し、実装にないものは修正案の 5 つである。
このほか、分割と DDL の並行 (BUG-6) と、index で引いた読み取りの span の不足 (BUG-7) はテストで見つけたが、このモデルにはない。
シャードの数と範囲表が固定で、読み取りの取引がないからである。

### M12 `m12_unique_index_build.qnt` — 行のある表に、シャードをまたぐ UNIQUE の index を作る

2026-11-11 に書いた。M11 が通っているのに、実装は index を壊した (`test/ddl-concurrent.test.ts` の seed 100 と 364、`test/open/unique-index-build.test.ts`)。
M11 は index を (値, 行) の組の集合として持ち、項目を消すときに行を名指しする。
実装の index は値を主キーにした 1 行で、行が値を手放すと、その値の項目を、誰のものかを確かめずに消す。
M12 は index を実装と同じ形で持つ。

比べるのは 2 つの作り方である。

- **作りながら書く** (2026-11 までの設計、`m12_red_online`)：index を記録した時点から、取引が index を保守し、一意性を index で確かめる。既存の行の項目は後から埋める。
- **書き込みを止めて作る** (決めた設計、`m12_green`)：index を記録する版が、表を書き込み禁止にする。出来上がるまで、index は Worker の計画から見えない。既存の行を、止まった状態で埋める。

`m12_red_online` の反例は seed 364 と同じ形になる。
2 行が同じ値 k を持つ。片方の行の項目を埋めた後で、もう片方の行が k を手放し、k の項目 (他人のもの) を消す。
index は公開され、k を持つ行に項目がない。

invariant は 5 つである。

- `indexMatches`: 公開された index は、値を持つ行のすべてについて、その行を指す項目を持ち、行のない項目を持たない。
- `noWriteWhileLocked`: 書き込み禁止の版にいるシャードで、行の書き込みが確定しない。
- `notRelied`: 出来上がっていない index を、文が使わない (一意性の確認にも、項目の保守にも)。
- `oneExit`: 終わり方は、公開か取り消しのどちらか 1 回だけである。
- `noIntentWhileLocked`: 書き込み禁止の版にいるシャードに、その表の intent がない。

禁止が必ず解けることは、時相の性質としては検査していない。
代わりに、解くための 2 つの遷移がいつでも起きられることを示した。
期限切れ (`expire`) の条件は「作っている最中である」だけで、Meta が自分で起こす。
実装の期限切れは、作る側が期限の延長を止めたとき (5 秒) か、作り始めてから上限 (5 分) に達したときに起きる。モデルの `expire` はいつでも起き得るので、延長の形もこのモデルの範囲にある。延長は、作っている最中の版だけを受ける (公開と同じ確認) ので、取り消された作成を延長が生き返らせることはない。
終わった版の適用 (`applyVer`) の条件は「そのシャードに intent がない」で、これは `noIntentWhileLocked` が保証する。

決めた設計は、次の条件の上に立つ。1 つ外すと反例が出る。

| 条件 (定数) | 外したインスタンス | 反例 | 実装 |
|---|---|---|---|
| シャードが、作っている間、表への書き込みを断る (`SHARD_LOCK`) | `m12_red_no_lock` | 行を埋めた後でその行が変わり、項目が古いまま公開される | 入れた (`assertWriteSetFits`) |
| 作っている最中の index を、計画が使わない (`BUILD_VISIBLE` が false) | `m12_red_visible` | 書き込みは確定しないが、文が、出来上がっていない index による UNIQUE 違反を受け取る | 入れた (`TableDef.building`) |
| シャードは、版を進める前に intent を決着させる (`DRAIN_INTENTS`) | `m12_red_no_drain` | 禁止の前に prepare した取引が、行を埋めた後で確定する | ある (M11 の修正案) |
| シャードは、自分より古い版の計画を断る (`REJECT_STALE`) | `m12_red_stale` | index を知らない計画が、公開の後で確定する | ある |
| 公開と取り消しは、最新の版が「作っている最中」のときだけ起きる (`ONE_EXIT`) | `m12_red_two_exits` | 期限切れで取り消した後に、遅れてきた公開が通る | 入れた (`publishIndex` と期限の延長は、作っている最中の版だけを受ける) |
| 取引は、書き込みを計画した版を、確定まで持ち続ける (`PIN_VERSION`) | `m12_red_repin` | index を知らない計画が、公開の後の版を名乗って確定する | 守られていなかった。直した (M13、`test/txn-across-schema-change.test.ts`) |
| 行を埋める処理が読むシャードは、index を記録した版を適用してから答える (`SCAN_AT_VERSION`) | `m12_red_scan_early` | 読んだ後で、まだ書き込みを止めていないシャードの行が変わる | ある (読む要求が版を名乗る) |

`PIN_VERSION` は、モデルを実装と突き合わせて見つけた。
`REJECT_STALE` は「要求が名乗る版は、その計画に使った版である」ことを前提にする。
実装では、接続をまたぐ取引 (Hrana の baton) と、知らない表を読んだ後の取引が、溜めた書き込みを計画し直さずに、新しい版を名乗っていた。
これは index の作り方とは無関係で、取引の途中に DDL が挟まれば起きる。

守っているのはシャードである。
`m12_green_shard_only` は、Worker が先に断らなくても成り立つ。
逆に、すべての Worker が先に断るなら (`m12_green`)、シャードが禁止を理由に断る場面は起きない (`witnessRefusedByLock` に到達しない)。
古い版の計画は `REJECT_STALE` が断り、作っている最中の版の計画は Worker が出さないからである。
それでもシャードに置くのは、書き込みが必ず通る場所がシャードの 1 箇所だけだからで、Worker の経路が増えても確認が漏れない。

公開の時刻は、別の小さなモデル (`m12_clock_*`) で扱う。
取引の直列な順序は時刻の順である。index の公開は文の意味を変える (UNIQUE 違反で失敗する、衝突する行を消す) ので、公開も時刻の順の中に 1 点を持たなければならない。
版はシャードごとに、ばらばらの実時間に適用され、時計もずれている。
何もしなければ、時計の遅いシャードで index を使う文が、時計の進んだシャードの古い書き込みより小さい時刻を持つ (`m12_clock_red_no_clock`)。
決めた設計では、行を埋める処理が、各シャードの行を読んだ時刻の最大 m を公開の版に載せる。シャードは、公開の版を適用するときに、時計を m まで進める。
範囲の移動で親の時計を子へ渡す仕組み (M5b の `finishRange`) と同じ形である。
行のないシャードも読んで、その時刻を m に入れる (`m12_clock_red_skip_empty`)。

`publishIsAPoint`: index を使う文が読む時刻は、index を使わない書き込みの確定の時刻のどれよりも小さくない。

シャードは版を適用するたびに、それより古い時刻の読みを断る (`ddlFloor`)。
このため、公開の版が時刻を運ばなくても、直列でない実行は作れないと考えている。
ただし、その直列な順序は時刻の順と一致しない。試験の検査は時刻の順に並べて確かめるので、公開に時刻を持たせて、順序を 1 つにする。

モデルにないもの。

- 分割と index の作成が重なる場合。行が止まっているので、範囲表が変わったら全体を読み直せば足りる (同じ項目を 2 度書いても変わらない)。DDL と分割の順序 (不変条件 4) は別に扱う。
- 取り消された後に届く、行を埋める処理の遅い書き込み。index の表は取り消しの版で捨てる。版 1 を名乗る書き込みは、捨てる前の表に入るか、`REJECT_STALE` で断られる。
- index の表そのものの 2PC (M1、M9)。項目の intent が衝突することだけを写した。
- シャードの中で完結する UNIQUE index (shard key を含むもの)。各シャードの SQLite が作る。
### M13 `m13_txn_schema_boundary.qnt` — 取引の中の DDL と、取引が名乗る表定義の版

2026-11-11 に書いた。
取引の書き込みは COMMIT まで Worker の手元に溜まり、DDL は取引の中でもその場で全シャードに効く。
何もしなければ、効く順序が書いた順序と入れ替わる。表を作り直す移行では、行を写す前に古い表が消え、行が全部消える (`test/open/migration-tools.test.ts`)。

決めた設計は 2 つの規則である。

- DDL は、開いている取引を先に確定してから実行する。その後の文は新しい取引になる (MySQL と同じ)。取引は開いたままにする。libSQL のクライアントは、`COMMIT` を「autocommit でない」ことを条件に送るからである。
- 取引は、最初に読むか書くかしたときの表定義の版を、確定まで名乗り続ける。版が変わるのは、確定の境目だけである。

invariant は 4 つである。

- `prefixOfScript`: 効いた文 (確定した書き込みと実行した DDL) は、文の並びの頭から順に、抜けも重なりもなく並ぶ。
- `pinned`: 確定した書き込みは、どれも、確定のときに名乗った版で計画されている。
- `ownDdlVisible`: 文は、同じ接続が先に実行した DDL を見て計画される。
- `completeWhenOk`: COMMIT が成功を返したなら、全部の文が効いている。

| 外した条件 | インスタンス | 反例 |
|---|---|---|
| DDL の前に確定する、と版を名乗り続ける (2026-11 までの実装) | `m13_red_main` | DDL が、前に溜めた書き込みより先に効く |
| DDL の前に確定する | `m13_red_pin_only` | 自分が作った表へ書く文が、古い版で計画されて失敗する |
| 版を名乗り続ける | `m13_red_repin` | 別の接続の DDL の後で、古い計画の書き込みが新しい版を名乗って確定する |
| 断られた区切りだけをやり直す | `m13_red_retry_whole` | 文の並びの頭からやり直し、確定した区切りと DDL を 2 度実行する |
| 先に確定できなければ DDL を実行しない | `m13_red_ddl_anyway` | 前の区切りの書き込みが失われたまま、DDL だけが効く |

モデルにないもの。シャードが古い版の計画を断ることは前提にした (M11)。区切りの中の取引の直列可能性は M1 と M9 に任せた。
取引の中で表を作り直すとき、行を写した区切りの確定から古い表を消すまでの間に、別の接続が古い表へ書いた行は消える。MySQL と同じで、この設計の範囲の外である。

### M14 `m14_rebuild_guard.qnt` — 取引の中で表を作り直すとき、別の接続の書き込みを失わない

2026-11-11 に書いた。表を作り直す移行 (新しい表を作る、行を写す、古い表を消す、名前を変える) は、DDL の前に取引を確定するので (M13)、行を写す区切り (copy) の確定と、古い表の DROP の間に、古い表を守るものがない。

決めた設計は、取引が読んだ表を DROP するとき、次の順に進む。

1. copy の区切りは、いままでどおり確定する。
2. Meta が、古い表を書き込み禁止にする版を記録する (index の作成と同じ枠と期限)。
3. 各シャードは、その版を適用した後で、copy が読んだ範囲に、copy の読んだ時刻より後の変更がないかを確かめる。
4. 全シャードで変更がなければ、Meta が DROP を、禁止の唯一の終わり方として記録する。変更があれば、禁止を取り消し、DDL を競合として失敗させる。

禁止を先に掛けてから copy を確定する順にはできない。禁止の版が先にシャードへ届くと、copy の区切りが名乗る版が古くなり、シャードが断るからである (M13 の版の固定)。
このため、copy と同時に書き込みがあると、行は失われないが、移行が失敗し、作りかけの新しい表が残る。

| 外した条件 | インスタンス | 反例 |
|---|---|---|
| 禁止の版を適用したシャードは、古い表への書き込みを断る | `m14_red_no_lock` | 確かめた後、DROP までの間の書き込みが消える |
| DROP の前に確かめる | `m14_red_no_check` | copy の確定から禁止までの間の書き込みが消える |
| 確かめるのは、禁止の版を適用した後 | `m14_red_check_early` | 確かめた後、禁止の版を適用するまでの間の書き込みが消える |
| 禁止の版を適用する前に intent を決着させる | `m14_red_no_drain` | 禁止の前に prepare した書き込みが、確かめた後で確定する |
| DROP は禁止の唯一の終わり方 | `m14_red_untied` | 期限切れで禁止が解けた後に、DROP が通る |
| copy の読んだ時刻と比べる | `m14_red_commit_ts` | copy の確定の時刻を見ていないシャードで、それより小さい時刻の書き込みを見逃す |

### M15 `m15_maintenance_slot.qnt` — 表定義の変更とシャードの分割の順序 (不変条件 4)

2026-11-11 に書いた。分割の間、親と子は DDL を適用しない。分割の途中に新しい版が記録されると、その版で計画した要求を、親と子が分割の終わりまで断る (`test/open/ddl-vs-split-race.test.ts`)。
子が親より古い版で受け取り始めると、子へ移った行を読めない。要求は、グループを取りに行く前に版を確かめ、子はグループが届いたときにだけ親の版へ追いつくからである (`test/open/child-behind-parent.test.ts`)。

決めた設計は、Meta が持つ保守の操作の枠である。分割は、全シャードが最新の版を適用した後で枠を取り、Meta が返す版を使う。枠は分割どうしでは共有でき、DDL (index の作成と DROP の前の禁止を含む) とは排他である。枠は、子が受け取り終えた後で返す。

`servable`: 分割の間も、Meta の最新の版で計画した要求を、行の持ち主が版の理由で断らない。

| 外した条件 | インスタンス | 反例 |
|---|---|---|
| DDL は、分割が枠を持つ間は記録しない (2026-11 までの実装) | `m15_red_no_slot` | 分割の途中に記録された版の要求を、移動中の持ち主が断る |
| 分割は、枠を取ったときの Meta の版を使う | `m15_red_stale_begin` | 子が古い版で受け取り始め、親は新しい版を先に適用している。切り替えの後、子が要求を断る |
| 枠は、子が受け取り終えた後で返す | `m15_red_early_release` | 切り替えの直後に記録された版の要求を、受け取り中の子が断る |
| 枠は、全シャードが最新の版を適用した後でだけ取れる | `m15_red_no_based_on` | 分割の途中に、別のシャードが失敗した版を取り消し、版が進む |
| 子は、枠が消えていれば受け取り始めない | `m15_red_late_start` | 期限切れの後に、止まっていた進め方の受け取りの始まりが届き、枠のないまま分割が進む。その間に DDL が記録される |

枠の終わり方。子が受け取り始める前の枠は、期限 (5 秒) で消える。分割を進める側が止まっても枠が残らないことは、`witnessRecordedAfterDeath` が示す。子が受け取り始めると期限を外す。分割は取り消せないので、子が受け取り終えたときにだけ枠を返し、止まった分割は Autoscaler が Meta の枠の一覧から再開する。
モデルにないもの。受け取り始めた後に止まった分割の再開 (実装の試験 `test/split-slot.test.ts` が、止まる位置ごとに確かめる)。終わらない分割 (16 MB を超えるグループ) が枠を持ち続けると、DDL がいつまでも待つ。

### M5b `m5b_live_migration.qnt` — pull 型ライブ再構成 (S2 + S3)

- 親 P と子 C、移動する範囲に shard key グループ 2 個。Meta の経路切替 (`switchRoute`)、親の受理停止 (`fence`、任意の順序で起きる)、
  子の on-demand pull (`pull` → 応答 `recvPull`、応答の喪失 `losePull` と冪等な再送)、blind write、クロスシャード取引 X の
  prepare / c 決定 / phase 2、T を持った読み (P にも C にも行く = stale routing と scatter)。
- invariant `migrationSafe` = singleOwner (C が受理したグループを P が後から受理しない) ∧ readConsistent (答えた読みは T 時点の真の値) ∧
  noLostWrite (移動後の子の最新値 = 受理済み commit の最新) ∧ intentNotLost (到着後に intent が親に残らない)。
- フラグ: `MOVE_AS_TXN` (S3: delete@m / insert@m)、`PARENT_SERVES_OLD` (親が T < m を undo で答える)、`CHILD_UNDO_OLD` (子が T < m を undo で答える)、
  `P2_MODE` (phase 2 の宛先: 0 prepare 先、1 intent の物理位置、2 moved 表)、`MOVE_INTENTS`。
- green = 版を保って物理的に移す、親は移動済みグループに常に NotOwner、子は T < m に ReadTooOld、phase 2 は moved 表で転送、intent は pull で運ぶ。
  fence の有無や Meta 切替との順序は nondet なので、「切替を先にして親は未移動グループを受理し続ける」(S2 の字義) も含めて安全。

### M7 `m7_restore.qnt` — W への同時点復元 (S6)

- commit、flush (R2 へ書いた後に `__log` の世代を DROP)、W の公開、bookmark による復元 (b は目標 ± APPROX)。
- S6 (red): 目標 W、c > W を `__log` で undo。b が W より前に落ちれば (b, W] が欠け、c ∈ (W, b] の世代が b 以前に DROP されていれば undo できない。
- 修正版 (green): 目標 W − APPROX で b <= W を保証し、(b, W] を R2 の after-image で redo する。W <= flush_ts なので R2 は必ず持っている。

### M6 `m6_watermark.qnt` — 分析 watermark

- 真の時刻 now と各シャードのずれ off (|off| ≤ SKEW)。commit は `max(HLC, phys) + 1`。intent の適用時刻 c は pts 以上で自分の HLC 以下にもなる (anchor が他参加者の pts から決める)。dirty 報告は DELAY_MAX 以内に届く。Meta は `W = min(now − MARGIN, dirty シャードの flush_ts)` を公開。
- invariant `watermarkSafe`: 公開済み W 以下の commit は flush 済み。
- red: (1) dirty 報告が intent 書き込み時だけ → 単一シャード commit が漏れる (design.md「intent を書いた時点で dirty を報告」のままだと起きる。レビューで指摘した点の再確認)。(2) resolved ts を使わず HLC で flush → 後から c ≤ flush_ts で適用される intent が漏れる。(3) SKEW + DELAY > MARGIN → 漏れる。`watermarkSafeOrDetected` (flush 時に W 以下なら検出) は (3) でも保たれる。つまり遅延検出は「シャードが flush すれば」補えるが、flush しないシャードは補えない。

## 抽象化で落としたもの (仮定)

- DO 内の処理は原子的 (各アクションは 1 イベント)。DO 間 RPC は遅延・順序入替・重複 (M3) を許すが、M1 では「要求は必ず届き、応答も届く」。
- M1/M2 の phase 2 は参加者ごとに別アクションだが、1 参加者内では原子的。読み手の「代行適用」は apply アクションが先に起きるまで読みを待つことで表現 (到達状態は同じ)。
- rollback-read は「履歴から T 時点の版を返す」で抽象化。差分上限 K、課金、SQL の中身は扱わない。
- 時計ずれは tick (M1) / off (M6) で表し、上限は定数。HLC の論理部は「厳密増加」としてのみ表現。
- M1 の書き込み競合は no-wait (即 abort)。Worker の retry は別取引として表現されない (取引数が固定)。
- M3 は取引 1 件、anchor は参加者とは別ノードとして扱う。tombstone の書き込みは durable とみなす (照会応答は確定後)。
- M5 の split は右半分のキーだけ。コピー速度・追いつきは扱わない (サイズ・性能の話はベンチ側)。
- M6 の Meta の時計は真の時刻。compactor の再生成そのものはモデル外 (検出までを見る)。
- M5b: 書き込みは blind write (検証無し)。移動の単位はグループ 1 個 = 行 1 個 (チャンク分割は扱わない)。親の行イメージの GC、
  子の再 split (連鎖) は扱わない。pull の応答喪失で親と子の再起動を表す (永続状態以外は持たない)。
- M7: 時計ずれ無し、intent 無し。bookmark の概算は「時刻 b の commit 集合」で表す。
- M11: index の項目は取引の確定と同時に変わる (index の表への 2PC と、その途中を読む読み手は M1 と M9 に任せる)。時刻はなく、
  backfill の読みは「確定済みの intent は適用後の値を読み、未確定の intent は読み飛ばす」で表す。
  2PC の取引の検証は「計画の後に別の取引が確定していれば中止」だけで、行ロック、wound-wait、Worker のリトライは扱わない (取引の数が固定)。
  autocommit の待ちは、原因 (行ロックか intent の決着) を問わず「版の確認と書き込みの間に他の出来事が入る」で表す。
  シャードは 2 個で固定し、分割と再起動は扱わない。publish と backfill 失敗時の DROP INDEX がシャードへ押し出されないことは、版を 0 と 1 に畳んだので表れない。
  DROP INDEX と、表を消すだけの DROP TABLE (別の表への書き込みを巻き込む BUG-5 の形) は扱わず、同じ名前で作り直す場合だけを見る。
- 有限化のための定数は各ファイルのインスタンスに明示した。取引 3 件 (`m1_green3`) は `HEAVY=1` で回すが、25 分・2.4 億状態で打ち切っても
  完了しなかった (深さ 19 まで違反なし)。完全探索は 2 件の結果だけである。
