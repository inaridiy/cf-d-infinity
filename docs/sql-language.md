# SQL 言語仕様

状態：試作に実装済み。互換性は本物の SQLite との比較で確かめた
作成日：2026-11-06

## 結論

この DB は SQLite 互換である。
既存の `@libsql/client` は接続先の URL を変えるだけで動き、Drizzle の libSQL と D1 のドライバも動く。
シャードの実行器が SQLite そのものであり、シャードを跨ぐ文も Worker の中の SQLite (WASM) で元の SQL を実行するので、式の意味を再実装していない。

Postgres 互換にしなかったのは、Postgres の構文、型、関数の意味を SQLite の上に再現することになるからである。
互換性の水準がその再現の精度で決まってしまう。

分析の層だけは方言が異なる。
分析クエリは DuckDB が実行するので DuckDB 方言で書き、別の API から発行する。
自動で振り分けない理由は、方言だけでなく鮮度 (2〜5 分) も変わるからである。

## 文の実行場所

利用者は実行場所を意識しなくてよい。
プランナが次の順に選ぶ。

| 文の形 | 実行場所 | 代表的なレイテンシ |
|---|---|---|
| 全表の shard key が同じ値に固定される | そのシャードの SQLite | 31 ms |
| 単純な集約、`ORDER BY LIMIT` | 各シャードで部分実行し Worker で合成 | 63〜68 ms |
| それ以外 | 条件を押し下げて行を集め、Worker の SQLite で元の SQL を実行 | 77〜95 ms |
| シャードを跨ぐ書き込み | 同じく Worker の SQLite で実行し、行の変更を取引で確定 | 105 ms から |

レイテンシは本番の実測で、クライアントと Worker の往復 (17 ms) を含む ([benchmarks.md](./benchmarks.md))。

Worker へ集める行数には上限 (既定 20 万行) があり、超えるとエラーになる。
大きな集計は分析の層へ回す。

## 互換性の確認

SQLite 自身の適合試験 sqllogictest と、本物の SQLite との差分テストを使った。
結果は実装の変更後に毎回取り直す。

| 試験 | 内容 | 結果 |
|---|---|---|
| sqllogictest `select1`〜`select5` | 複雑なサブクエリ | 8,884 クエリが 4 シャードで一致 |
| sqllogictest `random`、`index` | 式、集約、group by、index | 約 17 万クエリが一致 |
| sqllogictest `evidence` | SQLite の文書の各文 | 本物の SQLite と同じ結果 |
| 差分テスト (手書き) | 書き込み、制約、取引、スキーマ変更 | 全スクリプトが一致 |
| 差分テスト (乱数) | 200 シード、3 万文 | 全文が一致 |
| 本番 | `@libsql/client` を通した `select1` | 1,000 クエリが一致 |

`evidence` の `aggfunc` の 4 件は、本物の SQLite でも試験の期待値と一致しない。
試験が書かれた版との差である。

差分テストの検出力は、既知のバグを再導入して確かめた。
「黙って間違う」バグの多くはこの過程で見つかったので、実行経路を変えるときは必ず全部を流す。

## SQLite との差分

### 使えないもの

