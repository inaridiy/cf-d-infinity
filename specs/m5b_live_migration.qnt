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
//
// 空にされたグループと、範囲の床 (2026-11-14)。DELETES のグループは、行を全部消す blind write (del) を 1 回受ける。確定の時刻で
// 「行なし」の版 (writer 0。最初の状態と同じ値) を置く。親が fence の前に空にしたグループは、行がないので pull されず、到着の記録 (m) を
// 持たない。finishRange で、子が到着なしで受け持つ。子は、そのグループの履歴を持たない (行なしの版だけ)。
// 消す前の時刻 T を持った読みが子に届くと、子は「行なし」と答える。T の時点では行があった (readConsistent)。
// この読み手は、たとえば、別の接続で続く取引である (T は変わらず、送り先は新しい範囲表で決まる)。モデルの読み read(C, g, T) は、
// T も送り先も自由に選ぶので、この読み手を含む。子が到着なしのグループを答えるのは finishRange の後、つまり Meta の経路が
// 子を指した後だけである。
// RANGE_FLOOR は「範囲の床」である。子は、範囲の移動を終えるときに受け取った時刻 m を、範囲と一緒に残す。その範囲のグループを
// T < m で読む要求は、pull されたグループでも、されなかったグループでも断る (ReadTooOld)。
// FLOOR_DURABLE = false は、床を子の再起動で忘れる (restartC)。
// HOPS は、同じ範囲をもう一度移す回数である (nextHop)。受け取り終えた子を親に読み替え、新しい空のシャードを子にする。
// 床のあるインスタンスは floorSafe を確かめる。migrationSafe に次の 2 つを足したものである。
//   openReadConsistent: 子が到着なしで受け持つグループを答える T では、子の持つ値が、その時刻の真の値と一致する
//   clockAboveFloor:    床を持つシャードの時計は、床以上である (次に範囲を渡すときに発行する時刻が、床より大きくなる)
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
  const DELETES: Set[int]        // 行を全部消す blind write を受けるグループ (グループごとに 1 回)。Set() なら削除はない
  const RANGE_FLOOR: bool        // 範囲の床: 子は、移動を終えた範囲と時刻 m を残し、その範囲のグループの T < m の読みを断る
  const FLOOR_DURABLE: bool      // 床が子の再起動で残る。false なら、再起動で床を忘れる
  const HOPS: int                // 同じ範囲をもう一度移す回数 (0 なら 1 回だけ移す)
  const CROSS: bool              // クロスシャード取引 X がある。false なら、書き込みは blind write と削除だけ (状態を減らすため)
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
  var pendingDel: Set[int]                // まだ行っていない削除 (グループ)
  var floor: int                          // C: 受け取り終えた範囲の床 (0 = 無し)
  var finished: bool                      // C: 範囲の移動を終えた (finishRange)
  var pfloor: int -> int                  // P: group -> これより小さい T の読みを断る時刻。P が前の移動の子だったときの、到着の m と床
  var hops: int                           // 範囲を移し直した回数

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
    open' = Set(), served' = GROUPS.mapBy(_ => 0), lateWrite' = false,
    pendingDel' = DELETES, floor' = 0, finished' = false, pfloor' = GROUPS.mapBy(_ => 0), hops' = 0
  }

  action keepFloor = all { floor' = floor, finished' = finished, pfloor' = pfloor, hops' = hops }
  action keepMove = all { moved' = moved, arrived' = arrived, fenced' = fenced, route' = route, pullMsg' = pullMsg, open' = open, keepFloor }
  action keepWrites = all { pending' = pending, truth' = truth, cAccepted' = cAccepted, dual' = dual, hist' = hist, lateWrite' = lateWrite,
                            pendingDel' = pendingDel }
  action keepRead = all { badRead' = badRead, lastBad' = lastBad, served' = served }

  def holds(d: int, g: int): bool = if (d == P) moved.get(g) == 0 else (arrived.get(g) > 0 or open.contains(g))
  // d がグループの行を持っている (最新の版が「行なし」でない)
  def hasRows(d: int, g: int): bool = latest(hist.get(d).get(g)).writer > 0

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
    moved' = moved, arrived' = arrived, route' = route, pullMsg' = pullMsg, open' = open, keepFloor,
    hlc' = hlc, cache' = cache, intent' = intent, keepWrites, keepRead
  }
  // Meta が経路を子へ切り替える
  action switchRoute = all {
    route == P, route' = C,
    moved' = moved, arrived' = arrived, fenced' = fenced, pullMsg' = pullMsg, open' = open, keepFloor,
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
          cAccepted' = cAccepted, cache' = cache, pendingDel' = pendingDel
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
          dual' = dual, cache' = cache, pendingDel' = pendingDel
        }
      }
    },
    intent' = intent, keepMove, keepRead
  }

  // ---- 削除 (blind) --------------------------------------------------------------
  // グループの行を全部消す。確定の時刻 c で「行なし」の版 (writer 0) を置く。行のあるグループだけが対象で、グループごとに 1 回。
  // 受理の規則と ghost の更新は write と同じである。
  action del(w: int, g: int): bool = all {
    pendingDel.contains(g),
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
        d == P, moved.get(g) == 0, not(fenced), hasRows(P, g),
        val c = hlc.get(P) + 1
        all {
          hlc' = hlc.set(P, c),
          hist' = hist.set(P, hist.get(P).set(g, hist.get(P).get(g).union(Set({ ver: c, writer: 0 })))),
          truth' = truth.set(g, truth.get(g).union(Set({ ver: c, writer: 0 }))),
          pendingDel' = pendingDel.exclude(Set(g)),
          dual' = (dual or cAccepted.contains(g)),
          lateWrite' = (lateWrite or c <= served.get(g)),
          cAccepted' = cAccepted, cache' = cache, pending' = pending
        }
      },
      // 子が受理
      all {
        d == C, holds(C, g), hasRows(C, g),
        val c = hlc.get(C) + 1
        all {
          hlc' = hlc.set(C, c),
          hist' = hist.set(C, hist.get(C).set(g, hist.get(C).get(g).union(Set({ ver: c, writer: 0 })))),
          truth' = truth.set(g, truth.get(g).union(Set({ ver: c, writer: 0 }))),
          pendingDel' = pendingDel.exclude(Set(g)),
          cAccepted' = cAccepted.union(Set(g)),
          lateWrite' = (lateWrite or c <= served.get(g)),
          dual' = dual, cache' = cache, pending' = pending
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
      arrived' = arrived, fenced' = fenced, route' = route, open' = open, keepFloor,
      pending' = pending, truth' = truth, cAccepted' = cAccepted, dual' = dual, lateWrite' = lateWrite, pendingDel' = pendingDel,
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
      moved' = moved, fenced' = fenced, route' = route, open' = open, keepFloor,
      pending' = pending, truth' = truth, cAccepted' = cAccepted, dual' = dual, lateWrite' = lateWrite, pendingDel' = pendingDel,
      cache' = cache, keepRead
    }
  }

  // 応答が失われる (親または子の再起動)。子は後で pull をやり直す
  action losePull = all {
    pullMsg.g != 0,
    pullMsg' = noPull,
    moved' = moved, arrived' = arrived, fenced' = fenced, route' = route, open' = open, keepFloor,
    hlc' = hlc, cache' = cache, intent' = intent, keepWrites, keepRead
  }

  // ---- 範囲の移動を終える -----------------------------------------------------
  // pull されなかったグループ (親に行も intent もない) を、子が到着なしで受け持つ。実装では、drain が行のあるグループを
  // 運び終えた後の finishMove と finishIncoming にあたる。親は、時刻を発行して、このグループをもう答えないことを記録する。
  // FINISH_CARRIES_CLOCK なら、その時刻を子へ渡し、子は時計をそこまで進める。
  // 親に行がないグループには、一度も書かれていないグループと、書かれた後で空にされたグループ (del) がある。どちらも、最新の版が
  // 「行なし」である。子は、どちらも履歴なしで受け持つ (行なしの版だけ)。削除がなければ、この条件は hist == initVers と同じである。
  // RANGE_FLOOR なら、子は受け取った時刻 m を床として残す。全部のグループが pull された範囲でも、終えるときに床を残す。
  // (2026-11-17、M5d に合わせて緩めた) 親は、行と intent が残っていなければ渡し終える。空のグループを渡した応答が飛んでいても (届いていなくても) 終える。
  // 子は、届いていないグループを全部、到着なしで受け持ち、飛んでいる応答を捨てる (M5d の規則)。
  action finishRange = all {
    fenced, route == C,
    val handedEmpty = GROUPS.filter(g => moved.get(g) > 0 and arrived.get(g) == 0 and not(open.contains(g))
      and latest(hist.get(P).get(g).filter(v => v.writer != TOMB)).writer == 0 and not(intent.where == P and groupOf(X) == g))
    val rest = GROUPS.filter(g => moved.get(g) == 0).union(handedEmpty)
    val m = hlc.get(P) + 1
    all {
      rest != Set() or (RANGE_FLOOR and not(finished)),
      GROUPS.forall(g => moved.get(g) > 0 or
        (latest(hist.get(P).get(g)).writer == 0 and not(intent.where == P and groupOf(X) == g))),
      GROUPS.forall(g => moved.get(g) == 0 or arrived.get(g) > 0 or open.contains(g) or handedEmpty.contains(g)),
      hlc' = hlc.set(P, m).set(C, if (FINISH_CARRIES_CLOCK) max(hlc.get(C), m) else hlc.get(C)),
      moved' = GROUPS.mapBy(g => if (rest.contains(g)) m else moved.get(g)),
      open' = open.union(rest),
      hist' = hist.set(C, GROUPS.mapBy(g => if (rest.contains(g)) initVers else hist.get(C).get(g))),
      floor' = if (RANGE_FLOOR) m else floor, finished' = true, pfloor' = pfloor, hops' = hops,
      arrived' = arrived, fenced' = fenced, route' = route, pullMsg' = noPull,
      pending' = pending, truth' = truth, cAccepted' = cAccepted, dual' = dual, lateWrite' = lateWrite, pendingDel' = pendingDel,
      cache' = cache, intent' = intent, keepRead
    }
  }

  // 子の再起動。床が永続していなければ、床を忘れる。ほかの状態は永続している (pull の応答の喪失は losePull)。
  action restartC = all {
    RANGE_FLOOR, not(FLOOR_DURABLE), floor > 0,
    floor' = 0, finished' = finished, pfloor' = pfloor, hops' = hops,
    moved' = moved, arrived' = arrived, fenced' = fenced, route' = route, pullMsg' = pullMsg, open' = open,
    hlc' = hlc, cache' = cache, intent' = intent, keepWrites, keepRead
  }

  // ---- 同じ範囲をもう一度移す ---------------------------------------------------
  // 子が範囲を受け取り終えた後、その子を親にして、同じ範囲を新しい空のシャードへ移す。変数の P を今の子に、C を新しいシャードに
  // 読み替える。元の親は、範囲の要求を全部断る (fence 済み) ので、モデルから消える。Worker のキャッシュと Meta の経路は、新しい親を指す。
  // 新しい親は、前の移動の子として持っていた時計、行、到着の m、床を持ち続ける。到着の m か床より小さい T の読みは、親になっても断る。
  // 実装では、受け取り中のシャードは分割できない (fence が断る) ので、範囲の移動を終えた後でだけ起きる。
  action nextHop = all {
    hops < HOPS,
    pullMsg.g == 0,
    GROUPS.forall(g => holds(C, g)),
    not(RANGE_FLOOR) or finished,
    intent.where != P,
    hops' = hops + 1,
    hlc' = Map(P -> hlc.get(C), C -> 0),
    hist' = Map(P -> hist.get(C), C -> GROUPS.mapBy(_ => Set())),
    pfloor' = GROUPS.mapBy(g => max(arrived.get(g), floor)),
    moved' = GROUPS.mapBy(_ => 0), arrived' = GROUPS.mapBy(_ => 0), open' = Set(),
    fenced' = false, finished' = false, floor' = 0,
    route' = P, cache' = WORKERS.mapBy(_ => P), pullMsg' = noPull,
    intent' = if (intent.where == C) intent.with("where", P).with("preparedAt", P) else intent,
    cAccepted' = Set(),
    pending' = pending, pendingDel' = pendingDel, truth' = truth, dual' = dual, lateWrite' = lateWrite,
    keepRead
  }

  // ---- クロスシャード取引 X (グループ 1) ------------------------------------------
  // prepare はグループを持つ DO に届く (anchor は経路表を見るが、移動中は親に届くこともある)
  action prepareX(d: int): bool = all {
    CROSS,
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
      pending' = pending, cAccepted' = cAccepted, dual' = dual, pendingDel' = pendingDel,
      lateWrite' = (lateWrite or c <= served.get(g)),
      cache' = cache, keepMove, keepRead
    }
  }

  // ---- 読み -------------------------------------------------------------------
  // 読み手は T を持って d に行く。答えが返るなら真の値と比べる。NotOwner / ReadTooOld / 未到着は答えでない。
  // intent がある DO では、pts <= T かつ c 未決定なら push (c > T を強制)、c 決定済みで c <= T かつ未適用なら待つ。
  def truthAt(g: int, t: int): int = valueAt(truth.get(g), t)
  // 親は、前の移動の子だったときの到着の m と床 (pfloor) より小さい T を断る。移し直しがなければ pfloor は 0 である。
  def answersAtP(g: int, t: int): bool =
    (moved.get(g) == 0 or (PARENT_SERVES_OLD and t < moved.get(g))) and t >= pfloor.get(g)
  // 範囲の床があれば、子は、pull されたグループも、到着なしで受け持つグループも、T < 床 の読みを断る。床は finishRange まで 0 である。
  def answersAtC(g: int, t: int): bool =
    ((arrived.get(g) > 0 and (t >= arrived.get(g) or CHILD_UNDO_OLD)) or open.contains(g)) and t >= floor
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
    { nondet w = oneOf(WORKERS) nondet g = oneOf(GROUPS) del(w, g) },
    { nondet g = oneOf(GROUPS) pull(g) },
    recvPull,
    losePull,
    finishRange,
    restartC,
    nextHop,
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
  // 子が到着なしで受け持つグループを答える T では、子の持つ値が、その時刻の真の値と一致する。readConsistent は、読みが起きたときに
  // 比べる。こちらは、どの状態でも、子が答えるはずの T を全部比べる (空にされたグループの読みの不変条件)。
  val openReadConsistent = open.forall(g => 0.to(T_MAX).forall(t =>
    not(answersAtC(g, t)) or intentBlocks(C, g, t) or valueAt(hist.get(C).get(g), t) == truthAt(g, t)))
  // 床を持つシャードの時計は、床以上である。そのシャードが次に範囲を渡すときに発行する時刻は、床より大きい。
  val clockAboveFloor = hlc.get(C) >= floor and GROUPS.forall(g => hlc.get(P) >= pfloor.get(g))
  val floorSafe = migrationSafe and openReadConsistent and clockAboveFloor

  // witness
  val witnessMovedAndWritten = not(GROUPS.forall(g => arrived.get(g) > 0) and pending == Set()
                                   and cAccepted != Set() and intent.where == 3)
  val witnessIntentMovedThenApplied = not(intent.where == 3 and intent.preparedAt == P and arrived.get(groupOf(X)) > 0
                                          and latest(hist.get(C).get(groupOf(X))).writer == X)
  val witnessOpenWritten = not(open != Set() and cAccepted.intersect(open) != Set())
  // (2026-11-17、M5d に合わせて緩めた) 親が空のまま渡した (親の履歴に delete@m がある) グループを、子が到着なしで受け持ち、そこへ書き込みを受理した
  val witnessHandedEmptyOpen = not(GROUPS.exists(g => open.contains(g) and arrived.get(g) == 0
    and hist.get(P).get(g).exists(v => v.writer == TOMB) and cAccepted.contains(g)))
  // 親が移動の前に空にしたグループ (削除の版が、範囲の移動を終えた時刻より前にある) を、子が到着なしで受け持っている
  def emptiedThenOpen(g: int): bool =
    open.contains(g) and truth.get(g).exists(v => v.writer == 0 and v.ver > 0 and v.ver < moved.get(g))
  // 空にされたグループを子が受け持ち、その後で子が書き込みを受理した
  val witnessEmptiedWritten = not(GROUPS.exists(g => emptiedThenOpen(g) and cAccepted.contains(g)))
  // 空にされたグループを、子が床以上の T で答えた (TRACK_READS のとき。親が答えた読みの時刻は、床より小さい)
  val witnessEmptiedRead = not(GROUPS.exists(g => emptiedThenOpen(g) and floor > 0 and served.get(g) >= floor))
  // 範囲を移し直した後で、新しい子が全部のグループを受け持ち、書き込みを受理した
  val witnessSecondHopWritten = not(hops > 0 and GROUPS.forall(g => holds(C, g)) and cAccepted != Set())
  // 移し直した範囲に、最初の親が空にしたグループがあり、新しい子がそれを到着なしで受け持っている
  val witnessSecondHopEmptied = not(hops > 0 and GROUPS.exists(g => open.contains(g) and pfloor.get(g) > 0
                                     and truth.get(g).exists(v => v.writer == 0 and v.ver > 0 and v.ver < pfloor.get(g))))
}

