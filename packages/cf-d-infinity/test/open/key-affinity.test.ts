// 未解決: Worker が計算するキーと、シャードに入った行のキーが食い違う。計画書の不変条件 6、未解決の問題 19。
//
// Worker は、行の置き場所を決める前に、値を列の型に揃える (`normalize`、src/sql/cst.ts)。揃え方が SQLite と違う値がある。
// - 16 進、2 進、8 進の文字列 ('0x10' など): SQLite は文字列のまま入れる。`normalize` は数にする。
// - 範囲を超える指数の文字列 ('1e400'): SQLite は REAL の無限大にする。`normalize` は文字列のまま。
// - TEXT の列に入る実数: SQLite は有効数字 15 桁の文字列にする (0.30000000000000004 は "0.3"、1e20 は "1.0e+20")。
//   `normalize` は JavaScript の文字列にする。
// 書き込みは、シャードが行のキーと Worker のキーを比べて断る (利用者には内部の文言の誤り)。読みは比べないので、Worker の
// キーが指すシャードを読み、行がなければ空を返す。行が両方のキーで同じシャードに当たれば見つかるので、答えが置き場所で変わる。
// 見つけたのは、キー文字列の関数を 1 つにする下調べのとき (2026-11-12)。
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { Db } from "../../src/client/db";
import { SimCluster } from "../sim";

async function both(ddl: string, statements: string[]) {
  const lite = new DatabaseSync(":memory:");
  lite.exec(ddl);
  const c = new SimCluster({ shards: 4 });
  const db = new Db(c);
  await db.ddl(ddl);
  const ours: unknown[] = [];
  const want: unknown[] = [];
  for (const s of statements) {
    want.push((() => {
      try {
        const st = lite.prepare(s);
        return st.columns().length ? st.all().map((r) => ({ ...r })) : (st.run(), "ok");
      } catch (e) {
        return `error ${(e as Error).message}`;
      }
    })());
    ours.push(await db.query(s).then((r) => (r.columns.length ? r.rows : "ok"), (e: Error) => `error ${e.message}`));
  }
  return { ours, want };
}

describe("the key the Worker computes for a value agrees with the row SQLite stores", () => {
  it("finds a row in a TEXT key column written as a REAL literal", async () => {
    const { ours, want } = await both("CREATE TABLE t(k TEXT PRIMARY KEY, v INTEGER)", [
      "INSERT INTO t(k, v) SELECT 0.30000000000000004 || '', 1",
      "INSERT INTO t(k, v) SELECT 1e20 || '', 2",
      "SELECT v FROM t WHERE k = 0.30000000000000004",
      "SELECT v FROM t WHERE k = 1e20",
      "INSERT INTO t(k, v) VALUES (123456789.123456789, 3)",
      "SELECT v FROM t WHERE k = '123456789.123457'",
    ]);
    expect(ours).toEqual(want);
  });

  it("stores hex-looking strings in a NUMERIC key column as SQLite does", async () => {
    const { ours, want } = await both("CREATE TABLE n(k NUMERIC PRIMARY KEY, v INTEGER)", [
      "INSERT INTO n(k, v) VALUES ('0x10', 1)",
      "INSERT INTO n(k, v) VALUES ('0b1', 2)",
      "INSERT INTO n(k, v) VALUES ('1e400', 3)",
      "SELECT k, v FROM n WHERE k = '0x10'",
      "SELECT v FROM n WHERE k = '1e400'",
      "SELECT count(*) AS c FROM n",
    ]);
    expect(ours).toEqual(want);
  });
});
