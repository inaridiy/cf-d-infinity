import type { Value } from "../types";

/** 引用符とコメントの外にある位置だけを走査して、f の結果で置き換える。 */
function scan(sql: string, f: (rest: string) => { skip: number; text: string } | null): string {
  let out = "";
  for (let i = 0; i < sql.length; ) {
    const ch = sql[i]!;
    if (ch === "'" || ch === '"' || ch === "`") {
      let j = i + 1;
      while (j < sql.length) {
        if (sql[j] === ch) {
          if (sql[j + 1] === ch) j += 2;
          else break;
        } else j++;
      }
      out += sql.slice(i, j + 1);
      i = j + 1;
      continue;
    }
    if (sql.startsWith("--", i) || sql.startsWith("/*", i)) {
      const end = sql.startsWith("--", i) ? sql.indexOf("\n", i) : sql.indexOf("*/", i) + 1;
      const stop = end < 0 ? sql.length : end + 1;
      out += sql.slice(i, stop);
      i = stop;
      continue;
    }
    const hit = f(sql.slice(i));
    if (hit) {
      out += hit.text;
      i += hit.skip;
    } else {
      out += ch;
      i++;
    }
  }
  return out;
}

/** `?` を `:pN` に置き換える。パーサが値の位置を保持できるようにするためである。 */
export function nameParams(sql: string): string {
  let n = 0;
  return scan(sql, (rest) => (rest[0] === "?" ? { skip: 1, text: `:p${n++}` } : null));
}

/** `:pN` を `?` に戻し、出現順に値を並べる。 */
export function toPositional(sql: string, params: Value[]): { sql: string; params: Value[] } {
  const ordered: Value[] = [];
  const text = scan(sql, (rest) => {
    const m = /^:p(\d+)/.exec(rest);
    if (!m) return null;
    ordered.push(params[Number(m[1])] ?? null);
    return { skip: m[0].length, text: "?" };
  });
  return { sql: text, params: ordered };
}
