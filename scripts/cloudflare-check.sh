#!/usr/bin/env bash
# 本物の Cloudflare で 1 度流す確認 (計画書の公開の条件 4)。Cloudflare に置くので、持ち主に頼まれたときにだけ流す (AGENTS.md の規則 6)。
#
#   scripts/cloudflare-check.sh          一時的な Worker を置き、test/workerd.test.ts をそこへ向けて流し、Worker を消す
#   scripts/cloudflare-check.sh --keep   調べるために消さずに残す。後で `npx wrangler delete --name <名前> --force` で消す
#
# 置くのは packages/cf-d-infinity/wrangler.jsonc と同じ構成である。名前を dinf-check-<乱数> に、シャードを 4 つに変え、
# Cron Trigger を外す (毎分 Autoscaler を起こさない。確認が終わった後に何も動かないようにするためである)。
# トークンは毎回乱数で作り、Worker と一緒に消える。wrangler が Cloudflare にログインしている必要がある (`npx wrangler login`)。
#
# 費用 (Workers Paid の単価で、含まれる量を差し引かずに数えた上限の見積もり。2026-11 の料金表):
#   試験は HTTP の要求を 500 回ほど送る (DINF_LIVE_MAX_REQUESTS で打ち切る。既定 3000)。
#   Worker の要求 3000 回 × $0.30/100 万 = $0.001、CPU 3000 回 × 100 ms × $0.02/100 万 ms = $0.006。
#   DO の要求は Worker の要求 1 回につき 20 回までと見て 6 万回 × $0.15/100 万 = $0.009。
#   DO の実行時間は 8 個 × 30 分 × 128 MB = 1,800 GB-s × $12.50/100 万 = $0.023。
#   行の書き込みは 10 万行 × $1.00/100 万 = $0.10、読みは 100 万行 × $0.001/100 万 = $0.001。保存は数 MB で、消すので数えない。
#   合わせて $0.15 を超えない。CPU の上限 (limits.cpu_ms) を 1 回 5 秒にして、止まらない処理が費用を積まないようにする。
set -u
cd "$(dirname "$0")/../packages/cf-d-infinity"
keep=0
for a in "$@"; do
  case "$a" in
    --keep) keep=1 ;;
    *) echo "usage: scripts/cloudflare-check.sh [--keep]" >&2; exit 2 ;;
  esac
done

name="dinf-check-$(openssl rand -hex 3)"
token=$(openssl rand -hex 24)
admin=$(openssl rand -hex 24)
mkdir -p .wrangler
cfg="$PWD/.wrangler/$name.jsonc"
deployed=0
cleanup() {
  rm -f "$cfg"
  if [ "$deployed" = 1 ]; then
    if [ "$keep" = 1 ]; then
      echo "kept $name; delete it with: npx wrangler delete --name $name --force"
    else
      echo "deleting $name"
      npx wrangler delete --name "$name" --force || echo "could not delete $name; delete it by hand"
    fi
  fi
}
trap cleanup EXIT

# wrangler.jsonc から作る。注釈の行を除いて JSON として読み、名前、シャードの数、Cron、CPU の上限だけを変える。
node -e '
  const fs = require("node:fs");
  const [cfg, name, dir] = process.argv.slice(1);
  const c = JSON.parse(fs.readFileSync("wrangler.jsonc", "utf8").split("\n").filter((l) => !/^\s*\/\//.test(l)).join("\n"));
  c.name = name;
  c.main = `${dir}/${c.main}`;
  for (const k of Object.keys(c.alias ?? {})) c.alias[k] = `${dir}/${c.alias[k].replace(/^\.\//, "")}`;
  c.vars = { ...c.vars, DINF_SHARD_COUNT: "4" };
  delete c.triggers;
  c.workers_dev = true;
  c.limits = { cpu_ms: 5000 };
  fs.writeFileSync(cfg, JSON.stringify(c, null, 2));
' "$cfg" "$name" "$PWD"

echo "deploying $name"
deployed=1
out=$(npx wrangler deploy -c "$cfg" --var "DINF_API_TOKEN:$token" --var "DINF_ADMIN_TOKEN:$admin" 2>&1 | sed -e "s/$token/<token>/g" -e "s/$admin/<admin>/g")
echo "$out"
url=$(printf '%s\n' "$out" | grep -oE 'https://[a-z0-9.-]+\.workers\.dev' | head -1)
if [ -z "$url" ]; then echo "no workers.dev URL in the deploy output"; exit 1; fi

# 新しい workers.dev の名前は、引けるようになるまで少しかかる。
for i in $(seq 1 30); do
  code=$(curl -s -o /dev/null -w '%{http_code}' -X POST -H "authorization: Bearer $token" "$url/v3")
  [ "$code" = 200 ] && break
  sleep 2
done
if [ "$code" != 200 ]; then echo "$url does not answer (last status $code)"; exit 1; fi

echo "running test/workerd.test.ts against $url"
DINF_LIVE_URL="$url" DINF_LIVE_TOKEN="$token" DINF_LIVE_ADMIN_TOKEN="$admin" \
  npx vitest run test/workerd.test.ts --project workerd --testTimeout=120000 --hookTimeout=120000
status=$?
echo "tests exited with $status"
exit $status