// 修正版 (green): 版を保って物理的に移す。親は移動済みグループに NotOwner、子は T < m に ReadTooOld。
// phase 2 は intent のある DO へ転送。intent は pull で運ぶ。
module m5b_green {
  import m5b_core(MOVE_AS_TXN = false, PARENT_SERVES_OLD = false, CHILD_UNDO_OLD = false,
                  P2_MODE = 2, MOVE_INTENTS = true,
                  FINISH_CARRIES_CLOCK = true, TRACK_READS = false, CLOCK_MAX = 2, T_MAX = 6,
                  DELETES = Set(), RANGE_FLOOR = false, FLOOR_DURABLE = true, HOPS = 0, CROSS = true).*
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
                  FINISH_CARRIES_CLOCK = true, TRACK_READS = false, CLOCK_MAX = 2, T_MAX = 6,
                  DELETES = Set(), RANGE_FLOOR = false, FLOOR_DURABLE = true, HOPS = 0, CROSS = true).*
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
                  FINISH_CARRIES_CLOCK = true, TRACK_READS = false, CLOCK_MAX = 2, T_MAX = 6,
                  DELETES = Set(), RANGE_FLOOR = false, FLOOR_DURABLE = true, HOPS = 0, CROSS = true).*
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
                  FINISH_CARRIES_CLOCK = true, TRACK_READS = false, CLOCK_MAX = 2, T_MAX = 6,
                  DELETES = Set(), RANGE_FLOOR = false, FLOOR_DURABLE = true, HOPS = 0, CROSS = true).*
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
                  FINISH_CARRIES_CLOCK = true, TRACK_READS = false, CLOCK_MAX = 2, T_MAX = 6,
                  DELETES = Set(), RANGE_FLOOR = false, FLOOR_DURABLE = true, HOPS = 0, CROSS = true).*
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
                  FINISH_CARRIES_CLOCK = true, TRACK_READS = false, CLOCK_MAX = 2, T_MAX = 6,
                  DELETES = Set(), RANGE_FLOOR = false, FLOOR_DURABLE = true, HOPS = 0, CROSS = true).*
  run counterexampleTest =
    init.then(prepareX(P)).then(fence).then(switchRoute)
        .then(pull(1)).then(recvPull)
        .expect(intent.where == P and moved.get(1) > 0 and not(intentNotLost))
}

