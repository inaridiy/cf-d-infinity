// 未解決: 値の格納の型 (INTEGER と REAL) が、入口、経路、置き場所で変わる。計画書の不変条件 11、未解決の問題 20。
//
// DO の SQLite は、JS の数を、整数でも REAL として束縛する (BigInt は束縛できない)。読むときは、INTEGER の 5 も REAL の 5.0 も
// JS の 5 になる。D∞ の値 (`Value`) は JS の数なので、INTEGER と REAL の区別を運べない。そのため:
// - Hrana の integer の引数も、D1 の API の整数も、シャードでは REAL として束縛される。TEXT の列には "5.0" が入り、
//   `v * ? / 2` は整数の割り算にならない。Worker の SQLite (sql.js) は整数を INTEGER として束縛するので、同じ文でも、
//   表を読まない文 (Worker で答える) と表を読む文 (シャードで答える) で答えが違う。
// - 型のない列の REAL の 2.0 は、シャードで答える読みでは real、Worker の SQLite へ集めて答える読みでは integer になる。
//
// 正しい振る舞いは、それぞれの入口の約束である。Hrana は値の型をそのまま (sqld と同じ)、D1 の API は整数の数を INTEGER として
// 束縛する (D1 の型の変換表)。見つけたのは、キー文字列の関数を 1 つにする下調べのとき (2026-11-12)。
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { D1Compatible } from "../../src/client/d1";
import { Db } from "../../src/client/db";
import { clientOf } from "../libsql";
import { SimCluster } from "../sim";

const DDL = "CREATE TABLE kv(k INTEGER PRIMARY KEY, v, s TEXT)";

describe("the storage class of a value", () => {
  it("binds a Hrana integer argument as INTEGER, as sqld does", async () => {
    const c = new SimCluster({ shards: 2 });
    const client = clientOf(c);
    await client.execute(DDL);
    await client.execute({ sql: "INSERT INTO kv(k, v, s) VALUES (?, ?, ?)", args: [1n, 5n, 5n] });
    const r = await client.execute({ sql: "SELECT typeof(v) AS tv, s, v * ? / 2 AS x FROM kv WHERE k = 1", args: [3n] });
    // node:sqlite は BigInt を INTEGER として束縛する。sqld も Hrana の integer をそう束縛する。
    const lite = new DatabaseSync(":memory:");
    lite.exec(DDL);
    lite.prepare("INSERT INTO kv(k, v, s) VALUES (?, ?, ?)").run(1n, 5n, 5n);
    const want = lite.prepare("SELECT typeof(v) AS tv, s, v * ? / 2 AS x FROM kv WHERE k = 1").all(3n);
    expect(r.rows.map((x) => ({ ...x }))).toEqual(want.map((x) => ({ ...x })));
  });

  it("binds an integral number from the D1 API as INTEGER, as D1 does", async () => {
    const c = new SimCluster({ shards: 2 });
    const d1 = new D1Compatible(new Db(c));
    await d1.prepare(DDL).run();
    await d1.prepare("INSERT INTO kv(k, v, s) VALUES (?, ?, ?)").bind(1, 5, 5).run();
    const r = await d1.prepare("SELECT typeof(v) AS tv, s FROM kv WHERE k = 1").all();
    expect(r.results).toEqual([{ tv: "integer", s: "5" }]);
  });

  it("answers the same for a statement on a shard and the same statement on the Worker's SQLite", async () => {
    const c = new SimCluster({ shards: 2 });
    const db = new Db(c);
    await db.ddl(DDL);
    await db.query("INSERT INTO kv(k, v) VALUES (1, 1)");
    const onWorker = (await db.query("SELECT ? / 2 AS x", [5])).rows;
    const onShard = (await db.query("SELECT ? / 2 AS x FROM kv WHERE k = 1", [5])).rows;
    expect(onShard).toEqual(onWorker);
  });

  it("keeps a REAL in a column without a type, whichever path reads it", async () => {
    const c = new SimCluster({ shards: 1 });
    const db = new Db(c);
    await db.ddl(DDL);
    await db.query("INSERT INTO kv(k, v) VALUES (5, 2.0), (6, 3)");
    const point = (await db.query("SELECT typeof(v) AS t FROM kv WHERE k = 5")).rows;
    const range = (await db.query("SELECT typeof(v) AS t FROM kv WHERE k >= 5 ORDER BY k")).rows;
    expect({ point, range }).toEqual({ point: [{ t: "real" }], range: [{ t: "real" }, { t: "integer" }] });
  });
});
