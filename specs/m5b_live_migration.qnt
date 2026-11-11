// M5b: pull 型ライブ再構成 (S2 + S3) の検査
//
// 親 P (=1)、子 C (=2)、移動する範囲に shard key グループ 2 個 (1, 2)。
// S2: 範囲の所有権を Meta で先に C へ切り替え、C は未移動グループに要求が来たら P から pull する。
// S3: 移動を時刻 m の取引として扱う (親は delete@m、子は insert@m)。T < m の読みは親が undo で復元して答え、
//     子は insert@m を undo して答える。
// 書き込みは blind write (id)。クロスシャード取引 X (id 3) はグループ 1 に intent を置き、anchor が c を決め、
// phase 2 は prepare した DO へ届く。読み手は T を持って P か C のどちらかに行く (stale routing / scatter の両方を表す)。
//
// invariants
//   singleOwner:     C が受理したグループへの write を、その後 P が受理しない
//   readConsistent:  DO が答えた読み (NotOwner / ReadTooOld 以外) は、T 時点の真の値 (受理済み commit の c <= T の最新) と一致
//   noLostWrite:     移動後のグループの子の最新値は、受理済み commit の最新と一致
//   intentNotLost:   intent は現在そのグループを持つ DO にある (非オーナーに残らない)
//   noWriteBelowRead: 答えた読みの時刻以下の時刻で、同じグループへの書き込みが受理されない
//
// 範囲の移動を終える手順 (finishRange)。親に行のないグループは pull されない。範囲の移動が終わると、子はそのグループを
// 到着なしで受け持つ。pull されたグループは時刻 m を運ぶので、子の時計は m まで進む。pull されないグループは何も運ばない。
// 親が「行はない」と答えた読みの時刻より小さい時刻で、子が書き込みを受理すると、その読みは、後から書き込みの後になる。
// FINISH_CARRIES_CLOCK は、移動を終えるときに親の時計を子へ渡す (修正版)。
module m5b_core {
  const MOVE_AS_TXN: bool        // S3: 移動を delete@m / insert@m として記録する。false なら版を保って物理的に移す
  const PARENT_SERVES_OLD: bool  // 親が移動済みグループの T < m の読みを undo で答える (S3)。false なら常に NotOwner
  const CHILD_UNDO_OLD: bool     // 子が T < m の読みを undo で答える (S3 の字義)。false なら ReadTooOld(m) を返す
  const P2_MODE: int             // phase 2 の宛先。0: prepare した DO に適用 (anchor の参加者リストのまま)
                                 //                 1: intent が物理的にある DO に適用 (S3 の字義: intent はグループと一緒に移る)
                                 //                 2: moved 表で現オーナーを決め、未到着なら待つ (修正版)
  const MOVE_INTENTS: bool       // pull で intent も運ぶ
  const FINISH_CARRIES_CLOCK: bool  // 範囲の移動を終えるとき、親の時計を子へ渡す
  const TRACK_READS: bool        // 答えた読みの時刻を覚える (noWriteBelowRead のための ghost。状態が増えるので、小さい定数で使う)
  const CLOCK_MAX: int
  const T_MAX: int

  pure val P = 1
  pure val C = 2
  pure val DOMS = Set(P, C)
  pure val GROUPS = Set(1, 2)
  pure val WRITES = Set(1, 2)
  pure val X = 3                        // クロスシャード取引の id。グループ 1 に書く
  pure val WORKERS = Set(1, 2)
  pure val TOMB = -1                    // S3 の delete@m
  pure def groupOf(id: int): int = if (id == 2) 2 else 1
  pure def max(a: int, b: int): int = if (a > b) a else b

  type Ver = { ver: int, writer: int }
  type Intent = { where: int, pts: int, c: int, pushed: int, preparedAt: int }   // where: 0 無し, 1 P, 2 C, 3 適用済み
  type Pull = { g: int, m: int, data: Set[Ver], withIntent: bool }                // g == 0 なら送信中の pull 無し
  type Bad = { g: int, t: int, dom: int, got: int, want: int }

