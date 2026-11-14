// M20: グループを piece に分けて運ぶ間も、確定した取引は UNIQUE を守って適用できる (不変条件 2 の UNIQUE の部分)
//
// 背景。shard key を含む UNIQUE は、各シャードの SQLite の index が守る (M16)。これは「1 つの shard key の行は 1 つのシャードに
// ある」ことに頼っている。subslot の設計 (docs/design-subslots.md) は、グループを piece (主キーの順の区間) に分けて運ぶ。
// fence の前に置かれた intent は、piece と一緒に別々の時点に運ばれ、別々に適用される。取引 X が、同じグループの行 r1 (piece 1) と
// r2 (piece 2) の UNIQUE の値を、r2 は 'b' から 'c' へ、r1 は 'a' から 'b' へ変えるとする。piece 1 が届き、X が確定し、子が r1 の
// intent を適用すると、子の r1 は 'b' になる。その後で piece 2 が古い行 r2 = 'b' を運んで届くと、子の UNIQUE の index が挿入を断り、
// piece 2 は届かなくなる。親の側にも同じ形がある。親は、渡した piece の行を ack まで控えとして持つので、まだ渡していない piece の
// 分だけを適用すると、控えの行と衝突する。
//
// 設計 (docs/design-subslots.md「書き込みが続く間の大きなグループ」)。次の 3 つを合わせる。
//   (1) 親は、グループの最初の piece を切る前に、そのグループの UNIQUE の値に触れる intent を決着させる。確定していれば、グループの
//       全体を持っているうちに、取引の分をまとめて適用する。決着が付かなければ、pull を待たせる
//   (2) fence の後、親は新しい intent を受けない
//   (3) 子は、グループが揃うまで、そのグループの UNIQUE の値を書く文を受けない
// 3 つが揃うと、最初の piece を切ってからグループが子で揃うまで、そのグループの UNIQUE の値は変わらない。
// 扱うのは、グループの全部が移る場合 (slot の全体の移動) である。slot を subslot で割る移動では、親にグループの一部が残り、
// 親は残る行への書き込みを受け続けるので、(2) が成り立たない (m20_red_late_intent の形)。その場合の規則は、このモデルにない。
//
// モデル。M16 を 2 つのシャードに広げた。グループ 1 つ、行 3 つ (行 1 は piece 1、行 2 と行 3 は piece 2)、値は 0 (行がない) と
// 1..NVAL、取引 2 つ。取引は 1 行か 2 行に値を書く (0 は消す)。書き込みはどれも UNIQUE の値に触れる (触れない書き込みは、
// このモデルに関係がない)。prepare は M16 の 2 つの状態で確かめる。確かめる相手は、受けたシャードの表である。
// 親の表 tabP は、切った piece の行も ack まで持つ。piece は、切る (cutPiece)、届く (receive)、ack の順に進む。
// intent は行と一緒に動く。行が親にある間は親に、piece が届いた後は子にある (M18 の intentNotLost)。
// 適用 (applyAt) は、そのシャードがいま持っている、その取引の intent を、まとめて 1 度に適用する。
//
// invariants
//   committedApplies: 確定した取引の適用も、piece の受け取りも、シャードの UNIQUE の index に断られない
//   uniqueVisible:    見える状態 (行の持ち主の値に、確定して未適用の intent を重ねたもの) に、同じ値の行が 2 つない
module m20_core {
  const NVAL: int               // 値の種類
  const SETTLE: int             // 親が piece を切る前に決着させる intent。0: しない
                                //   1: グループの最初の piece を切る前に、グループの全部
                                //   2: 切る piece の中の intent だけ (piece を切るたびに)
  const PARENT_STOPS: bool      // fence の後、親は新しい intent を受けない
  const CHILD_CHECK: int        // 子が UNIQUE の値を書く文を受ける条件。0: グループが揃ってから
                                //   1: 揃う前でも受け、手元の行だけで確かめる
                                //   2: 揃う前でも受け、手元の行と、まだ届いていない piece の親の行で確かめる

  pure val P = 1
  pure val C = 2
  pure val ROWS = Set(1, 2, 3)
  pure val PIECES = Set(1, 2)
  pure def pieceOf(r: int): int = if (r == 1) 1 else 2
  pure val VALS = 0.to(NVAL)
  pure val TXNS = Set(1, 2)

