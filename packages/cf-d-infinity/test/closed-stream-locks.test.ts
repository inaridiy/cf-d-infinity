// Hrana のストリームを、COMMIT も ROLLBACK もせずに閉じたら、開いていた取引の行ロックをすぐに手放す (2026-11-12 に直した)。
//
// sqld は、ストリームを閉じると、開いている取引を巻き戻す。@libsql/client の使い方でも、`finally { tx.close() }` はよく書かれる。
// 直す前の D∞ は、HTTP の `close` 要求を何もせずに返し、WebSocket の `close_stream` と接続の切断は取引を捨てる (`Db.abandon`) だけで、
// ロックを解かない。ほかの接続の書き込みは、その行で 5 秒待たされる。
// 見つけたのは、分割の最中に送金を続けるデモ (examples/split-under-load.mjs) である。分割の瞬間に失敗した取引を閉じると、
// 書き込みが 1、2 秒止まった (計画書の未解決の問題 21)。
import { describe, expect, it } from "vitest";
import { Db } from "../src/client/db";
import { clientOf } from "./libsql";
import { SimCluster } from "./sim";

/** 全シャードが持っている行ロックの数。 */
const locks = (c: SimCluster) => [...c.cores.values()].reduce((n, core) => n + (core as unknown as { locks: Map<string, unknown> }).locks.size, 0);

describe("a transaction whose stream is closed without COMMIT or ROLLBACK", () => {
  it("releases its row locks at once over HTTP, so another connection's write does not wait", async () => {
    const c = new SimCluster({ shards: 2 });
    const client = clientOf(c);
    await client.execute("CREATE TABLE t(id INTEGER PRIMARY KEY, n INTEGER)");
    await client.execute("INSERT INTO t VALUES (1, 0)");
    const tx = await client.transaction("write");
    await tx.execute("SELECT n FROM t WHERE id = 1"); // BEGIN IMMEDIATE なので、行ロックを取る
    tx.close();
    await c.sleep(10); // 閉じる要求が届く
    const t0 = c.runtime.now();
    await clientOf(c).execute("UPDATE t SET n = 1 WHERE id = 1");
    expect(c.runtime.now() - t0).toBeLessThan(1000);
  });

  it("releases its row locks when a Db is abandoned (a WebSocket stream closed or the socket dropped)", async () => {
    const c = new SimCluster({ shards: 2 });
    await new Db(c).ddl("CREATE TABLE t(id INTEGER PRIMARY KEY, n INTEGER)");
    await new Db(c).query("INSERT INTO t VALUES (1, 0)");
    const db = new Db(c);
    await db.query("BEGIN IMMEDIATE");
    await db.query("SELECT n FROM t WHERE id = 1");
    expect(locks(c)).toBeGreaterThan(0); // 行ロックを取っている
    await db.abandon();
    await c.settle();
    expect(locks(c)).toBe(0);
  });
});
