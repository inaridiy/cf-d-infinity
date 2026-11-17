// M5c: 範囲が前の持ち主へ戻る間に届く phase 2 (未解決の問題 54)
//
// 2026-11-16 に書いた。実装より先に書いたモデルである (計画書の規則 3)。
// M5b (m5b_live_migration.qnt) の phase 2 は、moved 表で 1 回だけ転送する (phase2X)。範囲をもう一度動かす nextHop は、受け取り終えた子を
// 親に読み替えて新しい空の子へ渡すので、範囲は前の持ち主へ戻らない。M23b (m23b_refresh_two_moves.qnt) の yPhase2 は、いまの持ち主
// (holder) に 1 手で適用し、前の持ち主が受け取ったと答える状態がない。どちらも、前の持ち主が phase 2 を受け取ったと答える手と、
// 転送の列を確かめていない。
//
// 舞台。シャード S0 (=0) と S2 (=1)、グループ 1 つ。取引 Y は S0 で prepare した intent を持ち、anchor (別のシャード) が確定を決めて、
// 記録を書いている。S0 への phase 2 (finalize) は遅れて届く。範囲は S0 から S2 へ (移動 1)、S2 から S0 へ (移動 2)、MOVES_N = 3 なら
// もう一度 S0 から S2 へ (移動 3) 動く。移動の手は kernel.ts の段 4 の形である。
//   start   移動の move-start を親と子が適用する。移動 i は、移動 i-1 を終えた後でだけ始まる (Meta の moves-overlap)
//   pull    親が行と intent を応答に載せ、そのグループに「渡した」印を付ける (kernel.ts の moved)。intent が載ったら、その移動を
//           転送の記録に残す (__moved_txn)
//   recv    子が受け取る。行と intent を入れ、自分の「渡した」印を外す (receiveStep)
//   ack     親が、渡した行と intent を消す
//   finish  移動を終える (finishMove と finishIncoming)
// phase 2 の要求は、シャードの 1 手で処理する (finalizeStep)。piece を運ぶ転送 (pieces) は、そのシャードが受け取り中で、グループがまだ
// 届いていなければ、届くまで待つ (arrive)。届いた後か、受け取り中でなければ、次のことを 1 手でする。
//   1. 「渡した」印がなく、intent を持っていれば適用する (localIntents)
//   2. 「渡した」印があり、転送の記録にその移動があれば、渡した先へ転送する。転送の答えが返るまで、この要求は答えない (forwards)
//   3. どちらでもなければ、何もせずに答える
// anchor は、S0 への最初の要求が答えたら、届け終えた印を付ける (phase2Step の done)。届け終えた記録は、後で消してよい (gc)。
// 適用されないまま残った intent は、読み手か再駆動が anchor に尋ねて決着させる。記録が消えていれば presumed abort で捨てる。
//
// 規則の条件 (定数)。赤は 1 つずつ外す。
//   CLEAR_AT_START  「渡した」印を、範囲を受け取り直す移動の start で外す (段 4 のコードの moveStarted。赤)。緑では、グループが届いた
//                   とき (recv) だけに外す。運ばれなかったグループは finish で外すが、このモデルのグループはいつも運ばれる
//   FOLLOW_STALE    転送の記録を、いまの「渡した」印の移動に限らず、全部たどる (段 4 より前のコード。赤)
//   REHAND_FINISHED 終わった移動の遅れた pull に、親がグループを渡し直す (未解決の問題 55。赤)。緑では、終わった移動の pull を断る
//                   (親は、終わっていない fence の下でだけ渡す。終わった移動の子は、そのグループを受け取り終えている)
//
// 2026-11-16 (2 回目)。問題 55 を足した。範囲が前の親へ戻った後に、前の移動の遅れた pull が届くと、親はグループを、終わった移動の fence で
// もう一度渡そうとし、「渡した」印を付け直した (印は __moved への書き込みより前にメモリへ付けていたので、書き込みが失敗しても残った)。
// 印が付くと、自分の intent に届いた phase 2 を、前の移動の子へ転送する。
//
// invariant
//   deliveredApplied  anchor が届け終えた印を付けたなら、Y の書き込みは適用されている (問題 54 の不変条件の候補: 参加者は、intent を
//                     適用したか、いまの持ち主へ転送した後でだけ、phase 2 を受け取ったと答える)
//   noLostWrite       確定した Y の intent を、presumed abort で捨てない
//   finalValue        移動を全部終えて届け終えたら、いまの持ち主の行は Y の値である
//   boundedForwards   転送の数は、移動の数以下である
//   handsUnderFence   親がグループを渡す (印を付ける) のは、その移動が終わる前だけである (問題 55)
// temporal
//   delivers          phase 2 は、いつか届け終わる
module m5c_core {
  const CLEAR_AT_START: bool
  const FOLLOW_STALE: bool
  const REHAND_FINISHED: bool
  const MOVES_N: int

