// M21: CatalogEpoch。Meta の 5 つの版と排他を、1 本の epoch の列と、2 相の遷移 1 種類にまとめる
//
// 実装より先に書いたモデルで、対応する実装はまだない (docs/design-catalog-epoch.md)。いまの Meta は、DDL の版と事後の取り消し
// (revokeDdl と逆操作の SQL)、シャードをまたぐ UNIQUE の index を作る間の書き込み禁止 (M12)、DROP の前の書き込み禁止 (M14)、
// 分割と DDL の枠 (M15)、範囲表の版を、別々に持っている。
//
// 設計: Meta は追記だけの列を持つ。1 行が 1 つの epoch で、記録は 5 種類である。
//   prepare(op)   表定義の遷移を開く。対象の表を書き込み禁止にする
//   commit(op)    遷移を確定する。全シャードが prepare を適用し、確かめに通った後でだけ記録する
//   abort(op)     遷移を取り消す。禁止を解くだけで、利用者の表に触る文を持たない
//   start         範囲の移動を開く。その区間の宛先は、この epoch から子である
//   end           範囲の移動を閉じる
// モデルでは、op ごとに prepare、commit、abort の epoch を持つ。移動 (SPLIT) は start を prepare の欄、end を commit の欄に
// 置く。表定義の遷移も移動も、同じ 3 つの欄で、開いているか、どちらで終わったかを引く。
//
// シャードは、列を先頭から順に適用する (ep)。表定義の記録を適用する前に、持っている intent を決着させる。移動の記録は待たずに
// 適用する。親にとって、start を適用したことが fence である。
//
// 要求は、Worker のスナップショットの epoch (pe) と、その中で表定義が最後に変わった epoch (ps) を運ぶ。シャードは、ps が
// 自分のもの (sv) と等しいことを確かめ、所有は自分のスナップショットで引く。範囲表だけが進んだ epoch は、ps を古くしない。
//
// 場面は 4 つの操作で、定数で選ぶ。行は 2 個 (行 1 はシャード P、行 2 はシャード Q)。値は 1、2、値なし (0)。
//   BUILD  CREATE UNIQUE INDEX (シャードをまたぐ)。prepare の間に、止まった行を読んで項目を埋める (M12 の形)
//   CHECK  行で失敗し得る DDL。「値が 2 の行があれば失敗する」制約で表す (既存の行が CHECK に反する ADD COLUMN、
//          重複のある列へのシャード内の UNIQUE index)。各シャードが、prepare の間に、巻き戻す取引の中で試す
//   DROP   DROP TABLE。行を写した取引 (copy) が読んだ後の書き込みがないことを、prepare の間に確かめる (M14 の形)
//   SPLIT  行 1 の区間を、P から新しいシャード C へ移す
//
// 取引は 1 行の値を書き換える。文の実行 (plan)、シャードでの受け付け (prepare。intent を置く)、確定 (commit) の 3 段。
// RECHECK を外したインスタンスでは、受け付けの前に、版だけを確かめる段 (enter) が入る (行ロックや intent の決着を待つ前の確認)。
//
// invariant は、M11 から M15 のものを写したもの (どれがどれかは specs/README.md の M21 の表) と、この設計で新しく要るものである。
//   commitApplies     記録した commit は、どのシャードでも適用できる (取り消しの代わり)
//   noServeBelowAck   シャードは、自分が ok と答えた prepare より古い表定義の計画を受けない
//   servable          Meta の最新の epoch で計画した要求を、その epoch の持ち主が、版や所有の理由で断らない
//                     (M15 の servable と、未解決の問題 17)
//   pinnedSurvives    表定義が同じで、自分が持ち主である要求を、シャードは epoch が古いという理由で断らない
module m21_core {
  // ---- 場面 ----
  const HAS_BUILD: bool
  const HAS_CHECK: bool
  const HAS_DROP: bool
  const HAS_SPLIT: bool
  const NTXN: int
  const FIXED_INIT: bool       // 最初の値を 1、1 に固定する (状態を減らす)

  // ---- 設計の条件。赤は 1 つずつ外す ----
  const REJECT_STALE: bool     // シャードは、自分より古い表定義で計画された要求を断る
  const RECHECK: bool          // シャードは、待ちの後で、版と所有を確かめ直す
  const FENCE: bool            // prepare を適用したシャードは、対象の表への書き込みを断る
  const DRAIN: bool            // シャードは、表定義の記録を適用する前に、intent を決着させる
  const CHECK_AT_EPOCH: bool   // 試適用、行の走査、変更の確認は、そのシャードが prepare を適用した後で行う
  const GUARD_CHECK: bool      // DROP の prepare は、copy が読んだ後の変更を確かめる
  const ALL_ACKS: bool         // commit は、全シャードが ok と答えた後でだけ記録する
  const ONE_EXIT: bool         // commit は、その遷移が開いているときだけ記録する
  const ONE_OPEN: bool         // 表定義の遷移は、同時に 1 つしか開かない
  const PIN: bool              // 取引は、計画し直さずに、新しい表定義の epoch を名乗らない
  const BUILD_VISIBLE: bool    // (外すと true) 作っている最中の index を、計画が使う
  const DDL_WAITS_MOVE: bool   // 移動が開いている間、表定義の遷移を開かない
  const MOVE_WAITS_DDL: bool   // 表定義の遷移が開いている間、移動を開かない
  const END_AFTER_DRAIN: bool  // end は、子が受け取り終えた後でだけ記録する
  const PULL_AT_EPOCH: bool    // pull は start の epoch を運び、親は適用してから答える
  const FENCE_IS_EPOCH: bool   // 親の fence は「start を適用したこと」である (false はいまの実装: 親が先に fence し、範囲表は後で切り替わる)
  const OWNER_CHECK: int       // 0 設計どおり。1 epoch が等しいことを求める。2 所有をスナップショットで引かない
  // ---- 設計の選択肢 ----
  const SCHEMA_ON_PREPARE: bool // 表定義の epoch は、prepare と abort でも進む (false なら、commit だけで進む)

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
  pure val DDLS = Set(1, 2, 3)
  pure val OPS = Set(1, 2, 3, 4)
  pure val MAXE = 9                       // epoch の上限 (どのインスタンスでも届かない)

  pure val NO_INDEX = 0
  pure val BUILDING = 1
  pure val PUBLIC = 2

  // phase: 0 未使用、1 文を実行した、2 受け付けられた (intent がある)、3 終わった
  // pe は計画に使ったスナップショットの epoch、ps は取引が名乗る表定義の epoch、ce は要求が運ぶ epoch。
  type Txn = { phase: int, row: int, old: int, new: int, pe: int, ps: int, ce: int, dest: int, maintain: bool, seen: int, entered: bool, ok: bool }
  pure val idle: Txn = { phase: 0, row: 0, old: 0, new: 0, pe: 0, ps: 0, ce: 0, dest: 0, maintain: false, seen: 0, entered: false, ok: false }
  pure val done: Txn = { phase: 3, row: 0, old: 0, new: 0, pe: 0, ps: 0, ce: 0, dest: 0, maintain: false, seen: 0, entered: false, ok: false }

  type Ghost = {
    wroteFenced: bool,      // 書き込み禁止の epoch にいるシャードで、書き込みが確定した
    relied: bool,           // 出来上がっていない index を、文が使った
    refusedByFence: bool,   // シャードが、書き込み禁止を理由に断った (witness 用)
    stuck: bool,            // シャードが、記録された commit を適用できなかった
    wroteAfterDrop: bool,   // DROP の commit が記録された後で、その表への書き込みが確定した
    resurrected: bool,      // DROP を適用したシャードに、書き込みが適用された
    badPin: bool,           // 取引が、計画に使っていない表定義の epoch を名乗って受け付けられた
    belowAck: bool,         // シャードが、ok と答えた prepare より古い表定義の計画を受けた
    refusedLatest: bool,    // 最新の epoch で計画した要求を、持ち主が版か所有の理由で断った
    refusedUnmoved: bool,   // 表定義が同じで、自分が持ち主である要求を断った
    acceptedOlder: bool,    // 自分より古い epoch の要求を受けた (witness 用)
    badRead: bool,          // 答えた読みが、確定した最新の値と違う
    shapeMismatch: bool,    // 行を運んだときに、親と子の表定義が違った
    uncutRead: bool,        // 親が、start を適用した後で、まだ渡していない行の読みに答えた (witness 用)
  }
  pure val clean: Ghost = {
    wroteFenced: false, relied: false, refusedByFence: false, stuck: false, wroteAfterDrop: false, resurrected: false,
    badPin: false, belowAck: false, refusedLatest: false, refusedUnmoved: false, acceptedOlder: false, badRead: false, shapeMismatch: false, uncutRead: false,
  }

  // ---- Meta ----
  var len: int                  // 最新の epoch
  var prepE: int -> int         // op -> prepare (SPLIT は start) の epoch。0 はまだ
  var commitE: int -> int       // op -> commit (SPLIT は end) の epoch
  var abortE: int -> int        // op -> abort の epoch
  // ---- 遷移を進める側 ----
  var acks: int -> Set[int]     // op -> ok と答えたシャード
  var dead: int -> bool         // op -> 進める側が止まった
  // ---- シャード ----
  var ep: int -> int            // シャード -> 適用した epoch
  var store: int -> int         // シャード -> 持っている行の値 (P と C は行 1、Q は行 2)
  var truth: int -> int         // 行 -> 確定した最新の値
  var idx: int -> int           // 値 -> その値を持つ行 (0 = 項目なし)
  var txns: int -> Txn
  // ---- DROP の場面 ----
  var copied: bool              // copy の区切りが、表を読んで確定した
  var late: int -> bool         // シャード -> copy の後で、書き込みが確定した
  // ---- 移動 ----
  var pulled: bool              // 行 1 が子に届いた
  var drained: bool             // 子が受け取り終えた (親の時計を受け取り、移動の記録を閉じた)
  var pfenced: bool             // いまの実装の fence (範囲表の切り替えより前に、親が手元で付ける印)
  var g: Ghost

  pure def max(a: int, b: int): int = if (a > b) a else b
  pure def cap(x: int, e: int): int = if (x <= e) x else 0
  pure def within(x: int, e: int): bool = x >= 1 and x <= e
  pure def has(op: int): bool =
    if (op == BUILD) HAS_BUILD else if (op == CHECK) HAS_CHECK else if (op == DROP) HAS_DROP else HAS_SPLIT
  pure val noEntries: int -> int = VALS.mapBy(_ => 0)

  // ---- スナップショット (epoch e まで畳んだもの) ----
  def openAt(op: int, e: int): bool =
    within(prepE.get(op), e) and not(within(commitE.get(op), e)) and not(within(abortE.get(op), e))
  /**
   * 表定義の epoch。取引が名乗り、シャードが比べる。決めた設計では、表定義の記録 (prepare、commit、abort) のどれでも進む。
   * 別の案 (SCHEMA_ON_PREPARE = false) では、commit だけで進む。prepare と abort は、表定義の中身を変えないからである。
   */
  def schemaAt(e: int): int =
    DDLS.fold(0, (m, op) => max(m, max(cap(commitE.get(op), e),
      if (SCHEMA_ON_PREPARE) max(cap(prepE.get(op), e), cap(abortE.get(op), e)) else 0)))
  def isSchemaEpoch(e: int): bool = DDLS.exists(op => prepE.get(op) == e or commitE.get(op) == e or abortE.get(op) == e)
  /** 表が書き込み禁止か。開いている表定義の遷移がある。 */
  def fencedAt(e: int): bool = DDLS.exists(op => openAt(op, e))
  def indexAt(e: int): int =
    if (within(commitE.get(BUILD), e)) PUBLIC else if (openAt(BUILD, e)) BUILDING else NO_INDEX
  def checkOnAt(e: int): bool = within(commitE.get(CHECK), e)
  def droppedAt(e: int): bool = within(commitE.get(DROP), e)
  def movedAt(e: int): bool = within(prepE.get(SPLIT), e)
  def ownerAt(e: int, r: int): int = if (r == 2) Q else if (movedAt(e)) C else P
  def shardsAt(e: int): Set[int] = if (movedAt(e)) Set(P, Q, C) else Set(P, Q)
  def moveOpen: bool = prepE.get(SPLIT) > 0 and commitE.get(SPLIT) == 0
  def ddlOpen: bool = DDLS.exists(op => openAt(op, len))

  // ---- シャードから見えるもの ----
  def sv(s: int): int = schemaAt(ep.get(s))
  def noIntents(s: int): bool = TXNS.forall(t => not(txns.get(t).phase == 2 and txns.get(t).dest == s))
  /** シャードが持っている行の値。親は、渡した行の控えを数えない。 */
  def heldVal(s: int): int = if (s == P and pulled) 0 else store.get(s)
  pure def rowHeld(s: int): int = if (s == Q) 2 else 1
  /** 行の持ち主が持つ値。 */
  def lv(r: int): int = if (r == 2) store.get(Q) else if (pulled) store.get(C) else store.get(P)
  /** 移動の途中のシャード。運ぶ行と intent の形が変わらないように、表定義の記録を適用しない (M15)。 */
  def movingNow(s: int): bool =
    (s == P or s == C) and not(drained) and (movedAt(ep.get(s)) or (s == P and pfenced))
  /** 次の記録を適用できない。待っても適用できないので、要求を断ることになる。 */
  def blockedApply(s: int): bool = ep.get(s) < len and isSchemaEpoch(ep.get(s) + 1) and movingNow(s)

