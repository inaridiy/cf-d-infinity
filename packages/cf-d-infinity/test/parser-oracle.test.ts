// 前のパーサ (sql-parser-cst) と今のパーサ (src/sql/parser.ts) の突き合わせ。
//
// sql-parser-cst は GPL なので、依存に入れていない。流すときだけ入れる (入っていなければ、この試験は飛ばされる):
//
//   npm install --no-save sql-parser-cst@0.33.1
//   PARSER_CORPUS=/tmp/corpus npx vitest run                      # 試験の全部が解析した文を書き出す (test/setup.ts)
//   PARSER_ORACLE_CORPUS=/tmp/corpus npx vitest run test/parser-oracle.test.ts
//
// 文の集まりを指定しなければ、文法を一通り踏む一覧 (test/parser-statements.ts) だけを比べる。指定すれば、その文と、
// test/slt/ にある sqllogictest のファイルの文を全部比べる (`:` で区切って、いくつも指定できる)。
//
// 比べるもの (test/parser-oracle.ts):
//   1. 受け付けるかどうか。食い違いは、本物の SQLite の構文の判定で分ける。
//   2. 木の形 (節の種類と欄。range と空白は除く)、葉でない節の文面、引数の節の位置。
//   3. 引数を束縛した結果 (値の並び、節の番号、束縛した後の文面)。
//   4. DDL の解釈 (parseDdl) の結果。制約を外して出し直した文面も、ここで比べる。
//   5. 空白と注釈をトークンの境目に差し込んだ文の、木と文面と DDL の解釈。境目は 1 つも除かない。
//   6. 出し直した文面を解析し直すと、同じ木になること。
//   7. 乱数で作った式 (演算子の混ぜ方)。
// 食い違いは種類ごとに数え、理由の分かっている種類 (EXPLAINED) のほかが 1 件でもあれば落ちる。
//
// 前の経路は、解析の前に文面を書き換えていた (test/parser-old.ts の preprocess: 後ろに結合が続かない結合の語を引用符で囲む、
// `x IN ()` をサブクエリにする、関数の引数の ALL を落とす、CR を空白にする)。今の経路は書き換えず、パーサが SQLite と同じ場所で読む。
// 書き換えが文面を変える文は、木が違って当たり前なので、今のパーサにも書き換えた後の文面を読ませて、前のパーサと比べる
// (パーサどうしの比較)。こうすると、書き換えの違いの陰に、ほかの違いが隠れない。書き換えずに読んだ結果は、ここでは、
// 受け付けるかどうかを SQLite と比べ、注釈を差し込んでも木が変わらないことを確かめる。答えと列名が SQLite と同じであることは、
// test/contextual-words.test.ts が確かめる。
// 今のパーサが SQLite と同じであることは、前のパーサを使わずに test/parser.test.ts が確かめる。
import { existsSync, readdirSync } from "node:fs";
import { afterAll, describe, expect, it, vi } from "vitest";
import * as now from "../src/sql/cst";
import { SCHEMA_STATEMENTS } from "../src/sql/plan";
import {
  bound, corpusDir, diffTrees, loadOld, outcome, randomExpression, sltStatements, splitStatements, sqliteAccepts, stripAllTrivia, stripEdgeTrivia, stubSchema, withTrivia,
} from "./parser-oracle";
import { STATEMENTS } from "./parser-statements";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Node = any;

const old = await loadOld();
// この試験が解析する文は、書き出さない (PARSER_CORPUS)。書き出すと、読み込んだ文の集まりと、差し込みを入れた文が、次の集まりに入る。
now.parseObserver.seen = undefined;

// DDL の解釈を、前のパーサと今のパーサの両方で動かす。ddl.ts は cst.ts を読むので、前のパーサに差し替えた ddl.ts を別に読む。
vi.resetModules();
vi.doMock("../src/sql/cst", () => ({ ...old }));
const oldDdl = old ? await import("../src/sql/ddl") : null;
vi.doUnmock("../src/sql/cst");
vi.resetModules();
const newDdl = await import("../src/sql/ddl");

