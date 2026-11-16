// M24: 表ごとの epoch。DDL が取引を古くするのは、取引が頼るもの (読んだ表、書いた表、計画に使った表、view の元の表、
// 表の index) を変えたときだけにする (未解決の問題 53)
//
// 実装より先に書いたモデルで、対応する実装はまだない (docs/design-catalog-epoch.md の「表ごとの epoch (2026-11-16)」)。
// 段 3 の実装では、取引は表定義全体の epoch (schema) を 1 つ名乗り、どの表定義の記録 (prepare、commit、abort) でもそれが進む。
// そのため、関係のない表の CREATE TABLE も、失敗した DDL も、開いている取引を全部、2 度古くする。SQLite (WAL) では、ほかの接続の
// DDL は、別の表の取引を失敗させない。
//
// 設計:
//   1. 表定義のもの (表と view。名前で引く) が、それぞれ epoch を持つ。表は 2 つ持つ。読みの epoch は、その表の読みが返すもの
//      (列、行の形、表があるか) か、シャードが古い時刻の行を読み戻せるかを変える DDL で進む。書き込みの epoch は、それに加えて、
//      書き込みが保守するもの (index、UNIQUE) を変える DDL で進む。index の DDL は、その表の書き込みの epoch を進める。
//   2. epoch は commit だけで進む (決めたこと 6 を改める)。prepare と abort は表定義の中身を変えない。
//   3. 要求は、計画が頼るものと、その epoch を運ぶ。書く表は書き込みの epoch、読む表 (view を通るなら view と元の表) は読みの
//      epoch である。シャードは、そのものだけを、自分のスナップショットと比べる。要求のほうが新しければ列を適用してから比べ直し、
//      古ければ断る。
//   4. シャードが表定義の記録を適用する間 (intent の決着を待つ間)、待たせるのは、その記録が変えるもの (fence の表を含む) に頼る
//      要求だけで、断らない。決着させる intent も、その記録が変える表のものだけである。
// 取引は、最初に読むか書くかしたときのスナップショット (pe) を、確定まで使う (M13、M21 のまま)。
//
// M21 (specs/m21_catalog_epoch.qnt) の本体を写して、次を変えた。
//   - 表定義のものを 4 つにした。A (行 1 は P、行 2 は Q。M21 の表)、A の上の view V、別の表 B (行が 1 つ Q にあり、値 bv は
//     変わらない)、まだない表 N。index は、A の上の、シャードをまたぐ UNIQUE (BUILD) である。
//   - DDL を 2 つ足した。NEWT (CREATE TABLE N。fence はない) と ALTB (B の、行で失敗し得る DDL。bv が 2 なら Q の試しが通らず
//     abort、そうでなければ commit。B の列を足す)。
//   - 書き込みの計画が B を読むことがある (via 1。INSERT INTO A ... SELECT ... FROM B)。読みが V を通ることがある (via 2)。
//     取引は、書き込みと確定の間に、A か V を読む文を 1 つ実行できる。
//   - 書き込み禁止の表への書き込みは、断らずに待つ (いまの実装の TableLocked の待ち。M21 は断る)。
//   - M21 の設計の条件は、設計どおりに固定した (外した形は M21 が確かめている)。取引が新しい epoch を名乗り直す手 (repin)、
//     版だけを先に確かめる段 (enter)、いまの実装の fence (fenceFirst) はない。進める側が止まる手 (die) は分割にだけ残した。
// 時刻はない。シャードの DDL の床 (古い時刻の行の読み戻し) は m24_floor で、行ロックと DDL の待ちは m24_lock で、取引の中の DDL
// の順序は m24_boundary (M13 を表ごとにしたもの) で確かめる。決めたこと 6 (commit だけで進める) を M21 の全部の場面と赤で
// 確かめ直すインスタンス (m24_m21_*) は、M21 を読み込むので、別のファイル m24b_m21_commit_only.qnt に置いた。
//
// invariant は、M21 のもの (noServeBelowAck と pinned を除く。下) と、新しい 3 つである。
//   planMatches             シャードが要求を受け付けるとき、要求が頼るどのものの表定義も、計画のときと同じである
//                           (M21 の noServeBelowAck と pinned を、ものごとに言い直したもの)
//   noRefusalUnrelated      頼るものに触る表定義の記録が計画の後にないのに、持ち主が版の理由で断ることはない
//                           (「表 A の取引は、表 B の DDL で断られない」。M21 の pinnedSurvives を、ものごとにしたもの)
//   noRefusalWithoutChange  頼るものの表定義が計画の後に変わっていない (確定した DDL がない) のに、持ち主が版の理由で断ることはない
//                           (失敗した DDL は、触った表の取引も断らない)
// noServeBelowAck (ok と答えた prepare より古い計画を受けない) は、commit だけで進める形では定義から成り立たないので除いた
// (M21 の m21_alt_commit_only_* と同じ)。pinned は、名乗り直す手がないので、いつも成り立つ。
module m24_core {
  // ---- 場面 ----
  const HAS_BUILD: bool        // A に、シャードをまたぐ UNIQUE の index を作る (書き込みだけが頼る変更)
  const HAS_CHECK: bool        // A の、行で失敗し得て、行の形を変える DDL (CHECK のある ADD COLUMN)
  const HAS_DROP: bool         // DROP TABLE A (取引 copy が読んだ後の変更を確かめる。M21 の DROP)
  const HAS_SPLIT: bool        // A の行 1 の区間を P から C へ移す
  const HAS_NEWT: bool         // 関係のない新しい表 N を作る (CREATE TABLE N)
  const HAS_ALTB: bool         // 別の表 B の、行で失敗し得る DDL
  const VIA_V: bool            // 読みが view V を通ることがある
  const VIA_B: bool            // A への書き込みの計画が、B を読むことがある
  const TXN_READ: bool         // 取引が、書き込みと確定の間に、A か V を読む文を 1 つ実行する
  const AUTO_READ: bool        // 取引の外の読み (autocommit) がある
  const NTXN: int
  const FIXED_INIT: bool       // A の最初の値を 1、1 に固定する (状態を減らす)
  // ---- 新しい条件。赤は 1 つずつ外す ----
  const PER_TABLE: bool        // シャードは、要求が頼るものの epoch だけを比べる (false: 表定義全体の epoch 1 つ。M21 と段 3 の実装)
  const EXPAND_VIEW: bool      // view を通る計画は、view と、その元の表の両方に頼る (false: view だけ)
  const INDEX_ON_TABLE: bool   // index の DDL は、その表の書き込みの epoch を進める (false: index を、表とは別のものとして数える)
  const WRITE_EPOCH: bool      // 書き込みは、表の書き込みの epoch を比べる (false: 読みの epoch を比べる。index の変更が見えない)
  const READ_DEPS: bool        // 書き込みの計画は、書く表のほかに、計画が読んだ表にも頼る (false: 書く表だけ)
  const APPLY_REFUSES: int     // 表定義の記録を適用している間に断る要求。0 断らない (待たせる)。1 その記録が変えるものに頼る要求。
                               // 2 すべて (段 3 の実装の schemaChanging)
  // ---- 設計の選択肢 ----
  const SCHEMA_ON_PREPARE: bool  // epoch は prepare と abort でも進む (段 3 の決めたこと 6)。false なら commit だけで進む

  pure val P = 1
  pure val Q = 2
  pure val C = 3
  pure val SHARDS = Set(1, 2, 3)
  pure val ROWS = Set(1, 2)
  pure val VALS = Set(1, 2)
  pure val ALLV = Set(0, 1, 2)
  pure val TXNS = 1.to(NTXN)

  pure val BUILD = 1
  pure val CHECK = 2
  pure val DROP = 3
  pure val SPLIT = 4
  pure val NEWT = 5
  pure val ALTB = 6
  pure val DDLS = Set(1, 2, 3, 5, 6)
  pure val OPS = Set(1, 2, 3, 4, 5, 6)
  pure val MAXE = 9                       // epoch の上限 (どのインスタンスでも届かない)

  // 表定義のもの
  pure val OA = 1                         // 表 A
  pure val OV = 2                         // view V (A の上)
  pure val OB = 3                         // 表 B
  pure val ON = 4                         // 表 N (NEWT が作る)
  pure val OI = 5                         // A の index を、表とは別のものとして数えたとき (赤 INDEX_ON_TABLE = false) の名前
  // 頼り方
  pure val RD = 1                         // 読みとして頼る (読みの epoch を比べる)
  pure val WR = 2                         // 書き込みとして頼る (書き込みの epoch を比べる)

  pure val NO_INDEX = 0
  pure val BUILDING = 1
  pure val PUBLIC = 2

  // phase: 0 未使用、1 文を実行した、2 受け付けられた (intent がある)、3 終わった
  // pe は計画に使ったスナップショットの epoch (取引は確定まで同じものを使う)。via は書き込みの計画の形 (0 A だけ、1 B を読んで A を書く)。
  // read は、書き込みと確定の間の読みの文を、もう実行したか。
  type Txn = { phase: int, row: int, old: int, new: int, pe: int, via: int, dest: int, maintain: bool, seen: int, read: bool, ok: bool }
  pure val idle: Txn = { phase: 0, row: 0, old: 0, new: 0, pe: 0, via: 0, dest: 0, maintain: false, seen: 0, read: false, ok: false }
  pure val done: Txn = { phase: 3, row: 0, old: 0, new: 0, pe: 0, via: 0, dest: 0, maintain: false, seen: 0, read: false, ok: false }

  type Ghost = {
    wroteFenced: bool,          // A が書き込み禁止の epoch にいるシャードで、A への書き込みが確定した
    relied: bool,               // 出来上がっていない index を、文が使った (BUILD_VISIBLE は固定で false なので起きない)
    stuck: bool,                // シャードが、記録された commit を適用できなかった
    wroteAfterDrop: bool,       // DROP の commit が記録された後で、A への書き込みが確定した
    resurrected: bool,          // DROP を適用したシャードに、書き込みが適用された
    refusedLatest: bool,        // 最新の epoch で計画した要求を、持ち主が版か所有の理由で断った
    refusedUnmoved: bool,       // 表定義全体の epoch が同じで、自分が持ち主である要求を断った (M21 の pinnedSurvives)
    acceptedOlder: bool,        // 自分より古い epoch の書き込みを受けた (witness 用)
    badRead: bool,              // 答えた読みが、確定した最新の値と違う
    shapeMismatch: bool,        // 行を運んだときに、親と子の表定義が違った
    uncutRead: bool,            // 親が、start を適用した後で、まだ渡していない行の読みに答えた (witness 用)
    planMismatch: bool,         // 要求が頼るものの表定義が、計画のときと違うシャードで、要求が受け付けられた
    refusedUnrelated: bool,     // 頼るものに触る表定義の記録が計画の後にないのに、持ち主が版の理由で断った
    refusedNoChange: bool,      // 頼るものの表定義が計画の後に変わっていないのに、持ち主が版の理由で断った
    refusedChanged: bool,       // 頼るものの表定義が変わったので、持ち主が断った (witness 用)
    acrossUnrelated: bool,      // A だけに頼る書き込みが、計画の後の NEWT の commit と ALTB の abort を適用したシャードで受け付けられた
    acrossFailedRead: bool,     // B を読んだ計画の書き込みが、計画の後の ALTB の abort を適用したシャードで受け付けられた
    acrossFailedTouched: bool,  // A の CHECK の prepare より前に計画した書き込みが、その abort を適用したシャードで受け付けられた
    readAcrossIndex: bool,      // index の commit より前に計画した読みが、その commit を適用したシャードで答えられた
  }
  pure val clean: Ghost = {
    wroteFenced: false, relied: false, stuck: false, wroteAfterDrop: false, resurrected: false,
    refusedLatest: false, refusedUnmoved: false, acceptedOlder: false, badRead: false, shapeMismatch: false, uncutRead: false,
    planMismatch: false, refusedUnrelated: false, refusedNoChange: false, refusedChanged: false,
    acrossUnrelated: false, acrossFailedRead: false, acrossFailedTouched: false, readAcrossIndex: false,
  }

  // ---- Meta ----
  var len: int                  // 最新の epoch
  var prepE: int -> int         // op -> prepare (SPLIT は start) の epoch。0 はまだ
  var commitE: int -> int       // op -> commit (SPLIT は end) の epoch
  var abortE: int -> int        // op -> abort の epoch
  // ---- 遷移を進める側 ----
  var acks: int -> Set[int]     // op -> ok と答えたシャード
  var dead: int -> bool         // op -> 進める側が止まった (分割だけ)
  // ---- シャード ----
  var ep: int -> int            // シャード -> 適用した epoch
  var store: int -> int         // シャード -> 持っている A の行の値 (P と C は行 1、Q は行 2)
  var truth: int -> int         // 行 -> 確定した最新の値
  var idx: int -> int           // 値 -> その値を持つ行 (0 = 項目なし)
  var txns: int -> Txn
  var bv: int                   // B の行 (Q にある) の値。変わらない。2 なら ALTB の試しが通らない
  // ---- DROP の場面 ----
  var copied: bool              // copy の区切りが、表を読んで確定した
  var late: int -> bool         // シャード -> copy の後で、書き込みが確定した
  // ---- 移動 ----
  var pulled: bool              // 行 1 が子に届いた
  var drained: bool             // 子が受け取り終えた
  var g: Ghost

  pure def max(a: int, b: int): int = if (a > b) a else b
  pure def cap(x: int, e: int): int = if (x <= e) x else 0
  pure def within(x: int, e: int): bool = x >= 1 and x <= e
  pure def has4(op: int): bool =
    if (op == BUILD) HAS_BUILD else if (op == CHECK) HAS_CHECK else if (op == DROP) HAS_DROP else if (op == SPLIT) HAS_SPLIT
    else if (op == NEWT) HAS_NEWT else HAS_ALTB
  /** 場面にある DDL。畳み込みは、これだけを回る (TLC の手間を減らすため。場面にない DDL は記録を残さない)。 */
  pure val ACTIVE: Set[int] = DDLS.filter(op => has4(op))
  pure val VIAS_W: Set[int] = if (VIA_B) Set(0, 1) else Set(0)
  pure val VIAS_R: Set[int] = if (VIA_V) Set(0, 2) else Set(0)
  /** A の DDL か。 */
  pure def onA(op: int): bool = op == BUILD or op == CHECK or op == DROP
  pure val noEntries: int -> int = VALS.mapBy(_ => 0)

  // ---- 表定義のものと epoch ----
  /** op が変えるもの。k は、読みとして頼るとき (RD) か、書き込みとして頼るとき (WR) か。index の作成は、読みが返すものを変えない。 */
  pure def changes(op: int, k: int): Set[int] =
    if (op == CHECK or op == DROP) Set(OA)
    else if (op == BUILD) (if (k == WR) Set(OA) else Set())
    else if (op == NEWT) Set(ON)
    else if (op == ALTB) Set(OB)
    else Set()
  /** op の prepare が書き込み禁止にする表。 */
  pure def fences(op: int): Set[int] = if (onA(op)) Set(OA) else if (op == ALTB) Set(OB) else Set()
  /** op は、もの o の DDL か (o を変えるか、o を書き込み禁止にする)。 */
  pure def isOn(op: int, o: int): bool = changes(op, WR).contains(o) or fences(op).contains(o)
  /** シャードと Worker が数えるもの。条件を外すと、設計の changes とずれる。 */
  def counted(op: int, k: int): Set[int] =
    if (k == WR and not(WRITE_EPOCH)) changes(op, RD)
    else if (op == BUILD and k == WR and not(INDEX_ON_TABLE)) Set(OI)
    else changes(op, k)

