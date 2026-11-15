// 未解決 (計画書の未解決の問題 37): 取引は、途中の範囲の移動 (分割) の前に読んだ範囲が動くと、分割をまたげない。
//
// 約束 (docs/sql-language.md の「取引」、2026-11-15 に決めた): 取引の途中で範囲が動いても、取引は続けられる。動いた行への文は
// 新しい持ち主へ送る。動いた範囲を移動の時刻より前の読み取り時刻で読む文は、それまでの読みが今も成り立てば読み取り時刻を進めて
// 読み、成り立たなければ競合になる。どちらも、移動がなく同じ行が別の接続に書かれたときと同じ扱いである。`not owner` では失敗しない。
// 利用者は分割の時期を選べないので、分割で取引が失敗すると、答えが置き場所で変わる (AGENTS.md の規則 4)。
//
// Epoch の段 2 (docs/design-catalog-epoch.md の「段 2 の結果」) で、取引は表定義の epoch だけを名乗り、文が範囲の移動で断られると、
// 範囲表を取り替えて文を計画し直す。動いた行への文は新しい持ち主へ行き、`not owner` では失敗しなくなった。まだ通らないのは、
// 分割の前に、動いた範囲を読んでいた取引である。動いた範囲を移動の時刻より前の時刻で読むと、子は `read too old: moved at m` で
// 断り、取引は読み取り時刻を m へ進めようとして、それまでの読みを確かめ直す (Txn.advance)。その読みは、親が、移動の前の範囲表の
// claim で答えたものである。親は手放した範囲を含む claim を `not owner` で断り、子は床 m より前の時刻の確かめに答えないので、
// 読みが今も成り立つかを誰も言えない。取引は時点を進められず、文は `read too old: moved at m` で失敗する。読んだ行が変わって
// いなくても失敗するので、成否が置き場所で変わる。
//   1 つ目の試験: 2 文目の読みが `read too old: moved at m` で失敗する。
//   2 つ目の試験: 別の接続が書いたときの失敗 (`read too old`) は、書かなかったときにも同じに起きる (後半が失敗する)。
// 親が移動の前の時刻を、子が受け取った後の時刻を受け持って確かめ直す規則はモデルにない (M21 の取引は動いた行で断られ、M18 は
// 移動をまたぐ取引の検証を扱っていない)。規則 3 により、そのモデル (M5b を広げる) を先に書く。持ち主は Epoch の段 2 の後の作業。
import { describe, expect, it } from "vitest";
import { split } from "../../src/autoscaler";
import { Db } from "../../src/client/db";
import { keyString } from "../../src/keys";
import { ownerOf, SUBSLOTS } from "../../src/routing";
import { SimCluster } from "../sim";

const ROWS = 40;
async function seeded(): Promise<SimCluster> {
  const c = new SimCluster({ shards: 1 });
  const db = new Db(c);
  await db.ddl("CREATE TABLE t(id INTEGER PRIMARY KEY, v INTEGER NOT NULL)");
  await db.query(`INSERT INTO t VALUES ${Array.from({ length: ROWS }, (_v, i) => `(${i + 1}, ${i + 1})`).join(", ")}`);
  return c;
}
/** s0 の範囲の後ろ半分を s1 へ動かし、動いた行の id を返す。 */
async function splitHalf(c: SimCluster): Promise<number[]> {
  const { routing } = await c.catalog();
  const r = routing.ranges.find((x) => x.shard === "s0")!;
  const cut = Math.floor((r.start + r.end) / 2 / SUBSLOTS) * SUBSLOTS;
  await split(c, "s0", "s1", { range: { start: cut, end: r.end } });
  const after = (await c.catalog()).routing;
  return Array.from({ length: ROWS }, (_v, i) => i + 1).filter((id) => ownerOf(after, keyString([BigInt(id)])) === "s1");
}
const outcome = (p: Promise<unknown>) => p.then(() => "ok", (e: Error) => e.message);

describe("a transaction that a split crosses", () => {
  it("keeps reading its snapshot and writes the moved rows, then commits", async () => {
    const c = await seeded();
    const tx = await new Db(c, { retries: 0 }).begin();
    const before = (await tx.query("SELECT id, v FROM t ORDER BY id")).rows;
    const moved = await splitHalf(c);
    expect(moved.length).toBeGreaterThan(0);
    const id = moved[0]!;
    expect(await outcome(tx.query("SELECT id, v FROM t ORDER BY id"))).toBe("ok");
    expect((await tx.query("SELECT id, v FROM t ORDER BY id")).rows).toEqual(before);
    expect(await outcome(tx.query("UPDATE t SET v = v + 100 WHERE id = ?", [id]))).toBe("ok");
    expect(await outcome(tx.query("UPDATE t SET v = v + 1000 WHERE v < 3"))).toBe("ok");
    expect(await outcome(tx.commit())).toBe("ok");
    const after = (await new Db(c).query("SELECT v FROM t WHERE id = ?", [id])).rows;
    expect(after).toEqual([{ v: id + 100 }]);
  });

  it("fails with a conflict, not with not owner, when a row it read changed after the split, and only then", async () => {
    // 同じ取引を、別の接続が動いた行を書く場合と書かない場合で流す。書けば競合で失敗し、書かなければ確定する。
    // 書かない場合が、失敗の理由が書き込みであって、分割ではないことを確かめる。
    const run = async (write: boolean) => {
      const c = await seeded();
      const tx = await new Db(c, { retries: 0 }).begin();
      await tx.query("SELECT id, v FROM t ORDER BY id");
      const moved = await splitHalf(c);
      if (write) await new Db(c).query("UPDATE t SET v = -1 WHERE id = ?", [moved[0]!]);
      const read = await outcome(tx.query("SELECT id, v FROM t ORDER BY id"));
      return read === "ok" ? await outcome(tx.query("UPDATE t SET v = 0 WHERE id = 1").then(() => tx.commit())) : read;
    };
    const changed = await run(true);
    expect(changed).not.toMatch(/not owner/);
    expect(changed).toMatch(/^(conflict|read too old)/);
    expect(await run(false)).toBe("ok");
  });
});
