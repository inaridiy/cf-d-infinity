# subslot による配置の 2 段化の設計

状態：設計。持ち主の判断を末尾に記した (2026-11-14)。同じ日に、形式を token の区間に改めた (「結論」と「形式」の節)。段 1 (形式と配線) は実装した。段 2 から先の実装はまだない。モデルは M18 (`specs/m18_subslot_split.qnt`) にある
作成日：2026-11-14
前提：[scaling.md](./scaling.md)、[storage-format.md](./storage-format.md)、[specs/README.md](../specs/README.md) の M5b、M15、M18

コードの行番号は `8424e97` のもので、`src/` と `test/` は `packages/cf-d-infinity/` の下を指す。
今のコードの挙動についての記述は、コードを読んだ結果である。
試験は走らせていない。

## 結論

`SHARD KEY` 句をなくした後に残る 2 つの崖 (16 MB を超えるグループは運べない、1 つのテナントは 1 つのシャードを超えられない) を、配置の 2 段目で解く。
slot は今までどおり `hash(shard key)` で、これに `subslot = hash(主キーの全体) mod 65536` を足す。
2 つを並べた整数を行の token と呼び、範囲表は token の区間をシャードに対応させる。

| 要素 | 決定 |
|---|---|
| 行の token | `region × 2^32 + slot × 2^16 + subslot` の 40 ビットの整数。region はいまは 0。slot は `hashKey(shard key のキー文字列)` の上位 16 ビット (65,536 個。今までは 4,096 個)、subslot は `hashKey(主キーのキー文字列)` の下位 16 ビット。行ごとに保存するものはない |
| 範囲表 | token の半開区間 `[start, end)` をシャードに対応させる。同じ shard key の行は連続した 65,536 個の token (その slot のブロック) に載り、区間の境目をブロックの中に置くと、その shard key の行が 2 つのシャードに分かれる |
| span の claim | shard key で絞る span と全表の span が、宛先のシャードが持つ token の区間を運ぶ |
| piece | (グループ, fence の token の区間, 主キーの順の区間)。M18 の piece を、主キーの順でさらに切る |
| 答えの絞り込み | 行を絞らない。claim の外の行を持っている間は、断る |
| 分かれた slot の文 | 1 シャードで答えられない文は、基準経路で実行する |
| 段 | 4 段。形式、piece 単位の移動、分かれた slot の経路、slot を割る移動 |

決めた方向 (M18) から 2 点ずれる。
piece の境目を subslot の部分範囲ではなく主キーの順の区間にすることと、答えを絞らずに断ることである。
理由と、M18 が何を保証し続けるかは、それぞれの節に書く。

形式は、初めは (slot の範囲, subslot の範囲) の長方形で書いた。
2026-11-14 の設計の見直しで、1 本の token の区間に改めた。
置き場所は同じである。
長方形の案が作るのは、幅 1 の slot を subslot の範囲で切った項目だけで、それは「slot のブロックの中に境目を置いた区間」としてそのまま書ける。
区間にすると、範囲表の項目、claim、fence、piece の範囲が、どれも同じ 1 種類の物 (半開区間) になり、長方形を切り分ける規則も、slot の全体を表す 2 通りの書き方を揃える規則も要らなくなる。
token の上位 8 ビットを region として空けてあるので、行ごとに置く地域を決める拡張を、形式を変えずに足せる。
slot は、token の桁に合わせて 4,096 個から 65,536 個に細かくした。
前の slot 1 つは、いまの slot 16 個にちょうど当たるので、前の slot の境目は、どれも今の slot の境目でもある。
この文書の「形式」より後ろの節は、長方形の言葉のまま残してある。
「slot を subslot の範囲で割る」は「区間の境目を、その slot のブロックの中に置く」ことで、`sub` は「fence や claim の区間のうち、その slot のブロックに重なる部分」のことである。

持ち主の判断が要ることが 4 つあり、末尾にまとめた。

## 形式

### 行の token

`src/routing.ts` に、行の token を足す。

    token = region × 2^32 + slot × 2^16 + subslot

- region は、いまは 0 である。行ごとに置く地域を決める拡張のために 8 ビットを空けてあり、実装はしない。
- slot は `hashKey(sk)` の上位 16 ビットである (`SLOTS = 65536`)。今までは上位 12 ビット (4,096 個) だった。
- subslot は `subslotOf(pk) = hashKey(pk) & 0xffff` である (`SUBSLOTS = 65536`)。

token は 40 ビットで、JS の安全な整数に収まる。ビット演算は 32 ビットで切れるので、掛け算と足し算で作る。
`pk` は主キーのキー文字列で、`encodeKey` (`src/shard/rows.ts:134`) が作り、`Change.pk` と `__intents.pk` が持っている。
表の名前は混ぜない。
同じ shard key の行は、連続した 65,536 個の token に載る。これを、その slot のブロックと呼ぶ (`blockOf(sk)`)。
`slotOf(sk)` は、ブロックの最初の token を返す。区間の境目とそのまま比べられる。

