# design.md の危険箇所の Quint / TLC 検査

`docs/design.md` のプロトコルのうち、壊れると直列化可能性・原子性・データ損失につながる 6 箇所を Quint でモデル化し、TLC で有限モデルを全探索した。

注意: ここでの「全探索で違反なし」は、**各モデルに書いた小さな定数 (シャード 2、取引 2〜3、キー 4、時刻は小さな整数) の範囲で反例が存在しない**ことを意味する。任意サイズの証明ではない。M4 だけは Apalache で帰納的不変条件も確認した (こちらは定数の範囲内で帰納的であることの証明になる)。

## 実行

```sh
cd specs
./check.sh            # green の全探索 + red の反例確認 + witness + run テスト + M4 の帰納的不変条件
HEAVY=1 ./check.sh    # 加えて M1 を取引 3 件で全探索 (数分〜)
TLC_CONFIG=/path/to/tlc.json ./check.sh   # TLC の heap と worker の数を渡す。中身は { "maxHeap": "-Xmx2500m", "workers": 8 } の形
```

quint は TLC を `-Xmx8G` で起動する。コマンド行の指定なので、`JAVA_TOOL_OPTIONS=-Xmx...` では下がらない (下がるのは、TLA+ に直す Apalache の側だけである)。メモリの少ない計算機では `TLC_CONFIG` を使う。

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
| M5b `m5b_green` | `migrationSafe` | P/C、group 2、write 2、intent 1、worker 2、tick 2、T 0..6 | 9,719,448 (生成 9,692 万。`finishRange` を足す前は 9,512,226) | 22 | No violation |
| M5b `m5b_red_s3` / `_s3_parent` / `_p2` / `_p2_window` / `_intents` | `migrationSafe` | 同上 | 反例 | | 反例 (5 本すべて) |
| M5b `m5b_green_range` | `migrationSafe` (`noWriteBelowRead` を含む) | 同上で T 0..3、答えた読みの時刻を覚える、範囲の移動を終える手順あり | 8,306,186 (76 s) | | No violation |
| M5b `m5b_red_range` | `noWriteBelowRead` | 同上、移動を終えるときに親の時計を子へ渡さない | 25,013 で反例 | | 反例 |
| M5b `m5b_red_emptied` | `readConsistent` | P/C、group 2、write 2、intent 1、worker 2、tick 2、T 0..4、行を全部消す書き込みをグループごとに 1 回。床なし (2026-11-14 の実装) | 約 4 万で反例 | 最短の反例は 6 手 | 反例 (実装の欠陥) |
| M5b `m5b_green_floor` | `floorSafe` (= migrationSafe ∧ openReadConsistent ∧ clockAboveFloor) | 同上、範囲の床あり | 20,667,159 (生成 1.72 億) | 23 | No violation |
| M5b `m5b_green_floor_clock` | `floorSafe` (`noWriteBelowRead` を含む) | 同上、答えた読みの時刻を覚える、取引 X なし | 4,150,998 (生成 3,481 万) | 21 | No violation |
| M5b `m5b_green_floor_clock_x` | `floorSafe` (`noWriteBelowRead` を含む) | 答えた読みの時刻を覚える、取引 X あり、削除は X が書くグループ 1 だけ、T 0..3 (HEAVY) | 29,856,308 (生成 2.27 億) | 22 | No violation |
| M5b `m5b_red_floor_volatile` / `m5b_red_floor_no_clock` | `readConsistent` | `m5b_green_floor` から条件を 1 つずつ外す (床を子の再起動で忘れる / 移動を終えるときに親の時計を渡さない) | 反例 | 最短の反例は 7 / 9 手 | 反例 (2 本とも) |
| M5b `m5b_green_floor_resplit` | `floorSafe` | 範囲の床あり。子が受け取り終えた範囲を、新しい空のシャードへもう一度移す。削除は両方のグループ、tick 1、T 0..5、取引 X なし | 6,127,304 (生成 3,933 万) | 28 | No violation |
| M5b `m5b_green_floor_resplit_x` | `floorSafe` | 同上、取引 X あり、削除は X が書くグループ 1 だけ、tick なし、T 0..4 (HEAVY) | 43,323,996 (生成 2.55 億) | 29 | No violation |
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
| M16 `m16_green` | `committedApplies` | 行 3 つ、値 2 種類と不在、取引 2 つ (1 行か 2 行を書く)、決着と適用は別の段 | 7,197 | | No violation |
| M16 `m16_red_body_only` / `_intents_only` | `committedApplies` | prepare の 2 つの状態の確かめ方から 1 つずつ外す | 反例 | 手で書いた run は 6 / 5 手 | 反例 (2 本とも) |

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
| M5b | `witnessOpenWritten` (`m5b_green_range`) | 子が到着なしで受け持ったグループに、子が書き込みを受理した |
| M5b | `witnessEmptiedWritten` (`m5b_green_floor`) | 親が移動の前に空にしたグループを、子が到着なしで受け持ち、その後で子が書き込みを受理した |
| M5b | `witnessEmptiedRead` (`m5b_green_floor_clock`) | 親が移動の前に空にしたグループを、子が床以上の T で答えた (床があっても、読みを全部断ってはいない) |
| M5b | `witnessSecondHopWritten` / `witnessSecondHopEmptied` (`m5b_green_floor_resplit`) | 範囲を移し直した後で、新しい子が全部のグループを受け持って書き込みを受理した / 最初の親が空にしたグループを、新しい子が到着なしで受け持った |
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
| M16 | `witnessBothApplied` | 2 つの取引がどちらも確定して、本体へ適用される |

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

### M5b: 親が空にしたグループを、古い読みの時刻で子に読む (範囲の床)

`m5b_red_emptied.counterexampleTest`。2026-11-14 の実装の欠陥である。実装では `packages/cf-d-infinity/test/open/old-read-of-emptied-group.test.ts` が再現する。

行のあるグループは、pull が時刻 m を運び、子は T < m の読みを ReadTooOld で断る。親が fence の前に行を全部消したグループは、行がないので pull されず、m を運ばない。範囲の移動が終わると、子はそのグループを到着なしで受け持つ。子にはそのグループの履歴がないので、どの T の読みにも「行なし」と答える。

それまでのモデルは、到着なしで受け持つグループを、一度も書かれていないグループに限っていた (`finishRange` の条件が `hist == initVers`)。書かれた後で空になったグループがモデルになかったので、`m5b_green_range` は通っていた。今回、行を全部消す書き込み (`del`、`DELETES`) を足し、`finishRange` の条件を「親の最新の版が行なし」に広げた。削除のない既存のインスタンスでは、2 つの条件は同じである。

1. 親がグループ 2 に行を書く (c = 1)。取引が T = 1 でその行を読む。
2. 別の接続が、その行を消す (c = 2)。グループは空になる。
3. 親が fence し、Meta が経路を子へ切り替え、範囲の移動を終える。運ぶ行はない。親は m = 3 を発行し、子は時計を 3 に進めて、グループを到着なしで受け持つ。
4. 取引が別の接続で続く。T は 1 のままで、送り先は新しい範囲表で決まるので、子へ行く。子は「行なし」と答える。T = 1 の時点では行があった。

取引は、同じ行を 2 回読んで、違う答えを得る。読むだけの取引は確定のときに検証を受けないので、そのまま確定する。最短の反例は、1 の読みを省いた 6 手である (書く、消す、fence、経路の切り替え、移動を終える、子で読む)。

モデルの読み (`read(C, g, T)`) は、T も送り先も自由に選ぶ。接続をまたいで続く取引も、分割の後に始まって時計の遅れた別のシャードから T を取る取引も、この読みに含まれる。子が到着なしのグループを答えるのは `finishRange` の後だけで、そのとき Meta の経路は子を指している。

修正 (`m5b_green_floor`) は、範囲の床である。子は、範囲の移動を終えるときに受け取った時刻 m を、範囲と一緒に残す。その範囲のグループを T < m で読む要求は、pull されたグループでも、されなかったグループでも、ReadTooOld で断る。m は、親が fence の後に発行した時刻なので、親がその範囲に確定したどの書き込みよりも大きい。T ≥ m の読みは親の書き込みを全部見るので、子の持つ状態がそのまま答えになる。

