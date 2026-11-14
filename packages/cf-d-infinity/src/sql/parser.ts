// SQLite の方言の構文解析。文法は SQLite の parse.y と文書 (lang_*.html) に合わせる。手書きの再帰下降で、依存はない。
//
// 木の形 (節の type と欄の名前) は、計画の組み立て (plan.ts)、DDL の解釈 (ddl.ts)、Db (client/db.ts) が読む形である。
// 2026-11-14 まで使っていたパーサ (sql-parser-cst) の木と同じ形にしてある。形を変えると、文の経路が黙って変わる
// (たとえば、ORDER BY の項は、識別子だけなら識別子そのもの、それ以外は sort_specification で包む。上位 N 件の押し下げは、
// この違いを見ている)。形の見本は test/parser.test.ts、前のパーサとの突き合わせは test/parser-oracle.test.ts にある。
// 欄は、文面に現れる順に作る。出し直し (printer.ts) が、欄を作った順にたどるからである。
// 空白と注釈は、次のトークンが葉 (予約語、識別子、literal、引数) ならその葉の leading に、記号 (`(` `)` `,` `.` と
// 記号の演算子) なら、直前に読み終えた節の trailing に付ける。節を配列から外すと、その節の前後の空白も一緒に消える。
import { SqlError } from "../types";
import { tokenize, unquote, type Token } from "./lexer";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Node = any;

/**
 * 識別子に使えない語。SQLite の予約語から、parse.y の %fallback ID (識別子としても読める語) を除いたものに、
 * 結合の語 (LEFT など) と INDEXED を加えたものである。結合の語を識別子に使った文は、解析の前に引用符で囲む (cst.ts)。
 */
const RESERVED = new Set(`ADD ALL ALTER AND AS AUTOINCREMENT BETWEEN CASE CHECK COLLATE COMMIT CONSTRAINT CREATE CROSS DEFAULT
  DEFERRABLE DELETE DISTINCT DROP ELSE ESCAPE EXCEPT EXISTS FOREIGN FROM FULL GROUP HAVING IN INDEX INDEXED INNER INSERT
  INTERSECT INTO IS ISNULL JOIN LEFT LIMIT NATURAL NOT NOTHING NOTNULL NULL ON OR ORDER OUTER PRIMARY REFERENCES RETURNING
  RIGHT SELECT SET TABLE THEN TO TRANSACTION UNION UNIQUE UPDATE USING VALUES WHEN WHERE`.split(/\s+/));

const JOIN_WORDS = new Set(["NATURAL", "LEFT", "RIGHT", "FULL", "OUTER", "INNER", "CROSS"]);
const CONFLICT_ACTIONS = new Set(["ROLLBACK", "ABORT", "FAIL", "IGNORE", "REPLACE"]);
const LIKE_WORDS = new Set(["LIKE", "GLOB", "REGEXP", "MATCH"]);
/** 列の定義で、型の名前を終わらせる語 (列の制約の先頭)。 */
const COLUMN_CONSTRAINT_START = new Set(["CONSTRAINT", "PRIMARY", "NOT", "NULL", "UNIQUE", "CHECK", "DEFAULT", "COLLATE", "REFERENCES", "GENERATED", "AS"]);

/** 演算子の強さ。SQLite の parse.y の %left と %right の順である (ESCAPE は LIKE の中で読むので、ここにはない)。 */
const PREC = { or: 1, and: 2, not: 3, equality: 4, relational: 5, bitwise: 7, additive: 8, multiplicative: 9, concat: 10, collate: 11, unary: 12 };
const SYMBOL_PREC: Record<string, number> = {
  "=": PREC.equality, "==": PREC.equality, "!=": PREC.equality, "<>": PREC.equality,
  "<": PREC.relational, "<=": PREC.relational, ">": PREC.relational, ">=": PREC.relational,
  "&": PREC.bitwise, "|": PREC.bitwise, "<<": PREC.bitwise, ">>": PREC.bitwise,
  "+": PREC.additive, "-": PREC.additive, "*": PREC.multiplicative, "/": PREC.multiplicative, "%": PREC.multiplicative,
  "||": PREC.concat, "->": PREC.concat, "->>": PREC.concat,
};

/** 語が 1 つならその節、2 つ以上なら節の配列 (`IS` と `IS NOT`、`JOIN` と `LEFT JOIN`)。 */
const one = <T>(xs: T[]): T | T[] => (xs.length === 1 ? xs[0]! : xs);

class Parser {
  private i = 0;
  private readonly toks: Token[];

  constructor(private readonly source: string) {
    this.toks = tokenize(source);
  }

  // ---- トークンの読み方 ----

  private get t(): Token {
    return this.toks[this.i]!;
  }

  private at(k: number): Token {
    return this.toks[Math.min(this.i + k, this.toks.length - 1)]!;
  }

  /** 直前に読んだトークンの終わりの位置。節の range の終わりに使う。 */
  private get last(): number {
    return this.toks[this.i - 1]!.end;
  }

  private fail(tok: Token = this.t): never {
    throw new SqlError(tok.kind === "eof" ? "incomplete input" : `near "${tok.text}": syntax error`);
  }

  private isKw(word: string, k = 0): boolean {
    const t = this.at(k);
    return t.kind === "word" && t.upper === word;
  }

  private isOp(op: string, k = 0): boolean {
    const t = this.at(k);
    return t.kind === "op" && t.text === op;
  }

  /** 識別子として読めるトークンか。引用した識別子と、予約語でない語である。 */
  private isName(k = 0): boolean {
    const t = this.at(k);
    return t.kind === "quoted" || (t.kind === "word" && !RESERVED.has(t.upper));
  }

  private leaf(type: string, tok: Token, fields: Record<string, unknown>): Node {
    const n: Node = { type, ...fields, range: [tok.start, tok.end] };
    if (tok.ws) n.leading = tok.ws;
    return n;
  }

  /** 語を予約語として読む。word を渡すと、その語でなければ構文の誤りにする。 */
  private kw(word?: string): Node {
    const tok = this.t;
    if (tok.kind !== "word" || (word !== undefined && tok.upper !== word)) this.fail();
    this.i++;
    return this.leaf("keyword", tok, { text: tok.text, name: tok.upper });
  }

  private kws(...words: string[]): Node[] {
    return words.map((w) => this.kw(w));
  }

  private kwIf(word: string): Node | undefined {
    return this.isKw(word) ? this.kw() : undefined;
  }

  /** 記号を読む。直前の空白と注釈は、読み終えた節 prev の trailing に付ける。 */
  private op(text: string, prev: Node): void {
    const tok = this.t;
    if (tok.kind !== "op" || tok.text !== text) this.fail();
    this.i++;
    if (tok.ws) prev.trailing = (prev.trailing ?? "") + tok.ws;
  }

  /** 記号の演算子を読み、その文面を返す。 */
  private symbol(prev: Node): string {
    const tok = this.t;
    this.op(tok.text, prev);
    return tok.text;
  }

  private identifier(): Node {
    const tok = this.t;
    if (!this.isName()) this.fail();
    this.i++;
    return this.leaf("identifier", tok, { text: tok.text, name: tok.kind === "quoted" ? unquote(tok.text) : tok.text });
  }

  /** 別名と照合順序の名前。識別子のほかに、文字列の literal も書ける (`SELECT a 'x'`)。 */
  private aliasName(): Node {
    const tok = this.t;
    if (tok.kind !== "string") return this.identifier();
    this.i++;
    return this.leaf("identifier", tok, { text: tok.text, name: unquote(tok.text) });
  }

  /** `名前` か `スキーマ.名前`。parts は、`.` でつなげる名前の数の上限である。 */
  private qualifiedName(parts = 2): Node {
    let n = this.identifier();
    for (let k = 1; k < parts && this.isOp("."); k++) {
      this.op(".", n);
      const property = this.identifier();
      n = { type: "member_expr", object: n, property, range: [n.range[0], property.range[1]] };
    }
    return n;
  }