  var tabP: int -> int              // 親の表。行 -> 値 (0 は行がない)。切った piece の行も、ack まで控えとして残る
  var tabC: int -> int              // 子の表
  var cut: Set[int]                 // 親が切った piece
  var arr: Set[int]                 // 子に届いた piece
  var acked: Set[int]
  var fenced: bool
  var intents: int -> (int -> int)  // 取引 -> (行 -> 書いた後の値)。適用した行は除く
  var status: int -> str            // "idle" | "pending" | "committed" | "aborted" | "applied"
  var home: int -> int              // 取引を受けたシャード (0 はまだ)
  var broken: bool                  // ghost: 適用か受け取りで UNIQUE を破った
  var marks: Set[int]               // ghost: 到達の確認のための印
                                    //   1: fence の後、最初の piece を切る前に、未決着だった取引が決着した (pull が待った)
                                    //   2: 2 つの piece にまたがる取引が、1 度に適用された
                                    //   3: 子が受けた取引が、子で適用された

  pure def unique(m: int -> int): bool =
    ROWS.forall(a => ROWS.forall(b => a == b or m.get(a) == 0 or m.get(a) != m.get(b)))
  pure def overlay(base: int -> int, w: int -> int): int -> int =
    ROWS.mapBy(r => if (w.keys().contains(r)) w.get(r) else base.get(r))
  pure def restrict(w: int -> int, rows: Set[int]): int -> int = w.keys().intersect(rows).mapBy(r => w.get(r))
  pure val empty: int -> int = ROWS.mapBy(_ => 0)

  // シャード d が持ち主である行。親は切っていない piece、子は届いた piece (切られて飛んでいる piece の行は、どちらでもない)
  def rowsAt(d: int): Set[int] =
    if (d == P) ROWS.filter(r => not(cut.contains(pieceOf(r)))) else ROWS.filter(r => arr.contains(pieceOf(r)))
  def tab(d: int): int -> int = if (d == P) tabP else tabC
  // 行の持ち主の値。届くまでは親の値 (切った後は控え) である
  def owned: int -> int = ROWS.mapBy(r => if (arr.contains(pieceOf(r))) tabC.get(r) else tabP.get(r))
  /** 本体にまだ入っていない intent を持つ取引 (未決着と、確定したが未適用)。 */
  def open(u: int): bool = Set("pending", "committed").contains(status.get(u))
  def holders(t: int): Set[int] = TXNS.filter(u => u != t and open(u))
  def lockedRows(t: int): Set[int] = holders(t).map(u => intents.get(u).keys()).flatten()
  // シャード d から見える、ほかの取引の intent を適用した状態
  def othersApplied(d: int, t: int, base: int -> int): int -> int =
    holders(t).fold(base, (m, u) => overlay(m, restrict(intents.get(u), rowsAt(d))))
  // 行の集合 rows に、決着していない (未決着か、確定して未適用の) intent がある
  def unsettled(rows: Set[int]): bool = TXNS.exists(u => open(u) and intents.get(u).keys().intersect(rows) != Set())

  pure val WRITES: Set[int -> int] =
    ROWS.powerset().filter(s => s.size() >= 1 and s.size() <= 2).map(s => s.setOfMaps(VALS)).flatten()

  action init = {
    nondet b = ROWS.setOfMaps(VALS).filter(m => unique(m)).oneOf()
    all {
      tabP' = b, tabC' = empty, cut' = Set(), arr' = Set(), acked' = Set(), fenced' = false,
      intents' = TXNS.mapBy(_ => Map()), status' = TXNS.mapBy(_ => "idle"), home' = TXNS.mapBy(_ => 0),
      broken' = false, marks' = Set()
    }
  }
  // run のための初期状態
  action given(b: int -> int): bool = all {
    tabP' = b, tabC' = empty, cut' = Set(), arr' = Set(), acked' = Set(), fenced' = false,
    intents' = TXNS.mapBy(_ => Map()), status' = TXNS.mapBy(_ => "idle"), home' = TXNS.mapBy(_ => 0),
    broken' = false, marks' = Set()
  }

