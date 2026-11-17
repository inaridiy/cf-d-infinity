#!/usr/bin/env bash
# 全モデルの一括検査。
#   green: TLC の全探索で No violation
#   red:   TLC が反例を見つける (違反検出 = 成功)
#   witness: 到達可能性 (not(到達したい状態) を invariant にして違反 = 成功。vacuous でないことの確認)
#   test:  run (決定的な反例・到達トレース) が通る
#   inductive: Apalache で帰納的不変条件を確認 (M4)
#   live:  TLC で時相の性質 (活性) を確かめる (M19)
# 使い方: cd specs && ./check.sh            (HEAVY=1 ./check.sh で NTXN=3 の M1 も回す)
#   TLC_CONFIG=<file> ./check.sh で、TLC の heap と worker の数を JSON で渡す (例: { "maxHeap": "-Xmx2500m", "workers": 8 })。
#   quint は TLC を -Xmx8G で起動する。コマンド行の指定なので、JAVA_TOOL_OPTIONS では下がらない
set -u
cd "$(dirname "$0")"
# TLC には Java 17 以上が要る。specs/.tools/jdk に置いてあればそれを使い、なければ PATH の java を使う。
if [ -d "$PWD/.tools/jdk" ]; then export JAVA_HOME="$PWD/.tools/jdk" PATH="$PWD/.tools/jdk/bin:$PATH"; fi

pass=0; fail=0
ok()   { pass=$((pass+1)); printf '  ok   %s\n' "$1"; }
bad()  { fail=$((fail+1)); printf '  FAIL %s\n' "$1"; }
tlc_config=()
if [ -n "${TLC_CONFIG:-}" ]; then tlc_config=(--tlc-config="$TLC_CONFIG"); fi
# quint verify は、型の検査に Apalache のサーバを使い、既定では決まったポート (8822) に立てる。同じ計算機で 2 つの検査を
# 同時に流すと、ポートを取り合ってサーバが立たず、検査が答えを出さないまま終わる (2026-11-14 に、red が 9 件「反例なし」と出た)。
# この実行の間は、空いているポートを 1 つ選んで使う。
port=$(python3 -c 'import socket; s = socket.socket(); s.bind(("127.0.0.1", 0)); print(s.getsockname()[1])')
server=(--server-endpoint="localhost:$port")
# verdict <出力>: TLC の答え。ok (違反なし)、violation (違反あり)、none (答えがない: 道具の誤り、メモリ不足など)。
# 答えがないのに「反例なし」と出すと、モデルの誤りと道具の誤りの見分けがつかないので、分けて出す。
verdict() {
  if printf '%s\n' "$1" | grep -q '\[violation\]'; then echo violation
  elif printf '%s\n' "$1" | grep -q '\[ok\] No violation found'; then echo ok
  else echo none; fi
}

# verify_expect <expected: ok|violation> <file> <module> <invariant>
verify_expect() {
  local expect=$1 file=$2 mod=$3 inv=$4 out
  out=$(npx quint verify --backend=tlc "${server[@]}" ${tlc_config[@]+"${tlc_config[@]}"} --main="$mod" --invariant="$inv" "$file" 2>&1)
  local states got
  states=$(printf '%s\n' "$out" | grep -oE '[0-9,]+ distinct states found' | tail -1)
  got=$(verdict "$out")
  case "$expect:$got" in
    ok:ok) ok "green    $mod $inv ($states)" ;;
    ok:violation) bad "green    $mod $inv (violation found)"; printf '%s\n' "$out" | tail -5 ;;
    violation:violation) ok "$5 $mod $inv ($states)" ;;
    violation:ok) bad "$5 $mod $inv (no violation found)"; printf '%s\n' "$out" | tail -5 ;;
    *) bad "${5:-green   } $mod $inv (no verdict: the checker did not finish)"; printf '%s\n' "$out" | tail -5 ;;
  esac
}
green()   { verify_expect ok "$@"; }
red()     { verify_expect violation "$@" "red     "; }
witness() { verify_expect violation "$@" "witness "; }
# live_expect <expected: ok|violation> <file> <module> <temporal property>
live_expect() {
  local expect=$1 file=$2 mod=$3 prop=$4 out
  out=$(npx quint verify --backend=tlc "${server[@]}" ${tlc_config[@]+"${tlc_config[@]}"} --main="$mod" --temporal="$prop" "$file" 2>&1)
  local states got
  states=$(printf '%s\n' "$out" | grep -oE '[0-9,]+ distinct states found' | tail -1)
  got=$(verdict "$out")
  case "$expect:$got" in
    ok:ok) ok "live     $mod $prop ($states)" ;;
    ok:violation) bad "live     $mod $prop (violation found)"; printf '%s\n' "$out" | tail -5 ;;
    violation:violation) ok "live red $mod $prop ($states)" ;;
    violation:ok) bad "live red $mod $prop (no violation found)"; printf '%s\n' "$out" | tail -5 ;;
    *) bad "live     $mod $prop (no verdict: the checker did not finish)"; printf '%s\n' "$out" | tail -5 ;;
  esac
}
live()     { live_expect ok "$@"; }
live_red() { live_expect violation "$@"; }
tests() {
  local file=$1 mod=$2 out
  out=$(npx quint test --main="$mod" "$file" 2>&1)
  if printf '%s\n' "$out" | grep -qE 'failed|error'; then bad "test     $mod"; printf '%s\n' "$out" | grep -E 'failed|Error|error' | head -5
  else ok "test     $mod ($(printf '%s\n' "$out" | grep -oE '[0-9]+ passing'))"; fi
}
inductive() {
  local file=$1 mod=$2 ind=$3 inv=$4 out
  out=$(npx quint verify "${server[@]}" --main="$mod" --inductive-invariant="$ind" --invariant="$inv" "$file" 2>&1)
  if printf '%s\n' "$out" | grep -q '\[ok\] No violation found'; then ok "inductive $mod $ind => $inv"; else bad "inductive $mod $ind"; printf '%s\n' "$out" | grep -vE 'I@|protobuf|gencode' | tail -5; fi
}

echo "== M1 serializable_commit (TLC 全探索)"
f=m1_serializable_commit.qnt
green   $f m1_green serializable
for m in m1_red_a m1_red_b m1_red_c m1_red_d m1_red_e m1_red_g; do red $f $m serializable; done
witness $f m1_green witnessCrossCommit
witness $f m1_green witnessRefreshCommit
witness $f m1_green witnessROSeesCross
for m in m1_green m1_red_a m1_red_b m1_red_c m1_red_d m1_red_e m1_red_g; do tests $f $m; done
if [ "${HEAVY:-0}" = "1" ]; then green $f m1_green3 serializable; fi

echo "== M2 snapshot_read (M1 と同じモデル、invariant = atomicVisibility)"
green   $f m2_green atomicVisibility
red     $f m2_red atomicVisibility
tests   $f m2_green
tests   $f m2_red

echo "== M3 anchor_recovery"
f=m3_anchor_recovery.qnt
green   $f m3_green recovery
red     $f m3_red recovery
witness $f m3_green witnessAllApplied
witness $f m3_green witnessTombstoneAfterRestart
tests   $f m3_green
tests   $f m3_red

echo "== M4 hlc_restart"
f=m4_hlc_restart.qnt
green   $f m4_green commitAfterRead
green   $f m4_green_lease commitAfterRead
red     $f m4_red commitAfterRead
witness $f m4_green witnessCommitAfterRestartRead
tests   $f m4_green
tests   $f m4_red
inductive $f m4_green inductive commitAfterRead

echo "== M5 split_fence"
f=m5_split_fence.qnt
green   $f m5_green splitSafe
red     $f m5_red_switch splitSafe
red     $f m5_red_intents splitSafe
witness $f m5_green witnessDoneWithBoth
witness $f m5_green witnessIntentResolvedAtChild
tests   $f m5_green
tests   $f m5_red_switch
tests   $f m5_red_intents

echo "== M5b live_migration (S2 + S3 の pull 型再構成)"
f=m5b_live_migration.qnt
green   $f m5b_green migrationSafe
for m in m5b_red_s3 m5b_red_s3_parent m5b_red_p2 m5b_red_p2_window m5b_red_intents; do red $f $m migrationSafe; done
witness $f m5b_green witnessMovedAndWritten
witness $f m5b_green witnessIntentMovedThenApplied
# 範囲の移動を終える手順。pull されなかったグループを子が受け持つとき、親の時計を子へ渡す
green   $f m5b_green_range migrationSafe
red     $f m5b_red_range noWriteBelowRead
witness $f m5b_green_range witnessOpenWritten
# 空にされたグループと範囲の床。親が fence の前に行を全部消したグループを、消す前の時刻 T で、子に読む
red     $f m5b_red_emptied readConsistent          # 2026-11-14 の実装: 子は到着の記録も床も持たず、「行なし」と答える
green   $f m5b_green_floor floorSafe               # 範囲の床: 子は、移動を終えた範囲のグループの T < m の読みを断る
green   $f m5b_green_floor_clock floorSafe         # 答えた読みの時刻を覚えて、noWriteBelowRead も確かめる (取引 X なし)
red     $f m5b_red_floor_volatile readConsistent   # 床を、子の再起動で忘れる
red     $f m5b_red_floor_no_clock readConsistent   # 床はあるが、移動を終えるときに親の時計を子へ渡さない
green   $f m5b_green_floor_resplit floorSafe       # 同じ範囲をもう一度移す (子を親にして、新しいシャードへ。取引 X なし)
if [ "${HEAVY:-0}" = "1" ]; then                   # 取引 X を入れた版 (2,986 万状態と 4,332 万状態。合わせて 10〜20 分)
  green $f m5b_green_floor_clock_x floorSafe
  green $f m5b_green_floor_resplit_x floorSafe
fi
witness $f m5b_green_floor witnessEmptiedWritten
witness $f m5b_green_floor_clock witnessEmptiedRead
witness $f m5b_green_floor_resplit witnessSecondHopWritten
witness $f m5b_green_floor_resplit witnessSecondHopEmptied
witness $f m5b_green_floor_clock witnessLateFinish        # 渡した空のグループの応答が飛んでいる間に親が終え、子が受け持った範囲に書き込みを受けた (M5d に合わせて緩めた finishRange)
for m in m5b_green m5b_green_range m5b_red_range m5b_red_s3 m5b_red_s3_parent m5b_red_p2 m5b_red_p2_window m5b_red_intents \
         m5b_red_emptied m5b_green_floor m5b_green_floor_clock m5b_green_floor_clock_x m5b_red_floor_volatile m5b_red_floor_no_clock \
         m5b_green_floor_resplit m5b_green_floor_resplit_x; do tests $f $m; done

echo "== M6 watermark"
f=m6_watermark.qnt
green   $f m6_green watermarkSafe
red     $f m6_red_dirty watermarkSafe
red     $f m6_red_resolved watermarkSafe
red     $f m6_red_skew watermarkSafe
if [ "${HEAVY:-0}" = "1" ]; then green $f m6_red_skew watermarkSafeOrDetected; fi   # 約 10 分
witness $f m6_green witnessPublished
witness $f m6_green witnessIntentApplied
tests   $f m6_green
tests   $f m6_red_dirty
tests   $f m6_red_resolved

echo "== M1b read_refresh (read-time refresh / __ver 廃止 / T = max HLC)"
f=m1b_read_refresh.qnt
green   $f m1b_green serializable
green   $f m1b_green atomicVisibility
green   $f m1b_green_bump serializable
green   $f m1b_green_bump freshReadPicked          # 修正案 (settle 後に T を発行) で claim 3 が成立
red     $f m1b_green freshReadPicked               # 修正前は autocommit の 1 シャード読みで claim 3 が破れる
red     $f m1b_green_bump freshReadSeq             # 取引の 2 文目では成立しない (範囲の明示)
red     $f m1b_red_ra serializable                 # (a) refresh が HLC を進めない (取引 3 件)
green   $f m1b_red_rb serializable                 # (b) 旧 T の検証窓は保守的で、安全性は破れない
red     $f m1b_red_rc serializable                 # (c) 失敗後に T だけ進める
witness $f m1b_green witnessReadRefreshAdvanced
tests   $f m1b_green
tests   $f m1b_red_ra
tests   $f m1b_red_rc
# 2026-11-16: 移動のない read-time refresh を、移動をまたぐ refresh と同じ規則 (上限 to、intent の push と待ち) にそろえた形。答えは上と同じ
green   $f m1b_green_u m1bSafe                          # serializable と atomicVisibility
red     $f m1b_green_u freshReadPicked
witness $f m1b_green_u witnessReadRefreshAdvanced
witness $f m1b_green_u witnessFailedThenFinished        # 通らなかった refresh の後も、読むだけの取引が古い T のまま確定する
green   $f m1b_green_bump_u freshReadPicked
red     $f m1b_green_bump_u freshReadSeq
green   $f m1b_red_rb_u serializable
red     $f m1b_red_rc_u serializable
red     $f m1b_red_no_wait atomicVisibility             # c の決まった intent の適用を待たない
green   $f m1b_green3_u m1bSafe                         # 取引 3 件、テンプレート 4 つ
witness $f m1b_green3_u witnessNewRulePass              # いまの規則なら通らなかった refresh が通り、取引が確定する
witness $f m1b_green3_u witnessFailedThenFinished
green   $f m1b_no_push3 m1bSafe                         # push しなくても、2 シャードでは破れない (後で決まる c は必ず to より大きい)
if [ "${HEAVY:-0}" = "1" ]; then
  red   $f m1b_red_ra_u serializable                    # 取引 3 件 (約 3 分)
