// 内部で使う列の名前を、利用者の列に使わせない (計画書の不変条件 5、2026-11-13 の Codex の指摘 C2、C3)。
//
// 型のない列の型を読むために走査が足す別名 `__dinf_typeof_<i>` は、同じ名前の利用者の列を上書きした (C3)。名前の接頭辞を 1 つの
// 一覧 (src/sql/ddl.ts の INTERNAL_COLUMN_PREFIXES) にまとめ、DDL がその名前の列を断る。ここでは、実際に使っている別名が一覧に
// 当たること、その名前の列を CREATE TABLE と ADD COLUMN が断ることを確かめる。
//
// 以前は `$` で始まる列名も断っていた。行イメージが列名つきの JSON で、BLOB と無限大の値を `{"$b": 16 進}`、`{"$f": "Infinity"}` の
// 印にしていたので、列名が `$b` か `$f` の行は、行そのものが印に見え、確定した INSERT が消えた (C2)。値の作り直しの段 2 で、
// 行イメージは列名を持たないタプルになったので、予約を外した。そういう列が、取引、シャードをまたぐ確定、分割を通って使えることを
// 確かめる。
import { describe, expect, it } from "vitest";
import { split } from "../src/autoscaler";
import { Db } from "../src/client/db";
import { handlePipeline, type PipelineReq } from "../src/client/hrana";
import { encode, typedScanList } from "../src/shard/rows";
import { INTERNAL_COLUMN_PREFIXES, isInternalColumn } from "../src/sql/ddl";
import type { TableDef } from "../src/types";
import { encodeTuple } from "../src/value";
import { SimCluster } from "./sim";

/** JSON の中の object のキーを全部集める。 */
function keysIn(json: string): string[] {
  const out: string[] = [];
  JSON.parse(json, function (k) {
    if (k !== "" && !Array.isArray(this)) out.push(k);
    return (this as Record<string, unknown>)[k];
  });
  return out;
}

