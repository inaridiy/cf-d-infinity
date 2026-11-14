# 値と行イメージの作り直しの設計

状態：設計。段 0 (検査)、段 1 (符号とキー)、段 2 (行イメージと捕捉) を実装した。段 3 から先はまだない。持ち主の判断と、段 0 から段 2 の結果は末尾に記した
作成日：2026-11-14
前提：[storage-format.md](./storage-format.md)、[sql-language.md](./sql-language.md) の「値」、[design-subslots.md](./design-subslots.md)

コードの行番号は `71eda05` (ブランチ `subslots`) のもので、`src/` と `test/` は `packages/cf-d-infinity/` の下を指す。
今のコードの挙動についての記述は、コードを読んだ結果である。
SQLite の挙動についての記述は、node:sqlite (SQLite 3.51.3) と sql.js 1.13.0 (SQLite 3.49.1) で小さなスクリプトを流して確かめた。
workerd についての記述は、段 0 で、手元の workerd 1.20260730.1 (Miniflare 4.20260730.0) の DO の SQLite で流して確かめた (2026-11-14、`test/workerd-limits.test.ts`)。
本番の Cloudflare では流していない。
計測の数字は node:sqlite でのもので、変更の前後の比としてだけ読める。

## 結論

64 ビットの整数を、入口から保存、移動、書き出しまで、丸めずに通す。
そのために、値の JS の型、シャードから値を読む文、行イメージ、変更の捕捉の 4 つを作り直す。

| 要素 | 決定 |
|---|---|
| 値の型 | `Value = null \| bigint \| number \| string \| Uint8Array`。JS の型が SQLite の格納の型である。`bigint` は INTEGER、`number` は REAL。印 `{ real }` はなくなる |
| 値 1 つの符号 (**要素**) | `'i'` と 10 進の数字 (INTEGER)、`'t'` と文字列 (TEXT)、`'r'` と `quote()` の文字列 (REAL)、`'b'` と 16 進 (BLOB)、`null`。SQL の中でも JS でも同じ形に作れる |
| 行イメージ (**タプル**) | 表定義の列の順に並べた要素の JSON の配列。列名は持たない。変更ログ、intent、移動のペイロード、取引が溜める変更が、この形で行を運ぶ |
| シャードからの読み | シャードが返す結果は、すべて型つきで読む。利用者の SELECT は CTE で包み、INTEGER と TEXT の列に印を付けて読む。利用者の RETURNING は Worker が項ごとに書き換える |
| 束縛 | INTEGER は今と同じ `(CAST(? AS INTEGER)+0)` で包む。2^53 を超える値は、10 進の文字列を束縛して同じ式で包む |
| キー文字列 | 形は今のまま (値の並びの JSON)。整数は、桁数に関わらず 10 進の数字で書く。今入れられる値のキーは、1 つの場合を除いて 1 バイトも変わらない |
| 型の親和性の変換 | `storedAs` を消す。変換のない場合と、1 行で書ける正確な変換だけを JS に残し、ほかは Worker の SQLite の列に入れて読む |
| 捕捉 | 共有の `__cap(seq, tbl, old, new)` に、trigger がタプルを書く。`__capv_<表>` はなくなる。変更後の行は trigger の `new` から取り、本体から読み直さない |
| 消えるもの | K1 の拒否、`Real`、`fromTyped`、`typedScalarSql`、`typedRow`、`typedValues`、`imageList`、`__dinf_wide`、`__dinf_typeof_<i>`、`hasWideInteger`、`keySql`、`storedAs`、列名の予約 (`$` と `__dinf_`) |
| 段 | 5 段。検査、符号とキー、行イメージと捕捉、値の型と型つきの読み、入口と書き出し |

刷新案 (`.agents/execplans/evidence/2026-11-14-clean-slate-architecture.md` の 1) から変えた点が 4 つある。

- 刷新案は、`quote()` が 5 つの格納の型を「無損失かつ一意に」文字列にすると書いている。TEXT については成り立たない。`quote('a' || char(0) || 'b')` は `'a'` を返し、NUL から後ろを落とす (2 つのエンジンで確かめた)。そこで `quote()` は REAL にだけ使い、TEXT は印を前に付けてそのまま運ぶ。
- `json_array(quote(c1), ...)` は、列が 33 以上の表で、DO の SQLite の関数の引数の上限 (32、`docs/platform-facts.md`) に当たる。32 個ずつの入れ子にする。
- 刷新案は行イメージだけを扱っている。64 ビットの整数を通すには、利用者の文の結果も正確に読む必要がある。主キーで 1 行を読む `SELECT * FROM t WHERE id = ?` は、文をそのままシャードへ送る経路を通るからである。
- キーの型の親和性を「Worker の SQLite に評価させれば不一致がゼロになる」とは言えない。Worker の SQLite (sql.js、3.49.1) と DO の SQLite は版が違い、REAL を TEXT にする書式は版で変わったことがある (`src/keys.ts:37`)。版で結果が変わり得る変換は、絞り込みに使う範囲を今より広げない。

これは、2026-11-12 の 2 つの決定 (計画書の Decision Log) を取り消す。
「BigInt で INTEGER を表す案は採らない」の理由は、DO の SQLite が BigInt を束縛できないことと、整数の値の REAL を表す手段がどちらにしても要ることだった。
束縛は 10 進の文字列を `CAST` で包めば足り、`number` をいつも REAL とすれば、整数の値の REAL に印は要らない。
「結果の数の型は運ばない」の理由は、結果の列ごとに `typeof` を足す費用だった。
費用は「費用」の節に測った値を書いた (8 列の行で 1 行あたり約 1 µs)。
型を運ぶと、「整数の値の REAL を Hrana の `integer` で返す」という sqld との違いもなくなる。

並行の仕組みは足さないので、Quint のモデルは書かない (規則 3。2026-11-12 の値の型の作り直しと同じ立場である)。
確かめるのは、SQLite との突き合わせである。

## 確かめた事実

| 事実 | node:sqlite 3.51.3 | sql.js 3.49.1 | 手元の workerd (DO の SQLite) |
|---|---|---|---|
| `quote()` は TEXT を最初の NUL で切る | 切る | 切る | 切る |
| `'t' \|\| x` と `json_array` は、値として NUL を保つ (`hex()` で見える。`json_array` は `\u0000` と書く) | 保つ | 保つ | 保つ |
| ドライバは、結果の TEXT を NUL を含めて全部返す | 返さない。最初の NUL で切る | 返さない。最初の NUL で切る | 返す |
| `(CAST(? AS INTEGER)+0)` に 10 進の文字列を束縛すると、±2^63 の端まで正確な INTEGER になる。型の親和性は持たない | 正確 | 正確 | 正確 |
| `'i' \|\| c` と `json_array(c)` は、64 ビットの整数を全桁書く | 書く | 書く | 書く |
| `json_array` の REAL は 15 桁に丸まる (`0.30000000000000004` が `0.3`) | 丸まる | 丸まる | (使わない) |
| `quote()` で書いた REAL を JS の `Number()` で読むと、元の double に戻る (double 20,285 個) | 戻る | 戻る | 戻る |
| CTE の列を 2 回参照すると、`random()` が 2 回評価される | される | される | される |
| `FROM (SELECT * FROM r LIMIT -1 OFFSET 0)` を挟むと 1 回になる。実行は co-routine で、中間の表は作らない | 1 回 | 1 回 | 1 回 |
| AFTER trigger の `new.*` は、型の親和性を掛けた後の値で、採番した rowid が入っている | そう | そう | そう |
| INSERT の RETURNING で、整数を入れた REAL の列を `CASE ... ELSE c END` に通すと、ドライバには INTEGER として届く (`typeof` は `real`) | 届く | 届く | JS の数の 5 として届く (DO のドライバは INTEGER と REAL を区別しない)。`'r' \|\| quote(c)` は `r5.0` を返す |
| 文を用意するだけで (実行せずに)、結果の列名が取れる。RETURNING の列名も取れる | 取れる | 取れる | (Worker の sql.js だけが使う) |
| INTEGER と REAL の等値は正確に比べる (`9007199254740993 = 9007199254740992.0` は偽) | 正確 | 正確 | 正確 |
| REAL を、型の親和性ごとの 5 つの列 (TEXT、NUMERIC、INTEGER、REAL、型なし) に入れた結果 (double 20,285 個) | 3 つとも一致 | | |
| 文字列を、同じ 5 つの列に入れた結果 (113,390 個) | 3 つとも一致 | | |
| BigInt を束縛する | INTEGER になる | TEXT になる | 束縛できない (TypeError になる。計画書の未解決の問題 20) |
| JS の数を束縛する | REAL になる | 32 ビットに収まる整数の値は INTEGER、ほかは REAL | REAL になる。NaN は NULL になる |
| INTEGER を読む | 既定は 2^53 を超えると例外。`setReadBigInts` で BigInt | `useBigInt` で BigInt | 丸めた `number` |
| `JSON.parse` の reviver が元の文面 (`context.source`) を受け取る | Node 24.15 で受け取る | | 受け取る |
| structured clone が BigInt を運ぶ | Node で運ぶ | | DO の RPC も、Service Binding の RPC も運ぶ (object の中の BigInt も) |
| SQLite の版 | 3.51.3 | 3.49.1 | `sqlite_version()` は呼べない (許可されていない関数)。挙動は 3.47 のもので、workerd の実行ファイルは `3.47.0` の文字列を持つ |

workerd の列は、段 0 で `test/workerd-limits.test.ts` に足して確かめた。
手元の workerd の結果で、本番の結果ではない。
事実は見たとおりに試験に書いてあるので、workerd を上げて結果が変わると、その試験が落ちる。
値の集まり (double と文字列) は `test/value-corpus.ts` が作る。

この設計が頼っていた事実のうち、違っていたのは 1 つで、workerd ではなく、node:sqlite と sql.js のドライバの側だった。
どちらも、結果の TEXT を最初の NUL で切って返す (3 行目)。
SQL の中の値は切れていないので、`hex()` や `json_array` を通せば全部が届く。
この違いから、次のことが決まる。

- Worker の SQLite (sql.js) から TEXT を素の列で読むと、NUL から後ろを失う。`storedValue` (段 1) は、変換した値をタプル (`json_array`) で読む。`useBigInt` の素の読みは使わない。
- 「Worker の SQLite」の節の「`useBigInt` で読む。読んだ値はそのまま `Value` である」は、TEXT については成り立たない。段 3 で `ScratchDb` の `query` を作るときに、TEXT を正確に読む形を決める。候補は 2 つある。結果の行をタプルで読む形と、TEXT を `CAST(... AS BLOB)` で読んで UTF-8 として戻す形である (`CAST('t' || c AS BLOB)` が全部のバイトを返すことは、node:sqlite で確かめた)。
- シミュレータ (node:sqlite) の型つきの読みは、`'t' || c` を NUL で切って受け取る。DO では切れない。DO にできることがシミュレータにできない向きの違いなので、欠陥が黙って通ることはないが、NUL を含む TEXT の試験はシミュレータで落ちる。これも段 3 で決める。シミュレータの `query` が TEXT を正確に読む形にするか、NUL を含む TEXT の検査を workerd に置くかである。
- 今のコードも、この違いで NUL を含む TEXT を失う (`test/open/nul-in-text.test.ts`)。シャードが答える文は全部を返し、Worker の SQLite が答える文は切って返す。INSERT … SELECT は、切れた値を保存する。シミュレータの検査は、シャードの側も基準の側も node:sqlite なので、どちらも切れて同じになり、見えなかった。

次の 4 つは、文書とコードからの推測だった。
この設計はどれにも頼っているので、同じく段 0 で workerd で確かめた。