  var hlc: int -> int
  var hist: int -> (int -> Set[Ver])      // DO -> group -> 保持している版
  var moved: int -> int                   // P: group -> m (0 = 未移動)
  var arrived: int -> int                 // C: group -> m (0 = 未到着)
  var fenced: bool                        // P が範囲への新規受理を止めた
  var route: int                          // Meta の経路
  var cache: int -> int                   // Worker のキャッシュ
  var pending: Set[int]
  var truth: int -> Set[Ver]              // ghost: 受理 (適用) 済み commit
  var cAccepted: Set[int]                 // ghost: C が write を受理したグループ
  var dual: bool                          // ghost
  var pullMsg: Pull
  var intent: Intent
  var badRead: bool
  var lastBad: Bad
  var open: Set[int]                      // C: 到着なしで受け持つグループ (範囲の移動が終わり、親に行がなかった)
  var served: int -> int                  // ghost: group -> 答えた読みの時刻の最大
  var lateWrite: bool                     // ghost: 答えた読みの時刻以下で、書き込みを受理した

  pure val noPull: Pull = { g: 0, m: 0, data: Set(), withIntent: false }
  pure val noBad: Bad = { g: 0, t: 0, dom: 0, got: 0, want: 0 }
  pure val initVers: Set[Ver] = Set({ ver: 0, writer: 0 })

  pure def latest(vs: Set[Ver]): Ver =
    vs.fold({ ver: -1, writer: -1 }, (acc, v) => if (v.ver > acc.ver) v else acc)
  pure def valueAt(vs: Set[Ver], t: int): int =
    latest(vs.filter(v => v.ver <= t)).writer
  // 版を保って移すときの子の初期履歴。S3 では insert@m 1 本に潰す
  pure def arrivalHist(data: Set[Ver], m: int): Set[Ver] =
    if (MOVE_AS_TXN) Set({ ver: m, writer: latest(data).writer }) else data

  action init = all {
    hlc' = DOMS.mapBy(_ => 0),
    hist' = Map(P -> GROUPS.mapBy(_ => initVers), C -> GROUPS.mapBy(_ => Set())),
    moved' = GROUPS.mapBy(_ => 0), arrived' = GROUPS.mapBy(_ => 0),
    fenced' = false, route' = P, cache' = WORKERS.mapBy(_ => P),
    pending' = WRITES, truth' = GROUPS.mapBy(_ => initVers),
    cAccepted' = Set(), dual' = false, pullMsg' = noPull,
    intent' = { where: 0, pts: 0, c: 0, pushed: 0, preparedAt: 0 },
    badRead' = false, lastBad' = noBad,
    open' = Set(), served' = GROUPS.mapBy(_ => 0), lateWrite' = false
  }