  /** `( 中身 )`。 */
  private paren(inner: () => Node): Node {
    const open = this.t;
    if (!this.isOp("(")) this.fail();
    this.i++;
    const expr = inner();
    this.op(")", expr);
    const n: Node = { type: "paren_expr", expr, range: [open.start, this.last] };
    if (open.ws) n.leading = open.ws;
    return n;
  }

  /** `項目, 項目, ...`。emptyOk なら、閉じる括弧の前の 0 個も読む。 */
  private list(item: () => Node, emptyOk = false): Node {
    const start = this.t.start;
    const items: Node[] = [];
    if (!(emptyOk && this.isOp(")"))) {
      items.push(item());
      while (this.isOp(",")) {
        this.op(",", items[items.length - 1]);
        items.push(item());
      }
    }
    return { type: "list_expr", items, range: items.length ? [items[0].range[0], this.last] : [start, start] };
  }

  private node(type: string, start: number, fields: Record<string, unknown>): Node {
    return { type, ...fields, range: [start, this.last] };
  }

  // ---- 式 ----
  // 優先順位は SQLite の parse.y のとおりである (PREC)。演算子の強さで左辺を伸ばしていく (precedence climbing)。yacc の優先順位と
  // 同じ読み方になる: 閉じた形 (`x IN (...)`、`x ISNULL`) の後ろには、それより強い演算子も続けられる (`a IN (1, 2) || 'x'`)。

  /** 式。強さが minPrec に満たない演算子の手前で止まる。 */
  expr(minPrec: number = PREC.or): Node {
    let left = this.prefix();
    for (;;) {
      const t = this.t;
      if (t.kind === "op") {
        const prec = SYMBOL_PREC[t.text];
        if (prec === undefined || prec < minPrec) return left;
        left = this.binary(left, this.symbol(left), this.expr(prec + 1));
        continue;
      }
      if (t.kind !== "word") return left;
      const not = t.upper === "NOT";
      const word = not ? this.at(1).upper : t.upper;
      if (!not && (word === "OR" || word === "AND")) {
        const prec = word === "OR" ? PREC.or : PREC.and;
        if (prec < minPrec) return left;
        left = this.binary(left, this.kw(), this.expr(prec + 1));
      } else if (!not && word === "COLLATE") {
        if (PREC.collate < minPrec) return left;
        left = this.binary(left, this.kw(), this.aliasName());
      } else if (PREC.equality < minPrec) {
        return left;
      } else if (!not && word === "IS") {
        const ks = [this.kw()];
        if (this.isKw("NOT")) ks.push(this.kw());
        if (this.isKw("DISTINCT") && this.isKw("FROM", 1)) ks.push(this.kw(), this.kw());
        left = this.binary(left, one(ks), this.expr(PREC.equality + 1));
      } else if (!not && (word === "ISNULL" || word === "NOTNULL")) {
        left = this.node("postfix_op_expr", left.range[0], { expr: left, operator: this.kw() });
      } else if (not && word === "NULL") {
        left = this.node("postfix_op_expr", left.range[0], { expr: left, operator: this.kws("NOT", "NULL") });
      } else if (word === "IN") {
        const operator = one(not ? [this.kw(), this.kw()] : [this.kw()]);
        left = this.binary(left, operator, this.inOperand());
      } else if (LIKE_WORDS.has(word)) {
        const operator = one(not ? [this.kw(), this.kw()] : [this.kw()]);
        let right = this.expr(PREC.equality + 1);
        // ESCAPE は、LIKE の右辺に掛かる 2 項の演算子として持つ。
        if (this.isKw("ESCAPE")) right = this.binary(right, this.kw(), this.expr(PREC.equality + 1));
        left = this.binary(left, operator, right);
      } else if (word === "BETWEEN") {
        const betweenKw = one(not ? [this.kw(), this.kw()] : [this.kw()]);
        // 下限は AND の手前まで、上限は等値の仲間より強い式である。
        const begin = this.expr(PREC.not);
        const andKw = this.kw("AND");
        const end = this.expr(PREC.equality + 1);
        left = { type: "between_expr", left, betweenKw, begin, andKw, end, range: [left.range[0], end.range[1]] };
      } else return left;
    }
  }

  private binary(left: Node, operator: unknown, right: Node): Node {
    return { type: "binary_expr", left, operator, right, range: [left.range[0], right.range[1]] };
  }

  /** 前置の演算子 (- + ~ NOT) の付いた式か、演算子のない式。 */
  private prefix(): Node {
    const t = this.t;
    if (t.kind === "op" && (t.text === "-" || t.text === "+" || t.text === "~")) {
      this.i++;
      const expr = this.expr(PREC.unary);
      const n: Node = { type: "prefix_op_expr", operator: t.text, expr, range: [t.start, expr.range[1]] };
      if (t.ws) n.leading = t.ws;
      return n;
    }
    if (this.isKw("NOT")) {
      const operator = this.kw();
      const expr = this.expr(PREC.equality);
      return this.node("prefix_op_expr", t.start, { operator, expr });
    }
    return this.primary();
  }

  /** IN の右辺。括弧の中の並びかサブクエリ、表の名前、表を返す関数の呼び出し。 */
  private inOperand(): Node {
    if (this.isOp("(")) {
      // 空の並び (`x IN ()`) は読まない。解析の前に、常に偽のサブクエリへ書き換えてある (cst.ts)。
      return this.paren(() => (this.startsSelect() ? this.select() : this.list(() => this.expr())));
    }
    const name = this.qualifiedName();
    return this.isOp("(") ? this.call(name) : name;
  }

  private startsSelect(k = 0): boolean {
    return this.isKw("SELECT", k) || this.isKw("VALUES", k) || this.isKw("WITH", k);
  }

  private primary(): Node {
    const t = this.t;
    switch (t.kind) {
      case "number":
        this.i++;
        return this.leaf("number_literal", t, { text: t.text, value: Number(t.text.replaceAll("_", "")) });
      case "string":
        this.i++;
        return this.leaf("string_literal", t, { text: t.text, value: unquote(t.text) });
      case "blob": {
        this.i++;
        const hex = t.text.slice(2, -1);
        const value: number[] = [];
        for (let k = 0; k < hex.length; k += 2) value.push(Number.parseInt(hex.slice(k, k + 2), 16));
        return this.leaf("blob_literal", t, { text: t.text, value });
      }
      case "param":
        this.i++;
        return this.leaf("parameter", t, { text: t.text });
      case "op":
        if (t.text === "(") {
          // 括弧の中は、サブクエリ、1 つの式、行の値 (式の並び) のどれかである。
          return this.paren(() => {
            if (this.startsSelect()) return this.select();
            const l = this.list(() => this.expr());
            return l.items.length === 1 ? l.items[0] : l;
          });
        }
        return this.fail();
      case "quoted":
        return this.named();
      case "word":
        break;
      default:
        return this.fail();
    }
    const start = t.start;
    switch (t.upper) {
      case "NULL":
        return this.node("null_literal", start, { nullKw: this.kw(), value: null });
      case "TRUE":
      case "FALSE":
        if (this.isOp("(", 1) || this.isOp(".", 1)) break;
        return this.node("boolean_literal", start, { valueKw: this.kw(), value: t.upper === "TRUE" });
      case "CURRENT_DATE":
      case "CURRENT_TIME":
      case "CURRENT_TIMESTAMP":
        if (this.isOp("(", 1) || this.isOp(".", 1)) break;
        return this.node("func_call", start, { name: this.identifier() });
      case "CASE": {
        const caseKw = this.kw();
        const expr = this.isKw("WHEN") ? undefined : this.expr();
        const clauses: Node[] = [];
        while (this.isKw("WHEN")) {
          const s = this.t.start;
          clauses.push(this.node("case_when", s, { whenKw: this.kw(), condition: this.expr(), thenKw: this.kw("THEN"), result: this.expr() }));
        }
        if (clauses.length === 0) this.fail();
        if (this.isKw("ELSE")) {
          const s = this.t.start;
          clauses.push(this.node("case_else", s, { elseKw: this.kw(), result: this.expr() }));
        }
        return this.node("case_expr", start, { caseKw, expr, clauses, endKw: this.kw("END") });
      }
      case "CAST": {
        // 式の先頭の CAST と RAISE は、SQLite では識別子として読まれない。
        if (!this.isOp("(", 1)) this.fail();
        const castKw = this.kw();
        const args = this.paren(() => {
          const s = this.t.start;
          return this.node("cast_arg", s, { expr: this.expr(), asKw: this.kw("AS"), dataType: this.dataType() });
        });
        return this.node("cast_expr", start, { castKw, args });
      }
      case "EXISTS": {
        const operator = this.kw();
        if (!this.isOp("(") || !this.startsSelect(1)) this.fail();
        const expr = this.paren(() => this.select());
        return this.node("prefix_op_expr", start, { operator, expr });
      }
      case "RAISE": {
        if (!this.isOp("(", 1)) this.fail();
        const raiseKw = this.kw();
        const args = this.paren(() => {
          const s = this.t.start;
          if (!this.isKw("IGNORE") && !CONFLICT_ACTIONS.has(this.t.upper)) this.fail();
          const ignore = this.isKw("IGNORE");
          const type = this.node("raise_expr_type", s, { typeKw: this.kw() });
          const items = [type];
          if (!ignore) {
            this.op(",", type);
            items.push(this.expr());
          }
          return { type: "list_expr", items, range: [s, this.last] };
        });
        return this.node("raise_expr", start, { raiseKw, args });
      }
      default:
        break;
    }
    if (RESERVED.has(t.upper)) this.fail();
    return this.named();
  }

