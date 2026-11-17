# CatalogEpoch による Meta の一本化の設計

状態：設計。段 1 (列と畳み込み)、段 2 (要求が epoch を運ぶ)、段 3 (DDL の 2 相化)、段 4 (移動) を実装した (2026-11-15 と 16、末尾の「段 1 の結果」から「段 4 の結果」)。モデルは M21 (`specs/m21_catalog_epoch.qnt`) にあり、結果は [specs/README.md](../specs/README.md) の M21 の節に書いた。持ち主の判断が要ることと決めたことは、「段 1 の結果」の前にまとめた。
作成日：2026-11-14
前提：[overview.md](./overview.md)、[design-subslots.md](./design-subslots.md)、[specs/README.md](../specs/README.md) の M11 から M15、M18、M19、M5b

関数と行の番号は `71eda05` のもので、`src/` と `test/` は `packages/cf-d-infinity/` の下を指す。
`src/shard/core.ts` は別の作業で書き直している最中なので、名前は変わり得る。
今のコードの挙動についての記述は、コードを読んだ結果で、試験は走らせていない。

## 結論

Meta は今、5 つの版と排他を別々に持っている。
DDL の版と事後の取り消し (`revokeDdl`、逆操作の SQL `undo`)、シャードをまたぐ UNIQUE の index を作る間の書き込み禁止 (`building`、`build_lease`、M12)、DROP の前の書き込み禁止 (`guard`、M14)、分割と DDL の枠 (`SplitSlot`、M15)、範囲表の版である。
これを、1 本の単調な列 (以下 **epoch の列**) と、その上の 1 種類の遷移に置き換える。

| 要素 | 決定 |
|---|---|
| epoch の列 | Meta の表 `__epoch(epoch, rec)`。追記だけで、1 行が 1 つの epoch。記録は `prepare`、`commit`、`abort`、`move-start`、`move-end` の 5 種類 |
| スナップショット | epoch `e` の表定義、表の状態、範囲表は、列の先頭から `e` までを畳んだもの。`Catalog` を置き換える |
| 表定義の遷移 | どの DDL も `prepare` から `commit` か `abort` へ進む。`prepare` は対象の表を書き込み禁止にし、全シャードが適用して確かめに通ったときだけ `commit` を記録する。同時に開くのは 1 つ |
| 移動の遷移 | 分割は `move-start` から `move-end` へ進む。取り消しはない。`move-start` が、範囲表の切り替えであり、親の fence であり、子の受け取りの始まりである |
| 遷移どうしの排他 | 表定義の遷移と移動は、同時に開かない (両方向)。移動どうしは、区間とシャードが重ならなければ並ぶ。枠 (`SplitSlot`) はなくなり、Meta が記録を足すときの条件になる |
| シャードが比べるもの | 要求は `epoch` (Worker のスナップショット) と `schema` (その中で表定義が最後に変わった epoch) を運ぶ。シャードは `schema` が等しいことを確かめ、所有は自分のスナップショットで引く |
| 取引が名乗る版 | `schema` を、確定まで名乗り続ける (M13 のまま)。範囲表だけが進んだ epoch は、取引を古くしない |
| `schema` が進む記録 | `prepare`、`commit`、`abort` のどれでも進む。`commit` だけで進める案を、モデルで確かめたうえで、持ち主の判断に挙げた |
| 逆操作 | なくなる。`abort` は禁止を解き、`prepare` が作った空の index の表を名前で消すだけである |
| 止まった進め方 | DDL は、`commit` の記録までなら Meta が期限 (5 秒、上限 5 分) で `abort` を記録する。移動は、`move-start` の後は子が自分で進める |
| 未解決の問題 17 | 主キーを名指しする読みと書きについて、窓がなくなる。全表の読みは、移動が終わるまで `migrating:` のままである |
| 段 | 4 段。列と畳み込み、要求が epoch を運ぶ、DDL の 2 相化、移動 |

刷新の提案 (2026-11-14 の、作り直しの 5 つの案。リポジトリには置いていない) の 3 から、4 点ずれる。

1. 要求が運ぶ数は 1 つではなく 2 つである。1 つの epoch が等しいことを求めると、分割のたびに、その記録を知ったシャードが、関係のない取引を全部断る (M21 の `m21_red_strict_epoch`)。
2. 移動の区間の中の所有は、Meta に持ち込まない。piece ごとの所有は、親と子の手元の記録で決まる (M5b、M18、M19 のまま)。
3. 「逆 DDL が一切要らない」は、利用者の表については成り立つ。index の表 (`__gidx_<index>`) は `prepare` で作るので、`abort` を適用したシャードが名前で消す。
4. 分割の始まりは、シャードの確かめを待たない。`move-start` と `move-end` の 2 つの記録が、1 つの遷移の始まりと終わりに当たる。

## epoch の列とスナップショット

### 記録

```ts
/** Meta の列の 1 行。epoch は行の番号で、1 から始まる。 */
type EpochRecord =
  | { kind: "prepare"; mode: "plain" | "trial" | "build" | "guard"; ddl: ParsedDdl; fence: string[]; staging?: { sql: string[]; defs: TableDef[] } }
  | { kind: "commit"; of: number; at?: Ts }
  | { kind: "abort"; of: number; reason: string }
  | { kind: "move-start"; from: string; to: string; start: number; end: number }
  | { kind: "move-end"; of: number };
```

- `prepare.ddl` は、今の `DdlEntry` が運ぶもの (シャードで実行する文、表定義、Worker の SQLite で再生する文) である。実行するのは `commit` を適用するときで、`prepare` では実行しない。
- `prepare.fence` は、書き込み禁止にする表である。行か形が、`prepare` から `commit` まで変わってはならない表を入れる (表を消す、名前を変える、列を足す、行を確かめる、行を読んで index を作る)。新しい表を作るだけの DDL では空になる。
- `prepare.staging` は、`prepare` を適用したシャードが作る内部の表 (作る文と表定義) である。`build` の `__gidx_<index>` だけが使う。進める側は、`commit` の前に、この表へ項目を書く。`abort` を適用したシャードは、`defs` の名前で表を消す。
- `commit.of`、`abort.of`、`move-end.of` は、終える遷移を始めた epoch である。
- `commit.at` は、index を公開する `commit` が運ぶ時刻である (今の `DdlEntry.at`、M12 の時計のモデル)。

今の `DdlEntry` の `reverts`、`reason`、`guard`、`ParsedDdl` の `undo`、`build`、`TableDef` の `building`、`locked` はなくなる。
書き込み禁止は表定義の印ではなく、スナップショットの表の状態になる。

### 保存

| 場所 | 今 | 変更後 |
|---|---|---|
| Meta | `__ddl(version, entry)`、`__routing(version, body)` | `__epoch(epoch INTEGER PRIMARY KEY, rec TEXT NOT NULL)` の 1 表 |
| Meta の `__meta` | `splits` (枠)、`build_lease` (期限) | `lease` (開いている表定義の遷移の期限。`{ epoch, started, until }`)。`splits` はなくなる |
| シャード | `__ddl(version, entry)` | `__epoch(epoch, rec)`。Meta の列のうち、適用した分の写し |
| シャードの `__fenced`、`__incoming` | `fence`、`beginIncoming` の RPC が行を作る | `move-start` の適用が行を作る。形は変えない |

最初の範囲表は、今と同じく、最初に範囲表を引いたときに作る (`MetaCore.routing`、`src/meta.ts:143`)。
列の上では、epoch 0 のスナップショットが持つものとして扱う。
最初の公開の前なので、`__ddl` と `__routing` からの移行は書かない。

### スナップショット

```ts
interface Snapshot {
  epoch: number;
  /** 表定義が最後に変わった epoch。prepare、commit、abort の記録で進み、移動の記録では進まない。 */
  schema: number;
  tables: Record<string, TableDef>;
  views: Record<string, string>;
  indexes: Record<string, IndexInfo>;
  ddl: string[];
  /** 開いている表定義の遷移。書き込み禁止の表は open.fence である。 */
  open: { epoch: number; mode: string; fence: string[] } | null;
  /** 範囲表。moving のある項目は移動の途中で、宛先は shard (子)、渡す側は moving.from である。 */
  routing: { ranges: (Interval & { shard: string; moving?: { from: string; epoch: number } })[] };
  /** 最後の表定義の記録が abort なら、その遷移と理由。DDL を出した側が、失敗を利用者へ返すのに使う。 */
  aborted?: { of: number; reason: string };
}
```

畳み込みは、副作用のない関数にして `src/catalog.ts` (新しいファイル) に置く。
Meta、シャード、Worker が同じ関数を使い、M21 の遷移の条件と突き合わせる試験も、この関数を相手にする。
`commit` された DDL だけが `tables` と `ddl` に入るので、Worker の SQLite で再生する文から、取り消された文を除く処理 (`MetaCore.current` の `reverted`、`src/meta.ts:329`) は要らない。

## 遷移

### 表定義の遷移

どの DDL も、同じ 3 手で進む。

1. Meta が `prepare` を記録する (`MetaCore.prepare`)。文は、今と同じく、Meta の SQLite の空の表で確かめてから記録する (`replayShadow`、`src/meta.ts:120`)。空の表への実行は巻き戻し、`commit` を記録するときにもう一度実行して残す。
2. 進める側 (DDL を出した Worker の呼び出し) が、全シャードに `prepare` を適用させ、確かめの答えを集める。
3. 全シャードが ok なら、Meta が `commit` を記録する。そうでなければ `abort` を記録する。

`prepare` の間に何をするかは、`mode` で違う。

| mode | DDL | シャードが `prepare` を適用した後で答えること | 進める側が `commit` の前にすること |
|---|---|---|---|
| `plain` | CREATE TABLE、CREATE VIEW、DROP VIEW、DROP INDEX、行で失敗しない CREATE INDEX と ADD COLUMN、RENAME TO、取引が読んでいない表の DROP TABLE | 適用したこと | なし |
| `trial` | シャード内の UNIQUE index、式か WHERE のある index、CHECK か NOT NULL のある ADD COLUMN | 巻き戻す取引の中で文を実行し、SQLite が通したか | 分かれたテナントがあれば、その行を突き合わせる (下の「token の区間の移動との関係」) |
| `build` | 行のある表への、シャードをまたぐ UNIQUE の index | 適用したこと | 止まった行を読み、項目を書く。読んだ時刻の最大を `commit.at` に載せる (今の `buildIndex`) |
| `guard` | 取引が読んだ表の DROP TABLE | 適用したこと | 取引が読んだ範囲に、読んだ時刻より後の変更がないことを、各シャードに確かめる (今の `unchanged`) |

`fence` が空なのは、CREATE TABLE、CREATE VIEW、DROP VIEW、DROP INDEX、行で失敗しない CREATE INDEX である。
ほかの DDL は、対象の表を `fence` に入れる。

`trial` の試し方は、rollback-read と同じ形である (`ShardCore.rollback`、`src/shard/core.ts:1379`)。
表は書き込み禁止なので、試した結果は `commit` の適用まで変わらない。
`commit` を適用するシャードは、同じ文をもう一度、今度は残す形で実行する。

`plain` でも `prepare` を挟む理由は 2 つある。
1 つ目は、表を消す DDL と名前を変える DDL で、DDL が完了を返した後の書き込みが失われないことを、Meta の 1 つの条件 (全シャードの ok) で守れることである。今は、Worker が全シャードへ適用させてから完了を返すことで守っている (`Db.changeSchema` の `syncRecorded`、M11 の `m11_red_no_sync`)。
2 つ目は、進め方が 1 通りになることである。
新しい表を作るだけの DDL では `fence` が空なので、`prepare` の往復は、全シャードに届くことを確かめるだけになる。この往復を省くかどうかは、持ち主の判断に挙げた。

### 移動の遷移

1. Meta が `move-start` を記録する (`MetaCore.startMove`)。この epoch から、区間の宛先は子である。
2. 子は、`move-start` を適用すると受け取り中になり、行を親から引き取る (`pull`、`drain`)。親は、`move-start` を適用すると、その区間の書き込みと prepare を断る。
3. 子が受け取り終え、親の時計を受け取った後で (`finishMove`、`finishIncoming`)、Meta が `move-end` を記録する (`MetaCore.endMove`)。

今の手順 (`split`、`src/autoscaler.ts:137`) から消える手は、枠を取る (`reserveSplit`、`beginSplit`)、子が受け取り始める (`beginIncoming` と `startSplit`)、親が fence する (`fence` と `checkSplit`)、範囲表を切り替える (`switchRange`)、枠を返す (`endSplit`) の 5 つで、`startMove` の 1 手になる。
`pull`、`receive`、`ack`、`drain`、`finishMove`、`finishIncoming` は変えない。変わるのは、`pull` と `listGroups` と `finishMove` の要求が `move-start` の epoch を運び、親が、その epoch まで列を適用してから答えることである。

`move-start` には、シャードの確かめがない。
今の手順が子の受け取りを親の fence より先に済ませるのは、親が「持ち主は子だ」と断った時点で、子が受け取れる状態になっているためである。
`move-start` を適用した子は、記録そのもの (`from`、区間) から受け取りを始められるので、先に済ませる手が要らない。

### 同時に開ける遷移

Meta は、記録を足すときに、開いている遷移を見る。

| 足す記録 | 表定義の遷移が開いている | 移動が開いている |
|---|---|---|
| `prepare` | 断る (`SchemaBusy`。待ってやり直せる) | 断る (同じ) |
| `move-start` | 断る (`SplitBusy`) | 区間が重ならず、親も子も、開いている移動の親でも子でもなければ記録する |

`move-start` は、ほかに次を確かめる。区間の全体を親が持っていること (今の `switchRange` の `from` の確認、`src/meta.ts:160`)、子が、ほかの区間を持たないか、同じ移動の子であること (今の `split` の `owned` の確認、`src/autoscaler.ts:159`)。
今はシャードが手元の記録で断っている 3 つ (受け取り中のシャードは fence しない、送り出し中のシャードは受け取らない、同じ範囲を 2 つの子へ送り出さない。`src/shard/core.ts:713` から `:738`) は、範囲表の項目の状態から Meta が断れる。

表定義の遷移と移動を並べないのは、移動の途中のシャードが表定義の記録を適用しないからである (`applySchema`、`src/shard/core.ts:479`)。
運ぶ行と intent の形が、受け取る側の表と合わなくなる。
列は順に適用するので、移動の途中に表定義の記録が入ると、そのシャードは、それより先の epoch の要求を、移動が終わるまで断ることになる。
これは M15 の `servable` で、枠がなくなっても、条件としては残る。

表定義の遷移を 1 つずつにするのは、`prepare` のときの確かめ (Meta の空の表での実行、シャードの試適用) が、`commit` までに表定義が変わらないことを前提にするからである。
index を作っている間に同じ表の DROP が確定すると、index の `commit` は、消えた表に適用できない (`m21_red_two_open`)。
別々の表の遷移を並べる余地はあるが、今と同じく 1 つずつにしておく。

## シャード

### 列の適用

`ensureSchema`、`reachSchema`、`applySchema`、`schemaFailed` (`src/shard/core.ts:434` から `:519`) を、列の適用に置き換える。
シャードは、`MetaCore.epochsSince` (今の `ddlSince`) で続きの記録を取り、順に 1 つずつ適用する。

| 記録 | 適用の前 | 適用 (1 つの同期の取引) |
|---|---|---|
| `prepare` | `fence` の表の intent を、anchor に尋ねて決着させる (今の `settleAllIntents`) | `staging` の表を作る。`__epoch` に書く。以後、`fence` の表への書き込みを断る |
| `commit` | なし (`fence` の表に intent はない) | `ddl.sql` を実行する。`__epoch` に書く。`at` があれば時計を進める。`ddlFloor` を取り直す |
| `abort` | なし | `staging` の表を消す。`__epoch` に書く。禁止が解ける |
| `move-start` | なし (intent は決着させない。行と一緒に運ぶ) | 自分が `from` なら `__fenced` に、`to` なら `__incoming` に行を足す。`__epoch` に書く |
| `move-end` | なし | `__epoch` に書く |

`prepare` の適用が intent の決着を待っている間、そのシャードは、古い `schema` の新しい要求を受けない (今の `ensureSchema` の `schemaChange` の確認、`src/shard/core.ts:440`)。受けると intent が増え続けて、禁止を掛けられない。
表定義の記録は、移動の途中のシャードでは適用しない (今と同じ)。Meta が並べないので、起きるのは Meta の条件が破れたときだけである。

遅れているシャードと、分割で生まれたシャードは、`prepare` と、その `abort` を続けて見ることがある。
このときも、2 つを順に適用する。
`prepare` の適用は、禁止の印を付け、空の `__gidx_<index>` を作るだけで、`abort` の適用がそれを戻す。
利用者の表に触る文は `commit` にしかないので、今の「取り消された版と、取り消す版の両方を飛ばす」処理 (`applySchema` の `skip`、`src/shard/core.ts:483`) は要らない。
`commit` が記録されるのは、範囲表の全シャードが `prepare` を適用した後だけなので、`prepare` と `commit` を続けて見るのは、後から生まれたシャードだけである。その表は空なので、`commit` の文は行で失敗しない。

`commit` の適用が失敗するのは、試適用に通った文が、同じ行に対して通らない場合である。保存の障害のほかには、起きないはずである。
起きたときは、今の「取り消せなかった版」と同じ扱い (`schemaStuck`、`health` が報告する) にし、取り消しはしない。

### 要求ごとの確かめ

要求 (`ExecReq`、`PrepareReq`、`CommitReq`、`refresh`、`unchanged`) は、`schema` に加えて `epoch` を運ぶ。
`schema` の値は、Worker のスナップショットの `schema` (epoch の番号) になる。
シャードは、同期区間に入るたびに (`enter`、`src/shard/core.ts:675`)、次の順で確かめる。

| 確かめ | 規則 | 今の何を置き換えるか |
|---|---|---|
| 表定義 | 要求の `schema` が自分のスナップショットの `schema` より大きければ、列を適用してから確かめ直す。小さければ `stale epoch` で断る | `ensureSchema` と `enter` の版の確認。規則は同じ |
| 所有 (1 行、shard key の範囲) | 自分のスナップショットの範囲表で、その token の区間が自分のものでなければ断る。ただし、要求の `epoch` が自分の `epoch` より大きければ、先に列を適用して確かめ直す | `__fenced` の終わった行による拒否。子が範囲を知る手 (`beginIncoming`) |
| 所有 (全表の範囲) | 要求の claim (Worker の範囲表でこのシャードが持つ区間) が、自分のスナップショットで自分の区間に含まれなければ断る | claim と `__fenced` の重なりの確認 (`assertOwned`、`src/shard/core.ts:645`) |
| 書き込み禁止 | 書く表が `open.fence` にあれば `TableLocked` で断る | `assertUnlocked` (`:1854`)。印の置き場所だけが変わる |
| 移動の区間の中 | piece ごとの規則 (到着、時刻 m、`Migrating`、`ReadTooOld`)。変えない | 変えない |

要求が `epoch` も運ぶのは、子が遅れているときのためである。
子は、`move-start` を適用するまで、自分が宛先だと知らない。
Worker の `epoch` が自分より新しければ、断る前に列を適用する。
Worker の `epoch` が自分以下なら、古いのは Worker で、Meta に尋ねずに断れる。

`epoch` が等しいことは求めない。
求めると、分割の記録を適用したシャードが、動いていない行の、分割より前に始まった取引まで断る。
範囲表の記録は、関わらないシャードは適用しなくてよい。要求の `schema` が等しく、行が自分のものであれば、そのシャードは Meta に尋ねずに答える。
このため、分割の記録が増えても、Meta への問い合わせは、親と子と、その行に触った Worker の分だけである。

「親が `move-start` を適用した」ことが fence である、と言えるのは、書き込みと prepare についてである。
読みは、piece ごとの規則に従う。M19 は、親が、まだ渡していない piece の読みに答えることを求めている (`specs/README.md` の M19 の「モデルが実装に求めること」)。
M21 の親も、`move-start` を適用した後、渡す前の行の読みに答える。

### 表定義の epoch が進む記録

`schema` は、表定義の記録 (`prepare`、`commit`、`abort`) のどれでも進む、とした。
今の index の作成と DROP の前の禁止が、禁止の版と終わりの版の 2 回、版を進めるのと同じである。
この決め方では、どの DDL も、失敗したものも含めて、開いている取引を 2 回古くする。今は、ふつうの DDL は 1 回、取り消された DDL と、index の作成と、読んだ表の DROP は 2 回である。

`prepare` と `abort` は、表定義の中身を変えない。変えるのは表の状態 (書き込み禁止) だけで、それはシャードが、要求の `schema` に依らずに断る。
そこで、`schema` を `commit` だけで進める案がある。
`prepare` より前に計画した書き込みは、禁止が掛かっている間は `TableLocked` で断られ、`abort` を適用した後のシャードでは、計画し直さずに通る。`commit` を適用したシャードでは、今までどおり古い計画として断られる。
取引が古くなるのは、DDL が確定したときの 1 回だけになり、失敗した DDL は、ほかの表の取引に見えない。

M21 は、この案を、index の作成と、行で失敗し得る DDL の場面で確かめた (`m21_alt_commit_only_build`、`m21_alt_commit_only_check`)。
「シャードは、自分が ok と答えた `prepare` より古い計画を受けない」(`noServeBelowAck`) は、この案では定義から成り立たないので除き、残りの不変条件に違反はなかった。
赤は、どれも「どの記録でも進む」決め方の上で確かめてある。
どちらを採るかは、持ち主の判断に挙げた。この文書の残りは、「どの記録でも進む」として書いてある。

### 確かめ直し

`enter` が待ちの後で確かめ直す規則は、そのまま残る。
M21 は、これを外すと、待つ前に通った古い計画が、`prepare` に ok と答えた後のシャードで受け付けられることを示す (`m21_red_no_recheck`。M11 の BUG-3 と同じ形)。

## Meta と Worker

### Meta の入口

| 新しい入口 (`MetaCore`) | 置き換えるもの |
|---|---|
| `snapshot()` | `catalog` |
| `epochsSince(epoch)` | `ddlSince` |
| `prepare(sql, opts, basedOn)` | `applyDdl`、`lockTables`。`basedOn` は呼び出し側のスナップショットの `schema` で、違えば `SchemaMoved` |
| `commit(epoch, acks, at?)` | `publishIndex`、`finishLock`、今の「記録して終わり」の DDL |
| `abort(epoch, reason)` | `revokeDdl` |
| `renew(epoch)` | `renewLock` |
| `startMove(move)` | `beginSplit`、`startSplit`、`checkSplit`、`switchRange` |
| `endMove(epoch)` | `endSplit` |
| `moves()` | `splits` |

`commit` は 3 つを確かめる。その遷移が開いていること、`acks` が範囲表の全シャードを含むこと、期限が切れていないこと (先に `expire` を通す)。
`basedOn` の意味は変わる。今は「全シャードが適用し終えた版」で、取り消しを安全にするためにある (`applyDdl` の注釈、`src/meta.ts:365`)。取り消しがないので、「文を解釈した表定義が最新である」ことだけを表す。

「全シャードが ok と答えた」ことを確かめる層は Meta である。
ok を集めて運ぶのは進める側 (`Db`) で、Meta は、運ばれた ok が範囲表の全シャードを覆うことを確かめる。
シャードの集合は、`prepare` から終わりまで変わらない。シャードが増えるのは `move-start` だけで、表定義の遷移が開いている間は記録されないからである。

### 期限

期限は、開いている表定義の遷移に 1 つあり、今と同じ 5 秒と 5 分である (`INDEX_LEASE_MS`、`INDEX_BUILD_MAX_MS`、`src/meta.ts:29`)。
進める側が `renew` で延ばし続け (`Db.keepLease`、`src/client/db.ts:1667`)、止まれば 5 秒のうちに、延ばし続けても 5 分で、Meta が `abort` を記録する (`expire`。外から呼ばれるたびに確かめる。今と同じ)。
今は index の作成と DROP の前の禁止だけが期限を持つ。変更後は、どの DDL も持つ。
移動には期限がない。

### Worker

`Db.changeSchema`、`record`、`syncAll`、`syncRecorded`、`guardedDrop`、`checkUnique`、`buildIndex` (`src/client/db.ts:1386` から `:1659`) は、1 つの進め方になる。

```ts
const snap = await meta.prepare(sql, opts, cat.schema);   // SchemaBusy なら待ってやり直す
const lease = this.keepLease(snap.epoch);
try {
  const shards = shardsOf(snap.routing);
  const answers = await Promise.all(shards.map((id) => this.shardOf(id).prepared({ epoch: snap.epoch })));
  const bad = answers.find((a) => !a.ok);
  if (bad) throw new SqlError(bad.reason);                 // シャードの SQLite のメッセージ
  // mode ごとの仕事: build は行を読んで項目を書く。guard は unchanged を尋ねる
  this.publish(await meta.commit(snap.epoch, shards, at));
} catch (e) {
  await meta.abort(snap.epoch, reason(e)).catch(() => null);
  throw e;
} finally {
  lease.stop();
}
```

`prepared` はシャードの新しい入口で、その epoch まで列を適用し、`trial` なら文を試して、結果を返す。
自分のスナップショットで、その遷移がもう開いていなければ (先に `abort` が記録された)、`stale epoch` で断る。
`commit` の後で全シャードへ適用させる手は、正しさには要らない。禁止を早く解くために、今と同じく送ってよい。
その手と、Autoscaler が子に `move-start` を知らせる手には、`syncSchema` (`src/shard/core.ts:1274`) を `syncEpoch` に改めて使う。

重複のある列への UNIQUE を記録の前に調べる `Db.checkUnique` は、`trial` の試適用に含まれるので、なくなる。
Worker のキャッシュは、今の `Db.cached` (`src/client/db.ts:1239`) がスナップショットを持つだけで、捨てる条件 (`not owner:`、`migrating`、`stale` で始まる誤り、`TableLocked` の後の取り直し) は変えない。
取引は、最初に読むか書くかしたときのスナップショットを確定まで使う (`Txn.catalog`、`src/client/db.ts:630`)。今と同じである。
範囲表だけが進んだ後も、取引は古いスナップショットのまま進む。
動いていない行への文は、そのシャードが移動の記録を適用していても通る (M21 の `witnessPinnedSurvives`)。
動いた区間に触った文は、`not owner:` で断られた後、`schema` が同じスナップショットを取り直して、新しい持ち主へ送り直す ([design-refresh-across-move.md](./design-refresh-across-move.md)。2026-11-15 に改めた。末尾の「移動をまたぐ取引 (2026-11-15)」)。

## 今の仕組みとの対応

| 今の仕組み | 変更後 |
|---|---|
| DDL を記録する前の確かめ (Meta の空の表での実行、`Db.assertReplays`) | 残る。`prepare` を記録する前に行う |
| 全シャードが前の版を適用してから次を記録する (`applyDdl` の `basedOn`、`Db.record` の `syncAll`) | なくなる。取り消しのための規則だった。代わりに、`commit` が全シャードの ok を求める |
| 取り消し (`revokeDdl`、`revoke`、`undo`、`schemaFailed`、`applySchema` の `skip`、`Catalog.revoked`) | なくなる。失敗は `prepare` の間に見つかり、`abort` が禁止を解く |
| index の作成 (`build`、`TableDef.building`、`publishIndex`) | `mode: "build"` の遷移。出来上がっていない index が計画から見えないことは、`ddl` を `commit` まで畳まないことで決まる |
| 公開の時刻 (`DdlEntry.at`) | `commit.at`。変えない |
| 期限 (`build_lease`、`renewLock`、5 秒と 5 分) | 開いている表定義の遷移の期限。値は同じ |
| DROP の前の禁止 (`lockTables`、`finishLock`、`unchanged`) | `mode: "guard"` の遷移。`unchanged` は変えない |
| 保守の操作の枠 (`SplitSlot`、`beginSplit`、`startSplit`、`checkSplit`、`endSplit`、`assertFreeForDdl`) | なくなる。「同時に開ける遷移」の表の条件になる |
| 枠の 5 秒の期限 (子が受け取り始める前) | なくなる。枠を取る手と始める手の間がない |
| 範囲表の切り替え (`switchRange`、`Routing.version`) | `move-start` の記録。範囲表の版は epoch |
| 親の fence (`fence` の RPC) | 親が `move-start` を適用すること |
| 分割の再開 (`splitsToResume`) | `moves()` の一覧から。再開は、子に epoch を知らせるだけになる |

逆操作の文 (`undo`) を作っている 4 か所は、次のように置き換わる。

| `undo` を作っている所 | 今の逆操作 | 変更後 |
|---|---|---|
| シャード内の index (`createIndex`、`src/sql/ddl.ts:261`) | `DROP INDEX IF EXISTS` | `trial`。`prepare` は index を作らず、試すだけである。`abort` に文はない |
| シャードをまたぐ UNIQUE の index (`createIndex`、`src/sql/ddl.ts:273`) | `DROP TABLE __gidx_<index>` と、行の側の index の `DROP INDEX` | `build`。`prepare` は空の `__gidx_<index>` だけを作り (`staging`)、`abort` を適用したシャードが名前で消す。行の側の index (`__gidx_<index>__rows`) は、`commit` の文に移す。一意でない index なので、行で失敗しない |
| ADD COLUMN (`alterTable`、`src/sql/ddl.ts:359`) | 捕捉の trigger を消し、`DROP COLUMN` し、trigger を作り直す | `trial`。`abort` に文はない |
| DROP の前の禁止 (`lockTables`、`src/meta.ts:448`) | 空の `undo` (取り消せる版であることの印) | `guard`。`abort` が禁止を解く |

## 止まったときに誰が終えるか

| 止まる場所 | 残る状態 | 誰が、どう終えるか |
|---|---|---|
| `prepare` の記録の前 | 何もない | やり直す |
| `prepare` の後、`commit` の前 (進める側が止まる、シャードが答えない) | 表が書き込み禁止 | Meta が、期限で `abort` を記録する。禁止を断られた Worker も、列を取りに来たシャードも Meta に尋ねるので、待っている者がいれば 5 秒のうちに解ける |
| 進める側が、`abort` の後で戻ってくる | 遅れた `commit` の要求 | Meta が断る (その遷移はもう開いていない)。M21 の `oneExit` |
| `commit` の記録の後 | まだ `commit` を適用していないシャードでは、表が書き込み禁止のまま | 終えるべきものはない。新しいスナップショットの要求が届いたシャードが適用する。禁止を断られた Worker は、スナップショットを取り直して、その要求を送る |
| `move-start` の記録の前 | 何もない | やり直す |
| `move-start` の後、子が知る前 | 親はまだ区間を答えている | 最新の範囲表の要求が子に届くか、Autoscaler が子に epoch を知らせると、子が始める |
| 子が受け取っている途中 | 主キーを名指しする要求は通る。全表の読みは `migrating:` | 子が、自分の alarm で `drain` を続け、終えたら `finishMove`、`finishIncoming`、`endMove` を呼ぶ |
| `move-end` の記録の前 (子は受け取り終えている) | 表定義の遷移が開けない | 子の alarm が `endMove` を呼び直す |

