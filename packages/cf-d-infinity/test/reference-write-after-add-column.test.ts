// 計画した後に ADD COLUMN が入っても、基準経路の書き込みは、足された列の確定した値を残す (計画書の未解決の問題 38。Epoch の段 2 で
// 直した。docs/design-catalog-epoch.md の「段 2 の結果」)。
//
// 段 2 より前は、Db.transaction がやり直すたびに表定義を取り直すのに、文の計画 (Plan) は最初のものを使い続けた。基準経路の書き込み
// (Txn.wasmWrite) は、Worker の SQLite を新しい表定義 (取引の catalog) で作り、行を集める走査は計画の表定義の列だけを読む
// (src/sql/plan.ts の scanList)。足された列は集めた行に入らないので、Worker の SQLite では既定値になり、捕捉した変更後の行が、
// シャードの確定した値を既定値で上書きした。値の作り直しの段 2 で、行イメージの検査を基準経路だけの実行の
// test/ddl-concurrent.test.ts に掛けたときに、計画と取引の表定義の食い違いとして見つけた (2026-11-14)。
// いまは、やり直す試みのスナップショットの表定義の epoch が、計画したものと違えば、計画を捨てて、その試みの表定義で文を計画し直す
// (Db.dispatch)。
//
// 正しい振る舞い: 文が触らない列の値は、確定した値のまま残る。
import { describe, expect, it } from "vitest";
import { Db } from "../src/client/db";
import { SimCluster } from "./sim";

describe("a reference-path write planned before an ADD COLUMN", () => {
  it("keeps the value of the added column that the statement does not touch", async () => {
    const c = new SimCluster({ shards: 2 });
    // 古い表定義を覚えた接続。文を基準経路で実行する。
    const stale = new Db(c, { reference: "full" });
    await stale.ddl("CREATE TABLE t(id INTEGER PRIMARY KEY, n INTEGER)");
    await stale.query("INSERT INTO t VALUES (1, 0)");
    // 別の接続が列を足し、その列に値を書く。
    const other = new Db(c);
    await other.ddl("ALTER TABLE t ADD COLUMN extra TEXT DEFAULT 'd'");
    await other.query("UPDATE t SET extra = 'v' WHERE id = 1");
    // 古い接続が、足された列に触らない書き込みをする。シャードは古い版の要求を断り、取引は表定義を取り直してやり直す。
    await stale.query("UPDATE t SET n = n + 1 WHERE id = 1");
    expect((await other.query("SELECT id, n, extra FROM t")).rows).toEqual([{ id: 1, n: 1, extra: "v" }]);
  });

  // 計画し直した試みが、競合で断られた後も、古い計画に戻らない。やり直す試みのスナップショットは、計画し直したときと同じだが、
  // 最初の計画のときとは違う。最初の計画を送ると、足された列を既定値で上書きする。
  it("keeps the added column when the attempt planned again is refused by a conflict and tried once more", async () => {
    const c = new SimCluster({ shards: 2 });
    const stale = new Db(c, { reference: "full" });
    await stale.ddl("CREATE TABLE t(id INTEGER PRIMARY KEY, n INTEGER)");
    await stale.query("INSERT INTO t VALUES (1, 0)");
    const other = new Db(c);
    await other.ddl("ALTER TABLE t ADD COLUMN extra TEXT DEFAULT 'd'");
    await other.query("UPDATE t SET extra = 'v' WHERE id = 1");
    // 古い接続の文の、計画し直した試みの確定を止め、その間に別の接続が同じ行を書く。止めた確定は競合で断られる。
    let held = false;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let reached!: () => void;
    const hit = new Promise<void>((r) => (reached = r));
    c.net.gate = (m) => {
      if ((m.method !== "commitLocal" && m.method !== "commit") || m.from !== "client" || held) return undefined;
      held = true;
      reached();
      return gate;
    };
    const write = stale.query("UPDATE t SET n = n + 1 WHERE id = 1").then(() => "ok", (e: Error) => e.message);
    await hit;
    c.net.gate = () => undefined;
    await other.query("UPDATE t SET extra = 'w' WHERE id = 1");
    release();
    expect(await write).toBe("ok");
    expect((await other.query("SELECT id, n, extra FROM t")).rows).toEqual([{ id: 1, n: 1, extra: "w" }]);
  });
});
