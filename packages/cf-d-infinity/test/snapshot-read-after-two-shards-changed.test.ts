// 直した (計画書の未解決の問題 34): 取引の中の、複数のシャードを読む文が、読んだ後に 2 つ以上のシャードで行が変わっていると、`read too old` で失敗する。
//
// 取引は、読む行に新しい確定があると、読む時点を先へ進めようとする (src/client/db.ts の Txn.call と advance)。それまでの読みが
// 変わっていて進められなければ、「スナップショットのまま読み続ける」と決めてある (advance の注釈)。ところが、1 つの文が複数の
// シャードへ同時に要求を送っていると、こうなる。
//   1. どのシャードにも「新しい確定があれば知らせる」(fresh) を付けて送る。
//   2. 1 つ目のシャードが「moved at …」と答える。時点は進められないので、以後は fresh を付けないと決める (wantsFresh = false)。
//   3. 2 つ目のシャードも「moved at …」と答える。これは 2 より前に送った要求の答えである。ところが、やり直す条件が
//      wantsFresh を見ているので、やり直さずに、その誤りをそのまま投げる。
// 1 つのシャードだけが変わっていれば、スナップショットの行が返る。答えが、変わった行の置き場所で変わる。
// 誤りはやり直せる種類 (競合) なので、取引は直列のままである。失うのは、読むだけの長い取引が読み続けられることである。
// Hrana の対話の取引では、要求のたびに取引を組み立て直し、wantsFresh が元に戻るので、文のたびに起きる。
//
// 見つけたのは、64 ビットの整数の検査 (test/open/int64.test.ts) の「古い時刻の読み」の場面を、4 シャードで流したとき (2026-11-14)。
//
// 直し方 (2026-11-16): 答えを、その要求が運んだ時点と fresh だけで判断する (Txn.call)。fresh を付けて送った要求の `moved at` は、
// T を進めるか、進められなければ fresh を外してスナップショットで読み直す合図で、並んだ別の要求の答えには依らない。
import { describe, expect, it } from "vitest";
import { Db } from "../src/client/db";
import { ownerOf } from "../src/routing";
import { SimCluster } from "./sim";

describe("a transaction that reads several shards after rows on two of them changed", () => {
  it("keeps reading its snapshot", async () => {
    const c = new SimCluster({ shards: 2 });
    const db = new Db(c);
    await db.ddl("CREATE TABLE flat(id INTEGER PRIMARY KEY, v INTEGER NOT NULL)");
    const { routing } = await c.catalog();
    const on = (shard: string) => { for (let i = 1; ; i++) if (ownerOf(routing, JSON.stringify([i])) === shard) return i; };
    const [a, b] = [on("s0"), on("s1")];
    for (const id of [a, b]) await db.query("INSERT INTO flat VALUES (?, 1)", [id]);

    const tx = await new Db(c, { retries: 0 }).begin();
    const scan = "SELECT id, v FROM flat ORDER BY id";
    const before = (await tx.query(scan)).rows;
    expect(before).toHaveLength(2);
    // 別の接続が、2 つのシャードの行を 1 つずつ書き換える。
    await new Db(c).query("UPDATE flat SET v = 10 WHERE id = ?", [a]);
    await new Db(c).query("UPDATE flat SET v = 100 WHERE id = ?", [b]);
    const again = await tx.query(scan).then((r) => r.rows, (e: Error) => `error ${e.message}`);
    expect(again).toEqual(before);
    await tx.commit();
  });
});
