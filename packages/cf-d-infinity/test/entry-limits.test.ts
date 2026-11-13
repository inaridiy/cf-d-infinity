// 入口の上限 (src/entry.ts。README の Limitations の「Request limits」)。2026-11-13 の README の確認 (指摘 R9) で、上限の多くに
// 試験がないと分かった。ここでは、シミュレータで確かめられるものを確かめる。HTTP の 1,001 文と WebSocket の上限は
// test/workerd.test.ts が本物の workerd で確かめる。
import { describe, expect, it } from "vitest";
import { Db } from "../src/client/db";
import { handlePipeline, type PipelineReq } from "../src/client/hrana";
import { BadRequest, ENTRY_LIMITS, checkCount, checkSql, readJson, sameToken } from "../src/entry";
import { SimCluster } from "./sim";

const pipeline = async (c: SimCluster, requests: unknown[], baton: string | null = null) =>
  handlePipeline({ baton, requests } as PipelineReq, async (token) => new Db(c, { token })) as Promise<{
    baton: string | null; results: { type: string; error?: { message: string } }[];
  }>;

describe("entry limits", () => {
  it("refuses a body over the limit with 413 and malformed JSON with 400", async () => {
    const big = new Request("http://x/", { method: "POST", body: "x".repeat(ENTRY_LIMITS.bodyChars + 1) });
    await expect(readJson(big)).rejects.toMatchObject({ status: 413 });
    const declared = new Request("http://x/", { method: "POST", body: "{}", headers: { "content-length": String(ENTRY_LIMITS.bodyChars + 1) } });
    await expect(readJson(declared)).rejects.toMatchObject({ status: 413 });
    await expect(readJson(new Request("http://x/", { method: "POST", body: "{" }))).rejects.toMatchObject({ status: 400 });
    expect(await readJson(new Request("http://x/", { method: "POST", body: '{"a":1}' }))).toEqual({ a: 1 });
  });

  it("counts statements and measures statement text", () => {
    expect(() => checkCount(ENTRY_LIMITS.statements, "x")).not.toThrow();
    expect(() => checkCount(ENTRY_LIMITS.statements + 1, "x")).toThrow(BadRequest);
    expect(() => checkSql("x".repeat(ENTRY_LIMITS.sqlChars))).not.toThrow();
    expect(() => checkSql("x".repeat(ENTRY_LIMITS.sqlChars + 1))).toThrow(/longer than/);
    expect(() => checkSql(5)).toThrow(/must be a string/);
    expect(sameToken("abc", "abc")).toBe(true);
    expect(sameToken("abc", "abd")).toBe(false);
    expect(sameToken("abc", "abcd")).toBe(false);
  });

  it("fails an over-long statement, a too-long batch and the stored statement past the limit on their own, in a pipeline", async () => {
    const c = new SimCluster({ shards: 1 });
    await new Db(c).ddl("CREATE TABLE t(id INTEGER PRIMARY KEY)");
    const long = `SELECT 1 /*${"x".repeat(ENTRY_LIMITS.sqlChars)}*/`;
    const steps = Array.from({ length: ENTRY_LIMITS.statements + 1 }, () => ({ stmt: { sql: "SELECT 1" } }));
    const r = await pipeline(c, [
      { type: "execute", stmt: { sql: "INSERT INTO t VALUES (1)" } },
      { type: "execute", stmt: { sql: long } },
      { type: "batch", batch: { steps } },
      { type: "execute", stmt: { sql: "SELECT count(*) FROM t" } },
    ]);
    expect(r.results.map((x) => x.type)).toEqual(["ok", "error", "error", "ok"]);
    expect(r.results[1]!.error!.message).toMatch(/longer than/);
    expect(r.results[2]!.error!.message).toMatch(/batch steps/);

    const store = Array.from({ length: ENTRY_LIMITS.storedSql + 1 }, (_v, i) => ({ type: "store_sql", sql_id: i + 1, sql: "SELECT 1" }));
    const s = await pipeline(c, store);
    expect(s.results.slice(0, -1).every((x) => x.type === "ok")).toBe(true);
    expect(s.results.at(-1)!.error!.message).toMatch(/stored statements/);
  });
});