DDL の遷移を、止まった進め方に代わって終える者は置かない。
`commit` の前なら `abort` で安全に戻せ、`build` と `guard` は、進める側の仕事 (項目を書く、取引が読んだ範囲を確かめる) を引き継げないからである。

移動を子が進めるのは、新しい取り決めである。
今は、Autoscaler が `drain` を呼び、止まった分割を次の判断 (最長 1 分) で再開する。
子は Durable Object なので、alarm で自分の仕事を続けられる (今の `redrive`、`src/shard/core.ts:2242` と同じ仕掛け)。
alarm の handler は最大 15 分なので、大きな移動は、何回かの alarm に分けて続ける (`drain` は、渡し終えたグループを飛ばして続きから進む)。
Autoscaler は、今と同じ順に呼んでよい。子が進めていれば、同じ手は冪等に終わる。

## 未解決の問題 17 は閉じるか

問題 17 (`test/open/fenced-before-switch.test.ts`) は、親が fence した後、範囲表が切り替わる前に進める側が止まると、範囲表は親を指したまま、親が断り続けることである。

閉じるには、次の 3 つが要る。

1. 親の手元だけの fence が、Meta の記録より先に付かない。親の fence は、`move-start` を適用することである。
2. 移動の RPC (`pull`、`listGroups`、`finishMove`) が `move-start` の epoch を運び、親が、適用してから答える。運ばなければ、親は fence の前に行を渡し、その後も古い範囲表の書き込みを受ける (`m21_red_pull_unfenced`)。
3. 子が、記録だけから受け取りを始められる。

3 つが揃えば、親が区間を断る時点で、Meta の列には、子を宛先にした範囲表がある。
断られた Worker がスナップショットを取り直せば、子へ送り、子は行を親から引き取って答える。
進める側は、`move-start` を記録した後は要らない。
M21 は、進める側がどこで止まっても、次の 2 つが成り立つことを確かめた。
最新の epoch で計画した要求を、その epoch の持ち主が、版や所有の理由で断らない (`servable`)。
移動が始まってから行が子に届くまで、親か子が列を適用する、親の intent が確定する、子が行を引き取る、のどれかの手がいつでも打てる (`moveNotStuck`)。
2 つ目は、子が行を引き取れずに、要求が断られもせず待ち続ける形がないことである。
今の手順 (fence が先) は、1 つ目を数手で破る (`m21_red_fence_first`)。

閉じるのは、主キーを名指しする読みと書きである。再現の試験が求めているのは、この 2 つである。
全表の読みと、移動の途中のグループを丸ごと読む文は、今と同じく、移動が終わるまで `migrating:` で断られる (グループの読みは、M19 の仕組みを入れた後は通る)。
子が自分で移動を進めるので、これが続くのは、Autoscaler の次の判断までではなく、運び終えるまでになる。
親が答えない場合 (落ちている) は、今と同じく、子は引き取れない。

## token の区間の移動との関係

`docs/design-subslots.md` の 4 段と、M18、M19、M20 は、移動の中身 (piece、claim、UNIQUE) を決めている。
この設計が変えるのは、移動の外側 (いつ始まり、いつ終わり、誰が範囲表を持つか) だけである。

- 範囲表の項目は token の区間のままで、`moving` が付く。境目をブロックの中に置く移動 (段 4) でも、記録は同じである。
- claim は残る。全表の範囲と shard key の範囲の claim を、シャードは、自分のスナップショットの区間と比べる。`__fenced` の終わった行と比べるのをやめるので、「受け取った範囲の外の点と、外にはみ出す claim を断る」確かめ (`design-subslots.md` の「所有の確かめ」) は、受け取りの記録を残さなくてもできる。範囲の床 (`__incoming` の `m`) は、時刻の規則なので残る。
- M19 の分け直しは変えない。断る応答が piece の表を運び、Worker が claim を分け直す。分け直した要求は、Worker のスナップショットの `epoch` と `schema` を運ぶ。親は、`move-start` を適用した後も、まだ切っていない piece の読みに答える。
- M20 の「fence の後、親は新しい intent を受けない」は、「親が `move-start` を適用した後」と読み替える。
- 既存の行への `CREATE UNIQUE INDEX` の突き合わせ (`design-subslots.md` の判断 5) は、`revokeDdl` で取り消す手順として書いてある。`trial` の遷移の中の、進める側の仕事になる。全シャードが `prepare` を適用した後 (表は止まっている) に、分かれた slot の行を両方の持ち主から読んで突き合わせ、重複があれば `abort` する。取り消しは要らない。M12 を広げて書くことになっていたモデルは、M21 の `BUILD` の形 (止まった行を読んでから `commit`) に当たる。

## 消えるものと、新しいもの

行数は、読んで見積もった概算である。

| ファイル | 消える、書き直す | 新しく書く |
|---|---|---|
| `src/meta.ts` (481 行) | 約 300 行。枠 (`SplitSlot` と 5 つの入口、約 100)、取り消し (`revokeDdl`、`revoke`、約 35)、期限と `building` (約 50)、`lockTables` と `finishLock` と `publishIndex` (約 50)、`switchRange`、`applyDdl`、`append`、`current` (約 65) | 約 180 行。列への追記、`prepare`、`commit`、`abort`、`expire`、`renew`、`startMove`、`endMove` |
| `src/catalog.ts` (新) | | 約 150 行。記録の型、畳み込み、遷移の条件 |
| `src/client/db.ts` | 約 200 行。`syncAll`、`record`、`changeSchema`、`guardedDrop`、`syncRecorded`、`checkUnique`、`buildIndex` の進め方の部分、`stillBuilding` | 約 90 行。1 つの進め方と、`build` と `guard` の仕事 |
| `src/shard/core.ts` | 約 130 行。`ensureSchema` から `schemaFailed` (約 85)、`beginIncoming` と `fence` (約 40) | 約 120 行。列の適用、`prepared`、スナップショットで引く所有 |
| `src/autoscaler.ts` | 約 70 行。`split` の前半、`reserveSplit` | 約 30 行 |
| `src/sql/ddl.ts` | 約 15 行。`undo` (4 か所)、`publishBuild`、`build` | 約 25 行。`mode` と `fence` を決める |
| `src/types.ts`、`src/worker.ts` | 入口の名前、`Faults` | 約 30 行 |

合わせて、約 720 行が消えるか書き直され、約 620 行を書く。
行数はほとんど減らない。減るのは仕組みの数である。
版が 2 つ (DDL の版、範囲表の版) から 1 つに、書き込み禁止の作り方が 2 つ (`building`、`guard`) から 1 つに、止まった進め方の後始末が 3 つ (取り消し、期限、枠の期限) から 1 つ (期限) になる。
提案は、ほかの 4 つの刷新と合わせて `src/` が半分になると見積もっているが、この部分だけでは、そうはならない。

試験は、`test/split-slot.test.ts`、`test/schema-failure.test.ts`、`test/unique-index-build.test.ts`、`test/rebuild-guard.test.ts` の、Meta の入口を直接呼ぶ箇所を書き直すことになる。

## 段

どの段も、落ちる検査を先に用意してから入れる (`AGENTS.md` の規則 2)。

| 段 | 中身 | 落ちてから通る検査、または挙動が変わらないことの確かめ | 規模 |
|---|---|---|---|
| 1 | 列と畳み込み。`src/catalog.ts` と、Meta の `__epoch`。Meta の入口は今の名前のまま、列の上に載せる。DDL は `commit` だけの記録で、取り消しも、今の形 (逆操作の文を持つ次の版) のまま `commit` の記録として載る。分割は今の手順で、切り替えが `move-start`、枠を返す手が `move-end` の記録になる | 挙動を変えない段である。(a) `history` と `replay` の同じ seed で、RPC の列が前後で同じ。(b) 乱択の DDL と分割の並びで、畳み込みの結果が、今の `MetaCore.current` の答えと一致する (段 1 の間だけ、両方を持つ)。(c) M21 の遷移の条件を、`src/catalog.ts` の関数と突き合わせる。モデルの乱択の経路 (`quint run --mbt`) の Meta の手を関数に流し、モデルが断る手を関数も断ることを確かめる。(d) 作り直した材料で `test/upgrade.test.ts` が通る | 約 450 行、3 日 |
| 2 | 要求が `epoch` と `schema` を運ぶ。シャードが `__epoch` を持ち、所有をスナップショットで引く。`PROTOCOL_VERSION` を上げる | 先に、分割の後で動いていない行の取引が通り続ける試験と、遅れた子が最新の範囲表の要求を受けて追いつく試験を書く (今のコードで通る。段 2 で落ちないことを確かめる)。欠陥の表 (`scripts/fault-table.mjs`) の `noSchemaRecheck`、`ignoreFence`、`staleWideRead`、`childKeepsOldSchema` の行が変わらない | 約 500 行、4 日 |
| 3 | DDL の 2 相化。`prepare`、`prepared`、`commit`、`abort`、期限。取り消し、`building`、`guard`、`checkUnique` を消す | 先に、今のコードで、進める側が各手の前で止まる試験を DDL に足す (分割の `test/split-slot.test.ts` と同じ形。行で失敗する DDL、index の作成、読んだ表の DROP)。`test/schema-failure.test.ts` の場面 (重複のある UNIQUE、CHECK に反する行) は、同じメッセージを返し、表が書けるままであることを確かめ続ける。`test/open/split-reserve-revoked.test.ts` が通る (取り消しがないので、枠を取る前の適用が断られない)。M21 の赤の再生 (下の表) を足す。`ddl-concurrent` の seed 1 から 500 と、文の再生の「実行の途中で index を作る」場面 | 約 800 行、6 から 7 日 |
| 4 | 移動。`startMove`、`endMove`、子が進める `drain`。枠、`fence` と `beginIncoming` の RPC、`switchRange`、`reserveSplit` を消す | `test/open/fenced-before-switch.test.ts` が通る (本試験へ移す)。`test/split-slot.test.ts` を、進める側が各手の前で止まる試験として書き直す (止まる位置は、`startMove` の前後、`drain` の途中、`endMove` の前)。`test/ddl-vs-split-race.test.ts`、`test/child-behind-parent.test.ts` が通り続ける。`history`、`elle-sim`、`replay` の分割の seed | 約 600 行、5 日 |

段 3 と段 4 の順は、取り消しを先になくすためである。
段 4 の「表定義の遷移が開いていなければ `move-start` を記録する」は、記録された版が後から取り消されないことを前提にする。
逆の順では、段 4 の間、今の「全シャードが最新の版を適用してから始める」確認を残すことになる。

モデルの赤と、欠陥のスイッチ (`Faults`、`src/types.ts`) の対応は次のとおりである。
再生は、その形に届く段で足し、`docs/model-coverage.md` の M12、M14、M15 の行を置き換える。

| M21 の赤 | スイッチ | 戻す欠陥 | 段 |
|---|---|---|---|
| `m21_red_no_recheck` | `noSchemaRecheck` (ある) | `enter` が、待ちの後で `schema` を確かめ直さない | 2 |
| `m21_red_stale` | なし (今と同じ。守りだけを再生する) | シャードが古い `schema` の要求を断らない | 2 |
| `m21_red_owner_unchecked` | `ignoreFence` (ある。意味を広げる) | シャードが、所有を自分のスナップショットで引かない | 2 |
| `m21_red_strict_epoch` | なし | 安全性の欠陥ではない。段 2 の先に書く試験が守る | 2 |
| `m21_red_no_fence`、`_trial_no_fence`、`_drop_no_fence` | `ignoreTableLock` (ある) | `prepare` を適用したシャードが、書き込みを断らない | 3 |
| `m21_red_no_drain`、`_trial_no_drain`、`_drop_no_drain` | `ddlIgnoresIntents`、`unchangedIgnoresIntents` (ある) | intent を持ったまま `prepare` を適用する | 3 |
| `m21_red_scan_early`、`_trial_early`、`_drop_check_early` | `scanBeforeLock` (ある) を `checkBeforePrepare` に広げる | 確かめ (走査、試適用、`unchanged`) が、`prepare` の epoch を運ばない | 3 |
| `m21_red_early_commit`、`_trial_missing_ack`、`_drop_missing_ack` | `commitWithoutAcks` (新。Meta が ok の集合を確かめず、`Db` が 1 つのシャードを飛ばす)。`publishBeforeBackfill` (ある) は残す | 全シャードの ok を待たずに `commit` を記録する | 3 |
| `m21_red_two_exits`、`_drop_untied` | `dropAfterExpiry` (ある) を `commitAfterAbort` に広げる | `commit` が、遷移が開いているかを確かめない | 3 |
| `m21_red_two_open` | `overlappingTransitions` (新。Meta) | 表定義の遷移を 2 つ開く | 3 |
| `m21_red_repin` | `repinOnRestore` (ある) | 取引が、計画し直さずに新しい `schema` を名乗る | 3 |
| `m21_red_online`、`_visible` | なし (今と同じ) | 作っている最中の index を計画が使う | 3 |
| `m21_clock_red_no_clock`、`_skip_empty`、`m21_guard_red_commit_ts` | `publishWithoutClock`、`scanSkipsEmpty`、`guardFromCommitTs` (ある) | 変えない | 3 |
| `m21_red_ddl_during_move`、`_move_during_ddl` | `ddlDuringMove`、`moveDuringDdl` (新。Meta)。`startWithoutSlot`、`fenceWithoutSlot`、`splitWithoutSync` はなくなる | 表定義の遷移と移動を並べる | 4 |
| `m21_red_end_early` | `endBeforeDrained` (新) | 子が受け取り終える前に `move-end` を記録する | 4 |
| `m21_red_pull_unfenced` | `pullWithoutEpoch` (新) | 移動の RPC が `move-start` の epoch を運ばない | 4 |
| `m21_red_fence_first` | なし | 今の手順そのものである。`test/open/fenced-before-switch.test.ts` が再現している | 4 |

## 危険

- **書き込みが止まる DDL が増える**：今は、表を消す、名前を変える、列を足す、シャード内の index を作る DDL は、表への書き込みを止めない。変更後は、`prepare` から `commit` の適用まで止まる。短ければ全シャードへの往復 1 回分で、`trial` の DDL では、いちばん遅いシャードの試適用の時間になる。行の多い表へのシャード内の UNIQUE index では、index を作る時間だけ止まる。止まる時間の上限は 5 分である。今は、同じ DDL が、失敗したときに限り、ほかのシャードで index を作ってから捨てている。
- **取引が古くなる回数**：`schema` をどの記録でも進めると、どの DDL も、開いている取引を 2 回古くする (`prepare` を適用したシャードと、終わりの記録を適用したシャードで)。新しい表を作るだけの DDL と、失敗した DDL も同じである。今は、ふつうの DDL は 1 回である。`commit` だけで進める案は、これを 1 回にする。
- **試適用の費用**：`trial` の文は 2 度実行される (試して巻き戻す、`commit` で残す)。Durable Object の SQLite が、取引の中の DDL を巻き戻すことと、巻き戻した書き込みの課金は、`docs/platform-facts.md` にない。今のコードも、適用に失敗した DDL の巻き戻しに頼っている (`applySchema` の `b.tx`) ので、巻き戻せることは見込めるが、課金は実測が要る。
- **`commit` を適用できないシャード**：試適用に通った文が `commit` で通らなければ、そのシャードは止まる。取り消しがないので、戻す手はない。M21 は、設計の条件が守られていれば起きないこと (`commitApplies`) を確かめたが、保存の障害はモデルの外である。
- **長い移動の間、DDL が待つ**：今と同じである (M15 の「モデルにないもの」)。大きなテナントの移動が数十分かかれば、DDL はその間 `SchemaBusy` で待ち、Worker の待ちの上限 (`SPLIT_WAIT_MS`、60 秒) で失敗する。この設計は、これを解かない。
- **スナップショットの取り直し**：`move-start` と `move-end` のたびに、親と子に触った Worker がスナップショットを取り直す。今も、動いた行に触った Worker は範囲表を取り直すので、増えるのは `move-end` の分と、親の動いていない行だけに触っていて全表を読んだ Worker の分である。
- **ほかの書き直しとの重なり**：`src/shard/core.ts` の書き直しと、`design-subslots.md` の段 2 から段 4 が、同じ入口 (`enter`、`assertOwned`、移動の RPC) を触る。順序は持ち主の判断に挙げた。
- **モデルの置き換え**：M12、M14、M15 の赤の再生 (`docs/model-coverage.md` の 20 行ほど) を、M21 の赤に付け替えることになる。付け替えの間、再生のない赤ができないように、段ごとに行う。

## M21 が確かめたことと、確かめていないこと

モデルの中身、不変条件、赤と反例は [specs/README.md](../specs/README.md) の M21 の節に書いた。
ここには、設計の判断に効いた結果だけを挙げる。

- 表定義の遷移の条件は、どれも外すと破れる。書き込み禁止、intent の決着、`prepare` を適用した後の確かめ、全シャードの ok、終わり方は 1 つ、開くのは 1 つ、の 6 つである。
- 行で失敗し得る DDL (`CHECK` の場面) で、記録された `commit` を適用できること (`commitApplies`) は、古い `schema` の要求を断らなくても、待ちの後で確かめ直さなくても破れない (`m21_check_no_reject`)。この不変条件を守っているのは、書き込み禁止と、適用した後の表そのもの (SQLite が制約を確かめる) である。確かめたのは、この 1 つの不変条件だけである。モデルの制約は行の値の性質で、行の形を変えない。列を足す DDL では、古い形の行イメージを持つ計画を断るために、版の確認が要る。版の確認を外してよい、という結果ではない。
- `schema` を `commit` だけで進める案は、index の作成と、行で失敗し得る DDL の場面で、`noServeBelowAck` を除く不変条件を破らない (上の「表定義の epoch が進む記録」)。
- 表定義の遷移と移動の排他は、両方向とも要る。移動の途中に `prepare` を記録する形 (`m15_red_no_slot` と同じ形) と、遷移が開いている間に `move-start` を記録する形 (`m15_red_no_based_on` の後継) は、どちらも `servable` を破る。
- M15 の残りの 2 つの赤 (`stale_begin`、`late_start`) は、形がなくなる。子は列を順に適用するので、親より古い表定義で受け取り始められず、枠を取る手と始める手の間がないので、期限切れの後に始まることがない。

確かめていないこと。

- 時刻。M21 の本体に時計はない。公開の時刻と、DROP の前の確かめが比べる時刻は、M12 と M14 から写した小さなモデル (`m21_clock_*`、`m21_guard_*`) で確かめた。移動の時刻 (m、範囲の床) は M5b、M18、M19 のままである。
- 移動の中身。行は 1 つで、1 手で運ばれる。親の intent は、運ぶ手を持たないので、ないときにだけ行を運ぶ。応答の喪失、piece、claim の分け直しは、M5b、M18、M19 が扱う。
- 取引の中の DDL の順序 (M13 の `prefixOfScript`、`ownDdlVisible`、`completeWhenOk`)。接続の側の規則で、この設計は変えない。M13 が受け持ち続ける。
- 2PC の取引。M21 の取引は 1 シャードで、受け付けと確定の 2 段である。anchor が参加者の応答の後で版を確かめ直すこと、確定して未適用の intent は、M11 が受け持ち続ける。
- 同じ名前の表の作り直し (DROP の後の CREATE)。古い計画の書き込みが新しい表に届かないことは、`schema` の確認が守る (M11 の `m11_green_recreate`)。M21 の DROP は、消すところまでである。
- 活性。禁止が必ず解けることは、時相の性質としては確かめていない。期限切れの手が、遷移が開いている間いつでも打てることと、進める側が止まった後で禁止が解けて書き込みが通る経路があること (`witnessLiftedAfterStall`) を確かめた。
- 2 つ以上の移動と、移動どうしの条件 (区間とシャードが重ならない)。

## 持ち主の判断が要ること

1. **書き込みが止まる DDL が増えること**。表を消す、名前を変える、列を足す、シャード内の index を作る DDL が、`prepare` の間、その表への書き込みを止める。認めなければ、行で失敗しない DDL は `prepare` を挟まない記録 (今と同じ 1 手) に残し、表を消す DDL は、今の「全シャードへ適用させてから完了を返す」で守ることになる。進め方が 2 通りになる。
2. **新しい表を作るだけの DDL の往復**。`fence` が空の DDL でも `prepare` の往復を挟むか、省いて `commit` だけを記録するか。この案は、最初の実装では挟む側である (進め方が 1 通りで、費用は DDL 1 回につき全シャードへの往復 1 回)。
3. **試適用の 2 度の実行**。行の多い表へのシャード内の UNIQUE index では、index を 2 度作る。`prepare` で本物の index を作り、`abort` で名前で消す形 (`build` の `__gidx` と同じ扱い) にすれば 1 度で済むが、`prepare` が利用者の表に index を足すことになる。この案は、実測してから決める側である。
4. **移動を子が進めること**。`drain` と `endMove` を、子が自分の alarm で進める。入れなければ、止まった分割は今と同じく Autoscaler が再開し (最長 1 分)、その間、全表の読みが `migrating:` で断られる。主キーを名指しする要求は、どちらでも通る。
5. **順序**。`design-subslots.md` の段 2 から段 4 と、`src/shard/core.ts` の書き直しの、どこに挟むか。段 1 と段 2 は、移動の中身に触らないので、先に入れられる。段 4 は、piece 単位の移動 (subslot の段 2) と同じ入口を触る。
6. **表定義の epoch を、どの記録で進めるか**。この案は、どの記録でも進める側で書いた (今の index の作成と同じで、赤を全部この上で確かめた)。`commit` だけで進める案は、取引を古くする回数を 1 回に減らし、失敗した DDL をほかの取引に見せない。M21 は、2 つの場面で、この案が残りの不変条件を破らないことを確かめた。採るなら、段 3 の前に、赤をこの案の上でも確かめ直す。新しい表を作るだけの DDL の往復 (判断 2) を省く理由の 1 つは、この回数だったので、この案を採れば、往復を挟む費用は往復そのものだけになる。
7. **モデルの扱い**。実装が入った時点で、M12、M14、M15 は M21 が置き換える。M11 (2PC の取引と DDL) と M13 (取引の中の DDL の順序) は残す。M21 は、この 2 つの赤のうち Meta の仕組みに依るもの (`m11_red_no_sync`、`m11_red_no_reject`、`m13_red_repin` など) を写したが、全部は写していない。

## 決めたこと (2026-11-14)

持ち主は、刷新の 5 つをすべて公開の前に入れると決め、細部を任せた。
上の 7 つは、次のように進める。
違う判断があれば、実装の段 3 の前に直す。

1. 書き込みが止まる DDL が増えることを認める。進め方を 1 通りにするためである。止まるのは `prepare` から `commit` か `abort` までで、行を確かめる DDL では、その確かめの時間を含む。`docs/sql-language.md` に書く。
2. 新しい表を作るだけの DDL でも、`prepare` の往復を挟む。
3. 試適用で index を 2 度作るかどうかは、段 3 で、行の多い表で測ってから決める。段 3 で測り、2 度作る形のままにした (「段 3 の結果」の測り)。
4. 移動は、`move-start` の後は子が自分の alarm で進める。止まった分割の間、全表の読みが `migrating:` で断られる時間を短くするためである。
5. 順序は計画書の順番のとおりにする。値の作り直しの段 3 の後、token の区間の段 2 の前に、段 1 から段 4 を入れる。
6. 表定義の epoch は、`prepare`、`commit`、`abort` のどれでも進める (M21 が全部の赤を確かめた形)。`commit` だけで進める案は、取引を古くする回数が減るので、実装の後で、赤をその案の上でも確かめ直してから採るかを決める。
7. 実装が入ったら、M12、M14、M15 を M21 で置き換える。M11 と M13 は残す。

## 段 1 の結果 (2026-11-15)

段 1 の Meta は、表定義の版と範囲表を `__epoch(epoch, rec)` の 1 表に記録し、どの答えも列を畳んで作る (`src/catalog.ts` の `fold`)。
入口の名前、確かめ、答え、誤りの文は、段 1 より前と同じである。
シャードと Worker は変えていない。要求が epoch を運ぶのは段 2 からである。

### 列が記録するもの

段 1 の Meta が書く記録は 3 種類で、どれも今の手順の 1 手に当たる。

| 今の手 | 記録 |
|---|---|
| 表定義の版を 1 つ積む (`applyDdl`、`publishIndex`、`lockTables`、`finishLock`、取り消し) | `{ kind: "commit", ddl }`。`ddl` は今の `DdlEntry` のままで、`of` を持たない。取り消しも、逆操作の文を持つ次の版の `commit` である |
| 範囲表を切り替える (`switchRange`) | `{ kind: "move-start", from, to, start, end }`。同じ切り替えをもう一度呼んでも、記録は増えない |
| 分割の枠を返す (`endSplit`) | `{ kind: "move-end", of }`。枠の名前 (親、子、区間) で開いている移動を引き、なければ記録しない |

最初の範囲表は、epoch 0 の記録 (`{ kind: "genesis", routing }`) にした。
上の「保存」の節の「epoch 0 のスナップショットが持つもの」を、列の 1 行として持つ形である。
今と同じく、最初に範囲表を引いたときに書く。

`prepare`、`abort`、`of` のある `commit` は、型と畳み込みと遷移の条件 (`refusal`) だけを、いまから持つ。
段 1 の Meta は、これらを書かず、`refusal` も呼ばない。
記録を足してよいかは、今の仕組み (分割の枠、期限、`basedOn`、最新の版の確かめ) が決める。
分割の枠は範囲表の切り替えより前に取られ、記録を残さずに期限で消えるので、列だけからは決められないからである。

### 畳み込みと今の状態

| スナップショット | 今の Meta の何に当たるか |
|---|---|
| `version`、`tables`、`views`、`indexes`、`ddl`、`revoked` | `MetaCore.current` の答え。`version` は段 1 の間だけ持つ `DdlEntry.version` で、シャードと Worker はまだこれを比べる。取り消された版の文を `ddl` から除く処理は、取り消しの `commit` を畳むときに行う |
| `open` | `building()`。最新の表定義の版が index の作成 (mode `build`) か DROP の前の書き込み禁止 (mode `guard`) なら、その版が遷移を開いている。次の版が閉じる |
| `routing` | `__routing` の最新の行。版は、最初の範囲表の版に `move-start` の数を足したもので、今の `Routing.version` と同じになる |
| `moves` | 開いている移動 (`move-start` の後、`move-end` の前)。設計の `routing.ranges[].moving` の代わりに、範囲表とは別に持つ。範囲表を今の `Routing` の形のまま返せる |
| `epoch`、`schema` | 新しい。Meta の外には出さない |

`MetaCore.catalog` は、スナップショットから今の `Catalog` の形 (キーの順まで同じ) を作って返す。

### 設計の本文からずれたところ

- 最初の範囲表を、5 種類の記録とは別の `genesis` の記録として epoch 0 に置いた。
- 開いている移動を、範囲表の項目の印ではなく `moves` の一覧で持つ。
- `move-start` の `from` は省けることがある。今の `switchRange` は `from` を省けるので、区間の持ち主が 1 つに決まらなければ記録しない。段 4 の `startMove` では必ず持つ。
- 段 1 の `open` は、`prepare` の記録ではなく、最新の版の印 (`DdlEntry.build`、`DdlEntry.guard`) から畳む。行で失敗し得る DDL (段 3 の `trial`) は、段 1 では遷移を開かない。今と同じく、1 つの版で記録し、失敗すれば取り消しの版を積む。
- Meta は利用者の DDL を自分の SQLite でも実行するので、`__epoch` を内部の名前に足した (`src/sql/ddl.ts` の `INTERNAL_NAMES`)。足さないと、利用者の `DROP TABLE __epoch` が Meta の列を消す。段 1 で利用者に見える変化は、これだけである。段 1 より前は `__epoch` という名前の表を作れたが、いまは「reserved for internal use」で断る (`test/catalog.test.ts`)。
- 保存の形式を版 3 にした (`src/types.ts` の `STORAGE_FORMAT`)。シャードの形式は変わらない。版 2 からの移行は書かない。

### 検査

(a) RPC の列。`test/history.test.ts` と `test/replay.test.ts` に限らず、sim の全試験 (889 件、RPC 418,136 回) と、基準経路の 2 組の `history` と `replay` (59 件ずつ) を、変更の前後で `RPC_TRACE` を付けて流し、送り元、宛先、種類の列を比べた。
要求の中身の SHA-256 も一緒に比べた (一時的に `test/setup.ts` に足し、比べた後で戻した)。
列は全部同じだった。
違いは 2 種類で、どちらも変更によるものではない。
1 つ目は更新の試験の 2 件で、材料の版が 2 から 3 に変わり、試験の名前が変わった。列も要求の中身も同じである。
2 つ目は 3 件 (`basic` の「非決定的な SQL」と、`subrequests` の index の作成の 2 件) で、要求の中身の指紋だけが違った。変更の前のコードを 3 回流すと、3 件とも毎回違う値になる。`basic` の試験は、文の中で `random()` を使う。`subrequests` の 2 件の原因は調べていない。

未解決の問題の再現 (`test/open/`、8 ファイル 10 件) も、変更の前後で流した。10 件とも前後で落ち、最初の誤りの文も同じだった。

(b) 今の答えとの一致。段 1 より前の Meta を `test/meta-old.ts` に写して残した。
`test/catalog.test.ts` は、乱択の並び (60 seed、120 手) を 2 つの Meta に同じ順で流し、どの入口の答えも誤りの文まで同じであることを確かめる。
並びは、期限と上限をまたぐ時計、延ばし続ける期限、index の作成と公開と取り消し、DROP の前の書き込み禁止、古い `basedOn`、失敗する DDL と何もしない DDL、枠のある分割とない切り替え、Meta の開き直し、欠陥のスイッチ (`startWithoutSlot`、`fenceWithoutSlot`、`dropAfterExpiry`) を含む。
`META_SHADOW` を付けると、シミュレータのすべての Meta の呼び出しを古い Meta にも流して比べる (`test/sim.ts` の `shadowMeta`)。sim の全試験で、違いは 0 件だった。
`move-end` には古い Meta に当たるものがないので、別に確かめた。分割を進める側を各段の前で止めて再開すると、列には、その移動の `move-start` と `move-end` が 1 つずつあり、開いている移動は残らない (7 つの段のどれで止めても)。
検査が欠陥を見つけることは、段 1 の Meta に欠陥を 1 つずつ入れて確かめた (取り消された文を履歴に残す、書き込み禁止で遷移を開かない、同じ切り替えを 2 度記録する、取り消しの前の表定義を 1 epoch 先まで畳む、`ddlSince` の境目をずらす、取り消しの印を次の版で消さない。6 つとも乱択の比べ合いが落ちた)。比べ合いの shadow も、わざと入れた違いを見つけた。

