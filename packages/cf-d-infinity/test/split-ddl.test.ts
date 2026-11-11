// 増設と DDL が重なったときの回帰テスト。子が先に DDL を適用すると、親の古い形の行と intent を受け取れず、
// 親は intent が決着するまで DDL を適用できず、互いに待ち続けていた。増設の間は、親も子も DDL を適用しない。
import { describe, expect, it } from "vitest";
import { split } from "../src/autoscaler";
import { Db } from "../src/client/db";
import { ownerOf, planSplit, slotOf } from "../src/routing";
import { quiescentProblems } from "./invariants";
import { SimCluster } from "./sim";

const attempt = async <T>(p: Promise<T>) => p.then((v) => ({ ok: v as unknown }), (e: Error) => ({ err: e.message }));

describe("split + a schema change + a committed transaction waiting to be applied", () => {
  it("ends in a state that recovers by itself", async () => {
    const c = new SimCluster({ shards: 2 });
    const db = c.client();
    await db.ddl(`CREATE TABLE t(tenant_id INTEGER NOT NULL, id INTEGER NOT NULL, x INTEGER, y INTEGER, PRIMARY KEY (tenant_id, id)) SHARD KEY (tenant_id)`);
    const { routing } = await c.catalog();
    const range = planSplit(routing, "s0")!;
    let G = 1; // a tenant on s0 inside the range that the split will move
    while (!(ownerOf(routing, JSON.stringify([G])) === "s0" && slotOf(JSON.stringify([G])) >= range.start && slotOf(JSON.stringify([G])) < range.end)) G++;
    let B = 1;
    while (ownerOf(routing, JSON.stringify([B])) !== "s1") B++;
    await db.query("INSERT INTO t VALUES (?, 1, 0, 0)", [G]);
    await db.query("INSERT INTO t VALUES (?, 1, 0, 0)", [B]);

    // X commits on s0 and s1 with s1 as the anchor; the finalize to s0 is delayed. X is acknowledged.
    let releaseFinalize!: () => void;
    const finalizeHeld = new Promise<void>((r) => (releaseFinalize = r));
    let releasePull!: () => void;
    const pullHeld = new Promise<void>((r) => (releasePull = r));
    let pullSeen!: () => void;
    const pullStarted = new Promise<void>((r) => (pullSeen = r));
    let holdPull = true;
    c.net.gate = (m) => (m.method === "finalize" && m.to === "s0" && m.from === "s1" ? finalizeHeld : undefined);
    c.net.reply = (m) => {
      if (holdPull && m.method === "pull" && m.to === "s0") {
        holdPull = false;
        pullSeen();
        return pullHeld; // the parent answered; the answer is still on its way to the child
      }
      return undefined;
    };
    const x = await new Db(c).begin();
    await x.query("SELECT x FROM t WHERE tenant_id = ?", [B]);
    await x.query("UPDATE t SET x = 1 WHERE tenant_id = ? AND id = 1", [G]);
    await x.query("UPDATE t SET x = 1 WHERE tenant_id = ? AND id = 1", [B]);
    await x.commit();
    expect(c.net.log.some((m) => m.method === "prepare" && m.from === "s1" && m.to === "s0")).toBe(true);

    // The autoscaler splits s0. The child has asked for the group; the answer is in flight.
    const splitting = attempt(split(c, "s0", "s2"));
    await pullStarted;

    // 増設の途中で列を足す。親も子も、増設が終わるまで DDL を適用しないので、DDL は待つ。待ち時間を短くすると、はっきり断る。
    const impatient = await attempt(new Db(c, { splitWaitMs: 100 }).ddl("ALTER TABLE t ADD COLUMN z INTEGER"));
    expect(impatient).toEqual({ err: "a shard split is in progress; retry the schema change when it finishes" });
    const ddl = attempt(new Db(c).ddl("ALTER TABLE t ADD COLUMN z INTEGER"));
    await c.sleep(50);
    releasePull();
    releaseFinalize();
    expect(await splitting).toHaveProperty("ok");
    expect(await ddl).toEqual({ ok: undefined });
    await c.settle();
    for (let i = 0; i < 5; i++) {
      c.time += 10_000;
      await c.fireAlarms();
      await c.settle();
    }
    const read = await attempt(new Db(c, { retries: 3 }).query("SELECT x FROM t WHERE tenant_id = ? AND id = 1", [G]).then((r) => r.rows));
    const problems = await quiescentProblems(c);
    expect(read).toEqual({ ok: [{ x: 1 }] });
    expect(problems).toEqual([]);
    expect((await c.catalog()).tables.t!.columns).toEqual(["tenant_id", "id", "x", "y", "z"]);
  });
});