| 項目 | 理由 |
|---|---|
| TEMP 表、`ATTACH`、仮想表 (`CREATE VIRTUAL TABLE`。FTS5 など) | DO の SQLite が許可しない、または Worker の SQLite に含まれない。TEMP 表と仮想表は `unsupported:` で断る |
| trigger、生成列、`CREATE TABLE ... AS SELECT` | 検査が足りないので断る。エラーは `unsupported:` で始まる |
| `ALTER TABLE` の `RENAME COLUMN` と `DROP COLUMN` | 同上 |
| 主キー、shard key、shard key を含まない UNIQUE の列の、BINARY 以外の照合順序 | 同上。行と行き先のシャードを値で決めるので、照合順序で等しい値を同じ行として扱えない。列の定義に書いても (`a TEXT COLLATE NOCASE PRIMARY KEY`)、表の制約に書いても (`PRIMARY KEY (a COLLATE NOCASE)`) 同じである。`COLLATE BINARY` と書いたものは通る |
| 主キーの列に NULL のある行 | 断る。SQLite は INTEGER でない主キーに NULL をいくつでも入れられるが、行を主キーの値で名指しするので区別できない。`INTEGER PRIMARY KEY` に NULL を渡すと rowid が入るのは SQLite と同じである |
| 書き込みの文の中の `sqlite_master` と PRAGMA の関数 (`pragma_table_info(...)` など) | 断る。読みの文の中なら、利用者の表定義について答える (シャードの内部の表は見えない) |
| shard key を含まない、UNIQUE の部分 index と式の index | 断る (`unsupported:`)。シャードをまたぐ UNIQUE の index の表は、列の値だけで項目を作るからである |
| 文の `OR FAIL` と `OR ROLLBACK` (INSERT と UPDATE)、制約に書いた `ON CONFLICT` (ABORT 以外) | 断る (`unsupported:`)。OR FAIL は衝突した行より前の行の変更を残し、OR ROLLBACK は取引を終え、制約の ON CONFLICT は文の既定の衝突の処理を変える。どれも、D∞ はまだ SQLite と同じに運べない (2026-11-15 に差分の検査が見つけた)。断るのは文の形と表定義で決まる。文に書く `OR IGNORE`、`OR REPLACE`、`REPLACE`、`ON CONFLICT DO` は使える |
| 名前が `__dinf_` で始まる表 | 断る。D∞ が文に足す CTE の名前 (型つきの読みの `__dinf_r`) と取り違えないためである。列の名前は予約しない。`$` で始まる列名は、行イメージが列名を持たなくなったので使え、`__dinf_` で始まる列名は、文に列の別名を足さなくなったので使える (2026-11-14) |

### DO の SQLite の制限

DO の SQLite には、文の長さ (100 KB)、束縛の変数 (100 個)、複合 SELECT の項 (5 つ、実測) の上限がある。シャードは、実行する文を
束縛のための書き換えの後の形で測り、超える文を実行せずに断る。Worker はそれを受けて、文を基準経路 (Worker の SQLite) で実行し直す。
上限に当たるかは、行がシャードにどう分かれているかで変わるので、断ると成否が置き場所で決まるからである (`src/shard-limits.ts`)。
多行の INSERT は、変数の数と文の長さが収まるように Worker が分けて送る。

| 制限 | 扱い |
|---|---|
| 文の長さ 100 KB、束縛の変数 100 個、複合 SELECT の 5 項 | 基準経路で実行し直す。基準経路では、上限を超える条件は押し下げずに表を丸ごと集めるので、集める量の予算 (16 MB) を超える表では失敗する |
| 文字列と BLOB は 1 つ 2 MB まで | 引数で超える文は基準経路で実行し直す。2 MB を超える値は、シャードに保存できないのでエラーになる |
| `LIKE` と `GLOB` のパターンは 50 バイトまで | エラーになる |
| SQL 関数の引数は 32 個まで | エラーになる |

### 値

