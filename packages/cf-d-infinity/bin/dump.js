// export が書く文と、import がそれを読み戻す処理。CLI と試験の両方から使う。

const quote = (id) => `"${id.replaceAll('"', '""')}"`;

/** 値を SQL のリテラルにする。BLOB は { $blob: 16 進 } で受ける。 */
export function literal(v) {
  if (v === null || v === undefined) return "NULL";
  if (typeof v === "number") return Number.isFinite(v) ? String(v) : Number.isNaN(v) ? "NULL" : v > 0 ? "9e999" : "-9e999";
  if (typeof v === "object" && typeof v.$blob === "string") return `X'${v.$blob}'`;
  const quoted = `'${String(v).replaceAll("'", "''")}'`;
  return quoted.replace(/[\n\r\0]/g, (c) => `' || char(${c.charCodeAt(0)}) || '`);
}

/** 1 行に 1 文の INSERT にする。1 文は 100 行まで、およそ 64 KB までにまとめる。大きな行は 1 行で 1 文になる。 */
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
 * insertLines が書いた 1 行を、表、列、値に戻す。その形でなければ null を返す。
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
          row.push({ $blob: line.slice(i + 2, end) });
          i = end + 1;
        } else if (line[i] === "'") {
          let s = text();
          // 改行と NUL は ' || char(n) || ' でつないである。
          for (let m; (m = /^ \|\| char\((\d+)\) \|\| /.exec(line.slice(i, i + 24))); ) {
            i += m[0].length;
            if (line[i] !== "'") return fail();
            s += String.fromCharCode(Number(m[1])) + text();
          }
          row.push(s);
        } else {
          const m = /^-?[0-9.eE+-]+/.exec(line.slice(i, i + 40));
          if (!m) return fail();
          row.push(m[0] === "9e999" ? Infinity : m[0] === "-9e999" ? -Infinity : Number(m[0]));
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
