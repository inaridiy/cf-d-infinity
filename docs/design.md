# Cloudflare 上の水平スケール NewSQL 設計

状態：設計案 (試作、本番ベンチマーク、シャードの自動増設の検証が完了。結果は [benchmarks.md](./benchmarks.md))
作成日：2026-11-06
前提となる制約値と出典は [platform-facts.md](./platform-facts.md) に、SQL の仕様は [sql-language.md](./sql-language.md) に、シャードの自動増設は [scaling.md](./scaling.md) に、分散クエリ実行層は [query-engine.md](./query-engine.md) にまとめた。
形式モデルと検査結果は [specs/README.md](../specs/README.md) にある。

## 結論

シャードを 1 つの Durable Object (DO) とし、その SQLite に利用者のテーブルをそのまま置く。
複製は DO の永続化基盤が 5 台の follower と 3 台の ack で済ませているので、Raft は実装しない。
hot path に単一の DO を置かないため、シャード数に比例してスループットが伸びる。

| 項目 | 決定 |
|---|---|
| シャード | DO 1 個。目標サイズ 0.5〜2 GB |
| 格納形式 | ネイティブ SQLite テーブル。本体は committed の最新版のみ |
| 分割 | `hash(shard key)` のスロット。省略時は PK の先頭列。関連テーブルを同じシャードに集める |
| 分離レベル | Serializable が既定。シャードを跨ぐ実時間順序は保証しない |
| 時刻 | シャードごとの HLC。単一の TSO は置かない |
| クロスシャード commit | anchor シャード主導の 2PC、presumed abort |
| 過去時点の読み取り | rollback-read (差分を一時的に戻して読み、ROLLBACK する) |
| index | shard key を含むものはローカル、含まないものはグローバルで同期更新 |
| 分析 | シャードの変更ログを R2 へ流し、DuckDB on Containers で読む |
| クライアント | `@libsql/client` (Hrana)、D1 互換 API、Drizzle。SQLite 互換 |

依頼時の三層分割 (ポイントは Worker、複雑なものは DO、分析は DuckDB) は、次の形に修正した。

| 依頼時の想定 | 修正後 | 修正の理由 |
|---|---|---|
| ポイント読み込みは Worker | Worker は経路を決め、シャード DO が実行する | Worker はデータを持たず、read replica もない |
| 複雑なものは DO | クエリの調整は Worker、シャード内の部分 SQL は DO | 調整役を DO に集めると 1 個あたり約 1,000 req/s の上限に当たる |
| 分析は DuckDB on Containers | そのまま採用。ただし OLTP の DO を直接読まず R2 経由にする | 分析の読み取りで OLTP の処理を止めないため |

この設計は、シャード 1 個の実効性能を仮定して組んでいる。
未計測の値が閾値を外れると設計を変える必要があり、その条件は「計測項目と撤退条件」に示した。

## 全体構成

```text
 クライアント (Worker binding / HTTP / WebSocket)
        |
        v
 +--------------------------+       +-----------------------------+
 | Gateway Worker (無状態)  | ----> | Meta DO (表定義、範囲と DO) |
 | parse, plan, 経路決定,   |       | hot path の外。isolate と   |
 | scatter のマージ, OCC    |       | KV にキャッシュする         |
 +--------------------------+       +-----------------------------+
        |  RPC
        v
 +--------------------------------------------------------------+
 | Shard DO x N (home region に集約)                            |
 |  本体テーブル / __intents / __log_<gen> / __txn / HLC        |
 |  SQLite の複製は DO 基盤が担当 (5 follower, 3 ack)           |
 +--------------------------------------------------------------+
        |  60 秒または 16 MB ごとに flush
        v
 +----------------+    +----------------------+    +---------------+
 | R2 (変更ファイル) | -> | Compactor Container | -> | Parquet /     |
 +----------------+    +----------------------+    | Iceberg (R2)  |
                                                   +---------------+
                                                          |
 Analytics Gateway DO -> DuckDB Container x M  <----------+
```

## シャードの内部構造

シャードの内部形式は、ネイティブテーブルと汎用 KV の 2 択になる。
TiKV 型の汎用 KV にすると、述語評価と index を JS で実装し直すことになる。
DO の上限はリクエスト数とシングルスレッドの CPU なので、処理を JS へ移すほど上限に早く当たる。
そこで SQLite のプランナと C 実装の実行器をそのまま使える Vitess 型を採る。

シャードは利用者のテーブルに加えて、次の内部テーブルを持つ。