| 項目 | 差分 |
|---|---|
| 64 ビットの整数 | 差分はない (2026-11-14 から。`test/int64.test.ts`)。±2^63 の端まで、保存し、引数で渡し、SQL の中で計算し、結果で返し、分割で運び、エクスポートして取り込める (`test/export-import.test.ts`)。Hrana は 10 進の文字列 (`integer`) で運ぶ。D1 互換の API、Service Binding、HTTP の `/sql` と `/batch` の結果の INTEGER は、`intMode` で形を選ぶ (@libsql/client と同じ。2026-11-15 から)。既定の `"number"` は D1 と同じく JS の数で返し、±(2^53 - 1) を超える INTEGER を含む結果は、隣の値に丸めずに誤りにする。`last_row_id` は、`"number"` で JS の数にできなければ (2^53 を超える rowid を明示して入れたとき)、丸めずに「返す rowid がない」として扱う (Service Binding と HTTP の `lastInsertRowid` は `null`、D1 の `meta.last_row_id` は行を入れなかった文と同じ 0)。RETURNING のない INSERT は、SQLite と同じく成功する。`"bigint"` は INTEGER をすべて `bigint` で、`"string"` はすべて 10 進の文字列で返す。指定は `connect(env.DINF_DB, { intMode: "bigint" })`、HTTP の本文の `"intMode": "string"` である。HTTP は JSON なので `"bigint"` を断る。CLI (`npx cf-d-infinity sql`) は、`--param` の数字と、表と `--json` の INTEGER を、桁を落とさずに運ぶ |
| 引数の型 | 差分はない。Hrana は要求に書いた型のまま束縛する (`integer` は INTEGER、`float` は REAL。sqld と同じ。@libsql/client は JS の数を `float`、BigInt と真偽値を `integer` で送る)。型の印と値の JS の型が合わない引数 (`float` の文字列、`integer` の JS の数、base64 でない `blob`、知らない型など) は、文を実行する前に、引数の番号か名前を書いた `ARGS_INVALID` の誤りにする (2026-11-16 から。sqld が引数の誤りに使う code である)。誤りはその要求だけのもので、同じ pipeline のほかの要求と取引は続く。sqld は、そういう本文を JSON として読めず、pipeline の全体を HTTP 400 で断る。D1 互換の API と Service Binding は、安全な整数の JS の数を INTEGER、ほかの数を REAL、`bigint` を INTEGER として束縛する。安全な範囲の外の整数の値の JS の数 (2^60 など) は、渡された double のまま REAL である (INTEGER の列では、型の親和性が整数にする)。JS の数では `5.0` と `5` を見分けられないので、どちらも INTEGER である。型を正確に渡すには、Service Binding の `queryElements(sql, params)` に、引数を要素 (`i5`、`r5.0`、`tabc`、`b00FF`、`null`。エクスポートと同じ形、`docs/storage-format.md`) で渡す (2026-11-16 から。CLI の `--param 5.0` もこれで REAL のまま届く)。`Uint8Array`、`ArrayBuffer`、型つき配列は、そのバイトの BLOB である (D1 は型つき配列を要素ごとに 1 バイトへ切る)。数の配列 (`[65, 66]`) は、D1 互換の API だけが、D1 と同じく、そのバイトの BLOB として受け付ける (2026-11-16 から。D1 の結果は BLOB を数の配列で返すので、それを引数に戻すコードが動く)。受け付けるのは、どの要素も 0 以上 256 未満の JS の数である配列で、空の配列は空の BLOB、整数でない要素は 0 へ向けて切り捨てる (`1.5` は 1)。範囲の外の数 (`256`、`-1`)、NaN、数でない要素は、D1 と同じく `bind` が断る。穴のある配列 (`[, 1]`) は、D1 は `bind` で通して実行のときに落ちるが、D∞ は `bind` が断る (Miniflare 4.20260730.0 のローカルの D1 で測った)。Service Binding (`connect(env.DINF_DB)` の `bind` を含む) と HTTP は、数の配列を断る。HTTP の `/sql` と `/batch` の本文の JSON では、数の literal の型を文面で決める (2026-11-16 から)。数字だけで書いた literal は INTEGER で、64 ビットに収まれば元の数字のまま正確に読む (`9223372036854775807` は丸めない。JS のクライアントが `JSON.stringify` で書いた 2^60 も、数字だけなので INTEGER である)。小数点か指数のある literal (`5.0`、`1e5`、`1e20`) は REAL である。64 ビットに収まらない数字だけの literal は、SQLite がその literal を読むのと同じく REAL である。JS のクライアントの `JSON.stringify` は `5.0` を `5` と書くので、REAL の 5.0 を HTTP で渡すには、本文を文面で書くか、Hrana の `float` を使う。数の literal の元の文面を読めない実行環境 (JSON.parse の source text access のない V8) では、D1 互換の API と同じ規則 (安全な整数は INTEGER、ほかは REAL) で読む。D1 互換の API、Service Binding、HTTP は、値でない引数 (object など。Service Binding と HTTP では配列も。JSON には BLOB を書く形がない) と 64 ビットに収まらない `bigint` を、文を実行する前に誤りにする (`parameter 2 is an array; ...`)。DO の SQLite は JS の数を REAL として束縛し、BigInt を束縛できないので、D∞ が文の中の引数を `(CAST(? AS INTEGER)+0)` に包んで、型を保つ (2^53 を超える INTEGER は 10 進の文字列を包む)。値は、どの経路で答えても、分割で運んでも、型を変えない |
| 結果の数の型 | 差分はない (2026-11-14 から)。整数の値の REAL (5.0 など) は、Hrana の `float` で返る (sqld と同じ)。シャードは結果を型つきで読む (INTEGER と TEXT に印を付けて運ぶ)。REAL の無限大は、Hrana が JSON で運べないので、クライアントの誤りになる (sqld も同じ) |
| NUL (U+0000) を含む TEXT | 差分はない (2026-11-14 から)。どの経路で答えても、全部を返す。Worker の SQLite のドライバは TEXT を最初の NUL で切るので、D∞ は TEXT を BLOB にして読む |
| HTTP の `/sql` と `/batch` の JSON の BLOB と無限大 | 値を JSON の値のまま書くので、BLOB はバイトの番号を鍵にした object (`{"0":0,"1":255}`)、REAL の ±無限大は `null` になる。`hex()` か `quote()` で読むか、Hrana を使う。D1 互換の API と Service Binding は、structured clone で BLOB を `Uint8Array` のまま返す |
| 暗黙の rowid と `INTEGER PRIMARY KEY` の採番 | 一意で増えるが連続しない。削除された番号は再利用しない。接続を跨ぐと順序も保証しない |
| 文の結果の `lastInsertRowid` (D1 の `meta.last_row_id`) | 文が最後に入れた行の rowid で、行を入れなかった文は `null` (D1 の `meta` は 0) である。SQLite の `last_insert_rowid()` と同じく、`REPLACE` が消してから入れた行は入れたことになり、UPSERT の `DO UPDATE` で更新した行と、`OR IGNORE` や `DO NOTHING` が入れなかった行は、ならない。文をどの経路で実行しても同じ値になる (2026-11-16 から。`test/last-insert-rowid.test.ts`、差分の検査が比べる)。違いは 2 つある。SQLite の接続の値は文をまたいで残るが、D∞ は文ごとに返し、`UPDATE` と `DELETE` は `null` である。rowid が行のキーでない表 (`INTEGER PRIMARY KEY` でない主キーの表) の行は、rowid を返さない。D∞ の行は、シャードをまたいで意味のある、そういう rowid を持たないからである |