`floorSafe` は、`migrationSafe` に次の 2 つを足したものである。

- `openReadConsistent`: 子が到着なしで受け持つグループを答える T では、子の持つ値が、その時刻の真の値と一致する。`readConsistent` は、読みが起きたときに比べる。こちらは、どの状態でも、子が答えるはずの T を全部比べる。
- `clockAboveFloor`: 床を持つシャードの時計は、床以上である。

床に要ることを、次のインスタンスで確かめた。

| 確かめたこと | インスタンス | 結果 |
|---|---|---|
| 床は、子の再起動の後も残っていなければならない | `m5b_red_floor_volatile` | 再起動で床を忘れると、床のない実装と同じ反例になる |
| 床は、時計を渡す手順の代わりにならない | `m5b_red_floor_no_clock` | 親がグループ 1 を書いて (c = 1) 空にする (c = 2)。子は床 3 を残すが、時計は 0 のままである。子が取引 X の書き込みを c = 1 で適用する。時刻の順では削除が後なので、T = 3 の真の値は「行なし」だが、子は X の値を答える |
| 全部のグループが pull された範囲にも、床を残してよい | `m5b_green_floor` (run は `pulledGroupTest`) | pull されたグループは、到着の m 以上で床より小さい T も断るようになる。断る読みが増えるだけである |
| 書き込みの側 (答えた読みの時刻以下で書き込みを受理しない) は、床と削除があっても成り立つ | `m5b_green_floor_clock`、`m5b_green_floor_clock_x` | `noWriteBelowRead` を含めて違反なし |
| 同じ範囲をもう一度移すとき、新しい子は前の床を知らなくてよい | `m5b_green_floor_resplit`、`m5b_green_floor_resplit_x` | 違反なし |

答えた読みの時刻を覚えるインスタンスと、範囲を移し直すインスタンスは、状態が多い。`check.sh` がいつも回すのは、取引 X を外した版である (`CROSS = false`。書き込みは blind write と削除だけ)。X を入れた版 (`_x`) は、定数を小さくして、`HEAVY=1` のときだけ回す。削除は、X が書くグループ 1 だけにしてある。空にされたグループへ X の書き込みが届く形は、読みと持ち主の不変条件については `m5b_green_floor` がいつも確かめる。`noWriteBelowRead` と、移し直しについては、`_x` の版だけが確かめる。

`m5b_red_range` (時計を渡さない) は、親が答えた読みがあって初めて破れた。空にされたグループがあると、`m5b_red_floor_no_clock` のとおり、親の確定だけで破れる。

移し直し (`nextHop`) は、受け取り終えた子を親に読み替え、新しい空のシャードを子にして、同じ手順をもう一度進める。新しい親は、前の移動で受け取った時計、行、到着の m、床を持ち続け、到着の m か床より小さい T の読みは、親になっても断る。新しい子の床は、新しい親が発行する時刻である。新しい親の時計は自分の床以上 (`clockAboveFloor`) なので、新しい床は前の床より大きく、新しい子は前の床を受け取らなくてよい。親の時計が床以上なのは、範囲の移動を終えるときに時計を受け取っているからである。

モデルにないもの。

- 全表の読み。M5b は読みをグループ単位で扱う。実装の子は、全表の読みを、到着の m の最大 (`maxArrived`) より小さい T で断る。行を 1 つも運ばなかった分割では、これが 0 のままなので、子は古い T の全表の読みを断らない。答えが実際に欠けるかどうかは、親が残りの範囲について返す行にもよるので、走らせて確かめてはいない。床は、全表の読みにも当てる (床を持つ範囲に重なる読みを、T < m で断る)。
- `finishMove` と `finishIncoming` の間。実装では別々の RPC で、モデルの `finishRange` は 1 手である。間に、要求から始まる pull が入ると、そのグループの到着の m は、床より大きくなる。子が到着の m と床の両方で断るかぎり、断る読みが増えるだけである。範囲の移動を終えるときに到着の記録を消す設計 (`docs/design-subslots.md` の「drain と finishMove」) は、この順序を含めては確かめていない。`finishMove` をやり直すと、親は新しい m を発行する。fence の後は親の範囲の行が変わらないので、どの m も床として使えるはずだが、これも確かめていない。
- 範囲の一部だけの移し直し。モデルの範囲は、グループの全部である。子が受け取った範囲の一部を渡すときは、残りの部分の床を残す。
- 読みと書き込みの両方をする取引の検証。書き込みは blind write だけである。
- M18 の「行のない piece」。piece でも同じ形のはずだが、M18 には足していない。

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

### M16 `m16_unique_pending.qnt` — 未確定の書き込みがあっても、確定した取引は UNIQUE を守って適用できる (不変条件 2)

2026-11-12 に書いた。実装 (`uniquePending` と prepare の試適用) が前から持つ論法を、後から確かめた。prepare は、取引の書き込みが、本体の行だけの状態と、ほかの取引の intent をすべて適用した状態の、どちらでも UNIQUE を破らないことを確かめる。ほかの行の最後の値は、本体の版か、その行の intent の版のどちらかなので、両方で通れば、どの組み合わせで確定しても衝突しない。

`committedApplies`: 確定した取引の適用が、UNIQUE を破らない。

| 外した条件 | インスタンス | 反例 |
|---|---|---|
| ほかの取引の intent を適用した状態で確かめる | `m16_red_body_only` | 取引 1 が行 1 に値 1 を書く intent を置き、取引 2 が本体だけを見て行 2 に値 1 を書く。両方が確定する |
| 本体の行だけの状態で確かめる | `m16_red_intents_only` | 本体の行 1 が値 1 を持ち、取引 1 がそれを消す intent を置く。取引 2 は取引 1 が確定した状態だけを見て行 2 に値 1 を書く。取引 1 が中止され、取引 2 が確定する |

モデルにないもの。シャードをまたぐ UNIQUE (index の表の行も、同じ規則の intent になる)、照合順序と部分 index (実装は値を自前で比べず、SQLite に判定させる)、autocommit の書き込み (prepare と確定と適用が続けて起きる場合なので、このモデルの部分である)。

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
- 範囲の移動を終える手順 (`finishRange`)。親に行も intent もないグループは pull されず、子が到着なしで受け持つ。親は時刻 m を発行し、
  `FINISH_CARRIES_CLOCK` なら子は時計を m まで進める。`noWriteBelowRead` (答えた読みの時刻以下で、同じグループへの書き込みを受理しない) は、
  答えた読みの時刻を覚えるインスタンス (`TRACK_READS`) で確かめる。
- 空にされたグループと範囲の床 (2026-11-14)。`DELETES` のグループは、行を全部消す blind write (`del`) を 1 回受ける。確定の時刻で「行なし」の版を置く。
  `RANGE_FLOOR` なら、子は `finishRange` で受け取った m を床として残し、その範囲のグループの T < m の読みを断る。
  `FLOOR_DURABLE = false` は、床を子の再起動 (`restartC`) で忘れる。`HOPS` は、同じ範囲をもう一度移す回数である (`nextHop`)。
  `CROSS = false` は、取引 X を外す (状態を減らすため)。
  床のあるインスタンスは `floorSafe` (= migrationSafe ∧ openReadConsistent ∧ clockAboveFloor) を確かめる。
  欠陥と修正は「M5b: 親が空にしたグループを、古い読みの時刻で子に読む」の節に書いた。

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
- M5b: 書き込みは blind write (検証無し)。移動の単位はグループ 1 個 = 行 1 個 (チャンク分割は扱わない)。親の行イメージの GC は扱わない。
  子の再 split は、受け取り終えた範囲の全部を新しい空のシャードへ移す形だけを、`m5b_green_floor_resplit` で扱う (範囲の一部だけ、
  3 回以上、元の親へ戻す形は扱わない)。pull の応答喪失で親と子の再起動を表す (永続状態以外は持たない)。床を永続させない場合だけ、
  子の再起動を別の手 (`restartC`) にしてある。範囲の移動の終わりは 1 手で、`finishMove` と `finishIncoming` の間は扱わない。
