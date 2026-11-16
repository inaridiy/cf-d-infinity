// 字句の手書きの走査 3 つの、置き換える前の写し (計画書の未解決の問題 48)。凍らせてあり、直さない。
// src/sql/lexer.ts (SQLite の tokenize.c に合わせた字句解析) より前に書かれた走査で、2026-11-16 に、どれも字句解析を使う形に
// 置き換えた。test/lexical-scans.test.ts が、同じ文の集まりで、前と今の答えを比べる。
//   - placeholders: src/value.ts。束縛のための書き換え (bindTyped) が、文の中の引数の位置を探す。
//   - compoundTerms: src/shard-limits.ts。シャードが、文ごとに複合 SELECT の項を多めに数える。
//   - identifierText: src/sql/scratch.ts。文が PRAGMA の関数を読むかを、`/\bpragma_/i` で探すための文面。
//   - tokenize: src/sql/lexer.ts。字句解析そのものも Scanner の上に作り直したので、前の tokenize も写して比べる。
import { SqlError } from "../src/types";
import type { Token, TokenKind } from "../src/sql/lexer";

export interface Placeholder {
  start: number;
  end: number;
  index: number;
}

export function placeholders(sql: string): Placeholder[] {
  const out: Placeholder[] = [];
  const names = new Map<string, number>();
  let max = 0;
  let i = 0;
  const n = sql.length;
  const isName = (c: string) => /[A-Za-z0-9_$]/.test(c) || c.charCodeAt(0) > 127;
  while (i < n) {
    const c = sql[i]!;
    if (c === "'" || c === '"' || c === "`") {
      const j = sql.indexOf(c, i + 1);
      if (j < 0) return out;
      // 引用の中の 2 重の引用符は、閉じずに続く。
      i = j + 1;
      while (i < n && sql[i] === c) {
        const k = sql.indexOf(c, i + 1);
        if (k < 0) return out;
        i = k + 1;
      }
      continue;
    }
    if (c === "[") {
      const j = sql.indexOf("]", i + 1);
      if (j < 0) return out;
      i = j + 1;
      continue;
    }
    if (c === "-" && sql[i + 1] === "-") {
      const j = sql.indexOf("\n", i + 2);
      i = j < 0 ? n : j + 1;
      continue;
    }
    if (c === "/" && sql[i + 1] === "*") {
      const j = sql.indexOf("*/", i + 2);
      i = j < 0 ? n : j + 2;
      continue;
    }
    if (c === "?") {
      let j = i + 1;
      while (j < n && /[0-9]/.test(sql[j]!)) j++;
      const index = j > i + 1 ? Number(sql.slice(i + 1, j)) : max + 1;
      max = Math.max(max, index);
      out.push({ start: i, end: j, index });
      i = j;
      continue;
    }
    if ((c === ":" || c === "@" || c === "$") && i + 1 < n && isName(sql[i + 1]!) && !(i > 0 && isName(sql[i - 1]!))) {
      let j = i + 1;
      while (j < n && isName(sql[j]!)) j++;
      const name = sql.slice(i, j);
      let index = names.get(name);
      if (index === undefined) {
        index = max + 1;
        names.set(name, index);
        max = index;
      }
      out.push({ start: i, end: j, index });
      i = j;
      continue;
    }
    if (isName(c)) {
      // 識別子や数の literal の途中の `$` などを、引数と取り違えない。
      while (i < n && isName(sql[i]!)) i++;
      continue;
    }
    i++;
  }
  return out;
}

export function compoundTerms(sql: string): number {
  let code = "";
  for (let i = 0; i < sql.length; ) {
    const c = sql[i]!;
    const close = c === "'" ? "'" : c === '"' ? '"' : c === "`" ? "`" : c === "[" ? "]" : null;
    if (close) {
      for (i++; i < sql.length; i++) {
        if (sql[i] === close) {
          if (close !== "]" && sql[i + 1] === close) i++;
          else break;
        }
      }
      i++;
      code += " ";
    } else if (c === "-" && sql[i + 1] === "-") {
      const j = sql.indexOf("\n", i + 2);
      i = j < 0 ? sql.length : j + 1;
      code += " ";
    } else if (c === "/" && sql[i + 1] === "*") {
      const j = sql.indexOf("*/", i + 2);
      i = j < 0 ? sql.length : j + 2;
      code += " ";
    } else {
      code += c;
      i++;
    }
  }
  return 1 + (code.match(/\b(UNION|INTERSECT|EXCEPT)\b/gi)?.length ?? 0);
}

export function identifierText(sql: string): string {
  let out = "";
  let i = 0;
  const n = sql.length;
  while (i < n) {
    const c = sql[i]!;
    if (c === "'") {
      i++;
      while (i < n) {
        if (sql[i] === "'") {
          if (sql[i + 1] === "'") {
            i += 2;
            continue;
          }
          i++;
          break;
        }
        i++;
      }
      out += " ";
    } else if (c === '"' || c === "`") {
      let id = "";
      i++;
      while (i < n) {
        if (sql[i] === c) {
          if (sql[i + 1] === c) {
            id += c;
            i += 2;
            continue;
          }
          i++;
          break;
        }
        id += sql[i];
        i++;
      }
      out += ` ${id} `;
    } else if (c === "[") {
      const j = sql.indexOf("]", i + 1);
      out += ` ${j < 0 ? sql.slice(i + 1) : sql.slice(i + 1, j)} `;
      i = j < 0 ? n : j + 1;
    } else if (c === "-" && sql[i + 1] === "-") {
      const j = sql.indexOf("\n", i + 2);
      i = j < 0 ? n : j + 1;
      out += " ";
    } else if (c === "/" && sql[i + 1] === "*") {
      const j = sql.indexOf("*/", i + 2);
      i = j < 0 ? n : j + 2;
      out += " ";
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

/** scratch.ts の reads が使っていた判定。 */
export const readsPragmaFunctionOld = (sql: string): boolean => /\bpragma_/i.test(identifierText(sql));

// ---- tokenize (src/sql/lexer.ts) ----
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
