// Service Binding の入口 (Database) とクライアント (connect) を、本物の workerd の RPC で確かめる。
// 同じ Worker の中の binding と、別の Worker からの binding の両方を通す。
import { readFileSync } from "node:fs";
import { build } from "esbuild";
import { Miniflare } from "miniflare";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
// @ts-expect-error -- JavaScript のモジュール
import { workerBundle } from "../scripts/esbuild-options.mjs";
import { HTTP_LITERALS, JS_VALUES, shownValue } from "./entry-values";

let mf: Miniflare;
let consumerBundle = "";
const call = async (name: string) => {
  const r = await mf.dispatchFetch(`http://x/${name}`);
  return (await r.json()) as Record<string, any>;
};

beforeAll(async () => {
  await build({
    entryPoints: { "fixture-app": "test/fixtures/app.ts", "fixture-consumer": "test/fixtures/consumer.ts" },
    ...workerBundle, outdir: "dist", logLevel: "error",
    external: ["cloudflare:workers", "*.wasm"],
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
        // 利用者のプロジェクトの多くは nodejs_compat を有効にしている。そこでは process があり、
        // sql.js が Node で動いていると誤認すると `__dirname is not defined` で落ちる。
        compatibilityDate: "2026-07-01",
        compatibilityFlags: ["nodejs_compat"],
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

  it("runs a migration batch that rebuilds a table and re-creates its UNIQUE index", async () => {
    const r = await call("migrate");
    expect({ rows: r.rows, journal: r.journal }).toEqual({
      rows: [{ id: 1, email: "a@x", name: "A" }, { id: 2, email: "b@x", name: "" }, { id: 3, email: "c@x", name: "C" }],
      journal: 2,
    });
    expect(r.duplicate).toMatch(/UNIQUE constraint failed/);
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

// docs/design-values.md の「D1 互換の API、Service Binding、HTTP の JSON」と、決めたことの 1 と 2。fixtures/app.ts が、bigint を
// `<数字>n` の文字列にして返す。
describe("64-bit integers and NUL through the binding and HTTP", () => {
  const NUL = "a\u0000b";
  const MAX = "9223372036854775807";
  const MIN = "-9223372036854775808";
  const ABOVE = "9007199254740993";

  it("refuses a wide INTEGER in the result by default, and returns every INTEGER as bigint or string with intMode", async () => {
    const r = await call("wide");
    for (const k of ["plainScan", "plainKey", "plainRaw"]) expect(r[k], k).toMatch(/cannot hold exactly/);
    expect(r.returningPlain).toMatch(/cannot hold exactly/);
    expect(r.tooWide).toMatch(/does not fit in 64 bits/);
    expect(r.badMode).toMatch(/intMode/);
    const { plainScan: _a, plainKey: _b, plainRaw: _c, returningPlain: _d, tooWide: _e, badMode: _f, ...exact } = r;
    expect(exact).toEqual({
      safe: { id: 1, s: NUL },
      bigScan: [
        { id: "1n", n: `${MAX}n`, v: `${MAX}n`, s: NUL },
        { id: "2n", n: `${MIN}n`, v: `${MIN}n`, s: NUL },
        { id: "3n", n: `${ABOVE}n`, v: "4611686018427387905n", s: NUL },
      ],
      bigRaw: [["1n", `${MAX}n`, `${MAX}n`, NUL], ["2n", `${MIN}n`, `${MIN}n`, NUL], ["3n", `${ABOVE}n`, "4611686018427387905n", NUL]],
      strScan: [
        { id: "1", n: MAX, v: MAX, s: NUL },
        { id: "2", n: MIN, v: MIN, s: NUL },
        { id: "3", n: ABOVE, v: "4611686018427387905", s: NUL },
      ],
      session: `${MAX}n`,
      batch: [{ n: `${MIN}n` }],
      inTx: [{ n: `${MIN}n` }],
      afterTx: "4611686018427387905n",
      // RETURNING のない INSERT は成功し、既定の last_row_id は丸めずに 0 (返す rowid がない) になる。
      lastRowPlain: 0,
      lastRowBig: "1152921504606846977n",
      lastRowStr: "1152921504606846978",
      // 安全な範囲の外の整数の値の JS の数は REAL である (決めたことの 2)。INTEGER の列は、型の親和性で整数にする。
      unsafe: { t: "real", x: 2 ** 60 },
      unsafeStored: { tn: "integer", n: "1152921504606846976n", tv: "real", v: 2 ** 60 },
    });
  });

  it("answers HTTP /sql and /batch in the intMode the body names; integer literals in the JSON are read exactly", async () => {
    const r = await call("httpWide");
    expect(r.plain).toMatchObject({ status: 400, error: expect.stringMatching(/cannot hold exactly/) });
    expect(r.batchPlain).toMatchObject({ status: 400, error: expect.stringMatching(/cannot hold exactly/) });
    expect(r.lastRowPlain).toMatchObject({ status: 200, changes: 1, lastInsertRowid: null });
    expect(r.bigint).toMatchObject({ status: 400, error: expect.stringMatching(/JSON cannot carry a bigint/) });
    expect(r.bad).toMatchObject({ status: 400, error: expect.stringMatching(/intMode/) });
    expect(r.str).toMatchObject({
      status: 200, columns: ["id", "n", "s"], changes: 0, lastInsertRowid: null,
      rows: [{ id: "1", n: MAX, s: NUL }, { id: "2", n: MIN, s: NUL }, { id: "3", n: ABOVE, s: NUL }],
    });
    expect(r.num).toMatchObject({ status: 200, rows: [{ id: 1, s: NUL }] });
    // 数字だけの literal で 64 ビットに収まるものは INTEGER、小数点か指数のあるものと、64 ビットに収まらないものは REAL。
    expect(r.literals).toMatchObject({ status: 200, rows: [{ a: "integer", b: MIN, c: "real", d: "real", e: ABOVE, f: "integer" }] });
    expect(r.lastRow).toMatchObject({ status: 200, changes: 1, lastInsertRowid: "1152921504606846981" });
    expect(r.batch).toMatchObject({ status: 200, results: [{ rows: [{ n: MIN }], changes: 0 }, { rows: [{ s: NUL }], changes: 0 }] });
    expect(r.nul).toMatchObject({ status: 200, rows: [{ s: NUL, h: "610062" }] });
  });
});

// 入口の値 (test/entry-values.ts。計画書の未解決の問題 47)。HTTP は JSON の literal の文面で、Service Binding と D1 互換の API は
// JS の値の型で、INTEGER か REAL かを決める。値でないものは、文を実行する前に利用者の誤りとして断る。
describe("argument values at every entry, on workerd", () => {
  // HTTP の結果は intMode "string" の JSON である。INTEGER は 10 進の文字列、REAL は JSON の数。
  const overHttp = (v: unknown) => (typeof v === "bigint" ? String(v) : v);
  const row = (want: { t: string; v: unknown }, key: boolean, show: (v: unknown) => unknown) =>
    key ? { t: want.t, v: show(want.v), tx: want.t, vx: show(want.v) } : { t: want.t, v: show(want.v) };

  it("reads an HTTP JSON number by its text, and a binding or D1 API value by its JS type", async () => {
    const r = await call("entryValues");
    for (const [i, [literal, want]] of HTTP_LITERALS.entries()) {
      const got = r.http[i];
      for (const step of ["select", "batch", "insert", "key"] as const) {
        const label = `HTTP ${literal} ${step}`;
        if ("error" in want) {
          expect.soft(got[step], label).toMatchObject({ status: 400, error: expect.stringMatching(want.error) });
        } else if (step !== "insert") {
          expect.soft(got[step], label).toEqual({ status: 200, row: row(want, step === "key", overHttp) });
        } else expect.soft(got[step].status, label).toBe(200);
      }
    }
    // local は、この Worker の中の D1 互換の API である。数の配列だけ、期待が Service Binding と違う (c.d1)。
    const wantOf = (name: "binding" | "local", c: (typeof JS_VALUES)[number]) => (name === "local" ? c.d1 ?? c.want : c.want);
    for (const name of ["binding", "local"] as const) {
      for (const [i, c] of JS_VALUES.entries()) {
        const got = r[name][i];
        if (got === null) continue;
        const want = wantOf(name, c);
        for (const step of Object.keys(got)) {
          const label = `${name} ${c.label} ${step}`;
          if ("error" in want) {
            expect.soft(got[step], label).toMatchObject({ error: expect.stringMatching(want.error) });
            expect.soft(got[step].name, label).not.toBe("TypeError");
          } else if (step === "insert") expect.soft(got[step], label).toEqual({ row: null });
          else expect.soft(got[step], label).toEqual({ row: row(want, step === "key", shownValue) });
        }
      }
    }
    // 断った値の行は、どの入口でも入っていない。
    const accepted = HTTP_LITERALS.filter(([, w]) => !("error" in w)).length
      + JS_VALUES.filter((c) => c.rpc !== false && !("error" in wantOf("binding", c))).length
      + JS_VALUES.filter((c) => !("error" in wantOf("local", c))).length;
    expect(r.rows).toBe(String(accepted));
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
