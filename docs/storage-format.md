# 保存と通信の形式

状態：Early 版で固める形式の一覧 (2026-11-12)。2026-11-14 に、行の置き場所を token の区間にした ([design-subslots.md](./design-subslots.md))。同じ日に、行イメージをタプルにし、キー文字列の数の書き方を決めた ([design-values.md](./design-values.md) の段 2。保存の形式の版 2、通信の版 4)。値の JS の型を格納の型にし、シャードの結果を型つきで読むようにした (同じ設計書の段 3。通信の版 5。保存の形式は変わらない)。2026-11-15 に、エクスポートの行を要素のタプルにし、形式の版を file と CLI とのあいだの JSON に持たせた (同じ設計書の段 4。エクスポートの形式の版 1)。2026-11-15 に、Meta の表定義の版と範囲表を、epoch の列 1 本にした ([design-catalog-epoch.md](./design-catalog-epoch.md) の段 1。保存の形式の版 3。シャードの形式は変わらない)。同じ日に、シャードの `__ddl` を Meta の列の写し `__epoch` にし、要求が epoch と表定義の epoch を運ぶようにした (同じ設計書の段 2。保存の形式の版 4、通信の版 6)。2026-11-16 に、表定義の変更を 2 相 (`prepare`、`commit`、`abort`) にした (同じ設計書の段 3。保存の形式の版 5、通信の版 8)。同じ日に、範囲の移動を Meta の列の `move-start` と `move-end` で進め、シャードの移動の記録を移動ごとにした (同じ設計書の段 4。保存の形式の版 6、通信の版 9)。2026-11-17 に、表定義の epoch を表と view ごとに持ち、commit の記録でだけ進める形にし、行ロックの寿命を取引のものにした (同じ設計書の「表ごとの epoch」と [design-lock-lease.md](./design-lock-lease.md)。保存の形式の版 7、通信の版 10)

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
| 範囲 | token の半開区間 `[start, end)`。範囲表、読む範囲の claim、範囲の移動の要求と記録が、この形で範囲を運ぶ | 固定 |
| 位置 (`Pos`) | グループの中の行の位置。`[表の名前, 主キーのキー文字列]` で、表の名前の順、表の中は主キーの順に並ぶ。端は `null`。表の列には、JSON の文字列で書く (端は `null` の 4 文字) | 固定 |
| 時刻 (`Ts`) | 物理の ms × 1024 + 論理のカウンタ (`src/hlc.ts`)。2^53 に収まる | 固定 |
| 行イメージと変更 (`Change`) | `{ table, pk, sk, before, after }`。行は、表定義の列の順に並べた要素の配列 (タプル。`src/value.ts`)。PRIMARY KEY のない表は先頭に rowid を置く。列名は持たない。要素は、INTEGER が `"i"` と 10 進の数字、TEXT が `"t"` と文字列、REAL が `"r"` と `quote()` の文字列、BLOB が `"b"` と大文字の 16 進、NULL が `null`。変更の並びは JSON にする (`src/shard/rows.ts` の `encode`) | 固定 |

## シャード (`DinfShard`)