### 制約

| 項目 | 差分 |
|---|---|
| 外部キー | 強制しない。SQLite の既定と同じである。`PRAGMA foreign_keys = ON` は効かない |
| `INSERT OR IGNORE`、`OR REPLACE`、`ON CONFLICT`、`UPDATE OR IGNORE`、`UPDATE OR REPLACE` | 衝突する行がどのシャードにあっても、SQLite と同じ結果になる。1 シャードで解決できないときは、文を Worker の SQLite で実行し、変更後の行と主キーか UNIQUE の値が同じ行を集め足して、SQLite に解決させる |
| 部分 index、式 index | シャード内の index になる。UNIQUE なら shard key を含む必要がある |
| 予約された名前 | `sqlite_` で始まる名前と、内部の表が使う名前 (`__txn`、`__meta`、`__gidx_` で始まる名前など) は作れない |
| 1 取引の大きさ | 1 シャードに書く変更は、変更前と変更後の行を合わせて UTF-8 で 1 MB まで。超える取引は commit の前に断る |

### 取引

既定は Serializable である。
本物の SQLite は書き込みを 1 本に直列化するが、ここでは行ロックと楽観的な検証を組み合わせている。

| 開始の文 | 読み取り | 書き込み | `COMMIT` の失敗 |
|---|---|---|---|
| `BEGIN IMMEDIATE`、`transaction("write")` | 主キーの読みは行ロックを取り最新を読む | 文の時点で行ロックを取る | ほぼ起きない |
| `BEGIN`、`transaction("deferred")` | 開始時点のスナップショット | 文の時点で行ロックを取る | 読んだ行が変わると `SQLITE_BUSY` |

これは本物の SQLite の意味と同じ形である。
`BEGIN IMMEDIATE` は最初に書き込みの権利を取り、素の `BEGIN` は読みから書きへ移るときに `SQLITE_BUSY` になり得る。
読んでから書く取引は `BEGIN IMMEDIATE` を使うのがよい。