  def openAt(op: int, e: int): bool =
    within(prepE.get(op), e) and not(within(commitE.get(op), e)) and not(within(abortE.get(op), e))
  /** op が e までに残した記録のうち、epoch を進めるもの。決めた設計では commit だけ。 */
  def mark(op: int, e: int): int =
    max(cap(commitE.get(op), e), if (SCHEMA_ON_PREPARE) max(cap(prepE.get(op), e), cap(abortE.get(op), e)) else 0)
  /** 表定義全体の epoch (M21 と段 3 の実装。PER_TABLE = false のとき、シャードはこれを比べる)。 */
  def schemaAt(e: int): int = ACTIVE.fold(0, (m, op) => max(m, mark(op, e)))
  /** 要求が運び、シャードが比べる epoch。d は (もの、頼り方)。 */
  def verAt(e: int, d: (int, int)): int =
    if (not(PER_TABLE)) schemaAt(e)
    else ACTIVE.fold(0, (m, op) => if (counted(op, d._2).contains(d._1)) max(m, mark(op, e)) else m)
  /** もの d の表定義が最後に変わった epoch (確定した DDL)。ghost の基準で、条件に依らない。 */
  def contentAt(e: int, d: (int, int)): int =
    ACTIVE.fold(0, (m, op) => if (changes(op, d._2).contains(d._1)) max(m, cap(commitE.get(op), e)) else m)
  /** もの o の DDL の記録 (prepare、commit、abort のどれでも) のうち、e までの最後のもの。ghost の基準。 */
  def touchAt(e: int, o: int): int =
    ACTIVE.fold(0, (m, op) => if (isOn(op, o)) max(m, max(cap(commitE.get(op), e), max(cap(prepE.get(op), e), cap(abortE.get(op), e)))) else m)

  def isSchemaEpoch(e: int): bool = ACTIVE.exists(op => prepE.get(op) == e or commitE.get(op) == e or abortE.get(op) == e)
  /** epoch e の表定義の記録を書いた op (なければ 0)。 */
  def opAt(e: int): int = ACTIVE.fold(0, (m, op) => if (prepE.get(op) == e or commitE.get(op) == e or abortE.get(op) == e) op else m)
  /** 表 o が書き込み禁止か。o を fence に持つ、開いている表定義の遷移がある。 */
  def fencedAt(e: int, o: int): bool = ACTIVE.exists(op => fences(op).contains(o) and openAt(op, e))
  def indexAt(e: int): int =
    if (within(commitE.get(BUILD), e)) PUBLIC else if (openAt(BUILD, e)) BUILDING else NO_INDEX
  def checkOnAt(e: int): bool = within(commitE.get(CHECK), e)
  def droppedAt(e: int): bool = within(commitE.get(DROP), e)
  def movedAt(e: int): bool = within(prepE.get(SPLIT), e)
  def ownerAt(e: int, r: int): int = if (r == 2) Q else if (movedAt(e)) C else P
  def shardsAt(e: int): Set[int] = if (movedAt(e)) Set(P, Q, C) else Set(P, Q)
  def moveOpen: bool = prepE.get(SPLIT) > 0 and commitE.get(SPLIT) == 0
  def ddlOpen: bool = ACTIVE.exists(op => openAt(op, len))

  // ---- 計画が頼るもの ----
  /** 書き込み (A の行。via 1 なら、計画が B を読む) が運ぶもの。 */
  def writeDeps(via: int): Set[(int, int)] = if (via == 1 and READ_DEPS) Set((OA, WR), (OB, RD)) else Set((OA, WR))
  /** 書き込みが本当に頼るもの (ghost の基準)。 */
  pure def trueWriteDeps(via: int): Set[(int, int)] = if (via == 1) Set((OA, WR), (OB, RD)) else Set((OA, WR))
  /** 読み (A の行。via 2 なら V を通る) が運ぶもの。 */
  def readDeps(via: int): Set[(int, int)] =
    if (via == 2) (if (EXPAND_VIEW) Set((OV, RD), (OA, RD)) else Set((OV, RD))) else Set((OA, RD))
  pure def trueReadDeps(via: int): Set[(int, int)] = if (via == 2) Set((OV, RD), (OA, RD)) else Set((OA, RD))

  // ---- シャードから見えるもの ----
  def sv(s: int): int = schemaAt(ep.get(s))
  def noIntents(s: int): bool = TXNS.forall(t => not(txns.get(t).phase == 2 and txns.get(t).dest == s))
  /** シャードが持っている行の値。親は、渡した行の控えを数えない。 */
  def heldVal(s: int): int = if (s == P and pulled) 0 else store.get(s)
  pure def rowHeld(s: int): int = if (s == Q) 2 else 1
  /** 行の持ち主が持つ値。 */
  def lv(r: int): int = if (r == 2) store.get(Q) else if (pulled) store.get(C) else store.get(P)
  /** 移動の途中のシャード。運ぶ行と intent の形が変わらないように、表定義の記録を適用しない (M15)。 */
  def movingNow(s: int): bool = (s == P or s == C) and not(drained) and movedAt(ep.get(s))
  /** 次の記録を適用できない。待っても適用できないので、要求を断ることになる。 */
  def blockedApply(s: int): bool = ep.get(s) < len and isSchemaEpoch(ep.get(s) + 1) and movingNow(s)
  /** 表定義の記録を適用する前に、シャードの intent を決着させるか。intent は A にしかないので、A の DDL だけである。 */
  pure def drainsA(op: int): bool = onA(op)

  /** 自分のスナップショットで、行 r の書き込みの宛先が自分か。 */
  def ownsDesign(s: int, r: int): bool =
    if (r == 2) s == Q
    else (s == P and not(movedAt(ep.get(P)))) or (s == C and movedAt(ep.get(C)))
  /** 読みは、親がまだ渡していない行にも答える (M19)。 */
  def holdsDesign(s: int, r: int): bool = ownsDesign(s, r) or (s == P and r == 1 and not(pulled))
  def mine(s: int, r: int, forRead: bool): bool = if (forRead) holdsDesign(s, r) else ownsDesign(s, r)

  /**
   * シャード s が、行 r の要求 (計画の epoch pe、運ぶもの deps) を受けるか。
   * 0 受ける、1 先に列を適用する (待つ)、2 断る (古い計画か、持ち主でない)、3 適用できないので断る。
   * 決めた設計では、deps のものごとに比べる。どれかが自分より新しければ待ち、どれかが古ければ断る。範囲表の epoch は、M21 と同じく、
   * 行が自分のものでないときだけ追いかける。
   */
  def gate(s: int, r: int, pe: int, deps: Set[(int, int)], forRead: bool): int = {
    val behind = deps.exists(d => verAt(pe, d) > verAt(ep.get(s), d)) or (pe > ep.get(s) and not(mine(s, r, forRead)))
    if (behind) (if (blockedApply(s)) 3 else 1)
    else if (deps.exists(d => verAt(pe, d) < verAt(ep.get(s), d)) or not(mine(s, r, forRead))) 2
    else 0
  }

  /** 断ったときの ghost。e は、シャードが比べたスナップショットの epoch。tdeps は、要求が本当に頼るもの。 */
  def refusedGhost(gg: Ghost, s: int, r: int, pe: int, tdeps: Set[(int, int)], forRead: bool, code: int, e: int): Ghost = {
    val byVersion = code == 2 and (if (forRead) holdsDesign(s, r) else ownsDesign(s, r))
    {
      ...gg,
      refusedLatest: gg.refusedLatest or (code >= 2 and pe == len),
      refusedUnmoved: gg.refusedUnmoved or (byVersion and schemaAt(pe) == schemaAt(e)),
      refusedUnrelated: gg.refusedUnrelated or (byVersion and tdeps.forall(d => touchAt(pe, d._1) == touchAt(e, d._1))),
      refusedNoChange: gg.refusedNoChange or (byVersion and tdeps.forall(d => contentAt(pe, d) == contentAt(e, d))),
      refusedChanged: gg.refusedChanged or (byVersion and tdeps.exists(d => contentAt(pe, d) != contentAt(e, d))),
    }
  }
  /** 読みに答えたときの ghost。 */
  def servedGhost(gg: Ghost, s: int, r: int, pe: int, tdeps: Set[(int, int)]): Ghost = {
    ...gg,
    badRead: gg.badRead or store.get(s) != truth.get(r),
    uncutRead: gg.uncutRead or (s == P and r == 1 and movedAt(ep.get(P))),
    planMismatch: gg.planMismatch or tdeps.exists(d => contentAt(pe, d) != contentAt(ep.get(s), d)),
    readAcrossIndex: gg.readAcrossIndex or (commitE.get(BUILD) > pe and ep.get(s) >= commitE.get(BUILD)),
  }

  action initWith(a: int, b: int, w: int): bool = all {
    len' = 0, prepE' = OPS.mapBy(_ => 0), commitE' = OPS.mapBy(_ => 0), abortE' = OPS.mapBy(_ => 0),
    acks' = OPS.mapBy(_ => Set()), dead' = OPS.mapBy(_ => false),
    ep' = SHARDS.mapBy(_ => 0), store' = Map(1 -> a, 2 -> b, 3 -> 0), truth' = Map(1 -> a, 2 -> b), idx' = noEntries,
    txns' = TXNS.mapBy(_ => idle), bv' = w,
    copied' = false, late' = SHARDS.mapBy(_ => false),
    pulled' = false, drained' = false, g' = clean,
  }
  action init = {
    nondet a = oneOf(ALLV)
    nondet b = oneOf(ALLV)
    nondet w = oneOf(Set(1, 2))
    all { not(FIXED_INIT) or (a == 1 and b == 1), HAS_ALTB or w == 1, initWith(a, b, w) }
  }

  action keepLog = all { len' = len, prepE' = prepE, commitE' = commitE, abortE' = abortE }
  action keepCoord = all { acks' = acks, dead' = dead }
  action keepData = all { store' = store, truth' = truth, idx' = idx, bv' = bv }
  action keepSide = all { copied' = copied, late' = late, pulled' = pulled, drained' = drained }
  action recordAbort(op: int): bool = all { len' = len + 1, abortE' = abortE.set(op, len + 1), prepE' = prepE, commitE' = commitE }

  // ---- 取引 -------------------------------------------------------------------

