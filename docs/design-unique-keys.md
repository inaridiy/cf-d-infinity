# UNIQUE をキーの行に一本化する設計

状態：設計。実装はまだない。モデルは M22 (`specs/m22_unique_keys.qnt`) にあり、結果は [specs/README.md](../specs/README.md) の M22 の節に書いた。持ち主の判断が要ることを末尾にまとめた
作成日：2026-11-14
前提：[design-subslots.md](./design-subslots.md)、[design-catalog-epoch.md](./design-catalog-epoch.md)、[design-values.md](./design-values.md)、[specs/README.md](../specs/README.md) の M12、M16、M18 から M21

コードの行番号は `b9aa6b2` (ブランチ `subslots`) のもので、`src/` と `test/` は `packages/cf-d-infinity/` の下を指す。
`src/shard/*` は別の作業で書き直している最中なので、名前は変わり得る。
今のコードの挙動についての記述は、コードを読んだ結果である。
SQLite の挙動についての記述は、node:sqlite (SQLite 3.51.3) で小さなスクリプトを流して確かめた。
試験は走らせていない。

## 結論

主キー以外の UNIQUE を、1 種類の仕組みで守る。
制約ごとに、値の正規形を主キーにした内部の表 (以下 **キーの表**) を持ち、その値を持つ行の主キーを 1 行に書く (以下 **キーの行**)。
値を書く取引は、行と一緒にキーの行を書く。
キーの行も行なので、置き場所、piece、持ち主の確かめ、intent、ロック、2PC は、行と同じ規則に乗る。

| 要素 | 決定 |
|---|---|
| キーの表 | 制約ごとに 1 つ、`__ukey_<n>(k TEXT PRIMARY KEY, pk TEXT NOT NULL, sk TEXT NOT NULL)`。`n` は制約を作った epoch と順番から決める番号で、表と index の名前は使わない。形は今の `__gidx_<index>` と同じである |
| キー `k` | index の列ごとの、格納された値の正規形を並べたキー文字列 (`keyString`)。TEXT は、その列の照合順序で正規化する。どれかの列が NULL の組と、部分 index の条件に合わない行は、キーの行を持たない |
| 照合順序 | 組み込みの 3 つだけである。BINARY はそのまま。NOCASE は ASCII の A から Z を小文字にし、最初の NUL から後ろは比べず、長さ (UTF-8 のバイト数) だけを比べる。RTRIM は末尾の空白 (U+0020) だけを落とす |
| キーを作る場所 | 値と部分 index の条件は、SQLite が捕捉の trigger の中で計算する (式の index も同じ)。JS は、届いた要素を照合順序で正規化するだけである |
| 置き場所 | shard key の列を BINARY で含む制約 (以下 **同居の制約**) は、キーの行の shard key をテナントの shard key にする。token はテナントの slot のブロックに入る。ほかの制約は、今の `__gidx` と同じく `k` の hash で決める |
| ロックと intent | 値を取るキーの行は「ない」から行の主キーへ、手放すキーの行は行の主キーから「ない」へ書く。prepare は、行と同じく、ほかの取引の intent がないこと (ロック) と、確定した値が取引の読んだものと同じことを確かめる。ほかの取引の未確定の値は、キーの表の主キーの一致で見つかる |
| シャードの中 | テナントが分かれていなければ、同居の制約のキーの行は行と同じシャードにある。追加の RPC はなく、1 シャードの確定 (`commitLocal`、`execAuto`) のまま進む |
| シャードをまたぐ | キーの行の持ち主が別のシャードなら、その持ち主が 2PC の参加者になる (今の `__gidx` と同じ) |
| 物理の index | シャードの SQLite の index は一意でない index にする。検索に使う。M22 は、一意のままにすると、piece ごとの適用で確定した取引が適用できなくなることを示した |
| 文の意味 | 衝突を決めるのは、いつも SQLite である。シャードは、捕捉した変更を順に、キーの衝突を行ごとに確かめ、衝突があれば文を取り消して `NeedsReference` を投げる。基準経路の Worker の SQLite は利用者の DDL のとおりの UNIQUE を持ち、違反の誤り、OR IGNORE、REPLACE、ON CONFLICT を決める |
| piece | キーの行は、位置 (キーの表の名前, キーの行の主キー) で piece に入り、piece と一緒に動く。子は、キーの位置を覆う piece が届いてからキーを確かめる。M20 の 3 つの規則は要らない |
| index の作成 | M21 の `build` の遷移にする (シャードの中の UNIQUE も)。行を止め、進める側がキーの行を書く。重複は、キーの行の持ち主で見つかる |
| 消えるもの | `__gidx_*`、シャードの SQLite の UNIQUE index、`uniquePending` と試適用、M16、M20 の規則、UNIQUE のための span の広げ方 (`uniqueReads`)、分かれたテナントの既存の行の突き合わせ (design-subslots.md の判断 5)、表定義の 4 つの拒否 |
| 未解決の問題 31 | 表の制約と CREATE INDEX の列の名前と照合順序は、DDL を Worker の SQLite で実行して `PRAGMA index_list` と `PRAGMA index_xinfo` から読む。構文木の読みは、それと突き合わせる検査になる |
| 段 | 4 段。検査、キーの関数と列の解決、シャードをまたぐ UNIQUE の置き換え、シャードの中の UNIQUE の置き換え。piece の部分は design-subslots.md の段 2 と段 4 の受け入れに入れる |

刷新の提案 (2026-11-14 の、作り直しの 5 つの案。リポジトリには置いていない) の 5 から、6 点ずれる。

1. キーの識別子は、表と index の名前ではなく、カタログが制約に付ける番号にする。名前を使うと、`ALTER TABLE ... RENAME TO` でキーの行を全部書き直すことになり、同じ名前で作り直した表の古いキーと見分けられない。表の制約の index の名前は SQLite が付ける (`sqlite_autoindex_<表>_<番号>`) ので、表の名前に引きずられる。
2. キーの行は、全部の制約で 1 つの表ではなく、制約ごとの表に置く。M21 の `abort` は、`prepare` が作った表を名前で消す。1 つの表にまとめると、index の作成の取り消しと DROP INDEX が、行の数に比例する削除になる。
3. 同居の条件は「UNIQUE が shard key を含む」ではなく「shard key の列を、index の中で BINARY で比べる」である。`UNIQUE (tenant COLLATE NOCASE, code)` では、テナント 'A' と 'a' の行がぶつかるが、2 つは別の slot にある。この制約は、`k` の hash で置く。
4. 追加の RPC はないが、追加の書き込みはある。値の変わるキーごとに、キーの行を 1 行書く (値を変える UPDATE は、消すのと入れるのとで 2 行)。代わりに、試適用 (`uniquePending` と `checkUnique`) の書き込みと巻き戻しがなくなる。差し引きは段 3 で測る。
5. 刷新案は、文の意味 (衝突の誤り、OR IGNORE、REPLACE、ON CONFLICT) を誰が決めるかを書いていない。物理の index が一意でないと、シャードの SQLite は衝突を知らない。衝突があれば基準経路で実行し、そこで SQLite が決める (「文の意味」の節)。衝突の対象に主キー以外の UNIQUE を名指しする `ON CONFLICT (...)` は、一意でない index ではシャードの SQLite で翻訳できないので、文の形で最初から基準経路になる。持ち主の判断 1 に挙げた。
6. 物理の index は「一意でなくてよい」のではなく、一意であってはならない。M20 の決着させてから切る規則を消すと、piece ごとの適用の途中で、シャードの物理の表に同じ値の行が一時的に 2 つできる。見える状態は UNIQUE を守っているが、一意の index は挿入を断る (`m22_red_physical_unique`)。

## キーの形

### キーの表と行

```ts
/** 表定義に足す。今の uniques (シャードの中) と globalIndexes (シャードをまたぐ) の 2 つを置き換える。 */
interface UniqueKeyDef {
  /** 制約の番号。キーの表は `__ukey_<id>`。 */
  id: number;
  /** index の列。式の列は null で、式は exprs にある。 */
  columns: (string | null)[];
  /** 列ごとの照合順序 (PRAGMA index_xinfo の coll)。 */
  collations: ("BINARY" | "NOCASE" | "RTRIM")[];
  /** 式の index の式と、部分 index の条件 (SQL の文面)。 */
  exprs?: (string | null)[];
  where?: string;
  /** 同居の制約か。shard key の列を BINARY で含む。 */
  colocated: boolean;
  /** 誤りの文言に使う、SQLite が報告する名前 (列の並びか、index の名前)。 */
  name: string;
}
```