| 推測 | 根拠 | 頼っている決定 | 段 0 の結果 (手元の workerd) |
|---|---|---|---|
| DO の SQLite の列の上限 (100) は、結果の列の数にも掛かる | SQLite の文書は、列の上限が SELECT の結果の項にも掛かると書いている | 型つきの読みが列を足さないこと。今の `imageList` は 100 列の表で列が 100 を超えるので、今も断られているはずである | 合っていた。101 列の結果は `too many columns in result set` で断られる。サブクエリと CTE の列の数にも掛かる。PRIMARY KEY のない 100 列の表の `SELECT rowid, *` も断られる。型つきの読みに包んだ 100 列の結果は読める |
| 1 つの値の長さの上限 | `src/shard-limits.ts` は 2 MB、`docs/platform-facts.md` は 8 MB (2026-11-09 の公式の表) と書いている | `'t' \|\| c` は値を 1 バイト長くし、`hex(c)` は 2 倍にする。上限いっぱいの TEXT を読めるか、行イメージの BLOB がどこまで入るかが、これで決まる | どちらとも違った。手元の workerd は、値も行も 2,200,000 バイトまでである。行には見出しが入るので、表に入る TEXT はそれより数バイト短く、`'t'` を付けても読める。タプルにしても収まるが、JSON が文字を逃がす (引用符は 2 バイトになる) と収まらない行がある。`hex(c)` は 1,099,999 バイトの BLOB までである。素の BLOB は上限まで読める。本番の上限は確かめていない |
| 包んだ読みで、課金される読んだ行の数は変わらない | `EXPLAIN QUERY PLAN` が co-routine と答えたことだけである | 「費用」の節の課金の記述 | 合っていた。走査、主キーの 1 行、index、ORDER BY と LIMIT、集約、結合、窓関数、複合 SELECT、DISTINCT の 10 個の文で、包んだ文の `rowsRead` は素の文と同じだった。D∞ を通した数 (`test/rowcost.test.ts`) は、包む実装が入る段 3 で足す |
| -0.0 を束縛して読むと 0.0 になる | node:sqlite では `quote()` が `0.0` と書いた。sql.js は -0.0 を INTEGER の 0 として束縛した (`(CAST(? AS REAL)+0.0)` で包む場合に当たる) | -0.0 と 0.0 を区別しないという決定 | 違った。DO のドライバは符号を保って束縛し、式の結果と型のない列からは -0 を返す。REAL の列は、整数の値を整数として持つので、符号を落とす。文字にする関数 (`quote()`、`\|\|`、`printf`) は、どれも `0.0` と書く。決定は変えない。SQL の中から符号は見えず、行イメージを通った行は 0.0 になる。経路で変わり得るのは、ドライバが返す JS の数の符号だけである |

表になかった事実が 3 つ見つかった。

- SQL 関数の引数は、手元の workerd では 127 個まで通る (SQLite の既定)。公式の表は 32 個と書いている。本番が 32 で断るかは、手元では確かめられない。タプルの式は、どちらでも通るように、32 個ずつの入れ子のままにする。
- 式の木の深さは 100 までである (SQLite の既定は 1,000。公式の表にない)。2 項の演算子で n 個の項をつなぐと、深さは n になる。D∞ が作る式のうち、列ごとの条件を OR や AND でつなぐものは、列の数だけ深くなる。今のコードは、97 列から 99 列の表に 1 行も書けない (`test/open/wide-table-expression-depth.test.ts`)。node:sqlite は上限を変えられないので、シミュレータでは見えない。
- `sqlite_version()`、`sqlite_source_id()`、`PRAGMA compile_options` は、DO では使えない (使える関数を許可の一覧で絞っている)。版を記録する手段は、挙動から見当を付けることだけである。

## 値の型と符号

### JS の型

```ts
// src/types.ts
export type Value = null | bigint | number | string | Uint8Array;
```

`bigint` は INTEGER で、範囲は -2^63 から 2^63 - 1 である。
`number` は REAL で、整数の値でも REAL である。
入口は、範囲の外の `bigint` を断り、NaN を NULL にする (SQLite が NaN を NULL として束縛するのと同じ)。
-0.0 は 0.0 と区別しない (`quote()` が `0.0` と書く。今も JSON を通ると区別を失う)。
SQL の中から符号は見えない (`quote()`、`||`、`printf` のどれも `0.0` と書く)。
DO のドライバは、式の結果と型のない列の -0.0 を、符号を保った JS の数で返す。行イメージを通った行は 0.0 になるので、ドライバが返す数の符号は経路で変わり得る (「確かめた事実」の節)。

D∞ の内部の表 (`__meta`、`__log_g*`、`__intents` など) が持つ整数は、時刻、版、token、カウンタで、どれも 2^53 に収まる。
内部の表の読み書きは、今の規則のまま `number` で行う。
`Backend` (`src/types.ts:386`) の入口を 2 つに分ける。

| 入口 | 引数 | 結果 | 使う場所 |
|---|---|---|---|
| `exec`、`raw`、`iterate` (今のまま) | `null \| number \| string \| Uint8Array`。整数の値の `number` は INTEGER として束縛する | ドライバの値。数は `number` | 内部の表 |
| `query` (足す) | `Value`。`bigint` は INTEGER、`number` は REAL として束縛する | ドライバの値のまま | 利用者の表に触る文 |

`exec` の引数の型は `bigint` を受け付けないので、利用者の値を内部の入口へ渡すと型の検査で落ちる。
逆の取り違え (内部の整数を `number` のまま `query` に渡す) は型では落ちない。
採番 (`nextId`、`src/client/db.ts:1324`)、`lastInsertRowid` (`:115`)、`sawId` (`src/sql/plan.ts:100`) は `bigint` で持ち、`number` と混ぜた演算が型の検査で落ちるようにする。

### 要素

値 1 つを、JSON にもドライバの結果にも置ける形にしたものを **要素** と呼ぶ。

| 格納の型 | JSON の中 (タプル) | シャードの結果の列 |
|---|---|---|
| NULL | `null` | `null` |
| INTEGER | `"i"` と 10 進の数字。`"i9223372036854775807"` | 同じ |
| TEXT | `"t"` と文字列。`"tabc"` | 同じ |
| REAL | `"r"` と `quote()` の文字列。`"r5.0"`、`"r9.0e+999"` | `number` のまま |
| BLOB | `"b"` と 16 進。`"b00FF"` | BLOB のまま |

結果の列で REAL と BLOB を素のまま返すのは、ドライバが正確に運ぶからである。
ドライバが返す JS の型は 4 つ (`null`、`number`、文字列、BLOB) で、格納の型は 5 つある。
INTEGER と TEXT を印つきの文字列にすれば、残りの 3 つは JS の型で見分けられる。
「ドライバの `number` は、束縛でも読みでも REAL」という 1 つの規則になる。

SQL の式は次の 3 つで、`src/value.ts` に置く (`selectElemSql`、`returningElemSql`、`jsonElemSql`)。

```sql
-- 結果の列 (SELECT)。c は列の参照
CASE typeof(c) WHEN 'integer' THEN 'i'||c WHEN 'text' THEN 't'||c ELSE c END
-- 結果の列 (RETURNING)。REAL にも印を付ける (理由は「利用者の RETURNING」)
CASE typeof(c) WHEN 'integer' THEN 'i'||c WHEN 'text' THEN 't'||c WHEN 'real' THEN 'r'||quote(c) ELSE c END
-- JSON の中。NULL は 'n' || NULL で NULL になる
substr(typeof(c),1,1) || CASE typeof(c) WHEN 'real' THEN quote(c) WHEN 'blob' THEN hex(c) ELSE c END
```

JS の側は `decodeElem` と `encodeElem` の 2 つである。
`decodeElem` は、`number` を REAL、BLOB を BLOB、`null` を NULL とし、文字列は先頭の 1 文字で分ける。
REAL の文字列は `Number()` で読む。JS の `Number()` は正確に丸めるので、`quote()` が元の double に戻せる桁数で書くかぎり (`src/keys.ts:85` の確かめ)、同じ double になる。
`encodeElem` が書く REAL は、JS の最短の表記に、小数点も指数もなければ `.0` を足したものである (無限大は `9.0e+999`)。
NaN は NULL にする (SQLite が NaN を NULL として束縛するのと同じ)。64 ビットに収まらない `bigint` は投げる。
`decodeElem` は、印のない文字列を受け取ると投げる。包み忘れた文の結果を、黙って TEXT として読まないためである。
印の後ろが、その型の書き方でない文字列も投げる (`i` の後ろは 10 進の数字だけ、`r` の後ろは 10 進の小数か指数の表記だけ)。JS の `BigInt()` と `Number()` は、空の文字列を 0 に、16 進の文字列も数に読むからである。
SQL が作った要素と JS が作った要素は、同じ REAL でも文字が違うことがある (`r3.000000000000000445e-01` と `r0.30000000000000004`)。
要素を文字で比べる場所は作らず、比べるときは値に戻す (`touchesUniqueOnManyRows`、`src/shard/rows.ts:224`)。

### タプル

```ts
type Tuple = (string | null)[];   // JSON の中の要素の並び
```

SQL では `json_array(要素, ...)` で作る。
列が 32 を超える表では、32 個ずつの `json_array` を `json_array` で包み、JS が 1 段だけ平らにする。
32 は公式の表の上限である。手元の workerd は 127 個まで受け付けたが、本番が 32 で断るかは確かめられないので、32 に合わせる。
要素は文字列か `null` なので、平らにしてよいかは迷わない。
入れ子は SQL から JS へ渡す間だけの形で、保存する形はいつも平らな配列である。
式は `tupleSql` が作り、読む側は `parseTuple` が平らにする。JS の側でタプルを作るのは `encodeTuple`、値に戻すのは `decodeTuple` である。

段 3 まで、`Value` (`src/types.ts`) は今の形のままである。
要素とタプルの関数は、作り直しの後の値の型を `TypedValue` という名前で `src/value.ts` の中に持ち、それで書いてある。
今の `Value` を `TypedValue` にする橋が `typedOf` である。段 3 で `Value` が同じ形になったら、`TypedValue` と `typedOf` を消す。

## 境界

値が越える境界と、そこでの規則を並べる。

| 境界 | 入る向き | 出る向き |
|---|---|---|
| Hrana | `integer` は `BigInt(文字列)` で INTEGER。`float` は REAL | INTEGER は `integer` (10 進の文字列)、REAL は `float` |
| D1 互換の API、Service Binding、HTTP の `/sql` と `/batch` | `bigint` は INTEGER。`number` は、安全な整数なら INTEGER、ほかは REAL。真偽値は INTEGER | 既定は、安全な範囲の INTEGER を `number` で返し、範囲の外は誤りにする。`intMode` で `bigint` か文字列を選べる |
| Worker の SQLite (sql.js) | 下の「束縛」の表 | `useBigInt` で読む。INTEGER は `bigint`、REAL は `number` |
| DO の SQL の API | 下の「束縛」の表 | 行イメージはタプル (文字列)、結果は型つきの読み |
| シミュレータの node:sqlite | DO と同じ | DO と同じ (丸めて読む模倣を残す) |
| Worker とシャードの RPC | `Value` をそのまま (structured clone が BigInt を運ぶ。DO の RPC が運ばなければ、引数と結果を要素の形で運ぶ) | 同じ |
| JSON にする場所 (baton、2PC の ID の hash) | `bigint` は `{"$i":"数字"}`、BLOB は `{"$b":"16 進"}`、無限大は `{"$f":...}` | 同じ |
| エクスポートのファイル | 整数の literal は INTEGER、小数点か指数のある literal は REAL | 形式は今のまま。19 桁までの整数が書けるようになる |

### 束縛

`bindTyped` (`src/value.ts:139`) は、今と同じく文の中の引数の位置を字句で見つけて包む。
変わるのは、包むかどうかを決める表だけである。

| 値 | DO、シミュレータ | sql.js |
|---|---|---|
| `bigint`、安全な範囲 | `Number(v)` を `(CAST(? AS INTEGER)+0)` で包む (今と同じ) | 32 ビットに収まれば `Number(v)` をそのまま。収まらなければ左と同じ |
| `bigint`、2^53 以上 | 10 進の文字列を `(CAST(? AS INTEGER)+0)` で包む | 同じ |
| `number` | そのまま (REAL として束縛される) | 32 ビットの整数の値なら `(CAST(? AS REAL)+0.0)` で包む。ほかはそのまま |
| 文字列、BLOB、`null` | そのまま | そのまま |

