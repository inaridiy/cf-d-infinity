# 移動の要求と応答が、その移動より後に届くときの規則

状態：設計。`foundation-4` に実装はまだない。モデルは M5d (`specs/m5d_move_messages.qnt`) である。実装より先に書いた (計画書の規則 3)。
作成日：2026-11-17
前提：[design-catalog-epoch.md](./design-catalog-epoch.md) の「移動の遷移」、[design-refresh-across-move.md](./design-refresh-across-move.md) の「3 回目の実装の規則」、[specs/README.md](../specs/README.md) の M5b、M5c、M5d の節。

今のコードについての記述は、`5808b08` のコードを読んだ結果である。
この作業では、試験を走らせていない。
類の場面は、読み直しが `5808b08` で試験にしたものである (類の 1 は `test/open/late-pull-after-range-returned.test.ts`。ほかは、読み直しの手元にある)。
`src/` と `test/` は `packages/cf-d-infinity/` の下を指す。

## この文書が扱う類

範囲の移動は、fence、グループの pull、ack、親が渡し終えること、子が受け取り終えること、move-end の列である。
シャードの間の要求と応答には期限がないので、どれも、その移動が閉じた後に届くことがある。
3 日の間に、3 つの欠陥 (問題 54、55、58) が、移動の要求か応答がその移動より後に届いたことで起きた。
読み直しは、同じ類の場面を 7 つ挙げた (下の「類と、モデルのインスタンス」)。
`5808b08` のコードは、7 つのどれでも誤る。

この文書は、その類を、場面ごとの直しではなく、1 つの規則で閉じる (計画書の規則 1)。
不変条件は「シャードの移動の記録は、その移動が生きている間の要求と応答だけが変える」で、持ち主は、移動の記録を書く層 (`src/shard/kernel.ts` の `pullPieces`、`ack`、`finishHanding`、`receiveStep`、`finishIncoming`) である。

[design-refresh-across-move.md](./design-refresh-across-move.md) の節にはせず、文書を分けた。
あの文書の規則は、取引が移動をまたぐときの読みと確かめのもので、持ち主は読みの経路である。
ここの規則の持ち主は移動の記録で、移動をまたぐ取引がなくても破れる (類の 2、5、6)。

この規則は、前の決まりを 1 つ置き換える。
[design-refresh-across-move.md](./design-refresh-across-move.md) の不変条件 D の最後の行と、M5c の `REHAND_FINISHED` は、親が終わった移動の pull を「断る」としていた。
ここでは、親は断らずに「渡し終えた」と答える。
断る形は、行のないグループを待っていた文を `group not arrived` で失敗させる (取り下げた直し `89d99c8`。下の条件 3)。

## 用語

- **移動の epoch**：Meta が move-start を記録した epoch。移動ごとに 1 つあり、移動の要求、piece、記録の行が運ぶ。
- **生きた記録**：その epoch の、終わっていない記録。親では `__fenced` の done = 0 の行、子では `__incoming` の done = 0 の行である。
- **渡した記録**：親が移動のために変えるもの。`__moved`、`__moved_txn`、ack で消す行と intent、`__fenced` の done。
- **受け取った記録**：子が移動のために変えるもの。入れる行と intent、`__arrived`、`__incoming` の done と m。
- **印**：メモリの `moved` (グループを渡した移動と、ack を受けたか) と `arrived` (グループが届いた移動)。phase 2 の適用と転送、pull の渡し直し、ack、所有の確かめが読む。

## 規則

1. シャードは、自分が生きた記録を持つ epoch を名指しする要求か応答でだけ、渡した記録と受け取った記録を変える。
2. ほかの epoch の要求と応答には、状態を変えずに答える。親は「渡し終えた」と、いまの時計を答える。子は応答を捨てる。
3. 子は、受け取り中の移動の「渡し終えた」を、断りではなく答えとして受け取り、そこで受け取り終える。
4. 印は、記録から 1 つの関数で作る。起動のときも、記録を書いた後も、同じ関数を使う。
5. pull の答えを待っていた文は、答えが捨てられたら、いまの受け取り中の移動で尋ね直す。

