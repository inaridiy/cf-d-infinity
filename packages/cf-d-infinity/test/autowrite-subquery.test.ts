// autocommit の書き込みが、サブクエリで読む表の確定済みで適用待ちの書き込みを待つことを確かめる。
import { describe, expect, it } from "vitest";
import { Db } from "../src/client/db";
import { ownerOf } from "../src/routing";
import { SimCluster } from "./sim";

const SQL = "UPDATE accounts SET bal = (SELECT sum(amount) FROM ledger WHERE tenant_id = ?) WHERE tenant_id = ?";

async function scenario(viaTransaction: boolean) {
  const c = new SimCluster({ shards: 2 });
  const db = c.client();
  await db.ddl(`CREATE TABLE accounts(tenant_id INTEGER PRIMARY KEY, bal INTEGER NOT NULL)`);
  await db.ddl(`CREATE TABLE ledger(tenant_id INTEGER NOT NULL, id INTEGER NOT NULL, amount INTEGER NOT NULL, PRIMARY KEY (tenant_id, id)) SHARD KEY (tenant_id)`);
  const { routing } = await c.catalog();
  const on = (s: string) => { for (let t = 1; ; t++) if (ownerOf(routing, JSON.stringify([t])) === s) return t; };
  const [A, B] = [on("s1"), on("s0")];
  for (const t of [A, B]) {
    await db.query("INSERT INTO accounts VALUES (?, 10)", [t]);
    await db.query("INSERT INTO ledger VALUES (?, 1, 10)", [t]);
  }
  // X: a two-shard transaction; s0 is the anchor (it holds X's unprotected read), the finalize to s1 is delayed.
  let release!: () => void;
  const held = new Promise<void>((r) => (release = r));
  c.net.gate = (m) => (m.method === "finalize" && m.to === "s1" ? held : undefined);
  const x = await new Db(c).begin();
  await x.query("SELECT bal FROM accounts WHERE tenant_id = ?", [B]);
  await x.query("INSERT INTO ledger VALUES (?, 2, 90)", [A]);
  await x.query("INSERT INTO ledger VALUES (?, 2, 90)", [B]);
  await x.commit(); // acknowledged
  expect(c.net.log.some((m) => m.method === "prepare" && m.from === "s0" && m.to === "s1")).toBe(true);

  // W starts after X was acknowledged.
  const w = new Db(c);
  if (viaTransaction) await w.transaction((tx) => tx.query(SQL, [A, A]));
  else await w.query(SQL, [A, A]);

  c.net.gate = () => undefined;
  release();
  await c.settle();
  const r = new Db(c);
  return {
    bal: (await r.query("SELECT bal FROM accounts WHERE tenant_id = ?", [A])).rows[0]!.bal,
    sum: (await r.query("SELECT sum(amount) s FROM ledger WHERE tenant_id = ?", [A])).rows[0]!.s,
  };
}

describe("autocommit UPDATE whose subquery reads another table of the same shard key", () => {
  it("control: inside db.transaction() it sees the acknowledged insert", async () => {
    expect(await scenario(true)).toEqual({ bal: 100, sum: 100 });
  });
  it("as a plain autocommit statement it must see it too", async () => {
    const r = await scenario(false);
    expect(r).toEqual({ bal: 100, sum: 100 });
  });
});
