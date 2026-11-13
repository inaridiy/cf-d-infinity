// 2^53 を超える INTEGER (計画書の K1、2026-11-13 に test/key-conversions.test.ts を作っていて見つけた)。
//
// SQLite の INTEGER は 64 ビットだが、D∞ の値 (src/types.ts の Value) は JS の数で、2^53 を超える整数を正確に持てない。
// DO の SQLite も読み出しで JS の数にする。そのため、シャードに入った 1500000000000000001 と 1500000000000000002 は、Worker では
// どちらも 1500000000000000000 になる。行を Worker の SQLite に集めると主キーが重なり、SELECT が UNIQUE の違反で失敗する。
// 取引の書き込みは行イメージを JS の数で運ぶので、確定した値が書いた値と違う。
// 正しい振る舞いは 2 つのどちらかである。SQLite と同じ答えを返すか、値で決まる `unsupported:` の誤りで、どの経路でもどの
// 置き場所でも同じように断るか (AGENTS.md の規則 4)。持ち主は断るほうを選んだ (2026-11-13)。断るのは、書き込みのたびに作る
// 行イメージを読むところ (src/shard/rows.ts の imageList と typedRow) である。
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
  it("give SQLite's answer, or the same unsupported: refusal on every placement", async () => {
    const statements = [
      "INSERT INTO t VALUES (1500000000000000001, 'a'), (1500000000000000002, 'b')",
      "INSERT INTO t VALUES (7, 'c')",
      "UPDATE t SET id = id * 10000000000000000 WHERE id = 7",
      "INSERT INTO t SELECT 1 << 60, 'd'",
      // TEXT の列に入る大きな整数も、Worker を通ると丸まる (Codex の 2 回目の見直し、指摘 4)。
      "INSERT INTO t(id, v) SELECT 20, 9007199254740993",
      "INSERT INTO t(id, v) VALUES (21, (SELECT 9007199254740995))",
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
    // 断るかどうかも、シャードの数で変わらない。2026-11-13 の持ち主の決定で、2^53 を超える整数の保存は断る (計画書の K1)。
    expect(refusedOn[1]).toEqual(expect.arrayContaining([statements[0], statements[2], statements[3], statements[4], statements[5], "TXN"]));
    expect(refusedOn[2]).toEqual(refusedOn[1]);
    expect(refusedOn[4]).toEqual(refusedOn[1]);
  });

  it("refuses a column DEFAULT beyond 2^53, which would reach existing rows without a row image (Codex review 2, finding 5)", async () => {
    for (const shards of [1, 3]) {
      const db = new Db(new SimCluster({ shards }));
      await db.ddl("CREATE TABLE d(id INTEGER PRIMARY KEY, v TEXT)");
      await db.query("INSERT INTO d VALUES (1, 'a')");
      for (const dflt of ["9007199254740993", "(1 << 60)", "-9223372036854775808"]) {
        await expect(db.ddl(`ALTER TABLE d ADD COLUMN w INTEGER DEFAULT ${dflt}`)).rejects.toThrow(/^unsupported: an INTEGER beyond/);
        await expect(db.ddl(`CREATE TABLE e${shards}(id INTEGER PRIMARY KEY, w DEFAULT ${dflt})`)).rejects.toThrow(/^unsupported: an INTEGER beyond/);
      }
      await db.ddl("ALTER TABLE d ADD COLUMN w INTEGER DEFAULT 9007199254740991");
      expect((await db.query("SELECT id, w FROM d")).rows).toEqual([{ id: 1, w: 9007199254740991 }]);
    }
  });
});