  pure val S0 = 0
  pure val S2 = 1
  pure val SHARDS = Set(S0, S2)
  pure def src(i: int): int = if (i % 2 == 1) S0 else S2
  pure def dst(i: int): int = if (i % 2 == 1) S2 else S0
  pure val MOVES = 1.to(MOVES_N)
  // 転送の上限。これを超える転送は作らず、overflow に印を付ける (状態を有限にする。boundedForwards が見る)
  pure val CAP = MOVES_N + 2
  // 要求の状態
  pure val PENDING = 0
  pure val WAITING = 1
  pure val DONE = 2

  type Move = { started: bool, pulled: bool, flying: bool, carry: bool, rowVal: int, arrived: bool, acked: bool, finished: bool }
  type Req = { at: int, pieces: int, st: int, child: int }

  var mv: int -> Move
  // グループの行の値。-1 は行を持っていない。初めの値は 0 で、Y の書き込みは 1 にする
  var row: int -> int
  // Y の intent の写しを持っている (適用していない)
  var intent: int -> bool
  // 「渡した」印。そのグループを渡した移動の番号で、0 は印なし
  var mark: int -> int
  // 転送の記録 (__moved_txn)。Y の intent を載せた pull の移動の番号
  var movedTxn: int -> Set[int]
  var reqs: List[Req]
  var record: bool
  var applied: bool
  var lost: bool
  var overflow: bool
  var staleHand: bool

  val noMove: Move = { started: false, pulled: false, flying: false, carry: false, rowVal: -1, arrived: false, acked: false, finished: false }

  action init = all {
    mv' = MOVES.mapBy(_ => noMove),
    row' = Map(S0 -> 0, S2 -> -1),
    intent' = Map(S0 -> true, S2 -> false),
    mark' = Map(S0 -> 0, S2 -> 0),
    movedTxn' = Map(S0 -> Set(), S2 -> Set()),
    // anchor は確定を決めて記録を書き、S0 へ phase 2 を送った。届くのは後である
    reqs' = [{ at: S0, pieces: 0, st: PENDING, child: -1 }],
    record' = true,
    applied' = false,
    lost' = false,
    overflow' = false,
    staleHand' = false,
  }

  def delivered: bool = reqs[0].st == DONE
  // d が受け取り中の移動 (start の後、finish の前で、行き先が d)
  def receiving(d: int): Set[int] = MOVES.filter(i => mv.get(i).started and not(mv.get(i).finished) and dst(i) == d)
  def unarrived(d: int): bool = receiving(d).exists(i => not(mv.get(i).arrived))