- **本体テーブル**：利用者が定義した表。committed の最新版だけを持つ。隠し列は持たないので、`SELECT *` や列名なしの `INSERT` は本物の SQLite と一致する。
- **`__intents`**：prepare 済みで未確定の書き込みを行イメージで持つ。commit で本体へ適用する。
- **`__log_<gen>`**：commit ごとに 1 行、`(commit_ts, txn, blob)` を持つ。blob は変更の before-image と after-image を含む。`commit_ts` の物理時刻 2 分ごとの世代の表 (`WITHOUT ROWID`) に分け、古い世代から順に読む。世代を UNION の view で束ねないのは、DO の SQLite が複合 SELECT を 5 項までしか受け付けないからである。保持窓 (10 分) より古い世代は `DROP TABLE` する。DROP は行の書き込みとして課金されない。
- **`__txn`**：そのシャードが anchor を務めた取引の決着 `(txn_id, status, c, participants, at)` を持つ。全参加者へ phase 2 を届けた記録と tombstone は、1 時間後に消す。

本体に未確定の行を置かないのは、pushdown した任意の SQL (JOIN や集約) から未確定の行を隠せないからである。
本体が committed だけなら、SQL を書き換えずに実行できる。

メモリには直近の write の索引 `(table, pk, commit_ts)` を 60 秒分持つ。
DELETE された行と範囲に対する競合検出は、これで処理する。
行の版は持たず、競合の検出はこの索引だけで行う。
再起動時は残っている `__log` から索引を作り直すので、起動時間とメモリは保持窓に比例し、書き込みの総数には比例しない。
世代を DROP する前に `log_low_water` を上げ、それより古い `T` の取引と過去読みは abort か ReadTooOld にする。
未決着の intent の `prepare_ts` と、分析へ未送出の範囲は保持窓を延ばす。
索引が膨らんだら捨てて low-water を上げ、それより古い窓を読む取引は保守的に abort する。

## パーティショニングと split

既定のキーは `(hash(shard_key), table, pk)` とする。
テーブル宣言で shard key を指定すると、同じ値を持つ行は表を跨いで同じシャードに集まる。
これは Spanner の interleave や Vitess の keyspace に相当し、典型的な取引をシングルシャードに収めるための前提である。
もしテーブルごとの PK range にすると、同じ利用者の users と orders が別シャードに分かれ、ほとんどの取引が 2PC に落ちる。
連番 ID の末尾へ書き込みが集中しないよう、range は宣言した表だけの opt-in とする。

split の境界は shard key の値の切れ目を優先する。
ただし 1 つの shard key の値が 1 シャードの容量を超えるとき (大口テナントなど) は、その値の内部で切る。
まずテーブルの境界で切り、それでも足りなければ 1 つの表を pk で切る。
その値の取引はコロケーションを失ってクロスシャードになるが、容量の壁で止まるよりはよい。
表を pk で切る場合は、その表の PK 以外の UNIQUE を先にグローバル index へ昇格させる。
行が 2 つの DO に分かれると、SQLite の UNIQUE は DO の中でしか効かないからである。

TiKV の split はメタデータの操作で済むが、ここには shared storage がないので必ずコピーになる。
以下は当初の fence 方式の手順である。
負荷の高いシャードで追いつかないので、自動増設では pull 型へ置き換える ([scaling.md](./scaling.md))。

1. 親が split key を決める。発動条件は、サイズ 1 GB 超、write 200 取引/s の持続、read 500 req/s の持続のいずれかである。
2. 右半分を新しい DO へチャンクでコピーする。親は処理を続け、変更ログを蓄積する。
3. 変更ログの残りが閾値を下回ったら、親が右半分への要求を数百 ms だけ retry 指示で拒否する。
4. 残りのログと未解決の `__intents` を子へ送り、fence 時の HLC を子へ引き継ぐ。
5. Meta の範囲を切り替える。迷い込んだ要求には親が `NotOwner(新DO)` を返す。
6. 親が右半分を削除する。

`__txn` は親に残る。intent は anchor の DO ID を直接持つので、split の影響を受けない。
merge で anchor の DO を消すときは `__txn` を吸収先へコピーし、旧 DO を 24 時間 forwarder として残す。
1 GB シャードの split は、200 バイト行と index 2 本を仮定すると、コピーと削除で約 $15 になる。

## 時刻と分離レベル

単一の TSO は採用しない。
TiDB の PD はクライアント側のバッチ取得で高いスループットを出すが、Worker は取引ごとに別の isolate で動くのでバッチ化が効かない。
TSO の DO が約 1,000 req/s で全体の取引数の上限になる。

そこで各シャードが **HLC** (物理時刻と論理カウンタの組) を持つ。
Worker の `Date.now()` は実行中に進まないので、時刻は常にシャードが発行する。
HLC は発行のたびに厳密に増加する。

HLC の値は再起動を跨いで後退してはならない。
読み手の `T` で進めた分が失われると、すでに `T` で読まれたシャードに `T` 以下の commit が入るからである。
読むたびに永続化すると読み取りが quorum 待ちになるので、TiDB の PD と同じく上限を先取りして保存する。
`T` が保存済みの上限を超えたときだけ、上限を `T + 1 秒` に更新する 1 行を書く。
再起動時は `max(保存済みの上限, 物理時刻)` から再開する。
書き込みは 1 シャードあたり最大で毎秒 1 回になる。

時計のずれの上限が公表されていないので、保証の範囲は次のように定める。