  /** 設計どおりの所有。自分のスナップショットで、行 r の書き込みの宛先が自分か。 */
  def ownsDesign(s: int, r: int): bool =
    if (r == 2) s == Q
    else (s == P and not(movedAt(ep.get(P))) and not(pfenced)) or (s == C and movedAt(ep.get(C)))
  /** 読みは、親がまだ渡していない行にも答える (M19)。いまの実装の fence は、読みも断る。 */
  def holdsDesign(s: int, r: int): bool =
    ownsDesign(s, r) or (s == P and r == 1 and not(pulled) and not(pfenced))
  def mine(s: int, r: int, forRead: bool): bool =
    if (OWNER_CHECK == 2) (if (r == 2) s == Q else (s == P or s == C))
    else if (forRead) holdsDesign(s, r) else ownsDesign(s, r)

  /**
   * シャード s が、行 r の要求 (運ぶ epoch は ce、名乗る表定義の epoch は ps) を受けるか。
   * 0 受ける、1 先に列を適用する (待つ)、2 断る (古い計画か、持ち主でない)、3 適用できないので断る。
   */
  def gate(s: int, r: int, ce: int, ps: int, forRead: bool): int = {
    val behind = ps > sv(s) or (ce > ep.get(s) and (OWNER_CHECK == 1 or not(mine(s, r, forRead))))
    if (behind) (if (blockedApply(s)) 3 else 1)
    else if ((REJECT_STALE and ps < sv(s)) or not(mine(s, r, forRead)) or (OWNER_CHECK == 1 and ce < ep.get(s))) 2
    else 0
  }
  /** 断られた要求が、設計では受けられるものだった (表定義が同じで、自分が持ち主)。 */
  def wronglyRefused(s: int, r: int, ps: int, forRead: bool): bool =
    ps == sv(s) and (if (forRead) holdsDesign(s, r) else ownsDesign(s, r))

  action initWith(a: int, b: int): bool = all {
    len' = 0, prepE' = OPS.mapBy(_ => 0), commitE' = OPS.mapBy(_ => 0), abortE' = OPS.mapBy(_ => 0),
    acks' = OPS.mapBy(_ => Set()), dead' = OPS.mapBy(_ => false),
    ep' = SHARDS.mapBy(_ => 0), store' = Map(1 -> a, 2 -> b, 3 -> 0), truth' = Map(1 -> a, 2 -> b), idx' = noEntries,
    txns' = TXNS.mapBy(_ => idle),
    copied' = false, late' = SHARDS.mapBy(_ => false),
    pulled' = false, drained' = false, pfenced' = false, g' = clean,
  }
  action init = {
    nondet a = oneOf(ALLV)
    nondet b = oneOf(ALLV)
    all { not(FIXED_INIT) or (a == 1 and b == 1), initWith(a, b) }
  }

  action keepLog = all { len' = len, prepE' = prepE, commitE' = commitE, abortE' = abortE }
  action keepCoord = all { acks' = acks, dead' = dead }
  action keepData = all { store' = store, truth' = truth, idx' = idx }
  action keepSide = all { copied' = copied, late' = late, pulled' = pulled, drained' = drained, pfenced' = pfenced }
  action recordAbort(op: int): bool = all { len' = len + 1, abortE' = abortE.set(op, len + 1), prepE' = prepE, commitE' = commitE }

  // ---- 取引 -------------------------------------------------------------------

  // 文を実行する。Worker は、手元のスナップショット (古くてもよい) で宛先と index の使い方を決める。
  action plan(t: int, r: int, nv: int, pe: int): bool = all {
    txns.get(t).phase == 0,
    pe <= len,
    not(droppedAt(pe)),
    val dest = ownerAt(pe, r)
    val cur = store.get(dest)
    val st = indexAt(pe)
    val uses = st == PUBLIC or (st == BUILDING and BUILD_VISIBLE)
    val holder = if (uses and nv != 0) idx.get(nv) else 0
    all {
      dest != C or pulled,                   // 子は、行が届いてから文を実行する
      nv != cur,
      txns' = txns.set(t,
        // 同じ値の項目が別の行を指していれば、UNIQUE 違反で文が失敗する
        if (holder != 0 and holder != r) done
        else { phase: 1, row: r, old: cur, new: nv, pe: pe, ps: schemaAt(pe), ce: pe, dest: dest, maintain: uses, seen: holder, entered: false, ok: false }),
      g' = { ...g, relied: g.relied or (uses and st == BUILDING) },
      keepLog, keepCoord, ep' = ep, keepData, keepSide,
    }
  }

  // 取引が、溜めた書き込みを計画し直さずに、新しい表定義の epoch を名乗る。PIN なら起きない。
  action repin(t: int): bool = all {
    not(PIN),
    txns.get(t).phase == 1,
    txns.get(t).ps < schemaAt(len),
    txns' = txns.set(t, { ...txns.get(t), ps: schemaAt(len), ce: len }),
    g' = g, keepLog, keepCoord, ep' = ep, keepData, keepSide,
  }

  // シャードが要求を受け、版と所有を確かめる。この後で、行ロックか intent の決着を待つ。RECHECK なら、待ちの後で
  // もう一度確かめるので、この段は要らない (prepare が確かめる)。
  action enter(t: int): bool = all {
    not(RECHECK),
    txns.get(t).phase == 1,
    not(txns.get(t).entered),
    val x = txns.get(t)
    all {
      gate(x.dest, x.row, x.ce, x.ps, false) == 0,
      txns' = txns.set(t, { ...x, entered: true }),
      g' = g, keepLog, keepCoord, ep' = ep, keepData, keepSide,
    }
  }

  // シャードが書き込みを受け付ける。版と所有、書き込み禁止、読んだ後に変わっていないことを確かめて、intent を置く。
  // 確かめに通らなければ、取引は終わる (何も書かない)。
  action prepare(t: int): bool = all {
    txns.get(t).phase == 1,
    val x = txns.get(t)
    val s = x.dest
    val code = if (not(RECHECK) and x.entered) 0 else gate(s, x.row, x.ce, x.ps, false)
    // 書き込み禁止の印と、表や制約そのものは、シャードのいまの状態で決まる。
    val locked = FENCE and fencedAt(ep.get(s))
    val gone = droppedAt(ep.get(s))
    val bad = checkOnAt(ep.get(s)) and x.new == 2
    val changed = store.get(s) != x.old or (x.maintain and x.new != 0 and idx.get(x.new) != x.seen)
    // 行の intent と、index の項目の intent。項目も行なので、同じ値の項目を触る 2 つの取引は、片方しか受け付けられない。
    val busy = TXNS.exists(u => u != t and txns.get(u).phase == 2 and
      (txns.get(u).row == x.row or
       (x.maintain and txns.get(u).maintain and
        Set(x.old, x.new).exclude(Set(0)).intersect(Set(txns.get(u).old, txns.get(u).new)) != Set())))
    val accepted = code == 0 and not(locked or gone or bad or changed or busy)
    all {
      code != 1,
      code != 0 or s != C or pulled,         // 子は、行が届くのを待つ (pull)
      txns' = txns.set(t, if (accepted) { ...x, phase: 2 } else done),
      g' = {
        ...g,
        refusedByFence: g.refusedByFence or (code == 0 and locked),
        refusedLatest: g.refusedLatest or (code >= 2 and x.pe == len),
        refusedUnmoved: g.refusedUnmoved or (code == 2 and wronglyRefused(s, x.row, x.ps, false)),
        acceptedOlder: g.acceptedOlder or (accepted and x.ce < ep.get(s)),
        badPin: g.badPin or (accepted and x.ps != schemaAt(x.pe)),
        belowAck: g.belowAck or (accepted and DDLS.exists(op => acks.get(op).contains(s) and x.ps < prepE.get(op))),
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
      txns' = txns.set(t, { ...done, ps: x.ps, dest: s, ok: true }),
      late' = if (copied) late.set(s, true) else late,
      g' = {
        ...g,
        wroteFenced: g.wroteFenced or fencedAt(ep.get(s)),
        wroteAfterDrop: g.wroteAfterDrop or commitE.get(DROP) > 0,
        resurrected: g.resurrected or droppedAt(ep.get(s)),
      },
      keepLog, keepCoord, ep' = ep, copied' = copied, pulled' = pulled, drained' = drained, pfenced' = pfenced,
    }
  }