sql.js は `bigint` を TEXT として束縛するので、`bigint` をドライバへ渡さない。
安全な範囲の値の束縛は今と 1 バイトも変わらないので、文の長さの勘定 (`src/shard-limits.ts:74`) も変わらない。

### シャードからの読み

シャードが利用者の表の値を JS へ返す文は 3 種類あり、それぞれ次の形で読む。

| 文 | 形 | 作る場所 |
|---|---|---|
| D∞ が作る行の読み (`selectRow`、`selectGroup`、捕捉、移動) | タプルを 1 列で読む。`SELECT json_array(...) FROM t WHERE ...` | `src/shard/rows.ts` |
| 結果を返す SELECT (利用者の文、Worker が作る走査、部分集約) | CTE で包み、列ごとに要素の式を掛ける | シャード (`readLimited`、`src/shard/core.ts:1513`) |
| 利用者の RETURNING | 項ごとに要素の式に書き換える | Worker (`planInsert`、`planUpdateDelete`、`src/sql/plan.ts:773`、`:965`) |

結果を返す SELECT は、次の文にして実行する。

```sql
WITH "__dinf_r"("c0", "c1") AS (
<利用者の文>
) SELECT <"c0" の要素の式>, <"c1" の要素の式>
FROM (SELECT * FROM "__dinf_r" LIMIT -1 OFFSET 0)
```

この形にした理由を、部品ごとに書く。

- CTE の列の並び `("c0", "c1")` は、結果の列に位置で名前を付ける。利用者の文の列名が重なっていても (`SELECT a, a`)、式でも (`count(*)`)、参照できる。サブクエリを `*` で開くと、重なった列名は `a:1` に変わる (確かめた)。
- `LIMIT -1 OFFSET 0` は、SQLite がサブクエリを外の文へ展開するのを止める。止めないと、要素の式が列を複数回参照するので、`random()` やサブクエリの列が参照のたびに評価され、`typeof` と値が食い違う (整数と文字列を半々に返す列で、64 行のうち約半分が食い違った)。
- 利用者の文の前後に改行を置く。文末の `--` の注釈が閉じ括弧を飲まない。
- 結果の列の数は、利用者の文と同じ n である。DO の SQLite の列の上限 (100) が結果の列にも掛かるなら (推測。「確かめた事実」の節)、型の列を足す形 (今の `__dinf_typeof_<i>`) は 100 列の結果で上限を超える。

列の数 n と、利用者に返す列名は、Worker が渡す。
Worker は、どの文もシャードへ送る前に自分の SQLite でコンパイルしている (`Db.compiled`、`src/client/db.ts:1260`。結果は文面と表定義の履歴ごとに覚える)。
そこで、用意した文の列名 (`getColumnNames()`) を一緒に覚える (`Compiled.columns`、`src/sql/scratch.ts:36`)。
`ExecReq` に `columns: string[]` を足し、シャードは n をそこから取り、応答の列名にもそれを使う。
列名を SQLite 以外が決める場所は増えない (`test/partial-column-names.test.ts` が見る)。

包むのは、Worker ではなくシャードである。
丸めて読むのは DO の SQL の API の性質なので、それを知る場所をシャードの 1 か所にする。
`ExecReq.sql` は利用者の文面のままなので、範囲の検査の報告 (`src/shard/core.ts:1455`) はそのまま読める。
文の種類ごとの行数の集計 (`src/worker.ts:55`) は、文の先頭の語で分けているので、包む前の文面を渡す。
DO の上限 (`shardLimitOf`、`:1537`) は、包んだ後の文で測る。

次の形の文で、包んだ文が元の文と同じ行を同じ順で返すことを確かめた。
`WITH` と `WITH RECURSIVE` で始まる文、`__dinf_r` という名前の CTE を持つ文、ORDER BY と LIMIT のある複合 SELECT、`VALUES`、集約と窓関数、重なった列名、文末の注釈。
列の数が合わなければ、SQLite が `table __dinf_r has 2 values for 3 columns` で断る。
文末の `;` は Worker が除いて送る。
包んだ文が 100 KB を超えれば、今と同じくシャードが `ShardLimit` で断り、Worker が基準経路で実行し直す。

### 利用者の RETURNING

DML はサブクエリに置けないので、包めない。
Worker が、RETURNING の項を 1 つずつ要素の式に書き換える (構文木は `tailClauses` が持っている、`src/sql/plan.ts:780`)。

- 列の参照と `*` (表定義の列の順に開く) は、列に要素の式を掛ける。
- ほかの式 `e` は、`(SELECT <"x" の要素の式> FROM (SELECT e AS "x" LIMIT -1 OFFSET 0))` にする。`e` は 1 回だけ評価される (`random()` で確かめた)。

RETURNING では、REAL にも印を付ける。
INSERT の RETURNING で、整数を入れた REAL の列を `ELSE c` で素のまま返すと、ドライバには INTEGER の 5 として届く (`typeof` は `real` と答える)。
DO では JS の 5 になり、「`number` は REAL」の規則で正しく読めるが、偶然に頼ることになる。
`'r' || quote(c)` は `r5.0` を返す (確かめた)。

返す列名は、書き換える前の利用者の文をコンパイルして取る。
Worker がシャードへ送る前にコンパイルしている文 (`tablesOf`、`src/client/db.ts:818`) は、行ごとに分けて書き換えた後の文なので、そこから取ると要素の式の文面が列名になる。
計画が、元の文の列名を書き込みの指示と一緒に持つ。

利用者の RETURNING のある文は、今と同じく trigger で捕捉する (`captureOf`、`src/sql/plan.ts:956`)。

### Worker の SQLite

`ScratchDb` (`src/sql/scratch.ts:110`) は、`query` で `Value` を束縛し、`useBigInt` で読む。
読んだ値はそのまま `Value` である。
Worker の SQLite で計算した値を引数に戻す場所 (`insertSelect`、VALUES の中のサブクエリ、キーの式) は、型を読み直す必要がなくなり、`fromTyped` と `typedScalarSql` は消える。
`load` (`:197`) は、行ごとの束縛の形 (包む引数の並び) ごとに用意した文を覚える。
今は、32 ビットを超える整数を含む行が、行ごとに文を用意し直している (`:207`)。

### Hrana

`fromH` (`src/client/hrana.ts:56`) の `integer` は `BigInt(v.value)` にし、64 ビットに収まらない値だけを断る。
`toH` (`:75`) は、`bigint` を `integer`、`number` を `float` で返す。
整数の値の REAL は `float` で返るようになり、sqld と同じになる。
無限大を運べないのは今と同じである。

### D1 互換の API、Service Binding、HTTP の JSON

入る向きは、`toValue` (`src/client/d1.ts:24`、`src/entrypoint.ts:8`) の 1 か所で決める。
`number` は、`Number.isSafeInteger` なら INTEGER、そうでなければ REAL とする。
2^60 のような安全な範囲の外の整数の値は REAL になる。
D∞ が丸めるのではなく、渡された double をそのまま入れる (INTEGER の列なら、SQLite がその値の整数にする)。
安全な範囲の外の整数の値を全部断ることはできない。1e300 も整数の値だからである。
断るなら、2^53 以上 2^63 未満の整数の値だけになるが、その範囲の REAL (1e17 など) を渡す文も断ることになる。
2^53 以上の INTEGER を正確に渡すには、`bigint` を渡すか、Hrana を使う。

出る向きは、`QueryResult` (`src/client/db.ts:110`) が 2 つの形を持つ。
`values` は `Value` のままで、Hrana と Worker の中の計算が使う。
`rows` (列名から値への object) は、D1 と同じく INTEGER を `number` で返し、D1 互換の API、Service Binding、HTTP の `/sql` が使う。
安全な範囲の外の INTEGER は、既定では誤りにする (`intMode: "number"`。@libsql/client の既定と同じ)。
`intMode` を `"bigint"` にすると INTEGER をすべて `bigint` で、`"string"` にするとすべて 10 進の文字列で返す。
HTTP の `/sql` は JSON なので、`"bigint"` は選べない。
誤りにするかどうかは値で決まり、行の置き場所には依らない。

### シミュレータ

`SqliteBackend` (`test/sim.ts:153`) は、DO の代わりである。
DO にできないことをシミュレータができると、正確な読みを忘れた経路がシミュレータでだけ通る。
次の 4 つを守る。

- `exec` などの内部の入口は、今と同じく BigInt で読んで `number` に丸める (`lossy`、`:149`)。
- `number` は REAL として束縛し、`bigint` がドライバに届いたら投げる (DO は束縛できない)。
- `query` は、ドライバが INTEGER を返したら試験を落とす。型つきの読みの形の文は、INTEGER を文字列で返すので、INTEGER がドライバから数として出てくるのは、包み忘れた文だけである。範囲の検査 (`test/setup.ts`) と同じく、どのシミュレータの試験にも掛かる。
- 結果の列が 100 を超える文を断る。段 0 で入れた (`test/sim.ts` の `DO_MAX_RESULT_COLUMNS`)。見るのは文の結果の列だけで、サブクエリと CTE の列の数は見ない。

関数の引数の上限 (32) と、式の木の深さの上限 (100) は、node:sqlite では模倣できない。
タプルの式を作る関数の単体の試験 (どの関数の呼び出しも引数が 32 以下) と、workerd での 100 列の表の試験で見る。
node:sqlite のドライバが TEXT を NUL で切って返すことも、DO と違う (「確かめた事実」の節)。

SQLite との突き合わせの基準 (試験の中の `DatabaseSync`) は、BigInt を INTEGER、`number` を REAL として束縛し、`setReadBigInts` で読む。
`Value` と同じ規則なので、結果を型ごと比べられる。

### エクスポートと取り込み

ファイルの形式 (`storage-format.md` の「エクスポート」) は変えない。
今は断っていた 2^53 以上の整数が、10 進の literal で書けるようになる。
`exportRows` (`src/shard/core.ts:1023`) は、D∞ が作る文なので、列ごとに要素の式を掛けて読む (CTE は要らない)。
CLI とのあいだの JSON は、行をタプルで運ぶ。
`bin/dump.js` の `literal` (`:9`) は要素から literal を書き、取り込みは literal から要素を作る (`{ $blob }` と `{ real }` の印はなくなる)。
REAL の literal は、今と同じく JS の最短の表記で書く。

## 行イメージ

### 形

```ts
interface Change { table: string; pk: string; sk: string; before: Tuple | null; after: Tuple | null; since?: Ts }
```

`before` と `after` は、表定義の列の順に並べたタプルである。
PRIMARY KEY のない表は、先頭に rowid を置く (今の `selectList` と同じ順、`src/shard/rows.ts:29`)。
`__intents.change` と `__log_g*.blob` は、今と同じく `Change` と `Change[]` を `JSON.stringify` したものである。
タプルは文字列と `null` の配列なので、JSON にも structured clone にもそのまま入る。
`PiecePayload.rows` (`src/types.ts:320`) と、取引が溜める変更 (`overlay`、`src/client/db.ts:308`) も同じタプルを運ぶ。

行を書き戻す関数 (`insertRow`、`updateRow`、`setBasedRestore`、`applyChanges`、`src/shard/rows.ts`) は、タプルを `decodeElem` で値に戻し、`query` で束縛する。
SQL の中で要素を値に戻すことはしない。
REAL の文字列を SQLite の `CAST` に読ませると、版ごとの解釈の違いが入るからである。

### 列の順序と表定義の版

タプルは列名を持たないので、作ったときと違う表定義で読むと、値が黙って別の列に入る。
列名つきの JSON なら「no such column」で止まっていた場面である。
今のコードは、行イメージを作った版と読む版が同じになるように、すでに 5 か所で守っている。