| 範囲 | 保証 |
|---|---|
| シングルシャード取引 | Strict serializable (failover 中の窓については「主なリスク」を参照) |
| マルチシャード取引 | Serializable |
| 同一セッション内 | 因果整合。応答の HLC トークンを次の要求に持ち回る |
| 別セッションの実時間順序 | autocommit の読みと取引の最初の読みでは保証する。取引の 2 文目以降は保証しない ([sql-language.md](./sql-language.md)) |
| `ASYNC` index を使うクエリ | 上の保証の対象外。isolation の明示を要求する |
| 分析 | 全シャードで同一時刻のスナップショット (鮮度 2〜5 分) |

## 読み取り

ポイントリードは、Worker がキャッシュ済みの経路表でシャードを決め、RPC 1 回で読む。
1 シャードで完結する読み取りは、シャードの最新状態を読んで HLC トークンを返す。
ただし読む範囲に intent があれば、`T = HLC.now()` とみなして後述の照会を行う。
committed で phase 2 が未適用の intent を無視すると、同じセッションが別シャードで見た取引をここで見失うからである。

マルチシャードの読み取りは次の手順で進める。

1. 最初に触るシャードの HLC を読み取り時刻 `T` とする。
2. 各シャードは到着時に `HLC = max(HLC, T)` とする。これで以後の commit は `T` より大きくなる。
3. 読む範囲に `prepare_ts ≤ T` の intent があれば anchor に照会する (後述)。
4. rollback-read で時刻 `T` の状態を作り、plain SQL を実行する。

intent を無視してよいのは、その commit 時刻が `T` を超えると確定している場合に限る。
具体的には、`prepare_ts > T` のとき、anchor が aborted と答えたとき、anchor への push が成功したときである。
push は anchor に `min_commit_ts = T + 1` を登録する操作で、anchor は commit 時刻をこれ以上に決める。
push を受理するのは `c` の決定前だけである。
`c` の決定後は refresh の途中でも `c` が動かないので、受理すると読み手が取引を誤って無視する (Quint のモデルが見つけた反例)。
`c` が決定済みで `c ≤ T` なら、読み手は決着を待ち、commit なら phase 2 を代行適用してから読む。
タイムアウトで通過させると、片方のシャードでは取引が見えず、もう片方では見える読み取りが起こる。

照会は `await` を伴うので、その間に他の処理が割り込む。
照会の後で intent と差分を確認し直し、rollback-read の本体は同期区間で実行する。

### rollback-read

TiDB や CockroachDB は MVCC の過去版を読む。
しかしネイティブテーブルに履歴を持たせると、JOIN や集約を履歴込みの view に書き換える必要がある。
**rollback-read** は、DO が同期かつシングルスレッドで動くことを使って、これを避ける方式である。

```ts
try {
  ctx.storage.transactionSync(() => {
    // 0. PRAGMA defer_foreign_keys = ON (ROLLBACK で解除される)
    // 1. T より後に変更された行を、本体から全部 DELETE する
    // 2. それらの行のうち T に存在したものを before-image で INSERT する
    // 3. Worker が buffer した自分の未 commit write を適用する (対話的取引のみ)
    rows = sql.exec(pushdownSql, ...params).toArray();
    throw new Rollback();
  });
} catch (e) { if (!(e instanceof Rollback)) throw e; }
```

処理の途中に他の要求は割り込まず、ROLLBACK するので本体は変わらない。
行ごとに UPDATE で戻すと、UNIQUE 列の値を入れ替えた取引を戻せない。
どの順序でも途中で重複が生じるからである。
先に全部消してから入れ直すと、途中の状態は常に時刻 `T` の状態の部分集合になるので、制約に違反しない。
before-image は pk ごとに「`T` より後で最も古い commit のもの」を 1 回だけ適用する。

3 の手順を入れると、対話的取引の read-your-writes も同じ機構で解ける。
buffer は pushdown のたびに送るので、クエリサイズの上限に含める。

差分の行数は上限 `K` (初期値 50) で制限する。
逆適用は同期処理なので他の要求を止めるうえ、ROLLBACK した分が課金される可能性があるからである。
超過時、`T` が変更ログの保持窓より古いとき、および `T` が直近の DDL より前のときは `ReadTooOld` を返す。
`ReadTooOld` を受けた Worker は `T` を上げ、先行シャードで変更の有無を照合してから読み直す。
3 回で打ち切り、全参加者の HLC を集めて最大値を `T` にする方式へ切り替える。

ローカルの workerd での検証結果は次のとおりである (`spikes/rollback-read/`)。
本番環境の挙動と課金は未検証である。

| 確認項目 | 結果 |
|---|---|
| ROLLBACK 後に本体が元に戻る | 確認 |
| UNIQUE swap を含む差分から `T` の状態を再現 (DELETE して INSERT) | 確認 |
| 同じ差分を行ごとの UPDATE で戻す | UNIQUE 違反で失敗 |
| `rowsWritten` が ROLLBACK 分を数える | 数える。6 行の操作で 12 (index 分を含む) |
| `CREATE TEMP TABLE` | `SQLITE_AUTH` で不可 |
| `PRAGMA defer_foreign_keys` | 可 |