キーの行は `(k, pk, sk)` である。
`k` は正規形のキー文字列、`pk` はその値を持つ行の主キーのキー文字列 (holder)、`sk` はキーの行の shard key のキー文字列である。
`sk` は、同居の制約ではテナントの shard key、ほかの制約では `k` と同じである。
キーの行の主キーは `k` だけなので、同じ値の 2 つ目のキーの行は、キーの表の主キーが断る。

### 正規形

`k = keyString(列ごとの正規形)` で、`keyString` は今のもの (`src/keys.ts:99`) を使う。
数の書き方は今のまま、INTEGER と REAL を値で比べる規則である (整数の値で 64 ビットの範囲にある REAL は、その整数の数字で書く)。
SQLite の UNIQUE は INTEGER の 1 と REAL の 1.0 を同じ値と見なすので、これで一致する。
TEXT と BLOB は、キー文字列の形が違うので、決して等しくならない。SQLite も同じである。

正規化の入力は、SQLite が格納した値 (要素) である。
Worker が文の引数から作るのではない。
型の親和性の変換は、格納した時点で済んでいるので、JS で写さない (`storedAs` を使わない)。
式の index の列は、SQLite が計算した式の値である。

照合順序は、index の列ごとに `PRAGMA index_xinfo` が返す `coll` である。列の定義の照合順序を引き継いだものも、index に書いたものも、ここに出る。
TEXT の値だけを正規化する。

| 照合順序 | 正規形 | SQLite の比べ方 |
|---|---|---|
| BINARY | そのまま | `memcmp` と長さ |
| NOCASE | 最初の NUL の手前を、ASCII の A から Z だけ小文字にする。NUL を含めば、その後ろを捨て、NUL と全体の UTF-8 のバイト数を足す | `sqlite3StrNICmp` は、ASCII の 26 文字だけを畳み、左の文字列の NUL で止まる。等しければ長さを比べる。`'a' \|\| char(0) \|\| 'x'` と `'A' \|\| char(0) \|\| 'y'` は等しい |
| RTRIM | 末尾の U+0020 を全部落とす | 両方の末尾の空白 (0x20) を落としてから BINARY。タブ、改行、U+00A0、U+3000 は落とさない |

D∞ の利用者は照合順序を足せない (DO の SQLite に関数を足す入口がない。`docs/platform-facts.md`)。
ほかの名前の照合順序は、SQLite 自身が CREATE の時点で `no such collation sequence` で断る。

この規則は、使い捨てのスクリプトで確かめた。
node:sqlite で、照合順序ごとに、型のない列の UNIQUE の表へ 291 個の値 (TEXT の大文字小文字、末尾と先頭の空白、タブ、U+00A0、U+3000、NUL の位置、多バイト文字、合成文字、INTEGER と REAL の端、BLOB) を入れ、SQLite が同じと見なした値の組と、正規形が同じ値の組を比べた。
違いはなかった (3 つの照合順序と、2 つずつの比べ方 12,222 組)。
正規化を 3 通りに壊すと (Unicode の小文字にする、`trimEnd` で空白を全部落とす、NUL の規則を落とす)、どれも違いが出た。
本物の検査は段 0 で書く (「段」の節)。

### 部分 index と式の index

今は、shard key を含まない部分 index と式の UNIQUE index を断っている (`src/sql/ddl.ts:302`)。
shard key を含むものは、シャードの SQLite が守っている。
キーの行では、どちらも同じ形で守る。

キーの値と部分 index の条件は、SQLite が計算する。
捕捉の trigger (`captureDdl`、`src/shard/rows.ts:346`) は、変更前と変更後の行のタプルを `__cap` に書いている。
UNIQUE のある表では、制約ごとに、`old` と `new` で式と条件を計算した要素の並びも書く (`CASE WHEN 条件 THEN json_array(式の要素...) END`)。
SQLite は、index の式と条件に、決定的な関数しか許さない。同じ行からは、いつも同じキーが出る。
基準経路の Worker の SQLite も、同じ trigger の文で変更を捕捉する (`src/client/db.ts:886`) ので、同じキーを作る。
index を作るとき (下の「index の作成」) の既存の行のキーも、同じ式の SELECT で作る。

キーの関数 `uniqueKeys(def, change)` は 1 つにし、シャードの手元の確かめと、Worker の 2PC の経路の両方が呼ぶ。
入力は捕捉の行 1 つ (変更前と変更後のキーの要素) で、出力は、値を取るキーの行と、手放すキーの行である。

## キーの行の置き場所

キーの行の token は、行と同じ `tokenOf(sk, pk)` で決める (`src/routing.ts`)。
キーの行では、`sk` は上の `sk`、`pk` は `keyString([k])` である。

| 制約 | キーの行の `sk` | token | テナントが分かれていないとき |
|---|---|---|---|
| 同居 (shard key の列を BINARY で含む) | 行の shard key | テナントの slot のブロックの中。subslot は `k` の hash | 行と同じシャード |
| ほか | `keyString([k])` | `k` の hash で、どの slot にも入る | ふつうは別のシャード |

同居の制約では、衝突し得る行はどれも同じ shard key の値を持つ。
キーの要素の中の shard key の値は、行の shard key の格納された値そのもの (BINARY) なので、キーの行の slot は、行の slot と同じになる。
NOCASE で比べると、そうならない (上の「刷新案からのずれ」の 3)。

キーの行の位置は (`__ukey_<n>`, `keyString([k])`) である。
piece は、グループの行を (表の名前, 主キー) の順の区間で切る (design-subslots.md の「piece の切り方」) ので、1 つのグループの 1 つの制約のキーの行は、連続した位置に並ぶ。
グループの piece の列挙 (`listGroups`、pull の走査) は、キーの表も、利用者の表と同じに数える。
テナントの slot のブロックの中に境目を置く移動 (段 4) では、キーの行も、subslot (`k` の hash) で両側に分かれる。
行とキーの行が別のシャードに分かれるので、そのテナントの書き込みは 2PC になる (M22 の `m22_green_split`)。

## ロックと intent

### 書き込み

値を書く取引は、行の変更と一緒に、キーの行の変更を書く。

- 値を取る: キーの行 `k` を「ない」から `(k, pk, sk)` へ。
- 値を手放す (UPDATE で変える、DELETE、部分 index の条件から外れる): キーの行 `k` を `(k, pk, sk)` から「ない」へ。
- 同じ取引の中で、ある行が手放した値を別の行が取る (入れ替えを含む): キーの行の holder を書き換える。取引の溜める変更 (`Txn.buffer`) は表と主キーで 1 つにまとめるので、手放す変更と取る変更が 1 つの変更になる。

キーの行の変更は、行の変更と同じ `Change` で、同じ参加者の集まりに入る。
キーの行の持ち主が行と同じシャードなら、1 つの確定である。
別のシャードなら、そのシャードが 2PC の参加者になる。

prepare と 1 シャードの確定 (`validate`、`src/shard/kernel.ts:1613`) は、キーの行に、行と同じ確かめをする。

- ほかの取引の intent がない。あれば、今と同じく `intent on ...` で断る (ロック)。
- 確定した値が、取引の読んだもの (`Change.before`) と同じである。値を取る変更では「行がない」こと。今の `if (row && w.before === null) return unique:` (`:1628`) が、そのまま UNIQUE の確かめになる。
- 読んだ時刻より後に変わっていない (`write after T`)。

ほかの取引の未確定の値は、キーの表の主キーの一致で、`__intents` の 1 行として見つかる。
未確定の intent を全部試しに適用する確かめ (`uniquePending`、`:1646`) と、取引の変更を本体に試しに適用する確かめ (`checkUnique`、`:1704`) は要らない。
M16 が確かめた 2 つの状態の論法は、キーの行のロック (`m22_red_no_key_lock` が、外すと破れる) と、確定した値の確かめ (`m22_red_no_key_body`) に置き換わる。

### シャードの中 (追加の RPC なし)

文をそのまま 1 つのシャードへ送る経路 (`Txn.write`、`autoWrite`、`execAuto`) は、次のように進む。

