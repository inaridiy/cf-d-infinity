# 値の格納の型とキーの揃え方 (2026-11-12)

キー文字列を作る関数を 1 つにする下調べ (Early 版の線の「順番」の 2) で見つけた。再現は `test/open/storage-class.test.ts` と `test/open/key-affinity.test.ts` にある。

## 束縛と読み出しの型 (調べた結果)

JS の値を束縛して、列に入った値と `typeof` を読んだ。

| 値 | DO の SQLite (workerd、Miniflare) | `node:sqlite` (シミュレータのシャード) | sql.js (Worker の SQLite) |
|---|---|---|---|
| 5 を TEXT の列へ | `"5.0"` | `"5.0"` | `"5"` |
| 5 を型のない列へ | REAL 5.0 | REAL 5.0 | INTEGER 5 |
| 0.1 + 0.2 を TEXT の列へ | `"0.3"` | `"0.3"` | (調べていない) |
| 1e20 を TEXT の列へ | `"1.0e+20"` | `"1.0e+20"` | `"1.0e+20"` |
| BigInt 5n | 束縛できない (`Cannot convert a BigInt value to a number`) | INTEGER 5 | (調べていない) |

- DO の SQLite は、JS の数を、整数でも REAL として束縛する。シミュレータの `node:sqlite` も同じである。Worker の sql.js は、安全な整数を INTEGER として束縛する。
- 読み出しでは、DO の SQLite は INTEGER の 5 も REAL の 5.0 も JS の 5 を返す。2^53 を超える INTEGER は精度を落として返す。
- SQLite の関数は型を保つ。`json_array(c)` は INTEGER の 5 を `[5]`、REAL の 5.0 を `[5.0]` にし、`json_extract('[5.0]', '$[0]')` は REAL を返す。DO で `unhex` は使える。`sqlite_version()` は使えない (`not authorized`)。

## 入口の約束

- Hrana: 値の型は要求に書いてある (`integer` と `float`)。@libsql/client は JS の数を `float`、BigInt と真偽値を `integer` として送る。sqld は、その型のまま束縛する。
- D1 の API: Cloudflare の文書の型の変換表は、Number を「REAL か INTEGER」、Boolean を INTEGER とする。整数の数は INTEGER として束縛される。BigInt は受け付けない。

## 食い違い

1. 整数の引数が、シャードでは REAL として束縛される。TEXT の列には `"5.0"` が入り、`v * ? / 2` は整数の割り算にならない。表を読まない文は Worker の sql.js で答えるので、`SELECT ? / 2` は 2、`SELECT ? / 2 FROM kv WHERE k = 1` は 2.5 になる。
2. 型のない列の REAL の 2.0 は、主キーの等値で読むとシャードが答えて `real`、範囲で読むと Worker の SQLite へ集めて答えて `integer` になる。シャードが 1 つでも起きる。
3. `normalize` (src/sql/cst.ts) が SQLite の型の揃え方と違う。16 進などの文字列を数にする。範囲を超える指数の文字列を文字列のまま残す。TEXT の列に入る実数を JavaScript の書き方で文字列にする (SQLite は有効数字 15 桁)。整数と REAL を区別できないので、TEXT の列に入る整数の引数のキーも `"5"` と `"5.0"` で食い違う。書き込みはシャードが断り (`row of shard key ... written through shard key ...`)、読みは Worker のキーが指すシャードだけを読んで、行を見落とす。

`test/diff.ts` の SQLite との比較は、引数を使わず、結果を JS の値で比べるので、1 と 2 を見ない。sqllogictest も同じである。