読み取りのスケールの第一手段はシャードの細分化である。
split の発動条件に read の負荷を含めているのはこのためで、サイズが小さくても分割する。
単一のホットキーは split で解けないので、将来 `AS OF` を明示した読み取りに限り、変更ログを購読する follower DO で受ける。
書き込み課金が倍になるので、これは opt-in かつ MVP の対象外とする。

## 書き込みとトランザクション

取引の書き込みは commit まで Worker が buffer し、本体へは適用しない。
読み取りの検証は楽観的に行い、書き込みは行ロックで守る (後述の「悲観的な取引」)。
Worker が途中で死ぬと、残るのはメモリ上のロックだけで、TTL で消える。
Worker は状態を持たないので、接続を跨ぐ取引の状態は Hrana の baton に載せて持ち回る。

### 文から行の変更へ

書き込み文の意味は Worker で解析しない。
変更された行は、文の形に応じて 2 つの方法で捕捉する。

| 文の形 | 捕捉の方法 |
|---|---|
| OR 句、UPSERT、RETURNING のない INSERT、RETURNING と FROM のない DELETE、主キーで 1 行に絞れる UPDATE | 文に `RETURNING` を付けて実行し、UPDATE の変更前の行は主キーで読む |
| それ以外 | 捕捉用の trigger で変更された行を記録する |

ROLLBACK した書き込みも行として課金されるので、trigger の捕捉は 1 文あたり 3 行の費用がかかる。
autocommit の文は前者なら下書きをせず、そのまま実行して確定する。行ロックに当たったときだけ巻き戻して待つ。
取引の文は、どちらの方法でもシャードが文を一時的に実行して行を捕捉してから ROLLBACK する。
Worker はその行イメージを buffer し、commit で適用する。
`INSERT ... ON CONFLICT` のように文面から変更行が分からない文も、この手順で分散取引に載せられる。
`REPLACE` が暗黙に消す行を捕捉するため、`recursive_triggers` を有効にする。

### シングルシャード取引

Worker は `commit(txn_id, T, write_set, read_spans)` をシャードへ送る。
シャードは検証と本体への適用と `__log` への記録を 1 つの `transactionSync` で実行する。
quorum の確定は 1 回で、2PC は発生しない。

本体への適用は通常の行単位で行う。
UNIQUE 列を複数行で変更する取引だけは、rollback-read と同じ手順で対象行を全部 DELETE してから INSERT する。
行単位の適用では swap が `SQLITE_CONSTRAINT` になり、commit 確定後の phase 2 で起きると適用不能のまま詰まるからである。
全取引をこの手順にしないのは、更新の行課金が倍になるからである。

### クロスシャード取引

Percolator がクライアント主導なのは、durable なコーディネータがないからである。
ここには DO があるので、参加シャードの 1 つを **anchor** として commit を主導させる。
これによって、commit の決着に lock の TTL と heartbeat が要らなくなる。
悲観的な取引の行ロックには TTL があるが、これは待ちを解くためのもので、決着には関わらない。

1. Worker が anchor へ `commit(txn_id, T, write_set, read_spans)` を送る。anchor は in-flight に登録する。
2. anchor が他の参加者へ `prepare` を送る。読み取りだけの参加者にも送る。
3. 参加者は同じ pk の intent か他の取引のロックがあれば即 abort (no-wait) する。prepare は決して待たない。直近 write の索引に当たれば abort する。read span を `(T, prepare_ts]` で照合し、UNIQUE を論理検査して intent を書き、HLC を 1 刻み進めた `prepare_ts` を返す。
4. anchor が `HLC = max(HLC, 全 prepare_ts, pushed)` としてから最後に自分を prepare し、その `prepare_ts` を `c` とする。
5. `prepare_ts < c` かつ未保護の read span を持つ参加者へ `refresh(spans, (prepare_ts, c])` を送る。参加者は HLC を `c` まで進めてから照合する。失敗なら abort する。`c` の決定後に届いた push は、決着まで保留する。
6. anchor が `__txn` に committed(c) を insert し、`sync()` で確定を待つ。
7. Worker へ応答し、同じイベント内で phase 2 を発火する。alarm は再駆動の保険とする。
8. 参加者は HLC を `c` まで進め、シングルシャード取引と同じ手順で intent を本体へ適用し、`__log` に 1 行書く。

pk の等値で読み、同じ pk に書く read span は、intent が守るので refresh の対象にならない。
これ以外の read span (範囲、述語、index 経由の読み) を未保護と呼ぶ。
intent は pk しか守らず、述語に後から合致する行の挿入 (phantom) を防げないからである。
anchor は HLC を全 `prepare_ts` まで進めてから prepare するので、自分の span は `c` まで検証済みになり refresh が要らない。
よって anchor には未保護の read span を持つ参加者を優先して選び、同条件なら `hash(txn_id)` で分散する。
未保護の span が 1 シャードに収まる取引は 2 ラウンドで、そうでない取引は 3 ラウンドになる。