fi
for m in m1b_green_u m1b_red_ra_u m1b_red_rc_u m1b_red_no_wait m1b_green3_u; do tests $f $m; done

echo "== M8 recent_index (__ver 廃止後の first-committer-wins)"
f=m8_recent_index.qnt
green   $f m8_green fcw
red     $f m8_red_drop fcw
green   $f m8_red_latest fcw                       # DROP が logLowWater を上げるなら最新世代だけの再構築でも破れない
witness $f m8_green witnessAdmitAfterRestart
tests   $f m8_green
tests   $f m8_red_drop

echo "== M9 protocol (実装に揃えた統合モデル: 楽観 + 悲観 + IMMEDIATE + 述語 span + read-time refresh + anchor 2PC + wound-wait + 待ち行列)"
f=m9_protocol.qnt
green   $f m9_green protocolSafe
green   $f m9_green noLostWakeup
green   $f m9_green noYoungDie
for m in m9_red_ro_skip m9_red_second_f m9_red_imm_read_t m9_red_skip_lost m9_red_f_is_t m9_red_wound_prepared m9_red_no_pred m9_red_prepare_waits; do red $f $m protocolSafe; done
red     $f m9_red_wait_die noYoungDie
red     $f m9_impl_wake noLostWakeup            # 実装どおり: TTL 切れを遅延検出 → 待ち手が眠ったまま
red     $f m9_red_leave_silent noLostWakeup     # 起こされた待ち手が去っても次を起こさない (3 取引)
witness $f m9_green witnessPessWaitedCommit
witness $f m9_green witnessWoundTaken
witness $f m9_green witnessImmROValidated
witness $f m9_green witnessSecondDml
for m in m9_green m9_impl_wake m9_red_ro_skip m9_red_second_f m9_red_imm_read_t m9_red_skip_lost; do tests $f $m; done

echo "== M10 取引記録の GC と古い COMMIT の拒否"
f=m10_txn_record_gc.qnt
green   $f m10_green safe
red     $f m10_red_no_guard safe          # 年齢の検査なし: tombstone を消した後に再配送の COMMIT が確定する
red     $f m10_red_gc_undone safe         # 適用前の committed 記録を消す
red     $f m10_red_guard_too_long safe    # 受け付ける年齢 G が保持時間 R 以上
witness $f m10_green witnessGc

echo "== M11 表定義の変更 (DDL) と取引の並行"
f=m11_schema_change.qnt
for m in m11_green m11_green_unique m11_green_unique_colocated m11_green_recreate; do green $f $m schemaSafe; done
green   $f m11_fix_recheck_only schemaSafe   # index の DDL は、anchor の確認し直しだけでも 2PC の途中の取引を止められる
green   $f m11_fix_drain_only schemaSafe     # 適用前に intent を決着させるだけでも止められる
green   $f m11_index_no_sync schemaSafe      # index の DDL は、全シャードへの先行適用を外しても破れない
red     $f m11_impl schemaSafe               # 実装どおり (修正案をすべて外す)
red     $f m11_impl_wait schemaSafe          # BUG-3: autocommit がロック待ちの後で版を確かめ直さない
red     $f m11_impl_inflight schemaSafe      # BUG-4: 2PC の途中の取引が public の後に確定する
red     $f m11_impl_backfill schemaSafe      # BUG-2: backfill の読みと書きの間の更新で古い項目が残る
red     $f m11_impl_chunk schemaSafe         # BUG-1: UNIQUE の backfill が同じシャードの重複を上書きする
red     $f m11_impl_drop schemaSafe          # BUG-5: 確定済みの intent が作り直した表へ適用される
red     $f m11_red_no_reject schemaSafe      # シャードが古い版の要求を拒否しない
red     $f m11_red_early_public schemaSafe   # backfill の前に public にする
red     $f m11_red_no_write_only schemaSafe  # write-only の index を書き込みが更新しない
red     $f m11_red_no_sync schemaSafe        # 全シャードへ適用する前に DDL が完了を返す
witness $f m11_green witnessPublicWithWriters
witness $f m11_green witnessStaleRejected
witness $f m11_green witnessCrossDuringDdl
witness $f m11_green_unique witnessUniqueFailed
witness $f m11_green_unique witnessUniquePublic
witness $f m11_green_recreate witnessRecreateWritten
for m in m11_green m11_impl_wait m11_impl_inflight m11_impl_backfill m11_impl_chunk m11_impl_drop m11_red_no_reject m11_red_early_public m11_red_no_write_only m11_red_no_sync; do tests $f $m; done

echo "== M12 行のある表に、シャードをまたぐ UNIQUE の index を作る (書き込みを止めて作る)"
f=m12_unique_index_build.qnt
green   $f m12_green buildSafe
green   $f m12_green_shard_only buildSafe        # 守るのはシャード。Worker が先に断らなくても成り立つ
red     $f m12_red_online indexMatches           # 2026-11 までの設計 (作りながら書く)。他人の項目を消す
red     $f m12_red_online notRelied              # 同上。出来上がっていない index で一意性を確かめる
red     $f m12_red_no_lock indexMatches          # 書き込みを止めない
red     $f m12_red_visible notRelied             # 止めるが、作っている最中の index を計画が使う
red     $f m12_red_no_drain noWriteWhileLocked   # intent を持ったまま版を進める
red     $f m12_red_stale indexMatches            # 古い版の計画を断らない
red     $f m12_red_two_exits oneExit             # 取り消された後に公開が通る
red     $f m12_red_repin indexMatches            # 取引が、計画し直さずに新しい版を名乗る (実装にあった欠陥)
red     $f m12_red_scan_early indexMatches       # 書き込みを止める前のシャードの行を読んで埋める
witness $f m12_green witnessPublicThenWrite
witness $f m12_green witnessWithdrawnOnDuplicate
witness $f m12_green_shard_only witnessRefusedByLock
tests   $f m12_green_shard_only
# 公開の時刻。index を使う文は、時刻の順で、index を使わない書き込みの後ろにいる
green   $f m12_clock_green publishIsAPoint
red     $f m12_clock_red_no_clock publishIsAPoint     # 公開の版が時刻を運ばない
red     $f m12_clock_red_skip_empty publishIsAPoint   # 行のないシャードを読まず、その時刻が入らない
witness $f m12_clock_green witnessAwareOnSlowShard
tests   $f m12_clock_red_no_clock
echo "== M13 取引の中の DDL と、取引が名乗る表定義の版"
f=m13_txn_schema_boundary.qnt
green   $f m13_green boundarySafe
red     $f m13_red_main prefixOfScript           # 2026-11 までの実装: DDL が、前に溜めた書き込みより先に効く
red     $f m13_red_pin_only ownDdlVisible        # 版を名乗り続けるが、DDL の前に確定しない: 自分が作った表へ書けない
red     $f m13_red_repin pinned                  # 計画し直さずに新しい版を名乗る
red     $f m13_red_retry_whole prefixOfScript    # 文の並びの頭からやり直し、確定した分を 2 度実行する
red     $f m13_red_ddl_anyway prefixOfScript     # 先に確定するのに失敗しても DDL を実行する
witness $f m13_green witnessRetriedAndDone
witness $f m13_green witnessOtherDdlThenDone
tests   $f m13_green
tests   $f m13_red_main

echo "== M14 取引の中で表を作り直すとき、別の接続の書き込みを失わない"
f=m14_rebuild_guard.qnt
green   $f m14_green guardSafe
red     $f m14_red_no_lock noLostWrite        # 確かめるが禁止しない
red     $f m14_red_no_check noLostWrite       # 禁止するが確かめない
red     $f m14_red_check_early noLostWrite    # 禁止の版を適用する前に確かめる
red     $f m14_red_no_drain noLostWrite       # intent を決着させずに禁止の版を適用する
red     $f m14_red_untied noLostWrite         # DROP が禁止と結び付いていない (期限切れの後に通る)
red     $f m14_red_commit_ts noLostWrite      # copy の確定の時刻と比べる
witness $f m14_green witnessDroppedAfterWrites
witness $f m14_green witnessRefusedByCheck

echo "== M15 表定義の変更とシャードの分割の順序 (保守の操作の枠)"
f=m15_maintenance_slot.qnt
green   $f m15_green servable
red     $f m15_red_no_slot servable          # 2026-11 までの実装: 分割の途中かを確かめてから記録する (原子的でない)
red     $f m15_red_stale_begin servable      # 分割が、枠を取る前に読んだ版を使う (子が親より古い版で受け取る)
red     $f m15_red_early_release servable    # 枠を、子が受け取り終える前に返す
red     $f m15_red_no_based_on servable      # 全シャードが最新の版を適用する前に枠を取る (分割の途中に取り消しが入る)
red     $f m15_red_late_start servable       # 期限切れの後に届いた、子の受け取りの始まりを断らない
witness $f m15_green witnessRecordedBeforeAndServed
witness $f m15_green witnessRecordedAfterDeath   # 分割を進める側が枠を取った後で止まっても、DDL は記録できる

echo "== M16 unique pending (不変条件 2 の UNIQUE の部分)"
f=m16_unique_pending.qnt
green   $f m16_green committedApplies
red     $f m16_red_body_only committedApplies      # ほかの取引の intent を適用した状態で確かめない
red     $f m16_red_intents_only committedApplies   # 本体の行だけの状態で確かめない
witness $f m16_green witnessBothApplied
for m in m16_red_body_only m16_red_intents_only; do tests $f $m; done

echo "== M17 txn id reuse (不変条件 12)"
f=m17_txn_id_reuse.qnt
green   $f m17_green safe                # 2PC の ID は続きごと (取引の ID と中身の指紋)。anchor は同じ ID の実行を 1 つずつにし、中止は記録が中止のときだけ abort を送る
green   $f m17_green_serialize_only safe # 実行を 1 つずつにするだけで足りる (中止の確かめは 2 つ目の守り)
red     $f m17_red_resend safe           # 2026-11-13 の 1 回目の修正: 同じ中身の 2 つの実行が同時に走り、後の実行の中止が先の実行の intent を消す
red     $f m17_red_resend_abort_check_only safe  # 中止の確かめだけ: 後の実行が確定を決めると記録の INSERT が失敗し、確定したのに誤りと答える
red     $f m17_red_abort safe            # 2026-11-12 の修正: 指紋を両方で確かめるが、ID は取引の ID。断られた続きの中止が、確定した続きの intent を消す
red     $f m17_red_impl safe             # 2026-11-12 より前の実装: 参加者も anchor も、同じ ID の別の続きを確かめない
red     $f m17_red_prepare_only safe     # anchor が、同じ ID の決着があると、中身を見ずに結果を返す
red     $f m17_red_commit_only safe      # 参加者が、同じ ID の intent があると、後の書き込みを捨てて ok と答える
witness $f m17_green witnessOneCommittedOneRefused
witness $f m17_green witnessConcurrent
witness $f m17_green witnessResend
tests   $f m17_red_abort
tests   $f m17_red_resend
tests   $f m17_red_impl

echo "== M18 subslot split (1 つの shard key の行を、複数のシャードに分けて持つ)"
f=m18_subslot_split.qnt
green   $f m18_green tenantSplitSafe                    # piece 1 は親に残り、piece 2 は子へ移る。テナントの読みは両方のシャードが答える
green   $f m18_green_clock tenantSplitSafe              # 答えた読みの時刻を覚えて、noWriteBelowRead を確かめる
green   $f m18_green_chunks tenantSplitSafe             # 上の範囲が 2 通の応答に分かれて移る (16 MB を超えるテナント)。Worker の claim の分け方は任意
red     $f m18_red_partial_answer readConsistent        # 親が、範囲表の古い要求を断らず、まだ持っている piece だけを答える
red     $f m18_red_child_partial readConsistent         # 子が、届いた piece だけを答える
red     $f m18_red_answer_held readConsistent           # 答える行を要求の範囲で絞らない: 親の控えの行が、子の答えと重なる
red     $f m18_red_piece_without_clock noWriteBelowRead # piece が時刻を運ばない
red     $f m18_red_write_by_slot singleOwner            # 書き込みの宛先と持ち主の確認を slot だけで決める
red     $f m18_red_write_by_slot noLostWrite
red     $f m18_red_intents_by_group intentNotLost       # pull が、shard key の intent を全部運ぶ
witness $f m18_green witnessSplitWritten
witness $f m18_green witnessTenantReadBoth
witness $f m18_green witnessIntentMovedThenApplied
witness $f m18_green_chunks witnessHalfArrived
witness $f m18_green_chunks witnessReadWhileMoving      # 移動の途中でも、claim を piece で分け直せばテナントの読みが揃う
for m in m18_green m18_green_clock m18_green_chunks m18_red_partial_answer m18_red_child_partial m18_red_answer_held m18_red_piece_without_clock m18_red_write_by_slot m18_red_intents_by_group; do tests $f $m; done

