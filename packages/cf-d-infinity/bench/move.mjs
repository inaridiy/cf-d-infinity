// 移動の速度と、負荷をかけたままの移動の影響を測る。
import { writeFileSync } from "node:fs";
import { load, post } from "./run.mjs";

// 環境変数名に GROUPS は使えない。bash の特殊変数なので代入が無視される。
const GROUPS = Number(process.env.GROUP_COUNT ?? 256);
const ROWS = 400;
const ddl = "CREATE TABLE bulk(tenant_id INTEGER NOT NULL, id INTEGER NOT NULL, v TEXT, PRIMARY KEY (tenant_id,id))";
const ddl2 = "CREATE TABLE bench(tenant_id INTEGER NOT NULL, id INTEGER NOT NULL, n INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (tenant_id,id))";
const prep = async (cluster) => {
  await post("/admin/ddl", { cluster, shards: 1, sql: ddl });
  await post("/admin/ddl", { cluster, shards: 1, sql: ddl2 });
  // 1 シャードへのバルク投入は overloaded になりやすいので並列度を抑える。
  const run = async (op, extra) => {
    const lanes = 2;
    const per = GROUPS / lanes;
    await Promise.all(Array.from({ length: lanes }, async (_, i) => {
      for (let from = i * per + 1; from <= (i + 1) * per; from += 8) {
        await post("/bench", { op, cluster, shards: 1, tenants: GROUPS, concurrency: 1, durationMs: 0, from, to: from + 7, ...extra });
      }
    }));
  };
  await run("seedBulk", { times: ROWS });
  await run("seed", {});
};
const out = {};

// 1. 負荷なしの移動
const A = process.env.A ?? "mv2", B = process.env.B ?? "mv3";
await prep(A);
out.idle = await post("/admin/split", { cluster: A, shards: 1, parent: `${A}-0`, child: `${A}-1` });
console.log("idle", JSON.stringify(out.idle));

// 2. 書き込み負荷をかけたままの移動
await prep(B);
out.before = await load({ op: "write", cluster: B, shards: 1, tenants: GROUPS, clients: 12, concurrency: 4, durationMs: 5000 });
console.log("before", out.before.perSec, out.before.p50, out.before.p99);
const during = load({ op: "write", cluster: B, shards: 1, tenants: GROUPS, clients: 12, concurrency: 4, durationMs: 15000 });
await new Promise((r) => setTimeout(r, 2000));
out.hot = await post("/admin/split", { cluster: B, shards: 1, parent: `${B}-0`, child: `${B}-1` });
console.log("hot", JSON.stringify(out.hot));
out.during = await during;
console.log("during", out.during.perSec, out.during.p50, out.during.p99, JSON.stringify(out.during.failures).slice(0, 200));
out.after = await load({ op: "write", cluster: B, shards: 1, tenants: GROUPS, clients: 12, concurrency: 4, durationMs: 5000 });
console.log("after", out.after.perSec, out.after.p50, out.after.p99);
writeFileSync("bench/results/move.json", JSON.stringify(out, null, 1));