- M7: 時計ずれ無し、intent 無し。bookmark の概算は「時刻 b の commit 集合」で表す。
- M11: index の項目は取引の確定と同時に変わる (index の表への 2PC と、その途中を読む読み手は M1 と M9 に任せる)。時刻はなく、
  backfill の読みは「確定済みの intent は適用後の値を読み、未確定の intent は読み飛ばす」で表す。
  2PC の取引の検証は「計画の後に別の取引が確定していれば中止」だけで、行ロック、wound-wait、Worker のリトライは扱わない (取引の数が固定)。
  autocommit の待ちは、原因 (行ロックか intent の決着) を問わず「版の確認と書き込みの間に他の出来事が入る」で表す。
  シャードは 2 個で固定し、分割と再起動は扱わない。publish と backfill 失敗時の DROP INDEX がシャードへ押し出されないことは、版を 0 と 1 に畳んだので表れない。
  DROP INDEX と、表を消すだけの DROP TABLE (別の表への書き込みを巻き込む BUG-5 の形) は扱わず、同じ名前で作り直す場合だけを見る。
- 有限化のための定数は各ファイルのインスタンスに明示した。取引 3 件 (`m1_green3`) は `HEAVY=1` で回すが、25 分・2.4 億状態で打ち切っても
  完了しなかった (深さ 19 まで違反なし)。完全探索は 2 件の結果だけである。

### M17 `m17_txn_id_reuse.qnt` — 同じ取引の ID を持つ 2 つの続き (不変条件 12)

2026-11-13 に書き、同じ日に書き直した。対話的な取引の状態を運ぶ baton は使い捨てではないので、同じ baton から、同じ取引の ID で違う書き込みを持つ続きが 2 つできる (HTTP の再送でも起き得る)。2026-11-12 より前の実装では、anchor が ID だけで決着を覚えて 2 つ目の COMMIT に 1 つ目の結果を返し、参加者は同じ ID の 2 回目の prepare に前の intent を残して ok と答えた。2 つ目の続きは確定したと聞くが、その書き込みは入らない。

最初の版のモデルは、確定の記録と intent の中身で続きを見分ける設計 (anchor と参加者が指紋を確かめる) を緑にした。しかし、断られた続きが intent に触れないとしていた。実装の中止 (`decideAbort`) は、全部の参加者に abort(ID) を送り、参加者はその ID の intent を消す。2 つの続きが同時に COMMIT すると、断られた続きの中止が、確定した続きの intent を phase 2 の前に消す (Codex の見直しの指摘 C1)。書き直したモデルは、COMMIT を、記録を確かめる段、prepare、確定か中止を決める段に分け、中止が intent を消すことを入れた。

同じ日の 2 回目の見直し (指摘 1) で、同じ中身の COMMIT が 2 つ同時に走ると (再送が元の COMMIT を追い越す)、同じ ID の 2 つの実行になり、後の実行の中止が先の実行の intent を消すことが分かった。モデルに、続き 1 の実行を 2 つ足した (実行 1 と 2 は同じ ID、実行 3 は続き 2)。

決めた設計は、2PC の ID を「取引の ID と、続きの中身の指紋」にすること (`BY_ATTEMPT`)、anchor が同じ ID の実行を 1 つずつにすること (`SERIALIZE`)、中止を決めた実行が、記録が中止のときだけ abort を送ること (`ABORT_CHECKS`) である。2 つの続きは別々の 2PC になり、確定の記録も intent も abort も続きごとに分かれる。同じ行を書けば、片方の prepare は普通の競合で断られる。同じ中身の再送は同じ ID なので、同じ答えになる。指紋は SHA-256 で、利用者が中身を選んでも衝突を作れない。

`safe` (`noLostAck`、`noForeignApply`、`noWrongRefusal`): 確定と答えた続きの書き込みは、intent が残っていなければ全部の参加者で適用され、適用されるのは確定した続きの値だけで、確定した続きの実行に、断ったか誤りだとは答えない。緑は `m17_green` と、実行を 1 つずつにするだけの `m17_green_serialize_only` である。

| 設計 | インスタンス | 反例 |
|---|---|---|
| 実行を 1 つずつにしない、中止は記録を見ない (2026-11-13 の 1 回目の修正) | `m17_red_resend` | 実行 1 が確定し、参加者 1 で適用する。実行 2 は適用済みの行に断られて中止を決め、abort(ID) が実行 1 の参加者 2 の intent を消す |
| 実行を 1 つずつにしない、中止は記録を見る | `m17_red_resend_abort_check_only` | 実行 2 が実行 1 の intent を再送として ok と見て確定を決め、記録の INSERT が失敗して、確定したのに誤りと答える |
| ID は取引の ID、anchor と参加者が指紋を確かめる (2026-11-12 の修正) | `m17_red_abort` | 2 つの続きが同時に始め、続き 1 が確定する。続き 2 は参加者に断られて中止を決め、abort(ID) が続き 1 の intent を消す |
| ID は取引の ID、どちらも確かめない (2026-11-12 より前) | `m17_red_impl` | 続き 1 が確定し、続き 2 の prepare は ok と答えられ、COMMIT も確定と聞く |
| ID は取引の ID、参加者だけが確かめる | `m17_red_prepare_only` | anchor は、同じ ID の決着があると参加者に prepare を送らずに結果を返すので、続き 2 は確定と聞く |
| ID は取引の ID、anchor だけが確かめる | `m17_red_commit_only` | 続き 2 の intent が先に参加者に置かれ、続き 1 の確定がそれを適用する |

### M18 `m18_subslot_split.qnt` — 1 つの shard key の行を、複数のシャードに分けて持つ

2026-11-14 に書いた。実装より先に書いたモデルで、対応する実装はまだない。同じ日に `SHARD KEY` 句をなくし、shard key は主キーの最初の列に決まった。同じ shard key の行 (グループ) は 1 通の応答で運ぶ (`pull`、`GROUP_MAX_BYTES` = 16 MB) ので、16 MB を超えるグループは移せず、その分割は終わらない。1 つのテナントは、1 つのシャードより大きくなれない。句があった間は、`SHARD KEY (tenant_id, id)` と書いて、行ごとに別のグループにできた。

設計は、配置を 2 段にする。slot = hash(主キーの最初の列) mod 4096 は今までどおりで、テナントの行は既定で 1 つのシャードに集まる。これに subslot = hash(主キーの全体) mod 65536 を足し、範囲表は (slot の範囲, subslot の範囲) をシャードに対応させる。移動の単位は piece = (グループ, subslot の範囲) で、1 通の応答に収まる大きさにする。1 つの slot を subslot の範囲で分けると、1 つのテナントの行が複数のシャードに分かれる。それでも文は、1 つの SQLite が全部の行を持つときと同じ答えを返さなければならない。

モデルは、親 P、子 C、テナント 1 つである。piece 1 は subslot の下の範囲にあって P に残り、piece 2 は上の範囲にあって C へ移る。slot は 2 つのシャードのものになる。移動の手順は M5b の green と同じで、fence、範囲表の切り替え、piece ごとの pull (応答の喪失と再送)、時刻 m の持ち運びからなる。親は m を決めた piece を答えず、子は T < m の読みを断る。Worker のキャッシュは変数にしない。要求ごとに、それまでに知り得た範囲表の版のどれかを選ぶので、古い版を持つ Worker が何台いてもよい。版 0 は slot の全体が P、版 1 は下の範囲が P で上の範囲が C である。書き込みは、piece ごとの blind write (Worker は主キーを知っているので、piece で宛先を決める) と、piece 1 と piece 2 に intent を置く取引 X である。X は anchor が c を決めた時点で確定し、phase 2 は piece ごとに、moved 表で決めた持ち主へ届く。

読みは 2 種類ある。主キーの読みは、M5b と同じく piece の持ち主が答える。テナントの読み (`WHERE tenant_id = ?`) では、Worker は shard key しか知らない。自分の版の範囲表でその slot を持つシャードの全部に、時刻 T と、そのシャードが持つはずの subslot の範囲 (以下 claim) を送り、揃った答えを合わせる。版 0 の Worker は P だけに送る。版 1 の Worker には P と C が別々の時点に答え、その間にほかの出来事が入る。片方に断られた読みは捨てる。

`tenantSplitSafe` は次の 5 つである。M5b の 5 つを piece に読み替えた。