  // ---- 移動 ----
  action start(i: int): bool = all {
    not(mv.get(i).started), if (i == 1) true else mv.get(i - 1).finished,
    mv' = mv.setBy(i, m => m.with("started", true)),
    // 段 4 のコード (赤): 範囲を受け取り直す移動を始めたところで、「渡した」印を外す
    mark' = if (CLEAR_AT_START) mark.set(dst(i), 0) else mark,
    row' = row, intent' = intent, movedTxn' = movedTxn, reqs' = reqs, record' = record, applied' = applied, lost' = lost, overflow' = overflow, staleHand' = staleHand,
  }
  action pull(i: int): bool = all {
    mv.get(i).started, not(mv.get(i).pulled),
    val s = src(i)
    all {
      mv' = mv.setBy(i, m => m.with("pulled", true).with("flying", true).with("carry", intent.get(s)).with("rowVal", row.get(s))),
      mark' = mark.set(s, i),
      movedTxn' = if (intent.get(s)) movedTxn.setBy(s, x => x.union(Set(i))) else movedTxn,
      row' = row, intent' = intent, reqs' = reqs, record' = record, applied' = applied, lost' = lost, overflow' = overflow, staleHand' = staleHand,
    }
  }
  action recv(i: int): bool = all {
    mv.get(i).flying,
    val d = dst(i)
    all {
      mv' = mv.setBy(i, m => m.with("flying", false).with("arrived", true)),
      row' = row.set(d, mv.get(i).rowVal),
      intent' = intent.set(d, intent.get(d) or mv.get(i).carry),
      mark' = mark.set(d, 0),
      movedTxn' = movedTxn, reqs' = reqs, record' = record, applied' = applied, lost' = lost, overflow' = overflow, staleHand' = staleHand,
    }
  }
  action ack(i: int): bool = all {
    mv.get(i).arrived, not(mv.get(i).acked),
    val s = src(i)
    all {
      mv' = mv.setBy(i, m => m.with("acked", true)),
      row' = row.set(s, -1),
      intent' = intent.set(s, false),
      mark' = mark, movedTxn' = movedTxn, reqs' = reqs, record' = record, applied' = applied, lost' = lost, overflow' = overflow, staleHand' = staleHand,
    }
  }
  action finish(i: int): bool = all {
    mv.get(i).acked, not(mv.get(i).finished),
    mv' = mv.setBy(i, m => m.with("finished", true)),
    row' = row, intent' = intent, mark' = mark, movedTxn' = movedTxn, reqs' = reqs, record' = record, applied' = applied, lost' = lost, overflow' = overflow, staleHand' = staleHand,
  }

  // ---- phase 2 ----
  // 転送の宛先の移動。緑では、いまの「渡した」印の移動が転送の記録にあるときだけ。FOLLOW_STALE では、記録のどれでも
  def forwardVia(d: int): Set[int] =
    if (FOLLOW_STALE) movedTxn.get(d)
    else if (mark.get(d) > 0 and movedTxn.get(d).contains(mark.get(d))) Set(mark.get(d))
    else Set()
  // e は転送に使う移動 (forwardVia の 1 つ)。転送しないなら 0
  action handle(r: int, e: int): bool = all {
    r < reqs.length(),
    reqs[r].st == PENDING,
    val d = reqs[r].at
    val local = intent.get(d) and mark.get(d) == 0
    val via = forwardVia(d)
    val full = reqs.length() > CAP
    all {
      // piece を運ぶ転送は、受け取り中でグループがまだ届いていなければ、届くのを待つ (arrive が pull する)
      reqs[r].pieces == 0 or not(unarrived(d)),
      if (via == Set()) e == 0 else via.contains(e),
      row' = if (local) row.set(d, 1) else row,
      intent' = if (local) intent.set(d, false) else intent,
      applied' = (applied or local),
      // 転送が多すぎるときは、転送を作らずに止めて印を付ける (boundedForwards が破れる)
      reqs' = if (e == 0 or full) reqs.replaceAt(r, reqs[r].with("st", DONE))
              else reqs.replaceAt(r, reqs[r].with("st", WAITING).with("child", reqs.length())).append({ at: dst(e), pieces: e, st: PENDING, child: -1 }),
      overflow' = (overflow or (e > 0 and full)),
      mv' = mv, mark' = mark, movedTxn' = movedTxn, record' = record, lost' = lost, staleHand' = staleHand,
    }
  }
  // 転送の答えが返ったら、転送した要求も答える
  action complete(r: int): bool = all {
    r < reqs.length(),
    reqs[r].st == WAITING, reqs[reqs[r].child].st == DONE,
    reqs' = reqs.replaceAt(r, reqs[r].with("st", DONE)),
    mv' = mv, row' = row, intent' = intent, mark' = mark, movedTxn' = movedTxn, record' = record, applied' = applied, lost' = lost, overflow' = overflow, staleHand' = staleHand,
  }
  // anchor が、届け終えた取引の記録を消す (TXN_RETAIN_MS の後の gc)
  action gc = all {
    delivered, record,
    record' = false,
    mv' = mv, row' = row, intent' = intent, mark' = mark, movedTxn' = movedTxn, reqs' = reqs, applied' = applied, lost' = lost, overflow' = overflow, staleHand' = staleHand,
  }
  // 自分のものとして持っている intent を、読み手か再駆動が anchor に尋ねて決着させる。記録がなければ presumed abort で捨てる
  action resolve(d: int): bool = all {
    intent.get(d), mark.get(d) == 0,
    row' = if (record) row.set(d, 1) else row,
    intent' = intent.set(d, false),
    applied' = (applied or record),
    lost' = (lost or not(record)),
    mv' = mv, mark' = mark, movedTxn' = movedTxn, reqs' = reqs, record' = record, overflow' = overflow, staleHand' = staleHand,
  }