| 行イメージ | 守り |
|---|---|
| シャードが実行する文と、その変更 | 要求の版がシャードの版と等しいときだけ実行する (`ensureSchema` と `enter`、`src/shard/core.ts:434`、`:678`) |
| intent | 表定義の版を適用する前に、持っている intent を全部決着させる (`applySchema`、`:475`。外すスイッチは `ddlIgnoresIntents`) |
| 変更ログ | 版を適用した時刻より古い読みを断る (`ddlFloor`、`:503`、`:1395`) |
| 移動のペイロード | 移動の途中は版を適用しない。子は親の版に追いついてから受け取る (`:479`) |
| 取引が溜める変更 | 読むか書くかした取引は版を取り替えない。表定義が変わっていたら競合で失敗する (不変条件 7、`specs/m13_txn_schema_boundary.qnt`) |

この 5 つが効いているかぎり、タプルの長さは読む表定義の列の数と等しい。
長さが違ったときの扱いは、本番とシミュレータで分ける。

- 本番：タプルが短ければ、先頭の列のイメージとして扱う。挿入では残りの列に DEFAULT が入り、更新では残りの列に触らない。ADD COLUMN は列を末尾にだけ足すので、列名つきのイメージを新しい表に入れる今の挙動と同じ結果になる。確定した取引の適用を止めないためである (不変条件 2)。タプルが長ければ誤りにする。
- シミュレータ：長さが違えば試験を落とす。上の守りのどれかが破れたことを、どの試験でも見つける。

長さでは見つからない場合が 1 つ残る。
同じ名前の表を、同じ数の列で、順序を変えて作り直した場合である (drizzle-kit の表の作り直しがこの形になり得る)。
守りは上の表と同じだが、破れても長さの確かめには掛からない。
切り替える前に、`test/ddl-concurrent.test.ts` に「列の順序を変える作り直し」と並行する取引の場面を足し、今のコードで流す (段 0)。
行イメージに版を持たせる案は、持ち主の判断が要ることの 5 に書いた。

`RENAME COLUMN` と `DROP COLUMN` は今は断っている。
位置のタプルは `RENAME COLUMN` の前後で読み方が変わらない。
`DROP COLUMN` を足すときは、位置がずれるので、表の作り直しと同じ守りが要る。

### 大きさの勘定

取引の大きさの上限 (1 MB、`assertWriteSetFits`、`:1841`) と、移動の 1 通の大きさは、`Change` の JSON の長さで数えている。
タプルは列名を持たない分だけ短いので、同じ上限に入る行が増える。
結果の大きさの勘定 (`sizeOf`、`:93`) は、値に戻した後で数える (`bigint` と `number` は 8 バイト)。
今と同じ数になるので、集める予算の配り方は変わらない。

trigger の中でタプルの文字列が DO の SQLite の値の長さの上限を超えると、SQLite が `string or blob too big` で文を止める。
BLOB は 16 進で 2 倍になる (今の JSON の行イメージも同じである)。
この誤りは、取引の大きさの上限の誤りと同じ文面に直す。

## キー文字列

### 形

キー文字列 (`keyString`、`src/keys.ts:75`) の形は変えない。
段 1 では、新しい書き方の関数を `keyStringExact` という名前で `keyString` の隣に置いた。段 2 で `keyString` と入れ替える。
値の並びの JSON で、BLOB は `{"$b":"小文字の 16 進"}`、無限大は `{"$f":"Infinity"}` である。
数の書き方だけを、次の 1 つの規則にする。

- INTEGER は、10 進の数字で書く。桁数に上限を置かない。
- REAL は、整数の値で 64 ビットの整数の範囲 (-2^63 以上、2^63 未満) にあれば、その整数を 10 進で書く (`BigInt(r)` の数字)。そうでなければ、今と同じ `JSON.stringify` の表記で書く。

INTEGER の 5 と REAL の 5.0 が同じ文字列になるのは今と同じである。
SQLite は INTEGER と REAL を正確に比べるので、キーが等しいことと SQLite で等しいことが、2^53 を超えても一致する必要がある。
REAL の 2^53 と INTEGER の 2^53 は同じキーで、INTEGER の 2^53 + 1 は別のキーである (型のない主キーの列で、前者は UNIQUE の違反になり、後者はならないことを確かめた)。
2^53 以上の整数の値の REAL に `BigInt(r)` を使うのは、JS の表記がその double の正確な値ではないからである (2^62 + 1024 は `4611686018427389000` と書かれ、正確な値は `4611686018427388928` である)。

### 変わるキーと変わらないキー

| 値 | キー |
|---|---|
| 絶対値が 2^53 未満の INTEGER、TEXT、BLOB、整数でない REAL、絶対値が 2^53 未満の整数の値の REAL、64 ビットの整数の範囲の外の REAL、無限大 | 今と 1 バイトも変わらない |
| 絶対値が 2^53 以上で、64 ビットの整数の範囲にある整数の値の REAL | 変わる。JS の表記から、正確な値の数字になる |
| 絶対値が 2^53 以上の INTEGER | 新しい。今は断っている |

行の token は `hashKey(キー文字列)` から決まる (`src/routing.ts:36`)。
1 行目の値では、行の置き場所も、`__gidx_<index>.k`、`__intents.pk`、`__moved.g`、位置 (`Pos`) の文字列も変わらない。
新しい `keyString` を使い始める段 2 で、シミュレータの同じ seed の RPC の宛先とメソッドの列が、変更の前後で同じになるはずである。それを段 2 の検査に使う。

### 読み戻し

キー文字列から値に戻す場所は、`pkValues` と `selectGroup` (`src/shard/rows.ts:26`、`:161`)、位置の比較である。
`JSON.parse` は 2^53 以上の整数を丸めるので、reviver が受け取る元の文面 (`context.source`) を使う。
数字だけの文面で 64 ビットに収まれば `BigInt(文面)`、そうでなければ `number` とする (`keyValues`、`src/keys.ts`)。
元の文面を受け取れない実行環境では、2^53 以上の整数を丸めたまま返さずに、投げる。
`keyValues` は workerd の中でも動かして確かめた (`test/workerd-limits.test.ts`。キー文字列を値に戻して書き直すと、元の文字列になる)。
戻した値は `WHERE 主キー IS ?` に束縛する。
INTEGER の引数は、REAL で入っている同じ値の行にも当たる (確かめた)。

`context.source` は、Node 24 にも、手元の workerd にもある (段 0 で確かめた。`test/workerd-limits.test.ts`)。
キー文字列の整数は、桁数に関わらず 10 進の数字で書くと決まった。
なかった場合の案 (2^53 以上の整数だけを `{"$i":"数字"}` と書く) は採らない。
どちらの形にするかは、行の置き場所に効き、公開の後は変えられない。

### 型の親和性の変換

Worker は、文の中の値から行の置き場所を決めるために、「その値が列に入ると何になるか」を知る必要がある。
今は `storedAs` (`src/keys.ts:42`) が、数に読める文字列の文法を正規表現で写し、REAL を TEXT にする変換だけを諦めている (`undefined` を返し、読みは絞らず、書き込みは基準経路)。

`storedAs` を消し、`storedValue(v, 親和性)` に替える (`src/sql/stored.ts`。段 1 で書いた。段 3 まで、どこからも呼ばない)。

| 入る値と列の親和性 | 決め方 |
|---|---|
| NULL、BLOB、親和性が BLOB の列 | 変換なし |
| TEXT を TEXT へ、INTEGER を INTEGER か NUMERIC へ、REAL を REAL へ | 変換なし |
| 安全な整数の値の REAL を INTEGER か NUMERIC へ | 同じ値の INTEGER |
| 安全な範囲の INTEGER を REAL へ | 同じ値の REAL |
| INTEGER を TEXT へ | 10 進の文字列 |
| ほか (文字列を数の列へ、2^53 以上の INTEGER と REAL のあいだ、REAL を TEXT へ) | Worker の SQLite に入れて読む |

最後の行は、親和性ごとの列を持つ 1 行の表に `INSERT OR REPLACE ... RETURNING` で入れ、入った値をタプルで読む (RETURNING が返す値と、入れた後に読んだ値が同じであることを確かめた)。
素の列を `useBigInt` で読むことはしない。sql.js のドライバは TEXT を最初の NUL で切って返すので、NUL を含む文字列が数の列に入ったとき (文字列のまま残る) に、キーが切れる。
`CAST` は使わない。`CAST('abc' AS INTEGER)` は 0 で、列の親和性は `'abc'` を TEXT のまま残す。
数に読める文字列の文法 (`' 12 '`、`'1e3'`、`'0x10'`、`'9223372036854775808'`) を、JS で写すのをやめられる。

`pinsOf` と `pkOf` (`src/sql/plan.ts:346`、`:363`) は同期の関数で、sql.js の初期化は非同期である。
変換のための SQLite は、isolate に 1 つだけ開いて持ち続ける。
`Db` が文を計画する前に、その初期化を 1 度だけ待つ (どの文も `Db.compiled` で sql.js を使うので、読み込みの費用は増えない)。
初期化は `initStoredValue(engine)` で、sql.js の初期化の結果を引数で受け取る。
Worker では wasm を実行時に生成できず、Worker の SQLite (`src/sql/scratch.ts`) が持つ engine は外から見えないからである。
段 3 で、`scratch.ts` が engine を渡すようにつなぐ (sql.js を 2 つ読み込まない)。
`storedValue` は、初期化の前に呼ばれたら投げる。
プランナを直に呼ぶ試験 (`test/planner-shapes.test.ts`) は、先に初期化を待つ。

JS に残す 3 行は、SQLite の文書が定める正確な変換で、1 行で書ける。
残す理由は費用である。
sql.js で 1 つの値を変換すると 21 から 25 µs かかった (用意した 2 つの文で、入れて読み直す形で測った)。
段 1 の実装 (用意した 1 つの文で、数の 3 つの列に入れてタプルで読む) では 27 µs だった。同じ値を別の親和性で続けて尋ねたときは、直前の結果を使う。
@libsql/client は JS の数を `float` で送るので、整数の主キーの列に REAL が入る変換は、ふつうの文のたびに起きる。
1,000 行の INSERT で、キーの列ごとに 20 ms 余計にかかることになる。
`test/key-conversions.test.ts` は、JS の行も含めた `storedValue` の全体を、本物の列に入れた結果と比べる。

版で結果が変わり得る変換が 2 つある。
REAL を TEXT にする書式と、文字列を整数でない REAL にする解釈である。
Worker の SQLite と DO の SQLite の版が違うと、Worker が思うキーとシャードに入った行のキーが食い違い、読みが空を返す。
node:sqlite 3.51.3 と sql.js 3.49.1 は、上の「確かめた事実」の corpus で 1 件も食い違わなかった。
DO の SQLite は確かめていない。
規則は次のとおりにする。

- REAL を TEXT にする変換は、今と同じく `undefined` を返す。段 0 の corpus (double 20,285 個) では、3 つのエンジン (3.47、3.49.1、3.51.3) が 1 件も食い違わなかった。それでも、書式は版で変わったことがあるので、絞り込みには使わない。
- 文字列を REAL にする変換は、使う。段 0 で、手元の workerd の結果が sql.js と一致した (文字列 113,390 個を 5 つの列に入れて、1 件も食い違わなかった)。今は JS の `Number()` で写して使っている。
- corpus は `test/workerd-limits.test.ts` で流し続け、DO の SQLite の版が上がって食い違ったら見つける。本番の DO の SQLite では流していない。`scripts/cloudflare-check.sh` が流すのは `test/workerd.test.ts` だけなので、本番で流すには、そこへ足す必要がある (段 3 までに決める)。

型の名前から親和性を決める関数 (`affinityOf`、`src/sql/cst.ts:146`) は、5 つの規則のままで残す。
数の literal の読み (`constant`、`:164`) は、整数の literal を `bigint` にする。
`-9223372036854775808` は、符号と数字を 1 つの literal として読む (SQLite と同じ。数字だけを先に読むと REAL になる)。

## 捕捉

### 共有の表と trigger

```sql
CREATE TABLE __cap(seq INTEGER PRIMARY KEY, tbl TEXT NOT NULL, old TEXT, new TEXT);
CREATE TRIGGER "__cap_<表>_U" AFTER UPDATE ON "<表>" WHEN EXISTS (SELECT 1 FROM __cap_on)
BEGIN INSERT INTO __cap(tbl, old, new) VALUES ('<表>', <old.* のタプル>, <new.* のタプル>); END;
```