/**
 * 理由の分かっている食い違い。値は、その判断である。
 * ここにない種類の食い違いが 1 件でもあれば、試験は落ちる。
 */
const EXPLAINED: Record<string, string> = {
  "accepts: both reject": "どちらも断る。変わらない",
  "accepts: new only, SQLite accepts": "前のパーサが読めなかった SQLite の文。今は受け付ける",
  "accepts: old only, SQLite rejects": "前のパーサが通していた、SQLite の構文でない文。今は構文の誤りにする",
  "accepts: both, SQLite rejects": "どちらのパーサも通すが、SQLite は断る。文は SQLite まで届いて、そこで断られる",
  "accepts: neither, SQLite accepts": "どちらのパーサも断る SQLite の文。変わらない",
  "text: edge comments only": "節の両端の注釈。前のパーサは節によって付けたり付けなかったりした。今はどの節にも付けない",
  "shape: a number the old parser read as an identifier (0X1f, 1_000)": "SQLite では数である。数として読む",
  "shape: a column constraint after DEFAULT, which the old parser read as part of the default value": "SQLite では DEFAULT の値は literal か括弧の式で、後ろは次の制約である。制約として読む",
  "shape: GENERATED ALWAYS, which the old parser read as part of the type name": "制約の一部として読む。生成列は、前も今も断る",
  "shape: arguments of a virtual table module, now kept as text": "モジュールが自分で読む文面なので、式として読まない。仮想表は、前も今も作れない",
  "shape: precedence of compound operators (equal and left to right in SQLite)": "SQLite の結合の順に従う",
  "shape: precedence of bitwise operators (equal and left to right in SQLite)": "SQLite の優先順位に従う",
  "shape: precedence of comparison operators (< <= > >= bind tighter than = in SQLite)": "SQLite の優先順位に従う",
  "trivia: old rejects": "空白か注釈を差し込むと、前のパーサが読めなくなる文。今は読む",
  "ddl: a comment next to the type of an INTEGER PRIMARY KEY column": "前は rowid の別名と見なさず、主キーを省いた INSERT が失敗した。今は別名と見なす",
  "rewrite: text the old path changed before parsing": "結合の語の名前、空の IN の並び、関数の引数の ALL、CR。今は書き換えずにパーサが読む。前のパーサとは、書き換えた後の文面で比べる",
};

const SAMPLES = Number(process.env.PARSER_ORACLE_SAMPLES ?? 8);
const DETAIL = Number(process.env.PARSER_ORACLE_DETAIL ?? 600);
const tally = new Map<string, { count: number; samples: string[] }>();
let sources = 0;
let statements = 0;
let variants = 0;

function note(kind: string, source: string, detail = ""): void {
  const t = tally.get(kind) ?? { count: 0, samples: [] };
  t.count++;
  if (t.samples.length < SAMPLES) t.samples.push(`${source.replace(/\s+/g, " ").slice(0, 300)}${detail ? `\n        ${detail.slice(0, DETAIL)}` : ""}`);
  tally.set(kind, t);
}

/**
 * DDL の解釈の食い違いのうち、理由の分かっているもの。
 * 前のパーサは、型の名前の節に隣の注釈を付けることがあった。ddl.ts は型の名前の文面が INTEGER かどうかで rowid の別名を決めるので、
 * `id /* c *\/ INTEGER PRIMARY KEY` を別名と見なさず、主キーを省いた INSERT が失敗した。今は節の文面に注釈が付かない。
 */
function explainDdl(source: string, x: string, y: string): string | null {
  if (x.startsWith("error") || y.startsWith("error") || !/\/\*|--/.test(source)) return null;
  const rest = (json: string): string => JSON.stringify(JSON.parse(json), (k, v) => (k === "rowidAlias" ? undefined : v));
  return rest(x) === rest(y) ? "ddl: a comment next to the type of an INTEGER PRIMARY KEY column" : null;
}