  // 終わった移動 i の遅れた pull が、親に届く。REHAND_FINISHED なら、印がその移動のものでなければ、渡し直して印を付ける (赤)。緑では断る
  // (状態は変わらないので、手として書かない)
  action stalePull(i: int): bool = all {
    REHAND_FINISHED, mv.get(i).finished,
    val s = src(i)
    all {
      mark.get(s) != i,
      mark' = mark.set(s, i),
      movedTxn' = if (intent.get(s)) movedTxn.setBy(s, x => x.union(Set(i))) else movedTxn,
      staleHand' = true,
    },
    mv' = mv, row' = row, intent' = intent, reqs' = reqs, record' = record, applied' = applied, lost' = lost, overflow' = overflow,
  }

  action step = any {
    { nondet i = oneOf(MOVES) any { start(i), pull(i), recv(i), ack(i), finish(i), stalePull(i) } },
    { nondet r = oneOf(0.to(CAP)) nondet e = oneOf(0.to(MOVES_N)) any { handle(r, e), complete(r) } },
    gc,
    { nondet d = oneOf(SHARDS) resolve(d) },
  }

  // ---- 不変条件 ----
  val deliveredApplied = not(delivered) or applied
  val noLostWrite = not(lost)
  def holder: int = dst(MOVES_N)
  val finalValue = not(delivered and mv.get(MOVES_N).finished) or row.get(holder) == 1
  val boundedForwards = not(overflow) and reqs.length() <= MOVES_N + 1
  val handsUnderFence = not(staleHand)
  val m5cSafe = deliveredApplied and noLostWrite and finalValue and boundedForwards and handsUnderFence

  // ---- witness ----
  // phase 2 が、戻る移動の途中で S0 に届き、S2 へ転送され、S2 からまた S0 へ転送されて、S0 で適用された
  val witnessForwardBack = not(delivered and applied and reqs.length() == 3 and reqs[2].at == S0)
  // phase 2 が、S2 に転送され、S2 がまだ渡していない intent をそこで適用した
  val witnessAppliedAtS2 = not(delivered and applied and reqs.length() == 2 and row.get(S2) == 1 and mv.get(2).started)

  // ---- 活性 ----
  val vars = (mv, row, intent, mark, movedTxn, reqs, record, applied, lost, overflow, staleHand)
  temporal fairness = and {
    MOVES.forall(i => weakFair(start(i), vars) and weakFair(pull(i), vars) and weakFair(recv(i), vars) and weakFair(ack(i), vars) and weakFair(finish(i), vars)),
    0.to(CAP).forall(r => 0.to(MOVES_N).forall(e => weakFair(handle(r, e), vars)) and weakFair(complete(r), vars)),
  }
  temporal delivers = fairness implies eventually(delivered)
}