INSERT の trigger は `new` だけを、DELETE の trigger は `old` だけを書く。
`__capv_<表>` (`captureDdl`、`src/shard/rows.ts:261`) はなくなり、表定義の版を適用するたびに作り直すのは trigger だけになる。
`__cap` を読む文が返すのは TEXT だけなので、DO でも型を落とさない。
Worker の SQLite での捕捉 (基準経路の書き込み) も同じ文を使う。
2 つのエンジンは、同じ文の列に 1 バイトも違わないタプルを書いた。

キー文字列は、タプルの主キーの位置の要素を値に戻して `keyString` に通して作る。
SQL の中でキーの元を作る `keySql` (`src/keys.ts:84`) は消え、キー文字列を作る関数は JS の `keyString` だけになる (不変条件 6)。

### 正味の変更

今は、変更後の行を、文の後に本体から主キーで読み直している (`capturedChanges`、`:293`)。
trigger の `new` が、型の親和性を掛けた後の値と採番した rowid を持っているので、読み直しをやめる。
`__cap` の行を `seq` の順に見て、キーごとに次のようにまとめる。

1. `old` があれば、`old` のキーの項目を取る。なければ `before = old` で作る。`after = null` にする。
2. `new` があれば、`new` のキーの項目を取る。なければ `before = null` で作る。`after = new` にする。
3. 最後に、`before` も `after` も `null` の項目 (同じ文の中で挿入して消した行) を捨てる。

主キーを書き換える UPDATE は、古いキーの削除と新しいキーの挿入になる。
`REPLACE` が消す行は、`recursive_triggers` で DELETE の trigger が先に走るので、同じ規則に載る。
`INSERT OR REPLACE`、主キーを書き換える `ON CONFLICT DO UPDATE`、DELETE を続けて流し、最後の `new` が本体の行と一致することを確かめた。

読み直しをやめると、まとめ方の誤りが黙って通る。
シミュレータでは、まとめた `after` を本体の行 (`selectRow`) と比べ、違えば試験を落とす (範囲の検査と同じ仕掛け)。

### RETURNING による捕捉

`runCaptured` (`src/shard/core.ts:1660`) は、`<利用者の文> RETURNING <タプル>` を実行する。
返るのは 1 列の TEXT で、INSERT と UPDATE では変更後の行、DELETE では消した行である。
UPDATE の変更前の行は、今と同じく、先に主キーで読む。
足す文面は、100 列の表 (列名が 9 文字) で 15 KB である。
今の `imageList` は同じ表で約 10 KB (式の長さから手で数えた) なので、100 KB を超えて trigger に回る文は少し増える (超えたときの扱いは今と同じ、`:1669`)。

### 表定義のときの上限の確かめ

今は、表を作るときに、全表の走査と `imageList` の文が DO の上限に収まることを確かめ、収まらない表を断っている (`assertReplays`、`src/client/db.ts:1350`)。
`imageList` がなくなるので、確かめる文を次の 4 つに替える。

- UPDATE の trigger の DDL (`old` と `new` のタプルを持ち、D∞ が作る文でいちばん長い)
- 主キーでタプルを読む文 (`selectRow`)
- 全表の走査を、型つきの読みの形に包んだ文 (段 2 では、型つきの読みはまだないので、今の走査の形 (`scanSql`) を確かめる)
- 行を入れ直す文 (`insertRow`)。束縛の変数が 100 を超えないこと

どの文も、式の木の深さが 100 に収まることも確かめる (主キーの列を AND でつなぐ条件は、主キーの列の数だけ深くなる)。
今の確かめは深さを見ないので、97 列から 99 列の表が `CREATE TABLE` を通り、1 行も書けない (`test/open/wide-table-expression-depth.test.ts`)。
確かめを落とすと、長い列名の広い表が `CREATE TABLE` を通り、後でシャードが trigger を作れずに止まる。
断るかどうかは表定義だけで決まる (規則 4)。

## 消すものと、残す予約

| 消すもの | 代わり |
|---|---|
| `Real`、`realOf`、`isReal`、`numberOf`、`isIntegerValue` (`src/value.ts`) | `Value` の JS の型 |
| `wideIntegerError`、K1 の拒否、Hrana の入口の拒否、DEFAULT の確かめ (`assertReplays` の中、`src/client/db.ts:1373`) | なし。64 ビットの整数が通る |
| `fromTyped`、`typedScalarSql` | Worker の SQLite を `useBigInt` で読む |
| `imageList`、`typedRow`、`typedValues`、`__dinf_typeof_<i>`、`__dinf_wide`、`hasWideInteger` (`src/shard/rows.ts`) | タプルと型つきの読み |
| `Scan.typed` と `scanSql` の包み (`src/sql/plan.ts:36`)、`insertSelect` の読み直し (`src/client/db.ts:1001`) | 読みはいつも型つき |
| `keySql`、`storedAs`、`textAsNumber` (`src/keys.ts`) | `keyString` と `storedValue` |
| `__capv_<表>` | `__cap` の `old` と `new` |

`INTERNAL_COLUMN_PREFIXES` (`src/sql/ddl.ts:61`) は、2 つとも外せる。

- `$`：列名つきの JSON の行イメージで、`$b` という名前の列が BLOB の印 `{"$b": ...}` と見分けられなかった。タプルは列名を持たない。印 `$b`、`$f`、`$i` が残るのはキー文字列と baton の JSON で、どちらにも列名は入らない。
- `__dinf_`：文に足す列の別名 (`__dinf_typeof_<i>`、`__dinf_wide`、`__dinf_c<i>`) がなくなる。CTE の列 `"c0"` は位置で付けるので、利用者の列名とぶつからない。

残す予約は表の名前である。
`sqlite_` で始まる名前、内部の表の名前 (`__cap`、`__meta`、`__gidx_` で始まる名前など)、`__dinf_` で始まる表の名前は、今と同じく作れない。
`__dinf_r` という表があると、包んだ文の中のその表への参照が、CTE 自身への参照と読まれ得る (そういう表は作れないので、試してはいない)。

## 変更が届く場所

`Value` の型を替えると、コンパイラが教えてくれる場所と、教えてくれない場所がある。
教えてくれないのは、`number` を INTEGER として扱っている場所と、値を JSON にする場所である。

| 場所 | 変更 |
|---|---|
| `src/types.ts` | `Value`、`Change`、`ExecReq.columns`、`Backend.query`、`PROTOCOL_VERSION` |
| `src/value.ts` | 要素とタプルの関数、SQL の式、`bindTyped` の表 |
| `src/keys.ts` | `keyString`、`keyValues` |
| `src/shard/rows.ts` | 行を読み書きする関数、捕捉。JSON の符号 (`encode`、`decode`、`:15`) に `$i` を足す |
| `src/shard/core.ts` | `runStatement`、`readLimited`、`runCaptured`、`exportRows`、`pull`、`receive`、`deltaAfter`、`restore`、`intentMatches`、`rowMatches`、`deleteOutside`、`sizeOf`。行イメージをそのまま渡している場所 (取引が溜めた変更の重ね合わせ `:1241`、`:1579`、`uniquePending` の試し適用 `:1790` から `:1827`、変更ログの読み出し `:2283`) |
| `src/sql/scratch.ts` | `query`、`useBigInt`、`Compiled.columns`、`load`。`EXPLAIN` の結果を読む `reads` (`:174`) は内部の入口のまま (`p2 === 1` を `number` で比べている) |
| `src/sql/plan.ts`、`src/sql/cst.ts` | `storedAs` の 4 か所 (`:355`、`:370`、`:880`、`:885`)、RETURNING の書き換え、`scanSql`、`constant`。採番した ID を `typeof v === "number"` で見分けている場所 (`plan.ts:891`) |
| `src/client/db.ts` | `scan`、`insertSelect`、`evaluate` (`:1310`)、`nextId`、`sawId` (`:899`、`:1306`)、`QueryResult`、`assertReplays`。2PC の ID は変更と span を JSON にして hash を取る (`:1156`)。span の引数に `bigint` が入るので、JSON の符号を通す |
| `src/client/hrana.ts` | `fromH`、`toH`、`last_insert_rowid`、baton (`:232`、`:247`) |
| `src/client/d1.ts`、`src/entrypoint.ts`、`src/binding.ts` | `toValue`、`intMode`、`meta.last_row_id` |
| `src/worker.ts` | `DoBackend.query`。`/sql` と `/batch` の `Response.json` (`:718`、`:723`) は `bigint` を書けないので、`rows` の形だけを返す |
| `src/transfer.ts`、`bin/dump.js` | タプル |
| `src/analytics.ts` | 変更を列名つきの行で外へ出している (`:25`)。表定義の列名を付け直してから出す |
| `src/meta.ts` | 変えない。採番の表 `__seq` の値は 2^53 未満である |
| `test/sim.ts` | `SqliteBackend` の `query` と、足す模倣 |
| 試験 | `before` と `after` を列名で読むか、列名つきで作っている補助と試験 (`test/diff.ts`、`test/ddl-harness.ts`、`test/replay.test.ts`、`test/gc.test.ts`、`test/counterexamples.test.ts`、`test/protocol.test.ts` など) |

行イメージを列名で引いている場所が `src/client/db.ts` に 3 つある。
挿入した行の rowid を見る場所 (`:898`)、UNIQUE の値が同じ行を集め足す `conflicting` (`:928` から `:947`)、シャードをまたぐ UNIQUE の index の項目を作る場所 (`:1073` から `:1079`) である。
列名から位置を引く関数 (`imageAt(def, タプル, 列名)`) を `src/shard/rows.ts` に 1 つ置き、どれもそれを通す。

採番は 2^53 未満の範囲で続ける。
利用者が明示して入れた ID を見て採番を進める `sawId` は、2^53 以上の ID を無視する。
採番した ID は 2^53 未満、無視した ID は 2^53 以上なので、重ならない。

## 永続データと通信で変わるもの

保存の形式の版 (`STORAGE_FORMAT`) は 2 に上げ、材料を `test/fixtures/storage/format-2.json` に作り直す。版 1 からの移行は書かない (公開の前なので後方互換を持たない)。
版を上げるのは、版 1 のデータを今のコードが黙って読み違えるからである。`CREATE TABLE IF NOT EXISTS __cap` は版 1 の `__cap(seq, tbl, oldk, newk)` を作り替えず、Meta の `__ddl` の版は、捕捉の trigger の文 (`__capv_<表>` に書く形) を含み、intent と変更ログは列名つきの行イメージを持つ。
版 1 のデータは、移行がないと言って起動を拒否する (`test/health.test.ts`)。
(段 2 の前のこの節は「版は 1 のままにし、材料を作り直す」と書いていた。`__ddl` の trigger の文と `__cap` の形を見落としていた。)

| 形式 | 変更 |
|---|---|
| 利用者の表 | 変わらない。2^53 以上の INTEGER が入るようになる |
| キー文字列 (`__gidx_*.k`、`__intents.pk` と `sk`、`__moved.g`、`__arrived.g`、位置) | 「変わるキーと変わらないキー」の表のとおり |
| 行の token | 計算は変わらない。入力のキー文字列が上の 1 つの場合だけ変わる |
| `__intents.change`、`__log_g*.blob` | `before` と `after` がタプルになる |
| `__cap`、`__capv_<表>`、trigger | `__cap(seq, tbl, old, new)`。`__capv_<表>` はなくなる。作り直せる区分のままである |
| Meta の表 (`__ddl`、`__routing`、`__seq`、`__meta`) | 変わらない。`TableDef` も変えない |
| RPC | `PROTOCOL_VERSION` を、段 2 で 4 (`Change` と `PiecePayload.rows` のタプル)、段 3 で 5 (`bigint` を含む `Value`、`ExecReq.columns`) にする。通信の形が変わったのに版が同じだと `test/protocol.test.ts` が落ちる。2 つの段を 1 本の PR にまとめるなら、上げるのは 1 回でよい |
| baton | 取引の書き出しの中の値と行イメージの形が変わる。読めない baton は今と同じく断る |
| エクスポートのファイル | 変わらない |