- `singleOwner`: 受理した書き込みは、piece の持ち主だけにある。子は届いた piece の行だけを持ち、親が手放した piece の控えに、手放した時刻以後の行がない。
- `readConsistent`: 答えた読みは、T 時点の真の行の集合と一致する。テナントの読みでは、どの piece も、ちょうど 1 つのシャードが答える (抜けも重なりもない)。
- `noLostWrite`: piece の持ち主の行は、確定した書き込みの全部である (決着して未適用の intent を除く)。
- `intentNotLost`: intent は、その piece の持ち主にある。
- `noWriteBelowRead`: 答えた読みの時刻以下の時刻で、同じ piece への書き込みが確定しない。

決めた設計は、次の条件の上に立つ。1 つ外すと反例が出る。上の 3 つが、シャードがテナントの読みに答えるときの規則である。

| 条件 (定数) | 外したインスタンス | 反例 |
|---|---|---|
| 親は、claim に手放した piece (m を決めた piece) が 1 つでもあれば断る (`REFUSE_STALE`) | `m18_red_partial_answer` | piece 2 が C へ移る。版 0 の Worker のテナントの読みに、P が piece 1 だけを答える。Worker は P の答えを全部だと思うので、piece 2 の行がどこからも返らない |
| 子は、claim の piece が全部届いていて、T がどの piece の m よりも小さくないときだけ答える (`CHILD_WAITS_CLAIM`) | `m18_red_child_partial` | 上の範囲の piece 2 だけが届く。版 1 の Worker の読みに、C は piece 2 だけを、P は piece 1 だけを答える。まだ P にある piece 3 の行が返らない |
| 答える行を claim で絞る (`ANSWER_BY_CLAIM`) | `m18_red_answer_held` | piece 2 が C へ移る。P は、子の ack が届くまで、その行を控えとして持っている。版 1 の Worker の読みに、C が piece 2 を答え、P が piece 1 と控えの piece 2 を答える。piece 2 の行が 2 度返る |
| piece は時刻 m を運び、子は時計を m まで進める (`CARRY_CLOCK`) | `m18_red_piece_without_clock` | P が piece 2 を T で答える。piece 2 が C へ移り、C の時計は進まない。C が piece 2 への書き込みを T 以下の時刻で受理する。答えた読みが、後から書き込みの後になる |
| 書き込みの宛先と持ち主の確認を piece で決める (`WRITE_BY_PIECE`) | `m18_red_write_by_slot` | P が piece 2 の m を決めた後で、版 0 の Worker の piece 2 への書き込みを受理する。飛んでいる応答には入っていないので、C はその行を持たない。C が piece 1 への書き込みを受理する形もある |
| pull は、その piece の intent だけを運ぶ (`INTENTS_BY_PIECE`) | `m18_red_intents_by_group` | X が piece 1 に intent を置く。piece 2 の pull が shard key の intent を全部運び、P に残る piece 1 の intent が C へ行く |

`m18_red_write_by_slot` と `m18_red_piece_without_clock` には、決定的な run が 2 本ずつある (親の側と子の側、blind write と取引 X)。

16 MB を超えるテナントでは、上の範囲が何通もの応答に分かれて移る。`m18_green_chunks` は piece を 3 つにし、piece 2 と piece 3 が別々に移る。範囲表のとおりの claim では、移動の途中、テナントの読みはどちらの版でも揃わない。版 0 の claim は P が断り、版 1 の claim は、C が残りの piece を受け取るまで断る。主キーの読みと書きは、届いた piece について通る。このインスタンスでは、Worker が piece を P と C に好きに分けて claim にする (`ANY_CLAIM`)。どう分けても `tenantSplitSafe` は破れない。規則はシャードの側だけで閉じていて、Worker の分け方に頼らない。ただし、全部を調べたのはこのインスタンスだけで、取引 X がなく、読みの時刻も覚えない (`noWriteBelowRead` は確かめていない)。X と読みの時刻を入れた場合は、下のランダム探索だけが根拠である。分け方が実際の持ち主と合えば (P に、残る piece とまだ手放していない piece)、移動の途中でも読みは揃う (`witnessReadWhileMoving`)。モデルの P は、fence の後でも、まだ m を決めていない piece の読みに答える (M5b と同じ)。いまの実装は、fence した範囲の要求を全部断るので、移動の途中の読みを通すなら、そこも変えることになる。

| インスタンス | invariant | 定数 | 到達状態数 (distinct) | 深さ | 結果 |
|---|---|---|---|---|---|
| `m18_green` | `tenantSplitSafe` | piece 2 つ (1 つが移る)、blind write 2 件、取引 X、tick 1、T 0..3 | 1,444,786 (生成 1,534 万) | 17 | No violation |
| `m18_green_clock` | `tenantSplitSafe` | 同上で T 0..2、答えた読みの時刻を覚える | 1,708,337 (生成 1,583 万) | 17 | No violation |
| `m18_green_chunks` | `tenantSplitSafe` | piece 3 つ (2 つが別々に移る)、blind write 3 件、取引 X なし、tick 1、T 0..3、claim の分け方は任意 | 1,643,242 (生成 1,771 万) | 17 | No violation |
| `m18_red_partial_answer` / `_child_partial` / `_answer_held` | `readConsistent` | 条件を 1 つ外す | 反例 | 反例は 4 / 5 / 6 状態 | 反例 |
| `m18_red_piece_without_clock` | `noWriteBelowRead` | 同上 (`m18_green_clock` から) | 反例 | 反例は 7 状態 | 反例 |
| `m18_red_write_by_slot` | `singleOwner` / `noLostWrite` | 同上 | 反例 | 反例は 5 / 6 状態 | 反例 |
| `m18_red_intents_by_group` | `intentNotLost` | 同上 | 反例 | 反例は 5 状態 | 反例 |

`noWriteBelowRead` を確かめているのは `m18_green_clock` だけである。読みの時刻を覚えないインスタンスでは、この不変条件は破れようがない。状態数は、8 worker、heap 2.5 GB で測った。ほかの試験と同時に走らせて、green は 1 本 3 分ほどである。
`m18_red_child_partial` で TLC が見つける最短の反例は、上の表の形ではない。何も移っていないうちに、Worker が全部の piece を C の claim にし、C が何も返さずに答える。表の形は、決定的な run に固定してある。

TLC には大きすぎる定数は、ランダム探索で補った。`m18_green_wide` は、piece 3 つ、blind write 3 件、取引 X、読みの時刻を覚える、claim の分け方は任意、tick 2、T 0..6 である。`quint run --main=m18_green_wide --invariant=tenantSplitSafe --max-steps=40 --max-samples=1000000` で 100 万本の経路 (各 40 手) を調べ、違反はなかった (約 10 分)。これは抜き取りで、全探索ではない。同じ定数で条件を 1 つずつ外すと、6 つとも 1 秒以内に反例が出た (1 回だけ確かめた。外したインスタンスはファイルに残していない)。`check.sh` には含めない。

witness は 5 つである。`witnessSplitWritten` は、piece 2 が移った後で、C が piece 2 への書き込みを、P が piece 1 への書き込みを受理する。`witnessTenantReadBoth` は、テナントの読みに両方のシャードが答え、合わせた答えが、分割の後に両側で確定した行を含む。`witnessIntentMovedThenApplied` は、P で prepare した piece 2 の intent が子へ移り、子で適用される。`witnessHalfArrived` と `witnessReadWhileMoving` は `m18_green_chunks` のもので、上の範囲の piece が 1 つだけ届いた状態と、その状態で揃うテナントの読みである。

モデルが実装に求めること。