1. シャードは、文を、一意でない index の表に実行し、変更を捕捉する。
2. 捕捉の順 (`__cap.seq`) に、行ごとにキーの変更を作る (`uniqueKeys`)。
3. キーの行が自分のものなら、行ごとに確かめる。キーの表を主キーで引き、文の中で先に取られたか手放されたキーを重ねる。値を取る行より前に、ほかの行がその値を持っていれば、衝突である。
4. 自分のキーの行に、ほかの取引の intent があれば、文が読む行の intent と同じに扱う。決着させてから文を実行し直す (核の `Effect`)。確定して未適用の変更を決着させずに確かめると、誤って衝突にする (今の `test/unique-reads.test.ts` が確かめている形)。悲観の取引では、ロックを待つ。
5. 衝突があれば、文の変更を取り消し、`NeedsReference` を返す。Worker は基準経路で実行し直す。
6. 衝突がなければ、キーの行の変更を文の変更に足して、今と同じに確定するか、Worker に返す。

確かめを行ごとにするのは、SQLite が行ごとに確かめるからである。
`UPDATE t SET u = 3 - u` (2 行の値の入れ替え) は、SQLite では UNIQUE 違反で失敗する (node:sqlite で確かめた)。
文の終わりの状態だけを見ると、重複がないので通してしまう。
行ごとの確かめは、SQLite より厳しい側に倒れるのはよい (基準経路で同じ答えになる) が、緩い側に倒れてはならない。

これは仮定を 1 つ置いている。
行ごとの結果は、行を訪ねる順で変わる (`UPDATE t SET u = u + 1` は、u = 1 の行を先に訪ねれば違反し、u = 2 の行を先に訪ねれば通る)。
シャードの SQLite は、一意でない index の表で文を計画するので、一意の index を持つ Worker の SQLite と、別の順で行を訪ねることがある。
シャードが通した文を、基準経路で実行すれば違反になる、ということが起き得る。
どちらの答えも、SQLite がある順で行を訪ねたときの答えであり、計画書が「行の物理的な並び順で結果が決まる文」として SQLite との違いを認めている種類 (ORDER BY のない LIMIT など) に入る、と考える。
段 0 の差分の検査 (c) は、この種類の文を、どちらかの順の答えに一致すれば合格にし、順に依らない文は答えの一致を求める。
順に依らない文で違いが出たら、この仮定が誤っている。

### シャードをまたぐ

キーの行の token が、文を実行したシャードの範囲の外にあれば (同居でない制約、分かれたテナント)、シャードはそのキーを確かめられない。
シャードは、キーの変更を変更と一緒に返す。
Worker は、キーの行を持ち主のシャードの変更として溜め、文の時点で持ち主を主キーで引いて確かめる (今の `assertUnique`、`src/client/db.ts:1101`)。
行ごとの確かめは同じ関数で、引いた holder を使う。
衝突があれば `NeedsReference` である。
autocommit の 1 シャードの経路 (`execAuto`) は、キーの行が範囲の外にあれば、今の「1 シャードで確定できない」と同じに、取引の経路へ落ちる。

### 基準経路

基準経路 (`Txn.wasmWrite`、`src/client/db.ts:864`) は今の形のままである。
衝突し得る行を集める `conflicting` (`:921`) は、値を取るキーごとにキーの行を持ち主から引き、holder の行を集める。
今のシャードの中の UNIQUE の問い (同じ shard key の値の中を `=` で探す、`:939`) と、シャードをまたぐ UNIQUE の問い (`:946`) は、この 1 つになる。
Worker の SQLite は、利用者の DDL を再生しているので、照合順序、部分 index、式の index を含めて本物の UNIQUE を持つ。
違反の誤り、OR IGNORE、REPLACE が消す行、ON CONFLICT の更新は、SQLite が決める。
決まった変更のキーの行は、確かめ直さずに溜める (今の `"trusted"`)。prepare は、キーの行を普通に確かめる。

### 文の意味

| 文 | シャードへそのまま送れるか | 衝突したとき |
|---|---|---|
| INSERT、UPDATE (衝突の処理を書かない) | 送れる | 基準経路で、SQLite が `UNIQUE constraint failed: ...` を返す |
| INSERT OR IGNORE、OR REPLACE、REPLACE、OR FAIL、OR ROLLBACK、UPDATE OR ... | 送れる | 基準経路で、SQLite が決める |
| `ON CONFLICT DO NOTHING` (対象なし)、`ON CONFLICT (主キー) DO ...` | 送れる | 基準経路 |
| `ON CONFLICT (主キー以外の UNIQUE の列) DO ...` | 送れない。一意でない index では、シャードの SQLite が文を翻訳しない (`ON CONFLICT clause does not match any PRIMARY KEY or UNIQUE constraint`、node:sqlite で確かめた) | 文の形で、最初から基準経路 |

どの行も、衝突の有無で経路が変わるだけで、答えは変わらない (計画書の規則 4)。
最後の行は文の形で決まる。
今は、シャードをまたぐ UNIQUE のある表への衝突を自分で解決する INSERT だけが、最初から基準経路である (`src/sql/plan.ts:840`)。
変更後は、主キー以外の UNIQUE を対象にした upsert が、どの表でも基準経路になる。
費用は 1 回の往復から、集める読みと確定の 2 回の往復と Worker の SQLite での実行に増える。

### span

UNIQUE のある表への書き込みは、今は、文が同じ値の行を読むので、範囲を shard key の値の全体に広げるか、UNIQUE の値の条件の範囲を足している (`src/client/spans.ts:47` から `:69`)。
物理の index が一意でなくなると、シャードの SQLite の文は、ほかの行を読まない。
キーの行は、書き込みとして確かめる (確定した値と、読んだ時刻より後の変更)。
1 行を名指しする書き込みの範囲は、その 1 行になる。
`uniqueReads` とその範囲は要らない。
範囲の検査 (`test/setup.ts`) は、シャードが手元で引いたキーの行を、文が書いた行として数える。

## piece と移動

### 何が要らなくなるか

M20 は、シャードの SQLite の UNIQUE index と、piece ごとの適用の組み合わせを確かめ、3 つの規則を足した。

| M20 の規則 | なぜ要ったか | キーの行では |
|---|---|---|
| 親は、最初の piece を切る前に、グループの intent を決着させる | piece ごとの適用の途中で、子の物理の表に同じ値の行が一時的に 2 つでき、一意の index が挿入を断る | 物理の index は一意でない。キーの行は主キーが 1 つの値に 1 行で、その intent はキーの行と一緒に動き、1 行ずつ適用される。途中の状態でぶつかるものがない |
| fence の後、親は新しい intent を受けない | 親は、子へ移った行の値を知らないので、手元の行だけで確かめると重複を通す | 値の確かめは、キーの行の持ち主がする。親が書くのは、自分が持つ位置の行だけである。M21 の親は move-start の後に書き込みを断るが、それは時刻 m の規則のためで、UNIQUE はこれに頼らない (`m22_green_parent_until_cut`) |
| 子は、グループが揃うまで、UNIQUE の値を書く文を受けない | 子は、まだ届いていない行の値を知らない | 子は、キーの位置を覆う piece だけを pull して待つ。値の確かめは点の読みで、グループの全体を要らない |

3 つ目が、持ち主の判断とぶつかっていた点である。
M20 の規則では、大きなテナントが移る間、UNIQUE のある表への 1 行の INSERT まで `migrating:` で失敗した。
キーの行では、INSERT が待つのは、行の位置とキーの位置を覆う piece の到着 (pull の往復 1 回ずつ) だけである。

### 規則

piece の規則は、M18 と M19 のものを、キーの行にもそのまま使う。

- 子は、キーの位置を覆う piece が届いてから、そのキーの行を確かめる。届いていなければ、その位置の piece を pull する (design-subslots.md の `pull` の `at`)。キーの行がなくても位置はあり、その位置を覆う piece が届けば「ない」と言える。届いていないキーを「ない」と見なすと、親に残る holder と重複する (`m22_red_key_unarrived`)。
- intent は、その位置の piece と一緒に動く (M18 の `INTENTS_BY_PIECE`)。キーの行の intent を、その値を持つ行の piece と一緒に運ぶと、子が持っていないキーの行を書き、後から届いたキーの行とぶつかる (`m22_red_key_intent_with_row`)。intent は表と主キーで選ぶので、キーの表の intent は、キーの表の位置で選ばれる。
- キーの行は、その位置の持ち主が確かめる。値を持つ行のシャードが手元のキーの行で確かめると、テナントを割った後の親が、もう持っていないキーの行を「ない」と見る (`m22_red_key_at_row`)。今のシャードの中の UNIQUE index は、この考え方である。
- 親は、切った piece のキーの行を、ack まで控えとして持つ。控えに答えないこと (M18 の `ANSWER_BY_CLAIM`) は、キーの行の点の読みでは、持ち主の確かめ (切った piece の位置は親のものではない) で決まる。