(c) M21 との突き合わせ。`test/fixtures/m21/generate.mjs` が、M21 の乱択の経路 (`quint run --mbt`) の各状態で、Meta の手の候補を model 自身に試させる (`quint test` の run。条件を TypeScript に写さない)。
`test/catalog-m21.test.ts` は、model の列の 3 つの表から epoch の列を組み立てて畳み、同じ候補を `refusal` に尋ねる。
model が受ける手は関数も受け、model が断る手は関数も断ることを確かめる。
model にしかない条件 (操作は 1 度だけ、進める側が止まった、表が消えた後の DDL は構文の確かめが断る、子が受け取り終えた) で断られた手は数えない。
インスタンスは、決めた設計の 7 つ (`m21_green_build`、`_check`、`_ddl2`、`_drop`、`_split`、`_split_txns`、`_split_build`) と、`m21_green_split` の定数で 4 つの操作を全部入れたもの (specs/ にはない) の 8 つで、それぞれ 40 手の経路を 12 本作った。
試した状態は 3,936 (Meta の手に関わる変数で 294 通り) で、候補の答えのうち、関数も受けたものが 258、関数も断ったものが 1,687 (条件ごとに `one-exit` 860、`one-open` 283、`move-not-open` 153、`all-acks` 117、`owner` 94、`ddl-waits-move` 93、`move-waits-ddl` 87)、model にしかない条件で数えなかったものが 161 だった。違いは 0 件だった。
`refusal` に欠陥を 1 つずつ入れると (`one-open`、`ddl-waits-move`、`move-waits-ddl`、`all-acks`、`move-not-open`、commit の `one-exit`、abort の `one-exit` を外す 7 つと、ok を比べるシャードの集合を範囲表から取らない 1 つ)、8 つとも試験が落ちた。
結果は「M21 の条件と段」の表に書いた。

(d) 更新の試験。材料を作り直した (`test/fixtures/storage/format-3.json`)。変更の前のコードで同じ作業負荷から作った材料と比べると、シャードの写しと答えは、形式の印のほかは同じで、Meta の写しは、`__ddl` と `__routing` が `__epoch` に替わったほかは同じだった。`commit` の記録が運ぶ `DdlEntry` は、`__ddl` の行と同じである。

### M21 の条件と段

| M21 の条件 | `refusal` の rule | 段 1 の Meta で守るもの | 列の上で Meta が守る段 |
|---|---|---|---|
| `ONE_OPEN` (表定義の遷移は 1 つずつ) | `one-open` | `assertFreeForDdl` の `building()`。判定は `open` と同じ | 段 3 |
| `ONE_EXIT` (終わり方は 1 つ) | `one-exit` | `publishIndex`、`finishLock`、取り消し、`renewLock` が、最新の版を確かめる | 段 3 |
| `ALL_ACKS` (全シャードの ok の後で確定) | `all-acks` (ok の集合を引数で受ける) | Meta ではなく Worker (`Db` の `syncAll`) | 段 3 |
| `DDL_WAITS_MOVE` (移動の間は遷移を開かない) | `ddl-waits-move` | 分割の枠。枠は、開いている移動より長く持たれる | 段 4 |
| `MOVE_WAITS_DDL` (遷移の間は移動を開かない) | `move-waits-ddl` | `beginSplit` が `building()` で断り、枠の間は DDL を記録しない | 段 4 |
| `END_AFTER_DRAIN` (受け取り終えてから閉じる) | なし (列からは決まらない) | Autoscaler の手順の順序 | 段 4 (受け取り終えた子が `move-end` を記録させる) |
| 移す区間の持ち主 (M21 は場面で固定) | `owner` | `switchRange` の確かめ (今と同じ) | 段 4 |
| 移動どうし、子が持つ範囲 (M21 にない) | `moves-overlap`、`child-owns` | シャードの手元の記録と、Autoscaler の `split` | 段 4 |

行で失敗し得る DDL (`CHECK` の場面) の遷移は、段 1 の Meta にはない。
`refusal` は、`prepare` の記録 (mode `trial`) として、この場面も突き合わせた。

### 段 2 に要るもの

- `Catalog` に `epoch` と `schema` を足し、要求 (`ExecReq`、`PrepareReq`、`CommitReq`、`refresh`、`unchanged`) に運ばせる。`PROTOCOL_VERSION` を上げる。
- `MetaCore.epochsSince(epoch)` を足す。シャードは `__ddl` を `__epoch` (Meta の列の写し) にし、同じ `fold` で自分のスナップショットを作る。シャードの形式が変わるので、保存の形式を上げる。
- シャードの所有を、自分のスナップショットの `routing` と `moves` で引く。
- 表定義の版を比べる値を、`DdlEntry.version` から `schema` に替える。段 1 の `commit` の記録が運ぶ `DdlEntry.version` は、段 3 で記録の形を変えるときに消す。
- 畳み込みの費用。段 1 の Meta は、呼ばれるたびに列の全部を読んで畳む (今も `__ddl` の全部を読んでいた)。シャードも畳むようになるので、最後の epoch で覚えておく形を考える。
- 古い Meta の写し (`test/meta-old.ts`) と `META_SHADOW` は、段 3 で表定義の遷移を 2 相にするまで残す。答えが変わる段 2 の変更 (`Catalog` に足すもの) は、比べる前に古い答えに合わせて落とす。

## 段 2 の結果 (2026-11-15)

段 2 で、要求が Worker のスナップショットの epoch と表定義の epoch を運び、シャードが Meta の列の写しを持つようになった。
断られた試みは、古い計画を送り直さず、新しいスナップショットで計画し直す。
Meta の記録と入口は段 1 のままで、DDL と分割の手順も変えていない。
通信の版は 6、保存の形式は版 4 で、どちらも移行は書かない。

### 要求が運ぶものと、シャードが確かめること

| 要求 | 運ぶもの |
|---|---|
| `ExecReq`、`PrepareReq`、`CommitReq` (anchor から参加者への `prepare` も) | `schema` (表定義が最後に変わった epoch。`Catalog.schema`) と `epoch` (スナップショットの epoch。`Catalog.epoch`) |
| `syncSchema` | `{ schema }`。DDL を全シャードへ適用させる手と、分割の枠を取る前の適用が使う |
| `beginIncoming` の答え、`fence`、`PiecePayload` | `schema` は表定義の epoch である。`MetaCore.startSplit` は、枠の版と一緒に、その版の表定義の epoch を返す |
| `unchanged` | `schema` は表定義の epoch。`epoch` は運ばない (下の「ずれたところ」) |

`Catalog` に `epoch` と `schema` を足した。
Meta の入口 (`applyDdl` の `basedOn`、取り消し、公開、枠) は、段 3 まで `DdlEntry.version` で話す。
`SchemaMoved` は、版と一緒に表定義の epoch を運ぶ。

シャードは、要求の入口 (`schemaStep`) で、M21 の `gate` と同じ順に確かめる。

1. 要求の `schema` が自分の表定義の epoch より小さければ、`not owner: stale schema` で断る。大きければ、Meta の列を適用してから確かめ直す (intent を決着させる今の手順のまま)。
2. 要求の `epoch` が自分の写しの最後の epoch より大きく、要求の行か claim が自分のスナップショットで自分のものでなければ、範囲の記録だけを適用する (`catchUpStep`)。表定義の記録の手前で止まる。要求の `epoch` が小さいことでは断らない。
3. 同期区間の入口 (`enter` の `assertOwned`) と書き込みの守り (`claimed`) が、所有を引く。手放した範囲 (`__fenced`) か、自分のスナップショットの範囲表で自分のものでない範囲なら `not owner`。全表の読みの claim も同じ規則で引く。`__fenced` の拒否は段 4 まで残す。分割の手順は、範囲表を切り替える前に親を fence するので、親のスナップショットが切り替えを知る前から断れるのは、こちらだけである。

欠陥のスイッチ `ignoreFence` は、意味を広げて、`__fenced` とスナップショットの両方の所有の確かめを外す (M21 の `m21_red_owner_unchecked`)。

### シャードの写し

シャードの `__ddl(version, entry)` を `__epoch(epoch, rec)` にした。Meta の列のうち、適用した分を、epoch 0 から隙間なく、Meta と同じ記録の形で持つ。
表定義 (`defs`)、表定義の epoch、所有を引く範囲表は、写しを `src/catalog.ts` の `fold` で畳んで作る。
畳んだ結果はメモリに持ち、記録を足したときだけ畳み直す (段 1 の申し送りの「畳み込みの費用」)。
Meta は、段 1 と同じく、呼ばれるたびに畳む。シミュレータでは Meta の答えの object が Worker にそのまま渡り、持ち続けられるので、控えを共有しないためである。
続きは `MetaCore.epochsSince(after)` (新しい入口) で取る。

| 記録 | 写しに足す手 |
|---|---|
| `genesis`、`move-start`、`move-end` | 文を持たない。表定義の記録と一緒に適用するとき (`applyStep`) と、範囲の記録だけを適用するとき (`catchUpStep`)。後者は intent を決着させない |
| `commit` (段 1 の形。`DdlEntry` を運ぶ) | 文を実行し、同じ取引で写しに足す (`applyStep`)。取り消された版と、それを取り消す版の組は、今と同じく、両方とも実行しない。比べるのは `DdlEntry.version` である。畳むと取り消す前の表定義に戻るので、表定義は飛ばしても飛ばさなくても同じになる |
| `prepare`、`abort`、`of` のある `commit` (段 3) | まだ書かれない。届いたら、シャードは適用せずに断る |

### 断られた試みを計画し直す

Worker が断られた要求を送り直す場所を全部見た。計画を捨てて計画し直すようにしたのは 2 か所で、残りは、もとから試みごとに計画し直しているか、計画を送り直さない。

| 場所 | 段 2 より前 | 段 2 |
|---|---|---|
| 複数のシャードに書く autocommit の文 (`Db.dispatch` から `Db.transaction`) | 断られると (古い表定義、`not owner`、`migrating`、競合)、新しい取引で、最初の計画をそのまま送り直した。未解決の問題 35 と 38 はこれである | やり直す試みのスナップショットの epoch か表定義の epoch が、最初の計画のものと違えば、計画を捨てて、その試みの取引で計画し直す。一度違えば、後の試みでも最初の計画には戻らない (計画し直した試みが競合で断られた後に戻ると、古い計画を送り直す。`test/reference-write-after-add-column.test.ts` の 2 つ目)。最初の計画の採番は戻す。スナップショットが最初の計画と同じ (競合、`migrating`) なら、同じ計画を送る (計画は待ちと採番を含むので、競合のたびに計画し直すと、分割も DDL もない実行の RPC の列まで変わる) |
| 取引の中の文 (`Db.begin()`、`Db.transaction(fn)`、D1 の batch の `Txn.statement`。SQL の `BEGIN` と Hrana の取引の `Db.attemptStatement`) | `not owner` を利用者へ返した。取引は自分の範囲表を持ち続けたので、動いた範囲に触る文は、取引の終わりまで断られた | `not owner` (表定義が古いという `not owner: stale schema` は除く) なら、表定義の epoch が同じで範囲表が新しいスナップショットを取り、取引の範囲表だけを取り替えて、文を計画し直す (`Txn.reroute`、3 回まで)。捨てた試みの採番は戻す。取引が名乗る表定義の epoch は変わらない。取引が溜めた書き込みの行か、行ロックを取って読んだ範囲が、新しい範囲表で別のシャードのものなら、取り替えずに競合で断る (下の 37)。`COMMIT` は計画し直す文ではないので、取り替えない |
| 計画の途中で表を読む autocommit の文 (`inTxn`) | 試みごとに、取引の表定義で計画し直していた | 変えない |
| 利用者の関数の取引 (`Db.transaction(fn)`、`batch` の区切り)、Hrana の `BEGIN` から始まる batch | 試みごとに関数か batch を頭から流し、文ごとに計画し直していた | 変えない |
| 1 つの autocommit の文 (`Db.attemptStatement`) | 試みごとに計画し直し、採番を戻していた | 変えない |
| 取引の要求の読み直し (`Txn.call`) | 応答を待つ間に読み取り時刻が進んだときと、`moved at` で時刻を進めたときに、同じ要求を同じシャードへ、新しい時刻で送り直す | 変えない。表定義と範囲表は変わっていないので、計画は古くない |
| index の項目を書く取引 (`Db.writeIndex`) | 範囲表を取り直し、項目を新しい範囲表で振り分け直して書く | 変えない |
| 分割の枠 (`reserveSplit`)、DDL の記録 (`Db.record`) | 版が進んでいたら取り直してやり直す | 適用させる数を表定義の epoch にした。データの文の計画ではない |

`src/client/d1.ts`、`src/binding.ts`、`src/worker.ts`、`src/entry.ts` には、送り直す繰り返しがない。
段 2 で足した採番の戻し (`Db.dispatch`、`Txn.statement`) は、捨てた試みが計画を終えた後に、同じブロックから誰も取っていないときだけ戻す (`Db.idsUndo`)。worker.ts は、同じ isolate の接続でブロックを共有する (`sharedIds`) ので、確かめずに戻すと、ほかの接続が取った番号をもう一度配ることがある。SQL の `BEGIN` の取引の文を計画し直すときは、`Db.attemptStatement` の今の戻し方を通り、これは、この確かめをしていない (下の「見つけて直していないもの」)。

### 未解決の問題 35、37、38

| 問題 | 段 2 より前 | 段 2 |
|---|---|---|
| 35 (分割の前の計画の複数行 INSERT) | シャードの書き込みの守りが `write outside claim:` で断り、INSERT が失敗した | 計画し直して、行を持ち主ごとの文に分ける。`test/multi-row-insert-after-split.test.ts` へ移した。置き場所の差分の検査は、伏せていた形 (表定義を作った Db で初めの行を入れる) を伏せずに流す |
| 38 (ADD COLUMN の前の計画の基準経路の書き込み) | 足した列を既定値で上書きした | 新しい表定義で計画し直す。`test/reference-write-after-add-column.test.ts` へ移した |
| 37 (取引が分割をまたげない) | 動いた範囲に触る文と `COMMIT` が `not owner` で失敗した | 動いた行への文は新しい持ち主へ行き、`not owner` で失敗しない。`Db.begin()` の取引は、分割の前に動いた範囲を読んでも書いてもいなければ、確定まで通る。まだ通らない形は 3 つで、`test/open/` に残した (下) |

37 のうち、まだ通らないのは次の 3 つである。どれも、読んだ行が変わっていなくても失敗するので、成否が置き場所で変わる。

- 分割の前に動いた範囲を読んだ取引 (`test/open/transaction-across-split.test.ts`)。その範囲を移動の時刻 m より前の時刻で読むと、子は `read too old: moved at m` で断る。取引は読み取り時刻を m へ進めようとして、それまでの読みを確かめ直す (`Txn.advance`) が、その読みは、親が移動の前の範囲表の claim で答えたものである。親は、手放した範囲を含む claim を `not owner` で断り、子は、床 m より前の時刻の確かめに答えない。誰も読みが今も成り立つとは言えないので、取引は時点を進められない。同じ取引の `COMMIT` も、溜めた読みと書き込みが親のものとして残るので、親に `not owner` で断られる。
- SQL の `BEGIN` の取引が、分割の後に動いた行を書く (`test/open/locking-transaction-commit-after-split.test.ts`)。書き込みは最新の状態で実行され、子が受ける。`COMMIT` では、子の prepare が取引の T で所有を確かめ、T は子の床より前なので、`read too old` で断る。子が持つ書き込みと読みは、どれも子が受け取った後の時刻 F から検証されるのに、所有は T で引く。

- 分割の前に動いた行を書いたか、行ロックを取って読んだ取引 (`test/open/transaction-across-split.test.ts` の 3 つ目)。次の文が競合で断られる。範囲表を取り替えると、溜めた書き込みは書いたときのシャードのものとして残り、新しい持ち主へ送る文の overlay に入らない。行ロックを取る文 (SQL の `BEGIN` の書き込み、`BEGIN IMMEDIATE` の主キーの読み) は最新の状態で実行されるので、子の床にも止められず、取引自身の書き込みを見ないまま答えた。行ロックは読んだシャードのメモリにだけあるので、ロックを取って読んだ行も、新しい持ち主では別の接続が書けて、読み直すと食い違った (段 2 の作業の確かめで見つけた。`test/transaction-own-writes-across-split.test.ts`)。いまは、範囲表を取り替えずに競合で断る (`Txn.reroute`)。

直すには、親が移動の前の時刻を、子が受け取った後の時刻を受け持って、移動をまたぐ読みを確かめ直す規則と、溜めた読みと書き込みを新しい持ち主へ移す規則が要る。
親は自分の変更ログで、子は受け取った後の自分の変更ログで答える。片方だけでは足りない。子は、グループを受け取った時刻 (piece の m) から書き込みを受けるが、範囲の床 m は `finishMove` が後で発行するので、その間の子の書き込みを親は知らない。
要求の epoch が移動の記録より新しいとき (読み手が移動を知っていて、両方に尋ねるとき) だけ答えさせる必要もある。
この規則は M21 にない (M21 の取引は動いた行で断られ、M18 は移動をまたぐ取引の検証を扱っていない)。
規則 3 により、モデル (M5b を広げる) を先に書く。持ち主の判断で、別の作業がモデルを書いている。
「Worker」の節の、動いた区間に触った文についての文は、そのモデルの作業が直す。

### 検査

先に書いた試験の 2 つ (`test/transaction-on-unmoved-rows-across-split.test.ts`、`test/lagging-child-catches-up.test.ts`) は、段 2 より前のコード (`44306cf`) で通り、段 2 の後も通る。
1 つ目は、動いていない行の取引が、分割を知った親でも通ること (M21 の `m21_red_strict_epoch`) を、Worker を通して確かめる。2 つ目は、子が範囲の記録を適用する前に、最新の範囲表と表定義の要求を受けて追いつくことを確かめる。

M21 の赤のうち段 2 が届く 4 つに、再生を足した (`docs/model-coverage.md`)。
`m21_red_stale` と `m21_red_owner_unchecked` と `m21_red_strict_epoch` は `test/epoch-requests.test.ts` に、シャードへ直に要求を送る形で置いた。
`m21_red_owner_unchecked` の形は、段 2 より前のシャードが黙って受けたもの (範囲表で別のシャードのもので、一度も手放していない行の書き込み) で、`ignoreFence` で受けるように戻すと、シミュレータの書き込みの検査が、持ち主でないシャードに残る行として見つける。
`m21_red_no_recheck` は、今までの再生 (`test/stale-plan-after-wait.test.ts`) が、表定義の epoch で比べるようになった。

RPC の列。`test/history.test.ts` と `test/replay.test.ts` の既定の seed (61 件) を、`44306cf` と段 2 で `RPC_TRACE` を付けて流し、送り元、宛先、種類の列を比べた。
49 件は同じで、12 件が違った。どれも分割か古い表定義が関わる。

| 違った試験 | 原因 |
|---|---|
| `history` の「while shards are added」の seed 21 から 26、「with splits and restarts together」の 32 から 34、「with pessimistic transactions ... with splits and restarts」の 51 と 54 (11 件) | 分割の後、取引の文が `not owner` で終わらず、範囲表を取り替えて新しい持ち主へ行く (`Txn.reroute`)。子が範囲の記録を適用する (`catchUpStep`)。取引の成否が変わるので、作業負荷の続きも変わる。数を出す印を一時的に入れて `SEEDS=21`、`31`、`51` で `history` を流し (`SEEDS` はどの場面の seed も置き換える)、取り替えと追いつきが起きることを確かめた |
| `replay` の「with a UNIQUE index that spans shards built during the run」の seed 5 (1 件) | 実行の途中で index を作る DDL が入り、複数のシャードに書く autocommit の文が古い表定義で断られた。やり直す試みは、計画し直す (`Db.dispatch`)。数を出す印を一時的に入れて流し、この seed で 6 つの文が計画し直されることを確かめた |

meta の呼び出しは RPC の列に出ないので、`ddlSince` から `epochsSince` への置き換えは列を変えない。

段 1 の Meta との比べ合い (`META_SHADOW`) を、Meta を多く呼ぶ試験 (`ddl-concurrent`、`split-slot`、`rebuild-guard`、`unique-index-build`、`schema-failure`、`ddl-vs-split-race` の 153 件) で流し、違いは 0 件だった。
段 2 で足したもの (`Catalog` の `epoch` と `schema`、`startSplit` の `schema`、`SchemaMoved` の表定義の epoch) は、比べる前に新しい Meta の答えから落とす (`test/meta-old.ts` の `stage1Answer`、`stage1Error`)。`epochsSince` は古い Meta にないので比べない。`test/catalog.test.ts` の乱択の比べ合いも同じ落とし方をする。

欠陥の表 (`scripts/fault-table.mjs --from 1 --to 40 --procs 3`、コミットした作業ツリーで)。見つけた数は、どの行も減らなかった。
各欄は、落ちた試験の数 / 流した seed ごとの試験の数である。

| 欠陥 | 段 | replay | history | ddl-concurrent |
|---|---|---|---|---|
| (なし) | 前 (`44306cf`) | 0/120 | 0/240 | 0/520 |
| (なし) | 後 (`04a0c9e`) | 0/120 | 0/240 | 0/520 |
| `noSchemaRecheck` | 前 | 0/120 | 0/240 | 37/520 |
| `noSchemaRecheck` | 後 | 0/120 | 0/240 | 39/520 |
| `ignoreFence` | 前 | 0/120 | 82/240 | 80/520 |
| `ignoreFence` | 後 | 0/120 | 82/240 | 80/520 |
| `staleWideRead` | 前 | 0/120 | 0/240 | 16/520 |
| `staleWideRead` | 後 | 0/120 | 0/240 | 16/520 |
| `childKeepsOldSchema` | 前 | 0/120 | 0/240 | 0/520 |
| `childKeepsOldSchema` | 後 | 0/120 | 0/240 | 0/520 |

`noSchemaRecheck` と `staleWideRead` の ddl-concurrent は、落ちる seed の顔ぶれが少し変わった (同じ seed でも、計画し直しと追いつきで実行が変わる)。
`childKeepsOldSchema` は、前も後も、乱択の検査では見つからない (`docs/model-coverage.md` の「Switches that match no red module」のとおり)。
表は `04a0c9e` で取った。その後の `f055c56` は、行ロックを取って読んだ範囲が動いた取引の範囲表を取り替えないことだけを足した (分割の後の取引の文だけが変わる)。RPC の列と、下の数は `f055c56` で取り直した。

置き場所の差分の検査の「台本の途中で 1 回分割する」置き場所で、分割の後の取引の文と `COMMIT` の結果を、seed 1 から 300 で数えた (3 つの実行の形)。
取引の出し方は、`Db.begin()` (表の object)、SQL の `BEGIN` (sql)、Hrana の baton (baton) である。

| 実行 | 段 | 文: 通った | 文: `not owner` | 文: `read too old` | 文: ほかの競合 | `COMMIT`: 通った | `COMMIT`: `not owner` | `COMMIT`: ほかの競合 |
|---|---|---|---|---|---|---|---|---|
| sim | 前 | 329 | 406 | 110 | 0 | 82 | 92 | 45 |
| sim | 後 | 437 | 0 | 355 | 52 | 74 | 90 | 55 |
| reference-scans | 前 | 318 | 406 | 118 | 0 | 99 | 85 | 35 |
| reference-scans | 後 | 418 | 0 | 374 | 50 | 92 | 82 | 45 |
| reference-full | 前 | 161 | 509 | 181 | 0 | 110 | 75 | 29 |
| reference-full | 後 | 266 | 0 | 520 | 62 | 101 | 70 | 43 |

制約の違反で失敗した文は数えていない。

文の `not owner` は、どの形でも 0 になった。前は、object と sql の取引の文が、分割の後に動いた範囲に触ると、取引の終わりまで断られた (baton は要求ごとに範囲表を取り直すので、前から 0 だった)。
そのうち、分割の前に動いた範囲を読んでいなかった取引の文は通るようになり、読んでいた取引の文は `read too old` に、書いていた取引の文は競合になった (37 の形)。台本の半分は、取引を表の丸ごとの読みで始めるので、`read too old` が多い。
`COMMIT` の `not owner` は残る (37 の 1 つ目の形の `COMMIT`)。
検査は、分割の後の文の `not owner` を違いとして報告するように締めた。`COMMIT` は、もとから競合を許しているので、緩いままである。締めた検査は、段 2 で seed 1 から 300 が通り、段 2 より前のコードでは、既定の 30 seed のうち 12 が落ちる。

### 設計の本文からずれたところ

- `refresh` と `unchanged` は `epoch` を運ばない。どちらも、取引がそのシャードで読んだ範囲を送る要求で、そのシャードは、そのときもう自分のスナップショットで範囲を持っていた。範囲の記録を適用する必要が起きない。
- 範囲の記録だけを適用する手 (`catchUpStep`) は、表定義の記録の手前で止まる。表定義の記録は intent を決着させてから適用するもので、要求の表定義の epoch が自分より新しければ、入口が先にそちらへ回すからである。
- 所有の確かめは、`__fenced` の拒否の隣に足した。置き換えてはいない (段 4 まで、親は範囲表の切り替えより前に fence する)。
- シャードは移動の記録 (`Snapshot.moves`) を所有に使わない。移動の途中の規則 (到着、時刻 m、`Migrating`、`ReadTooOld`) は、今と同じく `__incoming`、`__fenced`、`__arrived` が持つ。
- Meta は畳んだ結果を覚えない (上の「シャードの写し」)。

### 見つけて直していないもの

- 37 の 3 つの形 (上)。
- Hrana の baton の取引は、要求ごとに、その要求の接続の範囲表で組み立て直す (`Txn.load`) ので、分割の前に書いた行が動くと、上と同じく、行ロックを取る文が取引自身の書き込みを見ないまま答える (`test/open/baton-own-write-across-split.test.ts`)。段 2 より前のコードでも同じである。不変条件の候補: 取引の文は、取引自身の書き込みを必ず見る (見られないなら答えない)。持ち主は Worker の取引の層。
- `Db.attemptStatement` は、失敗した文の採番を、同じブロックなら無条件に戻す。worker.ts は同じ isolate の接続でブロックを共有するので、その間にほかの接続が同じブロックから取っていれば、その番号をもう一度配り、後の INSERT が主キーの UNIQUE で失敗する (`test/shared-rowid-block-rollback.test.ts`)。不変条件の候補: 採番した rowid は、どの接続にも 1 度しか配らない。

### 段 3 に要るもの

- Meta が `prepare`、`abort`、`of` のある `commit` を書き、シャードが `prepare` の禁止 (`open.fence`) で書き込みを断る。いまのシャードは、これらの記録を断る (`applyStep`)。`TableDef.building` と `locked` の印を、スナップショットの `open` に替える。
- `schema` を、どの記録で進めるかの持ち主の判断 6 (いまは、段 1 の `commit` の記録だけが進める)。
- `test/meta-old.ts` と `META_SHADOW` は、段 3 で消せる。比べる前に段 2 の欄を落とす関数 (`stage1Answer`、`stage1Error`) も一緒に消す。
- 移動をまたぐ読みの確かめ直しの規則と、取引が溜めた読みと書き込みを新しい持ち主へ移す規則 (上) は、段 3 ではなく、37 の作業である。モデルが入ってから、`Txn.advance`、`Txn.reroute`、子の prepare の所有の時刻に入れる。

## 移動をまたぐ取引 (2026-11-15)

「Worker」の節は、動いた区間に触った文が `not owner:` で失敗し、利用者が取引をやり直す、としていた。
2026-11-15 に、取引は途中の移動をまたいで続く、と約束した (`docs/sql-language.md` の「取引」)。
設計は [design-refresh-across-move.md](./design-refresh-across-move.md)、モデルは M23 (`specs/m23_refresh_across_move.qnt`) にある。
この文書で変わるのは、取引が確定まで使うスナップショットの意味だけである。
取引が確定まで名乗るのは `schema` で、範囲表は `NotOwner` のたびに取り直す。
取り直したスナップショットの `schema` が違えば、今と同じく、表定義の変更で古くなった取引として失敗する。
「取引は、最初に読むか書くかしたときのスナップショットを確定まで使う」と「範囲表だけが進んだ後も、取引は古いスナップショットのまま進む」は、表定義の部分について読む。
要求が `epoch` と `schema` を運ぶこと、シャードが所有を自分のスナップショットで引くことは変わらない。
範囲表の取り直しだけを先に入れても安全である。確かめは今と同じく読んだシャードへ行き、親は `NotOwner`、子は床で断るので、取引は競合で失敗する (M23 の `m23_impl`。答えは誤らないが、規則 4 はまだ破れている)。

## 段 3 の結果 (2026-11-16)

段 3 で、どの DDL も、Meta の列の `prepare` から `commit` か `abort` へ進むようになった。
取り消し (逆操作の文を持つ次の版)、`TableDef.building` と `locked`、DROP の前の書き込み禁止の版 (`lockTables`、`finishLock`)、記録の前に重複を調べる `Db.checkUnique` はなくなった。
分割の枠 (`SplitSlot`) と、範囲の移動の手順は段 2 のままである (段 4)。
通信の版は 8、保存の形式は版 5 で、どちらも移行は書かない。

### 記録と期限

| 記録 | Meta が書くとき | シャードがすること (記録を写しに足すのと同じ 1 つの同期の取引で) |
|---|---|---|
| `{ kind: "prepare", mode, ddl, fence, staging? }` | `MetaCore.prepare(sql, { guard }, basedOn)`。`basedOn` が最新の表定義の epoch でなければ `SchemaMoved`。遷移が開いているか分割の枠があれば `SchemaBusy`。文 (`staging.sql` と `ddl.sql`) を Meta の SQLite の空の表で試して巻き戻し、通れば記録して、期限を付ける | 先に intent を全部決着させる (今までどおり、表定義の記録の前に `settleAll`)。`staging.sql` (index の表) を作る。以後、`fence` の表への書き込みを `TableLocked` で断る (`assertUnlocked` が、スナップショットの開いている遷移を見る) |
| `{ kind: "commit", of, at? }` | `MetaCore.commit(epoch, acks, at)`。遷移が開いていること (ONE_EXIT)、`acks` が範囲表の全シャードを覆うこと (ALL_ACKS) を確かめ (`refusal` の `one-exit` と `all-acks`)、文を Meta の SQLite でも実行して残す。期限を消す | prepare の `ddl.sql` を実行する。`at` があれば時計を進め、`ddlFloor` を取り直す。失敗すれば、取り消さずに止まる (`schemaStuck`、health の `schemaError`) |
| `{ kind: "abort", of, reason }` | `MetaCore.abort(epoch, reason)`。進める側が失敗したとき。期限切れなら `expire` が書く。もう abort された遷移には記録せず、記録した理由を返す。commit された遷移は断る | `staging` の表を名前で消す。禁止が解ける |

