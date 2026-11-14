// 結合の語 (LEFT、RIGHT、FULL、INNER、OUTER、CROSS、NATURAL) と JOIN の間に注釈があっても、結合の種類が変わらないこと。
//
// 2026-11-14 までは、解析の前の文面の書き換え (src/sql/cst.ts の preprocess) が、結合の語の後ろに、空白だけを挟んで JOIN などが
// 続くかを文面で見ていた。続かなければ、識別子として使われたものとして引用符で囲んだ。`p LEFT /* c */ JOIN q` は
// `p "LEFT" /* c */ JOIN q` になり、表 p に LEFT という別名を付けた内部結合として読まれた。列を表の名前で修飾していれば
// no such column で落ち、修飾していなければ、外部結合が内部結合になって、行が黙って欠けた。
//
// 見つけたのは、パーサを入れ替えるときの突き合わせで、文のトークンの境目に注釈を差し込んだとき (test/parser-oracle.test.ts)。
// 書き換えは消した。結合の語を識別子として読むかどうかは、パーサが、語のある場所で決める (src/sql/parser.ts の JOIN_WORDS)。
// これは、見つけたときの再現である。書き換えが受け持っていた構文の全部は、test/contextual-words.test.ts が確かめる。
import { describe, expect, it } from "vitest";
import { diff } from "./diff";

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