1 から 4 は、読み直しが選んだ規則である。
5 は、M5d が足した (下の「規則にない条件」)。

要求と応答ごとに書くと、次のとおりである。

| 届くもの | 受ける側 | 生きた記録があるとき | ないとき |
|---|---|---|---|
| `pull` | 親 | グループを渡し、`__moved` と `__moved_txn` を書く。同じ移動でもう渡していれば、同じ m で渡し直す | 「渡し終えた」と時計を答える。記録も印も作らない |
| `ack` | 親 | その移動で渡して ack を待つグループの、行と intent を消す | 何もしない |
| `finishMove` | 親 | 渡し終えた印 (done = 1) を付け、時計を答える | 時計を答える (今も同じ) |
| `listGroups` | 親 | 範囲のグループを挙げる。状態は変えない | 挙げるものがないと答える |
| `pull` の応答 | 子 | 行と intent を入れ、`__arrived` を書く。「渡し終えた」なら、受け取り終える | 捨てる。待っていた文は、尋ね直す |
| `finishMove` の応答 | 子 | 受け取り終える (done = 1 と m) | 何もしない |

親が終わった移動に「渡し終えた」と答えてよい理由は、親が渡し終える条件にある。
子の drain は、親のグループを列挙し直し、行か intent のあるグループを全部受け取って ack してから、`finishMove` を頼む。
だから、渡し終えた親の範囲には、行も intent も残っていない。
その後に届いた pull が名指しするグループは、もう子に届いているか、行も intent もないかである。
子は、どちらでも、受け取り終えれば答えられる (行のないグループは、到着の記録なしで、範囲の床から受け持つ)。

`listGroups` は状態を変えないので、M5d は要求として置いていない (drain が親を読む述語にした)。

## 類と、モデルのインスタンス

どの場面も、`m5d_code_*` (`5808b08` のコードの条件) の run が手順で、`m5d_green_*` の同じ名前の run が、規則の下での答えである。
「欠けている条件」の欄は、その場面の害が起きるのに、規則のどの条件が欠けている必要があるかである。
`5808b08` のコードに条件を 1 つだけ入れたインスタンスの、同じ名前の run が、場面ごとに確かめている (下の「条件を 1 つだけ入れた形」)。
シャードは 0、1、2 と呼ぶ (読み直しの s0、s2、s3)。

| 類 | 場面 | `5808b08` の手順 | 害が起きるのに欠けている条件 | 規則の下での答え |
|---|---|---|---|---|
| 1 | 運ばれなかったグループの遅れた pull が、範囲が 0 へ戻った後に届く (問題 58) | `m5d_code_return` の `member1Test`。0 は渡し直して印を残し、後の取引の phase 2 を、適用も転送もせずに受け取ったと答える | 親の規則と、印の関数 | `m5d_green_return` の `member1Test`。0 は「渡し終えた」と答え、記録も印も作らない。phase 2 は 0 で適用される |
| 2 | 同じ pull が、0 が行を確定し直した後に届く | 同 `member2Test`。0 は確定した行を 1 へ渡し直し、その ack が 0 の行を消す | 親の規則と、印の関数。印の関数があっても、子の規則がなければ、行が前の子にも入る | 同 `member2Test`。行は渡されず、ack も出ない |
| 3 | 同じ pull が、運ばれて戻ってきたグループに届く | 同 `member3Test`。`__moved` への書き込みが UNIQUE で失敗し、メモリだけの印が、後の phase 2 を適用させない | 親の規則 (書き込みの失敗)。印を書き込みより前に付けること (メモリだけの印) | 同 `member3Test`。記録を書かないので、失敗しない |
| 4 | 戻らない列 (0 → 1 → 2)。0 への遅れた pull が、移動 2 が閉じた後に届く | `m5d_code_chain` の `member4Test`。0 は空のグループを渡し直し、1 の受け取りが移動 2 の印を消す。1 は phase 2 を転送せずに答える | 親の規則、子の規則、印の関数の 3 つとも | `m5d_green_chain` の `member4Test`。1 は答えを捨て、印は残り、phase 2 は 2 へ転送される |
| 5 | 同じものが、移動 2 の pull と ack の間に届く | 同 `member5Test`。ack は数えられず、行は 1 と 2 の両方に残り、移動は閉じない。1 を再起動すると閉じる | 同上 | 同 `member5Test`。ack は数えられ、移動は閉じる |
| 6 | 生きた fence の下の pull の応答が、子がグループを受け取り直した後に届く (0 → 1 → 0 → 1) | `m5d_code_return3` の `member6Test`。1 が消した行が戻る | 子の規則 | `m5d_green_return3` の `member6Test`。1 は捨てる |
| 7 | 生きた fence の下で渡した空のグループの応答が、子が受け取り終えた後に届く | `m5d_code_chain` の `member7Test`。到着の記録が後から付き、移動 2 の印が消えて、1 は phase 2 を転送せずに答える | 子の規則 (後からの到着の記録)。印の関数も欠けていると、phase 2 が適用されない | `m5d_green_chain` の `member7Test`。1 は捨て、到着の記録は付かない |

