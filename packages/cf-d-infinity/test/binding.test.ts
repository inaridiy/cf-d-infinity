// Service Binding の入口 (Database) とクライアント (connect) を、本物の workerd の RPC で確かめる。
// 同じ Worker の中の binding と、別の Worker からの binding の両方を通す。
import { readFileSync } from "node:fs";
import { build } from "esbuild";
import { Miniflare } from "miniflare";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

let mf: Miniflare;
let consumerBundle = "";
const call = async (name: string) => {
  const r = await mf.dispatchFetch(`http://x/${name}`);
  return (await r.json()) as Record<string, any>;
};

beforeAll(async () => {
  await build({
    entryPoints: { "fixture-app": "test/fixtures/app.ts", "fixture-consumer": "test/fixtures/consumer.ts" },
    bundle: true, format: "esm", platform: "browser", outdir: "dist", logLevel: "error",
    external: ["cloudflare:workers", "*.wasm"],
    alias: { fs: "./src/empty.js", path: "./src/empty.js", crypto: "./src/empty.js" },
  });
  consumerBundle = readFileSync("dist/fixture-consumer.js", "utf8");
  const database = { name: "app", entrypoint: "DinfDatabase" };
  mf = new Miniflare({
    workers: [
      {
        name: "app",
        modules: [
          { type: "ESModule", path: "dist/fixture-app.js", contents: readFileSync("dist/fixture-app.js", "utf8") },
          { type: "CompiledWasm", path: "dist/sql-wasm.wasm", contents: readFileSync("src/sql-wasm.wasm") },
        ],
        compatibilityDate: "2026-07-01",
        bindings: { DINF_SHARD_COUNT: "4", DINF_API_TOKEN: "data-token" },
        durableObjects: {
          DINF_SHARD: { className: "DinfShard", useSQLite: true },
          DINF_META: { className: "DinfMeta", useSQLite: true },
          DINF_AUTOSCALER: { className: "DinfAutoscaler", useSQLite: true },
        },
        serviceBindings: { DINF_DB: database },
      },
      {
        name: "consumer",
        modules: [{ type: "ESModule", path: "dist/fixture-consumer.js", contents: consumerBundle }],
        compatibilityDate: "2026-07-01",
        serviceBindings: { DINF_DB: database },
      },
    ],
  });
}, 60000);
afterAll(() => mf?.dispose());

describe("the Database binding inside the same Worker", () => {
  it("speaks the D1 API without a token", async () => {
    expect(await call("d1")).toEqual({
      batch: [1, 1, 1],
      column: 100,
      row: { id: 2, balance: 100 },
      missing: null,
      all: [{ id: 1, balance: 100 }, { id: 2, balance: 100 }, { id: 3, balance: 100 }],
      raw: [[1, 100], [2, 100], [3, 100]],
      rawNames: ["id", "balance"],
      changes: 2,
    });
  });

  it("runs interactive transactions across shards: commit, rollback, and a helper that rolls back on throw", async () => {
    expect(await call("tx")).toEqual({
      read: [{ balance: 100 }],
      thrown: "changed my mind",
      helper: 1,
      all: [{ id: 1, balance: 70 }, { id: 2, balance: 130 }, { id: 3, balance: 101 }],
      total: 301,
    });
  });

  it("discards a transaction the caller left open; its row locks expire with the TTL", async () => {
    expect(await call("abandon")).toEqual({ left: "open" });
    const after = await call("afterAbandon");
    expect(after.balance).toBe(70);
    expect(after.ms).toBeLessThan(8000);
  }, 15000);

  it("rolls back at once when the transaction is disposed, as `await using` does", async () => {
    const r = await call("scoped");
    expect(r.balance).toBe(130);
    expect(r.ms).toBeLessThan(2000);
  });

  it("fails an optimistic transaction at commit when a row it read has changed", async () => {
    const r = await call("conflict");
    expect(r.error).toMatch(/SQLITE_BUSY|conflict/i);
    expect(r.total).toBe(301);
  });

  it("is accepted by Drizzle's D1 driver, including batch", async () => {
    expect(await call("drizzle")).toEqual({
      before: [{ id: 2, balance: 130 }],
      after: [{ id: 1, balance: 70 }, { id: 2, balance: 130 }, { id: 3, balance: 101 }],
    });
  });

  it("carries the HLC token as a D1 session bookmark", async () => {
    expect(await call("session")).toEqual({ zero: "0", advanced: true, carried: true, read: 70 });
  });
});

describe("the binding's fetch", () => {
  it("reaches the HTTP endpoint, which still checks the token", async () => {
    expect(await call("http")).toEqual({ none: 401, wrong: 401, ok: 200, rows: [{ n: 3 }] });
  });
});

describe("the Database binding from another Worker", () => {
  it("works with only the client in the consumer's bundle", async () => {
    const consumer = await mf.getWorker("consumer");
    const r = await consumer.fetch("http://x/");
    expect(await r.json()).toEqual([{ id: 1, body: "a!" }, { id: 2, body: "b?" }]);
    expect(consumerBundle).not.toMatch(/ShardCore|sql-wasm|sql-parser-cst/);
    expect(consumerBundle.length).toBeLessThan(10_000);
  });
});
