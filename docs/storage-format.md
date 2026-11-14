# 保存と通信の形式

状態：Early 版で固める形式の一覧 (2026-11-12)

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
| 行の置き場所 | `slotOf(sk)`: キー文字列の FNV-1a と murmur3 の finalizer の 32 ビットの hash を、4096 個の slot に割る (`src/routing.ts`) | 固定 |
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
| `__fenced`、`__incoming`、`__moved`、`__moved_txn`、`__arrived` | 範囲の移動の途中の状態 | 固定 |
| `__cap`、`__cap_on`、`__capv_<表>`、trigger `__cap_<表>_I/U/D` | 1 つの文の変更を捕まえる表。文の外では空である | 作り直せる (表定義の版を適用するときに作る) |

## Meta (`DinfMeta`)

| 表 | 中身 | 区分 |
|---|---|---|
| `__ddl(version, entry)` | 表定義の版の履歴 (`DdlEntry` の JSON。取り消し、index の作成と公開、書き込み禁止を含む) | 固定 |
| `__routing(version, body)` | 範囲表 (`Routing` の JSON。slot の範囲からシャードの名前 `<cluster>-<番号>` へ) | 固定 |
| `__seq(name, next)` | 採番 | 固定 |
| `__meta(k, v)` | `format`、`shadow`、`splits` (保守の操作の枠の JSON)、`build_lease` (index の作成の期限の JSON) | 固定 |
| `__slow(...)` | 遅い文の記録 | 作り直せる |

## Autoscaler (`DinfAutoscaler`)

`events` (判断の記録) と `conf` (閾値) は、作り直せる。

## 通信

| 形式 | 中身 | 区分 |
|---|---|---|
| Worker と Durable Object の RPC | 要求と応答の object (`ShardApi`、`src/types.ts`)。要求は版を運ぶ | 版で守る (`PROTOCOL_VERSION` = 1) |
| Hrana の baton | 開いている取引の書き出し (`Db.dump`) を JSON にして署名したもの | 作り直せる。読めない baton は `BATON_INVALID` で断り、クライアントは取引をやり直す |
| 読みの session token | `Ts` の数 | 固定 |
| エクスポート | 1 行に 1 文の `INSERT INTO "表"("列", ...) VALUES (...), ...;`。REAL は小数点か指数を付けて書く。BLOB は `X'...'`、無限大は `9e999` | 固定 (利用者の形式) |

利用者に見える入口 (Hrana v2 と v3、D1 互換の API、Service Binding、HTTP の `/sql`、`/batch`、`/ddl`、管理の入口、CLI) の互換は、この文書ではなく、[sql-language.md](./sql-language.md) と README が約束する。