describe("internal column names", () => {
  it("covers every alias the scans add, and the row images carry no column names", () => {
    // 行イメージはタプルなので、列名も印も入らない。BLOB と無限大の値も、要素の文字列になる。
    const after = encodeTuple([1n, new Uint8Array([1, 2]), Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]);
    expect(keysIn(encode({ table: "t", pk: "[1]", sk: "[1]", before: null, after }))).toEqual(["table", "pk", "sk", "before", "after"]);
    const def = { name: "t", columns: ["id", "u", "w"], pk: ["id"], implicitRowid: false, affinity: { id: "INTEGER" } } as unknown as TableDef;
    const aliases = [...typedScanList(def).matchAll(/AS "([^"]+)"/g)].map((m) => m[1]!);
    expect(aliases.length).toBe(2); // 型のない列 2 つの型を読む列
    for (const a of aliases) expect(isInternalColumn(a), a).toBe(true);
  });

  it("refuses such a column in CREATE TABLE and ADD COLUMN, with unsupported:", async () => {
    const db = new Db(new SimCluster({ shards: 2 }));
    for (const name of ["__dinf_typeof_0", "__DINF_x"]) {
      await expect(db.ddl(`CREATE TABLE t(id INTEGER PRIMARY KEY, "${name}" TEXT)`)).rejects.toThrow(/^unsupported: column name/);
    }
    await db.ddl("CREATE TABLE t(id INTEGER PRIMARY KEY, v TEXT)");
    await expect(db.ddl(`ALTER TABLE t ADD COLUMN "__dinf_typeof_0" TEXT`)).rejects.toThrow(/^unsupported: column name/);
    expect(INTERNAL_COLUMN_PREFIXES).not.toContain("$");
  });

  it("keeps columns whose names only contain the prefixes", async () => {
    const db = new Db(new SimCluster({ shards: 2 }));
    await db.ddl(`CREATE TABLE t(id INTEGER PRIMARY KEY, "a$f" TEXT, "x__dinf_" TEXT, real INTEGER)`);
    await db.transaction(async (tx) => {
      for (let i = 1; i <= 4; i++) await tx.query(`INSERT INTO t VALUES (?, 'x', 'y', ?)`, [i, i]);
    });
    expect((await db.query(`SELECT count(*) AS n, sum(real) AS s FROM t WHERE "a$f" = 'x'`)).rows).toEqual([{ n: 4, s: 10 }]);
  });

  it("uses columns named like the old markers ($b, $f) through transactions, a cross-shard commit and a split", async () => {
    const c = new SimCluster({ shards: 2 });
    const db = c.client();
    // 型のない列にすると、BLOB と無限大の値がそのまま入る。以前の行イメージでは、`{"$b": "0102"}` の形の行が BLOB の印に見えた。
    await db.ddl(`CREATE TABLE m(id INTEGER PRIMARY KEY, "$b", "$f", "$x" TEXT)`);
    await db.ddl(`ALTER TABLE m ADD COLUMN "$i" INTEGER`);
    const rows = Array.from({ length: 8 }, (_, i) => [i + 1, `0${i}`, i % 2 ? Number.POSITIVE_INFINITY : i, `x${i}`, i]);
    // 1 つの取引で 8 行を書く。行は 2 つのシャードに分かれるので、確定は 2 相で、行イメージは intent と変更ログを通る。
    await db.transaction(async (tx) => {
      for (const r of rows) await tx.query(`INSERT INTO m VALUES (?, ?, ?, ?, ?)`, r);
    });
    await db.query(`UPDATE m SET "$b" = x'0102' WHERE id = 2`);
    await db.query(`UPDATE m SET "$x" = "$x" || '!' WHERE "$i" >= 6`);
    const want = rows.map(([id, b, f, x, n]) => ({
      id, $b: id === 2 ? new Uint8Array([1, 2]) : b, $f: f, $x: (n as number) >= 6 ? `${x}!` : x, $i: n,
    }));
    const read = async () => (await db.query(`SELECT id, "$b", "$f", "$x", "$i" FROM m ORDER BY id`)).rows;
    expect(await read()).toEqual(want);
    // 分割で行を運ぶ。運ぶ行もタプルである。
    await split(c, "s0", "s2");
    await split(c, "s1", "s3");
    expect(await read()).toEqual(want);
    expect((await db.query(`SELECT count(*) AS n FROM m WHERE "$f" = 9e999`)).rows).toEqual([{ n: 4 }]);
  });

  it("uses such columns in a Hrana transaction whose writes travel in the baton", async () => {
    // baton は取引の書き出しを JSON にし、`{"$b": ...}` の印を BLOB に戻して読む (src/client/hrana.ts)。取引が溜めた行イメージも
    // baton に入るので、列名が印と同じ行が印と取り違えられないことを、要求をまたぐ取引で確かめる。
    const c = new SimCluster({ shards: 2 });
    await new Db(c).ddl(`CREATE TABLE m(id INTEGER PRIMARY KEY, "$b", "$f")`);
    const step = (baton: string | null, sql: string[]) =>
      handlePipeline({ baton, requests: sql.map((s) => ({ type: "execute", stmt: { sql: s } })) } as PipelineReq, async (token) => new Db(c, { token })) as Promise<{
        baton: string | null; results: { type: string; error?: { message: string } }[];
      }>;
    const begun = await step(null, ["BEGIN", ...Array.from({ length: 6 }, (_, i) => `INSERT INTO m VALUES (${i + 1}, x'0${i}ff', 9e999)`)]);
    expect(begun.results.filter((r) => r.type !== "ok")).toEqual([]);
    const done = await step(begun.baton, [`UPDATE m SET "$f" = -9e999 WHERE id <= 3`, "COMMIT"]);
    expect(done.results.filter((r) => r.type !== "ok")).toEqual([]);
    await c.settle();
    expect((await new Db(c).query(`SELECT id, "$b", "$f" FROM m ORDER BY id`)).rows).toEqual(
      Array.from({ length: 6 }, (_, i) => ({ id: i + 1, $b: new Uint8Array([i, 255]), $f: i < 3 ? Number.NEGATIVE_INFINITY : Number.POSITIVE_INFINITY })));
  });
});
