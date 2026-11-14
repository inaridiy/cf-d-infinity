# CatalogEpoch による Meta の一本化の設計

状態：設計。実装はまだない。モデルは M21 (`specs/m21_catalog_epoch.qnt`) にあり、結果は [specs/README.md](../specs/README.md) の M21 の節に書いた。持ち主の判断が要ることを末尾にまとめた。
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
| 逆操作 | なくなる。`abort` は禁止を解き、`prepare` が作った空の index の表を名前で消すだけである |
| 止まった進め方 | DDL は、`commit` の記録までなら Meta が期限 (5 秒、上限 5 分) で `abort` を記録する。移動は、`move-start` の後は子が自分で進める |
| 未解決の問題 17 | 主キーを名指しする読みと書きについて、窓がなくなる。全表の読みは、移動が終わるまで `migrating:` のままである |
| 段 | 4 段。列と畳み込み、要求が epoch を運ぶ、DDL の 2 相化、移動 |

提案 (`.agents/execplans/evidence/2026-11-14-clean-slate-architecture.md` の 3) から、4 点ずれる。

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
M21 は、最新の epoch で計画した要求を、その epoch の持ち主が、版や所有の理由で断らないこと (`servable`) を、進める側がどこで止まっても確かめた。
今の手順 (fence が先) は、同じ不変条件を 3 手で破る (`m21_red_fence_first`)。

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
- 行で失敗し得る DDL (`CHECK` の場面) は、古い `schema` の要求を断らなくても、待ちの後で確かめ直さなくても、`commit` を適用できる (`m21_check_no_reject`)。守っているのは、書き込み禁止と、適用した後の表そのもの (SQLite が制約を確かめる) である。版の確認が要るのは、計画の作り方が変わる DDL (index) である。
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
6. **モデルの扱い**。実装が入った時点で、M12、M14、M15 は M21 が置き換える。M11 (2PC の取引と DDL) と M13 (取引の中の DDL の順序) は残す。M21 は、この 2 つの赤のうち Meta の仕組みに依るもの (`m11_red_no_sync`、`m11_red_no_reject`、`m13_red_repin` など) を写したが、全部は写していない。