`docs/storage-format.md` の「値の型」「キー文字列」「行イメージと変更」「`__cap`」「通信」の行と、`docs/sql-language.md` の「値」の 3 行と「使えないもの」の列名の行を、形が変わる段ごとに書き換える。

## 費用

数字は、node:sqlite 3.51.3 で、8 列の表 (整数 4、文字列 3、REAL 1) の 5 万行を使い、暖機の後の中央値を取ったものである。
DO の SQLite と Workers の CPU での値ではない。

| 項目 | 今 | 変更後 |
|---|---|---|
| 行イメージ 1 つの大きさ | 145 バイト | 92 バイト (36% 減) |
| trigger の捕捉 (5 万行の UPDATE、1 行あたり) | 7.5 µs | 4.0 µs |
| 捕捉で書く行 (N 行を変える文) | 2N + 1 行。1 行なら 3 行 (`__cap`、`__capv`、`__cap_on`、`src/shard/core.ts:1657`) | N + 1 行。1 行なら 2 行 |
| 捕捉の後に読み直す行 (1 行の変更につき) | 最大 2 行 (ミラーと、変更後の行) | 0 行 |
| 走査の読み (1 行あたり) | 0.44 µs | 1.38 µs |
| 主キーで 1 行の読み (1 文あたり) | 1.03 µs | 1.92 µs |
| 型の親和性の変換 (JS で済まない値、1 つあたり) | JS の関数 (0.13 µs) | 27 µs (段 1 の実装で測った) |
| 100 列の表の RETURNING に足す文面 | 約 10 KB | 15 KB |
| 100 列の表の UPDATE の trigger の文面 | ミラーへの INSERT | 35 KB (列名が 9 文字。`tupleSql` の文面を数えた) |

捕捉は軽くなる。
ミラーの行と変更後の行を 1 行ずつ読み直さなくなるからである。

読みは、1 行あたり約 1 µs 重くなる。
SQLite が INTEGER と TEXT の列に印を付けた文字列を作り、JS がそれを `BigInt` と文字列に戻す分である。
RPC の往復 (ミリ秒) より 3 桁小さい。
集める行の上限 (20 万行) まで読む基準経路の文では、約 0.2 秒が足される。
BLOB と REAL は素のまま読むので、BLOB の多い結果で通信が増えることはない。

課金は、書き込みで下がる (変更 1 行につき、書く行が 1 つ、読む行が最大 2 つ減る)。
読みで読む行の数は、変わらない見込みである。
包んだ文は co-routine で実行され、中間の表を作らない (`EXPLAIN QUERY PLAN` の答えで、課金の行数を数えてはいない)。

## オラクル

規則 2 により、挙動を変える前に、それを見つける検査を持つ。

### すでにある検査

| 検査 | 見るもの |
|---|---|
| `test/typed-diff.test.ts` | 型のある引数と、型を揃えると変わる値を、型の親和性の違う列とキーに入れ、`typeof` と値を node:sqlite と比べる。Hrana 経由。基準経路だけの実行 2 通りでも流す |
| `test/storage-class.test.ts` | 入口ごとの束縛の型 (Hrana、D1 互換の API)、分割で運んだ後の型 |
| `test/key-conversions.test.ts`、`test/key-affinity.test.ts` | `storedAs` と本物の列。literal と引数のキーを 4 シャードで引く |
| `test/wide-integers.test.ts` | 2^53 を超える整数が、SQLite と同じ答えか、どの置き場所でも同じ拒否になること |
| `test/fuzz.test.ts`、`test/diff.ts`、`test/slt*.test.ts` | 書き込みのたびに全表を `quote()` で比べる。答えと列名を比べる |
| `test/internal-columns.test.ts`、`test/partial-column-names.test.ts` | 予約の列名、結果の列名 |
| `test/upgrade.test.ts` | 材料 (`quote()` の写し) から起動して同じ答えを返す |
| `test/rowcost.test.ts`、`test/workerd-limits.test.ts` | workerd での課金の行数と上限 |
| `test/replay.test.ts`、`test/history.test.ts`、`test/ddl-concurrent.test.ts`、範囲の検査 | 並行の下での答え。行イメージを運ぶ経路の全部を通る |

これらが見ていないものが 3 つある。
`typed-diff` の比較 (`show`、`test/typed-diff.test.ts:86`) は `bigint` を `number` にしてから比べるので、結果の INTEGER と REAL の違いを見ない。
どの生成器も、2^53 を超える整数を「正しく通る値」として作らない。
NUL を含む文字列を作る生成器がない。

### 足す検査

1. `test/int64.test.ts`：64 ビットの整数を、どの経路でも SQLite と同じに扱うこと。`test/wide-integers.test.ts` を書き換えて作る。初めは落ちるので `test/open/` に置き、段 3 で `test/` へ移す。値は ±(2^63 - 1)、-2^63、2^53 ± 1、Snowflake の形の ID。入口は Hrana の `integer`、D1 互換の API の `bigint`、文の中の literal。文は、INSERT、主キーの UPDATE、`1 << 62` のように SQL の中で作る値、INSERT … SELECT、VALUES の中のサブクエリ、RETURNING、upsert、DEFAULT、取引の中で書いた行の読み、シャードをまたぐ取引、シャードをまたぐ UNIQUE、条件の span の引数、古い時刻の読み、分割で運んだ後の読み、エクスポートして取り込んだ後の読み。シャードは 1、2、4。実行は 3 通り (普通、基準経路 2 通り)。基準は node:sqlite を BigInt で読み、`bigint` と `number` を区別して比べる。
2. `test/typed-diff.test.ts` を広げる：比較で型を保つ (@libsql/client を `intMode: "bigint"` で使う)。値に 2^53 を超える整数、`"a\u0000b"`、2^63 以上の REAL を足す。文に RETURNING (整数を入れた REAL の列を含む)、`random()` の列の `typeof` と値、`WITH` で始まる文、重なった列名、100 列の結果を足す。
3. 符号の性質の試験 (`test/value-codec.test.ts`)：乱択の値について、JS で要素にして戻すと同じ値になること、SQL のタプルの式 (node:sqlite と sql.js) を JS で戻した値が、同じ行を BigInt で読んだ値と等しいこと。double は `key-conversions` の corpus (2 万個) をビットで比べる。列は 1、32、33、64、100。
4. `test/key-conversions.test.ts` を広げる：`storedValue` を 3 つのエンジンの列と比べる。2^53 と 2^63 の前後の INTEGER と REAL の組で、キーが等しいことと、型のない主キーで UNIQUE の違反になることが一致すること。`keyValues(keyString(v))` で引いた行が元の行であること。新しい `keyString` が、今入れられる値の corpus で、今の `keyString` と同じ文字列を返すこと (古い関数を消す前に流す)。
5. シミュレータの 3 つの確かめ：`query` に INTEGER がドライバの数として出てきたら落とす。捕捉でまとめた `after` を本体の行と比べる。タプルの長さが表定義と違えば落とす。
6. `test/workerd-limits.test.ts` に足す：「確かめた事実」の workerd の列と、推測の表の全部。100 列の表の捕捉と読み。101 列の結果と、関数の引数 33 個の文が断られること (上限が今も 100 と 32 であること)。上限いっぱいの TEXT と BLOB の読み。DO の SQLite の版 (`sqlite_version()`)。`test/rowcost.test.ts` には、包んだ読みで読んだ行の数を足す。
7. `test/ddl-concurrent.test.ts` に、列の順序を変える表の作り直しと並行する取引の場面を足す。
8. 欠陥のスイッチ (`Faults`) を 2 つ足し、検査が見つけることを欠陥の表で確かめる。`unfencedRead` (`LIMIT -1 OFFSET 0` を外す) と `roundedImages` (タプルの整数を `Number` で戻す)。

## 段

| 段 | 中身 | 落ちてから通る検査 | 規模 |
|---|---|---|---|
| 0 | 検査を先に作る。「足す検査」の 1 から 7。`src/` は変えない | 1 は `test/open/` で落ちる (今は拒否)。2 の型の比較は、整数の値の REAL を Hrana が `integer` で返すところで落ちる (今の文書どおりの違いなので、段 3 まで比較を緩める印を付ける)。6 は workerd の事実を確定する。7 は今のコードで通るはずで、落ちれば今の欠陥である | 試験 約 600 行、2 から 3 日 |
| 1 | 符号とキー。`src/value.ts` に要素とタプルの関数、`src/keys.ts` に新しい `keyString` と `keyValues`、`src/sql/` に `storedValue`。まだどこからも呼ばない | 3 と 4。新旧の `keyString` の一致 | 約 350 行、2 日 |
| 2 | 行イメージと捕捉。`Change` をタプルにし、`__cap` を共有にし、`runCaptured`、行を読み書きする関数、移動のペイロード、取引が溜める変更、表定義のときの上限の確かめ、材料を替える。`Value` はまだ今の形 (整数は `number`、整数の値の REAL は印) である。`decodeElem` は型のある値 (`TypedValue`) を返すので、それを今の `Value` に直す橋 (`typedOf` の逆) を段 2 で足して通す。タプルの中の 2^53 以上の整数は、その橋と捕捉の 1 か所ずつで、K1 と同じ誤りにする。列名の予約のうち `$` を外す。`PROTOCOL_VERSION` を 4 にする | 5 の捕捉と長さの確かめ。`typed-diff`、`storage-class`、`wide-integers` (拒否のまま)、`fuzz`、`replay`、`history`、`upgrade` が、3 通りの実行で通る。`history` と `replay` の同じ seed で、RPC の宛先とメソッドの列が変更の前後で同じ (行イメージが短くなるので、大きさで切れる移動の場面は違ってよい)。`rowcost` の期待を 3 行から 2 行に直す。`internal-columns` の `$b` の列は、断る試験から、使える試験に変える。`test/protocol.test.ts` の指紋 | 約 850 行 (試験の補助の書き換えを含む)、4 から 5 日 |
| 3 | 値の型と型つきの読み。`Value` を替え、`bindTyped` の表、`query`、`readLimited` の包み、`exportRows` の読み、RETURNING の書き換え、`Compiled.columns`、Hrana、`toValue`、`constant`、`storedAs` の呼び出しを替える。K1 を外す。列名の予約の `__dinf_` を外す。`PROTOCOL_VERSION` を 5 にする | 1 が通り、`test/` へ移る。2 の緩めた印を外す。5 の `query` の確かめ。8 のスイッチ。`internal-columns` の `__dinf_` の列。`test/protocol.test.ts` の指紋 | 約 900 行、4 から 5 日 |
| 4 | 入口と書き出し。`intMode`、HTTP の JSON、`bin/dump.js` と `importRows` と CLI とのあいだの JSON、`src/analytics.ts`、文書 | `test/export-import.test.ts` に 64 ビットの整数と NUL を含む文字列を足す。`test/d1.test.ts`、`test/binding.test.ts` に `intMode` | 約 300 行、1 から 2 日 |

合わせて約 3,000 行 (うち試験が約 800 行)、13 から 17 日である。

段 2 の後も、段 3 まで残る関数がある。
Worker が集める走査と `exportRows` は、型のない列の `typeof` を一緒に読む今の形 (`Scan.typed`、`typedValues`、`__dinf_typeof_<i>`) のままで、`fromTyped` と `typedScalarSql` も残る。
`exportRows` は、`imageList` の代わりに走査と同じ列の並びで読む。
段 2 で消えるのは、`imageList`、`typedRow`、`__dinf_wide`、`hasWideInteger`、`keySql`、`__capv_<表>` である。
2^53 以上の整数は段 2 でも保存できないので、読みの側で確かめる列 (`__dinf_wide`) は要らない。

段 2 と段 3 を分けるのは、検査を分けるためである。
段 2 は答えを変えない (断る値も同じ) ので、今ある検査の全部がそのまま合格の基準になる。
段 3 は答えを変える (64 ビットの整数が通り、Hrana の結果の型が変わる) ので、段 0 で作った検査が基準になる。

