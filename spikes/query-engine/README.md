# query-engine spike: Worker 内 SQLite WASM と SQLite 文法パーサの実測

ローカル workerd (miniflare 4.20260730.0) のみ。本番未デプロイ。時間は Node 側で `dispatchFetch` の往復を測った (workerd の `Date.now()` は要求中に進まないため)。往復には 1〜2 ms の固定費が含まれる。

実行: `npm install && npx esbuild bench-sqljs.src.js --bundle --format=esm --platform=browser --outfile=dist/bench-sqljs.js --external:./sql-wasm.wasm --external:crypto --external:fs --external:path && node run-sqljs.mjs`。パーサは `node parsers.mjs`、`node parsers2.mjs`。

## SQLite WASM が workerd で動くか

| ビルド | 結果 | JS bundle | wasm | 初回 init | 2 回目 |
|---|---|---|---|---|---|
| sql.js 1.13.0 (SQLite 3.49.1) | 動く (`instantiateWasm` で `CompiledWasm` モジュールを渡す。`self.location` の shim が必要) | 82 KB | 644 KB | 74 ms | 2 ms |
| wa-sqlite 1.0.0 (SQLite 3.44.0、同期ビルド) | 動く (`import.meta.url` を define で与える) | 92 KB | 545 KB | 72 ms | 2 ms |
| @sqlite.org/sqlite-wasm 3.50.4 (公式) | 動かない。起動時に小さな wasm を実行時生成するため `Wasm code generation disallowed by embedder` | 445 KB | 836 KB | - | - |

## sql.js の処理時間 (行は JS オブジェクトとして生成し、prepared statement で 1 取引に投入)

| 操作 | 10 万行 | 50 万行 |
|---|---|---|
| 行の生成だけ (差し引き用) | 10 ms | - |
| 投入 (CREATE + INSERT ×n + COMMIT) | 115〜123 ms (生成込み) | 437 ms |
| GROUP BY 1,000 グループ + count + sum | 33 ms | 169 ms |
| GROUP BY + HAVING + ORDER BY + LIMIT 10 | 25〜28 ms | - |
| DISTINCT (5,000 種) | 33 ms | - |
| row_number() OVER (ORDER BY) LIMIT 10 | 20 ms | - |
| JOIN 10 万 × 10 万 (PK 結合) | 13 ms | - |
| JOIN 非 index 列 (左 2,000 行) | 85〜88 ms | - |
| ORDER BY LIMIT 10 (Top-N) | 9 ms | - |
| JSON stringify + parse 10 万行 (4.5 MB) | 30 ms | - |
| DB サイズ (`export()`) | 4.7 MB (2 表 20 万行) | 11.9 MB |

WASM ヒープの実サイズは取れなかった (sql.js の exports に memory が無い)。DB サイズと JS 側の行 (10 万行で 10 MB 程度と推定) から、128 MB の isolate で安全に扱えるのは 20〜30 万行程度と推定する。

## DO 側 SQLite との機能差

DO の SQLite は `sqlite_version()` を authorizer が禁止するので版は読めない。`->>`、math 関数、窓関数、`FILTER` は DO でも sql.js でも動いた。sql.js は FTS5 を持たない (FTS3 のみ)。DO は FTS5 を持つ (公式 docs)。FTS の `MATCH` はシャードへ押し下げるしかない。

## パーサ比較 (23 構文)

| パーサ | 通った数 | 落ちた構文 | minified bundle | 解析 1 文 |
|---|---|---|---|---|
| sql-parser-cst 0.33.1 (sqlite) | 21 | `VALUES ... AS v(id, name)` (別名の列リスト)、`?2` / `:g` は `paramTypes` 指定で通る | 627 KB | 368 µs |
| pgsql-ast-parser 12 | 17 | INSERT OR REPLACE、PARTITION BY 窓、COLLATE/NULLS LAST、GLOB、STRICT、params | 245 KB | - |
| node-sql-parser 5.3.12 (sqlite) | 14 | ON CONFLICT、UPDATE FROM、OVER (ORDER BY)、PARTITION BY 窓、FILTER、COLLATE、IS NOT / GLOB、VALUES、params | 215 KB | 80 µs |
| sqlite-parser 1.0.1 | 12 | ON CONFLICT、RETURNING、UPDATE FROM、窓、FILTER、JSON 演算子、STRICT など | - | - |

sql-parser-cst は CST (空白とコメントを保持) なので `show()` で文を復元でき、押し下げの書き換えに使える。
