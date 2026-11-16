# 保存と通信の形式

状態：Early 版で固める形式の一覧 (2026-11-12)。2026-11-14 に、行の置き場所を token の区間にした ([design-subslots.md](./design-subslots.md))。同じ日に、行イメージをタプルにし、キー文字列の数の書き方を決めた ([design-values.md](./design-values.md) の段 2。保存の形式の版 2、通信の版 4)。値の JS の型を格納の型にし、シャードの結果を型つきで読むようにした (同じ設計書の段 3。通信の版 5。保存の形式は変わらない)。2026-11-15 に、エクスポートの行を要素のタプルにし、形式の版を file と CLI とのあいだの JSON に持たせた (同じ設計書の段 4。エクスポートの形式の版 1)。2026-11-15 に、Meta の表定義の版と範囲表を、epoch の列 1 本にした ([design-catalog-epoch.md](./design-catalog-epoch.md) の段 1。保存の形式の版 3。シャードの形式は変わらない)

D∞ は、利用者のデータを Durable Object の SQLite に置き、Worker と Durable Object のあいだを RPC でつなぐ。
公開した後に新しい版を置くと、古い版が書いたデータを新しい版が開き、古い版と新しい版の Worker と Durable Object がしばらく混ざって動く。
この文書は、そのとき食い違ってはいけない形式を並べ、どれを固めるか、どれを作り直せるかを決める。

形式は 3 つに分ける。

- **固定**：Early 版から変えない。変えるときは、保存の形式の版 (`STORAGE_FORMAT`、`src/types.ts`) を上げ、1 つ前の版から進める移行を `STORAGE_MIGRATIONS` に足し、更新の試験 (`test/upgrade.test.ts`) に古い版のデータを残す (`test/fixtures/storage/format-<版>.json`。公開した版の材料は書き換えない)。DO は起動するときに、古い版のデータへ移行を順に流す。古い版のコードは、新しい版のデータを開くと起動を拒否する (`checkStorageFormat`)。最初の公開の前は後方互換を持たない。形式を変えたら材料を作り直し、古い版のデータを読み違える変更なら版を上げて、移行を書かずに古い版の材料を消す (版 2 で、版 1 の材料を消した)。移行のない古い版のデータは、起動を拒否する。
- **版で守る**：互換でない変更は、通信の版 (`PROTOCOL_VERSION`、`MIN_PROTOCOL_VERSION`) を上げて行う。シャードは受け付ける範囲の版だけを処理する。
- **作り直せる**：失っても、作り直すか、利用者がやり直せば済む。版を上げずに変えてよい。

## 値とキー

| 形式 | 中身 | 区分 |
|---|---|---|
| 値の型 | JS の型が格納の型である (`src/types.ts` の `Value`)。`bigint` は INTEGER (-2^63 から 2^63 - 1)、`number` は REAL (整数の値でも REAL)、文字列は TEXT、`Uint8Array` は BLOB。値を JSON にする場所 (baton、2PC の ID の指紋、範囲の引数) では、INTEGER を `{"$i":"数字"}`、BLOB を `{"$b":"16 進"}`、無限大を `{"$f":"Infinity"}` と書く (`src/shard/rows.ts` の `encode`)。内部の表の値は JS の数で持つ (時刻、版、token、カウンタで、どれも 2^53 に収まる) | 固定 |
| キー文字列 | 主キーと shard key の値の並びを JSON にしたもの (`src/keys.ts` の `keyString`)。INTEGER は、桁数に関わらず 10 進の数字で書く。REAL は、整数の値で 64 ビットの整数の範囲にあればその整数の数字で、そうでなければ `JSON.stringify` の表記で書く。INTEGER の 5 と REAL の 5.0 は同じ `5`。BLOB は `{"$b":"小文字の 16 進"}`、無限大は `{"$f":"Infinity"}`。値は列の型の親和性で揃えてから作る (`src/sql/stored.ts` の `storedValue`)。読み戻すときは `keyValues` が数字の桁を落とさずに読む | 固定 |
| 行の置き場所 (token) | `token = region × 2^32 + slot × 2^16 + subslot` の 40 ビットの整数 (`src/routing.ts`)。region はいまは 0 で、行ごとに置く地域を決める拡張のために 8 ビットを空けてある。slot は、shard key のキー文字列の hash (FNV-1a と murmur3 の finalizer、32 ビット) の上位 16 ビット。subslot は、主キーのキー文字列の同じ hash の下位 16 ビット。表の名前は混ぜない。行ごとに保存するものはない。同じ shard key の行は、連続した 65,536 個の token (その slot のブロック) に載る | 固定 |
| 範囲 | token の半開区間 `[start, end)`。範囲表、読む範囲の claim、範囲の移動の要求、分割の枠が、この形で範囲を運ぶ | 固定 |
| 位置 (`Pos`) | グループの中の行の位置。`[表の名前, 主キーのキー文字列]` で、表の名前の順、表の中は主キーの順に並ぶ。端は `null`。表の列には、JSON の文字列で書く (端は `null` の 4 文字) | 固定 |
| 時刻 (`Ts`) | 物理の ms × 1024 + 論理のカウンタ (`src/hlc.ts`)。2^53 に収まる | 固定 |
| 行イメージと変更 (`Change`) | `{ table, pk, sk, before, after }`。行は、表定義の列の順に並べた要素の配列 (タプル。`src/value.ts`)。PRIMARY KEY のない表は先頭に rowid を置く。列名は持たない。要素は、INTEGER が `"i"` と 10 進の数字、TEXT が `"t"` と文字列、REAL が `"r"` と `quote()` の文字列、BLOB が `"b"` と大文字の 16 進、NULL が `null`。変更の並びは JSON にする (`src/shard/rows.ts` の `encode`) | 固定 |