// 範囲の移動を終えるとき、親の時計を子へ渡す (修正版)。答えた読みの時刻を覚えて、noWriteBelowRead を確かめる。
// 読みの時刻を覚えると状態が増えるので、T の上限を小さくしてある。
module m5b_green_range {
  import m5b_core(MOVE_AS_TXN = false, PARENT_SERVES_OLD = false, CHILD_UNDO_OLD = false, P2_MODE = 2, MOVE_INTENTS = true,
                  FINISH_CARRIES_CLOCK = true, TRACK_READS = true, CLOCK_MAX = 2, T_MAX = 3,
                  DELETES = Set(), RANGE_FLOOR = false, FLOOR_DURABLE = true, HOPS = 0, CROSS = true).*
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
                  FINISH_CARRIES_CLOCK = false, TRACK_READS = true, CLOCK_MAX = 2, T_MAX = 3,
                  DELETES = Set(), RANGE_FLOOR = false, FLOOR_DURABLE = true, HOPS = 0, CROSS = true).*
  run counterexampleTest =
    init.then(read(P, 2, 2))                      // 親がグループ 2 を T = 2 で答える
        .then(fence).then(switchRoute)
        .then(finishRange)                        // 子の時計は 0 のまま
        .expect(open == Set(1, 2) and hlc.get(C) == 0)
        .then(refreshCache(1)).then(write(1, 2))  // 子が 1 で受理する。1 <= 2
        .expect(latest(truth.get(2)).ver == 1 and lateWrite and not(migrationSafe))
}

