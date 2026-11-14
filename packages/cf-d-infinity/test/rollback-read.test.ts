// M7: rollback-read はどの過去時点の状態も正確に再構成できる。実 SQLite に対するプロパティテスト。
import { describe, expect, it } from "vitest";
import { Db, QueryResult } from "../src/client/db";
import { SimCluster } from "./sim";

function prng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 2 ** 32;
  };
}

describe("rollback-read reconstructs every past state", () => {
  for (const seed of [1, 2, 3, 4, 5, 6, 7, 8]) {
    it(`with random inserts, deletes, updates and UNIQUE swaps (seed ${seed})`, async () => {
      const rnd = prng(seed);
      const c = new SimCluster({ shards: 1, K: 10_000 });
      const db = new Db(c);
      await db.ddl(`CREATE TABLE t(tenant_id INTEGER NOT NULL, id INTEGER NOT NULL, code TEXT NOT NULL, n INTEGER NOT NULL, PRIMARY KEY (tenant_id,id))`);
      await db.ddl(`CREATE UNIQUE INDEX t_code ON t(tenant_id, code)`);
      const dump = "SELECT id, code, n FROM t WHERE tenant_id = 1 ORDER BY id";
      const snapshots: { T: number; rows: unknown[] }[] = [];
      let codeSeq = 0;

      for (let i = 0; i < 80; i++) {
        c.time += 1;
        const rows = (await db.query(dump)).rows as { id: number; code: string }[];
        const a = rows[Math.floor(rnd() * rows.length)];
        const b = rows[Math.floor(rnd() * rows.length)];
        const op = rnd();
        if (op < 0.4 || rows.length < 2) {
          const id = 1 + Math.floor(rnd() * 1000);
          if (!rows.some((r) => r.id === id)) await db.query("INSERT INTO t VALUES (1,?,?,?)", [id, `c${codeSeq++}`, i]);
        } else if (op < 0.6 && a) {
          await db.query("DELETE FROM t WHERE tenant_id = 1 AND id = ?", [a.id]);
        } else if (op < 0.8 && a) {
          await db.query("UPDATE t SET n = n + 1 WHERE tenant_id = 1 AND id = ?", [a.id]);
        } else if (a && b && a.id !== b.id) {
          await db.transaction(async (tx) => {
            await tx.query("UPDATE t SET code = 'tmp' WHERE tenant_id = 1 AND id = ?", [a.id]);
            await tx.query("UPDATE t SET code = ? WHERE tenant_id = 1 AND id = ?", [a.code, b.id]);
            await tx.query("UPDATE t SET code = ? WHERE tenant_id = 1 AND id = ?", [b.code, a.id]);
          });
        }
        const read = await db.query(dump);
        snapshots.push({ T: read.ts!, rows: read.rows });
      }

      const shard = c.shard(c.shardIds[0]!);
      const { version } = await c.catalog();
      for (const s of snapshots) {
        const past = await shard.exec({
          T: s.T, sql: dump, params: [], spans: [{ kind: "sk", table: "t", sk: "[1]" }], schema: version,
        });
        expect(new QueryResult(past.columns, past.values).rows).toEqual(s.rows);
      }
      // 読み取りが本体を変えていないこと。
      expect((await db.query(dump)).rows).toEqual(snapshots.at(-1)!.rows);
    });
  }
  it("falls back to ReadTooOld above the delta limit K", async () => {
    const c = new SimCluster({ shards: 1, K: 3 });
    const db = new Db(c);
    await db.ddl(`CREATE TABLE t(tenant_id INTEGER NOT NULL, id INTEGER NOT NULL, PRIMARY KEY (tenant_id,id))`);
    const T = (await db.query("SELECT count(*) c FROM t WHERE tenant_id = 1")).ts!;
    for (let i = 0; i < 5; i++) await db.query("INSERT INTO t VALUES (1,?)", [i]);
    const { version } = await c.catalog();
    await expect(c.shard("s0").exec({ T, sql: "SELECT 1", params: [], spans: [], schema: version })).rejects.toThrow(/read too old/);
  });
});