write skew を防ぐ根拠は次のとおりである。
W1 と W2 が互いの書く行を読み、`c1 < c2` だとする。
W2 の検証は `c2` まで及ぶ。
W1 の intent が検証より先に置かれていれば W2 が検出する。
検証より後に置かれていれば、その `prepare_ts` は `c2` より大きく、`c1 ≥ prepare_ts > c2` となって仮定と矛盾する。
この論法は、読み取りだけの参加者にも prepare を送ること、HLC が発行のたびに厳密に増えること、anchor が全 `prepare_ts` を取り込むことの 3 点に依存している。

### 悲観的な取引

楽観的な検証だけでは、同じ行を奪い合う取引が `COMMIT` で失敗し続ける。
シミュレータで測ると、ホットな 10 行で失敗率が 78% に達した。
そこで TiDB と同じく、書き込みは文の時点で行ロックを取る。

| 開始の文 | 読み取り | 書き込み |
|---|---|---|
| `BEGIN IMMEDIATE` | 主キーの読みは行ロックを取り、最新の時刻 F で読む | 文の時点で行ロックを取る |
| `BEGIN` | 時刻 T のスナップショット | 文の時点で行ロックを取る |

DML の手順は次のとおりである。

1. 時刻 F を取り、読む範囲の intent を決着させる。確定済みで未適用の行を読み飛ばさないためである。
2. 最新の状態で文を試し実行し、変更行を得る。
3. 変更行に他の保持者か intent があれば待ち、待った後は 1 からやり直す。
4. なければロックを取り、行の変更と F を返す。読んだ範囲は F から検証する。

ロックは DO のメモリだけに置く。
再起動、TTL 切れ、wound、移動で消えても安全である。
ロックの有無に関わらず、commit の検証が行ごとの F 以降の変更を見るからである。
同じ行への 2 回目の DML は自分の overlay を読むだけなので、検証の窓は最初の F から取る。

待ちは wound-wait である。
若い取引が待ち、古い取引は 200 ms 待っても空かなければ保持者のロックを奪う。
wait-die はホットな行で後から来る取引が全部死ぬので使わない。
prepare 済みの取引は奪えない。
prepare は待たないので、prepare 済みの取引は待ちの終端になり、閉路ができない。

待ち手は先頭の 1 件だけを起こす。
ロックの期限切れはタイマーで確かめ、起こされた待ち手が取らずに去るときは次を起こす。
どちらかが欠けると、ロックが空いたまま全員が眠る。

読み取りだけの取引は、T のスナップショットだけを読んだなら検証なしで終わる。
ロックを取って最新を読んだ取引は読みの時刻が揃わないので、書き込みがなくても `COMMIT` で検証する。

`COMMIT` や検証に失敗した取引はロックを解放する。
残すと TTL が切れるまで全員が待つ。

### 障害時の決着

prepare の段階では anchor にログを書かない (presumed abort)。
intent に当たった読み手やシャードの alarm が anchor に照会し、記録がなく in-flight でもなければ、anchor が abort の tombstone を書く。
anchor は直列に処理するので、tombstone の後に届いた ack は捨てられる。
Worker は応答が不明なとき `status(txn_id)` で決着を知る。

冪等性は `txn_id` で担保する。
prepare と phase 2 は `retryable()` を付け、Worker から anchor への commit は付けずに status 照会へ回す。
DO の再起動で in-flight の記憶が消えても、旧 instance は確定を止められており、新しい記録を確定できない。
phase 2 の送信を `sync()` の後に置くのは、DO 間 RPC に output gate が効くか確認できていないからである。

全 RPC に `protocol_version` と `epoch` を載せる。
deferred code update で新旧のコードが共存するので、新コードは旧形式を受け、内部テーブルの変更は「2 版読み、1 版書き」の 2 回デプロイとする。

## クエリの実行

Worker は parse、schema の bind、シャードの剪定を行い、部分 SQL を各シャードへ送って結果をマージする。
合成は Worker の中の SQLite (sql.js) が行う ([query-engine.md](./query-engine.md))。
全シャードに及ぶ文も既定で実行する。
ただし scatter の QPS 上限はシャード 1 個の容量と同じで、N を増やしても増えない。
実測では 1 invocation からの fan-out は 8 前後で遅延が跳ねるので、scatter は service binding で階層化する。

index は shard key の有無で配置を自動的に決める。

- **ローカル index**：shard key を含む index。シャード内の SQLite index で、UNIQUE も SQLite の制約として持つ。
- **グローバル index**：shard key を含まない index。index キーで分割した別のシャード群に置き、同じ取引の同期参加者として更新する。