## シャード (`DinfShard`)

| 表 | 中身 | 区分 |
|---|---|---|
| 利用者の表 | 利用者が書いた表定義 | 固定 (利用者の形式) |
| `__gidx_<index>(k, pk, sk)` | シャードをまたぐ UNIQUE の index。`k` は値のキー文字列 | 固定。中身は index を作り直せば戻るが、作り直す手順は Early 版にない |
| `__meta(k, v)` | `format` (保存の形式の版)、`epoch`、`ceiling`、`flushed`、`log_low_water`、`ddl_floor`、`log_gens` (変更ログの世代の JSON の配列) | 固定 |
| `__ddl(version, entry)` | Meta から受け取った表定義の版。`entry` は `DdlEntry` の JSON (`TableDef` を含む) | 固定 |
| `__log_g<世代>(commit_ts, txn, blob)` | 確定した取引の変更ログ。`blob` は `Change[]` の JSON。世代は物理時刻で分ける | 固定 |
| `__intents(tbl, pk, sk, txn, anchor, prepare_ts, change)` | 2 相の確定の途中の書き込み。`change` は `Change` の JSON | 固定 |
| `__txn(txn, status, c, participants, done, at)` | anchor が持つ取引の決着 | 固定 |
| `__fenced(lo, hi, to, done)` | 送り出した範囲 (fence)。token の区間 `[lo, hi)` である。渡し終えると `done` = 1 にし、消さない | 固定 |
| `__incoming(lo, hi, from_id, done, m)` | 受け取った範囲。受け取り終えても消さず、`done` = 1 と、渡した側から受け取った時刻 `m` を残す | 固定 |
| `__moved(g, lo, hi, after, up_to, m, dest, acked)` | 渡した piece。主キーは `(g, lo, after)`。`g` は shard key のキー文字列、`[lo, hi)` は fence の区間、`(after, up_to]` は位置の区間、`m` は手放した時刻である | 固定 |
| `__moved_txn(txn, g, lo, after, dest)` | 渡した piece に intent を持っていた取引。決着を渡した先へ転送するのに使う | 固定 |
| `__arrived(g, lo, hi, after, up_to, m)` | 受け取った piece と、渡した側が手放した時刻 | 固定 |
| `__cap(seq, tbl, old, new)`、`__cap_on`、trigger `__cap_<表>_I/U/D` | 1 つの文の変更を捕まえる表。trigger が、変更前と変更後の行のタプルを JSON で書く。文の外では空である | 作り直せる (trigger は表定義の版を適用するときに作る。Meta の `__epoch` の `commit` の記録が運ぶ版は、その trigger の文を含む) |

移動の単位は piece で、グループ `g` の行のうち、token が fence の区間に入り、位置が区間 `(after, up_to]` に入るものである。
いまのコードは、形式だけを持つ (設計書の段 1)。
作る範囲はどれも両端が slot の境目 (65,536 の倍数) にあり、piece はどれもグループの全体 (`after` も `up_to` も `null`) である。
受け取り終えた `__incoming` の行は、範囲の床である。シャードは、起動のときに読み戻し、その範囲のキーを `m` より前の時刻で読む要求を断る
(`src/shard/kernel.ts` の `assertOwned`)。受け取った範囲の外の要求を断る確かめには、まだ使っていない。

## Meta (`DinfMeta`)