TLC は、`m5d_code_return` の `deliveredApplied` の反例として、類の 1 の手順を見つけた。

## 条件、赤、スイッチ

緑 (`m5d_green_*`) は、条件を全部満たす。
赤は、条件を 1 つ外すか、`5808b08` のコードに条件を 1 つだけ入れた形である。
「害」は、行、intent、印、文の断りのどれかが誤ること (`m5dOutcome`) で、「規則だけ」は、生きた記録のない移動で記録を変えたこと自体 (`handsUnderFence`、`receivesUnderIncoming`) である。

| 条件 (定数) | 外したインスタンス | 破れる不変条件 | スイッチ |
|---|---|---|---|
| 1 と 2 の親の側。親は、生きた fence の下の pull でだけ渡す (`PARENT_RULE`) | `m5d_red_rehand` | `handsUnderFence` (規則だけ) と `noFailedWrite` (類の 3 の、UNIQUE の失敗)。行、intent、印は壊れない (`m5dData` は緑) | `rehandFinished` |
| 同上。親は、生きた fence の下の ack でだけ消す (`ACK_RULE`) | `m5d_red_late_ack` | `handsUnderFence` (規則だけ)。害はない (`m5dOutcome` は緑) | なし (下の「ack」) |
| 1 と 2 の子の側。子は、受け取り中の移動の応答でだけ受け取る (`CHILD_RULE`) | `m5d_red_child_stale` | `ownerHasTruth`、`receivesUnderIncoming`。`ownerHasTruth` を破る道は 2 つある。類の 6 (run の `member6Test`。消した行が戻る) と、移動 1 の遅れた「渡し終えた」が、同じ範囲の移動 3 の受け取りを終える道 (`closeEarlyTest`。TLC の反例はこちら) である | `childAcceptsStale` |
| 3。「渡し終えた」は答えである (`FINISHED_ANSWERS`) | `m5d_red_finished_refusal` | `noMoveRefusal` (行のないグループの文が `group not arrived` で断られる)。行と印は壊れない | `finishedAsRefusal` |
| 4。印は、記録の書き込みの後で付ける (`MARKS` = 2 が外した形) | `m5d_red_mark_before_write` (親の規則も外す) | `markMatchesRecord` (類の 3 の、メモリだけの印)、`deliveredApplied` | `markBeforeWrite` |
| 4。動いている間も、起動のときと同じ関数で印を作る (`MARKS` = 1 が外した形) | `m5d_red_boot_differs` (親の規則も外す) | `marksDerived`、`deliveredApplied` (類の 1)。`markMatchesRecord` は緑 | `bootMarksDiffer` |
| 5。捨てられた答えの後で尋ね直す (`ASK_AGAIN`) | `m5d_red_ask_once` | `noMoveRefusal`。行と印は壊れない | なし (下の「規則にない条件」) |