| 表 | 中身 | 区分 |
|---|---|---|
| 利用者の表 | 利用者が書いた表定義 | 固定 (利用者の形式) |
| `__gidx_<index>(k, pk, sk)` | シャードをまたぐ UNIQUE の index。`k` は値のキー文字列 | 固定。中身は index を作り直せば戻るが、作り直す手順は Early 版にない |
| `__meta(k, v)` | `format` (保存の形式の版)、`epoch`、`ceiling`、`flushed`、`log_low_water`、`ddl_floors` (表ごとの、表定義の変更の床。`[小文字の表の名前, 時刻]` の組の JSON の配列。時刻は、表の形を変える commit を適用したときに、変更ログにあった、その表の確定の時刻の最大である。保存の形式の版 7 から。版 6 までは、シャードに 1 つの `ddl_floor`)、`log_gens` (変更ログの世代の JSON の配列) | 固定 |
| `__epoch(epoch, rec)` | Meta の epoch の列 (Meta の `__epoch`) のうち、このシャードが適用した分の写し。epoch 0 (最初の範囲表) から隙間なく続き、行は Meta の行と同じ記録の JSON である。シャードは、表定義と、所有を引く範囲表を、これを畳んで作る (`src/catalog.ts` の `fold`)。表定義の記録は、その記録の文と同じ取引で足す (`prepare` は index の表 (staging) を作り、`commit` は prepare の文を実行し、`abort` は staging の表を名前で消す)。範囲の記録 (`move-start`、`move-end`) は、新しい epoch の要求が、自分のスナップショットでは自分のものでない行に触ったときと、移動の要求 (子の listGroups、pull、finishMove、進める側の drain) が運ぶ epoch まで進むときに足す。`move-start` は、自分が渡す側なら `__fenced` に、受け取る側なら `__incoming` に、同じ取引で行を足す | 固定 |
| `__log_g<世代>(commit_ts, txn, blob)` | 確定した取引の変更ログ。`blob` は `Change[]` の JSON。世代は物理時刻で分ける | 固定 |
| `__intents(tbl, pk, sk, txn, anchor, prepare_ts, change)` | 2 相の確定の途中の書き込み。`change` は `Change` の JSON | 固定 |
| `__txn(txn, status, c, participants, done, at)` | anchor が持つ取引の決着 | 固定 |
| `__fenced(lo, hi, to, done, epoch)` | 送り出した範囲 (fence)。token の区間 `[lo, hi)` である。`epoch` (主キー) は、その移動の `move-start` の epoch で、このシャードがその記録を適用したときに書く。渡し終えると `done` = 1 にし、消さない。所有はこの記録ではなく、`__epoch` を畳んだ範囲表で引く | 固定 |
| `__incoming(lo, hi, from_id, done, m, epoch)` | 受け取った範囲。`epoch` (主キー) は、その移動の `move-start` の epoch。受け取り終えても消さず、`done` = 1 と、渡した側から受け取った時刻 `m` を残す。記録は受け取りごとにあり、同じ区間を 2 度受け取れば 2 行になる。受け取り終えた行は書き換えない | 固定 |
| `__moved(g, lo, hi, after, up_to, m, dest, acked, epoch)` | 渡した piece。主キーは `(g, epoch, after)`。`g` は shard key のキー文字列、`[lo, hi)` は fence の区間、`(after, up_to]` は位置の区間、`m` は手放した時刻、`epoch` は渡した移動の `move-start` の epoch である | 固定 |
| `__moved_txn(txn, g, lo, after, dest, epoch)` | 渡した piece に intent を持っていた取引。決着を渡した先へ転送するのに使う。転送するのは、いまも渡したままの移動 (`epoch`) の行だけである | 固定 |
| `__arrived(g, lo, hi, after, up_to, m, epoch)` | 受け取った piece と、渡した側が手放した時刻。主キーは `(g, epoch, after)` で、同じグループを 2 度受け取れば 2 行になる | 固定 |
| `__cap(seq, tbl, old, new)`、`__cap_on`、trigger `__cap_<表>_I/U/D` | 1 つの文の変更を捕まえる表。trigger が、変更前と変更後の行のタプルを JSON で書く。文の外では空である | 作り直せる (trigger は表定義の commit を適用するときに作る。Meta の `__epoch` の `prepare` の記録が運ぶ文は、その trigger の文を含む) |

移動の単位は piece で、グループ `g` の行のうち、token が fence の区間に入り、位置が区間 `(after, up_to]` に入るものである。
いまのコードは、形式だけを持つ (設計書の段 1)。
作る範囲はどれも両端が slot の境目 (65,536 の倍数) にあり (Meta の `startMove` が、そうでない範囲を記録の前に断る)、piece はどれもグループの全体 (`after` も `up_to` も `null`) である。
範囲が前の持ち主へ戻ると、同じシャードが同じ区間とグループを何度も渡し、受け取るので、移動の記録はどれも、その移動の `move-start` の epoch で分ける (保存の形式の版 6)。
受け取り終えた `__incoming` の行は、範囲の床である。シャードは、起動のときに読み戻し、その範囲のキーを `m` より前の時刻で読む要求を断る
(`src/shard/kernel.ts` の `assertOwned`)。受け取った範囲の外の要求を断る確かめには、まだ使っていない。

## Meta (`DinfMeta`)

