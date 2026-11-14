// 本番の Cloudflare 上での黒箱検査。取引の負荷をかけながら障害を混ぜ、履歴を bench/elle.mjs で検査する。
// 障害: DO の強制再起動、手動の増設、版を上げるデプロイ (即時更新なし = 新旧のコードが混在する)。
//
// 使い方 (計測用の構成 wrangler.bench.jsonc をデプロイ済みであること):
//   URL=https://... TOKEN=... ADMIN_TOKEN=... node bench/jepsen.mjs
// 環境変数: CLUSTER, DURATION (秒), CLIENTS (同時の /bench 呼び出し), LANES (呼び出しあたりの並列度),
//   CRASH_EVERY (秒)、SPLIT_AT (秒のカンマ区切り)、DEPLOY_ACCEPT_AT と DEPLOY_SEND_AT (秒。空なら行わない)
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { check } from "./elle.mjs";
import { post } from "./run.mjs";

const env = process.env;
const cluster = env.CLUSTER ?? "jep";
const DURATION = Number(env.DURATION ?? 600) * 1000;
const CLIENTS = Number(env.CLIENTS ?? 16);
const LANES = Number(env.LANES ?? 4);
const WINDOW = Number(env.WINDOW ?? 10) * 1000;
const CRASH_EVERY = Number(env.CRASH_EVERY ?? 15) * 1000;
const SPLIT_AT = (env.SPLIT_AT ?? "90,270").split(",").filter(Boolean).map((s) => Number(s) * 1000);
const DEPLOY_ACCEPT_AT = env.DEPLOY_ACCEPT_AT === "" ? null : Number(env.DEPLOY_ACCEPT_AT ?? 180) * 1000;
const DEPLOY_SEND_AT = env.DEPLOY_SEND_AT === "" ? null : Number(env.DEPLOY_SEND_AT ?? 420) * 1000;
const SHARDS = 4;

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const events = [];
const event = (kind, detail) => {
  events.push({ t: Math.round((Date.now() - t0) / 1000), kind, detail });
  log(kind, JSON.stringify(detail ?? {}).slice(0, 160));
};

await post("/admin/ddl", {
  cluster, shards: SHARDS,
  sql: "CREATE TABLE jep(k INTEGER NOT NULL, id INTEGER NOT NULL, v TEXT NOT NULL, PRIMARY KEY (k, id))",
});
const t0 = Date.now();
const until = t0 + DURATION;
const history = [];
const failures = {};
let lostInvocations = 0;

// 負荷。WINDOW ごとに CLIENTS 本の /bench を投げ、各呼び出しの履歴を集める。
const load = (async () => {
  while (Date.now() < until) {
    const windowMs = Math.min(WINDOW, until - Date.now());
    const parts = await Promise.allSettled(Array.from({ length: CLIENTS }, () =>
      post("/bench", { op: "jepsen", cluster, shards: SHARDS, tenants: 1, concurrency: LANES, durationMs: windowMs, epochMs: 20000, keysPerEpoch: 32 })));
    let ok = 0;
    for (const p of parts) {
      if (p.status === "rejected") {
        lostInvocations++;
        const m = String(p.reason).slice(0, 100);
        failures[`invocation: ${m}`] = (failures[`invocation: ${m}`] ?? 0) + 1;
        continue;
      }
      history.push(...p.value.history);
      ok += p.value.count;
      for (const [k, v] of Object.entries(p.value.failures)) failures[k] = (failures[k] ?? 0) + v;
    }
    log("window", { committed: ok, total: history.length, lostInvocations });
  }
})();

