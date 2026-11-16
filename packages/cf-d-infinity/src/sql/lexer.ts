// SQLite の方言の字句解析。規則は SQLite の tokenize.c に合わせる。
// 空白と注釈は捨てず、次のトークンの ws に入れる。文を元の文面のまま出し直すためである (src/sql/printer.ts)。
//
// 字句の規則は、ここの Scanner の 1 か所にある。構文解析 (tokenize)、式の深さの見積もり (src/sql/depth.ts)、文の中の引数の位置
// (src/value.ts の placeholders)、複合 SELECT の項の数 (src/shard-limits.ts の compoundTerms)、PRAGMA の関数の名前
// (src/sql/scratch.ts の namesPragmaFunction) は、どれもこれで文面を読む。前は後ろの 3 つが、それぞれ手書きで文字列と注釈を
// 飛ばしていた (計画書の未解決の問題 48)。文面の読み手が 2 つあると、片方だけが注釈や引用を読み違える (構文解析の前に文面を
// 書き換えていた前の経路は、注釈を読み違えた)。
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

/** 数字の並びを読む。SQLite 3.46 からの、数字の間の `_` も読む。 */
function digits(src: string, i: number, ok: (c: number) => boolean): number {
  while (ok(src.charCodeAt(i)) || (src.charCodeAt(i) === 95 && ok(src.charCodeAt(i - 1)) && ok(src.charCodeAt(i + 1)))) i++;
  return i;
}

/** 演算子と区切りの記号の長さ。記号でなければ 0。 */
function opLength(src: string, i: number): number {
  const c = src.charCodeAt(i);
  const d = src.charCodeAt(i + 1);
  switch (c) {
    case 45: // -
      return d === 62 ? (src.charCodeAt(i + 2) === 62 ? 3 : 2) : 1; // ->> と ->
    case 124: // |
      return d === 124 ? 2 : 1;
    case 60: // <
      return d === 60 || d === 61 || d === 62 ? 2 : 1; // << <= <>
    case 62: // >
      return d === 62 || d === 61 ? 2 : 1; // >> >=
    case 61: // =
      return d === 61 ? 2 : 1;
    case 33: // !
      return d === 61 ? 2 : 0; // != だけ。`!` だけは SQLite でも誤り
    case 43: case 42: case 47: case 37: case 38: case 126: case 40: case 41: case 44: case 59: case 46: // + * / % & ~ ( ) , ; .
      return 1;
    default:
      return 0;
  }
}

/** Scanner の字句の種類。"illegal" は、SQLite が TK_ILLEGAL とする誤った字句である。 */
export type ScanKind = Exclude<TokenKind, "eof"> | "illegal";

/**
 * 字句を 1 つずつ読む。字句の規則はここ 1 か所にある。
 * 誤った字句 (閉じていない引用、16 進でない BLOB、数に続く識別子の文字、名前のない `:`、知らない文字) では投げずに、"illegal" の
 * 字句として読み進める。SQLite の tokenize.c も TK_ILLEGAL を返して進む。誤りにするのは使う側である (tokenize は投げる。文面を
 * 走査するだけの関数は、誤った字句を飛ばす。そういう文は、構文解析か SQLite が断る)。
 * 字句ごとに object を作らないので、シャードが文ごとに走らせる数え上げ (compoundTerms) にも使える。
 */
export class Scanner {
  /** 今の字句の種類。 */
  kind: ScanKind = "illegal";
  /** 今の字句の前の空白と注釈の始まり (前の字句の終わり)。 */
  wsStart = 0;
  /** 今の字句の始まりと終わり。 */
  start = 0;
  end = 0;

  constructor(readonly src: string) {}

