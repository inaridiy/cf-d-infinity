// M5d: 移動の要求と応答が、その移動より長く生きる (未解決の問題 54、55、58 と、その類)
//
// 2026-11-17 に書いた。実装より先に書いたモデルである (計画書の規則 3)。
// シャードの間の要求と応答には期限がない。3 日で 3 つの欠陥 (問題 54、55、58) が、移動の要求か応答が、その移動より後に届いたことで
// 起きた。読み直しが、同じ類を 7 つ挙げた (下の「類」)。M5c (m5c_phase2_return.qnt) は、類の 1 つ (終わった移動の遅れた pull) を
// 1 手 (stalePull) で置いたが、子の側がなく、移動を終える手が 1 つで、グループはいつも運ばれ、シャードは 2 つで、再起動がない。
//
// 確かめる規則。
//   シャードは、自分が生きた記録を持つ移動の epoch を名指しする要求か応答でだけ、渡した記録と受け取った記録を変える。親では
//   __fenced の done = 0、子では __incoming の done = 0 が、生きた記録である。ほかの epoch には、状態を変えずに答える。親は
//   「渡し終えた」と時計を答え、子は応答を捨てる。子は「渡し終えた」を断りではなく答えとして受け取り、そこで受け取り終える。
//   メモリの印 (moved、arrived) は、記録から 1 つの関数で作る。起動のときも、動いている間も、同じ関数を使う。
//
// 舞台。シャード 3 つ (0、1、2)。ROUTE が移動の列を決める (移動 i は ROUTE[i-1] から ROUTE[i] へ)。範囲は 1 つで、移動は重ならない
// (Meta の moves-overlap)。グループは GROUPS_N 個で、初めに行を持つのは FULL のグループである。行も intent もないグループは運ばれない。
//   記録 (SQLite)    pdone (__fenced の done)、cdone (__incoming の done)、hrec (__moved: 0 なし、1 渡した、2 ack 済み)、
//                    mtxn (__moved_txn)、arec (__arrived)
//   メモリの印        mark (kernel.ts の moved)、arr (arrived)
//   飛んでいるもの    pullReq (pull の要求)、pullResp (pull の応答)、acks (ack)。どれも集合で、届けても消さない。同じ要求を出す文は
//                    いくつもあり得るので、移動の後のいつでも、何度でも届く。消すのは再起動だけである (下の restart)
// 移動の手。
//   start         移動の move-start を Meta が記録し、親と子が適用する (親は __fenced に、子は __incoming に行を足す)
//   sendPull      子が pull を送る。受け取り中で、グループがまだ届いていないとき (drain と、文の on-demand の pull)
//   deliverPull   親に pull が届く。生きた fence の下なら、行と intent を応答に載せ、記録と印を付ける。同じ移動でもう渡していれば、同じ
//                 ものを渡し直す。終わった fence の下では、規則のとおりなら「渡し終えた」と答える
//   deliverResp   子に応答が届く。受け取り中の移動のものなら、行と intent を入れて到着を記録し、ack を送る。「渡し終えた」なら、そこで
//                 受け取り終える。受け取り中でない移動の応答は捨てる (kernel.ts の fetchStep と同じく、ack は送る)
//   deliverAck    親に ack が届く。生きた fence の下で、その移動で渡して、まだ ack されていないグループの行と intent を消す
//   parentFinish  親が渡し終える (finishHanding)。子の drain が、親に行も intent も残っていないことを見た後である
//   childFinish   子が受け取り終える (finishIncoming)。運ばれなかったグループを、到着の記録なしで受け持つ
//   moveEnd       Meta が move-end を記録する。次の移動は、この後でだけ始まる
//   restart       シャードが再起動する。印を記録から作り直す。そのシャードへの応答は消え (待っていた手続きがない)、そのシャードが
//                 送った pull は、親には届くが、応答の届け先がない (dead)。回数は RESTARTS まで
// 持ち主 (範囲表で範囲を持つシャード) は、行を書き (ownerPut)、消す (ownerDel)。取引 Y は、いつでも、そのときの持ち主で intent を置いて確定する
// (beginY)。M5c の Y (移動の前に S0 で prepare した) は、最初に beginY を取る場合である。phase 2 (handle、complete)、gc、resolve は
// M5c と同じ形である。
//
// 規則の条件 (定数)。緑は全部を満たす。
//   PARENT_RULE       親は、生きた fence の下の pull でだけ、グループを渡す (記録と印を付ける)。終わった fence の pull には
//                     「渡し終えた」と答える。false は 5808b08 のコード (終わった fence の下でも渡し直す。スイッチ rehandFinished)
//   ACK_RULE          親は、生きた fence の下の ack でだけ、渡した行と intent を消す。false は 5808b08 のコードと、読み直しの試作
//                     (印の移動と ack の移動が合えば、終わった fence の下でも消す)
//   CHILD_RULE       子は、受け取り中の移動の応答でだけ、受け取った記録を変える。false は 5808b08 のコード (到着の記録の epoch が
//                     違えば入れる。スイッチ childAcceptsStale)
//   FINISHED_ANSWERS  子は「渡し終えた」を答えとして受け取り、そこで受け取り終える。false は取り下げた直し (89d99c8。断りとして読み飛ばし、
//                     待っていた文は group not arrived で断られる。スイッチ finishedAsRefusal)
//   MARKS             印の作り方。0 は、記録から 1 つの関数 (dMark、dArr) で作る。1 は、動いている間は手ごとに書き換え、起動のとき
//                     だけ関数で作る (スイッチ bootMarksDiffer)。2 は、1 に加えて、渡した印を記録の書き込みより前に付け、書き込みが
//                     失敗しても残す (5808b08 のコード。スイッチ markBeforeWrite)
//   ASK_AGAIN         pull の答えを待っていた文は、答えが捨てられたら、いまの受け取り中の移動で尋ね直す。false は 5808b08 のコード
//                     (arriveStep は 1 回だけ尋ねる)。上の規則にはない条件で、このモデルが見つけた (下の m5d_red_ask_once)
//
// 類 (読み直しが挙げた 7 つ)。どれも 5808b08 のコードで起きる。m5d_code_* の run が手順で、m5d_green_* の同じ名前の run が、緑での答えである。
//   1. 運ばれなかったグループの遅れた pull が、範囲が戻った後に届く。親は渡し直して印を残し、後の取引の phase 2 を適用も転送もせずに答える
//   2. 同じ pull が、持ち主が行を確定し直した後に届く。渡し直しの ack が、持ち主の確定した行を消す
//   3. 同じ pull が、運ばれて戻ってきたグループに届く。記録の書き込みが UNIQUE で失敗し、メモリだけの印が後の phase 2 を適用させない
//   4. 戻らない列 (0 → 1 → 2)。0 への遅れた pull が空のグループを渡し直し、1 の受け取りが移動 2 の印を消す。1 は phase 2 を転送せずに答える
//   5. 同じものが、移動 2 の pull と ack の間に届く。ack は数えられず、行は 1 と 2 の両方に残り、移動は閉じない
//   6. 生きた fence の下の pull の応答が、子がそのグループを受け取り直した後に届く。消した行が戻る。親の側の規則だけでは止まらない
//   7. 応答が、子が受け取り終えた後に届く。グループに、後からの到着の記録が付く
//
// invariant (m5dSafe)
//   deliveredApplied、noLostWrite、finalValue、boundedForwards、handsUnderFence   M5c のもの
//   receivesUnderIncoming  子が受け取った記録を変えるのは、その移動を受け取り中の間だけである
//   rowsOnlyAtOwner        行と intent は、持ち主か、終わっていない fence の親にだけある
//   ownerHasTruth          持ち主が答えるグループの行は、確定した書き込みのとおりである (消した行が戻らない。確定した行が消えない)
//   ackWillLand            子に届いたグループの行を親がまだ持っているなら、親は、その移動の、ack を待つ印を持っている (ack が数えられる)
//   noMoveRefusal          移動だけが原因で、文が group not arrived で断られない
//   noFailedWrite          移動の記録と、運んだ行の書き込みは失敗しない (__moved の UNIQUE にも、行の主キーにも当たらない)
//   marksDerived           メモリの印は、記録から関数で作ったものに等しい
//   m5dData は、行と intent と印の不変条件 (M5c の 4 つ、rowsOnlyAtOwner、ownerHasTruth、ackWillLand、marksDerived)。m5dOutcome は、
//   それに noMoveRefusal と noFailedWrite を足したもの。m5dSafe は、さらに handsUnderFence と receivesUnderIncoming (規則そのもの) を足す
// temporal (m5dLive)
//   どの移動も閉じる。始めた取引の phase 2 は、いつか届け終わる
//
// 形の定数。ROUTE は移動の列、GROUPS_N はグループの数、FULL は初めに行を持つグループ、TXN は取引 Y を置くか、OWNER_OPS は持ち主の
// 書き込みと削除を置くか、RESTARTS は再起動の回数の上限である。
//
// 置いていないこと。時計 (pull の m、「渡し終えた」が運ぶ親の時計、範囲の床) は M5b が扱う。表定義と epoch の列の適用は M21 が扱う
// (親は move-start を適用してから答えるので、start を 1 手にした)。phase 2 の要求は、再起動で失われない (再送は M5b と M17)。
// グループは 1 つの piece で動く (M18)。
module m5d_core {
  const PARENT_RULE: bool
  const ACK_RULE: bool
  const CHILD_RULE: bool
  const FINISHED_ANSWERS: bool
  const MARKS: int
  const ASK_AGAIN: bool
  const ROUTE: List[int]
  const GROUPS_N: int
  const FULL: Set[int]
  const TXN: bool
  const OWNER_OPS: bool
  const RESTARTS: int

  pure val SHARDS = Set(0, 1, 2)
  pure val MOVES_N = ROUTE.length() - 1
  pure val MOVES = 1.to(MOVES_N)
  pure val GROUPS = 1.to(GROUPS_N)
  pure def src(i: int): int = ROUTE[i - 1]
  pure def dst(i: int): int = ROUTE[i]
  // (シャード, グループ) と (移動, グループ)
  pure val KEYS = tuples(SHARDS, GROUPS)
  pure val HANDS = tuples(MOVES, GROUPS)
  // 行の値。NONE は行がない。0 は 1 シャードの文が書いた値 (初めの行と ownerPut)、1 は取引 Y が書いた値
  pure val NONE = -1
  // 転送の上限 (M5c と同じ)
  pure val CAP = MOVES_N + 2
  pure val PENDING = 0
  pure val WAITING = 1
  pure val DONE = 2

