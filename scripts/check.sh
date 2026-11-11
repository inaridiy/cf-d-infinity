#!/usr/bin/env bash
# main へ入れる前に、この計算機で流す検査。
#
# GitHub の CI は、push と PR のたびには走らない (遅く、GitHub に負荷を掛けるので、持ち主がやめた)。
# 代わりに、変更を main へ入れる前に、これを手元で流す。CI が流していたものと同じ内容である。
#
#   scripts/check.sh            型検査、全テスト、課金行数、sqllogictest、パッケージの作成確認、CLI の試験 (10 分ほど)
#   scripts/check.sh --quick    型検査と全テストだけ (2 分ほど)
#   scripts/check.sh --models   加えて、形式モデルの検査 (specs/check.sh。1 時間ほど)
#
# specs/ が main と違っていれば、--models を付けなくても、形式モデルの検査を流す。モデルを変えたのに検査を流さないまま
# main へ入れる、ということが起きないようにするためである。
#
# 失敗した段があれば、最後に一覧を出して、0 でない値で終わる。段ごとの出力は、表示するディレクトリに残る。
set -u
cd "$(dirname "$0")/.."
root=$PWD
quick=0; models=0
for a in "$@"; do
  case "$a" in
    --quick) quick=1 ;;
    --models) models=1 ;;
    *) echo "usage: scripts/check.sh [--quick] [--models]" >&2; exit 2 ;;
  esac
done

# specs/ に、main との差分か、コミットしていない変更があるか。
if ! git diff --quiet main -- specs 2>/dev/null || [ -n "$(git status --porcelain -- specs 2>/dev/null)" ]; then
  if [ "$models" = 0 ]; then echo "specs/ differs from main: the formal models will be checked too"; fi
  models=1
fi

logs=$(mktemp -d "${TMPDIR:-/tmp}/dinf-check-XXXXXX")
failed=()
# step <名前> <ディレクトリ> <コマンド...>
step() {
  local name=$1 dir=$2; shift 2
  local log="$logs/$(printf '%s' "$name" | tr -c 'a-zA-Z0-9' '-').log" start=$SECONDS
  if (cd "$root/$dir" && "$@") >"$log" 2>&1; then
    printf '  ok    %-34s %4ds\n' "$name" $((SECONDS - start))
  else
    printf '  FAIL  %-34s %4ds  %s\n' "$name" $((SECONDS - start)) "$log"
    failed+=("$name")
  fi
}

pkg=packages/cf-d-infinity
echo "checks (logs in $logs)"
step "typecheck" $pkg npm run typecheck
step "tests" $pkg npx vitest run
if [ "$quick" = 0 ]; then
  step "billed rows" $pkg env ROWCOST=1 npx vitest run test/rowcost.test.ts
  # sqllogictest の select1 から select5 は、取得済みならそのまま使う。
  if [ ! -f "$pkg/test/slt/select1.test" ]; then step "fetch sqllogictest" $pkg test/slt/fetch.sh; fi
  step "sqllogictest" $pkg env SLT_LIMIT=1000000 npx vitest run test/slt.test.ts
  step "package" $pkg npm pack --dry-run
  step "cli tests" packages/create-cf-d-infinity npm test
  step "cli package" packages/create-cf-d-infinity npm pack --dry-run
fi
if [ "$models" = 1 ]; then step "formal models" specs ./check.sh; fi

if [ ${#failed[@]} -gt 0 ]; then
  echo "failed: ${failed[*]}"
  exit 1
fi
echo "all checks passed"