- テナントの読み (shard key の span) の要求は、Worker の範囲表でそのシャードが持つ (slot の範囲, subslot の範囲) を運ぶ。いまの実装は、全表の span に slot の範囲を付けている (`assertOwned` の `s.slots`)。これを subslot の範囲まで広げ、shard key の span にも付ける。全表の読みは、claim が全部の slot に広がるだけで、同じ規則になる。
- 親は、その範囲に、m を決めた piece が 1 つでも重なれば `NotOwner` を返す。残った行だけを答えない。
- 子は、その範囲の piece が全部届くまで答えない (pull するか、`Migrating` を返す)。届いた後は、T がどれかの piece の m より小さければ `ReadTooOld` を返す。子は、親にどの piece があるかを知らない。「全部届いた」と言えるのは、親に列挙させた後か、範囲の移動が終わった後である。
- 答える行は、要求の範囲で絞る。行の subslot は主キーから計算する。親は、手放した piece の行を ack まで持っているので、絞らなければ子の答えと重なる。
- 書き込み、prepare、phase 2 の持ち主の確認 (`fencedRange`、`moved`、`arrived`、`__moved_txn`) は、shard key ではなく piece で引く。
- `pull` と `ack` は、intent を shard key (`WHERE sk = ?`) ではなく piece で選ぶ。
- piece は m を運び、子は受け取るときに時計を m まで進める (いまの `receive` と同じ)。

範囲表のとおりの claim だけを使うと、大きいテナントは、移動の間、主キーを指定しない文が通らない。通すには、Worker が claim を piece の単位で分け直せる必要がある (たとえば、断る応答に、手放した範囲か届いた範囲を載せる)。その仕組みは、このモデルにはない。このモデルが示したのは、分け直しても安全であることだけである。仕組みそのもの (断る応答が piece の表を運び、Worker が claim を分け直す) は、M19 がモデルにした。

M5b の `singleOwner` は、破れようがない。M5b の blind write はグループごとに 1 件なので、「子が受理したグループを、後から親が受理する」が起きる余地がない。M18 では、受理された行がどのシャードにあるかを直接見る形にし、`m18_red_write_by_slot` で破れることを確かめた。M5b は直していない。

モデルにないもの。

- 行のない piece。pull されないので、範囲の移動が終わるときに子が到着なしで受け持ち、親の時計を受け取る (M5b の `finishRange`)。piece でも同じ形のはずだが、確かめていない。
- 2 つ目のグループ。slot を subslot で分けると、その slot にあるテナントが全部分かれる。移動は piece ごとなので、モデルの piece を別のグループのものと読めば同じである。
- テナントの読みを含む取引の検証。commit のとき、読んだ範囲を T から確かめ直す。読みと同じ claim の確認が要るはずである。書き込みは blind write だけを扱う (M5b と同じ)。
- 子の再分割、範囲表の版が 3 つ以上ある場合、シャードの併合。
- 親が控えの行を消す ack。モデルの親は控えを持ち続ける。
- piece の境界の決め方 (再送で同じ m を返すには、親が最初の pull で境界を決めて記録する必要がある) と、16 MB を超える 1 行。
- 活性。断られた読みが、範囲表を取り直した後で必ず通ることは確かめていない。移動の途中の読みについては、M19 が、claim を分け直す手順と、それが終わることを確かめた。
- 取引 X は、piece 1 と piece 2 に 1 行ずつ書く 1 件である。piece が 3 つのインスタンスには X がない。
- UNIQUE。piece ごとに運ばれた intent の適用は、M20 が扱う。

### M19 `m19_claim_resplit.qnt` — 移動の途中のテナントの読みを、claim を piece で分け直して通す

2026-11-14 に書いた。実装より先に書いたモデルで、対応する実装はまだない。M18 の規則では、大きなテナントが移る間 (1 GB で約 4 分)、範囲表のとおりの claim はどちらのシャードにも断られ、主キーを名指ししない文が `migrating:` で失敗する。持ち主は、これを認めないと決めた (`docs/design-subslots.md` の判断 3)。piece 単位の移動 (段 2) を実装する前に、Worker が claim を piece で分け直す仕組みが要る。M18 が示したのは、claim をどう分けても安全であることまでで、Worker が分け方を知る手順と、やり直しが終わることはモデルになかった。

設計は、断る応答に piece の表を載せる。

- 親 P の表は、手放した piece (m を決めた piece) と、その m である。子 C の表は、届いた piece と、その m である。
- Worker は、表のとおりに claim を分け直して、同じ読みを同じ時刻 T で続ける。P に断られたら、claim のうち P が手放した piece を C の claim へ移し、その piece を「手放したと P が言った piece」として、読みが終わるまで覚える (以下 sure)。C に断られたら、claim のうち C に届いていない piece で sure でないものを、P の claim へ移す。
- 表の m が T より大きければ、その piece を T で答えられるシャードはない (P は手放し、C は T < m を断る)。Worker は T を表の m の最大まで上げ、それまでの答えを捨てて、全部の piece を新しい T で聞き直す。sure は残す。
- シャードの規則は M18 のままである。P は claim の全部をいま持っているとき、C は claim の全部が届いていて T がどの m よりも小さくないときだけ答え、claim の中の行だけを返す。Worker の表は古くてよい。古ければ、また断られて、新しい表を受け取る。
- C は、届いていない piece が sure のものだけなら、断らずに待つ。P が切った後なので、待つのは応答 1 通分である (実装では、その piece だけを pull する)。sure でない piece が届いていなければ、待たずに断る。範囲表のとおりの claim で待つと、テナントの全体を pull することになる。

P が、断る応答に、まだ持っている部分の答えを一緒に載せてもよい。モデルでは、断る手と、分け直した claim に答える手が続けて起きる場合に当たる。

モデルの舞台は M18 と同じである。親 P、子 C、テナント 1 つ。piece 1 は subslot の下の範囲にあって P に残り、piece 2 と piece 3 が 1 つずつ C へ移る。piece は主キーの順に並んだ区間で、番号がその順である。モデルの piece は、切られ得る最小の単位と読める (Worker の claim は piece の任意の集合なので、実装の 1 つの区間は、その和に当たる)。移動 (fence、範囲表の切り替え、pull、応答の喪失と再送、時刻 m の持ち運び)、piece ごとの blind write、piece 1 と piece 2 に intent を置く取引 X は、M18 から写した。違うのは読みである。Worker は、1 つの読みについて、P と C に出している claim、覚えた sure、受け取った答え、断られた回数を持つ。最初の claim は、範囲表の版 0 (全部を P)、版 1 (piece 1 を P、残りを C)、または任意の分け方 (`ANY_START`。前の読みで覚えた表が古くなっている場合を含む) である。シャードが答える手と断る手は別々に起き、その間に移動も書き込みも進む。

`resplitSafe` は次の 9 つである。

- `readConsistent`: 揃った答えは、T 時点の真の行の集合と一致する。どの piece も、ちょうど 1 つのシャードが答える。
- `readAtSomeT`: 揃った答えは、どれかの時刻の真の行の集合と一致する (`readConsistent` より弱い。違う時刻の答えを合わせた赤が、本当に読みを裂くことを示すために置いた)。
- `answeredOnlyHeld`: シャードは、T の時点で全部を持っていない claim に答えない。
- `noWriteBelowRead`: 答えた読みの時刻以下の時刻で、同じ piece への書き込みが確定しない。
- `boundedRetries`: 1 つの読みが断られる回数は、上限 (`RETRY_MAX`) 以下である。断る手に、回数での歯止めは付けていない。
- `readNotStuck`: 進行中の読みは行き止まりにいない。出している claim は、答えられるか、断られるか、いつでも打てる手 (切られた piece の pull とその到着、X の phase 2) を待っている。
- `singleOwner`、`noLostWrite`、`intentNotLost`: M18 と同じ。

終わること。`boundedRetries` と `readNotStuck` は、安全性の形で書いた。P が断るたびに、Worker の知らなかった cut が 1 つ以上ある。C が断るたびに、sure でない piece が P へ移るか、T が上がる。piece は有限で、cut は取り消されないので、断られる回数には上限がある。これに加えて、活性そのものを `m19_live` で確かめた。`readTerminates` は、「Worker があきらめなければ、始めた読みはいつか揃う」である。仮定する公平性は、(a) シャードは、出ている claim に、答えられるなら答え、断るなら断る (弱い公平性)、(b) 切られた piece の pull は届くまでやり直され (弱い公平性)、応答は失われ続けない (強い公平性)、(c) X の phase 2 はいつか届く (弱い公平性)、の 3 つである。新しい piece を切る手には、公平性を置いていない。つまり、移動が途中で止まっても、進み続けても、読みは揃う。どちらの検査も、piece が有限であることに頼っている。