/** 2 つの文字列の、最初に違う場所の前後。 */
function firstDifference(x: string, y: string): string {
  let at = 0;
  while (at < x.length && x[at] === y[at]) at++;
  const from = Math.max(0, at - 80);
  return `at ${at}: ${JSON.stringify(x.slice(from, at + 160))}\n        vs     ${JSON.stringify(y.slice(from, at + 160))}`;
}

const tryParse = (cst: { parseStatements(s: string): Node[] }, source: string): Node[] | null => {
  try {
    return cst.parseStatements(source);
  } catch {
    return null;
  }
};

/** 木の形だけを比べる (今のパーサどうし)。文面のまま持つ節 (raw) は、空白と注釈を除いて比べる。 */
function sameShape(a: Node, b: Node): boolean {
  const strip = (n: Node): unknown =>
    JSON.stringify(n, function (this: Node, k, v) {
      if (k === "range" || k === "leading" || k === "trailing") return undefined;
      return k === "text" && this.type === "raw" ? stripAllTrivia(v) : v;
    });
  return strip(a) === strip(b);
}

/**
 * 木の形の食い違いのうち、今のパーサが SQLite の文法に従ったために起きるもの。どれも、前のパーサの読み方が SQLite と違っていた。
 * 当たらなければ null (理由の分からない食い違い)。
 * どの種類も、同じトークンの並びの読み方 (組み方) の違いである。2 つの木を文面に戻したトークンの並びが違えば (sameTokens が偽)、
 * 読み方の違いではないので、理由のある食い違いとは認めない。
 */
