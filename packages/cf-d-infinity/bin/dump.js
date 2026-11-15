// export が書く文と、import がそれを読み戻す処理。CLI と試験の両方から使う。
//
// 値は要素で受け渡す (src/value.ts。docs/storage-format.md の「エクスポート」)。INTEGER は "i" と 10 進の数字、TEXT は "t" と文字列、
// REAL は "r" と 10 進の小数か指数の表記、BLOB は "b" と 16 進、NULL は null。行は要素の配列 (タプル) である。
// Worker (src/transfer.ts の exportPage と importRows) と CLI のあいだの JSON は、この形で行を運ぶ。要素は文字列か null なので、
// JSON で運べない値 (2^53 を超える整数、無限大) も、整数の値の REAL と INTEGER の違いも、NUL を含む TEXT も失わない。
// 形式の版は EXPORT_FORMAT である。Worker の頁、取り込みの呼び出し、書き出した file の 1 行目が、同じ版を持つ。

/** 書き出しの形式の版。src/transfer.ts の EXPORT_FORMAT と同じ値である (test/export-import.test.ts が確かめる)。 */
export const EXPORT_FORMAT = 1;
const FORMAT_LINE = /^-- cf-d-infinity export format (\d+)$/;

const quote = (id) => `"${id.replaceAll('"', '""')}"`;
const INT64_MIN = -(2n ** 63n);
const INT64_MAX = 2n ** 63n - 1n;
const INTEGER_TEXT = /^-?[0-9]+$/;
// src/value.ts の REAL_TEXT と同じ。要素の REAL は 10 進の小数か指数の表記だけである。
const REAL_TEXT = /^-?[0-9]+(\.[0-9]+)?(e[+-]?[0-9]+)?$/;
const HEX_TEXT = /^(?:[0-9A-Fa-f]{2})*$/;

/** REAL を要素の文字列にする (src/value.ts の realText と同じ)。小数点も指数もなければ `.0` を足す。無限大は `9.0e+999`。 */
function realText(x) {
  if (x === Infinity) return "9.0e+999";
  if (x === -Infinity) return "-9.0e+999";
  const s = String(x === 0 ? 0 : x);
  return /[.e]/.test(s) ? s : `${s}.0`;
}

/** 書き出す file の先頭の行。1 行目が形式の版である。 */
export function exportHeader() {
  return [
    `-- cf-d-infinity export format ${EXPORT_FORMAT}`,
    "-- cf-d-infinity logical export. One statement per line. Not a consistent snapshot unless writes were stopped.",
    "-- Load it into an empty database with: npx cf-d-infinity import <this file>",
  ];
}

/**
 * file の先頭の注釈の行から、形式の版を読む。版の行がないか、版が違えば投げる。最初の公開の前は、ほかの版の file を読まない
 * (後方互換を持たない)。
 */
export function fileFormat(lines) {
  for (const raw of lines) {
    const line = raw.trim();
    const m = FORMAT_LINE.exec(line);
    if (m) {
      const format = Number(m[1]);
      if (format !== EXPORT_FORMAT) {
        throw new Error(`the file is in export format ${format}, and this cf-d-infinity reads export format ${EXPORT_FORMAT}; import it with the version that exported it, or export it again`);
      }
      return format;
    }
    if (line !== "" && !line.startsWith("--")) break;
  }
  throw new Error(`the file has no export format line ("-- cf-d-infinity export format ${EXPORT_FORMAT}" at the top); import reads only files that \`cf-d-infinity export\` wrote`);
}

/**
 * 要素を SQL の literal にする。SQLite がその literal を読むと、同じ型の同じ値になる。INTEGER は数字のまま (64 ビットの端まで)、
 * REAL は小数点か指数を付けて書く (SQLite は小数点か指数のある数の literal を REAL として読む。無限大は `9.0e+999`)。
 * TEXT の改行と NUL は、1 文が 1 行に収まるよう、char() の連結にする。要素でないものは、別の値として書かずに投げる。
 */
export function literal(e) {
  if (e === null) return "NULL";
  if (typeof e === "string") {
    const rest = e.slice(1);
    switch (e[0]) {
      case "i":
        if (INTEGER_TEXT.test(rest) && BigInt(rest) >= INT64_MIN && BigInt(rest) <= INT64_MAX) return rest;
        break;
      case "r":
        if (REAL_TEXT.test(rest)) return /[.e]/.test(rest) ? rest : `${rest}.0`;
        break;
      case "b":
        if (HEX_TEXT.test(rest)) return `X'${rest.toUpperCase()}'`;
        break;
      case "t": {
        const quoted = `'${rest.replaceAll("'", "''")}'`;
        return quoted.replace(/[\n\r\0]/g, (c) => `' || char(${c.charCodeAt(0)}) || '`);
      }
    }
  }
  throw new Error(`not an element: ${JSON.stringify(e)?.slice(0, 40)}`);
}

