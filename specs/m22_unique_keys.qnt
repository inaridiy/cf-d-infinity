// M22: 主キー以外の UNIQUE を、論理のキーの行 1 種類にまとめる。グループが piece ごとに動く間も、UNIQUE の値を書く文が通る
//
// 実装より先に書いたモデルで、対応する実装はまだない (docs/design-unique-keys.md)。
//
// 背景。いまの UNIQUE は 2 通りである。shard key を含む UNIQUE は、シャードの SQLite の UNIQUE の index が守り、ほかの取引の未確定の
// 値は、intent を全部試しに適用して確かめる (M16、uniquePending)。shard key を含まない UNIQUE は、index の表 __gidx_<index> の行
// (値を主キーにした 1 行) を、同じ取引で書く。前者は「1 つの shard key の行は 1 つのシャードにある」ことに頼るので、グループを piece
// ごとに運ぶと、確定した取引が適用できなくなる (M20)。M20 の緑は 3 つの規則を足したが、その 1 つ (子はグループが揃うまで UNIQUE の
// 値を書く文を受けない) は、大きなテナントが動く間、UNIQUE のある表への 1 行の INSERT まで migrating: で失敗させる。
//
// 設計。どの UNIQUE も、__gidx と同じ形の「キーの行」で守る。キーの行は (制約, 値の正規形) を主キーにした 1 行で、その値を持つ行の
// 主キー (holder) を持つ。値を書く取引は、行と一緒にキーの行も書く。新しい値のキーの行は「ない」から holder へ、手放す値のキーの
// 行は holder から「ない」へ。キーの行も行なので、置き場所 (token)、piece、持ち主の確かめ、intent、ロック、2PC は、行と同じ規則に
// 乗る。shard key を含む UNIQUE のキーの行は、テナントの slot のブロックに置くので、テナントが分かれていなければ行と同じシャードに
// ある。シャードの物理の index は一意でない (検索のための index) にする。
//
// モデル。M20 の舞台を使う。親 P、子 C、グループ 1 つ、行 2 つ (行 1 は piece 1、行 2 は piece 2)、値は 0 (行がないか、キーの列が
// NULL) と 1..NVAL。値 v ごとに、キーの位置が 1 つある。キーの位置を覆う piece は、最初に任意に選ぶ (kpiece)。行と同じ piece の
// ことも、違う piece のこともある。キーの行が「ない」ときも位置はあり、その位置を覆う piece が届けば、子は「ない」と言える。
//   MOVE_ALL = true   グループの全部が piece ごとに子へ移る (design-subslots.md の段 2)。fence の後、親はグループに書かない
//   MOVE_ALL = false  piece 1 は親に残り、piece 2 だけが移る (段 4、テナントを割る)。親は piece 1 の位置の書き込みを受け続ける
// 取引は 1 行か 2 行の値を書く (計画)。計画は、そのときの見える状態から行の古い値を読み、キーの行の変更を作る。シャードは、自分が
// 持つ位置の部分を確かめて intent を置く (prepare。1 つの取引の部分は、シャードごとに別の手で、別の時点に置かれる)。全部の部分の
// intent が置かれたら確定できる。適用は、そのシャードがいま持つ位置の intent をまとめて行う。intent は位置の piece と一緒に動く。
// 決着させてから piece を切る規則 (M20 の SETTLE) はない。
//
// invariants
//   committedApplies    確定した取引の適用も、piece の受け取りも失敗しない。物理の index は一意でないので、失敗するのは、キーの行の
//                       intent が確かめたときと違う値に当たるか、届いたキーの行が子の同じキーの行とぶつかる場合である
//   uniqueVisible       見える状態の行の値 (キーの行ではない) に、同じ値の行が 2 つない
//   keysExact           見える状態のキーの行は、行の値のちょうど逆の写像である (値 v を持つ行は r だけ ⇔ キーの行 v の holder は r)
//   noMigratingRefusal  UNIQUE の値を書く取引を、移動の途中だという理由で断らない (受け入れの条件。M20 の規則は破る)
// temporal
//   writeTerminates     計画した取引は、移動が途中で止まっても (新しい piece を切る手に公平性がなくても) いつか確定か中止になる
module m22_core {
  const NVAL: int               // 値の種類 (キーの位置の数)
  const MOVE_ALL: bool          // true: グループの全部が移る。false: piece 1 は親に残る
  const NTXN: int
  // ---- 設計の条件。赤は 1 つずつ外す ----
  const KEY_OWNER: bool         // キーの部分は、キーの位置の持ち主が確かめる。false なら、その値を持つ (持つことになる) 行のシャードが、
                                //   自分の手元のキーの行で確かめる (シャードの中の index と同じ考え方)
  const PULL_KEY: bool          // 子は、キーの位置を覆う piece が届くまで、そのキーを確かめない。false なら、届いていないキーを「ない」と見なす
  const KEY_LOCK: bool          // キーの行の intent は、ほかの取引の同じキーの部分を断る
  const KEY_BODY: bool          // キーの持ち主は、確定したキーの行が、計画が読んだ holder と同じかを確かめる
  const KEY_IN_TXN: bool        // キーの行は、行と同じ 2PC の参加者である。false なら、行だけで確定し、キーの行は確定の後に書く
  const RELEASE_OLD: bool       // 行が値を手放す (UPDATE で変える、DELETE) とき、古い値のキーの行も消す
  const KEY_INTENT_MOVES: bool  // キーの行の intent は、キーの位置の piece と一緒に動く。false なら、その値を持つ行の piece と一緒に動く
  const PHYS_UNIQUE: bool       // (外すと true) シャードの物理の index を UNIQUE のままにする
  // ---- 設計の選択肢 ----
  const PARENT_UNTIL_CUT: bool  // 親は、fence の後も、まだ切っていない piece の位置の prepare を受ける (M20 の PARENT_STOPS を外す)
  const CHILD_GROUP: int        // 0 設計: 子は、部分の位置を覆う piece だけを待つ (足りなければ、その piece を pull する)
                                // 1 M20 の規則: グループが揃うまで、UNIQUE の値を書く取引を migrating で断る
                                // 2 グループが揃うまで待つ
  const TRACK: bool             // witness のための印を持つ