function explainShape(source: string, detail: string, sameTokens: boolean): string | null {
  if (!sameTokens) return null;
  if (/identifier\((0[xX][0-9A-Fa-f]+|\d[\d_]*)\) vs number_literal/.test(detail)) return "shape: a number the old parser read as an identifier (0X1f, 1_000)";
  if (/\.constraints: \[.*constraint_default.*\] vs \[.*constraint_default, constraint_(not_null|collate|null|unique|check|primary_key|generated)/.test(detail)
    || /\.constraints: \[.*constraint_default.*\] vs \[.*constraint_default, (references_specification|constraint)\b/.test(detail)) {
    return "shape: a column constraint after DEFAULT, which the old parser read as part of the default value";
  }
  if (/dataType(\.name)?: .*(keyword\(GENERATED\), keyword\(ALWAYS\)|named_data_type vs \(none\))/.test(detail) && /GENERATED\s+ALWAYS/i.test(source)) {
    return "shape: GENERATED ALWAYS, which the old parser read as part of the type name";
  }
  if (/module\.args\.expr: func_args vs raw/.test(detail)) return "shape: arguments of a virtual table module, now kept as text";
  if (/operator(\.text)?: /.test(detail)) {
    const ops = (re: RegExp) => new Set(source.match(re) ?? []).size;
    if (/\b(INTERSECT)\b/i.test(source) && ops(/\b(UNION|EXCEPT|INTERSECT)\b/gi) >= 2) return "shape: precedence of compound operators (equal and left to right in SQLite)";
    if (ops(/<<|>>|&|\|(?!\|)/g) >= 2) return "shape: precedence of bitwise operators (equal and left to right in SQLite)";
    if (/[<>]=?/.test(source) && /==?|!=|<>|\bIS\b/i.test(source)) return "shape: precedence of comparison operators (< <= > >= bind tighter than = in SQLite)";
  }
  return null;
}

/**
 * 前の経路が書き換える文を、今のパーサが書き換えずに読んだ結果。受け付けるかどうかは、SQLite と同じでなければならない。
 * 分かっている違い (test/parser.test.ts の KNOWN_DIFFERENCES) のうち、ここで除くのは、UPDATE と DELETE の ORDER BY と LIMIT だけである。
 */
function checkUnrewritten(source: string, rewritten: string): void {
  note("rewrite: text the old path changed before parsing", source);
  const pieces = splitStatements(source);
  const sqliteOk = pieces !== null && pieces.every(sqliteAccepts);
  const ours = tryParse(now, source) !== null;
  // 書き換えた後の文面も断るなら、断る理由は、書き換えが受け持っていた語の読み方ではない (型のない `CAST(x AS)` など)。
  // その文は、前のパーサとの比較 (check) が、書き換えた後の文面で分類する。
  if (!ours && tryParse(now, rewritten) === null) return;
  // 分かっている違い: UPDATE と DELETE の ORDER BY と LIMIT は、SQLite では組み込みの指定があるときだけの構文である。
  const knownLax = pieces !== null && pieces.some((p) => /^(WITH\b.*)?(UPDATE|DELETE)\b[^]*\b(ORDER\s+BY|LIMIT)\b/i.test(p));
  if (ours !== sqliteOk && !(ours && knownLax)) note(ours ? "rewrite: accepted without the rewrite, SQLite rejects" : "rewrite: rejected without the rewrite, SQLite accepts", source, outcome(() => now.parseStatements(source)));
}

function check(source: string, o: NonNullable<typeof old>, opts: { texts: boolean; trivia: boolean; strict?: boolean }): void {
  sources++;
  const a = tryParse(o, source);
  // 今のパーサには、前の経路の書き換えの後の文面を読ませる (ファイルの先頭の説明)。
  const rewritten = o.rewrite(source);
  if (rewritten !== source) checkUnrewritten(source, rewritten);
  const b = tryParse(now, rewritten);
  if (!a || !b) {
    const pieces = b ? b.map((s) => now.text(s)) : a ? a.map((s) => stripEdgeTrivia(o.text(s))) : splitStatements(rewritten);
    const sqliteOk = pieces !== null && pieces.every(sqliteAccepts);
    if (!a && !b) note(sqliteOk ? "accepts: neither, SQLite accepts" : "accepts: both reject", source);
    else if (a) note(sqliteOk ? "accepts: old only, SQLite accepts" : "accepts: old only, SQLite rejects", source, outcome(() => now.parseStatements(rewritten)));
    else note(sqliteOk ? "accepts: new only, SQLite accepts" : "accepts: new only, SQLite rejects", source);
    if (!b) return;
  }
  if (a && a.length !== b.length) {
    note("shape: number of statements", source, `${a.length} vs ${b.length}`);
    return;
  }
  for (const [i, stmt] of b.entries()) {
    statements++;
    const text = now.text(stmt);
    if (!sqliteAccepts(text) && a) note("accepts: both, SQLite rejects", text);
    // 出し直した文面を解析し直すと、同じ木と同じ文面になる。
    const again = tryParse(now, text);
    if (!again || again.length !== 1 || !sameShape(again[0], stmt) || now.text(again[0]) !== text) note("round trip", source, text);
    if (!a) continue;
    const d = diffTrees(a[i], stmt, o, opts.texts);
    const sameTokens = stripAllTrivia(o.text(a[i])) === stripAllTrivia(text);
    if (d.shape) note((opts.strict ? null : explainShape(source, d.shape, sameTokens)) ?? "shape", source, d.shape);
    if (d.text) note("text", source, d.text);
    if (d.range) note("parameter range", source, d.range);
    if (d.edgeComments) note("text: edge comments only", source);
    if (d.shape) continue;
    // DDL の解釈。束縛より先に比べる (束縛は木を書き換える)。
    if (SCHEMA_STATEMENTS.has(stmt.type) && oldDdl) {
      const schema = stubSchema(stmt);
      const x = outcome(() => oldDdl.parseDdl(stripEdgeTrivia(o.text(a[i])), structuredClone(schema)));
      const y = outcome(() => newDdl.parseDdl(text, structuredClone(schema)));
      if (x !== y) note(explainDdl(source, x, y) ?? "ddl", source, firstDifference(x, y));
    }
    for (const named of [false, true]) {
      const [x, y] = named ? [tryParse(o, source)![i], tryParse(now, rewritten)![i]] : [a[i], stmt];
      const bx = outcome(() => bound(o, x, named));
      const by = outcome(() => bound(now, y, named));
      if (bx !== by) note("bind", source, firstDifference(bx, by));
    }
  }
  if (!opts.trivia || !a) return;
  // 空白と注釈を、トークンの境目の全部に差し込む。今のパーサは、差し込む前と同じ木に読まなければならない。前の経路の書き換えは、
  // 結合の語の直後、ALL の前後、IN の後ろの空の括弧を文面で見分けていたので、そこに注釈があると読み方が変わった
  // (`a LEFT /* c */ JOIN b` が内部結合になった。test/join-word-before-comment.test.ts)。今は、その境目にも差し込む。
  const fresh = tryParse(now, source);
  if (!fresh) return;
  for (const [vi2, insert] of [" /* c */ ", " -- c\n", "\n\t "].entries()) {
    const variant = withTrivia(source, () => insert);
    if (variant === null) continue;
    variants++;
    const vb = tryParse(now, variant);
    if (!vb || vb.length !== fresh.length) {
      note("trivia: new rejects", variant, outcome(() => now.parseStatements(variant)));
      continue;
    }
    for (const [i, stmt] of vb.entries()) {
      if (!sameShape(stmt, fresh[i])) note("trivia: shape changes", variant);
      // 節の文面は、差し込んだものを除けば元と同じで、両端に空白や注釈が付かない。
      const pairs: [Node, Node][] = [];
      const collect = (x: Node, y: Node): void => {
        if (!x || typeof x !== "object") return;
        if (Array.isArray(x)) return x.forEach((e, k) => collect(e, y[k]));
        if (x.type && typeof x.text !== "string") pairs.push([x, y]);
        for (const k of Object.keys(x)) if (k !== "range" && k !== "leading" && k !== "trailing") collect(x[k], y[k]);
      };
      if (sameShape(stmt, fresh[i])) collect(stmt, fresh[i]);
      for (const [x, y] of pairs) {
        const tx = now.text(x);
        if (stripEdgeTrivia(tx) !== tx || stripAllTrivia(tx) !== stripAllTrivia(now.text(y))) {
          note("trivia: text", variant, `${x.type}: ${JSON.stringify(tx)}`);
          break;
        }
      }
    }
    if (vi2 > 0) continue;
    const va = tryParse(o, variant);
    if (!va) {
      note("trivia: old rejects", variant);
      continue;
    }
    // 前のパーサとは、書き換えた後の文面で比べる。注釈のために前の経路が読み違える文 (結合の語の後ろの注釈) も、同じ文面を読むので
    // 同じ木になる。
    const vr = tryParse(now, o.rewrite(variant));
    if (!vr || vr.length !== va.length) {
      note("trivia: new rejects the rewritten text", variant, outcome(() => now.parseStatements(o.rewrite(variant))));
      continue;
    }
    for (const [i, stmt] of vr.entries()) {
      const d = diffTrees(va[i], stmt, o, true);
      if (d.shape && !explainShape(source, d.shape, stripAllTrivia(o.text(va[i])) === stripAllTrivia(now.text(stmt)))) note("trivia: shape differs from old", variant, d.shape);
      if (d.text) note("trivia: text differs from old", variant, d.text);
      if (d.range) note("trivia: parameter range", variant, d.range);
      // 注釈を挟んだ DDL の解釈。ddl.ts は節の文面 (型の名前など) を読むので、注釈がどの節に付くかで結果が変わり得る。
      if (!d.shape && SCHEMA_STATEMENTS.has(stmt.type) && oldDdl) {
        const schema = stubSchema(stmt);
        const x = outcome(() => oldDdl.parseDdl(stripEdgeTrivia(o.text(va[i])), structuredClone(schema)));
        const y = outcome(() => newDdl.parseDdl(now.text(stmt), structuredClone(schema)));
        if (x !== y) note(explainDdl(variant, x, y) ?? "trivia: ddl", variant, firstDifference(x, y));
      }
    }
  }
}

const corpusDirs = (process.env.PARSER_ORACLE_CORPUS ?? "").split(":").filter(Boolean);
const sltDir = "test/slt";
// sqllogictest の 22 万件は数分かかる。文の集まりを指定したときか、PARSER_ORACLE_SLT=1 のときだけ流す。
const withSlt = process.env.PARSER_ORACLE_SLT === "1" || (corpusDirs.length > 0 && process.env.PARSER_ORACLE_SLT !== "0");
const sltFiles = !withSlt || !existsSync(`${sltDir}/select1.test`) ? [] : [
  ...readdirSync(sltDir).filter((f) => f.endsWith(".test")).map((f) => `${sltDir}/${f}`),
  ...["evidence", "random", "index"].filter((d) => existsSync(`${sltDir}/${d}`)).flatMap((d) => readdirSync(`${sltDir}/${d}`).map((f) => `${sltDir}/${d}/${f}`)),
];
/** sqllogictest は文が多く、形が似ている。節ごとの文面と、空白の差し込みは、この数に 1 つだけ比べる。 */
const SLT_SAMPLE = Number(process.env.PARSER_ORACLE_SLT_SAMPLE ?? 20);

describe.skipIf(!old)("the parser against the parser it replaced", () => {
  const seen = new Set<string>();
  const run = async (list: string[], opts: (i: number) => { texts: boolean; trivia: boolean; strict?: boolean }): Promise<void> => {
    for (const [i, source] of list.entries()) {
      // 長い突き合わせの間も、vitest の親との通信が止まらないようにする。
      if (i % 500 === 499) await new Promise((r) => setImmediate(r));
      if (seen.has(source)) continue;
      seen.add(source);
      check(source, old!, opts(i));
    }
  };

  it("the statement list that walks the grammar", async () => {
    await run(STATEMENTS, () => ({ texts: true, trivia: true }));
  });

  it("random expressions", async () => {
    // 演算子を混ぜた式を作る。前のパーサと優先順位の違う組 (ビットの演算子どうし、= の仲間と < の仲間) は、1 つの式に
    // 片方しか入れない。そうすれば、木の形の食い違いは 1 件も出ないはずである (strict: 理由のある食い違いとしても認めない)。
    await run(Array.from({ length: Number(process.env.PARSER_ORACLE_EXPRESSIONS ?? 4000) }, (_v, seed) => `SELECT ${randomExpression(seed + 1, { separate: true })} FROM t`),
      () => ({ texts: true, trivia: false, strict: true }));
  }, 3_600_000);

  for (const dir of corpusDirs) {
    it(`statements the test suite parsed: ${dir}`, async () => {
      await run(corpusDir(dir), () => ({ texts: true, trivia: true }));
    }, 3_600_000);
  }

  for (const f of sltFiles) {
    it(`sqllogictest ${f}`, async () => {
      await run(sltStatements(f), (i) => ({ texts: i % SLT_SAMPLE === 0, trivia: i % SLT_SAMPLE === 0 }));
    }, 3_600_000);
  }

  afterAll(() => {
    const lines = [`parser oracle: ${sources} sources, ${statements} statements, ${variants} variants with inserted whitespace and comments`];
    for (const [kind, t] of [...tally].sort()) {
      lines.push(`  ${EXPLAINED[kind] ? "explained " : "UNEXPLAINED"} ${kind}: ${t.count}${EXPLAINED[kind] ? ` (${EXPLAINED[kind]})` : ""}`);
      if (!EXPLAINED[kind] || process.env.PARSER_ORACLE_VERBOSE) for (const s of t.samples) lines.push(`      ${s}`);
    }
    console.log(lines.join("\n"));
  });

  it("leaves no difference without a known reason", () => {
    expect([...tally.keys()].filter((k) => !EXPLAINED[k])).toEqual([]);
  });
});