ロックは行ごとで、待ちは SQLite の busy_timeout に相当する 5 秒が上限である。
書き込みのロックは、文の経路によらず、文が書いた行のすべてに取る。
主キーで 1 行に絞る文はシャードが文を実行するときに、範囲や条件で書く文 (行を集めて Worker の SQLite で実行する文) は、文を実行した後に書いた行ごとに取る。
後者の文は、取引の読み取り時刻のスナップショットで行を読んで計算するので、読み取り時刻とロックの間に別の接続が同じ行を確定していれば、`COMMIT` が `SQLITE_BUSY` になる。
`BEGIN IMMEDIATE` でも同じである (最新を読むのは主キーの読みだけである)。
行ロックの待ちは wound-wait で、古いものが先に行を取る。
古さは、取引なら最初にロックを取った時刻、autocommit の書き込みならシャードが受けた時刻で比べ、同じミリ秒なら取引を古いものとする (autocommit はロックを持たず、取引の行を奪わずに待つ)。
autocommit の文は内部でリトライし、`batch` も文が全部分かっているので内部でやり直す (DDL を含む `batch` は、次の「取引の中の DDL」を参照)。
`BEGIN` で始めた対話的な取引のリトライはアプリの責任である。

条件で読んだ範囲は、条件に関わる行の変更だけを競合にする。
ただし条件をシャードへ押し下げられない読みは表単位で検証するので、関係のない行の書き込みでも衝突する。

autocommit の読み取りと取引の最初の読み取りでは、開始前に確定した書き込みが別の接続のものでも必ず見える。
複数シャードの読み取りは対象シャードの時計の最大値を読み取り時刻にし、1 シャードの読み取りは未解決の取引を決着させた後の時刻で読むからである。

例外は取引の 2 文目以降である。
読み取り時刻を進められなかった取引は最初のスナップショットのまま読み続けるので、別のシャードに後から確定した書き込みが見えないことがある。
Serializable は保たれ、書き込みがあれば `COMMIT` の検証で競合になる。

取引の途中で範囲の移動 (分割) があっても、取引は続けられる。
動いた行への文は、新しい持ち主へ送る。
動いた範囲を移動の時刻より前の読み取り時刻で読む文は、それまでの読みが今も成り立てば読み取り時刻を進めて読み、成り立たなければ競合 (`SQLITE_BUSY`) になる。
どちらも、移動がなく、同じ行が別の接続に書かれたときと同じ扱いなので、答えは行の置き場所で変わらない。
`not owner` で失敗することはない。
(2026-11-15 に決めた約束である。今のコードが守るのは一部である。動いた行への文は、範囲表を取り直して新しい持ち主へ送り、`not owner` では失敗しない。`Db.begin()` の取引は、分割の前に動いた範囲を読んでも書いてもいなければ、確定まで通る。まだ守らないのは 3 つで、どれも読んだ行が変わっていなくても失敗する。分割の前に動いた範囲を読んだ取引は、その範囲を移動の時刻より前の時刻で読む文が `read too old` で失敗する。分割の前に動いた行を書いたか、行ロックを取って読んだ取引は、次の文が `SQLITE_BUSY` (競合) で失敗する (どちらも `test/open/transaction-across-split.test.ts`)。SQL の `BEGIN` の取引は、分割の後に動いた行を書くと、`COMMIT` が `SQLITE_BUSY` (`read too old`) で失敗する (`test/open/locking-transaction-commit-after-split.test.ts`)。)

### 取引の中の DDL

取引の中で DDL を実行すると、先にその取引を確定し、DDL の後の文は新しい取引になる。
MySQL と同じ扱いで、SQLite とは違う。
DDL は全シャードへの適用を伴い、取り消せないからである。
先に確定しないと、手元に溜めた書き込みより先に DDL が効く。表を作り直す移行 (新しい表を作る、行を写す、古い表を消す、名前を変える) では、行が失われる。

このため、次の点が SQLite と違う。

