# 値と行イメージの作り直しの設計

状態：設計。実装はまだない。持ち主の判断が要ることを末尾に記した
作成日：2026-11-14
前提：[storage-format.md](./storage-format.md)、[sql-language.md](./sql-language.md) の「値」、[design-subslots.md](./design-subslots.md)

コードの行番号は `71eda05` (ブランチ `subslots`) のもので、`src/` と `test/` は `packages/cf-d-infinity/` の下を指す。
今のコードの挙動についての記述は、コードを読んだ結果である。
SQLite の挙動についての記述は、node:sqlite (SQLite 3.51.3) と sql.js 1.13.0 (SQLite 3.49.1) で小さなスクリプトを流して確かめた。
workerd では何も流していない。vitest と TLC も流していない。
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

| 事実 | node:sqlite 3.51.3 | sql.js 3.49.1 | workerd |
|---|---|---|---|
| `quote()` は TEXT を最初の NUL で切る | 切る | 切る | 段 0 |
| `'t' \|\| x` と `json_array` は NUL を保つ (`\u0000`) | 保つ | 保つ | 段 0 |
| `(CAST(? AS INTEGER)+0)` に 10 進の文字列を束縛すると、±2^63 の端まで正確な INTEGER になる。型の親和性は持たない | 正確 | 正確 | 段 0 |
| `'i' \|\| c` と `json_array(c)` は、64 ビットの整数を全桁書く | 書く | 書く | 段 0 |
| `json_array` の REAL は 15 桁に丸まる (`0.30000000000000004` が `0.3`) | 丸まる | 丸まる | (使わない) |
| CTE の列を 2 回参照すると、`random()` が 2 回評価される | される | される | 段 0 |
| `FROM (SELECT * FROM r LIMIT -1 OFFSET 0)` を挟むと 1 回になる。実行は co-routine で、中間の表は作らない | 1 回 | 1 回 | 段 0 |
| AFTER trigger の `new.*` は、型の親和性を掛けた後の値で、採番した rowid が入っている | そう | そう | 段 0 |
| INSERT の RETURNING で、整数を入れた REAL の列を `CASE ... ELSE c END` に通すと、ドライバには INTEGER として届く (`typeof` は `real`) | 届く | 届く | 段 0 |
| 文を用意するだけで (実行せずに)、結果の列名が取れる。RETURNING の列名も取れる | 取れる | 取れる | (Worker の sql.js だけが使う) |
| INTEGER と REAL の等値は正確に比べる (`9007199254740993 = 9007199254740992.0` は偽) | 正確 | 正確 | 段 0 |
| REAL を TEXT の列に入れた結果 (double 20,262 個) | 2 つは一致 | | 段 0 |
| 文字列を NUMERIC と REAL の列に入れた結果 (141,852 個) | 2 つは一致 | | 段 0 |
| BigInt を束縛する | INTEGER になる | TEXT になる | 束縛できない (計画書の未解決の問題 20) |
| INTEGER を読む | 既定は 2^53 を超えると例外。`setReadBigInts` で BigInt | `useBigInt` で BigInt | 丸めた `number` |
| `JSON.parse` の reviver が元の文面 (`context.source`) を受け取る | Node 24.15 で受け取る | | 段 0 |
| structured clone が BigInt を運ぶ | Node で運ぶ | | DO の RPC と Service Binding は段 0 |

workerd の列は、どれも段 0 で `test/workerd-limits.test.ts` に足して確かめる。
1 つでも違えば、その行に頼る決定を見直してから先へ進む。

次の 4 つは、確かめたことではなく、文書とコードからの推測である。
この設計はどれにも頼っているので、同じく段 0 で workerd で確かめる。