  // 「渡した」印。e は渡した移動で、0 は印なし
  type Mark = { e: int, acked: bool }
  type PullReq = { i: int, g: int, dead: bool }
  // fin は「渡し終えた」の答え
  type PullResp = { i: int, g: int, row: int, carry: bool, fin: bool }
  type Req = { at: int, pieces: int, st: int, child: int }
  pure val NOMARK: Mark = { e: 0, acked: false }

  // ---- Meta ----
  var started: int
  var ended: int
  // ---- 記録 ----
  var pdone: int -> bool
  var cdone: int -> bool
  var hrec: (int, int) -> int
  var mtxn: Set[(int, int)]
  var arec: Set[(int, int)]
  // ---- メモリの印 ----
  var mark: (int, int) -> Mark
  var arr: (int, int) -> int
  // ---- 行と intent ----
  var row: (int, int) -> int
  var intent: (int, int) -> bool
  // 持ち主が答えるはずの値 (確定して適用した、いちばん新しい書き込み)
  var base: int -> int
  // ---- 飛んでいるもの ----
  var pullReq: Set[PullReq]
  var pullResp: Set[PullResp]
  var acks: Set[(int, int)]
  // ---- 取引 Y (M5c) ----
  // Y が書くグループ。0 は、まだ始めていない
  var tg: int
  var reqs: List[Req]
  var record: bool
  var applied: bool
  var lost: bool
  var overflow: bool
  // ---- 見るための印 ----
  var staleHand: bool
  var staleRecv: bool
  var refused: bool
  var writeFailed: bool
  var restarts: int

  // ---- 印を記録から作る関数 (規則の 2 つ目の段落) ----
  pure def maxOf(s: Set[int]): int = s.fold(0, (a, x) => if (x > a) x else a)
  // 到着の印: そのシャードの到着の記録のうち、いちばん新しい移動
  pure def dArr(arecV: Set[(int, int)], s: int, g: int): int =
    maxOf(MOVES.filter(i => dst(i) == s and arecV.contains((i, g))))
  // 「渡した」印: そのシャードがいちばん新しく渡した移動。その後で、グループが届き直したか (到着の記録)、範囲を受け取り終えていれば
  // (終えた __incoming)、印はない (kernel.ts の unmarked)
  pure def dMark(hrecV: (int, int) -> int, arecV: Set[(int, int)], cdoneV: int -> bool, s: int, g: int): Mark = {
    val e = maxOf(MOVES.filter(i => src(i) == s and hrecV.get((i, g)) > 0))
    val back = dArr(arecV, s, g) > e or MOVES.exists(j => j > e and dst(j) == s and cdoneV.get(j))
    if (e == 0 or back) NOMARK else { e: e, acked: hrecV.get((e, g)) == 2 }
  }
  pure def dMarks(hrecV: (int, int) -> int, arecV: Set[(int, int)], cdoneV: int -> bool): (int, int) -> Mark =
    KEYS.mapBy(k => dMark(hrecV, arecV, cdoneV, k._1, k._2))
  pure def dArrs(arecV: Set[(int, int)]): (int, int) -> int = KEYS.mapBy(k => dArr(arecV, k._1, k._2))

  action init = all {
    started' = 0, ended' = 0,
    pdone' = MOVES.mapBy(_ => false), cdone' = MOVES.mapBy(_ => false),
    hrec' = HANDS.mapBy(_ => 0), mtxn' = Set(), arec' = Set(),
    mark' = KEYS.mapBy(_ => NOMARK), arr' = KEYS.mapBy(_ => 0),
    row' = KEYS.mapBy(k => if (k._1 == ROUTE[0] and FULL.contains(k._2)) 0 else NONE),
    intent' = KEYS.mapBy(_ => false),
    base' = GROUPS.mapBy(g => if (FULL.contains(g)) 0 else NONE),
    pullReq' = Set(), pullResp' = Set(), acks' = Set(),
    tg' = 0, reqs' = [], record' = false, applied' = false, lost' = false, overflow' = false,
    staleHand' = false, staleRecv' = false, refused' = false, writeFailed' = false, restarts' = 0,
  }

  // 範囲表で範囲を持つシャード
  def owner: int = if (started == 0) ROUTE[0] else dst(started)
  def liveFence(i: int): bool = i <= started and not(pdone.get(i))
  def liveIncoming(i: int): bool = i <= started and not(cdone.get(i))
  // d が受け取り中の移動 (移動は重ならないので、高々 1 つ)
  def receiving(d: int): Set[int] = MOVES.filter(j => liveIncoming(j) and dst(j) == d)
  // d が受け取り中で、グループがまだ届いていない (kernel.ts の notOwned の 2: group not arrived)
  def unarrived(d: int, g: int): bool = receiving(d).exists(j => arr.get((d, g)) != j)
  def serves(d: int, g: int): bool = d == owner and not(unarrived(d, g))
  def holds(s: int, g: int): bool = row.get((s, g)) != NONE or intent.get((s, g))
  // 親が listGroups で挙げるグループ: 行か intent か、この移動の印があり、この移動で渡して ack を受けたものではない
  def listed(i: int, g: int): bool = {
    val k = mark.get((src(i), g))
    (holds(src(i), g) or k.e == i) and not(k.e == i and k.acked)
  }
  def yg: int = if (tg > 0) tg else 1
  def delivered: bool = tg > 0 and reqs[0].st == DONE

