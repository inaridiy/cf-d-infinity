// 2^53 を超える INTEGER (計画書の K1、2026-11-13 に test/key-conversions.test.ts を作っていて見つけた)。
//
// SQLite の INTEGER は 64 ビットだが、段 2 までの D∞ の値は JS の数で、2^53 を超える整数を正確に持てなかった。DO の SQLite も
// 読み出しで JS の数にする。シャードに入った 1500000000000000001 と 1500000000000000002 は、Worker ではどちらも 1500000000000000000
// になり、行を Worker の SQLite に集めると主キーが重なった。持ち主は、値で決まる `unsupported:` の誤りで、どの経路でもどの置き場所でも
// 同じように断ると決めた (2026-11-13)。
// 値の作り直しの段 3 で、値の JS の型が格納の型になり (bigint は INTEGER)、シャードの結果を型つきで読むようになった。断るのをやめ、
// どの置き場所でも SQLite と同じ答えを返す。64 ビットの整数のほかの経路は、test/int64.test.ts が確かめる。
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { Db } from "../src/client/db";
import { SimCluster } from "./sim";

async function run(shards: number, statements: string[]) {
  const db = new Db(new SimCluster({ shards }));
  await db.ddl("CREATE TABLE t(id INTEGER PRIMARY KEY, v TEXT)");
  const out: string[] = [];
  for (const s of statements) {
    out.push(await (async () => {
      if (s === "TXN") {
        return db.transaction(async (tx) => {
          await tx.query("INSERT INTO t VALUES (1500000000000000005, 'e')");
          await tx.query("UPDATE t SET v = 'f' WHERE id = 1500000000000000005");
        }).then(() => "ok", (e: Error) => `error ${e.message}`);
      }
      return db.query(s).then((r) => (r.columns.length ? JSON.stringify(r.rows) : "ok"), (e: Error) => `error ${e.message}`);
    })());
  }
  return out;
}

describe("integers beyond 2^53", () => {
  it("give SQLite's answer on every placement, and no statement is refused", async () => {
    const statements = [
      "INSERT INTO t VALUES (1500000000000000001, 'a'), (1500000000000000002, 'b')",
      "INSERT INTO t VALUES (7, 'c')",
      "UPDATE t SET id = id * 10000000000000000 WHERE id = 7",
      "INSERT INTO t SELECT 1 << 60, 'd'",
      // TEXT の列に入る大きな整数も、Worker を通ると丸まる (Codex の 2 回目の見直し、指摘 4)。
      "INSERT INTO t(id, v) SELECT 20, 9007199254740993",
      "INSERT INTO t(id, v) VALUES (21, (SELECT 9007199254740995))",
      // 計画が計算するキーの式。REAL の 1e20 を INTEGER にすると 2^63 - 1 になる (test/typed-diff.test.ts の seed 79、81、157 が作った形)。
      "INSERT INTO t(id, v) VALUES (CAST(1e20 AS INTEGER), 'g')",
      "SELECT CAST(id AS TEXT) AS id, v FROM t ORDER BY v",
      "TXN",
      "SELECT CAST(id AS TEXT) AS id, v FROM t WHERE v IN ('e', 'f')",
      "SELECT count(*) AS n FROM t",
    ];
    const refusedOn: Record<number, string[]> = {};
    for (const shards of [1, 2, 4]) {
      // 断った文は SQLite でも実行しない (test/diff.ts と同じ)。約束は「SQLite と同じ答えか、unsupported: で断るか」である。
      const lite = new DatabaseSync(":memory:");
      lite.exec("CREATE TABLE t(id INTEGER PRIMARY KEY, v TEXT)");
      const got = await run(shards, statements);
      refusedOn[shards] = [];
      got.forEach((g, i) => {
        const s = statements[i]!;
        if (g.startsWith("error unsupported:")) {
          refusedOn[shards]!.push(s);
          return;
        }
        let want: string;
        if (s === "TXN") {
          lite.exec("BEGIN; INSERT INTO t VALUES (1500000000000000005, 'e'); UPDATE t SET v = 'f' WHERE id = 1500000000000000005; COMMIT");
          want = "ok";
        } else {
          const st = lite.prepare(s);
          want = st.columns().length ? JSON.stringify(st.all()) : (st.run(), "ok");
        }
        expect(`${shards} shards, ${s}: ${g}`).toBe(`${shards} shards, ${s}: ${want}`);
      });
    }
    // 段 2 までは、2^53 を超える整数を保存する文を断っていた (計画書の K1)。段 3 からは、どの置き場所でも断らない。
    for (const shards of [1, 2, 4]) expect(refusedOn[shards], `${shards} shards`).toEqual([]);
  });

  it("accepts a column DEFAULT beyond 2^53, which reaches existing rows without a row image, and returns it exactly", async () => {
    // 段 2 までは、行イメージを作らずに既存の行へ入る既定値を、表定義のときに断っていた (Codex の 2 回目の見直し、指摘 5)。
    for (const shards of [1, 3]) {
      const db = new Db(new SimCluster({ shards }));
      await db.ddl("CREATE TABLE d(id INTEGER PRIMARY KEY, v TEXT)");
      await db.query("INSERT INTO d VALUES (1, 'a')");
      // 文字列で書いた既定値も、INTEGER の列の型の親和性で整数になる。ADD COLUMN の既定値は定数でなければならないので、式の既定値
      // (`(1 << 60)`) は CREATE TABLE で確かめる。
      const dflts = ["9007199254740993", "-9223372036854775808", "'9007199254740995'", "' 9007199254740997 '"];
      for (const [i, dflt] of dflts.entries()) await db.ddl(`ALTER TABLE d ADD COLUMN w${i} INTEGER DEFAULT ${dflt}`);
      await db.query("INSERT INTO d(id, v) VALUES (2, 'b')");
      const r = await db.query(`SELECT id, ${dflts.map((_d, i) => `w${i}, typeof(w${i})`).join(", ")} FROM d ORDER BY id`);
      const want = [9007199254740993n, -(2n ** 63n), 9007199254740995n, 9007199254740997n].flatMap((v) => [v, "integer"]);
      expect(r.values).toEqual([[1n, ...want], [2n, ...want]]);
      await db.ddl(`CREATE TABLE e(id INTEGER PRIMARY KEY, w INTEGER DEFAULT (1 << 60))`);
      await db.query("INSERT INTO e(id) VALUES (1)");
      expect((await db.query("SELECT w FROM e")).values).toEqual([[1n << 60n]]);
    }
  });
});