| 推測 | 根拠 | 頼っている決定 |
|---|---|---|
| DO の SQLite の列の上限 (100) は、結果の列の数にも掛かる | SQLite の文書は、列の上限が SELECT の結果の項にも掛かると書いている。DO で試してはいない | 型つきの読みが列を足さないこと。今の `imageList` は 100 列の表で列が 100 を超えるので、今も断られているはずである |
| 1 つの値の長さの上限 | `src/shard-limits.ts` は 2 MB、`docs/platform-facts.md` は 8 MB (2026-11-09 の公式の表) と書いている | `'t' \|\| c` は値を 1 バイト長くし、`hex(c)` は 2 倍にする。上限いっぱいの TEXT を読めるか、行イメージの BLOB がどこまで入るかが、これで決まる |
| 包んだ読みで、課金される読んだ行の数は変わらない | `EXPLAIN QUERY PLAN` が co-routine と答えたことだけである | 「費用」の節の課金の記述。`test/rowcost.test.ts` に読みの場合を足して数える |
| -0.0 を束縛して読むと 0.0 になる | node:sqlite では `quote()` が `0.0` と書いた。sql.js は -0.0 を INTEGER の 0 として束縛した (`(CAST(? AS REAL)+0.0)` で包む場合に当たる) | -0.0 と 0.0 を区別しないという決定 |

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

SQL の式は次の 3 つで、`src/value.ts` に置く。

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
SQL が作った要素と JS が作った要素は、同じ REAL でも文字が違うことがある (`r3.000000000000000445e-01` と `r0.30000000000000004`)。
要素を文字で比べる場所は作らず、比べるときは値に戻す (`touchesUniqueOnManyRows`、`src/shard/rows.ts:224`)。

### タプル

```ts
type Tuple = (string | null)[];   // JSON の中の要素の並び
```

SQL では `json_array(要素, ...)` で作る。
列が 32 を超える表では、32 個ずつの `json_array` を `json_array` で包み、JS が 1 段だけ平らにする。
要素は文字列か `null` なので、平らにしてよいかは迷わない。
入れ子は SQL から JS へ渡す間だけの形で、保存する形はいつも平らな配列である。

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
- 結果の列が 100 を超える文を断る (`checkDoLimits`、`:22`)。今は模倣していない。

関数の引数の上限 (32) は、node:sqlite では模倣できない。
タプルの式を作る関数の単体の試験 (どの関数の呼び出しも引数が 32 以下) と、workerd での 100 列の表の試験で見る。

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
数字だけの文面で 64 ビットに収まれば `BigInt(文面)`、そうでなければ `number` とする (`keyValues`、`src/keys.ts` に足す)。
戻した値は `WHERE 主キー IS ?` に束縛する。
INTEGER の引数は、REAL で入っている同じ値の行にも当たる (確かめた)。

`context.source` は、Node 24 にある。workerd にあるかは段 0 で確かめる。
なければ、2^53 以上の整数だけを `{"$i":"数字"}` と書く形に替える。
どちらの形にするかは、行の置き場所に効き、公開の後は変えられないので、段 1 の前に決める。

### 型の親和性の変換

Worker は、文の中の値から行の置き場所を決めるために、「その値が列に入ると何になるか」を知る必要がある。
今は `storedAs` (`src/keys.ts:42`) が、数に読める文字列の文法を正規表現で写し、REAL を TEXT にする変換だけを諦めている (`undefined` を返し、読みは絞らず、書き込みは基準経路)。

`storedAs` を消し、`storedValue(v, 親和性)` に替える (`src/sql/` に置く)。

| 入る値と列の親和性 | 決め方 |
|---|---|
| NULL、BLOB、親和性が BLOB の列 | 変換なし |
| TEXT を TEXT へ、INTEGER を INTEGER か NUMERIC へ、REAL を REAL へ | 変換なし |
| 安全な整数の値の REAL を INTEGER か NUMERIC へ | 同じ値の INTEGER |
| 安全な範囲の INTEGER を REAL へ | 同じ値の REAL |
| INTEGER を TEXT へ | 10 進の文字列 |
| ほか (文字列を数の列へ、2^53 以上の INTEGER と REAL のあいだ、REAL を TEXT へ) | Worker の SQLite に入れて読む |

最後の行は、親和性ごとの列を持つ 1 行の表に `INSERT OR REPLACE ... RETURNING` で入れ、`useBigInt` で読む (RETURNING が返す値と、入れた後に読んだ値が同じであることを確かめた)。
`CAST` は使わない。`CAST('abc' AS INTEGER)` は 0 で、列の親和性は `'abc'` を TEXT のまま残す。
数に読める文字列の文法 (`' 12 '`、`'1e3'`、`'0x10'`、`'9223372036854775808'`) を、JS で写すのをやめられる。