  /** 識別子で始まる式。列の参照 (`a`、`t.a`、`s.t.a`) か、関数の呼び出し。 */
  private named(): Node {
    const n = this.qualifiedName(3);
    return n.type === "identifier" && this.isOp("(") ? this.call(n) : n;
  }

  private star(): Node {
    const star = this.t;
    if (!this.isOp("*")) this.fail();
    this.i++;
    return this.leaf("all_columns", star, {});
  }

  /** 関数の呼び出しの、名前より後ろ。引数、FILTER、OVER。 */
  private call(name: Node): Node {
    const args = this.paren(() => {
      const s = this.t.start;
      const distinctKw = this.isKw("DISTINCT") ? this.kw() : undefined;
      // `*` は、ただ 1 つの引数としてだけ書ける (`count(*)`)。
      const list = !distinctKw && this.isOp("*") && this.isOp(")", 1) ? this.list(() => this.star()) : this.list(() => this.expr(), !distinctKw);
      // 集約の引数の並び順 (`group_concat(a ORDER BY b)`)。
      const orderBy = this.isKw("ORDER") ? this.orderBy() : undefined;
      return this.node("func_args", s, { distinctKw, args: list, orderBy });
    });
    let filter: Node | undefined;
    let over: Node | undefined;
    // FILTER と OVER は、関数の閉じる括弧の直後で、後ろが括弧 (OVER は名前でもよい) のときだけ予約語である。
    if (this.isKw("FILTER") && this.isOp("(", 1)) {
      const s = this.t.start;
      const filterKw = this.kw();
      const where = this.paren(() => {
        const ws = this.t.start;
        return this.node("where_clause", ws, { whereKw: this.kw("WHERE"), expr: this.expr() });
      });
      filter = this.node("filter_arg", s, { filterKw, where });
    }
    if (this.isKw("OVER") && (this.isOp("(", 1) || this.isName(1))) {
      const s = this.t.start;
      const overKw = this.kw();
      const window = this.isOp("(") ? this.paren(() => this.windowDefinition()) : this.identifier();
      over = this.node("over_arg", s, { overKw, window });
    }
    return this.node("func_call", name.range[0], { name, args, filter, over });
  }

  private windowDefinition(): Node {
    const start = this.t.start;
    const clauseStart = (k: number): boolean =>
      this.isOp(")", k) || (this.isKw("PARTITION", k) && this.isKw("BY", k + 1)) || (this.isKw("ORDER", k) && this.isKw("BY", k + 1))
      || this.isKw("ROWS", k) || this.isKw("RANGE", k) || this.isKw("GROUPS", k);
    // 先頭の名前は、元にする window の名前である。句の先頭の語と同じ名前でも、後ろに句が続けば名前として読む。
    const baseWindowName = this.isName() && (!clauseStart(0) || clauseStart(1)) && !this.isKw("ORDER") ? this.identifier() : undefined;
    let partitionBy: Node | undefined;
    if (this.isKw("PARTITION")) {
      const s = this.t.start;
      partitionBy = this.node("partition_by_clause", s, { partitionByKw: this.kws("PARTITION", "BY"), specifications: this.list(() => this.expr()) });
    }
    const orderBy = this.isKw("ORDER") ? this.orderBy() : undefined;
    let frame: Node | undefined;
    if (this.isKw("ROWS") || this.isKw("RANGE") || this.isKw("GROUPS")) {
      const s = this.t.start;
      const unitKw = this.kw();
      let extent: Node;
      if (this.isKw("BETWEEN")) {
        const bs = this.t.start;
        extent = this.node("frame_between", bs, { betweenKw: this.kw(), begin: this.frameBound(), andKw: this.kw("AND"), end: this.frameBound() });
      } else extent = this.frameBound();
      let exclusion: Node | undefined;
      if (this.isKw("EXCLUDE")) {
        const es = this.t.start;
        const excludeKw = this.kw();
        const kindKw = this.isKw("NO") ? this.kws("NO", "OTHERS") : this.isKw("CURRENT") ? this.kws("CURRENT", "ROW") : this.isKw("GROUP") ? this.kw() : this.kw("TIES");
        exclusion = this.node("frame_exclusion", es, { excludeKw, kindKw });
      }
      frame = this.node("frame_clause", s, { unitKw, extent, exclusion });
    }
    return this.node("window_definition", start, { baseWindowName, partitionBy, orderBy, frame });
  }

  private frameBound(): Node {
    const s = this.t.start;
    if (this.isKw("CURRENT") && this.isKw("ROW", 1)) return this.node("frame_bound_current_row", s, { currentRowKw: this.kws("CURRENT", "ROW") });
    const expr = this.isKw("UNBOUNDED") ? this.node("frame_unbounded", s, { unboundedKw: this.kw() }) : this.expr();
    if (this.isKw("PRECEDING")) return this.node("frame_bound_preceding", s, { expr, precedingKw: this.kw() });
    return this.node("frame_bound_following", s, { expr, followingKw: this.kw("FOLLOWING") });
  }

  /** 型の名前の語か。列の制約の先頭の語と、予約語は、型の名前にならない。 */
  private isTypeWord(): boolean {
    const t = this.t;
    return t.kind === "word" && !COLUMN_CONSTRAINT_START.has(t.upper) && !RESERVED.has(t.upper);
  }

  /**
   * 型の名前。語の並びと、括弧の中の 1 つか 2 つの数。
   * 引用した名前 (`"INTEGER"`、`'my type'`) は、SQLite は読むが、ここでは読まない。ddl.ts は型の名前の文面で rowid の別名と
   * 型の親和性を決めるので、引用符の付いた文面を渡すと、`id "INTEGER" PRIMARY KEY` を別名と見なさない。
   */
  private dataType(): Node {
    const start = this.t.start;
    const words: Node[] = [];
    while (this.isTypeWord()) words.push(this.kw());
    if (words.length === 0) this.fail();
    const params = this.isOp("(") ? this.paren(() => this.list(() => this.signedNumber())) : undefined;
    return params ? this.node("named_data_type", start, { name: one(words), params }) : this.node("named_data_type", start, { name: one(words) });
  }