M19 の claim の分け直しは、テナントの読みのためのもので、キーの確かめには要らない。キーの行は点で引くからである。

### M21 の移動の遷移との関係

- 親の fence は、親が move-start を適用したことである。その後、親は移る区間の書き込みと prepare を断る。キーの行も同じである。
- 表定義の遷移と移動は同時に開かない (M21) ので、index の作成と移動は重ならない。
- move-end は、子が全部の piece を受け取った後で記録する。キーの行も piece に入っているので、条件は変わらない。

## index の作成

M21 の遷移の 1 つにする。

| DDL | mode | 中身 |
|---|---|---|
| UNIQUE のある CREATE TABLE | `plain` | `commit` が、利用者の表、一意でない index、空のキーの表を作る |
| 行のある表への CREATE UNIQUE INDEX | `build` | 下の手順。シャードの中の UNIQUE も同じである (M21 の設計では `trial` だった) |
| UNIQUE の DROP INDEX | 書き込みを止める遷移 (`fence` は元の表) | `prepare` は元の表を止め、元の表とキーの表の intent を決着させる。`commit` が、一意でない index とキーの表を名前で消す。M21 の設計では `fence` が空の `plain` だった |
| DROP TABLE | 今の M21 のまま | 決着させる intent に、キーの表のものも入れる。`commit` がキーの表も名前で消す |

キーの行の intent は、利用者の表ではなくキーの表にあり、行と別のシャードにあることもある。
M21 の `prepare` を適用するシャードは、`fence` の表の intent を決着させてから適用する。
UNIQUE のある表では、その表のキーの表の intent も、この決着の対象に入れる。
入れないと、確定して未適用のキーの行の intent が、消されたキーの表に残り、確定した取引が適用できなくなる。
`prepare` は全部のシャードが適用するので、キーの表の行がどのシャードにあっても、そのシャードが決着させる。

`build` の手順は次のとおりである。

1. `prepare` は表を書き込み禁止にし、空のキーの表を `staging` として作る。`abort` を適用したシャードは、名前で消す。
2. 進める側は、各シャードに、止まった行のキーを作らせる。シャードは、式と条件の SELECT で行ごとのキーを作り、自分の範囲に token のあるキーの行を、区切って入れる (今の `buildIndex` と同じく、1 回の同期区間に収まる量ずつ)。キーの表の主キーが重複を断れば、その値で `abort` する。範囲の外のキーの行は、進める側に返す。
3. 進める側は、範囲の外のキーの行を、持ち主のシャードへ書く。重複は、持ち主のキーの表の主キーで見つかる。
4. 読んだ時刻の最大を `commit.at` に載せる (M12 の時計の規則)。`commit` は一意でない index を作る。

分かれたテナントで、同じ値の行が 2 つのシャードにあっても、キーの行は 1 つの持ち主に集まるので、重複が見つかる。
design-subslots.md の判断 5 (既存の行への `CREATE UNIQUE INDEX` の、分かれたテナントの突き合わせ) は、別の手順として要らない。
M21 の `BUILD` の場面は、index を値ごとに 1 項目の形 (M12 の形) で持ち、2 つのシャードの行を読んで項目を埋める。キーの行はこの形そのものなので、M21 の緑と赤がそのまま当たる。M21 は項目の置き場所を区別しないので、同居の制約と、そうでない制約の違いは、M21 の結果を変えない。
シャードの中の UNIQUE index の `trial` (M21 の判断 3、行の多い表で index を 2 度作るか) は、UNIQUE については問いがなくなる。`trial` は、CHECK や NOT NULL のある ADD COLUMN と、一意でない式の index に残る。

## 消えるもの

| 消えるもの | 代わり |
|---|---|
| `__gidx_<index>`、`__gidx_<index>__rows`、`globalIndexTable`、`rowIndexSql` (`src/sql/ddl.ts:105`、`:123`) | `__ukey_<n>` と、制約の列の一意でない index |
| シャードの SQLite の UNIQUE index (表の制約と CREATE UNIQUE INDEX をそのまま送る形) | 一意でない index。シャードへ送る CREATE TABLE からは UNIQUE の制約を外し、CREATE INDEX を足す |
| `TableDef.uniques`、`globalIndexes`、`partialUnique`、`building` | `TableDef.uniqueKeys` (`UniqueKeyDef[]`) |
| `uniquePending`、`checkUnique` の試適用、`hasUniqueBeyondKey`、`PENDING_UNIQUE` (`src/shard/kernel.ts:151`、`:1646`、`:1700`、`:1704`) | キーの行の確かめ (今の `validate` の行の確かめのまま) |
| 欠陥のスイッチ `autoIgnoresUniqueIntents` | キーの行のロックを外すスイッチ (`m22_red_no_key_lock`) |
| `uniqueReads`、`touchesUnique` (`src/sql/plan.ts:58`、`:987`)、範囲の規則 3 (`src/client/spans.ts:49`) | 1 行の範囲と、書いたキーの行 |
| 基準経路の 2 つの問い (`conflicting` の `def.uniques` と `def.globalIndexes`) | キーの行を引いて holder を集める 1 つの問い |
| 計画の規則「シャードをまたぐ UNIQUE のある表への、衝突を自分で解決する INSERT は基準経路」(`src/sql/plan.ts:840`) | 衝突の対象に主キー以外の UNIQUE を名指しする upsert は基準経路。ほかは、衝突したら基準経路 |
| 表定義の拒否 4 つ (`test/refusals.test.ts:28`、`:29`、`:33` と、`src/sql/ddl.ts:302`): shard key を含まない UNIQUE の BINARY 以外の照合順序 (表の制約と CREATE INDEX)、shard key を含まない部分 index と式の UNIQUE index | 受け付ける。キーは SQLite が作り、照合順序は 3 つの正規形で比べる |
| M16 (`specs/m16_unique_pending.qnt`) | 実装が入った時点で M22 が置き換える。M16 の 2 つの赤は `m22_red_no_key_lock` と `m22_red_no_key_body` に当たる |
| M20 の 3 つの規則と、design-subslots.md の「書き込みが続く間の大きなグループ」の規則 | 要らない。M20 は M22 が置き換える |
| design-subslots.md の「分かれた slot の文」の表の「シャード内 UNIQUE の値を書く」行 (同じ値の行を持ち主の全部から読む 2PC) と、判断 5 | キーの行の点の 2PC と、`build` の遷移 |
| 未解決の問題 6 (UNIQUE のある表への書き込みの仕事が、同じグループの未確定の取引の数に比例する。`test/unique-pending-cost.test.ts`) | 確かめは、キーの数だけの主キーの引きになる |

主キーの一意性は、今のまま、シャードの SQLite の主キーが守る。
同じ主キーの行は、いつも同じ token で、同じシャードにある。

## 未解決の問題 31: 列の名前の解決

`CREATE TABLE u (id INTEGER PRIMARY KEY, email TEXT, UNIQUE (EMAIL))` の UNIQUE は email の列に掛かる。
DDL の解釈 (`createTable`、`src/sql/ddl.ts:165`) は、制約に書いてある文面をそのまま列の名前として記録し、重複を通す (`test/open/constraint-column-case.test.ts`)。
`PRIMARY KEY (A)` と列 `a` では、どの INSERT も断られる。

列の名前の解決を、SQLite にさせる関数 1 つにする。

```ts
/** DDL を Worker の SQLite (空の表定義に、今の表定義を再生したもの) で実行し、PRAGMA で制約を読む。 */
function resolveConstraints(w: ScratchDb, table: string): {
  columns: { name: string; pk: number; hidden: number }[];          // PRAGMA table_xinfo
  keys: { name: string; unique: boolean; origin: "pk" | "u" | "c"; partial: boolean;   // PRAGMA index_list
          parts: { cid: number; name: string | null; coll: string }[] }[];            // PRAGMA index_xinfo (key = 1 の行)
};
```

node:sqlite で確かめた事実は次のとおりである。