echo "== M19 claim resplit (移動の途中のテナントの読みを、claim を piece で分け直して通す)"
f=m19_claim_resplit.qnt
green   $f m19_green resplitSafe                        # 断る応答が piece の表を運び、Worker が claim を分け直す。取引 X あり。最初の claim は範囲表のとおり
green   $f m19_green_clock resplitSafe                  # 答えた読みの時刻を覚えて、noWriteBelowRead を確かめる
green   $f m19_green_any resplitSafe                    # 最初の claim の分け方は任意 (古い表の控え)。取引 X なし
green   $f m19_green_any_x resplitSafe                  # 同上で、取引 X が、移る piece 2 つに書く
live    $f m19_live readTerminates                      # 活性: あきらめなければ、読みはいつか揃う。新しい piece を切る手に公平性は置かない
red     $f m19_red_stale_map readConsistent             # P が、分け直した claim を、いまの表で確かめずに答える (読みの T より古い表)
red     $f m19_red_stale_map answeredOnlyHeld
red     $f m19_red_mixed_t readAtSomeT                  # T を上げたときに、古い T の答えを残して合わせる
red     $f m19_red_gap readConsistent                   # 分け直した claim の間に抜けがある (区間の終わりを含めない)
red     $f m19_red_forget_map boundedRetries            # Worker が P の表を忘れる: 飛んでいる piece を、P と C が断り続ける
live_red $f m19_live_red_child_waits readTerminates     # C が、claim の全部が届くまで断らずに待つ (M18 までの規則): 移動が止まると読みが終わらない
red     $f m19_live_red_child_waits readNotStuck
red     $f m19_red_piece_without_clock noWriteBelowRead # piece が時刻を運ばない
witness $f m19_green witnessResplitWhileMoving          # 移動の途中の読みが、分け直した後で、両方のシャードの答えで揃う
witness $f m19_green witnessResplitTwice                # 読みの間に piece が移り、P に 2 度断られてから揃う
witness $f m19_green witnessDoneWhilePieceFlying        # 揃った時点で、切られて飛んでいる piece がある
witness $f m19_green witnessRestartedThenDone           # T を上げて聞き直してから揃う
witness $f m19_green witnessXSeenOnBoth                 # 分け直した読みが、P の答えと C の答えの両方に X の行を見る
witness $f m19_green witnessRetryMaxReached             # 断られる回数の上限はきつい
witness $f m19_green_any witnessRetryMaxReached
for m in m19_green m19_green_clock m19_green_any m19_red_stale_map m19_red_mixed_t m19_red_gap m19_red_forget_map m19_live_red_child_waits m19_red_piece_without_clock; do tests $f $m; done

echo "== M20 unique piecewise (グループを piece に分けて運ぶ間の UNIQUE。不変条件 2)"
f=m20_unique_piecewise.qnt
green   $f m20_green uniqueSafe                         # 親は、グループの最初の piece を切る前に、グループの intent を決着させる
green   $f m20_green_per_piece uniqueSafe               # 決着させるのを、切る piece の中の intent だけにしても破れない
green   $f m20_green_child_reads_parent uniqueSafe      # 子が、揃う前でも、親に残る行と合わせて確かめる。グループの全部を決着させる規則の下でだけ成り立つ
red     $f m20_red_piecewise committedApplies           # 決着させずに切る: piece ごとに適用され、確定した取引が適用できなくなる
green   $f m20_red_piecewise uniqueVisible              # 同上。見える状態は UNIQUE を守ったままで、破れるのは適用だけである
red     $f m20_red_late_intent uniqueVisible            # fence の後も、親が intent を受ける
red     $f m20_red_late_intent committedApplies
red     $f m20_red_child_early uniqueVisible            # 子が、グループが揃う前に、手元の行だけで確かめて受ける
red     $f m20_red_child_early committedApplies
red     $f m20_red_child_reads_parent_per_piece uniqueVisible   # 親に残る行と合わせて確かめても、切る piece の中だけを決着させる規則では破れる
witness $f m20_green witnessCrossAppliedThenMoved       # 2 つの piece にまたがる取引が適用され、グループが 2 つの piece で子へ移る
witness $f m20_green witnessFirstCutWaited              # 未決着の取引の決着を待ってから、最初の piece を切る
witness $f m20_green witnessChildWrote                  # 揃った後で、子が UNIQUE の値を書く取引を受ける
witness $f m20_green_child_reads_parent witnessChildWroteEarly
for m in m20_green m20_red_piecewise m20_red_piecewise_note m20_red_late_intent m20_red_child_early m20_red_child_reads_parent_per_piece; do tests $f $m; done

echo "== M21 catalog epoch (Meta の版と排他を、1 本の epoch の列と、2 相の遷移にまとめる。実装より先に書いたモデル)"
f=m21_catalog_epoch.qnt
green   $f m21_green_build epochSafe                    # 行のある表に、シャードをまたぐ UNIQUE の index を作る。取引 2 件が、どの epoch のスナップショットでも計画する
green   $f m21_green_check epochSafe                    # 行で失敗し得る DDL。各シャードが、書き込みを止めた表で試してから確定する (事後の取り消しの代わり)
green   $f m21_green_ddl2 epochSafe                     # 同時に出された 2 つの DDL。表定義の遷移は 1 つずつ開く
green   $f m21_green_drop epochSafe                     # 取引が読んだ表の DROP。copy の後の書き込みがあれば取り消す
green   $f m21_green_split epochSafe                    # 移動と DDL。分割を進める側は、start の後ならいつ止まってもよい
green   $f m21_green_split_txns epochSafe               # 移動の前後のスナップショットの取引 2 件。動かない行の取引は、分割の記録を適用したシャードでも通る
green   $f m21_check_no_reject commitApplies            # 外しても破れない: CHECK の場面では、版の確認がなくても、記録された commit を適用できる (この不変条件に限る。版の確認を外してよい、ではない)
green   $f m21_alt_commit_only_build epochSafeCommitOnly   # 別の案: 表定義の epoch を commit だけで進める (prepare と abort では進めない)。noServeBelowAck を除いて成り立つ
green   $f m21_alt_commit_only_check epochSafeCommitOnly
# BUILD の場面 (M12 と、M11 のうち Meta の仕組みに依る赤)
red     $f m21_red_online indexMatches                  # 2026-11 までの設計 (作りながら書く)。他人の項目を消す (m12_red_online)
red     $f m21_red_online notRelied
red     $f m21_red_no_fence indexMatches                # 書き込みを止めない (m12_red_no_lock、m11_impl_backfill)
red     $f m21_red_visible notRelied                    # 作っている最中の index を計画が使う (m12_red_visible)
red     $f m21_red_no_drain noWriteWhileFenced          # intent を持ったまま表定義の記録を適用する (m12_red_no_drain、m11_impl_inflight)
red     $f m21_red_stale indexMatches                   # 古い表定義の計画を断らない (m12_red_stale、m11_red_no_reject)
red     $f m21_red_stale noServeBelowAck
red     $f m21_red_two_exits oneExit                    # 取り消された後に commit が通る (m12_red_two_exits)
red     $f m21_red_two_exits indexMatches
red     $f m21_red_repin indexMatches                   # 取引が、計画し直さずに新しい表定義の epoch を名乗る (m12_red_repin、m13_red_repin)
red     $f m21_red_repin pinned
red     $f m21_red_scan_early indexMatches              # prepare を適用する前のシャードの行を読んで埋める (m12_red_scan_early)
red     $f m21_red_scan_early noServeBelowAck
red     $f m21_red_no_recheck indexMatches              # 待ちの後で版を確かめ直さない (m11_impl_wait)。ok と答えた prepare より古い計画を受ける
red     $f m21_red_no_recheck noServeBelowAck
red     $f m21_red_early_commit indexMatches            # 全シャードの ok を待たずに commit を記録する (m11_red_early_public)
# CHECK の場面 (取り消しの代わりが頼る条件)
red     $f m21_red_trial_no_fence commitApplies         # 試適用の間、書き込みを止めない
red     $f m21_red_trial_missing_ack commitApplies      # 全シャードの ok を待たずに commit を記録する
red     $f m21_red_trial_early commitApplies            # prepare を適用する前のシャードが、試適用に ok と答える
red     $f m21_red_trial_no_drain commitApplies         # intent を持ったまま prepare を適用する
# DROP の場面 (M14 と、M11 の作り直し)
red     $f m21_red_drop_no_fence guardHolds             # 確かめるが、書き込みを止めない (m14_red_no_lock)
red     $f m21_red_drop_no_check guardHolds             # 書き込みは止めるが、確かめない (m14_red_no_check)
red     $f m21_red_drop_check_early guardHolds          # prepare を適用する前に確かめる (m14_red_check_early)
red     $f m21_red_drop_no_drain guardHolds             # intent を決着させずに適用する (m14_red_no_drain)
red     $f m21_red_drop_no_drain noResurrect            # 同上。DROP を適用したシャードに、書き込みが適用される (m11_impl_drop)
red     $f m21_red_drop_untied guardHolds               # 期限切れで禁止が解けた後に、DROP の commit が通る (m14_red_untied)
red     $f m21_red_drop_missing_ack noLostAfterReturn   # 全シャードが prepare を適用する前に、DDL が完了を返す (m11_red_no_sync)
red     $f m21_red_two_open commitApplies               # 表定義の遷移を 2 つ開く: index を作っている間に、同じ表の DROP が確定する
# 移動の場面 (M15 と、未解決の問題 17)
red     $f m21_red_ddl_during_move servable             # 移動が開いている間に、表定義の遷移を開く (m15_red_no_slot)
red     $f m21_red_move_during_ddl servable             # 表定義の遷移が開いている間に、移動を開く (m15_red_no_based_on の後継)
red     $f m21_red_end_early servable                   # 子が受け取り終える前に end を記録する (m15_red_early_release)
red     $f m21_red_pull_unfenced moveKeepsWrites        # pull が start の epoch を運ばない: 親が、fence の前に行を渡す
red     $f m21_red_pull_unfenced readConsistent
red     $f m21_red_pull_unfenced sameShape
red     $f m21_red_fence_first servable                 # いまの実装: 親の fence が、範囲表の切り替えより先の別の手である (未解決の問題 17)
red     $f m21_red_owner_unchecked moveKeepsWrites      # シャードが、所有を自分のスナップショットで引かない
red     $f m21_red_owner_unchecked readConsistent
red     $f m21_red_strict_epoch pinnedSurvives          # シャードが、epoch が等しいことを求める: 分割が、動いていない行の取引を巻き込む
witness $f m21_green_build witnessPublicThenWrite
witness $f m21_green_build witnessAbortedOnDuplicate
witness $f m21_green_build witnessRefusedByFence
witness $f m21_green_build witnessLiftedAfterStall      # 進める側が止まった後、Meta が取り消し、その後の書き込みが通る
witness $f m21_green_check witnessTrialRejectedThenWrite    # 試適用が通らずに取り消され、その後の書き込みが通る (逆操作の文なしで)
witness $f m21_green_check witnessCheckCommittedThenWrite
witness $f m21_green_ddl2 witnessBothCommitted
witness $f m21_green_ddl2 witnessBuildAfterRejectedCheck
witness $f m21_green_drop witnessDroppedAfterWrites
witness $f m21_green_drop witnessGuardRefused
witness $f m21_green_split witnessServedWhileDriverDead # 進める側が止まっていても、子への書き込みが通る (end の前)
witness $f m21_green_split witnessEndedDriverDead
witness $f m21_green_split witnessDdlAfterMove
witness $f m21_green_split witnessMoveAfterDdl
witness $f m21_green_split witnessParentAnswersUncut    # 親が、start を適用した後で、まだ渡していない行の読みに答える (M19)
witness $f m21_green_split_txns witnessPinnedSurvives   # 分割より前のスナップショットの取引が、分割の記録を適用したシャードで通る
witness $f m21_alt_commit_only_check witnessOldPlanAfterAbort   # 別の案で、prepare より前の計画が、取り消しの後で、計画し直さずに通る
if [ "${HEAVY:-0}" = "1" ]; then                   # 移動と index の作成の組み合わせ (M12 が扱わなかった)。緑が 1 本で 10 分ほど、witness も同じくらいかかる
  green   $f m21_green_split_build epochSafe            # 行を埋める処理は、移動が閉じた後なら子の行を読む
  witness $f m21_green_split_build witnessBuildAfterMove  # 移動が閉じた後で index が公開され、項目は子が持つ行を指す
  witness $f m21_green_split_build witnessMoveAfterBuild  # index が公開された後で行が動き、子への書き込みが index を保守する
