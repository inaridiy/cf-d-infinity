// Hrana の引数の値と型の印 (計画書の未解決の問題 51、不変条件 11)。
//
// Hrana の引数は型を書いた値 ({ type, value } か { type: "blob", base64 }) である。2026-11-16 まで、src/client/hrana.ts の fromH は
// type で枝を選ぶだけで、value の JS の型を確かめなかった。`float` の文字列は TEXT に、`text` の数は REAL に、`float` の配列は BLOB
// になり、`float` の object は SQLite のドライバの束縛の誤り (`Wrong API use`) に、`blob` の数か欠けた base64 は fromBase64 の中の
// TypeError (`s.padEnd is not a function`) になり、知らない type は undefined のまま束縛へ進んで文が実行された。`integer` の JS の数は、
// 正規表現が文字列に直して通した。
// 今は、どれも、文を実行する前に、引数の番号 (名前つきなら名前) を書いた利用者の誤りとして断る。誤りの code は、sqld が引数の誤りに
// 使う ARGS_INVALID である。要求ごとの誤りとして返すので、同じ pipeline のほかの要求と、取引 (baton) は続く。
// sqld は、型の印と値が合わない本文を JSON として読めず、pipeline の全体を HTTP 400 で断る (Hrana の仕様は code を決めていない)。
import { describe, expect, it } from "vitest";
import { Db } from "../src/client/db";
import { handlePipeline, type PipelineReq } from "../src/client/hrana";
import { SimCluster } from "./sim";

type HResult = {
  type: string;
  response?: { type: string; result: { rows: { type: string; value?: unknown; base64?: string }[][]; step_errors?: ({ code: string } | null)[] } };
  error?: { message: string; code: string };
};

const pipeline = async (c: SimCluster, requests: unknown[], baton: string | null = null) =>
  (await handlePipeline({ baton, requests } as PipelineReq, async (token) => new Db(c, { token }))) as { baton: string | null; results: HResult[] };

const outcome = (r: HResult) => (r.type === "ok" ? { row: r.response!.result.rows[0] } : { error: r.error!.message, code: r.error!.code });

const execute = async (c: SimCluster, sql: string, stmt: { args?: unknown; named_args?: unknown }) =>
  outcome((await pipeline(c, [{ type: "execute", stmt: { sql, ...stmt } }])).results[0]!);

const SELECT = "SELECT typeof(?1) AS t, ?1 AS v";

/** 型の印と値が合わない引数。どれも 1 番目の引数として渡す。 */
const MISMATCHED: unknown[] = [
  { type: "float", value: "abc" },
  { type: "float", value: [65, 66] },
  { type: "float", value: { a: 1 } },
  { type: "float", value: null },
  { type: "float" },
  { type: "text", value: 5 },
  { type: "text", value: [65, 66] },
  { type: "text", value: null },
  { type: "text" },
  { type: "blob", base64: 5 },
  { type: "blob", base64: [65, 66] },
  { type: "blob" },
  { type: "blob", base64: "!!!!" },
  { type: "blob", base64: "QUJD=" },
  { type: "blob", base64: "A" },
  { type: "blob", base64: "=" },
  { type: "blob", base64: "QQ=" },
  { type: "blob", base64: "QUI==" },
  { type: "blob", base64: "QU=I" },
  { type: "blob", base64: "QUI-" },
  { type: "integer", value: 5 },
  { type: "integer", value: "abc" },
  { type: "integer", value: "5.0" },
  { type: "integer", value: "" },
  { type: "integer", value: null },
  { type: "integer" },
  { type: "integer", value: "9223372036854775808" },
  { type: "integer", value: "-9223372036854775809" },
  { type: "bogus", value: 1 },
  { type: 5 },
  {},
  null,
  5,
  "x",
  [1],
];

/** 認めて受け付ける引数と、結果の行 (型の名前と、Hrana の値)。 */
const ACCEPTED: [unknown, { type: string; value?: unknown; base64?: string }[]][] = [
  [{ type: "null" }, [{ type: "text", value: "null" }, { type: "null" }]],
  [{ type: "integer", value: "5" }, [{ type: "text", value: "integer" }, { type: "integer", value: "5" }]],
  [{ type: "integer", value: "-9223372036854775808" }, [{ type: "text", value: "integer" }, { type: "integer", value: "-9223372036854775808" }]],
  [{ type: "float", value: 5 }, [{ type: "text", value: "real" }, { type: "float", value: 5 }]],
  [{ type: "float", value: 0.5 }, [{ type: "text", value: "real" }, { type: "float", value: 0.5 }]],
  [{ type: "text", value: "x" }, [{ type: "text", value: "text" }, { type: "text", value: "x" }]],
  [{ type: "blob", base64: "QUI=" }, [{ type: "text", value: "blob" }, { type: "blob", base64: "QUI=" }]],
  // @libsql/client (js-base64) は埋め草を付けるが、付けない base64 も受け付ける (前から)。
  [{ type: "blob", base64: "QUI" }, [{ type: "text", value: "blob" }, { type: "blob", base64: "QUI=" }]],
  [{ type: "blob", base64: "" }, [{ type: "text", value: "blob" }, { type: "blob", base64: "" }]],
  [{ type: "blob", base64: "QQ==" }, [{ type: "text", value: "blob" }, { type: "blob", base64: "QQ==" }]],
  [{ type: "blob", base64: "QQ" }, [{ type: "text", value: "blob" }, { type: "blob", base64: "QQ==" }]],
  [{ type: "blob", base64: "+/8=" }, [{ type: "text", value: "blob" }, { type: "blob", base64: "+/8=" }]],
];

