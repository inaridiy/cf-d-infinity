#!/usr/bin/env bash
# 夜間の乱択の検査 (計画書の完了の条件 8: 2 週間、新しい種類の失敗が出ない)。手元の計算機で、毎晩、新しい seed で流す。
#
#   scripts/nightly.sh                   # 既定: 上限 4 時間、並列 6、検査ごとに 300 seed
#   scripts/nightly.sh --hours 2 --procs 4 --seeds 100
#   scripts/nightly.sh --hours 15 --procs 10 --seeds 4200 --from 900001   まとめて回す (夜間の 2 週間分。範囲は夜間と重ならない)
#
# 流すのは、その時点の origin/main を取り出した worktree である。作業中のツリーには触らない。
# seed は日付から決める。同じ日に流し直すと同じ seed になり、日が変われば新しい seed になる。
# 結果は ${DINF_NIGHTLY_DIR:-$HOME/.dinf-nightly}/<日付>/ に置く (summary.txt に、検査ごとの通った数と落ちた seed)。
# 落ちた seed は、そのコミットで `SEEDS=<seed> npx vitest run <検査> -t "seed <seed>"` と流せば、同じように落ちる。
# 上限を超えた検査は、プロセスのグループごと止め、summary に「止まった」と書く。
set -u
hours=4; procs=6; seeds=300; from=
while [ $# -gt 0 ]; do
  case "$1" in
    --hours) hours=$2; shift 2 ;;
    --procs) procs=$2; shift 2 ;;
    --seeds) seeds=$2; shift 2 ;;
    --from) from=$2; shift 2 ;;
    *) echo "usage: scripts/nightly.sh [--hours h] [--procs n] [--seeds n] [--from seed]" >&2; exit 2 ;;
  esac
done

repo=$(cd "$(dirname "$0")/.." && pwd)
day=$(date +%F)
out="${DINF_NIGHTLY_DIR:-$HOME/.dinf-nightly}/$day${from:+-from$from}"
mkdir -p "$out"
exec >>"$out/nightly.log" 2>&1
echo "== $(date -Is) start: hours=$hours procs=$procs seeds=$seeds"

# 2 重に走らせない。
lock="${DINF_NIGHTLY_DIR:-$HOME/.dinf-nightly}/.lock"
if ! mkdir "$lock" 2>/dev/null; then echo "another nightly run holds $lock; exiting"; exit 0; fi
wt=$(mktemp -d "${TMPDIR:-/tmp}/dinf-nightly-XXXXXX")
cleanup() { git -C "$repo" worktree remove --force "$wt" >/dev/null 2>&1; rm -rf "$wt"; rmdir "$lock" 2>/dev/null; }
trap cleanup EXIT

# 流すコミット。既定は origin/main (DINF_NIGHTLY_REF で変えられる)。
ref=${DINF_NIGHTLY_REF:-origin/main}
git -C "$repo" fetch -q origin main || echo "fetch failed; using the local origin/main"
git -C "$repo" worktree add -q --detach "$wt" "$ref"
commit=$(git -C "$wt" rev-parse --short HEAD)
ln -s "$repo/packages/cf-d-infinity/node_modules" "$wt/packages/cf-d-infinity/node_modules"
echo "commit $commit" | tee "$out/commit"

# 日付ごとに違う seed の範囲。日数 × 10000 から始めるので、2 週間のどの晩とも重ならない。
# --from を与えると、その seed から始める (まとめて回すとき。結果の置き場は <日付>-from<seed> になる)。
if [ -z "$from" ]; then from=$(( ($(date +%s) / 86400) % 100000 * 10000 + 1 )); fi
to=$(( from + seeds - 1 ))
# 時間は 3 つの検査で分け合う。等分すると、seed が多いときに直列化の検査 (history、ほかの 2 つより重い) だけが時間切れになる
# (2026-11-13 の 4,200 seed で、5 時間の枠を 1 割ほど超えた)。各検査は、全体の残りの時間から、後の検査に 1/6 ずつ残した分を使う。
total=$(( hours * 3600 ))
reserve=$(( total / 6 ))
deadline=$(( $(date +%s) + total ))

: > "$out/summary.txt"
echo "commit $commit, seeds $from..$to, ${total}s in all" >> "$out/summary.txt"
cd "$wt/packages/cf-d-infinity"
left=3
for check in replay history ddl-concurrent; do
  left=$(( left - 1 ))
  start=$(date +%s)
  budget=$(( deadline - start - left * reserve ))
  # 欠陥を自分で入れて決まった seed で見つかることを確かめる試験は、ほかの seed では落ちるのが正しいので、流さない。
  setsid node scripts/sweep.mjs "test/$check.test.ts" "$from" "$to" --procs "$procs" --exclude "put back|search: seeds" > "$out/$check.txt" 2>&1 &
  pid=$!
  while kill -0 "$pid" 2>/dev/null; do
    if [ $(( $(date +%s) - start )) -gt "$budget" ]; then
      kill -KILL -- -"$pid" 2>/dev/null
      echo "timeout: $check did not finish within ${budget}s (a time limit, not proof of a hang)" >> "$out/$check.txt"
      break
    fi
    sleep 10
  done
  wait "$pid" 2>/dev/null
  { echo; echo "## $check ($(( $(date +%s) - start ))s)"; grep -E "passed|seeds:|timeout" "$out/$check.txt"; } >> "$out/summary.txt"
done
echo "== $(date -Is) done" >> "$out/nightly.log"
cat "$out/summary.txt"