決めた設計は、次の条件の上に立つ。1 つ外すと反例が出る。

| 条件 (定数) | 外したインスタンス | 反例 |
|---|---|---|
| P は、claim をいまの表で確かめる (`MAP_CURRENT`) | `m19_red_stale_map` | P が piece 2 を手放し、Worker の読み (T = 3) を断って表を返す。Worker は P に piece 1 と piece 3 を聞き直す。その後で piece 3 が m = 2 で移り、C が piece 3 に時刻 3 で書く。P は、claim が自分の表から作られたものなので、いまの表を見ずに、控えの行で piece 3 を答える。m より後で T 以下の書き込みが抜ける |
| T を上げたら、それまでの答えを捨てる (`SAME_T`) | `m19_red_mixed_t` | P が piece 1 を T = 1 で答える。その後、P が piece 1 に時刻 2 で、piece 2 に時刻 3 で書き、piece 2 が m = 4 で移る。C が断り、Worker は T を 4 に上げるが、piece 1 の古い答えを残す。合わせた答えは、piece 2 の時刻 3 の行を含み、piece 1 の時刻 2 の行を含まない。どの時刻の状態とも一致しない |
| 分け直した claim は、断られた claim をちょうど覆う (`SPLIT_EXACT`) | `m19_red_gap` | P が piece 2 を手放し、表を返す。Worker は、区間の終わりの piece を C の claim に入れない (終わりを含まない区間として扱う)。P の答えだけで揃ったことになり、piece 2 の行がどこからも返らない。どのシャードも、持っていない claim には答えていない |
| Worker は、P の表 (sure) を読みの間覚えている (`KEEP_MAP`) | `m19_red_forget_map` | P が piece 2 を切り、応答が飛んでいる。C は「届いていない」と断り、Worker は piece 2 を P に聞く。P は「手放した」と断り、Worker は C に聞く。応答が届くまで繰り返す。破れるのは回数の上限 (`boundedRetries`) だけである。応答が届けば読みは揃い、答えも正しい |
| C は、sure でない piece が届いていなければ、待たずに断って表を返す (`C_REFUSES`) | `m19_live_red_child_waits` | M18 までの子の規則 (claim の全部が届くまで待つ) に戻す。piece 2 だけが届き、piece 3 は P にあって切られていない。版 1 の Worker が、C に piece 2 と piece 3 を聞く。C は、piece 3 が移ってくるまで、答えも断りもしない。移動が止まれば、読みは終わらない (`readTerminates` と `readNotStuck`)。答えは間違えない |
| piece は時刻 m を運び、子は時計を m まで進める (`CARRY_CLOCK`) | `m19_red_piece_without_clock` | P が、分け直した読みで、まだ切っていない piece 3 を T = 2 で答える。piece 3 が移り、C の時計は進まない。C が piece 3 への書き込みを時刻 1 で受理する |

持ち主が挙げた 3 つの赤との対応は、「読みの T より古い表で答える」が `m19_red_stale_map`、「違う T の答えを合わせる」が `m19_red_mixed_t`、「区間の間に抜けがある」が `m19_red_gap` である。

| インスタンス | 性質 | 定数 | 到達状態数 (distinct) | 深さ | 結果 |
|---|---|---|---|---|---|
| `m19_green` | `resplitSafe` | piece 3 つ (2 つが別々に移る)、取引 X (piece 1 と piece 2)、blind write 1 件 (piece 3)、読み 1 回、最初の claim は範囲表の版 0 か版 1、T 0..3 | 2,427,648 (生成 946 万) | 21 | No violation |
| `m19_green_clock` | `resplitSafe` | 同上で T 0..2、答えた読みの時刻を覚え、読みの後の書き込みまで調べる | 2,063,856 (生成 794 万) | 22 | No violation |
| `m19_green_any` | `resplitSafe` | 最初の claim の分け方は任意、取引 X なし、blind write 2 件 (piece 2 と piece 3)、tick 1、T 0..2 | 149,216 (生成 71 万) | 19 | No violation |
| `m19_green_any_x` | `resplitSafe` | 最初の claim の分け方は任意、取引 X は移る piece 2 つ (piece 2 と piece 3)、blind write なし、T 0..2 | 566,498 (生成 240 万) | 19 | No violation |
| `m19_live` | `readTerminates` (時相) | 取引 X (piece 1 と piece 2)、blind write なし、Worker は読みをあきらめない、T 0..1 | 164,017 (生成 56 万) | 19 | No violation |
| `m19_live_red_child_waits` | `readTerminates` (時相) / `readNotStuck` | 同上で取引 X なし、条件を 1 つ外す | 反例 | 反例は 4 状態の後で足踏み / 4 状態 | 反例 |
| `m19_red_stale_map` | `readConsistent` / `answeredOnlyHeld` | 条件を 1 つ外す。取引 X なし、blind write 1 件、T 0..3 | 反例 | 反例は 11 / 8 状態 | 反例 |
| `m19_red_mixed_t` | `readAtSomeT` | 同上で blind write 3 件 | 反例 | 反例は 11 状態 | 反例 |
| `m19_red_gap` | `readConsistent` | 同上で blind write 1 件 | 反例 | 反例は 6 状態 | 反例 |
| `m19_red_forget_map` | `boundedRetries` | 同上 | 反例 | 反例は 8 状態 | 反例 |
| `m19_red_piece_without_clock` | `noWriteBelowRead` | 同上で T 0..2、答えた読みの時刻を覚える | 反例 | 反例は 8 状態 | 反例 |

`noWriteBelowRead` を確かめているのは `m19_green_clock` だけである。読みの時刻を覚えないインスタンスでは、この不変条件は破れようがない。状態数は、8 worker、heap 2.5 GB で測った (`TLC_CONFIG` で渡す。quint は TLC を `-Xmx8G` で起動し、`JAVA_TOOL_OPTIONS` では下がらない)。ほかの検査と同時に走らせて、green は 1 本 30 秒から 2 分半、活性の検査は約 1 分である。

調べる状態を減らすために、2 つを省いた。揃った読みからは、捨てる手だけを打つ。読みが 1 回終わった後の世界は、読みの時刻を覚えるインスタンスでだけ調べる。読みに関する不変条件はその先で破れようがなく、残りの 3 つは M18 が調べている。

TLC には大きすぎる定数は、ランダム探索で補った。`m19_green_wide` は、piece 4 つ (3 つが別々に移る)、blind write 3 件、移る piece 2 つに書く取引 X、読みの時刻を覚える、最初の claim は任意、読み 2 回、tick 2、T 0..6 である。`quint run --main=m19_green_wide --invariant=resplitSafe --max-steps=40 --max-samples=300000` で 30 万本の経路 (各 40 手) を調べ、違反はなかった (約 3 分)。断られる回数の上限は 4 (移る piece の数 + 1) にしてある。これは抜き取りで、全探索ではない。同じ定数で、上の表の 6 つの条件を 1 つずつ外すと、6 つとも 30 秒以内に反例が出た (1 回だけ確かめた。外したインスタンスはファイルに残していない)。`check.sh` には含めない。

witness は 6 つである。`witnessResplitWhileMoving` は、移動の途中のテナントの読みが、分け直した後で、P の答え (残る piece と、まだ切っていない piece) と C の答え (届いた piece) で揃う。`witnessResplitTwice` は、読みの間に piece が移り、P に 2 度断られてから揃う。`witnessDoneWhilePieceFlying` は、P が piece を T で答えた後でその piece が切られ、応答が飛んでいる間に、C の答えで揃う。`witnessRestartedThenDone` は、T を上げて聞き直してから揃う。`witnessXSeenOnBoth` は、分け直した読みが、P の答えと C の答えの両方に X の行を見る。`witnessRetryMaxReached` は、断られる回数が上限に届く (`m19_green` と `m19_green_any`)。

モデルが実装に求めること。段 2 の受け入れの条件として使える形で書く。

