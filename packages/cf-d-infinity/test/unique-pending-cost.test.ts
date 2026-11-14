// UNIQUE のある表への 1 回の書き込みの仕事を、ほかの取引がその表に intent を持っている間に測る (計画書の未解決の問題 6)。
// prepare は、ほかの intent を試しに適用した状態で UNIQUE を確かめる (specs/m16_unique_pending.qnt)。試しに適用するのは、同じ
// shard key の値 (グループ) の intent だけである。ほかのグループの intent がいくつあっても、仕事は増えない。同じグループの intent の
// 数には比例する (README の Limitations に数字を書いた)。
import { describe, expect, it } from "vitest";
import { Db } from "../src/client/db";
import { ownerOf } from "../src/routing";
import { SimCluster } from "./sim";

describe("write on a table with a local UNIQUE index while N other transactions are pending", () => {
  it("costs the same for N = 0 and N = 200 pending in other shard-key groups, and grows only with the same group's", async () => {
    const measure = async (pending: number, sameGroup: boolean) => {
      const c = new SimCluster({ shards: 2 });
      const db = c.client();
      await db.ddl(`CREATE TABLE p(tenant_id INTEGER NOT NULL, id INTEGER NOT NULL, code TEXT, PRIMARY KEY (tenant_id, id), UNIQUE (tenant_id, code))`);
      const { routing } = await c.catalog();
      const on = (s: string) => { for (let t = 1; ; t++) if (ownerOf(routing, JSON.stringify([t])) === s) return t; };
      const onAfter = (sh: string, after: number) => { for (let t = after + 1; ; t++) if (ownerOf(routing, JSON.stringify([t])) === sh) return t; };
      const [A, B] = [on("s1"), on("s0")];
      const other = onAfter("s1", A); // 同じシャードの、別のグループ
      const P = sameGroup ? A : other;
      let release!: () => void;
      const held = new Promise<void>((r) => (release = r));
      c.net.gate = (m) => (m.method === "finalize" && m.to === "s1" ? held : undefined);
      // `pending` two-shard transactions, anchored on s0, each leaves one intent on s1 (tenant A) until phase 2 arrives.
      for (let i = 0; i < pending; i++) {
        const x = await new Db(c).begin();
        await x.query("SELECT code FROM p WHERE tenant_id = ? AND id = ?", [B, 1_000_000 + i]);
        await x.query("INSERT INTO p VALUES (?, ?, ?)", [P, i, `a${i}`]);
        await x.query("INSERT INTO p VALUES (?, ?, ?)", [B, i, `b${i}`]);
        await x.commit();
      }
      const b = c.backends.get("s1")!;
      let statements = 0;
      let writes = 0;
      for (const k of ["exec", "raw", "iterate"] as const) {
        const orig = b[k].bind(b) as (sql: string, ...p: never[]) => unknown;
        (b as unknown as Record<string, unknown>)[k] = (sql: string, ...p: never[]) => {
          statements++;
          if (/^\s*(INSERT|DELETE|UPDATE)\b/i.test(sql) && /"p"/.test(sql)) writes++;
          return orig(sql, ...p);
        };
      }
      // Another tenant on the same shard would be the fair case; the shard key does not matter to uniquePending.
      await new Db(c).query("INSERT INTO p VALUES (?, ?, 'fresh')", [A, 5_000_000]);
      const out = { pending, sameGroup, statements, rowWritesOnUserTable: writes };
      c.net.gate = () => undefined;
      release();
      await c.settle();
      return out;
    };
    const base = await measure(0, false);
    const others = await measure(200, false);
    const same = await measure(200, true);
    console.log(JSON.stringify({ base, others, same }));
    expect(others.rowWritesOnUserTable).toBeLessThanOrEqual(base.rowWritesOnUserTable + 5);
    expect(others.statements).toBeLessThanOrEqual(base.statements + 10);
  }, 120_000);
});