期限は `__meta` の `lease` (`[{ epoch, started, until }]`) で、prepare が付け、commit と abort が消す。
進める側は期限の半分ごとに `MetaCore.renew(epoch)` で延ばし、止まれば 5 秒 (`LEASE_MS`) のうちに、延ばし続けても prepare から 5 分 (`TRANSITION_MAX_MS`) で、Meta の入口の `expire` が abort を書く。
abort の理由は「(遷移の名前) stopped before it finished and was withdrawn; the table is unchanged」か「... did not finish within 300 seconds ...」で、遷移の名前は、index の作成なら `CREATE INDEX <名前>`、取引が読んだ表の DROP なら `the lock on <表> before DROP TABLE`、ほかは文そのものである (`src/catalog.ts` の `describeOpen`)。

シャードの新しい入口 `prepared({ epoch })` は、prepare の epoch まで列を適用し、その遷移が自分のスナップショットで開いていれば ok を返す。
mode が `trial` なら、書き込みを止めた表に `ddl.sql` を試して巻き戻し (`ShardKernel.trial`、rollback-read と同じ形)、SQLite が通したかを返す。
もう開いていなければ (先に abort を適用した) ok: false を返す。

### 進め方

`Db.changeSchema` は、どの DDL も同じ手で進める。新しい表を作るだけの DDL も同じである (決めたこと 2)。

1. 表定義を取り、文を Worker の SQLite で再生できることを確かめ (`assertReplays`)、Meta に prepare を記録させる (`prepareDdl`)。`SchemaMoved` なら取り直し、`SchemaBusy` なら待つ (60 秒)。何もしない DDL (IF NOT EXISTS で表がある、など) は、何も記録されずに終わる。
2. 期限を延ばし始め、範囲表の全シャードに `prepared` を尋ねる (`preparedAll`)。どれかが ok でなければ、その理由で失敗する。移動の途中で適用を待つシャードには、待って尋ね直す。
3. mode ごとの仕事をする (`work`)。`build` は止まった行を読んで index の表へ項目を書き、読んだ時刻の最大を `at` にする。`guard` は、取引が読んだ範囲を持つシャードに `unchanged` を尋ねる。
4. Meta に commit を記録させる。どこかで失敗すれば abort を記録させ、Meta が先に abort していれば、その理由を返す。
5. commit を全シャードに適用させる (`syncAll`)。書き込みの禁止を早く解くためで、失敗は捨てる。

進める側の手を、進める側の止まる検査 (`test/ddl-driver-stops.test.ts`) が止めずに流したときの列は次のとおりである (2 シャード。`catalog` は数えない)。

| 場面 | 手の列 |
|---|---|
| 片方のシャードの行が CHECK に反する ADD COLUMN | `prepare` `renew` `s0.prepared` `s1.prepared` `abort` `s0.syncSchema` `s1.syncSchema` |
| 行のある表への、シャードをまたぐ UNIQUE の index | `prepare` `renew` `s0.prepared` `s1.prepared` `s0.exec` `s1.exec` `s1.exec` `s1.commitLocal` `s0.exec` `s0.commitLocal` `commit` `s0.syncSchema` `s1.syncSchema` |
| 同じ batch が読んだ表の DROP | (読む取引の手の後で) `prepare` `renew` `s0.prepared` `s1.prepared` `s0.unchanged` `s1.unchanged` `commit` `s0.syncSchema` `s1.syncSchema` |

段 3 より前の、行で失敗する DDL の列は `s0.syncSchema` `s1.syncSchema` `applyDdl` `s0.syncSchema` `s1.syncSchema` `s0.syncSchema` `s1.syncSchema` だった (記録の前の適用、記録、記録の後の適用、取り消しの後の適用)。

### mode と fence

(2026-11-17 に、fence は、DDL の種類ごとに並べるのをやめ、DDL が書き込みの epoch を進める表から導くようにした。`DROP INDEX` と、列だけの一意でない `CREATE INDEX` の fence は、対象の表である。「表ごとの epoch」の「ロックを与える判断と fence」。下の表は、段 3 のときのものである。)

| DDL | mode | fence |
|---|---|---|
| CREATE TABLE、CREATE VIEW、DROP VIEW、DROP INDEX、列だけの一意でない CREATE INDEX | `plain` | なし |
| DROP TABLE、ALTER TABLE ... RENAME TO | `plain` | 対象の表 |
| シャード内の UNIQUE index、式か WHERE のある index | `trial` | 対象の表 |
| ALTER TABLE ... ADD COLUMN | `trial` | 対象の表 |
| 行のある表への、シャードをまたぐ UNIQUE の index | `build` | 対象の表 (staging は `__gidx_<index>`) |
| 取引が読んだ表の DROP TABLE | `guard` | 消す表 |

### 消したもの

| 場所 | 消したもの |
|---|---|
| `src/meta.ts` | `applyDdl`、`revokeDdl` と `revoke`、`publishIndex`、`lockTables`、`finishLock`、`renewLock`、`building`、`holders`、`ddlSince`、`entries`、`append`、`schemaOf`、`build_lease`。`Catalog.version` と `Catalog.revoked`、`SchemaMoved.version`、`SplitSlot.version` (枠は表定義の epoch `schema` で持つ) |
| `src/catalog.ts` | 段 1 の、`DdlEntry` を運ぶ `commit` の記録と `DdlEntry` (`version`、`reverts`、`reason`、`guard`)、`Snapshot.version` と `revoked` |
| `src/sql/ddl.ts`、`src/types.ts` | `ParsedDdl.undo` と `build`、`publishBuild`、`TableDef.building` と `locked`、使われていなかった `MetaApi` |
| `src/shard/kernel.ts`、`core.ts`、`step.ts` | `schemaFailed` の手続き、Meta への `revokeDdl`、取り消しの組を飛ばす処理 (`applyStep` の `skip`) |
| `src/client/db.ts` | `record` (記録の前の全シャードへの適用)、`syncRecorded`、`guardedDrop`、`checkUnique`、`buildIndex`、`stillBuilding`、Cluster の 6 つの入口 |
| `src/worker.ts` | Meta の DO の 6 つの入口と `ddlSince`。`schemaSql` (論理エクスポートの表定義) は `catalog().ddl` から作る。`/admin/ddl` は表定義の epoch を返す |
| 欠陥のスイッチ | `dropAfterExpiry` (`commitAfterAbort` に広げた)、`scanBeforeLock` (`checkBeforePrepare` に広げた) |
| 試験 | `test/meta-old.ts`、`META_SHADOW` (`test/sim.ts` の `shadowMeta`)、`stage1Answer` と `stage1Error`、`test/catalog.test.ts` の段 1 の比べ合い |

古い Meta との比べ合いを消す前に、残る使い道がないことを確かめた。
比べ合いは、新旧の Meta の同じ名前の入口を同じ順で呼んで答えを比べるもので、段 3 の Meta には、比べていた入口のうち表定義の 6 つ (`applyDdl`、`revokeDdl`、`publishIndex`、`lockTables`、`finishLock`、`renewLock`) がない。
残る入口 (`catalog`、分割の枠の 5 つ、`switchRange`、`allocate`) の答えも、表定義の版の数と取り消しの印がなくなり、表定義の epoch が prepare と abort でも進むので、同じにならない。
乱択の比べ合い (`test/catalog.test.ts` の 60 seed) の並びは、どれも表定義の 6 つの入口を呼ぶ。
表定義の遷移の条件は、M21 と突き合わせる `test/catalog-m21.test.ts` (段 3 でも変えずに通る) と、`test/catalog.test.ts` の書き直した試験、下の再生が確かめる。

### 決めたこと 3 (試しで index を 2 度作るか) の測り

シャード内の UNIQUE index (`CREATE UNIQUE INDEX ux ON p(tenant_id, code)`、主キー 2 列、`code` は 30 字ほどの TEXT) を、行の数を変えて node:sqlite (Node 24) で作った。
3 回流した中央値である。

| 行 | 1 度だけ作る | 試して巻き戻す | 試した後に作る |
|---|---|---|---|
| 100,000 | 35 ms | 34 ms | 30 ms |
| 1,000,000 | 399 ms | 402 ms | 399 ms |

試しの費用は、index を 1 度作るのと同じで、書き込みが止まる時間は、その分だけ長くなる (100 万行のシャードで約 0.4 秒)。
試しで index を 2 度作る形のままにした。
`prepare` で本物の index を作り、`abort` で名前で消す形にすると、作るのは 1 度で済むが、`prepare` が利用者の表に触ることになり、遅れて `prepare` と `abort` を続けて見るシャードと、分割で生まれたシャードが、作って消すことになる。
節約できるのは 100 万行で 0.4 秒ほどで、書き込みが止まる時間の上限 (5 分) と比べて小さい。
DO の SQLite が取引 (`transactionSync`) の中の DDL を巻き戻し、確定のときに同じ文がもう一度通ることは、手元の workerd で確かめた。Meta は DDL ごとに、文を自分の SQLite の取引の中で試して巻き戻す (`tryShadow`) ので、workerd の試験の全部の DDL がこの経路を通る。シャードの試しが通る場合と通らない場合は、`test/workerd.test.ts` の「tries a change that can fail on rows on the fenced table ...」が通す。
巻き戻した書き込みが課金されるかは、Cloudflare で測っていない (`docs/platform-facts.md` にない)。持ち主の許可を得た計測の項目に足す。

### 設計の本文からずれたところ

- `prepare` の `staging` の表定義は、prepare を畳んだときから `Snapshot.tables` に載り、abort で消える。進める側が、commit の前に、その表へ項目を書くからである。利用者の文からは見えない (内部の名前で、Worker の SQLite の履歴にもない)。
- `build` の prepare の `ddl` は、出来上がった形 (表定義の `globalIndexes` に index を足したもの、index の表の表定義、`indexes`、利用者の文) を持ち、行の側の index (`__gidx_<index>__rows`、一意でない) を作る文だけを `ddl.sql` に置く。
- どの `ADD COLUMN` も `trial` にした。`CHECK` と `NOT NULL` だけでなく、STRICT の表の既定値の型も既存の行で確かめられ、SQLite の `ADD COLUMN` は表の形を書き換えるだけなので、試すのは安い。`NOT NULL` で既定値のない `ADD COLUMN` は、新しい SQLite では空の表では通るので、Meta では断られず、行のあるシャードの試しで断られる。
- DDL の遷移と分割の排他は、段 4 まで分割の枠が守る。`refusal` の `ddl-waits-move` と `move-waits-ddl` は使わない。試験が `switchRange` を直に呼んで `endSplit` を呼ばないと、列に開いた移動が残り、`ddl-waits-move` で全部の DDL が止まるからである。Meta が `refusal` で決めるのは、`one-open`、`one-exit`、`all-acks` の 3 つである。
- スナップショットは、開いている遷移を一覧 (`Snapshot.opens`) でも持つ。欠陥のスイッチ `overlappingTransitions` を入れた Meta の列も畳むためで、Meta の条件が守られていれば、1 つか空である。期限も遷移ごとに持つ。
- `commitAfterAbort` は、閉じた遷移の遅れた commit を受けて、同じ prepare をもう一度記録し、それを確定する。列は壊れず、abort から開き直すまでの書き込みは止まっていない。
- `commitWithoutAcks` は、Worker の側で最後のシャードに `prepared` も、commit の後の適用も送らない。Meta の側では ok の集合を確かめない。`FAULT=` は両方に入れる (`test/sim.ts` の `BOTH_FAULTS`)。
- `prepared` の要求の `early` は、欠陥のスイッチ `checkBeforePrepare` だけが付ける。シャードは列を適用せずに、記録を読んで、いまの表で試す。
- 重複のある列への `CREATE UNIQUE INDEX` (行が同じシャードにある) の誤りの文が、D∞ の文 (`UNIQUE constraint failed: p has duplicate values`) から SQLite の文 (`UNIQUE constraint failed: p.tenant_id, p.code`) になった。記録の前に調べていた `Db.checkUnique` がなくなり、各シャードの試しが SQLite の文を返すからである。`test/schema-failure.test.ts` のほかの場面 (行の片方が反する部分 UNIQUE、CHECK に反する ADD COLUMN) の文は変わらない。
- 分割の途中に出した DDL の誤りの文が「a shard split is in progress」から「a shard split of s0 is in progress」になった。記録の前に全シャードへ移動の途中かを尋ねる手がなくなり、Meta の枠の `SchemaBusy` で待つからである。
- 分割の枠を取る前の全シャードへの適用 (`reserveSplit`) は残した。段 3 からは安全のためには要らない (取り消しがないので、枠の後に表定義の記録が入らない)。欠陥のスイッチ `splitWithoutSync` は、段 3 から何も戻さない。枠と一緒に段 4 で消す。

### 検査

先に今のコードで用意した検査 (規則 2)。

- 進める側を各手の前で止める検査 (`test/ddl-driver-stops.test.ts`、`test/ddl-driver.ts`)。手の列を止めずに流して取り、手ごとに最初から流し直して、その手の前で止める。止めた後で、文は効いたか効かなかったかのどちらかであること、表へ書けること、別の DDL が通ること、全シャードが最新の表定義を適用でき、適用の失敗を報告していないことを確かめる。段 3 より前のコードで、index の作成と、読んだ表の DROP の場面は通り、行で失敗する ADD COLUMN の場面は落ちた。Meta が版を記録した後、シャードへ適用させる前に進める側が止まると、取り消しは、どれかの要求が行の反するシャードに版を適用させるまで起きず、その間、ほかの接続は列を足した表定義で計画した (4 つの値の INSERT が「table p has 5 columns but 4 values were supplied」で失敗した)。どこでも効かない文が、効いたように見えた。この場面は `test/open/` に置いてから段 3 に入り、段 3 で 3 つとも通ったので、戻した。
- `test/schema-failure.test.ts` は、重複のある UNIQUE と CHECK に反する行の場面の誤りの文を、完全に一致で確かめるようにした。段 3 で変わったのは、上に書いた 1 つだけである。どの場面でも、表は書けるままである。
- `test/open/split-reserve-revoked.test.ts` を、段 3 の形に写して `test/split-reserve-revoked.test.ts` へ移した。行で失敗する DDL を進める側が、s1 の試しが通らないのを見て abort を記録し、全シャードに適用させる前に止まる。分割の枠を取る前の適用は、prepare と abort を順に適用するだけで断られず、split() は 1 回で通る。

M21 の段 3 の赤の再生は `docs/model-coverage.md` の M21 の行にある。
新しく書いたのは `test/m21-two-phase.test.ts` の 9 つの場面で、どれも、直したコードで正しく終わることと、欠陥のスイッチを入れると、モデルの反例と同じ不変条件が破れることを確かめる。
スイッチは、表を作った後で入れる (場面の前提の表を作る DDL にスイッチが掛からないように)。

| M21 の赤 | スイッチ | スイッチを入れたときの姿 |
|---|---|---|
| `m21_red_trial_no_fence` | `ignoreTableLock` | 試しの後に CHECK に反する行が入り、s0 が commit を適用できずに止まる |
| `m21_red_trial_no_drain` | `ddlIgnoresIntents` | 試しが決着していない intent の行を見落とし、s0 が commit を適用できずに止まる |
| `m21_red_trial_early` | `checkBeforePrepare` | prepare を適用する前に試し、その後の書き込みを受けて、s0 が止まる |
| `m21_red_drop_check_early` | `checkBeforePrepare` | prepare の前に「変更なし」と答え、その後に書かれた行が DROP で消える |
| `m21_red_drop_no_fence` | `ignoreTableLock` | 確かめた後に書かれた行が DROP で消える |
| `m21_red_trial_missing_ack` | `commitWithoutAcks` | 答えなかったシャードが commit を適用できずに止まる。Meta の確かめだけを残すと、Meta が commit を断る |
| `m21_red_drop_missing_ack` | `commitWithoutAcks` | prepare を適用しなかったシャードが、DROP が完了を返した後の書き込みを受け、その行が消える |
| `m21_red_two_exits` | `commitAfterAbort` | 期限で abort された index の遅れた commit が通り、項目のない index が公開される (abort の適用が index の表を消すので、abort の後の行だけでなく、全部の行が index から引けない) |
| `m21_red_two_open` | `overlappingTransitions` | モデルの順 (index を作っている間に同じ表の DROP が確定する) では、Meta が commit のときに自分の SQLite で文を実行するので、消えた表への index の commit が記録されずに断られる (2 つ目の守り)。同じ欠陥は ADD COLUMN の順で表に出る: index の commit が、列を足す前の表定義で、足した列を表定義から消す |

`m21_red_early_commit` は、`commitWithoutAcks` だけでは届かない。index の作成の行の走査は prepare の epoch を名乗るので、飛ばされたシャードも、行を読まれる前に prepare を適用するからである。モデルの順 (項目を書く前に commit する) は、`publishBeforeBackfill` が `test/unique-index-build.test.ts` で再生する。
`test/ddl-concurrent.test.ts` の「DDL が全シャードに適用される前に完了を返す」欠陥の検査の検査 (lost-write check) は、確定の後の `syncSchema` を空にする形から、どのシャードも prepare を適用せずに ok と答え、確定の後にも適用しない形にした。`commitWithoutAcks` (3 つのうち 1 つのシャードを飛ばす) では、この作業負荷は seed 201 から 260 で 1 度も当たらなかった。

M12 と M14 の行は、M21 の行に置き換えた (決めたこと 7)。M15 の行は、段 4 で分割の枠がなくなるまで残す。`m15_red_no_based_on` は、段 3 から形がない (取り消しがないので、枠の後に表定義の記録が入らない) ので D にした。M11 と M13 の行は残す。

### 比べたもの

RPC の列。`test/history.test.ts` と `test/replay.test.ts` の既定の seed (61 件) を、段 3 の前 (`6c24560`) と後 (`3b6d6d7`) で `RPC_TRACE` を付けて流し、送り元、宛先、種類の列を比べた。
3 件は同じ (クラスタを作らない集計の試験で、列が空) で、58 件が違った。

| 違った試験 | 原因 |
|---|---|
| `history` の 33 件と、`replay` の DDL を作業負荷の前にだけ流す場面の 9 件 (42 件) | シャードに表定義を適用させる要求 (`syncSchema` と、新しい `prepared`) を除くと、列は同じである。どの試験も表を作る DDL で始まり、DDL 1 つの要求が、記録の前の `syncSchema` と記録の後の `syncSchema` から、`prepared` と commit の後の `syncSchema` に替わった。42 件とも、シャードごとに、前の `syncSchema` の数と、後の `prepared` と `syncSchema` の数の和が等しい |
| `replay` の「実行の途中で index を作る」の seed 1 から 8 (8 件) | 作業負荷の途中で DDL を流す場面である。DDL の要求の種類が替わり (上と同じ)、取り消しの後の全シャードへの適用がなくなったので、最初の DDL から後の列の交わり方が変わる。数を出す印を一時的に入れて seed 1 を流した (前後とも試験は通る): DDL は前後とも 11 回で、成否も同じ (7 回通り、4 回は重複で失敗)。シャードごとの表定義の要求は、前が `syncSchema` 27 回 (記録の前の適用 11、記録の後の適用 11、index の作成の終わり (公開か取り消し) の後の適用 5)、後が `prepared` 11 回と `syncSchema` 11 回 (commit か abort の後の適用) だった。書き込みが `TableLocked` で待ったのは、前後とも 0 回、古い表定義で断られて計画し直したのは、前後とも 2 回だった |
| `replay` の「SQL の BEGIN と Hrana の batch で表定義を変える取引」の seed 1 から 8 (8 件) | 同じく作業負荷の途中の DDL である。seed 1 の数: 前は DDL を 117 回出し、99 回が記録され、16 回は何もしない DDL (IF NOT EXISTS など。記録されない) で、2 回は失敗した。記録の前に全シャードへ適用させる手は 161 回あった (`schema moved` と `schema busy` のやり直しを含み、何もしない DDL も送る)。後は DDL を 99 回出し、91 回が prepare から commit まで進み、8 回は何もしない DDL で、シャードに要求を送らなかった。古い表定義で断られて計画し直した文は、前が 124 回、後が 75 回だった。取引と batch のやり直しの回数が変わり、出した DDL の数も変わる。`TableLocked` の待ちは、前後とも 0 回だった |

数を出す印は、`Db.changeSchema` の出口と、`Db.onRetry`、`Db.schemaMovedPast` に一時的に入れ、比べた後で戻した。

欠陥の表 (`scripts/fault-table.mjs --from 1 --to 40 --procs 3`、コミットした作業ツリーで。前は `6c24560`、後は `3b6d6d7`)。
各欄は、落ちた試験の数 / 流した seed ごとの試験の数である。

| 欠陥 (前 / 後) | 段 | replay | history | ddl-concurrent |
|---|---|---|---|---|
| (なし) | 前 | 0/120 | 0/240 | 0/520 |
| (なし) | 後 | 0/120 | 0/240 | 0/520 |
| `ddlIgnoresIntents` | 前 | 30/120 | 0/240 | 142/520 |
| `ddlIgnoresIntents` | 後 | 31/120 | 0/240 | 104/520 |
| `unchangedIgnoresIntents` | 前 | 0/120 | 0/240 | 0/520 |
| `unchangedIgnoresIntents` | 後 | 0/120 | 0/240 | 0/520 |
| `ignoreTableLock` | 前 | 8/120 | 0/240 | 85/520 |
| `ignoreTableLock` | 後 | 7/120 | 0/240 | 80/520 |
| `noSchemaRecheck` | 前 | 0/120 | 0/240 | 39/520 |
| `noSchemaRecheck` | 後 | 0/120 | 0/240 | 1/520 |
| `publishBeforeBackfill` | 前 | 40/120 | 0/240 | 120/520 |
| `publishBeforeBackfill` | 後 | 39/120 | 0/240 | 120/520 |
| `publishWithoutClock` | 前 | 0/120 | 0/240 | 0/520 |
| `publishWithoutClock` | 後 | 1/120 | 0/240 | 0/520 |
| `scanSkipsEmpty` | 前 | 0/120 | 0/240 | 0/520 |
| `scanSkipsEmpty` | 後 | 0/120 | 0/240 | 0/520 |
| `guardFromCommitTs` | 前 | 0/120 | 0/240 | 0/520 |
| `guardFromCommitTs` | 後 | 0/120 | 0/240 | 0/520 |
| `repinOnRestore` | 前 | 0/120 | 0/240 | 0/520 |
| `repinOnRestore` | 後 | 0/120 | 0/240 | 0/520 |
| `dropAfterExpiry` / `commitAfterAbort` | 前 | 0/120 | 0/240 | 0/520 |
| `dropAfterExpiry` / `commitAfterAbort` | 後 | 0/120 | 0/240 | 0/520 |
| `scanBeforeLock` / `checkBeforePrepare` | 前 | 2/120 | 0/240 | 64/520 |
| `scanBeforeLock` / `checkBeforePrepare` | 後 | 2/120 | 0/240 | 61/520 |
| `commitWithoutAcks` (新) | 後 | 0/120 | 0/240 | 0/520 |
| `overlappingTransitions` (新) | 後 | 0/120 | 0/240 | 0/520 |

見つけた数が減った行と、その理由。

- `noSchemaRecheck` の ddl-concurrent (39 から 1)。場面ごとに数えた (同じ seed の範囲を `scripts/sweep.mjs` で流した): 前は「分割と CREATE INDEX と ADD COLUMN」が 17、「分割と CREATE UNIQUE INDEX と ADD COLUMN」が 19、「ADD COLUMN」が 2、「複数の表の取引と DROP TABLE」が 1 で、ほとんどが、行イメージの形の検査 (`test/setup.ts`) が見つけた、列を足す前の形の書き込みだった。後は「分割と CREATE UNIQUE INDEX と ADD COLUMN」の seed 31 の 1 つである。M21 では、待ちの後の版の確かめ直し (`m21_red_no_recheck` が外すもの、`noServeBelowAck` を守る) と、prepare の書き込み禁止 (`noWriteWhileFenced` を守る) は別の守りで、どちらも、待っている間に表の形が変わった古い計画の書き込みを止める。減った理由は 2 つある。1 つ目は、段 3 の ADD COLUMN の書き込み禁止で、これは測った: 作業ツリーの写しで ADD COLUMN の fence を空にして同じ seed を流すと、5 (分割と CREATE INDEX と ADD COLUMN が 3、分割と CREATE UNIQUE INDEX と ADD COLUMN が 2) に戻る。禁止があると、古い計画の書き込みは、待ちの後で書き込み禁止に断られる (`assertUnlocked` は要求の表定義の epoch に依らない)。2 つ目 (39 から 5) は、表の形が変わるのが、最初の記録ではなく commit になったことである。これは推し量ったもので、測っていない。段 3 より前の ADD COLUMN は 1 つの版で、待っている書き込みがその版の適用をまたげば足りた。段 3 では、prepare は形を変えず、形を変える commit は、全シャードの prepared の往復の後に記録され、その後で適用される。古い計画の書き込みが形の変わる前に入って、形が変わった後に出るには、待ちが prepare の適用から commit の適用までをまたがなければならず、乱択の作業負荷の待ちは、ほとんどそこまで長くない (残った 5 つは、分割で群の到着を待つ、長い待ちのある場面である)。待ちが 2 つの記録をまたぐ形は、`test/stale-plan-after-wait.test.ts` と ddl-concurrent の BUG-3 の再生が決まった順で流し、スイッチを入れると落ちる (`m21_red_no_recheck` の行)。乱択の検査は、このスイッチを、ほとんど見つけなくなった。
- `ddlIgnoresIntents` の ddl-concurrent (142 から 104)。場面ごとの数は、前、後の順に、複数の表の取引と DROP TABLE が 25、21、DROP と同じ名前の CREATE が 18、18、ADD COLUMN が 21、16、分割と CREATE INDEX と ADD COLUMN が 10、1、分割と CREATE UNIQUE INDEX と ADD COLUMN が 16、12、列の順を変えた作り直しが 24、19、移行の道具の作り直しが 28、17 である。どの場面も見つける。M21 で intent の決着が守るのは、prepare を適用したシャードで、書き込みを止めた表に、決着していない書き込みが後から入らないこと (`m21_red_no_drain` の `noWriteWhileFenced`) である。乱択の検査が見るのは、その後の commit が表の形を変えるか表を消したときに、まだ決着していない intent が、新しい形の表に当てはめられるか、消えた表に残る姿だけである。段 3 では、prepare と commit の間に全シャードへの往復 (と試し) があり、prepare のときに飛んでいた intent の多くは、commit を適用する前に決着する。intent が commit の適用まで残る実行だけが見つかるので、数が減る (場面ごとの数は測ったもので、この理由は推し量ったものである)。決まった順の再生 (`m21_red_no_drain`、`_trial_no_drain`、`_drop_no_drain` の行) は、スイッチを入れると落ちる。
- `ignoreTableLock` (replay 8 から 7、ddl-concurrent 85 から 80)、`publishBeforeBackfill` の replay (40 から 39)、`scanBeforeLock` / `checkBeforePrepare` の ddl-concurrent (64 から 61)。どれも、index の作成の守りを外すスイッチで、守りの位置 (prepare を適用したシャードが書き込みを断る、項目を書いてから commit する、prepare を適用してから行を読む) は段 3 の前後で同じである (M21 の `m21_red_no_fence`、`_early_commit`、`_scan_early`)。どれも seed 1 から見つかり、違いは数 seed である。RPC の列の比べ合いのとおり、最初の DDL の後の交わり方が変わったことによると考えているが、場面ごとには数えていない。決まった順の再生は、スイッチを入れると落ちる。`checkBeforePrepare` は、試しと DROP の前の確かめも早めるが、ddl-concurrent の ADD COLUMN は CHECK を持たず、行で失敗し得ないので、試しを早めても答えは変わらない。その 2 つの形は `test/m21-two-phase.test.ts` が流す。

新しい 2 つのスイッチは、乱択の検査では見つからない。`commitWithoutAcks` は 3 つのうち 1 つのシャードを飛ばすだけで、飛ばしたシャードは、次の要求で prepare と commit を続けて適用する。古い表定義で計画した書き込みが、そのシャードに、その前に届く実行が要る (ddl-concurrent の lost-write の検査の検査で、seed 201 から 260 に 1 度もなかった)。`overlappingTransitions` は、2 つ目の DDL が 1 つ目の遷移の間に記録される実行が要るが、作業負荷の DDL は 1 つの接続から順に出る。どちらも `test/m21-two-phase.test.ts` が決まった順で再生する。

### 乱択の検査

段 3 の後のコード (`c2ac670`) で流した。

| 検査 | seed | 結果 |
|---|---|---|
| `test/ddl-concurrent.test.ts` (sim) | 1 から 500 | 6,500 件が通り、落ちたものはない (3 プロセスで 2,053 秒) |
| `test/ddl-concurrent.test.ts` (`REFERENCE=scans`) | 1 から 100 | 1,300 件が通り、落ちたものはない (807 秒) |
| `test/ddl-concurrent.test.ts` (`REFERENCE=full`) | 1 から 100 | 1,300 件が通り、落ちたものはない (2,273 秒) |
| `test/replay.test.ts` の「実行の途中で index を作る」(sim、reference-scans、reference-full) | 1 から 200 | 600 件が通り、落ちたものはない (80 秒) |

`ddl-concurrent` は基準経路の 2 つの組 (`vitest.config.ts` の oracles) に入っていないので、`REFERENCE` を環境変数で渡して sim の組で流した。渡した値が効いていることは、seed 1 の 1 つの場面で RPC を数えて確かめた (通常の経路は 1,616 回で `execAuto` が 53 回、`REFERENCE=scans` は 1,847 回で `execAuto` が 0 回、`REFERENCE=full` は 7,845 回)。
「実行の途中で index を作る」は、段 3 の直後のコード (`3b6d6d7`) でも seed 1 から 200 を流し、600 件が通った。
全部の試験 (`npx vitest run --maxWorkers=3`、4 つの組) も `c2ac670` で流し、182 ファイルのうち 175 が通り 7 が飛ばされ、1,946 件のうち 1,908 件が通り、38 件が飛ばされ、落ちたものはなかった。
欠陥の表と RPC の列は `3b6d6d7` で取った。その後の `5189ca9` は、シャードが写しを畳み直す回数を減らすだけで (範囲の記録の後の畳み直しを、次の表定義の記録の前まで遅らせる)、畳んだ結果を変えない。`c2ac670` は試験と文書だけである。`history` と `replay` の既定の seed の RPC の列は、`3b6d6d7` と `c2ac670` で 61 件とも同じだった。