// ---- 空にされたグループと範囲の床 (2026-11-14) ----------------------------------------------------

// 2026-11-14 の実装。親が fence の前に空にしたグループを、子が到着なしで受け持つ。子は床を持たないので、消す前の時刻 T の読みに
// 「行なし」と答える。test/open/old-read-of-emptied-group.test.ts の 1 つ目の形である (同じ行を 2 回読み、2 回目に T より後の削除を見る)。
module m5b_red_emptied {
  import m5b_core(MOVE_AS_TXN = false, PARENT_SERVES_OLD = false, CHILD_UNDO_OLD = false, P2_MODE = 2, MOVE_INTENTS = true,
                  FINISH_CARRIES_CLOCK = true, TRACK_READS = false, CLOCK_MAX = 2, T_MAX = 4,
                  DELETES = Set(1, 2), RANGE_FLOOR = false, FLOOR_DURABLE = true, HOPS = 0, CROSS = true).*
  run counterexampleTest =
    init.then(write(1, 2))                        // 親がグループ 2 に行を書く (c = 1)
        .then(read(P, 2, 1))                      // 取引が T = 1 で読む。親の答えは write 2
        .expect(not(badRead))
        .then(del(1, 2))                          // 別の接続が、T より後に、行を全部消す (c = 2)
        .expect(latest(truth.get(2)) == { ver: 2, writer: 0 })
        .then(fence).then(switchRoute)
        .then(finishRange)                        // 運ぶ行がない。親は m = 3 を発行し、子は時計を 3 に進めて、到着なしで受け持つ
        .expect(open == Set(1, 2) and moved.get(2) == 3 and arrived.get(2) == 0 and hlc.get(C) == 3)
        .expect(not(openReadConsistent))
        .then(read(C, 2, 1))                      // 取引が別の接続で続き、新しい範囲表で子へ行く。T = 1 < m。子の答えは「行なし」
        .expect(badRead and lastBad == { g: 2, t: 1, dom: C, got: 0, want: 2 })
}