fi
# 時刻に依る 2 つの性質 (M12 の公開の時刻と、M14 の確かめが比べる時刻を、epoch の言葉に直した小さなモデル)
green   $f m21_clock_green commitIsAPoint
red     $f m21_clock_red_no_clock commitIsAPoint        # commit が時刻を運ばない (m12_clock_red_no_clock)
red     $f m21_clock_red_skip_empty commitIsAPoint      # 行のないシャードを読まない (m12_clock_red_skip_empty)
witness $f m21_clock_green witnessAwareOnSlowShard
green   $f m21_guard_green guardSafe
red     $f m21_guard_red_commit_ts noLostWrite          # copy の確定の時刻と比べる (m14_red_commit_ts)
witness $f m21_guard_green witnessDroppedAfterWrites
witness $f m21_guard_green witnessRefusedByCheck
for m in m21_green_build m21_green_check m21_green_drop m21_green_split m21_green_split_txns m21_green_split_build \
         m21_red_online m21_red_no_fence m21_red_visible m21_red_no_drain m21_red_stale m21_red_two_exits m21_red_repin m21_red_scan_early \
         m21_red_no_recheck m21_red_early_commit m21_red_trial_no_fence m21_red_trial_missing_ack m21_red_trial_early m21_red_trial_no_drain \
         m21_red_drop_no_fence m21_red_drop_no_check m21_red_drop_check_early m21_red_drop_no_drain m21_red_drop_untied m21_red_drop_missing_ack \
         m21_red_two_open m21_red_ddl_during_move m21_red_move_during_ddl m21_red_end_early m21_red_pull_unfenced m21_red_fence_first \
         m21_red_owner_unchecked m21_red_strict_epoch m21_alt_commit_only_check m21_clock_red_no_clock m21_clock_red_skip_empty m21_guard_red_commit_ts; do tests $f $m; done

echo "== M24 table epochs (DDL が取引を古くするのは、取引が頼る表を変えて確定したときだけ。未解決の問題 53。実装より先に書いたモデル)"
f=m24_table_epochs.qnt
green   $f m24_green_unrelated m24Safe                  # 関係のない CREATE TABLE と、B の DDL (確定か失敗)。A だけに頼る取引と、B を読んで A を書く取引
green   $f m24_green_build m24Safe                      # A の index の作成と、関係のない CREATE TABLE。index の commit より前の計画は、読みは通り、書き込みは断られる
green   $f m24_green_check m24Safe                      # A の、行で失敗し得て形を変える DDL と、関係のない CREATE TABLE
green   $f m24_green_drop m24Safe                       # DROP TABLE A と、関係のない CREATE TABLE。V を通る読みも断られる
green   $f m24_green_split m24Safe                      # 移動と、関係のない CREATE TABLE
red     $f m24_red_global noRefusalUnrelated            # 段 3 の形: 表定義全体の epoch 1 つを、どの記録でも進める
red     $f m24_red_global_commit_only noRefusalUnrelated  # 全体の epoch 1 つを、commit だけで進める
red     $f m24_red_prepare_advances noRefusalWithoutChange  # 表ごとだが、prepare と abort でも進める: 失敗した DDL が、触った表の取引を断る
red     $f m24_red_read_deps planMatches                # 書き込みの計画が読んだ表を、要求が運ばない
red     $f m24_red_apply_all noRefusalUnrelated         # 段 3 の schemaChanging: 記録の適用中に、どの要求も断る
red     $f m24_red_apply_touched noRefusalWithoutChange # 記録の適用中に、記録が触る表に頼る要求を、待たせずに断る
red     $f m24_red_index indexMatches                   # index の DDL を、表とは別のものとして数える
red     $f m24_red_index planMatches
red     $f m24_red_write_epoch indexMatches             # 書き込みが、表の読みの epoch を比べる
red     $f m24_red_view readConsistent                  # view を通る計画が、元の表を運ばない
red     $f m24_red_view planMatches
witness $f m24_green_unrelated witnessAcrossUnrelated   # 取引が、関係のない CREATE TABLE の commit と、関係のない DDL の abort をまたいで確定する
witness $f m24_green_unrelated witnessAcrossFailedRead  # B を読んだ計画の書き込みが、B の DDL の abort の後で、計画し直さずに確定する
witness $f m24_green_unrelated witnessRefusedChanged    # B の DDL が確定すれば、B を読んだ計画は断られる
witness $f m24_green_check witnessAcrossFailedTouched   # A の DDL の prepare より前の計画の書き込みが、禁止の間は待ち、DDL の失敗の後で確定する
witness $f m24_green_check witnessTrialRejectedThenWrite
witness $f m24_green_check witnessCheckCommittedThenWrite
witness $f m24_green_build witnessReadAcrossIndex       # index の commit より前に計画した読みが、commit を適用したシャードで答えられる
witness $f m24_green_build witnessPublicThenWrite
witness $f m24_green_drop witnessDroppedAfterWrites
witness $f m24_green_split witnessServedWhileDriverDead
witness $f m24_green_split witnessPinnedSurvives
witness $f m24_green_split witnessParentAnswersUncut
green   $f m24_red_global witnessAcrossUnrelated        # 同じ witness は、段 3 の形では届かない
green   $f m24_red_global_commit_only witnessAcrossUnrelated
green   $f m24_red_prepare_advances witnessAcrossFailedRead
# DDL の床 (古い時刻の行の読み戻し)
green   $f m24_floor_green floorSafe
red     $f m24_floor_red_global noRefusalUnrelated      # 段 3 の形: 床がシャードに 1 つ
red     $f m24_floor_red_restore_all noRefusalUnrelated # 読み戻すのが、すべての表の行
red     $f m24_floor_red_no_floor noRestoreAcross       # 形を変えた表に床を置かない
witness $f m24_floor_green witnessServedBelow
witness $f m24_floor_green witnessRefusedB
# 行ロックと DDL の待ち (触った表に書いた取引)
green   $f m24_lock_green holderSurvives
red     $f m24_lock_red_no_wait holderSurvives          # prepare が行ロックを待たない
red     $f m24_lock_red_no_wound holderSurvives         # 書き込み禁止に当たった、ロックを持つ取引が、遷移を取り消させない
witness $f m24_lock_green witnessDdlAfterTxn
witness $f m24_lock_green witnessWoundThenCommit
witness $f m24_lock_green witnessDdlBusy
# 取り消させた DDL のやり直し (決めた設計。時刻あり。DDL の成否は利用者の時刻だけで決まり、行の置き場所に依らない)
green   $f m24_retry_green retrySafe                    # 取り消された DDL を、同じ期限の中で、新しい epoch の prepare でやり直す。禁止に当たった取引は、そのシャードの行のロックを取る
green   $f m24_retry_no_retry_same retrySafe            # やり直さない形でも、行が 1 つのシャードにあれば SQLite と同じ (下の赤と合わせて、成否が置き場所で決まる)
red     $f m24_retry_red_no_retry asSqlite              # やり直さない (m24_lock の形): 行が 2 つのシャードにあると、DDL が期限より前に失敗する
red     $f m24_retry_red_restart asSqlite               # やり直すたびに、期限を数え直す
red     $f m24_retry_red_same_epoch checkSawRows        # やり直しが、取り消された試みの prepare の epoch と ok を使う
red     $f m24_retry_red_no_hold noReblock              # 禁止に当たった取引に、シャードがロックを与えない: 取り消しとやり直しが繰り返す
red     $f m24_retry_red_no_wait holderSurvives         # prepare が行ロックを待たない
red     $f m24_retry_red_no_wound holderNotDelayed      # 取引が DDL を取り消させない: 取引の文が、期限まで DDL を待つ
witness $f m24_retry_green witnessWoundRetryCommit      # 行が 2 つのシャード。取り消し、やり直し、取引が期限のうちに確定し、DDL が確定する
witness $f m24_retry_green witnessSplitBusy             # 行が 2 つのシャード。取引が期限を過ぎてロックを持ち、やり直した DDL が期限に失敗する
witness $f m24_retry_green witnessSameCommit            # 行が 1 つのシャード。DDL は取引を待ち、その確定の後で確定する
witness $f m24_retry_green witnessSameBusy              # 行が 1 つのシャード。取引が期限を過ぎてロックを持ち、DDL が期限に失敗する
live    $f m24_retry_green retryLive                    # 活性: 始めた DDL は終わり、時刻は上限まで進み、送られた文は答えを得る
live_red $f m24_retry_red_no_hold ddlTerminates         # ロックを与えないと、取り消しとやり直しが、同じ刻みの中で限りなく続く
# 取引の中の DDL (M13 を表ごとにしたもの)
green   $f m24_boundary_green boundarySafeAll
red     $f m24_boundary_red_main prefixOfScript
red     $f m24_boundary_red_pin_only ownDdlVisible
red     $f m24_boundary_red_repin pinned
red     $f m24_boundary_red_retry_whole prefixOfScript
red     $f m24_boundary_red_ddl_anyway prefixOfScript
red     $f m24_boundary_red_global noRefusalUnrelated   # すべての DDL の版と比べる (M13 と段 3 の形)
witness $f m24_boundary_green witnessUnrelatedNoRetry   # 関係のない DDL が区切りの途中に入っても、やり直さずに終わる
witness $f m24_boundary_green witnessRetriedAndDone
witness $f m24_boundary_green witnessOtherDdlThenDone
green   $f m24_boundary_red_global witnessUnrelatedNoRetry  # 同じ witness は、すべての DDL の版と比べると届かない
for m in m24_green_unrelated m24_green_build m24_green_check m24_green_drop m24_green_split \
         m24_red_global m24_red_global_commit_only m24_red_prepare_advances m24_red_read_deps m24_red_apply_all m24_red_apply_touched \
         m24_red_index m24_red_write_epoch m24_red_view \
         m24_floor_green m24_floor_red_global m24_floor_red_restore_all m24_floor_red_no_floor \
         m24_lock_green m24_lock_red_no_wait m24_lock_red_no_wound \
         m24_retry_green m24_retry_no_retry_same m24_retry_red_no_retry m24_retry_red_restart m24_retry_red_same_epoch \
         m24_retry_red_no_hold m24_retry_red_no_wait m24_retry_red_no_wound \
         m24_boundary_green m24_boundary_red_global; do tests $f $m; done
# 決めたこと 6 の確かめ直し: M21 の場面を、epoch を commit だけで進める形で (index の作成と CHECK は、M21 の m21_alt_commit_only_*)
f=m24b_m21_commit_only.qnt
green   $f m24_m21_green_split_txns epochSafeCommitOnly
green   $f m24_m21_green_split epochSafeCommitOnly
if [ "${HEAVY:-0}" = "1" ]; then                        # M21 の大きな場面と、M21 の赤 (noServeBelowAck を除く) を、commit だけで進める形で
  green $f m24_m21_green_drop epochSafeCommitOnly
  green $f m24_m21_green_ddl2 epochSafeCommitOnly
  green $f m24_m21_green_split_build epochSafeCommitOnly
  red   $f m24_m21_red_online indexMatches
  red   $f m24_m21_red_online notRelied
  red   $f m24_m21_red_no_fence indexMatches
  red   $f m24_m21_red_visible notRelied
  red   $f m24_m21_red_no_drain noWriteWhileFenced
  red   $f m24_m21_red_stale indexMatches
  red   $f m24_m21_red_two_exits oneExit
  red   $f m24_m21_red_two_exits indexMatches
  red   $f m24_m21_red_repin indexMatches
  red   $f m24_m21_red_repin pinned
  red   $f m24_m21_red_scan_early indexMatches
  red   $f m24_m21_red_no_recheck indexMatches
  red   $f m24_m21_red_early_commit indexMatches
  red   $f m24_m21_red_trial_no_fence commitApplies
  red   $f m24_m21_red_trial_missing_ack commitApplies
  red   $f m24_m21_red_trial_early commitApplies
  red   $f m24_m21_red_trial_no_drain commitApplies
  red   $f m24_m21_red_drop_no_fence guardHolds
  red   $f m24_m21_red_drop_no_check guardHolds
  red   $f m24_m21_red_drop_check_early guardHolds
  red   $f m24_m21_red_drop_no_drain guardHolds
  red   $f m24_m21_red_drop_no_drain noResurrect
  red   $f m24_m21_red_drop_untied guardHolds
  red   $f m24_m21_red_drop_missing_ack noLostAfterReturn
  red   $f m24_m21_red_two_open commitApplies
  green $f m24_m21_red_ddl_during_move servable       # commit だけで進める形では反例がない: 移動の途中の prepare は要求を古くせず、DDL が移動の終わりまで待つだけになる
  red   $f m24_m21_red_move_during_ddl servable
  green $f m24_m21_red_end_early servable              # 同じ理由で反例がない (design-catalog-epoch.md の「移動の途中の prepare」)
  red   $f m24_m21_red_pull_unfenced moveKeepsWrites
  red   $f m24_m21_red_pull_unfenced readConsistent
  red   $f m24_m21_red_pull_unfenced sameShape
  red   $f m24_m21_red_fence_first servable
  red   $f m24_m21_red_owner_unchecked moveKeepsWrites
  red   $f m24_m21_red_owner_unchecked readConsistent
  red   $f m24_m21_red_strict_epoch pinnedSurvives