### 見つけて直していないもの

段 3 の作業の中で新しく見つけた欠陥は、進める側を止める検査が段 3 より前のコードで見つけた 1 つ (行で失敗する DDL が、取り消されるまでの間、ほかの接続に見える) で、段 3 で直った。
`test/open/` の再現 (13 ファイル) は、段 3 の前後で流し、どれも落ち、最初の誤りの文も前後で同じだった (段 3 で直って移した `split-reserve-revoked` を除く)。

### 段 4 に要るもの

- `startMove` と `endMove`。分割の枠 (`SplitSlot`、`beginSplit`、`startSplit`、`checkSplit`、`endSplit`、`splits`)、`fence` と `beginIncoming` の RPC、`switchRange`、`reserveSplit` を消す。DDL と移動の排他を、`refusal` の `ddl-waits-move` と `move-waits-ddl` で、列から決める (段 3 では、枠の `assertFreeForDdl` と `beginSplit` の `open` の確かめが守っている)。消す欠陥のスイッチは `startWithoutSlot`、`fenceWithoutSlot`、`splitWithoutSync` (段 3 から何も戻さない) で、足すのは `ddlDuringMove`、`moveDuringDdl`、`endBeforeDrained`、`pullWithoutEpoch`。
- `docs/model-coverage.md` の M15 の行を、M21 の段 4 の赤 (`m21_red_ddl_during_move`、`_move_during_ddl`、`_end_early`、`_pull_unfenced`、`_fence_first`) に置き換える。`test/open/fenced-before-switch.test.ts` を本試験へ移す。
- `test/split-slot.test.ts` を、`test/ddl-driver.ts` と同じ形 (手の列の番号で止める) の、分割を進める側の検査に書き直す。止まる位置は、`startMove` の前後、`drain` の途中、`endMove` の前である。
- `Db.preparedAll` の、移動の途中のシャードを待って尋ね直す手は、Meta が移動の間に prepare を記録しなくなれば (DDL_WAITS_MOVE が列で決まれば)、起きなくなる。残すか消すかを決める。
- 決めたこと 6 の、表定義の epoch を commit だけで進める案は、段 3 の実装の上で、赤を確かめ直してから採るかを決める (段 3 は、どの記録でも進める)。
- `specs/README.md` の M21 の節は、段 3 に合わせて直す必要がある (この作業は `specs/` を書かないので、直していない)。「Meta が条件として使うのは段 3 と段 4 から」は、段 3 で `one-open`、`one-exit`、`all-acks` を使い始めたことに、「実装が入った時点で、M12、M14、M15 は M21 が置き換える」は、M12 と M14 を段 3 で、M15 を段 4 で置き換えることにする。

## 表ごとの epoch (2026-11-16)

状態：実装した (2026-11-17。この節の最後の「表ごとの epoch の実装の結果」)。
未解決の問題 53 を閉じる変更である。
モデルは M24 (`specs/m24_table_epochs.qnt`) で、結果は [specs/README.md](../specs/README.md) の M24 の節に書いた。
関数と行の番号は `9e53efa` のものである。

### 問題

段 3 の取引は、表定義全体の epoch (`schema`) を 1 つ名乗る。
この epoch は prepare、commit、abort のどれでも進む (決めたこと 6)。
そのため、どの DDL も、開いている取引を全部、2 度古くする。関係のない表の `CREATE TABLE` でも、失敗した DDL でも同じである。
古くなった取引の以後の文と `COMMIT` は、`SQLITE_BUSY` で断られる。

表を見ずに取引を断る所は、ほかに 4 つある。

| 場所 | 何をするか |
|---|---|
| シャードの `schemaStep` (`src/shard/kernel.ts:2141`) | 表定義の記録を適用している間 (`schemaChanging`)、古い表定義の要求を全部断る |
| シャードの `ddlFloor` (`:1489`、`:1522`、`:2032`) | DDL の commit を適用するたびに、シャードに 1 つの床を置く。どの表についても、床より古い時刻の読み戻し (`deltaAfter`)、refresh、述語の検証を断る。読み戻すのも、T より後に確定した全部の表の行である |
| Worker の `Txn.load` (`src/client/db.ts:874`) | Hrana の baton の取引を組み立て直すとき、表定義全体の epoch が変わっていれば、取引を失敗させる。`@libsql/client` の https は、この経路である |
| Worker の `Txn.reroute` (`:807`) | 表定義全体の epoch が同じスナップショットでなければ、範囲表を取り替えず、範囲の移動で断られた文が失敗する |

持ち主の基準 (2026-11-16) は、Drizzle のような ORM から使ったときに SQLite と同じに振る舞うことである。
D∞ の仕組みだけが起こし、SQLite では起きない失敗は、認めない。
SQLite (WAL) では、ほかの接続の DDL は、別の表の取引を失敗させない。

### 規則

| 要素 | 決定 |
|---|---|
| 表定義のもの | 表と view。名前 (大文字小文字を区別しない) で引く。消した名前も、消した epoch を持ち続ける。作り直した表は、より新しい epoch になる |
| ものの epoch | 表は 2 つ持つ。読みの epoch と、書き込みの epoch である。view は 1 つ持つ |
| 読みの epoch が進む記録 | その表の読みが返すもの (列、行の形、表があるか) か、シャードが古い時刻の行をその表に読み戻せるかを変える DDL の commit。`CREATE TABLE`、`DROP TABLE`、`RENAME TO` (古い名前と新しい名前の両方)、`ADD COLUMN`、シャード内の UNIQUE index と、式か WHERE のある index の作成 (前の行を戻すと、新しい制約や式で失敗し得る) |
| 書き込みの epoch が進む記録 | 読みの epoch が進む記録と、index の DDL の commit (`CREATE INDEX`、`DROP INDEX`。シャードをまたぐ UNIQUE を含む)。index の DDL は、index の名前ではなく、その表の epoch を進める |
| view の epoch が進む記録 | `CREATE VIEW` と `DROP VIEW` の commit |
| epoch を進める記録の種類 | commit だけ (決めたこと 6 を改める。下の「決めたこと 6 を改める」)。prepare と abort は、どの epoch も進めない。prepare が作る内部の表 (`__gidx_<index>`) だけは、prepare の epoch で生まれる |
| 計画が頼るもの | 文が開く表 (view を通るなら、その元の表。`Db.tablesOf` が Worker の SQLite のコンパイルで確かめる表)、文が名指す view、文が書く表 |
| 要求が運ぶもの | 頼るものごとに、名前と epoch と、書き込みとして頼るか。書く表と、文が `INDEXED BY` で index を名指す表 (パーサが受け付ける。`indexed_table`) は書き込みの epoch、ほかは読みの epoch である。index を名指す読みは、`DROP INDEX` の後に古い計画のまま届くと、シャードの SQLite が `no such index` で断るからである |
| シャードが比べるもの | 運ばれたものだけを、自分のスナップショットと比べる。要求のほうが新しければ、列をその epoch まで適用してから比べ直す。古ければ `stale schema` で断る。等しければ通す |
| 取引のスナップショット | 最初に読むか書くかしたときの表定義の全体を、確定まで使う (今と同じ。M13)。初めて触る表も、その表定義で計画する |

読みの epoch と書き込みの epoch を分けたのは、index の DDL の後も、読むだけの取引が続けられるようにするためである (下の「触った表の DDL と SQLite」)。
読みの経路は、index と UNIQUE の情報を使わない。
計画 (`src/sql/plan.ts`) が `uniques` と `globalIndexes` を見るのは INSERT と UPDATE で、範囲 (`src/client/spans.ts` の `statementSpans`) が `uniques` で範囲を広げるのは書き込みだけである。
`src/client/db.ts` で `uniques` と `globalIndexes` を見る所も、書き込みが衝突し得る行を集める所と、グローバル index を保守する所 (`indexChanges`) である。
グローバル index は読みの経路に使わない (`docs/sql-language.md`)。
シャード内の index は、シャードの SQLite が自分で使い、答えを変えない。変わり得るのは、`ORDER BY` のない読みの行の順だけで、SQL はそれを決めていない。
読みの epoch が index の作成で進むのは、古い時刻の読み戻しが、新しい UNIQUE や式で失敗し得る index (上の表) だけである。

要求が運ぶものの数は、その要求の範囲と書き込みが名指す表と、文が名指す view の数である。
要求はもともと範囲と書き込みで表を名指していて、その大きさは文と取引の上限 (1 MB の書き込みなど) で決まるので、新しい上限は置かない。
数が多いときに表定義全体の epoch へ戻す、という逃げ道も置かない。置くと、成否が文の形ではなく、頼る表の数で決まるからである。

### シャード

| 確かめ | 規則 | 今の何を置き換えるか |
|---|---|---|
| 表定義 | 要求が運ぶ、頼るものごとに比べる (上の表) | `schemaStep` の `schema` の比べ |
| 待ちの後の確かめ直し | 同じく、頼るものごとに比べ直す | `enter` の `schema` の確かめ直し (M21 の `m21_red_no_recheck`) |
| 遷移の仕事の要求 | `prepared`、index の作成の行の走査、DROP の前の `unchanged` は、prepare の epoch を `atLeast` として運び、シャードはそこまで列を適用してから答える | 要求の `schema` に prepare の epoch を名乗らせて、適用させていた。commit だけで進める形では、prepare はどの epoch も進めないので、別に運ぶ (M21 の `CHECK_AT_EPOCH`) |
| 記録の適用中 | 適用している記録が変えるもの (fence の表を含む) に頼る要求は、適用が終わるまで待つ。断らない。ほかの要求は通す | `schemaChanging` の間、全部の要求を断る |
| intent の決着 | 記録を適用する前に決着させるのは、その記録が変える表 (fence の表、文が作る、変える、消す表、index の表) の intent だけである | `settleAll` が全部の intent を決着させる |
| 床 | 床を表ごとに持ち、読みの epoch を進める commit を適用したとき、その表にだけ置く。古い時刻の読み戻しで戻すのは、読む表の行だけで、見る床もその表のものだけである。refresh の窓と述語の検証も、範囲の表の床だけを見る。床の値は、そのシャードの変更ログにある、その表の確定の時刻の最大である (2026-11-17 に、モデル M23j で決めた。適用した時刻ではない。下の「表ごとの epoch の実装の結果」の「床の値」) | シャードに 1 つの `ddlFloor` |
| 行ロック | 表 X の prepare は、X の行のロックがある間は適用しない。待ちの上限は DDL の待ちの期限 (DDL を始めてから、busy_timeout と同じ 5 秒。下の「Worker」。prepare の記録が運ぶ) で、過ぎれば `prepared` に ok でないと答え、DDL が `SQLITE_BUSY` で失敗する。ただし、取ってきた列で、その遷移がもう閉じている (commit か abort が記録されている) prepare は、待たずに適用する (遅れたシャードが prepare と abort を続けて適用するときに、ロックの持ち主が追いつきを止めないため。`m24_lock` の `applyPrepare` と同じ) | prepare は intent を決着させるだけで、ロックを待たない |
| 禁止に当たったロックを持つ取引 | X の行のロックを別のシャードに持つ取引の書き込みか `COMMIT` が、X の書き込み禁止に当たったら、シャードは、その文を `TableLocked` で断るときに、その行のロックを取引に与える (書かずに。要求は、取引がロックを持つことを運ぶ)。そのロックは、ほかの行ロックと同じく、やり直しの prepare を待たせ、取引の `COMMIT` か `ROLLBACK` で放され、TTL で切れる (`m24_retry` の `HOLD`) | 禁止に当たった文は断られるだけで、何も残さない |

記録の適用中に要求を断っていたのは、受けると intent が増え続けて、適用がいつまでも終わらないからである。
決着させるのを、記録が変える表の intent だけにすれば、ほかの表への要求を受けても、待つ intent は増えない。
記録が変える表への要求は、受け付けずに待たせるので、これも増えない。
決着を全部の表にしたまま、ほかの表の要求を通すと、適用が飢える。2 つは一緒に入れる。

### Worker

- 計画は、文ごとに、頼るものとその epoch を、取引のスナップショットから集める。取引の COMMIT は、シャードごとに、そのシャードの書き込みと確かめる範囲が頼るものを運ぶ。
- 取引は、最初に読むか書くかしたときのスナップショットの epoch を、確定まで名乗る (今の `Txn.planned`)。
- `Txn.reroute` は、表定義全体の epoch を比べずに、新しい範囲表を取る。表定義は取引のスナップショットのまま計画する。範囲表と表定義は独立で、表定義の遷移と移動は Meta が並べない。
- `Txn.load` は、表定義全体の epoch が変わっていても、取引を失敗させない。取引のスナップショットの epoch で畳んだ表定義 (Meta の列を、その epoch まで畳んだもの) で計画し、範囲表はいまのものを使う。baton は、今と同じく、その epoch を運ぶ。
- 書き込み禁止で待つ (`TableLocked`) 文は、表定義全体の epoch が進むまでではなく、禁止を掛けた遷移が閉じる (commit か abort が記録される) まで待つ (`Db.schemaMovedPast`)。commit だけで進める形では、abort の後に epoch が進まないからである。
- 表 X の行のロックを持つ取引の文か `COMMIT` が、X の書き込み禁止で断られたら、Worker は、断ったシャードを、取引がロックを持つシャードに数え (上の「シャード」の、禁止に当たったロックを持つ取引)、Meta に、その遷移を取り消させる (`abort`。開いていれば記録される)。その後、禁止が解けるのを待つ。
- 取り消させる手の `abort` は、理由に、ロックを持つ取引が書き込み禁止に当たったことを記録する (ほかの abort の理由と見分けられる形で)。
- DDL を進める側 (`Db.changeSchema`) は、DDL を始めた時刻から 5 秒を、DDL の待ちの期限にする (busy_timeout と同じ)。遷移ごとの期限 (lease。5 秒ごとに延ばし、prepare から 5 分まで) とは別のもので、進める側が持つ。遷移が abort され、その理由が取り消させる手のもの (`commit` の断りか、`prepared` の ok でない答えで知る) なら、待ちの期限のうちに、同じ DDL を新しい遷移でやり直す。新しい遷移は、新しい epoch の prepare を記録し (新しい lease が付く)、全部のシャードの ok を集め直す (取り消された遷移の ok は使わない)。待ちの期限は数え直さない。待ちの期限が来たとき、まだ prepare を適用していない (ロックを待つ) シャードがあれば、開いている遷移を取り消し、DDL は `SQLITE_BUSY` で失敗する。全部のシャードが prepare を適用した後の仕事 (index の行の走査など) は、今と同じく lease の下で進み、待ちの期限では止めない (その後は、ロックを持つ取引が新しく現れないので、取り消させる手も起きない)。行の確かめ (CHECK の試し、UNIQUE の重複) や DROP の確かめで abort された遷移と、lease の期限切れで abort された遷移は、やり直さない (今と同じく、その理由で失敗する)。
- 何もしていない取引の最初の文が `stale schema` で断られたら、新しいスナップショットで計画し直す (今の `Txn.rebase` と同じ)。

### 触った表の DDL と SQLite

取引が頼る表 X を、ほかの接続の DDL が変えるときの扱いを、SQLite (WAL、busy_timeout 5 秒) と比べた。

| 取引の状態 | SQLite | D∞ にできること |
|---|---|---|
| X に書いた (行ロックを持つ) | DDL が、取引の書き込みのロックを待つ。busy_timeout を過ぎれば、DDL が `SQLITE_BUSY` で失敗する。取引は失敗しない | (a) prepare が、X の行のロックを持つ取引を待つ。できる。シャードは、自分の行のロックと intent を、表ごとに知っている |
| X を読んだだけで、後で X を読む | 古い表定義と古い行のまま読み続ける。`COMMIT` も通る | (b) 古い表定義のまま答える。できるのは、シャードが今の表で古い計画に同じ答えを返せる DDL だけである。index の DDL (読みの epoch を進めないもの) がそれに当たる。列を足す、名前を変える、表を消す DDL の後は、古い時刻の行を新しい形の表に読み戻せず、古い名前の表もない。シャードは、開いている読むだけの取引を知らないので、そのために古い表を残しておくこともできない |
| X を読んだだけで、後で X に書く | 書くときに `SQLITE_BUSY` (スナップショットが古い。ほかの接続の確定があれば、DDL でなくても) | (c) 再試行できる競合 (`SQLITE_BUSY`)。いつでもできる。今の扱いを、表ごとにしたもの |
| X にまだ触っていない | 初めて X を読む文は、取引のスナップショットの古い表定義で答える | (b) と同じ。index の DDL の後は答え、ほかは (c) |

推奨は、(a) をロックを持つ取引に、(b) を index の DDL に、残りに (c) を使う組み合わせである。
SQLite とまだ違うのは、次の 3 つだけである (4 は、やり直しを入れて、違いでなくなった)。

1. 読むだけの取引が、触った表か初めて触る表を、ほかの接続の DDL (列を足す、名前を変える、表を消す、シャード内の UNIQUE index か、式か WHERE のある index を作る) の確定の後で読むと、その文が `SQLITE_BUSY` になる。SQLite は古いスナップショットで答える。
2. 行ロックは、取引が 7.5 秒文を実行しなければ切れる (Worker が落ちたときのため)。その後は DDL が待たずに進み、取引のその表への次の文か `COMMIT` が `SQLITE_BUSY` になる。SQLite の書き込みのロックは、`COMMIT` まで切れない。ロックの寿命は取引のもので、切れるかどうかは、行の置き場所に依らない ([design-lock-lease.md](./design-lock-lease.md)。2026-11-17 に実装した。それまでは、TTL がシャードごとで、そのシャードで文を実行しないまま 5 秒経つと切れた)。
3. 楽観の取引は、`COMMIT` まで行ロックを持たないので、DDL を待たせない。`COMMIT` が `SQLITE_BUSY` になる。楽観なのは、Worker の中から使う `Db.begin()` と `Db.transaction(fn)`、それを使う D1 互換の `batch` (`Db.batch`) である。`transaction(fn)` と `batch` は、自分でやり直すので、利用者には見えない。悲観なのは、SQL の `BEGIN` (`Db.control` が `pessimistic` にする)、それを使う Hrana の取引と baton、Service Binding の `begin()` (`BEGIN IMMEDIATE` か `BEGIN` を送る。`src/entrypoint.ts`) で、これらには当たらない。
4. (違いでなくなったもの) 書いた取引が、別のシャードで X の書き込み禁止に当たったときは、DDL を取り消させる (上の「Worker」の、遷移を取り消させる手)。やり直しを入れる前の形では、DDL はそこで `SQLITE_BUSY` で失敗した。取引の行が 1 つのシャードにあれば、DDL は 5 秒まで待ち、その間に取引が確定すれば通るので、成否が行の置き場所で決まり、規則 4 に反した (`m24_retry_red_no_retry` が `asSqlite` を破り、同じ形で行を 1 つのシャードに置いた `m24_retry_no_retry_same` は緑)。
   決めた形では、DDL を進める側が、取り消された DDL を、DDL を始めたときの 5 秒の中で、新しい epoch の prepare でやり直す。禁止に当たったシャードは、断るときに、その行のロックを取引に与えるので、やり直しの prepare は、そのシャードでも取引を待つ。DDL の成否は、取引が 5 秒のうちに確定するか取り消すかだけで決まり、行の置き場所に依らない (`m24_retry_green` の `asSqlite`)。取引の文は、取り消しの往復 (Meta への abort と、シャードがその abort を適用するまで) だけ待つ。時刻をまたいでは待たない (`holderNotDelayed`)。

(a) の待ちを入れないと、書いた取引の `COMMIT` が、DDL の後で古い計画として断られる (`m24_lock_red_no_wait`、`m24_retry_red_no_wait`)。
取り消させる手を入れないと、取引が P に行ロックを持ったまま Q の書き込み禁止で待つ間に、P のロックが切れて DDL が確定し、取引が断られる (`m24_lock_red_no_wound`)。
P のロックの TTL は、Q で待っている間は延びないからである。
TTL がなくても、取引の文が DDL の期限まで待ち、その間 DDL も取引のロックを待つ (`m24_retry_red_no_wound` が `holderNotDelayed` を破る)。

取り消しの後でやり直すだけでは足りない。
禁止に当たったシャードが取引にロックを与えないと、そのシャードが、取引の書き込みより先に、やり直しの prepare を適用し得る。
取引はまた禁止に当たり、取り消しとやり直しが繰り返す (`m24_retry_red_no_hold`。`noReblock` と、活性の `ddlTerminates` を破る)。
実際の時刻では、繰り返しが期限まで続いて DDL が `SQLITE_BUSY` で失敗し、取引の書き込みはそれまで待つ。行が 1 つのシャードにあれば起きないので、これも置き場所で決まる失敗である。
やり直すたびに待ちの期限を数え直すと、DDL は 5 秒を過ぎても終わらず、SQLite なら `SQLITE_BUSY` になる DDL が確定する (`m24_retry_red_restart`)。
取り消された遷移の prepare の epoch と ok を使ってやり直すと、取引の書き込みより前のシャードの ok が、やり直しの commit に数えられ、シャードの確かめ (CHECK の試し、index の行の走査) が、DDL の確定する行を全部は見ない (`m24_retry_red_same_epoch`。`checkSawRows` を破る)。

### 決めたこと 6 を改める

表ごとの epoch は、commit だけで進める。
理由は 3 つある。

1. 失敗した DDL は、触った表の取引も古くしない。SQLite では、失敗した DDL は何も変えない。prepare でも進めると、失敗した B の DDL が、B を読んだ取引を断る (`m24_red_prepare_advances`。`noRefusalWithoutChange` を破る)。
2. 書き込みは、prepare から終わりまで、書き込み禁止が止める。prepare より前に計画した書き込みは、禁止の間は待ち、abort の後はそのまま通り、commit の後は古い計画として断られる (`m24_green_check` の `witnessAcrossFailedTouched`)。
3. M21 の不変条件 (`noServeBelowAck` を除く) は、M21 の全部の場面で、commit だけで進める形でも成り立つ (`specs/m24b_m21_commit_only.qnt` の緑)。M21 の赤 28 個 (35 本) は、2 本を除いて、同じ不変条件を破る。除いた 2 本は、下の「移動の途中の prepare」である。`noServeBelowAck` は、この形では定義から成り立たない。

この形で要るものは 2 つで、上の表に入れた。遷移の仕事の要求が prepare の epoch を別に運ぶこと、書き込み禁止で待つ文が遷移が閉じるまで待つことである。

#### 移動の途中の prepare

commit だけで進める形で M21 の赤を流し直すと、`m21_red_ddl_during_move` (移動の途中に prepare を記録する) と `m21_red_end_early` (子が受け取り終える前に move-end を記録し、その後で prepare を記録する) の `servable` に、反例がなくなった (565,944 と 367,636 状態)。
段 3 の形では、prepare が表定義の epoch を進めるので、その epoch で計画した要求を、prepare を適用できない移動の途中のシャードが断った。
commit だけで進める形では、prepare はどの epoch も進めず、要求は prepare の適用を待たない。
commit は、移動の途中のシャードが prepare を適用して ok と答えるまで記録されないので、DDL は移動が終わるまで待つだけになる。
逆向き (遷移が開いている間に移動を始める、`m21_red_move_during_ddl`) は、この形でも破れる。移動の前に ok と答えたシャードの分で commit が記録でき、それを移動の途中のシャードが適用できず、最新の要求を断るからである。

それでも、Meta の `ddl-waits-move` (移動の間は prepare を記録しない) と、子が受け取り終えてから move-end を記録することは残す。
移動の途中に prepare を記録すると、移動していないシャードが prepare を適用して表への書き込みを止め、その禁止が移動の終わりまで (長い移動では、遷移の期限の 5 分まで) 続くからである。
2 つは、この形では、M21 の場面 (移動は 1 回) では、安全のためではなく、書き込みが止まる時間のための条件になる。
適用されていない prepare の後ろで 2 つ目の移動が始まる形は、モデルにないので、2 つの条件を外してよい、という結果ではない。
段 4 で、`m21_red_ddl_during_move` と `m21_red_end_early` の再生を書くときは、`servable` ではなく、この形 (禁止が移動の終わりまで続く) を確かめるか、D の行にする。これは、決めたこと 6 を改めるときに決める。

### 取引の中の DDL (M13)

M13 の規則 (DDL の前に取引を確定する、取引は版を名乗り続ける、断られた区切りだけをやり直す、確定に失敗したら DDL を実行しない) は変えない。
`m24_boundary_*` は、M13 の本体に、ほかの接続の DDL が区切りの表に触るか、を足したもので、表ごとに比べても `boundarySafe` が成り立ち、M13 の赤 5 つが同じ不変条件を破り、関係のない DDL が区切りの途中に入っても、区切りがやり直されないこと (`witnessUnrelatedNoRetry`) を確かめた。
表定義全体の版と比べると、関係のない DDL の後で区切りがやり直しになる (`m24_boundary_red_global`)。

### モデル (M24)

M24 は M21 の本体を写し、表定義のものを 4 つ (表 A、A の上の view V、別の表 B、まだない表 N) にして、DDL を 2 つ (`CREATE TABLE N`、B の行で失敗し得る DDL) 足したものである。
M21 の設計の条件は、設計どおりに固定した。新しい条件を定数にし、赤はそれを 1 つずつ外す。
床、行ロック、取引の中の DDL は、小さなモデル (`m24_floor_*`、`m24_lock_*`、`m24_boundary_*`) で確かめた。
取り消させた DDL のやり直しは、`m24_lock` に時刻と行の置き場所と進める側のやり直しを足した `m24_retry_*` で確かめた (下の表の後)。
決めたこと 6 は、M21 の本体を、M21 のインスタンスと同じ定数で、epoch を commit だけで進める形にして確かめ直した (`specs/m24b_m21_commit_only.qnt` の `m24_m21_*`。M21 を読み込むので、M24 の検査のたびに読まないよう、ファイルを分けた。M21 のファイルは、`test/catalog-m21.test.ts` が sha256 を確かめているので変えない)。

| 条件 | 外したときの赤 | 破れる不変条件 |
|---|---|---|
| ものごとに比べる (`PER_TABLE`) | `m24_red_global` (段 3 の形)、`m24_red_global_commit_only` (commit だけで進めても、全体の epoch 1 つのまま) | `noRefusalUnrelated` |
| commit だけで進める (`SCHEMA_ON_PREPARE`) | `m24_red_prepare_advances` | `noRefusalWithoutChange` |
| view を通る計画は元の表にも頼る (`EXPAND_VIEW`) | `m24_red_view` | `readConsistent`、`planMatches` |
| index の DDL は、その表の書き込みの epoch を進める (`INDEX_ON_TABLE`) | `m24_red_index` | `indexMatches`、`planMatches` |
| 書き込みは書き込みの epoch を比べる (`WRITE_EPOCH`) | `m24_red_write_epoch` | `indexMatches` |
| 書き込みの計画は、読んだ表にも頼る (`READ_DEPS`) | `m24_red_read_deps` | `planMatches` |
| 記録の適用中は、変わるものに頼る要求を待たせ、ほかは通す (`APPLY_REFUSES`) | `m24_red_apply_all` (段 3 の形)、`m24_red_apply_touched` (変わるものに頼る要求を断る) | `noRefusalUnrelated`、`noRefusalWithoutChange` |
| 床を表ごとに持つ | `m24_floor_red_global` | `noRefusalUnrelated` |
| 読み戻すのは読む表の行だけ | `m24_floor_red_restore_all` | `noRefusalUnrelated` |
| 形を変えた表には床を置く | `m24_floor_red_no_floor` | `noRestoreAcross` |
| prepare は行ロックを待つ | `m24_lock_red_no_wait`、`m24_retry_red_no_wait` | `holderSurvives` |
| 書き込み禁止に当たった、ロックを持つ取引は、遷移を取り消させる | `m24_lock_red_no_wound`、`m24_retry_red_no_wound` | `holderSurvives`、`holderNotDelayed` |
| 禁止に当たったシャードは、ロックを持つ取引に、その行のロックを与える (`HOLD`) | `m24_retry_red_no_hold` | `noReblock`、活性 `ddlTerminates` |
| 進める側は、取り消された DDL をやり直す (`RETRY`) | `m24_retry_red_no_retry` (やり直しを入れる前の形) | `asSqlite` |
| やり直しも、DDL を始めたときの 5 秒の中で行う (`KEEP_BUDGET`) | `m24_retry_red_restart` | `asSqlite` |
| やり直しは、新しい epoch の prepare を記録し、ok を集め直す (`FRESH_EPOCH`) | `m24_retry_red_same_epoch` | `checkSawRows` |
| ほかの接続の DDL と比べるのは、区切りの表に触ったものだけ | `m24_boundary_red_global` | `noRefusalUnrelated` |

新しい不変条件は 3 つで、M21 の `noServeBelowAck` と `pinned` と `pinnedSurvives` を、ものごとに言い直したものである。

- `planMatches`: シャードが要求を受け付けるとき、要求が本当に頼るどのものの表定義も、計画のときと同じである。
- `noRefusalUnrelated`: 頼るものに触る表定義の記録 (prepare、commit、abort のどれでも) が計画の後にないのに、持ち主が版の理由で断ることはない。「表 A の取引は、表 B の DDL で断られない」である。
- `noRefusalWithoutChange`: 頼るものの表定義が計画の後に変わっていない (確定した DDL がない) のに、持ち主が版の理由で断ることはない。失敗した DDL は、触った表の取引も断らない。

witness は、取引が、計画の後の関係のない `CREATE TABLE` の commit と、関係のない DDL の abort の両方を適用したシャードで受け付けられ、確定すること (`witnessAcrossUnrelated`) を含む。
同じ witness は、段 3 の形 (`m24_red_global`) と、全体の epoch を commit だけで進める形 (`m24_red_global_commit_only`) では届かない (緑として確かめた)。

`m24_retry` は、表 X の行 x1 と x2 (置き場所は、シャード P と Q の 4 通りを init が選ぶ)、悲観の取引 1 件 (x1 を書き、x2 を書き、`COMMIT` する)、X の DDL 1 回のモデルで、時刻を刻みで数える (期限は 2 刻み、時刻は 0〜4)。
刻みは、内部の手 (シャードの適用と ok、進める側の commit とやり直しと期限、禁止に当たったロックと取り消させる手、送られた文の実行) がどれもできないときにだけ進む。RPC が 5 秒に比べて十分に速い、という仮定である。
不変条件は 5 つと、取引が断られないこと (`holderSurvives`、`txnNotRefused`) である。