主キーが 1 列の表、主キーのない表 (`pk = ["rowid"]`)、index の表 `__gidx_*` (`src/sql/ddl.ts:102`) では、主キーの文字列と shard key の文字列が同じなので、slot も subslot も 1 つの 32 ビットの hash から取ることになる。
ビットが重ならず、`hashKey` の最後の攪拌が全ビットを混ぜるので、slot を固定しても subslot は偏らない。
slot が上位 12 ビットだったときに、連番の整数キー 200 万個で、slot ごとの subslot の分布を 1 度だけ確かめた (偏りなし。スクリプトはリポジトリに入れていない)。
`test/routing.test.ts` は、slot を 16 個の束にまとめて、束ごとに subslot が片側に寄らないことを確かめる。

行ごとに保存するものは足さずに済む。
ただし、`hashKey` は JS の関数で、Durable Object の SQL の API には関数を足す入口がない (`docs/platform-facts.md` に足して確かめる)。
シャードは「subslot がこの範囲の行」を index で引けない。
この制約が、piece の切り方を決める。

### 範囲表

```ts
interface Interval { start: number; end: number }          // token の半開区間 [start, end)
interface RangeEntry extends Interval { shard: string }
```

項目の全体は、region 0 の token `[0, 2^32)` を重なりなく覆う。
形式は、境目をどの token にも置ける。
`planSplit` が slot のブロックの中に境目を置くのは、「増設の判断」の節の場合だけで、段 4 までは slot の境目 (65,536 の倍数) にだけ置く。
最初の範囲表は、65,536 個の slot をシャードの数で等分する。シャードの数が 4,096 を割り切れば、境目は今までと同じ位置になる。
最初の公開の前なので、`__routing` の既存の行との互換は持たない。

| 関数 (`src/routing.ts`) | 変更 |
|---|---|
| `tokenOf(sk, pk)`、`blockOf(sk)` | 行の token と、shard key のブロック |
| `ownerOf(r, sk, pk)` | `tokenOf(sk, pk)` を含む区間のシャード。`pk` を省くと、ブロックの全体を持つシャードを返し、ブロックが分かれていれば投げる (段 3 までの呼び出しと、試験のため) |
| `ownersOf(r, sk)` | `blockOf(sk)` に重なる区間のシャードの全部 (ふつうは 1 つ) |
| `regionsOf(r, shard)` | `rangesOf` (`:55`) の置き換え。`Interval[]` を返す |
| `applyMove(r, move)` | 重なる項目を切り分ける。今と同じ規則で、単位が token になる |
| `planSplit(r, parent, hint?)` | `{ start, end }` を返す (「増設の判断」の節) |

Meta は、`switchRange` (`src/meta.ts:144`) の持ち主の確認を区間の重なりで行う。
分割の枠 (`SplitSlot`、`beginSplit` から `checkSplit`、`:216` から `:249`) の同一性は、今と同じ (親, 子, `start`, `end`) である。

### シャードの記録

| 表 (`src/shard/core.ts:245` から `:249`) | 今 | 変更後 |
|---|---|---|
| `__fenced` | `(start, end, to, done)` | `(lo, hi, to, done)`。token の区間 `[lo, hi)` |
| `__incoming` | `(start, end, from_id)` | `(lo, hi, from_id, done, m)`。受け取り終えても消さない |
| `__moved` | `(g, m, dest, acked)` | `(g, lo, hi, after, up_to, m, dest, acked)`。主キーは `(g, lo, after)` |
| `__moved_txn` | `(txn, g, dest)` | `(txn, g, lo, after, dest)` |
| `__arrived` | `(g, m)` | `(g, lo, hi, after, up_to, m)` |

piece の記録の `lo`、`hi` は、その piece を切り出した fence の区間である。fence は重ならないので、`(g, lo, after)` で piece が 1 つに決まる。
`after` と `up_to` は位置で、JSON の文字列で書く。端は `null` の 4 文字である (主キーの列なので、SQL の NULL にはしない)。

`__intents`、`Change`、変更ログは変えない。
intent の subslot は `pk` から計算できる。

### 通信

- `Span.slots` (`src/types.ts:94`) を `Span.claim?: Interval[]` に替える。
- `GroupPayload` (`:289`) を `PiecePayload` に替える (次の節)。
- `pull`、`ack`、`finalize` と `abort` の `groups` (`:240` から `:256`) は、グループの名前ではなく piece を運ぶ。`ack`、`finalize`、`abort` が運ぶのは piece の名前 `{ g, range, after }` である。
- `beginIncoming`、`fence`、`moves`、`drain`、`finishMove`、`finishIncoming`、`listGroups` の範囲は、形は今の `{ start, end }` のままで、token の区間になる。列挙するのは今もグループで、`GroupCursor` (`:302`) の形は変えない。
- `PROTOCOL_VERSION` を 3 にする (`:480`)。

### `docs/storage-format.md` で変わる行

- 「行の置き場所」を token にする (固定)。
- シャードの `__fenced`、`__incoming`、`__moved`、`__moved_txn`、`__arrived` の形。
- Meta の `__routing` の説明 (token の区間からシャードへ)。
- 通信の `PROTOCOL_VERSION`。この行は今 1 と書いてあるが、コードは 2 である。
- `__gidx_<index>` の中身は変わらない。

