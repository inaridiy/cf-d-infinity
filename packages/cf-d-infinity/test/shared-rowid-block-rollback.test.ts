// 直した (計画書の未解決の問題 50): 同じ isolate の接続が rowid のブロックを共有すると (src/worker.ts の sharedIds)、失敗した文の採番を戻すときに、
// その間にほかの接続が同じブロックから取った番号を、もう一度配る。後の INSERT が、主キーの UNIQUE で失敗する。
//
// Db.attemptStatement は、文を計画する前の採番の控えを取り、文が失敗したら、同じブロックなら次の番号を控えに戻す (SQLite も、
// 失敗した INSERT の rowid を使わない)。戻すときに、控えの後でほかの接続が同じブロックから番号を取ったかを確かめない。
//   1. 接続 A の INSERT が rowid n を採番し、要求が届く前に失敗する (応答が失われた、など)。
//   2. その間に、同じブロックを共有する接続 B の INSERT が n + 1 を採番して確定する。
//   3. A の失敗で、ブロックの次の番号が n に戻る。A の次の INSERT は n を、その次は n + 1 を採番し、B の行と主キーがぶつかる。
// 利用者は rowid を指定していないので、SQLite なら失敗しない。
// Epoch の段 2 で足した戻し方 (Db.idsUndo、断られた試みを計画し直すとき) は、計画の後に誰も取っていないときだけ戻す。
// 見つけたのは、段 2 の作業で、送り直す場所を見直したとき (2026-11-15)。不変条件の候補: 採番した rowid は、どの接続にも 1 度しか
// 配らない (戻すのは、同じブロックから後に誰も取っていないときだけ)。
//
// 直し方 (2026-11-16): 試みは、自分が採番した番号の控え (Taken) を持つ。戻すのは、ブロックの次の番号がまだその採番の直後にある
// ときだけである (Db.giveBack)。試みの前のブロックの写しに戻す仕組み (前の saved、idsMark、idsUndo) は消した。
import { describe, expect, it } from "vitest";
import { Db } from "../src/client/db";
import type { Rpc } from "./sim";
import { SimCluster } from "./sim";

describe("two connections that share a rowid block", () => {
  it("never hand out the same rowid twice when a statement of one of them fails", async () => {
    const c = new SimCluster({ shards: 1 });
    await new Db(c).ddl("CREATE TABLE t(id INTEGER PRIMARY KEY, v INTEGER NOT NULL)");
    const ids = new Map<string, { next: number; end: number }>();
    const a = new Db(c, { ids, retries: 0 });
    const b = new Db(c, { ids, retries: 0 });
    await a.query("INSERT INTO t(v) VALUES (1)");

    // A の次の書き込みの要求を止め、その間に B が書いて確定する。止めた要求は、届けずに失わせる。書き込みの要求は、1 シャードに
    // 送る autocommit なら execAuto、基準経路だけで実行する指定 (REFERENCE) では、取引の確定の commitLocal である。
    let held: Rpc | undefined;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    c.net.gate = (m) => {
      if ((m.method !== "execAuto" && m.method !== "commitLocal") || held) return undefined;
      held = m;
      return gate;
    };
    c.net.drop = (m) => m === held;
    const failed = a.query("INSERT INTO t(v) VALUES (2)").then(() => "ok", (e: Error) => e.message);
    await c.sleep(5);
    expect(held).toBeDefined();
    await b.query("INSERT INTO t(v) VALUES (3)");
    release();
    expect(await failed).toMatch(/rpc dropped/);
    c.net.gate = () => undefined;
    c.net.drop = () => false;

    const later = [];
    for (const v of [4, 5, 6]) later.push(await a.query("INSERT INTO t(v) VALUES (?)", [v]).then(() => "ok", (e: Error) => e.message));
    expect(later).toEqual(["ok", "ok", "ok"]);
    expect((await new Db(c).query("SELECT count(*) AS n, count(DISTINCT id) AS d FROM t")).rows).toEqual([{ n: 5, d: 5 }]);
  });
});