// 範囲の床 (修正案)。子は、範囲の移動を終えるときに受け取った時刻 m を残し、その範囲のグループの T < m の読みを断る。
// m5b_red_emptied との違いは RANGE_FLOOR だけである。
module m5b_green_floor {
  import m5b_core(MOVE_AS_TXN = false, PARENT_SERVES_OLD = false, CHILD_UNDO_OLD = false, P2_MODE = 2, MOVE_INTENTS = true,
                  FINISH_CARRIES_CLOCK = true, TRACK_READS = false, CLOCK_MAX = 2, T_MAX = 4,
                  DELETES = Set(1, 2), RANGE_FLOOR = true, FLOOR_DURABLE = true, HOPS = 0, CROSS = true).*
  run emptiedGroupTest =
    init.then(write(1, 2)).then(read(P, 2, 1)).then(del(1, 2))
        .then(fence).then(switchRoute)
        .then(finishRange)                        // m = 3。子は 3 を床として残す
        .expect(floor == 3 and open == Set(1, 2))
        .expect(not(answersAtC(2, 1)) and not(answersAtC(2, 2)))   // T < 床: 子は ReadTooOld で断る
        .then(read(C, 2, 3))                      // T = 3 = 床: 子は「行なし」と答える。削除 (c = 2) の後なので正しい
        .expect(not(badRead))
        .then(refreshCache(1)).then(write(1, 1))  // 子がグループ 1 への書き込みを 4 で受理する
        .expect(latest(truth.get(1)).ver == 4 and floorSafe)
  // 全部のグループが pull された範囲でも、移動を終えるときに床を残す。pull されたグループも、T < 床 の読みを断る
  run pulledGroupTest =
    init.then(write(1, 1)).then(write(1, 2))      // c = 1、2
        .then(fence).then(switchRoute)
        .then(pull(1)).then(recvPull)             // m = 3
        .then(pull(2)).then(recvPull)             // m = 4
        .expect(answersAtC(1, 3) and not(answersAtC(2, 3)))        // 移動を終えるまでは、到着の m 以上の T に答える
        .then(finishRange)                        // m = 5
        .expect(floor == 5 and open == Set() and not(answersAtC(1, 4)) and answersAtC(1, 5))
        .then(read(C, 1, 5))
        .expect(floorSafe)
}