fi

echo "== M24c lock holders (DDL が待つ表の集合と、ロックを与える 1 つの判断。取引 2 件、ロックを取る読み、待つ間に来た取引。不変条件 16。実装より先に書いたモデル)"
f=m24c_lock_holders.qnt
green   $f m24c_green lockSafe                          # 決めた設計。取引 2 件 (書き込みから始めるか、ロックを取る読みから始める)、置き場所 8 通り
green   $f m24c_green_reader lockSafe                   # 取引 2 が、DDL より前に X をロックなしで読んでいる (計画し直せない)
green   $f m24c_green_optimistic lockSafe               # 取引 2 が楽観の取引 (行ロックを取らず、COMMIT で書く)
red     $f m24c_red_reads asSqlite                      # D1: ロックを与える判断が、書き込みとして頼る表にしか fence を見ない
red     $f m24c_red_reads preparedStays                 # 同上: 全シャードが ok と答えた試みを、後から始めた取引が取り消させる
red     $f m24c_red_fence holderSurvives                # D2: 書きの epoch を進める表が fence にない。行を書いた取引が断られる
red     $f m24c_red_window placementFree                # D3: 待つ間も新しい取引にロックを与える。行は 1 つのシャード (asSqlite も破れる)
red     $f m24c_red_window optimisticOutcome            # 同上: 待っているシャードが、楽観の取引の COMMIT を受ける
green   $f m24c_window_apart lockSafe                   # 同じ形でも、2 つの取引の行が別のシャードにあれば SQLite と同じ (上の赤と合わせて、置き場所で決まる)
red     $f m24c_red_gap asSqlite                        # やり直しを進める側が後から記録する (m24_retry の形): 取り消しとやり直しの間に、待っていた取引がロックを得る
green   $f m24c_gap_one_shard lockSafe                  # 同じ形でも、行が 1 つのシャードにあれば取り消しが起きず、SQLite と同じ
red     $f m24c_red_holder_here holderNotDelayed        # 待っているシャードが、そのシャードにロックを持つ取引にだけ与える: 別のシャードの持ち主の書き込みが待たされる
green   $f m24c_holder_here_one_shard lockSafe          # 同じ形でも、行が 1 つのシャードにあれば待たされない
# witness は、置き場所を 1 つにした場面で探す (m24c_green の置き場所の 1 つ)。モデルには、ここで流さない witness もある
# (witnessLateBlockedFenced、witnessReaderPasses、witnessOptimisticBusyFenced、witnessOptimisticAfterBusy。2026-11-17 に届くことを確かめた)。
witness $f m24c_green_one witnessLateWaitsOne           # 行が 1 つのシャード。待つ間に来た BEGIN IMMEDIATE の取引が待ち、DDL が確定し、取引も確定する
witness $f m24c_green_apart witnessLateWaitsTwo         # 同じ予定で、後から来た取引の行が、prepare を適用したシャードにある
witness $f m24c_green_one witnessLateBlockedPending     # 後から来た取引が、待っているシャードで、与えられずに待っている
witness $f m24c_green_cross witnessRestartKeepsWaiting  # 取り消しとやり直しをまたいで、後から来た取引が待ち続け、DDL が確定する
witness $f m24c_green_cross witnessBusyThenLate         # 持ち主が期限を過ぎてロックを持ち、DDL が期限に失敗し、待っていた取引はその後で通る
witness $f m24c_green_cross witnessTwoHolders           # 2 つの持ち主。片方の、もう片方を待つシャードへの書き込みが、取り消させずに通る
witness $f m24c_green_reader witnessReaderRefused       # DDL の前に読んだ取引は、DDL の確定の後で断られる
witness $f m24c_green_optimistic witnessOptimisticBusyPending  # 楽観の取引の COMMIT が、待っているシャードで競合になる
green   $f m24c_red_window witnessLateBlockedPending    # 同じ witness は、待つ間も与える形では届かない
live    $f m24c_green_cross lockLive                    # 活性: 始めた DDL は終わり、時刻は上限まで進み、送られた文は答えを得る (取り消しとやり直しが起きる置き場所)
for m in m24c_green m24c_red_reads m24c_red_fence m24c_red_window m24c_window_apart m24c_red_gap m24c_gap_one_shard \
         m24c_red_holder_here; do tests $f $m; done

echo "== M22 unique keys (主キー以外の UNIQUE をキーの行にまとめる。グループが piece ごとに動く間も、UNIQUE の値を書く文が通る。実装より先に書いたモデル)"
f=m22_unique_keys.qnt
green   $f m22_green uniqueSafe                         # グループの全部が piece ごとに移る。決着させてから切る規則も、子がグループを待つ規則もない
green   $f m22_green_split uniqueSafe                   # テナントを割る移動。親は残る piece の書き込みを受け続け、キーの行が子にあれば 2PC
green   $f m22_green_parent_until_cut uniqueSafe        # 外しても破れない: 親が、fence の後も、切っていない piece の位置の prepare を受ける
green   $f m22_green3_one uniqueSafe                    # piece 3 つ (piece 3 にはキーの位置だけ)、取引 1 つ
live    $f m22_live writeTerminates                     # 活性: 移動が止まっても (要らない piece が切られなくても)、計画した取引は終わる
live    $f m22_live_split writeTerminates
red     $f m22_red_key_at_row uniqueVisible             # キーを、値を持つ行のシャードが手元のキーの行で確かめる (シャードの中の index の考え方)
red     $f m22_red_key_unarrived uniqueVisible          # 子が、届いていない piece のキーを「ない」と見なす
red     $f m22_red_no_key_lock uniqueVisible            # キーの行の intent を、ほかの取引が見ない (M16 の m16_red_body_only の形)
red     $f m22_red_no_key_body uniqueVisible            # キーの持ち主が、確定したキーの行を確かめない
red     $f m22_red_key_after_commit uniqueVisible       # キーの行を行と同じ 2PC に入れず、確定の後に書く
red     $f m22_red_keep_old_key keysExact               # 値を手放す行のキーの行を消さない
red     $f m22_red_key_intent_with_row keysExact        # キーの行の intent が、値を持つ行の piece と一緒に動く
red     $f m22_red_key_intent_with_row committedApplies
red     $f m22_red_physical_unique committedApplies     # 物理の index を一意のままにする: piece ごとの適用で、子の挿入が断られる (m20_red_piecewise の形)
if [ "${HEAVY:-0}" = "1" ]; then                        # 同上。見える状態は UNIQUE を守ったままで、破れるのは適用だけである (約 3 分)
  green $f m22_red_physical_unique uniqueVisible
fi
red     $f m22_red_group_refuse noMigratingRefusal      # M20 の規則: 子は、グループが揃うまで、UNIQUE の値を書く取引を migrating で断る
live_red $f m22_live_red_group_wait writeTerminates     # M20 の規則を、断らずに待つ形にしたもの: 要らない piece が切られなければ、取引が終わらない
witness $f m22_track witnessWriteDuringMoveSamePiece    # 移動の途中に、行と同じ piece のキーを取る INSERT が、子で確定して適用される
witness $f m22_green3_one witnessWriteDuringMoveOtherPiece   # 同じく、キーの位置が行と違う piece にある
witness $f m22_track witnessKeyMovedThenChecked         # キーの行が holder を持ったまま子へ移り、子がそれで同じ値を断る
witness $f m22_track witnessPiecewiseApply              # 確定した取引の intent が、2 度以上に分けて適用される
witness $f m22_track witnessSwapAcrossPieces            # 値を 2 つの行の間で動かす取引が、fence の後に piece ごとに適用される
witness $f m22_track_split witnessCrossShardConflict    # 行とキーの行が別のシャードにあり、キーの持ち主が断る
witness $f m22_track_split witnessTwoShardCommit        # 行とキーの行が別のシャードの 2PC で確定し、両方で適用される
if [ "${HEAVY:-0}" = "1" ]; then                        # piece 3 つ、取引 2 つ
  green $f m22_green3 uniqueSafe
  green $f m22_green3_split uniqueSafe
fi
for m in m22_track m22_track_split m22_green3_one m22_red_key_at_row m22_red_key_unarrived m22_red_no_key_lock m22_red_no_key_body \
         m22_red_key_after_commit m22_red_keep_old_key m22_red_key_intent_with_row m22_red_physical_unique m22_red_group_refuse \
         m22_live_red_group_wait; do tests $f $m; done

echo "== M23 refresh across move (範囲の移動をまたぐ取引の read refresh と、子での確定。実装より先に書いたモデル)"
f=m23_refresh_across_move.qnt
# 設計 1 (推奨): Worker は今の持ち主へ送り、子が、到着より前の窓を親の記録で埋める
green   $f m23_green m23Safe                            # 全表を 2 回読み、動いた行を楽観で書く (再現の形)。W と Y、範囲表の古い Worker の refresh あり
green   $f m23_green_ro m23Safe                         # 読むだけの取引
green   $f m23_green_pess m23Safe                       # 悲観の取引。T は最初の読みのまま、子で確定する
red     $f m23_red_parent_alone serializable            # 親が、渡したグループの確かめに、自分の記録だけで答える (範囲表の古い Worker は子に尋ねない)
red     $f m23_red_child_from_floor serializable        # 子が、自分の記録を床から確かめる (到着の後、床の前の確定を見落とす)
red     $f m23_red_child_from_arrival serializable      # 子が、到着の m から確かめる (pull に乗った intent を m 以下の c で適用したものを見落とす)
red     $f m23_red_no_peer serializable                 # 子が、到着より前からの窓を、親の記録で埋めない
red     $f m23_red_prepare_alone serializable           # 確定の検証でだけ、親の記録で埋めない (失われた更新)
red     $f m23_red_no_bump serializable                 # 確かめに答えたシャードが、時計を to まで進めない
red     $f m23_red_no_push placementIndependent         # 確かめが、c の決まっていない intent で失敗する (読むだけの取引が、移動のために失敗する)
red     $f m23_impl_pinned placementIndependent         # いまの実装: 取引が範囲表を取り直さず、動いた行の文が not owner で失敗する
red     $f m23_impl placementIndependent                # 範囲表だけ取り直す: 確かめは読んだシャードへ行き、親は not owner、子は床で断る
green   $f m23_impl_pinned answersSafe                  # どちらも、断るだけで、答えは誤らない
green   $f m23_impl answersSafe
red     $f m23_live_red_pingpong boundedRefusals        # 子が「前の持ち主へ」と断り、親が「渡した」と断る
live    $f m23_live refreshTerminates                   # 活性: 始めた refresh は、いつか終わる
live_red $f m23_live_red_pingpong refreshTerminates
witness $f m23_green witnessRefreshAcross               # 移動の時刻をまたいで T を進めた refresh が通り、確定する
witness $f m23_green witnessCommitAcross                # 移動の前に親で読んだ取引が、動いた行を子で書いて確定する
witness $f m23_green witnessReproduction                # 再現の形 (test/open/transaction-across-split.test.ts の 1 つ目) が確定する
witness $f m23_green witnessConflictBelowFloor          # 子が到着の後、床の前に確定した書き込みで、取引が競合になる
witness $f m23_green witnessBelowArrival                # T が到着の m より小さいまま、子で確定する
witness $f m23_green witnessRefusedThenCommitted        # 親が範囲表の古い取引の確かめを断り、取引が範囲表を直して確定する
witness $f m23_green_pess witnessBelowArrival
witness $f m23_green_ro witnessAborted                  # 読むだけの取引が、移動の後の読み直しで競合になる (持ち主の判断 1)
# 段 2 の直後の親 (fence の後は範囲の要求を全部断る。M19 の前)。確かめの上限と組み合わせた形 (下の推奨の組み合わせ) を既定にし、
# 上限のない形は HEAVY にした (2026-11-16、M23b を足して、節の時間を抑えるため)
if [ "${HEAVY:-0}" = "1" ]; then
  green $f m23_green_fenced m23Safe
  live  $f m23_live_fenced refreshTerminates