| 表 | 中身 | 区分 |
|---|---|---|
| `__epoch(epoch, rec)` | epoch の列 (`src/catalog.ts`)。追記だけで、1 行が 1 つの epoch である。`rec` は `EpochRecord` の JSON。epoch 0 は最初の範囲表 (`{ kind: "genesis", routing }`。`Routing` の JSON で、項目は `{ start, end, shard }`。全部の項目が region 0 の token `[0, 2^32)` を重なりなく覆う。最初に範囲表を引いたときに書く)。epoch 1 から後は、表定義の遷移の始まり (`{ kind: "prepare", mode, ddl, fence, staging?, waitUntil? }`。`mode` は `plain`、`trial`、`build`、`guard`、`ddl` は `ParsedDdl` の JSON で、commit を適用するときに実行する文と表定義と、その DDL が確定で変えるもの (`changes`。読みの epoch が進む表、書き込みの epoch だけが進む表、view。保存の形式の版 7 から)、`fence` は書き込みを止める表の名前、`staging` は prepare を適用するときに作る内部の表 (index の表) の文と表定義、`waitUntil` は DDL の待ちの期限 (進める側の時計の時刻。シャードは、fence の表に行ロックがある間、その時刻まで prepare の適用を待つ))、その確定 (`{ kind: "commit", of, at? }`。`of` は prepare の epoch、`at` は index を公開する commit が運ぶ時刻)、その取り消し (`{ kind: "abort", of, reason, wound? }`。`wound` は、fence の表の行ロックを持つ取引が取り消させた印)、範囲の移動の始まり (`{ kind: "move-start", from, to, start, end }`。移す token の区間と、渡す側と受け取る側のシャード。範囲表の切り替えであり、渡す側の fence であり、受け取る側の受け取りの始まりである)、その終わり (`{ kind: "move-end", of }`。`of` はその移動の `move-start` の epoch。受け取る側が、受け取り終えた後で記録させる) のどれかである。表定義、範囲表、開いている遷移と移動は、列を先頭から畳んで作る。範囲表の版は、最初の範囲表の版に `move-start` の数を足したもの、表定義の epoch は、表と view ごとに、それを変えた最後の `commit` の epoch である (表は、読みの epoch と書き込みの epoch を持つ。保存の形式の版 7 から。版 6 までは、表定義全体で 1 つで、最後の表定義の記録 (`prepare`、`commit`、`abort`) の epoch だった) | 固定 |
| `__seq(name, next)` | 採番 | 固定 |
| `__meta(k, v)` | `format`、`shadow` (Meta の SQLite に表定義の文を写し終えた epoch)、`lease` (開いている表定義の遷移の期限の JSON の配列。項目は `{ epoch, started, until }`)、`baton_secret`。分割の枠 (`splits`) は、保存の形式の版 6 でなくなった | 固定 |
| `__slow(...)` | 遅い文の記録 | 作り直せる |

## Autoscaler (`DinfAutoscaler`)

`events` (判断の記録) と `conf` (閾値) は、作り直せる。

## 通信

