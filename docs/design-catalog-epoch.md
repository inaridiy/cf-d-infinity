# CatalogEpoch による Meta の一本化の設計

状態：設計。段 1 (列と畳み込み) を実装した (2026-11-15、末尾の「段 1 の結果」)。段 2 から段 4 の実装はまだない。モデルは M21 (`specs/m21_catalog_epoch.qnt`) にあり、結果は [specs/README.md](../specs/README.md) の M21 の節に書いた。持ち主の判断が要ることと決めたことは、「段 1 の結果」の前にまとめた。
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
動いた区間に触った文は、今と同じく `not owner:` で失敗し、利用者が取引をやり直す。

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
3. 試適用で index を 2 度作るかどうかは、段 3 で、行の多い表で測ってから決める。
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
| 取引の中の文 (`Db.begin()`、`Db.transaction(fn)`、D1 の batch の `Txn.statement`。SQL の `BEGIN` と Hrana の取引の `Db.attemptStatement`) | `not owner` を利用者へ返した。取引は自分の範囲表を持ち続けたので、動いた範囲に触る文は、取引の終わりまで断られた | `not owner` (表定義が古いという `not owner: stale schema` は除く) なら、表定義の epoch が同じで範囲表が新しいスナップショットを取り、取引の範囲表だけを取り替えて、文を計画し直す (`Txn.reroute`、3 回まで)。捨てた試みの採番は戻す。取引が名乗る表定義の epoch は変わらない。取引が溜めた書き込みの行が、新しい範囲表で別のシャードのものなら、取り替えずに競合で断る (下の 37)。`COMMIT` は計画し直す文ではないので、取り替えない |
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
| 37 (取引が分割をまたげない) | 動いた範囲に触る文と `COMMIT` が `not owner` で失敗した | 動いた行への文は新しい持ち主へ行き、`not owner` で失敗しない。`Db.begin()` の取引は、分割の前に動いた範囲を読んでも書いてもいなければ、確定まで通る。分割の前に動いた範囲に書いた取引の文は、競合で断る (下)。まだ通らない形は 2 つで、`test/open/` に残した (下) |

37 のうち、まだ通らないのは次の 2 つである。どちらも、読んだ行が変わっていなくても失敗するので、成否が置き場所で変わる。

- 分割の前に動いた範囲を読んだ取引 (`test/open/transaction-across-split.test.ts`)。その範囲を移動の時刻 m より前の時刻で読むと、子は `read too old: moved at m` で断る。取引は読み取り時刻を m へ進めようとして、それまでの読みを確かめ直す (`Txn.advance`) が、その読みは、親が移動の前の範囲表の claim で答えたものである。親は、手放した範囲を含む claim を `not owner` で断り、子は、床 m より前の時刻の確かめに答えない。誰も読みが今も成り立つとは言えないので、取引は時点を進められない。同じ取引の `COMMIT` も、溜めた読みと書き込みが親のものとして残るので、親に `not owner` で断られる。
- SQL の `BEGIN` の取引が、分割の後に動いた行を書く (`test/open/locking-transaction-commit-after-split.test.ts`)。書き込みは最新の状態で実行され、子が受ける。`COMMIT` では、子の prepare が取引の T で所有を確かめ、T は子の床より前なので、`read too old` で断る。子が持つ書き込みと読みは、どれも子が受け取った後の時刻 F から検証されるのに、所有は T で引く。

