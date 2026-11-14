// 構文木を文面に戻す。
//
// 節の欄を、作った順 (文面に現れる順。parser.ts) にたどって、葉の文面と、節の前後の空白と注釈を出す。
// 木に持たない記号 (括弧、`,`、`.`、`=`、`*`) は、節の種類ごとに足す。
// 木を書き換えてから出し直せる: 引数の葉の text を `?` に替える (cst.ts の bindParams)、制約や列を配列から外す (ddl.ts)。
import type { Node } from "./parser";

/** 文面に出さない欄。 */
const SKIP = new Set(["type", "range", "leading", "trailing"]);

/** 出力の 1 片。trivia は、空白と注釈である。 */
type Piece = { text: string; trivia: boolean };

function emit(n: unknown, out: Piece[]): void {
  if (n === null || n === undefined) return;
  if (typeof n === "string") {
    out.push({ text: n, trivia: false });
    return;
  }
  if (typeof n !== "object") return;
  if (Array.isArray(n)) {
    for (const x of n) emit(x, out);
    return;
  }
  const node = n as Node;
  if (node.leading) out.push({ text: node.leading, trivia: true });
  body(node, out);
  if (node.trailing) out.push({ text: node.trailing, trivia: true });
}

function separated(items: Node[], separator: string, out: Piece[]): void {
  items.forEach((item, i) => {
    if (i > 0) out.push({ text: separator, trivia: false });
    emit(item, out);
  });
}

function body(node: Node, out: Piece[]): void {
  // 葉 (予約語、識別子、literal、引数) は、文面をそのまま持っている。
  if (typeof node.text === "string") {
    out.push({ text: node.text, trivia: false });
    return;
  }
  switch (node.type) {
    case "paren_expr":
      out.push({ text: "(", trivia: false });
      emit(node.expr, out);
      out.push({ text: ")", trivia: false });
      return;
    case "list_expr":
      separated(node.items, ",", out);
      return;
    case "member_expr":
      emit(node.object, out);
      out.push({ text: ".", trivia: false });
      emit(node.property, out);
      return;
    case "all_columns":
      out.push({ text: "*", trivia: false });
      return;
    case "column_assignment":
      emit(node.column, out);
      out.push({ text: "=", trivia: false });
      emit(node.expr, out);
      return;
    case "pragma_assignment":
      emit(node.name, out);
      out.push({ text: "=", trivia: false });
      emit(node.value, out);
      return;
    case "limit_clause":
      // `LIMIT 飛ばす数, 件数` の `,`。OFFSET の形では、予約語が欄にある。
      if (node.offset && !node.offsetKw) {
        emit(node.limitKw, out);
        emit(node.offset, out);
        out.push({ text: ",", trivia: false });
        emit(node.count, out);
        return;
      }
      break;
    case "program":
      separated(node.statements, ";", out);
      return;
    default:
      break;
  }
  for (const k of Object.keys(node)) if (!SKIP.has(k)) emit(node[k], out);
}

/**
 * 節の文面。節の外側の空白と注釈は付けない (節の中のものは残す)。
 * 外側の注釈を付けないのは、出した文面を括弧で包んだり、後ろに句を足したりするからである。行末までの注釈が
 * 末尾に残ると、足した文面が注釈に呑まれる。
 */
export function print(n: Node): string {
  const out: Piece[] = [];
  emit(n, out);
  let from = 0;
  let to = out.length;
  while (from < to && out[from]!.trivia) from++;
  while (to > from && out[to - 1]!.trivia) to--;
  let s = "";
  for (let i = from; i < to; i++) s += out[i]!.text;
  return s;
}
