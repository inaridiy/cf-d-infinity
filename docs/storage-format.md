# 保存と通信の形式

状態：Early 版で固める形式の一覧 (2026-11-12)。2026-11-14 に、行の置き場所を token の区間にした ([design-subslots.md](./design-subslots.md))

D∞ は、利用者のデータを Durable Object の SQLite に置き、Worker と Durable Object のあいだを RPC でつなぐ。
公開した後に新しい版を置くと、古い版が書いたデータを新しい版が開き、古い版と新しい版の Worker と Durable Object がしばらく混ざって動く。
この文書は、そのとき食い違ってはいけない形式を並べ、どれを固めるか、どれを作り直せるかを決める。

形式は 3 つに分ける。

- **固定**：Early 版から変えない。変えるときは、保存の形式の版 (`STORAGE_FORMAT`、`src/types.ts`) を上げ、1 つ前の版から進める移行を `STORAGE_MIGRATIONS` に足し、更新の試験 (`test/upgrade.test.ts`) に古い版のデータを残す (`test/fixtures/storage/format-<版>.json`。公開した版の材料は書き換えない。最初の公開の前は、版 1 の形式も変えてよく、材料を作り直す)。DO は起動するときに、古い版のデータへ移行を順に流す。古い版のコードは、新しい版のデータを開くと起動を拒否する (`checkStorageFormat`)。
- **版で守る**：互換でない変更は、通信の版 (`PROTOCOL_VERSION`、`MIN_PROTOCOL_VERSION`) を上げて行う。シャードは受け付ける範囲の版だけを処理する。
- **作り直せる**：失っても、作り直すか、利用者がやり直せば済む。版を上げずに変えてよい。

## 値とキー

| 形式 | 中身 | 区分 |
|---|---|---|
| 値の型 | 整数の JS の数は INTEGER、整数でない数は REAL、整数の値の REAL は `{ "real": 数 }` (`src/value.ts`) | 固定 |
| キー文字列 | 主キーと shard key の値の並びを JSON にしたもの (`src/keys.ts` の `keyString`)。INTEGER の 5 と REAL の 5.0 は同じ `5`。BLOB は `{"$b":"小文字の 16 進"}`、無限大は `{"$f":"Infinity"}`。値は列の型の親和性で揃えてから作る (`storedAs`) | 固定 |
| 行の置き場所 (token) | `token = region × 2^32 + slot × 2^16 + subslot` の 40 ビットの整数 (`src/routing.ts`)。region はいまは 0 で、行ごとに置く地域を決める拡張のために 8 ビットを空けてある。slot は、shard key のキー文字列の hash (FNV-1a と murmur3 の finalizer、32 ビット) の上位 16 ビット。subslot は、主キーのキー文字列の同じ hash の下位 16 ビット。表の名前は混ぜない。行ごとに保存するものはない。同じ shard key の行は、連続した 65,536 個の token (その slot のブロック) に載る | 固定 |
| 範囲 | token の半開区間 `[start, end)`。範囲表、読む範囲の claim、範囲の移動の要求、分割の枠が、この形で範囲を運ぶ | 固定 |
| 位置 (`Pos`) | グループの中の行の位置。`[表の名前, 主キーのキー文字列]` で、表の名前の順、表の中は主キーの順に並ぶ。端は `null`。表の列には、JSON の文字列で書く (端は `null` の 4 文字) | 固定 |
| 時刻 (`Ts`) | 物理の ms × 1024 + 論理のカウンタ (`src/hlc.ts`)。2^53 に収まる | 固定 |
| 行イメージと変更 (`Change`) | `{ table, pk, sk, before, after }`。行は列名から値への object を JSON にしたもの (`src/shard/rows.ts` の `encode`)。BLOB と無限大は上と同じ印、整数の値の REAL は `{ "real": 数 }` | 固定 |

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
| `__cap`、`__cap_on`、`__capv_<表>`、trigger `__cap_<表>_I/U/D` | 1 つの文の変更を捕まえる表。文の外では空である | 作り直せる (表定義の版を適用するときに作る) |

移動の単位は piece で、グループ `g` の行のうち、token が fence の区間に入り、位置が区間 `(after, up_to]` に入るものである。
いまのコードは、形式だけを持つ (設計書の段 1)。
作る範囲はどれも両端が slot の境目 (65,536 の倍数) にあり、piece はどれもグループの全体 (`after` も `up_to` も `null`) である。
受け取り終えた `__incoming` の行は、範囲の床である。シャードは、起動のときに読み戻し、その範囲のキーを `m` より前の時刻で読む要求を断る
(`src/shard/kernel.ts` の `assertOwned`)。受け取った範囲の外の要求を断る確かめには、まだ使っていない。

## Meta (`DinfMeta`)

| 表 | 中身 | 区分 |
|---|---|---|
| `__ddl(version, entry)` | 表定義の版の履歴 (`DdlEntry` の JSON。取り消し、index の作成と公開、書き込み禁止を含む) | 固定 |
| `__routing(version, body)` | 範囲表 (`Routing` の JSON。token の区間からシャードの名前 `<cluster>-<番号>` へ)。項目は `{ start, end, shard }` で、全部の項目が region 0 の token `[0, 2^32)` を重なりなく覆う | 固定 |
| `__seq(name, next)` | 採番 | 固定 |
| `__meta(k, v)` | `format`、`shadow`、`splits` (保守の操作の枠の JSON。分割が移す範囲は token の区間 `start`、`end`)、`build_lease` (index の作成の期限の JSON) | 固定 |
| `__slow(...)` | 遅い文の記録 | 作り直せる |

## Autoscaler (`DinfAutoscaler`)

`events` (判断の記録) と `conf` (閾値) は、作り直せる。

## 通信

| 形式 | 中身 | 区分 |
|---|---|---|
| Worker と Durable Object の RPC | 要求と応答の object (`ShardApi`、`src/types.ts`)。要求は版を運ぶ。版 3 から、範囲は token の区間で、読む範囲は `claim` (区間の組) を、範囲の移動は piece (`Piece`、`PieceWant`、`PiecePayload`) を運ぶ | 版で守る (`PROTOCOL_VERSION` = 3。版 2 以前は受け付けない) |
| Hrana の baton | 開いている取引の書き出し (`Db.dump`) を JSON にして署名したもの | 作り直せる。読めない baton は `BATON_INVALID` で断り、クライアントは取引をやり直す |
| 読みの session token | `Ts` の数 | 固定 |
| エクスポート | 1 行に 1 文の `INSERT INTO "表"("列", ...) VALUES (...), ...;`。REAL は小数点か指数を付けて書く。BLOB は `X'...'`、無限大は `9e999` | 固定 (利用者の形式) |

利用者に見える入口 (Hrana v2 と v3、D1 互換の API、Service Binding、HTTP の `/sql`、`/batch`、`/ddl`、管理の入口、CLI) の互換は、この文書ではなく、[sql-language.md](./sql-language.md) と README が約束する。
