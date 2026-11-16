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