  /** 数と、符号を 1 つ付けた数。 */
  private signedNumber(): Node {
    const t = this.t;
    if (t.kind === "op" && (t.text === "-" || t.text === "+")) {
      this.i++;
      if (this.at(0).kind !== "number") this.fail();
      const expr = this.primary();
      const n: Node = { type: "prefix_op_expr", operator: t.text, expr, range: [t.start, expr.range[1]] };
      if (t.ws) n.leading = t.ws;
      return n;
    }
    if (t.kind !== "number") this.fail();
    return this.primary();
  }

  // ---- SELECT ----

  /** SELECT か VALUES の文。UNION などでつないだものと、先頭の WITH も読む。 */
  select(withClause?: Node): Node {
    const leading = withClause ?? (this.isKw("WITH") ? this.withClause() : undefined);
    let left = this.selectCore(leading);
    for (;;) {
      let operator: Node | Node[];
      if (this.isKw("UNION")) operator = this.isKw("ALL", 1) ? this.kws("UNION", "ALL") : this.kw();
      else if (this.isKw("INTERSECT") || this.isKw("EXCEPT")) operator = this.kw();
      else break;
      const right = this.selectCore();
      left = { type: "compound_select_stmt", left, operator, right, range: [left.range[0], right.range[1]] };
    }
    // ORDER BY と LIMIT は文の全体に掛かるが、木では最後の SELECT の句として持つ。
    // VALUES で終わる文には付けられない。
    const lastCore = left.type === "compound_select_stmt" ? left.right : left;
    if (lastCore.clauses[lastCore.clauses.length - 1].type === "values_clause") return left;
    if (this.isKw("ORDER")) lastCore.clauses.push(this.orderBy());
    if (this.isKw("LIMIT")) lastCore.clauses.push(this.limit());
    lastCore.range[1] = this.last;
    left.range[1] = this.last;
    return left;
  }

  private selectCore(withClause?: Node): Node {
    const start = withClause ? withClause.range[0] : this.t.start;
    const clauses: Node[] = withClause ? [withClause] : [];
    if (this.isKw("VALUES")) {
      clauses.push(this.valuesClause());
      return this.node("select_stmt", start, { clauses });
    }
    const s = this.t.start;
    const selectKw = this.kw("SELECT");
    const modifiers: Node[] = [];
    if (this.isKw("DISTINCT")) modifiers.push(this.node("select_distinct", this.t.start, { distinctKw: this.kw() }));
    else if (this.isKw("ALL")) modifiers.push(this.node("select_all", this.t.start, { allKw: this.kw() }));
    const columns = this.list(() => this.resultColumn());
    clauses.push(this.node("select_clause", s, { selectKw, modifiers, columns }));
    if (this.isKw("FROM")) {
      const fs = this.t.start;
      clauses.push(this.node("from_clause", fs, { fromKw: this.kw(), expr: this.joinTree() }));
    }
    if (this.isKw("WHERE")) clauses.push(this.where());
    if (this.isKw("GROUP")) {
      const gs = this.t.start;
      clauses.push(this.node("group_by_clause", gs, { groupByKw: this.kws("GROUP", "BY"), columns: this.list(() => this.expr()) }));
    }
    if (this.isKw("HAVING")) {
      const hs = this.t.start;
      clauses.push(this.node("having_clause", hs, { havingKw: this.kw(), expr: this.expr() }));
    }
    if (this.isWindowKw()) {
      const ws = this.t.start;
      const windowKw = this.kw();
      const namedWindows = this.list(() => {
        const ns = this.t.start;
        return this.node("named_window", ns, { name: this.identifier(), asKw: this.kw("AS"), window: this.paren(() => this.windowDefinition()) });
      });
      clauses.push(this.node("window_clause", ws, { windowKw, namedWindows }));
    }
    return this.node("select_stmt", start, { clauses });
  }

  /** WINDOW は、後ろに `名前 AS` が続くときだけ予約語である (SQLite の字句解析と同じ決め方)。 */
  private isWindowKw(): boolean {
    return this.isKw("WINDOW") && this.isName(1) && this.isKw("AS", 2);
  }

  /** 結果の列。`*`、`表.*`、式とその別名。 */
  private resultColumn(): Node {
    if (this.isOp("*")) return this.star();
    if (this.isName() && this.isOp(".", 1) && this.isOp("*", 2)) {
      const object = this.identifier();
      this.op(".", object);
      const property = this.star();
      return { type: "member_expr", object, property, range: [object.range[0], property.range[1]] };
    }
    return this.aliased(this.expr(), true);
  }

  /** `式 AS 別名`。implicit なら、AS のない `式 別名` も読む。 */
  private aliased(expr: Node, implicit: boolean): Node {
    if (this.isKw("AS")) return this.node("alias", expr.range[0], { expr, asKw: this.kw(), alias: this.aliasName() });
    if (implicit && (this.isName() || this.t.kind === "string") && !this.isWindowKw()) {
      return this.node("alias", expr.range[0], { expr, alias: this.aliasName() });
    }
    return expr;
  }

  private where(): Node {
    const s = this.t.start;
    return this.node("where_clause", s, { whereKw: this.kw("WHERE"), expr: this.expr() });
  }

  private valuesClause(): Node {
    const s = this.t.start;
    return this.node("values_clause", s, {
      valuesKw: this.kw("VALUES"),
      values: this.list(() => this.paren(() => this.list(() => this.expr()))),
    });
  }

  private orderBy(): Node {
    const s = this.t.start;
    return this.node("order_by_clause", s, { orderByKw: this.kws("ORDER", "BY"), specifications: this.list(() => this.orderingTerm()) });
  }

  /** 並び順の 1 項。方向の指定のない識別子だけの項は、識別子そのものを項にする。それ以外は sort_specification で包む。 */
  private orderingTerm(): Node {
    const expr = this.expr();
    const direction = this.direction();
    const nullHandlingKw = this.isKw("NULLS") && (this.isKw("FIRST", 1) || this.isKw("LAST", 1)) ? [this.kw(), this.kw()] : undefined;
    if (expr.type === "identifier" && !direction && !nullHandlingKw) return expr;
    return nullHandlingKw
      ? this.node("sort_specification", expr.range[0], { expr, direction, nullHandlingKw })
      : this.node("sort_specification", expr.range[0], { expr, direction });
  }

  private direction(): Node | undefined {
    const s = this.t.start;
    if (this.isKw("ASC")) return this.node("sort_direction_asc", s, { ascKw: this.kw() });
    if (this.isKw("DESC")) return this.node("sort_direction_desc", s, { descKw: this.kw() });
    return undefined;
  }

  private limit(): Node {
    const s = this.t.start;
    const limitKw = this.kw("LIMIT");
    const first = this.expr();
    if (this.isKw("OFFSET")) return this.node("limit_clause", s, { limitKw, count: first, offsetKw: this.kw(), offset: this.expr() });
    if (this.isOp(",")) {
      // `LIMIT 飛ばす数, 件数`。
      this.op(",", first);
      return this.node("limit_clause", s, { limitKw, offset: first, count: this.expr() });
    }
    return this.node("limit_clause", s, { limitKw, count: first });
  }

  private withClause(): Node {
    const s = this.t.start;
    const withKw = this.kw("WITH");
    const recursiveKw = this.isKw("RECURSIVE") && this.isName(1) ? this.kw() : undefined;
    const tables = this.list(() => {
      const cs = this.t.start;
      const table = this.identifier();
      const columns = this.isOp("(") ? this.paren(() => this.list(() => this.identifier())) : undefined;
      const asKw = this.kw("AS");
      const materializedKw = this.isKw("NOT") ? this.kws("NOT", "MATERIALIZED") : this.isKw("MATERIALIZED") ? this.kw() : undefined;
      const expr = this.paren(() => this.select());
      return this.node("common_table_expr", cs, { table, columns, asKw, materializedKw, expr });
    });
    return this.node("with_clause", s, { withKw, recursiveKw, tables });
  }

  // ---- FROM ----