- `PRAGMA index_xinfo` の `name` は、列の定義の綴りである。`UNIQUE (EMAIL)` と列 `Email` で、`Email` を返す。
- `coll` は、その index の列の照合順序で、列の定義から引き継いだもの (`Email TEXT COLLATE NOCASE` なら NOCASE) も、制約に書いたもの (`UNIQUE (n COLLATE RTRIM, T)`) も出る。主キーの index (`origin = 'pk'`、WITHOUT ROWID の表) も同じである。
- 式の列は `cid = -2`、`name` は NULL である。部分 index は `index_list` の `partial = 1` である。
- 列の名前の比べ方は ASCII だけを畳む。`UNIQUE ("É")` と列 `"é"` は `no such column` で断られる。
- `PRAGMA table_xinfo` は、列の照合順序を返さない。

使い方は次のとおりである。

1. `Db.assertReplays` (今、Worker の SQLite で DDL を確かめている所) が、DDL を実行した後で `resolveConstraints` を呼ぶ。
2. 主キーの列、shard key、UNIQUE の列、照合順序は、PRAGMA の答えを使う。構文木からは読まない。
3. 式の index の式と、部分 index の条件の文面は、構文木から取る。式の中の列の名前は、SQLite が trigger の中で解決するので、綴りを直さなくてよい。
4. 列の照合順序 (UNIQUE に関わらない列。集約の比べ方や計画に使う) は、今のまま構文木から読む。PRAGMA で読むなら、Worker の SQLite で列ごとに使い捨ての index を作り、`index_xinfo` の `coll` を読む手がある。

構文木の読みは、PRAGMA の答えと突き合わせる検査になる (段 0)。
問題 31 の 2 つの形は、名前を PRAGMA から読むので、作りとして起きない。
`CREATE UNIQUE INDEX i ON u (EMAIL)` の誤った拒否 (`no such column`) も、同じ関数で直る。

## 段

どの段も、落ちる検査を先に用意してから入れる (`AGENTS.md` の規則 2)。

| 段 | 中身 | 先に用意する検査 | 規模 |
|---|---|---|---|
| 0 | 検査だけ | (a) 照合順序のキーの検査 (下)。(b) 列の解決の検査: 乱択の CREATE TABLE と CREATE INDEX (列の大文字小文字、引用、制約の COLLATE、WITHOUT ROWID) で、今の構文木の読みと PRAGMA の答えを比べる。問題 31 の形で落ちる。(c) UNIQUE の文の差分の検査: 1 つの文の中の入れ替え、複数行の INSERT の自分どうしの衝突、OR IGNORE、OR REPLACE、OR FAIL、OR ROLLBACK、対象のある upsert、部分 index と式の index、NOCASE と RTRIM の列、shard key の列を NOCASE で比べる UNIQUE (`UNIQUE (tenant COLLATE NOCASE, code)`。'A' と 'a' のテナントが別のシャードにある置き方を含む) を、シャード 1、2、4 と分かれた置き方で、SQLite と比べる (`test/unique-conflicts.test.ts` と `test/conflict-clauses.test.ts` を広げる)。行を訪ねる順で答えが変わる文は、どちらかの順の答えに一致すれば合格にする (「シャードの中」の節の仮定)。基準経路だけの 2 つの実行でも流す。(d) 課金の計測: 文の再生の作業負荷で、文ごとの書いた行の数を今のコードで記録する | 約 400 行、2 日 |
| 1 | キーの関数と列の解決。どこからも呼ばない `uniqueKeys` と正規化。`resolveConstraints` を `createTable` と `createIndex` に入れる | (a) と (b) が通る。`test/open/constraint-column-case.test.ts` が `test/` へ移る | 約 300 行、2 日 |
| 2 | シャードをまたぐ UNIQUE を `__ukey_<n>` に置き換える。置き場所は今の `__gidx` と同じ。照合順序と部分 index と式の index の拒否を外す | (c) が、今まで断っていた形も含めて通る。`ddl-concurrent` の `CREATE UNIQUE INDEX` の seed 1 から 500、文の再生の「実行の途中で index を作る」場面 | 約 500 行、3 日 |
| 3 | シャードの中の UNIQUE をキーの行にする。物理の index を一意でなくする。行ごとの衝突の確かめと `NeedsReference`。upsert の計画の規則。`uniquePending`、`checkUnique`、`uniqueReads` を消す | (c) を 3 つの実行で。`test/unique-reads.test.ts` と `test/unique-pending-cost.test.ts` (後者は、仕事がグループの intent の数に比例しなくなる形に書き換える)。(d) の計測を比べる。グループの中身が変わる (同居の制約のキーの行が入る) ので、今のグループ単位の移動がキーの行も運ぶことを、`history`、`elle-sim`、`replay` (表は `UNIQUE (tenant_id, code)` を持つ) の分割の seed と `test/migration.test.ts` で確かめる。M22 の赤を戻すスイッチ (下の表) と、run の再生。M16 の反例の再生を M22 のものに付け替える | 約 700 行、4 から 5 日 |

piece の部分は、この設計の段ではなく、design-subslots.md の段 2 (piece 単位の移動) と段 4 (slot を割る移動) の受け入れの条件に入れる。
計画書の順番では、UNIQUE の作り直しは、置き場所の段 2 から 4 より前に入る。
段 2 では、`replay` の表の `UNIQUE (tenant_id, code)` (`test/replay.test.ts:18`) が、1 通で運べる大きさを小さくした分割で、piece ごとの適用とキーの行の移動に届く。
index の作成の `build` は、M21 の段 3 で入る。M21 の段 3 がこの設計の段 3 より先なら、シャードの中の UNIQUE index は、それまで `trial` のままである。

M22 の赤と、欠陥のスイッチの対応は次のとおりである。
再生は、その形に届く段で足す (`docs/model-coverage.md` の P)。

| M22 の赤 | スイッチ (新) | 戻す欠陥 | 段 |
|---|---|---|---|
| `m22_red_no_key_lock` | `noKeyLock` | キーの行の intent を、ほかの取引の同じキーの部分が見ない | 2 (シャードをまたぐ UNIQUE)、3 |
| `m22_red_no_key_body` | `noKeyBody` | キーの持ち主が、確定したキーの行を確かめない | 2、3 |
| `m22_red_key_after_commit` | `keyAfterCommit` | キーの行を、行と同じ 2PC に入れず、確定の後に書く | 2 |
| `m22_red_keep_old_key` | `keepOldKey` | 値を手放す行のキーの行を消さない | 2、3 |
| `m22_red_key_at_row` | `keyAtRow` | シャードが、自分の範囲の外のキーを、手元のキーの表で確かめる | 3 (分かれたテナントの置き方)、subslots の段 4 |
| `m22_red_key_unarrived` | `keyUnarrived` | 子が、届いていない piece のキーを「ない」と見なす | subslots の段 2 |
| `m22_red_key_intent_with_row` | `keyIntentWithRow` | pull と ack が、キーの行の intent を、その値を持つ行の piece で選ぶ | subslots の段 2 |
| `m22_red_physical_unique` | `physicalUnique` | シャードの物理の index を一意にする | 3、subslots の段 2 |
| `m22_red_group_refuse`、`m22_live_red_group_wait` | なし | M20 の規則。実装したことがないので、スイッチは要らない (計画書の分類 D) | |

### 照合順序のキーの検査

`test/unique-keys.test.ts` (段 0) は、キーの関数と SQLite の UNIQUE が、同じ値を同じと見なすことを確かめる。

- 値の生成器: TEXT (ASCII の大文字小文字、末尾と先頭の空白、タブ、改行、U+00A0、U+3000、NUL を先頭、途中、末尾に、多バイト文字、合成文字、ß と ẞ、ı と İ、乱択の短い文字列)、INTEGER (0、±1、2^53 ± 1、±(2^63 - 1)、-2^63)、REAL (整数の値、-0.0、2^53、2^63、±無限大、非正規化数)、BLOB (空、TEXT と同じバイト列)。
- 比べ方: 照合順序ごとに、型のない列 `x UNIQUE COLLATE X` の表へ、値を `INSERT OR IGNORE` で順に入れ、各値について `WHERE x = ?` で、SQLite が等しいと見なす行を引く。キーの関数の側は、キーが同じ最初の値を引く。2 つが全部の値で一致すれば、同値の関係が一致する。加えて、抜き取りの組を `? = ? COLLATE X` で比べる。複数の列の組と、NULL を含む組 (`UNIQUE (a, b)`) も比べる。
- 流す所: node:sqlite (シミュレータ)、sql.js (Worker の SQLite)、手元の workerd の DO の SQLite (`test/workerd-limits.test.ts` と同じ仕掛け)。承認された Cloudflare での計測にも足す。
- 値は要素で束縛し、比べるのは SQLite の中で行う。node:sqlite と sql.js は、結果の TEXT を NUL で切る (未解決の問題 32) ので、結果の文字列は比べない。
- 検査が検査になっていることの確かめ: 正規化を、Unicode の小文字、`trimEnd`、NUL の規則なし、の 3 通りに壊すと落ちること。

