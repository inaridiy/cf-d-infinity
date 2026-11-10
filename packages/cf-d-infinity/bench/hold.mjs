// 増設済みのクラスタへ同じ負荷を当て続け、台数が止まるかを見る。失敗はメッセージごとに残す。
// 使い方: URL=... TOKEN=... CLUSTER=stop1 BASE=<既存の書き込み合計> [RATE=<書き込み/s>] node bench/hold.mjs
import { mkdirSync, writeFileSync } from "node:fs";
import { load, post } from "./run.mjs";

const cluster = process.env.CLUSTER ?? "auto";
const TENANTS = 1024;
const BASE = Number(process.env.BASE ?? 0);
const WINDOWS = Number(process.env.WINDOWS ?? 36);
const CLIENTS = Number(process.env.CLIENTS ?? 120);
const RATE = process.env.RATE ? Number(process.env.RATE) : undefined;

// shards は起動時の台数。Autoscaler は既存の番号の続きから割り当てる。
await post("/admin/autoscale/start", { cluster, shards: 2, tickMs: 5000, thresholds: { cooldownMs: 60000, sustainTicks: 3 } });
const t0 = Date.now();
const timeline = [];
let total = 0;
for (let i = 0; i < WINDOWS; i++) {
  const r = await load({ op: "write", cluster, shards: 2, tenants: TENANTS, clients: CLIENTS, concurrency: 4, durationMs: 5000, ratePerSec: RATE });
  const st = await post("/admin/status", { cluster, shards: 2 });
  total += r.count;
  const row = {
    t: Math.round((Date.now() - t0) / 1000), shards: st.shards.length, perSec: r.perSec, p50: r.p50, p99: r.p99,
    failures: r.failures, skipped: r.skipped, rejected: r.rejected, rejectedSample: r.rejectedSample,
  };
  timeline.push(row);
  console.log(JSON.stringify(row));
}
await post("/admin/autoscale/stop", { cluster, shards: 2 });
const st = await post("/admin/status", { cluster, shards: 2 });
let check = null;
try {
  check = await post("/bench", { op: "verify", cluster, shards: 2, tenants: TENANTS, concurrency: 1, durationMs: 0 });
} catch (e) {
  check = { error: String(e) };
}
const verdict = { expected: BASE + total, ...check, exact: check.sum === BASE + total };
console.log("VERIFY", JSON.stringify(verdict));
const splits = st.scaler.events.filter((e) => e.kind !== "tick");
mkdirSync("bench/results", { recursive: true });
writeFileSync(`bench/results/hold-${cluster}.json`, JSON.stringify({ timeline, verdict, splits }, null, 1));