  action keepMeta = all { started' = started, ended' = ended }
  action keepRecs = all { pdone' = pdone, cdone' = cdone, hrec' = hrec, mtxn' = mtxn, arec' = arec }
  action keepMarks = all { mark' = mark, arr' = arr }
  action keepData = all { row' = row, intent' = intent, base' = base }
  action keepMsgs = all { pullReq' = pullReq, pullResp' = pullResp, acks' = acks }
  action keepTxn = all { tg' = tg, reqs' = reqs, record' = record, applied' = applied, lost' = lost, overflow' = overflow }
  action keepSeen = all { staleHand' = staleHand, staleRecv' = staleRecv, refused' = refused, writeFailed' = writeFailed }
  action keepBoot = restarts' = restarts

  // ---- 移動 ----
  action start(i: int): bool = all {
    i <= MOVES_N, started == i - 1, ended == i - 1,
    started' = i, ended' = ended,
    keepRecs, keepMarks, keepData, keepMsgs, keepTxn, keepSeen, keepBoot,
  }

  // 子が pull を送る。受け取り中で、グループがまだ届いていないとき (drain か、文の on-demand の pull)
  action sendPull(i: int, g: int): bool = all {
    liveIncoming(i), arr.get((dst(i), g)) != i,
    not(pullReq.contains({ i: i, g: g, dead: false })),
    pullReq' = pullReq.union(Set({ i: i, g: g, dead: false })),
    pullResp' = pullResp, acks' = acks,
    keepMeta, keepRecs, keepMarks, keepData, keepTxn, keepSeen, keepBoot,
  }

  // 親に pull が届く (pullPieces)。親は、要求の epoch まで列を適用してから答えるので、fence の記録はある
  action deliverPull(q: PullReq): bool = all {
    pullReq.contains(q),
    val i = q.i
    val g = q.g
    val s = src(i)
    val live = not(pdone.get(i))
    val known = mark.get((s, g))
    // 規則: 生きた fence の下でだけ渡す。5808b08 は、終わった fence の下でも渡す
    val hand = live or not(PARENT_RULE)
    // この移動でもう渡していれば (印がこの移動のもの)、記録を書かずに渡し直す
    val write = hand and known.e != i
    // __moved の主キーは (g, epoch, after)。印がないのに記録があれば、書き込みは UNIQUE で失敗し、応答は出ない
    val collide = write and hrec.get((i, g)) > 0
    val wrote = write and not(collide)
    // 5808b08 は、印を書き込みより前に付け、失敗しても残す
    val early = collide and MARKS == 2
    val hrec2 = if (wrote) hrec.set((i, g), 1) else hrec
    all {
      hrec' = hrec2,
      mtxn' = if (wrote and intent.get((s, g))) mtxn.union(Set((i, g))) else mtxn,
      mark' = if (MARKS == 0) dMarks(hrec2, arec, cdone)
              else if (wrote or early) mark.set((s, g), { e: i, acked: false })
              else mark,
      pullResp' = if (q.dead or collide) pullResp
                  else if (hand) pullResp.union(Set({ i: i, g: g, row: row.get((s, g)), carry: intent.get((s, g)), fin: false }))
                  else pullResp.union(Set({ i: i, g: g, row: NONE, carry: false, fin: true })),
      staleHand' = (staleHand or (not(live) and (wrote or early))),
      writeFailed' = (writeFailed or collide),
      staleRecv' = staleRecv, refused' = refused,
      pdone' = pdone, cdone' = cdone, arec' = arec, arr' = arr,
      pullReq' = pullReq, acks' = acks,
      keepMeta, keepData, keepTxn, keepBoot,
    }
  }

  // 子に pull の応答が届く (receiveStep と fetchStep)
  action deliverResp(m: PullResp): bool = all {
    pullResp.contains(m),
    val i = m.i
    val g = m.g
    val d = dst(i)
    val live = not(cdone.get(i))
    // 規則: 受け取り中の移動の応答だけを受け取る。5808b08 は、どの移動の応答も受け取る
    val take = live or not(CHILD_RULE)
    // 「渡し終えた」: 受け取り終える。規則のとおりなら、その epoch の受け取りを終える。子の規則がなければ、finishIncoming が区間で
    // 引くので、同じ範囲のいまの受け取りを終える
    val closing = if (take and m.fin and FINISHED_ANSWERS) (if (CHILD_RULE) Set(i) else receiving(d)) else Set()
    val cdone2 = MOVES.mapBy(j => cdone.get(j) or closing.contains(j))
    // 行と intent: この移動でまだ届いていなければ入れる (到着の印の epoch で比べる)
    val fresh = take and not(m.fin) and arr.get((d, g)) != i
    // 持っている行をもう一度入れると、主キーが衝突して書き込みは失敗する
    val clash = fresh and m.row != NONE and row.get((d, g)) != NONE
    val store = fresh and not(clash)
    val arec2 = if (store) arec.union(Set((i, g))) else arec
    val arr2 = if (MARKS == 0) dArrs(arec2) else if (store) arr.set((d, g), i) else arr
    // 答えを待っていた文が、同期区間に入る。受け取り中で、グループがまだ届いていなければ、group not arrived である
    val waits = MOVES.exists(j => j <= started and dst(j) == d and not(cdone2.get(j)) and arr2.get((d, g)) != j)
    all {
      cdone' = cdone2,
      arec' = arec2,
      arr' = arr2,
      // 5808b08 は、届いたグループの「渡した」印を、移動を比べずに外す。受け取り終えたら、そのシャードの印を全部外す
      mark' = if (MARKS == 0) dMarks(hrec, arec2, cdone2)
              else if (store) mark.set((d, g), NOMARK)
              else if (closing != Set()) KEYS.mapBy(k => if (k._1 == d) NOMARK else mark.get(k))
              else mark,
      row' = if (store and m.row != NONE) row.set((d, g), m.row) else row,
      intent' = if (store and m.carry) intent.set((d, g), true) else intent,
      base' = base,
      // fetchStep は、受け取りの手続きの後で、応答の piece の ack を送る (捨てた応答でも送る)
      acks' = if (m.fin or clash) acks else acks.union(Set((i, g))),
      staleRecv' = (staleRecv or (not(live) and (store or closing != Set()))),
      writeFailed' = (writeFailed or clash),
      // 受け取り中の移動の答えを受けた後も届いていなければ、尋ね直しても同じ答えなので、文は断られる (「渡し終えた」を断りとして
      // 読んだ 89d99c8)。受け取り中でない移動の答えの後は、尋ね直さなければ断られる (5808b08 の arriveStep)
      refused' = (refused or (waits and (live or not(ASK_AGAIN)))),
      staleHand' = staleHand,
      pdone' = pdone, hrec' = hrec, mtxn' = mtxn,
      pullReq' = pullReq, pullResp' = pullResp,
      keepMeta, keepTxn, keepBoot,
    }
  }

  // 親に ack が届く。その移動で渡して、まだ ack されていないグループの行と intent を消す。規則のとおりなら、生きた fence の下でだけ消す
  action deliverAck(i: int, g: int): bool = all {
    acks.contains((i, g)),
    val s = src(i)
    val live = not(pdone.get(i))
    val known = mark.get((s, g))
    val hrec2 = if (hrec.get((i, g)) > 0) hrec.set((i, g), 2) else hrec
    all {
      // 何も変えない ack は、手として数えない
      known.e == i, not(known.acked), live or not(ACK_RULE),
      row' = row.set((s, g), NONE), intent' = intent.set((s, g), false), base' = base,
      hrec' = hrec2,
      mark' = if (MARKS == 0) dMarks(hrec2, arec, cdone) else mark.set((s, g), { e: i, acked: true }),
      staleHand' = (staleHand or not(live)),
      staleRecv' = staleRecv, refused' = refused, writeFailed' = writeFailed,
      pdone' = pdone, cdone' = cdone, mtxn' = mtxn, arec' = arec, arr' = arr,
      keepMeta, keepMsgs, keepTxn, keepBoot,
    }
  }

  // 親が渡し終える (finishHanding)。子の drain は、親のグループを列挙し直して、何も残っていないことを見てから finishMove を頼む。
  // その後に届いた on-demand の pull が、空のグループに印を付けていることはある (ack を待つ印が残る)
  action parentFinish(i: int): bool = all {
    liveFence(i), liveIncoming(i),
    GROUPS.forall(g => not(holds(src(i), g))),
    pdone' = pdone.set(i, true),
    cdone' = cdone, hrec' = hrec, mtxn' = mtxn, arec' = arec,
    keepMeta, keepMarks, keepData, keepMsgs, keepTxn, keepSeen, keepBoot,
  }

  // 子が受け取り終える (finishIncoming)。finishMove の応答を受けた後である。応答が再起動で失われても、子は頼み直す
  action childFinish(i: int): bool = all {
    i <= started, pdone.get(i), not(cdone.get(i)),
    val cdone2 = cdone.set(i, true)
    all {
      cdone' = cdone2,
      mark' = if (MARKS == 0) dMarks(hrec, arec, cdone2) else KEYS.mapBy(k => if (k._1 == dst(i)) NOMARK else mark.get(k)),
      arr' = arr,
      pdone' = pdone, hrec' = hrec, mtxn' = mtxn, arec' = arec,
      keepMeta, keepData, keepMsgs, keepTxn, keepSeen, keepBoot,
    }
  }

  // Meta が move-end を記録する (子が、受け取り終えた後で頼む)
  action moveEnd(i: int): bool = all {
    i <= started, cdone.get(i), ended == i - 1,
    ended' = i, started' = started,
    keepRecs, keepMarks, keepData, keepMsgs, keepTxn, keepSeen, keepBoot,
  }

  // シャードの再起動。印を記録から作り直す。そのシャードへの応答は消え、そのシャードが送った pull は、応答の届け先を失う
  action restart(s: int): bool = all {
    restarts < RESTARTS,
    val bootMark = dMarks(hrec, arec, cdone)
    val bootArr = dArrs(arec)
    val mark2 = KEYS.mapBy(k => if (k._1 == s) bootMark.get(k) else mark.get(k))
    val arr2 = KEYS.mapBy(k => if (k._1 == s) bootArr.get(k) else arr.get(k))
    val resp2 = pullResp.filter(m => dst(m.i) != s)
    val req2 = pullReq.map(q => if (dst(q.i) == s) q.with("dead", true) else q)
    all {
      // 何も変えない再起動は、手として数えない
      mark2 != mark or arr2 != arr or resp2 != pullResp or req2 != pullReq,
      mark' = mark2, arr' = arr2, pullResp' = resp2, pullReq' = req2, acks' = acks,
      restarts' = restarts + 1,
      keepMeta, keepRecs, keepData, keepTxn, keepSeen,
    }
  }

  // ---- 持ち主の書き込み (1 シャードの文) ----
  action ownerPut(g: int): bool = all {
    OWNER_OPS, serves(owner, g), not(intent.get((owner, g))), row.get((owner, g)) != 0,
    row' = row.set((owner, g), 0), base' = base.set(g, 0), intent' = intent,
    keepMeta, keepRecs, keepMarks, keepMsgs, keepTxn, keepSeen, keepBoot,
  }
  action ownerDel(g: int): bool = all {
    OWNER_OPS, serves(owner, g), not(intent.get((owner, g))), row.get((owner, g)) != NONE,
    row' = row.set((owner, g), NONE), base' = base.set(g, NONE), intent' = intent,
    keepMeta, keepRecs, keepMarks, keepMsgs, keepTxn, keepSeen, keepBoot,
  }

  // ---- 取引 Y と phase 2 (M5c) ----
  // Y が、そのときの持ち主でグループ g に intent を置き、anchor (別のシャード) が確定を決めて記録を書く。phase 2 は遅れて届く
  action beginY(g: int): bool = all {
    TXN, tg == 0, serves(owner, g),
    intent' = intent.set((owner, g), true), row' = row, base' = base,
    tg' = g, reqs' = [{ at: owner, pieces: 0, st: PENDING, child: -1 }], record' = true,
    applied' = applied, lost' = lost, overflow' = overflow,
    keepMeta, keepRecs, keepMarks, keepMsgs, keepSeen, keepBoot,
  }
  // phase 2 の要求を、シャードが 1 手で処理する (finalizeStep)。e は転送に使う移動で、転送しないなら 0
  action handle(r: int, e: int): bool = all {
    tg > 0, r < reqs.length(), reqs[r].st == PENDING,
    val d = reqs[r].at
    val k = mark.get((d, yg))
    val local = intent.get((d, yg)) and k.e == 0
    val via = if (k.e > 0 and mtxn.contains((k.e, yg))) Set(k.e) else Set()
    val full = reqs.length() > CAP
    all {
      // piece を運ぶ転送は、受け取り中でグループがまだ届いていなければ、届くのを待つ
      reqs[r].pieces == 0 or not(unarrived(d, yg)),
      if (via == Set()) e == 0 else via.contains(e),
      row' = if (local) row.set((d, yg), 1) else row,
      intent' = if (local) intent.set((d, yg), false) else intent,
      // Y の書き込みは 1 つである。持ち主でないシャードに入った写しを後から適用しても、確定した値は変わらない
      base' = if (local and not(applied)) base.set(yg, 1) else base,
      applied' = (applied or local),
      reqs' = if (e == 0 or full) reqs.replaceAt(r, reqs[r].with("st", DONE))
              else reqs.replaceAt(r, reqs[r].with("st", WAITING).with("child", reqs.length())).append({ at: dst(e), pieces: e, st: PENDING, child: -1 }),
      overflow' = (overflow or (e > 0 and full)),
      tg' = tg, record' = record, lost' = lost,
      keepMeta, keepRecs, keepMarks, keepMsgs, keepSeen, keepBoot,
    }
  }
  action complete(r: int): bool = all {
    tg > 0, r < reqs.length(),
    reqs[r].st == WAITING, reqs[reqs[r].child].st == DONE,
    reqs' = reqs.replaceAt(r, reqs[r].with("st", DONE)),
    tg' = tg, record' = record, applied' = applied, lost' = lost, overflow' = overflow,
    keepMeta, keepRecs, keepMarks, keepData, keepMsgs, keepSeen, keepBoot,
  }
  // anchor が、届け終えた取引の記録を消す
  action gc = all {
    delivered, record,
    record' = false,
    tg' = tg, reqs' = reqs, applied' = applied, lost' = lost, overflow' = overflow,
    keepMeta, keepRecs, keepMarks, keepData, keepMsgs, keepSeen, keepBoot,
  }
  // 自分のものとして持っている intent を、読み手か再駆動が anchor に尋ねて決着させる。記録がなければ presumed abort で捨てる
  action resolve(d: int): bool = all {
    tg > 0, intent.get((d, yg)), mark.get((d, yg)).e == 0,
    row' = if (record) row.set((d, yg), 1) else row,
    base' = if (record and not(applied)) base.set(yg, 1) else base,
    intent' = intent.set((d, yg), false),
    applied' = (applied or record),
    // 失ったと数えるのは、どこにも適用していない書き込みの intent を捨てたときである。適用した後に残った写し (持ち主でないシャードに
    // 入った intent) を捨てるのは、失ったことにならない (その写しは rowsOnlyAtOwner が見る)
    lost' = (lost or (not(record) and not(applied))),
    tg' = tg, reqs' = reqs, record' = record, overflow' = overflow,
    keepMeta, keepRecs, keepMarks, keepMsgs, keepSeen, keepBoot,
  }

  action step = any {
    { nondet i = oneOf(MOVES) any { start(i), parentFinish(i), childFinish(i), moveEnd(i) } },
    { nondet i = oneOf(MOVES) nondet g = oneOf(GROUPS) any { sendPull(i, g), deliverAck(i, g) } },
    { nondet q = oneOf(pullReq) deliverPull(q) },
    { nondet m = oneOf(pullResp) deliverResp(m) },
    { nondet s = oneOf(SHARDS) restart(s) },
    { nondet g = oneOf(GROUPS) any { ownerPut(g), ownerDel(g), beginY(g) } },
    { nondet r = oneOf(0.to(CAP)) nondet e = oneOf(0.to(MOVES_N)) any { handle(r, e), complete(r) } },
    gc,
    { nondet d = oneOf(SHARDS) resolve(d) },
  }

  // ---- 不変条件 ----
  val deliveredApplied = not(delivered) or applied
  val noLostWrite = not(lost)
  val allEnded = ended == MOVES_N
  val finalValue = not(delivered and allEnded and base.get(yg) == 1) or row.get((owner, yg)) == 1
  val boundedForwards = not(overflow) and reqs.length() <= MOVES_N + 1
  val handsUnderFence = not(staleHand)
  val receivesUnderIncoming = not(staleRecv)
  val rowsOnlyAtOwner = KEYS.forall(k =>
    k._1 == owner or not(holds(k._1, k._2)) or (started > 0 and src(started) == k._1 and not(pdone.get(started))))
  // 持ち主が Y の intent をまだ持っている間は、持ち主でないシャードに入った写しが先に適用されていても、数えない (読み手は、持ち主の
  // intent を決着させてから読む。持ち主でないシャードの行は rowsOnlyAtOwner が見る)
  val ownerHasTruth = GROUPS.forall(g => not(serves(owner, g)) or row.get((owner, g)) == base.get(g)
    or (g == tg and intent.get((owner, g)) and base.get(g) == 1))
  val ackWillLand = HANDS.forall(k =>
    not(liveFence(k._1) and arr.get((dst(k._1), k._2)) == k._1 and holds(src(k._1), k._2))
      or (mark.get((src(k._1), k._2)).e == k._1 and not(mark.get((src(k._1), k._2)).acked)))
  val noMoveRefusal = not(refused)
  val noFailedWrite = not(writeFailed)
  val marksDerived = mark == dMarks(hrec, arec, cdone) and arr == dArrs(arec)
  // メモリの「渡した」印は、その移動の記録と合っている (印を書き込みより前に付けて、失敗しても残す形だけが破る。印を手ごとに
  // 書き換えても、書き込みの後で付けるなら破れない)
  val markMatchesRecord = KEYS.forall(k =>
    mark.get(k).e == 0 or hrec.get((mark.get(k).e, k._2)) == (if (mark.get(k).acked) 2 else 1))
  val m5cSafe = deliveredApplied and noLostWrite and finalValue and boundedForwards and handsUnderFence
  // 行、intent、印についての不変条件 (遅れた要求と応答で記録を変えたこと自体と、断りと、書き込みの失敗を除く)
  val m5dData = deliveredApplied and noLostWrite and finalValue and boundedForwards and rowsOnlyAtOwner and ownerHasTruth
    and ackWillLand and marksDerived
  // 外から見えること: 行、intent、印、文の断り、書き込みの失敗
  val m5dOutcome = m5dData and noMoveRefusal and noFailedWrite
  // 規則そのもの (生きた記録のない移動の要求と応答で、記録を変えない) を足す
  val m5dSafe = m5dOutcome and handsUnderFence and receivesUnderIncoming

  // ---- witness (緑で届くこと) ----
  // 終わった移動の遅れた pull に、親が「渡し終えた」と答えた
  val witnessLateFinished = not(pullResp.exists(m => m.fin and ended >= m.i))
  // 同じことが、範囲がその親へ戻った後 (類の 1 から 3) か、次の移動も閉じた後 (類の 4) に起きた
  val witnessLateAfterNext = not(pullResp.exists(m => m.fin and m.i == 1) and ended >= 2)
  // 親が渡し終えた後、子が受け取り終える前に、「渡し終えた」の答えが出た (子は、この答えで受け取り終える)
  val witnessFinishedInWindow = not(pullResp.exists(m => m.fin and not(cdone.get(m.i))))
  // 生きた fence の下で渡した行の応答が、子が受け取り終えた後も飛んでいる (類の 6 と 7 の応答)
  val witnessLateResponse = not(pullResp.exists(m => not(m.fin) and cdone.get(m.i)))
  // 運ばれなかったグループを、子が到着の記録なしで受け持ち、そこに行を書いた
  val witnessUncarriedWritten = not(ended >= 1 and arec == Set() and GROUPS.exists(g => row.get((owner, g)) == 0))
  // phase 2 が転送されて、いまの持ち主で適用された (M5c の witness)
  val witnessForwarded = not(delivered and applied and reqs.length() >= 2 and allEnded)

  // ---- 活性 ----
  val vars = (started, ended, pdone, cdone, hrec, mtxn, arec, mark, arr, row, intent, base, pullReq, pullResp, acks,
    tg, reqs, record, applied, lost, overflow, staleHand, staleRecv, refused, writeFailed, restarts)
  // 公平性は、移動を進める側の手にだけ置く: drain の pull (親が挙げるグループだけ)、生きた移動の要求と応答と ack の配送、移動を終える手、
  // phase 2 の手。遅れた要求と応答の配送、再起動、持ち主の書き込み、取引の開始には置かない
  action drainPull(i: int, g: int): bool = all { listed(i, g), sendPull(i, g) }
  action liveDeliverPull(i: int, g: int): bool = all { liveFence(i), deliverPull({ i: i, g: g, dead: false }) }
  action liveDeliverResp(i: int, g: int): bool = {
    nondet m = oneOf(pullResp.filter(x => x.i == i and x.g == g))
    all { liveIncoming(i), deliverResp(m) }
  }
  action liveDeliverAck(i: int, g: int): bool = all { liveFence(i), deliverAck(i, g) }
  temporal fairness = and {
    MOVES.forall(i => weakFair(start(i), vars) and weakFair(parentFinish(i), vars) and weakFair(childFinish(i), vars) and weakFair(moveEnd(i), vars)),
    HANDS.forall(k => weakFair(drainPull(k._1, k._2), vars) and weakFair(liveDeliverPull(k._1, k._2), vars)
      and weakFair(liveDeliverResp(k._1, k._2), vars) and weakFair(liveDeliverAck(k._1, k._2), vars)),
    0.to(CAP).forall(r => 0.to(MOVES_N).forall(e => weakFair(handle(r, e), vars)) and weakFair(complete(r), vars)),
  }
  temporal movesClose = fairness implies eventually(allEnded)
  temporal delivers = fairness implies always(tg > 0 implies eventually(delivered))
  temporal m5dLive = fairness implies (eventually(allEnded) and always(tg > 0 implies eventually(delivered)))

  // ---- run の部品 (グループは 1。どのインスタンスの run も使う) ----
  pure def reqOf(i: int): PullReq = { i: i, g: 1, dead: false }
  pure def payload(i: int, v: int, c: bool): PullResp = { i: i, g: 1, row: v, carry: c, fin: false }
  pure def finished(i: int): PullResp = { i: i, g: 1, row: NONE, carry: false, fin: true }
  // 移動 i を閉じる: 親が渡し終え、子が受け取り終え、Meta が move-end を記録する
  run closeMove(i: int): bool = parentFinish(i).then(childFinish(i)).then(moveEnd(i))
  // 行のないグループの移動 i。何も運ばない
  run emptyMove(i: int): bool = start(i).then(closeMove(i))
  // 同上。子の文が on-demand の pull を送り、届かないまま移動が閉じる
  run emptyMoveLatePull(i: int): bool = start(i).then(sendPull(i, 1)).then(closeMove(i))
  // 行のあるグループの移動 i。行 (c なら intent も) を運ぶ。pull の要求と応答は集合に残るので、同じ要求を出した別の文の分が、後で届く
  run fullMove(i: int, c: bool): bool =
    start(i).then(sendPull(i, 1)).then(deliverPull(reqOf(i))).then(deliverResp(payload(i, 0, c))).then(deliverAck(i, 1)).then(closeMove(i))
}

// ============================================================================================================
// 緑: 規則の全部。m5dSafe と m5dLive
// ============================================================================================================

// 範囲が前の持ち主へ戻る (0 → 1 → 0)。グループは 1 つで、初めは行がない (持ち主の ownerPut で、運ばれるグループになる)
module m5d_green_return {
  import m5d_core(PARENT_RULE = true, ACK_RULE = true, CHILD_RULE = true, FINISHED_ANSWERS = true, MARKS = 0, ASK_AGAIN = true,
    ROUTE = [0, 1, 0], GROUPS_N = 1, FULL = Set(), TXN = true, OWNER_OPS = true, RESTARTS = 1).*

  // 類の 1: 運ばれなかったグループの遅れた pull が、範囲が戻った後に届く。0 は「渡し終えた」と答え、何も変えない
  run member1Test =
    init.then(emptyMoveLatePull(1)).then(emptyMove(2))
        .then(deliverPull(reqOf(1)))
        .expect(pullResp == Set(finished(1)) and mark.get((0, 1)).e == 0 and hrec.get((1, 1)) == 0)
        .then(deliverResp(finished(1)))                    // 1 は、受け取り中でない移動の答えを捨てる
        .then(beginY(1)).then(handle(0, 0))                // 後の取引の phase 2 は、0 で適用される
        .expect(delivered and applied and row.get((0, 1)) == 1 and m5dSafe)
        .then(gc)
        .expect(m5dSafe)

  // 類の 2: 同じ pull が、持ち主が行を確定し直した後に届く。行は渡されず、ack も出ない
  run member2Test =
    init.then(emptyMoveLatePull(1)).then(emptyMove(2))
        .then(ownerPut(1))
        .then(deliverPull(reqOf(1))).then(deliverResp(finished(1)))
        .expect(row.get((0, 1)) == 0 and row.get((1, 1)) == NONE and acks == Set() and m5dSafe)

  // 類の 3: 同じ pull が、運ばれて戻ってきたグループに届く。記録を書かないので、書き込みは失敗せず、印も付かない
  run member3Test =
    init.then(ownerPut(1))
        .then(fullMove(1, false)).then(fullMove(2, false))
        .expect(owner == 0 and row.get((0, 1)) == 0 and mark.get((0, 1)).e == 0 and hrec.get((1, 1)) == 2)
        .then(deliverPull(reqOf(1)))
        .expect(pullResp.contains(finished(1)) and mark.get((0, 1)).e == 0 and noFailedWrite)
        .then(deliverResp(finished(1)))
        .then(beginY(1)).then(handle(0, 0))
        .expect(delivered and applied and row.get((0, 1)) == 1 and m5dSafe)

  // 親が渡し終えた後、子が受け取り終える前に、運ばれなかったグループの文が来る (取り下げた直し 89d99c8 が断った場面)。
  // 親は「渡し終えた」と答え、子はそこで受け取り終えて、文に答える
  run windowTest =
    init.then(start(1)).then(parentFinish(1))
        .then(sendPull(1, 1)).then(deliverPull(reqOf(1)))
        .expect(pullResp == Set(finished(1)) and not(cdone.get(1)))
        .then(deliverResp(finished(1)))
        .expect(cdone.get(1) and serves(1, 1) and noMoveRefusal)
        .then(ownerPut(1)).then(moveEnd(1))
        .expect(row.get((1, 1)) == 0 and m5dSafe)

  // M5c の returnTest の順序 (test/phase2-during-return.test.ts)。Y は移動の前に 0 で prepare し、戻る移動の途中で phase 2 が届く
  run returnTest =
    init.then(ownerPut(1)).then(beginY(1))
        .then(fullMove(1, true))
        .then(start(2))
        .expect(mark.get((0, 1)).e == 1 and intent.get((1, 1)))
        .then(handle(0, 1))                                // 0 は、まだ渡した印を持っているので 1 へ転送する
        .then(sendPull(2, 1)).then(deliverPull(reqOf(2)))  // 1 が 0 へ渡す (intent が載る)
        .then(handle(1, 2))                                // 1 は、移動 2 の記録で、0 へ転送し返す
        .then(deliverResp(payload(2, 0, true)))            // 0 にグループが届く。印が外れる
        .then(handle(2, 0))                                // 0 で適用する
        .then(complete(1)).then(complete(0))
        .then(deliverAck(2, 1)).then(closeMove(2))
        .expect(delivered and applied and row.get((0, 1)) == 1 and m5dSafe)
}

// 戻らない列 (0 → 1 → 2)
module m5d_green_chain {
  import m5d_core(PARENT_RULE = true, ACK_RULE = true, CHILD_RULE = true, FINISHED_ANSWERS = true, MARKS = 0, ASK_AGAIN = true,
    ROUTE = [0, 1, 2], GROUPS_N = 1, FULL = Set(), TXN = true, OWNER_OPS = true, RESTARTS = 1).*

  // 類の 4: 0 への遅れた pull が、移動 2 が閉じた後に届く。0 は「渡し終えた」と答え、1 は答えを捨てる。1 の印は残り、phase 2 は 2 へ転送される
  run member4Test =
    init.then(emptyMoveLatePull(1))
        .then(ownerPut(1)).then(beginY(1))                 // 1 が行を書き、Y が intent を置く。1 への phase 2 は遅れる
        .then(fullMove(2, true))
        .expect(mark.get((1, 1)) == { e: 2, acked: true } and intent.get((2, 1)))
        .then(deliverPull(reqOf(1))).then(deliverResp(finished(1)))
        .expect(mark.get((1, 1)) == { e: 2, acked: true } and arec == Set((2, 1)))
        .then(handle(0, 2)).then(handle(1, 0)).then(complete(0))
        .expect(delivered and applied and row.get((2, 1)) == 1 and m5dSafe)

  // 類の 5: 同じものが、移動 2 の pull と ack の間に届く。1 の印は残り、ack は数えられ、移動は閉じる
  run member5Test =
    init.then(emptyMoveLatePull(1))
        .then(ownerPut(1))
        .then(start(2)).then(sendPull(2, 1)).then(deliverPull(reqOf(2))).then(deliverResp(payload(2, 0, false)))
        .then(deliverPull(reqOf(1))).then(deliverResp(finished(1)))
        .expect(mark.get((1, 1)) == { e: 2, acked: false } and ackWillLand)
        .then(deliverAck(2, 1)).then(closeMove(2))
        .expect(allEnded and row.get((1, 1)) == NONE and row.get((2, 1)) == 0 and m5dSafe)

  // 類の 7: 生きた fence の下で渡した空のグループの応答が、子が受け取り終えた後に届く。1 は捨て、到着の記録は付かない
  run member7Test =
    init.then(start(1)).then(sendPull(1, 1)).then(deliverPull(reqOf(1)))
        .expect(mark.get((0, 1)) == { e: 1, acked: false } and handsUnderFence)
        .then(closeMove(1))                                // 1 は、到着の記録なしで受け持つ
        .then(ownerPut(1)).then(beginY(1))
        .then(fullMove(2, true))
        .then(deliverResp(payload(1, NONE, false)))
        .expect(not(arec.contains((1, 1))) and mark.get((1, 1)) == { e: 2, acked: true })
        .then(handle(0, 2)).then(handle(1, 0)).then(complete(0))
        .expect(delivered and applied and row.get((2, 1)) == 1 and m5dSafe)
}

// 範囲が戻って、もう一度出る (0 → 1 → 0 → 1)。取引は置かない (状態を減らすため。取引を置いた形は HEAVY の m5d_green_return3_txn)
module m5d_green_return3 {
  import m5d_core(PARENT_RULE = true, ACK_RULE = true, CHILD_RULE = true, FINISHED_ANSWERS = true, MARKS = 0, ASK_AGAIN = true,
    ROUTE = [0, 1, 0, 1], GROUPS_N = 1, FULL = Set(), TXN = false, OWNER_OPS = true, RESTARTS = 1).*

  // 類の 6: 移動 1 の、生きた fence の下の pull の応答が、1 がグループを移動 3 で受け取り直し、行を消した後に届く。1 は捨てる
  run member6Test =
    init.then(ownerPut(1))
        .then(fullMove(1, false)).then(fullMove(2, false)).then(fullMove(3, false))
        .then(ownerDel(1))
        .expect(owner == 1 and row.get((1, 1)) == NONE and arr.get((1, 1)) == 3)
        .then(deliverResp(payload(1, 0, false)))
        .expect(row.get((1, 1)) == NONE and arr.get((1, 1)) == 3 and m5dSafe)

  // 移動 1 の遅れた pull の答えが、1 が移動 3 を受け取っている間に届く。答えは捨てられ、待っていた文は、移動 3 で尋ね直す
  run askAgainTest =
    init.then(emptyMoveLatePull(1)).then(emptyMove(2))
        .then(ownerPut(1))
        .then(start(3))
        .then(deliverPull(reqOf(1))).then(deliverResp(finished(1)))
        .expect(unarrived(1, 1) and noMoveRefusal)
        .then(sendPull(3, 1)).then(deliverPull(reqOf(3))).then(deliverResp(payload(3, 0, false)))
        .expect(serves(1, 1) and row.get((1, 1)) == 0)
        .then(deliverAck(3, 1)).then(closeMove(3))
        .expect(m5dSafe)
}

// グループ 2 つ (1 は初めに行があり、2 は空)。「渡し終えた」の答えは範囲の全部を受け取り終えさせるので、ほかのグループが届いている
// ことを確かめる。持ち主の書き込みと再起動は置かない (持ち主の書き込みを置いた形は HEAVY の m5d_green_groups_owner)
module m5d_green_groups {
  import m5d_core(PARENT_RULE = true, ACK_RULE = true, CHILD_RULE = true, FINISHED_ANSWERS = true, MARKS = 0, ASK_AGAIN = true,
    ROUTE = [0, 1, 0], GROUPS_N = 2, FULL = Set(1), TXN = true, OWNER_OPS = false, RESTARTS = 0).*
}

// ---- HEAVY=1 で流す、大きい形 ----
// 0 → 1 → 0 → 1 に、取引を足す (再起動なし)
module m5d_green_return3_txn {
  import m5d_core(PARENT_RULE = true, ACK_RULE = true, CHILD_RULE = true, FINISHED_ANSWERS = true, MARKS = 0, ASK_AGAIN = true,
    ROUTE = [0, 1, 0, 1], GROUPS_N = 1, FULL = Set(), TXN = true, OWNER_OPS = true, RESTARTS = 0).*
}
// 列の先で、最初の持ち主へ戻る (0 → 1 → 2 → 0。再起動なし)
module m5d_green_chain_back {
  import m5d_core(PARENT_RULE = true, ACK_RULE = true, CHILD_RULE = true, FINISHED_ANSWERS = true, MARKS = 0, ASK_AGAIN = true,
    ROUTE = [0, 1, 2, 0], GROUPS_N = 1, FULL = Set(), TXN = true, OWNER_OPS = true, RESTARTS = 0).*
}
// グループ 2 つに、持ち主の書き込みを足す (取引と再起動なし)
module m5d_green_groups_owner {
  import m5d_core(PARENT_RULE = true, ACK_RULE = true, CHILD_RULE = true, FINISHED_ANSWERS = true, MARKS = 0, ASK_AGAIN = true,
    ROUTE = [0, 1, 0], GROUPS_N = 2, FULL = Set(1), TXN = false, OWNER_OPS = true, RESTARTS = 0).*
}

// ============================================================================================================
// 5808b08 のコード: 親の規則も子の規則もなく、印は手ごとに書き換え、書き込みより前に付ける。文は 1 回だけ尋ねる
// ============================================================================================================

module m5d_code_return {
  import m5d_core(PARENT_RULE = false, ACK_RULE = false, CHILD_RULE = false, FINISHED_ANSWERS = true, MARKS = 2, ASK_AGAIN = false,
    ROUTE = [0, 1, 0], GROUPS_N = 1, FULL = Set(), TXN = true, OWNER_OPS = true, RESTARTS = 1).*

  // 類の 1 (test/late-pull-after-range-returned.test.ts)
  run member1Test =
    init.then(emptyMoveLatePull(1)).then(emptyMove(2))
        .expect(owner == 0 and mark.get((0, 1)).e == 0)
        .then(deliverPull(reqOf(1)))                       // 0 は、終わった fence の下で渡し直し、印を付ける
        .expect(mark.get((0, 1)) == { e: 1, acked: false } and hrec.get((1, 1)) == 1 and not(handsUnderFence) and not(marksDerived))
        .then(beginY(1))                                   // 後の取引 Y が、このグループを書く
        .then(handle(0, 0))                                // 印があるので適用せず、転送の記録もないので転送せずに答える
        .expect(delivered and not(applied) and not(deliveredApplied))
        .then(gc)
        .then(restart(0))                                  // 再起動で、印は記録から作り直される (受け取り終えた範囲なので、外れる)
        .expect(mark.get((0, 1)).e == 0)
        .then(resolve(0))                                  // anchor の記録はもうないので、確定した書き込みを捨てる
        .expect(lost and not(noLostWrite))

  // 類の 2
  run member2Test =
    init.then(emptyMoveLatePull(1)).then(emptyMove(2))
        .then(ownerPut(1))                                 // 持ち主 (0) が行を確定する
        .then(deliverPull(reqOf(1)))                       // 0 は、確定した行を、終わった移動の子 (1) へ渡し直す
        .then(deliverResp(payload(1, 0, false)))           // 1 は、到着の記録がないので、入れる
        .expect(row.get((1, 1)) == 0 and not(rowsOnlyAtOwner) and not(receivesUnderIncoming))
        .then(deliverAck(1, 1))                            // 渡し直しの ack が、持ち主の確定した行を消す
        .expect(row.get((0, 1)) == NONE and base.get(1) == 0 and not(ownerHasTruth))

  // 類の 3
  run member3Test =
    init.then(ownerPut(1))
        .then(fullMove(1, false)).then(fullMove(2, false))
        .expect(mark.get((0, 1)).e == 0 and hrec.get((1, 1)) == 2)
        .then(deliverPull(reqOf(1)))                       // 印を付けてから __moved に書く。UNIQUE で失敗し、印だけが残る
        .expect(not(noFailedWrite) and mark.get((0, 1)) == { e: 1, acked: false } and not(markMatchesRecord))
        .then(beginY(1)).then(handle(0, 0))
        .expect(delivered and not(applied) and not(deliveredApplied))
        .then(restart(0))                                  // メモリだけの印は、再起動で消える
        .expect(mark.get((0, 1)).e == 0)
}

module m5d_code_chain {
  import m5d_core(PARENT_RULE = false, ACK_RULE = false, CHILD_RULE = false, FINISHED_ANSWERS = true, MARKS = 2, ASK_AGAIN = false,
    ROUTE = [0, 1, 2], GROUPS_N = 1, FULL = Set(), TXN = true, OWNER_OPS = true, RESTARTS = 1).*

  // 類の 4
  run member4Test =
    init.then(emptyMoveLatePull(1))
        .then(ownerPut(1)).then(beginY(1))
        .then(fullMove(2, true))                           // 行と intent は 2 へ移った
        .expect(mark.get((1, 1)) == { e: 2, acked: true } and intent.get((2, 1)))
        .then(deliverPull(reqOf(1)))                       // 0 は、空のグループを渡し直す
        .then(deliverResp(payload(1, NONE, false)))        // 1 は入れ、移動 2 の印を消す
        .expect(mark.get((1, 1)).e == 0 and not(marksDerived))
        .then(handle(0, 0))                                // 1 は、intent も印も持たないので、転送せずに答える
        .expect(delivered and not(applied) and not(deliveredApplied))
        .then(gc).then(resolve(2))
        .expect(lost and not(noLostWrite))

  // 類の 5
  run member5Test =
    init.then(emptyMoveLatePull(1))
        .then(ownerPut(1))
        .then(start(2)).then(sendPull(2, 1)).then(deliverPull(reqOf(2))).then(deliverResp(payload(2, 0, false)))
        .then(deliverPull(reqOf(1))).then(deliverResp(payload(1, NONE, false)))
        // 1 の、移動 2 の印が消えた。ack は数えられず (deliverAck は取れない)、行は 1 と 2 の両方に残り、1 は渡し終えられない
        .expect(mark.get((1, 1)).e == 0 and acks.contains((2, 1)) and not(ackWillLand))
        .expect(row.get((1, 1)) == 0 and row.get((2, 1)) == 0 and holds(1, 1))
        .then(restart(1))                                  // 再起動すると、印が記録から戻る
        .expect(mark.get((1, 1)) == { e: 2, acked: false })
        .then(deliverAck(2, 1)).then(closeMove(2))
        .expect(allEnded)

  // 類の 7
  run member7Test =
    init.then(start(1)).then(sendPull(1, 1)).then(deliverPull(reqOf(1)))
        .expect(handsUnderFence)                           // 親は、生きた fence の下で渡した
        .then(closeMove(1))
        .then(ownerPut(1)).then(beginY(1))
        .then(fullMove(2, true))
        .then(deliverResp(payload(1, NONE, false)))        // 到着の記録が付き、移動 2 の印が消える
        .expect(arec.contains((1, 1)) and not(receivesUnderIncoming) and mark.get((1, 1)).e == 0 and not(marksDerived))
        .then(handle(0, 0))
        .expect(delivered and not(applied) and not(deliveredApplied))
}

module m5d_code_return3 {
  import m5d_core(PARENT_RULE = false, ACK_RULE = false, CHILD_RULE = false, FINISHED_ANSWERS = true, MARKS = 2, ASK_AGAIN = false,
    ROUTE = [0, 1, 0, 1], GROUPS_N = 1, FULL = Set(), TXN = false, OWNER_OPS = true, RESTARTS = 1).*

  // 類の 6
  run member6Test =
    init.then(ownerPut(1))
        .then(fullMove(1, false)).then(fullMove(2, false)).then(fullMove(3, false))
        .then(ownerDel(1))                                 // 持ち主 (1) が行を消して確定する
        .expect(row.get((1, 1)) == NONE and arr.get((1, 1)) == 3 and handsUnderFence)
        .then(deliverResp(payload(1, 0, false)))           // 移動 1 の応答が届く。到着の印は移動 3 なので、入れる
        .expect(row.get((1, 1)) == 0 and base.get(1) == NONE and not(ownerHasTruth) and arr.get((1, 1)) == 1 and not(marksDerived))
}

// ============================================================================================================
// 5808b08 に、規則の片方だけを入れた形
// ============================================================================================================

// 親の規則だけ (子の規則と印の関数がない)。類の 1 から 5 は起きなくなるが、6 と 7 は残る
module m5d_code_parent_rule {
  import m5d_core(PARENT_RULE = true, ACK_RULE = true, CHILD_RULE = false, FINISHED_ANSWERS = true, MARKS = 2, ASK_AGAIN = false,
    ROUTE = [0, 1, 2], GROUPS_N = 1, FULL = Set(), TXN = true, OWNER_OPS = true, RESTARTS = 1).*

  // 類の 4 は起きない。0 は「渡し終えた」と答え、1 は受け取り中ではないので、何も変わらない
  run member4Test =
    init.then(emptyMoveLatePull(1))
        .then(ownerPut(1)).then(beginY(1))
        .then(fullMove(2, true))
        .then(deliverPull(reqOf(1)))
        .expect(pullResp.contains(finished(1)) and handsUnderFence)
        .then(deliverResp(finished(1)))
        .expect(mark.get((1, 1)) == { e: 2, acked: true })
        .then(handle(0, 2)).then(handle(1, 0)).then(complete(0))
        .expect(delivered and applied and m5dOutcome)

  // 類の 5 も起きない
  run member5Test =
    init.then(emptyMoveLatePull(1))
        .then(ownerPut(1))
        .then(start(2)).then(sendPull(2, 1)).then(deliverPull(reqOf(2))).then(deliverResp(payload(2, 0, false)))
        .then(deliverPull(reqOf(1))).then(deliverResp(finished(1)))
        .expect(mark.get((1, 1)) == { e: 2, acked: false } and ackWillLand)
        .then(deliverAck(2, 1)).then(closeMove(2))
        .expect(allEnded and m5dOutcome)

  // 類の 7 は残る。親の渡し直しを使わない
  run member7Test =
    init.then(start(1)).then(sendPull(1, 1)).then(deliverPull(reqOf(1)))
        .then(closeMove(1))
        .then(ownerPut(1)).then(beginY(1))
        .then(fullMove(2, true))
        .then(deliverResp(payload(1, NONE, false)))
        .expect(handsUnderFence and not(receivesUnderIncoming) and mark.get((1, 1)).e == 0)
        .then(handle(0, 0))
        .expect(delivered and not(applied) and not(deliveredApplied))
}
module m5d_code_parent_rule_return {
  import m5d_core(PARENT_RULE = true, ACK_RULE = true, CHILD_RULE = false, FINISHED_ANSWERS = true, MARKS = 2, ASK_AGAIN = false,
    ROUTE = [0, 1, 0], GROUPS_N = 1, FULL = Set(), TXN = true, OWNER_OPS = true, RESTARTS = 1).*

  // 類の 1 から 3 は起きない
  run member1Test =
    init.then(emptyMoveLatePull(1)).then(emptyMove(2))
        .then(deliverPull(reqOf(1)))
        .expect(pullResp == Set(finished(1)) and mark.get((0, 1)).e == 0)
        .then(deliverResp(finished(1)))
        .then(beginY(1)).then(handle(0, 0))
        .expect(delivered and applied and m5dSafe)
  run member2Test =
    init.then(emptyMoveLatePull(1)).then(emptyMove(2))
        .then(ownerPut(1))
        .then(deliverPull(reqOf(1))).then(deliverResp(finished(1)))
        .expect(row.get((0, 1)) == 0 and row.get((1, 1)) == NONE and acks == Set() and m5dSafe)
  run member3Test =
    init.then(ownerPut(1))
        .then(fullMove(1, false)).then(fullMove(2, false))
        .then(deliverPull(reqOf(1)))
        .expect(pullResp.contains(finished(1)) and noFailedWrite and mark.get((0, 1)).e == 0)
        .then(beginY(1)).then(handle(0, 0))
        .expect(delivered and applied and m5dSafe)
}
module m5d_code_parent_rule3 {
  import m5d_core(PARENT_RULE = true, ACK_RULE = true, CHILD_RULE = false, FINISHED_ANSWERS = true, MARKS = 2, ASK_AGAIN = false,
    ROUTE = [0, 1, 0, 1], GROUPS_N = 1, FULL = Set(), TXN = false, OWNER_OPS = true, RESTARTS = 1).*

  // 類の 6 も、親の渡し直しを使わない
  run member6Test =
    init.then(ownerPut(1))
        .then(fullMove(1, false)).then(fullMove(2, false)).then(fullMove(3, false))
        .then(ownerDel(1))
        .then(deliverResp(payload(1, 0, false)))
        .expect(handsUnderFence and row.get((1, 1)) == 0 and not(ownerHasTruth))
}

// 子の規則だけ (親の規則と印の関数がない)。類の 4 から 7 は起きなくなるが、1、2、3 は残る
module m5d_code_child_rule {
  import m5d_core(PARENT_RULE = false, ACK_RULE = false, CHILD_RULE = true, FINISHED_ANSWERS = true, MARKS = 2, ASK_AGAIN = false,
    ROUTE = [0, 1, 0], GROUPS_N = 1, FULL = Set(), TXN = true, OWNER_OPS = true, RESTARTS = 1).*

  run member1Test =
    init.then(emptyMoveLatePull(1)).then(emptyMove(2))
        .then(deliverPull(reqOf(1)))
        .then(deliverResp(payload(1, NONE, false)))        // 1 は捨てる
        .expect(receivesUnderIncoming and mark.get((0, 1)) == { e: 1, acked: false })
        .then(beginY(1)).then(handle(0, 0))
        .expect(delivered and not(applied) and not(deliveredApplied))

  // 類の 2 は残る。1 は応答を捨てるが、fetchStep は捨てた応答の ack も送り、0 は印が合うので行を消す
  run member2Test =
    init.then(emptyMoveLatePull(1)).then(emptyMove(2))
        .then(ownerPut(1))
        .then(deliverPull(reqOf(1)))
        .then(deliverResp(payload(1, 0, false)))
        .expect(row.get((1, 1)) == NONE and receivesUnderIncoming and acks.contains((1, 1)))
        .then(deliverAck(1, 1))
        .expect(row.get((0, 1)) == NONE and base.get(1) == 0 and not(ownerHasTruth))

  run member3Test =
    init.then(ownerPut(1))
        .then(fullMove(1, false)).then(fullMove(2, false))
        .then(deliverPull(reqOf(1)))
        .expect(not(noFailedWrite) and not(markMatchesRecord))
        .then(beginY(1)).then(handle(0, 0))
        .expect(delivered and not(applied) and not(deliveredApplied))
}
module m5d_code_child_rule_chain {
  import m5d_core(PARENT_RULE = false, ACK_RULE = false, CHILD_RULE = true, FINISHED_ANSWERS = true, MARKS = 2, ASK_AGAIN = false,
    ROUTE = [0, 1, 2], GROUPS_N = 1, FULL = Set(), TXN = true, OWNER_OPS = true, RESTARTS = 1).*

  // 類の 4 は起きない。0 は空のグループを渡し直すが、1 は応答を捨てるので、移動 2 の印は残る
  run member4Test =
    init.then(emptyMoveLatePull(1))
        .then(ownerPut(1)).then(beginY(1))
        .then(fullMove(2, true))
        .then(deliverPull(reqOf(1)))
        .expect(not(handsUnderFence))
        .then(deliverResp(payload(1, NONE, false)))
        .expect(mark.get((1, 1)) == { e: 2, acked: true } and receivesUnderIncoming)
        .then(handle(0, 2)).then(handle(1, 0)).then(complete(0))
        .expect(delivered and applied and m5dData)

  // 類の 5 も起きない
  run member5Test =
    init.then(emptyMoveLatePull(1))
        .then(ownerPut(1))
        .then(start(2)).then(sendPull(2, 1)).then(deliverPull(reqOf(2))).then(deliverResp(payload(2, 0, false)))
        .then(deliverPull(reqOf(1))).then(deliverResp(payload(1, NONE, false)))
        .expect(mark.get((1, 1)) == { e: 2, acked: false } and ackWillLand)
        .then(deliverAck(2, 1)).then(closeMove(2))
        .expect(allEnded and m5dData)

  // 類の 7 も起きない
  run member7Test =
    init.then(start(1)).then(sendPull(1, 1)).then(deliverPull(reqOf(1)))
        .then(closeMove(1))
        .then(ownerPut(1)).then(beginY(1))
        .then(fullMove(2, true))
        .then(deliverResp(payload(1, NONE, false)))
        .expect(not(arec.contains((1, 1))) and mark.get((1, 1)) == { e: 2, acked: true })
        .then(handle(0, 2)).then(handle(1, 0)).then(complete(0))
        .expect(delivered and applied and m5dData)
}
module m5d_code_child_rule3 {
  import m5d_core(PARENT_RULE = false, ACK_RULE = false, CHILD_RULE = true, FINISHED_ANSWERS = true, MARKS = 2, ASK_AGAIN = false,
    ROUTE = [0, 1, 0, 1], GROUPS_N = 1, FULL = Set(), TXN = false, OWNER_OPS = true, RESTARTS = 1).*

  // 類の 6 は起きない
  run member6Test =
    init.then(ownerPut(1))
        .then(fullMove(1, false)).then(fullMove(2, false)).then(fullMove(3, false))
        .then(ownerDel(1))
        .then(deliverResp(payload(1, 0, false)))
        .expect(row.get((1, 1)) == NONE and arr.get((1, 1)) == 3 and ownerHasTruth)
}

// 印の関数だけ (親の規則も子の規則もない)。類の 1、4、5 は起きなくなる。2 は、持ち主の行は消えないが、行が前の子にも入る。
// 3 は、書き込みの失敗だけが残る。6 は残る。7 は、到着の記録が後から付くが、印は消えない
module m5d_code_derived_return {
  import m5d_core(PARENT_RULE = false, ACK_RULE = false, CHILD_RULE = false, FINISHED_ANSWERS = true, MARKS = 0, ASK_AGAIN = false,
    ROUTE = [0, 1, 0], GROUPS_N = 1, FULL = Set(), TXN = true, OWNER_OPS = true, RESTARTS = 1).*

  run member1Test =
    init.then(emptyMoveLatePull(1)).then(emptyMove(2))
        .then(deliverPull(reqOf(1)))                       // 渡し直しの記録は付くが、関数は印を作らない (範囲を受け取り終えている)
        .expect(hrec.get((1, 1)) == 1 and mark.get((0, 1)).e == 0 and not(handsUnderFence))
        .then(deliverResp(payload(1, NONE, false)))        // 1 は入れる (到着の記録が付く)
        .expect(arec.contains((1, 1)) and not(receivesUnderIncoming))
        .then(beginY(1)).then(handle(0, 0))
        .expect(delivered and applied and m5dData)

  run member2Test =
    init.then(emptyMoveLatePull(1)).then(emptyMove(2))
        .then(ownerPut(1))
        .then(deliverPull(reqOf(1)))
        .then(deliverResp(payload(1, 0, false)))           // 持ち主でない 1 に、行が入る
        .expect(row.get((1, 1)) == 0 and not(rowsOnlyAtOwner))
        // 0 に印はないので、ack は数えられず、持ち主の行は残る
        .expect(mark.get((0, 1)).e == 0 and row.get((0, 1)) == 0 and ownerHasTruth)

  run member3Test =
    init.then(ownerPut(1))
        .then(fullMove(1, false)).then(fullMove(2, false))
        .then(deliverPull(reqOf(1)))
        .expect(not(noFailedWrite) and mark.get((0, 1)).e == 0 and m5dData)
}
module m5d_code_derived_chain {
  import m5d_core(PARENT_RULE = false, ACK_RULE = false, CHILD_RULE = false, FINISHED_ANSWERS = true, MARKS = 0, ASK_AGAIN = false,
    ROUTE = [0, 1, 2], GROUPS_N = 1, FULL = Set(), TXN = true, OWNER_OPS = true, RESTARTS = 1).*

  run member4Test =
    init.then(emptyMoveLatePull(1))
        .then(ownerPut(1)).then(beginY(1))
        .then(fullMove(2, true))
        .then(deliverPull(reqOf(1))).then(deliverResp(payload(1, NONE, false)))
        // 到着の記録は付くが、関数は、移動 2 の印を消さない (到着の移動のほうが古い)
        .expect(arec.contains((1, 1)) and mark.get((1, 1)) == { e: 2, acked: true })
        .then(handle(0, 2)).then(handle(1, 0)).then(complete(0))
        .expect(delivered and applied and m5dData)

  run member5Test =
    init.then(emptyMoveLatePull(1))
        .then(ownerPut(1))
        .then(start(2)).then(sendPull(2, 1)).then(deliverPull(reqOf(2))).then(deliverResp(payload(2, 0, false)))
        .then(deliverPull(reqOf(1))).then(deliverResp(payload(1, NONE, false)))
        .expect(mark.get((1, 1)) == { e: 2, acked: false } and ackWillLand)
        .then(deliverAck(2, 1)).then(closeMove(2))
        .expect(allEnded and m5dData)

  run member7Test =
    init.then(start(1)).then(sendPull(1, 1)).then(deliverPull(reqOf(1)))
        .then(closeMove(1))
        .then(ownerPut(1)).then(beginY(1))
        .then(fullMove(2, true))
        .then(deliverResp(payload(1, NONE, false)))
        .expect(arec.contains((1, 1)) and not(receivesUnderIncoming) and mark.get((1, 1)) == { e: 2, acked: true })
        .then(handle(0, 2)).then(handle(1, 0)).then(complete(0))
        .expect(delivered and applied and m5dData)
}
module m5d_code_derived_return3 {
  import m5d_core(PARENT_RULE = false, ACK_RULE = false, CHILD_RULE = false, FINISHED_ANSWERS = true, MARKS = 0, ASK_AGAIN = false,
    ROUTE = [0, 1, 0, 1], GROUPS_N = 1, FULL = Set(), TXN = false, OWNER_OPS = true, RESTARTS = 1).*

  // 類の 6 は残る
  run member6Test =
    init.then(ownerPut(1))
        .then(fullMove(1, false)).then(fullMove(2, false)).then(fullMove(3, false))
        .then(ownerDel(1))
        .then(deliverResp(payload(1, 0, false)))
        .expect(row.get((1, 1)) == 0 and not(ownerHasTruth) and marksDerived)
}

// ============================================================================================================
// 赤: 緑から、条件を 1 つ外す
// ============================================================================================================

// 親の規則を外す (スイッチ rehandFinished)。親は、終わった fence の下で渡し直す。子の規則と印の関数があるので、行と印は壊れない
module m5d_red_rehand {
  import m5d_core(PARENT_RULE = false, ACK_RULE = false, CHILD_RULE = true, FINISHED_ANSWERS = true, MARKS = 0, ASK_AGAIN = true,
    ROUTE = [0, 1, 0], GROUPS_N = 1, FULL = Set(), TXN = true, OWNER_OPS = true, RESTARTS = 1).*

  // 類の 1 の手順。記録は付くが、関数で作る印は付かず (範囲を受け取り終えている)、phase 2 は適用される
  run rehandTest =
    init.then(emptyMoveLatePull(1)).then(emptyMove(2))
        .then(deliverPull(reqOf(1)))
        .expect(hrec.get((1, 1)) == 1 and not(handsUnderFence) and mark.get((0, 1)).e == 0)
        .then(deliverResp(payload(1, NONE, false)))
        .then(beginY(1)).then(handle(0, 0))
        .expect(delivered and applied and m5dData)

  // 類の 3 の手順。印がないのに記録があるので、書き込みは UNIQUE で失敗する (待っていた文は、内部の誤りで失敗する)
  run collideTest =
    init.then(ownerPut(1))
        .then(fullMove(1, false)).then(fullMove(2, false))
        .then(deliverPull(reqOf(1)))
        .expect(not(noFailedWrite) and m5dData)
}

// 子の規則を外す (スイッチ childAcceptsStale)。印の関数があっても、消した行は戻る
module m5d_red_child_stale {
  import m5d_core(PARENT_RULE = true, ACK_RULE = true, CHILD_RULE = false, FINISHED_ANSWERS = true, MARKS = 0, ASK_AGAIN = true,
    ROUTE = [0, 1, 0, 1], GROUPS_N = 1, FULL = Set(), TXN = false, OWNER_OPS = true, RESTARTS = 1).*

  // 類の 6
  run member6Test =
    init.then(ownerPut(1))
        .then(fullMove(1, false)).then(fullMove(2, false)).then(fullMove(3, false))
        .then(ownerDel(1))
        .then(deliverResp(payload(1, 0, false)))
        .expect(row.get((1, 1)) == 0 and not(ownerHasTruth) and not(receivesUnderIncoming) and marksDerived)

  // 移動 1 の遅れた pull への「渡し終えた」の答えが、1 が移動 3 を受け取っている間に届く。finishIncoming は区間で引くので、
  // 移動 3 の受け取りを終えてしまう。行は 0 に残ったままである
  run closeEarlyTest =
    init.then(emptyMoveLatePull(1)).then(emptyMove(2))
        .then(ownerPut(1))
        .then(start(3))
        .then(deliverPull(reqOf(1))).then(deliverResp(finished(1)))
        .expect(cdone.get(3) and not(pdone.get(3)) and row.get((0, 1)) == 0 and row.get((1, 1)) == NONE and not(ownerHasTruth))
}

// 「渡し終えた」を断りとして読む (取り下げた直し 89d99c8。スイッチ finishedAsRefusal)
module m5d_red_finished_refusal {
  import m5d_core(PARENT_RULE = true, ACK_RULE = true, CHILD_RULE = true, FINISHED_ANSWERS = false, MARKS = 0, ASK_AGAIN = true,
    ROUTE = [0, 1, 0], GROUPS_N = 1, FULL = Set(), TXN = true, OWNER_OPS = true, RESTARTS = 1).*

  // m5d_green_return の windowTest の手順。子は受け取り中のままで、待っていた文は group not arrived で断られる
  run windowTest =
    init.then(start(1)).then(parentFinish(1))
        .then(sendPull(1, 1)).then(deliverPull(reqOf(1)))
        .then(deliverResp(finished(1)))
        .expect(not(cdone.get(1)) and unarrived(1, 1) and not(noMoveRefusal) and m5dData)
}

// 捨てた答えの後で、尋ね直さない (5808b08 の arriveStep。規則にはない条件)
module m5d_red_ask_once {
  import m5d_core(PARENT_RULE = true, ACK_RULE = true, CHILD_RULE = true, FINISHED_ANSWERS = true, MARKS = 0, ASK_AGAIN = false,
    ROUTE = [0, 1, 0, 1], GROUPS_N = 1, FULL = Set(), TXN = false, OWNER_OPS = true, RESTARTS = 1).*

  // m5d_green_return3 の askAgainTest の手順。文は、移動 3 のグループが届いていないので、group not arrived で断られる
  run askOnceTest =
    init.then(emptyMoveLatePull(1)).then(emptyMove(2))
        .then(ownerPut(1))
        .then(start(3))
        .then(deliverPull(reqOf(1))).then(deliverResp(finished(1)))
        .expect(unarrived(1, 1) and not(noMoveRefusal) and m5dData)
}

// 印を、動いている間は手ごとに書き換え、起動のときだけ関数で作る (スイッチ bootMarksDiffer)。親の規則も外す
// (規則が 2 つともあれば、書き換えと関数は同じ印になる。下の m5d_marks_*)
module m5d_red_boot_differs {
  import m5d_core(PARENT_RULE = false, ACK_RULE = false, CHILD_RULE = true, FINISHED_ANSWERS = true, MARKS = 1, ASK_AGAIN = true,
    ROUTE = [0, 1, 0], GROUPS_N = 1, FULL = Set(), TXN = true, OWNER_OPS = true, RESTARTS = 1).*

  // 類の 1 の手順。動いている間の印は残り、起動のときの印は外れる
  run member1Test =
    init.then(emptyMoveLatePull(1)).then(emptyMove(2))
        .then(deliverPull(reqOf(1)))
        .expect(mark.get((0, 1)) == { e: 1, acked: false } and not(marksDerived) and markMatchesRecord)
        .then(beginY(1)).then(handle(0, 0))
        .expect(delivered and not(applied) and not(deliveredApplied))
        .then(restart(0))
        .expect(mark.get((0, 1)).e == 0 and marksDerived)

  // 類の 3 の手順。印は書き込みの後で付けるので、失敗した書き込みは印を残さない
  run member3Test =
    init.then(ownerPut(1))
        .then(fullMove(1, false)).then(fullMove(2, false))
        .then(deliverPull(reqOf(1)))
        .expect(not(noFailedWrite) and mark.get((0, 1)).e == 0 and marksDerived)
}

// 印を、記録の書き込みより前に付け、失敗しても残す (スイッチ markBeforeWrite)。書き込みが失敗するのは、親の規則がないときだけなので、
// 親の規則も外す。m5d_code_child_rule と同じ条件である
module m5d_red_mark_before_write {
  import m5d_core(PARENT_RULE = false, ACK_RULE = false, CHILD_RULE = true, FINISHED_ANSWERS = true, MARKS = 2, ASK_AGAIN = true,
    ROUTE = [0, 1, 0], GROUPS_N = 1, FULL = Set(), TXN = true, OWNER_OPS = true, RESTARTS = 1).*

  // 類の 3 の手順。メモリだけの印が残る
  run member3Test =
    init.then(ownerPut(1))
        .then(fullMove(1, false)).then(fullMove(2, false))
        .then(deliverPull(reqOf(1)))
        .expect(not(noFailedWrite) and mark.get((0, 1)) == { e: 1, acked: false } and hrec.get((1, 1)) == 2 and not(markMatchesRecord))
        .then(beginY(1)).then(handle(0, 0))
        .expect(delivered and not(applied) and not(deliveredApplied))
}

// ============================================================================================================
// 規則が 2 つともあるときの、印の書き方
// ============================================================================================================

// 親の規則と子の規則があり、印は 5808b08 のとおり (手ごとに書き換え、書き込みより前に付ける)
module m5d_marks_return {
  import m5d_core(PARENT_RULE = true, ACK_RULE = true, CHILD_RULE = true, FINISHED_ANSWERS = true, MARKS = 2, ASK_AGAIN = true,
    ROUTE = [0, 1, 0], GROUPS_N = 1, FULL = Set(), TXN = true, OWNER_OPS = true, RESTARTS = 1).*
}
module m5d_marks_chain {
  import m5d_core(PARENT_RULE = true, ACK_RULE = true, CHILD_RULE = true, FINISHED_ANSWERS = true, MARKS = 2, ASK_AGAIN = true,
    ROUTE = [0, 1, 2], GROUPS_N = 1, FULL = Set(), TXN = true, OWNER_OPS = true, RESTARTS = 1).*
}
module m5d_marks_return3 {
  import m5d_core(PARENT_RULE = true, ACK_RULE = true, CHILD_RULE = true, FINISHED_ANSWERS = true, MARKS = 2, ASK_AGAIN = true,
    ROUTE = [0, 1, 0, 1], GROUPS_N = 1, FULL = Set(), TXN = false, OWNER_OPS = true, RESTARTS = 1).*
}

// ack の規則だけを外す。終わった fence の下の ack が、空のグループの、ack を待つ印を ack 済みにする
module m5d_red_late_ack {
  import m5d_core(PARENT_RULE = true, ACK_RULE = false, CHILD_RULE = true, FINISHED_ANSWERS = true, MARKS = 0, ASK_AGAIN = true,
    ROUTE = [0, 1, 0], GROUPS_N = 1, FULL = Set(), TXN = true, OWNER_OPS = true, RESTARTS = 1).*
}

// ============================================================================================================
// 読み直しの試作: 親は終わった fence の pull に「渡し終えた」と答え、子は受け取り中の移動の応答だけを受け取って、「渡し終えた」で
// 受け取り終える。ack は 5808b08 のまま、印は手ごとに書き換えて書き込みの後で付け、文は 1 回だけ尋ねる
// ============================================================================================================

module m5d_prototype_return {
  import m5d_core(PARENT_RULE = true, ACK_RULE = false, CHILD_RULE = true, FINISHED_ANSWERS = true, MARKS = 1, ASK_AGAIN = false,
    ROUTE = [0, 1, 0], GROUPS_N = 1, FULL = Set(), TXN = true, OWNER_OPS = true, RESTARTS = 1).*
}
module m5d_prototype_chain {
  import m5d_core(PARENT_RULE = true, ACK_RULE = false, CHILD_RULE = true, FINISHED_ANSWERS = true, MARKS = 1, ASK_AGAIN = false,
    ROUTE = [0, 1, 2], GROUPS_N = 1, FULL = Set(), TXN = true, OWNER_OPS = true, RESTARTS = 1).*
}
module m5d_prototype_return3 {
  import m5d_core(PARENT_RULE = true, ACK_RULE = false, CHILD_RULE = true, FINISHED_ANSWERS = true, MARKS = 1, ASK_AGAIN = false,
    ROUTE = [0, 1, 0, 1], GROUPS_N = 1, FULL = Set(), TXN = false, OWNER_OPS = true, RESTARTS = 1).*
}