/** 1 行に 1 文の INSERT にする。1 文は 100 行まで、およそ 64 KB までにまとめる。大きな行は 1 行で 1 文になる。行はタプルで受ける。 */
export function insertLines(table, columns, rows) {
  const out = [];
  const head = `INSERT INTO ${quote(table)}(${columns.map(quote).join(", ")}) VALUES `;
  let batch = [];
  let size = 0;
  const flush = () => {
    if (batch.length === 0) return;
    out.push(`${head}${batch.join(", ")};`);
    batch = [];
    size = 0;
  };
  for (const row of rows) {
    const tuple = `(${row.map(literal).join(", ")})`;
    const bytes = Buffer.byteLength(tuple);
    if (size + bytes > 64_000 || batch.length >= 100) flush();
    batch.push(tuple);
    size += bytes;
  }
  flush();
  return out;
}

/**
 * insertLines が書いた 1 行を、表、列、行 (タプル) に戻す。その形でなければ null を返す。
 * literal は SQLite と同じ読み方で要素にする。小数点も指数もない数は、64 ビットに収まれば INTEGER、収まらなければ REAL である。
 * 値を取り出して引数で渡せば、文の長さの上限 (100 KB) に当たらない。リテラルのまま送ると、大きな値やマルチバイトの文字の行が入らない。
 */
export function parseInsert(line) {
  const head = /^INSERT INTO ((?:"(?:[^"]|"")*"))\(((?:"(?:[^"]|"")*"(?:, )?)+)\) VALUES /.exec(line);
  if (!head || !line.endsWith(";")) return null;
  const unquote = (s) => s.slice(1, -1).replaceAll('""', '"');
  const columns = [...head[2].matchAll(/"(?:[^"]|"")*"/g)].map((m) => unquote(m[0]));
  const rows = [];
  let i = head[0].length;
  const fail = () => null;
  const text = () => {
    // '...' を 1 つ読む。'' は ' 1 文字である。
    let out = "";
    i++;
    for (;;) {
      const end = line.indexOf("'", i);
      if (end < 0) throw new Error("unterminated string");
      out += line.slice(i, end);
      i = end + 1;
      if (line[i] !== "'") return out;
      out += "'";
      i++;
    }
  };
  try {
    for (;;) {
      if (line[i] !== "(") return fail();
      i++;
      const row = [];
      for (;;) {
        if (line.startsWith("NULL", i)) {
          row.push(null);
          i += 4;
        } else if (line.startsWith("X'", i)) {
          const end = line.indexOf("'", i + 2);
          if (end < 0) return fail();
          const hex = line.slice(i + 2, end);
          if (!HEX_TEXT.test(hex)) return fail();
          row.push(`b${hex.toUpperCase()}`);
          i = end + 1;
        } else if (line[i] === "'") {
          let s = text();
          // 改行と NUL は ' || char(n) || ' でつないである。
          for (let m; (m = /^ \|\| char\((\d+)\) \|\| /.exec(line.slice(i, i + 24))); ) {
            i += m[0].length;
            if (line[i] !== "'") return fail();
            s += String.fromCharCode(Number(m[1])) + text();
          }
          row.push(`t${s}`);
        } else {
          const m = /^-?(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:[eE][+-]?[0-9]+)?/.exec(line.slice(i, i + 400));
          if (!m) return fail();
          const big = INTEGER_TEXT.test(m[0]) ? BigInt(m[0]) : null;
          row.push(big !== null && big >= INT64_MIN && big <= INT64_MAX ? `i${big}` : `r${realText(Number(m[0]))}`);
          i += m[0].length;
        }
        if (line.startsWith(", ", i)) i += 2;
        else if (line[i] === ")") {
          i++;
          break;
        } else return fail();
      }
      if (row.length !== columns.length) return fail();
      rows.push(row);
      if (line.startsWith(", ", i)) i += 2;
      else if (line.slice(i) === ";") return { table: unquote(head[1]), columns, rows };
      else return fail();
    }
  } catch {
    return null;
  }
}

/** 1 回の呼び出しで入れる行の束に分ける。1 つの取引が 1 シャードに書ける量 (1 MB) に収まるよう、小さめに切る。 */
export function importBatches(rows, maxBytes = 200_000) {
  const out = [];
  let batch = [];
  let size = 0;
  for (const row of rows) {
    const bytes = Buffer.byteLength(JSON.stringify(row));
    if (batch.length > 0 && size + bytes > maxBytes) {
      out.push(batch);
      batch = [];
      size = 0;
    }
    batch.push(row);
    size += bytes;
  }
  if (batch.length > 0) out.push(batch);
  return out;
}
