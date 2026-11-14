// 未解決: 結合の語 (LEFT、RIGHT、FULL、INNER、OUTER、CROSS、NATURAL) と JOIN の間に注釈があると、結合の語が表の別名に化ける。
//
// 解析の前の書き換え (src/sql/cst.ts の preprocess) は、結合の語の後ろに、空白だけを挟んで JOIN などが続くかを文面で見る。
// 続かなければ、識別子として使われたものとして引用符で囲む。`p LEFT /* c */ JOIN q` は `p "LEFT" /* c */ JOIN q` になり、
// 表 p に LEFT という別名を付けた内部結合として読まれる。列を表の名前で修飾していれば no such column で落ちる。修飾していなければ、
// 外部結合が内部結合になり、行が黙って欠ける。
//
// 見つけたのは、パーサを入れ替えるときの突き合わせで、文のトークンの境目に注釈を差し込んだとき (test/parser-oracle.test.ts、
// 2026-11-14)。入れ替える前から同じである。書き換えは前のパーサが結合の語を識別子として読めなかったための回避策で、今のパーサなら、
// 結合の語を SQLite と同じ位置で識別子として読めば要らなくなる (文面の書き換えをやめると、`SELECT left + 1` の列名が、いまの
// `"left" + 1` から SQLite と同じ `left + 1` に変わる。`FROM t left` のような、SQLite が断る別名は断るようになる)。
import { describe, expect, it } from "vitest";
import { diff } from "../diff";

describe("a comment between a join word and JOIN", () => {
  it("keeps the outer join, as SQLite does", async () => {
    const problems = await diff(`
      CREATE TABLE p (id INTEGER PRIMARY KEY, v TEXT);
      CREATE TABLE q (qid INTEGER PRIMARY KEY, p_id INTEGER);
      INSERT INTO p VALUES (1, 'a'), (2, 'b'), (3, 'c');
      INSERT INTO q VALUES (10, 1);
      SELECT id, qid FROM p LEFT /* keep every p */ JOIN q ON p_id = id ORDER BY 1;
      SELECT count(*) FROM p LEFT -- keep every p
        JOIN q ON p_id = id;
      SELECT p.id, q.qid FROM p LEFT /* keep every p */ OUTER JOIN q ON q.p_id = p.id ORDER BY 1;
    `, 2);
    expect(problems).toEqual([]);
  });
});
