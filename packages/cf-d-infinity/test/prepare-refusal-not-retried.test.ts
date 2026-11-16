// 直した: 2 相コミットの prepare を、シャードの書き込みの守り (src/shard/kernel.ts の claimed) が断ると、Worker はそれを競合として
// やり直す。
//
// 守りの拒否 (`write outside claim:`) は、範囲表が古いのではなく、要求の作り方の誤りである (src/types.ts の WriteOutsideClaim)。
// やり直しても同じ変更を送るので、また断られる。1 シャードの確定 (commitLocal) は誤りをそのまま投げるので、やり直されない。
// 2 シャードの確定は、anchor が理由を文字列で返し、Txn.commit が UNIQUE でない理由を全部 ConflictError で包む。
// Db.transaction (autocommit の書き込みと batch) は、上限 (12 回) まで同じ取引をやり直し、最後に `conflict: write outside claim:` を返す。
// 利用者の取引 (Db.begin、SQL の BEGIN) では、やり直してよい競合 (SQLITE_BUSY) に見える。
// 見つけたのは、書き込みの守りを入れたとき (2026-11-14、計画書の「残り」)。
//
// 直し方 (2026-11-16): 確定が断られた理由は、1 シャードのものも 2 相コミットのものも、1 つの関数 (src/client/db.ts の commitRefusal) で
// 誤りにする。やり直して通り得る理由だけを競合にし、守りの拒否と UNIQUE の違反はやり直さない誤りにする。
import { afterEach, describe, expect, it } from "vitest";
import { Db, type Txn } from "../src/client/db";
import { keyString } from "../src/keys";
import { ownerOf } from "../src/routing";
import { tupleOfRow } from "../src/shard/rows";
import { ConflictError, type Change } from "../src/types";
import { allWriteEscapes, SimCluster } from "./sim";

/** 表 t、2 シャード。s0 の行 a を書き、s1 には、行 b を名乗って行 b2 のイメージを運ぶ変更 (守りが断る) を溜める。 */
async function scene() {
  const c = new SimCluster({ shards: 2 });
  const db = new Db(c);
  await db.ddl("CREATE TABLE t(id INTEGER PRIMARY KEY, v INTEGER NOT NULL)");
  const cat = await c.catalog();
  const on = (shard: string, after = 0) => { for (let i = after + 1; ; i++) if (ownerOf(cat.routing, keyString([BigInt(i)])) === shard) return i; };
  const a = on("s0");
  const b = on("s1");
  const b2 = on("s1", b);
  const forged: Change = { table: "t", pk: keyString([BigInt(b)]), sk: keyString([BigInt(b)]), before: null, after: tupleOfRow(cat.tables.t!, { id: BigInt(b2), v: 1n }) };
  const load = async (tx: Txn) => {
    await tx.query("INSERT INTO t VALUES (?, 1)", [a]);
    (tx as unknown as { buffer(shard: string, c: Change): void }).buffer("s1", forged);
  };
  const commits = () => c.net.log.filter((m) => m.method === "commit").length;
  return { c, db, load, commits };
}

describe("a two-shard commit whose prepare the write guard refuses", () => {
  // 守りが断った偽の変更は、書き込みの検査 (test/setup.ts) にも出る。この試験が確かめたものなので、全体の検査には渡さない。
  afterEach(() => {
    allWriteEscapes.length = 0;
  });
  it("is not retried by Db.transaction, and fails with the guard's error", async () => {
    const { db, load, commits } = await scene();
    const e = await db.transaction(load).then(() => null, (x: Error) => x);
    expect(e?.message).toMatch(/^write outside claim: /);
    expect(commits()).toBe(1);
  });

  it("is not reported to a transaction's caller as a conflict to retry", async () => {
    const { db, load } = await scene();
    const tx = await db.begin();
    await load(tx);
    const e = await tx.commit().then(() => null, (x: Error) => x);
    expect(e).not.toBeInstanceOf(ConflictError);
    expect(e?.message).toMatch(/^write outside claim: /);
  });
});