  // 読み。状態は変えない。断られたか、答えが正しいかだけを記録する。
  action read(pe: int, r: int): bool = all {
    pe <= len,
    not(droppedAt(pe)),
    val s = ownerAt(pe, r)
    val code = gate(s, r, pe, schemaAt(pe), true)
    all {
      code != 1,
      code != 0 or s != C or pulled,
      g' = {
        ...g,
        refusedLatest: g.refusedLatest or (code >= 2 and pe == len),
        refusedUnmoved: g.refusedUnmoved or (code == 2 and wronglyRefused(s, r, schemaAt(pe), true)),
        badRead: g.badRead or (code == 0 and store.get(s) != truth.get(r)),
        uncutRead: g.uncutRead or (code == 0 and s == P and r == 1 and movedAt(ep.get(P))),
      },
      keepLog, keepCoord, ep' = ep, keepData, txns' = txns, keepSide,
    }
  }

  // ---- Meta: 表定義の遷移 -----------------------------------------------------

  // 遷移を開く。Meta は、いまの表定義で文を確かめる (消えた表への DDL は断る)。
  action prepareOp(op: int): bool = all {
    DDLS.contains(op), has(op),
    prepE.get(op) == 0,
    not(droppedAt(len)),
    not(ONE_OPEN) or not(ddlOpen),
    not(DDL_WAITS_MOVE) or not(moveOpen),
    len' = len + 1, prepE' = prepE.set(op, len + 1), commitE' = commitE, abortE' = abortE,
    keepCoord, ep' = ep, keepData, txns' = txns, keepSide, g' = g,
  }

  // 遷移を確定する。進める側は、全シャードが ok と答えたと思っている。
  action commitOp(op: int): bool = all {
    DDLS.contains(op), has(op),
    not(dead.get(op)),
    prepE.get(op) > 0, commitE.get(op) == 0,
    not(ONE_EXIT) or openAt(op, len),
    not(ALL_ACKS) or acks.get(op) == shardsAt(prepE.get(op)),
    len' = len + 1, commitE' = commitE.set(op, len + 1), prepE' = prepE, abortE' = abortE,
    keepCoord, ep' = ep, keepData, txns' = txns, keepSide, g' = g,
  }

  // 期限切れ。進める側が止まっても、Meta が自分で取り消す。進める側が自分で取り消す場合も、この手である。
  // 埋めた項目は捨てる (index の表は、取り消しを適用したシャードが名前で消す)。
  action expire(op: int): bool = all {
    DDLS.contains(op), has(op),
    openAt(op, len),
    recordAbort(op),
    idx' = if (op == BUILD) noEntries else idx,
    keepCoord, ep' = ep, store' = store, truth' = truth, txns' = txns, keepSide, g' = g,
  }

  // 進める側が止まる。DDL は prepare の後で止まる。分割は、fence か start の後、行が子に届く前に止まる
  // (止まった後で行が届くことを、witness が順序つきで示せるようにする)。
  action die(op: int): bool = all {
    has(op), not(dead.get(op)),
    if (op == SPLIT) (prepE.get(SPLIT) > 0 or pfenced) and commitE.get(SPLIT) == 0 and not(pulled) else openAt(op, len),
    dead' = dead.set(op, true),
    acks' = acks, keepLog, ep' = ep, keepData, txns' = txns, keepSide, g' = g,
  }

  // ---- シャード: 列の適用と、prepare の確かめ ----------------------------------

  // シャードが次の記録を適用する。
  action applyNext(s: int): bool = all {
    s != C or prepE.get(SPLIT) > 0,          // 子は、分割の記録ができてから現れる
    ep.get(s) < len,
    val e = ep.get(s) + 1
    val schema = isSchemaEpoch(e)
    all {
      not(schema) or not(movingNow(s)),
      not(schema) or not(DRAIN) or noIntents(s),
      ep' = ep.set(s, e),
      store' = if (e == commitE.get(DROP)) store.set(s, 0) else store,
      g' = {
        ...g,
        // 制約に反する行があるシャードは、制約を足す文を実行できない。消えた表には index を公開できない。
        stuck: g.stuck or (e == commitE.get(CHECK) and heldVal(s) == 2) or (e == commitE.get(BUILD) and droppedAt(ep.get(s))),
      },
      keepLog, keepCoord, truth' = truth, idx' = idx, txns' = txns, keepSide,
    }
  }

  /** シャード s が、op の prepare の確かめに答えられるか。 */
  def canAck(op: int, s: int): bool = and {
    has(op), openAt(op, len), not(dead.get(op)),
    shardsAt(prepE.get(op)).contains(s), not(acks.get(op).contains(s)),
    not(CHECK_AT_EPOCH) or openAt(op, ep.get(s)),
  }

  // BUILD: シャードの行を読んで、index の項目を埋める。同じ値の項目が別の行を指していれば、重複なので取り消す。
  action ackBuild(s: int): bool = all {
    canAck(BUILD, s),
    val r = rowHeld(s)
    val v = heldVal(s)
    val dup = v != 0 and idx.get(v) != 0 and idx.get(v) != r
    all {
      // 埋める処理も、行を読んで項目を書く取引である。その行か、その項目に intent があれば、決着を待つ。
      TXNS.forall(u => not(txns.get(u).phase == 2 and
        (txns.get(u).dest == s or
         (txns.get(u).maintain and v != 0 and Set(txns.get(u).old, txns.get(u).new).contains(v))))),
      if (dup) all { recordAbort(BUILD), idx' = noEntries, acks' = acks }
      else all { keepLog, idx' = if (v != 0) idx.set(v, r) else idx, acks' = acks.set(BUILD, acks.get(BUILD).union(Set(s))) },
      dead' = dead, ep' = ep, store' = store, truth' = truth, txns' = txns, keepSide, g' = g,
    }
  }

  // CHECK: シャードが、巻き戻す取引の中で文を試す。通らなければ、取り消す。
  action ackCheck(s: int): bool = all {
    canAck(CHECK, s),
    if (heldVal(s) == 2) all { recordAbort(CHECK), acks' = acks }
    else all { keepLog, acks' = acks.set(CHECK, acks.get(CHECK).union(Set(s))) },
    dead' = dead, ep' = ep, keepData, txns' = txns, keepSide, g' = g,
  }

  // DROP: シャードが、copy が読んだ後の変更がないことを確かめる。あれば、取り消す (行は失われず、DDL が競合で失敗する)。
  action ackDrop(s: int): bool = all {
    canAck(DROP, s),
    if (GUARD_CHECK and late.get(s)) all { recordAbort(DROP), acks' = acks }
    else all { keepLog, acks' = acks.set(DROP, acks.get(DROP).union(Set(s))) },
    dead' = dead, ep' = ep, keepData, txns' = txns, keepSide, g' = g,
  }

  // ---- DROP の場面: 行を写す取引 -----------------------------------------------

  // copy の区切りが、表を全シャードで読んで確定する。読んだ後に変更か intent があれば、検証が断るので、ここでは
  // intent のないときにだけ起きる。この後の書き込みが、写されていない行である。
  action copy = all {
    HAS_DROP, not(copied), prepE.get(DROP) == 0,
    SHARDS.forall(s => noIntents(s)),
    copied' = true,
    late' = late, pulled' = pulled, drained' = drained, pfenced' = pfenced,
    keepLog, keepCoord, ep' = ep, keepData, txns' = txns, g' = g,
  }

  // ---- 移動 -------------------------------------------------------------------

  // いまの実装: 分割を進める側が、範囲表を切り替える前に、親に fence させる。
  action fenceFirst = all {
    HAS_SPLIT, not(FENCE_IS_EPOCH), prepE.get(SPLIT) == 0, not(pfenced), not(dead.get(SPLIT)),
    pfenced' = true,
    copied' = copied, late' = late, pulled' = pulled, drained' = drained,
    keepLog, keepCoord, ep' = ep, keepData, txns' = txns, g' = g,
  }

  // 移動を開く。この記録が、範囲表の切り替えであり、親の fence であり、子の受け取りの始まりである。
  action startSplit = all {
    HAS_SPLIT, prepE.get(SPLIT) == 0, not(dead.get(SPLIT)),
    FENCE_IS_EPOCH or pfenced,
    not(MOVE_WAITS_DDL) or not(ddlOpen),
    len' = len + 1, prepE' = prepE.set(SPLIT, len + 1), commitE' = commitE, abortE' = abortE,
    keepCoord, ep' = ep, keepData, txns' = txns, keepSide, g' = g,
  }

  // 子が行を親から引き取る。要求に駆動されても、背景でも起きる。進める側は要らない。
  // 親の intent は行と一緒に運ばれる (M5b、M18) が、ここでは運ぶ手順を持たないので、親に intent がないときにだけ起きる。
  action pull = all {
    HAS_SPLIT, not(pulled),
    movedAt(ep.get(C)),
    not(PULL_AT_EPOCH) or movedAt(ep.get(P)),
    noIntents(P),
    store' = store.set(C, store.get(P)), pulled' = true,
    g' = { ...g, shapeMismatch: g.shapeMismatch or sv(P) != sv(C) },
    truth' = truth, idx' = idx, copied' = copied, late' = late, drained' = drained, pfenced' = pfenced,
    keepLog, keepCoord, ep' = ep, txns' = txns,
  }

  // 子が受け取り終える (親の時計を受け取り、手元の移動の記録を閉じる)。子が自分で進める。
  action finishData = all {
    HAS_SPLIT, pulled, not(drained),
    drained' = true,
    copied' = copied, late' = late, pulled' = pulled, pfenced' = pfenced,
    keepLog, keepCoord, ep' = ep, keepData, txns' = txns, g' = g,
  }

  // 移動を閉じる。子が、受け取り終えた後で Meta に記録させる。
  action endSplit = all {
    HAS_SPLIT, prepE.get(SPLIT) > 0, commitE.get(SPLIT) == 0,
    not(END_AFTER_DRAIN) or drained,
    len' = len + 1, commitE' = commitE.set(SPLIT, len + 1), prepE' = prepE, abortE' = abortE,
    keepCoord, ep' = ep, keepData, txns' = txns, keepSide, g' = g,
  }

  action step = any {
    { nondet t = oneOf(TXNS) nondet r = oneOf(ROWS) nondet nv = oneOf(ALLV) nondet pe = oneOf(0.to(MAXE)) plan(t, r, nv, pe) },
    { nondet t = oneOf(TXNS) any { repin(t), enter(t), prepare(t), commit(t) } },
    { nondet pe = oneOf(0.to(MAXE)) nondet r = oneOf(ROWS) read(pe, r) },
    { nondet op = oneOf(DDLS) any { prepareOp(op), commitOp(op), expire(op) } },
    { nondet op = oneOf(OPS) die(op) },
    { nondet s = oneOf(SHARDS) any { applyNext(s), ackBuild(s), ackCheck(s), ackDrop(s) } },
    copy, fenceFirst, startSplit, pull, finishData, endSplit,
  }

  // ---- 不変条件 -------------------------------------------------------------
  // M12 (M11 の indexComplete、noDangling、uniqueSafe を含む)。表が消えた後は、index も一緒に消えている。
  val indexMatches = commitE.get(BUILD) == 0 or commitE.get(DROP) > 0 or
    (ROWS.forall(r => lv(r) == 0 or idx.get(lv(r)) == r) and
     VALS.forall(v => idx.get(v) == 0 or lv(idx.get(v)) == v))
  val noWriteWhileFenced = not(g.wroteFenced)
  val notRelied = not(g.relied)
  // M12 と M14
  val oneExit = DDLS.forall(op => not(commitE.get(op) > 0 and abortE.get(op) > 0))
  val noIntentWhileFenced = SHARDS.forall(s => not(FENCE and fencedAt(ep.get(s))) or noIntents(s))
  // M11 の noLostWrite と noResurrect
  val noLostAfterReturn = not(g.wroteAfterDrop)
  val noResurrect = not(g.resurrected)
  // M14 の noLostWrite
  val guardHolds = not(commitE.get(DROP) > 0 and SHARDS.exists(s => late.get(s)))
  // M13 の pinned
  val pinned = not(g.badPin)
  // M15 の servable と、未解決の問題 17
  val servable = not(g.refusedLatest)
  // この設計で新しく要るもの
  val commitApplies = not(g.stuck)
  val noServeBelowAck = not(g.belowAck)
  val pinnedSurvives = not(g.refusedUnmoved)
  // 移動 (M5b の noLostWrite と readConsistent、不変条件 4 の「運ぶ行の形」)
  val moveKeepsWrites = not(HAS_SPLIT) or droppedAt(len) or lv(1) == truth.get(1)
  val readConsistent = not(g.badRead)
  val sameShape = not(g.shapeMismatch)

  /** シャードが、次の記録を適用できる。 */
  def canApply(s: int): bool =
    ep.get(s) < len and (not(isSchemaEpoch(ep.get(s) + 1)) or (not(movingNow(s)) and (not(DRAIN) or noIntents(s))))
  // 移動が始まってから行が子に届くまで、行き止まりがない。進める側が止まっていても、親か子が列を適用する、親の intent が
  // 確定する、子が行を引き取る、のどれかの手が打てる。servable は断られた要求だけを数えるので、子が行を引き取れずに
  // 要求が待ち続ける形は、この不変条件が受け持つ (M19 の readNotStuck と同じ書き方)。
  val moveNotStuck = not(HAS_SPLIT and prepE.get(SPLIT) > 0 and not(pulled)) or
    canApply(P) or canApply(C) or TXNS.exists(t => txns.get(t).phase == 2) or
    (movedAt(ep.get(C)) and (not(PULL_AT_EPOCH) or movedAt(ep.get(P))) and noIntents(P))

  // 別の案 (表定義の epoch を commit だけで進める) でも成り立つもの。noServeBelowAck だけを除く。
  val epochSafeCommitOnly = and {
    indexMatches, noWriteWhileFenced, notRelied, oneExit, noIntentWhileFenced,
    noLostAfterReturn, noResurrect, guardHolds, pinned, servable,
    commitApplies, pinnedSurvives, moveKeepsWrites, readConsistent, sameShape, moveNotStuck,
  }
  val epochSafe = epochSafeCommitOnly and noServeBelowAck

  // ---- witness (not(到達したい状態) を invariant にして、違反が出れば到達できる) ----
  def wroteAt(e: int): bool = TXNS.exists(t => txns.get(t).ok and txns.get(t).ps == e)
  // index が公開された後で、index を使う書き込みが全部確定し、2 行とも値と項目を持つ
  val witnessPublicThenWrite = not(commitE.get(BUILD) > 0 and TXNS.forall(t => txns.get(t).ok and txns.get(t).ps == commitE.get(BUILD))
                                   and lv(1) != 0 and lv(2) != 0 and idx.get(lv(1)) == 1 and idx.get(lv(2)) == 2)
  // 最初から同じ値の行が 2 つあり、index の作成が取り消される
  val witnessAbortedOnDuplicate = not(abortE.get(BUILD) > 0 and lv(1) == lv(2) and lv(1) != 0 and acks.get(BUILD) != Set())
  // 書き込み禁止の epoch で計画された書き込みを、シャードが断る
  val witnessRefusedByFence = not(g.refusedByFence)
  // 進める側が止まった後、Meta が取り消し、その後の表定義で計画した書き込みが確定する
  val witnessLiftedAfterStall = not(DDLS.exists(op => dead.get(op) and abortE.get(op) > 0 and wroteAt(abortE.get(op))))
  // 制約に反する行があって試適用が通らず、取り消される。その後で書き込みが確定する (逆操作の文は要らない)
  val witnessTrialRejectedThenWrite = not(abortE.get(CHECK) > 0 and acks.get(CHECK) != Set() and wroteAt(abortE.get(CHECK)))
  // 制約が確定し、全シャードが適用し、その後で書き込みが確定する
  val witnessCheckCommittedThenWrite = not(commitE.get(CHECK) > 0 and ep.get(P) >= commitE.get(CHECK) and ep.get(Q) >= commitE.get(CHECK)
                                           and wroteAt(commitE.get(CHECK)))
  // 2 つの DDL が、順に確定する
  val witnessBothCommitted = not(commitE.get(BUILD) > 0 and commitE.get(CHECK) > 0)
  val witnessBuildAfterRejectedCheck = not(abortE.get(CHECK) > 0 and commitE.get(BUILD) > abortE.get(CHECK))
  // 別の接続の書き込みの後で copy が読み、DROP まで進む
  val witnessDroppedAfterWrites = not(commitE.get(DROP) > 0 and copied and TXNS.exists(t => txns.get(t).ok)
                                      and ep.get(P) >= commitE.get(DROP) and ep.get(Q) >= commitE.get(DROP))
  // copy の後の書き込みを見つけて、DROP を取り消す
  val witnessGuardRefused = not(abortE.get(DROP) > 0 and copied and SHARDS.exists(s => late.get(s)) and acks.get(DROP) != Set())
  // 分割を進める側が start の後で止まっても、子が行を引き取り、子への書き込みが確定する (end はまだ)
  val witnessServedWhileDriverDead = not(dead.get(SPLIT) and commitE.get(SPLIT) == 0 and pulled
                                         and TXNS.exists(t => txns.get(t).ok and txns.get(t).dest == C))
  // 進める側が止まっていても、移動は閉じる
  val witnessEndedDriverDead = not(dead.get(SPLIT) and commitE.get(SPLIT) > 0)
  // 分割より前のスナップショットの取引が、分割の記録を適用したシャードで受け付けられる
  val witnessPinnedSurvives = not(g.acceptedOlder and prepE.get(SPLIT) > 0)
  // 移動の後で DDL が確定する。DDL の後で移動が始まり、行が届く
  val witnessDdlAfterMove = not(commitE.get(SPLIT) > 0 and commitE.get(CHECK) > commitE.get(SPLIT) and ep.get(C) >= commitE.get(CHECK))
  val witnessMoveAfterDdl = not(commitE.get(CHECK) > 0 and prepE.get(SPLIT) > commitE.get(CHECK) and pulled)
  // 親が、start を適用した後で、まだ渡していない行の読みに答える (M19)
  val witnessParentAnswersUncut = not(g.uncutRead)
  // 別の案で、ok と答えた prepare より前の計画が、その遷移が取り消された後で受け付けられる
  val witnessOldPlanAfterAbort = not(g.belowAck and DDLS.forall(op => commitE.get(op) == 0))
}

// ---- 決めた設計 ----------------------------------------------------------------

// BUILD: 行のある表に、シャードをまたぐ UNIQUE の index を作る。取引 2 件が、どの epoch のスナップショットでも計画する。
module m21_green_build {
  import m21_core(HAS_BUILD = true, HAS_CHECK = false, HAS_DROP = false, HAS_SPLIT = false, NTXN = 2, FIXED_INIT = false,
    REJECT_STALE = true, RECHECK = true, FENCE = true, DRAIN = true, CHECK_AT_EPOCH = true, GUARD_CHECK = true,
    ALL_ACKS = true, ONE_EXIT = true, ONE_OPEN = true, PIN = true, BUILD_VISIBLE = false,
    DDL_WAITS_MOVE = true, MOVE_WAITS_DDL = true, END_AFTER_DRAIN = true, PULL_AT_EPOCH = true, FENCE_IS_EPOCH = true, OWNER_CHECK = 0,
    SCHEMA_ON_PREPARE = true).*
  // 書き込み禁止の epoch で計画した書き込みを、シャードが断る。公開の後は、index を使う書き込みが通る。
  run fencedThenPublicTest =
    initWith(1, 0).then(prepareOp(BUILD)).then(applyNext(P)).then(applyNext(Q))
        .then(plan(1, 1, 2, 1)).then(prepare(1))
        .expect(txns.get(1).phase == 3 and not(txns.get(1).ok) and g.refusedByFence)
        .then(ackBuild(P)).then(ackBuild(Q)).then(commitOp(BUILD)).then(applyNext(P))
        .then(plan(2, 1, 2, 2)).then(prepare(2)).then(commit(2))
        .expect(epochSafe and idx.get(2) == 1 and idx.get(1) == 0)
  // 進める側が止まると、Meta が期限で取り消す。禁止が解け、取り消しの後の表定義で計画した書き込みが通る。
  run liftedAfterStallTest =
    initWith(1, 0).then(prepareOp(BUILD)).then(applyNext(P)).then(ackBuild(P)).then(die(BUILD)).then(expire(BUILD))
        .then(applyNext(P)).then(plan(1, 1, 2, 2)).then(prepare(1)).then(commit(1))
        .expect(epochSafe and store.get(P) == 2 and idx == noEntries)
  // 同じ値の行が 2 つある。2 つ目の行を読んだところで重複が見つかり、取り消される。項目は残らない。
  run duplicateAbortsTest =
    initWith(1, 1).then(prepareOp(BUILD)).then(applyNext(P)).then(applyNext(Q)).then(ackBuild(P)).then(ackBuild(Q))
        .expect(epochSafe and abortE.get(BUILD) == 2 and idx == noEntries and not(fencedAt(len)))
}
// CHECK: 行で失敗し得る DDL。各シャードが、書き込みを止めた表で試してから、確定する。事後の取り消しの代わりである。
module m21_green_check {
  import m21_core(HAS_BUILD = false, HAS_CHECK = true, HAS_DROP = false, HAS_SPLIT = false, NTXN = 2, FIXED_INIT = false,
    REJECT_STALE = true, RECHECK = true, FENCE = true, DRAIN = true, CHECK_AT_EPOCH = true, GUARD_CHECK = true,
    ALL_ACKS = true, ONE_EXIT = true, ONE_OPEN = true, PIN = true, BUILD_VISIBLE = false,
    DDL_WAITS_MOVE = true, MOVE_WAITS_DDL = true, END_AFTER_DRAIN = true, PULL_AT_EPOCH = true, FENCE_IS_EPOCH = true, OWNER_CHECK = 0,
    SCHEMA_ON_PREPARE = true).*
  // 制約に反する行があるシャードが、試適用を断る。取り消しは禁止を解くだけで、その後の書き込みが通る。
  run trialRejectedTest =
    initWith(1, 2).then(prepareOp(CHECK)).then(applyNext(P)).then(applyNext(Q)).then(ackCheck(P)).then(ackCheck(Q))
        .expect(abortE.get(CHECK) == 2 and not(fencedAt(len)))
        .then(applyNext(Q)).then(plan(1, 2, 1, 2)).then(prepare(1)).then(commit(1))
        .expect(epochSafe and store.get(Q) == 1)
  // 全シャードが通れば確定する。確定を適用したシャードは、制約に反する書き込みを断る。
  run trialPassedTest =
    initWith(1, 1).then(prepareOp(CHECK)).then(applyNext(P)).then(applyNext(Q)).then(ackCheck(P)).then(ackCheck(Q)).then(commitOp(CHECK))
        .then(applyNext(P)).then(plan(1, 1, 2, 2)).then(prepare(1))
        .expect(epochSafe and txns.get(1).phase == 3 and not(txns.get(1).ok))
}
// 同時に出された 2 つの DDL (BUILD と CHECK)。Meta は、表定義の遷移を 1 つずつしか開かない。
module m21_green_ddl2 {
  import m21_core(HAS_BUILD = true, HAS_CHECK = true, HAS_DROP = false, HAS_SPLIT = false, NTXN = 1, FIXED_INIT = false,
    REJECT_STALE = true, RECHECK = true, FENCE = true, DRAIN = true, CHECK_AT_EPOCH = true, GUARD_CHECK = true,
    ALL_ACKS = true, ONE_EXIT = true, ONE_OPEN = true, PIN = true, BUILD_VISIBLE = false,
    DDL_WAITS_MOVE = true, MOVE_WAITS_DDL = true, END_AFTER_DRAIN = true, PULL_AT_EPOCH = true, FENCE_IS_EPOCH = true, OWNER_CHECK = 0,
    SCHEMA_ON_PREPARE = true).*
}
// DROP: 取引が読んだ表を消す。copy が読んだ後の書き込みがあれば、取り消す。copy のない DROP も、同じ遷移である。
module m21_green_drop {
  import m21_core(HAS_BUILD = false, HAS_CHECK = false, HAS_DROP = true, HAS_SPLIT = false, NTXN = 2, FIXED_INIT = false,
    REJECT_STALE = true, RECHECK = true, FENCE = true, DRAIN = true, CHECK_AT_EPOCH = true, GUARD_CHECK = true,
    ALL_ACKS = true, ONE_EXIT = true, ONE_OPEN = true, PIN = true, BUILD_VISIBLE = false,
    DDL_WAITS_MOVE = true, MOVE_WAITS_DDL = true, END_AFTER_DRAIN = true, PULL_AT_EPOCH = true, FENCE_IS_EPOCH = true, OWNER_CHECK = 0,
    SCHEMA_ON_PREPARE = true).*
  // copy の後に書き込みがあったシャードが、確かめで見つけて、DROP を取り消す。行は失われない。
  run guardRefusesTest =
    initWith(1, 1).then(copy).then(plan(1, 1, 2, 0)).then(prepare(1)).then(commit(1))
        .then(prepareOp(DROP)).then(applyNext(P)).then(applyNext(Q)).then(ackDrop(Q)).then(ackDrop(P))
        .expect(epochSafe and abortE.get(DROP) == 2 and commitE.get(DROP) == 0 and store.get(P) == 2)
}
// SPLIT と CHECK: 行 1 の区間を P から C へ移す。DDL が前後に入る。分割を進める側は、start の後ならいつ止まってもよい。取引は 1 件。
module m21_green_split {
  import m21_core(HAS_BUILD = false, HAS_CHECK = true, HAS_DROP = false, HAS_SPLIT = true, NTXN = 1, FIXED_INIT = true,
    REJECT_STALE = true, RECHECK = true, FENCE = true, DRAIN = true, CHECK_AT_EPOCH = true, GUARD_CHECK = true,
    ALL_ACKS = true, ONE_EXIT = true, ONE_OPEN = true, PIN = true, BUILD_VISIBLE = false,
    DDL_WAITS_MOVE = true, MOVE_WAITS_DDL = true, END_AFTER_DRAIN = true, PULL_AT_EPOCH = true, FENCE_IS_EPOCH = true, OWNER_CHECK = 0,
    SCHEMA_ON_PREPARE = true).*
  // 未解決の問題 17 の形。進める側が start の直後に止まっても、移る行の読みと書きは、子が行を引き取って答える。
  run driverStopsAfterStartTest =
    initWith(1, 1).then(startSplit).then(die(SPLIT))
        .then(read(0, 1))                                  // 古い範囲表の読み。親はまだ start を知らないので、答える
        .then(applyNext(C)).then(applyNext(P)).then(pull)   // 最新の範囲表の要求が子に届き、子が親から引き取る
        .then(read(1, 1)).then(plan(1, 1, 2, 1)).then(prepare(1)).then(commit(1))
        .expect(epochSafe and store.get(C) == 2 and commitE.get(SPLIT) == 0)
        .then(finishData).then(endSplit)
        .expect(epochSafe and commitE.get(SPLIT) == 2)
}
// SPLIT だけ。取引 2 件が、移動の前後のスナップショットで、動く行と動かない行に書く。
module m21_green_split_txns {
  import m21_core(HAS_BUILD = false, HAS_CHECK = false, HAS_DROP = false, HAS_SPLIT = true, NTXN = 2, FIXED_INIT = true,
    REJECT_STALE = true, RECHECK = true, FENCE = true, DRAIN = true, CHECK_AT_EPOCH = true, GUARD_CHECK = true,
    ALL_ACKS = true, ONE_EXIT = true, ONE_OPEN = true, PIN = true, BUILD_VISIBLE = false,
    DDL_WAITS_MOVE = true, MOVE_WAITS_DDL = true, END_AFTER_DRAIN = true, PULL_AT_EPOCH = true, FENCE_IS_EPOCH = true, OWNER_CHECK = 0,
    SCHEMA_ON_PREPARE = true).*
  // 分割より前のスナップショットの取引は、分割の記録を適用したシャードでも、動かなかった行なら通る。動いた行は断られる。
  run pinnedAcrossSplitTest =
    initWith(1, 1).then(plan(1, 2, 2, 0)).then(plan(2, 1, 2, 0)).then(startSplit).then(applyNext(Q)).then(applyNext(P))
        .then(prepare(1)).then(commit(1)).then(prepare(2))
        .expect(epochSafe and txns.get(1).ok and store.get(Q) == 2 and txns.get(2).phase == 3 and not(txns.get(2).ok) and g.acceptedOlder)
}
// SPLIT と BUILD: index を作る DDL が、移動の前後に入る。M12 が扱わなかった組み合わせである (分割と index の作成の重なり)。取引は 1 件。
module m21_green_split_build {
  import m21_core(HAS_BUILD = true, HAS_CHECK = false, HAS_DROP = false, HAS_SPLIT = true, NTXN = 1, FIXED_INIT = false,
    REJECT_STALE = true, RECHECK = true, FENCE = true, DRAIN = true, CHECK_AT_EPOCH = true, GUARD_CHECK = true,
    ALL_ACKS = true, ONE_EXIT = true, ONE_OPEN = true, PIN = true, BUILD_VISIBLE = false,
    DDL_WAITS_MOVE = true, MOVE_WAITS_DDL = true, END_AFTER_DRAIN = true, PULL_AT_EPOCH = true, FENCE_IS_EPOCH = true, OWNER_CHECK = 0,
    SCHEMA_ON_PREPARE = true).*
  // 移動が閉じた後で index を作る。行を埋める処理は、子の行を読む。親は、渡した行の控えを数えない。
  run buildAfterMoveTest =
    initWith(1, 2).then(startSplit).then(applyNext(C)).then(applyNext(P)).then(pull).then(finishData).then(endSplit)
        .then(prepareOp(BUILD))
        .then(applyNext(P)).then(applyNext(P)).then(applyNext(Q)).then(applyNext(Q)).then(applyNext(Q)).then(applyNext(C)).then(applyNext(C))
        .then(ackBuild(P)).then(ackBuild(Q)).then(ackBuild(C)).then(commitOp(BUILD))
        .expect(epochSafe and idx.get(1) == 1 and idx.get(2) == 2)
        .then(applyNext(C)).then(plan(1, 1, 0, 4)).then(prepare(1)).then(commit(1))
        .expect(epochSafe and idx.get(1) == 0 and store.get(C) == 0)
  // 移動が閉じた後で index が公開され、行 1 の項目は、子が持つ行を指す
  val witnessBuildAfterMove = not(commitE.get(SPLIT) > 0 and commitE.get(BUILD) > commitE.get(SPLIT) and lv(1) != 0 and idx.get(lv(1)) == 1)
  // index が公開された後で移動が始まり、子への書き込みが index を保守する
  val witnessMoveAfterBuild = not(commitE.get(BUILD) > 0 and prepE.get(SPLIT) > commitE.get(BUILD) and pulled
                                  and TXNS.exists(t => txns.get(t).ok and txns.get(t).dest == C) and lv(1) != 0 and idx.get(lv(1)) == 1)
}

// ---- 外しても破れない条件 --------------------------------------------------------

// CHECK の場面では、古い計画を断らず、待ちの後で確かめ直さなくても、記録された commit を適用できる (commitApplies)。
// この不変条件を守っているのは、書き込み禁止と、適用した後の表そのもの (SQLite が制約を確かめる) である。
// 確かめたのは、この 1 つの不変条件だけである。モデルの制約は行の値の性質で、行の形を変えない。列を足す DDL では、
// 古い形の行イメージを持つ計画を断るために、版の確認が要る。版の確認を外してよい、という意味ではない。
module m21_check_no_reject {
  import m21_core(HAS_BUILD = false, HAS_CHECK = true, HAS_DROP = false, HAS_SPLIT = false, NTXN = 2, FIXED_INIT = false,
    REJECT_STALE = false, RECHECK = false, FENCE = true, DRAIN = true, CHECK_AT_EPOCH = true, GUARD_CHECK = true,
    ALL_ACKS = true, ONE_EXIT = true, ONE_OPEN = true, PIN = true, BUILD_VISIBLE = false,
    DDL_WAITS_MOVE = true, MOVE_WAITS_DDL = true, END_AFTER_DRAIN = true, PULL_AT_EPOCH = true, FENCE_IS_EPOCH = true, OWNER_CHECK = 0,
    SCHEMA_ON_PREPARE = true).*
}
// 別の案: 表定義の epoch を、commit だけで進める (prepare と abort では進めない)。prepare より前の計画は、禁止が掛かっている間は
// 書き込み禁止で断られ、取り消された後は、そのまま通る。取引が古くなるのは、DDL が確定したときの 1 回だけになる。
// noServeBelowAck (ok と答えた prepare より古い計画を受けない) は、この案では定義から成り立たないので、除いて確かめる。
module m21_alt_commit_only_build {
  import m21_core(HAS_BUILD = true, HAS_CHECK = false, HAS_DROP = false, HAS_SPLIT = false, NTXN = 2, FIXED_INIT = false,
    REJECT_STALE = true, RECHECK = true, FENCE = true, DRAIN = true, CHECK_AT_EPOCH = true, GUARD_CHECK = true,
    ALL_ACKS = true, ONE_EXIT = true, ONE_OPEN = true, PIN = true, BUILD_VISIBLE = false,
    DDL_WAITS_MOVE = true, MOVE_WAITS_DDL = true, END_AFTER_DRAIN = true, PULL_AT_EPOCH = true, FENCE_IS_EPOCH = true, OWNER_CHECK = 0,
    SCHEMA_ON_PREPARE = false).*
}
// 同じ案を、CHECK の場面で確かめる。
module m21_alt_commit_only_check {
  import m21_core(HAS_BUILD = false, HAS_CHECK = true, HAS_DROP = false, HAS_SPLIT = false, NTXN = 2, FIXED_INIT = false,
    REJECT_STALE = true, RECHECK = true, FENCE = true, DRAIN = true, CHECK_AT_EPOCH = true, GUARD_CHECK = true,
    ALL_ACKS = true, ONE_EXIT = true, ONE_OPEN = true, PIN = true, BUILD_VISIBLE = false,
    DDL_WAITS_MOVE = true, MOVE_WAITS_DDL = true, END_AFTER_DRAIN = true, PULL_AT_EPOCH = true, FENCE_IS_EPOCH = true, OWNER_CHECK = 0,
    SCHEMA_ON_PREPARE = false).*
  // prepare より前に計画した書き込みが、その DDL が取り消された後で、計画し直さずに通る。
  run oldPlanAfterAbortTest =
    initWith(1, 2).then(plan(1, 1, 0, 0))
        .then(prepareOp(CHECK)).then(applyNext(P)).then(applyNext(Q)).then(ackCheck(P)).then(ackCheck(Q))
        .expect(abortE.get(CHECK) == 2)
        .then(applyNext(P)).then(prepare(1)).then(commit(1))
        .expect(epochSafeCommitOnly and txns.get(1).ok and store.get(P) == 0 and not(noServeBelowAck))
  // 禁止が掛かっている間は、同じ計画が、書き込み禁止で断られる。
  run oldPlanWhileFencedTest =
    initWith(1, 1).then(plan(1, 1, 0, 0)).then(prepareOp(CHECK)).then(applyNext(P)).then(prepare(1))
        .expect(epochSafeCommitOnly and txns.get(1).phase == 3 and not(txns.get(1).ok) and g.refusedByFence)
}

// ---- 赤: BUILD の場面 ----------------------------------------------------------

// 2026-11 までの設計。作りながら書く。取引が index を保守し、一意性を、出来上がっていない index で確かめる (m12_red_online)。
module m21_red_online {
  import m21_core(HAS_BUILD = true, HAS_CHECK = false, HAS_DROP = false, HAS_SPLIT = false, NTXN = 2, FIXED_INIT = false,
    REJECT_STALE = true, RECHECK = true, FENCE = false, DRAIN = true, CHECK_AT_EPOCH = true, GUARD_CHECK = true,
    ALL_ACKS = true, ONE_EXIT = true, ONE_OPEN = true, PIN = true, BUILD_VISIBLE = true,
    DDL_WAITS_MOVE = true, MOVE_WAITS_DDL = true, END_AFTER_DRAIN = true, PULL_AT_EPOCH = true, FENCE_IS_EPOCH = true, OWNER_CHECK = 0,
    SCHEMA_ON_PREPARE = true).*
  run onlineTest =
    initWith(1, 1).then(prepareOp(BUILD)).then(applyNext(P)).then(applyNext(Q)).then(ackBuild(P))
        .then(plan(1, 2, 2, 1)).expect(not(notRelied))
        .then(prepare(1)).then(commit(1))                  // 行 2 が値 1 を手放し、行 1 の項目を消す
        .then(ackBuild(Q)).then(commitOp(BUILD))
        .expect(not(indexMatches) and idx.get(1) == 0 and store.get(P) == 1)
}
// 書き込みを止めない。埋めた後で変わった行の項目が、古いままになる (m12_red_no_lock、m11_impl_backfill)。
module m21_red_no_fence {
  import m21_core(HAS_BUILD = true, HAS_CHECK = false, HAS_DROP = false, HAS_SPLIT = false, NTXN = 2, FIXED_INIT = false,
    REJECT_STALE = true, RECHECK = true, FENCE = false, DRAIN = true, CHECK_AT_EPOCH = true, GUARD_CHECK = true,
    ALL_ACKS = true, ONE_EXIT = true, ONE_OPEN = true, PIN = true, BUILD_VISIBLE = false,
    DDL_WAITS_MOVE = true, MOVE_WAITS_DDL = true, END_AFTER_DRAIN = true, PULL_AT_EPOCH = true, FENCE_IS_EPOCH = true, OWNER_CHECK = 0,
    SCHEMA_ON_PREPARE = true).*
  run noFenceTest =
    initWith(2, 0).then(prepareOp(BUILD)).then(applyNext(P)).then(applyNext(Q)).then(ackBuild(P)).then(ackBuild(Q))
        .then(plan(1, 1, 1, 1)).then(prepare(1)).then(commit(1))
        .then(commitOp(BUILD))
        .expect(not(indexMatches) and idx.get(2) == 1 and store.get(P) == 1)
}
// 書き込みは止めるが、作っている最中の index を、計画が使う (m12_red_visible)。
module m21_red_visible {
  import m21_core(HAS_BUILD = true, HAS_CHECK = false, HAS_DROP = false, HAS_SPLIT = false, NTXN = 2, FIXED_INIT = false,
    REJECT_STALE = true, RECHECK = true, FENCE = true, DRAIN = true, CHECK_AT_EPOCH = true, GUARD_CHECK = true,
    ALL_ACKS = true, ONE_EXIT = true, ONE_OPEN = true, PIN = true, BUILD_VISIBLE = true,
    DDL_WAITS_MOVE = true, MOVE_WAITS_DDL = true, END_AFTER_DRAIN = true, PULL_AT_EPOCH = true, FENCE_IS_EPOCH = true, OWNER_CHECK = 0,
    SCHEMA_ON_PREPARE = true).*
  run visibleTest = initWith(1, 2).then(prepareOp(BUILD)).then(plan(1, 1, 2, 1)).expect(not(notRelied))
}
// シャードが、intent を持ったまま表定義の記録を適用する。禁止の前に受け付けた取引が、禁止の後で確定する (m12_red_no_drain、m11_impl_inflight)。
module m21_red_no_drain {
  import m21_core(HAS_BUILD = true, HAS_CHECK = false, HAS_DROP = false, HAS_SPLIT = false, NTXN = 2, FIXED_INIT = false,
    REJECT_STALE = true, RECHECK = true, FENCE = true, DRAIN = false, CHECK_AT_EPOCH = true, GUARD_CHECK = true,
    ALL_ACKS = true, ONE_EXIT = true, ONE_OPEN = true, PIN = true, BUILD_VISIBLE = false,
    DDL_WAITS_MOVE = true, MOVE_WAITS_DDL = true, END_AFTER_DRAIN = true, PULL_AT_EPOCH = true, FENCE_IS_EPOCH = true, OWNER_CHECK = 0,
    SCHEMA_ON_PREPARE = true).*
  run noDrainTest =
    initWith(1, 0).then(plan(1, 1, 2, 0)).then(prepare(1)).then(prepareOp(BUILD)).then(applyNext(P)).then(commit(1))
        .expect(not(noWriteWhileFenced))
}
// シャードが、古い表定義の計画を断らない。index を知らない計画が、公開の後で確定する (m12_red_stale、m11_red_no_reject)。
module m21_red_stale {
  import m21_core(HAS_BUILD = true, HAS_CHECK = false, HAS_DROP = false, HAS_SPLIT = false, NTXN = 2, FIXED_INIT = false,
    REJECT_STALE = false, RECHECK = true, FENCE = true, DRAIN = true, CHECK_AT_EPOCH = true, GUARD_CHECK = true,
    ALL_ACKS = true, ONE_EXIT = true, ONE_OPEN = true, PIN = true, BUILD_VISIBLE = false,
    DDL_WAITS_MOVE = true, MOVE_WAITS_DDL = true, END_AFTER_DRAIN = true, PULL_AT_EPOCH = true, FENCE_IS_EPOCH = true, OWNER_CHECK = 0,
    SCHEMA_ON_PREPARE = true).*
  run staleTest =
    initWith(1, 0).then(prepareOp(BUILD)).then(applyNext(P)).then(applyNext(Q)).then(ackBuild(P)).then(ackBuild(Q))
        .then(commitOp(BUILD)).then(applyNext(P))
        .then(plan(1, 1, 2, 0)).then(prepare(1)).expect(not(noServeBelowAck))
        .then(commit(1))
        .expect(not(indexMatches) and idx.get(1) == 1 and store.get(P) == 2)
}
// commit が、遷移が開いているかを確かめない。期限切れで取り消された後に、遅れてきた commit が通る (m12_red_two_exits)。
module m21_red_two_exits {
  import m21_core(HAS_BUILD = true, HAS_CHECK = false, HAS_DROP = false, HAS_SPLIT = false, NTXN = 2, FIXED_INIT = false,
    REJECT_STALE = true, RECHECK = true, FENCE = true, DRAIN = true, CHECK_AT_EPOCH = true, GUARD_CHECK = true,
    ALL_ACKS = true, ONE_EXIT = false, ONE_OPEN = true, PIN = true, BUILD_VISIBLE = false,
    DDL_WAITS_MOVE = true, MOVE_WAITS_DDL = true, END_AFTER_DRAIN = true, PULL_AT_EPOCH = true, FENCE_IS_EPOCH = true, OWNER_CHECK = 0,
    SCHEMA_ON_PREPARE = true).*
  run twoExitsTest =
    initWith(1, 0).then(prepareOp(BUILD)).then(applyNext(P)).then(applyNext(Q)).then(ackBuild(P)).then(ackBuild(Q))
        .then(expire(BUILD)).then(commitOp(BUILD))
        .expect(not(oneExit) and not(indexMatches))
}
// 取引が、溜めた書き込みを計画し直さずに、新しい表定義の epoch を名乗る (m12_red_repin、m13_red_repin)。
module m21_red_repin {
  import m21_core(HAS_BUILD = true, HAS_CHECK = false, HAS_DROP = false, HAS_SPLIT = false, NTXN = 2, FIXED_INIT = false,
    REJECT_STALE = true, RECHECK = true, FENCE = true, DRAIN = true, CHECK_AT_EPOCH = true, GUARD_CHECK = true,
    ALL_ACKS = true, ONE_EXIT = true, ONE_OPEN = true, PIN = false, BUILD_VISIBLE = false,
    DDL_WAITS_MOVE = true, MOVE_WAITS_DDL = true, END_AFTER_DRAIN = true, PULL_AT_EPOCH = true, FENCE_IS_EPOCH = true, OWNER_CHECK = 0,
    SCHEMA_ON_PREPARE = true).*
  run repinTest =
    initWith(1, 0).then(plan(1, 1, 2, 0))
        .then(prepareOp(BUILD)).then(applyNext(P)).then(applyNext(Q)).then(ackBuild(P)).then(ackBuild(Q))
        .then(commitOp(BUILD)).then(applyNext(P))
        .then(repin(1)).then(prepare(1)).expect(not(pinned))
        .then(commit(1))
        .expect(not(indexMatches))
}
// 行を埋める処理が、まだ prepare を適用していない (書き込みを止めていない) シャードの行を読む (m12_red_scan_early)。
module m21_red_scan_early {
  import m21_core(HAS_BUILD = true, HAS_CHECK = false, HAS_DROP = false, HAS_SPLIT = false, NTXN = 2, FIXED_INIT = false,
    REJECT_STALE = true, RECHECK = true, FENCE = true, DRAIN = true, CHECK_AT_EPOCH = false, GUARD_CHECK = true,
    ALL_ACKS = true, ONE_EXIT = true, ONE_OPEN = true, PIN = true, BUILD_VISIBLE = false,
    DDL_WAITS_MOVE = true, MOVE_WAITS_DDL = true, END_AFTER_DRAIN = true, PULL_AT_EPOCH = true, FENCE_IS_EPOCH = true, OWNER_CHECK = 0,
    SCHEMA_ON_PREPARE = true).*
  run scanEarlyTest =
    initWith(1, 0).then(prepareOp(BUILD)).then(ackBuild(P))
        .then(plan(1, 1, 2, 0)).then(prepare(1)).expect(not(noServeBelowAck))
        .then(commit(1))
        .then(applyNext(P)).then(applyNext(Q)).then(ackBuild(Q)).then(commitOp(BUILD))
        .expect(not(indexMatches))
}
// シャードが、待ちの後で版を確かめ直さない。待つ前に通った古い計画が、prepare に ok と答え、公開を適用した後のシャードで受け付けられる (m11_impl_wait)。
module m21_red_no_recheck {
  import m21_core(HAS_BUILD = true, HAS_CHECK = false, HAS_DROP = false, HAS_SPLIT = false, NTXN = 2, FIXED_INIT = false,
    REJECT_STALE = true, RECHECK = false, FENCE = true, DRAIN = true, CHECK_AT_EPOCH = true, GUARD_CHECK = true,
    ALL_ACKS = true, ONE_EXIT = true, ONE_OPEN = true, PIN = true, BUILD_VISIBLE = false,
    DDL_WAITS_MOVE = true, MOVE_WAITS_DDL = true, END_AFTER_DRAIN = true, PULL_AT_EPOCH = true, FENCE_IS_EPOCH = true, OWNER_CHECK = 0,
    SCHEMA_ON_PREPARE = true).*
  run noRecheckTest =
    initWith(1, 0).then(plan(1, 1, 2, 0)).then(enter(1))
        .then(prepareOp(BUILD)).then(applyNext(P)).then(applyNext(Q)).then(ackBuild(P)).then(ackBuild(Q))
        .then(commitOp(BUILD)).then(applyNext(P))
        .then(prepare(1)).expect(not(noServeBelowAck))
        .then(commit(1))
        .expect(not(indexMatches))
}
// 全シャードの ok を待たずに commit を記録する。行を埋める前に index が公開される (m11_red_early_public)。
module m21_red_early_commit {
  import m21_core(HAS_BUILD = true, HAS_CHECK = false, HAS_DROP = false, HAS_SPLIT = false, NTXN = 2, FIXED_INIT = false,
    REJECT_STALE = true, RECHECK = true, FENCE = true, DRAIN = true, CHECK_AT_EPOCH = true, GUARD_CHECK = true,
    ALL_ACKS = false, ONE_EXIT = true, ONE_OPEN = true, PIN = true, BUILD_VISIBLE = false,
    DDL_WAITS_MOVE = true, MOVE_WAITS_DDL = true, END_AFTER_DRAIN = true, PULL_AT_EPOCH = true, FENCE_IS_EPOCH = true, OWNER_CHECK = 0,
    SCHEMA_ON_PREPARE = true).*
  run earlyCommitTest = initWith(1, 0).then(prepareOp(BUILD)).then(commitOp(BUILD)).expect(not(indexMatches))
}

// ---- 赤: CHECK の場面 (取り消しの代わりが頼る条件) --------------------------------

// 試適用の間、書き込みを止めない。通った後で、制約に反する行が書かれる。記録された commit を、そのシャードが適用できない。
module m21_red_trial_no_fence {
  import m21_core(HAS_BUILD = false, HAS_CHECK = true, HAS_DROP = false, HAS_SPLIT = false, NTXN = 2, FIXED_INIT = false,
    REJECT_STALE = true, RECHECK = true, FENCE = false, DRAIN = true, CHECK_AT_EPOCH = true, GUARD_CHECK = true,
    ALL_ACKS = true, ONE_EXIT = true, ONE_OPEN = true, PIN = true, BUILD_VISIBLE = false,
    DDL_WAITS_MOVE = true, MOVE_WAITS_DDL = true, END_AFTER_DRAIN = true, PULL_AT_EPOCH = true, FENCE_IS_EPOCH = true, OWNER_CHECK = 0,
    SCHEMA_ON_PREPARE = true).*
  run trialNoFenceTest =
    initWith(1, 1).then(prepareOp(CHECK)).then(applyNext(P)).then(applyNext(Q)).then(ackCheck(P))
        .then(plan(1, 1, 2, 1)).then(prepare(1)).then(commit(1))
        .then(ackCheck(Q)).then(commitOp(CHECK)).then(applyNext(P))
        .expect(not(commitApplies))
}
// 全シャードの ok を待たずに commit を記録する。試していないシャードに、制約に反する行がある。
module m21_red_trial_missing_ack {
  import m21_core(HAS_BUILD = false, HAS_CHECK = true, HAS_DROP = false, HAS_SPLIT = false, NTXN = 2, FIXED_INIT = false,
    REJECT_STALE = true, RECHECK = true, FENCE = true, DRAIN = true, CHECK_AT_EPOCH = true, GUARD_CHECK = true,
    ALL_ACKS = false, ONE_EXIT = true, ONE_OPEN = true, PIN = true, BUILD_VISIBLE = false,
    DDL_WAITS_MOVE = true, MOVE_WAITS_DDL = true, END_AFTER_DRAIN = true, PULL_AT_EPOCH = true, FENCE_IS_EPOCH = true, OWNER_CHECK = 0,
    SCHEMA_ON_PREPARE = true).*
  run missingAckTest =
    initWith(1, 2).then(prepareOp(CHECK)).then(applyNext(P)).then(ackCheck(P)).then(commitOp(CHECK))
        .then(applyNext(Q)).then(applyNext(Q))
        .expect(not(commitApplies))
}
// prepare を適用する前 (書き込みを止める前) のシャードが、試適用に ok と答える。
module m21_red_trial_early {
  import m21_core(HAS_BUILD = false, HAS_CHECK = true, HAS_DROP = false, HAS_SPLIT = false, NTXN = 2, FIXED_INIT = false,
    REJECT_STALE = true, RECHECK = true, FENCE = true, DRAIN = true, CHECK_AT_EPOCH = false, GUARD_CHECK = true,
    ALL_ACKS = true, ONE_EXIT = true, ONE_OPEN = true, PIN = true, BUILD_VISIBLE = false,
    DDL_WAITS_MOVE = true, MOVE_WAITS_DDL = true, END_AFTER_DRAIN = true, PULL_AT_EPOCH = true, FENCE_IS_EPOCH = true, OWNER_CHECK = 0,
    SCHEMA_ON_PREPARE = true).*
  run trialEarlyTest =
    initWith(1, 1).then(prepareOp(CHECK)).then(ackCheck(P))
        .then(plan(1, 1, 2, 0)).then(prepare(1)).expect(not(noServeBelowAck))
        .then(commit(1))
        .then(applyNext(P)).then(applyNext(Q)).then(ackCheck(Q)).then(commitOp(CHECK)).then(applyNext(P))
        .expect(not(commitApplies))
}
// シャードが、intent を持ったまま prepare を適用する。試適用の後で、その intent が確定する。
module m21_red_trial_no_drain {
  import m21_core(HAS_BUILD = false, HAS_CHECK = true, HAS_DROP = false, HAS_SPLIT = false, NTXN = 2, FIXED_INIT = false,
    REJECT_STALE = true, RECHECK = true, FENCE = true, DRAIN = false, CHECK_AT_EPOCH = true, GUARD_CHECK = true,
    ALL_ACKS = true, ONE_EXIT = true, ONE_OPEN = true, PIN = true, BUILD_VISIBLE = false,
    DDL_WAITS_MOVE = true, MOVE_WAITS_DDL = true, END_AFTER_DRAIN = true, PULL_AT_EPOCH = true, FENCE_IS_EPOCH = true, OWNER_CHECK = 0,
    SCHEMA_ON_PREPARE = true).*
  run trialNoDrainTest =
    initWith(1, 1).then(plan(1, 1, 2, 0)).then(prepare(1))
        .then(prepareOp(CHECK)).then(applyNext(P)).then(ackCheck(P)).then(commit(1))
        .then(applyNext(Q)).then(ackCheck(Q)).then(commitOp(CHECK)).then(applyNext(P))
        .expect(not(commitApplies) and not(noWriteWhileFenced))
}

// ---- 赤: DROP の場面 -----------------------------------------------------------

// 確かめるが、書き込みを止めない。確かめた後、DROP までの間の書き込みが消える (m14_red_no_lock)。
module m21_red_drop_no_fence {
  import m21_core(HAS_BUILD = false, HAS_CHECK = false, HAS_DROP = true, HAS_SPLIT = false, NTXN = 2, FIXED_INIT = true,
    REJECT_STALE = true, RECHECK = true, FENCE = false, DRAIN = true, CHECK_AT_EPOCH = true, GUARD_CHECK = true,
    ALL_ACKS = true, ONE_EXIT = true, ONE_OPEN = true, PIN = true, BUILD_VISIBLE = false,
    DDL_WAITS_MOVE = true, MOVE_WAITS_DDL = true, END_AFTER_DRAIN = true, PULL_AT_EPOCH = true, FENCE_IS_EPOCH = true, OWNER_CHECK = 0,
    SCHEMA_ON_PREPARE = true).*
  run dropNoFenceTest =
    initWith(1, 1).then(copy).then(prepareOp(DROP)).then(applyNext(P)).then(applyNext(Q)).then(ackDrop(P))
        .then(plan(1, 1, 2, 1)).then(prepare(1)).then(commit(1))
        .then(ackDrop(Q)).then(commitOp(DROP))
        .expect(not(guardHolds))
}
// 書き込みは止めるが、確かめない。copy の確定から禁止までの間の書き込みが消える (m14_red_no_check)。
module m21_red_drop_no_check {
  import m21_core(HAS_BUILD = false, HAS_CHECK = false, HAS_DROP = true, HAS_SPLIT = false, NTXN = 2, FIXED_INIT = true,
    REJECT_STALE = true, RECHECK = true, FENCE = true, DRAIN = true, CHECK_AT_EPOCH = true, GUARD_CHECK = false,
    ALL_ACKS = true, ONE_EXIT = true, ONE_OPEN = true, PIN = true, BUILD_VISIBLE = false,
    DDL_WAITS_MOVE = true, MOVE_WAITS_DDL = true, END_AFTER_DRAIN = true, PULL_AT_EPOCH = true, FENCE_IS_EPOCH = true, OWNER_CHECK = 0,
    SCHEMA_ON_PREPARE = true).*
  run dropNoCheckTest =
    initWith(1, 1).then(copy).then(plan(1, 1, 2, 0)).then(prepare(1)).then(commit(1))
        .then(prepareOp(DROP)).then(applyNext(P)).then(applyNext(Q)).then(ackDrop(P)).then(ackDrop(Q)).then(commitOp(DROP))
        .expect(not(guardHolds))
}
// prepare を適用する前に確かめる。確かめた後、適用までの間の書き込みが消える (m14_red_check_early)。
module m21_red_drop_check_early {
  import m21_core(HAS_BUILD = false, HAS_CHECK = false, HAS_DROP = true, HAS_SPLIT = false, NTXN = 2, FIXED_INIT = true,
    REJECT_STALE = true, RECHECK = true, FENCE = true, DRAIN = true, CHECK_AT_EPOCH = false, GUARD_CHECK = true,
    ALL_ACKS = true, ONE_EXIT = true, ONE_OPEN = true, PIN = true, BUILD_VISIBLE = false,
    DDL_WAITS_MOVE = true, MOVE_WAITS_DDL = true, END_AFTER_DRAIN = true, PULL_AT_EPOCH = true, FENCE_IS_EPOCH = true, OWNER_CHECK = 0,
    SCHEMA_ON_PREPARE = true).*
  run dropCheckEarlyTest =
    initWith(1, 1).then(copy).then(prepareOp(DROP)).then(ackDrop(P))
        .then(plan(1, 1, 2, 0)).then(prepare(1)).then(commit(1))
        .then(applyNext(P)).then(applyNext(Q)).then(ackDrop(Q)).then(commitOp(DROP))
        .expect(not(guardHolds))
}
// intent を決着させずに表定義の記録を適用する。確かめた後で、禁止の前の intent が確定する (m14_red_no_drain)。
// DROP を適用した後で確定すれば、消えた表に書き込みが適用される (m11_impl_drop)。
module m21_red_drop_no_drain {
  import m21_core(HAS_BUILD = false, HAS_CHECK = false, HAS_DROP = true, HAS_SPLIT = false, NTXN = 2, FIXED_INIT = true,
    REJECT_STALE = true, RECHECK = true, FENCE = true, DRAIN = false, CHECK_AT_EPOCH = true, GUARD_CHECK = true,
    ALL_ACKS = true, ONE_EXIT = true, ONE_OPEN = true, PIN = true, BUILD_VISIBLE = false,
    DDL_WAITS_MOVE = true, MOVE_WAITS_DDL = true, END_AFTER_DRAIN = true, PULL_AT_EPOCH = true, FENCE_IS_EPOCH = true, OWNER_CHECK = 0,
    SCHEMA_ON_PREPARE = true).*
  run dropNoDrainTest =
    initWith(1, 1).then(copy).then(plan(1, 1, 2, 0)).then(prepare(1))
        .then(prepareOp(DROP)).then(applyNext(P)).then(ackDrop(P)).then(commit(1))
        .then(applyNext(Q)).then(ackDrop(Q)).then(commitOp(DROP))
        .expect(not(guardHolds))
  run resurrectTest =
    initWith(1, 1).then(plan(1, 1, 2, 0)).then(prepare(1))
        .then(prepareOp(DROP)).then(applyNext(P)).then(applyNext(Q)).then(ackDrop(P)).then(ackDrop(Q)).then(commitOp(DROP))
        .then(applyNext(P)).expect(store.get(P) == 0)
        .then(commit(1))
        .expect(not(noResurrect) and store.get(P) == 2)
}
// DROP の commit が、禁止と結び付いていない。期限切れで禁止が解けた後に、commit が通る (m14_red_untied)。
module m21_red_drop_untied {
  import m21_core(HAS_BUILD = false, HAS_CHECK = false, HAS_DROP = true, HAS_SPLIT = false, NTXN = 2, FIXED_INIT = true,
    REJECT_STALE = true, RECHECK = true, FENCE = true, DRAIN = true, CHECK_AT_EPOCH = true, GUARD_CHECK = true,
    ALL_ACKS = true, ONE_EXIT = false, ONE_OPEN = true, PIN = true, BUILD_VISIBLE = false,
    DDL_WAITS_MOVE = true, MOVE_WAITS_DDL = true, END_AFTER_DRAIN = true, PULL_AT_EPOCH = true, FENCE_IS_EPOCH = true, OWNER_CHECK = 0,
    SCHEMA_ON_PREPARE = true).*
  run dropUntiedTest =
    initWith(1, 1).then(copy).then(prepareOp(DROP)).then(applyNext(P)).then(applyNext(Q)).then(ackDrop(P)).then(ackDrop(Q))
        .then(expire(DROP)).then(applyNext(P))
        .then(plan(1, 1, 2, 2)).then(prepare(1)).then(commit(1))
        .then(commitOp(DROP))
        .expect(not(guardHolds) and not(oneExit))
}
// 全シャードが prepare を適用する前に commit を記録し、DDL が完了を返す。古い表定義の Worker が、まだ適用していないシャードへ書き、
// 後から DROP が適用されて消える (m11_red_no_sync)。
module m21_red_drop_missing_ack {
  import m21_core(HAS_BUILD = false, HAS_CHECK = false, HAS_DROP = true, HAS_SPLIT = false, NTXN = 2, FIXED_INIT = true,
    REJECT_STALE = true, RECHECK = true, FENCE = true, DRAIN = true, CHECK_AT_EPOCH = true, GUARD_CHECK = true,
    ALL_ACKS = false, ONE_EXIT = true, ONE_OPEN = true, PIN = true, BUILD_VISIBLE = false,
    DDL_WAITS_MOVE = true, MOVE_WAITS_DDL = true, END_AFTER_DRAIN = true, PULL_AT_EPOCH = true, FENCE_IS_EPOCH = true, OWNER_CHECK = 0,
    SCHEMA_ON_PREPARE = true).*
  run dropMissingAckTest =
    initWith(1, 1).then(prepareOp(DROP)).then(applyNext(P)).then(ackDrop(P)).then(commitOp(DROP))
        .then(plan(1, 2, 2, 0)).then(prepare(1)).then(commit(1))
        .expect(not(noLostAfterReturn) and store.get(Q) == 2)
        .then(applyNext(Q)).then(applyNext(Q))
        .expect(store.get(Q) == 0)
}

// ---- 赤: 2 つの遷移が同時に開く --------------------------------------------------

// 表定義の遷移を、同時に 2 つ開く。index を作っている間に、同じ表の DROP が確定する。index の commit は、消えた表に適用できない。
// 取引は要らないので、置かない (反例が深く、取引があると探索に時間がかかる)。
module m21_red_two_open {
  import m21_core(HAS_BUILD = true, HAS_CHECK = false, HAS_DROP = true, HAS_SPLIT = false, NTXN = 0, FIXED_INIT = false,
    REJECT_STALE = true, RECHECK = true, FENCE = true, DRAIN = true, CHECK_AT_EPOCH = true, GUARD_CHECK = true,
    ALL_ACKS = true, ONE_EXIT = true, ONE_OPEN = false, PIN = true, BUILD_VISIBLE = false,
    DDL_WAITS_MOVE = true, MOVE_WAITS_DDL = true, END_AFTER_DRAIN = true, PULL_AT_EPOCH = true, FENCE_IS_EPOCH = true, OWNER_CHECK = 0,
    SCHEMA_ON_PREPARE = true).*
  run twoOpenTest =
    initWith(1, 0).then(prepareOp(BUILD)).then(prepareOp(DROP))
        .then(applyNext(P)).then(applyNext(P)).then(applyNext(Q)).then(applyNext(Q))
        .then(ackBuild(P)).then(ackBuild(Q)).then(ackDrop(P)).then(ackDrop(Q))
        .then(commitOp(DROP)).then(commitOp(BUILD))
        .then(applyNext(P)).then(applyNext(P))
        .expect(not(commitApplies))
}

// ---- 赤: 移動の場面 -------------------------------------------------------------

// 移動が開いている間に、表定義の遷移を開く。その epoch で計画した要求を、移動の途中の持ち主が断る (m15_red_no_slot)。
module m21_red_ddl_during_move {
  import m21_core(HAS_BUILD = false, HAS_CHECK = true, HAS_DROP = false, HAS_SPLIT = true, NTXN = 1, FIXED_INIT = true,
    REJECT_STALE = true, RECHECK = true, FENCE = true, DRAIN = true, CHECK_AT_EPOCH = true, GUARD_CHECK = true,
    ALL_ACKS = true, ONE_EXIT = true, ONE_OPEN = true, PIN = true, BUILD_VISIBLE = false,
    DDL_WAITS_MOVE = false, MOVE_WAITS_DDL = true, END_AFTER_DRAIN = true, PULL_AT_EPOCH = true, FENCE_IS_EPOCH = true, OWNER_CHECK = 0,
    SCHEMA_ON_PREPARE = true).*
  run ddlDuringMoveTest =
    initWith(1, 1).then(startSplit).then(applyNext(C)).then(prepareOp(CHECK)).then(read(2, 1))
        .expect(not(servable))
}
// 表定義の遷移が開いている間に、移動を開く。遷移の終わり (commit か abort) が、移動の途中に記録される。
// m15_red_no_based_on (分割の途中に、取り消しの版が入る) の後継である。
module m21_red_move_during_ddl {
  import m21_core(HAS_BUILD = false, HAS_CHECK = true, HAS_DROP = false, HAS_SPLIT = true, NTXN = 1, FIXED_INIT = true,
    REJECT_STALE = true, RECHECK = true, FENCE = true, DRAIN = true, CHECK_AT_EPOCH = true, GUARD_CHECK = true,
    ALL_ACKS = true, ONE_EXIT = true, ONE_OPEN = true, PIN = true, BUILD_VISIBLE = false,
    DDL_WAITS_MOVE = true, MOVE_WAITS_DDL = false, END_AFTER_DRAIN = true, PULL_AT_EPOCH = true, FENCE_IS_EPOCH = true, OWNER_CHECK = 0,
    SCHEMA_ON_PREPARE = true).*
  run moveDuringDdlTest =
    initWith(1, 1).then(prepareOp(CHECK)).then(startSplit).then(expire(CHECK))
        .then(applyNext(C)).then(applyNext(C)).then(read(3, 1))
        .expect(not(servable))
}
// 子が受け取り終える前に、end を記録する。その直後に開いた表定義の遷移を、受け取り中の子が適用できない (m15_red_early_release)。
module m21_red_end_early {
  import m21_core(HAS_BUILD = false, HAS_CHECK = true, HAS_DROP = false, HAS_SPLIT = true, NTXN = 1, FIXED_INIT = true,
    REJECT_STALE = true, RECHECK = true, FENCE = true, DRAIN = true, CHECK_AT_EPOCH = true, GUARD_CHECK = true,
    ALL_ACKS = true, ONE_EXIT = true, ONE_OPEN = true, PIN = true, BUILD_VISIBLE = false,
    DDL_WAITS_MOVE = true, MOVE_WAITS_DDL = true, END_AFTER_DRAIN = false, PULL_AT_EPOCH = true, FENCE_IS_EPOCH = true, OWNER_CHECK = 0,
    SCHEMA_ON_PREPARE = true).*
  run endEarlyTest =
    initWith(1, 1).then(startSplit).then(applyNext(C)).then(endSplit).then(prepareOp(CHECK)).then(applyNext(C)).then(read(3, 1))
        .expect(not(servable))
}
// pull が start の epoch を運ばない。親は、start を適用する前 (fence の前) に行を渡し、その後も古い範囲表の書き込みを受ける。
module m21_red_pull_unfenced {
  import m21_core(HAS_BUILD = false, HAS_CHECK = true, HAS_DROP = false, HAS_SPLIT = true, NTXN = 1, FIXED_INIT = true,
    REJECT_STALE = true, RECHECK = true, FENCE = true, DRAIN = true, CHECK_AT_EPOCH = true, GUARD_CHECK = true,
    ALL_ACKS = true, ONE_EXIT = true, ONE_OPEN = true, PIN = true, BUILD_VISIBLE = false,
    DDL_WAITS_MOVE = true, MOVE_WAITS_DDL = true, END_AFTER_DRAIN = true, PULL_AT_EPOCH = false, FENCE_IS_EPOCH = true, OWNER_CHECK = 0,
    SCHEMA_ON_PREPARE = true).*
  run pullUnfencedTest =
    initWith(1, 1).then(startSplit).then(applyNext(C)).then(pull)
        .then(plan(1, 1, 2, 0)).then(prepare(1)).then(commit(1))
        .expect(not(moveKeepsWrites) and store.get(P) == 2 and store.get(C) == 1)
        .then(read(1, 1))
        .expect(not(readConsistent))
  // 親が、確定した DDL をまだ適用していないのに、行を渡す。子の表と形が合わない。
  run pullOldShapeTest =
    initWith(1, 1).then(prepareOp(CHECK)).then(applyNext(P)).then(applyNext(Q)).then(ackCheck(P)).then(ackCheck(Q)).then(commitOp(CHECK))
        .then(startSplit).then(applyNext(C)).then(applyNext(C)).then(applyNext(C)).then(pull)
        .expect(not(sameShape))
}
// いまの実装。親の fence が、範囲表の切り替えより前の、別の手である。間で進める側が止まると、範囲表は親を指したまま、
// 親が断り続ける (未解決の問題 17、test/open/fenced-before-switch.test.ts)。
module m21_red_fence_first {
  import m21_core(HAS_BUILD = false, HAS_CHECK = true, HAS_DROP = false, HAS_SPLIT = true, NTXN = 1, FIXED_INIT = true,
    REJECT_STALE = true, RECHECK = true, FENCE = true, DRAIN = true, CHECK_AT_EPOCH = true, GUARD_CHECK = true,
    ALL_ACKS = true, ONE_EXIT = true, ONE_OPEN = true, PIN = true, BUILD_VISIBLE = false,
    DDL_WAITS_MOVE = true, MOVE_WAITS_DDL = true, END_AFTER_DRAIN = true, PULL_AT_EPOCH = true, FENCE_IS_EPOCH = false, OWNER_CHECK = 0,
    SCHEMA_ON_PREPARE = true).*
  run fenceFirstTest =
    initWith(1, 1).then(fenceFirst).then(die(SPLIT)).then(read(0, 1))
        .expect(not(servable) and len == 0)
}
// シャードが、所有を自分のスナップショットで引かない (表定義の epoch だけを比べる)。親が、渡した行への書き込みを受ける。
module m21_red_owner_unchecked {
  import m21_core(HAS_BUILD = false, HAS_CHECK = true, HAS_DROP = false, HAS_SPLIT = true, NTXN = 1, FIXED_INIT = true,
    REJECT_STALE = true, RECHECK = true, FENCE = true, DRAIN = true, CHECK_AT_EPOCH = true, GUARD_CHECK = true,
    ALL_ACKS = true, ONE_EXIT = true, ONE_OPEN = true, PIN = true, BUILD_VISIBLE = false,
    DDL_WAITS_MOVE = true, MOVE_WAITS_DDL = true, END_AFTER_DRAIN = true, PULL_AT_EPOCH = true, FENCE_IS_EPOCH = true, OWNER_CHECK = 2,
    SCHEMA_ON_PREPARE = true).*
  run ownerUncheckedTest =
    initWith(1, 1).then(startSplit).then(applyNext(P)).then(applyNext(C)).then(pull)
        .then(plan(1, 1, 2, 0)).then(prepare(1)).then(commit(1))
        .expect(not(moveKeepsWrites))
}
// シャードが、要求の epoch が自分の epoch と等しいことを求める。分割の記録を適用したシャードは、動いていない行の、
// 分割より前のスナップショットの取引まで断る。
module m21_red_strict_epoch {
  import m21_core(HAS_BUILD = false, HAS_CHECK = true, HAS_DROP = false, HAS_SPLIT = true, NTXN = 1, FIXED_INIT = true,
    REJECT_STALE = true, RECHECK = true, FENCE = true, DRAIN = true, CHECK_AT_EPOCH = true, GUARD_CHECK = true,
    ALL_ACKS = true, ONE_EXIT = true, ONE_OPEN = true, PIN = true, BUILD_VISIBLE = false,
    DDL_WAITS_MOVE = true, MOVE_WAITS_DDL = true, END_AFTER_DRAIN = true, PULL_AT_EPOCH = true, FENCE_IS_EPOCH = true, OWNER_CHECK = 1,
    SCHEMA_ON_PREPARE = true).*
  run strictEpochTest =
    initWith(1, 1).then(plan(1, 2, 2, 0)).then(startSplit).then(applyNext(Q)).then(prepare(1))
        .expect(not(pinnedSurvives) and not(txns.get(1).ok))
}

// ---- 時刻 -----------------------------------------------------------------------
//
// 時刻に依る 2 つの性質は、上のモデルに時計を足さず、小さなモデルで確かめる (M12 が index の中身と公開の時刻を分けたのと同じ)。
// どちらも、仕組みはいまの実装と変わらない。変わるのは、版の番号が epoch になり、禁止の版が prepare、終わりの版が commit か
// abort になることだけである。M12 と M14 を閉じるために、ここへ写した。

// 1. commit の時刻 (M12 の publishIsAPoint)。index の commit は、文の意味を変える (UNIQUE 違反で失敗する、衝突する行を消す)。
//    取引の直列な順序は時刻の順なので、commit も、時刻の順の中に 1 点を持たなければならない。
//
//      index を使わない書き込みの確定の時刻  <=  commit が運ぶ時刻 m  <=  index を使う文の読む時刻
//
//    行を埋める処理が、各シャードの行を読んだ時刻の最大を m として commit に載せる。シャードは、commit を適用するときに、
//    時計を m まで進める。上のモデルが示した次の 2 つを前提にする。
//      index を使わない書き込みは、prepare を適用したシャードでは確定しない (noWriteWhileFenced、REJECT_STALE)。
//      行を読む要求は prepare の epoch を運ぶので、読まれたシャードは prepare を適用している (CHECK_AT_EPOCH)。
module m21_clock_core {
  const COMMIT_CARRIES_CLOCK: bool    // commit が時刻 m を運び、シャードは適用のときに時計を m まで進める
  const SCAN_EVERY_SHARD: bool        // 行を埋める処理は、行のないシャードも読む (時刻を得るため)

  pure val SHARDS = Set(1, 2)
  pure val MAXC = 3                    // 時計の上限

  var len: int                  // Meta の最新の epoch。0 index なし、1 prepare、2 commit
  var ep: int -> int            // シャード -> 適用した epoch
  var clock: int -> int         // シャード -> 時計
  var scanT: int -> int         // シャード -> 行を読んだ時刻 (-1 = まだ読んでいない)
  var at: int                   // commit が運ぶ時刻
  var legacyMax: int            // ghost: index を使わない書き込みの確定の時刻の最大
  var awareOk: bool             // ghost: index を使う文が、index を使わない書き込みをすべて見た

  pure def max(a: int, b: int): int = if (a > b) a else b

  action init = all {
    len' = 0, ep' = SHARDS.mapBy(_ => 0), clock' = SHARDS.mapBy(_ => 0), scanT' = SHARDS.mapBy(_ => -1),
    at' = 0, legacyMax' = 0, awareOk' = true,
  }

  // 時計が進む (物理時刻、ほかの表の書き込み)
  action tick(s: int): bool = all {
    clock.get(s) < MAXC,
    clock' = clock.set(s, clock.get(s) + 1),
    len' = len, ep' = ep, scanT' = scanT, at' = at, legacyMax' = legacyMax, awareOk' = awareOk,
  }

  // index を使わない書き込みが確定する。prepare を適用したシャードでは起きない。
  action legacyWrite(s: int): bool = all {
    ep.get(s) == 0,
    clock.get(s) < MAXC,
    clock' = clock.set(s, clock.get(s) + 1),
    legacyMax' = max(legacyMax, clock.get(s) + 1),
    len' = len, ep' = ep, scanT' = scanT, at' = at, awareOk' = awareOk,
  }

  action prepareOp = all {
    len == 0, len' = 1,
    ep' = ep, clock' = clock, scanT' = scanT, at' = at, legacyMax' = legacyMax, awareOk' = awareOk,
  }

  // シャードが次の記録を適用する。commit なら、時計を m まで進める。
  action applyNext(s: int): bool = all {
    ep.get(s) < len,
    ep' = ep.set(s, ep.get(s) + 1),
    clock' = if (COMMIT_CARRIES_CLOCK and ep.get(s) == 1) clock.set(s, max(clock.get(s), at)) else clock,
    len' = len, scanT' = scanT, at' = at, legacyMax' = legacyMax, awareOk' = awareOk,
  }

  // 行を埋める処理が、シャードの行を読む。応答に、読んだ時刻が付く。
  action scan(s: int): bool = all {
    len == 1, ep.get(s) == 1, scanT.get(s) < 0,
    scanT' = scanT.set(s, clock.get(s)),
    len' = len, ep' = ep, clock' = clock, at' = at, legacyMax' = legacyMax, awareOk' = awareOk,
  }

  // commit を記録する。行のあるシャードは全部読んである。SCAN_EVERY_SHARD でなければ、行のないシャード (ここではシャード 2) を読まない。
  action commitOp = all {
    len == 1,
    if (SCAN_EVERY_SHARD) SHARDS.forall(s => scanT.get(s) >= 0) else scanT.get(1) >= 0,
    len' = 2,
    at' = SHARDS.fold(0, (m, s) => max(m, scanT.get(s))),
    ep' = ep, clock' = clock, scanT' = scanT, legacyMax' = legacyMax, awareOk' = awareOk,
  }

  // index を使う文が、シャード s で読む時刻を決める。commit を適用したシャードだけが、その計画を受ける。
  action awareRead(s: int): bool = all {
    len == 2, ep.get(s) == 2,
    awareOk' = (awareOk and clock.get(s) >= legacyMax),
    len' = len, ep' = ep, clock' = clock, scanT' = scanT, at' = at, legacyMax' = legacyMax,
  }

  action step = any {
    { nondet s = oneOf(SHARDS) tick(s) },
    { nondet s = oneOf(SHARDS) legacyWrite(s) },
    prepareOp,
    { nondet s = oneOf(SHARDS) applyNext(s) },
    { nondet s = oneOf(SHARDS) scan(s) },
    commitOp,
    { nondet s = oneOf(SHARDS) awareRead(s) },
  }

  // index を使う文は、index を使わない書き込みを全部見る (時刻の順で、commit の後ろにいる)
  val commitIsAPoint = awareOk
  // commit の後、時計の遅かったシャードで index を使う文が読む
  val witnessAwareOnSlowShard = not(len == 2 and ep.get(2) == 2 and legacyMax == 2 and scanT.get(2) == 0 and awareOk)
}

module m21_clock_green {
  import m21_clock_core(COMMIT_CARRIES_CLOCK = true, SCAN_EVERY_SHARD = true).*
}

// commit が時刻を運ばない。時計の遅いシャードで index を使う文が、別のシャードの古い書き込みより前の時刻で読む (m12_clock_red_no_clock)。
module m21_clock_red_no_clock {
  import m21_clock_core(COMMIT_CARRIES_CLOCK = false, SCAN_EVERY_SHARD = true).*
  run slowShardTest =
    init.then(legacyWrite(1)).then(legacyWrite(1))               // シャード 1 の時計は 2
        .then(prepareOp).then(applyNext(1)).then(applyNext(2)).then(scan(1)).then(scan(2)).then(commitOp)
        .then(applyNext(2)).then(awareRead(2))                    // シャード 2 の時計は 0 のまま
        .expect(not(commitIsAPoint))
}

// 行のないシャードを読まない。そのシャードで、読まれる前に確定した書き込み (行を消すなど) の時刻が、m に入らない (m12_clock_red_skip_empty)。
module m21_clock_red_skip_empty {
  import m21_clock_core(COMMIT_CARRIES_CLOCK = true, SCAN_EVERY_SHARD = false).*
  run skipEmptyTest =
    init.then(legacyWrite(2)).then(legacyWrite(2))               // 行のないシャード 2 で、行を消す書き込みが時刻 2 で確定した
        .then(prepareOp).then(applyNext(1)).then(scan(1)).then(commitOp)
        .then(applyNext(1)).then(awareRead(1))                    // シャード 1 の時計は 0 のまま
        .expect(not(commitIsAPoint))
}

// 2. DROP の前の確かめが比べる時刻 (M14)。copy の確定の時刻ではなく、読んだ時刻と比べる。copy が読んだシャードは、どれも
//    読んだ時刻を見ている (読みの要求が時刻を運ぶ) ので、その後の書き込みは、どのシャードでも、それより大きい時刻になる。
//    確定の時刻は、参加していないシャードが見ていないことがある。
//
//    M14 を、epoch の言葉に直して写した。ほかの条件 (書き込み禁止、prepare を適用した後で確かめる、intent の決着、
//    commit は禁止の唯一の終わり方) は、上のモデルが外して確かめているので、ここでは設計どおりに固定する。
//    古い表の行を持つシャード 2 つ、別の接続の書き込み (受け付けと確定の 2 段) 2 回まで、時計 0〜5。
module m21_guard_core {
  const CHECK_FROM_READ: bool     // copy の読んだ時刻と比べる (false なら確定の時刻と比べる)

  pure val SHARDS = Set(1, 2)
  pure val MAXC = 5

  // phase: 0 copy の前、1 copy を確定した、2 prepare を記録した、3 commit (DROP) を記録した、4 abort を記録した、9 copy が断られた
  var phase: int
  var clock: int -> int
  var T: int                    // copy の読んだ時刻 (-1 はまだ読んでいない)
  var c: int                    // copy の確定の時刻
  var applied: int -> bool      // シャードが prepare を適用した
  var acked: int -> bool        // シャードが確かめて、ok と答えた
  var writes: int -> Set[int]   // シャード -> 確定した書き込みの時刻
  var pend: int -> bool         // シャードに、別の接続の書き込みの intent がある
  var left: int                 // 残りの書き込みの回数
  var late: int                 // ghost: copy が読んだ後に確定した書き込みの数
  var exits: int                // ghost

  pure def max(a: int, b: int): int = if (a > b) a else b

  action init = all {
    phase' = 0, clock' = SHARDS.mapBy(_ => 0), T' = -1, c' = -1,
    applied' = SHARDS.mapBy(_ => false), acked' = SHARDS.mapBy(_ => false),
    writes' = SHARDS.mapBy(_ => Set()), pend' = SHARDS.mapBy(_ => false), left' = 2, late' = 0, exits' = 0,
  }

  /** 禁止が効いているか。prepare を適用していて、遷移がまだ開いている。commit の後は表がない。 */
  def fenced(s: int): bool = applied.get(s) and phase == 2
  def gone: bool = phase == 3

  // ---- 別の接続の書き込み ----
  action otherPrepare(s: int): bool = all {
    left > 0, not(pend.get(s)), not(fenced(s)), not(gone),
    pend' = pend.set(s, true), left' = left - 1,
    phase' = phase, clock' = clock, T' = T, c' = c, applied' = applied, acked' = acked, writes' = writes, late' = late, exits' = exits,
  }
  action otherCommit(s: int): bool = all {
    pend.get(s), not(gone),
    val ts = clock.get(s) + 1
    all {
      ts <= MAXC,
      clock' = clock.set(s, ts), writes' = writes.set(s, writes.get(s).union(Set(ts))), pend' = pend.set(s, false),
      late' = if (T >= 0) late + 1 else late,
      phase' = phase, T' = T, c' = c, applied' = applied, acked' = acked, left' = left, exits' = exits,
    }
  }
  /** 時計が進む (ほかの表の書き込み)。 */
  action tick(s: int): bool = all {
    clock.get(s) < MAXC,
    clock' = clock.set(s, clock.get(s) + 1),
    phase' = phase, T' = T, c' = c, applied' = applied, acked' = acked, writes' = writes, pend' = pend, left' = left, late' = late, exits' = exits,
  }

  // ---- 移行の取引 ----
  /** copy が古い表を全シャードで読む。読みの要求が時刻を運ぶので、どのシャードも T を見る。 */
  action copyRead = all {
    phase == 0, T < 0,
    val t = SHARDS.fold(0, (m, s) => max(m, clock.get(s)))
    all { T' = t, clock' = SHARDS.mapBy(s => max(clock.get(s), t)),
      phase' = phase, c' = c, applied' = applied, acked' = acked, writes' = writes, pend' = pend, left' = left, late' = late, exits' = exits },
  }
  /** copy の区切りを確定する。読んだ後に変更か intent があれば、検証が断る。確定の時刻は anchor (シャード 1) だけが見る。 */
  action copyCommit = all {
    phase == 0, T >= 0,
    val stale = SHARDS.exists(s => writes.get(s).exists(w => w > T) or pend.get(s))
    val ts = max(clock.get(1), T) + 1
    all {
      ts <= MAXC,
      phase' = if (stale) 9 else 1,
      c' = if (stale) c else ts,
      clock' = if (stale) clock else clock.set(1, ts),
      T' = T, applied' = applied, acked' = acked, writes' = writes, pend' = pend, left' = left, late' = late, exits' = exits,
    }
  }
  /** Meta が prepare を記録する。古い表を書き込み禁止にする。 */
  action prepareOp = all {
    phase == 1,
    phase' = 2,
    clock' = clock, T' = T, c' = c, applied' = applied, acked' = acked, writes' = writes, pend' = pend, left' = left, late' = late, exits' = exits,
  }
  /** シャードが prepare を適用する。intent が残っている間は適用しない (決着を待つ)。 */
  action applyPrepare(s: int): bool = all {
    phase >= 2, not(applied.get(s)),
    not(pend.get(s)),
    applied' = applied.set(s, true),
    phase' = phase, clock' = clock, T' = T, c' = c, acked' = acked, writes' = writes, pend' = pend, left' = left, late' = late, exits' = exits,
  }
  /** シャードが、prepare を適用した後で、copy の後の変更を確かめる。変更があれば、abort を記録する。 */
  action ack(s: int): bool = all {
    phase == 2, not(acked.get(s)), applied.get(s),
    val since = if (CHECK_FROM_READ) T else c
    val changed = writes.get(s).exists(w => w > since)
    all {
      acked' = if (changed) acked else acked.set(s, true),
      phase' = if (changed) 4 else phase,
      exits' = if (changed) exits + 1 else exits,
      clock' = clock, T' = T, c' = c, applied' = applied, writes' = writes, pend' = pend, left' = left, late' = late,
    }
  }
  /** Meta が commit (DROP) を記録する。遷移が開いていて、全シャードが ok と答えたときだけ。 */
  action commitOp = all {
    phase == 2,
    SHARDS.forall(s => acked.get(s)),
    phase' = 3, exits' = exits + 1,
    clock' = clock, T' = T, c' = c, applied' = applied, acked' = acked, writes' = writes, pend' = pend, left' = left, late' = late,
  }
  /** 期限切れ。移行の取引が止まっても、禁止は解ける。 */
  action expire = all {
    phase == 2,
    phase' = 4, exits' = exits + 1,
    clock' = clock, T' = T, c' = c, applied' = applied, acked' = acked, writes' = writes, pend' = pend, left' = left, late' = late,
  }

  action step = any {
    { nondet s = oneOf(SHARDS) otherPrepare(s) },
    { nondet s = oneOf(SHARDS) otherCommit(s) },
    { nondet s = oneOf(SHARDS) tick(s) },
    copyRead, copyCommit, prepareOp,
    { nondet s = oneOf(SHARDS) applyPrepare(s) },
    { nondet s = oneOf(SHARDS) ack(s) },
    commitOp, expire,
  }

  val noLostWrite = not(phase == 3 and late > 0)
  val oneExit = exits <= 1
  val guardSafe = noLostWrite and oneExit

  // witness
  val witnessDroppedAfterWrites = not(phase == 3 and SHARDS.exists(s => writes.get(s) != Set()))
  val witnessRefusedByCheck = not(phase == 4 and SHARDS.exists(s => acked.get(s) == false and applied.get(s)) and exits == 1 and late > 0)
}

module m21_guard_green {
  import m21_guard_core(CHECK_FROM_READ = true).*
}

// copy の確定の時刻と比べる。確定の時刻を見ていないシャードで、それより小さい時刻の書き込みを見逃す (m14_red_commit_ts)。
module m21_guard_red_commit_ts {
  import m21_guard_core(CHECK_FROM_READ = false).*
  run commitTsTest =
    init.then(copyRead).then(copyCommit)                          // T = 0。確定の時刻 c = 1 は、シャード 1 だけが見る
        .expect(phase == 1 and c == 1 and clock.get(2) == 0)
        .then(otherPrepare(2)).then(otherCommit(2))               // シャード 2 の書き込みは、時刻 1 で確定する (c より大きくない)
        .then(prepareOp).then(applyPrepare(1)).then(applyPrepare(2)).then(ack(1)).then(ack(2))
        .then(commitOp)
        .expect(not(noLostWrite))
}