- 断る応答が、そのグループの piece の表を運ぶ。親は `NotOwner` に、手放した piece の区間と m (`__moved` の行) を載せる。子は、受け取り中の範囲の shard key の span を断る応答に、届いた piece の区間と m (`__arrived` の行) を載せる。隣り合う区間はまとめてよい。Worker が使うのは、区間と、その中の m の最大だけである。
- shard key の span の claim は、subslot の範囲に加えて、位置の区間 `(after, upTo]` の並びを運ぶ。区間ごとに、親が手放したと言ったかどうか (sure) を付ける。
- 親は、fence した範囲でも、まだ切っていない区間の読みに答える。いまの実装と設計の文書は、fence した範囲の要求を全部断る。答えるときに時計を T まで進めるので (いまの読みと同じ)、その後に切る piece の m は T より大きい。書き込みと prepare は、今までどおり断る (M20 が頼っている)。
- 親は、claim の区間に、手放した piece が 1 つでも重なれば断る。確かめる相手は、答えを読むのと同じ同期区間の、いまの `__moved` である。要求が名乗る表の版や、前に返した表では判断しない。
- 子は、claim の区間の全部が、届いた piece で覆われ、T がどの m よりも小さくないときだけ答える。覆われていない部分が sure の区間だけなら、その piece を pull して待つ。sure でない区間が覆われていなければ、pull せずに、表を付けて断る。
- 答える行は、claim の区間で絞る。設計の文書の「絞らずに断る」は、この経路では成り立たない (親は、手放した piece の行を ack まで持っている)。絞り込みは走査の条件になるので、移動の途中のテナントの文は、行を集める経路 (部分集約、Top-N、基準経路) で実行する。
- Worker は、1 つの文の読みを、1 つの時刻 T で揃える。表の m が T より大きければ、T をその m 以上に上げ、それまでに集めた答えを全部捨てて聞き直す。取引の中の文は、T を自由には上げられない。read-time refresh (M1b) で上げられなければ、今と同じ `ReadTooOld` (やり直せる誤り) になる。
- 分け直した claim は、断られた claim をちょうど覆い、重ならない。区間は `(after, upTo]` で、境目には表の値をそのまま使う。シャードは抜けを見つけられないので、守るのは Worker である。検査は 2 つ要る。分け直す関数の性質の試験 (乱択の表と claim で、分け直した区間が重ならず、和が元の claim に等しい。境目の行を含む) と、移動の途中の文を SQLite と突き合わせる試験 (`replay` に分割を足したもの) である。
- Worker は、親の表 (sure) を、文が終わるまで覚える。
- 断られた回数の上限は、固定の回数 (いまの 12 回) と分ける。親が断るたびに移動が 1 piece 以上進んでいるので、長い文は、その間に切られた piece の数だけ断られ得る。モデルの上限は、移る piece が 2 つで 3 回である (最初の claim が範囲表のとおりでも、任意でも同じで、3 回に届く経路がある)。移る piece が 3 つのランダム探索では、4 回を超えなかった。移る piece の数 + 1 と読める。親に断られるのは、移る piece 1 つにつき 1 回までである (断られるたびに、その piece が sure になって C の claim へ移り、戻らない)。

モデルにないもの。

- 取引の検証。commit のとき、読んだ範囲を T から確かめ直す。分け直した claim で読んだ取引は、検証も同じ claim で行うことになり、読みと確定の間に piece が移ると、検証が断られる。そのときの手順 (中止してやり直すか、検証も分け直すか) は決めていない。書き込みは blind write だけを扱う (M5b、M18 と同じ)。
- 書き込みを伴うテナントの文。条件つきの UPDATE と DELETE は、読みを分け直して集め、主キーで書けば、この読みの上に乗る。UNIQUE の値を書く文は、M20 の条件 (子はグループが揃うまで受けない) に当たり、移動の間は通らない。
- piece の境目を pull のときに決めること (M18 の「モデルにないもの」と同じ)。
- 表の大きさ。1 GB のテナントを 1 MB の piece で運ぶと、表は約 1,000 行になる。応答に載せる量の上限と、まとめ方は扱っていない。
- 子が、sure の piece を待ちきれずに期限で断る場合 (`Migrating`)。同じ claim の聞き直しになる。
- 2 つ目のグループと、テナントを名指ししない全表の読み。表はグループごとなので、全表の読みでは、応答に載る表が大きくなる。
- 子の再分割と、3 つ目のシャード。表の宛先がさらに手放していれば、同じ規則を繰り返すはずだが、確かめていない。
- 2 回以上の読みと、同時に進む 2 つの読み。TLC の全探索は読み 1 回だけである。前の読みが残すもの (進んだ時計、X の push) の後で始まる読みは、ランダム探索 (読み 2 回) だけが調べている。全探索のインスタンスの tick は、0 回か、0 から 1 への 1 回である。
- T を上げる先は、表の m の最大だけである (許されるいちばん小さい時刻)。

### M20 `m20_unique_piecewise.qnt` — グループを piece に分けて運ぶ間も、確定した取引は UNIQUE を守って適用できる (不変条件 2)

2026-11-14 に書いた。実装より先に書いたモデルで、対応する実装はまだない。shard key を含む UNIQUE は、各シャードの SQLite の index が守る (M16)。これは、1 つの shard key の行が 1 つのシャードにあることに頼っている。piece 単位の移動 (`docs/design-subslots.md` の段 2) では、fence の前に置かれた intent が、piece と一緒に別々の時点に運ばれ、別々に適用される。設計の文書は、確定した取引がこれで適用できなくなる形を見つけ、規則を 1 つ足した。その規則を、実装の前に確かめた。

モデルは、M16 を 2 つのシャードに広げたものである。グループ 1 つ、行 3 つ (行 1 は piece 1、行 2 と行 3 は piece 2)、値は不在と 2 種類 (設計の文書の例を固定する run だけ 3 種類)、取引 2 つ。取引は 1 行か 2 行に値を書く。書き込みはどれも UNIQUE の値に触れる (触れない書き込みは、このモデルに関係がない)。prepare は M16 の 2 つの状態で確かめ、確かめる相手は、受けたシャードの表である。親の表は、切った piece の行を ack まで控えとして持つ。piece は、切る (最初の pull に答えて m を決める)、届く、ack の順に進む。intent は行と一緒に動く (M18 の `intentNotLost`)。適用は、そのシャードがいま持っている、その取引の intent を、まとめて 1 度に行う。

`uniqueSafe` は次の 2 つである。

- `committedApplies`: 確定した取引の適用も、piece の受け取りも、シャードの UNIQUE の index に断られない。
- `uniqueVisible`: 見える状態 (行の持ち主の値に、確定して未適用の intent を重ねたもの) に、同じ値の行が 2 つない。

決めた設計は、次の 3 つを合わせる。3 つが揃うと、最初の piece を切ってからグループが子で揃うまで、そのグループの UNIQUE の値は変わらない。1 つ外すと反例が出る。

| 条件 (定数) | 外したインスタンス | 反例 |
|---|---|---|
| 親は、グループの最初の piece を切る前に、そのグループの intent を決着させる。確定していれば、グループの全体を持っているうちに、取引の分をまとめて適用する。未決着なら切らない (`SETTLE = 1`) | `m20_red_piecewise` (設計の文書の例の run は `m20_red_piecewise_note`) | 設計の文書の例。r1 = 'a' (piece 1)、r2 = 'b' (piece 2)。X が r2 を 'c' に、r1 を 'b' に変える intent を置く。piece 1 が届き、X が確定し、子が r1 の intent を適用する (子の r1 は 'b')。piece 2 が古い行 r2 = 'b' を運んで届き、子の index が挿入を断る。親の側の形もある。piece 2 を先に渡すと、親は控えの r2 = 'b' を持ったまま r1 を 'b' にしようとする。どちらも、見える状態は UNIQUE を守っている (`uniqueVisible` は破れない)。破れるのは適用である |
| fence の後、親は新しい intent を受けない (`PARENT_STOPS`) | `m20_red_late_intent` | piece 1 (r1 = 1) が子へ移り、親が控えを消す。親が、r2 を 1 にする書き込みを受ける。親の表にはもう r1 がないので、衝突しない。確定すると、r1 と r2 がどちらも 1 になる |
| 子は、グループが揃うまで、UNIQUE の値を書く文を受けない (`CHILD_CHECK = 0`) | `m20_red_child_early` | piece 1 (r1 = 1) だけが子に届いている。子が、手元の行だけで確かめて、r1 を 2 にする書き込みを受ける。r2 = 2 は親にある。piece 2 が届くと、子の index が挿入を断る |