保存の形式の版 (`STORAGE_FORMAT`) は 1 のままにし、材料を作り直す (公開の前なので許される)。
`test/fixtures/storage/format-1.json` は分割を 1 回含む (`test/upgrade.test.ts:107`) ので、移動の記録の表が入っている。

## piece の切り方

M18 の piece は (グループ, subslot の範囲) である。
1 通の応答に収めるには、大きなグループを subslot の部分範囲に切ることになるが、シャードは subslot で行を引けない。
切り方の候補は 3 つある。

| 案 | 境目 | 費用 |
|---|---|---|
| A | subslot の部分範囲。保存なし | piece を 1 つ運ぶたびに、グループの全行を読んで JS で選ぶ。1 GB のグループを 1 MB ずつ運ぶと、約 1 TB を読む |
| B | subslot の部分範囲。行ごとの subslot を、隠れた列と index か、別の表に持つ | 行ごとに書き込みが 1 つ増える。常に持てば全部の書き込みが、移動の前に作れば移動が、約 2 倍の課金になる。作っている間の書き込みにも保守が要る。隠れた列は「利用者の表を宣言のまま置く」という前提も崩す |
| C | 主キーの順の区間 | 読むのは運ぶ行だけ (slot を subslot で割る移動では、約 2 倍)。境目の比較が要る |

C を選ぶ。
**piece** は (グループ `g`, fence の token の区間 `range`, 位置の区間 `(after, upTo]`) で、`g` の行のうち、token が `range` に入り、位置が区間に入るものである。
**位置** は (表の名前, 主キーのキー文字列) で、表の名前の順、表の中は主キーの順に並ぶ。
`null` は端を表す。
1 通に収まるグループは `(null, null]` の piece 1 つになり、今の移動の単位と同じである。

```ts
type Pos = [table: string, pk: string] | null;
interface PiecePayload {
  g: string; range: Interval; after: Pos; upTo: Pos;
  m: Ts; rows: { table: string; row: Row }[]; intents: Row[]; schema: number;
}
```

これは決めた方向からのずれである。
M18 が覆い続ける範囲は、次のとおりである。
M18 の piece は番号で、モデルは piece が subslot で連続していることを使っていない。
1 つの fence の piece の全部が M18 の「移る piece」に、`sub` の外の行が「残る piece」に当たる。
claim は token の区間で、1 つの fence の区間に重なれば、その fence の piece の全部を含むものとして扱う (広く取る側である)。
これは M18 の claim (piece の集合) の特別な場合で、`m18_green_chunks` は任意の分け方で安全を確かめている (取引 X と読みの時刻を入れた場合の根拠は、ランダム探索だけである)。
覆われないのは、境目を pull のときに決めることである (M18 の「モデルにないもの」。「移動」の節で扱う)。

位置の比較は SQLite にさせる (`SELECT (?, ?) < (?, ?)` の行値の比較)。
主キーの列は BINARY の照合順序に限られる (`src/shard/rows.ts:131`) ので、束縛した値の比較は index の順序と一致するはずである。
段 2 で、乱択のキーの並びを SQLite の `ORDER BY` と突き合わせる試験を足す。
JS で SQLite の規則を写すことはしない (`src/keys.ts:37` に、写して外した記録がある)。
表の名前は親も子も同じ JS の比較で並べる。
グループが揃ったかどうかは、境目の文字列が等しいことだけで分かる。

## Worker の経路

### 宛先と claim

宛先は span から決める。
`rowSpan`、`groupSpan`、`scanSpans` (`src/client/spans.ts`) は変えず、claim は送るときに付ける。
`withSlots` (`src/client/db.ts:282`) を `withClaims` に替え、`resolve` と `groupByShard` (`:268`、`:329`) は `ownersOf` を使う。

| span | 宛先 | claim |
|---|---|---|
| 1 行 (`rowSpan`) | `ownerOf(routing, sk, pk)` | 付けない。token は主キーから決まる |
| shard key で絞る (`groupSpan`、`sks` のある `scanSpans`) | `ownersOf(routing, sk)` の全部 | そのシャードが持つ区間のうち、`blockOf(sk)` に重なる部分 |
| 全表 (`tableSpan`、`sk` のない条件) | 全シャード | そのシャードの区間の全部 (`regionsOf`) |

文をそのまま 1 つのシャードへ送る経路 (`shardRead`、`Txn.write`、`autoWrite`。`:336`、`:810`、`:2128`) は、文の span の全部がそのシャード 1 つに決まるときだけ使う。
shard key で絞る span の slot に持ち主が 2 つ以上あれば、`NeedsReference` (`:175`) を投げ、`runPlanned` (`:202`) が基準経路で計画し直す。
切り替えは今と同じ 1 か所である。

行を集める走査 (`scan`、`collect`、`conflicting`。`:392`、`:409`、`:913`) は、持ち主の全部に、それぞれの claim を付けて送る。
取引が変更を置くシャード (`:822`、`:894`、`:1107`) は `ownerOf(routing, c.sk, c.pk)` で決める。

### プランナ

