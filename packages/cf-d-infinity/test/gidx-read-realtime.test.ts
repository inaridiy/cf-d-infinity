// index 経由の autocommit の読みが、行のシャードの時計が進んでいても、開始前に確定した書き込みを見ることを確かめる。
import { describe, expect, it } from "vitest";
import { Db } from "../src/client/db";
import { ownerOf } from "../src/routing";
import { SimCluster } from "./sim";

describe("autocommit read through a global index, row shard's clock ahead of the index shard's", () => {
  it("sees a write that was acknowledged before the read started", async () => {
    const drift = new Map<string, number>();
    const c = new SimCluster({ shards: 2, skewMs: (id) => drift.get(id) ?? 0 });
    const db = c.client();
    await db.ddl(`CREATE TABLE t(tenant_id INTEGER NOT NULL, id INTEGER NOT NULL, v INTEGER, n INTEGER NOT NULL, PRIMARY KEY (tenant_id, id)) SHARD KEY (tenant_id)`);
    await db.ddl(`CREATE INDEX ix ON t(v)`);
    const { routing } = await c.catalog();
    let P = 1;
    while (ownerOf(routing, JSON.stringify([P])) !== "s1") P++;
    let V = 100;
    while (ownerOf(routing, JSON.stringify([JSON.stringify([V])])) !== "s0") V++;
    await db.query("INSERT INTO t VALUES (?, 1, ?, 0)", [P, V]);
    await c.settle();
    c.time += 1000;

    drift.set("s1", 40); // the row's shard runs 40 ms ahead of the index entry's shard

    // Session 1: a single-shard update (the index key does not change). Acknowledged.
    await new Db(c).query("UPDATE t SET n = 1 WHERE tenant_id = ? AND id = 1", [P]);
    await c.settle();
    c.time += 5;

    // Session 2 starts afterwards.
    const viaIndex = (await new Db(c).query("SELECT n FROM t WHERE v = ?", [V])).rows;
    const viaKey = (await new Db(c).query("SELECT n FROM t WHERE tenant_id = ? AND id = 1", [P])).rows;
    expect(viaKey).toEqual([{ n: 1 }]);
    expect(viaIndex).toEqual([{ n: 1 }]);
  });
});