| 形式 | 中身 | 区分 |
|---|---|---|
| Worker と Durable Object の RPC | 要求と応答の object (`ShardApi`、`src/types.ts`)。要求は版を運ぶ。版 3 から、範囲は token の区間で、読む範囲は `claim` (区間の組) を、範囲の移動は piece (`Piece`、`PieceWant`、`PiecePayload`) を運ぶ。版 4 から、行イメージ (`Change` の `before` と `after`、`PiecePayload` の `rows`、取引が溜める変更) はタプルである。版 5 から、値は `bigint` を含む `Value` (structured clone が運ぶ) で、読みの要求は結果の列名 (`ExecReq.columns`) を運ぶ。シャードは読みを型つきの読みに包み (`src/value.ts` の `typedReadSql`)、型のある値を返す。利用者の RETURNING は Worker が要素の式に書き換えて送る 版 6 から、要求 (`ExecReq`、`PrepareReq`、`CommitReq`) は、Worker のスナップショットの epoch (`epoch`) と、表定義が最後に変わった epoch (`schema`) を運ぶ。`schema` の数は表定義の版の数ではなく epoch である。`syncSchema` は `{ schema }` を受ける。版 7 から、書き込みの応答は文が入れた行 (`ExecRes.inserted`) を運ぶ。版 8 から、シャードは表定義の遷移の `prepare` を適用したかを答える (`prepared({ epoch })`、答えは `{ ok, reason? }`)。版 9 から、`beginIncoming` と `fence` はなく、子から親への移動の要求 (`listGroups`、`pull`、`finishMove`) は移動の `move-start` の `epoch` を運び、進める側の `drain` は `{ start, end, epoch }` を受けて、子が移動を終えるまで進める。`Piece` と `PiecePayload` は移動の `epoch` を運ぶ。`syncSchema` は `{ schema, epoch? }` を受ける。版 10 から、要求 (`ExecReq`、`PrepareReq`、`CommitReq` の参加者) は、`schema` の代わりに、頼る表と view ごとの epoch (`deps`。`{ name, epoch, write? }` の配列) を運び、表定義の遷移の仕事の要求 (index の作成の行の走査、`unchanged`) は prepare の epoch を `atLeast` で運ぶ。`syncSchema` は `{ atLeast }` を受ける。悲観の取引の要求は、取引の lease (`{ epoch, ms }`。版と残り) を、ロックを取る要求では `lock` の中に (取引が行ロックを持つ表 `holds` と一緒に)、ほかの要求では `lease` に運ぶ。新しい入口 `renew({ txn, lease })` が、取引の lease を延ばす。`refresh` も `deps` を運ぶ | 版で守る (`PROTOCOL_VERSION` = 10。版 9 以前は受け付けない) |
| Hrana の baton | 開いている取引の書き出し (`Db.dump`) を JSON にして署名したもの | 作り直せる。読めない baton は `BATON_INVALID` で断り、クライアントは取引をやり直す |
| 読みの session token | `Ts` の数 | 固定 |
| エクスポートの file | 1 行目が形式の版の注釈 `-- cf-d-infinity export format 1` で、続く注釈の行の後に、表定義の文 (利用者が実行した文面) と、1 行に 1 文の `INSERT INTO "表"("列", ...) VALUES (...), ...;` が並ぶ。値は SQLite がその literal を読むと同じ型の同じ値になる形で書く (`bin/dump.js` の `literal`)。INTEGER は 10 進の数字 (64 ビットの端まで)、REAL は小数点か指数を付けた表記 (無限大は `9.0e+999`)、TEXT は `'...'` で、改行 (`\n`、`\r`) と NUL は `' \|\| char(n) \|\| '` の連結、BLOB は `X'大文字の 16 進'`、NULL は `NULL`。取り込み (`npx cf-d-infinity import`) は、何かを実行する前に版の行を確かめ、版の行がない file と、ほかの版の file を断る (最初の公開の前は後方互換を持たない) | 固定 (利用者の形式。版は `bin/dump.js` の `EXPORT_FORMAT`) |
| エクスポートの頁と取り込みの行 (CLI と Worker のあいだの JSON) | `DinfDatabase.exportRows(表, 続きの位置, 行数)` は `{ format, columns, rows, cursor }` を返す。`rows` は表定義の列の順の要素のタプル (`src/value.ts`。上の「行イメージと変更」と同じ要素) で、`cursor.after` も主キーの値のタプルである。要素は文字列か `null` なので、JSON を通しても 64 ビットの整数、無限大、整数の値の REAL と INTEGER の区別、NUL を含む TEXT を失わない。`importRows(表, 列, 行, format)` は同じタプルを受け、`format` が違うか、要素でない値 (JS の数、印の object、印のない文字列) を含む行があれば、何も書かずに断る | 版で守る (`format` = `EXPORT_FORMAT` = 1。`src/transfer.ts` と `bin/dump.js` が同じ値を持ち、`test/export-import.test.ts` が確かめる) |
| 分析の行 (`src/analytics.ts` の `collect`) | 変更ログの行ごとに `{ commit_ts, table, pk, deleted, row }`。`row` は列名から要素への object で、消した行は `null`、表が消えていれば列名のないタプルである | 作り直せる (配備した Worker からはまだ呼ばれない) |

利用者に見える入口 (Hrana v2 と v3、D1 互換の API、Service Binding、HTTP の `/sql`、`/batch`、`/ddl`、管理の入口、CLI) の互換は、この文書ではなく、[sql-language.md](./sql-language.md) と README が約束する。