使い捨てのスクリプトは、この形の node:sqlite の部分だけを流し、上の「正規形」の節の結果を得た。

## 段 0 の結果 (2026-11-15)

`b875aa5` (ブランチ `foundation-2`) の上で、4 つの検査を足した。`src/` は変えていない。
時間は、`--maxWorkers=2` で、ほかの試験と同時に流さないときのものである。

| 検査 | ファイル | 流す所 | 既定の実行 |
|---|---|---|---|
| (a) 照合順序のキー | `test/unique-keys.ts`、`test/unique-keys.test.ts`、`test/unique-keys-workerd.test.ts` | node:sqlite、sql.js (sim)、手元の workerd (workerd) | 1 秒ほど |
| (b) 列の解決 | `test/unique-columns.ts`、`test/unique-columns.test.ts`、`test/open/unique-columns-case.test.ts` | DDL の解釈と node:sqlite の PRAGMA (sim) | seed 400 個、1 秒ほど |
| (c) UNIQUE の文の差分 | `test/unique-diff.ts`、`test/unique-diff.test.ts` | シャード 1、2、4 と分割で切った 4 シャード。sim、reference-scans、reference-full | seed 43 個、1 つの実行が 25 秒ほど |
| (d) 書いた行の数 | `test/unique-rowcost.test.ts` | 手元の workerd (workerd) | 5 秒ほど |

### (a) 照合順序のキー

キーの関数は段 1 で入るので、検査は関数を引数に取る (`KeyFn`)。
値は SQL の literal で書き、束縛しない (DO は JS の数を REAL で束縛し、BigInt を束縛できない。sql.js は小さな整数の値の数を INTEGER で束縛する)。
SQLite の類は、UNIQUE のある表への `INSERT OR IGNORE` で残った行と、`=` で等しい組の 2 つで取る。どちらも SQLite の中で決め、ドライバから読むのは番号と ASCII の文字だけである。
「比べ方」の項の `WHERE x = ?` は、列どうしの比べ方にした。`CAST(x'..' AS TEXT)` の literal と比べると、右辺の TEXT の親和性が、型のない列の数を TEXT に変え、INTEGER の 1 と TEXT の '1' が等しくなる。

値は 278 個 (TEXT 223 個。決まったもの 103 個と、乱択の短いもの 120 個。INTEGER 17 個、REAL 25 個、BLOB 11 個、NULL 2 個) で、2 列の組は 28 個の値の直積の 784 組である。
照合順序の場面は 6 つ (1 列の BINARY、NOCASE、RTRIM と、照合順序を混ぜた 2 列の組 3 つ。照合順序を列に書く形と、CREATE UNIQUE INDEX に書く形)。

- 3 つのエンジンで、入った値は作ったとおりで、UNIQUE の index と `=` は同じ類を作り、類はエンジンの間で同じだった。エンジンの違いはなかった。
- 参照の実装 (「正規形」の表のとおり) は、3 つのエンジンの全部の場面で一致した。NOCASE の NUL の規則 (`'a' || char(0) || 'x'` と `'A' || char(0) || 'y'` が等しい) は、手元の workerd の DO の SQLite でも成り立つ。
- 壊した実装 6 つは、3 つのエンジンのどれでも落ちた。Unicode の小文字、空白を全部落とす、`trimEnd`、NUL の規則なし、NULL を含む組にキーを作る、REAL を JS の表記で書く (2^62 + 1024 の REAL と、同じ表記の INTEGER 4611686018427389000 を同じと見なす)。

本番の DO の SQLite では流していない (「決めたこと」の 7)。

### (b) 列の解決

DDL の解釈 (`parseDdl`) が読む列、主キー、rowid の別名、shard key、主キーと UNIQUE の列と照合順序、部分 index を、同じ DDL を node:sqlite で実行して `PRAGMA table_xinfo`、`index_list`、`index_xinfo` で読んだものと比べる。
既定の 400 個の seed で、比べた文は 464 個だった。問題 31 の形を作らない生成で、seed 1 から 20,000 まで違いはなかった。
SQLite が断る DDL は比べない。`Db.ddl` は、記録の前に Worker の SQLite で利用者の文を実行する (`Db.assertReplays`) からである (seed 4986 の、食い違う ON CONFLICT の UNIQUE を 2 つ持つ表は、この区別がなかったときの検査の誤りだった)。

見つけた欠陥は 3 つで、既定の実行では生成の指定で作らず、指定を入れると見つかることを既定の実行が確かめる。

| 生成の指定 | 欠陥 | 再現 | 持ち主 |
|---|---|---|---|
| `caseVariants` | 未解決の問題 31 (100 個の seed で 75 件) | `test/open/unique-columns-case.test.ts`、`test/open/constraint-column-case.test.ts` | `ddl.ts` の `createTable`、`createIndex` |
| `tableCase` | 新。`CREATE INDEX i ON T (...)` (表は `t`) を `no such table: main.T` で断る。問題 31 と同じ種類で、表の名前の解決である | `test/open/create-index-table-case.test.ts` | `ddl.ts` の `createIndex` (`existingTable`) |
| `primaryKeyDesc` | 新。列の定義の `x INTEGER PRIMARY KEY DESC` を rowid の別名として記録する。SQLite では別名にならず、値を省くと NULL が入る。D∞ は番号を振る | `test/open/integer-primary-key-desc.test.ts` | `ddl.ts` の `createTable` (`rowidAlias`)。不変条件 6 と 11 |

段 1 の `resolveConstraints` で問題 31 は直る見込みである。表の名前も同じ関数で解決し、rowid の別名も PRAGMA (主キーの index の有無) から読めば、残りの 2 つも直る (提案で、確かめていない)。

### (c) UNIQUE の文の差分

表の形は 10 個 (`FAMILIES`) で、文の形は 14 個 (`SHAPES`) である。
置き場所は 4 つ (シャード 1、2、4 と、1 シャードを slot の境目で 3 回分割した 4 シャード)。
行を訪ねる順で答えが変わる文は、2 行だけに触れる形に限り、SQLite のふつうの順と `PRAGMA reverse_unordered_selects` の逆の順のどちらかに一致すれば合格にした。
印のない文 (順に依らない文) で、下の欠陥のほかの違いは出なかった。ただし、いまのシャードの物理の index は一意なので、「シャードの中」の節の仮定 (一意でない index の表では、シャードの SQLite が別の順で行を訪ねる) が試されるのは段 3 からである。この比べ方は、そのときもそのまま使える。
流した seed は、sim で 1 から 900、reference-scans で 1 から 250、reference-full で 1 から 300 で、どれも伏せる欠陥と文の形を最後に変えた後に流して通った (欠陥の 6 つ目は、この掃引の seed 430 と 533 で見つけた)。

いま断る形の一覧 (`REFUSED`) は次のとおりである。どれも表定義の形で決まり、どの置き場所とどの実行でも同じに断る。一覧の形を受け付けるようになると、既定の実行が落ちるので、一覧から外す。

| 断る形 | 文言 | 受け付ける段 |
|---|---|---|
| shard key を含まない UNIQUE の、列の定義の NOCASE (RTRIM は下の CREATE UNIQUE INDEX の形で流す) | `unsupported: COLLATE NOCASE on column ... of a UNIQUE constraint that does not include the shard key` | 2 |
| shard key を含まない CREATE UNIQUE INDEX の、列の COLLATE | `unsupported: a UNIQUE partial or expression index ...` (列の COLLATE は式と同じに扱われる) | 2 |
| shard key を含まない部分 index の UNIQUE | 同上 | 2 |
| 式の UNIQUE index。shard key を含んでも断る | 同上 | 2 |
| 表の UNIQUE の列の COLLATE (`UNIQUE (tenant COLLATE NOCASE, code)`) | `near "COLLATE": syntax error` (パーサの拒否。`unsupported:` ではない) | 2 |
| shard key の列を COLLATE で比べる CREATE UNIQUE INDEX | `unsupported: a UNIQUE partial or expression index ...` | 2 |

