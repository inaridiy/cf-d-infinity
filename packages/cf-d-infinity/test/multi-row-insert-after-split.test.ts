// 古い範囲表で計画した複数行の INSERT が、分割の後でやり直されても、行を 1 つずつ持ち主のシャードに入れる (計画書の未解決の問題 35。
// Epoch の段 2 で直した。docs/design-catalog-epoch.md の「段 2 の結果」)。
//
// 複数行の INSERT は、計画のときに、行を範囲表の持ち主のシャードごとにまとめ、まとめごとに 1 つの文にする (src/sql/plan.ts の
// planInsert)。行が複数のシャードにまたがると、autocommit の文は取引として実行され (Db.dispatch から Db.transaction)、断られると
// やり直す。
//   1. Worker の範囲表が古い (分割の前)。全部の行が 1 つのシャードの持ち物に見え、文は 1 つになる。
//   2. 古い持ち主は範囲を手放しているので `not owner` で断る。Db.transaction は範囲表を取り直して、やり直す。
// 段 2 より前は、やり直しが同じ計画を使い、まとめの宛先 (route の sks) を、いまの範囲表でシャードへ振り分け直した。1 つのまとめの
// 行が 2 つのシャードに分かれ、まとめの文 (全部の行) が、その両方へ送られた。分割で生まれたシャード同士は、互いの範囲を手放した
// ことがないので通してしまい、同じ主キーの行が 2 つのシャードに入った (確定と答えた書き込みが、黙って表を壊した)。その後、シャードの
// 書き込みの守り (src/shard/kernel.ts の claimed) が、宣言の外の行を書いた文を `write outside claim:` で断るようにし、表は壊れなく
// なったが、INSERT は失敗した。
// いまは、やり直す試みのスナップショットが計画したものと違えば、計画を捨てて、その試みのスナップショットで文を計画し直す
// (Db.dispatch)。シャードも、所有を自分のスナップショットの範囲表で引く。守りを外したときの形は、test/write-guard.test.ts が、
// 古い計画をシャードへ直に送り直して確かめる。
//
// 見つけたのは、置き場所の差分の検査 (test/placement-differential.test.ts) の「分割で切った 4 シャード」の置き場所で、
// 分割の前に表定義を読んだ Db で、初めの行を入れたとき (2026-11-14、seed 45)。
import { describe, expect, it } from "vitest";
import { split } from "../src/autoscaler";
import { Db } from "../src/client/db";
import { keyString } from "../src/keys";
import { ownerOf, planSplit } from "../src/routing";
import { rawRows } from "./ddl-harness";
import { SimCluster } from "./sim";

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
    const read = await new Db(c).query("SELECT id, v FROM t ORDER BY id").then((r) => r.rows.map((x) => [x.id, x.v]), (e: Error) => `error ${e.message}`);
    expect(read).toEqual([[a, 1], [b, 2]].sort((x, y) => x[0]! - y[0]!));
  });
});