  action keepMove = all { moved' = moved, arrived' = arrived, fenced' = fenced, route' = route, pullMsg' = pullMsg, open' = open }
  action keepWrites = all { pending' = pending, truth' = truth, cAccepted' = cAccepted, dual' = dual, hist' = hist, lateWrite' = lateWrite }
  action keepRead = all { badRead' = badRead, lastBad' = lastBad, served' = served }

  def holds(d: int, g: int): bool = if (d == P) moved.get(g) == 0 else (arrived.get(g) > 0 or open.contains(g))

  // ---- 時計 ---------------------------------------------------------------
  action tick(d: int): bool = all {
    hlc.get(d) < CLOCK_MAX,
    hlc' = hlc.set(d, hlc.get(d) + 1),
    cache' = cache, intent' = intent, keepMove, keepWrites, keepRead
  }

  // ---- 所有権の切替 -------------------------------------------------------
  // 親が範囲への受理を止める (修正版の手順。S2 の字義では無い)
  action fence = all {
    not(fenced), fenced' = true,
    moved' = moved, arrived' = arrived, route' = route, pullMsg' = pullMsg, open' = open,
    hlc' = hlc, cache' = cache, intent' = intent, keepWrites, keepRead
  }
  // Meta が経路を子へ切り替える
  action switchRoute = all {
    route == P, route' = C,
    moved' = moved, arrived' = arrived, fenced' = fenced, pullMsg' = pullMsg, open' = open,
    hlc' = hlc, cache' = cache, intent' = intent, keepWrites, keepRead
  }
  action refreshCache(w: int): bool = all {
    cache' = cache.set(w, route),
    hlc' = hlc, intent' = intent, keepMove, keepWrites, keepRead
  }

  // ---- 書き込み (blind) --------------------------------------------------------
  action write(w: int, id: int): bool = all {
    pending.contains(id),
    val g = groupOf(id)
    val d = cache.get(w)
    any {
      // 親: 移動済み、または fence 済みなら NotOwner → キャッシュ更新
      all {
        d == P, moved.get(g) > 0 or fenced,
        cache' = cache.set(w, C),
        hlc' = hlc, keepWrites
      },
      // 親が受理
      all {
        d == P, moved.get(g) == 0, not(fenced),
        val c = hlc.get(P) + 1
        all {
          hlc' = hlc.set(P, c),
          hist' = hist.set(P, hist.get(P).set(g, hist.get(P).get(g).union(Set({ ver: c, writer: id })))),
          truth' = truth.set(g, truth.get(g).union(Set({ ver: c, writer: id }))),
          pending' = pending.exclude(Set(id)),
          dual' = (dual or cAccepted.contains(g)),
          lateWrite' = (lateWrite or c <= served.get(g)),
          cAccepted' = cAccepted, cache' = cache
        }
      },
      // 子が受理 (到着済みのグループか、到着なしで受け持つグループ。未到着なら pull が先)
      all {
        d == C, holds(C, g),
        val c = hlc.get(C) + 1
        all {
          hlc' = hlc.set(C, c),
          hist' = hist.set(C, hist.get(C).set(g, hist.get(C).get(g).union(Set({ ver: c, writer: id })))),
          truth' = truth.set(g, truth.get(g).union(Set({ ver: c, writer: id }))),
          pending' = pending.exclude(Set(id)),
          cAccepted' = cAccepted.union(Set(g)),
          lateWrite' = (lateWrite or c <= served.get(g)),
          dual' = dual, cache' = cache
        }
      }
    },
    intent' = intent, keepMove, keepRead
  }

  // ---- pull -------------------------------------------------------------------
  // 子が親にグループを要求し、親が応答する (1 アクション)。親は moved[g] = m を永続化してから応答する。
  // 再送 (親または子の再起動で応答が失われた後) は同じ m と保持した行イメージで答える (冪等)。
  action pull(g: int): bool = all {
    route == C or fenced,                 // 子が自分を新オーナーと知っている
    arrived.get(g) == 0, not(open.contains(g)),
    pullMsg.g == 0,
    val first = moved.get(g) == 0
    val m = if (first) hlc.get(P) + 1 else moved.get(g)
    val data = hist.get(P).get(g).filter(v => v.writer != TOMB)
    val carry = MOVE_INTENTS and intent.where == P and groupOf(X) == g
    all {
      moved' = moved.set(g, m),
      hlc' = if (first) hlc.set(P, m) else hlc,
      // S3: 親に delete@m を記録 (初回のみ)
      hist' = if (first and MOVE_AS_TXN)
                hist.set(P, hist.get(P).set(g, hist.get(P).get(g).union(Set({ ver: m, writer: TOMB }))))
              else hist,
      pullMsg' = { g: g, m: m, data: data, withIntent: carry },
      arrived' = arrived, fenced' = fenced, route' = route, open' = open,
      pending' = pending, truth' = truth, cAccepted' = cAccepted, dual' = dual, lateWrite' = lateWrite,
      cache' = cache, intent' = intent, keepRead
    }
  }

  // 子が pull の応答を受け取り、グループを持つ。HLC を m まで進める。intent が同梱されていれば子へ移す
  action recvPull = all {
    pullMsg.g != 0,
    val g = pullMsg.g
    val m = pullMsg.m
    all {
      arrived' = arrived.set(g, m),
      hlc' = hlc.set(C, max(hlc.get(C), m)),
      hist' = hist.set(C, hist.get(C).set(g, arrivalHist(pullMsg.data, m))),
      intent' = if (pullMsg.withIntent and intent.where == P) intent.with("where", C) else intent,
      pullMsg' = noPull,
      moved' = moved, fenced' = fenced, route' = route, open' = open,
      pending' = pending, truth' = truth, cAccepted' = cAccepted, dual' = dual, lateWrite' = lateWrite,
      cache' = cache, keepRead
    }
  }

  // 応答が失われる (親または子の再起動)。子は後で pull をやり直す
  action losePull = all {
    pullMsg.g != 0,
    pullMsg' = noPull,
    moved' = moved, arrived' = arrived, fenced' = fenced, route' = route, open' = open,
    hlc' = hlc, cache' = cache, intent' = intent, keepWrites, keepRead
  }

  // ---- 範囲の移動を終える -----------------------------------------------------
  // pull されなかったグループ (親に行も intent もない) を、子が到着なしで受け持つ。実装では、drain が行のあるグループを
  // 運び終えた後の finishMove と finishIncoming にあたる。親は、時刻を発行して、このグループをもう答えないことを記録する。
  // FINISH_CARRIES_CLOCK なら、その時刻を子へ渡し、子は時計をそこまで進める。
  action finishRange = all {
    fenced, route == C, pullMsg.g == 0,
    GROUPS.exists(g => moved.get(g) == 0),
    GROUPS.forall(g => moved.get(g) > 0 or
      (hist.get(P).get(g) == initVers and not(intent.where == P and groupOf(X) == g))),
    GROUPS.forall(g => moved.get(g) == 0 or arrived.get(g) > 0),
    val m = hlc.get(P) + 1
    val rest = GROUPS.filter(g => moved.get(g) == 0)
    all {
      hlc' = hlc.set(P, m).set(C, if (FINISH_CARRIES_CLOCK) max(hlc.get(C), m) else hlc.get(C)),
      moved' = GROUPS.mapBy(g => if (rest.contains(g)) m else moved.get(g)),
      open' = open.union(rest),
      hist' = hist.set(C, GROUPS.mapBy(g => if (rest.contains(g)) initVers else hist.get(C).get(g))),
      arrived' = arrived, fenced' = fenced, route' = route, pullMsg' = pullMsg,
      pending' = pending, truth' = truth, cAccepted' = cAccepted, dual' = dual, lateWrite' = lateWrite,
      cache' = cache, intent' = intent, keepRead
    }
  }

  // ---- クロスシャード取引 X (グループ 1) ------------------------------------------
  // prepare はグループを持つ DO に届く (anchor は経路表を見るが、移動中は親に届くこともある)
  action prepareX(d: int): bool = all {
    intent.where == 0,
    holds(d, groupOf(X)),
    d == P or route == C,
    val pts = hlc.get(d) + 1
    all {
      hlc' = hlc.set(d, pts),
      intent' = { where: d, pts: pts, c: 0, pushed: 0, preparedAt: d },
      cache' = cache, keepMove, keepWrites, keepRead
    }
  }
  // anchor が c を決める (他参加者の prepare_ts 次第で pts 以上の任意の値。push があればそれより大きい)
  action decideX(c: int): bool = all {
    intent.where == P or intent.where == C,
    intent.c == 0,
    c >= intent.pts, c > intent.pushed, c <= intent.pts + 2,
    intent' = intent.with("c", c),
    hlc' = hlc, cache' = cache, keepMove, keepWrites, keepRead
  }
  // phase 2: prepare した DO へ届く。宛先の決め方は P2_MODE。
  //   0: prepare した DO (親) に適用。intent が子へ移っていても親に書く
  //   1: intent が物理的にある DO に適用。pull の応答が飛んでいる間 (m は決まったが子は未到着) は親にあるので親に書く
  //   2: moved 表でオーナーを決める。親が m を決めた後は常に子。子が未到着なら適用せず待つ (anchor の alarm が再駆動)
  action phase2X = all {
    intent.c > 0,
    intent.where == P or intent.where == C,
    val g = groupOf(X)
    val owner = if (moved.get(g) > 0) C else P
    val target = if (P2_MODE == 0) intent.preparedAt else if (P2_MODE == 1) intent.where else owner
    val c = intent.c
    all {
      P2_MODE != 2 or holds(target, g),
      hist' = hist.set(target, hist.get(target).set(g, hist.get(target).get(g).union(Set({ ver: c, writer: X })))),
      truth' = truth.set(g, truth.get(g).union(Set({ ver: c, writer: X }))),
      hlc' = hlc.set(target, max(hlc.get(target), c)),
      intent' = intent.with("where", 3),
      pending' = pending, cAccepted' = cAccepted, dual' = dual,
      lateWrite' = (lateWrite or c <= served.get(g)),
      cache' = cache, keepMove, keepRead
    }
  }

  // ---- 読み -------------------------------------------------------------------
  // 読み手は T を持って d に行く。答えが返るなら真の値と比べる。NotOwner / ReadTooOld / 未到着は答えでない。
  // intent がある DO では、pts <= T かつ c 未決定なら push (c > T を強制)、c 決定済みで c <= T かつ未適用なら待つ。
  def truthAt(g: int, t: int): int = valueAt(truth.get(g), t)
  def answersAtP(g: int, t: int): bool =
    moved.get(g) == 0 or (PARENT_SERVES_OLD and t < moved.get(g))
  def answersAtC(g: int, t: int): bool =
    (arrived.get(g) > 0 and (t >= arrived.get(g) or CHILD_UNDO_OLD)) or open.contains(g)
  def intentBlocks(d: int, g: int, t: int): bool =
    intent.where == d and groupOf(X) == g and intent.pts <= t and intent.c > 0 and intent.c <= t
  def intentPushes(d: int, g: int, t: int): bool =
    intent.where == d and groupOf(X) == g and intent.pts <= t and intent.c == 0

  action read(d: int, g: int, t: int): bool = all {
    if (d == P) answersAtP(g, t) else answersAtC(g, t),
    not(intentBlocks(d, g, t)),
    val got = valueAt(hist.get(d).get(g), t)
    val want = truthAt(g, t)
    all {
      intent' = if (intentPushes(d, g, t)) intent.with("pushed", max(intent.pushed, t)) else intent,
      badRead' = (badRead or got != want),
      lastBad' = if (not(badRead) and got != want) { g: g, t: t, dom: d, got: got, want: want } else lastBad,
      served' = if (TRACK_READS) served.set(g, max(served.get(g), t)) else served,
      hlc' = hlc.set(d, max(hlc.get(d), t)),
      cache' = cache, keepMove, keepWrites
    }
  }

  action step = any {
    { nondet d = oneOf(DOMS) tick(d) },
    fence,
    switchRoute,
    { nondet w = oneOf(WORKERS) refreshCache(w) },
    { nondet w = oneOf(WORKERS) nondet id = oneOf(WRITES) write(w, id) },
    { nondet g = oneOf(GROUPS) pull(g) },
    recvPull,
    losePull,
    finishRange,
    { nondet d = oneOf(DOMS) prepareX(d) },
    { nondet c = oneOf(1.to(CLOCK_MAX + 6)) decideX(c) },
    phase2X,
    { nondet d = oneOf(DOMS) nondet g = oneOf(GROUPS) nondet t = oneOf(0.to(T_MAX)) read(d, g, t) }
  }

  // ---- 不変条件 -------------------------------------------------------------
  val singleOwner = not(dual)
  val readConsistent = not(badRead)
  val noLostWrite = GROUPS.forall(g =>
    not(holds(C, g)) or latest(hist.get(C).get(g)).writer == latest(truth.get(g)).writer)
  // 子にグループが到着するまでは親が intent を保持してよい (pull の応答に同梱され、再送でも運ばれる)。
  // 到着後に親に残っていれば非オーナーに取り残されている。
  val intentNotLost =
    (intent.where != P or not(holds(C, groupOf(X)))) and (intent.where != C or holds(C, groupOf(X)))
  // 答えた読みの時刻以下で、同じグループへの書き込みが受理されると、その読みは、後から書き込みの後になる。
  val noWriteBelowRead = not(lateWrite)
  val migrationSafe = singleOwner and readConsistent and noLostWrite and intentNotLost and noWriteBelowRead

  // witness
  val witnessMovedAndWritten = not(GROUPS.forall(g => arrived.get(g) > 0) and pending == Set()
                                   and cAccepted != Set() and intent.where == 3)
  val witnessIntentMovedThenApplied = not(intent.where == 3 and intent.preparedAt == P and arrived.get(groupOf(X)) > 0
                                          and latest(hist.get(C).get(groupOf(X))).writer == X)
  val witnessOpenWritten = not(open != Set() and cAccepted.intersect(open) != Set())
}

// 修正版 (green): 版を保って物理的に移す。親は移動済みグループに NotOwner、子は T < m に ReadTooOld。
// phase 2 は intent のある DO へ転送。intent は pull で運ぶ。
module m5b_green {
  import m5b_core(MOVE_AS_TXN = false, PARENT_SERVES_OLD = false, CHILD_UNDO_OLD = false,
                  P2_MODE = 2, MOVE_INTENTS = true,
                  FINISH_CARRIES_CLOCK = true, TRACK_READS = false, CLOCK_MAX = 2, T_MAX = 6).*
  run moveWithIntentTest =
    init.then(write(1, 1))                       // P が group 1 に write 1 (c = 1)
        .then(prepareX(P))                        // X の intent を P に置く (pts 2)
        .then(fence).then(switchRoute)
        .then(pull(1))                            // m = 3、intent 同梱
        .then(losePull)                           // 応答が失われる
        .then(pull(1))                            // 再送: 同じ m
        .expect(pullMsg.m == 3 and moved.get(1) == 3)
        .then(recvPull)
        .expect(arrived.get(1) == 3 and intent.where == C and hlc.get(C) == 3)
        .then(decideX(2))                         // 他参加者の pts が小さく c = 2 < m
        .then(phase2X)                            // 子で適用 (転送)
        .expect(latest(hist.get(C).get(1)).writer == X)
        .expect(not(answersAtC(1, 2)))             // T = 2 < m: 子は ReadTooOld で答えない
        .then(read(C, 1, 3))                      // T = 3 >= m: X (c = 2) を見る
        .expect(not(badRead) and migrationSafe)
}

// S3 の字義: 移動を取引として記録し、親は T < m を undo で答え、子も T < m を undo で答える
module m5b_red_s3 {
  import m5b_core(MOVE_AS_TXN = true, PARENT_SERVES_OLD = true, CHILD_UNDO_OLD = true,
                  P2_MODE = 2, MOVE_INTENTS = true,
                  FINISH_CARRIES_CLOCK = true, TRACK_READS = false, CLOCK_MAX = 2, T_MAX = 6).*
  // C1: 所有権切替後、T < m の読みが子に来る。子は insert@m を undo して「行が無い」と答える。
  run childUndoCounterexampleTest =
    init.then(write(1, 1))                       // group 1 = write 1 (c = 1)
        .then(fence).then(switchRoute)
        .then(pull(1)).then(recvPull)             // m = 2、子の履歴は insert@2 のみ
        .expect(arrived.get(1) == 2)
        .then(read(C, 1, 1))                      // T = 1 < m。真の値は write 1、子の答えは -1 (不在)
        .expect(badRead and lastBad.got == -1 and lastBad.want == 1)
}

// S3 で子だけ ReadTooOld に直した版。親の undo 読みが、移動後に子で適用された c < m の commit を見落とす (C2)
module m5b_red_s3_parent {
  import m5b_core(MOVE_AS_TXN = true, PARENT_SERVES_OLD = true, CHILD_UNDO_OLD = false,
                  P2_MODE = 2, MOVE_INTENTS = true,
                  FINISH_CARRIES_CLOCK = true, TRACK_READS = false, CLOCK_MAX = 2, T_MAX = 6).*
  run parentUndoCounterexampleTest =
    init.then(prepareX(P))                        // intent (pts 1) を P に置く
        .then(fence).then(switchRoute)
        .then(pull(1)).then(recvPull)             // m = 2、intent は C へ
        .then(decideX(1))                         // c = 1 < m (他参加者の pts から決まる)
        .then(phase2X)                            // C で適用、真の値: group 1 = X @1
        .then(read(P, 1, 1))                      // T = 1 < m: 親が delete@2 を undo して答える → X を含まない
        .expect(badRead and lastBad.dom == P and lastBad.want == X and lastBad.got == 0)
}

// 親に届いた phase 2 を転送せず親で適用する (anchor の参加者リストが古い)
module m5b_red_p2 {
  import m5b_core(MOVE_AS_TXN = false, PARENT_SERVES_OLD = false, CHILD_UNDO_OLD = false,
                  P2_MODE = 0, MOVE_INTENTS = true,
                  FINISH_CARRIES_CLOCK = true, TRACK_READS = false, CLOCK_MAX = 2, T_MAX = 6).*
  run counterexampleTest =
    init.then(prepareX(P)).then(fence).then(switchRoute)
        .then(pull(1)).then(recvPull)
        .then(decideX(3)).then(phase2X)           // 親で適用。子の最新は初期値のまま
        .expect(not(noLostWrite))
}

// 検査で見つかった穴: phase 2 を「intent が物理的にある DO」に適用する (S3 の字義)。
// 親が m を決めて応答を送った後、子が受け取るまでの間は intent がまだ親にある。この窓で phase 2 が親に届くと
// 親の (もう移動済みの) 行に適用され、飛んでいる応答のスナップショットには入っていないので子で失われる。
module m5b_red_p2_window {
  import m5b_core(MOVE_AS_TXN = false, PARENT_SERVES_OLD = false, CHILD_UNDO_OLD = false,
                  P2_MODE = 1, MOVE_INTENTS = true,
                  FINISH_CARRIES_CLOCK = true, TRACK_READS = false, CLOCK_MAX = 2, T_MAX = 6).*
  run counterexampleTest =
    init.then(prepareX(P))                        // intent (pts 1) を P に置く
        .then(switchRoute)
        .then(pull(1))                            // P: moved[1] = m = 2、応答 (行 + intent) を送る。intent はまだ P にある
        .expect(pullMsg.g == 1 and intent.where == P and moved.get(1) == 2)
        .then(decideX(2))
        .then(phase2X)                            // P に届き、P の行に適用される
        .expect(latest(hist.get(P).get(1)).writer == X)
        .then(recvPull)                           // 子は X を含まないスナップショットを受け取る
        .expect(latest(hist.get(C).get(1)).writer == 0 and not(noLostWrite))
}

// pull で intent を運ばない
module m5b_red_intents {
  import m5b_core(MOVE_AS_TXN = false, PARENT_SERVES_OLD = false, CHILD_UNDO_OLD = false,
                  P2_MODE = 2, MOVE_INTENTS = false,
                  FINISH_CARRIES_CLOCK = true, TRACK_READS = false, CLOCK_MAX = 2, T_MAX = 6).*
  run counterexampleTest =
    init.then(prepareX(P)).then(fence).then(switchRoute)
        .then(pull(1)).then(recvPull)
        .expect(intent.where == P and moved.get(1) > 0 and not(intentNotLost))
}

// 範囲の移動を終えるとき、親の時計を子へ渡す (修正版)。答えた読みの時刻を覚えて、noWriteBelowRead を確かめる。
// 読みの時刻を覚えると状態が増えるので、T の上限を小さくしてある。
module m5b_green_range {
  import m5b_core(MOVE_AS_TXN = false, PARENT_SERVES_OLD = false, CHILD_UNDO_OLD = false, P2_MODE = 2, MOVE_INTENTS = true,
                  FINISH_CARRIES_CLOCK = true, TRACK_READS = true, CLOCK_MAX = 2, T_MAX = 3).*
  run emptyRangeTest =
    init.then(read(P, 2, 2))                      // 親がグループ 2 を T = 2 で答える。親の時計は 2
        .then(fence).then(switchRoute)
        .then(finishRange)                        // どのグループも pull されていない。親は 3 を発行し、子へ渡す
        .expect(open == Set(1, 2) and hlc.get(C) == 3)
        .then(refreshCache(1)).then(write(1, 2))  // 子がグループ 2 への書き込みを 4 で受理する
        .expect(latest(truth.get(2)).ver == 4 and not(lateWrite) and migrationSafe)
}

// 範囲の移動を終えるとき、子の時計を進めない (2026-11 までの実装)。
// 親が「T = 2 では値は 0」と答えた後で、子が同じグループへの書き込みを 1 で受理する。
module m5b_red_range {
  import m5b_core(MOVE_AS_TXN = false, PARENT_SERVES_OLD = false, CHILD_UNDO_OLD = false, P2_MODE = 2, MOVE_INTENTS = true,
                  FINISH_CARRIES_CLOCK = false, TRACK_READS = true, CLOCK_MAX = 2, T_MAX = 3).*
  run counterexampleTest =
    init.then(read(P, 2, 2))                      // 親がグループ 2 を T = 2 で答える
        .then(fence).then(switchRoute)
        .then(finishRange)                        // 子の時計は 0 のまま
        .expect(open == Set(1, 2) and hlc.get(C) == 0)
        .then(refreshCache(1)).then(write(1, 2))  // 子が 1 で受理する。1 <= 2
        .expect(latest(truth.get(2)).ver == 1 and lateWrite and not(migrationSafe))
}