### 条件を 1 つだけ入れた形

`5808b08` のコード (`m5d_code_return`、`m5d_code_chain`、`m5d_code_return3`) は、条件を 1 つも満たさず、類の 1 から 7 が全部起きる。
破れる不変条件は、`deliveredApplied`、`noLostWrite`、`ownerHasTruth`、`rowsOnlyAtOwner`、`ackWillLand`、`markMatchesRecord`、`noFailedWrite` と、活性の `movesClose` である (`noLostWrite`、`rowsOnlyAtOwner`、`noFailedWrite` は run が、ほかは `check.sh` の TLC の行が確かめる)。

このコードに、条件を 1 つだけ入れた形を 3 つ流した。
欄は、類ごとの run の結果である。

| 類 | 親の規則だけ (`m5d_code_parent_rule`、`_parent_rule_return`、`_parent_rule3`) | 子の規則だけ (`m5d_code_child_rule`、`_child_rule_chain`、`_child_rule3`) | 印の関数だけ (`m5d_code_derived_return`、`_derived_chain`、`_derived_return3`) |
|---|---|---|---|
| 1 | 起きない | 残る | 起きない。渡し直しの記録は付くが、印は付かない |
| 2 | 起きない | 残る。子は、捨てた応答にも ack を送る (`fetchStep` の形) | 持ち主の行は消えないが、行が前の子にも入る |
| 3 | 起きない | 残る | 書き込みの失敗だけが残る |
| 4 | 起きない | 起きない | 起きない。到着の記録は後から付くが、移動 2 の印は消えない |
| 5 | 起きない | 起きない | 起きない |
| 6 | 残る | 起きない | 残る |
| 7 | 残る | 起きない | 到着の記録は後から付くが、印は消えず、phase 2 は転送される |

親の規則だけでは、6 と 7 が残る (`m5d_code_parent_rule` の `deliveredApplied`、`m5d_code_parent_rule3` の `ownerHasTruth`)。
どちらも、親が生きた fence の下で正しく渡した応答が、遅れて届く場面である。
類の 4 と 5 の害 (phase 2 が転送されない、ack が数えられない) も、渡し直しがなくても、類の 7 の道から起きる (`m5d_code_parent_rule` の `deliveredApplied` と `ackWillLand`)。
子の規則だけでは、1 から 3 が残る (`m5d_code_child_rule` の `deliveredApplied` と `ownerHasTruth`)。
戻らない列では、子の規則だけでも、印の関数だけでも、行と印は壊れない (`m5d_code_child_rule_chain` と `m5d_code_derived_chain` の `m5dData` は緑)。

類の 7 つは、類の全部ではない。
TLC は、印の関数だけの形 (`m5d_code_derived_return`) で、表にない順序を 2 つ見つけた。
1 つは、類の 2 の pull が、戻る移動 (移動 2) がまだ閉じていない間に届く順序である (`ackWillLand`)。
0 は、移動 2 で届いたグループに行を書いた後で、その行を移動 1 の子 (1) へ渡し直す。
1 は移動 2 の親で、もう ack を受けているので、入った行は消されず、移動 2 は閉じない。
もう 1 つは、渡し直しが 2 回続く順序である (`ownerHasTruth`)。
0 が、書いた行を 1 へ渡し直し、1 は、移動 2 の遅れた pull に、その行を 0 へ渡し直す。
その間に 0 が行を消していると、消した行が 0 に戻る。
緑のインスタンスは、決まった場面ではなく、全部の順序を探索しているので、これらの順序も含む。

### 条件 4 は、規則が 2 つともあれば破れない

