// 取引が分割の前に書いた行が、分割で別のシャードへ動いた後も、同じ取引の文は、その書き込みを見る。
//
// Epoch の段 2 から、取引の文が範囲の移動で断られると、取引は範囲表を取り替えて、文を新しい持ち主で計画し直す (Txn.reroute)。
// 取引が溜めた書き込みは、書いたときのシャードのものとして残る。書いた行が動いていると、新しい持ち主へ送る文の overlay (取引自身の
// 書き込み) に、その行が入らない。行ロックを取る文 (SQL の BEGIN の書き込み、BEGIN IMMEDIATE の主キーの読み) は最新の状態で
// 実行されるので、子の範囲の床にも止められず、取引自身の書き込みを見ないまま答える (見つけたのは段 2 の作業の確かめ、2026-11-15)。
// そこで、取引が、新しい範囲表で別のシャードのものになった行を書いていれば、範囲表を取り替えずに、競合で断る。分割をまたいで
// その取引を続ける規則 (溜めた書き込みと読みを新しい持ち主へ移す) は、移動をまたぐ確かめ直しと一緒に、モデルを書いてから入れる
// (未解決の問題 37、test/open/transaction-across-split.test.ts)。
import { describe, expect, it } from "vitest";
import { split } from "../src/autoscaler";
import { Db } from "../src/client/db";
import { keyString } from "../src/keys";
import { ownerOf, SUBSLOTS, tokenOf } from "../src/routing";
import { SimCluster } from "./sim";

const ROWS = 40;
const key = (id: number) => keyString([BigInt(id)]);
const outcome = <T>(p: Promise<T>) => p.then((v) => ({ ok: v as unknown }), (e: Error) => ({ err: e.message }));

async function scene() {
  const c = new SimCluster({ shards: 1 });
  const admin = new Db(c);
  await admin.ddl("CREATE TABLE t(id INTEGER PRIMARY KEY, v INTEGER NOT NULL)");
  await admin.query(`INSERT INTO t VALUES ${Array.from({ length: ROWS }, (_v, i) => `(${i + 1}, ${i + 1})`).join(", ")}`);
  const r = (await c.catalog()).routing.ranges.find((x) => x.shard === "s0")!;
  const cut = Math.floor((r.start + r.end) / 2 / SUBSLOTS) * SUBSLOTS;
  const moving = Array.from({ length: ROWS }, (_v, i) => i + 1).find((id) => tokenOf(key(id), key(id)) >= cut)!;
  return { c, moving, splitIt: () => split(c, "s0", "s1", { range: { start: cut, end: r.end } }) };
}

describe("a transaction whose own write moved to another shard in a split", () => {
  for (const begin of ["BEGIN", "BEGIN IMMEDIATE"]) {
    it(`does not answer from the new owner without its own write (${begin})`, async () => {
      const { c, moving, splitIt } = await scene();
      const db = new Db(c, { retries: 0 });
      await db.query(begin);
      await db.query("UPDATE t SET v = v + 100 WHERE id = ?", [moving]);
      await splitIt();
      expect(ownerOf((await c.catalog()).routing, key(moving))).toBe("s1");
      // 取引の中では、行の値は自分の書き込みの後のものである。見えないなら、答えずに断る。
      const read = await outcome(db.query("SELECT v FROM t WHERE id = ?", [moving]).then((r) => r.rows));
      const write = await outcome(db.query("UPDATE t SET v = v + 1 WHERE id = ? RETURNING v", [moving]).then((r) => r.rows));
      expect(read).not.toEqual({ ok: [{ v: moving }] });
      expect(write).not.toEqual({ ok: [{ v: moving + 1 }] });
      for (const x of [read, write]) if ("ok" in x) expect(x.ok).toEqual([{ v: moving + 100 + (x === write ? 1 : 0) }]);
      await outcome(db.query("ROLLBACK"));
      // 確定していないので、行は元の値のままである。
      expect((await new Db(c).query("SELECT v FROM t WHERE id = ?", [moving])).rows).toEqual([{ v: moving }]);
    });
  }
});