  private joinTree(): Node {
    let left = this.tableOrSubquery();
    for (;;) {
      let operator: unknown;
      if (this.isOp(",")) operator = this.symbol(left);
      else if (this.isKw("JOIN")) operator = this.kw();
      else if (this.t.kind === "word" && JOIN_WORDS.has(this.t.upper)) {
        const ks: Node[] = [];
        while (this.t.kind === "word" && JOIN_WORDS.has(this.t.upper) && ks.length < 3) ks.push(this.kw());
        ks.push(this.kw("JOIN"));
        operator = ks;
      } else return left;
      const right = this.tableOrSubquery();
      let specification: Node | undefined;
      if (this.isKw("ON")) {
        const s = this.t.start;
        specification = this.node("join_on_specification", s, { onKw: this.kw(), expr: this.expr() });
      } else if (this.isKw("USING")) {
        const s = this.t.start;
        specification = this.node("join_using_specification", s, { usingKw: this.kw(), expr: this.paren(() => this.list(() => this.identifier())) });
      }
      left = this.node("join_expr", left.range[0], { left, operator, right, specification });
    }
  }

  private tableOrSubquery(): Node {
    let source: Node;
    if (this.isOp("(")) {
      source = this.paren(() => (this.startsSelect() ? this.select() : this.joinTree()));
    } else {
      source = this.qualifiedName();
      // 表を返す関数 (`json_each(x)`)。
      if (this.isOp("(")) source = this.call(source);
    }
    return this.indexed(this.aliased(source, true));
  }

  /** `表 INDEXED BY 名前` と `表 NOT INDEXED`。 */
  private indexed(table: Node): Node {
    if (this.isKw("INDEXED")) return this.node("indexed_table", table.range[0], { table, indexedByKw: this.kws("INDEXED", "BY"), index: this.identifier() });
    if (this.isKw("NOT") && this.isKw("INDEXED", 1)) return this.node("not_indexed_table", table.range[0], { table, notIndexedKw: this.kws("NOT", "INDEXED") });
    return table;
  }

  /** 書き込み先の表。別名は AS を付けたものだけである。 */
  private targetTable(): Node {
    return this.indexed(this.aliased(this.qualifiedName(), false));
  }

  // ---- INSERT、UPDATE、DELETE ----

  private orAction(): Node | undefined {
    if (!this.isKw("OR")) return undefined;
    const s = this.t.start;
    const orKw = this.kw();
    if (!CONFLICT_ACTIONS.has(this.t.upper)) this.fail();
    return this.node("or_alternate_action", s, { orKw, actionKw: this.kw() });
  }

  private returning(): Node {
    const s = this.t.start;
    return this.node("returning_clause", s, { returningKw: this.kw("RETURNING"), columns: this.list(() => this.resultColumn()) });
  }

  private insert(withClause?: Node): Node {
    const start = withClause ? withClause.range[0] : this.t.start;
    const clauses: Node[] = withClause ? [withClause] : [];
    const s = this.t.start;
    const insertKw = this.kw();
    const orAction = insertKw.name === "INSERT" ? this.orAction() : undefined;
    const intoKw = this.kw("INTO");
    const table = this.aliased(this.qualifiedName(), false);
    const columns = this.isOp("(") ? this.paren(() => this.list(() => this.identifier())) : undefined;
    clauses.push(this.node("insert_clause", s, { insertKw, modifiers: [], orAction, intoKw, table, columns }));
    if (this.isKw("DEFAULT")) {
      const ds = this.t.start;
      clauses.push(this.node("default_values", ds, { defaultValuesKw: this.kws("DEFAULT", "VALUES") }));
    } else {
      const body = this.select();
      // 行を並べただけの VALUES は、SELECT の文で包まずに句として持つ。
      clauses.push(body.type === "select_stmt" && body.clauses.length === 1 && body.clauses[0].type === "values_clause" ? body.clauses[0] : body);
    }
    while (this.isKw("ON")) clauses.push(this.upsert());
    if (this.isKw("RETURNING")) clauses.push(this.returning());
    return this.node("insert_stmt", start, { clauses });
  }

  private upsert(): Node {
    const s = this.t.start;
    const onConflictKw = this.kws("ON", "CONFLICT");
    let conflictTarget: Node | undefined;
    let where: Node | undefined;
    if (this.isOp("(")) {
      conflictTarget = this.paren(() => this.list(() => this.indexedColumn()));
      if (this.isKw("WHERE")) where = this.where();
    }
    const doKw = this.kw("DO");
    const as = this.t.start;
    let action: Node;
    if (this.isKw("NOTHING")) action = this.node("upsert_action_nothing", as, { nothingKw: this.kw() });
    else {
      const updateKw = this.kw("UPDATE");
      const set = this.setClause();
      action = this.node("upsert_action_update", as, { updateKw, set, where: this.isKw("WHERE") ? this.where() : undefined });
    }
    return this.node("upsert_clause", s, { onConflictKw, conflictTarget, where, doKw, action });
  }

  private setClause(): Node {
    const s = this.t.start;
    const setKw = this.kw("SET");
    const assignments = this.list(() => {
      const column = this.isOp("(") ? this.paren(() => this.list(() => this.identifier())) : this.identifier();
      this.op("=", column);
      const expr = this.expr();
      return { type: "column_assignment", column, expr, range: [column.range[0], expr.range[1]] };
    });
    return this.node("set_clause", s, { setKw, assignments });
  }

  private update(withClause?: Node): Node {
    const start = withClause ? withClause.range[0] : this.t.start;
    const clauses: Node[] = withClause ? [withClause] : [];
    const s = this.t.start;
    const updateKw = this.kw("UPDATE");
    const orAction = this.orAction();
    const tables = this.list(() => this.targetTable());
    clauses.push(this.node("update_clause", s, { updateKw, modifiers: [], orAction, tables }));
    clauses.push(this.setClause());
    if (this.isKw("FROM")) {
      const fs = this.t.start;
      clauses.push(this.node("from_clause", fs, { fromKw: this.kw(), expr: this.joinTree() }));
    }
    this.tail(clauses);
    return this.node("update_stmt", start, { clauses });
  }

  /** UPDATE と DELETE の、WHERE から後ろ。 */
  private tail(clauses: Node[]): void {
    if (this.isKw("WHERE")) clauses.push(this.where());
    if (this.isKw("RETURNING")) clauses.push(this.returning());
    if (this.isKw("ORDER")) clauses.push(this.orderBy());
    if (this.isKw("LIMIT")) clauses.push(this.limit());
  }

  private delete(withClause?: Node): Node {
    const start = withClause ? withClause.range[0] : this.t.start;
    const clauses: Node[] = withClause ? [withClause] : [];
    const s = this.t.start;
    const deleteKw = this.kw("DELETE");
    const fromKw = this.kw("FROM");
    const tables = this.list(() => this.targetTable());
    clauses.push(this.node("delete_clause", s, { deleteKw, modifiers: [], fromKw, tables }));
    this.tail(clauses);
    return this.node("delete_stmt", start, { clauses });
  }

  // ---- 表定義 ----

  private ifNotExists(): Node[] | undefined {
    return this.isKw("IF") && this.isKw("NOT", 1) ? this.kws("IF", "NOT", "EXISTS") : undefined;
  }

  private ifExists(): Node[] | undefined {
    return this.isKw("IF") && this.isKw("EXISTS", 1) ? this.kws("IF", "EXISTS") : undefined;
  }

