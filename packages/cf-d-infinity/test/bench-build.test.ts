// 計測用の構成 (src/bench.ts) が本番の入口に計測と障害注入を足して動くこと。
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { Miniflare } from "miniflare";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
// @ts-expect-error -- JavaScript のモジュール
import { check } from "../bench/elle.mjs";

let mf: Miniflare;
const post = async (path: string, body: unknown, token = "admin-test") => {
  const r = await mf.dispatchFetch(`http://x${path}`, { method: "POST", body: JSON.stringify(body), headers: { authorization: `Bearer ${token}` } });
  return { status: r.status, body: (await r.json().catch(() => null)) as Record<string, unknown> };
};

beforeAll(async () => {
  execFileSync("npm", ["run", "-s", "bundle:bench"], { stdio: "inherit" });
  mf = new Miniflare({
    modules: [
      { type: "ESModule", path: "dist/bench.js", contents: readFileSync("dist/bench.js", "utf8") },
      { type: "CompiledWasm", path: "dist/sql-wasm.wasm", contents: readFileSync("src/sql-wasm.wasm") },
    ],
    compatibilityDate: "2026-07-01",
    bindings: { DINF_SHARD_COUNT: "2", DINF_API_TOKEN: "test", DINF_ADMIN_TOKEN: "admin-test" },
    durableObjects: {
      DINF_SHARD: { className: "DinfShard", useSQLite: true },
      DINF_META: { className: "DinfMeta", useSQLite: true },
      DINF_AUTOSCALER: { className: "DinfAutoscaler", useSQLite: true },
    },
  });
}, 60000);
afterAll(() => mf?.dispose());

describe("the benchmark build", () => {
  it("requires the admin token for /bench", async () => {
    expect((await post("/bench", { op: "ping", shards: 2, tenants: 1, concurrency: 1, durationMs: 10 }, "test")).status).toBe(401);
  });

  it("keeps the autoscaler ticking at a fixed period between start and stop, without load", async () => {
    const ticks = async () => ((await post("/admin/status", { cluster: "as", shards: 2 })).body.scaler as { events: { kind: string }[] })
      .events.filter((e) => e.kind === "tick").length;
    expect((await post("/admin/autoscale/start", { cluster: "as", shards: 2, tickMs: 100 }, "test")).status).toBe(401);
    expect((await post("/admin/autoscale/start", { cluster: "as", shards: 2, tickMs: 100 })).status).toBe(200);
    await new Promise((r) => setTimeout(r, 800));
    expect(await ticks()).toBeGreaterThanOrEqual(3);
    await post("/admin/autoscale/stop", { cluster: "as", shards: 2 });
    await new Promise((r) => setTimeout(r, 300));
    const stopped = await ticks();
    await new Promise((r) => setTimeout(r, 500));
    expect(await ticks()).toBe(stopped);
  });

  it("runs an open-loop load and keeps the sum exact across an injected crash", async () => {
    const base = { cluster: "bb", shards: 2, tenants: 20, concurrency: 1 };
    await post("/admin/ddl", { cluster: "bb", shards: 2, sql: "CREATE TABLE bench(tenant_id INTEGER NOT NULL, id INTEGER NOT NULL, n INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (tenant_id,id)) SHARD KEY (tenant_id)" });
    await post("/bench", { ...base, op: "seed", from: 1, to: 20, durationMs: 0 });
    const a = await post("/bench", { ...base, op: "write", durationMs: 1000, ratePerSec: 50 });
    expect(a.body.count).toBe(50);
    await post("/bench", { ...base, op: "crash", target: "bb-0", durationMs: 0 });
    const b = await post("/bench", { ...base, op: "write", durationMs: 1000, ratePerSec: 50 });
    const v = await post("/bench", { ...base, op: "verify", durationMs: 0 });
    expect(v.body).toEqual({ count: 20, sum: (a.body.count as number) + (b.body.count as number) });
  });

  it("produces a history the black-box checker accepts, with crashes injected during the run", async () => {
    const base = { cluster: "jj", shards: 2, tenants: 1, concurrency: 6 };
    await post("/admin/ddl", { cluster: "jj", shards: 2, sql: "CREATE TABLE jep(k INTEGER NOT NULL, id INTEGER NOT NULL, v TEXT NOT NULL, PRIMARY KEY (k, id)) SHARD KEY (k)" });
    const run = post("/bench", { ...base, op: "jepsen", durationMs: 3000, epochMs: 1000, keysPerEpoch: 6 });
    for (let i = 0; i < 4; i++) {
      await new Promise((r) => setTimeout(r, 500));
      await post("/bench", { ...base, op: "crash", target: `jj-${i % 2}`, durationMs: 0 });
    }
    const { body } = await run;
    const history = body.history as { ops: [string, number][] }[];
    const keys = [...new Set(history.flatMap((t) => t.ops.map((o) => o[1])))];
    const fin = await post("/bench", { ...base, op: "jepsenFinal", keys, durationMs: 0 });
    const r = check(history, { finalReads: fin.body.finalReads });
    console.log("JEPSEN local", JSON.stringify(r.stats), JSON.stringify(body.failures).slice(0, 300));
    if (Object.keys(r.anomalies).length) {
      console.log("ANOMALIES", JSON.stringify(r.anomalies, null, 1).slice(0, 3000));
      const ids = new Set(JSON.stringify(r.anomalies).match(/[0-9a-f]{8}-\d+-\d+/g) ?? []);
      for (const t of history as unknown as { id: string }[]) if (ids.has(t.id)) console.log("TXN", JSON.stringify(t).slice(0, 400));
    }
    expect(r.anomalies).toEqual({});
    expect(r.stats.ok).toBeGreaterThan(50);
  }, 60000);
});