`statementPin` (`src/sql/plan.ts:440`) が示すのは「文が 1 つのグループだけを読む」ことで、「1 つのシャードが答えられる」ことではなくなる。
`planRead` (`:748`) と `planUpdateDelete` (`:979`) は、主キーを名指ししているか、その slot が `cat.routing` で 1 つのシャードのものであるときだけ、そのまま送る計画を返す。
そうでなければ、部分集約、Top-N、`sks` つきの走査へ進む。
実行時の `NeedsReference` だけに頼らないのは、計画し直しが部分集約と Top-N を使わないからである (`reference: "scans"`、`src/client/db.ts:211`)。

`Scan.sks` (`src/sql/plan.ts:24`) の絞り込みは、「その shard key のシャード」から「その slot を持つシャードの全部」になる。
`planInsert` は行を `ownerOf(cat.routing, b.sk, b.pk)` でまとめる (`:913`)。
複数行の INSERT は主キーを 1 つに決められず、グループの span になる (`src/client/spans.ts:71`) ので、分かれた slot では基準経路になる。

### 分かれた slot で成否が変わる文

1 つの shard key に絞れている文を、形ごとに並べる。

| 文の形 | slot が 1 つのシャードにある | slot が分かれている | 置き場所で成否が変わるか |
|---|---|---|---|
| 主キーを等値で名指しする | そのまま送る | piece の持ち主へそのまま送る | 変わらない |
| 単表の集約 (`partialAggregate` の形) | そのまま送る | シャードごとに集約して合成する | 変わらない |
| 単表の条件、ORDER BY と LIMIT | そのまま送る | 条件と Top-N を押し下げて集める | ほぼ変わらない。集めるのは結果の行 (OFFSET があればその分も) で、上限は同じ 20 万行と 16 MB である |
| 結合、サブクエリ、窓関数、押し下げられない条件 | シャードの中で、何行でも読める | 入力の行を集める | **変わる**。入力が 20 万行か 16 MB (`src/client/db.ts:289`) を超えると断る |
| 条件つきの UPDATE と DELETE | そのまま送る | 条件に合う行を集めて Worker で実行する | 変更の合計 1 MB の上限が先に効く。押し下げられない条件があれば上の行と同じ |
| シャード内 UNIQUE の値を書く | 1 シャードの確定 | 同じ値の行を持ち主の全部から読む 2PC | 変わらない。遅くなる |

4 行目は、`AGENTS.md` の規則 4 と、計画書の不変条件 13 が禁じる形である。
1 つのシャードに収まらないテナントの結合は、基準経路で実行するしかなく、基準経路には集める予算がある。
slot を割るのは、そのテナントが 1 つのシャードを超えたときだけだが、割る直前まで通っていた文が、割った後に断られる。
これを文書に書く資源の上限として認めるかは、持ち主の判断である。

## シャード

### 所有の確かめ

`Rows.writes` (`src/shard/core.ts:148`) に `table` と `pk` を足す。
`fencedRange(sk)` と `incomingRange(sk)` (`:543`、`:547`) は、token `tokenOf(sk, pk)` か、区間 (ブロック `blockOf(sk)`、claim) で引く。
`assertOwned` (`:571`) の規則は次のとおりである。

| 対象 | 渡した側 | 受け取る側 |
|---|---|---|
| 1 行 (span、書く行) | 点が fence の中なら `NotOwner` | 受け取り中の範囲の点で、位置を含む piece が未着なら pull する。`T < m` なら `ReadTooOld`。受け取り終えた範囲では、`T` が範囲の床 (「drain と finishMove」の節) より小さければ `ReadTooOld` |
| shard key で絞る span | claim が fence に重なれば `NotOwner`。同じ slot に終わっていない fence があり、`g` を渡し終えていなければ `Migrating` | claim が受け取り中の範囲に重なり、`g` の piece が揃っていなければ pull する。期限を過ぎたら `Migrating`。`T` がどれかの `m` より小さければ `ReadTooOld` |
| 全表の span | claim が fence に重なれば `NotOwner`。移動の途中なら `Migrating` (今と同じ) | 今と同じ |

claim のない shard key の span は、ブロックの全体を claim したものとして扱う。
受け取った範囲の記録を持つシャード (分割で生まれたシャード) は、記録した範囲の外の点と、外にはみ出す claim も `NotOwner` で断る。
今のシャードは、fence した範囲と受け取り中の範囲しか知らないので、subslot で割った slot の残りの半分の行が届いても受けてしまう。
範囲の記録を消さずに残す (「drain と finishMove」の節) ので、この確かめができる。
渡した側は今と同じく、fence した範囲の要求を、m を決める前から断る (M18 の親より厳しい)。

`enter` (`:611`) の形は変えない。
`exec`、`execAuto`、`commitLocal`、`prepareSync`、`refresh`、`unchanged` はどれも `enter` を通るので、確定のときの検証にも同じ確かめが掛かる。

### 答えの絞り込み

M18 は、答える行を claim で絞ることを求める。
渡した側が、渡した行を ack まで持っているからである。
しかし、シャードが実行するのは利用者の文そのもので、集約や結合の結果から行を後で除くことはできない。

そこで、絞らずに断る。
渡した側は、同じ slot に終わっていない fence があり、そのグループの piece を全部渡して ack を受けていなければ、shard key で絞る span を `Migrating` で断る。
渡し終えたグループについては、手元の行は claim の中の行だけである。
これも決めた方向からのずれだが、失う可用性はない。
テナントの読みは両方のシャードの答えが要り、受け取る側は piece が揃うまで答えないので、渡した側が先に答えられても読みは揃わない。
渡した側の条件は、受け取る側の条件に ack の往復を足しただけである。