fi
# 確かめの上限を to で切る案 (持ち主の判断 1。2026-11-16 に採った)
red     $f m23_green_ro readOnlyBelowStart              # 上限のない確かめでは、床より後の確定でも、読むだけの取引が失敗する
green   $f m23_green_bounded m23Safe
green   $f m23_green_ro_bounded m23Safe
green   $f m23_green_ro_bounded readOnlyBelowStart      # 上限を切れば、読むだけの取引が失敗するのは、窓 (from, 床] に確定があるときだけである
# 推奨の組み合わせ (設計 1、段 2 の直後の親、確かめの上限)
green   $f m23_green_rec m23Safe
green   $f m23_green_rec_pess m23Safe
witness $f m23_green_rec_pess witnessBelowArrival
live    $f m23_live_rec refreshTerminates
green   $f m23_live_rec readOnlyBelowStart
# 設計 2 (退けた案): Worker が親と子の両方に尋ね、親は要求の epoch で確かめる。2026-11-16 に設計 1 を採ったので、HEAVY にした
if [ "${HEAVY:-0}" = "1" ]; then
  green   $f m23_alt_green m23Safe
  green   $f m23_alt_green_ro m23Safe
  green   $f m23_alt_green_pess m23Safe
  red     $f m23_alt_red_parent_alone serializable      # Worker が、読んだシャード (親) だけに尋ねる
  red     $f m23_alt_red_no_epoch serializable          # 親が、要求の epoch を見ずに答える
  red     $f m23_alt_red_child_from_floor serializable
  red     $f m23_alt_red_unarrived serializable         # 子が、グループが届く前に答える (飛んでいる intent を、親も子も見ない)
  red     $f m23_alt_red_prepare_alone serializable     # 確定で、Worker が親を検証に入れない
  live    $f m23_alt_live refreshTerminates
  witness $f m23_alt_green witnessReproduction
  green   $f m23_green_wide m23Safe                     # tick 2 回、T の上限 6
fi
for m in m23_green m23_green_pess m23_green_fenced m23_green_ro_bounded m23_red_parent_alone m23_red_child_from_floor m23_red_child_from_arrival m23_red_no_peer \
         m23_red_prepare_alone m23_red_no_bump m23_red_no_push m23_impl_pinned m23_impl m23_live_red_pingpong \
         m23_alt_green m23_alt_red_parent_alone m23_alt_red_no_epoch m23_alt_red_unarrived; do tests $f $m; done

echo "== M23b refresh across two moves (範囲がもう一度動く間も続く取引。受け取りの記録をたどって前の持ち主たちに尋ねる。実装より先に書いたモデル)"
f=m23b_refresh_two_moves.qnt
# 書き手 W と Y を両方入れると大きいので、既定では 1 つずつにした (両方の形は HEAVY)
green   $f m23b_green_w m23bSafe                        # 全表を 2 回読み、動いた行を楽観で書く (再現の形)。書き手は W。範囲表の古い Worker の refresh あり
green   $f m23b_green_y m23bSafe                        # 同じ形で、書き手は Y (intent が移動のたびに運ばれ、m 以下の c で適用されることがある)
green   $f m23b_green_ro_w m23bSafeRO                   # 読むだけの取引。m23bSafe と readOnlyBelowStart (失敗するのは、窓 (読んだ時刻, to] に確定があるときだけ)
green   $f m23b_green_ro_y m23bSafeRO
green   $f m23b_green_pess m23bSafe                     # 悲観の取引 (W と Y)。T は最初の読みのまま、2 回の移動の後に確定する
green   $f m23b_green_back_y m23bSafe                   # 範囲が S0 へ戻る (閉路)。読むだけ
red     $f m23b_red_stop_first serializable             # 尋ねられたシャードが、それ以上尋ねない (最初の前の持ち主で止まる)
red     $f m23b_red_forget serializable                 # 受け取りを終えたら、受け取りの記録を忘れる
red     $f m23b_red_forget_one serializable             # 同上、移動 1 回で
red     $f m23b_red_mid_from_arrival serializable       # 尋ねられたシャードが、自分の記録を自分の到着の m から確かめる
red     $f m23b_red_mid_alone serializable              # 移動 2 で渡したシャードが、範囲表の古い Worker の確かめに答える
red     $f m23b_red_skip_push serializable              # いまの持ち主の確かめが、c の決まっていない intent を push せずに通す (anchor が to 以下の c を決める)
red     $f m23b_live_red_cycle boundedAsks              # 範囲が戻ったとき、記録を時刻で選ばないと、尋ね合いが終わらない
live    $f m23b_live chainLive                          # 活性: 始めた refresh も、尋ね始めた確かめも、いつか終わる (refreshTerminates と asksEnd)
witness $f m23b_green_w witnessReproduction2            # 再現の形が、2 回の移動をまたいで、前の持ち主 2 つに尋ねて確定する
witness $f m23b_green_w witnessOneHop                   # 移動の間に読んだ取引が、前の持ち主 1 つにだけ尋ねて確定する
witness $f m23b_green_w witnessFoundAtS0                # 移動 1 の前に S0 で確定した書き込みを、尋ねる列が見つける
witness $f m23b_green_pess witnessBelowArrival2         # T が移動 1 の m より小さいまま、移動 2 の行き先で確定する
witness $f m23b_green_back_y witnessReadAcross2         # 範囲が戻った後、2 回の移動をまたいで T を進めて確定する
if [ "${HEAVY:-0}" = "1" ]; then                        # 活性の検査 (1 本 3 分ほど) と、書き手 W と Y の両方
  live     $f m23b_live_back chainLive                  # 範囲が S0 へ戻る形でも、refresh と尋ねる列が終わる
  live_red $f m23b_live_red_cycle chainLive             # 記録を時刻で選ばないと終わらない (安全の赤 boundedAsks は既定で確かめる)
  green $f m23b_green m23bSafe                          # T の上限 6
  green $f m23b_green_ro m23bSafeRO
  green $f m23b_green_back m23bSafe
  green $f m23b_green_one m23bSafe                      # 移動 1 回 (M23 の推奨の組み合わせと同じ規則)
fi
for m in m23b_green m23b_green_pess m23b_green_back m23b_red_stop_first m23b_red_forget m23b_red_mid_from_arrival m23b_red_mid_alone \
         m23b_red_skip_push m23b_live_red_cycle; do tests $f $m; done

echo "== M23c old reads across moves (移動の前の読み取り時刻の読みに、前の持ち主の記録で答える。実装より先に書いたモデル)"
f=m23c_old_reads_across_move.qnt
green   $f m23c_green_ro_w m23cSafeRO                   # 読むだけの取引。書き手 W、2 回の移動。読むだけの取引は「古すぎる」のほかでは失敗しない
green   $f m23c_green_ro_y m23cSafeRO                   # 同上、書き手 Y (pull に乗った intent が、受け取る前の c で子で適用される)
green   $f m23c_green_w m23cSafe                        # 書く取引 (楽観)。書き手 W
green   $f m23c_green_back_y m23cSafeRO                 # 範囲が S0 へ戻る。読むだけ、書き手 Y
green   $f m23c_green_split_floor m23cSafeRO            # 閾値を範囲の床にしても、持ち主が自分の版を重ねれば安全 (全表の span の形)
green   $f m23c_green_retain m23cSafeRO                 # 変更ログを切り詰める (移動 1 回)。渡した行は logLowWater が手放した時刻を越えるまで残す
green   $f m23c_green_empty m23cSafeRO                  # 空にされたグループは運ばれず、子は範囲の床より前の T を前の持ち主に尋ねる
green   $f m23c_green_empty_w m23cSafe                  # 同上で、書く取引 (確定の検証も、範囲の床を窓の上端にして前の持ち主に尋ねる)
red     $f m23c_base_ro roNeverFails                    # M23b の規則のまま: 案 A' の形で、読むだけの取引が移動のために失敗する
red     $f m23c_red_child_below readConsistent          # 持ち主が、到着より前の T に、受け取った行で答える
red     $f m23c_red_no_merge readConsistent             # 持ち主が、自分の版を重ねない (受け取る前の c で適用した intent を落とす)
red     $f m23c_red_prev_above readConsistent           # 閾値を床にして重ねない: 前の持ち主が到着の m 以上の T に答え、子の書き込みを落とす
red     $f m23c_red_no_retain readConsistent            # 渡した行を、移動を終えたら消す (今の ack)
red     $f m23c_red_no_epoch readConsistent             # 渡したシャードが、範囲表の古い Worker の読みに、残した行で答える
red     $f m23c_red_worker_routes readConsistent        # Worker が古い読みを前の持ち主へ直接送る (持ち主は重ねず、intent も push しない)
red     $f m23c_red_empty_no_floor readConsistent       # 運ばれなかったグループの窓の始まり (範囲の床) を記録しない
live    $f m23c_live_end txnEnds                        # 活性: 取引はいつか終わる (読みが intent や到着を待ち続けない)。OTHER なし
live    $f m23c_live_end_w txnEnds                      # 同上、書く取引
live    $f m23c_live_end_back txnEnds                   # 同上、範囲が S0 へ戻る形
live    $f m23c_live_end_empty txnEnds                  # 同上、空にされたグループ (子は finish で受け持つ)
live    $f m23c_live_end_retain txnEnds                 # 同上、変更ログを切り詰める形
witness $f m23c_green_ro_w witnessAPrime                # 案 A' の形の読むだけの取引が、T を進めずに確定する
witness $f m23c_green_ro_w witnessForward2              # 2 回の移動をまたいで、前の持ち主 2 つに尋ねた読みで確定する
witness $f m23c_green_ro_y witnessOverlay               # 持ち主の重ねた版 (受け取る前の c で適用した intent) が答えになる
witness $f m23c_green_retain witnessTooOld              # 前の持ち主の logLowWater より古い読みが「古すぎる」で断られる
witness $f m23c_green_w witnessWriteAcross2             # 書く取引が、T を進めずに 2 回の移動をまたいで確定する
witness $f m23c_green_empty witnessEmptyRead            # 空にされたグループの、削除の前の行を、前の持ち主に尋ねて読む
if [ "${HEAVY:-0}" = "1" ]; then
  green $f m23c_green_y m23cSafe                        # 書く取引、書き手 Y
  green $f m23c_green_pess m23cSafe                     # 悲観の取引、書き手 W と Y
  green $f m23c_green_split_floor_y m23cSafeRO
  green $f m23c_green_retain_w m23cSafe                 # 書く取引で、変更ログを切り詰める
  green $f m23c_green_retain2 m23cSafeRO                # 移動 2 回で、変更ログを 1 回切り詰める
  green $f m23c_green_retain_y m23cSafeRO               # 変更ログを切り詰め、書き手 Y (重ねることと、受け取りの記録を消すこと)
  live  $f m23c_live chainLive                         # OTHER ありで、refresh と尋ねる列が終わる (古い読みはどちらも使わない。M23b の m23b_live と同じ規則)
fi
for m in m23c_green_ro_w m23c_green_ro_y m23c_green_w m23c_green_retain m23c_green_empty m23c_base_ro m23c_red_child_below \
         m23c_red_no_merge m23c_red_prev_above m23c_red_no_retain m23c_red_no_epoch m23c_red_worker_routes m23c_red_empty_no_floor; do tests $f $m; done

echo "== M23d old reads keep the versions they overlay (古い読みに重ねる自分の版を、変更ログの切り詰めで失わない。実装より先に書いたモデル)"
f=m23d_old_read_retention.qnt
green   $f m23d_green m23dSafe                           # 受け持ち始める前の c の版を残し、logLowWater が m 以上になってから消す。書き手 Y
green   $f m23d_green_w m23dSafe                         # 同上、書き手 Y と W
red     $f m23d_red_log_only readAtT                     # 重ねる版を変更ログからだけ取る (1 回目の実装): 切り詰めで消えた版を落とす
red     $f m23d_red_keep_until_c readAtT                 # 残した版を、logLowWater が c 以上になったら消す
witness $f m23d_green witnessKeptUsed                    # 古い読みが、変更ログから消えた自分の版を、残した版から答える
for m in m23d_green m23d_red_log_only m23d_red_keep_until_c; do tests $f $m; done

echo "== M23e lock carry (範囲の移動で、行ロックを新しい持ち主へ運ぶ。寿命は M25 の取引の lease。実装より先に書いたモデル)"
f=m23e_lock_carry.qnt
green   $f m23e_green m23eSafe                          # 運び、lease をそのまま持ち、延長と unlock を転送し、先に届いた転送を覚え、運んだ先を保存する。動く置き場所と動かない置き場所で結果が同じ
red     $f m23e_red_memory_record stmtKeeps             # 運んだ先をメモリにだけ持つ: 親が再起動すると延長が届かず、運んだロックが、取引が働く間に切れる
red     $f m23e_red_memory_record endReleases           # 同上: 親が再起動した後に終わった取引の、運んだロックが残る (lease の期限で切れる)
green   $f m23e_red_memory_record m23eWeak              # 同上でも、直列化可能性は破れず、動かない置き場所より早くロックを失うことはない
red     $f m23e_red_no_carry outcomeSame                # 運ばない: lease は取引のものでも、W は、動く置き場所でだけ、待たずに書く
red     $f m23e_red_regrant lockProtects                # 運ばず、延長が届いたら与え直す: 取引は、読んだ後に書かれた行のロックを持つ (M25 の m25_red_regrant と同じ欠陥)
red     $f m23e_red_regrant outcomeSame
red     $f m23e_red_fresh_lease idleLoses               # 受け取った側が新しい期限を与える: 放っておかれた取引のロックが L より長く残る
red     $f m23e_red_no_forward_renew stmtKeeps          # 親が延長を転送しない: 運んだロックが、取引が働く間に切れる
red     $f m23e_red_no_forward_renew outcomeSame
red     $f m23e_red_no_forward_unlock outcomeSame       # 親が unlock を転送しない: ROLLBACK の後も、W は、動く置き場所でだけ待つ
red     $f m23e_red_no_early outcomeSame                # 受け取る側が、先に届いた転送を覚えない: 飛んでいる間の ROLLBACK の後に、ロックが届く
live    $f m23e_live leaseLive                          # 活性: ロックはいつか全部切れ、待つ W は終わる
witness $f m23e_green witnessCarriedBusy                # 運んだロックが転送された延長で延び、W はどちらの置き場所でも SQLITE_BUSY、取引が確定する
witness $f m23e_green witnessEarlyRenew                 # pull の応答が飛んでいる間の延長を、届いたロックに当てる
witness $f m23e_green witnessEarlyUnlock                # 飛んでいる間に ROLLBACK した取引のロックを入れず、W がどちらの置き場所でも書く
witness $f m23e_red_memory_record witnessLeftover       # 親の再起動の後に取引が終わり、運んだロックが残る
for m in m23e_green m23e_red_memory_record m23e_red_no_carry m23e_red_regrant m23e_red_fresh_lease m23e_red_no_forward_renew \
         m23e_red_no_forward_unlock m23e_red_no_early; do tests $f $m; done