グローバル index を持つ表の write は 2PC に落ちる。
非同期を既定にしない理由は偽陰性である。
「INSERT の直後に `WHERE email = ?` で見つからない」は本体の検証で補えず、このクエリは snapshot でも Serializable でもなくなる。
`ASYNC` を宣言した index だけ、anchor が phase 2 で非同期に更新する。

クエリサイズの上限は次のように具体化する。

| 対象 | 上限 | 由来 |
|---|---|---|
| SQL 文 | 100 KB | DO SQL |
| 行、文字列、BLOB | 2 MB | DO SQL |
| 列数 | 100 | DO SQL |
| bound parameter | 100 | 超える分は JSON 1 個と `json_each` で渡す |
| 取引の write set | 1 MB | `__log` の 1 行に before と after を収めるため (行の上限 2 MB) |
| Worker へ集める行 | 20 万行 | Isolate の 128 MB からの推定 |
| 分析クエリ | 1 ノードあたり 12 GiB | Container の上限 |

## 分析パス

OLTP の DO を分析で読むと、シングルスレッドの処理を止めてしまう。
そのためデータは必ず R2 を経由させる。

1. シャードが 60 秒または 16 MB ごとに、`flush_ts` までの変更を R2 へ書く。キーはシャード別なので、同一キーの書き込み制限には当たらない。
2. `flush_ts` は未解決 intent の `min(prepare_ts)` 未満に抑える (TiCDC の resolved ts と同じ考え方)。
3. Compactor Container が数分ごとにファイルをまとめ、変更の表と最新状態の表を更新する。
4. 分析クエリは Analytics Gateway DO を経由して DuckDB Container へ届く。

全シャードで整合したスナップショットを作るには、シャードの `flush_ts` の最小値 `W` が要る。
しかし hibernate 中のシャードを毎分起こすわけにはいかない。
そこで commit 時刻が常に物理時刻以上であることを使い、`W_cand = now − 30 秒` とする。
時計のずれが 30 秒未満である限り、idle なシャードの次の commit は `W_cand` より大きくなるので、idle なシャードは計算から外せる。
シャードは flush 後の最初の書き込み (intent または commit) で Meta に dirty を報告し、`W = min(W_cand, dirty シャードの flush_ts)` とする。
dirty の報告が遅れた場合に備えて、compactor が `W` 以下の遅延ファイルを見つけたらスナップショットを再生成する。

DuckDB が R2 上の Iceberg をどこまで読めるかは、公式ドキュメントの間で記述が一致していない。
M3 の冒頭で確認し、使えない場合は Parquet と独自 manifest を S3 互換 API で読む構成に切り替える。
Container の autoscaling は記載がないので、ノード数は Analytics Gateway DO が管理する。

## メタデータとスキーマ変更

Meta DO は表定義、範囲と DO の対応、`schema_version` を持つ。
Worker は経路表を isolate のメモリにキャッシュし、起動直後は KV のスナップショットから読む。
シャードが `NotOwner` と `StaleSchema` で不整合を検出するので、キャッシュが古くても正しさは壊れない。
シャード数が増えて経路表が大きくなったら、CockroachDB の meta range のように 2 段にして必要な部分だけを読む。

DDL は F1 の Online Schema Change を使い、配信を lazy apply に置き換える。

1. Meta が `schema_version` を上げ、delete-only、write-only、public の順に遷移させる。
2. 全要求に `schema_version` を添付する。シャードは自分が古ければ、その場で DDL ログを適用する。この lazy apply はメタデータだけの DDL に限る。
3. シャードは現在の版より 2 つ以上古い要求を拒否する。
4. Meta は次の状態へ進む前に lease (初期値 90 秒) を待つ。KV の伝播は「60 秒以上かかることもある」とされ上限がないので、lease は拒否の頻度を下げるだけで、正しさはシャード側の版の拒否で守る。
5. backfill を伴う DDL は、Workflow が全シャードを能動的に起こす。これで全シャードが新しい版を知り、古い Worker の要求を確実に拒否できる。各シャードは alarm で分割実行し、完了を Meta に報告する。全完了で public へ進む。

SQLite で型変更はできないので、列の追加、コピー、切り替えで処理する。

シャード内の FK は `NO ACTION` だけを許す。
rollback-read と適用の手順は行を DELETE するので、`CASCADE` や `RESTRICT` があると差分外の行を消すか失敗するからである。

## 配置とクライアント

database ごとに home region を 1 つ決め、全シャードをそこに置く。
2PC の往復時間を最小にするためである。
`locationHint` は作成時のみ有効で best effort なので、外れた DO は RTT の実測で検出して作り直す。
マルチリージョンは、将来の follower DO による stale read だけを対象とする。

Worker にも Container にも inbound の生 TCP は届かないので、Postgres と MySQL のワイヤープロトコルは受けられない。
クライアントは Worker binding と HTTP / WebSocket driver に絞る。
シャードの実行器に合わせて方言は SQLite とし、D1 互換 API を最初の面にする。
`batch` を 1 取引に対応させ、Sessions API の bookmark に HLC トークンを載せる。
Postgres 互換は、ワイヤー、型、方言の 3 層の実装が要るのでスコープ外とする。