  pure val P = 1
  pure val C = 2
  pure val SHARDS = Set(1, 2)
  pure val ROWS = Set(1, 2)
  pure val PIECES = Set(1, 2)
  // 行 r は piece r にある
  pure def pieceOfRow(r: int): int = r
  pure val MOVED = if (MOVE_ALL) Set(1, 2) else Set(2)
  pure val VALS = 1.to(NVAL)
  pure val ALLV = 0.to(NVAL)
  pure val TXNS = 1.to(NTXN)
  // 位置。行 r は r、値 v のキーの行は KB + v
  pure val KB = 10
  pure def kpos(v: int): int = KB + v
  pure def isKey(x: int): bool = x > KB
  pure def valOf(x: int): int = x - KB

  var tab: int -> (int -> int)      // シャード -> 行 -> 値 (0 は行がないか NULL)。親は、切った piece の行を ack まで控えとして持つ
  var key: int -> (int -> int)      // シャード -> 値 -> キーの行の holder (0 はキーの行がない)。控えは行と同じ
  var kpiece: int -> int            // 値 -> そのキーの位置を覆う piece。最初に選び、変えない
  var fenced: bool                  // 親が move-start を適用した (M21)
  var cut: Set[int]                 // 親が切った piece (最初の pull に答えて m を決めた)
  var arr: Set[int]                 // 子に届いた piece
  var acked: Set[int]
  var status: int -> str            // "idle" | "planned" | "committed" | "aborted" | "applied"
  var w: int -> (int -> int)        // 取引 -> 行 -> 書く値
  var old: int -> (int -> int)      // 取引 -> 行 -> 計画が読んだ値
  var did: int -> Set[int]          // 取引 -> intent を置いた位置 (適用した後も残る)
  var prep: int -> Set[int]         // 取引 -> まだ適用していない intent の位置
  var broken: bool                  // ghost: 適用か受け取りが失敗した
  var migRefused: bool              // ghost: 移動の途中だという理由で、UNIQUE の値を書く取引を断った
  var marks: Set[int]               // ghost: witness の印 (下の witness の注釈)
  var fromP: Set[int]               // ghost: 子のキーの行のうち、値が親から届いたもの (届いた後に子が書いていない)
  var steps: int -> Set[int]        // ghost: 取引 -> intent を適用したシャード
  var midSame: Set[int]             // ghost: 移動の途中に、子が、行と同じ piece のキーを取る部分を受けた取引
  var midOther: Set[int]            // ghost: 同じく、行と違う piece のキーを取る部分を受けた取引

  pure def unique(m: int -> int): bool =
    ROWS.forall(a => ROWS.forall(b => a == b or m.get(a) == 0 or m.get(a) != m.get(b)))
  pure def pick(s: Set[int]): int = s.fold(0, (m, r) => if (r > m) r else m)