絞り込みが要るのは、移動の途中のテナントの読みを通すとき (claim の分け直し) で、そのときに足す。
検査は今入れる。
範囲の検査 (`deleteOutside`、`:1369`) が、claim の外の行を span の外として消すようにする。
claim の外の行に答えが依存すれば、どのシミュレータの試験でも落ちる。

### intent と時計

`pull` と `ack` は intent を `WHERE sk = ?` で選んでいる (`:748`、`:846`)。
これを、位置が piece の区間に入り、subslot が `sub` に入る intent に絞る。
`localIntents` (`:2053`) は、行の piece が渡してあるかで決め、`forwards` (`:2058`) は `__moved_txn` の piece ごとに転送する。

piece は m を運び、`receive` (`:830`) が piece ごとに時計を進める。

## 移動

### piece の pull

子は `pull({ want: [{ g, from } | { g, at }], to, start, end, maxBytes })` を送る。`start` と `end` は fence の区間である。
`from` は子がそのグループで揃えた位置の続きで、`at` は要求が名指しした行の位置である。
親は、1 つの同期区間で次を行う。

1. その位置を含む piece がもうあれば、同じ `m` と同じ境目で行を読み直して返す。
2. なければ、行を位置の順に読み (token が fence の区間の外の行は飛ばす)、`maxBytes` に達したところで切る。グループの終わりか、次の渡してある piece に達したら、そこを `upTo` にする。`at` の場合は、その位置の直前の行 (なければ、手前の渡してある piece の終わりか、先頭) を `after` にする。
3. 区間の intent を選び、`m` を発行して、`__moved` と `__moved_txn` に書く。

`m` と境目を同じ区間で決めて記録するので、再送は同じ piece を返す。
`m` を決めた piece の行は、親ではもう変わらない (phase 2 を適用しない)。
1 行は取引の大きさの上限 (1 MB、`MAX_WRITE_SET_BYTES`) を超えられないので、piece は必ず 1 行以上を運べる。
`GROUP_MAX_BYTES` (`:88`、`:752`) はなくなる。

今の手順 (M5b) との違いは、m の単位がグループから piece になること、所有を位置で引くこと、グループが揃ったかを子が数えること、の 3 つである。
fence、範囲表の切り替え、ack での削除、phase 2 の転送の順序は変えない。

### 書き込みが続く間の大きなグループ

fence の後、書き込みは子に届く。
主キーを名指しする文は、その行を含む piece だけを要求して進む (往復 1 回と、1 MB 以下の転送)。
グループの全体は待たない。

shard key で絞る文は、グループの全体が要る。
子は、そのグループの piece を続けて pull し、5 秒 (行ロックの待ちと同じ長さ) で揃わなければ `Migrating` を返して、背景で続ける。
シャード内 UNIQUE の値を書く文もこの形 (`src/client/spans.ts:65`) なので、文と prepare の UNIQUE の検査は、グループの全体を持つシャードで行われる。

適用は別である。
fence の前に置かれた intent は、piece と一緒に別々の時点に運ばれ、別々に適用される。
シャードをまたぐ取引 X が、同じグループの行 r1 (piece A) と r2 (piece B) の UNIQUE の値を、r2 は 'b' から 'c' へ、r1 は 'a' から 'b' へ変えるとする。
piece A が届き、X が確定し、子の読み手が r1 の intent を決着させると (`settleIntents` から `finalize`)、子の r1 は 'b' になる。
その後で piece B が、古い行 r2 = 'b' と intent を運んで届く。
`receive` (`:816`) は r2 を r1 の隣に挿入しようとして、シャードの UNIQUE の index に断られ、piece B は届かなくなる。
今は、グループの行と intent が 1 通で運ばれるので、この形はない (読んだだけで、走らせてはいない)。

規則を 1 つ足す。
親は、グループの最初の piece を切る前に、そのグループの intent のうち UNIQUE の値に触れるもの (UNIQUE のある表への挿入と削除、UNIQUE の列を変える更新) を、anchor に尋ねて決着させる。
確定していれば、グループの全体を持っているうちに、まとめて適用する。
決着が付かなければ、その pull は待たせる。
fence の後は、親に新しい intent は置かれず、子は UNIQUE の値を書く文をグループが揃うまで受けないので、最初の piece を切ってからグループが子で揃うまで、そのグループの UNIQUE の値は変わらない。
これは新しい守りなので、モデルを先に書く (M16 と M18 の組み合わせ)。
計画書の不変条件 2 に割り当てる。

転送は実測で 4.1 MB/s である (`scaling.md`)。
Worker のやり直しは 12 回で、合わせて 1 秒に満たない (`src/client/db.ts:260`、`:1985`)。
20 MB までのグループは今と同じく待って通るが、1 GB のテナントは約 4 分、10 GB なら約 40 分、主キーを名指ししない文が `migrating:` で失敗する。
今は、そのテナントは運べず、分割が終わらない。

### drain と finishMove