  action keepMove = all { cut' = cut, arr' = arr, acked' = acked, fenced' = fenced }
  action keepTabs = all { tabP' = tabP, tabC' = tabC }
  action keepTxn = all { intents' = intents, status' = status, home' = home }

  // シャード d が、取引 t の書き込み w を受ける。M16 の 2 つの状態で UNIQUE を確かめる
  action prepare(d: int, t: int, w: int -> int): bool = all {
    status.get(t) == "idle",
    w.keys().subseteq(rowsAt(d)),
    w.keys().intersect(lockedRows(t)) == Set(),
    if (d == P) (not(PARENT_STOPS) or not(fenced)) else (CHILD_CHECK != 0 or arr == PIECES),
    val base = if (d == C and CHILD_CHECK == 2) owned else tab(d)
    all {
      unique(overlay(base, w)),
      unique(overlay(othersApplied(d, t, base), w)),
      intents' = intents.set(t, w), status' = status.set(t, "pending"), home' = home.set(t, d),
      broken' = broken, marks' = marks, keepMove, keepTabs
    }
  }

  action decide(t: int, commit: bool): bool = all {
    status.get(t) == "pending",
    status' = status.set(t, if (commit) "committed" else "aborted"),
    intents' = if (commit) intents else intents.set(t, Map()),
    marks' = if (fenced and cut == Set()) marks.union(Set(1)) else marks,
    home' = home, broken' = broken, keepMove, keepTabs
  }

  // シャード d が、取引 t の intent のうち、いま持っているものを、まとめて適用する (phase 2、または読み手による決着)
  action applyAt(d: int, t: int): bool = all {
    status.get(t) == "committed",
    val s = intents.get(t).keys().intersect(rowsAt(d))
    val after = overlay(tab(d), restrict(intents.get(t), s))
    val rest = intents.get(t).keys().exclude(s)
    all {
      s != Set(),
      tabP' = if (d == P) after else tabP,
      tabC' = if (d == C) after else tabC,
      broken' = (broken or not(unique(after))),
      intents' = intents.set(t, restrict(intents.get(t), rest)),
      status' = if (rest == Set()) status.set(t, "applied") else status,
      marks' = marks.union(if (s.map(r => pieceOf(r)) == PIECES) Set(2) else Set())
                    .union(if (d == C and home.get(t) == C) Set(3) else Set()),
      home' = home, keepMove
    }
  }

  action fence = all {
    not(fenced), fenced' = true,
    cut' = cut, arr' = arr, acked' = acked,
    broken' = broken, marks' = marks, keepTabs, keepTxn
  }

  // 親が piece を切る (最初の pull に答えて m を決める)。切った piece の行は、親ではもう変わらない
  action cutPiece(p: int): bool = all {
    fenced, not(cut.contains(p)),
    SETTLE != 1 or cut != Set() or not(unsettled(ROWS)),
    SETTLE != 2 or not(unsettled(ROWS.filter(r => pieceOf(r) == p))),
    cut' = cut.union(Set(p)),
    arr' = arr, acked' = acked, fenced' = fenced,
    broken' = broken, marks' = marks, keepTabs, keepTxn
  }

  // 子が piece を受け取る。行を自分の表に挿入する。その piece の intent も一緒に子のものになる
  action receive(p: int): bool = all {
    cut.contains(p), not(arr.contains(p)),
    val after = ROWS.mapBy(r => if (pieceOf(r) == p) tabP.get(r) else tabC.get(r))
    all {
      tabC' = after, tabP' = tabP,
      broken' = (broken or not(unique(after))),
      arr' = arr.union(Set(p)),
      cut' = cut, acked' = acked, fenced' = fenced,
      marks' = marks, keepTxn
    }
  }

  // 親が ack を受け、控えの行を消す
  action ack(p: int): bool = all {
    arr.contains(p), not(acked.contains(p)),
    tabP' = ROWS.mapBy(r => if (pieceOf(r) == p) 0 else tabP.get(r)), tabC' = tabC,
    acked' = acked.union(Set(p)),
    cut' = cut, arr' = arr, fenced' = fenced,
    broken' = broken, marks' = marks, keepTxn
  }

  action step = any {
    { nondet d = Set(P, C).oneOf() nondet t = TXNS.oneOf() nondet w = WRITES.oneOf() prepare(d, t, w) },
    { nondet t = TXNS.oneOf() nondet c = Set(true, false).oneOf() decide(t, c) },
    { nondet d = Set(P, C).oneOf() nondet t = TXNS.oneOf() applyAt(d, t) },
    fence,
    { nondet p = PIECES.oneOf() cutPiece(p) },
    { nondet p = PIECES.oneOf() receive(p) },
    { nondet p = PIECES.oneOf() ack(p) }
  }

  val committedApplies = not(broken)
  val uniqueVisible = unique(TXNS.filter(u => status.get(u) == "committed").fold(owned, (m, u) => overlay(m, intents.get(u))))
  val uniqueSafe = committedApplies and uniqueVisible

  /** 到達できることの確かめ。 */
  // 2 つの piece にまたがる取引が確定して適用され、グループが 2 つの piece で子へ移った
  val witnessCrossAppliedThenMoved = not(marks.contains(2) and arr == PIECES)
  // fence の後も未決着だった取引が決着するのを待ってから、グループが子へ移った
  val witnessFirstCutWaited = not(marks.contains(1) and arr == PIECES)
  // グループが揃った後で、子が UNIQUE の値を書く取引を受け、適用した
  val witnessChildWrote = not(marks.contains(3))
  // 片方の piece だけが届いている間に、子が UNIQUE の値を書く取引を受け、適用した (CHILD_CHECK = 2)
  val witnessChildWroteEarly = not(marks.contains(3) and arr != PIECES)
}

// 決めた設計。親は、グループの最初の piece を切る前に、グループの intent を決着させる
module m20_green {
  import m20_core(NVAL = 2, SETTLE = 1, PARENT_STOPS = true, CHILD_CHECK = 0).*
  // 設計の文書の例。値は 'a' = 1、'b' = 2 で、X は r1 と r2 の値を入れ替える
  run settledTest =
    init.then(given(Map(1 -> 1, 2 -> 2, 3 -> 0)))
        .then(prepare(P, 1, Map(1 -> 2, 2 -> 1)))     // X: r1 は 'a' から 'b'、r2 は 'b' から 'a'
        .then(fence)
        .expect(unsettled(ROWS))                      // 最初の piece は切れない (pull は待つ)
        .then(decide(1, true))
        .expect(unsettled(ROWS))                      // 確定しても、適用するまでは切れない
        .then(applyAt(P, 1))                          // 親が、グループの全体を持っているうちに、まとめて適用する
        .expect(tabP == Map(1 -> 2, 2 -> 1, 3 -> 0) and marks == Set(1, 2))
        .then(cutPiece(1)).then(receive(1)).then(ack(1))
        .then(cutPiece(2)).then(receive(2)).then(ack(2))
        .expect(tabC == Map(1 -> 2, 2 -> 1, 3 -> 0) and tabP == empty and uniqueSafe)
        .then(prepare(C, 2, Map(3 -> 1, 2 -> 0)))     // 揃った後は、子が UNIQUE の値を書く文を受ける
        .then(decide(2, true)).then(applyAt(C, 2))
        .expect(tabC == Map(1 -> 2, 2 -> 0, 3 -> 1) and marks.contains(3) and uniqueSafe)
}

// 決着させる範囲を、切る piece の中の intent だけにする。これでも破れない (どちらの規則でも、UNIQUE の値に触れる intent は
// piece と一緒に運ばれない)
module m20_green_per_piece {
  import m20_core(NVAL = 2, SETTLE = 2, PARENT_STOPS = true, CHILD_CHECK = 0).*
}

// 決着させずに切る (設計の文書が見つけた形)。piece ごとに適用され、確定した取引が適用できなくなる。
// 見える状態は UNIQUE を守ったままである (uniqueVisible は破れない)。破れるのは適用である
module m20_red_piecewise {
  import m20_core(NVAL = 2, SETTLE = 0, PARENT_STOPS = true, CHILD_CHECK = 0).*
  // 値の入れ替え。'a' = 1、'b' = 2
  run counterexampleTest =
    init.then(given(Map(1 -> 1, 2 -> 2, 3 -> 0)))
        .then(prepare(P, 1, Map(1 -> 2, 2 -> 1)))     // X: r1 は 'a' から 'b'、r2 は 'b' から 'a'
        .then(fence)
        .then(cutPiece(1)).then(receive(1))           // piece 1 が、r1 = 'a' と intent を運んで届く
        .then(decide(1, true))                        // X が確定する
        .then(applyAt(C, 1))                          // 子が r1 の intent を適用する。子の r1 は 'b'
        .then(cutPiece(2)).then(receive(2))           // piece 2 が、古い行 r2 = 'b' を運んで届く。子の index が断る
        .expect(broken and uniqueVisible)
}
// 同じ形を、設計の文書の例そのままの値で固定する (値が 3 種類。run だけに使う)
module m20_red_piecewise_note {
  import m20_core(NVAL = 3, SETTLE = 0, PARENT_STOPS = true, CHILD_CHECK = 0).*
  // 設計の文書の例。値は 'a' = 1、'b' = 2、'c' = 3
  run counterexampleTest =
    init.then(given(Map(1 -> 1, 2 -> 2, 3 -> 0)))
        .then(prepare(P, 1, Map(1 -> 2, 2 -> 3)))     // X: r2 は 'b' から 'c'、r1 は 'a' から 'b'
        .then(fence)
        .then(cutPiece(1)).then(receive(1))           // piece 1 が、r1 = 'a' と intent を運んで届く
        .then(decide(1, true))                        // X が確定する
        .then(applyAt(C, 1))                          // 子が r1 の intent を適用する。子の r1 は 'b'
        .expect(tabC.get(1) == 2 and not(broken) and uniqueVisible)
        .then(cutPiece(2)).then(receive(2))           // piece 2 が、古い行 r2 = 'b' を運んで届く。子の index が断る
        .expect(broken and uniqueVisible)
  // 親の側。piece 2 を先に渡す (主キーを名指しした pull)。親は r2 の控えを持ったまま、r1 の分だけを適用する
  run parentSideTest =
    init.then(given(Map(1 -> 1, 2 -> 2, 3 -> 0)))
        .then(prepare(P, 1, Map(1 -> 2, 2 -> 3)))
        .then(fence)
        .then(cutPiece(2)).then(receive(2))           // 親の表には、控えの r2 = 'b' が残っている
        .then(decide(1, true))
        .then(applyAt(P, 1))                          // 親が r1 を 'b' にする。控えの r2 = 'b' と衝突する
        .expect(broken and uniqueVisible)
}

// fence の後も、親が、まだ渡していない行への intent を受ける。最初の piece を切った後に置かれた intent は、決着を待たれない
module m20_red_late_intent {
  import m20_core(NVAL = 2, SETTLE = 1, PARENT_STOPS = false, CHILD_CHECK = 0).*
  run counterexampleTest =
    init.then(given(Map(1 -> 1, 2 -> 2, 3 -> 0)))
        .then(fence)
        .then(cutPiece(1)).then(receive(1)).then(ack(1))   // r1 = 1 は子にあり、親の表にはもうない
        .then(prepare(P, 1, Map(2 -> 1)))             // 親は r2 を 1 にする書き込みを受ける。親の表では衝突しない
        .then(decide(1, true))
        .expect(not(uniqueVisible))                   // r1 と r2 がどちらも 1 になる
        .then(cutPiece(2)).then(receive(2))
        .then(applyAt(C, 1))                          // 子で適用すると、index が断る
        .expect(broken)
}

// 子が、グループが揃う前に、手元の行だけで確かめて UNIQUE の値を書く文を受ける
module m20_red_child_early {
  import m20_core(NVAL = 2, SETTLE = 1, PARENT_STOPS = true, CHILD_CHECK = 1).*
  run counterexampleTest =
    init.then(given(Map(1 -> 1, 2 -> 2, 3 -> 0)))
        .then(fence)
        .then(cutPiece(1)).then(receive(1))           // 子には r1 = 1 だけがある。r2 = 2 は親にある
        .then(prepare(C, 1, Map(1 -> 2)))             // 子は r1 を 2 にする書き込みを受ける。子の表では衝突しない
        .then(decide(1, true)).then(applyAt(C, 1))
        .expect(not(uniqueVisible))
        .then(cutPiece(2)).then(receive(2))           // piece 2 が r2 = 2 を運んで届く。子の index が断る
        .expect(broken)
}

// 子が、グループが揃う前でも、手元の行と、まだ届いていない piece の親の行を合わせて確かめる。
// 親がグループの全部を決着させてから切る (SETTLE = 1) なら、親に残る行は変わらないので、破れない。
// 読みと prepare の間に何も入らないものとして表した (読みを取引の span として検証する手順は、このモデルにない)
module m20_green_child_reads_parent {
  import m20_core(NVAL = 2, SETTLE = 1, PARENT_STOPS = true, CHILD_CHECK = 2).*
}
// 同じ確かめ方でも、決着させるのが切る piece の中の intent だけ (SETTLE = 2) だと破れる。
// 親に残る piece に未決着の intent があり、子の確かめはそれを見ない
module m20_red_child_reads_parent_per_piece {
  import m20_core(NVAL = 2, SETTLE = 2, PARENT_STOPS = true, CHILD_CHECK = 2).*
  run counterexampleTest =
    init.then(given(Map(1 -> 1, 2 -> 0, 3 -> 0)))
        .then(prepare(P, 1, Map(2 -> 2)))             // X: r2 (piece 2) を 2 にする。未決着のまま
        .then(fence)
        .then(cutPiece(1)).then(receive(1))           // piece 1 に intent はないので、切れる
        .then(prepare(C, 2, Map(1 -> 2)))             // 子は r1 を 2 にする書き込みを受ける。親の r2 はまだ 0 に見える
        .then(decide(1, true)).then(decide(2, true))
        .expect(not(uniqueVisible))
}