### 進行中の作業との順序

計画書の順番 (2026-11-14) のとおり、シャードを同期の核と待ちの殻に分ける作業の後、置き場所の段 2 の前に入れる。

- 段 0 と段 1 は `src/shard/core.ts` に触らない。核と殻の作業と並行して、今から進められる。段 0 は `test/sim.ts` に触るので、核と殻の作業が RPC の記録の比較に使う部分 (配送と記録) には触らないことを、始める前に揃える。
- 段 2 と段 3 は、`core.ts` の `runStatement`、`runCaptured`、`readLimited`、`exportRows`、`pull`、`receive`、`deltaAfter`、`rowMatches` を書き換える。核と殻の作業が同じ関数を動かすので、その後にする。足すのは同期の SQL だけで、`await` は増えない。核の 1 歩 (`step`) の中に収まる。
- 置き場所の段 2 (piece 単位の移動) は、`PiecePayload` の行と intent、位置の文字列を作り直す。行の形とキー文字列がここで決まってから始める。キー文字列は token の入力なので、形を後から変えると行の置き場所が変わる。
- Meta を 1 つの状態機械にまとめる作業 (順番の 4) とは、触る場所が重ならない。`TableDef` と `DdlEntry` は変えない。
- UNIQUE を論理のキーに統一する作業 (順番の 5) は、キー文字列の上に照合順序を足す。この後にする。

### 段ごとの危険

- 段 1：キー文字列の数の書き方が、公開の後は変えられない形式になる。`context.source` は手元の workerd にあったので、整数は桁のまま書く。本番の workerd では確かめていない (V8 の機能なので、同じ版の workerd なら同じはずである)。
- 段 2：シミュレータの seed は同じ実行になるはずだが、移動の 1 通の大きさが変わるので、分割を含む控えの seed は別の実行になり得る。
- 段 3：`number` を INTEGER のつもりで `query` に渡す誤りは、型の検査で見つからない。INTEGER の列に入ると SQLite が整数に戻すので、検査でも見えにくい。見えるのは、TEXT の列と型のない列である。`typed-diff` の型のない列と、採番を `bigint` にする型で受ける。
- 段 3：DO の SQLite の関数の引数、列、値の長さの上限は、シミュレータが模倣しないか、今回足す。workerd での試験を省くと、本番でだけ落ちる。

## 持ち主の判断が要ること

1. D1 互換の API、Service Binding、HTTP の `/sql` が、2^53 以上の INTEGER を結果に含むときの既定。この案は、誤りにして `intMode` で `bigint` か文字列を選ばせる (@libsql/client と同じ)。丸めた `number` を返すと、誤りにはならないが、黙って隣の値になる。
2. D1 互換の API の引数の `number` が、安全な範囲の外の整数の値のとき。この案は REAL として束縛する (渡された double をそのまま入れる)。刷新案は「入口で弾く」と書いている。弾くなら、2^53 以上 2^63 未満の整数の値を弾くことになり、その範囲の REAL (1e17 など) を渡す文も失敗する。
3. キー文字列の整数を、桁数に関わらず 10 進の数字で書くこと。読み戻しに `JSON.parse` の `context.source` を使う。JS の安全な整数の境目を形式に持ち込まない案である。代わりの案は、2^53 以上だけを `{"$i":"数字"}` と書く。どちらも今のキーを変えない。行の置き場所に効くので、公開の後は変えられない。
4. 採番 (暗黙の rowid と `INTEGER PRIMARY KEY`) を 2^53 未満の範囲で続けること。利用者が 2^53 以上の ID を明示して入れた表でも、採番はその上へ飛ばない。採番した ID と明示した ID は重ならないが、「いちばん大きい ID の次」にはならない。
5. 行イメージに表定義の版を持たせるか。この案は持たせない (今ある 5 つの守り、シミュレータでの長さの確かめ、作り直しの場面の検査に頼る)。持たせるなら、`__intents` と変更ログに版の列を足し、適用のときに比べる。`Change` 1 つにつき数バイト増える。
6. 段 0 と段 1 を、核と殻の作業と並行して今から始めること。

## 持ち主の判断 (2026-11-14)

設計書の問いは、どれも推奨の側で進める (持ち主は 5 つの刷新をすべて公開の前に入れると決め、細部は任せた)。
1. D1 互換の API の結果に 2^53 以上の整数が出たら、既定は誤りを返す。`intMode` で丸めを選べる。
2. 安全な範囲を超える整数の値の JS の数の引数は、REAL として束縛する。
3. キー文字列の整数は桁をそのまま書く。workerd で `JSON.parse` の reviver が元の文字列を受け取れることを段 0 で確かめ、受け取れなければ印 `{"$i":…}` にする。
4. 自動で振る id は 2^53 未満のままにする。
5. 行イメージに表定義の版を持たせない。
6. 段 0 と段 1 は、今始める (`core.ts` に触らない)。

## 段 0 の結果 (2026-11-14)

検査を書き、workerd の事実を確かめた。`src/` は変えていない。
workerd の事実は「確かめた事実」の節に書いた。

### キー文字列の整数の書き方

手元の workerd の `JSON.parse` の reviver は、`context.source` を受け取った。
持ち主の判断の 3 のとおり、整数は桁をそのまま書く。印 `{"$i":…}` は使わない。

### 書いた検査

| 検査 | 場所 | いまの結果 |
|---|---|---|
| 1 | `test/open/int64.test.ts` | 19 の場面を、シャード 1、2、4 と、実行 3 通りで流す。場面ごとに新しいクラスタと基準を使い、最初の食い違いで止めて、食い違い方を分ける。±(2^53 - 1) に収まる値では、どの場面も通る (D1 互換の API に BigInt を渡す場面を除く)。64 ビットの値では、19 の場面のどれもが、最初の大きな値で食い違う。断るのが 17、保存していない値を丸めて返すのが 1、D1 互換の API が BigInt を受け取れないのが 1 である。文書にある決まりで説明できない食い違いはなく、食い違い方は置き場所と経路で変わらない |
| 2 | `test/typed-diff.test.ts` の末尾のブロック、`test/typed-diff-harness.ts` | 元の台本を、結果の INTEGER と REAL を区別して比べる。緩めるのは、文書にある 2 点だけである (整数の値の REAL を `integer` で返す、計算した 2^53 を超える整数を丸めて返す)。元の生成器には手を入れず、足す値と文は 2 つ目の生成器に置いた。どちらも通る。2^53 を超える整数と NUL を含む文字列は、同じ生成器に指定を付けて `test/open/typed-diff-wide.test.ts` が流す (いまは落ちる) |
| 3 | `test/value-codec.test.ts` (段 1) | 通る。JS で要素にして戻した値、node:sqlite と sql.js のタプルの式を JS で戻した値 (列は 1、32、33、64、100。NUL を含む文字列と 64 ビットの整数を含む)、2 万個の double のビット、どの関数の呼び出しも引数が 32 以下であること |
| 4 | `test/key-conversions.test.ts` | 通る。今の `keyString` が等しいことと、型のない主キーで UNIQUE の違反になることが、いま保存できる値で一致する。段 1 で、新しい `keyStringExact` の同じ確かめ (64 ビットの整数と、2^53 と 2^63 の前後の REAL を含む)、`keyValues` で引いた行が元の行であること、新旧の一致、`storedValue` と node:sqlite と sql.js の列の一致を足した。workerd の列との一致は `test/workerd-limits.test.ts` が見る |
| 5 | 書いていない | 3 つとも、確かめる相手が段 2 か段 3 でできる。`query` は段 3 で足す入口である。捕捉でまとめた `after` は、今は本体から読み直しているので、比べる相手がない (段 2)。タプルは段 2 までない。シミュレータの節の 4 つ目 (結果の列が 100 を超える文を断る) は入れた |
| 6 | `test/workerd-limits.test.ts`、`test/workerd-probe.ts` | 「確かめた事実」の節のとおり。段 1 で、100 列の表の捕捉 (trigger と RETURNING) と読み (タプルと、型つきの読み) を、`src/value.ts` の式で足した。`test/rowcost.test.ts` の、D∞ を通した読みの行数は、包む実装が入る段 3 で足す |
| 7 | `test/ddl-concurrent.test.ts` の 5、`test/ddl-harness.ts` | 2 つの形 (DROP して CREATE する形と、移行の道具が流す 4 文) で通る。作り直す表に、作業負荷が書かない列 `gen` を置き、既定値を表定義ごとに変えた。作り直した表に古い既定値の行があれば、古い表定義で作った行イメージが新しい表に入っている。行イメージが列名を持つ今でも見える。intent を決着させる守りを外す (`ddlIgnoresIntents`) と、この検査が気付く |

### 見つかった今の欠陥

直していない。
どれも `test/open/` に、正しい振る舞いを期待する再現がある。

1. NUL を含む TEXT が、Worker の SQLite を通ると最初の NUL で切れる。答えが経路で変わり、INSERT … SELECT は切れた値を保存する (`test/open/nul-in-text.test.ts`)。
2. 97 列から 99 列の表は、`CREATE TABLE` を通るのに、DO では 1 行も書けない。式の木の深さが 100 を超える (`test/open/wide-table-expression-depth.test.ts`)。
3. 列の数と、型のない列の数と、1 を足して 100 を超える表は、`CREATE TABLE` を通るのに、DO では読むことも書くこともできない。行イメージを読む文と、行を集める走査が、型のない列ごとに `typeof` の列を、さらに 2^53 の確かめの列を足すので、結果の列が 100 を超える。PRIMARY KEY のない表は、rowid の列がもう 1 つ加わる。主キーの 1 列と型のない 50 列の表が、いちばん小さい例である (`test/open/untyped-columns-result-limit.test.ts`)。
4. 取引の中の、複数のシャードを読む文が、読んだ後に 2 つ以上のシャードで行が変わっていると、スナップショットを読み続けずに `read too old` で失敗する (`test/open/snapshot-read-after-two-shards-changed.test.ts`)。
5. D1 互換の API に BigInt を渡すと、値が小さくても、内部の誤り「Do not know how to serialize a BigInt」で失敗する。段 3 で BigInt を INTEGER として受け取るようになる (`test/open/int64.test.ts` が見ている)。

2 と 3 は、同じ 1 つの穴である。表を作るときの確かめ (`assertReplays`) も、シミュレータも、DO の SQLite の上限のうち、式の木の深さ (100) と結果の列の数 (100) を知らなかった。作れる表と、DO で使える表が食い違う。
直すときは、列の数ごとに個別に手当てするのではなく、DO の上限を 1 か所に持ち、表を作るときの確かめとシミュレータの両方がそれを見る形にする (計画書の不変条件 3)。
どちらも、シミュレータが DO の上限を模していなかったために、シミュレータの試験では通っていた。
3 の上限は段 0 でシミュレータに入れた。2 の上限 (式の木の深さ) は node:sqlite では模倣できないので、workerd の試験でしか見えない。
1 は、node:sqlite のドライバも TEXT を NUL で切るので、シミュレータでは見えない。

## 段 1 の結果 (2026-11-14)

符号とキーの関数を足した。足しただけで、どこからも呼んでいない (`src/` の中で、3 つのファイルの外に参照がないことを確かめた)。

| 場所 | 足したもの |
|---|---|
| `src/value.ts` | `TypedValue`、`Elem`、`Tuple`、`encodeElem`、`decodeElem`、`selectElemSql`、`returningElemSql`、`jsonElemSql`、`MAX_FUNCTION_ARGS`、`tupleSql`、`parseTuple`、`encodeTuple`、`decodeTuple`、`typedOf` |
| `src/keys.ts` | `keyStringExact`、`keyValues` |
| `src/sql/stored.ts` | `initStoredValue`、`storedValue` |

新旧のキー文字列は、いま保存できる値の集まりで一致した。
集まりは、絶対値が 2^53 未満の INTEGER、double 20,285 個の REAL、数に読める文字列、BLOB、NULL と、それらを並べた複数の列のキーである。
違ったのは、設計のとおり、絶対値が 2^53 以上で 64 ビットの整数の範囲にある整数の値の REAL のうち、JS の表記が正確な値と違うものだけだった (2^60 は、今は `1152921504606847000`、新しくは `1152921504606846976`)。

