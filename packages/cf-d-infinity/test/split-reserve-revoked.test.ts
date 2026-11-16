// 分割の枠を取る前の適用で、分割に関わらないシャードが、最新の表定義の記録の適用に失敗しない (未解決の問題 22。段 3 で閉じた)。
//
// 段 3 より前の reserveSplit (src/autoscaler.ts) は、全シャードに最新の版を適用させてから枠を取った。あるシャードが最新の版の適用に
// 失敗すると、そのシャードは取り消しの版を記録し、取り消された版を求めた適用は stale schema で断られ、その誤りは、やり直しの輪の外で
// 投げられた。split() は枠を取らずに失敗し、Autoscaler の次の判断まで分割が遅れた (安全性は保たれた)。
// 段 3 から、行で失敗する DDL は、prepare の確かめ (各シャードの試し) で見つかって abort になり、取り消しの文はない。prepare の適用は
// 利用者の表に触らず、abort の適用は禁止を解くだけなので、適用は行に依らず通る。枠を取る前の適用は断られない。
//
// 見つけたのは、specs/m15_maintenance_slot.qnt の m15_red_no_based_on の反例を写したときである (test/split-slot.test.ts、2026-11-12)。
import { describe, expect, it } from "vitest";
import { split } from "../src/autoscaler";
import { Db } from "../src/client/db";
import { ownerOf } from "../src/routing";
import { SimCluster } from "./sim";

describe("a split reserved after a schema change failed on a shard that takes no part in it", () => {
  it("applies the failed change everywhere without an error, and takes the slot in one call", async () => {
    const c = new SimCluster({ shards: 2 });
    const db = new Db(c);
    await db.ddl("CREATE TABLE p(tenant_id INTEGER NOT NULL, id INTEGER NOT NULL, code TEXT, gone INTEGER, PRIMARY KEY (tenant_id, id))");
    const { routing } = await c.catalog();
    const tenants = Array.from({ length: 200 }, (_, i) => i + 1);
    const on = (shard: string) => tenants.filter((t) => ownerOf(routing, JSON.stringify([t])) === shard);
    await db.query("INSERT INTO p VALUES (?, 1, 'x', NULL)", [on("s0")[0]!]);
    // s1 にだけ、次の DDL に反する行を置く。空の表では通るので、Meta は prepare を記録する。
    await db.query("INSERT INTO p VALUES (?, 1, 'z', 1), (?, 2, 'z', 1)", [on("s1")[0]!, on("s1")[0]!]);
    // DDL を進める側は、s1 の試しが通らないのを見て abort を記録し、全シャードに適用させる前に止まった。s0 は prepare も abort も
    // 適用していない。
    const p = await c.prepare("CREATE UNIQUE INDEX ux ON p(tenant_id, code) WHERE gone IS NOT NULL", {}, (await c.catalog()).schema);
    const answer = await c.shard("s1").prepared({ epoch: p.epoch! });
    expect(answer).toEqual({ ok: false, reason: "UNIQUE constraint failed: p.tenant_id, p.code" });
    await c.abort(p.epoch!, answer.reason!);
    const r = await split(c, "s0", "s2").then(() => "ok", (e: Error) => e.message);
    expect(r).toBe("ok");
    // 表は元のままで、どのシャードも書ける。
    const cat = await c.catalog();
    expect(cat.indexes.ux).toBeUndefined();
    await new Db(c).query("INSERT INTO p VALUES (?, 3, 'z', 1)", [on("s1")[0]!]);
  });
});