echo "== M23f statement snapshot (Worker の 1 つの文の要求は、どれも、その試みを計画した範囲表で区間を切る。実装より先に書いたモデル)"
f=m23f_statement_snapshot.qnt
green   $f m23f_green stmtSafe                          # 送る前に確かめ、取引の範囲表が試みのスナップショットでなければ計画し直す。移動 1 回
green   $f m23f_green_plan stmtSafe                     # claim を試みのスナップショットで切り、計画し直すのは NotOwner のときだけ、という形も安全
red     $f m23f_red_claim_at_send noRegionDropped       # 2 回目の実装: claim を、送るときの範囲表で切る。宛先にないシャードへ動いた区間を、誰も読まない
red     $f m23f_red_claim_at_send noRegionTwice         # 同上: 答えを残した宛先から、送り直す宛先へ動いた区間を、2 度数える
green   $f m23f_red_claim_at_send readAtT               # 同上でも、シャードの答えは T の値である (誤るのは、Worker の答えの合わせ方)
red     $f m23f_red_resend_only noRegionTwice           # 送り直しの前だけ確かめる: 範囲表が替わった後の最初の送信が、新しい範囲表で切る
red     $f m23f_red_keep_answers noRegionTwice          # 計画し直すとき、答えた宛先の答えを残す (2 つのスナップショットの答えが混ざる)
live    $f m23f_live stmtEnds                           # 活性: 文はいつか揃う (移動では失敗しない)
witness $f m23f_green witnessRestartThenDone            # 計画し直した文が、2 つのシャードの答えで揃う
witness $f m23f_green witnessAdvancedAcrossSwap         # 範囲表を取り直した確かめが通って T が進み、文が揃う
witness $f m23f_green witnessDoneOnOldSnapshot          # 範囲表が替わった後、送る要求が残っていなければ、前のスナップショットの答えだけで揃う
witness $f m23f_green witnessFirstSendRestart           # 最初の送信の前の確かめで計画し直す (送り直しのない道)
witness $f m23f_green witnessNotAdvanced                # T を進められなかった文が、古い T のまま、計画し直して揃う
if [ "${HEAVY:-0}" = "1" ]; then                        # 移動 2 回 (2,896 万状態と 1,562 万状態。5 分と 3 分)
  green $f m23f_green2 stmtSafe
  green $f m23f_green_plan2 stmtSafe
fi
for m in m23f_green m23f_green_plan m23f_red_claim_at_send m23f_red_resend_only m23f_red_keep_answers; do tests $f $m; done

echo "== M23g ask then enter (前の持ち主に尋ねてから同期区間に入る間に、範囲が戻ってくる。受け持った期間ごとに答える。実装より先に書いたモデル)"
f=m23g_ask_then_enter.qnt
green   $f m23g_green_read m23gSafe                     # 読むだけの取引 (古い読み)。範囲が P → C → P → C と動く。書き手 W 2 つと Y
green   $f m23g_green_validate m23gSafe                 # 読んで書く取引 (確定の検証)
green   $f m23g_green_read_d m23gSafe                   # 範囲が別のシャードを回って戻る形 (P → C → D → C)
green   $f m23g_green_validate_d m23gSafe
green   $f m23g_forward_no_recheck m23gSafe             # 範囲が前の持ち主へ戻らなければ (P → C → D)、入口の確かめがなくても破れない
green   $f m23g_forward_no_recheck_validate m23gSafe
red     $f m23g_red_no_recheck readConsistent           # 入口で受け取りの記録を確かめない (2 回目の実装): 古い読みが、ほかの期間に適用された T 以下の版を落とす
red     $f m23g_red_no_recheck_validate serializable    # 同上、確定の検証: ほかの期間の確定を見落として確定する
red     $f m23g_red_no_recheck_d serializable           # 同上、P → C → D → C の形
red     $f m23g_red_no_window readConsistent            # 前の持ち主が、受け持った期間で区切らない: 後の期間の確定の before-image で、前の期間の行を戻す
red     $f m23g_red_no_window answerStable              # 同上: 同じ問いの答えが、尋ねる時点で変わる
red     $f m23g_red_held_overlaid readConsistent        # 前の持ち主が、T に持っていた部分にも残した版を重ねる: 古い版が、土台の新しい確定を隠す
live    $f m23g_live xEnds                              # 活性: 尋ね直しは終わり、取引はいつか終わる
witness $f m23g_green_read witnessReasked               # 尋ねてから入るまでに範囲が戻り、尋ね直して読みに答える
witness $f m23g_green_read witnessOverlaidAfterReask    # 尋ね直した答えが、ほかのシャードの期間に、受け持ち始める前の c で適用された版である
witness $f m23g_green_read witnessThreeHops             # 3 つの期間をさかのぼる読み
witness $f m23g_green_validate witnessConflictAfterReask   # 尋ね直した確かめが、ほかの期間の確定を見つけて、取引が競合になる
for m in m23g_green_read m23g_green_validate m23g_red_no_recheck m23g_red_no_recheck_validate m23g_red_no_window m23g_red_held_overlaid; do tests $f $m; done

echo "== M23h wide read (シャードの全表の読み。要求の claim の行だけを、時刻 T の値で答える。実装より先に書いたモデル)"
f=m23h_wide_read.qnt
green   $f m23h_green m23hSafe                          # 1 回の移動で 2 つの区間が動く。親は送り出しの途中も答え、子は受け取り終えるのを待って答える
green   $f m23h_green2 m23hSafe                         # 2 回の移動 (受け取りの記録が 2 つ)。子は claim を記録ごとに分ける
live    $f m23h_live readEnds                           # 活性: 読みは、いつか答えられるか NotOwner で断られる (子の待ちは終わる)
red     $f m23h_red_ignore_claim answersClaim           # 答える行を claim で絞らない: move-start を適用していない親が、動く区間の行も答える
red     $f m23h_red_partial answersClaim                # claim の一部しか持たなくても、持つ部分だけを答える
red     $f m23h_red_newest_floor answersAtT             # claim の全部を、いちばん新しい記録の床で決める: 子の書き込みを落とす
red     $f m23h_red_oldest_floor answersAtT             # いちばん古い記録の床で決める: 床より前の T の区間を、受け取った行で答える
red     $f m23h_red_no_wait answersAtT                  # 受け取り中の子が、待たずに答える: 届いていない区間の行が落ちる
red     $f m23h_red_child_migrating neverMigrating      # 前のコード: 受け取り中の子が migrating で断る (移動だけで文が失敗する)
red     $f m23h_red_parent_migrating neverMigrating     # 前のコード: 送り出している親が migrating で断る
witness $f m23h_green2 witnessSplitAnswer               # 1 つの claim の中で、ある区間は親に尋ね、別の区間は自分の行で答える
witness $f m23h_green witnessWaitedThenAnswered         # 子が、受け取り終えるのを待ってから答える
witness $f m23h_green witnessParentDuringMove           # 親が、送り出している途中に、残る区間の claim に答える
witness $f m23h_green witnessNarrowClaim                # 親が、まだ適用していない move-start を知っている Worker の、狭い claim に答える
for m in m23h_green m23h_green2 m23h_red_ignore_claim m23h_red_partial m23h_red_newest_floor m23h_red_oldest_floor m23h_red_no_wait; do tests $f $m; done

echo "== M23i guard across move (取引が読んだ表を DROP する前の確かめを、範囲の移動をまたいで通す。実装より先に書いたモデル)"
f=m23i_guard_across_move.qnt
green   $f m23i_green m23iSafe                          # 確かめをいまの持ち主へ送り、持ち主が前の持ち主に尋ね、自分の記録を読んだ時刻から確かめる
red     $f m23i_red_no_rehome placementIndependent      # いまのコード: 確かめを読んだシャードへ送る。移動だけで DROP が失敗する
green   $f m23i_red_no_rehome noLostWrite               # 同上でも、書き込みは失わない (断る側に倒れている)
red     $f m23i_red_no_ask noLostWrite                  # 持ち主が前の持ち主に尋ねない: 移動の前に、読んだシャードで確定した書き込みを失う
red     $f m23i_red_from_arrival noLostWrite            # 持ち主が自分の記録を到着の m から確かめる: pull に乗った intent の、m より小さい c の確定を失う
witness $f m23i_green witnessDroppedAcrossMove          # 読んだ後に範囲が動いても、変更がなければ DROP が commit される
witness $f m23i_green witnessRefusedByFormerOwner       # 前の持ち主への尋ねが、移動の前の書き込みを見つける
witness $f m23i_green witnessRefusedByCarriedIntent     # 持ち主の確かめが、受け持ち始める前の c で適用した確定を見つける
for m in m23i_green m23i_red_no_rehome m23i_red_no_ask m23i_red_from_arrival; do tests $f $m; done

echo "== M23j retained images across DDL (残した行イメージと表定義の変更。表ごとの epoch の下で、古い読みが表定義の変更をまたぐ。実装より先に書いたモデル)"
f=m23j_ddl_retained_images.qnt
green   $f m23j_green_rename m23jSafe                   # RENAME TO。残したイメージに変更を当て、尋ねが表の epoch を運ぶ。床は、変更ログに確定がなければ置かない
green   $f m23j_green_rename_y m23jSafe                 # 同上、書き手 Y (残した版) も
green   $f m23j_green_recreate m23jSafe                 # DROP TABLE の後に、同じ名前で CREATE TABLE
green   $f m23j_green_addcol m23jSafe                   # ADD COLUMN
green   $f m23j_exact_rename m23jExact                  # 床を、変更ログにある確定の時刻の最大にする形。床は、前の形の before-image を戻す読みだけを断る
green   $f m23j_exact_recreate m23jExact
red     $f m23j_red_no_reshape_rename readAtT           # 渡した行に RENAME TO を当てない: 後の名前の古い読みが、行を見つけない
red     $f m23j_red_no_reshape_recreate readAtT         # 渡した行に DROP TABLE を当てない: 消した表の行が、新しい表の古い読みに出てくる
red     $f m23j_red_no_reshape_kept readAtT             # 残した版に RENAME TO を当てない: 持ち主が重ねる版が見つからない
green   $f m23j_addcol_no_reshape readAtT               # ADD COLUMN は、当てなくても答えが変わらない
red     $f m23j_addcol_no_reshape imagesMatch           # 同上: 違うのはイメージの形だけ (答えの検査では見えない)
red     $f m23j_red_no_chain_epoch readAtT              # 前の持ち主への尋ねが表の epoch を運ばない: commit を適用していない (か、先に適用した) 前の持ち主が、違う名前の行で答える
red     $f m23j_red_no_floor noRestoreAcross            # 床を置かない: 前の形の before-image を、後の形の計画の読みに戻す
green   $f m23j_always_rename m23jSafe                  # 床を、いつも適用した時刻に置く形 (1 回目の実装より前) も、答えは誤らない
red     $f m23j_always_rename floorNeeded               # 同上: 変更ログに確定のないシャードが、適用した時刻より前の T を断る
green   $f m23j_always_rename witnessFormerBelowApply   # 同上: 前の持ち主が、適用した時刻より前の T の古い読みに答える道はない
red     $f m23j_green_rename floorNeeded                # 2 回目の実装の規則に残る、要らない断り: 確定のあるシャードが、最後の確定から適用までの間の T を断る
witness $f m23j_green_rename witnessHandedAcrossDdl     # DDL の後の計画の古い読みが、変更を当てた渡した行で答えられる
witness $f m23j_green_rename_y witnessKeptAcrossDdl     # 同上、残した版で
witness $f m23j_green_rename witnessFormerBelowApply    # 床を置かなかった前の持ち主が、適用した時刻より前の T の古い読みに答える
witness $f m23j_green_rename witnessStaleAtFormerOwner  # commit の前の計画の読みを、commit を適用した前の持ち主が断る (DDL で決まる失敗)
witness $f m23j_exact_rename witnessFloorRefuses        # 前の形の before-image を戻すことになる読みは、床が断る
for m in m23j_green_rename m23j_exact_rename m23j_red_no_reshape_rename m23j_red_no_reshape_recreate m23j_addcol_no_reshape \
         m23j_red_no_chain_epoch m23j_red_no_floor m23j_always_rename; do tests $f $m; done