  private create(): Node {
    const start = this.t.start;
    const createKw = this.kw("CREATE");
    if (this.isKw("UNIQUE") || this.isKw("INDEX")) {
      const indexTypeKw = this.kwIf("UNIQUE");
      const indexKw = this.kw("INDEX");
      const ifNotExistsKw = this.ifNotExists();
      const name = this.qualifiedName();
      const onKw = this.kw("ON");
      const table = this.identifier();
      const columns = this.paren(() => this.list(() => this.indexedColumn()));
      const clauses = this.isKw("WHERE") ? [this.where()] : [];
      return this.node("create_index_stmt", start, { createKw, indexTypeKw, indexKw, ifNotExistsKw, name, onKw, table, columns, clauses });
    }
    let kind: Node | undefined;
    if (this.isKw("TEMP") || this.isKw("TEMPORARY") || this.isKw("VIRTUAL")) kind = this.node("relation_kind", this.t.start, { kindKw: this.kw() });
    if (this.isKw("TABLE")) {
      const tableKw = this.kw();
      const ifNotExistsKw = this.ifNotExists();
      const name = this.qualifiedName();
      if (kind?.kindKw.name === "VIRTUAL") {
        const us = this.t.start;
        const usingKw = this.kw("USING");
        const module = this.identifier();
        // モジュールの引数は、モジュールが自分で読む文面である。括弧の釣り合いだけを見て、引数のない呼び出しの形で持つ。
        const using = this.node("create_table_using_clause", us, { usingKw, module: this.isOp("(") ? this.rawCall(module) : this.node("func_call", module.range[0], { name: module }) });
        return this.node("create_table_stmt", start, { createKw, kind, tableKw, ifNotExistsKw, name, clauses: [using] });
      }
      if (this.isKw("AS")) {
        const as = this.t.start;
        const asClause = this.node("as_clause", as, { asKw: this.kw(), expr: this.select() });
        return this.node("create_table_stmt", start, { createKw, kind, tableKw, ifNotExistsKw, name, clauses: [asClause] });
      }
      const columns = this.paren(() => this.tableElements());
      let options: Node | undefined;
      if (this.isKw("WITHOUT") || this.isKw("STRICT")) {
        options = this.list(() => {
          const os = this.t.start;
          return this.node("table_option", os, { name: this.isKw("WITHOUT") ? this.kws("WITHOUT", "ROWID") : this.kw("STRICT") });
        });
      }
      return this.node("create_table_stmt", start, { createKw, kind, tableKw, ifNotExistsKw, name, columns, options, clauses: [] });
    }
    if (kind?.kindKw.name === "VIRTUAL") this.fail();
    if (this.isKw("VIEW")) {
      const viewKw = this.kw();
      const ifNotExistsKw = this.ifNotExists();
      const name = this.qualifiedName();
      // view の列の名前は、制約のない列の定義の形で持つ。
      const columns = this.isOp("(") ? this.paren(() => this.list(() => this.node("column_definition", this.t.start, { name: this.identifier(), constraints: [] }))) : undefined;
      const as = this.t.start;
      const asClause = this.node("as_clause", as, { asKw: this.kw("AS"), expr: this.select() });
      return this.node("create_view_stmt", start, { createKw, kinds: kind ? [kind] : [], viewKw, ifNotExistsKw, name, columns, clauses: [asClause] });
    }
    const triggerKw = this.kw("TRIGGER");
    const ifNotExistsKw = this.ifNotExists();
    const name = this.qualifiedName();
    const timeKw = this.isKw("INSTEAD") ? this.kws("INSTEAD", "OF") : this.isKw("BEFORE") || this.isKw("AFTER") ? this.kw() : undefined;
    const es = this.t.start;
    if (!this.isKw("DELETE") && !this.isKw("INSERT") && !this.isKw("UPDATE")) this.fail();
    const eventKw = this.kw();
    const event = eventKw.name === "UPDATE" && this.isKw("OF")
      ? this.node("trigger_event", es, { eventKw, ofKw: this.kw(), columns: this.list(() => this.identifier()) })
      : this.node("trigger_event", es, { eventKw });
    const ts = this.t.start;
    const target = this.node("trigger_target", ts, { onKw: this.kw("ON"), table: this.qualifiedName() });
    const clauses: Node[] = [];
    if (this.isKw("FOR")) clauses.push(this.node("for_each_clause", this.t.start, { forEachKw: this.kws("FOR", "EACH"), itemKw: this.kw("ROW") }));
    if (this.isKw("WHEN")) clauses.push(this.node("when_clause", this.t.start, { whenKw: this.kw(), expr: this.expr() }));
    const bs = this.t.start;
    const beginKw = this.kw("BEGIN");
    // 本体は、`;` で終わる文の並びである。最後の `;` の後ろは、空の文として持つ。
    const ps = this.t.start;
    const statements: Node[] = [];
    do {
      const st = this.triggerStatement();
      statements.push(st);
      this.op(";", st);
    } while (!this.isKw("END"));
    statements.push({ type: "empty", range: [this.last, this.last] });
    const program = this.node("program", ps, { statements });
    const body = this.node("block_stmt", bs, { beginKw, program, endKw: this.kw("END") });
    return this.node("create_trigger_stmt", start, { createKw, kind, triggerKw, ifNotExistsKw, name, timeKw, event, target, clauses, body });
  }

  private triggerStatement(): Node {
    const withClause = this.isKw("WITH") ? this.withClause() : undefined;
    if (this.isKw("INSERT") || this.isKw("REPLACE")) return this.insert(withClause);
    if (this.isKw("UPDATE")) return this.update(withClause);
    if (this.isKw("DELETE")) return this.delete(withClause);
    return this.select(withClause);
  }

  /** 括弧の釣り合いだけを見て、閉じる括弧までを読み飛ばす。中の文面は、括弧の節の raw に持つ。 */
  private rawCall(name: Node): Node {
    const open = this.t;
    this.i++;
    let depth = 1;
    while (depth > 0) {
      if (this.t.kind === "eof") this.fail();
      if (this.isOp("(")) depth++;
      if (this.isOp(")")) depth--;
      this.i++;
    }
    const close = this.toks[this.i - 1]!;
    const args: Node = { type: "paren_expr", expr: { type: "raw", text: this.source.slice(open.end, close.start), range: [open.end, close.start] }, range: [open.start, close.end] };
    if (open.ws) args.leading = open.ws;
    return this.node("func_call", name.range[0], { name, args });
  }

  /** CREATE TABLE の括弧の中。列の定義の後ろに、表の制約が続く。 */
  private tableElements(): Node {
    let constraints = false;
    return this.list(() => {
      const t = this.t;
      if (t.kind === "word" && (t.upper === "CONSTRAINT" || t.upper === "PRIMARY" || t.upper === "UNIQUE" || t.upper === "CHECK" || t.upper === "FOREIGN")) {
        constraints = true;
        return this.constraint(true);
      }
      // 表の制約の後ろに、列の定義は書けない。
      if (constraints) this.fail();
      return this.columnDefinition();
    });
  }

  columnDefinition(): Node {
    const start = this.t.start;
    const name = this.identifier();
    const dataType = this.isTypeWord() ? this.dataType() : undefined;
    const constraints: Node[] = [];
    while (this.t.kind === "word" && COLUMN_CONSTRAINT_START.has(this.t.upper)) {
      const c = this.constraint(false);
      constraints.push(c);
      // AUTOINCREMENT は PRIMARY KEY の続きだが、木では次の独立した制約として持つ。
      if ((c.type === "constraint" ? c.constraint : c).type === "constraint_primary_key" && this.isKw("AUTOINCREMENT")) {
        constraints.push(this.node("constraint_auto_increment", this.t.start, { autoIncrementKw: this.kw() }));
      }
    }
    return dataType ? this.node("column_definition", start, { name, dataType, constraints }) : this.node("column_definition", start, { name, constraints });
  }

