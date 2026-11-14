// 式の木の深さ (DO の SQLite の上限の 1 つ。src/shard-limits.ts の SHARD_LIMITS.exprDepth)。
//
// SQLite は、式の節ごとに高さ (Expr.nHeight) を持つ。葉は 1 で、節は子の高さの最大に 1 を足したものである (expr.c の exprSetHeight)。
// 副問い合わせの節の高さには、中の式 (結果の列、WHERE、HAVING、LIMIT、GROUP BY、ORDER BY) の高さの最大が入る。名前を解決する
// ときは、外の式の高さに、副問い合わせの中の式の高さを足して確かめる (resolve.c の sqlite3ResolveExprNames)。どちらかが上限を
// 超えると「Expression tree is too large」で文が断られる。DO の SQLite の上限は 100 である (SQLite の既定は 1,000。公式の上限の
// 表にない。test/workerd-limits.test.ts)。2 項の演算子で n 個の項をつなぐと、高さは n になる。node:sqlite は上限を変えられないので、
// シミュレータでは見えない。
//
// ここでは、文の字句から、その深さを多めに見積もる。演算子の優先順位は parse.y のとおりに読む。SQLite が高さを数えない節
// (値の組 (a, b) の中身、BETWEEN の上端と下端、COLLATE の下) も数えるので、SQLite より大きく出ることはあるが、小さく出ないように
// 作ってある。sqlite3 3.45.1 の CLI (`.limit expr_depth`) と突き合わせて確かめた (2026-11-14)。D∞ が作る文の形 (行イメージの文、
// 走査、AND と OR の鎖) では一致するか 1 から 2 大きく、乱択の式 600 個では一度も小さくなかった。test/expression-depth.test.ts が
// その一部を持つ。見積もりは、表を作るときに D∞ が作る文を確かめるのに使う (Db.assertReplays)。利用者の文の判定には使っていない。
import { tokenize, type Token } from "./lexer";

const KEYWORDS = new Set([
  "SELECT", "FROM", "WHERE", "GROUP", "BY", "HAVING", "ORDER", "LIMIT", "OFFSET", "VALUES", "SET", "INSERT", "INTO", "UPDATE",
  "DELETE", "REPLACE", "RETURNING", "AS", "ON", "USING", "JOIN", "LEFT", "RIGHT", "INNER", "OUTER", "CROSS", "NATURAL", "FULL",
  "UNION", "ALL", "INTERSECT", "EXCEPT", "DISTINCT", "BEGIN", "END", "CREATE", "TRIGGER", "AFTER", "BEFORE", "INSTEAD", "OF",
  "FOR", "EACH", "ROW", "TABLE", "INDEX", "VIEW", "IF", "WITH", "RECURSIVE", "ASC", "DESC", "NULLS", "FIRST", "LAST", "DEFAULT",
  "CONFLICT", "DO", "NOTHING", "ABORT", "FAIL", "IGNORE", "ROLLBACK", "WINDOW", "OVER", "PARTITION", "FILTER", "PRIMARY", "KEY",
  "UNIQUE", "CHECK", "REFERENCES", "CONSTRAINT", "TEMP", "TEMPORARY", "EXPLAIN", "QUERY", "PLAN", "PRAGMA", "MATERIALIZED",
  "INDEXED", "WHEN", "THEN", "ELSE", "OR", "AND", "IS", "IN", "LIKE", "GLOB", "REGEXP", "MATCH", "BETWEEN", "ESCAPE", "COLLATE",
  "ISNULL", "NOTNULL", "WITHOUT", "ROWS", "RANGE", "GROUPS", "UNBOUNDED", "PRECEDING", "FOLLOWING", "CURRENT", "EXCLUDE", "TIES",
  "OTHERS", "NO", "DROP", "ALTER", "ADD", "COLUMN", "RENAME", "TO", "VIRTUAL", "ANALYZE", "VACUUM", "REINDEX", "ATTACH", "DETACH",
  "DATABASE", "SAVEPOINT", "RELEASE", "TRANSACTION", "COMMIT", "DEFERRED", "IMMEDIATE", "EXCLUSIVE", "DEFERRABLE", "INITIALLY",
  "AUTOINCREMENT", "STORED",
]);
/** 予約語の中で、関数の名前にもなるもの。後ろに開き括弧があれば関数の呼び出しである。 */
const FUNCTION_WORDS = new Set(["REPLACE", "LIKE", "GLOB", "MATCH", "REGEXP"]);

const BINARY: Record<string, number> = {
  "=": 4, "==": 4, "!=": 4, "<>": 4, "<": 5, "<=": 5, ">": 5, ">=": 5, "&": 7, "|": 7, "<<": 7, ">>": 7,
  "+": 8, "-": 8, "*": 9, "/": 9, "%": 9, "||": 10, "->": 10, "->>": 10,
};

