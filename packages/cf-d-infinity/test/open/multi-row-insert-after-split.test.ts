// 未解決: 古い範囲表で計画した複数行の INSERT が、分割の後でやり直されると、行を 2 つのシャードに入れる。
//
// 複数行の INSERT は、計画のときに、行を範囲表の持ち主のシャードごとにまとめ、まとめごとに 1 つの文にする (src/sql/plan.ts の
// planInsert)。まとめの宛先は、文の中の行の shard key の一覧 (route の sks) として残る。行が複数のシャードにまたがると、autocommit
// の文は取引として実行され (Db.dispatch から Db.transaction)、実行のときに、その一覧をいまの範囲表でシャードへ振り分け直す
// (Txn.write の resolve)。範囲表が計画の後で変わっていると、1 つのまとめの行が 2 つのシャードに分かれ、まとめの文 (全部の行) が、
// その両方へ送られる。
//   1. Worker の範囲表が古い (分割の前)。全部の行が 1 つのシャードの持ち物に見え、文は 1 つになる。
//   2. 古い持ち主は範囲を手放しているので `not owner` で断る。Db.transaction は範囲表を取り直して、同じ計画でやり直す。
//   3. いまの範囲表では、行は 2 つのシャードに分かれる。2 つのシャードが、それぞれ全部の行を入れる。
// シャードは、宣言された shard key の外の行を書いても断らない。自分が手放した範囲の行だけを断るからである。分割で生まれた
// シャード同士は、互いの範囲を手放したことがないので、通してしまう。
// 結果: 同じ主キーの行が 2 つのシャードにあり、持ち主でないシャードにも行がある。全表を集める読みは UNIQUE の違反で失敗し、
// 1 シャードへ送る読みは、持ち主でないシャードの古い行を見落とす。確定と答えた書き込みが、黙って表を壊す。
//
// 見つけたのは、置き場所の差分の検査 (test/placement-differential.test.ts) の「分割で切った 4 シャード」の置き場所で、
// 分割の前に表定義を読んだ Db で、初めの行を入れたとき (2026-11-14、seed 45)。
import { describe, expect, it } from "vitest";
import { split } from "../../src/autoscaler";
import { Db } from "../../src/client/db";
import { keyString } from "../../src/keys";
import { ownerOf, planSplit } from "../../src/routing";
import { rawRows } from "../ddl-harness";
import { SimCluster } from "../sim";

describe("a multi-row INSERT planned with a range table from before two splits", () => {
  it("stores every row once, on its owner", async () => {
    const c = new SimCluster({ shards: 1 });
    const db = new Db(c);
    await db.ddl("CREATE TABLE t(id INTEGER PRIMARY KEY, v INTEGER NOT NULL)");
    // db は、分割の前の範囲表を覚えている (別の Worker の isolate の、キャッシュした表定義と同じ)。
    await db.query("SELECT count(*) FROM t");
    // s0 の後ろ半分を s1 へ、残りの後ろ半分を s2 へ渡す。s1 と s2 は、互いの範囲を手放したことがない。
    const half = planSplit((await c.catalog()).routing, "s0")!;
    await split(c, "s0", "s1", { range: half });
    const quarter = planSplit((await c.catalog()).routing, "s0")!;
    await split(c, "s0", "s2", { range: quarter });
    const { routing } = await c.catalog();
    const on = (shard: string) => { for (let i = 1; ; i++) if (ownerOf(routing, keyString([i])) === shard) return i; };
    const [a, b] = [on("s1"), on("s2")];

    await db.query("INSERT INTO t VALUES (?, 1), (?, 2)", [a, b]);
    await c.settle();

    const stored = (await rawRows(c, "t")).map((r) => `${r.row.id as number}@${r.shard}`).sort();
    expect(stored).toEqual([`${a}@s1`, `${b}@s2`].sort());
    const read = await new Db(c).query("SELECT id, v FROM t ORDER BY id").then((r) => r.values, (e: Error) => `error ${e.message}`);
    expect(read).toEqual([[a, 1], [b, 2]].sort((x, y) => x[0]! - y[0]!));
  });
});