分割の前に動いた範囲に書いた取引は、範囲表を取り替えない。取り替えると、溜めた書き込みは書いたときのシャードのものとして残り、新しい持ち主へ送る文の overlay に入らない。行ロックを取る文 (SQL の `BEGIN` の書き込み、`BEGIN IMMEDIATE` の主キーの読み) は最新の状態で実行されるので、子の床にも止められず、取引自身の書き込みを見ないまま答えた (段 2 の作業の確かめで見つけた。`test/transaction-own-writes-across-split.test.ts`)。いまは、その文を競合で断る。

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
| (なし) | 後 (`b3ec805`) | 0/120 | 0/240 | 0/520 |
| `noSchemaRecheck` | 前 | 0/120 | 0/240 | 37/520 |
| `noSchemaRecheck` | 後 | 0/120 | 0/240 | 38/520 |
| `ignoreFence` | 前 | 0/120 | 82/240 | 80/520 |
| `ignoreFence` | 後 | 0/120 | 82/240 | 80/520 |
| `staleWideRead` | 前 | 0/120 | 0/240 | 16/520 |
| `staleWideRead` | 後 | 0/120 | 0/240 | 17/520 |
| `childKeepsOldSchema` | 前 | 0/120 | 0/240 | 0/520 |
| `childKeepsOldSchema` | 後 | 0/120 | 0/240 | 0/520 |

`noSchemaRecheck` と `staleWideRead` の ddl-concurrent は、落ちる seed の顔ぶれが少し変わった (同じ seed でも、計画し直しと追いつきで実行が変わる)。
`childKeepsOldSchema` は、前も後も、乱択の検査では見つからない (`docs/model-coverage.md` の「Switches that match no red module」のとおり)。
表を取ったのは `b3ec805` で、その後の `bce136d` は、計画し直した試みが最初の計画へ戻らないことと、取引自身の書き込みが動いたときに範囲表を取り替えないことを足した。

置き場所の差分の検査の「台本の途中で 1 回分割する」置き場所で、分割の後の取引の文と `COMMIT` の結果を、seed 1 から 300 で数えた (3 つの実行の形)。
取引の出し方は、`Db.begin()` (表の object)、SQL の `BEGIN` (sql)、Hrana の baton (baton) である。

| 実行 | 段 | 文: 通った | 文: `not owner` | 文: `read too old` | 文: ほかの競合 | `COMMIT`: 通った | `COMMIT`: `not owner` | `COMMIT`: ほかの競合 |
|---|---|---|---|---|---|---|---|---|
| sim | 前 | 329 | 406 | 110 | 0 | 82 | 92 | 45 |
| sim | 後 | 437 | 0 | 357 | 50 | 74 | 90 | 55 |
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

- 37 の 2 つの形 (上)。
- Hrana の baton の取引は、要求ごとに、その要求の接続の範囲表で組み立て直す (`Txn.load`) ので、分割の前に書いた行が動くと、上と同じく、行ロックを取る文が取引自身の書き込みを見ないまま答える (`test/open/baton-own-write-across-split.test.ts`)。段 2 より前のコードでも同じである。不変条件の候補: 取引の文は、取引自身の書き込みを必ず見る (見られないなら答えない)。持ち主は Worker の取引の層。
- `Db.attemptStatement` は、失敗した文の採番を、同じブロックなら無条件に戻す。worker.ts は同じ isolate の接続でブロックを共有するので、その間にほかの接続が同じブロックから取っていれば、その番号をもう一度配り、後の INSERT が主キーの UNIQUE で失敗する (`test/open/shared-rowid-block-rollback.test.ts`)。不変条件の候補: 採番した rowid は、どの接続にも 1 度しか配らない。

### 段 3 に要るもの

- Meta が `prepare`、`abort`、`of` のある `commit` を書き、シャードが `prepare` の禁止 (`open.fence`) で書き込みを断る。いまのシャードは、これらの記録を断る (`applyStep`)。`TableDef.building` と `locked` の印を、スナップショットの `open` に替える。
- `schema` を、どの記録で進めるかの持ち主の判断 6 (いまは、段 1 の `commit` の記録だけが進める)。
- `test/meta-old.ts` と `META_SHADOW` は、段 3 で消せる。比べる前に段 2 の欄を落とす関数 (`stage1Answer`、`stage1Error`) も一緒に消す。
- 移動をまたぐ読みの確かめ直しの規則 (上) は、段 3 ではなく、37 の作業である。モデルが入ってから、`Txn.advance` と、子の prepare の所有の時刻に入れる。