  // 文を実行する。Worker は、手元のスナップショット (古くてもよい) で宛先と index の使い方を決める。via 1 なら、計画が B を読む。
  action plan(t: int, r: int, nv: int, pe: int, via: int): bool = all {
    txns.get(t).phase == 0,
    pe <= len,
    not(droppedAt(pe)),
    via == 0 or (via == 1 and VIA_B),
    val dest = ownerAt(pe, r)
    val cur = store.get(dest)
    val uses = indexAt(pe) == PUBLIC
    val holder = if (uses and nv != 0) idx.get(nv) else 0
    all {
      dest != C or pulled,                   // 子は、行が届いてから文を実行する
      nv != cur,
      txns' = txns.set(t,
        // 同じ値の項目が別の行を指していれば、UNIQUE 違反で文が失敗する
        if (holder != 0 and holder != r) done
        else { phase: 1, row: r, old: cur, new: nv, pe: pe, via: via, dest: dest, maintain: uses, seen: holder, read: false, ok: false }),
      g' = g, keepLog, keepCoord, ep' = ep, keepData, keepSide,
    }
  }

  // 取引の中の読みの文。取引のスナップショット pe で計画し、行の持ち主のシャードが答える。断られれば、取引は終わる。
  action txnRead(t: int, via: int): bool = all {
    TXN_READ,
    txns.get(t).phase == 1, not(txns.get(t).read),
    via == 0 or (via == 2 and VIA_V),
    val x = txns.get(t)
    val s = ownerAt(x.pe, x.row)
    val code = gate(s, x.row, x.pe, readDeps(via), true)
    all {
      code != 1,
      code != 0 or s != C or pulled,
      txns' = txns.set(t, if (code == 0) { ...x, read: true } else done),
      g' = if (code == 0) servedGhost(g, s, x.row, x.pe, trueReadDeps(via))
           else refusedGhost(g, s, x.row, x.pe, trueReadDeps(via), true, code, ep.get(s)),
      keepLog, keepCoord, ep' = ep, keepData, keepSide,
    }
  }

  // シャードが書き込みを受け付ける (取引の確定の要求)。版と所有、読んだ後に変わっていないことを確かめて、intent を置く。
  // 書き込み禁止の表への書き込みは、禁止が解けるまで待つ。確かめに通らなければ、取引は終わる (何も書かない)。
  action prepare(t: int): bool = all {
    txns.get(t).phase == 1,
    val x = txns.get(t)
    val s = x.dest
    val code = gate(s, x.row, x.pe, writeDeps(x.via), false)
    val locked = fencedAt(ep.get(s), OA)
    val gone = droppedAt(ep.get(s))
    val bad = checkOnAt(ep.get(s)) and x.new == 2
    val changed = store.get(s) != x.old or (x.maintain and x.new != 0 and idx.get(x.new) != x.seen)
    // 行の intent と、index の項目の intent。項目も行なので、同じ値の項目を触る 2 つの取引は、片方しか受け付けられない。
    val busy = TXNS.exists(u => u != t and txns.get(u).phase == 2 and
      (txns.get(u).row == x.row or
       (x.maintain and txns.get(u).maintain and
        Set(x.old, x.new).exclude(Set(0)).intersect(Set(txns.get(u).old, txns.get(u).new)) != Set())))
    val accepted = code == 0 and not(gone or bad or changed or busy)
    val tdeps = trueWriteDeps(x.via)
    val e = ep.get(s)
    all {
      code != 1,
      code != 0 or s != C or pulled,         // 子は、行が届くのを待つ (pull)
      code != 0 or not(locked),              // 書き込み禁止の表への書き込みは、禁止が解けるまで待つ
      txns' = txns.set(t, if (accepted) { ...x, phase: 2 } else done),
      g' = if (code != 0) refusedGhost(g, s, x.row, x.pe, tdeps, false, code, e)
           else {
             ...g,
             acceptedOlder: g.acceptedOlder or (accepted and x.pe < e),
             planMismatch: g.planMismatch or (accepted and tdeps.exists(d => contentAt(x.pe, d) != contentAt(e, d))),
             acrossUnrelated: g.acrossUnrelated or (accepted and x.via == 0 and x.pe < prepE.get(NEWT) and x.pe < prepE.get(ALTB)
                                                    and commitE.get(NEWT) > 0 and e >= commitE.get(NEWT) and abortE.get(ALTB) > 0 and e >= abortE.get(ALTB)),
             acrossFailedRead: g.acrossFailedRead or (accepted and x.via == 1 and x.pe < prepE.get(ALTB) and abortE.get(ALTB) > 0 and e >= abortE.get(ALTB)),
             acrossFailedTouched: g.acrossFailedTouched or (accepted and x.pe < prepE.get(CHECK) and abortE.get(CHECK) > 0 and e >= abortE.get(CHECK)),
           },
      keepLog, keepCoord, ep' = ep, keepData, keepSide,
    }
  }

  // 確定。行を書き換える。index を使う計画なら、古い値の項目を消し (誰の項目かは確かめない)、新しい値の項目を足す。
  action commit(t: int): bool = all {
    txns.get(t).phase == 2,
    val x = txns.get(t)
    val s = x.dest
    val removed = if (x.maintain and x.old != 0) idx.set(x.old, 0) else idx
    all {
      store' = store.set(s, x.new),
      truth' = truth.set(x.row, x.new),
      idx' = if (x.maintain and x.new != 0) removed.set(x.new, x.row) else removed,
      bv' = bv,
      txns' = txns.set(t, { ...done, pe: x.pe, via: x.via, dest: s, ok: true }),
      late' = if (copied) late.set(s, true) else late,
      g' = {
        ...g,
        wroteFenced: g.wroteFenced or fencedAt(ep.get(s), OA),
        wroteAfterDrop: g.wroteAfterDrop or commitE.get(DROP) > 0,
        resurrected: g.resurrected or droppedAt(ep.get(s)),
      },
      keepLog, keepCoord, ep' = ep, copied' = copied, pulled' = pulled, drained' = drained,
    }
  }

  // 段 3 の実装 (APPLY_REFUSES = 2) と、その記録が変えるものに頼る要求だけを断る形 (1)。シャードが表定義の記録を適用している間
  // (intent の決着を待つ間) に、取引の確定の要求を断る。決めた設計 (0) では、この手はない。その記録が変えるものに頼る要求は、
  // 適用が終わるまで待ち (適用は 1 手なので、モデルでは前か後になる)、ほかの要求は通る。
  // 断る理由は、適用している記録 (epoch e) と比べて決まるので、ghost も e で比べる。
  action refuseApplying(t: int): bool = all {
    APPLY_REFUSES > 0,
    txns.get(t).phase == 1,
    val x = txns.get(t)
    val s = x.dest
    val e = ep.get(s) + 1
    val op = opAt(e)
    val tdeps = trueWriteDeps(x.via)
    all {
      ep.get(s) < len, isSchemaEpoch(e), not(movingNow(s)),
      APPLY_REFUSES == 2 or tdeps.exists(d => isOn(op, d._1)),
      txns' = txns.set(t, done),
      g' = refusedGhost(g, s, x.row, x.pe, tdeps, false, 2, e),
      keepLog, keepCoord, ep' = ep, keepData, keepSide,
    }
  }

  // 読み (autocommit)。状態は変えない。断られたか、答えが正しいかだけを記録する。
  action read(pe: int, r: int, via: int): bool = all {
    AUTO_READ,
    pe <= len,
    not(droppedAt(pe)),
    via == 0 or (via == 2 and VIA_V),
    val s = ownerAt(pe, r)
    val code = gate(s, r, pe, readDeps(via), true)
    all {
      code != 1,
      code != 0 or s != C or pulled,
      g' = if (code == 0) servedGhost(g, s, r, pe, trueReadDeps(via)) else refusedGhost(g, s, r, pe, trueReadDeps(via), true, code, ep.get(s)),
      keepLog, keepCoord, ep' = ep, keepData, txns' = txns, keepSide,
    }
  }

  // ---- Meta: 表定義の遷移 -----------------------------------------------------

  // 遷移を開く。表定義の遷移は 1 つずつで、移動とも並べない (M21)。A の DDL は、A が消えた後は構文の確かめが断る。
  action prepareOp(op: int): bool = all {
    DDLS.contains(op), has4(op),
    prepE.get(op) == 0,
    not(onA(op)) or not(droppedAt(len)),
    not(ddlOpen), not(moveOpen),
    len' = len + 1, prepE' = prepE.set(op, len + 1), commitE' = commitE, abortE' = abortE,
    keepCoord, ep' = ep, keepData, txns' = txns, keepSide, g' = g,
  }

  // 遷移を確定する。全シャードが ok と答えた後で、遷移が開いているときだけ。
  action commitOp(op: int): bool = all {
    DDLS.contains(op), has4(op),
    prepE.get(op) > 0, commitE.get(op) == 0,
    openAt(op, len),
    acks.get(op) == shardsAt(prepE.get(op)),
    len' = len + 1, commitE' = commitE.set(op, len + 1), prepE' = prepE, abortE' = abortE,
    keepCoord, ep' = ep, keepData, txns' = txns, keepSide, g' = g,
  }

  // 期限切れ (進める側が止まった) か、進める側が自分で取り消す。埋めた項目は捨てる。
  action expire(op: int): bool = all {
    DDLS.contains(op), has4(op),
    openAt(op, len),
    recordAbort(op),
    idx' = if (op == BUILD) noEntries else idx,
    keepCoord, ep' = ep, store' = store, truth' = truth, bv' = bv, txns' = txns, keepSide, g' = g,
  }

  // 分割を進める側が止まる。start の後、行が子に届く前に止まる。
  action dieSplit: bool = all {
    HAS_SPLIT, not(dead.get(SPLIT)),
    prepE.get(SPLIT) > 0, commitE.get(SPLIT) == 0, not(pulled),
    dead' = dead.set(SPLIT, true),
    acks' = acks, keepLog, ep' = ep, keepData, txns' = txns, keepSide, g' = g,
  }

  // ---- シャード: 列の適用と、prepare の確かめ ----------------------------------

  // シャードが次の記録を適用する。表定義の記録は、それが変える表の intent を決着させてから適用する。
  action applyNext(s: int): bool = all {
    s != C or prepE.get(SPLIT) > 0,          // 子は、分割の記録ができてから現れる
    ep.get(s) < len,
    val e = ep.get(s) + 1
    val schema = isSchemaEpoch(e)
    all {
      not(schema) or not(movingNow(s)),
      not(schema) or not(drainsA(opAt(e))) or noIntents(s),
      ep' = ep.set(s, e),
      store' = if (e == commitE.get(DROP)) store.set(s, 0) else store,
      g' = {
        ...g,
        // 制約に反する行があるシャードは、制約を足す文を実行できない。消えた表には index を公開できない。
        stuck: g.stuck or (e == commitE.get(CHECK) and heldVal(s) == 2) or (e == commitE.get(BUILD) and droppedAt(ep.get(s)))
               or (e == commitE.get(ALTB) and s == Q and bv == 2),
      },
      keepLog, keepCoord, truth' = truth, idx' = idx, bv' = bv, txns' = txns, keepSide,
    }
  }

  /** シャード s が、op の prepare の確かめに答えられるか。prepare を適用した後でだけ答える (M21 の CHECK_AT_EPOCH)。 */
  def canAck(op: int, s: int): bool = and {
    has4(op), openAt(op, len),
    shardsAt(prepE.get(op)).contains(s), not(acks.get(op).contains(s)),
    openAt(op, ep.get(s)),
  }

  // BUILD: シャードの行を読んで、index の項目を埋める。同じ値の項目が別の行を指していれば、重複なので取り消す。
  action ackBuild(s: int): bool = all {
    canAck(BUILD, s),
    val r = rowHeld(s)
    val v = heldVal(s)
    val dup = v != 0 and idx.get(v) != 0 and idx.get(v) != r
    all {
      TXNS.forall(u => not(txns.get(u).phase == 2 and
        (txns.get(u).dest == s or
         (txns.get(u).maintain and v != 0 and Set(txns.get(u).old, txns.get(u).new).contains(v))))),
      if (dup) all { recordAbort(BUILD), idx' = noEntries, acks' = acks }
      else all { keepLog, idx' = if (v != 0) idx.set(v, r) else idx, acks' = acks.set(BUILD, acks.get(BUILD).union(Set(s))) },
      dead' = dead, ep' = ep, store' = store, truth' = truth, bv' = bv, txns' = txns, keepSide, g' = g,
    }
  }

  // CHECK: シャードが、巻き戻す取引の中で文を試す。通らなければ、取り消す。
  action ackCheck(s: int): bool = all {
    canAck(CHECK, s),
    if (heldVal(s) == 2) all { recordAbort(CHECK), acks' = acks }
    else all { keepLog, acks' = acks.set(CHECK, acks.get(CHECK).union(Set(s))) },
    dead' = dead, ep' = ep, keepData, txns' = txns, keepSide, g' = g,
  }

  // DROP: シャードが、copy が読んだ後の変更がないことを確かめる。あれば、取り消す。
  action ackDrop(s: int): bool = all {
    canAck(DROP, s),
    if (late.get(s)) all { recordAbort(DROP), acks' = acks }
    else all { keepLog, acks' = acks.set(DROP, acks.get(DROP).union(Set(s))) },
    dead' = dead, ep' = ep, keepData, txns' = txns, keepSide, g' = g,
  }

  // NEWT: 新しい表を作るだけなので、適用したことを答える。
  action ackNewt(s: int): bool = all {
    canAck(NEWT, s),
    keepLog, acks' = acks.set(NEWT, acks.get(NEWT).union(Set(s))),
    dead' = dead, ep' = ep, keepData, txns' = txns, keepSide, g' = g,
  }

  // ALTB: B の行を持つシャード (Q) が文を試す。B の行の値が 2 なら通らず、取り消す。
  action ackAltB(s: int): bool = all {
    canAck(ALTB, s),
    if (s == Q and bv == 2) all { recordAbort(ALTB), acks' = acks }
    else all { keepLog, acks' = acks.set(ALTB, acks.get(ALTB).union(Set(s))) },
    dead' = dead, ep' = ep, keepData, txns' = txns, keepSide, g' = g,
  }

  // ---- DROP の場面: 行を写す取引 -----------------------------------------------

  action copy = all {
    HAS_DROP, not(copied), prepE.get(DROP) == 0,
    SHARDS.forall(s => noIntents(s)),
    copied' = true,
    late' = late, pulled' = pulled, drained' = drained,
    keepLog, keepCoord, ep' = ep, keepData, txns' = txns, g' = g,
  }

  // ---- 移動 (M21 の決めた設計のまま) ---------------------------------------------

  action startSplit = all {
    HAS_SPLIT, prepE.get(SPLIT) == 0, not(dead.get(SPLIT)),
    not(ddlOpen),
    len' = len + 1, prepE' = prepE.set(SPLIT, len + 1), commitE' = commitE, abortE' = abortE,
    keepCoord, ep' = ep, keepData, txns' = txns, keepSide, g' = g,
  }

  action pull = all {
    HAS_SPLIT, not(pulled),
    movedAt(ep.get(C)), movedAt(ep.get(P)),
    noIntents(P),
    store' = store.set(C, store.get(P)), pulled' = true,
    g' = { ...g, shapeMismatch: g.shapeMismatch or sv(P) != sv(C) },
    truth' = truth, idx' = idx, bv' = bv, copied' = copied, late' = late, drained' = drained,
    keepLog, keepCoord, ep' = ep, txns' = txns,
  }

  action finishData = all {
    HAS_SPLIT, pulled, not(drained),
    drained' = true,
    copied' = copied, late' = late, pulled' = pulled,
    keepLog, keepCoord, ep' = ep, keepData, txns' = txns, g' = g,
  }

  action endSplit = all {
    HAS_SPLIT, prepE.get(SPLIT) > 0, commitE.get(SPLIT) == 0,
    drained,
    len' = len + 1, commitE' = commitE.set(SPLIT, len + 1), prepE' = prepE, abortE' = abortE,
    keepCoord, ep' = ep, keepData, txns' = txns, keepSide, g' = g,
  }

  action step = any {
    { nondet t = oneOf(TXNS) nondet r = oneOf(ROWS) nondet nv = oneOf(ALLV) nondet pe = oneOf(0.to(len)) nondet via = oneOf(VIAS_W) plan(t, r, nv, pe, via) },
    { nondet t = oneOf(TXNS) nondet via = oneOf(VIAS_R) any { prepare(t), commit(t), refuseApplying(t), txnRead(t, via) } },
    { nondet pe = oneOf(0.to(len)) nondet r = oneOf(ROWS) nondet via = oneOf(VIAS_R) read(pe, r, via) },
    { nondet op = oneOf(ACTIVE) any { prepareOp(op), commitOp(op), expire(op) } },
    dieSplit,
    { nondet s = oneOf(SHARDS) any { applyNext(s), ackBuild(s), ackCheck(s), ackDrop(s), ackNewt(s), ackAltB(s) } },
    copy, startSplit, pull, finishData, endSplit,
  }

  // ---- 不変条件 -------------------------------------------------------------
  // M21 のもの
  val indexMatches = commitE.get(BUILD) == 0 or commitE.get(DROP) > 0 or
    (ROWS.forall(r => lv(r) == 0 or idx.get(lv(r)) == r) and
     VALS.forall(v => idx.get(v) == 0 or lv(idx.get(v)) == v))
  val noWriteWhileFenced = not(g.wroteFenced)
  val notRelied = not(g.relied)
  val oneExit = ACTIVE.forall(op => not(commitE.get(op) > 0 and abortE.get(op) > 0))
  val noIntentWhileFenced = SHARDS.forall(s => not(fencedAt(ep.get(s), OA)) or noIntents(s))
  val noLostAfterReturn = not(g.wroteAfterDrop)
  val noResurrect = not(g.resurrected)
  val guardHolds = not(commitE.get(DROP) > 0 and SHARDS.exists(s => late.get(s)))
  val servable = not(g.refusedLatest)
  val commitApplies = not(g.stuck)
  val pinnedSurvives = not(g.refusedUnmoved)
  val moveKeepsWrites = not(HAS_SPLIT) or droppedAt(len) or lv(1) == truth.get(1)
  val readConsistent = not(g.badRead)
  val sameShape = not(g.shapeMismatch)
  def canApply(s: int): bool =
    ep.get(s) < len and (not(isSchemaEpoch(ep.get(s) + 1)) or (not(movingNow(s)) and (not(drainsA(opAt(ep.get(s) + 1))) or noIntents(s))))
  val moveNotStuck = not(HAS_SPLIT and prepE.get(SPLIT) > 0 and not(pulled)) or
    canApply(P) or canApply(C) or TXNS.exists(t => txns.get(t).phase == 2) or
    (movedAt(ep.get(C)) and movedAt(ep.get(P)) and noIntents(P))
  val m21Safe = and {
    indexMatches, noWriteWhileFenced, notRelied, oneExit, noIntentWhileFenced, noLostAfterReturn, noResurrect, guardHolds,
    servable, commitApplies, pinnedSurvives, moveKeepsWrites, readConsistent, sameShape, moveNotStuck,
  }
  // 新しいもの
  val planMatches = not(g.planMismatch)
  val noRefusalUnrelated = not(g.refusedUnrelated)
  val noRefusalWithoutChange = not(g.refusedNoChange)
  val m24Safe = m21Safe and planMatches and noRefusalUnrelated and noRefusalWithoutChange

  // ---- witness (not(到達したい状態) を invariant にして、違反が出れば到達できる) ----
  def wroteFrom(e: int): bool = TXNS.exists(t => txns.get(t).ok and txns.get(t).pe >= e)
  // 計画の後に、関係のない CREATE TABLE が確定し、関係のない DDL が失敗した。どちらも適用したシャードで、取引が確定する
  val witnessAcrossUnrelated = not(g.acrossUnrelated and TXNS.exists(t => txns.get(t).ok))
  // B を読んだ計画の書き込みが、B の DDL が失敗した後で、計画し直さずに確定する
  val witnessAcrossFailedRead = not(g.acrossFailedRead and TXNS.exists(t => txns.get(t).ok))
  // A の DDL の prepare より前の計画の書き込みが、禁止の間は待ち、その DDL が失敗した後で確定する
  val witnessAcrossFailedTouched = not(g.acrossFailedTouched and TXNS.exists(t => txns.get(t).ok))
  // index の commit より前に計画した読みが、commit を適用したシャードで答えられる
  val witnessReadAcrossIndex = not(g.readAcrossIndex)
  // 頼るものの表定義が変わった要求は、断られる (比べることが空回りしていない)
  val witnessRefusedChanged = not(g.refusedChanged)
  // M21 の witness のうち、場面に当たるもの
  val witnessPublicThenWrite = not(commitE.get(BUILD) > 0 and TXNS.forall(t => txns.get(t).ok and txns.get(t).pe >= commitE.get(BUILD))
                                   and lv(1) != 0 and lv(2) != 0 and idx.get(lv(1)) == 1 and idx.get(lv(2)) == 2)
  val witnessTrialRejectedThenWrite = not(abortE.get(CHECK) > 0 and acks.get(CHECK) != Set() and wroteFrom(abortE.get(CHECK)))
  val witnessCheckCommittedThenWrite = not(commitE.get(CHECK) > 0 and ep.get(P) >= commitE.get(CHECK) and ep.get(Q) >= commitE.get(CHECK)
                                           and wroteFrom(commitE.get(CHECK)))
  val witnessDroppedAfterWrites = not(commitE.get(DROP) > 0 and copied and TXNS.exists(t => txns.get(t).ok)
                                      and ep.get(P) >= commitE.get(DROP) and ep.get(Q) >= commitE.get(DROP))
  val witnessServedWhileDriverDead = not(dead.get(SPLIT) and commitE.get(SPLIT) == 0 and pulled
                                         and TXNS.exists(t => txns.get(t).ok and txns.get(t).dest == C))
  val witnessPinnedSurvives = not(g.acceptedOlder and prepE.get(SPLIT) > 0)
  val witnessParentAnswersUncut = not(g.uncutRead)
}

// ---- 決めた設計 ----------------------------------------------------------------

// 関係のない DDL。A の取引の横で、新しい表 N を作り (CREATE TABLE)、B の DDL が確定するか失敗する。取引は、A だけに頼る計画か、
// B を読む計画で A を書き、確定の前に A を読む文を実行する。
module m24_green_unrelated {
  import m24_core(HAS_BUILD = false, HAS_CHECK = false, HAS_DROP = false, HAS_SPLIT = false, HAS_NEWT = true, HAS_ALTB = true,
    VIA_V = false, VIA_B = true, TXN_READ = true, AUTO_READ = false, NTXN = 1, FIXED_INIT = true,
    PER_TABLE = true, EXPAND_VIEW = true, INDEX_ON_TABLE = true, WRITE_EPOCH = true, READ_DEPS = true, APPLY_REFUSES = 0,
    SCHEMA_ON_PREPARE = false).*
  // 取引が、関係のない CREATE TABLE と、関係のない失敗した DDL をまたいで、確定する (witnessAcrossUnrelated の形)。
  run acrossTest =
    initWith(1, 1, 2).then(plan(1, 1, 2, 0, 0))
        .then(prepareOp(NEWT)).then(applyNext(P)).then(applyNext(Q)).then(ackNewt(P)).then(ackNewt(Q)).then(commitOp(NEWT))
        .then(prepareOp(ALTB)).then(applyNext(P)).then(applyNext(P)).then(applyNext(Q)).then(applyNext(Q))
        .then(ackAltB(P)).then(ackAltB(Q))
        .expect(abortE.get(ALTB) == 4)
        .then(applyNext(P)).then(txnRead(1, 0)).then(prepare(1)).then(commit(1))
        .expect(m24Safe and txns.get(1).ok and g.acrossUnrelated)
  // B を読んだ計画の書き込みが、B の DDL が失敗した後で、計画し直さずに確定する。
  run abortedReadTest =
    initWith(1, 1, 2).then(plan(1, 1, 2, 0, 1))
        .then(prepareOp(ALTB)).then(applyNext(P)).then(applyNext(Q)).then(ackAltB(P)).then(ackAltB(Q)).then(applyNext(P))
        .then(prepare(1)).then(commit(1))
        .expect(m24Safe and txns.get(1).ok and g.acrossFailedRead)
  // B の DDL が確定すれば、B を読んだ計画の書き込みは、古い計画として断られる。
  run changedReadTest =
    initWith(1, 1, 1).then(plan(1, 1, 2, 0, 1))
        .then(prepareOp(ALTB)).then(applyNext(P)).then(applyNext(Q)).then(ackAltB(P)).then(ackAltB(Q)).then(commitOp(ALTB))
        .then(applyNext(P)).then(prepare(1))
        .expect(m24Safe and g.refusedChanged and not(txns.get(1).ok))
}
// A の、シャードをまたぐ UNIQUE の index の作成。index の commit より前の計画の読みは通り、書き込みは断られる。
module m24_green_build {
  import m24_core(HAS_BUILD = true, HAS_CHECK = false, HAS_DROP = false, HAS_SPLIT = false, HAS_NEWT = true, HAS_ALTB = false,
    VIA_V = true, VIA_B = false, TXN_READ = true, AUTO_READ = false, NTXN = 1, FIXED_INIT = false,
    PER_TABLE = true, EXPAND_VIEW = true, INDEX_ON_TABLE = true, WRITE_EPOCH = true, READ_DEPS = true, APPLY_REFUSES = 0,
    SCHEMA_ON_PREPARE = false).*
  run readAcrossIndexTest =
    initWith(1, 2, 1).then(plan(1, 1, 0, 0, 0))
        .then(prepareOp(BUILD)).then(applyNext(P)).then(applyNext(Q)).then(ackBuild(P)).then(ackBuild(Q)).then(commitOp(BUILD))
        .then(applyNext(P)).then(txnRead(1, 2))
        .expect(m24Safe and g.readAcrossIndex and txns.get(1).read)
        .then(prepare(1))
        .expect(m24Safe and g.refusedChanged and not(txns.get(1).ok))
}
// A の、行で失敗し得る DDL (形を変える)。prepare より前の計画の書き込みは、禁止の間は待ち、DDL が失敗すれば通る。
module m24_green_check {
  import m24_core(HAS_BUILD = false, HAS_CHECK = true, HAS_DROP = false, HAS_SPLIT = false, HAS_NEWT = true, HAS_ALTB = false,
    VIA_V = true, VIA_B = false, TXN_READ = true, AUTO_READ = false, NTXN = 1, FIXED_INIT = false,
    PER_TABLE = true, EXPAND_VIEW = true, INDEX_ON_TABLE = true, WRITE_EPOCH = true, READ_DEPS = true, APPLY_REFUSES = 0,
    SCHEMA_ON_PREPARE = false).*
  run abortedTouchedTest =
    initWith(1, 2, 1).then(plan(1, 1, 0, 0, 0))
        .then(prepareOp(CHECK)).then(applyNext(P)).then(applyNext(Q)).then(ackCheck(P)).then(ackCheck(Q))
        .expect(abortE.get(CHECK) == 2)
        .then(applyNext(P)).then(prepare(1)).then(commit(1))
        .expect(m24Safe and txns.get(1).ok and g.acrossFailedTouched)
}
// DROP TABLE A。V を通る読みも、A の DROP の後は、古い計画として断られる。
module m24_green_drop {
  import m24_core(HAS_BUILD = false, HAS_CHECK = false, HAS_DROP = true, HAS_SPLIT = false, HAS_NEWT = true, HAS_ALTB = false,
    VIA_V = true, VIA_B = false, TXN_READ = true, AUTO_READ = false, NTXN = 1, FIXED_INIT = true,
    PER_TABLE = true, EXPAND_VIEW = true, INDEX_ON_TABLE = true, WRITE_EPOCH = true, READ_DEPS = true, APPLY_REFUSES = 0,
    SCHEMA_ON_PREPARE = false).*
  run viewAfterDropTest =
    initWith(1, 1, 1).then(plan(1, 1, 2, 0, 0))
        .then(prepareOp(DROP)).then(applyNext(P)).then(applyNext(Q)).then(ackDrop(P)).then(ackDrop(Q)).then(commitOp(DROP))
        .then(applyNext(P)).then(txnRead(1, 2))
        .expect(m24Safe and g.refusedChanged and txns.get(1).phase == 3 and not(txns.get(1).ok))
}
// 移動と、関係のない CREATE TABLE。分割より前の計画の取引は、動いていない行なら通る (M21 の pinnedSurvives)。
module m24_green_split {
  import m24_core(HAS_BUILD = false, HAS_CHECK = false, HAS_DROP = false, HAS_SPLIT = true, HAS_NEWT = true, HAS_ALTB = false,
    VIA_V = false, VIA_B = false, TXN_READ = true, AUTO_READ = true, NTXN = 1, FIXED_INIT = true,
    PER_TABLE = true, EXPAND_VIEW = true, INDEX_ON_TABLE = true, WRITE_EPOCH = true, READ_DEPS = true, APPLY_REFUSES = 0,
    SCHEMA_ON_PREPARE = false).*
  run splitAcrossNewtTest =
    initWith(1, 1, 1).then(plan(1, 2, 2, 0, 0))
        .then(prepareOp(NEWT)).then(applyNext(P)).then(applyNext(Q)).then(ackNewt(P)).then(ackNewt(Q)).then(commitOp(NEWT))
        .then(startSplit).then(applyNext(Q)).then(applyNext(Q))
        .then(prepare(1)).then(commit(1))
        .expect(m24Safe and txns.get(1).ok and g.acceptedOlder)
        .then(applyNext(C)).then(applyNext(C)).then(applyNext(C)).then(applyNext(P)).then(applyNext(P)).then(pull)
        .then(read(3, 1, 0)).then(finishData).then(endSplit)
        .expect(m24Safe and commitE.get(SPLIT) == 4)
}

// ---- 赤: 新しい条件を 1 つずつ外す -----------------------------------------------

// 段 3 の実装: 表定義全体の epoch 1 つを、prepare、commit、abort のどれでも進める。関係のない CREATE TABLE の prepare で、A の取引が断られる。
module m24_red_global {
  import m24_core(HAS_BUILD = false, HAS_CHECK = false, HAS_DROP = false, HAS_SPLIT = false, HAS_NEWT = true, HAS_ALTB = true,
    VIA_V = false, VIA_B = true, TXN_READ = true, AUTO_READ = false, NTXN = 1, FIXED_INIT = true,
    PER_TABLE = false, EXPAND_VIEW = true, INDEX_ON_TABLE = true, WRITE_EPOCH = true, READ_DEPS = true, APPLY_REFUSES = 0,
    SCHEMA_ON_PREPARE = true).*
  run globalTest =
    initWith(1, 1, 1).then(plan(1, 1, 2, 0, 0)).then(prepareOp(NEWT)).then(applyNext(P)).then(prepare(1))
        .expect(not(noRefusalUnrelated) and not(txns.get(1).ok))
}
// 表定義全体の epoch を、commit だけで進める (決めたこと 6 だけを改めた形)。関係のない CREATE TABLE の commit で、A の取引が断られる。
module m24_red_global_commit_only {
  import m24_core(HAS_BUILD = false, HAS_CHECK = false, HAS_DROP = false, HAS_SPLIT = false, HAS_NEWT = true, HAS_ALTB = true,
    VIA_V = false, VIA_B = true, TXN_READ = true, AUTO_READ = false, NTXN = 1, FIXED_INIT = true,
    PER_TABLE = false, EXPAND_VIEW = true, INDEX_ON_TABLE = true, WRITE_EPOCH = true, READ_DEPS = true, APPLY_REFUSES = 0,
    SCHEMA_ON_PREPARE = false).*
  run globalCommitOnlyTest =
    initWith(1, 1, 1).then(plan(1, 1, 2, 0, 0))
        .then(prepareOp(NEWT)).then(applyNext(P)).then(applyNext(Q)).then(ackNewt(P)).then(ackNewt(Q)).then(commitOp(NEWT))
        .then(applyNext(P)).then(prepare(1))
        .expect(not(noRefusalUnrelated) and not(txns.get(1).ok))
}
// 表ごとの epoch だが、prepare と abort でも進める (段 3 の決めたこと 6 のまま)。失敗した B の DDL で、B を読んだ取引が断られる。
module m24_red_prepare_advances {
  import m24_core(HAS_BUILD = false, HAS_CHECK = false, HAS_DROP = false, HAS_SPLIT = false, HAS_NEWT = true, HAS_ALTB = true,
    VIA_V = false, VIA_B = true, TXN_READ = true, AUTO_READ = false, NTXN = 1, FIXED_INIT = true,
    PER_TABLE = true, EXPAND_VIEW = true, INDEX_ON_TABLE = true, WRITE_EPOCH = true, READ_DEPS = true, APPLY_REFUSES = 0,
    SCHEMA_ON_PREPARE = true).*
  run prepareAdvancesTest =
    initWith(1, 1, 2).then(plan(1, 1, 2, 0, 1)).then(prepareOp(ALTB)).then(applyNext(P)).then(prepare(1))
        .expect(not(noRefusalWithoutChange) and noRefusalUnrelated and not(txns.get(1).ok))
}
// 書き込みの計画が読んだ表を、要求が運ばない。B の DDL の commit を適用したシャードが、B の古い表定義で作った書き込みを受ける。
module m24_red_read_deps {
  import m24_core(HAS_BUILD = false, HAS_CHECK = false, HAS_DROP = false, HAS_SPLIT = false, HAS_NEWT = true, HAS_ALTB = true,
    VIA_V = false, VIA_B = true, TXN_READ = true, AUTO_READ = false, NTXN = 1, FIXED_INIT = true,
    PER_TABLE = true, EXPAND_VIEW = true, INDEX_ON_TABLE = true, WRITE_EPOCH = true, READ_DEPS = false, APPLY_REFUSES = 0,
    SCHEMA_ON_PREPARE = false).*
  run readDepsTest =
    initWith(1, 1, 1).then(plan(1, 1, 2, 0, 1))
        .then(prepareOp(ALTB)).then(applyNext(P)).then(applyNext(Q)).then(ackAltB(P)).then(ackAltB(Q)).then(commitOp(ALTB))
        .then(applyNext(P)).then(prepare(1))
        .expect(not(planMatches))
}
// 段 3 の実装の schemaChanging: 記録を適用している間、どの要求も断る。関係のない CREATE TABLE の適用の間に、A の取引が断られる。
module m24_red_apply_all {
  import m24_core(HAS_BUILD = false, HAS_CHECK = false, HAS_DROP = false, HAS_SPLIT = false, HAS_NEWT = true, HAS_ALTB = true,
    VIA_V = false, VIA_B = true, TXN_READ = true, AUTO_READ = false, NTXN = 1, FIXED_INIT = true,
    PER_TABLE = true, EXPAND_VIEW = true, INDEX_ON_TABLE = true, WRITE_EPOCH = true, READ_DEPS = true, APPLY_REFUSES = 2,
    SCHEMA_ON_PREPARE = false).*
  run applyAllTest =
    initWith(1, 1, 1).then(plan(1, 1, 2, 0, 0)).then(prepareOp(NEWT)).then(refuseApplying(1))
        .expect(not(noRefusalUnrelated))
}
// 記録を適用している間、その記録が触る表に頼る要求を、待たせずに断る。失敗する B の DDL の prepare の適用の間に、B を読んだ取引が断られる。
module m24_red_apply_touched {
  import m24_core(HAS_BUILD = false, HAS_CHECK = false, HAS_DROP = false, HAS_SPLIT = false, HAS_NEWT = true, HAS_ALTB = true,
    VIA_V = false, VIA_B = true, TXN_READ = true, AUTO_READ = false, NTXN = 1, FIXED_INIT = true,
    PER_TABLE = true, EXPAND_VIEW = true, INDEX_ON_TABLE = true, WRITE_EPOCH = true, READ_DEPS = true, APPLY_REFUSES = 1,
    SCHEMA_ON_PREPARE = false).*
  run applyTouchedTest =
    initWith(1, 1, 2).then(plan(1, 1, 2, 0, 1)).then(prepareOp(ALTB)).then(refuseApplying(1))
        .expect(not(noRefusalWithoutChange) and noRefusalUnrelated)
}
// index の DDL を、表とは別のものとして数える。index を知らない計画の書き込みが、index の commit の後で受け付けられる (m21_red_stale と同じ形)。
module m24_red_index {
  import m24_core(HAS_BUILD = true, HAS_CHECK = false, HAS_DROP = false, HAS_SPLIT = false, HAS_NEWT = true, HAS_ALTB = false,
    VIA_V = true, VIA_B = false, TXN_READ = true, AUTO_READ = false, NTXN = 1, FIXED_INIT = false,
    PER_TABLE = true, EXPAND_VIEW = true, INDEX_ON_TABLE = false, WRITE_EPOCH = true, READ_DEPS = true, APPLY_REFUSES = 0,
    SCHEMA_ON_PREPARE = false).*
  run indexTest =
    initWith(1, 0, 1).then(plan(1, 1, 2, 0, 0))
        .then(prepareOp(BUILD)).then(applyNext(P)).then(applyNext(Q)).then(ackBuild(P)).then(ackBuild(Q)).then(commitOp(BUILD))
        .then(applyNext(P)).then(prepare(1))
        .expect(not(planMatches))
        .then(commit(1))
        .expect(not(indexMatches) and idx.get(1) == 1 and store.get(P) == 2)
}
// 書き込みが、表の読みの epoch を比べる。index の commit は読みの epoch を進めないので、同じく古い計画の書き込みが通る。
module m24_red_write_epoch {
  import m24_core(HAS_BUILD = true, HAS_CHECK = false, HAS_DROP = false, HAS_SPLIT = false, HAS_NEWT = true, HAS_ALTB = false,
    VIA_V = true, VIA_B = false, TXN_READ = true, AUTO_READ = false, NTXN = 1, FIXED_INIT = false,
    PER_TABLE = true, EXPAND_VIEW = true, INDEX_ON_TABLE = true, WRITE_EPOCH = false, READ_DEPS = true, APPLY_REFUSES = 0,
    SCHEMA_ON_PREPARE = false).*
  run writeEpochTest =
    initWith(1, 0, 1).then(plan(1, 1, 2, 0, 0))
        .then(prepareOp(BUILD)).then(applyNext(P)).then(applyNext(Q)).then(ackBuild(P)).then(ackBuild(Q)).then(commitOp(BUILD))
        .then(applyNext(P)).then(prepare(1)).then(commit(1))
        .expect(not(indexMatches) and not(planMatches))
}
// view を通る計画が、view だけを運び、元の表を運ばない。A の DROP を適用したシャードが、V を通る古い計画の読みに答える。
module m24_red_view {
  import m24_core(HAS_BUILD = false, HAS_CHECK = false, HAS_DROP = true, HAS_SPLIT = false, HAS_NEWT = true, HAS_ALTB = false,
    VIA_V = true, VIA_B = false, TXN_READ = true, AUTO_READ = false, NTXN = 1, FIXED_INIT = true,
    PER_TABLE = true, EXPAND_VIEW = false, INDEX_ON_TABLE = true, WRITE_EPOCH = true, READ_DEPS = true, APPLY_REFUSES = 0,
    SCHEMA_ON_PREPARE = false).*
  run viewTest =
    initWith(1, 1, 1).then(plan(1, 1, 2, 0, 0))
        .then(prepareOp(DROP)).then(applyNext(P)).then(applyNext(Q)).then(ackDrop(P)).then(ackDrop(Q)).then(commitOp(DROP))
        .then(applyNext(P)).then(txnRead(1, 2))
        .expect(not(readConsistent) and not(planMatches))
}

// ---- DDL の床 (古い時刻の行の読み戻し) ----------------------------------------------
//
// シャードは、取引の読み取り時刻 T が自分の時計より古く、T より後に確定のある表を読むときは、その確定の before-image を、巻き戻す
// 取引の中で戻してから読む (rollback-read。ShardKernel.deltaAfter)。行の形を変える DDL を適用した後は、それより前の image を、
// 新しい形の表に戻せない。段 3 の実装は、DDL の commit を適用するたびに、シャードに 1 つの床 (ddlFloor) を置き、どの表についても、
// 床より古い T の読み戻しを断る (ReadTooOld。refresh は "window too old"、述語の検証は「変わった」と見なす)。巻き戻すのも、
// T より後に確定した、すべての表の行である。そのため、関係のない表 B の DDL の後で、A を読む取引の 2 文目が断られる。
// 決めた設計では、床を表ごとに持ち、行の形を変えた表にだけ置く。読みが巻き戻すのは読む表の行だけで、見る床もその表のものだけである。
// モデルはシャード 1 つ、表 A と B、時計 0〜MAXT。別の接続の書き込みは、A か B に 1 つ確定する。B の DDL は、B の行の形を変える
// commit を 1 回適用する。取引は、最初の読みで T を決め、その後 A か B を T で読む (refresh と述語の検証も、同じ規則で T から確かめる)。
module m24_floor_core {
  const PER_TABLE_FLOOR: bool    // 床を表ごとに持つ (false: シャードに 1 つ。段 3 の実装)
  const FLOOR_ON_CHANGED: bool   // 形を変えた表に床を置く (false: 置かない)
  const RESTORE_READ_ONLY: bool  // 巻き戻すのは、読む表の行だけ (false: T より後に確定した、すべての表の行。段 3 の実装)

  pure val TA = 1
  pure val TB = 2
  pure val TABLES = Set(1, 2)
  pure val MAXT = 5

  var now: int                     // シャードの時計
  var writes: int -> Set[int]      // 表 -> 確定した書き込みの時刻
  var ddlAt: int                   // B の DDL の commit を適用した時刻 (0 = まだ)
  var floor: int -> int            // 表 -> 床
  var T: int                       // 取引の読み取り時刻 (-1 = まだ読んでいない)
  var over: bool                   // 取引が断られた
  var refusedUnrelated: bool       // ghost: 形の変わっていない表 (A) の読みを、床で断った
  var restoredAcross: bool         // ghost: 形を変える DDL より前の image を、新しい形の表に戻した
  var servedBelow: bool            // ghost (witness): B の DDL より古い T で、T より後に確定のある A を読んだ
  var refusedB: bool               // ghost (witness): B の DDL より前の確定を巻き戻す B の読みを、床で断った

  action init = all {
    now' = 0, writes' = TABLES.mapBy(_ => Set()), ddlAt' = 0, floor' = TABLES.mapBy(_ => 0), T' = -1, over' = false,
    refusedUnrelated' = false, restoredAcross' = false, servedBelow' = false, refusedB' = false,
  }
  action keepGhost = all {
    refusedUnrelated' = refusedUnrelated, restoredAcross' = restoredAcross, servedBelow' = servedBelow, refusedB' = refusedB,
  }

  // 別の接続の書き込みが、表 t に確定する。
  action write(t: int): bool = all {
    now < MAXT,
    now' = now + 1, writes' = writes.set(t, writes.get(t).union(Set(now + 1))),
    ddlAt' = ddlAt, floor' = floor, T' = T, over' = over, keepGhost,
  }
  // シャードが、B の形を変える DDL の commit を適用する。床は、適用した時刻である (ShardKernel.applyStep の ddlFloor = issue())。
  action ddlB = all {
    ddlAt == 0, now < MAXT,
    now' = now + 1, ddlAt' = now + 1,
    floor' = if (not(FLOOR_ON_CHANGED)) floor else if (PER_TABLE_FLOOR) floor.set(TB, now + 1) else TABLES.mapBy(_ => now + 1),
    writes' = writes, T' = T, over' = over, keepGhost,
  }
  // 取引の最初の読み。T はシャードの時計で、巻き戻しは要らない。
  action firstRead = all {
    T < 0,
    T' = now,
    now' = now, writes' = writes, ddlAt' = ddlAt, floor' = floor, over' = over, keepGhost,
  }
  // 取引の後の読み (と、T からの refresh、述語の検証)。表 t を T で読む。T より後に確定のある表の行を巻き戻すので、その表の床を見る。
  action readAt(t: int): bool = all {
    T >= 0, not(over),
    val restore = if (RESTORE_READ_ONLY) Set(t) else TABLES
    val needs = restore.filter(u => writes.get(u).exists(w => w > T))
    val refuse = needs.exists(u => T < floor.get(u))
    all {
      over' = refuse,
      refusedUnrelated' = (refusedUnrelated or (refuse and t == TA)),
      refusedB' = (refusedB or (refuse and t == TB and writes.get(TB).exists(w => w > T and w < ddlAt))),
      restoredAcross' = (restoredAcross or (not(refuse) and needs.contains(TB) and writes.get(TB).exists(w => w > T and w < ddlAt))),
      servedBelow' = (servedBelow or (not(refuse) and t == TA and ddlAt > T and writes.get(TA).exists(w => w > T))),
      now' = now, writes' = writes, ddlAt' = ddlAt, floor' = floor, T' = T,
    }
  }
  action step = any { { nondet t = oneOf(TABLES) any { write(t), readAt(t) } }, ddlB, firstRead }

  val noRefusalUnrelated = not(refusedUnrelated)
  val noRestoreAcross = not(restoredAcross)
  val floorSafe = noRefusalUnrelated and noRestoreAcross
  // 床を表ごとに持てば、B の DDL より古い T で、A の確定を巻き戻して読める
  val witnessServedBelow = not(servedBelow)
  // B の DDL より前の B の確定を巻き戻す読みは、断られる
  val witnessRefusedB = not(refusedB)
}

module m24_floor_green {
  import m24_floor_core(PER_TABLE_FLOOR = true, FLOOR_ON_CHANGED = true, RESTORE_READ_ONLY = true).*
  run belowTest =
    init.then(firstRead).then(write(TA)).then(write(TB)).then(ddlB).then(readAt(TA))
        .expect(floorSafe and servedBelow and not(over))
        .then(readAt(TB))
        .expect(floorSafe and refusedB and over)
}
// 段 3 の実装: 床がシャードに 1 つ。B の DDL の後、A の読みが断られる。
module m24_floor_red_global {
  import m24_floor_core(PER_TABLE_FLOOR = false, FLOOR_ON_CHANGED = true, RESTORE_READ_ONLY = true).*
  run globalTest =
    init.then(firstRead).then(write(TA)).then(ddlB).then(readAt(TA))
        .expect(not(noRefusalUnrelated))
}
// 床は表ごとだが、巻き戻しは、すべての表の行である。A の読みが、B の巻き戻しのために断られる。
module m24_floor_red_restore_all {
  import m24_floor_core(PER_TABLE_FLOOR = true, FLOOR_ON_CHANGED = true, RESTORE_READ_ONLY = false).*
  run restoreAllTest =
    init.then(firstRead).then(write(TB)).then(ddlB).then(readAt(TA))
        .expect(not(noRefusalUnrelated))
}
// 形を変えた表に床を置かない。B の DDL より前の image を、新しい形の B に戻す。
module m24_floor_red_no_floor {
  import m24_floor_core(PER_TABLE_FLOOR = true, FLOOR_ON_CHANGED = false, RESTORE_READ_ONLY = true).*
  run noFloorTest =
    init.then(firstRead).then(write(TB)).then(ddlB).then(readAt(TB))
        .expect(not(noRestoreAcross))
}

// ---- 行ロックと DDL の待ち (触った表に書いた取引) -----------------------------------------
//
// SQLite では、書いた取引が書き込みのロックを持つので、ほかの接続の DDL は、その取引が終わるまで待つ (busy_timeout が過ぎれば、
// DDL のほうが SQLITE_BUSY で失敗する)。取引は失敗しない。
// D∞ の悲観の取引 (SQL の BEGIN と Hrana の baton。Drizzle の libSQL の取引もこれ) は、書いた行のロックを、行のシャードに持つ。
// ロックの TTL は 5 秒で、そのシャードで文を実行するたびに延びる。段 3 の実装の prepare は intent を決着させるだけで、ロックを
// 待たない。そのため、書いた取引の COMMIT が、DDL の後で古い計画として断られる。
// ここで確かめる条件 (取引の側の 2 つ):
//   WAIT_LOCKS  シャードは、表 X の prepare を、X の行のロックがある間は適用しない。待ちの上限は busy_timeout と同じ 5 秒で、
//               過ぎれば prepared に ok でないと答え、DDL が SQLITE_BUSY で失敗する (shardBusy)。
//   WOUND       X の行のロックを持つ取引の書き込みか COMMIT が、別のシャードで X の書き込み禁止に当たったら、Worker が Meta に
//               その遷移を取り消させる (開いていれば abort が記録される)。
// このモデルでは、取り消された DDL は SQLITE_BUSY で失敗する。そのため DDL の成否が、取引の行の置き場所で決まる (規則 4 に反する)。
// 決めた設計は、取り消された DDL を、同じ期限の中でやり直す形で、下の m24_retry_* が確かめる。このモデルは、ロックの TTL が
// 切れる手 (下の idleExpire と blockedExpire) と取引の側の 2 つの条件を、時刻なしで確かめるものとして残す。
// モデルは、表 X の行 x1 (シャード P) と x2 (Q)、悲観の取引 1 件 (x1 を書き、x2 を書き、COMMIT する)、X の DDL 1 回。
// 取引の計画は DDL より前のスナップショットである。
// ロックが切れる手は 2 つある。idleExpire は、取引がそのシャードで 5 秒以上文を実行しなかったこと (利用者が待たせた) で、
// 切れたことを ghost に残す。blockedExpire は、取引が書き込み禁止で待たされている間に時間が経ったことで、WOUND の設計では、
// 待たされた取引はすぐに遷移を取り消させるので、遷移が開いている間は起きない。
// invariant holderSurvives: x1 を書いた取引は、ロックが利用者の待ちで切れていなければ、DDL のために断られない (版で断られない、
// 書き込み禁止の待ちを諦めない)。まだ何も書いていない取引の最初の書き込みは数えない (触っていない取引は、表定義を取り直して
// 計画し直せる。Txn.rebase)。
module m24_lock_core {
  const WAIT_LOCKS: bool
  const WOUND: bool

  pure val P = 1
  pure val Q = 2
  pure val SHARDS = Set(1, 2)

  var meta: int                 // DDL: 0 まだ、1 開いている (prepare を記録した)、2 commit、3 abort
  var applied: int -> int       // シャード -> 0 何も適用していない、1 prepare を適用した (書き込み禁止)、2 終わりを適用した
  var acked: int -> bool
  var pc: int                   // 取引: 0 x1 を書く前、1 x1 を書いた、2 x2 を書いた、3 確定した、4 断られた
  var locks: int -> bool        // シャード -> 取引の、生きているロックがある
  var idle: bool                // ghost: 取引のロックが、利用者の待ちで切れた
  var refusedHolder: bool       // ghost: x1 を書いた取引が、利用者の待ちでロックを失っていないのに、DDL のために断られた
  var wounded: bool             // ghost (witness): 取引が DDL を取り消させた
  var ddlBusy: bool             // ghost (witness): シャードのロックの待ちが上限を過ぎ、DDL が失敗した

  action init = all {
    meta' = 0, applied' = SHARDS.mapBy(_ => 0), acked' = SHARDS.mapBy(_ => false), pc' = 0, locks' = SHARDS.mapBy(_ => false),
    idle' = false, refusedHolder' = false, wounded' = false, ddlBusy' = false,
  }
  action keepTxn = all { pc' = pc, locks' = locks, idle' = idle, refusedHolder' = refusedHolder, wounded' = wounded }
  action keepDdl = all { meta' = meta, applied' = applied, acked' = acked, ddlBusy' = ddlBusy }

  /** s が DDL の commit を適用した。DDL より前の計画は古い。 */
  def stale(s: int): bool = applied.get(s) == 2 and meta == 2
  def fenced(s: int): bool = applied.get(s) == 1
  def holds: bool = locks.get(P) or locks.get(Q)
  /** 取引の次の要求が、書き込み禁止で待たされている。 */
  def blocked: bool = (pc == 0 and fenced(P)) or (pc == 1 and fenced(Q)) or (pc == 2 and SHARDS.exists(s => fenced(s)))
  /** 取引が DDL のために断られたときの ghost。 */
  def refusal: bool = refusedHolder or (pc >= 1 and not(idle))

  // ---- DDL ----
  action prepareDdl = all { meta == 0, meta' = 1, applied' = applied, acked' = acked, ddlBusy' = ddlBusy, keepTxn }
  // シャードが prepare を適用する。遷移が開いている間は、X の行のロックがあれば待つ (WAIT_LOCKS)。終わった遷移の prepare は、
  // 遅れたシャードが続けて適用するだけなので、待たない。
  action applyPrepare(s: int): bool = all {
    meta >= 1, applied.get(s) == 0,
    meta != 1 or not(WAIT_LOCKS) or not(locks.get(s)),
    applied' = applied.set(s, 1), meta' = meta, acked' = acked, ddlBusy' = ddlBusy, keepTxn,
  }
  action ack(s: int): bool = all {
    meta == 1, applied.get(s) == 1, not(acked.get(s)),
    acked' = acked.set(s, true), meta' = meta, applied' = applied, ddlBusy' = ddlBusy, keepTxn,
  }
  // シャードのロックの待ちが上限を過ぎた。prepared に ok でないと答え、進める側が abort を記録させる。
  action shardBusy(s: int): bool = all {
    WAIT_LOCKS, meta == 1, applied.get(s) == 0, locks.get(s),
    meta' = 3, ddlBusy' = true, applied' = applied, acked' = acked, keepTxn,
  }
  action commitDdl = all {
    meta == 1, SHARDS.forall(s => acked.get(s)),
    meta' = 2, applied' = applied, acked' = acked, ddlBusy' = ddlBusy, keepTxn,
  }
  // 期限切れ (進める側が止まった)。
  action expireDdl = all { meta == 1, meta' = 3, applied' = applied, acked' = acked, ddlBusy' = ddlBusy, keepTxn }
  action applyEnd(s: int): bool = all {
    meta >= 2, applied.get(s) == 1,
    applied' = applied.set(s, 2), meta' = meta, acked' = acked, ddlBusy' = ddlBusy, keepTxn,
  }

  // ---- ロックが切れる ----
  action idleExpire(s: int): bool = all {
    locks.get(s), not(blocked),
    locks' = locks.set(s, false), idle' = true,
    pc' = pc, refusedHolder' = refusedHolder, wounded' = wounded, keepDdl,
  }
  action blockedExpire(s: int): bool = all {
    locks.get(s), blocked, not(WOUND) or meta != 1,
    locks' = locks.set(s, false),
    pc' = pc, idle' = idle, refusedHolder' = refusedHolder, wounded' = wounded, keepDdl,
  }

  // ---- 取引 ----
  // 書き込み。pc 0 は P の x1、pc 1 は Q の x2。書き込み禁止なら待つ。古い計画なら断られる。
  action write = all {
    pc == 0 or pc == 1,
    val s = if (pc == 0) P else Q
    all {
      not(fenced(s)),
      if (stale(s)) all { pc' = 4, locks' = SHARDS.mapBy(_ => false), refusedHolder' = refusal }
      else all { pc' = pc + 1, locks' = locks.set(s, true), refusedHolder' = refusedHolder },
      idle' = idle, wounded' = wounded, keepDdl,
    }
  }
  // COMMIT。両方のシャードに確定を求める。どちらかが書き込み禁止なら待ち、古い計画として断られれば終わる。
  action commitTxn = all {
    pc == 2,
    SHARDS.forall(s => not(fenced(s))),
    if (SHARDS.exists(s => stale(s))) all { pc' = 4, refusedHolder' = refusal }
    else all { pc' = 3, refusedHolder' = refusedHolder },
    locks' = SHARDS.mapBy(_ => false), idle' = idle, wounded' = wounded, keepDdl,
  }
  // 書き込み禁止に当たった取引が、X の行のロックを持っていれば、遷移を取り消させる。
  action wound = all {
    WOUND, meta == 1, blocked, holds,
    meta' = 3, wounded' = true, applied' = applied, acked' = acked, ddlBusy' = ddlBusy,
    pc' = pc, locks' = locks, idle' = idle, refusedHolder' = refusedHolder,
  }
  // 書き込み禁止の待ちを諦める (30 秒)。WOUND の設計では、x1 を書いた取引は、先に遷移を取り消させるので、諦めない。
  action giveUp = all {
    blocked, not(WOUND) or pc == 0,
    pc' = 4, locks' = SHARDS.mapBy(_ => false), refusedHolder' = refusal, idle' = idle, wounded' = wounded, keepDdl,
  }

  action step = any {
    prepareDdl, commitDdl, expireDdl, write, commitTxn, wound, giveUp,
    { nondet s = oneOf(SHARDS) any { applyPrepare(s), ack(s), shardBusy(s), applyEnd(s), idleExpire(s), blockedExpire(s) } },
  }

  val holderSurvives = not(refusedHolder)
  // x1 を書いた取引の COMMIT が通り、DDL は、その後で確定する
  val witnessDdlAfterTxn = not(pc == 3 and meta == 2)
  // 別のシャードの書き込み禁止に当たった取引が、DDL を取り消させて、確定する
  val witnessWoundThenCommit = not(wounded and pc == 3)
  // シャードのロックの待ちが上限を過ぎて DDL が失敗し、取引が確定する
  val witnessDdlBusy = not(ddlBusy and pc == 3)
}

// 取引の側の 2 つの条件を入れた形。取引は生き残るが、取り消された DDL はやり直さずに失敗する (決めた設計は m24_retry_green)。
module m24_lock_green {
  import m24_lock_core(WAIT_LOCKS = true, WOUND = true).*
  // x1 を P に書いた後、Q が prepare を適用した。x2 の書き込みが Q の書き込み禁止に当たり、取引が DDL を取り消させて、確定する。
  run woundTest =
    init.then(write).then(prepareDdl).then(applyPrepare(Q))
        .expect(blocked and pc == 1)
        .then(wound).then(applyEnd(Q)).then(write).then(commitTxn)
        .expect(holderSurvives and pc == 3 and meta == 3)
}
// prepare がロックを待たない。P が、x1 のロックがあるまま prepare を適用し、DDL が確定する。取引の x2 の書き込みが断られる。
module m24_lock_red_no_wait {
  import m24_lock_core(WAIT_LOCKS = false, WOUND = true).*
  run noWaitTest =
    init.then(write).then(prepareDdl).then(applyPrepare(P)).then(applyPrepare(Q)).then(ack(P)).then(ack(Q)).then(commitDdl)
        .then(applyEnd(Q)).then(write)
        .expect(not(holderSurvives))
}
// 取引が DDL を取り消させない。x2 の書き込みが Q の書き込み禁止で待つ間に、P の x1 のロックが切れ、DDL が確定し、取引が断られる
// (いまのロックの TTL は、待っている間も、文を実行しないシャードでは延びない)。
module m24_lock_red_no_wound {
  import m24_lock_core(WAIT_LOCKS = true, WOUND = false).*
  run noWoundTest =
    init.then(write).then(prepareDdl).then(applyPrepare(Q)).then(blockedExpire(P)).then(applyPrepare(P))
        .then(ack(P)).then(ack(Q)).then(commitDdl).then(applyEnd(Q)).then(write)
        .expect(not(holderSurvives))
}

// ---- 取り消させた DDL のやり直し (書いた取引が、別のシャードで書き込み禁止に当たったとき) ---------------------------
//
// m24_lock の WOUND は、ロックを持つ取引が別のシャードで書き込み禁止に当たると、DDL を取り消させ、DDL は SQLITE_BUSY で失敗する。
// 行が 1 つのシャードにあれば、DDL は 5 秒まで待ち、その間に取引が確定すれば通る。行が 2 つのシャードにあり、2 つ目の書き込みが、
// prepare を先に適用したシャードに当たると、DDL はすぐに失敗する。DDL の成否が行の置き場所で決まるので、規則 4 に反する。
// 決めた設計 (2026-11-16):
//   WAIT_LOCKS   シャードは、開いている試みの prepare を、表の行のロックがある間は適用しない (m24_lock のまま)。
//   WOUND        ロックを持つ取引の文が、開いている試みの書き込み禁止に当たったら、Worker が Meta に、その試みを取り消させる
//                (m24_lock のまま)。
//   HOLD         禁止に当たったシャードは、その書き込みを断る (TableLocked) ときに、行のロックを取引に与える (書かずに)。
//                取引の Worker は、そのシャードを、ロックを持つシャードに数える (COMMIT と ROLLBACK で放す)。
//   RETRY        進める側 (DDL の文を受けた Worker) は、取り消された DDL を、新しい試みでやり直す。
//   KEEP_BUDGET  やり直しも、DDL を始めたときの期限 (busy_timeout と同じ 5 秒) の中で行う。期限が来たら、開いている試みを
//                取り消し、DDL は SQLITE_BUSY で失敗する。
//   FRESH_EPOCH  やり直しは、新しい epoch の prepare を記録し、全部のシャードの ok を集め直す。
// HOLD がないと、取り消しの後で、そのシャードが、取引の書き込みより先に、やり直しの prepare を適用し得る。取引はまた禁止に当たり、
// 取り消しとやり直しが、期限まで繰り返す (m24_retry_red_no_hold)。
//
// 時刻: 刻み (tick) は、内部の手 (シャードの適用と ok、進める側の commit、やり直しと期限、禁止に当たったロックと取り消させる手、
// 送られた文の実行) がどれもできないときにだけ進む。RPC は 5 秒に比べて十分に速い、という仮定である。利用者の手 (文を送る、DDL を
// 始める) は、いつでもよい。期限 B は 2 刻みで、時刻は 0〜MAXT。
// モデルは、表 X の行 x1 と x2 (置き場所は、シャード P と Q の 4 通りから init が選ぶ)、悲観の取引 1 件 (x1 を書き、x2 を書き、
// COMMIT する)、X の DDL 1 回。取引の計画は、DDL より前の表定義である。ロックの TTL は、この instance にない (m24_lock にある)。
// 試みは、シャードごとに、いまの試みについての位置 (cur) と、前の試みの禁止がまだ残っているか (lag) だけで表す。閉じた試みの
// prepare と終わりは、待たずに続けて適用するので、まとめて 1 手にした。やり直しの回数に上限を置かずに、状態は有限になる。
//
// invariant:
//   asSqlite          DDL の結果は、利用者の時刻 (x1 を送った時刻 tW、COMMIT を送った時刻 tC、DDL を始めた時刻 d0) だけで決まり、
//                     SQLite (busy_timeout 5 秒) と同じである。DDL を始める前の刻みに x1 を送り、期限 (d0 + B) までに COMMIT を
//                     送らなかったときだけ SQLITE_BUSY で、それも期限より前には失敗しない。期限のうちに放されたなら確定する。DDL は
//                     期限までに終わる。置き場所を使わないので、どの置き場所でも結果が同じになる。同じ刻みの競り (x1 を d0 に送る、
//                     COMMIT を期限の刻みに送る) は、SQLite でもどちらが先にロックを取るかで決まるので、両方を許す。
//   holderSurvives    行を書いた取引は、DDL のために断られない (txnNotRefused: 取引は断られない。まだ何も書いていなければ計画し直す)
//   holderNotDelayed  ロックを持つ取引の文は、DDL を待って時刻をまたがない (SQLite では、ロックを持つ側は DDL を待たない)
//   noReblock         取引は、同じシャードで、同じ DDL の書き込み禁止に 2 度当たらない (取り消しとやり直しが繰り返さない。代わりの
//                     性質で、本来の性質は、時刻が進むこと (timeAdvances) である)
//   checkSawRows      DDL の commit が頼る ok は、どれも、そのシャードがその後で行の書き込みを受けていないものである
//                     (シャードの確かめ (CHECK の試し、index の行の走査) が、DDL の確定する行を全部見た)
module m24_retry_core {
  const WAIT_LOCKS: bool
  const WOUND: bool
  const HOLD: bool
  const RETRY: bool
  const KEEP_BUDGET: bool
  const FRESH_EPOCH: bool
  // ---- 場面 ----
  const SAME_SHARD: bool        // 行 x1 と x2 を同じシャードに置く置き場所だけにする (置き場所で成否が変わる形を示すため)

  pure val P = 1
  pure val Q = 2
  pure val SHARDS = Set(1, 2)
  pure val B = 2                // DDL の期限 (busy_timeout の 5 秒) を、刻みの数で
  pure val MAXT = 4

  // いまの試み
  pure val NONE = 0
  pure val OPEN = 1
  pure val COMMITTED = 2
  pure val ABORTED = 3
  // DDL の結果
  pure val RUNNING = 0
  pure val OK = 1
  pure val BUSY = 2

  var now: int
  var sh1: int                  // 行 x1 のシャード
  var sh2: int                  // 行 x2 のシャード
  // ---- DDL ----
  var meta: int                 // いまの試み: NONE (まだ始めていない)、OPEN、COMMITTED、ABORTED
  var dres: int                 // DDL の結果: RUNNING、OK、BUSY
  var dstart: int               // 期限を数え始めた時刻 (-1 まだ)
  var cur: int -> int           // シャード -> いまの試みについて: 0 prepare を適用していない、1 prepare を適用した (書き込み禁止)、
                                // 2 終わりを適用した
  var lag: int -> bool          // シャード -> 前の試みの prepare を適用したまま、その abort をまだ適用していない (書き込み禁止)
  var acked: Set[int]           // いまの試みに ok と答えたシャード (FRESH_EPOCH = false では、前の試みの答えも残る)
  // ---- 取引 ----
  var pc: int                   // 0 x1 を書く前、1 x1 を書いた、2 x2 を書いた、3 確定した、4 断られた
  var pend: bool                // 利用者が次の文を送り、まだ答えがない
  var locks: int -> bool        // シャード -> 取引のロックがある
  var rebased: bool             // 取引は、DDL の commit の後の表定義で計画し直した
  // ---- ghost ----
  var d0: int                   // DDL を始めた時刻 (-1 まだ)
  var dEnd: int                 // DDL が終わった時刻
  var tW: int                   // 利用者が x1 の書き込みを送った時刻
  var tC: int                   // 利用者が COMMIT を送った時刻
  var refusedHolder: bool       // 行を書いた取引が、DDL のために断られた
  var delayed: bool             // ロックを持つ取引の文が、答えのないまま時刻をまたいだ
  var reblocked: bool           // 取引が、取り消させたことのあるシャードで、また開いている試みの禁止に当たって取り消させた
  var badCheck: bool            // DDL の commit が、その後で行の書き込みを受けたシャードの ok に頼った
  var retried: bool             // 進める側がやり直した (witness 用)
  var woundAt: Set[int]         // 取引が禁止に当たって取り消させたシャード
  var late: Set[int]            // ok と答えた後で、行の書き込みを受けたシャード

  pure val noLocks: int -> bool = SHARDS.mapBy(_ => false)

  action initWith(a: int, b: int): bool = all {
    now' = 0, sh1' = a, sh2' = b,
    meta' = NONE, dres' = RUNNING, dstart' = -1, cur' = SHARDS.mapBy(_ => 0), lag' = SHARDS.mapBy(_ => false), acked' = Set(),
    pc' = 0, pend' = false, locks' = noLocks, rebased' = false,
    d0' = -1, dEnd' = -1, tW' = -1, tC' = -1,
    refusedHolder' = false, delayed' = false, reblocked' = false, badCheck' = false, retried' = false,
    woundAt' = Set(), late' = Set(),
  }
  action init = { nondet a = oneOf(SHARDS) nondet b = oneOf(SHARDS) all { not(SAME_SHARD) or a == b, initWith(a, b) } }

  action keepDdl = all { meta' = meta, dres' = dres, dstart' = dstart, cur' = cur, lag' = lag, acked' = acked }
  action keepTxn = all { pc' = pc, pend' = pend, locks' = locks, rebased' = rebased }
  action keepTimes = all { d0' = d0, dEnd' = dEnd, tW' = tW, tC' = tC }
  action keepFlags = all {
    refusedHolder' = refusedHolder, delayed' = delayed, reblocked' = reblocked, badCheck' = badCheck, retried' = retried,
    woundAt' = woundAt, late' = late,
  }
  action keepEnv = all { now' = now, sh1' = sh1, sh2' = sh2 }

  // ---- 見えるもの ----
  def deadline: int = dstart + B
  def closed: bool = meta == COMMITTED or meta == ABORTED
  /** シャード s は、書き込みを止めている (いまの試みか、前の試みの prepare を適用して、終わりをまだ適用していない)。 */
  def fenced(s: int): bool = cur.get(s) == 1 or lag.get(s)
  /** s の禁止は、開いている試みのものである (取り消させる相手がいる)。 */
  def openFence(s: int): bool = cur.get(s) == 1 and meta == OPEN
  /** s は DDL の commit を適用した。DDL より前の計画は古い。 */
  def stale(s: int): bool = cur.get(s) == 2 and meta == COMMITTED and not(rebased)
  def holder: bool = pc == 1 or pc == 2
  def lockSet: Set[int] = SHARDS.filter(s => locks.get(s))
  /** 送られた文が触るシャード。書き込みは行のシャード、COMMIT はロックを持つシャード。 */
  def reqShards: Set[int] = if (pc == 0) Set(sh1) else if (pc == 1) Set(sh2) else lockSet
  def blockers: Set[int] = reqShards.filter(s => openFence(s))

  // ---- 内部の手ができるか。tick の条件と、手の条件の両方に、この定義だけを使う ----
  def canExec: bool = pend and pc <= 2 and not(reqShards.exists(s => fenced(s)))
  def canHold: bool = HOLD and pend and pc == 1 and fenced(sh2) and not(locks.get(sh2))
  def canWound: bool =
    WOUND and meta == OPEN and pend and holder and blockers != Set() and (not(HOLD) or blockers.forall(s => locks.get(s)))
  def canApplyPrep(s: int): bool = meta == OPEN and cur.get(s) == 0 and not(lag.get(s)) and (not(WAIT_LOCKS) or not(locks.get(s)))
  def canApplyEnd(s: int): bool = closed and cur.get(s) != 2 and not(lag.get(s))
  def canApplyLag(s: int): bool = lag.get(s)
  def canAck(s: int): bool = meta == OPEN and cur.get(s) == 1 and not(acked.contains(s))
  def canCommitDdl: bool = dres == RUNNING and meta == OPEN and acked == SHARDS and now <= deadline
  def canRetry: bool = RETRY and dres == RUNNING and meta == ABORTED and now < deadline
  def canExpire: bool = dres == RUNNING and meta != NONE and now >= deadline
  def urgent: bool = or {
    canExec, canHold, canWound, canCommitDdl, canRetry, canExpire,
    SHARDS.exists(s => canApplyPrep(s) or canApplyEnd(s) or canApplyLag(s) or canAck(s)),
  }

  // ---- 利用者 ----
  // 取引の次の文を送る (x1 の書き込み、x2 の書き込み、COMMIT)。送らずに待ってもよい。
  action issue = all {
    not(pend), pc <= 2,
    pend' = true, pc' = pc, locks' = locks, rebased' = rebased,
    tW' = if (pc == 0) now else tW, tC' = if (pc == 2) now else tC, d0' = d0, dEnd' = dEnd,
    keepDdl, keepFlags, keepEnv,
  }
  // 別の接続が DDL を始める。最初の試みの prepare を記録する。
  action startDdl = all {
    meta == NONE, now + B <= MAXT,
    meta' = OPEN, dres' = RUNNING, dstart' = now, cur' = cur, lag' = lag, acked' = acked,
    d0' = now, dEnd' = dEnd, tW' = tW, tC' = tC,
    keepTxn, keepFlags, keepEnv,
  }
  // 時刻が進む。内部の手がどれもできないときだけ。
  action tick = all {
    now < MAXT, not(urgent),
    now' = now + 1, sh1' = sh1, sh2' = sh2,
    delayed' = (delayed or (pend and holder)),
    refusedHolder' = refusedHolder, reblocked' = reblocked, badCheck' = badCheck, retried' = retried, woundAt' = woundAt, late' = late,
    keepDdl, keepTxn, keepTimes,
  }

  // ---- 取引 ----
  // 送られた文を、シャードが実行する。書き込み禁止のシャードがあれば待つ。古い計画なら断られる (まだ何も書いていなければ、新しい
  // 表定義で計画し直す。Txn.rebase。文は送られたまま)。
  action exec = all {
    canExec,
    val refused = reqShards.exists(s => stale(s))
    val s = if (pc == 0) sh1 else sh2
    all {
      if (refused and pc == 0) all {
        rebased' = true, pc' = pc, pend' = pend, locks' = locks, refusedHolder' = refusedHolder, late' = late,
      } else if (refused) all {
        pc' = 4, pend' = false, locks' = noLocks, rebased' = rebased, refusedHolder' = true, late' = late,
      } else if (pc <= 1) all {
        pc' = pc + 1, pend' = false, locks' = locks.set(s, true), rebased' = rebased, refusedHolder' = refusedHolder,
        late' = if (dres == RUNNING and acked.contains(s)) late.union(Set(s)) else late,
      } else all {
        pc' = 3, pend' = false, locks' = noLocks, rebased' = rebased, refusedHolder' = refusedHolder, late' = late,
      },
      delayed' = delayed, reblocked' = reblocked, badCheck' = badCheck, retried' = retried, woundAt' = woundAt,
      keepDdl, keepTimes, keepEnv,
    }
  }
  // HOLD: ロックを持つ取引の x2 の書き込みが、書き込み禁止に当たった。シャードは書き込みを断り、行のロックを取引に与える。
  action holdAtFence = all {
    canHold,
    locks' = locks.set(sh2, true), pc' = pc, pend' = pend, rebased' = rebased,
    keepDdl, keepTimes, keepFlags, keepEnv,
  }
  // WOUND: ロックを持つ取引の文が、開いている試みの書き込み禁止に当たった。Worker が Meta に、その試みを取り消させる。
  // RETRY がなければ、DDL はここで SQLITE_BUSY で失敗する (m24_lock の形)。
  action wound = all {
    canWound,
    meta' = ABORTED,
    dres' = if (RETRY) dres else BUSY,
    dEnd' = if (RETRY) dEnd else now,
    reblocked' = (reblocked or blockers.exists(s => woundAt.contains(s))),
    woundAt' = woundAt.union(blockers),
    dstart' = dstart, cur' = cur, lag' = lag, acked' = acked,
    d0' = d0, tW' = tW, tC' = tC,
    refusedHolder' = refusedHolder, delayed' = delayed, badCheck' = badCheck, retried' = retried, late' = late,
    keepTxn, keepEnv,
  }

  // ---- 進める側 ----
  // RETRY: 取り消された DDL を、新しい試みでやり直す。期限は数え直さない (KEEP_BUDGET)。新しい epoch の prepare を記録し、ok を
  // 集め直す (FRESH_EPOCH)。前の試みの prepare を適用したまま abort をまだ適用していないシャードは、その禁止が残る (lag)。
  action retry = all {
    canRetry,
    meta' = OPEN, dres' = dres,
    dstart' = if (KEEP_BUDGET) dstart else now,
    cur' = SHARDS.mapBy(_ => 0),
    lag' = SHARDS.mapBy(s => lag.get(s) or cur.get(s) == 1),
    acked' = if (FRESH_EPOCH) Set() else acked,
    late' = if (FRESH_EPOCH) Set() else late,
    retried' = true,
    refusedHolder' = refusedHolder, delayed' = delayed, reblocked' = reblocked, badCheck' = badCheck, woundAt' = woundAt,
    keepTxn, keepTimes, keepEnv,
  }
  // 全部のシャードが ok と答えた。期限のうちなら、commit を記録する。
  action commitDdl = all {
    canCommitDdl,
    meta' = COMMITTED, dres' = OK, dEnd' = now,
    badCheck' = (badCheck or late != Set()),
    dstart' = dstart, cur' = cur, lag' = lag, acked' = acked,
    d0' = d0, tW' = tW, tC' = tC,
    refusedHolder' = refusedHolder, delayed' = delayed, reblocked' = reblocked, retried' = retried, woundAt' = woundAt, late' = late,
    keepTxn, keepEnv,
  }
  // 期限が来た。開いている試みを取り消し、DDL は SQLITE_BUSY で失敗する。
  action expire = all {
    canExpire,
    meta' = if (meta == OPEN) ABORTED else meta, dres' = BUSY, dEnd' = now,
    dstart' = dstart, cur' = cur, lag' = lag, acked' = acked,
    d0' = d0, tW' = tW, tC' = tC,
    keepTxn, keepFlags, keepEnv,
  }

  // ---- シャード ----
  // いまの試みの prepare を適用する。ロックがある間は待つ (WAIT_LOCKS)。
  action applyPrep(s: int): bool = all {
    canApplyPrep(s),
    cur' = cur.set(s, 1), meta' = meta, dres' = dres, dstart' = dstart, lag' = lag, acked' = acked,
    keepTxn, keepTimes, keepFlags, keepEnv,
  }
  // 閉じた試みの終わりを適用する。prepare をまだ適用していなければ、prepare と終わりを、待たずに続けて適用する。
  action applyEnd(s: int): bool = all {
    canApplyEnd(s),
    cur' = cur.set(s, 2), meta' = meta, dres' = dres, dstart' = dstart, lag' = lag, acked' = acked,
    keepTxn, keepTimes, keepFlags, keepEnv,
  }
  // 前の試みの abort を適用して、その禁止を解く。
  action applyLag(s: int): bool = all {
    canApplyLag(s),
    lag' = lag.set(s, false), meta' = meta, dres' = dres, dstart' = dstart, cur' = cur, acked' = acked,
    keepTxn, keepTimes, keepFlags, keepEnv,
  }
  // いまの試みの prepare を適用したシャードが、ok と答える (行の確かめは、ここで行う)。
  action ack(s: int): bool = all {
    canAck(s),
    acked' = acked.union(Set(s)), meta' = meta, dres' = dres, dstart' = dstart, cur' = cur, lag' = lag,
    keepTxn, keepTimes, keepFlags, keepEnv,
  }

  action step = any {
    issue, startDdl, tick, exec, holdAtFence, wound, retry, commitDdl, expire,
    { nondet s = oneOf(SHARDS) any { applyPrep(s), applyEnd(s), applyLag(s), ack(s) } },
  }

  // ---- 不変条件 -------------------------------------------------------------
  def D0: int = d0 + B
  /** 取引は、DDL の期限のあいだずっとロックを持っていた (x1 を d0 より前の刻みに送り、COMMIT を期限の刻みまでに送っていない)。 */
  def heldThrough: bool = tW >= 0 and tW < d0 and not(tC >= 0 and tC <= D0)
  /** 取引は、期限のうちにロックを放した (x1 を d0 より後の刻みに送ったか送っていない、または COMMIT を期限より前の刻みに送った)。 */
  def releasedInTime: bool = not(tW >= 0 and tW <= d0) or (tC >= 0 and tC < D0)
  val asSqlite = d0 < 0 or and {
    dres != BUSY or (dEnd >= D0 and not(releasedInTime)),
    dres != OK or not(heldThrough),
    not(dres == RUNNING and now > D0),
  }
  val holderSurvives = not(refusedHolder)
  val txnNotRefused = pc != 4
  val holderNotDelayed = not(delayed)
  val noReblock = not(reblocked)
  val checkSawRows = not(badCheck)
  val retrySafe = and { asSqlite, holderSurvives, txnNotRefused, holderNotDelayed, noReblock, checkSawRows }

  // ---- witness (時刻は競りのないものだけ。置き場所ごとに、確定と SQLITE_BUSY) ----
  def strictHolder: bool = tW >= 0 and tW < d0
  // 行が 2 つのシャードにある。取引が DDL を取り消させ、進める側がやり直し、取引が期限より前に確定して、DDL が確定する
  val witnessWoundRetryCommit = not(sh1 != sh2 and woundAt != Set() and retried and strictHolder and tC > d0 and tC < D0
                                    and dres == OK and pc == 3)
  // 同じく、取引が期限を過ぎてロックを持ち続け、やり直した DDL が期限に SQLITE_BUSY で失敗し、取引はその後で確定する
  val witnessSplitBusy = not(sh1 != sh2 and retried and strictHolder and tC > D0 and dres == BUSY and pc == 3)
  // 行が 1 つのシャードにある。DDL は取引を待ち、取引が期限より前に確定して、DDL が確定する
  val witnessSameCommit = not(sh1 == sh2 and strictHolder and tC > d0 and tC < D0 and dres == OK and pc == 3)
  // 同じく、取引が期限を過ぎてロックを持ち続け、DDL が期限に SQLITE_BUSY で失敗する
  val witnessSameBusy = not(sh1 == sh2 and strictHolder and tC > D0 and dres == BUSY and pc == 3)

  // ---- 活性 -----------------------------------------------------------------
  // 内部の手と刻みに、弱い公平性を置く (送られた文の実行も弱い公平性。強くすると、HOLD がないときの繰り返しが隠れる)。
  // 利用者の手 (文を送る、DDL を始める) には置かない。
  val vars = (now, sh1, sh2, meta, dres, dstart, cur, lag, acked, pc, pend, locks, rebased, d0, dEnd, tW, tC,
              refusedHolder, delayed, reblocked, badCheck, retried, woundAt, late)
  temporal fairness = and {
    weakFair(exec, vars), weakFair(holdAtFence, vars), weakFair(wound, vars), weakFair(retry, vars),
    weakFair(commitDdl, vars), weakFair(expire, vars), weakFair(tick, vars),
    weakFair(applyPrep(P), vars), weakFair(applyPrep(Q), vars), weakFair(applyEnd(P), vars), weakFair(applyEnd(Q), vars),
    weakFair(applyLag(P), vars), weakFair(applyLag(Q), vars), weakFair(ack(P), vars), weakFair(ack(Q), vars),
  }
  // 始めた DDL は、いつか終わる
  temporal ddlTerminates = fairness implies always((d0 >= 0 and dres == RUNNING) implies eventually(dres != RUNNING))
  // 時刻は、いつか上限まで進む (内部の手が、同じ刻みの中で限りなく続かない)
  temporal timeAdvances = fairness implies eventually(now == MAXT)
  // 送られた文は、いつか答えを得る
  temporal stmtCompletes = fairness implies always(pend implies eventually(not(pend)))
  temporal retryLive = fairness implies and {
    always((d0 >= 0 and dres == RUNNING) implies eventually(dres != RUNNING)),
    eventually(now == MAXT),
    always(pend implies eventually(not(pend))),
  }
}

// 決めた設計。行が 2 つのシャードにあり、x2 の書き込みが Q の書き込み禁止に当たる。取引は Q のロックを取り、DDL を取り消させ、
// 進める側がやり直す。やり直しの prepare は、P と Q で取引のロックを待ち、取引の COMMIT の後で確定する。
module m24_retry_green {
  import m24_retry_core(WAIT_LOCKS = true, WOUND = true, HOLD = true, RETRY = true, KEEP_BUDGET = true, FRESH_EPOCH = true,
    SAME_SHARD = false).*
  run woundRetryTest =
    initWith(P, Q).then(issue).then(exec).then(tick)
        .then(startDdl).then(applyPrep(Q)).then(ack(Q))
        .expect(not(canApplyPrep(P)) and not(urgent))
        .then(issue).then(holdAtFence).then(wound).then(retry).then(applyLag(Q))
        .expect(not(canApplyPrep(Q)) and canExec)
        .then(exec).then(tick).then(issue).then(exec)
        .then(applyPrep(P)).then(applyPrep(Q)).then(ack(P)).then(ack(Q)).then(commitDdl)
        .expect(retrySafe and dres == OK and pc == 3 and retried and dEnd == 2)
  // 同じ置き場所で、取引が期限を過ぎてロックを持ち続ける。DDL は期限に SQLITE_BUSY で失敗し、取引はその後で確定する。
  run busyTest =
    initWith(P, Q).then(issue).then(exec).then(tick)
        .then(startDdl).then(applyPrep(Q)).then(ack(Q))
        .then(issue).then(holdAtFence).then(wound).then(retry).then(applyLag(Q)).then(exec)
        .then(tick).then(tick)
        .expect(canExpire and urgent)
        .then(expire).then(applyEnd(P)).then(applyEnd(Q)).then(tick).then(issue).then(exec)
        .expect(retrySafe and dres == BUSY and dEnd == 3 and pc == 3)
}
// RETRY がない (m24_lock の形)。取り消された DDL は、期限より前に SQLITE_BUSY で失敗する。行が 1 つのシャードにあれば、同じ時刻の
// 並びで、DDL は待って確定する。
module m24_retry_red_no_retry {
  import m24_retry_core(WAIT_LOCKS = true, WOUND = true, HOLD = true, RETRY = false, KEEP_BUDGET = true, FRESH_EPOCH = true,
    SAME_SHARD = false).*
  run noRetryTest =
    initWith(P, Q).then(issue).then(exec).then(tick)
        .then(startDdl).then(applyPrep(Q)).then(ack(Q))
        .then(issue).then(holdAtFence).then(wound)
        .expect(dres == BUSY and dEnd == 1 and not(asSqlite))
}
// 同じ形 (RETRY がない) で、行を 1 つのシャードに置く。取引は禁止に当たらず、DDL は待って、SQLite と同じ結果になる。
// m24_retry_red_no_retry と合わせて、やり直さない形の成否が、行の置き場所で決まることを示す。
module m24_retry_no_retry_same {
  import m24_retry_core(WAIT_LOCKS = true, WOUND = true, HOLD = true, RETRY = false, KEEP_BUDGET = true, FRESH_EPOCH = true,
    SAME_SHARD = true).*
  run sameShardTest =
    initWith(P, P).then(issue).then(exec).then(tick)
        .then(startDdl).then(applyPrep(Q)).then(ack(Q))
        .then(issue).then(exec)
        .expect(not(urgent) and dres == RUNNING)
        .then(tick).then(issue).then(exec)
        .then(applyPrep(P)).then(ack(P)).then(commitDdl)
        .expect(retrySafe and dres == OK and dEnd == 2)
}
// やり直すたびに、期限を数え直す。DDL は、最初の期限を過ぎても終わらず、SQLite なら SQLITE_BUSY になる DDL が確定し得る。
module m24_retry_red_restart {
  import m24_retry_core(WAIT_LOCKS = true, WOUND = true, HOLD = true, RETRY = true, KEEP_BUDGET = false, FRESH_EPOCH = true,
    SAME_SHARD = false).*
  run restartTest =
    initWith(P, Q).then(issue).then(exec).then(tick)
        .then(startDdl).then(applyPrep(Q)).then(ack(Q)).then(tick)
        .then(issue).then(holdAtFence).then(wound).then(retry).then(applyLag(Q)).then(exec)
        .then(tick).then(tick)
        .expect(dres == RUNNING and now == 4 and not(asSqlite))
}
// やり直しが、取り消された試みと同じ prepare の epoch を使う。Q の、取引の x2 より前の ok が、やり直しの commit に数えられる。
module m24_retry_red_same_epoch {
  import m24_retry_core(WAIT_LOCKS = true, WOUND = true, HOLD = true, RETRY = true, KEEP_BUDGET = true, FRESH_EPOCH = false,
    SAME_SHARD = false).*
  run sameEpochTest =
    initWith(P, Q).then(issue).then(exec).then(tick)
        .then(startDdl).then(applyPrep(Q)).then(ack(Q))
        .then(issue).then(holdAtFence).then(wound).then(retry).then(applyLag(Q)).then(exec)
        .expect(late == Set(Q))
        .then(issue).then(exec).then(applyPrep(P)).then(ack(P)).then(commitDdl)
        .expect(dres == OK and not(checkSawRows))
}
// 禁止に当たった取引に、シャードがロックを与えない。取り消しの後で、Q が、取引の書き込みより先に、やり直しの prepare を適用し、
// 取引はまた禁止に当たる。取り消しとやり直しが、同じ刻みの中で繰り返す。
module m24_retry_red_no_hold {
  import m24_retry_core(WAIT_LOCKS = true, WOUND = true, HOLD = false, RETRY = true, KEEP_BUDGET = true, FRESH_EPOCH = true,
    SAME_SHARD = false).*
  run noHoldTest =
    initWith(P, Q).then(issue).then(exec).then(tick)
        .then(startDdl).then(applyPrep(Q)).then(ack(Q))
        .then(issue).then(wound).then(retry).then(applyLag(Q)).then(applyPrep(Q)).then(wound)
        .expect(not(noReblock) and now == 1)
}
// prepare が行ロックを待たない。DDL が、取引のロックがあるまま確定し、取引の x2 の書き込みが古い計画として断られる。
module m24_retry_red_no_wait {
  import m24_retry_core(WAIT_LOCKS = false, WOUND = true, HOLD = true, RETRY = true, KEEP_BUDGET = true, FRESH_EPOCH = true,
    SAME_SHARD = false).*
  run noWaitTest =
    initWith(P, Q).then(issue).then(exec).then(tick)
        .then(startDdl).then(applyPrep(P)).then(applyPrep(Q)).then(ack(P)).then(ack(Q)).then(commitDdl)
        .then(applyEnd(P)).then(applyEnd(Q)).then(issue).then(exec)
        .expect(not(holderSurvives) and pc == 4)
}
// 取引が DDL を取り消させない。x2 は Q の禁止で待ち、P は取引のロックを待つ。どちらも進まず、取引の文が、期限まで時刻をまたいで待つ。
module m24_retry_red_no_wound {
  import m24_retry_core(WAIT_LOCKS = true, WOUND = false, HOLD = true, RETRY = true, KEEP_BUDGET = true, FRESH_EPOCH = true,
    SAME_SHARD = false).*
  run noWoundTest =
    initWith(P, Q).then(issue).then(exec).then(tick)
        .then(startDdl).then(applyPrep(Q)).then(ack(Q))
        .then(issue).then(holdAtFence).then(tick)
        .expect(not(holderNotDelayed))
}

// ---- 取引の中の DDL の順序 (M13 を表ごとにしたもの) -------------------------------------
//
// M13 (specs/m13_txn_schema_boundary.qnt) の本体を写し、別の接続の DDL が、区切りの文の表に触るか (rel) を足した。シャードは、区切りの
// 書き込みが名乗る版を、区切りの表に触った最後の DDL の版と比べる (PER_TABLE。false なら M13 と同じく、すべての DDL の版と比べる)。
// 接続自身の DDL は、後の区切りの表に触るものとして数える (後の区切りは、その DDL の後で計画するので、どちらでも同じである)。
// invariant は M13 の boundarySafe と、noRefusalUnrelated (区切りの表に触る DDL がないのに、版の理由で断られない)。
module m24_boundary_core {
  const IMPLICIT_COMMIT: bool            // DDL は、開いている取引を先に確定してから実行する
  const PIN: bool                        // 取引は、最初に触ったときの版を確定まで名乗る
  const RETRY_WHOLE: bool                // 断られたら、文の並びの頭からやり直す
  const DDL_DESPITE_FAILED_COMMIT: bool  // 先に確定するのに失敗しても、DDL を実行する
  const PER_TABLE: bool                  // シャードは、区切りの表に触った DDL の版とだけ比べる

  pure val SCRIPT: List[str] = ["W", "D", "W", "D", "W", "C"]
  pure val N = SCRIPT.length()
  pure val EFFECTFUL: List[int] = range(0, N).select(i => SCRIPT[i] != "C")

  var pc: int
  var meta: int                  // Meta の版
  var metaRel: int               // 区切りの表に触った、最後の DDL の後の版
  var segVer: int
  var segStart: int
  var buffer: Set[(int, int)]
  var lastOwn: int
  var effects: List[int]
  var otherDone: bool
  var otherMid: bool             // 別の接続の DDL が、書き込みを溜めた区切りの途中に入った
  var otherRel: bool             // 別の接続の DDL が、区切りの表に触った
  var retries: int
  var status: str
  var badPin: bool
  var ownInvisible: bool
  var refusedUnrelated: bool     // ghost: 区切りの表に触る DDL がないのに、版の理由で断られた

  pure def appendOps(l: List[int], ops: Set[int]): List[int] =
    range(0, N).foldl(l, (acc, i) => if (ops.contains(i)) acc.append(i) else acc)
  pure def isPrefix(a: List[int], b: List[int]): bool =
    a.length() <= b.length() and range(0, a.length()).foldl(true, (ok, i) => ok and a[i] == b[i])

  action init = all {
    pc' = 0, meta' = 0, metaRel' = 0, segVer' = -1, segStart' = 0, buffer' = Set(), lastOwn' = 0, effects' = List(),
    otherDone' = false, otherMid' = false, otherRel' = false, retries' = 0, status' = "running", badPin' = false, ownInvisible' = false,
    refusedUnrelated' = false,
  }

  /** シャードが比べる版。 */
  def cmp: int = if (PER_TABLE) metaRel else meta
  /** 版の理由の拒否が、区切りの表に触る DDL のないものか。 */
  def unrelatedRefusal(v: int): bool = v >= metaRel

  action keepOther = all { otherDone' = otherDone, otherMid' = otherMid, otherRel' = otherRel }
  action keepGhost = all { badPin' = badPin, ownInvisible' = ownInvisible, keepOther }

  def accepts(conflict: bool): bool = not(conflict) and (buffer == Set() or segVer >= cmp)

  action abortSegment = all {
    buffer' = Set(), segVer' = -1,
    if (retries < 1) all {
      retries' = retries + 1,
      pc' = if (RETRY_WHOLE) 0 else segStart,
      segStart' = if (RETRY_WHOLE) 0 else segStart,
      status' = status,
    } else all { retries' = retries, pc' = pc, segStart' = segStart, status' = "failed" },
  }

  action write: bool = all {
    status == "running", pc < N, SCRIPT[pc] == "W",
    val v = if (segVer < 0) meta else segVer
    if (v < lastOwn)
      all {
        status' = "failed", ownInvisible' = true,
        pc' = pc, meta' = meta, metaRel' = metaRel, segVer' = segVer, segStart' = segStart, buffer' = buffer, lastOwn' = lastOwn,
        effects' = effects, keepOther, retries' = retries, badPin' = badPin, refusedUnrelated' = refusedUnrelated,
      }
    else if (v < cmp)
      all {
        abortSegment, meta' = meta, metaRel' = metaRel, lastOwn' = lastOwn, effects' = effects, keepGhost,
        refusedUnrelated' = (refusedUnrelated or unrelatedRefusal(v)),
      }
    else all {
      buffer' = buffer.union(Set((pc, v))), segVer' = v, pc' = pc + 1,
      meta' = meta, metaRel' = metaRel, segStart' = segStart, lastOwn' = lastOwn, effects' = effects, retries' = retries,
      status' = status, keepGhost, refusedUnrelated' = refusedUnrelated,
    }
  }

  action repin: bool = all {
    not(PIN), status == "running", segVer >= 0, segVer < meta,
    segVer' = meta,
    pc' = pc, meta' = meta, metaRel' = metaRel, segStart' = segStart, buffer' = buffer, lastOwn' = lastOwn, effects' = effects,
    retries' = retries, status' = status, keepGhost, refusedUnrelated' = refusedUnrelated,
  }

  action ddl(conflict: bool): bool = all {
    status == "running", pc < N, SCRIPT[pc] == "D",
    if (IMPLICIT_COMMIT and buffer != Set() and not(accepts(conflict)))
      if (DDL_DESPITE_FAILED_COMMIT) all {
        meta' = meta + 1, metaRel' = meta + 1, lastOwn' = meta + 1, effects' = effects.append(pc),
        buffer' = Set(), segVer' = -1, segStart' = pc + 1, pc' = pc + 1, retries' = retries, status' = status, keepGhost,
        refusedUnrelated' = (refusedUnrelated or (not(conflict) and unrelatedRefusal(segVer))),
      } else all {
        abortSegment, meta' = meta, metaRel' = metaRel, lastOwn' = lastOwn, effects' = effects, keepGhost,
        refusedUnrelated' = (refusedUnrelated or (not(conflict) and unrelatedRefusal(segVer))),
      }
    else all {
      meta' = meta + 1, metaRel' = meta + 1, lastOwn' = meta + 1,
      effects' = (if (IMPLICIT_COMMIT) appendOps(effects, buffer.map(b => b._1)) else effects).append(pc),
      buffer' = if (IMPLICIT_COMMIT) Set() else buffer,
      segVer' = if (IMPLICIT_COMMIT) -1 else segVer,
      segStart' = if (IMPLICIT_COMMIT) pc + 1 else segStart,
      pc' = pc + 1,
      badPin' = (badPin or (IMPLICIT_COMMIT and buffer.exists(b => b._2 != segVer))),
      retries' = retries, status' = status, ownInvisible' = ownInvisible, keepOther, refusedUnrelated' = refusedUnrelated,
    }
  }

  action commit(conflict: bool): bool = all {
    status == "running", pc < N, SCRIPT[pc] == "C",
    if (accepts(conflict)) all {
      effects' = appendOps(effects, buffer.map(b => b._1)),
      badPin' = (badPin or buffer.exists(b => b._2 != segVer)),
      status' = "ok", pc' = N, buffer' = Set(), segVer' = -1,
      meta' = meta, metaRel' = metaRel, lastOwn' = lastOwn, segStart' = segStart, retries' = retries, ownInvisible' = ownInvisible,
      keepOther, refusedUnrelated' = refusedUnrelated,
    } else all {
      abortSegment, meta' = meta, metaRel' = metaRel, lastOwn' = lastOwn, effects' = effects, keepGhost,
      refusedUnrelated' = (refusedUnrelated or (not(conflict) and unrelatedRefusal(segVer))),
    }
  }

  /** 別の接続の DDL。rel なら、区切りの表に触る。 */
  action otherDdl(rel: bool): bool = all {
    not(otherDone),
    meta' = meta + 1, metaRel' = if (rel) meta + 1 else metaRel,
    otherDone' = true, otherRel' = rel, otherMid' = buffer != Set(),
    pc' = pc, segVer' = segVer, segStart' = segStart, buffer' = buffer, lastOwn' = lastOwn, effects' = effects,
    retries' = retries, status' = status, badPin' = badPin, ownInvisible' = ownInvisible, refusedUnrelated' = refusedUnrelated,
  }

  action step = any {
    write,
    repin,
    { nondet x = oneOf(Set(true, false)) ddl(x) },
    { nondet x = oneOf(Set(true, false)) commit(x) },
    { nondet x = oneOf(Set(true, false)) otherDdl(x) },
  }

  val prefixOfScript = isPrefix(effects, EFFECTFUL)
  val pinned = not(badPin)
  val ownDdlVisible = not(ownInvisible)
  val completeWhenOk = status != "ok" or effects == EFFECTFUL
  val boundarySafe = prefixOfScript and pinned and ownDdlVisible and completeWhenOk
  val noRefusalUnrelated = not(refusedUnrelated)
  val boundarySafeAll = boundarySafe and noRefusalUnrelated

  val witnessRetriedAndDone = not(status == "ok" and retries == 1)
  val witnessOtherDdlThenDone = not(status == "ok" and otherDone)
  // 別の接続の、区切りの表に触らない DDL が、書き込みを溜めた区切りの途中に入っても、やり直さずに終わる
  val witnessUnrelatedNoRetry = not(status == "ok" and otherMid and not(otherRel) and retries == 0)
}

module m24_boundary_green {
  import m24_boundary_core(IMPLICIT_COMMIT = true, PIN = true, RETRY_WHOLE = false, DDL_DESPITE_FAILED_COMMIT = false, PER_TABLE = true).*
  run unrelatedTest =
    init.then(write).then(otherDdl(false)).then(ddl(false)).then(write).then(ddl(false)).then(write).then(commit(false))
        .expect(status == "ok" and retries == 0 and boundarySafeAll)
  run relatedTest =
    init.then(write).then(otherDdl(true)).then(ddl(false))
        .expect(retries == 1 and pc == 0 and boundarySafeAll)
}
// M13 の赤を、表ごとの比べ方の上でも確かめる。
module m24_boundary_red_main {
  import m24_boundary_core(IMPLICIT_COMMIT = false, PIN = false, RETRY_WHOLE = false, DDL_DESPITE_FAILED_COMMIT = false, PER_TABLE = true).*
}
module m24_boundary_red_pin_only {
  import m24_boundary_core(IMPLICIT_COMMIT = false, PIN = true, RETRY_WHOLE = false, DDL_DESPITE_FAILED_COMMIT = false, PER_TABLE = true).*
}
module m24_boundary_red_repin {
  import m24_boundary_core(IMPLICIT_COMMIT = true, PIN = false, RETRY_WHOLE = false, DDL_DESPITE_FAILED_COMMIT = false, PER_TABLE = true).*
}
module m24_boundary_red_retry_whole {
  import m24_boundary_core(IMPLICIT_COMMIT = true, PIN = true, RETRY_WHOLE = true, DDL_DESPITE_FAILED_COMMIT = false, PER_TABLE = true).*
}
module m24_boundary_red_ddl_anyway {
  import m24_boundary_core(IMPLICIT_COMMIT = true, PIN = true, RETRY_WHOLE = false, DDL_DESPITE_FAILED_COMMIT = true, PER_TABLE = true).*
}
// M13 と段 3 の実装: すべての DDL の版と比べる。関係のない DDL の後で、区切りがやり直しになる。
module m24_boundary_red_global {
  import m24_boundary_core(IMPLICIT_COMMIT = true, PIN = true, RETRY_WHOLE = false, DDL_DESPITE_FAILED_COMMIT = false, PER_TABLE = false).*
  run globalTest =
    init.then(write).then(otherDdl(false)).then(ddl(false))
        .expect(not(noRefusalUnrelated) and retries == 1)
}