- `ROLLBACK` と `ROLLBACK TO` が戻すのは、最後の DDL より後の文だけである。SAVEPOINT も DDL で消える。
- 先に確定できなければ (競合など)、DDL は実行せず、取引は終わる。エラーは DDL の文に返る。
- `batch` (D1 互換 API と Service Binding) は、DDL の位置で区切り、区切りごとに 1 つの取引で実行する。DDL を含む `batch` は「全部か無か」にならない。途中で失敗するとそこで止まり、それより前の区切りと DDL は効いたまま残る。
- 取引が読んだ表を `DROP TABLE` すると (表を作り直す移行の最後)、その表への書き込みを止め、取引が読んだ後に別の接続が書いていないかを全シャードで確かめてから消す。書かれていれば、消さずに競合 (`SQLITE_BUSY`) で失敗する。行は失われないが、移行は失敗し、作りかけの新しい表が残る。アプリの書き込みが多い表を作り直すときは、書き込みの少ない時間に流す。

Worker の中から使う `Db` の `transaction(fn)` と `begin()` が返す取引オブジェクトの中では、DDL を断る (`unsupported:`)。
`transaction(fn)` は競合すると関数を丸ごと実行し直すので、DDL の前に確定した分を 2 度実行してしまうからである。
SQL の `BEGIN`、Hrana の取引と batch、D1 互換の `batch`、Service Binding の `begin()` と `batch` では、上の規則で実行する。

取引が最初に読むか書くかした後で、別の接続が表定義を変えた場合、その取引は古い表定義のまま続く。
後から作られた表は見えない (`no such table`)。
SQLite で、読み始めた取引から、後で作られた表が見えないのと同じである。
その取引の以後の文と `COMMIT` は、新しい表定義を適用したシャードで断られる (`SQLITE_BUSY`)。取引をやり直す。

### DDL

DDL は全シャードへ適用してから完了を返す。
適用が遅れると、古い表定義の Worker が書いた行が後から消えるからである。
シャード数に比例して時間がかかるが、頻度の低い操作なので許容する。

SQLite が拒否する文は、記録する前に断る。
Meta が自分の SQLite の空の表で実行して確かめるので、`NOT NULL` で既定値のない `ADD COLUMN` や、重複した列名はここで止まる。
行があるシャードでだけ失敗する文 (重複のある列への UNIQUE index、既存の行が反する `CHECK` 付きの `ADD COLUMN`) は、取り消す。
適用できなかったシャードが取り消しを求め、全シャードが元の表定義に戻り、文を出した側には SQLite のメッセージが返る。

シャードの増設の途中は、DDL を記録しない。
最大 60 秒待ち、終わらなければ、出し直すよう求める。
逆に、index を作っている間と、DROP の前に表への書き込みを止めている間は、増設が始まらない (Autoscaler は次の判断のときに始める)。
運べない大きさのグループ (16 MB を超える) で止まった増設は、終わるまで表定義の変更を止め続ける (`docs/scaling.md`)。

shard key を含まない列への `CREATE UNIQUE INDEX` は、既存の行から index の表を埋める。
その間、その表への書き込みは待つ (最大 30 秒。待ち切れなければ `SQLITE_BUSY` で、やり直してよい)。
行が止まっているので、埋める作業と並行する書き込みが、index を壊すことはない。index は、出来上がって公開されるまで、どの文からも見えない。
1 回の要求で埋めきれない大きさの表では、エラーで止まり、index は作られず、表は元のままである。CREATE TABLE で宣言した UNIQUE は、埋める作業が要らない。
作る側が途中で止まっても、書き込みの禁止は 5 秒のうちに解ける (作る側が、作業の間、期限を延ばし続ける)。延ばし続けても、5 分で打ち切る。

## 分散のための DDL

SQLite の構文に、分散のための宣言は足していない。行は PRIMARY KEY の先頭の列のハッシュで分散し、PRIMARY KEY のない表は
rowid で分散する。先頭の列が同じ行は、表をまたいで同じシャードに載る。

```sql
CREATE TABLE orders (
  tenant_id INTEGER NOT NULL,
  id        INTEGER NOT NULL,
  status    TEXT,
  PRIMARY KEY (tenant_id, id)   -- テナントの行が 1 つのシャードに集まる
);
```

既存のスキーマはそのまま流せる。関連する行を同じシャードに置きたいときは、それを決める列を PRIMARY KEY の先頭に置く。
先頭の列の値の種類が少ない PK (`(type, id)` など) は、同じ値の行が 16 MB を超えると、そのシャードを分割できなくなる。

