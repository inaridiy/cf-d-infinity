// SQLite の方言の字句解析。規則は SQLite の tokenize.c に合わせる。
// 空白と注釈は捨てず、次のトークンの ws に入れる。文を元の文面のまま出し直すためである (src/sql/printer.ts)。
import { SqlError } from "../types";

export type TokenKind =
  /** 引用していない語。予約語か識別子かは、構文解析が位置で決める。 */
  | "word"
  /** 引用した識別子 ("..."、`...`、[...])。 */
  | "quoted"
  | "string"
  | "blob"
  | "number"
  /** 束縛する引数 (`?`、`?1`、`:a`、`@a`、`$a`)。 */
  | "param"
  /** 演算子と区切りの記号。 */
  | "op"
  | "eof";

export interface Token {
  kind: TokenKind;
  /** 文面のまま。 */
  text: string;
  /** word を大文字にしたもの。ほかの種類では空。 */
  upper: string;
  start: number;
  end: number;
  /** 直前の空白と注釈。 */
  ws: string;
}

const isDigit = (c: number): boolean => c >= 48 && c <= 57;
const isHex = (c: number): boolean => isDigit(c) || (c >= 65 && c <= 70) || (c >= 97 && c <= 102);
/** 識別子の先頭に使える文字。英字、`_`、ASCII の外の文字。 */
const isIdStart = (c: number): boolean => (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95 || c >= 128;
/** 識別子の 2 文字目から使える文字。数字と `$` が加わる。 */
const isIdChar = (c: number): boolean => isIdStart(c) || isDigit(c) || c === 36;

const OPS3 = ["->>"];
const OPS2 = ["||", "->", "<<", ">>", "<=", ">=", "==", "!=", "<>"];
const OPS1 = "=<>+-*/%&|~(),;.";

const unrecognized = (src: string, start: number, end: number): never => {
  throw new SqlError(`unrecognized token: "${src.slice(start, Math.min(end, start + 40))}"`);
};

/** 数字の並びを読む。SQLite 3.46 からの、数字の間の `_` も読む。 */
function digits(src: string, i: number, ok: (c: number) => boolean): number {
  while (ok(src.charCodeAt(i)) || (src.charCodeAt(i) === 95 && ok(src.charCodeAt(i - 1)) && ok(src.charCodeAt(i + 1)))) i++;
  return i;
}

export function tokenize(src: string): Token[] {
  const out: Token[] = [];
  const n = src.length;
  let i = 0;
  for (;;) {
    const wsStart = i;
    for (;;) {
      const c = src.charCodeAt(i);
      if (c === 32 || c === 9 || c === 10 || c === 12 || c === 13) i++;
      else if (c === 45 && src.charCodeAt(i + 1) === 45) {
        const e = src.indexOf("\n", i);
        i = e < 0 ? n : e;
      } else if (c === 47 && src.charCodeAt(i + 1) === 42) {
        // 閉じていない注釈は、SQLite と同じく、文の終わりまでを注釈として読む。
        const e = src.indexOf("*/", i + 2);
        i = e < 0 ? n : e + 2;
      } else break;
    }
    const ws = src.slice(wsStart, i);
    const start = i;
    const push = (kind: TokenKind, end: number): void => {
      const text = src.slice(start, end);
      out.push({ kind, text, upper: kind === "word" ? text.toUpperCase() : "", start, end, ws });
      i = end;
    };
    if (i >= n) {
      push("eof", n);
      return out;
    }
    const c = src.charCodeAt(i);
    const ch = src[i]!;
    if (ch === "'" || ch === '"' || ch === "`") {
      // 引用符は、2 つ重ねると中の 1 文字になる。
      let j = i + 1;
      for (;;) {
        if (j >= n) unrecognized(src, start, n);
        if (src[j] === ch) {
          if (src[j + 1] !== ch) break;
          j++;
        }
        j++;
      }
      push(ch === "'" ? "string" : "quoted", j + 1);
    } else if (ch === "[") {
      const j = src.indexOf("]", i);
      if (j < 0) unrecognized(src, start, n);
      push("quoted", j + 1);
    } else if ((ch === "x" || ch === "X") && src[i + 1] === "'") {
      let j = i + 2;
      while (isHex(src.charCodeAt(j))) j++;
      if (src[j] !== "'" || (j - i) % 2 !== 0) {
        // 16 進でない文字か、奇数個の桁。SQLite は閉じる引用符までを 1 つの誤ったトークンにする。
        while (j < n && src[j] !== "'") j++;
        unrecognized(src, start, j + 1);
      }
      push("blob", j + 1);
    } else if (isDigit(c) || (ch === "." && isDigit(src.charCodeAt(i + 1)))) {
      let j = i;
      if (ch === "0" && (src[i + 1] === "x" || src[i + 1] === "X") && isHex(src.charCodeAt(i + 2))) {
        j = digits(src, i + 2, isHex);
      } else {
        j = digits(src, j, isDigit);
        if (src[j] === ".") j = digits(src, j + 1, isDigit);
        if (src[j] === "e" || src[j] === "E") {
          const sign = src[j + 1] === "+" || src[j + 1] === "-" ? 1 : 0;
          if (isDigit(src.charCodeAt(j + 1 + sign))) j = digits(src, j + 1 + sign, isDigit);
        }
      }
      // 数の直後に識別子の文字が続くもの (`1e`、`0x`、`12abc`) は、SQLite では誤ったトークンである。
      if (isIdChar(src.charCodeAt(j))) {
        while (isIdChar(src.charCodeAt(j))) j++;
        unrecognized(src, start, j);
      }
      push("number", j);
    } else if (isIdStart(c)) {
      let j = i + 1;
      while (isIdChar(src.charCodeAt(j))) j++;
      push("word", j);
    } else if (ch === "?") {
      let j = i + 1;
      while (isDigit(src.charCodeAt(j))) j++;
      push("param", j);
    } else if (ch === ":" || ch === "@" || ch === "$") {
      let j = i + 1;
      while (isIdChar(src.charCodeAt(j))) j++;
      if (j === i + 1) unrecognized(src, start, j);
      push("param", j);
    } else {
      const op = OPS3.find((o) => src.startsWith(o, i)) ?? OPS2.find((o) => src.startsWith(o, i)) ?? (OPS1.includes(ch) ? ch : null);
      if (op === null) unrecognized(src, start, i + 1);
      out.push({ kind: "op", text: op!, upper: "", start, end: i + op!.length, ws });
      i += op!.length;
    }
  }
}

/** 引用した識別子の、引用符を外した名前。 */
export function unquote(text: string): string {
  const q = text[0]!;
  if (q === "[") return text.slice(1, -1);
  return text.slice(1, -1).replaceAll(q + q, q);
}