- `asSqlite`: DDL の結果は、利用者の時刻 (x1 の書き込みを送った刻み、`COMMIT` を送った刻み、DDL を始めた刻み) だけで決まり、SQLite (busy_timeout 5 秒) と同じである。DDL が `SQLITE_BUSY` になるのは、x1 を DDL より前の刻みに送り、期限の刻みまでに `COMMIT` を送らなかったときだけで、期限より前には失敗しない。そうでなければ確定する。DDL は期限までに終わる。決め方に置き場所を使わないので、どの置き場所でも結果が同じになる。同じ刻みの競り (x1 を DDL を始めた刻みに送る、`COMMIT` を期限の刻みに送る) は、SQLite でもどちらが先にロックを取るかで決まるので、両方の結果を許す。
- `holderNotDelayed`: ロックを持つ取引の文は、DDL を待って時刻をまたがない。
- `noReblock`: 取引は、同じシャードで、同じ DDL の書き込み禁止に 2 度当たらない。取り消しとやり直しの繰り返しを不変条件で捕まえる代わりの性質で、本来の性質は、時刻が上限まで進むこと (活性の `timeAdvances`) である。
- `checkSawRows`: DDL の commit が頼る ok は、どれも、そのシャードがその後で行の書き込みを受けていないものである。

witness は、競りのない時刻で、置き場所 (同じシャード、別のシャード) ごとに、DDL の確定と `SQLITE_BUSY` の 4 つである。別のシャードの確定は、取り消しとやり直しを通る (`witnessWoundRetryCommit`)。
活性 (`retryLive`) は、内部の手と刻みに弱い公平性を置いて、始めた DDL が終わること、時刻が上限まで進むこと、送られた文が答えを得ることである。送られた文の実行も弱い公平性にした。強い公平性にすると、`HOLD` のない形の繰り返しが隠れる。

確かめていないこと。

- 時刻と、読みの答えの中身。M24 の本体の読みは、確定した最新の値を答えたかだけを見る。index の DDL の後で古い計画の読みに答えてよいことは、読みが index を使わないという、計画と範囲のコードを読んだ結果に依る (上の「規則」)。モデルはそれを前提にしている。
- 名前の作り直し (DROP の後の CREATE、RENAME)。名前で引き、消した名前も epoch を持ち続ければ、古い計画は古い epoch を運ぶので断られる。モデルの DROP は消すところまでである。
- 2PC の取引 (anchor から参加者への prepare)。M24 の取引は 1 シャードである。参加者への prepare も、その参加者の書き込みと範囲が頼るものを運ぶ。
- 取引が 2 つ以上の表に書く形。M24 の取引は A の 1 行を書く。B は読むだけである。
- 取引 2 件の場面。M24 の場面は取引 1 件である。取引 2 件にすると、この作業の計算機では 5 分で終わらなかった。取引 2 件が index の項目を取り合う形は、M21 の場面を commit だけで進める形 (`m21_alt_commit_only_build`、`m24_m21_green_drop` など) が確かめるが、表ごとの比べ方との組み合わせは確かめていない。
- 活性。記録の適用が、ほかの表の intent のために飢えないこと (上の「シャード」の最後の段落) は、時相の性質としては確かめていない。
- 表ごとの intent の決着。モデルの取引は A にしか書かないので、B と N の記録は決着させる intent を持たない。決着を全部の表にした形との違いは、モデルには現れない。
- `INDEXED BY` で index を名指す読み。モデルの読みは index を名指さない。上の「規則」では、書き込みの epoch で頼るとした。
- 書き込み禁止の待ちの上限 (30 秒)。本体の書き込みは、禁止が解けるまで待ち続ける。実装では、30 秒を超える遷移 (行の多い表の index の作成) の間に待った書き込みは `SQLITE_BUSY` になる。今と同じで、この設計は変えない。
- `m24_retry` のロックの TTL。`m24_retry` にはロックが切れる手がない (`m24_lock` にある)。`asSqlite` は、ロックが切れない取引についての性質である。TTL はシャードごとで、そのシャードで文を実行したときだけ延びるので、ロックが切れるかどうかは、取引のほかの文がどのシャードに行くかで変わる (下の「持ち主の判断が要ること」の 6)。
- `COMMIT` が書き込み禁止に当たる形。ロックを持つシャードでは、prepare がロックを待つので、TTL がなければ起きない。`m24_retry` の `HOLD` は、x2 の書き込みが当たる形だけを持つ。上の「シャード」の規則は、`COMMIT` も同じに扱う。
- 取引 2 件以上が、順に DDL を取り消させる形。`m24_retry` の取引は 1 件で、取り消させるのは高々 1 回である。`m24_retry_red_restart` が示すのは、期限を数え直すと、DDL の結果が 5 秒を過ぎてから決まることで、限りなく延びることではない。取引が次々に来る形で限りなく延びることは、期限を数え直さないことから従う、という読みに留まる。
- 進める側が止まる形。`Db.changeSchema` を進める Worker が落ちれば、やり直す者がいない。遷移は、今と同じく、lease の 5 秒のうちに Meta の `expire` が abort する。
- `m24_retry_red_same_epoch` が持つのは、取り消された試みの ok を使い続けることだけである。シャードが同じ epoch の prepare を重複として読み飛ばす形 (禁止もロックの待ちもない) は、モデルにない。どちらも、やり直しに新しい epoch を使えば起きない。
- 行の確かめや DROP の確かめで abort された遷移をやり直さないこと。`m24_retry` の DDL は、行で失敗しない。

### 実装の一覧

規則 2 により、各項目の前に、落ちる検査を用意する。

| # | 場所 | すること | 先に落ちる検査 | 欠陥のスイッチ (赤) |
|---|---|---|---|---|
| 1 | `src/sql/ddl.ts` | `ParsedDdl` に、その DDL が変えるもの (`changes: { read: string[]; write: string[]; views: string[] }`) を足す。上の「規則」の表のとおりに決める | 表の DDL の一覧ごとに、変えるものを確かめる試験 | |
| 2 | `src/catalog.ts` | `Snapshot` に、ものごとの epoch (`objects: Record<name, { read, write }>`、view は `views` の epoch) を足し、`fold` が commit で進める。消した名前も残す。`Snapshot.schema` は commit だけで進める (Meta の `basedOn` と Worker のキャッシュに残す) | `fold` の試験 (CREATE、DROP、作り直し、RENAME、index、view、abort では進まない) | `epochOnPrepare` (`m24_red_prepare_advances`) |
| 3 | 要求の型 (`ExecReq`、`PrepareReq`、`CommitReq`、anchor から参加者への prepare、`refresh`、`unchanged`) | `schema` を `deps: { name; epoch; write? }[]` に替える。遷移の仕事の要求は `atLeast` を運ぶ。`PROTOCOL_VERSION` を上げる | | |
| 4 | Worker の計画 (`src/client/db.ts`、`src/sql/plan.ts`) | 文ごとに頼るものを集める。開く表は `Db.tablesOf` の表 (view の元の表を含む)、名指す view、書く表は書き込みの epoch | 関係のない表の `CREATE TABLE`、失敗した DDL、確定した DDL の後で、取引の文と `COMMIT` が通る試験 (今は落ちる) | `globalSchemaEpoch` (`m24_red_global`)、`viewDepsOnly` (`m24_red_view`)、`indexAsObject` (`m24_red_index`)、`writeDepsOnlyWritten` (`m24_red_read_deps`) |
| 5 | シャードの `schemaStep` と `enter` | 頼るものごとに比べ、待ちの後も比べ直す。書き込みは書き込みの epoch と比べる | 同じ表の DDL の後で古い計画が断られる試験 (今の `stale-plan-after-wait`、`epoch-requests` を、ものごとに書き直す) | `writeComparesRead` (`m24_red_write_epoch`)。`noSchemaRecheck` は残す |
| 6 | シャードの記録の適用 (`applyStep`、`settleAllStep`、`schemaChanging`) | 決着させる intent を、記録が変える表のものに絞る。適用中は、変わるものに頼る要求を待たせ、ほかは通す | 別の表の記録を適用しているシャードへの取引の文が通る試験 (今は `not owner: stale schema` で落ちる) | `applyRefusesAll` (`m24_red_apply_all`)、`applyRefusesTouched` (`m24_red_apply_touched`) |
| 7 | シャードの床 (`ddlFloor`、`deltaAfter`、`refresh`、`predicateChanged`) | 表ごとの床。読む表の行だけを読み戻す | 別の表の DDL の後で、取引の 2 文目 (古い T の読み戻し)、refresh、述語の検証が通る試験 (今は `read too old` か競合で落ちる) | `globalDdlFloor` (`m24_floor_red_global`)、`restoreAllTables` (`m24_floor_red_restore_all`)、`noFloorOnChange` (`m24_floor_red_no_floor`) |
| 8 | Worker の取引 (`Txn.reroute`、`Txn.load`、`Db.schemaMovedPast`) | 範囲表だけを取り替える。baton は、取引のスナップショットの epoch で畳んだ表定義で組み立て直す。書き込み禁止の待ちは、遷移が閉じるまで | baton の取引と `Db.begin()` の取引が、関係のない DDL と分割をまたいで確定する試験 (今は `the schema changed while the transaction was open` で落ちる) | `doomOnSchemaChange` (`m24_red_global` の Worker の側。モデルの取引は組み立て直さないので、赤はない) |
| 9 | シャードの prepare の適用 | fence の表の行のロックがある間は適用しない。DDL の期限 (prepare の記録が運ぶ) で `prepared` に ok でないと答える | 悲観の取引が行を書いた表への `ALTER TABLE` が、取引の `COMMIT` の後で通るか、`SQLITE_BUSY` で失敗する試験 (今は取引の `COMMIT` が落ちる) | `prepareIgnoresLocks` (`m24_lock_red_no_wait`、`m24_retry_red_no_wait`) |
| 10 | Worker の取引、シャードの書き込み禁止、DDL を進める側 (`src/client/db.ts` の DDL の経路) | 取引の側: ロックを持つ表の書き込み禁止に当たったら、断ったシャードをロックを持つシャードに数え、Meta に遷移を取り消させる (abort の理由に、取り消させる手であることを記録する)。シャードの側: ロックを持つ取引の文を禁止で断るときに、その行のロックを取引に与える。進める側 (`Db.changeSchema`): DDL を始めた時刻から 5 秒を待ちの期限にし (遷移の lease とは別)、取り消させる手の理由で abort された遷移を、待ちの期限のうちなら新しい遷移 (新しい epoch の prepare。ok は集め直す) でやり直す。待ちの期限は数え直さない。待ちの期限が来たとき、prepare を適用していないシャードがあれば、開いている遷移を取り消して `SQLITE_BUSY` を返す | 2 つのシャードに書く悲観の取引の 2 つ目の書き込みが、DDL の書き込み禁止に当たる試験を、行を 1 つのシャードに置いた同じ試験と並べ、取引が 5 秒のうちに確定すれば、どちらでも DDL が確定し、取引の書き込みが 5 秒を待たないこと。取引が 5 秒を過ぎてもロックを持てば、どちらでも DDL が 5 秒で (それより前でなく) `SQLITE_BUSY` になること | `noWound` (`m24_lock_red_no_wound`、`m24_retry_red_no_wound`)、`noRetryAfterWound` (`m24_retry_red_no_retry`)、`noLockAtFence` (`m24_retry_red_no_hold`)、`retryRestartsBudget` (`m24_retry_red_restart`)、`retrySameEpoch` (`m24_retry_red_same_epoch`) |
| 11 | `docs/model-coverage.md`、`specs/README.md` | M24 の赤の行を、項目ごとに P から A に移す | | |

決めたこと 6 の変更 (2 のうち commit だけで進めること) は、3 のうち `atLeast` と、8 のうち `Db.schemaMovedPast` と一緒になら、先に入れてよい。
それだけで、失敗した DDL は取引を古くしなくなる。ただし、表定義全体の epoch のままなので、確定した DDL は、関係のない表のものでも、全部の取引を古くし続ける (`m24_red_global_commit_only`)。
その後に、1、2 の残り、3、4、5 を一緒に入れる (運ぶものと比べるものは、片方だけでは意味がない)。
6、7、8 の残りは、それぞれ独立に入れられる。9 と 10 は一緒に入れる。
10 の 3 つの側 (取り消させる手、禁止に当たったロック、やり直し) も一緒に入れる。取り消させる手だけを入れると、DDL の成否が行の置き場所で決まり (`m24_retry_red_no_retry`)、やり直しをロックなしで入れると、取り消しとやり直しが期限まで繰り返す (`m24_retry_red_no_hold`)。

### 実装の後の `docs/sql-language.md`

「取引の中の DDL」の最後の段落と、「DDL」の「DDL は、開いている取引を 2 度古くする」の段落は、実装の後で次のようになる。
文書は、実装が入るまで今のまま (段 3 の挙動) にしておく。

> 取引が最初に読むか書くかした後で、別の接続が表定義を変えても、取引は最初の表定義のまま続く。
> 後から作られた表は見えない (`no such table`)。SQLite で、読み始めた取引から、後で作られた表が見えないのと同じである。
> 別の接続の DDL が取引を古くするのは、その DDL が、取引の文が頼る表 (読む表、書く表、view の元の表) を変えて確定したときだけである。
> 別の表の DDL、新しい表を作る DDL、失敗した DDL は、取引を古くしない。
> DDL が書き込みを止めている間 (下の「DDL」)、その表への書き込みは待つ。DDL が失敗すれば、待った書き込みはそのまま通る。
> 頼る表を変えた DDL が確定した後では、その表を読む文と書く文、その表を読んだか書いた取引の `COMMIT` が、`SQLITE_BUSY` で断られる。取引をやり直す。
> ただし、index を作るか消すだけの DDL (一意でない列の `CREATE INDEX`、shard key を含まない列への `CREATE UNIQUE INDEX`、`DROP INDEX`) の後は、その表を読む文と、その表を読んだだけの取引の `COMMIT` は通る。書く文 (と `INDEXED BY` でその表の index を名指す文) と、書いた取引の `COMMIT` は断られる。
> 取引が表の行を書いて行ロックを持っている間は、その表の DDL のほうが待つ。
> DDL が待つのは、DDL を始めてから 5 秒までである。取引がそのうちに確定するか取り消せば、DDL は通る。5 秒を過ぎても取引がロックを持っていれば、DDL が `SQLITE_BUSY` で失敗する。
> 取引の、その後の文と `COMMIT` は、DDL を待たない。取引の行がどのシャードにあっても、結果は同じである。
> SQLite で、書いた取引が書き込みのロックを持つ間、ほかの接続の DDL が busy_timeout (5 秒) まで待つのと同じである。
>
> SQLite と違うのは、次の 3 つである。
>
> - 読むだけの取引は、SQLite では、ほかの接続の DDL の後も、古い表定義と古い行のまま読み続けられる。この DB では、列を足す、名前を変える、表を消す、シャード内の UNIQUE index か、式か WHERE のある index を作る DDL が確定した後で、その表を読む文が `SQLITE_BUSY` になる。その取引で初めて読む表でも同じである。
> - 行ロックは、そのシャードで文を実行しないまま 5 秒経つと切れる。その後は DDL が待たずに進み、取引のその表への次の文か `COMMIT` が `SQLITE_BUSY` になる。
> - Worker の中から使う `Db` の `begin()` と `transaction(fn)` の取引は、`COMMIT` まで行ロックを持たないので、DDL を待たせない。`COMMIT` が `SQLITE_BUSY` になる (`transaction(fn)` と、それを使う D1 互換の `batch` は、自分でやり直す)。

> DDL が取引を古くするのは、確定したときだけで、古くなるのは、その DDL が変えた表に頼る取引だけである (`docs/design-catalog-epoch.md` の「表ごとの epoch」)。
> 失敗した DDL と、ほかの表の DDL は、取引を古くしない。

### 持ち主の判断が要ること

1. **触った表の扱い**。推奨は上の組み合わせ ((a) ロックを持つ取引には DDL を待たせる、(b) index の DDL の後も読みは通す、ほかは (c))。(a) を入れず (c) だけにすると、仕組みは小さい (9 と 10 がなくなる) が、ORM の移行 (列を足す) と並行して書いている取引の `COMMIT` が `SQLITE_BUSY` になる。SQLite では DDL のほうが待つ。
2. **読みの epoch と書き込みの epoch を分けること**。分けなければ (表に epoch 1 つ)、index を足す移行の間、その表を読むだけの取引も `SQLITE_BUSY` になる。分ける費用は、epoch が 2 つになることと、index の種類で読みの epoch を進めるかを決める表 (上の「規則」) を保つことである。推奨は分ける側である。
3. **行ロックの TTL**。SQLite との違いの 2 つ目 (5 秒文を実行しない取引の行ロックが切れる) は、表ごとの epoch とは別の、今からある違いである。この設計は変えない (ただし 6)。
4. **取り消させた DDL のやり直し** (2026-11-16 に `m24_retry` で確かめた)。書いた取引が別のシャードで書き込み禁止に当たったとき DDL を取り消させる手は、それだけでは、DDL の成否を取引の行の置き場所で変える (上の「触った表の DDL と SQLite」の 4)。進める側が、取り消された DDL を、DDL を始めたときの 5 秒の中で、新しい epoch の prepare でやり直す形にした。
   やり直すだけでは足りなかった。禁止に当たったシャードが、ロックを持つ取引にその行のロックを与えないと、やり直しの prepare が取引の書き込みより先に適用され得て、取り消しとやり直しが期限まで繰り返す (`m24_retry_red_no_hold`)。推奨は、このロックを与える形 (`HOLD`) である。シャードは、断るときに、要求の取引と行を知っているので、今の行ロックの仕組みで済み、やり直しの prepare は、ほかのロックと同じく、そのロックを待つ。代わりは、進める側が、取り消させた取引が終わるのを待ってからやり直す形である。これは、進める側が取引の終わりを知る新しい経路 (取引の状態を尋ねるか、取引の Worker から知らせる) を要するので、推奨しない。
5. **段 4 の再生**。決めたこと 6 を commit だけで進める形に改めると、`m21_red_ddl_during_move` と `m21_red_end_early` の今の形 (`servable`) は、反例でなくなる (上の「移動の途中の prepare」)。段 4 でこの 2 つの再生を書くなら、その前に、決めたこと 6 をどちらにするかを決める。
6. **行ロックの TTL がシャードごとであること** (規則 4)。TTL は、そのシャードで文を実行したときだけ延びる。行が 1 つのシャードにある取引は、どの文でもロックを延ばすが、行が 2 つのシャードにある取引は、その後の文が行かないシャードのロックを 5 秒で失う。そのため、取引がロックを失うか (その後は DDL が待たずに進み、取引のその表への次の文か `COMMIT` が `SQLITE_BUSY` になる) が、行の置き場所で決まる。3 で変えないとした違いのうち、この置き場所に依る部分は、規則 4 に触れる。推奨は、ロックの寿命を、シャードごとではなく取引ごとにする形 (取引のどの文でも、取引の全部のロックが延びる) である。切れるかどうかが、利用者が取引を放っておいた時間だけで決まるからである。`m24_retry` にはロックの TTL がない。2026-11-16 に、取引ごとのロックの寿命をモデル M25 (`specs/m25_txn_lock_lease.qnt`) で確かめ、[design-lock-lease.md](./design-lock-lease.md) に設計を書いた (要求が取引の貸し出しを運び、R = 2.5 秒。任された範囲で決めた)。2026-11-17 に、表ごとの epoch と一緒に実装した。

### 表ごとの epoch の実装の結果 (2026-11-17)

実装の一覧の 1 から 10 を入れた。11 は `docs/model-coverage.md` だけを直した (`specs/README.md` は、この作業の間、別の作業が書いていた)。
通信の版は 10、保存の形式は 7 である (`docs/storage-format.md`)。
行ロックの寿命 (M25) も、同じ変更に入れた ([design-lock-lease.md](./design-lock-lease.md) の「実装の結果」)。

#### 要求が運ぶものと、シャードが確かめること

| 要求 | 運ぶもの |
|---|---|
| `exec`、`execAuto` (`ExecReq`) | `deps` (頼るものごとの `{ name, epoch, write? }`)、`epoch` (Worker のスナップショットの epoch)、遷移の仕事の要求だけ `atLeast` (prepare の epoch) |
| `commitLocal`、`prepare` (`PrepareReq`) | `deps`、`epoch` |
| `commit` (`CommitReq`) | 参加者ごとの `deps` (`Participant.deps`)、`epoch`。anchor は、参加者への `prepare` に、その参加者の `deps` を載せる |
| `refresh` | `deps` (取引がそのシャードで読んだ範囲の表と view。anchor から参加者への確かめは、参加者の `deps`) |
| `unchanged` | `atLeast` |
| `syncSchema` | `atLeast` (その epoch まで、表定義の記録も範囲の記録も適用する) |
| `prepared` | `epoch` (今までどおり) |

- Worker は、`deps` を `depsOf` (`src/client/db.ts`) の 1 か所で作る。要求の範囲が名指す表は読みの epoch、要求が書く表と `INDEXED BY` の表は書き込みの epoch、文が名指す view は view の epoch である。epoch は、要求を計画したスナップショットの `Catalog.objects` から引く。
- 文が頼る view は、Worker の SQLite に尋ねる (`ScratchDb.viewsUsed`)。view を 1 つ消してみて、文を用意できなくなれば、文はその view に頼っている。view のない表定義では、何も実行しない。
- 取引は、シャードごとに、文が名指した view を覚え (`Txn.views`)、`COMMIT` の参加者の `deps` に足す。baton にも載せる。
- シャードは、`schemaStep` で `deps` を自分のスナップショットの `objects` と比べる (`epochOf`)。要求のほうが古いものが 1 つでもあれば `not owner: stale schema: <名前> …` で断り、新しいものがあれば、列をその epoch まで適用して比べ直す。待ちの後は、`enter` が、どのものも等しいことを確かめ直す。
- 書く表が、シャードのスナップショットで書き込み禁止で、要求の `epoch` がシャードの epoch より新しければ、シャードは列を適用してから進む。abort は、どのものの epoch も進めないので、禁止を解く記録を適用させるのは、遷移が閉じたと知った Worker の要求である (進める側が止まった後でも、禁止が解ける。`test/ddl-driver-stops.test.ts`)。

#### 実装の一覧との対応

| # | 結果 |
|---|---|
| 1 | 入れた。`ParsedDdl.changes` (`read`、`write`、`views`)。内部の表 (`__gidx_<index>`) も、作るとき (`CREATE TABLE` の UNIQUE) と消すときに `read` に入る |
| 2 | 入れた。`Snapshot.objects` (鍵は小文字の名前)。表定義の全体を表す `"*"` も持つ (epoch は `Snapshot.schema`)。どの表を読むか分からない範囲と、欠陥のスイッチ `globalSchemaEpoch` が頼る |
| 3 | 入れた。`refresh` も `deps` を運ぶ。シャードは、`deps` が自分の epoch と違えば、確かめを断る (下の「床の値」)。変えた点: `syncSchema` は `{ atLeast }` だけを受ける。`unchanged` は `deps` を運ばない (下の「設計の本文からずれたところ」) |
| 4 | 入れた。変えた点: view は構文からではなく SQLite に尋ねる (上)。`indexAsObject` は、Worker ではなく、畳み込みのスイッチにした (index の DDL が表の書き込みの epoch を進めない形)。文に付けて送る、取引の溜めた書き込み (overlay) を、文の範囲が名指す表のものだけにした (下の「見つけて直したもの」) |
| 5 | 入れた。`test/epoch-requests.test.ts` を、ものごとに書き直した |
| 6 | 入れた。変えた点: 待たせるのは、新しい文 (`exec`、`execAuto`) だけである。確定の途中の要求 (`commitLocal`、`prepare`、`commit`) は通す。通すと、その intent も、適用が決着を待つ。待たせると、2 つのシャードの適用と、2 つの取引の prepare が、互いを待つ輪になり、決着の待ちの期限 (5 秒) まで解けない |
| 7 | 入れた。`tableFloors` (保存は `__meta` の `ddl_floors`)。古い時刻の読みが読み戻すのは、範囲の表の行だけで、行の数の上限 K も、その表の分だけを数える。変えた点: 床の値は、適用した時刻ではなく、変更ログにあるその表の確定の時刻の最大である (下の「床の値」) |
| 8 | 入れた。`Txn.reroute` と `Txn.follow` は範囲表だけを取り替える。`Txn.load` は `Cluster.catalogAt(schema)` (Meta の列を、その epoch まで畳んだ表定義と、いまの範囲表) で組み立て直す。`Db.transitionClosed` は、禁止を掛けた遷移が閉じるのを待つ。読むか書くかした取引も、待ってから同じ文を送り直す |
| 9 | 入れた。prepare の記録が `waitUntil` (進める側の時計の時刻) を運ぶ。シャードは、fence の表に行ロックがある間、10 ms ごとに見直し、50 ms から 400 ms の間隔で Meta の列を取り直して、遷移が閉じたかを確かめる。待つ間、要求は通す。`waitUntil` のない prepare は、行ロックがあれば、待たずに断る |
| 10 | 書き込みの文が当たる形を入れた。取引は、行ロックを取った表を覚え (`Txn.lockTables`)、ロックを取る要求に載せる (`LockOwner.holds`)。シャードは、断るときに、文が書こうとした行のロックを与え、与えた印を誤りに付ける。Worker は、Meta に、取り消させる印を付けた abort を記録させ、取引の範囲表と epoch を取り直して、文を送り直す。進める側は、その印の abort なら、同じ `waitUntil` のまま、新しい prepare でやり直す。変えた点: 行を集めて Worker の SQLite で実行した文は、書いた行のロックを取る要求が、書き込み禁止に当たる (文そのものは、シャードで行を書かないので)。**入れていないもの**: `COMMIT` が書き込み禁止に当たる形 (下の「見つけて直していないもの」) |
| 11 | `docs/model-coverage.md` に、M24 の 21 個の赤の行を足した。`specs/README.md` は直していない |

#### 設計の本文からずれたところ

- **DDL の待ちの期限を見るのは、シャードだけである**。進める側は、`prepared` の答えを待つ。シャードが、`waitUntil` を過ぎると、行ロックを持つ取引がいることを理由に断り、進める側は、その誤りで DDL を失敗させる (`conflict: a transaction holds row locks on table …`。Hrana では `SQLITE_BUSY`)。時刻は、進める側の時計で決め、シャードが自分の時計で比べる。時計がずれていれば、その分だけ、5 秒からずれる。
- **取り消されたことを、進める側は、シャードの答えで知る**。行ロックを待っているシャードが、Meta の列を取り直して、遷移が閉じたと知り、`prepared` に ok でないと答える (取り消しから 400 ms のうち)。進める側は、Meta に abort を頼んで、記録されていた abort が取り消させる手のものかを受け取り、やり直す。
- **書き込み禁止に当たった文は、取引がロックを持たなくても、待つ**。読むか書くかした取引の文も、遷移が閉じるのを待ち (最大 30 秒)、同じ文を送り直す。DDL が失敗していれば通り、確定していれば `stale schema` で断られる。段 3 までは、待たずに断った。
- **`COMMIT` は、書き込み禁止に当たると、断られる**。ロックが生きている悲観の取引の `COMMIT` は、禁止に当たらない (ロックを持つシャードでは、prepare がロックを待つ。シャードをまたぐ UNIQUE の index の項目のシャードは、表の禁止の対象でない。`test/ddl-waits-for-row-locks.test.ts`)。当たるのは、ロックを故障 (シャードの再起動) で失ったときと、楽観の取引である。
- **`unchanged` は `deps` を運ばない**。取引が読んだ表を消す前の確かめは、行の変更だけを見る。読んだ後に、別の接続が、その表の形だけを変えた場合 (行を書かない DDL)、確かめは通り、表は消える。消す DDL は、最新の表定義で計画するので、古い計画は実行されない。床を動かす前も、同じである (確かめは、範囲に書き込みがあったかを先に索引で見て、なければ、床を見ずに通す)。
- **失敗した DDL の誤り**。取り消させる手で取り消され、やり直せなかった DDL (待ちの期限が過ぎた) は、取り消しの理由を `conflict:` で返す。

#### 床の値

床は、最初、commit を適用したときにシャードが発行した時刻に置いた (M24 の `m24_floor` の形)。
同じ日に、モデル M23j (`specs/m23j_ddl_retained_images.qnt`。`docs/design-refresh-across-move.md` の「3 回目の実装の規則」の不変条件 E) が、床の置き場所を決めた。
床は、commit を適用したときに、そのシャードの変更ログにある、その表の確定の時刻の最大である (`m23j_exact_*`)。
その表の確定が変更ログになければ、床を置かない。

- 床以上の時刻の読みが戻す行イメージは、commit の後の形のものだけである。適用した時刻の床は、前の形の最後の確定から適用までの間の時刻の読みを、戻すものが後の形だけでも、断っていた (`m23j_always_*`。答えは誤らない)。
- 表ごとの最新の確定の時刻は、直近 write の索引 (`recent` の `t\0表`。起動のときに変更ログから作り直す) から引く。索引を捨てた後 (`pruneRecent`) は、捨てた時刻以下の確定を、変更ログから探す (`lastLogged`)。
- `RENAME TO` は、前の名前と後の名前の両方に、前の名前で記録された確定の時刻を置く。後の名前の読みは、前の名前の確定を読み戻さないので、床がなければ、T より後の値を答える。
- 床を見るのは、行を T まで戻すシャードである (自分の変更ログで戻し、自分の床を見る)。前の持ち主への尋ねが表の epoch を運ぶこと (M23j の `CHAIN_EPOCH`) は、未解決の問題 37 の 3 回目の実装で入れる。
- **refresh が `deps` を運ぶのは、このためである**。床が適用の時刻にあった間は、表の DDL をまたぐ窓の確かめを、床が断っていた。床が適用より前にあると、行の変更のない DDL をまたぐ窓は、床を通る。取引が読んだ表の DDL が確定した後で、取引が読みの時刻を進めると、取引は、DDL の前の表と、DDL の後のほかの表を見る。シャードは、確かめの `deps` が自分の epoch と違えば断り、取引は読みの時刻を進めない (決めた時刻のスナップショットで読み続ける)。

検査は `test/table-floors.test.ts` にある。スイッチは `ddlFloorAtApply` (床を適用した時刻に置く。間の時刻の読みを断る) と、`refreshIgnoresSchema` (確かめが epoch を比べない。取引が、読んだ表の DDL をまたいで読みの時刻を進める) である。
乱択の検査 `ddl-concurrent` の 7 (移動の後の `ADD COLUMN` と、移動の前に時刻を決めた読み) は、seed 1 から 120 で、`aa1eea6` では、31 に答え、87 を `read too old: moved at …` で、2 を `not owner` で断った。今は、120 のどれにも、読みの時刻を進めて答える。断っていたのは、適用した時刻に置いた床である。床を適用の時刻に戻すと (`FAULT=ddlFloorAtApply`)、同じ seed で、31 に答え、89 を `read too old` で断る。