## スループットとコストの見積もり

以下は仮定に基づく試算である。
本番の実測ではシャード 1 個の書き込み上限が約 950/s で、64 シャードで 1.9 万 write/s まで確認した ([benchmarks.md](./benchmarks.md))。
シャードの自動増設も本番で確認し、2 個から 24 個まで手を触れずに増えた。
クロスシャード取引は 1 シャードあたり 44〜60/s で、下の仮定 (75/s) を下回った。
仮定は、シャードあたり write 300 取引/s、read 700 req/s、クロスシャード率 20%、クロスシャード 1 件がシャードの要求 4 回分である。

| シャード数 | シングルシャードのみ | クロスシャード 20% | ポイントリード |
|---|---|---|---|
| 1,000 | 30 万 write/s | 約 19 万 write/s | 70 万 req/s |
| 10,000 | 300 万 write/s | 約 190 万 write/s | 700 万 req/s |

write の課金が費用の大半を占める。
Worker のリクエスト単価は $0.30、DO は $0.15、行 write は $1.00 (いずれも 100 万件あたり) である。

| 操作 (100 万件あたり) | 行 write | 費用 |
|---|---|---|
| ポイントリード | 0 | 約 $0.45 |
| マルチシャード読み (ホットシャード、ROLLBACK が課金される場合) | 24〜36 | 約 $25〜36 |
| シングルシャード insert (index 2 本) | 4〜5 | 約 $4.5〜5.5 |
| クロスシャード (2 シャード、各 1 行、index なし) | 10〜12 | 約 $11〜13 |

書き込みの行数の幅は、変更ログの `DROP TABLE` が課金されるかどうかによる。
マルチシャード読みの行は、300 write/s のシャードを平均 20 ms 古い `T` で読み、差分 6 行を index 2 本の表で戻す場合である。
ROLLBACK 分が課金されなければ、ポイントリードと同程度に収まる。
1 万 write/s を 1 か月続けると 259 億件で、シングルシャード insert でも約 $12 万になる。
この設計はスループットを線形に伸ばせるが、単価は下がらない。
書き込みが常時高い用途では費用が先に問題になる可能性がある。
このほか、常時稼働のシャードは duration だけで 1 個あたり月 約 $4 かかり、ストレージは $0.20 / GB-月である。

## 主なリスク

**シャードの実効性能が仮定を下回ること**：全体のスケールが「シャードを増やせば線形」に依存している。quorum の確定が 50 ms 級なら、2PC の intent の保持が 100 ms を超え、競合による abort が増える。

**ホットな単一行**：1 行への write は 1 シャードの上限で止まり、split で解けない。上限は数百 write/s と見込む。

**ホットシャードの split が追いつかないこと**：コピーと通常処理がシングルスレッドを奪い合う。追いつけなければ pre-split が必須になる。

**時計のずれ**：別セッション間の実時間順序を保証しない理由であり、`W_cand` の 30 秒の根拠でもある。ずれの上限は公表されていない。

**failover 中の read**：旧 instance が quorum を踏まずに read を返す窓が存在すれば、シャード内の linearizability と refresh の判定が破れる。対策は応答の `epoch` による検出で、窓が有意なら必要な読みだけ 1 行書いてから読む。

**rollback-read の本番挙動**：spill した未 commit のフレームを永続化基盤がどう扱うか、ROLLBACK 分が課金されるかは未確認である。

## 計測項目と撤退条件

次を本番の Cloudflare 上で計測する。
M1 の性能と時計のずれ、fan-out は計測済みで、撤退条件には当たらなかった ([benchmarks.md](./benchmarks.md))。

| 時期 | 計測 | 閾値と対応 |
|---|---|---|
| M1 | 1 DO の持続 write、quorum 確定レイテンシ | write < 100 取引/s かつ確定 p50 > 100 ms なら設計を破棄する |
| M1 | Worker と DO の RTT、ポイントリード/s | 仮定値の見直し |
| M1 | ROLLBACK 分の行課金、`DROP TABLE` の行課金 | 課金されるなら `K` を下げる、ログ方式を変える |
| M1 | failover 時の read 窓 | 窓が有意なら quorum read を導入する |
| M2 | DO 間 RTT、2PC の p99 | 取引の設計目標の見直し |
| M2 | DO 間 RPC への output gate の適用 | 適用されるなら `sync()` を省く |
| M2 | Worker から 50 DO、anchor から参加者への並列度 | 6 接続が適用されるなら scatter を階層化し、取引の参加者数を制限する |
| M2 | 時計のずれの分布 | p99 > 1 秒なら HLC を諦め、TSO 系へ移る |
| M3 | DO 間コピー速度、追いつける write/s の上限 | < 100 write/s ならオンライン split を諦め、pre-split とバースト拒否へ変える |
| M3 | DuckDB と R2 Iceberg の互換性 | 不可なら Parquet と独自 manifest にする |

