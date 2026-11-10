# プラットフォーム事実シート

2026-11-06 時点で Cloudflare 公式ドキュメント・changelog から確認した値。
設計判断の前提はここに集約する。
「未確認」と書いた項目は公式情報が見つからず、実測が必要なものである。

## Durable Objects (SQLite backend)

| 項目 | 値 |
|---|---|
| ストレージ / object | 10 GB (Paid)。超過時は `SQLITE_FULL`、read と delete は可能 |
| ストレージ / account | 無制限 |
| object 数 | 無制限 |
| スループット / object | soft limit 約 1,000 req/s。単純操作 500-1,000、JSON 処理あり 500-750、変換 + storage write で 200-500 |
| 実行モデル | シングルスレッド。過負荷時は `.overloaded` エラー |
| CPU / request | 既定 30 秒、最大 5 分 |
| メモリ | 128 MB / isolate |
| 同時 outgoing 接続 | 6 / request (response header 待ちのみ計上。DO RPC に適用されるかは未確認) |
| Alarm | 1 object に 1 個、handler は最大 15 分 |
| SQL 制限 | 100 列 / table、行・文字列・BLOB 8 MB (2026-11-09 の公式の表。以前は 2 MB)、文 100 KB、bound parameter 100、SQL 関数の引数 32、`LIKE` と `GLOB` のパターン 50 バイト |
| SQL 制限 (実測、公式の表にない) | UNION、INTERSECT、EXCEPT の複合 SELECT は 5 項まで。6 項以上は `too many terms in compound SELECT`。本物の SQLite の既定は 500 (2026-11-09 に本番で確認) |
| API | `sql.exec` は同期。`transactionSync` はコールバック同期のみ。cursor を `await` 越しに持つと snapshot 分離の保証なし。`sync()` は保留中の write の永続化を待つ |
| PITR | 30 日。`getBookmarkForTime` / `onNextSessionRestoreBookmark`。bookmark は「おおよその時刻」で、前後どちらにずれるかの記載はない。復元は `ctx.abort()` で再起動して完了する。ローカルの開発環境では使えない |
| 配置 | `locationHint` は初回のみ・best effort。作成後の object は移動しない。jurisdiction は `eu` / `us` / `fedramp` |
| read replica | changelog / docs に記載なし (D1 には Sessions API 付きの read replication あり) |

### 永続性の仕組み (公式ブログ)

- SQLite WAL を VFS で捕捉し、commit ごとに 5 台の follower へ送る。
- 3 台の ack で確定する。follower は 5 つの別データセンターにある。
- 応答は output gate で確定まで保持される。コードは待たずに先へ進める。
- 16 MB または 10 秒ごとにオブジェクトストレージへバッチ保存し、snapshot も置く。
- ホスト到達不能時は follower 3 台以上に確定停止を伝えてから代替 instance を起動する。

### 並行性

- Input gate は storage 操作中のイベント配送を止める。
- `await` on 非 storage I/O (fetch, RPC, R2) の間は他のリクエストが割り込む。
- `await` を挟まない write は 1 つの atomic な単位に coalesce される。

### 直近の変更

| 日付 | 内容 |
|---|---|
| 2026-11-05 | DO への `fetch` / RPC を runtime が自動 retry (既定 4 回、開始 10 秒以内)。到達不明でも再送するが、初回が届いていれば object 側が拒否する。`retryable()` を付けない限りメソッドは 2 回実行されない。`maxRetries: 0` で無効化 |
| 2026-10-30 | Deferred code update が既定。active な object は最大 300 秒旧コードで動く。best effort |
| 2026-10-01 | 保留中の RPC / fetch / waitUntil が eviction を防ぐ (操作ごとに最大 15 分) |
| 2026-07-09 | 新規 namespace は SQLite 必須 |

### 料金 (Paid)

| 項目 | 単価 |
|---|---|
| リクエスト | 100 万件で $0.15 |
| Duration | 100 万 GB-s で $12.50 |
| 行 read | 100 万行で $0.001 |
| 行 write | 100 万行で $1.00 (index 更新も 1 行ずつ計上) |
| ストレージ | $0.20 / GB-月 |

## Workers

| 項目 | 値 |
|---|---|
| メモリ | 128 MB / isolate |
| CPU | 既定 30 秒、最大 5 分 |
| subrequest | 10,000 / invocation (申請で最大 1,000 万) |
| `waitUntil` | 応答後 30 秒まで |
| script size | 64 MiB |
| 時刻 | `Date.now()` は最後の I/O の時刻に固定され、実行中は進まない |
| inbound | HTTP / WebSocket のみ。生 TCP は受けられない |
| 料金 | 100 万リクエストで $0.30、100 万 CPU ms で $0.02。月 1,000 万リクエストと 3,000 万 CPU ms を含む |

## Containers

| 項目 | 値 |
|---|---|
| 最大 instance | 4 vCPU / 12 GiB / 20 GB disk |
| account 上限 | 1,500 vCPU / 6 TiB memory / 30 TB disk (申請で増加可) |
| 到達経路 | DO 経由のみ。inbound TCP / UDP は不可 |
| disk | 既定で ephemeral。sleep 後は image から新品 |
| snapshot | public beta (2026-09-30)、最大 20 GB、30 日保持 |
| cold start | 多くは 1-3 秒 |
| 停止 | SIGTERM から最大 15 分で SIGKILL。再起動時の場所は変わり得る |
| スケール | 手動 (`getRandom` / 固有 ID)。autoscaling の記載なし |
| 外部アクセス | R2 の FUSE mount 可。outbound handler 経由で Workers / KV / R2 binding を HTTP で呼べる |
| 料金 | vCPU $0.000020/s (active 課金)、memory $0.0000025/GiB-s、disk $0.00000007/GB-s |

## R2 / 周辺

| 項目 | 値 |
|---|---|
| Workers KV | 結果整合。他拠点への反映は「60 秒以上かかることもある」。上限の記載なし |
| R2 同一 key への同時書き込み | 1 / 秒 |
| R2 object サイズ | 約 5 TiB |
| R2 レイテンシ | 公式ブログの一般論で「数十〜数百 ms」 |
| Pipelines | 1 GB/s / stream、5 MB / request、20 stream / account。配信保証は未確認 |
| DuckDB Iceberg | REST catalog で読み書き可、R2 Data Catalog へ attach 可。ただし R2 backend の公式サポート範囲と `MERGE INTO` はドキュメント間で不一致 |

## ローカルの workerd で確かめたもの

- PITR はローカルでは動かない。`getBookmarkForTime` と `onNextSessionRestoreBookmark` は「This Durable Object's storage back-end does not implement point-in-time recovery.」で失敗する (miniflare 4.20260730.0、2026-11-10)。`getCurrentBookmark` は 0 だけの値を返す。全シャード復元は本番でしか開発と検証ができない。

## 公式情報が見つからず実測が必要なもの

- Worker から DO への RPC の往復時間 (同一リージョン・別リージョン)
- DO から DO への RPC の往復時間
- SQLite write の quorum 確定レイテンシと、1 object の持続 write 上限
- 同時 6 接続の制限が DO RPC に適用されるか
- DO 間のバルクコピー速度
- `locationHint` の実際の遵守率
- DO を跨いだ時計のずれ (上限の公表なし)
- failover 中に旧 instance が read だけ返す窓があるか