M23j は、作り直し (`DROP TABLE` の後に、同じ名前で `CREATE TABLE`) の後の計画の読みの正しい答えを、新しい表の版だけ、と置いている。
床が適用より前にあると、まだ何も読んでいない取引は、`DROP` より前の T で、新しい表を空として読める。
DDL を直列の順に数えるかどうかは、M24 も M23j も決めていない。

#### 検査

落ちてから通る検査 (2026-11-17 までは `test/open/` にあったか、`aa1eea6` で落ちることを確かめた)。

| 検査 | 確かめること |
|---|---|
| `txn-across-ddl` | 取引 (SQL の `BEGIN`、`Db.begin()`、baton) が、関係のない `CREATE TABLE` と、失敗した DDL (関係のない表、読んだ表) をまたいで確定する。頼る表の DDL が確定した後は、その表の文と `COMMIT` だけが `SQLITE_BUSY`。index だけの DDL の後は、読みと、読んだだけの取引の `COMMIT` が通る。view を通る読み。関係のない DDL と分割をまたぐ取引。3 つの実行の形で流す (分割の場面だけは、`REFERENCE=full` では流さない。未解決の問題 37) |
| `ddl-waits-for-row-locks` | 行を書いた取引がいる表の DDL が、取引の `COMMIT` の後で確定するか、5 秒で (それより前でなく) `SQLITE_BUSY` になる。取引の文と `COMMIT` は待たない。行を 1 つのシャードに置いた場面と、2 つに置いた場面で、同じ結果。やり直しの prepare と取引の書き込みの順、やり直しが行を見直すこと。3 つの実行の形で流す |
| `apply-per-table` | 別の表の記録を適用しているシャードが、取引の文に答える。その記録の表の文は、待って、DDL が失敗すれば通る |
| `table-floors` | 別の表の DDL の後で、古い時刻の読み、読み取り時刻の前進、述語の検証が通る。形を変えた表の古い時刻の読みは断る。前の形の最後の確定から DDL の適用までの間の時刻の読みには答える。名前を変えた表は、前の名前の確定の時刻を床にする。取引は、読んだ表の DDL をまたいで、読みの時刻を進めない |
| `catalog` の 2 つ、`epoch-requests` の 3 つ | DDL ごとの変えるもの、ものごとの epoch の畳み込み、ものごとの比べ |

欠陥のスイッチは 20 個で、どれも、上の検査の場面を落とす (各ファイルの「put back」)。
畳み込み: `epochOnPrepare`、`indexAsObject`。シャード: `writeComparesRead`、`applyRefusesAll`、`applyRefusesTouched`、`globalDdlFloor`、`restoreAllTables`、`noFloorOnChange`、`ddlFloorAtApply`、`refreshIgnoresSchema`、`prepareIgnoresLocks`、`noLockAtFence`。Worker: `globalSchemaEpoch`、`viewDepsOnly`、`writeDepsOnlyWritten`、`doomOnSchemaChange`、`noWound`、`noRetryAfterWound`、`retryRestartsBudget`、`retrySameEpoch`。
対応する赤は `docs/model-coverage.md` にある。

段 4 の 3 つの再生 (`test/m21-moves.test.ts`) は、M24 の言うとおりに改めた。
`ddlDuringMove` と `endBeforeDrained` は、スイッチを入れても、最新の計画の読みに答える (`servable` は破れない)。残る害 (移動の途中のシャードが prepare を適用できず、DDL が、移動を待たずに失敗する) を確かめる。
`moveDuringDdl` は、遷移の commit が移動の途中に記録されると、受け取り中の子が、その後の計画の要求を断る。Meta は、commit のときの範囲表の全シャードの ok を求めるので、モデルの反例は、`commitWithoutAcks` を一緒に入れたときに現れる。

#### 見つけて直したもの

- **古い形の行イメージが、頼ると名乗っていない表へ適用された** (`ddl-concurrent` の 6 の seed 2、行イメージの検査)。取引が溜めた書き込みを、文に付けて、表を選ばずに送っていた。要求は、範囲の表にしか頼らないので、別の表に列が足された後でも通り、その表の古い形の行イメージが適用された。文に付けるのを、範囲が名指す表の書き込みだけにした (`Txn.overlay`)。シャードをまたぐ UNIQUE のある書き込みの、課金される行も減った (`test/unique-rowcost.test.ts`: INSERT は 15 から 14.5、UNIQUE の値を変える UPDATE は 20.95 から 20.5)。
- **行を集める経路の書き込みが、書き込み禁止に当たらなかった** (`ddl-waits-for-row-locks` を `REFERENCE=scans` と `full` で流して見つけた)。文は通り、取引の `COMMIT` が禁止で断られた。文をシャードへ送る経路では文が断られるので、成否が、文の経路で変わった。書いた行のロックを取る要求を、書き込みとして禁止に当てるようにした。

#### 見つけて直していないもの

- **ロックを失った取引の `COMMIT` が、書き込み禁止に当たると、取引が `SQLITE_BUSY` で失敗する** (`test/open/commit-hits-fence-after-lock-loss.test.ts`)。設計は、`COMMIT` も書き込みの文と同じに扱う (取り消させて、やり直す) としたが、M24 のモデルは、書き込みの文が当たる形しか持たない (「確かめていないこと」)。`COMMIT` をやり直すには、2PC の ID を取り直し、断られた試みが参加者に置いた intent と、放したロックの扱いを決めなければならない。規則 3 により、モデルを先に書く。不変条件は M24 の `holderSurvives` で、持ち主は、Worker の取引の層と、シャードの確定の入口である。
- **行ロックを取り続ける書き手がいる表の DDL は、5 秒で `SQLITE_BUSY` になる**。prepare が待つのは、その表の行ロックが 1 つもない瞬間で、待っている間も、新しい取引はロックを取れる。SQLite でも、書き手が途切れなければ DDL は busy_timeout で失敗するが、D∞ のロックは行ごとなので、書き手どうしは互いを待たず、途切れにくい。モデルにも試験にもない。(直した。待っている間に来た取引は、ロックを得ずに DDL の後ろで待つ。下の「ロックを与える判断と fence」。)
- **`m24_boundary_red_global` の再生は、取引の場面で代えた**。batch の区切りの場面そのものの再生はない。
- **終わった移動の遅れた pull が、範囲を受け取り終えた前の持ち主に届くと、グループを渡し直す** (`test/open/late-pull-after-range-returned.test.ts`。未解決の問題 55 の残り)。この変更の欠陥ではなく、`aa1eea6` でも同じ場面が落ちる。見つけたのは、乱択の検査 `move-returns` の seed 18 である。床を適用の時刻に置かなくしたので、シャードが commit の適用で時計を読まなくなり、乱択の実行でシャードが時計を読む順が変わって、同じ seed が別の実行になった。渡し直した印が残ると、その後でそのグループを書いた取引の phase 2 を、シャードは、intent を適用せず、転送もせずに、受け取ったと答える。不変条件は、M5c の「終わった移動の pull は、渡し直さずに断る」(`m5c_red_rehand`) で、持ち主は、送り出した側の記録 (`pullPieces`、`fenceOf`) である。

### ロックを与える判断と fence (2026-11-17)

状態：実装した。
モデルは M24c (`specs/m24c_lock_holders.qnt`) で、結果は [specs/README.md](../specs/README.md) の M24c の節に書いた。
計画書の不変条件 16 である。この節より前の「表ごとの epoch」の記述のうち、変わった所は、下の「前の記述から変わったところ」にまとめた。

#### 欠陥

表ごとの epoch を実装した後で、見直しと生成器 (`test/ddl-lock-holders.ts`。`test/ddl-concurrent.test.ts` の 9) が、同じ場所に欠陥を 3 つ見つけた。
M24 の `m24_retry` は、取引 1 件と書き込みのロックだけを持つので、どれも現れなかった。

| | 欠陥 | 起きること |
|---|---|---|
| D1 | ロックを取る読み (`BEGIN IMMEDIATE` の主キーの読み) が、書き込み禁止の表でロックを得る。シャードは、書き込みとして頼る表の行にしか、禁止を確かめなかった | 全シャードが prepare を適用した後に始めた取引が、続く書き込みで DDL を取り消させる。DDL は、競合でない誤りで失敗する。行を集める経路 (基準経路) では、読みがロックを取らないので、DDL は確定し、取引のほうが断られる。結果が経路で変わる |
| D2 | 一意でない `CREATE INDEX` と `DROP INDEX` は、表の書き込みの epoch を進めるのに、fence が空だった (`src/sql/ddl.ts` が DDL の種類ごとに並べていた) | prepare は行ロックを待たず、DDL はすぐに確定する。行を書いた取引の次の書き込みと `COMMIT` が、`stale schema` で断られる |
| D3 | シャードが、行ロックの持ち主を待っている間に、新しい取引にロックを与える | その取引がロックを持ち続けると、DDL は 5 秒で `SQLITE_BUSY` になる。行が、もう prepare を適用したシャードにあれば、その取引は禁止で待ち、DDL は確定する。成否が、行の置き場所で決まる (規則 4) |

#### 不変条件 16

> DDL が待つ表の集合 (fence) は、その DDL が確定で書き込みの epoch を進める表のうち、いまある利用者の表である。畳み込みが epoch を進めるのと同じ一覧から、1 か所で導く。
>
> シャードは、DDL の prepare を見た時 (適用した時か、行ロックを待って適用を待ち始めた時) から、DDL が終わるまで、その表の行ロックを持たない取引に、その表の新しいロックを与えず、その取引の書き込みも受けない。
> その表の行ロックを持つ取引 (どのシャードに持っていてもよい) は、適用を待っているシャードでは通る。
> 行を書くことと、行ロックを取ることを止めるかは、シャードの 1 つの関数が決める。要求が表に書き込みとして頼るか、読みとして頼るかを見ない。
>
> 止められた要求は、断られずに、DDL の後ろで待つ。

提案されていた文 (「待つ表の集合は、書きの epoch を進める表の集合と等しい。prepare の適用を待ち始めた時から、そこにロックを持たない取引に、新しいロックを与えない」) から、4 か所を直した。1 から 3 は、モデルの赤が示した。

1. **禁止は、試みごとではなく、DDL が終わるまで続く**。ロックを持つ取引が書き込み禁止に当たって試みを取り消させた後、進める側がやり直しの prepare を記録するまで、取り消しを適用したシャードには、禁止も待ちもない。DDL の後ろで待っていた取引が、その間にロックを得る (`m24c_red_gap`)。取り消させる手は、行が 2 つのシャードにあるときだけ起きるので、これも規則 4 である。Meta が、取り消しと、やり直しの prepare を、1 手で記録するようにした (`ONE_RESTART`)。
2. **「ロックを持たない取引」は、どのシャードにも、その表のロックを持たない取引である**。そのシャードで見ると、P にロックを持つ取引の、Q (別の取引を待っている) への書き込みが、DDL の期限まで待たされる (`m24c_red_holder_here`)。
3. **止めるのは、ロックだけでなく、書き込みもである**。楽観の取引 (`Db.begin()`) の `COMMIT` と、autocommit の書き込みは、ロックを取らない。適用を待っているシャードが受けると、楽観の取引の `COMMIT` は、行が 1 つのシャードにあれば通り、2 つのシャードにあれば (prepare を適用したシャードで) 競合になる (`m24c_red_window` の `optimisticOutcome`)。書き込みの禁止と、ロックを与える判断を、1 つの関数にした。
4. **fence に入れるのは、いまある利用者の表だけである** (モデルの外)。まだない名前 (作る表、`RENAME` の新しい名前) と view には、行がない。内部の表 (`__gidx_<index>`) の行は、元の表を書く取引が、同じ取引で書き、行ロックを取らない。止めると、行ロックを持つ取引の `COMMIT` が、index の項目のシャード (元の表の行ロックがなく、prepare をもう適用している) で断られ、成否が項目の置き場所で決まる。元の表の fence が、項目を書く取引を待たせ、止める (`test/index-ddl-ignores-row-locks.test.ts` の 3 つ目の場面、`test/ddl-waits-for-row-locks.test.ts` の「does not refuse the COMMIT of a transaction whose rows carry a cross-shard UNIQUE」)。

#### 待つ間の新しい要求の扱い

モデルが決めたのは、**断らずに、DDL の後ろで待たせる**ことである。

- `SQLITE_BUSY` で断る案は採らない。SQLite では、DDL が書き込みのロックを待つ間に来た書き手は、busy_timeout まで待ち、DDL が終われば通る。すぐに断ると、SQLite では通る文が失敗する。
- 待ちは、DDL が終わるまでである。DDL は、行ロックを待つ間は、期限 (DDL を始めてから 5 秒) までに終わる。全シャードが prepare を適用した後の仕事が長い DDL (行の多い表の index) では、今の書き込み禁止の待ちの上限 (30 秒) までである。
- まだ何も読み書きしていない取引 (`BEGIN IMMEDIATE` の最初の読み、書き込みから始める取引) は、DDL が終わった後の表定義で計画し直して、通る。DDL の前に読んだ取引は、DDL が確定していれば `SQLITE_BUSY` になり、失敗していれば通る (SQLite の `SQLITE_BUSY_SNAPSHOT` と同じ)。
- ロックを取らない書き込みのうち、autocommit の文は、待って、通る。楽観の取引の `COMMIT` は、送り直せないので、禁止に当たったときと同じく、競合になる (SQLite との違いの 3 つ目。前からある)。

SQLite の書き込みのロックに、公平な列はない。持ち主が確定した時、待っていた DDL と、待っていた新しい書き手の、どちらが先にロックを取るかは決まっていない。新しい書き手が先に取って期限まで持てば、DDL は `SQLITE_BUSY` になる。
D∞ は、そのうちの片方だけを起こす。DDL を始めた後に最初のロックを求めた取引は、いつも DDL の後ろになる。
だから DDL の結果は、DDL より前にロックを取った取引の時刻だけで決まり、行の置き場所に依らない (`asSqlite`、`placementFree`)。
同じ時刻の競り (最初のロックの要求が、prepare がシャードへ届く前に着く。`COMMIT` が期限と同時) は、SQLite と同じく、どちらの結果もあり得る。

#### 実装

| 持ち主 | 変えたこと |
|---|---|
| fence を導く所 (`src/catalog.ts` の `fenceOf`) | DDL が確定で epoch を進めるものの一覧 (`advanced`) を、畳み込み (`advance`) と共有し、そこから、いまある利用者の表を選ぶ。`ParsedDdl.fence` と、`src/sql/ddl.ts` の DDL の種類ごとの fence は消した。Meta の `prepare` が、記録の `fence` を、ここから作る |
| シャードの 1 つの判断 (`src/shard/kernel.ts` の `tableGate`) | 書き込みの禁止 (`assertUnlocked`) と、ロックを与える判断を、1 つにした。行を書く経路 (文の実行、autocommit、`commitLocal`、2PC の prepare) と、ロックを取る経路 (`lockedStep`) が、どれも通る。ロックについては、与える直前に呼ぶ (行を待っていた要求は、起こされた後で、もう一度通る) |
| シャードの待ちの状態 (`ShardKernel.pending`) | 適用 (`applyStep`) は、行ロックのある表の prepare の手前で終わり、待ち始めたことを覚える。待つのは、prepare を適用させたい要求 (`preparedStep`。DDL を進める側の `prepared`) で、ロックが空くか、列の続きを取り直す時刻が来たら、適用をやり直す。前は、適用の手続きそのものが、期限まで眠っていた。その形では、やり直しの prepare の手前まで適用させたい要求 (取り消させた取引の送り直し) も、一緒に待たされる |
| Meta (`src/meta.ts` の `abort`) | 取り消させる手の abort と同じ 1 手で、やり直しの prepare (同じ文、同じ fence、同じ待ちの期限、新しい epoch) を記録する。やり直しの prepare は、その DDL の最初の試みの epoch を運ぶ (`retryOf`。何度取り消させられても同じ)。答えの `next` は、その DDL のやり直しのうち、いま開いているものの epoch である。書き込みが止まる時間の上限 (5 分) は、最初の試みの始まりから数える。待ちの期限を運ばない prepare は、やり直さない |
| DDL を進める側 (`src/client/db.ts` の `changeSchema`) | 取り消されたと知ったら、待ちの期限のうちなら、いま開いている、自分の DDL のやり直し (`Catalog.open.retryOf` が、自分の最初の試みの epoch) を引き継いで進め、過ぎていれば、それも取り消す。取り消させる手で終わった DDL は、どこで知っても、競合 (`SQLITE_BUSY`) で失敗する (前は、index を作る途中で知ると、競合でない誤りだった) |
| Worker の待ち (`Db.tableUnfenced`) | 止められた文は、名指された試みが閉じるのではなく、その表を fence に持つ遷移が開いていなくなるのを待つ。やり直しのたびに、送り直さない |
| Worker の取引 (`Txn.lockRead`、`Txn.unread`) | 下の「経路の違い」 |

通信の版は変えていない (シャードへの要求の形は同じ)。保存の形式の版も変えていない (prepare の記録に、省ける欄 `retryOf` が増えた。`docs/storage-format.md`)。

#### 経路の違い (D1 の基準経路の側)

行を集める経路 (基準経路) の文は、行を読んでから、ロックを求める。最適化の経路の文は、読む前にロックを求める。
ロックを止められた取引が、計画し直せるか (何も読んでいないか) が、経路で変わっていた。2 か所を直した。

- `BEGIN IMMEDIATE` の主キーの読みは、基準経路でも、行を集める前に、その行のロックを取る (`Txn.lockRead`。行は、走査ではなく文から決める。計画の `lockRow`)。
- 取引の最初の文が、答えを返す前に、書き込み禁止か、古い表定義で断られたら、その文が記録した読みを捨てて、何もしていない取引に戻す (`Txn.unread`)。文は答えを返していないので、取引は何も見ていない。

残る違いは 1 つで、DDL には関係がない。`BEGIN IMMEDIATE` の主キーの読みは、最適化の経路では、ロックを取った時刻の最新の行を読む。基準経路では、ロックを取ってから、取引の読み取り時刻で読む。
取引の最初の文なら、読み取り時刻はロックを取った時刻なので、同じである。後の文では、読み取り時刻とロックの間に、別の接続がその行を確定していれば、基準経路の取引の `COMMIT` が競合になる。
別の接続が本当に書いているので、範囲で書く文 (`docs/sql-language.md` の「取引」) と同じ扱いとして、認める。

#### 前の記述から変わったところ

- 「シャード」の表の「行ロック」: 待っている間、シャードは、その表の行ロックを持たない取引を、適用した後と同じに止める。
- 「Worker」の、進める側のやり直し: 新しい prepare を記録するのは、進める側ではなく Meta で、取り消しと同じ手である。進める側は、それを引き継ぐ。`m24_retry` の `RETRY` は、M24c の `ONE_RESTART` に替わった (`KEEP_BUDGET` と `FRESH_EPOCH` は同じ)。
- 「実装の一覧との対応」の 8: 書き込み禁止で待つ文は、名指された遷移が閉じるのを待つ `Db.transitionClosed` ではなく、その表を fence に持つ遷移が開いていなくなるのを待つ `Db.tableUnfenced` を使う。
- 「実装の一覧との対応」の 9: 10 ms ごとに見直して待つのは、適用の手続きではなく、`prepared` の要求である。
- 「見つけて直していないもの」の 2 つ目 (行ロックを取り続ける書き手がいる表の DDL は、5 秒で `SQLITE_BUSY` になる): 待っている間に来た書き手は、ロックを得ないので、DDL を待たせない。
- 段 3 の「mode と fence」の表: `DROP INDEX` と、列だけの一意でない `CREATE INDEX` の fence は、対象の表である (mode は `plain` のまま)。全シャードへの往復の間、その表への書き込みが止まる。

#### 検査

欠陥のスイッチは 5 つで、モデルの条件に 1 つずつ対応する。どれも、決まった順の再生 (各ファイルの「put back」) が落ちる。

| スイッチ | 側 | 戻す形 | モデルの赤 | 再生 |
|---|---|---|---|---|
| `lockGateWritesOnly` | シャード | ロックを取る読みは、書き込み禁止を確かめない (D1) | `m24c_red_reads` | `test/locking-read-on-fenced-table.test.ts` |
| `indexDdlUnfenced` | Meta | 行で失敗しない index の DDL の fence が空 (D2) | `m24c_red_fence` | `test/index-ddl-ignores-row-locks.test.ts` (3 つの DDL)、`test/catalog.test.ts` |
| `lockDuringDdlWait` | シャード | 待っている間、どの取引も通す (D3) | `m24c_red_window` | `test/ddl-busy-by-writer-during-its-wait.test.ts` (ロックを取る書き込み、ロックを取らない書き込み、行を待っていた要求) |
| `woundWithoutRestart` | Meta | 取り消しと一緒に、やり直しの prepare を記録しない | `m24c_red_gap` | 同じファイル (取り消しとやり直しの間)、`test/catalog.test.ts` |
| `holdsOnlyHere` | シャード | 待っている間、そのシャードにロックを持つ取引だけを通す | `m24c_red_holder_here` | 同じファイル (2 つの持ち主) |

3 つの再現は `test/` へ移し、3 つの実行の形 (通常、`REFERENCE=scans`、`REFERENCE=full`) で流す。
既定の seed の RPC の列 (`history` と `replay`。`RPC_TRACE` で書き出して比べた) は、通常の実行では、どれも変わらない。基準経路の 2 つの実行では、悲観の取引の `history` (seed 41 から 46、51 から 54) だけが変わる。`BEGIN IMMEDIATE` の主キーの読みが、行を集める前に、ロックを取る要求を送るからである。

生成器 9 は、reader の半分が、5 秒の期限の後まで取引を開けておくようにした (D3 の形)。不変条件 16 を、答えのほかに、シャードの状態でも直に確かめる (`lock granted on a fenced table`、`ddl committed under a row lock`、`lock granted during the wait`)。D1 から D3 の伏せは外した。

生成器 9 の結果 (2026-11-17)。直す前 (`aa1dc2e` のコードに、広げた生成器を載せたもの) は、seed 1 から 600 の 2,400 実行で、伏せた違反が、D1 で 133 seed、D2 で 227 seed、D3 で 45 seed にあった。D3 は、DDL が 1 シャードの実行でだけ失敗する形 (`ddl failed` 46 件、`differs: ddl` 9 件) を含む。
直した後は、seed 1 から 1000 の 4,000 実行で、違反が 0 である。既定の 96 seed (384 実行) では、reader が DDL の後ろで待った実行が 48、全シャードが prepare を適用した後に始めた `BEGIN IMMEDIATE` の取引が DDL の後ろで待って確定した実行が 20、一意でない index の DDL が持ち主を待って確定した実行が 36 ある (`test/ddl-concurrent.test.ts` の 9 の最後の試験が、0 でないことを確かめる)。
欠陥のスイッチを 1 つずつ入れると、seed 1 から 300 の 1,200 実行で、次のとおり落ちる。

| スイッチ | 落ちた seed (300 のうち) | 違反のある実行 (1,200 のうち) | 違反の種類と数 |
|---|---|---|---|
| `lockGateWritesOnly` | 57 | 226 | `lock granted on a fenced table` 226、`ddl withdrawn by a later lock` 226、`ddl committed under a row lock` 168、`lock granted during the wait` 118、`ddl failed` 56 |
| `indexDdlUnfenced` | 117 | 468 | `holder refused` 500、`ddl committed under a row lock` 464、`ddl did not wait` 256、`ddl not busy` 140、`late immediate refused` 100、`lock granted during the wait` 36 |
| `lockDuringDdlWait` | 47 | 160 | `lock granted during the wait` 160、`ddl failed` 54、`differs: ddl` 14 |
| `woundWithoutRestart` | 5 | 6 | `lock granted during the wait` 6、`differs: ddl` 4、`ddl failed` 3 |
| `holdsOnlyHere` | 14 | 28 | `holder refused` 30、`differs: transaction` 16 |

#### 持ち主の判断が要ること

任された範囲 (D1 から D3 を、同じ不変条件として、持ち主で直す) を超えて決めたことが 3 つある。どれも、モデルの赤が示した規則 4 の形を塞ぐためのもので、利用者に見える挙動が変わる。

1. **やり直しの prepare を記録するのは Meta である**。M24 の `RETRY` (進める側が、取り消しを知ってからやり直す) を替えた。列に、省ける欄 (`retryOf`) が増えた。進める側が止まっていれば、やり直しは、今までの遷移と同じく、期限 (5 秒) で取り消される。その間、表への書き込みは止まったままである (前は、取り消しの時点で解けた)。
2. **一意でない `CREATE INDEX` と `DROP INDEX` が、表への書き込みを止める**。全シャードへの往復の間である。止めないと、DDL は、行を書いた取引を待てない (待っている間に、表の書き込みの計画が古くなる書き込みを通すことになる)。
3. **DDL が行ロックの持ち主を待っている間の、ロックを取らない書き込み**。楽観の取引 (`Db.begin()`) の `COMMIT` は、行が、待っているシャードにあるとき、前は通った。いまは、prepare を適用したシャードにあるときと同じく、競合 (`SQLITE_BUSY`) になる。autocommit の書き込みは、前はすぐに通り、いまは DDL が終わるまで待つ。結果は置き場所に依らなくなったが、前は通っていた `COMMIT` が失敗する。逆 (待っているシャードに合わせて、prepare を適用したシャードでも通す) は、書き込み禁止そのものをやめることになるので、取れない。

#### 残っているもの

- **`COMMIT` が書き込み禁止に当たる形** (未解決の問題 59)。ロックを故障で失った取引の `COMMIT` は、適用を待っているシャードでも、禁止に当たったときと同じに断られる。この変更の前からある。
- **素の `BEGIN` の取引の結果を、置き場所の間で比べる検査**。生成器 9 は、DDL の前に読んだ取引と、DDL のすぐ前後に始めた取引の成否を、実行の間で比べない (どちらの表定義で計画したかが、ミリ秒の差で変わる)。モデルの `readerOutcome` は、刻みの単位で確かめている。
- **全シャードが prepare を適用した後の待ちの上限**。行の多い表の index を作る間 (最長 5 分)、後から来た取引の書き込みとロックの要求は、30 秒で `SQLITE_BUSY` になる。前からある資源の上限で、モデルにはない。
- **行を待っていた要求**。行ロックを待っていた要求が、DDL が始まった後に起こされる形は、モデルにない (モデルの 2 つの取引の行は別である)。実装は、ロックを与える判断を、起こされた後の、与える直前に置いていて、起こされた取引は DDL の後ろで待つ。決まった順の試験 (`test/ddl-busy-by-writer-during-its-wait.test.ts` の「queued on a row」) が確かめる。乱択の検査にはない。
- **再起動**。待ちの状態 (`pending`) はメモリにある。シャードが再起動すると、行ロックも消えるので、prepare は待たずに適用される (M25 の、再起動でロックを失う形と同じ)。

## 段 4 の結果 (2026-11-16)

段 4 で、範囲の移動は、Meta の列の `move-start` と `move-end` の 2 つの記録で進むようになった。
`move-start` は、範囲表の切り替えであり、親の fence であり、子の受け取りの始まりである。
分割の枠 (`SplitSlot`)、`fence` と `beginIncoming` の RPC、`switchRange`、`reserveSplit` はなくなった。
`move-start` の後は、子が自分で移動を進める (決めたこと 4)。
通信の版は 9、保存の形式は版 6 で、どちらも移行は書かない。

### 記録と、誰が進めるか

| 手 | 誰が | 何をするか |
|---|---|---|
| `startMove({ from, to, start, end })` | 進める側 (Autoscaler の `split`) | Meta が `move-start` を記録する。同じ移動 (親、子、区間) がもう開いていれば、記録を足さずに、その epoch を返す (再開)。断るのは `refusal` の 4 つの条件 (下の「排他」) と、slot の境目にない区間である |
| `move-start` を適用する (`moveRows`、`moveStarted`) | 親と子 (列の適用の中で) | 親は `__fenced` に、子は `__incoming` に、移動の epoch の行を、記録を写しに足すのと同じ取引で書く。親にとって、これが fence である (以後、スナップショットの範囲表が区間を子に渡すので、親はその区間の書き込みと prepare を断る)。子は受け取り始め、応答の後の仕事として移動を進め始め、alarm も予約する |
| `drain({ start, end, epoch })` | 進める側が子に送る | 子が移動を終えるまで進める手順 (`moveStep`) に合流し、運んだ数を返す。子は epoch まで列を適用してから始めるので、まだ `move-start` を知らない子にも、この要求だけで足りる |
| 全グループを引き取る (`drainStep`) | 子 | 親の `listGroups` と `pull` に移動の epoch を付ける。親は、その epoch まで列を適用してから答える (`toEpochStep`。M21 の PULL_AT_EPOCH)。範囲の記録だけを先に適用し、手前に表定義の記録があれば列の全部を適用する |
| 親の `finishMove({ start, end, epoch })` | 子が親に送る | 親は epoch まで適用し、fence に終えた印を付け、時刻 m を発行する |
| `finishIncoming` | 子 (自分で) | 時計を m まで進め、受け取りの記録に終えた印と m を付ける。以後、子は移動の途中ではない |
| `endMove(epoch)` | 子が Meta に送る | Meta が `move-end` を記録する。もう閉じていれば、閉じた記録の epoch を返す。子は、受け取り終えた後でだけ送る (M21 の END_AFTER_DRAIN。列からは決まらないので、子の手順の順序が守る) |
| `move-end` まで写しを進める | 子 | 自分の写しで移動が閉じる。alarm は、もうこの移動を進めない |

子が進める手順は、3 つの入口から同じものに合流する (殻の `drive`。移動の epoch ごとに 1 つ)。`move-start` を適用したときの応答の後の仕事、alarm (`redrive` は、受け取り中の移動と、受け取り終えたが自分の写しで閉じていない移動を進める)、進める側の `drain` である。
子は、起動のときにも、受け取り中か閉じていない移動があれば alarm を予約する。
Autoscaler の `split` の手は 2 つ (`startMove`、子の `drain`) になった。Autoscaler の判断は、Meta に開いている移動 (`moves()`) を、子に `drain` を送って再開する (`movesToResume`)。子が `move-start` をまだ知らない移動は、最新の範囲表の要求が子に届くか、この再開で始まる。

「止まったときに誰が終えるか」の表の移動の行は、次のようになった。

| 止まる場所 | 残る状態 | 誰が、どう終えるか |
|---|---|---|
| `startMove` の前 | 何もない | やり直す |
| `startMove` の後、子が知る前 | 親はまだ区間を持ち、答える (親も `move-start` を適用していなければ) | 最新の範囲表の要求が子に届くか (子は記録を適用して受け取り始め、そのまま移動を進める)、Autoscaler が開いている移動を再開する |
| 子が受け取っている途中 (子が再起動して、応答の後の仕事が消えた) | 主キーを名指しする要求は通る。全表の読みは `migrating:` | 子の alarm が続きを進める |
| `move-end` の記録の前 (子は受け取り終えている) | 表定義の遷移が開けない | 子の alarm が `endMove` を呼び直す |