## マイルストーン

**M1 (単一シャードの核)**：本体、`__intents`、`__log`、直近 write の索引、シングルシャード取引、rollback-read、HLC を作る。本番の性能が閾値を超えるかを確かめる。

**M2 (マルチシャード)**：anchor 2PC、refresh、Meta と経路、同期グローバル index を作る。Jepsen 型の検査で Serializable を確認する。

**M3 (運用)**：split と merge、変更ログから DuckDB までの経路、watermark、lazy DDL を作る。

MVP では `ASYNC` index、follower DO、Postgres 互換、長期の `AS OF`、シャードを跨ぐ FK の強制、trigger を切る。

## 参考 DB から借りた点と捨てた点

| 由来 | 借りた点 | 捨てた点と理由 |
|---|---|---|
| TiDB | Online Schema Change、resolved ts、Percolator の intent 解決の考え方 | PD の TSO (Worker でバッチ化できない)、TiKV の split (shared storage がない)、クライアント主導の commit (DO が durable) |
| CockroachDB | HLC、read refresh、push、meta range | 時計ずれ上限に基づく uncertainty (上限が非公表)、parallel commits (MVP では複雑さに見合わない) |
| Vitess / PlanetScale | ネイティブ DB 上のシャーディング、shard key、コピー型の resharding | MySQL プロトコル (inbound TCP 不可)、クロスシャード取引の弱さ |
| Spanner | interleave によるコロケーション | TrueTime と commit wait (時計の上限が得られない) |

シャードの実体についても、次の案を検討して捨てた。

| 案 | 捨てた理由 |
|---|---|
| Container 上で自前のストレージと Raft を動かす | disk が ephemeral で、再起動で場所が変わり、DO 経由でしか届かない |
| R2 を主記憶にする | 公式の説明で数十〜数百 ms のレイテンシがあり、commit ごとには使えない |
| D1 をシャードにする | read replica はあるが、alarm やシャード内の調整ロジックを持てない |

## 議論の経緯

Opus と Fable がそれぞれ独立に設計し、3 ラウンドの反例探しの後に Fable のレビューを受けた。
レビューの 11 件の指摘はすべて本文に反映した。

| 論点 | 当初の案 | 結果 | 決め手 |
|---|---|---|---|
| 調整役 | Opus：Query DO | Worker | Fable：DO に集めると 1,000 req/s の上限に当たる |
| 分離レベル | Fable：SI | Serializable | Opus：Worker の 30 秒は `waitUntil` の上限で、read refresh が可能 |
| 未確定行の置き場 | Fable：本体 | `__intents` | Opus：pushdown SQL から隠せない |
| パーティショニング | Fable：表ごとの PK range | shard key 優先 | Opus：関連行が別シャードに分かれる |
| 非 shard key の検索 | Fable：scatter | グローバル index | Opus：scatter の QPS は N に比例しない |
| 読み取り時刻 | Opus：未来の `T` | 最初のシャードの HLC | Fable：`δ` は HLC の前進に食われる |
| intent の通過 | Opus：タイムアウトで通過 | push による確定 | Fable：片方だけ見える反例 |
| 検証の対象 | Opus：変更ログのみ | intent も照合 | Fable：write skew の反例 |
| commit の主導 | Fable：Percolator | anchor 主導 | Opus：DO が durable なので TTL が要らない |
| 過去版の保持 | Fable：hist テーブル | rollback-read | Opus の案に Fable が条件を付けた |
| UNIQUE | Fable：論理制約化 | SQLite の制約を維持 | Opus：DELETE して INSERT する逆適用を workerd で確認 |
| グローバル index の既定 | Opus：非同期 | 同期 | Fable：偽陰性は本体の検証で補えない |
| watermark | Fable：KV で配布 | `now − 30 秒` | Opus：KV の伝播と lease が噛み合わない |
| 取引の競合 | 全部楽観 | 書き込みは行ロック | ホットな行で失敗率が 78〜98% に達した |
| ロックの待ち | Opus：wait-die | wound-wait | Opus の訂正：後から来る取引が全部死ぬ |
| prepare とロック | 悲観の取引は待つ | 待たずに abort | Fable：待つと閉路ができる |
| `c_target` による短縮 | Fable：既定 2 ラウンド | 採用せず | Opus：HLC が物理時刻で進むので `c_target` は prepare 時点でほぼ超過する |
| refresh の省略条件 | Opus：読んだ行に書く場合 | pk 等値の読みのみ | Fable：phantom の反例 |
| anchor の `c` | Opus：`max(全 prepare_ts)` | anchor が HLC に取り込む | Fable：検証が `c` に届かない反例 |
| 大口テナントの split | Opus：`(table, pk)` で切る | UNIQUE をグローバルへ昇格 | Fable：DO を跨ぐ重複の反例 |
| HLC の永続化 | Fable：読み手が進めるたびに 1 行 | 上限の先取り | Opus：読み取りの quorum 待ちを避ける |
