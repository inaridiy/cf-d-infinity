// 内部で使っていた列の名前が、利用者の列として使えること (計画書の不変条件 5、2026-11-13 の Codex の指摘 C2、C3)。
//
// 段 2 までは、2 つの接頭辞の列名を断っていた。
// - `__dinf_`: 型のない列の型を読むために走査が足した別名 `__dinf_typeof_<i>` が、同じ名前の利用者の列を上書きした (C3)。値の作り直しの
//   段 3 で、走査は型つきの読み (位置で名前を付けた CTE の列 `"c0"`) になり、文に足す別名はなくなった。予約を外した。
// - `$`: 行イメージが列名つきの JSON で、BLOB と無限大の値を `{"$b": 16 進}`、`{"$f": "Infinity"}` の印にしていたので、列名が `$b` か
//   `$f` の行は、行そのものが印に見え、確定した INSERT が消えた (C2)。段 2 で、行イメージは列名を持たないタプルになったので、外した。
// そういう列が、取引、シャードをまたぐ確定、分割、行を集める読み、部分の集約を通って使えることを確かめる。
import { describe, expect, it } from "vitest";
import { split } from "../src/autoscaler";
import { Db } from "../src/client/db";
import { handlePipeline, type PipelineReq } from "../src/client/hrana";
import { encode } from "../src/shard/rows";
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
  it("the row images carry no column names", () => {
    // 行イメージはタプルなので、列名も印も入らない。BLOB と無限大の値も、要素の文字列になる。
    const after = encodeTuple([1n, new Uint8Array([1, 2]), Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]);
    expect(keysIn(encode({ table: "t", pk: "[1]", sk: "[1]", before: null, after }))).toEqual(["table", "pk", "sk", "before", "after"]);
  });

  it("uses columns named like the old aliases (__dinf_typeof_0, __dinf_r, c0) in gathered reads, partial aggregates and writes", async () => {
    // 段 2 までは、行を集める走査が、型のない列ごとに `__dinf_typeof_<i>` の列を足していた。いまは、型つきの読みの CTE の名前
    // `__dinf_r` と、その列 `"c0"`、`"c1"` を、位置で付ける。どれも、利用者の列名と取り違えない。
    const db = new Db(new SimCluster({ shards: 2 }));
    await db.ddl(`CREATE TABLE t(id INTEGER PRIMARY KEY, "__dinf_typeof_0", "__DINF_x" TEXT, c0, "__dinf_r")`);
    await db.ddl(`ALTER TABLE t ADD COLUMN "__dinf_c0" INTEGER`);
    for (let i = 1; i <= 6; i++) await db.query(`INSERT INTO t VALUES (?, ?, ?, ?, ?, ?)`, [BigInt(i), i % 2 ? 5 : 5n, `x${i}`, "t", i * 1.5, BigInt(i)]);
    // 2 つのシャードから集める読み。型のない列の 5.0 (REAL) と 5 (INTEGER) は、型ごと返る。
    const all = await db.query(`SELECT id, typeof("__dinf_typeof_0") AS t, "__DINF_x", c0, "__dinf_r", "__dinf_c0" FROM t ORDER BY id`);
    expect(all.rows).toEqual(Array.from({ length: 6 }, (_, k) => ({
      id: k + 1, t: (k + 1) % 2 ? "real" : "integer", __DINF_x: `x${k + 1}`, c0: "t", __dinf_r: (k + 1) * 1.5, __dinf_c0: k + 1,
    })));
    // 部分の集約と、書き込み。
    expect((await db.query(`SELECT count(*) AS n, sum("__dinf_c0") AS s, max("__dinf_r") AS m FROM t WHERE c0 = 't'`)).rows).toEqual([{ n: 6, s: 21, m: 9 }]);
    await db.query(`UPDATE t SET "__dinf_typeof_0" = 'u' WHERE "__dinf_c0" >= 4`);
    expect((await db.query(`SELECT count(*) AS n FROM t WHERE "__dinf_typeof_0" = 'u'`)).rows).toEqual([{ n: 3 }]);
  });

  it("keeps columns whose names only contain the prefixes", async () => {
    const db = new Db(new SimCluster({ shards: 2 }));
    await db.ddl(`CREATE TABLE t(id INTEGER PRIMARY KEY, "a$f" TEXT, "x__dinf_" TEXT, real INTEGER)`);
    await db.transaction(async (tx) => {
      for (let i = 1; i <= 4; i++) await tx.query(`INSERT INTO t VALUES (?, 'x', 'y', ?)`, [BigInt(i), BigInt(i)]);
    });
    expect((await db.query(`SELECT count(*) AS n, sum(real) AS s FROM t WHERE "a$f" = 'x'`)).rows).toEqual([{ n: 4, s: 10 }]);
  });

  it("uses columns named like the old markers ($b, $f) through transactions, a cross-shard commit and a split", async () => {
    const c = new SimCluster({ shards: 2 });
    const db = c.client();
    // 型のない列にすると、BLOB と無限大の値がそのまま入る。以前の行イメージでは、`{"$b": "0102"}` の形の行が BLOB の印に見えた。
    await db.ddl(`CREATE TABLE m(id INTEGER PRIMARY KEY, "$b", "$f", "$x" TEXT)`);
    await db.ddl(`ALTER TABLE m ADD COLUMN "$i" INTEGER`);
    const rows = Array.from({ length: 8 }, (_, i) => [BigInt(i + 1), `0${i}`, i % 2 ? Number.POSITIVE_INFINITY : BigInt(i), `x${i}`, BigInt(i)]);
    // 1 つの取引で 8 行を書く。行は 2 つのシャードに分かれるので、確定は 2 相で、行イメージは intent と変更ログを通る。
    await db.transaction(async (tx) => {
      for (const r of rows) await tx.query(`INSERT INTO m VALUES (?, ?, ?, ?, ?)`, r);
    });
    await db.query(`UPDATE m SET "$b" = x'0102' WHERE id = 2`);
    await db.query(`UPDATE m SET "$x" = "$x" || '!' WHERE "$i" >= 6`);
    const num = (v: unknown) => (typeof v === "bigint" ? Number(v) : v);
    const want = rows.map(([id, b, f, x, n]) => ({
      id: num(id), $b: id === 2n ? new Uint8Array([1, 2]) : b, $f: num(f), $x: (n as bigint) >= 6n ? `${x}!` : x, $i: num(n),
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
