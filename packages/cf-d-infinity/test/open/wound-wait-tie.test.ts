// 未解決: 同じミリ秒に始まった autocommit の書き込みと取引の行ロックの順序が、ID の綴りで決まる。
//
// 行ロックの待ちは wound-wait である (src/shard/kernel.ts の older)。古い者が、猶予 (200 ms) の後に若い保持者から行を奪う。
// 古さは開始時刻で比べ、同じ時刻なら ID の文字列で比べる。autocommit の ID は `auto-<時刻>`、取引の ID は `t-<uuid>-<連番>` なので、
// 同じミリ秒なら autocommit がいつも古い。autocommit は、取引が先に取った行を 200 ms 後に奪って書き、取引の COMMIT は検証で競合になる。
// autocommit はロックを持たず、行が空くのを待つ側として作ってある (kernel.ts の autoStep の注釈「autocommit は取引より若いものとして
// 順番を待つ」)。順序が ID の綴りに依るので、入口の ID の接頭辞 (Db の idPrefix) を変えるだけで結果が変わる。
// 見つけたのは、シャードを核と殻に分けたとき (2026-11-14、計画書の「同じ開始時刻の取引と autocommit」)。
import { describe, expect, it } from "vitest";
import { Db } from "../../src/client/db";
import { SimCluster } from "../sim";

describe("an autocommit write that starts in the same millisecond as a transaction's row lock", () => {
  for (const idPrefix of ["t", "z", "a"]) {
    it(`waits for the transaction instead of wounding it, whatever the transaction's id looks like (prefix ${idPrefix})`, async () => {
      const c = new SimCluster({ shards: 1 });
      await new Db(c).ddl("CREATE TABLE t(id INTEGER PRIMARY KEY, v INTEGER NOT NULL)");
      await new Db(c).query("INSERT INTO t VALUES (1, 1)");
      const tx = new Db(c, { retries: 0, idPrefix });
      await tx.query("BEGIN");
      // 取引が行ロックを取る。仮想の時計は進まないので、次の autocommit の書き込みは同じミリ秒に始まる。
      await tx.query("UPDATE t SET v = v + 1 WHERE id = 1");
      let wrote = false;
      const other = new Db(c).query("UPDATE t SET v = v * 10 WHERE id = 1").then(() => (wrote = true));
      await c.sleep(1000);
      expect(wrote).toBe(false);
      await tx.query("COMMIT");
      await other;
      expect((await new Db(c).query("SELECT v FROM t WHERE id = 1")).values).toEqual([[20n]]);
    });
  }
});
