# 実装メモ

npm パッケージ `cf-d-infinity` の実装と、その開発手順の覚え書きである。
利用者向けの説明は [README.md](./README.md) とリポジトリの [README.md](../../README.md) にある。

Cloudflare Workers と Durable Objects の上で動く、SQLite 互換の分散 DB である。
Worker からは Service Binding (`DinfDatabase`) と `connect()` で使い、外からは既存の `@libsql/client` の接続先を変えるだけで使える。

```ts
import { createClient } from "@libsql/client";

const db = createClient({ url: "https://<worker>.workers.dev", authToken: "<DINF_API_TOKEN>" });
await db.execute("CREATE TABLE users(id INTEGER PRIMARY KEY, name TEXT)");
await db.execute({ sql: "INSERT INTO users(name) VALUES (?)", args: ["alice"] });
```

シャードの本体 `src/shard/core.ts` は DO に依存しないので、同じコードが node:sqlite (`test/sim.ts`) と workerd (`src/worker.ts`) の両方で動く。
SQLite との差分は [docs/sql-language.md](../../docs/sql-language.md) にある。

## 動かす

```sh
npm install
npm test                      # 全テスト。workerd の結合テストと @libsql/client の確認を含む
npm run typecheck
test/slt/fetch.sh             # sqllogictest の select1〜5 を取得する
SLT_LIMIT=1000000 npx vitest run test/slt.test.ts     # 全件を流す
FUZZ_SEEDS=200 FUZZ_LENGTH=150 npx vitest run test/fuzz.test.ts
```

デプロイの前に、2 つのトークンを secret として登録する。

```sh
npx wrangler secret put DINF_API_TOKEN     # データの読み書き
npx wrangler secret put DINF_ADMIN_TOKEN   # 運用の操作 (/admin)
npx wrangler deploy
```

トークンが未設定の経路は全要求を拒否する。
`DINF_BATON_SECRET` を設定すると Hrana の baton の署名鍵になる。未設定なら `DINF_API_TOKEN` から導く。

| パス | トークン | 本文 | 内容 |
|---|---|---|---|
| `POST /v3/pipeline` | API | Hrana over HTTP | `@libsql/client` の `https://` の入口 |
| WebSocket の upgrade | API (hello の jwt) | Hrana over WebSocket (hrana2) | `@libsql/client` の `wss://` の入口 |
| `POST /ddl` | API | `{ sql }` | DDL を実行する |
| `POST /sql` | API | `{ sql, params, token }` | 1 文を autocommit で実行する |
| `POST /batch` | API | `{ statements, token }` | 全文を 1 取引で実行する |
| `POST /admin/split` | ADMIN | `{ cluster, parent, child }` | 手動で増設する |
| `POST /admin/status` | ADMIN | `{ cluster }` | 範囲表と Autoscaler の履歴を返す |
| `POST /admin/slow` | ADMIN | `{ cluster, limit }` | 遅い文の記録を新しい順に返す |
| `POST /admin/rowstats` | ADMIN | `{ cluster }` | 文の種類ごとの課金行数を返し、0 に戻す |

### 自動増設

自動増設は `wrangler.jsonc` の Cron Trigger で動く。
起動と停止のための HTTP の入口はない。

```jsonc
"vars": { "DINF_SHARD_COUNT": "8" },
"triggers": { "crons": ["* * * * *"] }
```

Cron が毎分 Autoscaler DO を起こし、Autoscaler は全シャードの metrics を 1 回集めて判断する。
閾値を超えたシャード、移動中のシャード、未完了の増設のどれかがある間だけ、`DINF_AUTOSCALE_TICK_MS` (既定 5000) の alarm で判断を続ける。
どれもなくなれば alarm をやめ、次の Cron まで待つ。
負荷が始まってから最初の検出までは最大で約 1 分かかり、その後は 5 秒ごとに追う。

| 変数 | 既定 | 内容 |
|---|---|---|
| `DINF_SHARD_COUNT` | 8 | 最初のシャード数 |
| `DINF_AUTOSCALE` | なし | `split` なら閾値を超えたシャードを実際に割る。未指定なら `would-split` を記録するだけ。増設は取り消せないので既定は記録だけにしている |
| `DINF_AUTOSCALE_TICK_MS` | 5000 | 負荷が続いている間の判断の周期 (ms) |
| `DINF_AUTOSCALE_THRESHOLDS` | なし | 閾値の上書き (JSON)。項目は `src/autoscaler.ts` の `Thresholds` |
| `DINF_SLOW_QUERY_MS` | 500 | これより遅い文を DinfMeta に記録する。`0` は全部、`off` は記録しない |