// 範囲の床。答えた読みの時刻を覚えて、noWriteBelowRead も確かめる。読みの時刻を覚えると状態が増えるので、取引 X を外してある
// (書き込みは blind write と削除)。X を入れた版は m5b_green_floor_clock_x。
module m5b_green_floor_clock {
  import m5b_core(MOVE_AS_TXN = false, PARENT_SERVES_OLD = false, CHILD_UNDO_OLD = false, P2_MODE = 2, MOVE_INTENTS = true,
                  FINISH_CARRIES_CLOCK = true, TRACK_READS = true, CLOCK_MAX = 2, T_MAX = 4,
                  DELETES = Set(1, 2), RANGE_FLOOR = true, FLOOR_DURABLE = true, HOPS = 0, CROSS = false).*
  run emptiedGroupTest =
    init.then(write(1, 2)).then(read(P, 2, 1)).then(del(1, 2))
        .then(fence).then(switchRoute).then(finishRange)
        .then(read(C, 2, 3))                      // 子が、空にされたグループを床以上の T で答える
        .expect(served.get(2) == 3 and floor == 3)
        .then(refreshCache(1)).then(write(1, 1))  // 子の時計は 3 以上。書き込みは 4 で受理する
        .expect(not(lateWrite) and floorSafe)
}