// 障害。
const shardList = async () => (await post("/admin/status", { cluster, shards: SHARDS })).shards;
const faults = (async () => {
  let nextCrash = t0 + CRASH_EVERY;
  const splits = [...SPLIT_AT];
  let nextChild = SHARDS;
  const deploys = [
    DEPLOY_ACCEPT_AT !== null && { at: t0 + DEPLOY_ACCEPT_AT, vars: { DINF_PROTOCOL_ACCEPT: "2" }, name: "deploy step 1: accept v2, send v1" },
    DEPLOY_SEND_AT !== null && { at: t0 + DEPLOY_SEND_AT, vars: { DINF_PROTOCOL_ACCEPT: "2", DINF_PROTOCOL_SEND: "2" }, name: "deploy step 2: send v2" },
  ].filter(Boolean);
  while (Date.now() < until - 20000) {
    await new Promise((r) => setTimeout(r, 500));
    const now = Date.now();
    if (now >= nextCrash) {
      nextCrash += CRASH_EVERY;
      try {
        const list = await shardList();
        const target = list[Math.floor(Math.random() * list.length)];
        await post("/bench", { op: "crash", cluster, shards: SHARDS, tenants: 1, concurrency: 1, durationMs: 0, target });
        event("crash", { target });
      } catch (e) {
        event("crash-failed", { error: String(e).slice(0, 100) });
      }
    }
    if (splits.length && now - t0 >= splits[0]) {
      splits.shift();
      try {
        const list = await shardList();
        const parent = list[Math.floor(Math.random() * list.length)];
        const child = `${cluster}-${nextChild++}`;
        const r = await post("/admin/split", { cluster, shards: SHARDS, parent, child });
        event("split", { parent, child, ms: r?.ms, groups: r?.groups });
      } catch (e) {
        event("split-failed", { error: String(e).slice(0, 160) });
      }
    }
    if (deploys.length && now >= deploys[0].at) {
      const d = deploys.shift();
      const vars = { DINF_API_TOKEN: env.TOKEN, DINF_ADMIN_TOKEN: env.ADMIN_TOKEN, ...d.vars };
      const args = ["wrangler", "deploy", "-c", "wrangler.bench.jsonc", ...Object.entries(vars).flatMap(([k, v]) => ["--var", `${k}:${v}`])];
      try {
        // 即時更新を付けない。active な DO は最大 300 秒、旧コードのまま動く。
        execFileSync("npx", args, { stdio: "pipe", timeout: 180000 });
        event("deploy", { name: d.name });
      } catch (e) {
        event("deploy-failed", { name: d.name, error: String(e.stderr ?? e).slice(0, 200) });
      }
    }
  }
})();

await Promise.all([load, faults]);
mkdirSync("bench/results", { recursive: true });
// 最後の読み取りが失敗しても検査できるよう、履歴を先に保存する。
writeFileSync(`bench/results/jepsen-${cluster}.history.json.gz`, gzipSync(JSON.stringify({ history })));
log("load done; settling");
await new Promise((r) => setTimeout(r, 15000));
const keys = [...new Set(history.flatMap((t) => t.ops.map((op) => op[1])))];
const finalReads = {};
const finalErrors = {};
for (let i = 0; i < keys.length; i += 50) {
  try {
    const r = await post("/bench", { op: "jepsenFinal", cluster, shards: SHARDS, tenants: 1, concurrency: 1, durationMs: 0, keys: keys.slice(i, i + 50) });
    Object.assign(finalReads, r.finalReads);
  } catch (e) {
    const m = String(e).slice(0, 120);
    finalErrors[m] = (finalErrors[m] ?? 0) + 1;
  }
}
log("final reads", { keys: keys.length, read: Object.keys(finalReads).length, finalErrors });
// 静かになった後に、決着していない intent と変更ログの世代が残っていないかを見る。
let shardsAfter = null;
try {
  shardsAfter = await post("/bench", { op: "info", cluster, shards: SHARDS, tenants: 1, concurrency: 1, durationMs: 0 });
  log("shards after", Object.fromEntries(Object.entries(shardsAfter).map(([id, v]) => [id, { gens: v.gens, intents: v.intents?.n }])));
} catch (e) {
  log("info failed", String(e).slice(0, 100));
}
const result = check(history, { finalReads, tolerateUnknown: lostInvocations > 0 });
const byMode = {};
for (const t of history) {
  const m = (byMode[t.mode] ??= { ok: 0, fail: 0, info: 0 });
  m[t.type]++;
}
const finalKeys = { total: keys.length, read: Object.keys(finalReads).length, errors: finalErrors };
const summary = { cluster, durationS: DURATION / 1000, valid: result.valid, anomalies: result.anomalies, stats: result.stats, byMode, lostInvocations, finalKeys, shardsAfter, failures, events };
console.log("RESULT", JSON.stringify({ valid: result.valid, stats: result.stats, byMode, lostInvocations, finalKeys, anomalies: Object.keys(result.anomalies) }));
writeFileSync(`bench/results/jepsen-${cluster}.json`, JSON.stringify(summary, null, 1));
writeFileSync(`bench/results/jepsen-${cluster}.history.json.gz`, gzipSync(JSON.stringify({ history, finalReads })));