index の配置は宣言しない。
index は、shard key を含むかどうかにかかわらず、各シャードの中の SQLite index になる。
shard key でない列で引く読みは全シャードへ送り、各シャードが自分の index で引く。
例外は一意性である。
shard key を含まない UNIQUE は 1 つのシャードでは確かめられないので、グローバル index (index のキーで配置する表) を作り、行と同じ取引で保守する。
グローバル index を持つ表の書き込みは 2PC になる。
グローバル index は一意性の保証と、INSERT が衝突し得る行の場所を知るために使い、読みの経路には使わない。

## クライアント

| 種類 | 使い方 |
|---|---|
| `@libsql/client` | `createClient({ url, authToken })`。`https://` なら Hrana over HTTP、`wss://` なら Hrana over WebSocket (hrana2) で話す |
| Drizzle | libSQL または D1 のドライバ。移行 (`migrate`) の前に、記録の表を `drizzleMigrationsTable()` (`cf-d-infinity/client`) の文で作る |
| D1 互換 API | `prepare`、`bind`、`batch`、`withSession` |
| Worker の中から直接 | `Db` クラスの `query`、`transaction` |

Drizzle は、移行の記録の表を `id SERIAL PRIMARY KEY` で作り、記録の INSERT で id を省く。
SERIAL は INTEGER ではないので、SQLite では id に NULL が入る。
この DB は主キーに NULL のある行を断るので、Drizzle が作る前に、id を `INTEGER PRIMARY KEY` にした同じ表を作っておく。

```ts
import { drizzleMigrationsTable } from "cf-d-infinity/client";
await client.execute(drizzleMigrationsTable());          // libSQL。D1 互換なら db.prepare(...).run()
await migrate(drizzle(client), { migrationsFolder: "./drizzle" });
```

better-sqlite3 のような同期 API は提供できない。
ネットワークを跨ぐ DB なので、呼び出しは必ず非同期になる。

Hrana の対話的な取引は、HTTP では取引の状態を baton に載せて持ち回る。
Worker が状態を持たないので、どの Worker が受けても続きを実行できる。
WebSocket では接続を受けた Worker が取引の状態をメモリに持つ。

WebSocket の接続中のメッセージは Worker のリクエストとして課金されない。
シャードへの呼び出しも接続ごとに RPC の session にまとめ、2 秒使わなければ閉じる。
文を多く発行するサーバーからは `wss://` を使うと、1 文あたりのリクエスト課金がほぼなくなる。
session にまとめた呼び出しが本番で別に課金されないことは、まだ計測していない。

## パーサの役割

文の意味は SQLite が解釈するので、Worker のパーサは経路の決定にしか使わない。
パーサは自前で (`src/sql/parser.ts`)、SQLite の文法 (parse.y) に合わせてある。
受け付けるかどうかは、文の一覧を本物の SQLite の構文の判定と比べて確かめている (`test/parser.test.ts`)。
構文の誤りは、SQLite と同じ形の文言 (`near "x": syntax error`、`incomplete input`、`unrecognized token: "x"`) で断る。
文面は、解析の前に書き換えない。
結合の語 (`left`、`right`、`full`、`inner`、`outer`、`cross`、`natural`) は、SQLite と同じ場所で名前として読む: 表、列、index、CTE、`AS` の後ろの別名では名前になり、AS のない別名、型の名前、照合順序の名前、DEFAULT の後ろでは名前にならない (`FROM a LEFT JOIN b` の LEFT は結合の語である)。
関数の引数の `ALL` (`count(ALL x)`) と、空の並びの `x IN ()` も、そのまま読む。
別名のない結果の列名は、SQLite と同じく、式の文面である (`left + 1`、`count(ALL x)`、`x IN ()`)。
2026-11-14 までは、この 3 つと CR を、解析の前に文面を書き換えて読んでいた。語の間に注釈があると見誤り (`a LEFT /* c */ JOIN b` が内部結合になった)、列名も SQLite と違っていた。
結果と列名を SQLite と比べる試験は `test/contextual-words.test.ts` にある。

手書きの解析が表の参照を見落とすと、空の表として黙って誤った結果を返す。
そこで Worker の SQLite では、実行の前に `EXPLAIN` で本物のプランナが開く表を確かめ、足りない表を読み足している。