/** 内部の関数の誤り (TypeError など) の文面。利用者に見せる誤りに、これが混じってはならない。 */
const INTERNAL = /is not a function|Cannot read|undefined|Wrong API use/;

describe("Hrana arguments whose value does not match their type", () => {
  it("are refused before the statement runs, as ARGS_INVALID that names the argument", async () => {
    const c = new SimCluster({ shards: 2 });
    for (const arg of MISMATCHED) {
      const got = await execute(c, SELECT, { args: [arg] });
      expect.soft(got, JSON.stringify(arg)).toMatchObject({ error: expect.stringMatching(/^argument 1\b/), code: "ARGS_INVALID" });
      expect.soft(got, JSON.stringify(arg)).not.toMatchObject({ error: expect.stringMatching(INTERNAL) });
    }
  });

  it("are refused by name when they are named, and by number when positional arguments come with named ones", async () => {
    const c = new SimCluster({ shards: 2 });
    expect(await execute(c, "SELECT typeof(:a) AS t", { named_args: [{ name: ":a", value: { type: "float", value: "x" } }] }))
      .toMatchObject({ error: expect.stringMatching(/^argument :a\b/), code: "ARGS_INVALID" });
    expect(await execute(c, "SELECT typeof(?1) AS t, typeof(:a) AS u", { args: [{ type: "text", value: 5 }], named_args: [{ name: ":a", value: { type: "null" } }] }))
      .toMatchObject({ error: expect.stringMatching(/^argument 1\b/), code: "ARGS_INVALID" });
    expect(await execute(c, "SELECT typeof(:a) AS t", { named_args: [{ name: ":a", value: { type: "float", value: 5 } }] }))
      .toEqual({ row: [{ type: "text", value: "real" }] });
  });

  it("are refused when the argument lists themselves are malformed", async () => {
    const c = new SimCluster({ shards: 1 });
    for (const stmt of [{ args: 5 }, { args: { type: "null" } }, { named_args: 5 }, { named_args: [null] }, { named_args: [{ name: 5, value: { type: "null" } }] }, { named_args: [{ name: ":a" }] }]) {
      const got = await execute(c, "SELECT 1 AS one", stmt);
      expect.soft(got, JSON.stringify(stmt)).toMatchObject({ error: expect.stringMatching(/argument/), code: "ARGS_INVALID" });
      expect.soft(got, JSON.stringify(stmt)).not.toMatchObject({ error: expect.stringMatching(INTERNAL) });
    }
  });

  it("still bind a value that matches its type, as before", async () => {
    const c = new SimCluster({ shards: 2 });
    for (const [arg, row] of ACCEPTED) expect.soft(await execute(c, SELECT, { args: [arg] }), JSON.stringify(arg)).toEqual({ row });
  });

  it("check the base64 of a blob as large as a request may carry, without running out of stack", async () => {
    // HTTP の本文は 8 MB まで (src/entry.ts の ENTRY_LIMITS.bodyChars)。base64 の正規表現は、繰り返しで数 MB の文字列のスタックを使い切った。
    const c = new SimCluster({ shards: 2 });
    const n = 5_500_000;
    const base64 = Buffer.alloc(n, 0xab).toString("base64");
    expect(await execute(c, "SELECT length(?1) AS n", { args: [{ type: "blob", base64 }] })).toEqual({ row: [{ type: "integer", value: String(n) }] });
    expect(await execute(c, "SELECT length(?1) AS n", { args: [{ type: "blob", base64: `${base64.slice(0, -4)}!!!!` }] }))
      .toMatchObject({ error: expect.stringMatching(/^argument 1 is a blob whose "base64" is not base64/), code: "ARGS_INVALID" });
  });

  it("write nothing, and leave the rest of the pipeline and its transaction running", async () => {
    const c = new SimCluster({ shards: 2 });
    await c.client().query("CREATE TABLE hv(id INTEGER PRIMARY KEY, x)");
    const insert = (id: number, x: unknown) => ({ type: "execute", stmt: { sql: "INSERT INTO hv(id, x) VALUES (?1, ?2)", args: [{ type: "integer", value: String(id) }, x] } });
    // autocommit の文と batch の段。断った段の後の段は、条件がなければ実行される。
    const first = await pipeline(c, [
      insert(1, { type: "float", value: "1" }),
      { type: "batch", batch: { steps: [{ stmt: insert(2, { type: "blob", base64: 2 }).stmt }, { stmt: insert(3, { type: "text", value: "ok" }).stmt }] } },
    ]);
    expect(outcome(first.results[0]!)).toMatchObject({ code: "ARGS_INVALID" });
    expect(first.results[1]!.response!.result.step_errors).toEqual([expect.objectContaining({ code: "ARGS_INVALID" }), null]);
    // 取引の中で断っても、取引は続き、COMMIT できる。
    const opened = await pipeline(c, [{ type: "execute", stmt: { sql: "BEGIN" } }, insert(4, { type: "bogus" }), insert(5, { type: "text", value: "in tx" })]);
    expect(opened.results.map((r) => r.type)).toEqual(["ok", "error", "ok"]);
    const committed = await pipeline(c, [{ type: "execute", stmt: { sql: "COMMIT" } }], opened.baton);
    expect(committed.results.map((r) => r.type)).toEqual(["ok"]);
    expect((await c.client().query("SELECT id, x FROM hv ORDER BY id")).values).toEqual([[3n, "ok"], [5n, "in tx"]]);
  });
});