  // ---- キーの行の変更。行の古い値 o と書く値 wr から作る ----
  // 値 v を手放す行と、v を取る行。1 つの取引は、1 つの値を 2 つの行に書かない (文の時点で UNIQUE 違反になる)
  pure def relOf(o: int -> int, wr: int -> int, v: int): Set[int] = wr.keys().filter(r => o.get(r) == v and wr.get(r) != v)
  pure def acqOf(o: int -> int, wr: int -> int, v: int): Set[int] = wr.keys().filter(r => wr.get(r) == v and o.get(r) != v)
  // キーの行の変更 v -> { b: 計画が読んだ holder, a: 書いた後の holder }
  pure def entB(o: int -> int, wr: int -> int, v: int): int = if (RELEASE_OLD) pick(relOf(o, wr, v)) else 0
  pure def kwOf(o: int -> int, wr: int -> int): int -> { b: int, a: int } =
    VALS.filter(v => entB(o, wr, v) != pick(acqOf(o, wr, v)))
        .mapBy(v => { b: entB(o, wr, v), a: pick(acqOf(o, wr, v)) })

  def kw(t: int): int -> { b: int, a: int } = kwOf(old.get(t), w.get(t))
  def keyParts(t: int): Set[int] = kw(t).keys().map(v => kpos(v))
  def parts(t: int): Set[int] = w.get(t).keys().union(keyParts(t))
  def pieceOf(x: int): int = if (isKey(x)) kpiece.get(valOf(x)) else pieceOfRow(x)
  // 位置の値がいまある所。切っていない piece は親、届いた piece は子、切って飛んでいる piece はどちらでもない (0)
  def liveOwner(x: int): int = if (not(cut.contains(pieceOf(x)))) P else if (arr.contains(pieceOf(x))) C else 0
  // キーの部分に関わる行 (取る行、なければ手放す行)
  def assoc(t: int, x: int): int = if (kw(t).get(valOf(x)).a != 0) kw(t).get(valOf(x)).a else kw(t).get(valOf(x)).b
  def moving: bool = fenced and not(MOVED.subseteq(arr))
  // シャード d が、位置 x の部分を受けられるか。親は、fence の後、移る piece の位置を受けない (M21 の move-start)
  def canAccept(d: int, x: int): bool =
    liveOwner(x) == d and (d == C or not(fenced) or not(MOVED.contains(pieceOf(x))) or PARENT_UNTIL_CUT)
  // シャード d が、取引 t の位置 x の部分を、いま確かめられるか
  def readyAt(d: int, t: int, x: int): bool =
    if (not(isKey(x))) canAccept(d, x)
    else if (KEY_OWNER) canAccept(d, x) or
      (not(PULL_KEY) and d == C and fenced and MOVED.contains(pieceOf(x)) and not(arr.contains(pieceOf(x))))
    else canAccept(d, assoc(t, x))
  // intent がいまある所 (適用するシャード)
  def loc(t: int, x: int): int = if (isKey(x) and not(KEY_INTENT_MOVES)) liveOwner(assoc(t, x)) else liveOwner(x)
  def valAt(d: int, x: int): int = if (isKey(x)) key.get(d).get(valOf(x)) else tab.get(d).get(x)
  def expected(t: int, x: int): int = if (isKey(x)) kw(t).get(valOf(x)).b else old.get(t).get(x)
  def isOpen(u: int): bool = Set("planned", "committed").contains(status.get(u))
  def foreign(t: int, x: int): bool = TXNS.exists(u => u != t and isOpen(u) and prep.get(u).contains(x))
  // 部分の確かめ。行もキーの行も、ほかの取引の intent がなく (ロック)、値が計画の読んだものと同じであること
  def okPart(d: int, t: int, x: int): bool =
    if (isKey(x)) (not(KEY_LOCK) or not(foreign(t, x))) and (not(KEY_BODY) or valAt(d, x) == expected(t, x))
    else not(foreign(t, x)) and valAt(d, x) == expected(t, x)

  // ---- 見える状態 (位置の持ち主の値に、確定して未適用の intent を重ねたもの) ----
  // 位置の持ち主の値。届くまでは親の値 (切った後は控え) である
  def ownerData(r: int): int = if (arr.contains(pieceOfRow(r))) tab.get(C).get(r) else tab.get(P).get(r)
  def ownerKey(v: int): int = if (arr.contains(kpiece.get(v))) key.get(C).get(v) else key.get(P).get(v)
  def committedTxns: Set[int] = TXNS.filter(u => status.get(u) == "committed")
  def visData: int -> int =
    ROWS.mapBy(r => committedTxns.fold(ownerData(r), (acc, u) => if (prep.get(u).contains(r)) w.get(u).get(r) else acc))
  def visKey: int -> int =
    VALS.mapBy(v => committedTxns.fold(ownerKey(v), (acc, u) => if (prep.get(u).contains(kpos(v))) kw(u).get(v).a else acc))