親の規則と子の規則があり、ack も生きた fence の下でだけ数えるなら、印を `5808b08` のとおりに書き換えても (手ごとに書き換え、書き込みより前に付ける)、どの不変条件も破れない (`m5d_marks_return`、`m5d_marks_chain`、`m5d_marks_return3` の `m5dSafe`)。
状態の数も、緑と同じである。
つまり、生きた記録の下の書き換えは、関数が作る印と同じ印を作る。
だから、スイッチ `markBeforeWrite` と `bootMarksDiffer` は、それだけを入れても、どの試験も落ちない。
落ちることを確かめるには、`rehandFinished` と一緒に入れる (類の 1 と 3 の手順)。

それでも条件 4 を規則に入れる理由は、規則の 1 と 2 が破れたときの害の大きさである。
親の規則だけを外した `m5d_red_rehand` では、印の関数が、渡し直しの記録から印を作らないので (範囲を受け取り終えているので、印は外れる)、行も intent も壊れない。
印を手ごとに書き換える形では、同じ渡し直しが、確定した書き込みを失わせる (類の 1)。

### ack

読み直しの試作 (`m5d_prototype_*`) は、ack を `5808b08` のままにしている (印の移動と ack の移動が合えば、終わった fence の下でも行を消す)。
モデルでは、この形に害はない (`m5d_red_late_ack` と `m5d_prototype_return`、`m5d_prototype_chain` の `m5dOutcome` は緑)。
終わった fence の下で、ack を待つ印が残るのは、親が渡し終える直前に空のグループを渡したときだけで、消す行がないからである。
実装は、ack も同じ入口を通す (下の「実装がすること」の 1)。
通さない理由がなく、通せば、この議論に頼らずに済む。

### 規則にない条件

読み直しの試作は、規則の 1 から 3 を入れ、文は `5808b08` のとおり 1 回だけ尋ねる (`arriveStep` は、pull の答えが返ると、届いたかどうかを見ずに進む)。
この形は、範囲が戻って、もう一度出る列 (0 → 1 → 0 → 1) で、文を `group not arrived` で断る (`m5d_prototype_return3` と `m5d_red_ask_once` の `noMoveRefusal`。TLC の反例も、下の手順である)。

1. 移動 1 の間に、1 の文が、行のないグループを on-demand で pull する。要求は遅れる。
2. 移動 1 が閉じ、範囲は移動 2 で 0 へ戻り、移動 3 で、また 1 へ出る。1 は、移動 3 を受け取り中である。
3. 遅れた pull が 0 に届く。0 は「渡し終えた」と答える。
4. 答えが 1 に届く。移動 1 は受け取り中ではないので、1 は捨てる。待っていた文は、同期区間に入る。グループは、移動 3 ではまだ届いていないので、`group not arrived` で断られる。

断られる理由は移動だけなので、計画書の規則 4 に反する。
規則の 1 から 3 は、行と印は守る (`m5d_prototype_return3` の `m5dData` は緑)。
閉じるのは条件 5 で、文は、答えを受けた後も、受け取り中の範囲のグループが届いていなければ、いまの移動で尋ね直す (`m5d_green_return3` の `askAgainTest`)。
尋ね直す回数は、移動の数で抑えられる。受け取り中の移動の答えは、いつもグループを届かせるか、受け取り終えさせるからである (`noMoveRefusal` が、緑でこれを確かめる)。

この場面は、コードで走らせていない。
モデルと、`arriveStep` と `fetchStep` を読んだ結果である。

## 実装がすること

行の番号は `5808b08` のものである。