決着させる範囲。設計の文書の規則は、最初の piece を切る前に、グループの intent を全部決着させる。`m20_green_per_piece` は、これを「切る piece の中の intent だけ」に弱める (piece を切るたびに確かめる)。これでも破れない。どちらの規則でも、UNIQUE の値に触れる intent は piece と一緒に運ばれず、取引の分は親でまとめて適用されるからである。弱い規則は、遠い piece に長い取引の intent があっても、手前の piece を切れる。ただし、piece を切るたびに確かめることになり、適用で行の大きさが変わるので、区間を決める前に決着させることになる。下の段落の理由もあって、段 2 には設計の文書の規則 (グループの全部) を勧める。

子がグループの揃う前に受ける場合。3 つ目の条件は、大きなテナントが移る間、UNIQUE の値を書く文 (UNIQUE のある表への 1 行の INSERT を含む) を `migrating:` で失敗させる。これは、持ち主の判断 3 (主キーを名指ししない文の失敗を認めない) とぶつかる。主キーを名指しした INSERT も止まるので、判断 3 が挙げた範囲より広い。`m20_green_child_reads_parent` は、子が、手元の行と、まだ届いていない piece の親の行を合わせて確かめる形 (`CHILD_CHECK = 2`) を調べた。グループの全部を決着させる規則 (`SETTLE = 1`) の下では、破れない。最初の piece を切った後、親に残る行は変わらないからである。切る piece の中だけを決着させる規則では破れる (`m20_red_child_reads_parent_per_piece`。親に残る piece の未決着の intent を、子の確かめが見ない)。ただし、このインスタンスは、親の行を読むことと prepare の間に何も入らないものとして表している。実装では、親の行を読むのは M19 の分け直した読みで、取引の span として確定のときに検証することになる。その手順はモデルにない。この形を採るかどうかは、持ち主の判断である。

| インスタンス | invariant | 定数 | 到達状態数 (distinct) | 深さ | 結果 |
|---|---|---|---|---|---|
| `m20_green` | `uniqueSafe` | 行 3 つ (piece 2 つ)、値 2 種類と不在、取引 2 つ (1 行か 2 行を書く)、最初の値は任意、グループの全部を決着させてから切る | 121,282 (生成 931 万) | 14 | No violation |
| `m20_green_per_piece` | `uniqueSafe` | 同上で、切る piece の中の intent だけを決着させる | 136,096 (生成 935 万) | 14 | No violation |
| `m20_green_child_reads_parent` | `uniqueSafe` | `m20_green` で、子が、揃う前でも、親に残る行と合わせて確かめて受ける | 154,666 (生成 1,988 万) | 14 | No violation |
| `m20_red_piecewise` | `committedApplies` | 条件を 1 つ外す (決着させずに切る) | 反例 | 反例は 6 状態 | 反例 |
| `m20_red_piecewise` | `uniqueVisible` | 同上 | 571,054 (生成 2,301 万) | 15 | No violation (見える状態は破れない) |
| `m20_red_late_intent` | `uniqueVisible` / `committedApplies` | 条件を 1 つ外す (fence の後も、親が intent を受ける) | 反例 | 反例は 7 / 10 状態 | 反例 |
| `m20_red_child_early` | `uniqueVisible` / `committedApplies` | 条件を 1 つ外す (子が、揃う前に、手元の行だけで確かめて受ける) | 反例 | 反例は 6 / 9 状態 | 反例 |
| `m20_red_child_reads_parent_per_piece` | `uniqueVisible` | `m20_green_child_reads_parent` で、切る piece の中の intent だけを決着させる | 反例 | 反例は 8 状態 | 反例 |

状態数は、8 worker、heap 2.5 GB で測った。green は 1 本 1 分から 1 分半である。`check.sh` の M19 と M20 の節は、合わせて 49 本で、この設定で約 20 分かかった (ほかの検査と同時に走らせた値)。`m20_red_piecewise_note` は、設計の文書の例 (値が 3 種類) を、子の側と親の側の 2 本の run に固定したもので、TLC では調べない。

witness は 4 つである。`witnessCrossAppliedThenMoved` は、2 つの piece にまたがる取引が親でまとめて適用され、その後でグループが 2 つの piece で子へ移る。`witnessFirstCutWaited` は、fence の後も未決着だった取引が決着するのを待ってから、最初の piece が切られ、グループが子へ移る。`witnessChildWrote` は、グループが揃った後で、子が UNIQUE の値を書く取引を受けて適用する。`witnessChildWroteEarly` (`m20_green_child_reads_parent`) は、片方の piece だけが届いている間に、子が受けて適用する。

モデルが実装に求めること。段 2 の受け入れの条件として使える形で書く。

- 親は、グループの最初の piece を切る pull の中で、そのグループに、UNIQUE の値に触れる intent (UNIQUE のある表への挿入と削除、UNIQUE の列を変える更新) が残っていないことを確かめる。残っていれば、anchor に尋ねて決着させる。確定していれば、その取引がこのシャードに置いた分を、1 つの同期区間でまとめて適用する。中止なら消す。未決着なら、m を決めずに、pull を待たせる。確かめることと、m を決めて記録することは、同じ同期区間で行う。
- fence の後、親は、その範囲の書き込みと prepare を受けない (いまの実装のまま)。M19 のために、親が fence した範囲の読みに答えるようにしても、書き込みは受けない。
- 子は、グループの piece が揃うまで、そのグループの UNIQUE の値を書く文と prepare を受けない (pull して待つか、`Migrating` を返す)。主キーを名指しした、UNIQUE の値に触れない書き込みは、届いた piece について通る。
- 親は、切った piece の行 (控え) を、ack まで変えない。phase 2 は、切っていない piece の分だけを適用する。
- `receive` の挿入が UNIQUE に断られたら、握りつぶさずに失敗させる。上の 3 つが守られていれば、起きない。
- 欠陥のスイッチを 1 つ足す (決着させずに切る)。`m20_red_piecewise_note` の 2 本の run (子の側と親の側) を、実コードで再生する。`replay` の表は `UNIQUE (tenant_id, code)` を持つので、1 通で運べる大きさの上限を小さくした分割で、この形に届く。

モデルにないもの。

- 待たされた pull の活性。取引が決着しない間、最初の piece は切れない。決着は 2PC の期限 (presumed abort) に頼る。待った後で切れる経路があることだけを確かめた (`witnessFirstCutWaited`)。
- slot を subslot で割る移動 (段 4)。モデルは、グループの全部が移る場合 (段 2 の、slot の全体の移動) である。subslot で割ると、親にグループの一部が残り、親は残る行への書き込みを受け続ける。これは 2 つ目の条件を外した形で、`m20_red_late_intent` が、そのままでは破れることを示している (親は、控えを消した後、子へ移った行の値を知らない)。段 4 では、最初の piece を切った時点から、そのグループの UNIQUE の値の書き込みを、分かれた slot の経路 (同じ値の行を持ち主の全部から読む 2PC) に乗せるか、移動が終わるまで断ることになる。どちらも確かめていない。
- piece の境目を pull のときに決めること。モデルの行の位置は 3 つで、どの piece に入るかは決まっている。行のない位置への INSERT は、その位置に値を書くこととして入っているが、子がその位置を含む piece を pull してから挿入する手順 (設計の文書の `at`) は扱わない。
- 時刻。見える状態は、確定の順に重ねたものとして表す (M16 と同じ)。
- シャードをまたぐ UNIQUE の index (`__gidx_*`) と、既存の行への `CREATE UNIQUE INDEX` (分かれたテナントの突き合わせ。設計の文書の判断 5)。
- 移動が終わった後も分かれたままのテナント (subslot で割った slot)。そこでの UNIQUE の値の書き込みは、設計の文書の「同じ値の行を持ち主の全部から読む 2PC」で、M1 の検証に頼る。
- 適用の中の順序。SQLite は UNIQUE を行ごとに確かめるので、値の入れ替えは、消してから入れる順でしか適用できない。モデルの適用は、M16 と同じく、終わった状態だけを見る。