`triggers` の行を消してデプロイすると止まる。
ローカルの `wrangler dev` は Cron を自動では発火しない。
確かめるときは `wrangler dev --test-scheduled` で起動し、`curl "http://localhost:8787/__scheduled?cron=*+*+*+*+*"` を呼ぶ。

全シャードへの問い合わせは DO を起こすので、Duration の課金がかかる。
常に 5 秒周期で回すと待機中のシャードも起きたままになるため、平常時は毎分 1 回に抑えている。

### コマンドと遅い文の記録

`bin/cli.js` (`npx cf-d-infinity`) は `sql`、`slow`、`status` を持つ。
HTTP の入口とトークンは使わない。
使い捨ての Worker を miniflare で立て、動いている dev サーバの `DinfDatabase` へ Service Binding を張って呼ぶ。

dev サーバの探し方は、Wrangler と cf で違う。
Wrangler は `~/.config/.wrangler/registry` に、cf (Cloudflare Vite plugin 2.0) は `~/.config/cloudflare/dev-registry/v5` に、Worker の名前のファイルを置く。
コマンドは両方を探し、見つかった側のツールが使っている miniflare を利用者のプロジェクトから読み込む。
cf の miniflare は 5 系で設定の形が違うので、`convertV4MiniflareOptions` があればそれを通す。
この仕組みは `unsafeDevRegistryPath` という非公開の設定と registry の配置に依存しており、ツールの更新で壊れ得る。

`--remote` はデプロイ済みの Worker を相手にする。
使い捨ての Worker を利用者のプロジェクトの `wrangler dev` で手元に立て、Service Binding に `"remote": true` を付ける。
何もデプロイせず、公開の URL も作らない。認証は Wrangler のログインに任せる。
名前付きの入口 (`DinfDatabase`) への RPC が remote binding を通ることは、本番で確かめた (2026-11-10、wrangler 4.158.0)。
1 回の実行に約 8 秒かかる。cf だけのプロジェクトでは Wrangler も入れる必要がある。

遅い文は `Db` の `onStatement` で測り、`DINF_SLOW_QUERY_MS` を超えたものを DinfMeta の `__slow` に書く。
記録は応答を待たせない (`waitUntil`)。bound parameter は記録しない。
直近 1,000 件だけ残し、isolate ごとに 10 秒あたり 20 件で打ち切る。

sql.js は `process.versions.node` があると Node で動いているとみなし、`__dirname` と `fs` を使おうとする。
`nodejs_compat` を有効にした Worker には `process` があるので、束ねる時点でこの判定を偽にしている (`scripts/esbuild-options.mjs` の `define`)。
これがないと、`nodejs_compat` を使う利用者と cf のプロジェクトで `__dirname is not defined` になる。

### 上限、健全性、保存形式の版

結果の大きさはシャードが送り返す前に断つ (`SHARD_MAX_ROWS`、`SHARD_MAX_BYTES`、要求の `maxRows` と `maxBytes`)。
1 つの取引が 1 シャードに書ける変更は 1 MB までで、確定の前にクライアントとシャードの両方が検査する (`MAX_WRITE_SET_BYTES`)。
変更ログは 1 commit を 1 行に入れるので、これを超えると確定後の適用が DO の行の上限に当たり、取引が永久に適用できない。
移動できる 1 グループは 16 MB までである (`GROUP_MAX_BYTES`)。

`status` は各シャードの `health` を集め、`healthProblems` (`src/autoscaler.ts`) が運用者の見るべき問題を言葉にする。
確定したのに適用できない取引、30 秒を超えて決着を待つ intent、失敗を繰り返す再駆動、シャードごとに違う保存形式が対象である。

