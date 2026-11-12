// 未解決: 分割の枠を取る前の適用で、あるシャードが最新の版の適用に失敗して取り消すと、split() は枠を取らずに失敗する。
//
// reserveSplit (src/autoscaler.ts) は、全シャードに最新の版を適用させてから枠を取る。注釈は「適用に失敗したシャードは、その版の
// 取り消しを記録するので、版が進む。進んでいれば、もう一度適用させてから取る」と言う。ところが、取り消された版を求めた適用は
// stale schema で断られ、その誤りは、やり直しの輪の外で投げられる。輪がやり直すのは、Meta が basedOn を断ったときだけである。
// 安全性は保たれる (枠は取られない)。Autoscaler は保留の分割を次の判断でやり直すので、分割は 1 判断ぶん遅れる。/admin/split は誤りを返す。
//
// 見つけたのは、specs/m15_maintenance_slot.qnt の m15_red_no_based_on の反例を写したときである (test/split-slot.test.ts、2026-11-12)。
import { describe, expect, it } from "vitest";
import { split } from "../../src/autoscaler";
import { Db } from "../../src/client/db";
import { ownerOf } from "../../src/routing";
import { SimCluster } from "../sim";

describe("a split reserved while a shard that takes no part in it fails the latest schema version", () => {
  it("lets the shard revoke the version, applies the revocation everywhere, and takes the slot in one call", async () => {
    const c = new SimCluster({ shards: 2 });
    const db = new Db(c);
    await db.ddl("CREATE TABLE p(tenant_id INTEGER NOT NULL, id INTEGER NOT NULL, code TEXT, gone INTEGER, PRIMARY KEY (tenant_id, id)) SHARD KEY (tenant_id)");
    const { routing } = await c.catalog();
    const tenants = Array.from({ length: 200 }, (_, i) => i + 1);
    const on = (shard: string) => tenants.filter((t) => ownerOf(routing, JSON.stringify([t])) === shard);
    await db.query("INSERT INTO p VALUES (?, 1, 'x', NULL)", [on("s0")[0]!]);
    // s1 にだけ、次の DDL に反する行を置く。空の表では通るので、Meta は記録する。
    await db.query("INSERT INTO p VALUES (?, 1, 'z', 1), (?, 2, 'z', 1)", [on("s1")[0]!, on("s1")[0]!]);
    // DDL を記録した側は、全シャードに適用させる前に止まった。
    await c.applyDdl("CREATE UNIQUE INDEX ux ON p(tenant_id, code) WHERE gone IS NOT NULL", (await c.catalog()).version);
    const r = await split(c, "s0", "s2").then(() => "ok", (e: Error) => e.message);
    expect(r).toBe("ok");
  });
});