// 同上、取引 X あり。削除は、X が書くグループ 1 だけ (空にされたグループへ、X の書き込みが届く)。T の上限は 3 (m5b_green_range と同じ)。
// 状態が多いので、HEAVY=1 のときだけ回す。
module m5b_green_floor_clock_x {
  import m5b_core(MOVE_AS_TXN = false, PARENT_SERVES_OLD = false, CHILD_UNDO_OLD = false, P2_MODE = 2, MOVE_INTENTS = true,
                  FINISH_CARRIES_CLOCK = true, TRACK_READS = true, CLOCK_MAX = 2, T_MAX = 3,
                  DELETES = Set(1), RANGE_FLOOR = true, FLOOR_DURABLE = true, HOPS = 0, CROSS = true).*
  run crossAfterFinishTest =
    init.then(write(1, 1)).then(del(1, 1))        // 親がグループ 1 を書いて (c = 1)、空にする (c = 2)
        .then(fence).then(switchRoute).then(finishRange)   // 床 3
        .then(read(C, 1, 3))                      // 子が、空にされたグループ 1 を T = 3 で答える (行なし)
        .expect(served.get(1) == 3)
        .then(prepareX(C))                        // X の intent を子に置く (pts = 4)
        .then(decideX(4)).then(phase2X)           // c = 4 > 3
        .expect(latest(truth.get(1)) == { ver: 4, writer: X } and not(lateWrite) and floorSafe)
}

// 床を、子の再起動で忘れる (床を永続させない)。再起動の後は、床のない実装と同じ答えになる。
module m5b_red_floor_volatile {
  import m5b_core(MOVE_AS_TXN = false, PARENT_SERVES_OLD = false, CHILD_UNDO_OLD = false, P2_MODE = 2, MOVE_INTENTS = true,
                  FINISH_CARRIES_CLOCK = true, TRACK_READS = false, CLOCK_MAX = 2, T_MAX = 4,
                  DELETES = Set(1, 2), RANGE_FLOOR = true, FLOOR_DURABLE = false, HOPS = 0, CROSS = true).*
  run counterexampleTest =
    init.then(write(1, 2)).then(del(1, 2))        // c = 1、2
        .then(fence).then(switchRoute).then(finishRange)
        .expect(floor == 3 and not(answersAtC(2, 1)))
        .then(restartC)                           // 子が再起動して、床を忘れる
        .expect(floor == 0 and answersAtC(2, 1))
        .then(read(C, 2, 1))
        .expect(badRead and lastBad == { g: 2, t: 1, dom: C, got: 0, want: 2 })
}

// 床はあるが、範囲の移動を終えるときに親の時計を子へ渡さない。床は、時計を渡す手順の代わりにならない。
// 子が、親の削除より小さい時刻で、空にされたグループへの書き込みを受理する。時刻の順では削除が後なので、床以上の T の真の値は
// 「行なし」だが、子は書き込みの値を答える。m5b_red_range は、親が答えた読みが要る。こちらは、親の確定だけで破れる。
module m5b_red_floor_no_clock {
  import m5b_core(MOVE_AS_TXN = false, PARENT_SERVES_OLD = false, CHILD_UNDO_OLD = false, P2_MODE = 2, MOVE_INTENTS = true,
                  FINISH_CARRIES_CLOCK = false, TRACK_READS = false, CLOCK_MAX = 2, T_MAX = 4,
                  DELETES = Set(1, 2), RANGE_FLOOR = true, FLOOR_DURABLE = true, HOPS = 0, CROSS = true).*
  run counterexampleTest =
    init.then(write(1, 1)).then(del(1, 1))        // 親がグループ 1 を書いて (c = 1)、空にする (c = 2)
        .then(fence).then(switchRoute).then(finishRange)
        .expect(floor == 3 and hlc.get(C) == 0 and not(clockAboveFloor))   // 子は床 3 を残すが、時計は 0 のまま
        .then(prepareX(C)).then(decideX(1)).then(phase2X)                  // 子が、X の書き込みを c = 1 で適用する。1 < 2
        .expect(not(noLostWrite))
        .then(read(C, 1, 3))                      // T = 3 = 床。真の値は「行なし」(削除は c = 2)。子の答えは X
        .expect(badRead and lastBad == { g: 1, t: 3, dom: C, got: X, want: 0 })
}