  /**
   * 列か表の制約。`CONSTRAINT 名前` か、後ろの DEFERRABLE などの修飾があるときは、constraint の節で包む。
   * AUTOINCREMENT は、PRIMARY KEY の次の独立した制約として持つ。
   */
  private constraint(table: boolean): Node {
    const start = this.t.start;
    let name: Node | undefined;
    if (this.isKw("CONSTRAINT")) name = this.node("constraint_name", start, { constraintKw: this.kw(), name: this.identifier() });
    const s = this.t.start;
    let constraint: Node;
    const onConflict = (): Node[] => {
      if (!this.isKw("ON") || !this.isKw("CONFLICT", 1)) return [];
      const cs = this.t.start;
      const onConflictKw = this.kws("ON", "CONFLICT");
      if (!CONFLICT_ACTIONS.has(this.t.upper)) this.fail();
      return [this.node("on_conflict_clause", cs, { onConflictKw, resolutionKw: this.kw() })];
    };
    const t = this.t;
    switch (t.kind === "word" ? t.upper : "") {
      case "PRIMARY": {
        const primaryKeyKw = this.kws("PRIMARY", "KEY");
        if (table) {
          const columns = this.paren(() => this.list(() => this.indexedColumn()));
          constraint = this.node("constraint_primary_key", s, { primaryKeyKw, columns, clauses: onConflict() });
        } else {
          const direction = this.direction();
          constraint = this.node("constraint_primary_key", s, { primaryKeyKw, direction, clauses: onConflict() });
        }
        break;
      }
      case "UNIQUE": {
        const uniqueKw = this.kw();
        // 表の UNIQUE の列は、名前だけを読む。照合順序や方向の付いた列 (`UNIQUE (a COLLATE NOCASE)`) は、SQLite は読むが、
        // ここでは読まない。ddl.ts は列の名前だけを取り出すので、読むと、照合順序を知らない UNIQUE を記録してしまう。
        constraint = table
          ? this.node("constraint_unique", s, { uniqueKw, columns: this.paren(() => this.list(() => this.identifier())), clauses: onConflict() })
          : this.node("constraint_unique", s, { uniqueKw, clauses: onConflict() });
        break;
      }
      case "CHECK":
        constraint = this.node("constraint_check", s, { checkKw: this.kw(), expr: this.paren(() => this.expr()), clauses: table ? onConflict() : [] });
        break;
      case "FOREIGN": {
        if (!table) this.fail();
        const foreignKeyKw = this.kws("FOREIGN", "KEY");
        const columns = this.paren(() => this.list(() => this.identifier()));
        constraint = this.node("constraint_foreign_key", s, { foreignKeyKw, columns, references: this.references() });
        break;
      }
      case "NOT":
        if (table) this.fail();
        constraint = this.node("constraint_not_null", s, { notNullKw: this.kws("NOT", "NULL"), clauses: onConflict() });
        break;
      case "NULL":
        if (table) this.fail();
        constraint = this.node("constraint_null", s, { nullKw: this.kw() });
        break;
      case "DEFAULT":
        if (table) this.fail();
        constraint = this.node("constraint_default", s, { defaultKw: this.kw(), expr: this.defaultValue() });
        break;
      case "COLLATE":
        if (table) this.fail();
        constraint = this.node("constraint_collate", s, { collateKw: this.kw(), collation: this.aliasName() });
        break;
      case "REFERENCES":
        if (table) this.fail();
        constraint = this.references();
        break;
      case "GENERATED":
      case "AS": {
        if (table) this.fail();
        const generatedKw = this.isKw("GENERATED") ? this.kws("GENERATED", "ALWAYS") : undefined;
        const asKw = this.kw("AS");
        const expr = this.paren(() => this.expr());
        const storageKw = this.isKw("STORED") || this.isKw("VIRTUAL") ? this.kw() : undefined;
        constraint = this.node("constraint_generated", s, { generatedKw, asKw, expr, storageKw });
        break;
      }
      default:
        return this.fail();
    }
    // 外部キーの後ろの DEFERRABLE と INITIALLY。
    const modifiers: Node[] = [];
    if (constraint.type === "references_specification" || constraint.type === "constraint_foreign_key") {
      for (;;) {
        const ms = this.t.start;
        if (this.isKw("NOT") && this.isKw("DEFERRABLE", 1)) modifiers.push(this.node("constraint_modifier", ms, { kw: this.kws("NOT", "DEFERRABLE") }));
        else if (this.isKw("DEFERRABLE")) modifiers.push(this.node("constraint_modifier", ms, { kw: this.kw() }));
        else if (this.isKw("INITIALLY")) {
          const k = this.kw();
          if (!this.isKw("DEFERRED") && !this.isKw("IMMEDIATE")) this.fail();
          modifiers.push(this.node("constraint_modifier", ms, { kw: [k, this.kw()] }));
        } else break;
      }
    }
    const out = name || modifiers.length ? this.node("constraint", start, { name, constraint, modifiers }) : constraint;
    return out;
  }

  /** DEFAULT の値。SQLite では、literal、符号つきの数、括弧の式、識別子だけである。式の続きは読まない (次の制約である)。 */
  private defaultValue(): Node {
    const t = this.t;
    if (t.kind === "op" && (t.text === "-" || t.text === "+")) return this.signedNumber();
    if (t.kind === "op" && t.text === "(") return this.paren(() => this.expr());
    if (t.kind === "number" || t.kind === "string" || t.kind === "blob") return this.primary();
    if (t.kind === "word" && (t.upper === "NULL" || t.upper === "TRUE" || t.upper === "FALSE" || /^CURRENT_(DATE|TIME|TIMESTAMP)$/.test(t.upper))) return this.primary();
    return this.identifier();
  }

  private references(): Node {
    const s = this.t.start;
    const referencesKw = this.kw("REFERENCES");
    const table = this.identifier();
    const columns = this.isOp("(") ? this.paren(() => this.list(() => this.identifier())) : undefined;
    const options: Node[] = [];
    for (;;) {
      const os = this.t.start;
      if (this.isKw("ON") && (this.isKw("DELETE", 1) || this.isKw("UPDATE", 1))) {
        const onKw = this.kw();
        const eventKw = this.kw();
        let actionKw: Node | Node[];
        if (this.isKw("SET")) {
          const k = this.kw();
          if (!this.isKw("NULL") && !this.isKw("DEFAULT")) this.fail();
          actionKw = [k, this.kw()];
        } else if (this.isKw("NO")) actionKw = this.kws("NO", "ACTION");
        else if (this.isKw("CASCADE") || this.isKw("RESTRICT")) actionKw = this.kw();
        else return this.fail();
        options.push(this.node("referential_action", os, { onKw, eventKw, actionKw }));
      } else if (this.isKw("MATCH") && (this.at(1).kind === "word" || this.at(1).kind === "quoted")) {
        // MATCH の後ろは名前なら何でもよい (SQLite は読んで捨てる)。FULL は結合の語なので、引用符で囲まれて届く (cst.ts)。
        options.push(this.node("referential_match", os, { matchKw: this.kw(), typeKw: this.at(0).kind === "word" ? this.kw() : this.identifier() }));
      } else break;
    }
    return columns ? this.node("references_specification", s, { referencesKw, table, columns, options }) : this.node("references_specification", s, { referencesKw, table, options });
  }

  /** index の 1 列。`式 [COLLATE 名前] [ASC | DESC]`。 */
  private indexedColumn(): Node {
    const expr = this.expr();
    const direction = this.direction();
    return direction ? this.node("index_specification", expr.range[0], { expr, direction }) : this.node("index_specification", expr.range[0], { expr });
  }

  private drop(): Node {
    const start = this.t.start;
    const dropKw = this.kw("DROP");
    const what = this.t.upper;
    if (what === "TRIGGER") {
      const triggerKw = this.kw();
      return this.node("drop_trigger_stmt", start, { dropTriggerKw: [dropKw, triggerKw], ifExistsKw: this.ifExists(), trigger: this.qualifiedName() });
    }
    const one1 = (): Node => {
      const n = this.qualifiedName();
      return { type: "list_expr", items: [n], range: [n.range[0], n.range[1]] };
    };
    if (what === "TABLE") return this.node("drop_table_stmt", start, { dropKw, tableKw: this.kw(), ifExistsKw: this.ifExists(), tables: one1() });
    if (what === "INDEX") return this.node("drop_index_stmt", start, { dropKw, indexKw: this.kw(), ifExistsKw: this.ifExists(), indexes: one1() });
    if (what === "VIEW") return this.node("drop_view_stmt", start, { dropKw, viewKw: this.kw(), ifExistsKw: this.ifExists(), views: one1() });
    return this.fail();
  }