echo "== M25 txn lock lease (行ロックの寿命を取引のものにする。どの文も、取引の全部のロックを延ばす。実装より先に書いたモデル)"
f=m25_txn_lock_lease.qnt
green   $f m25_green leaseSafe                          # 決めた設計 (R = 1)。4 つの置き場所を、同じ利用者の手で並べて動かす
green   $f m25_green_exact leaseSafe                    # 文ごとに延ばす形 (R = 0)
green   $f m25_per_shard_same leaseSafe                 # 今の形でも、行が 1 つのシャードにあれば、どの文もロックを延ばす (下の赤と合わせて、置き場所で決まる)
red     $f m25_red_per_shard outcomeSame                # 今の形: 文を受けたシャードだけが延ばす。y で働く間に、別のシャードの x のロックが切れる
red     $f m25_red_per_shard stmtKeeps
red     $f m25_red_local_lease outcomeSame              # 文を受けたシャードが、受けるたびに自分で now + L に延ばす
red     $f m25_red_no_epoch idleLoses                   # シャードが lease の版を見ない: 延長の再配達で、取り消した取引のロックが延び続ける
red     $f m25_red_regrant lockProtects                 # 延長が、切れたロックを取り直す
red     $f m25_red_trust_lease serializable             # COMMIT が lease を信じて検証を省く: 再起動でロックが消えた後の書き込みを失う
witness $f m25_green witnessBusyKeeps                   # 行が 2 つのシャード。y で働き続ける取引の x のロックは切れず、W が SQLITE_BUSY、取引が確定する
witness $f m25_green witnessIdleLoses                   # 放っておかれた取引の x のロックが切れて W が書き、COMMIT が競合になる (どの置き場所でも)
witness $f m25_green witnessRenew                       # 文が触らないシャードへ延長が届き、取引が確定する
witness $f m25_green witnessLeftover                    # unlock の届かなかったロックは、lease の期限で切れ、待っていた W が書く
witness $f m25_green witnessRestartCaught               # 再起動で消えたロックの後の W の書き込みを、COMMIT の検証が見つける
witness $f m25_green_exact witnessBusyKeeps
green   $f m25_red_per_shard witnessBusyKeeps           # 同じ witness は、今の形では届かない
live    $f m25_green leaseLive                          # 活性: ロックはいつか全部切れたままになり、待つ W は終わり、時刻は上限まで進む
live    $f m25_green_exact leaseLive
live_red $f m25_red_no_epoch locksReleased              # 版を見ないと、再配達で延び続けるロックが、時刻の上限を越えて残る
for m in m25_green m25_green_exact m25_per_shard_same m25_red_per_shard m25_red_local_lease m25_red_no_epoch m25_red_regrant \
         m25_red_trust_lease; do tests $f $m; done

echo "== M5c phase 2 while a range returns (範囲が前の持ち主へ戻る間に届く phase 2。未解決の問題 54 と 55。実装より先に書いたモデル)"
f=m5c_phase2_return.qnt
green   $f m5c_green m5cSafe                             # 「渡した」印はグループが届いたときに外し、転送はいまの印の移動の記録だけをたどる。移動 2 回
green   $f m5c_green3 m5cSafe                            # 同上、移動 3 回 (S0 → S2 → S0 → S2)
red     $f m5c_red_clear_at_start deliveredApplied       # 段 4 のコード: 戻る移動の start で印を外す。前の持ち主が適用も転送もせずに答える
red     $f m5c_red_clear_at_start noLostWrite            # 同上: 届け終えた記録が消えた後、戻ってきた intent を presumed abort で捨てる
red     $f m5c_red_follow_stale boundedForwards          # 段 4 より前: 転送の記録を全部たどり、S0 と S2 が互いに転送し合う
red     $f m5c_red_rehand handsUnderFence                # 問題 55: 終わった移動の遅れた pull に、範囲が戻った親がグループを渡し直す
red     $f m5c_red_rehand boundedForwards                # 同上: 付け直した印で、S0 の phase 2 が S2 との間を行き来する
live    $f m5c_green delivers                            # 活性: phase 2 はいつか届け終わる
live    $f m5c_green3 delivers
witness $f m5c_green witnessForwardBack                  # 戻る移動の途中で届いた phase 2 が、S2 へ行って S0 へ戻り、S0 で適用される
witness $f m5c_green witnessAppliedAtS2                  # 転送された phase 2 を、まだ渡していない S2 が適用する
for m in m5c_green m5c_red_clear_at_start m5c_red_follow_stale m5c_red_rehand; do tests $f $m; done

echo "== M5d move messages that outlive their move (移動の要求と応答が、その移動より後に届く。問題 54、55、58 の類。実装より先に書いたモデル)"
f=m5d_move_messages.qnt
# 緑: 規則の全部 (docs/design-move-messages.md)
green   $f m5d_green_return m5dSafe                      # 範囲が前の持ち主へ戻る (0 → 1 → 0)
green   $f m5d_green_chain m5dSafe                       # 戻らない列 (0 → 1 → 2)
green   $f m5d_green_return3 m5dSafe                     # 戻って、もう一度出る (0 → 1 → 0 → 1)。取引なし
green   $f m5d_green_groups m5dSafe                      # グループ 2 つ (行のあるものと、ないもの)。持ち主の書き込みと再起動なし
live    $f m5d_green_return m5dLive                      # 活性: どの移動も閉じ、始めた取引の phase 2 は届け終わる
live    $f m5d_green_chain m5dLive
if [ "${HEAVY:-0}" = "1" ]; then                         # 大きい形と、既定から外した緑 (合わせて 8 分ほど)
  live  $f m5d_green_return3 m5dLive
  green $f m5d_green_return3_txn m5dSafe                 # 0 → 1 → 0 → 1 に、取引を足す (再起動なし)
  green $f m5d_green_chain_back m5dSafe                  # 0 → 1 → 2 → 0 (再起動なし)
  green $f m5d_green_groups_owner m5dSafe                # グループ 2 つに、持ち主の書き込みを足す (取引と再起動なし)
  green $f m5d_marks_chain m5dSafe                       # 親の規則と子の規則があれば、印を 5808b08 のとおりに書き換えても破れない
  green $f m5d_marks_return3 m5dSafe
  green $f m5d_red_late_ack m5dOutcome                   # ack の規則を外しても、害はない
  green $f m5d_red_boot_differs markMatchesRecord        # 書き込みの後で付ける印は、記録と合う
  green $f m5d_prototype_return3 m5dData                 # 試作は、範囲が戻ってもう一度出る列でも、行と印は壊さない
  green $f m5d_prototype_chain m5dOutcome                # 試作は、戻らない列でも、害がない
fi
# 5808b08 のコード: 類の 1 から 7
red     $f m5d_code_return deliveredApplied              # 類の 1 と 3: 渡し直した印が、後の取引の phase 2 を適用させない
red     $f m5d_code_return ownerHasTruth                 # 類の 2: 渡し直しの ack が、持ち主の確定した行を消す
red     $f m5d_code_return markMatchesRecord             # 類の 3: 失敗した書き込みの前に付けた印が残る
red     $f m5d_code_chain deliveredApplied               # 類の 4 と 7: 遅れた応答の受け取りが、次の移動の印を消す
red     $f m5d_code_chain ackWillLand                    # 類の 5: ack が数えられない
live_red $f m5d_code_chain movesClose                    # 類の 5: 移動が閉じない
red     $f m5d_code_return3 ownerHasTruth                # 類の 6: 消した行が戻る
# 5808b08 に、条件を 1 つだけ入れた形
red     $f m5d_code_parent_rule deliveredApplied         # 親の規則だけ: 類の 7 が残る
red     $f m5d_code_parent_rule3 ownerHasTruth           # 親の規則だけ: 類の 6 が残る
red     $f m5d_code_child_rule deliveredApplied          # 子の規則だけ: 類の 1 と 3 が残る
red     $f m5d_code_child_rule ownerHasTruth             # 子の規則だけ: 類の 2 が残る (子は、捨てた応答にも ack を送る)
green   $f m5d_code_child_rule_chain m5dData             # 子の規則だけ: 戻らない列では、行も印も壊れない (類の 4、5、7)
red     $f m5d_code_derived_return rowsOnlyAtOwner       # 印の関数だけ: 類の 2 の行が、持ち主でない前の子に入る
red     $f m5d_code_derived_return ackWillLand           # 印の関数だけ: 類にない順序。渡し直した行が、まだ閉じていない移動 2 の親に入り、移動が閉じない
red     $f m5d_code_derived_return ownerHasTruth         # 印の関数だけ: 類にない順序。渡し直しが 2 回続き、持ち主が消した行が戻る
red     $f m5d_code_derived_return3 ownerHasTruth        # 印の関数だけ: 類の 6 が残る
green   $f m5d_code_derived_chain m5dData                # 印の関数だけ: 戻らない列では、行も印も壊れない (類の 4、5、7)
# 緑から、条件を 1 つ外す
red     $f m5d_red_rehand handsUnderFence                # 親の規則を外す (スイッチ rehandFinished)
red     $f m5d_red_rehand noFailedWrite                  # 同上: 類の 3 の、UNIQUE の失敗
green   $f m5d_red_rehand m5dData                        # 同上: 子の規則と印の関数があるので、行も印も壊れない
red     $f m5d_red_late_ack handsUnderFence              # ack の規則を外す (試作の形)。害がないことは HEAVY で確かめる
red     $f m5d_red_child_stale ownerHasTruth            # 子の規則を外す (スイッチ childAcceptsStale と finishIncomingByInterval): 類の 6 と、遅れた「渡し終えた」が、いまの受け取りを終える場面
red     $f m5d_red_child_stale receivesUnderIncoming
red     $f m5d_red_finished_refusal noMoveRefusal        # 「渡し終えた」を断りとして読む (スイッチ finishedAsRefusal。取り下げた 89d99c8)
red     $f m5d_red_ask_once noMoveRefusal                # 捨てた答えの後で、尋ね直さない (規則にない条件。スイッチ askOnce)
red     $f m5d_red_boot_differs marksDerived             # 印を手ごとに書き換える (スイッチ bootMarksDiffer)。親の規則も外す
red     $f m5d_red_boot_differs deliveredApplied         # 同上: 類の 1
red     $f m5d_red_mark_before_write markMatchesRecord   # 印を書き込みより前に付ける (スイッチ markBeforeWrite)。親の規則も外す: 類の 3
# 親の規則と子の規則があれば、印を 5808b08 のとおりに書き換えても破れない
green   $f m5d_marks_return m5dSafe
# 読み直しの試作: 親の規則 (pull だけ)、子の規則、「渡し終えた」は答え。ack と尋ね方は 5808b08 のまま
green   $f m5d_prototype_return m5dOutcome
red     $f m5d_prototype_return3 noMoveRefusal           # 範囲が戻ってもう一度出ると、1 回だけ尋ねる文が group not arrived で断られる
witness $f m5d_green_return witnessLateAfterNext        # 終わった移動の遅れた pull に、範囲が戻った後で、親が「渡し終えた」と答える
witness $f m5d_green_chain witnessLateAfterNext          # 同上、次の移動が閉じた後
witness $f m5d_green_return witnessFinishedInWindow      # 親が渡し終えた後、子が受け取り終える前の pull に「渡し終えた」と答える
witness $f m5d_green_return3 witnessLateResponse         # 生きた fence の下の応答が、子が受け取り終えた後も飛んでいる
witness $f m5d_green_return witnessUncarriedWritten      # 運ばれなかったグループを、子が到着の記録なしで受け持って書く
witness $f m5d_green_chain witnessForwarded              # phase 2 が転送されて、いまの持ち主で適用される
for m in m5d_green_return m5d_green_chain m5d_green_return3 m5d_code_return m5d_code_chain m5d_code_return3 \
         m5d_code_parent_rule m5d_code_parent_rule_return m5d_code_parent_rule3 m5d_code_child_rule m5d_code_child_rule_chain \
         m5d_code_child_rule3 m5d_code_derived_return m5d_code_derived_chain m5d_code_derived_return3 m5d_red_rehand \
         m5d_red_child_stale m5d_red_finished_refusal m5d_red_ask_once m5d_red_boot_differs m5d_red_mark_before_write; do tests $f $m; done

echo "== M7 restore (S6 の全シャード同時点復元)"
f=m7_restore.qnt
green   $f m7_green restoreCorrect
red     $f m7_red restoreCorrect
witness $f m7_green witnessRestoredNonEmpty
tests   $f m7_green
tests   $f m7_red

echo
echo "passed: $pass  failed: $fail"
[ "$fail" -eq 0 ]