見つけた欠陥は 6 つで、どれも 1 シャードでも起きる (置き場所に依らない)。
既定の実行では伏せるか (文の答えか表の中身で当たったら、その置き場所の比較を打ち切る)、文を流さずに避け (`KNOWN_OPEN`)、`OPEN=1` で伏せない。

| 欠陥 | 再現 | 起きる実行 | 持ち主 |
|---|---|---|---|
| 1 つの文に UNIQUE の衝突が 2 つ以上あると、誤りの文言に SQLite と違う制約を書く (文はどちらも失敗する) | `test/open/unique-error-first-conflict.test.ts` | 全部 (基準経路だけの実行では複数行の文) | Worker の `Txn.indexChanges` と `assertUnique` (文の後で、変更の順 × 表定義の index の順に確かめる) |
| OR ROLLBACK が衝突すると、autocommit では `no such savepoint` (手元の workerd の DO では `internal error`) になり、取引の中では取引が終わらない | `test/open/or-rollback.test.ts` | autocommit は通常の実行、取引の中は全部 | 文の原子性の SAVEPOINT (シャードの `Backend.tx`、DO の `transactionSync`) と `Txn` |
| 表の制約の UNIQUE の ON CONFLICT (`UNIQUE (email) ON CONFLICT IGNORE`) を記録しない。シャードをまたぐ UNIQUE では衝突が誤りになり、シャードの中の UNIQUE の REPLACE では捕捉が消えた行を知らない (行イメージの検査が落ちる) | `test/open/unique-constraint-on-conflict.test.ts` | 通常の実行だけ | `ddl.ts` の `createTable` と文の計画 |
| OR FAIL の文が衝突すると、衝突の前の行の変更まで取り消す | `test/open/or-fail-keeps-earlier-rows.test.ts` | 全部 (手元の workerd でも) | 文の原子性 (シャードの SAVEPOINT、Worker の SQLite の `src/sql/scratch.ts`) |
| 複数行の OR REPLACE で、後の行に消される行が消した行が残る | `test/open/global-unique-replace-chain.test.ts` | 全部 (基準経路の書き込み) | 基準経路の書き込み `Txn.wasmWrite` の、REPLACE が消した行の捕捉 |
| ある行が UNIQUE の値を、OR REPLACE で消す行から受け取る変更の集まりを、UNIQUE の誤りで断る。部分 index の UNIQUE もある表への OR REPLACE の文と、先に値を受け取る行に触れてから UPDATE OR REPLACE する取引の COMMIT に出る | `test/open/local-unique-replace-trial.test.ts` | 全部 | 変更の集まりを、溜めた順に物理の UNIQUE index に 1 行ずつ当てる所 (見立て)。M22 の `m22_red_physical_unique` と同じ種類で、piece の移動がなくても 1 つの取引で起きる |

計画書の番号のついた不変条件で、これらに当たるものはない (どれも置き場所に依らない)。
6 つの再現の形の後で、`quiescentProblems` (`test/invariants.ts`) は、3 つの実行のどれでも問題を報告しなかった。intent は残らず、グローバル index は行と一致した (OR REPLACE で残る行も、index の項目を持つ)。内部の状態は壊れず、答えと表の中身が SQLite と違う。
6 つは 1 つの場所、衝突の処理 (ON CONFLICT の 5 つの処理、制約に書いた既定、1 文の中の衝突の順) に集まっている。
持ち主の規則 1 に従って、1 件ずつ直さず、次の形を提案する。

- 不変条件を 1 つ足す。「衝突の処理を持つ文の答えと効果は、同じ行の上で SQLite が実行したものと同じである。衝突の処理を決めるのは SQLite だけである」。
- 持ち主は文の意味の層 (「文の意味」の節) にする。シャードと Worker の最適化の経路は、衝突が起きたことだけを見つけて `NeedsReference` を投げ、基準経路で SQLite に決めさせる。基準経路は、SQLite が実行した文の効果 (REPLACE が消した行、OR FAIL が残した行、OR ROLLBACK が終わらせた取引) を全部捕捉する。
- それまでの範囲の削り方として、OR FAIL、OR ROLLBACK、制約の ON CONFLICT を、文の形と表定義で断る (`unsupported:`) 手がある。決まった形で断るので、規則 4 に反しない。

6 つ目は、段 3 (物理の index を一意でなくする) で起きなくなる見込みである。

### 設計の本文と、いまのコードの食い違い

- 「部分 index と式の index」の節は、shard key を含むものはシャードの SQLite が守っていると書く。部分 index はそのとおりだが、式の UNIQUE index は shard key を含んでも断る (`createIndex` は、列が名前だけの index だけを shard key を含むと見る)。
- 表の UNIQUE の列の COLLATE、ASC、DESC、文字列の literal は、パーサが構文の誤りで断る。段 1 の `resolveConstraints` を入れても、パーサを変えないと受け付けない。
- shard key の列を NOCASE で比べる UNIQUE (「刷新案からのずれ」の 3) は、表の制約の形も CREATE UNIQUE INDEX の形も、いまは作れない。差分の検査は、'a' と 'A' のテナントが別のシャードにある置き場所 (シャード 2 と 4) で、受け付けるようになったときに比べる。
- いまの分割は slot の境目でしか切れないので、1 つのテナントが 2 つのシャードにある置き場所は作れない。段 0 の (c) は、その置き場所を含まない。
- 「文の意味」の表は、OR FAIL と OR ROLLBACK をシャードへそのまま送れる文に入れている。いまは、どちらも SQLite と違う答えになる (上の欠陥の表)。

### (d) 書いた行の数

手元の workerd で、操作を 20 回ずつ流し、DO の `rowsWritten` を文の種類と表ごとに合計して割った (シャード 4 つ。HLC の `__meta` の行は除く)。
8 回と、計算機に負荷を掛けた 3 回で同じだった。2 つの範囲は、実行ごとに変わる数である (操作の間で intent と未適用の確定がなくなるまで待っても変わったので、前の操作の後始末の遅れではない。どこから来るかは分かっていない)。
内訳は `test/unique-rowcost.test.ts` の `PINNED` にある。段 3 は、この表と比べる。

| 操作 | シャードの中の UNIQUE (tenant_id, code) | シャードをまたぐ UNIQUE (email) |
|---|---|---|
| INSERT | 4 | 15 |
| UNIQUE の値を変える UPDATE | 7 | 20.95 |
| ほかの列を変える UPDATE | 2 | 4 |
| 衝突する INSERT OR IGNORE | 1 | 0 |
| 衝突しない INSERT OR IGNORE | 9 | 12.5 |
| 行を置き換える INSERT OR REPLACE | 11 | 19.35 から 20.35 (測った値は 19.55 から 19.9) |
| UNIQUE の upsert (衝突して UPDATE) | 6 | 9 から 11.25 (測った値は 10.05 から 10.5) |
| DELETE | 2 | 11.5 |

シャードの中の UNIQUE の値を変える UPDATE (7 行) と衝突しない INSERT OR IGNORE (9 行) は、捕捉の trigger の下書きと巻き戻しの分が大きい (内訳の `UPDATE lu` 5 行と `INSERT lu` 7 行)。
段 3 で試適用と下書きが減り、キーの行が足される。

## 危険