`pinsOf` と `pkOf` (`src/sql/plan.ts:346`、`:363`) は同期の関数で、sql.js の初期化は非同期である。
変換のための SQLite は、isolate に 1 つだけ開いて持ち続ける。
`Db` が文を計画する前に、その初期化を 1 度だけ待つ (どの文も `Db.compiled` で sql.js を使うので、読み込みの費用は増えない)。
`storedValue` は、初期化の前に呼ばれたら投げる。
プランナを直に呼ぶ試験 (`test/planner-shapes.test.ts`) は、先に初期化を待つ。

JS に残す 3 行は、SQLite の文書が定める正確な変換で、1 行で書ける。
残す理由は費用である。
sql.js で 1 つの値を変換すると 21 から 25 µs かかった (用意した 2 つの文で、入れて読み直す形で測った)。
@libsql/client は JS の数を `float` で送るので、整数の主キーの列に REAL が入る変換は、ふつうの文のたびに起きる。
1,000 行の INSERT で、キーの列ごとに 20 ms 余計にかかることになる。
`test/key-conversions.test.ts` は、JS の行も含めた `storedValue` の全体を、本物の列に入れた結果と比べる。

版で結果が変わり得る変換が 2 つある。
REAL を TEXT にする書式と、文字列を整数でない REAL にする解釈である。
Worker の SQLite と DO の SQLite の版が違うと、Worker が思うキーとシャードに入った行のキーが食い違い、読みが空を返す。
node:sqlite 3.51.3 と sql.js 3.49.1 は、上の「確かめた事実」の corpus で 1 件も食い違わなかった。
DO の SQLite は確かめていない。
規則は次のとおりにする。

- REAL を TEXT にする変換は、今と同じく `undefined` を返す。
- 文字列を REAL にする変換は、段 0 で workerd の結果が sql.js と一致すれば使う (今は JS の `Number()` で写して使っている)。一致しなければ、これも `undefined` にする。
- corpus は `test/workerd-limits.test.ts` と `scripts/cloudflare-check.sh` で流し続け、DO の SQLite の版が上がって食い違ったら見つける。

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
- 全表の走査を、型つきの読みの形に包んだ文
- 行を入れ直す文 (`insertRow`)。束縛の変数が 100 を超えないこと

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

保存の形式の版 (`STORAGE_FORMAT`) は 1 のままにし、材料 (`test/fixtures/storage/format-1.json`) を作り直す (公開の前なので許される)。

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
| 型の親和性の変換 (JS で済まない値、1 つあたり) | JS の関数 | 21 から 25 µs |
| 100 列の表の RETURNING に足す文面 | 約 10 KB | 15 KB |
| 100 列の表の UPDATE の trigger の文面 | ミラーへの INSERT | 30 KB |

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
| 2 | 行イメージと捕捉。`Change` をタプルにし、`__cap` を共有にし、`runCaptured`、行を読み書きする関数、移動のペイロード、取引が溜める変更、表定義のときの上限の確かめ、材料を替える。`Value` はまだ今の形 (整数は `number`、整数の値の REAL は印) で、`decodeElem` はその形を返す。タプルの中の 2^53 以上の整数は K1 と同じ誤りにする (`decodeElem` と捕捉の 1 か所ずつ)。列名の予約のうち `$` を外す。`PROTOCOL_VERSION` を 4 にする | 5 の捕捉と長さの確かめ。`typed-diff`、`storage-class`、`wide-integers` (拒否のまま)、`fuzz`、`replay`、`history`、`upgrade` が、3 通りの実行で通る。`history` と `replay` の同じ seed で、RPC の宛先とメソッドの列が変更の前後で同じ (行イメージが短くなるので、大きさで切れる移動の場面は違ってよい)。`rowcost` の期待を 3 行から 2 行に直す。`internal-columns` の `$b` の列は、断る試験から、使える試験に変える。`test/protocol.test.ts` の指紋 | 約 850 行 (試験の補助の書き換えを含む)、4 から 5 日 |
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

- 段 1：キー文字列の数の書き方が、公開の後は変えられない形式になる。`context.source` が workerd になければ、形を決め直す。
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

