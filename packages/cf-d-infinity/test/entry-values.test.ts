// 入口の値 (計画書の未解決の問題 47、不変条件 11)。場面と期待は test/entry-values.ts にあり、本物の workerd では
// test/binding.test.ts が同じ場面を流す。ここではシミュレータで、HTTP の本文の読み方 (src/entry.ts。src/worker.ts の handle が使う) と
// D1 互換の API (src/client/d1.ts。Service Binding の DinfDatabase も同じ toValue を使う) を確かめる。
// 答えるのが Worker の SQLite でもシャードでも同じになることを見るため、表を読まない文と、主キーで 1 行を読み書きする文の両方を
// 1 と 2 のシャードで流す。
import { describe, expect, it } from "vitest";
import { D1Compatible } from "../src/client/d1";
import { Db } from "../src/client/db";
import { jsonParams, numberLiterals, readJson } from "../src/entry";
import type { Value } from "../src/types";
import { BY_KEY, HTTP_LITERALS, INSERT, JS_VALUES, SELECT, TABLE, type Want } from "./entry-values";
import { SimCluster } from "./sim";

/** 結果か、誤りの文面と種類。 */
const outcome = async (f: () => Promise<Record<string, unknown> | null>) => {
  try {
    return { row: await f() };
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e), name: e instanceof Error ? e.name : typeof e };
  }
};

/** 場面の全部を見るため、expect.soft で比べる (1 つ目の違いで止めない)。 */
function check(label: string, got: Awaited<ReturnType<typeof outcome>>, want: Want, key = false): void {
  if ("error" in want) {
    // 利用者の誤りである。内部の関数の TypeError (`x.toString is not a function` など) ではない。
    expect.soft(got, label).toMatchObject({ error: expect.stringMatching(want.error), name: expect.not.stringMatching(/^TypeError$/) });
    return;
  }
  expect.soft(got, label).toEqual({ row: key ? { t: want.t, v: want.v, tx: want.t, vx: want.v } : { t: want.t, v: want.v } });
}

/** HTTP の /sql と同じ読み方 (src/worker.ts の handle)。本文は文面のまま渡す。 */
async function httpQuery(db: Db, sql: string, params: string) {
  const body = (await readJson(new Request("http://x/", { method: "POST", body: `{"sql":${JSON.stringify(sql)},"params":${params}}` }), numberLiterals)) as { params?: unknown };
  return db.query(sql, jsonParams(body.params));
}

const rowOf = (r: { columns: string[]; values: Value[][] }) => (r.values[0] ? Object.fromEntries(r.columns.map((c, i) => [c, r.values[0]![i]])) : null);
const accepted = (cases: Want[]) => BigInt(cases.filter((w) => !("error" in w)).length);

describe("HTTP /sql reads a JSON number by its text", () => {
  for (const shards of [1, 2]) {
    it(`gives each literal the type its text names, without a table and by primary key, on ${shards} shards`, async () => {
      const db = new Db(new SimCluster({ shards }));
      await db.ddl(TABLE);
      for (const [i, [literal, want]] of HTTP_LITERALS.entries()) {
        check(`${literal} in SELECT`, await outcome(async () => rowOf(await httpQuery(db, SELECT, `[${literal}]`))), want);
        const inserted = await outcome(async () => rowOf(await httpQuery(db, INSERT, `[${i}, ${literal}]`)));
        if ("error" in want) check(`${literal} in INSERT`, inserted, want);
        check(`${literal} by key`, await outcome(async () => rowOf(await httpQuery(db, BY_KEY, `[${i}, ${literal}]`))), want, true);
      }
      // 断った値の行は入っていない。
      expect(rowOf(await db.query("SELECT count(*) AS c FROM ev", []))).toEqual({ c: accepted(HTTP_LITERALS.map(([, w]) => w)) });
      // NULL は主キーに置けないので、表を読まない文だけで見る。
      check("null in SELECT", await outcome(async () => rowOf(await httpQuery(db, SELECT, "[null]"))), { t: "null", v: null });
    });
  }

  it("refuses params that are not an array, before the statement runs", async () => {
    const db = new Db(new SimCluster({ shards: 1 }));
    await expect(httpQuery(db, "SELECT ?", `{"a":1}`)).rejects.toMatchObject({ status: 400, message: expect.stringMatching(/params must be an array/) });
    await expect(httpQuery(db, "SELECT ?", `5`)).rejects.toMatchObject({ status: 400 });
  });

  it("leaves numbers outside params as JS numbers, so the body's token stays a number", async () => {
    const read = async (body: string) => (await readJson(new Request("http://x/", { method: "POST", body }), numberLiterals)) as Record<string, unknown>;
    const body = await read(`{"token":5.0,"intMode":"string","params":[1.0]}`);
    expect(body.token).toBe(5);
    expect(jsonParams(body.params)).toEqual([1]);
    expect(typeof (await read(`{"token":9007199254740993,"params":[]}`)).token).toBe("number");
  });

  it("falls back to the D1 rule when the runtime gives the reviver no source text", () => {
    // context.source を渡さない実行環境 (JSON.parse の source text access のない V8)。数は JS の数のまま届くので、D1 互換の API と
    // 同じく、安全な整数なら INTEGER、ほかは REAL になる。
    const read = (v: number, context?: { source: string }) => jsonParams([numberLiterals.call([], "0", v, context)]);
    expect(read(5)).toEqual([5n]);
    expect(read(1e5)).toEqual([100000n]);
    expect(read(0.5)).toEqual([0.5]);
    expect(read(1e20)).toEqual([1e20]);
    // 文面があれば、文面で決める。
    expect(read(5, { source: "5.0" })).toEqual([5]);
    expect(read(5, { source: "5" })).toEqual([5n]);
  });
});

describe("the D1 compatible API reads a JS value by its JS type", () => {
  for (const shards of [1, 2]) {
    it(`gives each value the type the D1 rule names, without a table, by primary key and in a batch, on ${shards} shards`, async () => {
      const d1 = new D1Compatible(new Db(new SimCluster({ shards })), { intMode: "bigint" });
      await d1.prepare(TABLE).run();
      for (const [i, { label, value, want }] of JS_VALUES.entries()) {
        check(`${label} in SELECT`, await outcome(async () => d1.prepare(SELECT).bind(value()).first()), want);
        const inserted = await outcome(async () => (await d1.prepare(INSERT).bind(i, value()).run(), null));
        if ("error" in want) check(`${label} in INSERT`, inserted, want);
        check(`${label} by key`, await outcome(async () => d1.prepare(BY_KEY).bind(i, value()).first()), want, true);
        check(`${label} in batch`, await outcome(async () => (await d1.batch([d1.prepare(SELECT).bind(value())]))[0]!.results[0] as Record<string, unknown>), want);
      }
      expect(await d1.prepare("SELECT count(*) AS c FROM ev").first("c")).toBe(accepted(JS_VALUES.map((c) => c.want)));
      for (const empty of [null, undefined]) check(`${empty} in SELECT`, await outcome(async () => d1.prepare(SELECT).bind(empty).first()), { t: "null", v: null });
    });
  }
});