`drain` (`:853`) は、`listGroups` でグループを列挙し、グループごとに `from` を進めながら pull と ack を繰り返す。
`listGroups` が挙げるのは、fence の slot にあり、`sub` に行か intent を持ち、渡し終えていないグループである。
slot を subslot で割ると、グループは親にも残るので、今の終わり方 (ack 済みのグループは親から消え、列挙が空になる。`:858`、`:885`) は、この絞り込みがないと成り立たない。
`sub` に行のないグループは運ばれず、要求が来たときだけ、空の piece 1 つで答える。
`finishMove` と `finishIncoming` (`:890`、`:898`) の役割は変えない。
`finishIncoming` は、`__incoming` の行を消さずに `done` と `m` を残し、その範囲の `__arrived` の行を消す。
残した `m` が、その範囲の「床」になる。
piece の記録のない行 (渡す側に行がなかった位置) を `T < m` で読む要求は、`ReadTooOld` で断る。
`__arrived` を残さないので、piece の数だけ記録が増え続けることもない。
受け取り終えた範囲は、全部の piece が届いたものとして扱う。
起動のときの時計の再開 (`:264`、`:288`) は床の `m` も数え、遅れて転送されてきた `finalize` (`ensureArrived`) は、終えた範囲の piece を取りに行かない。

床は、M18 の「行のない piece」の扱いである。
読んだかぎりでは、今のコードにも同じ形の穴がある。
取引が T を取り、親がそのグループの行を全部消し (T より後、fence より前)、分割が終わってから、取引が子でそのグループを T で読む。
子には到着の記録がなく (`:576`)、`finishIncoming` は範囲の記録を消している (`:903`) ので、子は「行なし」と答える。
T の時点では行があった。
起きるのは、T が、子が表定義を適用した時刻より新しいか、子にまだ確定がない場合である (`deltaAfter`、`:1297`)。
`test/move-timestamp.test.ts` が確かめているのは、書き込みの時刻の側だけである。
走らせて確かめてはいないので、計画書の不変条件 8 に割り当て、先に `test/open/` に再現を置く。

### 増設の判断

`planSplit` は、親の最も広い範囲が 2 slot 以上なら、今と同じく slot の範囲を半分にする。
slot を subslot で割るのは、次の 2 つの場合である。

- 親の範囲が幅 1 の slot だけである (今は `null` を返して割れない、`src/routing.ts:62`)。その slot の subslot の範囲を半分にする。
- 負荷の半分以上が 1 つのグループに集中している。今は通知だけである (`src/autoscaler.ts:73`)。そのグループの slot を subslot で割る。

2 つ目には条件を付ける。
テナントを割ると、主キーを名指しする文は 2 つのシャードに分かれるが、shard key で絞る文は 2 つのシャードを読むようになり、重くなる。
`count` (`src/shard/core.ts:968`) で、いちばん負荷の高いグループの要求のうち 1 行の span だけのものの割合を数え、`ShardMetrics.topGroup` に足す。
その割合が低ければ、今までどおり通知にする。
閾値は実測で決める。

分割の手順 (`split`、`src/autoscaler.ts:138`) は、範囲 (token の区間) を運ぶだけで、段は変わらない。
子は新しいシャードに限る (今と同じ)。

## 2PC、index、エクスポート

**2PC**：参加者は piece の持ち主で決まる。
`prepare`、`commitLocal`、`refresh` は `enter` で piece ごとに確かめ、phase 2 は `__moved_txn` で piece ごとに転送する。
分かれた slot の中の 2 行を書く取引は、M18 の取引 X である。

**シャードをまたぐ UNIQUE の index**：`__gidx_*` の行は主キーも shard key も `k` で、`ownerOf(routing, sk, pk)` に同じ文字列を渡す。
項目の `(pk, sk)` から、元の行を持つシャードが 1 つに決まる (`conflicting`、`src/client/db.ts:949`。走査に主キーを持たせれば、そこだけを読める)。
形式は変わらない。

**シャード内 UNIQUE**：shard key を含む UNIQUE は、各シャードの SQLite の index が守っている (`src/sql/ddl.ts:252`)。
これは「1 つの shard key の行は 1 つのシャードにある」ことに頼っている (`src/shard/core.ts:1715`、`src/client/spans.ts:52`)。
分かれた slot では、書き込みが基準経路になり、同じ値の行を持ち主の全部から読む (`conflicting` の `want`、`src/client/db.ts:931`)。
その読みは取引の span なので、同じ値を並行して書く 2 つの取引は、確定の検証で片方が中止になる (M1)。
新しい仕組みは要らない。
`uniquePending` と M16 は、prepare の検査については、シャードの中の話のまま成り立つ。
piece ごとの適用には、「書き込みが続く間の大きなグループ」の節の規則が要る。

**既存の行への `CREATE UNIQUE INDEX`**：`Db.checkUnique` (`src/client/db.ts:1587`) も、各シャードの index の作成も、自分のシャードの行しか見ない。
分かれたテナントで、同じ値の行が 2 つのシャードにあれば、通ってしまう。
全シャードが版を適用した後で、分かれた slot の行を、作った index の順に両方から読んで突き合わせ、重複があれば `revokeDdl` で取り消す手順が要る。
これは新しい仕組みなので、モデルが先に要る (規則 3。M12 の拡張)。

