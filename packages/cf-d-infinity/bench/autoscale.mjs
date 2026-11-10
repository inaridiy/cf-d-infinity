// シャード 2 個で起動し、一定の負荷をかけ続けて、Autoscaler が増やす様子を記録する。
import { writeFileSync, mkdirSync } from "node:fs";
import { load, post, seed } from "./run.mjs";

const cluster = process.env.CLUSTER ?? "auto";
const TENANTS = 1024;
const WINDOW = 5000;
const WINDOWS = Number(process.env.WINDOWS ?? 28);
const CLIENTS = Number(process.env.CLIENTS ?? 120);
// 一定レートの負荷 (書き込み/s)。未指定なら応答が返ると次を送る負荷になり、台数とともに負荷も増える。
const RATE = process.env.RATE ? Number(process.env.RATE) : undefined;

await post("/admin/ddl", { cluster, shards: 2, sql: "CREATE TABLE bench(tenant_id INTEGER NOT NULL, id INTEGER NOT NULL, n INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (tenant_id,id)) SHARD KEY (tenant_id)" });
await seed(2, TENANTS, cluster);
await post("/admin/autoscale/start", { cluster, shards: 2, tickMs: 5000, thresholds: { cooldownMs: Number(process.env.COOLDOWN ?? 15000), sustainTicks: Number(process.env.SUSTAIN ?? 2) } });

const t0 = Date.now();
const timeline = [];
let total = 0;
for (let i = 0; i < WINDOWS; i++) {
  const r = await load({ op: "write", cluster, shards: 2, tenants: TENANTS, clients: CLIENTS, concurrency: 4, durationMs: WINDOW, ratePerSec: RATE });
  const st = await post("/admin/status", { cluster, shards: 2 });
  const row = {
    t: Math.round((Date.now() - t0) / 1000), shards: st.shards.length, perSec: r.perSec, p50: r.p50, p99: r.p99,
    failures: Object.values(r.failures).reduce((a, b) => a + b, 0), failuresByMessage: r.failures,
    skipped: r.skipped, rejected: r.rejected, rejectedSample: r.rejectedSample,
  };
  total += r.count;
  timeline.push(row);
  console.log(JSON.stringify(row));
}
// 負荷を止めた後も、未完了の増設が片付くまで待つ。
let st = await post("/admin/status", { cluster, shards: 2 });
for (let i = 0; i < 12; i++) {
  const done = st.scaler.events.filter((e) => e.kind === "split-done").length;
  const started = st.scaler.events.filter((e) => e.kind === "split-start").length;
  if (done >= started) break;
  await new Promise((r) => setTimeout(r, 5000));
  st = await post("/admin/status", { cluster, shards: 2 });
}
await post("/admin/autoscale/stop", { cluster, shards: 2 });
st = await post("/admin/status", { cluster, shards: 2 });
const check = await post("/bench", { op: "verify", cluster, shards: 2, tenants: TENANTS, concurrency: 1, durationMs: 0 });
console.log("VERIFY", JSON.stringify({ successfulWrites: total, ...check, tenants: TENANTS, exact: check.sum === total && check.count === TENANTS }));
const splits = st.scaler.events.filter((e) => e.kind.startsWith("split") || e.kind === "notify");
mkdirSync("bench/results", { recursive: true });
writeFileSync("bench/results/autoscale.json", JSON.stringify({ timeline, splits, routing: st.routing }, null, 1));
for (const e of splits) console.log(e.kind, JSON.stringify(e.detail).slice(0, 170));