1. **記録を書く関数の入口**。渡す側と受け取る側に、入口を 1 つずつ置く。同期区間の `enter()` と `Section` (`kernel.ts:242`、`:1215`) と同じ形で、入口だけが印 (型の値) を作り、記録を書く関数は、その印を引数に取る。
   - 渡す側の入口は、移動の epoch を受け取り、その epoch の `__fenced` が done = 0 なら印を返し、done = 1 なら「渡し終えた」を返す。印を取る関数は、グループを渡すこと (`pullPieces` の `__moved` と `__moved_txn` への書き込み、`:2931`)、ack で行と intent を消すこと (`ack`、`:1325`)、渡し終えた印を付けること (`finishHanding`、`:1344`) である。
   - 受け取る側の入口は、移動の epoch を受け取り、その epoch の `__incoming` が done = 0 なら印を返し、そうでなければ何も返さない。印を取る関数は、行と intent を入れて `__arrived` を書くこと (`receiveStep`、`:3005`) と、受け取り終えること (`finishIncoming`、`:1365`) である。
   - `finishIncoming` は、いまは区間で受け取りを引く (`:1367`)。epoch で引く。区間で引くと、移動 1 の遅れた「渡し終えた」が、同じ範囲の移動 3 の受け取りを終えてしまう (`m5d_red_child_stale` の `closeEarlyTest`)。
2. **4 つの要求の `epoch` を必須にする** (`src/types.ts:367` から `:384` の `listGroups`、`pull`、`finishMove`。`ack` は piece ごとに epoch を運ぶ)。`fenceOf` (`:1253`) の、epoch がなければ区間の終わっていない fence を引く枝を消す。試験が直に送る要求も epoch を運ぶ。
3. **「渡し終えた」の答え**。`pull` の応答に、渡し終えたことと、親がいま発行した時刻を載せる (試作は `PiecePayload` に `finished` を足した)。子は、受け取り中の移動のものなら、その時刻で受け取り終える。親の `finishMove` の応答と同じ扱いである (M5b の `FINISH_CARRIES_CLOCK`)。
4. **印の関数**。次の関数を 1 つ置き、起動のとき (`:824` から `:839`) と、1 の関数が記録を書いた後に呼ぶ。印を、ほかの場所で書き換えない (`pullPieces` の `moved.set`、`ack` の `acked = true`、`receiveStep` の `arrived.set` と `moved.delete`、`finishIncoming` の `unmarked` の繰り返しを消す)。
   - 到着の印は、そのグループの `__arrived` の行のうち、epoch のいちばん大きいものである。
   - 「渡した」印は、そのグループの `__moved` の行のうち、epoch のいちばん大きいものである。ただし、それより大きい epoch の `__arrived` の行があるか、それより大きい epoch の、終えた `__incoming` の行がグループを含むなら、印はない。
   - これは、いまの起動のときの作り方と同じである。M5d の `dMark` と `dArr` が、この関数である。
5. **尋ね直し** (`arriveStep`、`:2845`)。pull の答えが返った後、頼んだグループのうち、受け取り中の範囲にあって、まだ届いていないものがあれば、もう一度 pull を出す。なければ進む。
6. **子が捨てた応答に ack を送らない** (`fetchStep`、`:2973`)。入れたか、もう届いていた piece にだけ ack を送る。モデルは、捨てた応答にも ack を送る形で緑なので、これは安全のためではなく、要らない要求を減らすためである。
7. **スイッチ**。`rehandFinished`、`childAcceptsStale`、`finishedAsRefusal`、`markBeforeWrite`、`bootMarksDiffer` を足す。`markBeforeWrite` と `bootMarksDiffer` は、入口を通らずに印を書き換える枝で、`rehandFinished` と一緒に入れて落ちることを確かめる。
8. **試験**。モデルの run を、決まった順の試験にする (計画書の規則 2)。類の 1 は `test/open/late-pull-after-range-returned.test.ts` にあり、通るようになったら `test/` へ移す。読み直しは、ほかの類と、行のないグループの窓 (`windowTest`) の試験を手元に持っている。尋ね直しの場面 (`askAgainTest`) と、区間で引く `finishIncoming` の場面 (`closeEarlyTest`) は、このモデルが見つけたもので、試験がまだない。

## M5d が確かめていないこと