  /** 次の字句へ進む。文の終わりに着いたら false を返す (そのとき start と end は文の長さ、wsStart は末尾の空白と注釈の始まり)。 */
  next(): boolean {
    const src = this.src;
    const n = src.length;
    let i = this.end;
    this.wsStart = i;
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
    this.start = i;
    if (i >= n) {
      this.end = n;
      return false;
    }
    const c = src.charCodeAt(i);
    let kind: ScanKind;
    let j: number;
    if (c === 39 || c === 34 || c === 96) {
      // ' " `。引用符は、2 つ重ねると中の 1 文字になる。閉じていなければ、文の終わりまでが誤った字句である。
      kind = c === 39 ? "string" : "quoted";
      j = i + 1;
      for (;;) {
        if (j >= n) {
          kind = "illegal";
          break;
        }
        if (src.charCodeAt(j) === c) {
          if (src.charCodeAt(j + 1) !== c) {
            j++;
            break;
          }
          j++;
        }
        j++;
      }
    } else if (c === 91) {
      // [
      const e = src.indexOf("]", i);
      kind = e < 0 ? "illegal" : "quoted";
      j = e < 0 ? n : e + 1;
    } else if ((c === 120 || c === 88) && src.charCodeAt(i + 1) === 39) {
      // x'...'。16 進でない文字か、奇数個の桁なら、SQLite は閉じる引用符までを 1 つの誤った字句にする。
      j = i + 2;
      while (isHex(src.charCodeAt(j))) j++;
      if (src.charCodeAt(j) !== 39 || (j - i) % 2 !== 0) {
        while (j < n && src.charCodeAt(j) !== 39) j++;
        kind = "illegal";
        j = Math.min(j + 1, n);
      } else {
        kind = "blob";
        j++;
      }
    } else if (isDigit(c) || (c === 46 && isDigit(src.charCodeAt(i + 1)))) {
      kind = "number";
      if (c === 48 && (src.charCodeAt(i + 1) === 120 || src.charCodeAt(i + 1) === 88) && isHex(src.charCodeAt(i + 2))) {
        j = digits(src, i + 2, isHex);
      } else {
        j = digits(src, i, isDigit);
        if (src.charCodeAt(j) === 46) j = digits(src, j + 1, isDigit);
        const e = src.charCodeAt(j);
        if (e === 101 || e === 69) {
          const s = src.charCodeAt(j + 1);
          const sign = s === 43 || s === 45 ? 1 : 0;
          if (isDigit(src.charCodeAt(j + 1 + sign))) j = digits(src, j + 1 + sign, isDigit);
        }
      }
      // 数の直後に識別子の文字が続くもの (`1e`、`0x`、`12abc`) は、SQLite では誤った字句である。
      if (isIdChar(src.charCodeAt(j))) {
        while (isIdChar(src.charCodeAt(j))) j++;
        kind = "illegal";
      }
    } else if (isIdStart(c)) {
      kind = "word";
      j = i + 1;
      while (isIdChar(src.charCodeAt(j))) j++;
    } else if (c === 63) {
      // ?NNN
      kind = "param";
      j = i + 1;
      while (isDigit(src.charCodeAt(j))) j++;
    } else if (c === 58 || c === 64 || c === 36) {
      // :name @name $name。名前がなければ誤り。
      j = i + 1;
      while (isIdChar(src.charCodeAt(j))) j++;
      kind = j === i + 1 ? "illegal" : "param";
    } else {
      const len = opLength(src, i);
      kind = len === 0 ? "illegal" : "op";
      j = i + Math.max(len, 1);
    }
    this.kind = kind;
    this.end = j;
    return true;
  }
}

/** 文を字句に分ける。誤った字句があれば、SQLite と同じ文面の誤り (`unrecognized token: "..."`) で投げる。 */
export function tokenize(src: string): Token[] {
  const out: Token[] = [];
  const s = new Scanner(src);
  while (s.next()) {
    const { kind, start, end } = s;
    if (kind === "illegal") throw new SqlError(`unrecognized token: "${src.slice(start, Math.min(end, start + 40))}"`);
    const text = src.slice(start, end);
    out.push({ kind, text, upper: kind === "word" ? text.toUpperCase() : "", start, end, ws: src.slice(s.wsStart, start) });
  }
  out.push({ kind: "eof", text: "", upper: "", start: src.length, end: src.length, ws: src.slice(s.wsStart) });
  return out;
}

/** 引用した識別子の、引用符を外した名前。 */
export function unquote(text: string): string {
  const q = text[0]!;
  if (q === "[") return text.slice(1, -1);
  return text.slice(1, -1).replaceAll(q + q, q);
}