/** 式の高さ。h は SQLite の Expr.nHeight、s は式の中の副問い合わせの式の、名前を解決するときの深さの最大。 */
interface H { h: number; s: number }
/** 文や副問い合わせの中の式の集まり。h と s は最大、d は h + s の最大。 */
interface Many { h: number; s: number; d: number }

const NONE: Many = { h: 0, s: 0, d: 0 };
const join = (a: Many, b: H): Many => ({ h: Math.max(a.h, b.h), s: Math.max(a.s, b.s), d: Math.max(a.d, b.h + b.s) });
const up = (...xs: H[]): H => ({ h: 1 + Math.max(0, ...xs.map((x) => x.h)), s: Math.max(0, ...xs.map((x) => x.s)) });
/** 副問い合わせを持つ節。SQLite は、名前を解決するとき、外の式の高さに副問い合わせの式の高さを足して確かめる (resolve.c)。 */
const withSelect = (sel: Many, ...xs: H[]): H => ({ h: 1 + Math.max(sel.h, ...xs.map((x) => x.h)), s: Math.max(sel.d, ...xs.map((x) => x.s)) });

/** 文の中の式の木の深さの見積もり。SQLite が数える深さより小さくはならない。 */
export function expressionDepth(sql: string): number {
  const t: Token[] = tokenize(sql);
  let i = 0;
  const peek = (k = 0): Token => t[Math.min(i + k, t.length - 1)]!;
  const isOp = (x: Token, text: string) => x.kind === "op" && x.text === text;
  const isWord = (x: Token, w: string) => x.kind === "word" && x.upper === w;
  const eof = () => peek().kind === "eof";
  const leaf: H = { h: 1, s: 0 };

  const startsExpr = (x: Token, next: Token): boolean => {
    if (x.kind === "number" || x.kind === "string" || x.kind === "blob" || x.kind === "param" || x.kind === "quoted") return true;
    if (x.kind === "op") return x.text === "(" || x.text === "-" || x.text === "+" || x.text === "~";
    if (x.kind === "word") return !KEYWORDS.has(x.upper) || (FUNCTION_WORDS.has(x.upper) && isOp(next, "("));
    return false;
  };

  // stop に当たるまでの文を読み、中の式を集める。stop の字句は読まない。
  const scan = (stop: (x: Token) => boolean): Many => {
    let all = NONE;
    while (!eof() && !stop(peek())) {
      const at = i;
      if (isWord(peek(), "LIMIT")) {
        // LIMIT と OFFSET の式は、TK_LIMIT の節の下にある (parse.y)。
        i++;
        const n = expr(0);
        if (isOp(peek(), ",") || isWord(peek(), "OFFSET")) {
          i++;
          all = join(all, up(n, expr(0)));
        } else all = join(all, up(n));
        continue;
      }
      if (startsExpr(peek(), peek(1))) all = join(all, expr(0));
      if (i === at) {
        if (isOp(peek(), "(")) all = join(all, primary());
        else i++;
      }
    }
    return all;
  };
  const closing = (x: Token) => isOp(x, ")");
  const itemEnd = (x: Token) => isOp(x, ")") || isOp(x, ",");
  /** 開き括弧の後から、閉じ括弧までの項目を読む。閉じ括弧を読む。 */
  const list = (): H[] => {
    const items: H[] = [];
    for (;;) {
      if (eof()) return items;
      if (isOp(peek(), ")")) {
        i++;
        return items;
      }
      if (isOp(peek(), ",")) {
        i++;
        continue;
      }
      const m = scan(itemEnd);
      items.push({ h: m.h, s: m.s });
    }
  };
  /** 開き括弧の後の副問い合わせを、閉じ括弧まで読む。 */
  const subquery = (): Many => {
    const m = scan(closing);
    if (isOp(peek(), ")")) i++;
    return m;
  };
  const isSelect = (x: Token) => isWord(x, "SELECT") || isWord(x, "WITH") || isWord(x, "VALUES");

  const primary = (): H => {
    const x = peek();
    if (x.kind === "number" || x.kind === "string" || x.kind === "blob" || x.kind === "param") {
      i++;
      return leaf;
    }
    if (isOp(x, "(")) {
      i++;
      if (isSelect(peek())) return withSelect(subquery());
      const items = list();
      // 括弧は節を作らない。値の組 (a, b) は TK_VECTOR の節になる (SQLite は中の項目を高さに数えないが、多めに数える)。
      return items.length === 1 ? items[0]! : up(...items);
    }
    if (isWord(x, "CASE")) {
      i++;
      const parts: H[] = [];
      if (!isWord(peek(), "WHEN")) parts.push(expr(0));
      while (isWord(peek(), "WHEN")) {
        i++;
        parts.push(expr(0));
        if (isWord(peek(), "THEN")) i++;
        parts.push(expr(0));
      }
      if (isWord(peek(), "ELSE")) {
        i++;
        parts.push(expr(0));
      }
      if (isWord(peek(), "END")) i++;
      return up(...parts);
    }
    if (x.kind === "word" && (x.upper === "CAST" || x.upper === "EXISTS" || x.upper === "RAISE") && isOp(peek(1), "(")) {
      i += 2;
      if (x.upper === "EXISTS") return withSelect(subquery());
      const m = scan(closing);
      if (isOp(peek(), ")")) i++;
      return x.upper === "RAISE" ? leaf : up({ h: m.h, s: m.s });
    }
    if (x.kind === "word" || x.kind === "quoted") {
      if (x.kind === "word" && KEYWORDS.has(x.upper) && !(FUNCTION_WORDS.has(x.upper) && isOp(peek(1), "("))) return { h: 0, s: 0 };
      i++;
      if (isOp(peek(), "(")) {
        i++;
        return up(...list());
      }
      // 修飾した名前 (t.c、s.t.c) は TK_DOT の節になる。
      let n = 1;
      while (isOp(peek(), ".")) {
        i++;
        if (peek().kind === "word" || peek().kind === "quoted") {
          i++;
          n++;
        } else {
          if (isOp(peek(), "*")) i++;
          break;
        }
      }
      return { h: n, s: 0 };
    }
    return { h: 0, s: 0 };
  };

  const unary = (): H => {
    const x = peek();
    if (x.kind === "op" && (x.text === "-" || x.text === "+" || x.text === "~")) {
      i++;
      return up(expr(12));
    }
    if (isWord(x, "NOT")) {
      i++;
      return up(expr(3));
    }
    return primary();
  };

  const expr = (min: number): H => {
    let left = unary();
    for (;;) {
      const x = peek();
      if (x.kind === "op" && BINARY[x.text] !== undefined) {
        const p = BINARY[x.text]!;
        if (p < min) break;
        i++;
        left = up(left, expr(p + 1));
        continue;
      }
      if (x.kind !== "word") break;
      let not = false;
      let w = x.upper;
      if (w === "NOT") {
        const n = peek(1);
        if (n.kind !== "word" || !["IN", "LIKE", "GLOB", "REGEXP", "MATCH", "BETWEEN", "NULL"].includes(n.upper)) break;
        not = true;
        w = n.upper;
      }
      const p = w === "OR" ? 1 : w === "AND" ? 2 : w === "COLLATE" ? 11
        : ["IS", "IN", "LIKE", "GLOB", "REGEXP", "MATCH", "BETWEEN", "ISNULL", "NOTNULL", "NULL"].includes(w) ? 4 : -1;
      if (p < 0 || p < min || (w === "NULL" && !not)) break;
      i += not ? 2 : 1;
      if (w === "NULL" || w === "ISNULL" || w === "NOTNULL") {
        left = up(left);
        continue;
      }
      if (w === "COLLATE") {
        i++;
        left = up(left);
        continue;
      }
      if (w === "IS") {
        if (isWord(peek(), "NOT")) i++;
        if (isWord(peek(), "DISTINCT")) i += 2;
        left = up(left, expr(p + 1));
        continue;
      }
      let node: H;
      if (w === "BETWEEN") {
        // 下端は AND の手前までの全部である (`x BETWEEN a = b AND c` の下端は a = b)。上端は BETWEEN より強い演算子だけを取る。
        const lo = expr(3);
        if (isWord(peek(), "AND")) i++;
        node = up(left, lo, expr(p + 1));
      } else if (w === "IN") {
        if (isOp(peek(), "(")) {
          i++;
          if (isSelect(peek())) node = withSelect(subquery(), left);
          else {
            const items = list();
            // `x IN (y)` は `x = +y` になる (parse.y)。単項の + の分だけ深い。
            node = items.length === 1 ? up(left, up(items[0]!)) : up(left, ...items);
          }
        } else {
          // `x IN 表` は `x IN (SELECT * FROM 表)` である。表の関数の引数も、副問い合わせの中の式として数える。
          const target = primary();
          node = withSelect({ h: target.h, s: target.s, d: target.h + target.s }, left);
        }
      } else if (w === "LIKE" || w === "GLOB" || w === "REGEXP" || w === "MATCH") {
        const right = expr(p + 1);
        if (isWord(peek(), "ESCAPE")) {
          i++;
          node = up(left, right, expr(p + 1));
        } else node = up(left, right);
      } else {
        node = up(left, expr(p + 1));
      }
      left = not ? up(node) : node;
    }
    return left;
  };

  return scan(() => false).d;
}