- 時計。pull の m、「渡し終えた」が運ぶ時刻、範囲の床は、M5b が扱う。M5d は、行の値と記録だけを持つ。
- M5b の `finishRange` は、渡したグループが全部届いていることを条件にしている。親が渡し終える直前に、空のグループを on-demand の pull で渡すと、その応答は、子が受け取り終えた後に届く。M5d の規則では、子は、このグループを到着の記録なしで受け持つ。M5b は、この形を置いていない。`finishRange` をこの形に緩めた写しを手元で流すと、M5b の緑は成り立った (`specs/README.md` の M5d の節の「M5b の前提」)。M5b の本体は、書き換えていない。
- 表定義の変更と、epoch の列の適用。M5d は、move-start を、親と子が同時に適用するものとして置いた (M21 が、親が要求の epoch まで適用してから答えることを確かめている)。
- phase 2 の要求の喪失と再送、取引が 2 つ以上あること、abort の転送。phase 2 の要求は、受け取り中でグループが届いていなければ、届くまで待つものとして置いた (M5c と同じ)。
- グループを piece に分けて運ぶ形 (M18、M19)。
- グループが 2 つの形は、取引を置いて持ち主の書き込みと再起動を外した形 (既定) と、持ち主の書き込みを置いて取引と再起動を外した形 (`HEAVY=1`) で確かめた。3 つを全部置いた形は、状態が多く、流していない。
- 範囲が 3 回動く列は、0 → 1 → 0 → 1 と 0 → 1 → 2 → 0 を確かめた。前者に取引を置いた形と、後者は、再起動を外してある (`HEAVY=1`)。

## 持ち主の判断が要ること

1. **尋ね直しを入れるか** (条件 5)。
   - 案 A：入れる (`arriveStep` を、届くまで尋ね直す形にする)。
   - 案 B：入れない。文が、範囲の 2 回の移動をまたいで待った後に、3 回目の移動の受け取りの途中で `group not arrived` (やり直してよい競合) で断られる。対話的な取引では、ORM に `SQLITE_BUSY` が届く。
   - 推奨は案 A である。案 B は、置き場所だけが理由の失敗で、規則 4 に反する。変更は `arriveStep` の 1 か所で、尋ね直す回数は移動の数で抑えられる。
   - piece を運ぶ phase 2 と abort の要求 (`finalizeStep`、`abortStep`) も、同じ `arriveStep` を通る。M5d は、この要求を、グループが届くまで待つものとして置いた (M5c と同じ)。案 A は、モデルが前提にしたこの形に、コードを合わせることにもなる。1 回だけ尋ねて進む形の phase 2 は、モデルでは確かめていない。
2. **前の決まりの書き換え**。[design-refresh-across-move.md](./design-refresh-across-move.md) の不変条件 D の最後の行 (「終わった移動の遅れた pull を断り」) と、`specs/README.md` の M5c の節の「緑では、終わった移動の pull を断る」を、「答える」に直す。この作業は、その 2 か所を書き換えていない (書いてよいのは、この文書と、M5d の行だけだった)。
3. **M5b の `finishRange` を緩めるか**。M5b は、渡したグループが全部届いてから範囲の移動を終える。コードの親は、行と intent が残っていなければ渡し終えるので、空のグループを渡した応答が飛んでいる間に終えることがある。
   - 案 A：M5b の本体を、緩めた形にする (子は、渡されたが届いていない空のグループも、到着の記録なしで受け持ち、飛んでいる応答を捨てる)。手元の写しでは、`m5b_green_range`、`m5b_green_floor_clock`、`m5b_green_floor_resplit` が成り立った。取引 X を入れた `HEAVY` の 2 つは流していない。
   - 案 B：M5b はそのままにし、確かめたことを M5d の節に残す (いまの状態)。
   - 推奨は案 A である。変更は `finishRange` の条件と、子が受け持つグループの集合だけで、モデルの終える条件が、コードの親の条件と同じになる。入れるときに、M5b の行を `HEAVY=1` で流し直す。