// 緑: 「渡した」印は、グループが届いたときに外す。転送は、いまの印の移動の記録だけをたどる。移動 2 回 (S0 → S2 → S0)
module m5c_green {
  import m5c_core(CLEAR_AT_START = false, FOLLOW_STALE = false, REHAND_FINISHED = false, MOVES_N = 2).*
  // test/open/phase2-during-return.test.ts の順序。移動 1 の後、戻る移動 2 が始まり、S0 がまだ引き取っていないところで phase 2 が届く
  run returnTest =
    init.then(start(1)).then(pull(1)).then(recv(1)).then(ack(1)).then(finish(1))
        .then(start(2))
        .expect(mark.get(S0) == 1 and intent.get(S2))
        .then(handle(0, 1))                                // S0 は、まだ渡した印を持っているので S2 へ転送する
        .expect(reqs.length() == 2 and reqs[1].at == S2 and reqs[1].pieces == 1)
        .then(pull(2))                                     // S2 が S0 へ渡す (intent が載る)
        .then(handle(1, 2))                                // S2 は渡した印の移動 2 の記録で、S0 へ転送し返す
        .expect(reqs.length() == 3 and reqs[2].at == S0 and reqs[2].pieces == 2)
        .then(recv(2))                                     // S0 にグループが届く。印が外れる
        .then(handle(2, 0))                                // S0 で適用する
        .then(complete(1)).then(complete(0))
        .then(ack(2)).then(finish(2))
        .expect(delivered and applied and row.get(S0) == 1 and m5cSafe)
        .then(gc)
        .expect(m5cSafe)
}

// 緑: 移動 3 回 (S0 → S2 → S0 → S2)
module m5c_green3 {
  import m5c_core(CLEAR_AT_START = false, FOLLOW_STALE = false, REHAND_FINISHED = false, MOVES_N = 3).*
}

// 赤: 段 4 のコード。範囲を受け取り直す移動の start で印を外す。S0 は intent も印も持たないまま答え、届け終えた記録が消えた後に、
// 戻ってきた intent を presumed abort で捨てる
module m5c_red_clear_at_start {
  import m5c_core(CLEAR_AT_START = true, FOLLOW_STALE = false, REHAND_FINISHED = false, MOVES_N = 2).*
  run lostTest =
    init.then(start(1)).then(pull(1)).then(recv(1)).then(ack(1)).then(finish(1))
        .then(start(2))
        .expect(mark.get(S0) == 0 and not(intent.get(S0)))
        .then(handle(0, 0))                                // S0 は何もせずに答える
        .expect(delivered and not(applied) and not(deliveredApplied))
        .then(gc)
        .then(pull(2)).then(recv(2))
        .then(resolve(S0))                                 // 記録がないので、確定した書き込みを捨てる
        .expect(lost and not(noLostWrite))
}

// 赤: 段 4 より前のコード。転送の記録を全部たどる。範囲が戻った後に届いた phase 2 を、S0 と S2 が互いに転送し合う
module m5c_red_follow_stale {
  import m5c_core(CLEAR_AT_START = false, FOLLOW_STALE = true, REHAND_FINISHED = false, MOVES_N = 2).*
  run pingPongTest =
    init.then(start(1)).then(pull(1)).then(recv(1)).then(ack(1)).then(finish(1))
        .then(start(2)).then(pull(2)).then(recv(2)).then(ack(2)).then(finish(2))
        .then(handle(0, 1))                                // S0 は適用し、移動 1 の記録で S2 へも転送する
        .then(handle(1, 2))                                // S2 は移動 2 の記録で S0 へ転送する
        .then(handle(2, 1))                                // S0 は、また移動 1 の記録で S2 へ転送する
        .expect(applied and reqs.length() == 4 and not(boundedForwards))
}

// 赤: 問題 55。範囲が S0 へ戻った後に、移動 1 の遅れた pull が S0 に届き、S0 はグループを渡し直して、移動 1 の印を付ける。S0 に届いた
// phase 2 は、自分の intent に適用されずに S2 へ転送され、S2 は移動 2 の記録で S0 へ転送し返す
module m5c_red_rehand {
  import m5c_core(CLEAR_AT_START = false, FOLLOW_STALE = false, REHAND_FINISHED = true, MOVES_N = 2).*
  run staleTest =
    init.then(start(1)).then(pull(1)).then(recv(1)).then(ack(1)).then(finish(1))
        .then(start(2)).then(pull(2)).then(recv(2)).then(ack(2)).then(finish(2))
        .expect(mark.get(S0) == 0 and intent.get(S0))
        .then(stalePull(1))
        .expect(mark.get(S0) == 1 and not(handsUnderFence))
        .then(handle(0, 1))                                // S0 は、印があるので自分で適用せず、S2 へ転送する
        .then(handle(1, 2))                                // S2 は移動 2 の記録で S0 へ転送し返す
        .then(handle(2, 1))
        .expect(not(applied) and not(boundedForwards))
}