保存形式の版は `STORAGE_FORMAT` (`src/types.ts`) で、シャードと Meta の `__meta` の `format` に書く。
固める形式と作り直せる形式の一覧は [docs/storage-format.md](../../docs/storage-format.md) にある。
内部の表の形や意味を互換でない形で変えるときは、版を上げ、1 つ前の版から進める移行を `STORAGE_MIGRATIONS` に足し、古い版の材料を `test/fixtures/storage/` に残す。
材料は、決まった作業負荷を流した Meta と全シャードの SQLite を `quote()` で SQL に写したもので、`test/upgrade.test.ts` が今のコードでそこから起動して確かめる。公開した版の材料は書き換えない。最初の公開 (npm への本物のリリース) の前は、版 1 の形式も自由に変えてよく、変えたら `REWRITE_STORAGE_FIXTURE=1 WRITE_STORAGE_FIXTURE=1 npx vitest run test/upgrade.test.ts --project sim` で材料を作り直す。
DO は起動するときに、古い版のデータへ移行を順に流す。移行のない古い版と、新しすぎる版 (`storage format too new`) は、起動を拒否する。

`export` は利用者が実行した DDL (`schemaSql`) と、各表の行 (`exportRows`) を SQL にする。
行はシャードごとに主キーの順で読み、時点はそろえない。移動の途中のシャードがあれば断る。

シミュレータの試験は、終わりに `test/invariants.ts` の検査を通す。
intent が残っていないこと、確定した取引が全部適用済みであること、再駆動が失敗を繰り返していないこと、グローバル index が本体と一致することを見る。

### 公開する形

`npm run build` (`scripts/build.mjs`) が `lib/` を作る。`npm pack` と `npm publish` は `prepack` でこれを実行する。

| 入口 | ファイル | 内容 |
|---|---|---|
| `cf-d-infinity/cloudflare` | `lib/cloudflare.js` | DO のクラス、`DinfDatabase`、`autoscale`、HTTP と Cron の入口 |
| `cf-d-infinity/client` | `lib/client.js` | `connect()` だけ。DB のコードを含まない |

sql.js は `lib/cloudflare.js` に束ねる。
sql.js の Node 向けの分岐が `fs`、`path`、`crypto` を参照するので、束ねずに出すと利用者の `wrangler.jsonc` に `alias` が要るからである。
`src/sql-wasm.wasm` は sql.js 1.13.0 の `dist/sql-wasm.wasm` の写しで、ビルドが一致を検査する。
`sql-parser-cst` (GPL-2.0-or-later) は束ねず、依存として参照する。束ねると配布物そのものが GPL の結合著作物になる。

利用者の Worker に入る名前には、衝突を避けるために接頭辞を付けている。
binding と変数は `DINF_`、クラスは `Dinf` で始まる。
DO のクラス名はデプロイ後に変えると利用者の側で `renamed_classes` の移行が要るので、変えない。

公開は `alpha` の dist-tag で行う。
npm 11.12 の `npm publish --dry-run` は `publishConfig.tag` を無視して `latest` と表示したので、tag は必ず明示する。

```sh
npm publish --tag alpha          # packages/cf-d-infinity と packages/create-cf-d-infinity の両方で実行する
```

2 つのパッケージの版は揃える。CLI は自分と同じ版の `cf-d-infinity` を利用者の `package.json` に書くからである。
セットアップ用の CLI は [packages/create-cf-d-infinity](../create-cf-d-infinity/README.md) にある。

### 計測用の構成

ベンチマークと障害注入の経路は、本番の Worker に含めない。
`wrangler.bench.jsonc` (`src/bench.ts`) が本番の入口に `/bench` と DO のプローブを足した別の Worker である。

```sh
npx wrangler deploy -c wrangler.bench.jsonc --var DINF_API_TOKEN:<t> --var DINF_ADMIN_TOKEN:<a> --durable-objects-code-update-mode immediate
URL=https://... TOKEN=<t> ADMIN_TOKEN=<a> node bench/run.mjs <suite>
URL=https://... TOKEN=<t> ADMIN_TOKEN=<a> node bench/jepsen.mjs        # 本番での黒箱検査 (約 11 分)
```

計測用の構成は Cron Trigger を持たない。
`POST /admin/autoscale/start` (`{ cluster, shards, tickMs, thresholds }`) で負荷によらず一定の周期で判断させ、`POST /admin/autoscale/stop` で止める。
どちらも ADMIN のトークンが要る。

結果は [docs/benchmarks.md](../../docs/benchmarks.md) にある。

### 版を上げるデプロイ

Cloudflare は、デプロイ後も active な DO で旧コードを最大 300 秒動かす。
要求の形式を互換でない形に変えるときは、`src/types.ts` の `PROTOCOL_VERSION` を 2 段階で上げる。
1 段目で受け付ける版の上限を上げたコードを出し、全 DO が入れ替わってから、2 段目で送る版を上げる。
訓練には `DINF_PROTOCOL_ACCEPT` と `DINF_PROTOCOL_SEND` の変数を使う (`bench/jepsen.mjs` が実行中に行う)。