| 表 | 中身 | 区分 |
|---|---|---|
| `__epoch(epoch, rec)` | epoch の列 (`src/catalog.ts`)。追記だけで、1 行が 1 つの epoch である。`rec` は `EpochRecord` の JSON。epoch 0 は最初の範囲表 (`{ kind: "genesis", routing }`。`Routing` の JSON で、項目は `{ start, end, shard }`。全部の項目が region 0 の token `[0, 2^32)` を重なりなく覆う。最初に範囲表を引いたときに書く)。epoch 1 から後は、表定義の版 1 つ (`{ kind: "commit", ddl }`。`ddl` は `DdlEntry` の JSON で、取り消し、index の作成と公開、書き込み禁止を含む)、範囲表の切り替え (`{ kind: "move-start", from, to, start, end }`。移す token の区間と、渡す側と受け取る側のシャード)、分割の枠を返したこと (`{ kind: "move-end", of }`。`of` はその移動の `move-start` の epoch) のどれかである。表定義、範囲表、開いている遷移と移動は、列を先頭から畳んで作る。範囲表の版は、最初の範囲表の版に `move-start` の数を足したもの、表定義の版は `DdlEntry.version` である。`prepare` と `abort` と、`of` のある `commit` は、段 3 から書く | 固定 |
| `__seq(name, next)` | 採番 | 固定 |
| `__meta(k, v)` | `format`、`shadow` (Meta の SQLite に表定義の文を写し終えた epoch)、`splits` (保守の操作の枠の JSON。分割が移す範囲は token の区間 `start`、`end`)、`build_lease` (index の作成の期限の JSON)、`baton_secret` | 固定 |
| `__slow(...)` | 遅い文の記録 | 作り直せる |

## Autoscaler (`DinfAutoscaler`)

`events` (判断の記録) と `conf` (閾値) は、作り直せる。

## 通信

| 形式 | 中身 | 区分 |
|---|---|---|
| Worker と Durable Object の RPC | 要求と応答の object (`ShardApi`、`src/types.ts`)。要求は版を運ぶ。版 3 から、範囲は token の区間で、読む範囲は `claim` (区間の組) を、範囲の移動は piece (`Piece`、`PieceWant`、`PiecePayload`) を運ぶ。版 4 から、行イメージ (`Change` の `before` と `after`、`PiecePayload` の `rows`、取引が溜める変更) はタプルである。版 5 から、値は `bigint` を含む `Value` (structured clone が運ぶ) で、読みの要求は結果の列名 (`ExecReq.columns`) を運ぶ。シャードは読みを型つきの読みに包み (`src/value.ts` の `typedReadSql`)、型のある値を返す。利用者の RETURNING は Worker が要素の式に書き換えて送る | 版で守る (`PROTOCOL_VERSION` = 5。版 4 以前は受け付けない) |
| Hrana の baton | 開いている取引の書き出し (`Db.dump`) を JSON にして署名したもの | 作り直せる。読めない baton は `BATON_INVALID` で断り、クライアントは取引をやり直す |
| 読みの session token | `Ts` の数 | 固定 |
| エクスポートの file | 1 行目が形式の版の注釈 `-- cf-d-infinity export format 1` で、続く注釈の行の後に、表定義の文 (利用者が実行した文面) と、1 行に 1 文の `INSERT INTO "表"("列", ...) VALUES (...), ...;` が並ぶ。値は SQLite がその literal を読むと同じ型の同じ値になる形で書く (`bin/dump.js` の `literal`)。INTEGER は 10 進の数字 (64 ビットの端まで)、REAL は小数点か指数を付けた表記 (無限大は `9.0e+999`)、TEXT は `'...'` で、改行 (`\n`、`\r`) と NUL は `' \|\| char(n) \|\| '` の連結、BLOB は `X'大文字の 16 進'`、NULL は `NULL`。取り込み (`npx cf-d-infinity import`) は、何かを実行する前に版の行を確かめ、版の行がない file と、ほかの版の file を断る (最初の公開の前は後方互換を持たない) | 固定 (利用者の形式。版は `bin/dump.js` の `EXPORT_FORMAT`) |
| エクスポートの頁と取り込みの行 (CLI と Worker のあいだの JSON) | `DinfDatabase.exportRows(表, 続きの位置, 行数)` は `{ format, columns, rows, cursor }` を返す。`rows` は表定義の列の順の要素のタプル (`src/value.ts`。上の「行イメージと変更」と同じ要素) で、`cursor.after` も主キーの値のタプルである。要素は文字列か `null` なので、JSON を通しても 64 ビットの整数、無限大、整数の値の REAL と INTEGER の区別、NUL を含む TEXT を失わない。`importRows(表, 列, 行, format)` は同じタプルを受け、`format` が違うか、要素でない値 (JS の数、印の object、印のない文字列) を含む行があれば、何も書かずに断る | 版で守る (`format` = `EXPORT_FORMAT` = 1。`src/transfer.ts` と `bin/dump.js` が同じ値を持ち、`test/export-import.test.ts` が確かめる) |
| 分析の行 (`src/analytics.ts` の `collect`) | 変更ログの行ごとに `{ commit_ts, table, pk, deleted, row }`。`row` は列名から要素への object で、消した行は `null`、表が消えていれば列名のないタプルである | 作り直せる (配備した Worker からはまだ呼ばれない) |

利用者に見える入口 (Hrana v2 と v3、D1 互換の API、Service Binding、HTTP の `/sql`、`/batch`、`/ddl`、管理の入口、CLI) の互換は、この文書ではなく、[sql-language.md](./sql-language.md) と README が約束する。