// 同じ範囲をもう一度移す (子を親にして、新しい空のシャードへ)。新しい子の床は、新しい親が発行した時刻である。新しい親の時計は
// 自分の床以上なので (clockAboveFloor)、新しい床は前の床より大きい。新しい子は、前の床を知らなくてよい。
// 2 回の移動で状態が増えるので、取引 X を外してある。X を入れた版は m5b_green_floor_resplit_x。
module m5b_green_floor_resplit {
  import m5b_core(MOVE_AS_TXN = false, PARENT_SERVES_OLD = false, CHILD_UNDO_OLD = false, P2_MODE = 2, MOVE_INTENTS = true,
                  FINISH_CARRIES_CLOCK = true, TRACK_READS = false, CLOCK_MAX = 1, T_MAX = 5,
                  DELETES = Set(1, 2), RANGE_FLOOR = true, FLOOR_DURABLE = true, HOPS = 1, CROSS = false).*
  run secondHopTest =
    init.then(write(1, 2)).then(del(1, 2))        // 最初の親が、グループ 2 を書いて (c = 1)、空にする (c = 2)
        .then(fence).then(switchRoute).then(finishRange)   // 床 3。子の時計も 3
        .then(nextHop)                            // 子を親に読み替える。時計と床を持ち続ける
        .expect(pfloor.get(2) == 3 and hlc.get(P) == 3 and not(answersAtP(2, 1)) and answersAtP(2, 3))
        .then(write(1, 1))                        // 新しい親がグループ 1 に書く (c = 4)
        .then(fence).then(switchRoute)
        .then(pull(1)).then(recvPull)             // m = 5
        .then(finishRange)                        // 新しい親は 6 を発行する。新しい子の床は 6
        .expect(floor == 6 and open == Set(2) and not(answersAtC(2, 1)) and not(answersAtC(2, 5)) and answersAtC(2, 6))
        .expect(floorSafe)
}

// 同上、取引 X あり。削除は、X が書くグループ 1 だけ。tick なし、T の上限は 4。状態が多いので、HEAVY=1 のときだけ回す。
module m5b_green_floor_resplit_x {
  import m5b_core(MOVE_AS_TXN = false, PARENT_SERVES_OLD = false, CHILD_UNDO_OLD = false, P2_MODE = 2, MOVE_INTENTS = true,
                  FINISH_CARRIES_CLOCK = true, TRACK_READS = false, CLOCK_MAX = 0, T_MAX = 4,
                  DELETES = Set(1), RANGE_FLOOR = true, FLOOR_DURABLE = true, HOPS = 1, CROSS = true).*
  run secondHopIntentTest =
    init.then(write(1, 1)).then(del(1, 1))        // 最初の親が、グループ 1 を書いて (c = 1)、空にする (c = 2)
        .then(fence).then(switchRoute).then(finishRange)   // 床 3。子は、両方のグループを到着なしで受け持つ
        .then(nextHop)
        .then(prepareX(P))                        // X の intent を新しい親に置く (pts = 4)。グループ 1 に行はない
        .then(fence).then(switchRoute)
        .then(pull(1)).then(recvPull)             // 行はないが、intent があるので運ぶ。m = 5。intent は新しい子へ移る
        .expect(intent.where == C and arrived.get(1) == 5)
        .then(finishRange)                        // m = 6。グループ 2 は、新しい子が到着なしで受け持つ
        .expect(floor == 6 and open == Set(2))
        .then(decideX(4)).then(phase2X)           // 新しい子で適用する
        .expect(latest(hist.get(C).get(1)).writer == X and floorSafe)
}