## 構成

| パス | 内容 |
|---|---|
| `src/shard/core.ts` | シャードのプロトコル (rollback-read、検証、anchor 2PC、回復、ライブ移動) |
| `src/shard/rows.ts` | 行の適用と set-based undo |
| `src/client/db.ts` | Worker 側の入口。OCC の取引、経路決定、scatter |
| `src/client/d1.ts` | D1 互換 API |
| `src/client/hrana.ts` | Hrana over HTTP と WebSocket、baton の署名 |
| `src/sql/plan.ts` | 文の実行場所の決定、条件の押し下げ |
| `src/sql/ddl.ts` | DDL の解釈、index の配置 |
| `src/sql/scratch.ts` | Worker の中の SQLite (sql.js) |
| `src/sql/cst.ts` | パーサのラッパー |
| `src/meta.ts` | 表定義、DDL 履歴、範囲表、index の作成と書き込み禁止の期限、保守の操作の枠 |
| `src/value.ts` | 値の格納の型 (INTEGER と REAL)。束縛の関数 `bindTyped` (DO、シミュレータ、Worker の SQLite の 3 つの Backend が通す) |
| `src/keys.ts` | キー文字列を作る関数 (`keyString` と、trigger の中の `keySql`)。SQLite の型の親和性を写す `storedAs` |
| `src/routing.ts` | 4,096 スロットの範囲表 |
| `src/autoscaler.ts` | 増設の判断と手順 |
| `src/analytics.ts` | 変更ログの収集と watermark |
| `src/worker.ts` | 本番の入口。DO への配線、認証、HTTP と WebSocket、Cron |
| `src/entrypoint.ts` | Service Binding の入口 `DinfDatabase`。文、batch、対話的な取引を RPC で受ける |
| `src/binding.ts` | アプリ側のクライアント `connect()`。D1 互換 API と取引 |
| `src/cloudflare.ts` | 公開する入口。Worker に組み込むものをまとめて export する |
| `bin/cli.js` | `cf-d-infinity` コマンド (`sql`、`slow`、`status`) |
| `src/bench.ts` | 計測用の入口。ベンチマーク、DO のプローブ、障害注入 |
| `src/listappend.ts` | 黒箱検査の負荷 (リストへの追記) |
| `bench/elle.mjs` | 黒箱の直列化可能性の検査器 (Elle の list-append 方式) |

## テスト