- **upsert の費用**：主キー以外の UNIQUE を対象にした `ON CONFLICT (...) DO UPDATE` が、どの表でも基準経路になる。upsert を多く使う作業負荷では、往復と Worker の SQLite での実行が増える。段 3 で測る。
- **書き込みの行の数**：キーの行の分だけ増える。値の変わるキーごとに 1 行 (値を変える UPDATE は 2 行) と、その変更ログである。試適用の分は減る。段 0 の計測で比べる。
- **捕捉の trigger の大きさ**：UNIQUE ごとに、式と条件の計算が trigger に入る。式の深さの上限 (未解決の問題 33 と 39) と、文の長さの上限 (100 KB) に近づく表があり得る。CREATE TABLE で測る (`src/sql/depth.ts`)。
- **分かれたテナントと同居でない制約の書き込み**：キーの行が別のシャードにあると、1 行の INSERT も 2PC になる。今のシャードをまたぐ UNIQUE と同じ費用である。
- **グループの大きさと取引の大きさ**：同居の制約のキーの行は、テナントのグループの行である。1 通で運べるグループの大きさ (`GROUP_MAX_BYTES`、16 MB。piece 単位の移動が入るまで) と、取引が書ける大きさ (1 MB、`MAX_WRITE_SET_BYTES` と `Txn.writeBytes`) に、キーの行の分が入る。上限の近くにいた取引とグループは、キーの行の分だけ先に上限に当たる。数え方は、置き場所に依らないように、行と同じ 1 か所で数える (計画書の不変条件 13)。
- **UNIQUE の DROP INDEX が書き込みを止める**：上の「index の作成」のとおり、キーの表の intent を決着させるために、元の表を止める。止まるのは、全部のシャードの `prepare` の適用までである。
- **キーの形は公開の後に変えられない**：キーの表の行は残る。正規形 (特に NOCASE の NUL の規則) を変えるには、キーの表を作り直すことになる。本番の DO の SQLite での照合順序の確かめは、公開の前に必須である。

## M22 が確かめたことと、確かめていないこと

モデルの中身、不変条件、赤と反例は [specs/README.md](../specs/README.md) の M22 の節に書いた。
ここには、設計の判断に効いた結果だけを挙げる。

- 受け入れの条件は満たした。グループの全部が piece ごとに移る形でも、テナントを割る形でも、UNIQUE の値を書く取引 (1 行の INSERT を含む) は、移動の途中に確定して適用される。`migrating` で断ることはなく (`noMigratingRefusal`)、確定した取引は適用でき (`committedApplies`)、見える状態の行の値に重複はない (`uniqueVisible`)。キーの行は、行の値のちょうど逆の写像のままである (`keysExact`)。
- 移動が途中で止まっても、計画した取引は終わる (`writeTerminates`)。待つのは、取引の位置を覆う piece の pull だけである。M20 の規則 (子はグループが揃うまで待つ) では、要らない piece が切られない限り終わらない。
- 決着させてから切る規則は要らない。値を 2 つの行の間で入れ替える取引も、fence の後に piece ごとに分けて適用される (M20 の反例の形が、ここでは通る)。
- 物理の index を一意のままにすると、この規則なしでは、確定した取引の適用が断られる (`m22_red_physical_unique`)。見える状態は破れない。物理の index は一意であってはならない、が結論である。
- 親が fence の後も書き込みを受けることは、UNIQUE を破らない (`m22_green_parent_until_cut`)。M20 の 2 つ目の規則は、UNIQUE のためには要らない。M21 の親は move-start の後に書き込みを断るが、それは時刻の規則のためである。
- 設計の条件 8 つは、どれも外すと破れる。キーの持ち主が確かめる、届いていないキーを「ない」と見なさない、キーの行のロック、確定したキーの行の確かめ、キーの行を同じ 2PC に入れる、古いキーを消す、intent はキーの位置と動く、物理の index は一意でない。

確かめていないこと。

- 時刻。M22 に時計はない。キーの行の確かめは、計画が読んだ値と同じかどうかで表した。読んだ時刻、piece の m、範囲の床は、M5b、M18、M19 のままである。
- 文の意味 (行ごとの衝突の確かめ、`NeedsReference`、基準経路の SQLite の決め方) と、キーの正規形。どちらも SQLite との突き合わせが受け持つ (段 0 の (a) と (c))。
- index の作成。M21 の `BUILD` が、値ごとに 1 項目の index を 2 つのシャードの行から作る形を確かめている。キーの行の置き場所 (同居かどうか) は、M21 の結果を変えない。
- 行 3 つ、値 3 つ、取引 3 つ。piece 3 つで取引 2 つは `HEAVY=1` のときだけで、テナントを割る形は流して違反がなかった (14,325,879 状態)。グループの全部が移る形は流していない。
- 1 つの値にキーの位置が 1 つであること。モデルはそう置いた。実装では、正規形が SQLite の等しさの類ごとに 1 つであること (段 0 の (a)) と、同居を shard key の列を BINARY で比べる制約に限ることで成り立つ。
- 取引の再試行、wound-wait、悲観のロックの待ち。モデルでは、断られた部分は取引を中止する。

## 持ち主の判断が要ること

1. **主キー以外の UNIQUE を対象にした upsert が、いつも基準経路になること**。`INSERT ... ON CONFLICT (email) DO UPDATE` は、一意でない index のシャードでは翻訳されない。往復は 1 回から 2 回に増え、Worker の SQLite で実行する。ほかの手は 2 つある。シャードが、1 行の upsert を自分で解く (衝突したキーの holder の行への UPDATE に書き換える) 手は、SQLite の upsert の意味を写すことになるので、差分の検査が育ってからにする。物理の index を一意のまま残す手は、M20 の規則を戻すことになる (`m22_red_physical_unique`)。**推奨**: 認めて文書に書き、段 3 で費用を測る。測った費用が大きければ、1 行の upsert をシャードで解く最適化を、差分の検査の後に足す。
2. **書き込みの行が増えること**。値の変わるキーごとに、キーの行を 1 行 (値を変える UPDATE は 2 行) 書く。試適用の書き込みと巻き戻しはなくなる。**推奨**: 認める。段 0 で今の数を記録し、段 3 で比べて README の Limitations に書く。
3. **今断っている 4 つの形を受け付けること**。shard key を含まない、BINARY 以外の照合順序の UNIQUE (表の制約と CREATE INDEX)、部分 index と式の UNIQUE index である。どれも、キーを SQLite が作るので、同じ仕組みに乗る。断ったままにしても規則 4 には反しない (表定義の形で決まる拒否である)。**推奨**: 段 2 で受け付ける。断る理由 (JS で SQLite の比べ方を写す) がなくなり、検査 (c) が同じ形を覆う。
4. **キーの表を制約ごとにすること、識別子を番号にすること**。刷新案は、1 つのキー空間に `u\0表\0index\0値` を置く。**推奨**: 制約ごとの表と番号にする。M21 の取り消しは表を名前で消すだけで済み、RENAME TO と、同じ名前での作り直しで、キーを書き直さない。
5. **shard key の列を BINARY 以外で比べる UNIQUE を、同居でない置き場所にすること**。`UNIQUE (tenant COLLATE NOCASE, code)` は、行が同じシャードにあっても、書き込みが 2PC になる。**推奨**: 認める。珍しい形で、正しく動く。
6. **M16 と M20 の扱い**。**推奨**: 実装が入った時点で、M22 が置き換える (M12、M14、M15 を M21 が置き換えるのと同じ)。M16 の 2 つの赤は `m22_red_no_key_lock` と `m22_red_no_key_body` に当たる。M20 の赤の形は、M22 の緑の run (`swapTest`、`lateIntentTest`) で通ることを示した。
7. **本番の DO の SQLite での確かめ**。キーの正規形は、公開の後は変えられない (キーの表が残る)。照合順序のキーの検査を、承認された Cloudflare での計測に足すことを、そのときに頼む。**推奨**: 段 1 の前に、手元の workerd で流し、本番は次の承認された計測で流す。

## 決めたこと (2026-11-14)

持ち主は、刷新の 5 つをすべて公開の前に入れると決め、細部を任せた。
上の問いは、次のように進める。
違う判断があれば、段 2 の前に直す。

1. 主キー以外の UNIQUE を対象にした upsert は、文の形で基準経路にする。段 3 で費用を測り、大きければ、差分の検査が育ってから 1 行の upsert をシャードで解く最適化を足す。
2. 書き込みの行が増えることを認める。段 0 で今の数を記録し、段 3 で比べる。
3. 今断っている 4 つの形 (shard key を含まない NOCASE と RTRIM の UNIQUE、部分 index、式の UNIQUE index) は、段 2 で受け付ける。
4. キーの表は制約ごとに 1 つにし、名前ではなくカタログの番号で識別する。
5. shard key の列を BINARY 以外で比べる UNIQUE は同居にせず、2PC にする。
6. 実装が入ったら、M16 と M20 を M22 で置き換える。
7. 照合順序のキーの検査は、段 0 で手元の workerd でも流す。本番の DO の SQLite では、承認済みの Cloudflare での計測で流す (キーの形は公開の後は変えられない)。