**shard key の文字列で引くもので、変えないもの**：負荷の集計 (`stats.groups`、`topGroup`)、直近の書き込みの索引 (`touch` の `s\0表\0sk`)、`WritePlan.sk` の確認 (`src/shard/core.ts:1407`)、`uniquePending` のグループの絞り込み。
どれも 1 つのシャードの中の話で、そのシャードが持つ行について正しければ足りる。

**エクスポートと取り込み**：`exportPage` (`src/transfer.ts:13`) はシャードを順に読み、`exportRows` は移動の途中のシャードを断る (`src/shard/core.ts:928`)。
移動が終われば、行はちょうど 1 つのシャードにあるので、変更は要らない。
取り込みは INSERT なので、piece で宛先が決まる。

## 段

| 段 | 中身 | 落ちてから通る検査 | 規模 |
|---|---|---|---|
| 1 | 形式と配線。行の token、範囲表の token の区間、`Span.claim`、記録の表の形、`PiecePayload`。区間の境目は slot の境目だけで、piece はいつも `(null, null]` | slot を細かくするほかに挙動を変えない段なので、落ちる検査はない。代わりに次を確かめる。(a) `history` と `replay` の同じ seed で、RPC の列 (宛先とメソッド) が変更の前後で同じ。slot を細かくしたので、シャードの数が 4,096 を割り切らないクラスタと、半端な幅の分割では、境目が前の slot 1 つ未満だけ動く。境目を前の slot に合わせた版で、同じになることを確かめる。(b) 欠陥の表 (`scripts/fault-table.mjs`) の移動のスイッチの行が変わらない。(c) `applyMove` を乱択で重ねても、どの token にも持ち主がちょうど 1 つある。(d) 作り直した材料で `test/upgrade.test.ts` が通る | 約 600 行、2 から 3 日 |
| 2 | piece 単位の移動。`pull`、`receive`、`ack`、`drain`、`assertOwned`、範囲の床 | 先に、今のコードで、1 通で運べる大きさの上限 (`GROUP_MAX_BYTES`) を `ShardDeps` から小さくできるようにし、`replay` に分割を足す (今は 3 シャード固定、`test/replay.test.ts:193`)。上限を小さくすると、`history`、`elle-sim`、`replay` の分割が「group too large to move」で止まる。段 2 の後は、同じ seed で、どのグループも数個の piece に分かれて運ばれ、検査が通る。`replay` の表は `UNIQUE (tenant_id, code)` を持つ (`test/replay.test.ts:18`) ので、piece ごとの適用と UNIQUE の形にも届くはずである | 約 1,100 行、5 から 7 日。先に、M18 に行のない piece を足し、UNIQUE と piece の適用のモデルを書く |
| 3 | 分かれた slot の経路。`withClaims`、`ownersOf`、プランナ、`NeedsReference`。移動はまだ slot の全体だけ | `SimOptions` (`test/sim.ts:295`) に、最初の範囲表で全部の slot を subslot で 2 つのシャードに分ける指定を足す。SQLite と突き合わせる検査 (`slt`、`fuzz`、`typed-diff`、`unique-conflicts`、`replay`) をその置き方で流す。段 3 の前は、テナントに絞った文が片方のシャードの行しか返さない。本番では、段 4 まで `sub` つきの項目はできない | 約 700 行、3 から 4 日 |
| 4 | slot を subslot で割る移動と `planSplit`。`listGroups` の `sub`、受け取った範囲の外を断る確かめ。既存の行への UNIQUE index の突き合わせ | `history`、`elle-sim`、`replay` の分割が、slot の分割と subslot の分割を乱択で選ぶ。M18 の `splitTenantTest` と、`halfArrivedTest` のうち claim の分け直しを除いた部分を、実コードで再生する。段 3 の置き方で見つかる UNIQUE index の重複は、段 3 で `test/open/` に置き、ここで通す | 約 900 行、5 から 7 日。UNIQUE index のモデルが先 |

M18 の赤と、欠陥のスイッチ (`Faults`、`src/types.ts:372`) の対応は次のとおりである。
再生は、その形に届く最初の段で足す。

| モデル | スイッチ | 戻す欠陥 | 段 |
|---|---|---|---|
| `m18_red_partial_answer` | `staleWideRead` を広げる | 渡した側が、fence に重なる claim の shard key の span を断らず、残りを答える | 4 |
| `m18_red_child_partial` | `partialGroupRead` | 受け取る側が、グループの piece が揃う前に shard key の span に答える | 2 |
| `m18_red_answer_held` | `answerHeldRows` | 渡した側が、渡し終えていないグループの shard key の span に答える | 4 |
| `m18_red_piece_without_clock` | `pieceWithoutClock` | `receive` が piece の m まで時計を進めない | 2 |
| `m18_red_write_by_slot` | `ownBySlot` | 受け取る側が、グループの piece が 1 つでも届いていれば、どの行の書き込みも受ける (段 2)。subslot を見ずに slot だけで持ち主を決め、受け取った範囲の外の点も受ける (段 4、モデルの 2 本の run) | 2、4 |
| `m18_red_intents_by_group` | `intentsByGroup` | `pull` と `ack` が intent を `WHERE sk = ?` で選ぶ | 2 |