### 表定義の遷移と移動の排他

Meta は、記録を足す前に、列を畳んだスナップショットで `refusal` に尋ね、次の 2 つで断る。分割の枠はなくなった。

| 足す記録 | 断る条件 (`refusal` の rule) | 誤り |
|---|---|---|
| `prepare` | 移動が開いている (`ddl-waits-move`。M21 の DDL_WAITS_MOVE) | `SchemaBusy` (`schema busy: a shard split of <親> is in progress`)。Worker は待ってやり直す (60 秒) |
| `move-start` | 表定義の遷移が開いている (`move-waits-ddl`。MOVE_WAITS_DDL) | `SchemaBusy`。Autoscaler の `split` は `split busy: schema busy: ...` にして、次の判断でやり直す |

`move-start` は、ほかに、区間の全体を親が持つこと (`owner`)、開いている移動と区間か親か子が重ならないこと (`moves-overlap`。`split busy:`)、子がほかの区間を持たないこと (`child-owns`) を確かめる。
どれも、段 1 から `refusal` にあり、`test/catalog-m21.test.ts` が M21 と突き合わせている条件である。
移動が閉じるのは、子が受け取り終え、親が渡し終えた (`finishMove`) 後なので、`prepare` が記録された後に移動の途中のシャードはない。
`Db.preparedAll` の、移動の途中のシャードを待って尋ね直す手は消した (段 3 の申し送り)。

### 受け取りの記録を受け取りごとに

所有をスナップショットだけで引くようにした (`notOwned` と、全表の読みの claim。手放した記録 `__fenced` とは比べない) ので、範囲が前の持ち主へ戻れるようになった。
そこで、移動の記録をどれも、その移動の `move-start` の epoch で分けた (`docs/design-refresh-across-move.md` の「実装がすること」の 5、M23b が段 4 に求めること)。

| 記録 | 段 4 より前 | 段 4 |
|---|---|---|
| `__incoming` | 区間ごと。`finishIncoming` の 2 つ目の UPDATE が、同じ区間の、ほかの受け取りの終わった行の m を上げた | 受け取りごとに 1 行 (`epoch` が主キー)。書き換えるのは、いま受け取っている移動の行だけで、受け取り終えた移動にもう一度届いても何もしない (時計だけを進める) |
| `__arrived` | 主キー `(g, lo, after)`。同じグループの 2 度目の到着は `INSERT OR IGNORE` で捨てられ、`receiveStep` は 2 度目の行を入れなかった (行が消えた) | 主キー `(g, epoch, after)`。この移動でまだ届いていない piece は、前の移動で届いたグループでも新しい到着である |
| `__moved`、`__moved_txn` | 主キー `(g, lo, after)`。同じグループを 2 度渡すと、2 度目を列挙せず (ack 済みの印が残る)、前の m で渡した | 主キー `(g, epoch, after)`。メモリの印は「渡して、まだ受け取り直していない」グループだけで、範囲が戻ると外す。決着の転送は、いまも渡したままの移動の記録だけをたどる (前の移動の記録をたどると、戻した先と戻ってきた先が互いに転送し合う) |
| `Piece`、`PiecePayload` | グループ、区間、位置 | 移動の epoch も運ぶ。前の移動の遅れた ack は、受け取り直した後の行を消さない |

### 消したもの

| 場所 | 消したもの |
|---|---|
| `src/meta.ts` | 分割の枠 (`SplitSlot`、`SplitMove`、`beginSplit`、`startSplit`、`checkSplit`、`endSplit`、`splits`、`__meta` の `splits`、枠の期限)、`switchRange` |
| `src/catalog.ts` | `splitId`。`Move.from` は省けなくなった |
| `src/autoscaler.ts` | `reserveSplit` (枠を取る前の全シャードへの `syncSchema`)、`split` の `beginIncoming`、`fence`、`switchRange`、`finishMove`、`finishIncoming`、`endSplit` の手、`splitsToResume` (`movesToResume` に替えた) |
| `src/shard/kernel.ts`、`core.ts`、`step.ts` | `beginIncomingStep`、`fenceStep` と、その RPC。所有の確かめの `fencedIn` (`__fenced` の終わった行による拒否)。`finishIncoming` の 2 つ目の UPDATE。Meta への `startSplit`、`checkSplit` |
| `src/client/db.ts` | `Cluster` の `beginSplit`、`endSplit`、`splits`、`switchRange`。`Db.preparedAll` の、移動の途中のシャードを待って尋ね直す手 |
| `src/worker.ts` | Meta の DO の枠の入口と `switchRange`。`/admin/status` の `splits` は `moves` になった |
| 欠陥のスイッチ | `startWithoutSlot`、`fenceWithoutSlot` (Meta)、`splitWithoutSync` (Worker) |
| 試験 | `test/split-slot.test.ts` の、M15 の `m15_red_no_based_on` と `m15_red_late_start` の再生 (枠と一緒に、形がなくなった) |

### 設計の本文からずれたところ

- 進める側の手は、設計の「今と同じ順に呼んでよい」より少ない。`split` は `startMove` と子の `drain` だけを呼び、`drain` が、子の手順 (引き取り、親の `finishMove`、`finishIncoming`、`endMove`) に合流する。進める側が `finishIncoming` と `endMove` を自分で呼ぶと、子が受け取り終えたかを進める側が知らずに呼ぶことになる。
- Meta の `startMove` は、slot の境目にない区間を、記録の前に断る (`moving a part of a slot is not supported yet`)。段 4 より前は、シャードの `beginIncoming` が、範囲表を切り替える前に断っていた。記録すると、シャードが進められない移動が開き続け、表定義の変更も止まる。
- `syncSchema` は `{ schema, epoch? }` を受ける。`syncEpoch` への改名はしていない (RPC の列の比べ合いを読みやすくするため)。
- 子の受け取りの始まりの表定義の epoch を、Meta は返さない。子は列を順に適用するので、`move-start` を適用した時点の表定義は、親が `move-start` を適用した時点と同じである (移動が開いている間は表定義の記録が足されない)。`receiveStep` の、届いた piece の表定義まで追いつく手は残した (通常は何もしない)。
- 欠陥のスイッチ `pullWithoutEpoch` は、親の側に置いた。子は epoch を運ぶが、親がそこまで適用せずに (fence の前に) 答える。モデルの「要求が epoch を運ばない」と同じ形で、渡した piece を移動ごとに見分けられるようにするためである。
- 列の適用 (`applyStep`) は、移動の途中になった後の表定義の記録を、記録ごとに断る (M21 の `movingNow`)。同じ続きの中で `move-start` を適用して移動の途中になることがあるからで、Meta の条件が破れたときだけ起きる。`toEpochStep` は、epoch まで適用できていれば、その先の記録で断られても通る。
- シャードは、子として進める移動のために alarm を予約するとき、そう伝える (`scheduleRedrive("move")`。DO では、ほかの予約と同じ 1 つの alarm である)。シミュレータは、その予約を、クラスタの仮想の時計の alarm にする (`SimCluster.armMoveAlarm`)。DO と同じく 5 秒後に `redrive` を走らせ、まだ進める移動が残っていれば、もう一度予約する (続けて 60 回まで)。発火したときに進める移動がもうなければ、何もしない。移動のない alarm (取り残された intent と phase 2 の再駆動) は、今までどおり試験が発火させる (`fireAlarms`)。自動に発火させると、移動のないほかの試験の RPC の列まで変わるからである。
- シミュレータの書き込みの検査 (`checkWrites`) の持ち主の決め方を変えた。段 4 より前は、Meta のいまの範囲表と `__fenced`、`__incoming` から決めた。段 4 では、シャードが写した列 (`__epoch`) を畳んだ範囲表でその token がシャードのものであり、そのグループを渡した記録 (`__moved`) があれば、その後に届き直したか (`__arrived`)、その範囲を受け取り直した (`__incoming`) ことを求める。親は `move-start` を写すまで、移る範囲の行を持ち、書き込みを受けてよい (その行は、写した後に子へ運ばれる) ので、Meta のいまの範囲表とは比べられない。この決め方は、シャードの所有の規則 (スナップショット) と同じ記録を読むので、段 4 より前ほど独立ではない。欠陥のスイッチ `ignoreFence` と `pullWithoutEpoch` の書き込みは、この検査が見つける (`test/epoch-requests.test.ts`、`test/m21-moves.test.ts`)。
- 受け取り終えた移動にもう一度 `finishIncoming` が届いても、m を上げない。段 4 より前は大きい方の m を残した (`test/old-read-of-emptied-group.test.ts` の試験は、その振る舞いを確かめていたので、受け取りの m が変わらないことを確かめるように書き直した)。どちらの m も、渡した側がその範囲について発行したどの時刻よりも大きいので、初めの m で足りる。

### 検査

先に、段 4 より前のコード (`9e53efa`) で用意した検査 (規則 2)。

- 分割を進める側を各手の前で止める検査 (`test/split-slot.test.ts`。段 4 の前は `test/open/split-driver-stops.test.ts`)。手は、止めずに流したときに進める側が送った呼び出しの列から取る (`test/ddl-driver.ts` の `driver`。表定義と移動の一覧を読む呼び出しは数えない)。止めた後で、移る行と残る行が、最新の範囲表の接続からも、分割の前の範囲表を持ったままの接続からも、読めて書けること、進める側を再開せずに (応答の後の仕事と、子が予約した alarm だけで) 移動が終わり、Meta の列に開いた移動が残らず、親も子も移動の途中でないこと、表定義の変更が通ること、全表の読みで全部の行が数えられること、進める側を再開しても通り、移動の記録が 1 組だけであることを確かめる。子が受け取りの途中で再起動する場面も足した。段 4 より前のコードの手は `syncSchema` `beginSplit` `beginIncoming` `fence` `switchRange` `drain` `finishMove` `finishIncoming` `endSplit` の 9 つで、子が受け取り始めた後のどの手 (`fence` から `endSplit` までの 6 つ) で止めても、移動は終わらず、表定義の変更は「a shard split of s0 is in progress」で失敗した。`switchRange` の前で止めると、移る行の読みと書きが「not owner: s1」で失敗した (問題 17)。受け取りの途中で再起動した子は、alarm を予約しなかった。
- 前の持ち主へ戻る範囲の検査 (`test/range-returns.test.ts`)。1 シャードの全部の範囲を s0 から s1、s1 から s0、s0 から s1 へ動かし、移動のたびに全部の行が読めて書けることと、受け取ったシャードが受け取りごとに記録を残すことを確かめる。段 4 より前のコードでは、2 つ目の移動の後、前の持ち主 s0 は戻った範囲を `__fenced` の終わった行で断り続け (「not owner: s1」)、40 行のどれも読めなかった。記録の検査も、2 つの受け取りの m が同じ値になって落ちた (`finishIncoming` の 2 つ目の UPDATE)。

段 4 で、2 つとも通るようになった。
受け取りの記録の守りを 1 つずつ外して、検査が見つけることを確かめた。2 度目の到着を捨てる形 (`receiveStep` の `fresh` を `!this.arrived.has(g)` に戻す) では、3 つ目の移動の後に 40 行全部が消え、到着の記録も 1 行ずつになった。`finishIncoming` の 2 つ目の UPDATE を戻すと、行は残るが、2 つの受け取りの m が同じになった。

送り出した側の記録 (M23b が名指しした 2 つの義務の外で、範囲が戻るために要ったもの) にも、`test/range-returns.test.ts` に場面を足した。2 シャードで、s0 の全部の範囲を s2 へ動かして戻す。
1 つ目は、範囲と一緒に戻らなかった空のグループ (行がないので運ばれない) に、戻った後の 2 シャードの取引が書く場面で、再起動しない形と、戻った後に s0 が再起動する形がある。2 つ目は、確定を返した 2 シャードの取引の phase 2 が s0 に届く前に、その intent が範囲と一緒に s2 へ行って戻り、その後で phase 2 が届く場面である。
守りを 1 つずつ外して確かめた。範囲を受け取り直したときに「渡した」印を外す手 (`moveStarted`) を外すと、1 つ目の再起動しない形で、取引の書き込みが s0 で適用されずに消えた。起動のときに外す手を外すと、再起動する形で同じになった。決着の転送が、いまも渡したままの移動の記録だけをたどる手を外すと、2 つ目の場面で s0 と s2 が phase 2 を互いに転送し合い、試験が時間切れになった。
前の移動の piece の遅れた ack を数えない手 (`ack` の `known.epoch !== p.epoch`) は、外しても、どの試験も落ちなかった。遅れた ack が、受け取り直した後の同じグループの、まだ子に届いていない渡しを消す形は、作っていない。

M21 の段 4 の赤の再生は `test/m21-moves.test.ts` (4 つの赤、8 件) と `test/fenced-before-switch.test.ts` にある。どれも、直したコードで正しく終わることと、スイッチを入れると、モデルの反例と同じ不変条件が破れることを確かめる。

| M21 の赤 | スイッチ | スイッチを入れたときの姿 |
|---|---|---|
| `m21_red_ddl_during_move` | `ddlDuringMove` (Meta) | 子の受け取りの途中に prepare が記録される。DDL は親で「waiting for a shard split on s0」で失敗して abort され、受け取り中の子は、最新の表定義の epoch の読みを「waiting for a shard split on s1」で断る (`servable`) |
| `m21_red_move_during_ddl` | `moveDuringDdl` (Meta) | 進める側が prepare の後で止まった遷移の間に移動が開き、期限切れの abort が移動の途中に記録される。受け取り中の子は、それを適用できず、最新の epoch の読みを断る |
| `m21_red_end_early` | `endBeforeDrained` (子) | 子が受け取り終える前に move-end が記録され、Meta の移動の一覧は空になる。次の DDL の prepare を受け取り中の子が適用できず、DDL は失敗し、子は最新の epoch の読みを断る |
| `m21_red_pull_unfenced` | `pullWithoutEpoch` (親) | 親が move-start を適用する前に行を渡し、その後に分割の前の範囲表で計画した書き込みを受ける。書いた値は子に届かず、親の行は ack で消える (`moveKeepsWrites`、`readConsistent`)。シミュレータの書き込みの検査も、渡した後の行を親に残す書き込みとして見つける |
| `m21_red_fence_first` | なし | 段 4 より前の手順そのもの。親だけが move-start を適用し (fence)、子が知らないまま進める側が止まった形で、新しい接続も古い範囲表の接続も、移る行を読み書きできる |

`test/catalog.test.ts` には、表定義の遷移と移動の排他を両方向とも Meta だけで確かめる試験と、スイッチが、それぞれの向きの確かめだけを外すことを確かめる試験を足した。

移動を開いたままにして場面を作る試験のうち、進める側の要求を止めていたものは、段 4 では子が自分で行を運ぶので、止めても移動が開いたままにならない。`test/ddl-vs-split-race.test.ts` (進める側の `drain` を止めていた) と `test/child-behind-parent.test.ts` は、子の最初の手 (親のグループの一覧、`listGroups`) を止めるように直した。`ddl-vs-split-race` は、読みの間、子が受け取り中で、表定義の変更が記録されていないことも確かめる。`test/split-hazards.test.ts` の、進める側の `drain` を落とす 2 つの場面は、子が移動を知らないまま残る形として残し、行の読みが子に届くと、子がそのまま移動を終えることを確かめるように直した。

### 比べたもの

RPC の列。`test/history.test.ts` と `test/replay.test.ts` の既定の seed (61 件) を、段 4 の前 (`9e53efa`) と後 (`ffd3ca2`) で `RPC_TRACE` を付けて流し、送り元、宛先、種類の列を比べた。
46 件は同じで、15 件が違った。違ったのは、分割のある `history` の試験の全部 (「while shards are added」の seed 21 から 26、「with splits and restarts together」の 31 から 34、「with pessimistic transactions ... with splits and restarts」の 51 から 54、同じ seed が同じ実行になることを確かめる 1 件) で、分割のない `history` と、分割のない `replay` は全部同じだった。
15 件とも、列は最初の分割の最初の手まで同じで、そこで、前は Autoscaler が親と子の `moves` を尋ね、後は子に `drain` を送る。
15 件の分割の手を足し合わせると次のようになる。

| 要求 | 前 | 後 |
|---|---|---|
| Autoscaler から: `moves` (親と子) | 302 | 0 |
| Autoscaler から: `syncSchema` (枠を取る前に全シャードへ。最初の CREATE TABLE の後の 64 を含む) | 1,324 | 64 |
| Autoscaler から: `beginIncoming`、`fence`、`finishMove`、`finishIncoming` | 151 ずつ | 0 |
| Autoscaler から: `drain` | 151 | 175 |
| 子から親へ: `finishMove` | 0 | 175 |
| 子から親へ: `listGroups`、`pull`、`ack` | 235、41、46 | 219、65、65 |

前は 151 回、後は 175 回の分割が終わった。分割 1 回の Autoscaler の要求が、`moves` 2、`syncSchema` がシャードの数だけ、`beginIncoming`、`fence`、`drain`、`finishMove`、`finishIncoming` から、子への `drain` 1 つになり、`finishMove` は子が親に送る。
分割が速く終わるので、作業負荷が終わる前に、作業負荷の側の上限 (`MAX_SPLITS`、12 回) により近くまで割る。
分割の時期が変わるので、取引の要求 (`exec`、`prepare`、`commit`、`finalize`、`refresh` など) の数と交わり方も変わる。どの試験も、前後とも通る。
`syncSchema` と、子から親への `listGroups`、`pull`、`finishMove` が運ぶ epoch による列の適用は、Meta への呼び出し (`epochsSince`) なので、RPC の列には出ない。
その後の `e0e6233` (シミュレータの、移動のための alarm と、送り出した側の試験) でも同じ 61 件を流し、61 件とも `ffd3ca2` と同じ列だった。alarm を足しても、この作業負荷の RPC の列は変わらなかった。

### 表定義の epoch を commit だけで進める案 (M24) との関係

段 4 は、表定義の epoch を、`prepare`、`commit`、`abort` のどれでも進める今の決め方 (決めたこと 6) の上で実装した。
M21 の段 4 の赤の再生のうち 3 つは、この決め方に頼っている。`m21_red_ddl_during_move`、`m21_red_end_early`、`m21_red_move_during_ddl` の再生 (`test/m21-moves.test.ts`) は、どれも、受け取り中の子が、移動の途中に記録された表定義の記録 (`prepare` か `abort`) を適用できず、その epoch で計画した読みを断ることを、破れの姿として確かめる。`prepare` と `abort` が表定義の epoch を進めなければ、その読みは断られない。
M24 (`specs/m24_*`) は、commit だけで進める決め方で、前の 2 つ (`ddl_during_move`、`end_early`) が `servable` の形では反例でなくなると報告している。問題 53 の実装で決め方を変えるときに、この 3 つの再生の破れの姿を見直す。`ddl-waits-move` と、受け取り終えた後でだけ move-end を記録させる規則は、M24 でも残る。`m21_red_pull_unfenced` の再生は、表定義の epoch の決め方に頼らない。

### 未解決の問題 17 と 37

問題 17 (親の fence の後、範囲表の切り替えの前に進める側が止まると、移る範囲を誰も答えない) は閉じた。`test/fenced-before-switch.test.ts` を本試験へ移した。
親の fence は、親が `move-start` を適用することで、そのとき Meta の列には、子を宛先にした範囲表がある。
試験は、モデルの反例と同じ形 (親だけが `move-start` を適用し、子は何も知らない) を作り、新しい接続も、分割の前の範囲表を持ったままの接続も、移る行を読み書きできることを確かめる。
分割を進める側を各手の前で止める検査 (`test/split-slot.test.ts`) も、段 4 より前のコードでは、この形で落ちた。

問題 37 (取引が分割をまたげない) の再現 (`test/open/` の `transaction-across-split`、`locking-transaction-commit-after-split`、`baton-own-write-across-split`) は、段 4 の前後で流し、どれも同じ形で落ちた。
最初の誤りの文は同じで、違うのは `read too old: moved at <m>` の m の値だけである (段 4 の前 `1024003090`、後 `1024000022`。分割の手が少なくなり、移動が仮想の時刻の早くに起きる)。
段 4 は、37 の 3 つの形のどれも変えない。37 が要るのは、移動をまたぐ確かめ直しの規則 (`docs/design-refresh-across-move.md`) で、段 4 は、その規則が前提にする受け取りの記録 (受け取りごとの `from_id` と m) と、前の持ち主へ戻った範囲に答えることを入れた。
`test/open/` のほかの再現 (UNIQUE と大文字小文字の段の 7 ファイル 11 件) も、前後で同じ誤りで落ちた。

### 危険と、確かめていないこと

- 親が、`move-start` より前に確定した DDL をまだ適用していないと、子の最初の `listGroups` か `pull` で、親は列の全部を適用する (intent を決着させる)。その間、その親に intent を持つ取引の決着を待つ。段 4 より前は、同じ待ちが、Autoscaler の `fence` の中にあった (`reachStep`)。段 4 では、利用者の要求 (子の on-demand の引き取り) がこの待ちに入ることがある。親に intent を置いた取引が、子への prepare で、親からの引き取りを待つと、決着の待ちの上限 (`SCHEMA_WAIT_MS`、5 秒) まで待ってから、競合で失敗する。再現は作っていない。乱択の検査で、この形が起きた数も数えていない。DDL を確定した Worker は、確定の後に全シャードへ適用させる (`syncAll`) ので、親が遅れるのは、その適用が届かなかったときだけである。
- 子が移動を進める手順は、応答の後の仕事 (DO では `ctx.waitUntil`) で始まり、続きは alarm (5 秒ごと) が進める。alarm の handler の上限 (15 分) を越える移動は、alarm が `drain` を続きから進める (到着の記録のあるグループは飛ばす)。本物の DO では確かめていない (`test/workerd.test.ts` は、Autoscaler の `drain` が子の手順に合流する形で、移動の全部を通す)。
- 2 つ以上の移動が同時に開くこと (区間とシャードが重ならないとき) は、Meta の条件 (`moves-overlap`) と `test/catalog.test.ts` の場面だけで確かめた。乱択の検査 (`history`、`elle-sim`、`ddl-concurrent`) の分割は、1 つずつ進む。
- 範囲が前の持ち主へ戻る形は、`test/range-returns.test.ts` の決まった並び (1 シャードの全部の範囲を 3 回動かす) だけで確かめた。Autoscaler は、範囲を持たないシャードしか子にしないので (`child-owns`)、ふつうの分割では起きない。

### 見つけて直していないもの

- 範囲が前の持ち主へ戻る途中に届いた phase 2 を、前の持ち主が、intent を適用も転送もせずに受け取ったと答える (`test/open/phase2-during-return.test.ts`)。2 シャードの取引 (z は s0、s1 が anchor) が確定を返し、s0 への phase 2 が届く前に、z の intent が範囲と一緒に s2 へ行き、範囲が s0 へ戻る移動の途中 (s0 は move-start を適用して受け取り始め、z をまだ引き取っていない) で phase 2 が届く。s0 には z の intent がなく、渡した印は move-start の適用で外れているので、何もせずに答え、anchor は届け終えた印を付ける。z の intent は、後で範囲と一緒に s0 に届き、決着しないまま残る。読み手が来れば anchor に尋ねて決着させるが、anchor が届け終えた取引の記録を消した後 (`TXN_RETAIN_MS`) は、presumed abort で捨てられる (M10 の `m10_red_gc_undone` と同じ形の失い方)。不変条件の候補: 参加者は、intent を適用したか、いまの持ち主へ転送した後でだけ、phase 2 を受け取ったと答える。持ち主は、送り出した側の記録 (`moved`、`moveStarted`、`forwards`)。送り出した側の記録で 4 つ目の手直しになるので、規則 1 により直していない。案は 2 つある。渡した印を、範囲を受け取り直したときではなく、そのグループが届いたときか、受け取り終えたとき (`finishIncoming`) に外す (届くまでは、phase 2 を、渡した先へ転送する。渡した先は、まだ渡していなければ自分で適用し、渡していれば転送し返し、受け取る側は未着の piece を引き取ってから適用する)。または、範囲が前の持ち主へ戻る移動を、M23b を書き手に広げて確かめるまで、Meta が断る (Autoscaler の分割は、もともと範囲を持たないシャードしか子にしないので、ふつうは起きない)。

### 段 4 の後に要るもの

- 問題 37 の実装 (`docs/design-refresh-across-move.md` の「実装がすること」)。受け取りの記録は、受け取りごとに `__incoming` (`from_id`、m、`epoch`) と `__arrived` (`epoch`) にある。`history` の RPC は、尋ねたシャードが fence の宛先かを `__fenced` の `to` と `epoch` で確かめられる。範囲が前の持ち主へ戻る形 (`m23b_live_red_cycle`) の再生も、いまは書ける。
- `specs/README.md` の M21 の節の「M15 は段 4 で置き換える」と、M15 の節は、M21 が置き換えたことに直す必要がある (この作業は `specs/` を書かないので、直していない)。`docs/model-coverage.md` は、M15 の行を M21 の行に置き換えた。
- 決めたこと 6 の、表定義の epoch を commit だけで進める案は、まだ決めていない (段 3 と同じ)。
- 分割の途中で止まる進め方と、範囲が戻る移動を、乱択の検査の生成器に入れること。いまは決まった並びの試験だけが確かめる (上の「危険と、確かめていないこと」)。

乱択の検査。

| 検査 | seed | 組 | コード | 結果 |
|---|---|---|---|---|
| `test/history.test.ts` | 1 から 300 | sim、reference-scans、reference-full | `ffd3ca2` | 5,400 件が通り、落ちたものはない (`scripts/sweep.mjs`、1 プロセス、3 つの組を並べて 3,674 秒) |
| `test/elle-sim.test.ts` | 1 から 300 | sim、reference-scans、reference-full | `ffd3ca2` | 900 件が通り、落ちたものはない (1,621 秒) |
| `test/replay.test.ts` | 1 から 300 | sim | `ffd3ca2` | 900 件が通り、落ちたものはない |
| `test/history.test.ts` | 1 から 300 | sim | `e0e6233` | 1,800 件が通り、落ちたものはない |
| `test/elle-sim.test.ts` | 1 から 300 | sim | `e0e6233` | 300 件が通り、落ちたものはない |
| `test/replay.test.ts` | 1 から 300 | sim | `e0e6233` | 900 件が通り、落ちたものはない |

`replay` は分割を含まない (再起動と DDL はある) ので、sim の組だけで流した。

欠陥の表 (`scripts/fault-table.mjs --from 1 --to 40 --procs 3 --harness history,ddl-concurrent`、コミットした木を `git archive` で取り出して。前は `9e53efa`、後は `e0e6233`)。移動の欠陥の行だけを流し、分割を含まない `replay` は外した (前後とも同じ)。
各欄は、落ちた試験の数 / 流した seed ごとの試験の数である。

| 欠陥 | 前: history | 前: ddl-concurrent | 後: history | 後: ddl-concurrent |
|---|---|---|---|---|
| (なし) | 0/240 | 0/520 | 0/240 | 0/520 |
| `servePastMove` | 5/240 | 0/520 | 4/240 | 2/520 |
| `ignoreFence` | 82/240 | 80/520 | 79/240 | 76/520 |
| `dropIntentsOnMove` | 4/240 | 7/520 | 13/240 | 9/520 |
| `applyAfterMoved` | 0/240 | 1/520 | 0/240 | 0/520 |
| `finishWithoutClock` | 0/240 | 0/520 | 0/240 | 0/520 |
| `noRangeFloor` | 0/240 | 0/520 | 0/240 | 0/520 |
| `staleWideRead` | 0/240 | 16/520 | 0/240 | 20/520 |
| `ddlDuringMove` (新) | | | 0/240 | 6/520 |
| `moveDuringDdl` (新) | | | 0/240 | 22/520 |
| `endBeforeDrained` (新) | | | 0/240 | 4/520 |
| `pullWithoutEpoch` (新) | | | 78/240 | 80/520 |

見つけた数が減った行は 2 つで、どちらも、決まった順の再生はスイッチを入れると落ちる。
- `ignoreFence` (162 から 155)。このスイッチは所有の確かめを外す (M21 の `m21_red_owner_unchecked`、M5b の `m5b_red_s3_parent`)。外したことが答えを変えるのは、親が区間を手放した後に、古い範囲表の要求が親に届いたときだけである。段 4 では、move-start が記録されてから親がそれを適用するまで、親はスナップショットで区間を持ち、古い範囲表の要求に答えるのが正しい (M21 の、親の fence は start を適用したことである)。段 4 より前は、範囲表を切り替える前に親が fence したので、スイッチが効く期間は、それより長かった。どの seed の範囲でも、ほとんどの seed (1 から 6 の全部) で見つかる。減った理由は推し量ったもので、場面ごとには数えていない。
- `applyAfterMoved` (1 から 0)。前に見つけたのは ddl-concurrent の「CREATE UNIQUE INDEX (global) and ADD COLUMN while shards split」の seed 23 だけで (行が失われた)、後は同じ seed で通る。このスイッチは、渡したグループの phase 2 を親で適用する (M5b の `m5b_red_p2`、`_p2_window`)。答えが変わるのは、2 相の取引の intent が pull に乗り、その phase 2 が pull の後に親に届いたときだけである。段 4 では、親の fence (move-start の適用) と最初の pull が続けて起きる (子の最初の `listGroups` か `pull` が、親に適用させる) ので、fence の前に置かれて pull の後まで決着しない intent が少なくなる。これも推し量ったもので、測っていない。決まった順の再生 (`test/migration.test.ts` の「m5b_red_p2 ...」と「m5b_red_p2_window ...」) は、スイッチを入れると落ちる。

新しい 4 つのスイッチは、どれも ddl-concurrent が見つける。`pullWithoutEpoch` は、history でも見つかる (親が fence の前に行を渡し、その後の書き込みが子に届かない)。`ddlDuringMove`、`moveDuringDdl`、`endBeforeDrained` を history が見つけないのは、history の作業負荷が、最初の CREATE TABLE のほかに DDL を出さないからである。`e0e6233` の 3 つは、seed を 3 つに分けて、1 つの作業プロセスずつ流した。
`test/ddl-vs-split-race.test.ts` と `test/child-behind-parent.test.ts` は、子の受け取りを止める形に直した後 (上の「検査」) も通る。
全部の試験 (`npx vitest run --maxWorkers=3`、4 つの組) を `e0e6233` で流し、187 ファイルのうち 180 が通り 7 が飛ばされ、1,954 件のうち 1,916 件が通り、38 件が飛ばされ、落ちたものはなかった (313 秒)。workerd の組の `test/workerd.test.ts` の「a split through /admin/split」は、本物の DO で、子の DO が Meta の DO に `endMove` を送る形を通す。
