#!/usr/bin/env bash
# 全モデルの一括検査。
#   green: TLC の全探索で No violation
#   red:   TLC が反例を見つける (違反検出 = 成功)
#   witness: 到達可能性 (not(到達したい状態) を invariant にして違反 = 成功。vacuous でないことの確認)
#   test:  run (決定的な反例・到達トレース) が通る
#   inductive: Apalache で帰納的不変条件を確認 (M4)
# 使い方: cd specs && ./check.sh            (HEAVY=1 ./check.sh で NTXN=3 の M1 も回す)
set -u
cd "$(dirname "$0")"
# TLC には Java 17 以上が要る。specs/.tools/jdk に置いてあればそれを使い、なければ PATH の java を使う。
if [ -d "$PWD/.tools/jdk" ]; then export JAVA_HOME="$PWD/.tools/jdk" PATH="$PWD/.tools/jdk/bin:$PATH"; fi

pass=0; fail=0
ok()   { pass=$((pass+1)); printf '  ok   %s\n' "$1"; }
bad()  { fail=$((fail+1)); printf '  FAIL %s\n' "$1"; }

# verify_expect <expected: ok|violation> <file> <module> <invariant>
verify_expect() {
  local expect=$1 file=$2 mod=$3 inv=$4 out
  out=$(npx quint verify --backend=tlc --main="$mod" --invariant="$inv" "$file" 2>&1)
  local states
  states=$(printf '%s\n' "$out" | grep -oE '[0-9,]+ distinct states found' | tail -1)
  case "$expect" in
    ok)
      if printf '%s\n' "$out" | grep -q '\[ok\] No violation found'; then ok "green    $mod $inv ($states)"; else bad "green    $mod $inv"; printf '%s\n' "$out" | tail -5; fi ;;
    violation)
      if printf '%s\n' "$out" | grep -q '\[violation\]'; then ok "$5 $mod $inv ($states)"; else bad "$5 $mod $inv (no violation found)"; printf '%s\n' "$out" | tail -5; fi ;;
  esac
}
green()   { verify_expect ok "$@"; }
red()     { verify_expect violation "$@" "red     "; }
witness() { verify_expect violation "$@" "witness "; }
tests() {
  local file=$1 mod=$2 out
  out=$(npx quint test --main="$mod" "$file" 2>&1)
  if printf '%s\n' "$out" | grep -qE 'failed|error'; then bad "test     $mod"; printf '%s\n' "$out" | grep -E 'failed|Error|error' | head -5
  else ok "test     $mod ($(printf '%s\n' "$out" | grep -oE '[0-9]+ passing'))"; fi
}
inductive() {
  local file=$1 mod=$2 ind=$3 inv=$4 out
  out=$(npx quint verify --main="$mod" --inductive-invariant="$ind" --invariant="$inv" "$file" 2>&1)
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
for m in m5b_green m5b_green_range m5b_red_range m5b_red_s3 m5b_red_s3_parent m5b_red_p2 m5b_red_p2_window m5b_red_intents; do tests $f $m; done

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
