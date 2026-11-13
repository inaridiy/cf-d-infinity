// 内部で使う列の名前と印を、利用者の列に使わせない (計画書の不変条件 5、2026-11-13 の Codex の指摘 C2、C3)。
//
// 行イメージは JSON で、BLOB と無限大の値を `{"$b": 16 進}`、`{"$f": "Infinity"}` の印にする。復号は印を形で見分けるので、
// 列名が `$b` か `$f` の行は、行そのものが印に見え、確定した INSERT が消えた。型のない列の型を読むために足す別名
// `__dinf_typeof_<i>` も、同じ名前の利用者の列を上書きした。名前の接頭辞を 1 つの一覧 (src/sql/ddl.ts の
// INTERNAL_COLUMN_PREFIXES) にまとめ、DDL がその名前の列を断る。ここでは、実際に使っている印と別名が一覧に当たること、
// その名前の列を CREATE TABLE と ADD COLUMN が断ることを確かめる。
import { describe, expect, it } from "vitest";
import { Db } from "../src/client/db";
import { encode, imageList } from "../src/shard/rows";
import { INTERNAL_COLUMN_PREFIXES, isInternalColumn } from "../src/sql/ddl";
import type { TableDef } from "../src/types";
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
  it("covers every marker the row images use and every alias the scans add", () => {
    const row = { id: 1, b: new Uint8Array([1, 2]), f: Number.POSITIVE_INFINITY, g: Number.NEGATIVE_INFINITY };
    const markers = keysIn(encode({ table: "t", pk: "[1]", sk: "[1]", before: null, after: row })).filter((k) => !["table", "pk", "sk", "before", "after", "id", "b", "f", "g"].includes(k));
    expect(markers.length).toBeGreaterThan(0);
    for (const m of markers) expect(isInternalColumn(m), m).toBe(true);
    const def = { name: "t", columns: ["id", "u", "w"], pk: ["id"], implicitRowid: false, affinity: { id: "INTEGER" } } as unknown as TableDef;
    const aliases = [...imageList(def).matchAll(/AS "([^"]+)"/g)].map((m) => m[1]!);
    expect(aliases.length).toBe(3); // 型を読む列 2 つと、2^53 を超える整数を確かめる列
    for (const a of aliases) expect(isInternalColumn(a), a).toBe(true);
  });

  it("refuses such a column in CREATE TABLE and ADD COLUMN, with unsupported:", async () => {
    const db = new Db(new SimCluster({ shards: 2 }));
    for (const name of ["$f", "$b", "$x", "__dinf_typeof_0", "__DINF_x"]) {
      await expect(db.ddl(`CREATE TABLE t(id INTEGER PRIMARY KEY, "${name}" TEXT)`)).rejects.toThrow(/^unsupported: column name/);
    }
    await db.ddl("CREATE TABLE t(id INTEGER PRIMARY KEY, v TEXT)");
    await expect(db.ddl(`ALTER TABLE t ADD COLUMN "$f" TEXT`)).rejects.toThrow(/^unsupported: column name/);
    expect(INTERNAL_COLUMN_PREFIXES).toContain("$");
  });

  it("keeps columns whose names only contain the prefixes", async () => {
    const db = new Db(new SimCluster({ shards: 2 }));
    await db.ddl(`CREATE TABLE t(id INTEGER PRIMARY KEY, "a$f" TEXT, "x__dinf_" TEXT, real INTEGER)`);
    await db.transaction(async (tx) => {
      for (let i = 1; i <= 4; i++) await tx.query(`INSERT INTO t VALUES (?, 'x', 'y', ?)`, [i, i]);
    });
    expect((await db.query(`SELECT count(*) AS n, sum(real) AS s FROM t WHERE "a$f" = 'x'`)).rows).toEqual([{ n: 4, s: 10 }]);
  });
});
