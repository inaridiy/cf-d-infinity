// index 経由の UPDATE が、ほかの行の確定済みで適用待ちの更新を古い値で上書きしないことを確かめる。
import { describe, expect, it } from "vitest";
import { Db } from "../src/client/db";
import { ownerOf } from "../src/routing";
import { quiescentProblems } from "./invariants";
import { SimCluster } from "./sim";

describe("UPDATE routed through a global index while an earlier commit is still being applied", () => {
  it("must not undo the earlier, acknowledged update", async () => {
    const c = new SimCluster({ shards: 2 });
    const db = c.client();
    await db.ddl(`CREATE TABLE t(tenant_id INTEGER NOT NULL, id INTEGER NOT NULL, v INTEGER, n INTEGER NOT NULL, PRIMARY KEY (tenant_id, id)) SHARD KEY (tenant_id)`);
    await db.ddl(`CREATE INDEX ix ON t(v)`);
    const { routing } = await c.catalog();
    // Two tenants on s1, one on s0. Pick index values whose index entries live on s0.
    const onS1: number[] = [];
    for (let t = 1; onS1.length < 2; t++) if (ownerOf(routing, JSON.stringify([t])) === "s1") onS1.push(t);
    const [P, Q] = onS1 as [number, number];
    let A = 1;
    while (ownerOf(routing, JSON.stringify([A])) !== "s0") A++;
    const ixOwner = (v: number) => ownerOf(routing, JSON.stringify([JSON.stringify([v])]));
    const vals: number[] = [];
    for (let v = 100; vals.length < 2; v++) if (ixOwner(v) === "s0") vals.push(v);
    const [OLD, NEW] = vals as [number, number];

    await db.query("INSERT INTO t VALUES (?, 1, ?, 0)", [P, OLD]);
    await db.query("INSERT INTO t VALUES (?, 1, ?, 0)", [Q, OLD]);
    await db.query("INSERT INTO t VALUES (?, 1, 1, 0)", [A]);

    // W1: move P's row from OLD to NEW. Anchor is s0 (it has an unprotected read span there), so s0 applies at once,
    // and the finalize to s1 is held: W1 is committed and acknowledged, but s1 still has only the intent.
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    let armed = false;
    c.net.gate = (m) => {
      if (m.method === "finalize" && m.to === "s1") return held;
      // Let the held finalize land between W2's statement and W2's commit on s1.
      if (armed && m.to === "s1" && (m.method === "prepare" || m.method === "commit" || m.method === "commitLocal")) {
        armed = false;
        release();
        return new Promise<void>((r) => setTimeout(r, 30));
      }
      return undefined;
    };
    const w1 = await new Db(c).begin();
    await w1.query("SELECT n FROM t WHERE tenant_id = ?", [A]);
    await w1.query("UPDATE t SET v = ? WHERE tenant_id = ? AND id = 1", [NEW, P]);
    await w1.commit();
    expect(c.net.log.some((m) => m.method === "prepare" && m.from === "s0" && m.to === "s1")).toBe(true);

    // W2 (autocommit, another connection, starts after W1 was acknowledged): touch every row that has v = OLD.
    armed = true;
    await new Db(c).query("UPDATE t SET n = 100 WHERE v = ?", [OLD]);

    c.net.gate = () => undefined;
    release();
    await c.settle();

    const rowP = (await new Db(c).query("SELECT v, n FROM t WHERE tenant_id = ? AND id = 1", [P])).rows[0];
    const problems = await quiescentProblems(c);
    // W1 was acknowledged before W2 started; in any serial order P ends with v = NEW and n = 0 (W2 does not match it).
    expect(rowP).toEqual({ v: NEW, n: 0 });
    expect(problems).toEqual([]);
  });
});