  pure val WRITES: Set[int -> int] =
    ROWS.powerset().filter(s => s.size() >= 1 and s.size() <= 2).map(s => s.setOfMaps(ALLV)).flatten()

  action init = {
    nondet b = ROWS.setOfMaps(ALLV).filter(m => unique(m)).oneOf()
    nondet kp = VALS.setOfMaps(PIECES).oneOf()
    all {
      tab' = Map(P -> b, C -> ROWS.mapBy(_ => 0)),
      key' = Map(P -> VALS.mapBy(v => pick(ROWS.filter(r => b.get(r) == v))), C -> VALS.mapBy(_ => 0)),
      kpiece' = kp,
      fenced' = false, cut' = Set(), arr' = Set(), acked' = Set(),
      status' = TXNS.mapBy(_ => "idle"), w' = TXNS.mapBy(_ => Map()), old' = TXNS.mapBy(_ => Map()),
      did' = TXNS.mapBy(_ => Set()), prep' = TXNS.mapBy(_ => Set()),
      broken' = false, migRefused' = false, marks' = Set(), fromP' = Set(),
      steps' = TXNS.mapBy(_ => Set()), midSame' = Set(), midOther' = Set(),
    }
  }
  // run のための初期状態 (init の後に、これで置き換える)。中身は init と同じ (quint は init と step で同じ action を使えない)
  action given(b: int -> int, kp: int -> int): bool = all {
    tab' = Map(P -> b, C -> ROWS.mapBy(_ => 0)),
    key' = Map(P -> VALS.mapBy(v => pick(ROWS.filter(r => b.get(r) == v))), C -> VALS.mapBy(_ => 0)),
    kpiece' = kp,
    fenced' = false, cut' = Set(), arr' = Set(), acked' = Set(),
    status' = TXNS.mapBy(_ => "idle"), w' = TXNS.mapBy(_ => Map()), old' = TXNS.mapBy(_ => Map()),
    did' = TXNS.mapBy(_ => Set()), prep' = TXNS.mapBy(_ => Set()),
    broken' = false, migRefused' = false, marks' = Set(), fromP' = Set(),
    steps' = TXNS.mapBy(_ => Set()), midSame' = Set(), midOther' = Set(),
  }