| ファイル | 検査すること |
|---|---|
| `test/basic.test.ts` | SQL の機能、経路決定、取引、グローバル index |
| `test/compat.test.ts` | 本物の SQLite との差分テスト (手書き) |
| `test/fuzz.test.ts` | 本物の SQLite との差分テスト (乱数) |
| `test/slt.test.ts`、`test/slt-more.test.ts` | SQLite の sqllogictest |
| `test/prod.test.ts` | 本番の Worker への確認。`PROD_URL` があるときだけ動く |
| `test/counterexamples.test.ts` | 設計レビューと形式モデルの反例。欠陥スイッチを入れると壊れ、外すと直ることを確かめる |
| `test/history.test.ts` | ランダムな並行実行が commit 時刻順の直列実行と一致すること (時計のずれ、遅延、再起動あり)。チェッカが欠陥を検出できることも確かめる |
| `test/rollback-read.test.ts` | どの過去時点も正確に再構成できること |
| `test/migration.test.ts` | ライブ移動、`m5b` の反例、Autoscaler の判断 |
| `test/workerd.test.ts` | 本物の workerd と DO の SQLite での結合テスト |
| `test/ddl-concurrent.test.ts`、`test/ddl-harness.ts` | 取引と並行する DDL。index の作成、UNIQUE、DROP、列の追加、分割との競合を乱数の作業負荷で回し、index と表の一致、確定した書き込みの残存、表定義の収束を見る。見つかった欠陥の再現も含む |
| `test/limits.test.ts` | シャード側の上限。結果の行数とバイト数、取引の大きさ、グループの列挙と大きさ |
| `test/health.test.ts` | 保存形式の版と、健全性の判定 |
| `test/review-regressions.test.ts` | 設計レビューで見つかった欠陥の再現。欠陥スイッチで壊れ、外すと直る |
| `test/ops.test.ts` | 遅い文の記録と、`cf-d-infinity` コマンド。miniflare を dev サーバに見立て、dev registry 経由で呼ぶ |
| `test/binding.test.ts` | `DinfDatabase` と `connect()` を workerd の RPC で通す。同じ Worker の中の binding と、別の Worker からの binding の両方 |
| `test/autoscale-cron.test.ts` | Cron から起こした Autoscaler が、負荷のある間だけ alarm で追い、増設し、負荷が止まると静まること |
| `test/d1.test.ts` | D1 互換 API と Drizzle |
| `test/contention.test.ts` | 競合時の取引の失敗率。`CONTENTION=1` のときだけ動く |
| `test/gc.test.ts` | 変更ログと取引記録の GC。窓の外を必要とする読みが黙って間違えないこと、古い COMMIT の拒否 |
| `test/rowcost.test.ts` | 1 操作あたりの課金行数を workerd で数え、上限を検査する。`ROWCOST=1` のときだけ動く |
| `test/protocol.test.ts` | 新旧コードが混在するときの版の検査 |
| `test/elle.test.ts` | 黒箱の検査器が既知の異常 (G0、G1a、G1c、G2、消失、順序の矛盾) を検出すること |
| `test/elle-sim.test.ts` | 黒箱検査をシミュレータで回す。欠陥スイッチを入れた実装で異常を検出すること |
| `test/bench-build.test.ts` | 計測用の構成。障害注入を挟んだ負荷と黒箱検査 |
| `test/analytics.test.ts` | 変更ログから DuckDB まで |
| `test/replay.test.ts` | 並行に流した文を、確定の時刻の順に 1 つの SQLite で再生し、1 文ずつ結果が同じこと (取引の中の DDL を含む) |
| `test/typed-diff.test.ts` | 型のある引数を @libsql/client から流し、値と `typeof` を node:sqlite と比べる。`test/storage-class.test.ts`、`test/key-affinity.test.ts` も値の型とキー |
| `test/upgrade.test.ts` | 保存形式の版ごとの材料 (`test/fixtures/storage/`) から起動して、答え、書き込み、分割、表定義の変更が通ること |
| `test/unique-index-build.test.ts`、`test/rebuild-guard.test.ts`、`test/txn-across-schema-change.test.ts`、`test/migration-tools.test.ts`、`test/split-slot.test.ts` | 表定義の変更の安全 (モデル M12 から M15) と、本物の Drizzle の移行 |
| `test/drizzle-kit.test.ts` | 本物の drizzle-kit が作った移行を、Drizzle の移行で流す |
| `test/closed-stream-locks.test.ts`、`test/unique-pending-cost.test.ts`、`test/add-column-mixed-scan.test.ts` | 2026-11-12 に直した欠陥の再現 |
| `test/determinism.test.ts` | ソースが時計、タイマー、乱数を直に呼ばないこと。同じ seed が同じ実行になること |
| `test/open/` | 見つかっているが直していない欠陥の再現。正しい挙動を期待して書く。既定の実行から外してある (`OPEN=1`) |

モデルの反例ごとの、欠陥のスイッチと、反例をシミュレータで決定的に流す試験の対応は、[docs/model-coverage.md](../../docs/model-coverage.md) にある。
乱択の検査は `scripts/sweep.mjs` で seed を大量に流し、`scripts/fault-table.mjs` で欠陥のスイッチごとにどの検査が見つけるかを表にする。リポジトリの直下の `scripts/nightly.sh` が毎晩新しい seed で流す。`scripts/cloudflare-check.sh` は、一時的な Worker を本物の Cloudflare に置いて workerd の試験を流し、消す (持ち主に頼まれたときだけ流す)。`npm run demo` は、シャードを割りながら取引を続けて答えが変わらないことを見せる。

`Faults` 型のスイッチは検証済みの欠陥を再導入する。
本番の DO は `faults` を渡さないので、すべて無効のまま動く。
反例の再現テストと検査器の検出力の確認に使うので、本体から外していない。

## 未実装

merge、R2 と Container への接続、全シャード復元、follower DO、8 シャードを超える scatter の階層化、semijoin、複数 DB は未実装である。
増設の手順は Autoscaler DO が直接動かしており、Workflows は使っていない。
1 グループは 1 回の RPC で運ぶので、巨大なグループの分割転送も未実装である。
要求の形式を変えるデプロイは、上記の 2 段階の手順に従う。
