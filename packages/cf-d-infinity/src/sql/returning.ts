// 利用者の RETURNING を、項ごとに要素の式へ書き換える (docs/design-values.md の「利用者の RETURNING」)。
//
// DML はサブクエリに置けないので、SELECT のように文全体を包んで読むことができない。そこで RETURNING の項を 1 つずつ、値を型ごと
// 正確に運ぶ式 (要素の式) に書き換える。
//   - 列の参照 (`c`、`t.c`) は、列にそのまま要素の式を掛ける。列の参照は何度評価しても同じ値である。
//   - `*` と `表.*` は、表定義の列の順に開いて、列ごとに要素の式を掛ける (SQLite の RETURNING の `*` と同じく、宣言した列だけ)。
//   - ほかの式 e は `(SELECT <"x" の要素の式> FROM (SELECT e AS "x" LIMIT -1 OFFSET 0))` にする。要素の式は値を何度も参照するので、
//     `random()` のような式が参照のたびに評価されないよう、`LIMIT -1 OFFSET 0` で 1 回の評価に固める。
// 別名は落とす。結果の列名は、書き換える前の文を SQLite にコンパイルさせて取る (列名を SQLite 以外が決める場所を増やさない)。
//
// 構文木を書き換えるだけの関数で、文をどこで実行するかは知らない。プランナ (src/sql/plan.ts) と、SQLite との突き合わせの基準
// (test/typed-diff-harness.ts) が使う。引数の節は元の木のまま残すので、render が引数を元の順に拾う。
import type { Node } from "./parser";
import { text } from "./cst";

const q = (id: string) => `"${id.replaceAll('"', '""')}"`;

/** 列の参照か (`c`、`t.c`、`s.t.c`)。 */
function isColumnRef(n: Node): boolean {
  if (n?.type === "identifier") return true;
  return n?.type === "member_expr" && n.property?.type === "identifier" && isColumnRef(n.object);
}

/**
 * RETURNING の節 (returning_clause) の項を、その場で書き換える。columns は、文が書く表の、宣言した列の順の名前である (`*` を開く)。
 * elem は、列の参照 1 つから要素の式を作る関数である。書き換えた後の項の数 (結果の列の数) を返す。
 */
export function rewriteReturning(clause: Node, columns: readonly string[], elem: (c: string) => string): number {
  const items: Node[] = clause.columns.items;
  const out: Node[] = [];
  for (const item of items) {
    const e = item.type === "alias" ? item.expr : item;
    const term = (parts: unknown[], first: boolean) => out.push({ type: "returning_term", leading: first ? item.leading ?? " " : " ", parts, range: item.range });
    if (e.type === "all_columns" || (e.type === "member_expr" && e.property?.type === "all_columns")) {
      const prefix = e.type === "member_expr" ? `${text(e.object)}.` : "";
      columns.forEach((c, i) => term([elem(`${prefix}${q(c)}`)], i === 0));
    } else if (isColumnRef(e)) {
      term([elem(text(e))], true);
    } else {
      // 式の節はそのまま持つ。引数 (`?`) の節が木に残るので、render が値を拾う。
      term([`(SELECT ${elem('"x"')} FROM (SELECT `, { ...e, leading: undefined, trailing: undefined }, ` AS "x" LIMIT -1 OFFSET 0))`], true);
    }
  }
  clause.columns = { type: "list_expr", items: out, range: clause.columns.range };
  return out.length;
}

/** 文の RETURNING の節。なければ null。 */
export const returningClause = (stmt: Node): Node | null =>
  ((stmt?.clauses ?? []) as Node[]).find((c) => c.type === "returning_clause") ?? null;