設計書から変えた点と、設計書を直した点は次のとおりである。

- `decodeElem` は、型のある値 (`TypedValue`) を返す。段 2 で今の `Value` に直す橋を足す (「段」の表の段 2 の行を直した)。段 2 の決まり (K1 と同じ誤り) を `decodeElem` に入れると、段 3 で外すことになる。
- `storedValue` は、入った値を `useBigInt` の素の列ではなく、タプルで読む。sql.js のドライバが TEXT を NUL で切るからである (「型の親和性の変換」の節を直した)。
- `initStoredValue` は、sql.js の engine を引数で受け取る。`src/sql/scratch.ts` の engine は外から見えず、段 1 では `scratch.ts` に触らないと決めたからである。本番の配線は段 3 に残る。
- 100 列の表の UPDATE の trigger の文面は 35 KB だった (設計書は 30 KB と書いていた)。RETURNING に足す文面は 15 KB で、設計書のとおりだった。
- `storedValue` の変換は 1 つあたり 27 µs だった (設計書は 21 から 25 µs)。

段 2 に残ること。

- `Change`、`PiecePayload.rows`、取引が溜める変更をタプルにする。`__cap` を共有の表にし、trigger を `tupleSql` で作る。
- `keyString` を `keyStringExact` に入れ替え、キー文字列を読む場所を `keyValues` にする。同じ seed の RPC の宛先とメソッドの列が、前後で同じであることを見る。
- `TypedValue` を今の `Value` に直す橋を足し、2^53 以上の整数をそこで断る。
- 表定義のときの上限の確かめを、新しい 4 つの文に替える。式の木の深さ (100) も見る。
- シミュレータの確かめ (検査の 5) のうち、捕捉でまとめた `after` と本体の行の比較、タプルの長さの確かめを足す。
- 段 0 で見つかった欠陥の 2 (式の木の深さ) は、`imageList` の 2^53 の確かめがなくなれば、原因がなくなる。再現が通ることを確かめて `test/` へ移す。3 (結果の列の数) は、行を集める走査が `typeof` の列を足すのをやめる段 3 まで残る。


## 段 2 の結果 (2026-11-14)

行イメージをタプルにし、捕捉を共有の `__cap` にした。`Value` は今の形のままである。

| 場所 | 変えたこと |
|---|---|
| `src/types.ts` | `Change` の `before` と `after`、`PiecePayload.rows` をタプルにした。`PROTOCOL_VERSION` と `MIN_PROTOCOL_VERSION` を 4、`STORAGE_FORMAT` を 2 にした |
| `src/value.ts` | 橋 `fromTypedValue` (`typedOf` の逆)。タプルの要素を値に戻すときは、どれもここを通り、2^53 以上の INTEGER はここで K1 の誤りになる |
| `src/keys.ts` | `keyString` (形式 1) を消し、呼んでいた場所を `keyStringExact` にした。`keySql` を消した。キー文字列を今の `Value` に戻す `keyParams` を足した |
| `src/shard/rows.ts` | 行を読み書きする関数をタプルにした (`selectRow`、`selectGroup`、`insertRow`、`setBasedRestore`、`applyChanges`)。`imageAt`、`valuesOf`、`tupleKey`。捕捉の trigger と `capturedChanges`。`imageList`、`typedRow`、`__dinf_wide`、`hasWideInteger`、`__capv_<表>` を消した。`imageStatements` (表を作るときに確かめる文)。`joinTerms` (釣り合った条件) |
| `src/shard/kernel.ts` | `runCaptured` (RETURNING のタプル)、`exportRows` (走査と同じ列の並び)、範囲の検査の `deleteOutside` (タプルで読む)、値の長さの上限の誤りの言い換え |
| `src/client/db.ts` | 行イメージを列名で引く 3 か所を `imageAt` に、index の表の項目を `tupleOfRow` にした。表を作るときの確かめ |
| `src/sql/depth.ts`、`src/shard-limits.ts` | 式の木の深さの見積もりと、D∞ が作る文の上限 `builtLimitOf` |
| `src/sql/ddl.ts` | 列名の予約の `$` を外した |
| `src/analytics.ts` | 出す行に、表定義の列名を付け直す (`rowOf`。段 1 までの行イメージと同じ形) |

### 設計書から変えた点

- 関数の名前は `keyStringExact` のままにした (指示書のとおり。設計書は、入れ替えた後の名前を `keyString` と書いている)。形式 1 の関数は `test/key-string-old.ts` に残し、`test/key-conversions.test.ts` が新旧を比べ続ける。
- キー文字列から値に戻す場所 (`pkValues`、`selectGroup`、捕捉のキー、Worker の衝突の探し方、述語の判定) は、`keyValues` の結果を `keyParams` で今の `Value` に直す。`fromTypedValue` は通さない。キーの整数には、2^53 以上の整数の値の REAL から作ったものがあり (K1 が断るのは格納の型が INTEGER の値だけ)、橋を通すと、そういう行が引けなくなるからである。`keyParams` は整数を JS の数に正確に戻し、戻らない整数だけを K1 と同じ誤りにする (`test/large-real-keys.test.ts`)。
- 保存の形式の版は 2 に上げた (「永続データと通信で変わるもの」の節を直した)。
- 「位置の比較」は、今のコードにない。位置 (`Pos`) は JSON の文字列として保存して比べるだけで (`posKey`、`posOf`)、キー文字列を値に戻していない。どの piece もグループの全体だからである。
- 表を作るときの確かめは、捕捉の trigger (3 つ)、主キーの読み、グループの読み、行を入れ直す文、今の走査の形 (`scanSql`) を測る。式の木の深さは、`src/sql/depth.ts` の見積もりで測る。見積もりは、SQLite の数え方 (式の節の高さと、名前を解決するときに副問い合わせの式の高さを足すこと) を字句から写したもので、sqlite3 3.45.1 の CLI (`.limit expr_depth`) と突き合わせた。D∞ が作る文の形と、乱択の式 (3 つの seed で、文法に合う異なる文 799 個) で、SQLite より小さく出たことはない。node:sqlite と sql.js は深さの上限を変えられないので、シミュレータの試験には使わず、単体の試験 (`test/expression-depth.test.ts`) と workerd の試験 (`test/wide-table-expression-depth.test.ts`) で見る。
- 主キーと shard key の列を AND でつなぐ条件と、基準経路の衝突の探し方が問いを OR でつなぐ条件は、16 項を超えたら釣り合った木に組む (`joinTerms`)。99 列の主キーの表は、組む前は `CREATE TABLE` で断られ (深さ 102)、組んだ後は workerd で書き換えも削除も通る。ただし、利用者の文が 99 列の主キーを引数で名指しすると、利用者の文そのものが深さ 100 を超える (`bindTyped` が整数の引数を包む式は、1 項あたり深さを 2 足す)。利用者の文の深さは、段 3 に残すことに書いた。条件の span (`src/client/spans.ts`) も、UNIQUE の列を AND でつなぐ。表を作るときの確かめには入っていない。
- 行イメージのタプルが DO の値の長さの上限を超えて SQLite が捕捉の中で止めた書き込みは、取引の大きさの上限の誤りに言い換える (「大きさの勘定」の節)。RETURNING の捕捉と trigger の捕捉の両方で、workerd で確かめた。
- 範囲の検査 (試験用の `deleteOutside`) も、行をタプルで読む。素の列で読む文を減らすためである。

### 検査の 5 と、見つかった危険

捕捉でまとめた `after` と本体の行の比較、タプルの長さと表定義の比較を、シミュレータのどの試験にも掛けた (`test/setup.ts`、`src/shard/rows.ts` の `imageChecks`)。シャードの捕捉と、Worker の SQLite での捕捉 (基準経路の書き込み) の両方に掛かる。
報告するだけで処理を変えないので、RPC の列は変わらない。

この検査が、計画と取引の表定義の食い違いを見つけた。
`Db.transaction` は、やり直すたびに表定義を取り直すが、文の計画は最初のものを使い続ける。そのため、基準経路の書き込み (`Txn.wasmWrite`) では、Worker の SQLite は取引の新しい表定義 (`this.cat`) で作られ、捕捉の trigger は計画の古い表定義 (`p.tables`) で作られることがあった。古い trigger は列の少ないタプルを書く。
列名つきの行イメージの間は、変更後の行を本体から読み直していたので、食い違いは捕捉に現れなかった。
trigger を、Worker の SQLite を作った表定義で作るようにした。基準経路だけの実行の `test/ddl-concurrent.test.ts` (ADD COLUMN と並行する取引、14 本) で見つかった。
同じ食い違いは、行を集める走査にも残っている。走査は計画の表定義の列だけを読むので、足された列は Worker の SQLite で既定値になり、文がその列に触らなくても、確定した値を既定値で上書きする。段 1 でも同じだった (変更後の行を本体から読み直していたので、既定値を書いた)。直していない。再現は `test/open/reference-write-after-add-column.test.ts` にある。同じ場所の 2 つ目の直しになるので (規則 1)、計画を取引の表定義と結び付ける形 (表定義が変わったら計画し直す) を、持ち主に諮る。

守りを外した反例の試験 (`m14_red_no_drain` の 2 つの守りを外す場面) では、長さの確かめが、古い表定義の intent を新しい表に当てはめたことを見つける。その試験は反例そのものを確かめるので、確かめを切る (`SimOptions.noImageCheck`)。

### RPC の列の比較

`test/history.test.ts` と `test/replay.test.ts` の既定の seed (61 本の試験) で、RPC の送り元、宛先、メソッドの列を、変更の前 (`775dd08`) と後で比べた (`RPC_TRACE`、`test/setup.ts`)。
キーの入れ替えの後も、タプルと捕捉の後も、釣り合った条件の後も、61 本すべてで 1 行も違わなかった。
移動の 1 通は大きさで切るが、この作業負荷の行は小さく、切れ目が変わらなかった。

### 課金

trigger で捕捉する 1 行の UPDATE (`test/rowcost.test.ts` に足した操作) は、手元の workerd で 1 操作 6 行から 5 行になった。捕捉が書く行が、`__cap`、`__capv_<表>`、`__cap_on` の 3 行から、`__cap` と `__cap_on` の 2 行になった分である (残りは、下書きの本体の 1 行、確定の適用の 1 行、変更ログの 1 行)。RETURNING で捕捉する操作の行数は変わらない。

### 段 3 に残ること

- `Value` を型のある値にし、`fromTypedValue`、`keyParams`、`TypedValue`、`typedOf` を消す。K1 を外す。
- 行を集める走査 (`Scan.typed`、`scanSql`、`typedValues`、`__dinf_typeof_<i>`) と `exportRows` を型つきの読みにする。型のない列が 50 以上の表で、行を集める SELECT が結果の列の上限に当たる (`test/open/untyped-columns-result-limit.test.ts`。INSERT、UPDATE、DELETE は段 2 で通るようになった)。
- NUL を含む TEXT (`test/open/nul-in-text.test.ts`)。段 2 は、利用者の TEXT を素の列で読む文を足していない。シャードの `listGroups`、`exportRows`、Worker の `scanShard` と走査は、今も素の列で読む。
- 列名の予約の `__dinf_`。`PROTOCOL_VERSION` を 5 にする。
- 欠陥のスイッチ `unfencedRead` と `roundedImages`。
- 利用者の文の式の木の深さ。シャードは、届いた文の深さを測らない。D∞ が作る文は表を作るときに確かめるが、深い利用者の文は、DO でだけ失敗し、シミュレータでは通る (`test/open/user-statement-expression-depth.test.ts`。99 列の主キーを整数の引数で引く文は、`bindTyped` の包みで深さ 102 になる)。見積もりを利用者の文の判定 (`shardLimitOf`) とシミュレータの模倣に使うかは、見積もりの多めの幅を確かめてから決める (不変条件 3)。