  action keepTabs = all { tab' = tab, key' = key }
  action keepMove = all { kpiece' = kpiece, fenced' = fenced, cut' = cut, arr' = arr, acked' = acked }
  action keepTxn = all { status' = status, w' = w, old' = old, did' = did, prep' = prep }
  action keepGhost = all {
    broken' = broken, migRefused' = migRefused, marks' = marks, fromP' = fromP, steps' = steps,
    midSame' = midSame, midOther' = midOther
  }

  // Worker が文を実行して、取引 t の書き込みを決める。行の古い値は、そのときの見える状態から読む
  action plan(t: int, wr: int -> int): bool = {
    val o = wr.keys().mapBy(r => visData.get(r))
    all {
      status.get(t) == "idle",
      wr.keys().exists(r => wr.get(r) != o.get(r)),
      VALS.forall(v => acqOf(o, wr, v).size() <= 1),
      status' = status.set(t, "planned"), w' = w.set(t, wr), old' = old.set(t, o),
      did' = did, prep' = prep, keepTabs, keepMove, keepGhost
    }
  }

  // 取引 t の、まだ intent を置いていない部分のうち、シャード d がいま確かめられるもの。
  // KEY_IN_TXN を外すと、確定の前は行の部分だけ、確定の後はキーの部分だけになる
  def todo(t: int): Set[int] =
    parts(t).exclude(did.get(t)).filter(x =>
      if (KEY_IN_TXN) true else if (status.get(t) == "planned") not(isKey(x)) else isKey(x))
  def ready(d: int, t: int): Set[int] = todo(t).filter(x => readyAt(d, t, x))
  def mayPrepare(t: int): bool = status.get(t) == "planned" or (status.get(t) == "committed" and not(KEY_IN_TXN))
  // M20 の規則が掛かるか: 子が、グループが揃う前に、UNIQUE の値を書く取引の部分を受けようとしている
  def groupGate(d: int, t: int): bool = CHILD_GROUP != 0 and d == C and kw(t) != Map() and not(MOVED.subseteq(arr))
  // prepare の手が打てるか (活性の run の確かめに使う)
  def canPrepare(d: int, t: int): bool = mayPrepare(t) and ready(d, t) != Set() and not(groupGate(d, t) and CHILD_GROUP == 2)

  // 断った部分の印。3: 行とキーが別のシャードにあり、キーの持ち主が断った。5: 親から届いたキーの行で、子が断った
  def refuseMarks(d: int, t: int, bad: Set[int]): Set[int] =
    (if (bad.exists(x => isKey(x) and liveOwner(assoc(t, x)) == SHARDS.exclude(Set(d)).fold(0, (a, s) => s))) Set(3) else Set())
      .union(if (d == C and bad.exists(x => isKey(x) and fromP.contains(valOf(x)) and key.get(C).get(valOf(x)) != 0)) Set(5) else Set())
  // 子が移動の途中に、キーを取る部分を受けた
  def midKey(d: int, t: int, rs: Set[int], same: bool): bool =
    d == C and moving and rs.exists(x => isKey(x) and kw(t).get(valOf(x)).a != 0 and
      ((pieceOf(x) == pieceOfRow(kw(t).get(valOf(x)).a)) == same))

  action prepareAt(d: int, t: int): bool = {
    val st = status.get(t)
    val rs = ready(d, t)
    val bad = rs.filter(x => not(okPart(d, t, x)))
    all {
      mayPrepare(t),
      rs != Set(),
      not(groupGate(d, t) and CHILD_GROUP == 2),
      if (groupGate(d, t) and CHILD_GROUP == 1 and st == "planned") all {
        // M20 の規則: グループが揃うまで、UNIQUE の値を書く取引を migrating で断る
        status' = status.set(t, "aborted"), prep' = prep.set(t, Set()), did' = did, w' = w, old' = old,
        migRefused' = true,
        broken' = broken, marks' = marks, fromP' = fromP, steps' = steps, midSame' = midSame, midOther' = midOther,
        keepTabs, keepMove
      } else if (bad == Set()) all {
        did' = did.set(t, did.get(t).union(rs)), prep' = prep.set(t, prep.get(t).union(rs)),
        status' = status, w' = w, old' = old,
        midSame' = if (TRACK and midKey(d, t, rs, true)) midSame.union(Set(t)) else midSame,
        midOther' = if (TRACK and midKey(d, t, rs, false)) midOther.union(Set(t)) else midOther,
        broken' = broken, migRefused' = migRefused, marks' = marks, fromP' = fromP, steps' = steps,
        keepTabs, keepMove
      } else all {
        // 断る。確定の前なら取引は中止になる。確定の後に断られたら (KEY_IN_TXN を外した赤)、確定した取引の分が入らない
        status' = if (st == "planned") status.set(t, "aborted") else status,
        prep' = if (st == "planned") prep.set(t, Set()) else prep,
        broken' = (broken or st == "committed"),
        marks' = if (TRACK) marks.union(refuseMarks(d, t, bad)) else marks,
        did' = did, w' = w, old' = old, migRefused' = migRefused, fromP' = fromP, steps' = steps,
        midSame' = midSame, midOther' = midOther,
        keepTabs, keepMove
      }
    }
  }

  // anchor が決める。確定は、全部の部分の intent が置かれた後だけ (KEY_IN_TXN を外すと、行の部分だけ)
  action decide(t: int, commit: bool): bool = all {
    status.get(t) == "planned",
    not(commit) or (if (KEY_IN_TXN) parts(t) else w.get(t).keys()).subseteq(did.get(t)),
    status' = status.set(t, if (commit) "committed" else "aborted"),
    prep' = if (commit) prep else prep.set(t, Set()),
    did' = did, w' = w, old' = old, keepTabs, keepMove, keepGhost
  }

  // シャード d が、取引 t の intent のうち、いま自分にあるものを、まとめて 1 度に適用する (phase 2、または読み手による決着)
  action applyAt(d: int, t: int): bool = {
    val s = prep.get(t).filter(x => loc(t, x) == d)
    val rest = prep.get(t).exclude(s)
    val tabD = ROWS.mapBy(r => if (s.contains(r)) w.get(t).get(r) else tab.get(d).get(r))
    val keyD = VALS.mapBy(v => if (s.contains(kpos(v))) kw(t).get(v).a else key.get(d).get(v))
    val bad = s.exists(x => valAt(d, x) != expected(t, x)) or (PHYS_UNIQUE and not(unique(tabD)))
    val fin = rest == Set() and parts(t).subseteq(did.get(t))
    val before = steps.get(t)
    val swap = kw(t).keys().exists(v => kw(t).get(v).b != 0 and kw(t).get(v).a != 0)
    all {
      status.get(t) == "committed",
      s != Set(),
      tab' = tab.set(d, tabD), key' = key.set(d, keyD),
      broken' = (broken or bad),
      prep' = prep.set(t, rest),
      status' = if (fin) status.set(t, "applied") else status,
      fromP' = if (TRACK and d == C) fromP.exclude(s.filter(x => isKey(x)).map(x => valOf(x))) else fromP,
      steps' = if (TRACK) steps.set(t, before.union(Set(d))) else steps,
      marks' = if (not(TRACK) or not(fin)) marks else marks
        .union(if (midSame.contains(t)) Set(1) else Set())
        .union(if (midOther.contains(t)) Set(2) else Set())
        .union(if (before != Set()) Set(6) else Set())
        .union(if (before != Set() and swap and fenced) Set(7) else Set())
        .union(if (before.union(Set(d)) == SHARDS) Set(8) else Set()),
      did' = did, w' = w, old' = old, migRefused' = migRefused, midSame' = midSame, midOther' = midOther,
      keepMove
    }
  }

  action fence = all {
    not(fenced), fenced' = true,
    kpiece' = kpiece, cut' = cut, arr' = arr, acked' = acked, keepTabs, keepTxn, keepGhost
  }

  // 親が piece を切る (子の pull に答えて m を決める)。決着させる規則はない
  action cutPiece(p: int): bool = all {
    fenced, MOVED.contains(p), not(cut.contains(p)),
    cut' = cut.union(Set(p)),
    kpiece' = kpiece, fenced' = fenced, arr' = arr, acked' = acked, keepTabs, keepTxn, keepGhost
  }

  // 子が piece を受け取る。行とキーの行を自分の表に入れる。その位置の intent も、一緒に子のものになる
  action receive(p: int): bool = {
    val rs = ROWS.filter(r => pieceOfRow(r) == p)
    val vs = VALS.filter(v => kpiece.get(v) == p)
    val tabC = ROWS.mapBy(r => if (rs.contains(r)) tab.get(P).get(r) else tab.get(C).get(r))
    val keyC = VALS.mapBy(v => if (vs.contains(v)) key.get(P).get(v) else key.get(C).get(v))
    val clash = rs.exists(r => tab.get(C).get(r) != 0) or vs.exists(v => key.get(C).get(v) != 0)
    all {
      cut.contains(p), not(arr.contains(p)),
      tab' = tab.set(C, tabC), key' = key.set(C, keyC),
      broken' = (broken or clash or (PHYS_UNIQUE and not(unique(tabC)))),
      arr' = arr.union(Set(p)),
      fromP' = if (TRACK) fromP.union(vs.filter(v => key.get(P).get(v) != 0)) else fromP,
      marks' = if (TRACK and vs.exists(v => key.get(P).get(v) != 0)) marks.union(Set(4)) else marks,
      kpiece' = kpiece, fenced' = fenced, cut' = cut, acked' = acked,
      migRefused' = migRefused, steps' = steps, midSame' = midSame, midOther' = midOther, keepTxn
    }
  }

  // 親が ack を受け、控え (行とキーの行) を消す
  action ack(p: int): bool = all {
    arr.contains(p), not(acked.contains(p)),
    tab' = tab.set(P, ROWS.mapBy(r => if (pieceOfRow(r) == p) 0 else tab.get(P).get(r))),
    key' = key.set(P, VALS.mapBy(v => if (kpiece.get(v) == p) 0 else key.get(P).get(v))),
    acked' = acked.union(Set(p)),
    kpiece' = kpiece, fenced' = fenced, cut' = cut, arr' = arr, keepTxn, keepGhost
  }

  action step = any {
    { nondet t = TXNS.oneOf() nondet wr = WRITES.oneOf() plan(t, wr) },
    { nondet d = SHARDS.oneOf() nondet t = TXNS.oneOf() prepareAt(d, t) },
    { nondet t = TXNS.oneOf() nondet c = Set(true, false).oneOf() decide(t, c) },
    { nondet d = SHARDS.oneOf() nondet t = TXNS.oneOf() applyAt(d, t) },
    fence,
    { nondet p = PIECES.oneOf() cutPiece(p) },
    { nondet p = PIECES.oneOf() receive(p) },
    { nondet p = PIECES.oneOf() ack(p) }
  }

  // ---- 不変条件 ---------------------------------------------------------------
  val committedApplies = not(broken)
  val uniqueVisible = unique(visData)
  val keysExact = and {
    VALS.forall(v => visKey.get(v) == 0 or visData.get(visKey.get(v)) == v),
    ROWS.forall(r => visData.get(r) == 0 or visKey.get(visData.get(r)) == r)
  }
  val noMigratingRefusal = not(migRefused)
  val uniqueSafe = committedApplies and uniqueVisible and keysExact and noMigratingRefusal

  // ---- 活性 -------------------------------------------------------------------
  // 計画した取引は、Worker が中止しなくても、いつか確定か中止になる。移動がそれ以上進まなくても (要らない piece が切られなくても)
  // そうなる。仮定する公平性: シャードは、確かめられる部分を確かめる (prepare の弱い公平性)。子は、部分の位置を覆う piece が親に
  // あれば pull し、親はそれを切る (demandCut の弱い公平性)。切った piece は届く (receive の弱い公平性)。anchor は、全部の intent が
  // 置かれたら確定する (decide の弱い公平性)。要らない piece を切る手 (cutPiece) と中止には、公平性を置かない
  def needed(p: int): bool = TXNS.exists(t => status.get(t) == "planned" and todo(t).exists(x => pieceOf(x) == p))
  action demandCut = { nondet p = PIECES.oneOf() all { needed(p), cutPiece(p) } }
  action receiveAny = { nondet p = PIECES.oneOf() receive(p) }
  val vars = (tab, key, kpiece, fenced, cut, arr, acked, status, w, old, did, prep, broken, migRefused, marks, fromP, steps,
              midSame, midOther)
  temporal fairness = and {
    weakFair(prepareAt(P, 1), vars), weakFair(prepareAt(C, 1), vars), weakFair(decide(1, true), vars),
    weakFair(demandCut, vars), weakFair(receiveAny, vars)
  }
  temporal writeTerminates = fairness implies always(status.get(1) == "planned" implies eventually(status.get(1) != "planned"))

  // ---- witness (vacuous でないことの確かめ) ------------------------------------
  // 1: 移動の途中に、子が、行と同じ piece のキーを取る部分を受け、その取引が確定して適用された
  val witnessWriteDuringMoveSamePiece = not(marks.contains(1))
  // 2: 同じく、キーの位置が行と違う piece にある (子は、キーの piece を pull してから確かめた)
  val witnessWriteDuringMoveOtherPiece = not(marks.contains(2))
  // 3: 行とキーが別のシャードにあり、キーの持ち主が、ほかの行の持つ値だとして断った
  val witnessCrossShardConflict = not(marks.contains(3))
  // 5: キーの行が piece と一緒に子へ移り (holder を持ったまま)、子が、それを見て、同じ値を取る部分を断った
  val witnessKeyMovedThenChecked = not(marks.contains(5))
  // 6: 確定した取引の intent が、2 度以上に分けて適用された (piece ごとの適用。決着させてから切る規則なしで)
  val witnessPiecewiseApply = not(marks.contains(6))
  // 7: 値を 2 つの行の間で動かす取引 (入れ替えを含む) が、fence の後に、piece ごとに分けて適用された (M20 の反例の形)
  val witnessSwapAcrossPieces = not(marks.contains(7))
  // 8: 親と子の両方に intent を置いた取引が、両方で適用された (行とキーの行が別のシャードの 2PC)
  val witnessTwoShardCommit = not(marks.contains(8))
}

// 決めた設計。グループの全部が piece ごとに移る (段 2)
module m22_green {
  import m22_core(NVAL = 2, MOVE_ALL = true, NTXN = 2,
                  KEY_OWNER = true, PULL_KEY = true, KEY_LOCK = true, KEY_BODY = true, KEY_IN_TXN = true, RELEASE_OLD = true,
                  KEY_INTENT_MOVES = true, PHYS_UNIQUE = false, PARENT_UNTIL_CUT = false, CHILD_GROUP = 0, TRACK = true).*
  // M20 の反例 (m20_red_piecewise) の形。決着させずに切っても、確定した取引は適用できる
  run swapTest =
    init.then(given(Map(1 -> 1, 2 -> 2), Map(1 -> 1, 2 -> 2)))   // r1 = 'a'、r2 = 'b'。キー 1 は piece 1、キー 2 は piece 2
        .then(plan(1, Map(1 -> 2, 2 -> 1)))           // X: r1 は 'a' から 'b'、r2 は 'b' から 'a'
        .expect(kw(1) == Map(1 -> { b: 1, a: 2 }, 2 -> { b: 2, a: 1 }))
        .then(prepareAt(P, 1))                        // 4 つの部分 (行 2 つ、キーの行 2 つ) を親に置く
        .then(fence)
        .then(cutPiece(1)).then(receive(1))           // piece 1 が、r1 とキー 1 を、intent と一緒に運ぶ
        .then(decide(1, true))
        .then(applyAt(C, 1))                          // 子が r1 とキー 1 の分を適用する。子の r1 は 'b'
        .then(cutPiece(2)).then(receive(2))           // piece 2 が古い r2 = 'b' を運ぶ。物理の index は一意でないので入る
        .expect(tab.get(C) == Map(1 -> 2, 2 -> 2) and not(broken) and uniqueSafe)
        .then(applyAt(C, 1))
        .expect(tab.get(C) == Map(1 -> 2, 2 -> 1) and key.get(C) == Map(1 -> 2, 2 -> 1) and status.get(1) == "applied"
                and marks.contains(6) and marks.contains(7) and uniqueSafe)
  // 移動の途中の 1 行の INSERT。キーの位置は、まだ切っていない piece にある。子は、その piece を pull してから確かめる
  run insertDuringMoveTest =
    init.then(given(Map(1 -> 0, 2 -> 0), Map(1 -> 2, 2 -> 2)))
        .then(fence)
        .then(cutPiece(1)).then(receive(1))           // piece 1 (行 1 の位置) だけが届いている
        .then(plan(1, Map(1 -> 1)))                   // INSERT: 行 1 に値 1
        .expect(not(canPrepare(C, 1)) or ready(C, 1) == Set(1))
        .then(prepareAt(C, 1))                        // 行 1 の部分だけを置く。キー 1 の位置 (piece 2) はまだ親にある
        .expect(did.get(1) == Set(1))
        .then(cutPiece(2)).then(receive(2))           // 子が piece 2 を pull する
        .then(prepareAt(C, 1))                        // キー 1 は「ない」と、届いた piece で言える
        .then(decide(1, true)).then(applyAt(C, 1))
        .expect(status.get(1) == "applied" and uniqueSafe)
  // 移動の途中に、別の行が持つ値の INSERT を、キーの持ち主 (子) が、親から届いたキーの行で断る
  run conflictDuringMoveTest =
    init.then(given(Map(1 -> 0, 2 -> 1), Map(1 -> 2, 2 -> 2)))   // r2 = 1。キー 1 は piece 2
        .then(fence)
        .then(cutPiece(1)).then(receive(1))
        .then(plan(1, Map(1 -> 1)))
        .then(prepareAt(C, 1))
        .then(cutPiece(2)).then(receive(2))
        .then(prepareAt(C, 1))                        // キー 1 の holder は r2。断る
        .expect(status.get(1) == "aborted" and marks.contains(5) and uniqueSafe)
}

// テナントを割る移動 (段 4)。piece 1 は親に残り、親は piece 1 の位置の書き込みを受け続ける。行とキーの行が別のシャードにあれば 2PC になる
module m22_green_split {
  import m22_core(NVAL = 2, MOVE_ALL = false, NTXN = 2,
                  KEY_OWNER = true, PULL_KEY = true, KEY_LOCK = true, KEY_BODY = true, KEY_IN_TXN = true, RELEASE_OLD = true,
                  KEY_INTENT_MOVES = true, PHYS_UNIQUE = false, PARENT_UNTIL_CUT = false, CHILD_GROUP = 0, TRACK = true).*
  // M20 の m20_red_late_intent の形。親は、移った値を知らなくても、キーの持ち主 (子) が断る
  run lateIntentTest =
    init.then(given(Map(1 -> 0, 2 -> 1), Map(1 -> 2, 2 -> 2)))   // r2 = 1 (piece 2)。キー 1 も piece 2
        .then(fence)
        .then(cutPiece(2)).then(receive(2)).then(ack(2))   // r2 とキー 1 は子にあり、親の控えはもうない
        .then(plan(1, Map(1 -> 1)))                   // 親に残る行 1 を 1 にする
        .then(prepareAt(P, 1))                        // 行 1 の部分は親が置く
        .then(prepareAt(C, 1))                        // キー 1 の部分は子が確かめ、holder の r2 を見て断る
        .expect(status.get(1) == "aborted" and marks.contains(3) and uniqueSafe)
  run twoShardTest =
    init.then(given(Map(1 -> 0, 2 -> 0), Map(1 -> 2, 2 -> 2)))
        .then(fence)
        .then(cutPiece(2)).then(receive(2))
        .then(plan(1, Map(1 -> 1)))
        .then(prepareAt(P, 1)).then(prepareAt(C, 1))
        .then(decide(1, true))
        .then(applyAt(P, 1)).then(applyAt(C, 1))
        .expect(status.get(1) == "applied" and marks.contains(8) and uniqueSafe)
}