今あるスイッチ (`applyAfterMoved`、`dropIntentsOnMove`、`servePastMove`、`ignoreFence`、`finishWithoutClock`) は、piece ごとの同じ守りを外すものとして残す。

段ごとの危険は次のとおりである。

- 段 1：ここで固めた形式が Early 版の形式になる。位置の書き方を後から変えるには移行が要る。
- 段 2：RPC の列が変わるので、控えてある seed (夜間の記録、`test/open/`) は、どれも別の実行になる。入れる前に、未解決の seed を片付けるか、再現を seed に頼らない形にする。大きなテナントの移動の間、保守の操作の枠が長く取られ、表定義の変更が待つ (M15 の「モデルにないもの」と同じ)。
- 段 3：上の表の 4 行目 (結合の入力の予算)。分かれたテナントへの複数行の INSERT と UNIQUE の値の書き込みが、基準経路と 2PC になって遅くなる。
- 段 4：移動の間、その slot のテナントの、主キーを名指ししない文が失敗する。slot の範囲を半分にする分割が、大きなテナントを何度も運ぶことがある。

## 切るもの、後に回すもの

- 移動の途中のテナントの読みを通す仕組み (Worker が claim を piece で分け直す)。M18 は安全だけを確かめていて、Worker が分け方を知る手順と活性はモデルにない。モデルが先である。
- 分かれた slot への、条件つきの UPDATE と DELETE をシャードごとに実行する最適化と、複数行の INSERT の span を 1 行ずつに狭める規則。範囲の検査に通してから足す。
- 両端がどちらもブロックの中にある区間 (2 つの slot を途中で切る)、既存のシャードへの移動、シャードの併合。形式は許すが、作らない。
- 主キーの前半だけで subslot を決める指定 (たとえば、テナントの中の利用者ごとに行を集める)。
- pull の並列化。

## M18 の「モデルにないもの」と実装

| M18 にないもの | 実装での扱い |
|---|---|
| 行のない piece | 範囲の床 (`__incoming` の `m`)。M18 に `finishRange` を足してから実装する |
| 2 つ目のグループ | piece の記録はグループごと。shard key の span の規則もグループごとで、同じ slot の小さなテナントは、1 回の pull で両側が答えられるようになる |
| テナントの読みを含む取引の検証 | `enter` が、確定のときにも claim を確かめ直す |
| 子の再分割、範囲表の版が 3 つ以上 | fence と claim は区間の重なりで判定する。受け取り中のシャードは fence しない (今と同じ)。`test/migration.test.ts` の連鎖の試験を、subslot の分割で増やす |
| ack で控えを消す | ack は piece の区間と `sub` で行と intent を消す |
| piece の境目、16 MB を超える 1 行 | 境目は最初の pull で m と一緒に記録する。1 行は 1 MB 以下である |
| 活性 | 確かめていない。大きなテナントの移動の間の失敗は、上に数字で書いた |
| 3 つの piece と取引 X | ランダム探索だけである。段 2 と段 4 の乱択の検査が受け持つ |

M18 が扱っていない UNIQUE は、piece ごとの適用を「書き込みが続く間の大きなグループ」の節に、書き込みの検査と既存の行への index を「2PC、index、エクスポート」の節に書いた。

## 持ち主の判断 (2026-11-14 に決まった)

1. 4 段をすべて、最初の公開 (Early 版) の前に入れる。
2. piece の境目は、主キーの順の区間にする (案 C)。
3. 大きなテナントの移動の間に、主キーを名指ししない文が失敗するのは認めない。claim を piece で分け直す仕組みを、モデルと実装の両方で、段 2 の前に入れる。
4. 1 つの slot を割るのは、そのシャードの容量 (10 GB) に近づいたときだけにする。分かれたテナントで、結合などの入力が集める予算を超えて断るのは、資源の上限として文書に書く。集める量を減らす仕組み (semijoin、段を分けた集め方) は、その次にする。
5. 既存の行への `CREATE UNIQUE INDEX` の突き合わせ (分かれたテナント) は、モデルを書いてから段 4 で入れる。

以下は、決める前に挙げた問いである。

## 持ち主の判断が要ること (決める前の問い)

1. piece の境目を主キーの順の区間にすること (案 C)。subslot の部分範囲にこだわるなら、案 B の課金を受け入れることになる。
2. 分かれたテナントで、結合などの入力が集める予算を超えると断ること。この案は、資源の上限として文書に書いて認める側である。割らなければ、そのテナントはシャードの容量 (10 GB、`scaling.md`) で止まる。認めなければ、段 4 (slot を割る) は、基準経路の予算を広げる仕組み (階層的な fan-out、semijoin) の後になる。
3. 大きなテナントの移動の間、主キーを名指ししない文が失敗すること。この案は、認めて文書に書き、claim の分け直しを最初の続きにする側である。認めなければ、分け直しのモデルと実装が、段 2 の前に要る。
4. 既存の行への `CREATE UNIQUE INDEX` の突き合わせを、段 4 の前提にすること。モデルを書く分だけ、段 4 が延びる。