  private alter(): Node {
    const start = this.t.start;
    const alterTableKw = this.kws("ALTER", "TABLE");
    const table = this.qualifiedName();
    const s = this.t.start;
    let action: Node;
    if (this.isKw("RENAME")) {
      const renameKw = this.kw();
      if (this.isKw("TO")) action = this.node("alter_action_rename", s, { renameKw: [renameKw, this.kw()], newName: this.identifier() });
      else {
        const columnKw = this.isKw("COLUMN") && this.isName(1) && !this.isKw("TO", 1) ? this.kw() : undefined;
        action = this.node("alter_action_rename_column", s, {
          renameKw: columnKw ? [renameKw, columnKw] : renameKw, oldName: this.identifier(), toKw: this.kw("TO"), newName: this.identifier(),
        });
      }
    } else if (this.isKw("ADD")) {
      const addKw = this.kw();
      const columnKw = this.isKw("COLUMN") && this.isName(1) ? this.kw() : undefined;
      action = this.node("alter_action_add_column", s, { addKw: columnKw ? [addKw, columnKw] : addKw, column: this.columnDefinition() });
    } else {
      const dropKw = this.kw("DROP");
      const columnKw = this.isKw("COLUMN") && this.isName(1) ? this.kw() : undefined;
      action = this.node("alter_action_drop_column", s, { dropKw: columnKw ? [dropKw, columnKw] : dropKw, column: this.identifier() });
    }
    const actions: Node = { type: "list_expr", items: [action], range: [action.range[0], action.range[1]] };
    return this.node("alter_table_stmt", start, { alterTableKw, table, actions });
  }

  // ---- そのほかの文 ----

  private pragma(): Node {
    const start = this.t.start;
    const pragmaKw = this.kw("PRAGMA");
    const name = this.qualifiedName();
    // 値は、数、文字列、名前のどれかである。名前は予約語でも書ける (`PRAGMA x = ON`) ので、語は予約語の節として持つ。
    const value = (): Node => {
      const t = this.t;
      if (t.kind === "op" && (t.text === "-" || t.text === "+")) return this.signedNumber();
      if (t.kind === "number" || t.kind === "string") return this.primary();
      if (t.kind === "quoted") return this.identifier();
      return this.kw();
    };
    let pragma: Node = name;
    if (this.isOp("=")) {
      this.op("=", name);
      const v = value();
      pragma = { type: "pragma_assignment", name, value: v, range: [name.range[0], v.range[1]] };
    } else if (this.isOp("(")) {
      pragma = this.node("pragma_func_call", name.range[0], { name, args: this.paren(value) });
    }
    return this.node("pragma_stmt", start, { pragmaKw, pragma });
  }

  private statement(): Node {
    const t = this.t;
    const start = t.start;
    if (t.kind !== "word") return this.fail();
    switch (t.upper) {
      case "SELECT":
      case "VALUES":
        return this.select();
      case "WITH": {
        const withClause = this.withClause();
        if (this.isKw("INSERT") || this.isKw("REPLACE")) return this.insert(withClause);
        if (this.isKw("UPDATE")) return this.update(withClause);
        if (this.isKw("DELETE")) return this.delete(withClause);
        return this.select(withClause);
      }
      case "INSERT":
      case "REPLACE":
        return this.insert();
      case "UPDATE":
        return this.update();
      case "DELETE":
        return this.delete();
      case "CREATE":
        return this.create();
      case "DROP":
        return this.drop();
      case "ALTER":
        return this.alter();
      case "PRAGMA":
        return this.pragma();
      case "EXPLAIN": {
        const explainKw = this.kw();
        const queryPlanKw = this.isKw("QUERY") ? this.kws("QUERY", "PLAN") : undefined;
        return this.node("explain_stmt", start, { explainKw, queryPlanKw, statement: this.statement() });
      }
      case "ANALYZE": {
        const analyzeKw = this.kw();
        if (!this.isName()) return this.node("analyze_stmt", start, { analyzeKw, tables: [] });
        const n = this.qualifiedName();
        return this.node("analyze_stmt", start, { analyzeKw, tables: { type: "list_expr", items: [n], range: [n.range[0], n.range[1]] } });
      }
      case "REINDEX": {
        const reindexKw = this.kw();
        return this.node("reindex_stmt", start, { reindexKw, name: this.isName() ? this.qualifiedName() : undefined });
      }
      case "VACUUM": {
        const vacuumKw = this.kw();
        const schema = this.isName() && !this.isKw("INTO") ? this.identifier() : undefined;
        if (!this.isKw("INTO")) return this.node("vacuum_stmt", start, { vacuumKw, schema });
        return this.node("vacuum_stmt", start, { vacuumKw, schema, intoKw: this.kw(), file: this.expr() });
      }
      case "ATTACH": {
        const attachKw = this.kw();
        const databaseKw = this.isKw("DATABASE") && !this.isKw("AS", 1) ? this.kw() : undefined;
        return this.node("attach_database_stmt", start, { attachKw, databaseKw, file: this.expr(), asKw: this.kw("AS"), schema: this.identifier() });
      }
      case "DETACH": {
        const detachKw = this.kw();
        const databaseKw = this.isKw("DATABASE") && this.isName(1) ? this.kw() : undefined;
        return this.node("detach_database_stmt", start, { detachKw, databaseKw, schema: this.identifier() });
      }
      case "BEGIN": {
        const startKw = this.kw();
        const behaviorKw = this.isKw("DEFERRED") || this.isKw("IMMEDIATE") || this.isKw("EXCLUSIVE") ? this.kw() : undefined;
        return this.node("start_transaction_stmt", start, { startKw, behaviorKw, transactionKw: this.transactionKw() });
      }
      case "COMMIT":
      case "END":
        return this.node("commit_transaction_stmt", start, { commitKw: this.kw(), transactionKw: this.transactionKw() });
      case "ROLLBACK": {
        const rollbackKw = this.kw();
        const transactionKw = this.transactionKw();
        if (!this.isKw("TO")) return this.node("rollback_transaction_stmt", start, { rollbackKw, transactionKw });
        const s = this.t.start;
        const toKw = this.kw();
        const savepointKw = this.isKw("SAVEPOINT") && this.isName(1) ? this.kw() : undefined;
        const savepoint = this.node("rollback_to_savepoint", s, { toKw, savepointKw, savepoint: this.identifier() });
        return this.node("rollback_transaction_stmt", start, { rollbackKw, transactionKw, savepoint });
      }
      case "SAVEPOINT":
        return this.node("savepoint_stmt", start, { savepointKw: this.kw(), savepoint: this.identifier() });
      case "RELEASE": {
        const releaseKw = this.kw();
        const savepointKw = this.isKw("SAVEPOINT") && this.isName(1) ? this.kw() : undefined;
        return this.node("release_savepoint_stmt", start, { releaseKw, savepointKw, savepoint: this.identifier() });
      }
      default:
        return this.fail();
    }
  }

  /** `TRANSACTION` と、その後ろの名前 (SQLite は読んで捨てる)。 */
  private transactionKw(): Node | Node[] | undefined {
    if (!this.isKw("TRANSACTION")) return undefined;
    const k = this.kw();
    return this.isName() && !this.isKw("TO") ? [k, this.identifier()] : k;
  }

  /** `;` で区切った文の並び。空の文は返さない。 */
  program(): Node[] {
    const out: Node[] = [];
    for (;;) {
      while (this.isOp(";")) this.i++;
      if (this.at(0).kind === "eof") return out;
      const st = this.statement();
      out.push(st);
      if (this.at(0).kind === "eof") return out;
      this.op(";", st);
    }
  }
}

/** 文の並びを解析する。構文の誤りは、SQLite と同じ形の文言の SqlError にする。 */
export function parseSql(source: string): Node[] {
  try {
    return new Parser(source).program();
  } catch (e) {
    // 括弧や式の入れ子が深すぎる文。SQLite も同じ文言で断る。
    if (e instanceof RangeError) throw new SqlError("parser stack overflow");
    throw e;
  }
}
