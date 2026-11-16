// 未解決 (計画書の未解決の問題 37 の続き): SQL の BEGIN の取引 (書き込みが行ロックを取る悲観的な取引) は、分割の前に動いた範囲に
// 触れていなくても、分割の後に動いた行を書くと、COMMIT が `conflict: read too old: moved at m` で失敗する。
//
// Epoch の段 2 (docs/design-catalog-epoch.md の「段 2 の結果」) から、取引の文が範囲の移動で断られると、取引は範囲表を取り替えて、
// 文を新しい持ち主で計画し直す。Db.begin() の取引 (楽観的) は、動いた行を移動の時刻より前の時刻で読もうとして子に断られると、
// それまでの読み (動いていない行だけ) を確かめて読み取り時刻を進め、確定まで通る。
// SQL の BEGIN の取引は、書き込みを最新の状態で実行して行ロックを取る (読み取り時刻 T は最初の文のまま)。子は、その書き込みを
// 受ける。COMMIT では、子の prepare が、取引の T で所有を確かめる (src/shard/kernel.ts の prepareSync の enter)。T は子の範囲の床
// (移動の時刻 m) より前なので、子は `read too old: moved at m` で断り、anchor が取引を中止する。子が持つ書き込みと読みは、どれも
// 子が受け取った後の時刻 F から検証されるが、所有の確かめは T で行う。同じ取引の、行ロックを取らない読み (2 文目以降の SELECT) も、
// 読み取り時刻を進めようとして、子に書いた行の範囲 (F から確かめる範囲) を子に T から確かめさせるので、`read too old` で失敗する。
// 分割がなければ、同じ取引は確定する。成否が置き場所で変わる (AGENTS.md の規則 4)。
//
// 直すには、子が、取引の T ではなく、範囲ごとの確かめの始まり (F) で所有を引く規則か、COMMIT の前に読み取り時刻を進める規則が要る。
// どちらも、移動をまたぐ取引の検証の規則で、モデルにない (test/open/transaction-across-split.test.ts と同じく、M5b を広げるモデルで
// 先に確かめる)。見つけたのは、段 2 の作業の確かめ (2026-11-15)。
import { describe, expect, it } from "vitest";
import { split } from "../../src/autoscaler";
import { Db } from "../../src/client/db";
import { keyString } from "../../src/keys";
import { ownerOf, SUBSLOTS, tokenOf } from "../../src/routing";
import { SimCluster } from "../sim";

const ROWS = 40;
const key = (id: number) => keyString([BigInt(id)]);
const outcome = (p: Promise<unknown>) => p.then(() => "ok", (e: Error) => e.message);

describe("a locking transaction (SQL BEGIN) that writes a moved row after a split", () => {
  for (const begin of ["BEGIN", "BEGIN IMMEDIATE"]) {
    it(`commits, as it would without the split (${begin})`, async () => {
      const c = new SimCluster({ shards: 1 });
      const admin = new Db(c);
      await admin.ddl("CREATE TABLE t(id INTEGER PRIMARY KEY, v INTEGER NOT NULL)");
      await admin.query(`INSERT INTO t VALUES ${Array.from({ length: ROWS }, (_v, i) => `(${i + 1}, ${i + 1})`).join(", ")}`);
      const r = (await c.catalog()).routing.ranges.find((x) => x.shard === "s0")!;
      const cut = Math.floor((r.start + r.end) / 2 / SUBSLOTS) * SUBSLOTS;
      const ids = Array.from({ length: ROWS }, (_v, i) => i + 1);
      const stay = ids.find((id) => tokenOf(key(id), key(id)) < cut)!;
      const db = new Db(c, { retries: 0 });
      await db.query(begin);
      expect((await db.query("SELECT v FROM t WHERE id = ?", [stay])).rows).toEqual([{ v: stay }]);
      await split(c, "s0", "s1", { range: { start: cut, end: r.end } });
      const { routing } = await c.catalog();
      const moved = ids.find((id) => ownerOf(routing, key(id)) === "s1")!;
      expect(await outcome(db.query("UPDATE t SET v = v + 100 WHERE id = ?", [moved]))).toBe("ok");
      expect(await outcome(db.query("COMMIT"))).toBe("ok");
      expect((await new Db(c).query("SELECT v FROM t WHERE id = ?", [moved])).rows).toEqual([{ v: moved + 100 }]);
    });
  }
});
