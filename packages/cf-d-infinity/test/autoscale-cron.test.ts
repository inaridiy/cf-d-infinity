// Cron Trigger から起こす Autoscaler を、本物の workerd と DO の alarm で確かめる。
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { Miniflare } from "miniflare";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

let mf: Miniflare;
let advisory: Miniflare;
const TICK_MS = 200;

async function post(path: string, body: unknown, token = "test") {
  const r = await mf.dispatchFetch(`http://x${path}`, {
    method: "POST", body: JSON.stringify(body), headers: { authorization: `Bearer ${token}` },
  });
  return { status: r.status, json: (await r.json().catch(() => null)) as any };
}
const cron = async () => (await mf.getWorker()).scheduled({ cron: "* * * * *" });
const status = async () => (await post("/admin/status", {}, "admin-test")).json as {
  shards: string[]; scaler: { events: { kind: string; detail: any }[] };
};
const ticks = async () => (await status()).scaler.events.filter((e) => e.kind === "tick").length;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const worker = (vars: Record<string, string>) => new Miniflare({
    modules: [
      { type: "ESModule", path: "dist/worker.js", contents: readFileSync("dist/worker.js", "utf8") },
      { type: "CompiledWasm", path: "dist/sql-wasm.wasm", contents: readFileSync("src/sql-wasm.wasm") },
    ],
    compatibilityDate: "2026-07-01",
    bindings: {
      DINF_SHARD_COUNT: "2", DINF_API_TOKEN: "test", DINF_ADMIN_TOKEN: "admin-test",
      DINF_AUTOSCALE_TICK_MS: String(TICK_MS),
      DINF_AUTOSCALE_THRESHOLDS: JSON.stringify({ writesPerSec: 20, sustainTicks: 2 }),
      ...vars,
    },
    durableObjects: {
      DINF_SHARD: { className: "DinfShard", useSQLite: true },
      DINF_META: { className: "DinfMeta", useSQLite: true },
      DINF_AUTOSCALER: { className: "DinfAutoscaler", useSQLite: true },
    },
  });

const on = (target: Miniflare) => ({
  post: async (path: string, body: unknown, token = "test") => {
    const r = await target.dispatchFetch(`http://x${path}`, { method: "POST", body: JSON.stringify(body), headers: { authorization: `Bearer ${token}` } });
    return { status: r.status, json: (await r.json().catch(() => null)) as any };
  },
  cron: async () => (await target.getWorker()).scheduled({ cron: "* * * * *" }),
});

beforeAll(async () => {
  execFileSync("npm", ["run", "-s", "bundle"], { stdio: "inherit" });
  // 実際に割るのは、明示的に有効にしたときだけである。
  mf = worker({ DINF_AUTOSCALE: "split" });
  advisory = worker({});
  for (const target of [mf, advisory]) await on(target).post("/ddl", { sql: `CREATE TABLE t(id INTEGER PRIMARY KEY, n INTEGER NOT NULL)` });
}, 60000);
afterAll(async () => {
  await mf?.dispose();
  await advisory?.dispose();
});

describe("autoscaler driven by a Cron Trigger", () => {
  it("has no HTTP endpoint that starts or stops it in the production build", async () => {
    expect((await post("/admin/autoscale/start", { shards: 2 }, "admin-test")).status).toBe(400);
    expect((await post("/admin/autoscale/stop", {}, "admin-test")).status).toBe(400);
  });

  it("probes an idle cluster once per cron and sets no alarm", async () => {
    await cron();
    expect(await ticks()).toBe(1);
    await sleep(TICK_MS * 4);
    expect(await ticks()).toBe(1);
  });

  it("follows a loaded cluster with alarms, splits it, and goes quiet when the load stops", async () => {
    let next = 1;
    let written = 0;
    let loading = true;
    const writer = async () => {
      while (loading) {
        const r = await post("/sql", { sql: "INSERT INTO t(id, n) VALUES (?, 0)", params: [next++] });
        if (r.status === 200) written++;
      }
    };
    const writers = Array.from({ length: 16 }, writer);
    await sleep(600);

    // この 1 回の Cron だけで、後は alarm が判断を続ける。ここまでに Cron を呼んだのは、前のテストと合わせて 2 回である。
    await cron();
    const crons = 2;
    let done = 0;
    for (let i = 0; i < 100 && done === 0; i++) {
      await sleep(200);
      done = (await status()).scaler.events.filter((e) => e.kind === "split-done").length;
    }
    loading = false;
    await Promise.all(writers);
    expect(done).toBeGreaterThan(0);
    // 増設には閾値を 2 回続けて超える必要がある。2 回目以降の判断は Cron ではなく alarm が行ったものである。
    expect(await ticks()).toBeGreaterThan(crons);
    expect((await status()).shards.length).toBeGreaterThan(2);

    // 負荷が止まると、進行中の増設が終わった後に alarm も止まる。
    let last = -1;
    for (let i = 0; i < 100; i++) {
      const now = await ticks();
      if (now === last) break;
      last = now;
      await sleep(TICK_MS * 5);
    }
    await sleep(TICK_MS * 5);
    expect(await ticks()).toBe(last);
    const st = await status();
    expect(st.scaler.events.filter((e) => e.kind === "split-failed")).toEqual([]);

    // 増設を挟んでも書き込みは失われない。
    const count = await post("/sql", { sql: "SELECT count(*) AS c FROM t", params: [] });
    expect(count.json.rows).toEqual([{ c: written }]);
  }, 60000);
});

describe("autoscaler without DINF_AUTOSCALE=split (the default)", () => {
  it("records that a shard should be split, and does not split it", async () => {
    const a = on(advisory);
    const events = async () => ((await a.post("/admin/status", {}, "admin-test")).json as { shards: string[]; scaler: { events: { kind: string; detail: any }[] } });
    await a.cron();
    let loading = true;
    let next = 1;
    const writers = Array.from({ length: 16 }, async () => {
      while (loading) await a.post("/sql", { sql: "INSERT INTO t(id, n) VALUES (?, 0)", params: [next++] });
    });
    await sleep(600);
    await a.cron();
    let advised = 0;
    for (let i = 0; i < 50 && advised === 0; i++) {
      await sleep(200);
      advised = (await events()).scaler.events.filter((e) => e.kind === "would-split").length;
    }
    loading = false;
    await Promise.all(writers);
    const st = await events();
    expect(advised).toBeGreaterThan(0);
    expect(st.scaler.events.find((e) => e.kind === "would-split")!.detail.reason).toMatch(/writes \d+\/s/);
    expect(st.scaler.events.filter((e) => e.kind.startsWith("split"))).toEqual([]);
    expect(st.shards).toHaveLength(2);
  }, 60000);
});
