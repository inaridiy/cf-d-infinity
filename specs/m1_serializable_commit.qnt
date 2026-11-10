// M1: anchor 主導 2PC の Serializable 検査 (design.md「書き込みとトランザクション」)
//
// 2 シャード、4 キー (1,2 は shard 1、3,4 は shard 2。1,3 は初期から存在、2,4 は insert 用)。
// 取引は固定テンプレート集合から選ぶ。読みは rollback-read 相当 (履歴から T 時点の版を返す)。
// 時刻は HLC (int)。tick で時計のずれを作る。
//
// invariant `serializable`: committed 取引の全ての読みが、(c, rank) 順で自分より前の
// committed 書き込みの最新と一致する (= commit_ts 順の直列実行と一致)。
// 読み取り専用取引は c = T、rank は書き手より後ろ (T 以下を見る)。
module m1_core {
  // ---- red / green 切り替え -------------------------------------------
  const RED_A: bool   // (a) 読み取り専用参加者へ prepare を送らない
  const RED_B: bool   // (b) anchor が受け取った prepare_ts を HLC に取り込まない
  const RED_C: bool   // (c) refresh が HLC を c まで進めない
  const RED_D: bool   // (d) 述語読みを「読んだ行を全部書く」なら保護済み扱い (phantom)
  const RED_E: bool   // (e) 検証で intent を見ない (変更ログだけ照合)
  const RED_F: bool   // (f) 読み手が in-flight intent を push せず通過 (M2 の red)
  const RED_G: bool   // (g) c 決定後 (refresh 中) も push を受理する = design.md 原文の「in-flight なら push」。検査で見つかった設計バグ
  const NTXN: int
  const CLOCK_MAX: int  // tick で進められる HLC の上限 (時計ずれの幅)

  // ---- 定数 -------------------------------------------------------------
  pure val SHARDS = Set(1, 2)
  pure val KEYS = Set(1, 2, 3, 4)
  pure val BASE = Set(1, 3)
  pure def shardOf(k: int): int = if (k <= 2) 1 else 2
  pure def keysOn(s: int): Set[int] = KEYS.filter(k => shardOf(k) == s)
  pure val TXNS = 1.to(NTXN)
  pure val NONE = 0
  pure val BIG = 1000

  type Tmpl = { reads: Set[int], pred: int, writes: Set[int] }
  // pred: 述語読み (shard 全体の存在キー集合を読む) をするシャード。0 なら無し。
  pure val TEMPLATES: Set[Tmpl] = Set(
    { reads: Set(1), pred: 0, writes: Set(3) },      // RW: x を読み y を書く
    { reads: Set(3), pred: 0, writes: Set(1) },      // RW: y を読み x を書く
    { reads: Set(1), pred: 0, writes: Set(1, 3) },   // RMW x + y 書き
    { reads: Set(3), pred: 0, writes: Set(1, 3) },   // RMW y + x 書き
    { reads: Set(), pred: 1, writes: Set(1, 3) },    // 述語読み S1 → 読んだ行 (x) と y を書く
    { reads: Set(), pred: 2, writes: Set(1, 3) },    // 述語読み S2 → 読んだ行 (y) と x を書く
    { reads: Set(), pred: 0, writes: Set(2) },       // insert xi
    { reads: Set(), pred: 0, writes: Set(4) },       // insert yi
    { reads: Set(), pred: 0, writes: Set(1) },       // blind write x
    { reads: Set(), pred: 0, writes: Set(3) },       // blind write y
    { reads: Set(), pred: 0, writes: Set(1, 3) },    // blind write x, y
    { reads: Set(1, 3), pred: 0, writes: Set() }     // 読み取り専用
  )

  type Status = Idle | Reading | Preparing | Refreshing | Committed | Aborted
  type Txn = {
    status: Status,
    tmpl: Tmpl,
    T: int,
    readVals: int -> int,     // key -> 読んだ版の writer (0 = 初期値)
    predSeen: Set[int],       // 述語読みで存在を見たキー
    predDone: bool,
    anchor: int,
    pts: int -> int,          // shard -> prepare_ts
    c: int,
    pushed: int,              // 読み手が登録した min_commit_ts (c > pushed)
    toRefresh: Set[int],
    didRefresh: bool,
    applied: Set[int]
  }
  type Ver = { ver: int, writer: int }
  type Intent = { txn: int, pts: int }

  // ---- 状態 -------------------------------------------------------------
  var txns: int -> Txn
  var hlc: int -> int
  var hist: int -> Set[Ver]        // key -> 適用済み committed 版 (本体 + 変更ログ)
  var intents: int -> Intent       // key -> intent (txn == NONE なら無し)

  // ---- 補助 -------------------------------------------------------------
  pure def max(a: int, b: int): int = if (a > b) a else b
  pure def maxOf(s: Set[int], d: int): int = s.fold(d, (acc, x) => max(acc, x))
  pure def minOf(s: Set[int], d: int): int = s.fold(d, (acc, x) => if (x < acc) x else acc)
  pure val noVer: Ver = { ver: -1, writer: -1 }

  def versionAt(k: int, t: int): Ver =
    hist.get(k).filter(e => e.ver <= t).fold(noVer, (acc, e) => if (e.ver > acc.ver) e else acc)
  def latestVer(k: int): int = hist.get(k).fold(-1, (acc, e) => max(acc, e.ver))

  pure def writeShards(t: Txn): Set[int] = t.tmpl.writes.map(k => shardOf(k))
  pure def readShards(t: Txn): Set[int] =
    t.tmpl.reads.map(k => shardOf(k)).union(if (t.tmpl.pred == 0) Set() else Set(t.tmpl.pred))
  pure def touched(t: Txn): Set[int] = writeShards(t).union(readShards(t))
  pure def participants(t: Txn): Set[int] = if (RED_A) writeShards(t) else touched(t)
  pure def isRO(t: Txn): bool = t.tmpl.writes == Set()
  pure def inflight(t: Txn): bool = t.status == Preparing or t.status == Refreshing
  pure def readsDone(t: Txn): bool = t.readVals.keys() == t.tmpl.reads and (t.tmpl.pred == 0 or t.predDone)

  // 保護された span: pk 等値で読み、同じ pk に書く。述語読みは常に未保護 (RED_D では
  // 「読んだ行を全部書くなら保護」と誤判定する)。
  pure def unprotectedPoint(t: Txn, p: int): Set[int] =
    t.tmpl.reads.filter(k => shardOf(k) == p and not(t.tmpl.writes.contains(k)))
  pure def predProtected(t: Txn): bool = RED_D and t.predSeen.subseteq(t.tmpl.writes)
  pure def hasUnprotected(t: Txn, p: int): bool =
    unprotectedPoint(t, p) != Set() or (t.tmpl.pred == p and not(predProtected(t)))

  def otherIntent(k: int, tid: int): bool = intents.get(k).txn != NONE and intents.get(k).txn != tid
  // 読み span の照合: (lo, hi] の他取引の commit、または他取引の intent
  def readConflict(tid: int, k: int, lo: int, hi: int): bool =
    hist.get(k).exists(e => e.ver > lo and e.ver <= hi and e.writer != tid)
    or (not(RED_E) and otherIntent(k, tid))
  def writeConflict(tid: int, t: Txn, p: int): bool =
    t.tmpl.writes.filter(k => shardOf(k) == p).exists(k => otherIntent(k, tid) or latestVer(k) > t.T)
  def spanConflict(tid: int, t: Txn, p: int, lo: int, hi: int): bool =
    unprotectedPoint(t, p).exists(k => readConflict(tid, k, lo, hi))
    or (t.tmpl.pred == p and not(predProtected(t)) and keysOn(p).exists(k => readConflict(tid, k, lo, hi)))
  // prepare 時の検証: 書きの first-committer-wins + 未保護 span を (T, 現在]
  def prepareConflict(tid: int, t: Txn, p: int): bool =
    writeConflict(tid, t, p) or spanConflict(tid, t, p, t.T, BIG)

  def intentsWithout(tid: int): int -> Intent =
    KEYS.mapBy(k => if (intents.get(k).txn == tid) { txn: NONE, pts: 0 } else intents.get(k))
  def placeIntents(tid: int, t: Txn, p: int, pts: int): int -> Intent =
    KEYS.mapBy(k => if (t.tmpl.writes.contains(k) and shardOf(k) == p) { txn: tid, pts: pts } else intents.get(k))

  // 読み手が intent に当たったときの扱い (design.md「読み取り」)
  //  - prepare_ts > T: 無視
  //  - committed(c <= T): phase 2 を代行適用してから読む (= apply が済むまで読みを遅らせる)
  //  - committed(c > T): 無視
  //  - in-flight (c 未決定): push (min_commit_ts = T+1) してから無視。RED_F では push せず通過
  //  - c 決定済みで未確定 (Refreshing) かつ c <= T: push は c を動かせない。読み手は決着を待つ (green)。
  //    RED_G では push を受理したことにして通過する (c は変わらない)。
  pure def pushable(u: Txn): bool = u.status == Preparing or (RED_G and u.status == Refreshing)
  def blockedBy(k: int, tid: int, t: int): bool =
    val it = intents.get(k)
    if (it.txn == NONE or it.txn == tid or it.pts > t) false
    else
      val u = txns.get(it.txn)
      u.c <= t and (u.status == Committed or (u.status == Refreshing and not(RED_G)))
  def pushTargets(ks: Set[int], tid: int, t: int): Set[int] =
    if (RED_F) Set() else
    ks.filter(k =>
      val it = intents.get(k)
      if (it.txn == NONE or it.txn == tid or it.pts > t) false else pushable(txns.get(it.txn))
    ).map(k => intents.get(k).txn)
  def withPushes(m: int -> Txn, targets: Set[int], t: int): int -> Txn =
    targets.fold(m, (acc, u) => acc.set(u, acc.get(u).with("pushed", max(acc.get(u).pushed, t))))

  // ---- 初期化 -------------------------------------------------------------
  pure val idleTxn: Txn = {
    status: Idle, tmpl: { reads: Set(), pred: 0, writes: Set() }, T: 0,
    readVals: Map(), predSeen: Set(), predDone: false, anchor: NONE,
    pts: Map(), c: 0, pushed: 0, toRefresh: Set(), didRefresh: false, applied: Set()
  }
  action init = all {
    txns' = TXNS.mapBy(_ => idleTxn),
    hlc' = SHARDS.mapBy(_ => 0),
    hist' = KEYS.mapBy(k => if (BASE.contains(k)) Set({ ver: 0, writer: 0 }) else Set()),
    intents' = KEYS.mapBy(_ => { txn: NONE, pts: 0 })
  }

  // ---- アクション (決定的な引数付き版。step から nondet で呼ぶ) -----------------
  // 取引開始: テンプレートを選び、最初に触るシャード home の HLC を T にする
  action begin(tid: int, tm: Tmpl, home: int): bool = all {
    txns.get(tid).status == Idle,
    tm.reads.map(k => shardOf(k)).union(tm.writes.map(k => shardOf(k)))
      .union(if (tm.pred == 0) Set() else Set(tm.pred)).contains(home),
    txns' = txns.set(tid, idleTxn.with("status", Reading).with("tmpl", tm).with("T", hlc.get(home))),
    hlc' = hlc, hist' = hist, intents' = intents
  }

  // 点読み: HLC を T まで進め、T 時点の版を読む
  action readKey(tid: int, k: int): bool = all {
    val t = txns.get(tid)
    all {
      t.status == Reading,
      t.tmpl.reads.contains(k),
      not(t.readVals.keys().contains(k)),
      not(blockedBy(k, tid, t.T)),
      val p = shardOf(k)
      val t1 = t.with("readVals", t.readVals.put(k, versionAt(k, t.T).writer))
      all {
        hlc' = hlc.set(p, max(hlc.get(p), t.T)),
        txns' = withPushes(txns.set(tid, t1), pushTargets(Set(k), tid, t.T), t.T),
        hist' = hist, intents' = intents
      }
    }
  }

  // 述語読み: shard p に T 時点で存在するキー集合を読む
  action readPred(tid: int): bool = all {
    val t = txns.get(tid)
    all {
      t.status == Reading,
      t.tmpl.pred != 0,
      not(t.predDone),
      val p = t.tmpl.pred
      all {
        not(keysOn(p).exists(k => blockedBy(k, tid, t.T))),
        val seen = keysOn(p).filter(k => versionAt(k, t.T).ver >= 0)
        val t1 = t.with("predSeen", seen).with("predDone", true)
        all {
          hlc' = hlc.set(p, max(hlc.get(p), t.T)),
          txns' = withPushes(txns.set(tid, t1), pushTargets(keysOn(p), tid, t.T), t.T),
          hist' = hist, intents' = intents
        }
      }
    }
  }

  // 読み取り専用取引の終了: 直列化点は T
  action finishRO(tid: int): bool = all {
    val t = txns.get(tid)
    all {
      t.status == Reading, readsDone(t), isRO(t),
      txns' = txns.set(tid, t.with("status", Committed).with("c", t.T)),
      hlc' = hlc, hist' = hist, intents' = intents
    }
  }

  // Worker が anchor へ commit を送る (anchor は参加者のどれでもよい)
  action sendCommit(tid: int, a: int): bool = all {
    val t = txns.get(tid)
    all {
      t.status == Reading, readsDone(t), not(isRO(t)),
      participants(t).contains(a),
      txns' = txns.set(tid, t.with("status", Preparing).with("anchor", a)),
      hlc' = hlc, hist' = hist, intents' = intents
    }
  }

  // anchor 以外の参加者の prepare
  action prepare(tid: int, p: int): bool = all {
    val t = txns.get(tid)
    all {
      t.status == Preparing,
      p != t.anchor,
      participants(t).contains(p),
      not(t.pts.keys().contains(p)),
      val ok = not(prepareConflict(tid, t, p))
      val newPts = hlc.get(p) + 1
      all {
        hlc' = if (ok) hlc.set(p, newPts) else hlc,
        intents' = if (ok) placeIntents(tid, t, p, newPts) else intentsWithout(tid),
        txns' = if (ok) txns.set(tid, t.with("pts", t.pts.put(p, newPts)))
                else txns.set(tid, t.with("status", Aborted)),
        hist' = hist
      }
    }
  }

  // anchor の prepare と c の決定
  action anchorPrepare(tid: int): bool = all {
    val t = txns.get(tid)
    all {
      t.status == Preparing,
      participants(t).exclude(Set(t.anchor)) == t.pts.keys(),
      val a = t.anchor
      val others = maxOf(t.pts.keys().map(p => t.pts.get(p)), 0)
      // green: 受け取った prepare_ts と pushed を HLC に取り込んでから厳密増加
      val base = if (RED_B) hlc.get(a) else max(hlc.get(a), max(others, t.pushed))
      val ptsA = base + 1
      val ok = not(prepareConflict(tid, t, a))
      val c = max(max(ptsA, others), t.pushed + 1)
      val toRef = participants(t).filter(p => p != a and t.pts.get(p) < c and hasUnprotected(t, p))
      all {
        hlc' = if (ok) hlc.set(a, ptsA) else hlc,
        intents' = if (ok) placeIntents(tid, t, a, ptsA) else intentsWithout(tid),
        txns' = if (ok)
                  txns.set(tid, t.with("pts", t.pts.put(a, ptsA)).with("c", c).with("toRefresh", toRef)
                                 .with("status", if (toRef == Set()) Committed else Refreshing))
                else txns.set(tid, t.with("status", Aborted)),
        hist' = hist
      }
    }
  }

  // 未保護 span を持つ参加者の refresh: HLC を c まで進め、(prepare_ts, c] を照合
  action refresh(tid: int, p: int): bool = all {
    val t = txns.get(tid)
    all {
      t.status == Refreshing,
      t.toRefresh.contains(p),
      val newH = if (RED_C) hlc.get(p) else max(hlc.get(p), t.c)
      val ok = not(spanConflict(tid, t, p, t.pts.get(p), t.c))
      val rest = t.toRefresh.exclude(Set(p))
      all {
        hlc' = hlc.set(p, newH),
        intents' = if (ok) intents else intentsWithout(tid),
        txns' = if (ok)
                  txns.set(tid, t.with("toRefresh", rest).with("didRefresh", true)
                                 .with("status", if (rest == Set()) Committed else Refreshing))
                else txns.set(tid, t.with("status", Aborted)),
        hist' = hist
      }
    }
  }

  // phase 2: 参加者 p で intent を本体へ適用
  action apply(tid: int, p: int): bool = all {
    val t = txns.get(tid)
    all {
      t.status == Committed,
      writeShards(t).contains(p),
      not(t.applied.contains(p)),
      hlc' = hlc.set(p, max(hlc.get(p), t.c)),
      hist' = KEYS.mapBy(k =>
        if (t.tmpl.writes.contains(k) and shardOf(k) == p) hist.get(k).union(Set({ ver: t.c, writer: tid }))
        else hist.get(k)),
      intents' = KEYS.mapBy(k =>
        if (t.tmpl.writes.contains(k) and shardOf(k) == p) { txn: NONE, pts: 0 } else intents.get(k)),
      txns' = txns.set(tid, t.with("applied", t.applied.union(Set(p))))
    }
  }

  // 時計のずれ: 物理時刻が進む
  action tick(s: int): bool = all {
    hlc.get(s) < CLOCK_MAX,
    hlc' = hlc.set(s, hlc.get(s) + 1),
    txns' = txns, hist' = hist, intents' = intents
  }

  action step = any {
    { nondet tid = oneOf(TXNS) nondet tm = oneOf(TEMPLATES) nondet home = oneOf(SHARDS) begin(tid, tm, home) },
    { nondet tid = oneOf(TXNS) nondet k = oneOf(KEYS) readKey(tid, k) },
    { nondet tid = oneOf(TXNS) readPred(tid) },
    { nondet tid = oneOf(TXNS) finishRO(tid) },
    { nondet tid = oneOf(TXNS) nondet a = oneOf(SHARDS) sendCommit(tid, a) },
    { nondet tid = oneOf(TXNS) nondet p = oneOf(SHARDS) prepare(tid, p) },
    { nondet tid = oneOf(TXNS) anchorPrepare(tid) },
    { nondet tid = oneOf(TXNS) nondet p = oneOf(SHARDS) refresh(tid, p) },
    { nondet tid = oneOf(TXNS) nondet p = oneOf(SHARDS) apply(tid, p) },
    { nondet s = oneOf(SHARDS) tick(s) }
  }

  // ---- 不変条件 -------------------------------------------------------------
  // 直列化順: (c, rank)。rank は書き手 = tid、読み取り専用 = NTXN + tid (c == T の書き手を見る側)
  def orderKey(tid: int): (int, int) =
    val t = txns.get(tid)
    (t.c, if (isRO(t)) NTXN + tid else tid)
  pure def lt(a: (int, int), b: (int, int)): bool = a._1 < b._1 or (a._1 == b._1 and a._2 < b._2)
  def committedWriters(k: int): Set[int] =
    TXNS.filter(u => txns.get(u).status == Committed and txns.get(u).tmpl.writes.contains(k))
  // tid の直前に k を書いた committed 取引 (無ければ 0 = 初期値、insert 用キーは -1 = 不在)
  def expectedWriter(k: int, tid: int): int =
    val before = committedWriters(k).filter(u => u != tid and lt(orderKey(u), orderKey(tid)))
    // before の中で順序最大の要素 (rank が tid 由来なので一意)
    val top = before.filter(u => before.forall(v => not(lt(orderKey(u), orderKey(v)))))
    if (before == Set()) (if (BASE.contains(k)) 0 else -1)
    else top.fold(0, (acc, u) => u)

  val serializable = TXNS.forall(tid =>
    val t = txns.get(tid)
    t.status != Committed or (
      t.readVals.keys().forall(k => t.readVals.get(k) == expectedWriter(k, tid))
      and (t.tmpl.pred == 0 or t.predSeen == keysOn(t.tmpl.pred).filter(k => expectedWriter(k, tid) != -1))
    ))

  // M2 用: 読み取り専用取引から見た書き手の atomic visibility。
  // 読んだ各キーについて、見た版が c_w 以上なら「w を見た」。全キーで一致し、かつ見た iff c_w <= T。
  def seenVer(r: Txn, k: int): int =
    val w = r.readVals.get(k)
    if (w == 0) 0 else txns.get(w).c
  val atomicVisibility = TXNS.forall(rid =>
    val r = txns.get(rid)
    not(isRO(r) and r.status == Committed) or TXNS.forall(wid =>
      val w = txns.get(wid)
      val ks = w.tmpl.writes.intersect(r.readVals.keys())
      w.status != Committed or isRO(w) or ks == Set() or
        ks.forall(k => (seenVer(r, k) >= w.c) == (w.c <= r.T))
    ))

  // vacuity の確認用 (これらは「違反」が出るのが正しい)
  val witnessCrossCommit = not(TXNS.exists(tid =>
    val t = txns.get(tid)
    t.status == Committed and writeShards(t).size() == 2 and t.applied == writeShards(t)))
  val witnessRefreshCommit = not(TXNS.exists(tid =>
    val t = txns.get(tid)
    t.status == Committed and t.didRefresh))
  val witnessROSeesCross = not(TXNS.exists(rid => TXNS.exists(wid =>
    val r = txns.get(rid)
    val w = txns.get(wid)
    isRO(r) and r.status == Committed and not(isRO(w)) and w.status == Committed
      and writeShards(w).size() == 2 and r.readVals.keys().forall(k => r.readVals.get(k) == wid))))
}

// ---- インスタンス -------------------------------------------------------------
module m1_green {
  import m1_core(RED_A = false, RED_B = false, RED_C = false, RED_D = false, RED_E = false, RED_F = false, RED_G = false,
                 NTXN = 2, CLOCK_MAX = 2).*
  // witness: クロスシャード commit に到達できる
  run crossCommitReachableTest =
    init.then(begin(1, { reads: Set(1), pred: 0, writes: Set(3) }, 1))
        .then(readKey(1, 1))
        .then(sendCommit(1, 1))
        .then(prepare(1, 2))
        .then(anchorPrepare(1))
        .then(apply(1, 2))
        .expect(txns.get(1).status == Committed and txns.get(1).c == 2 and serializable)
  // witness: refresh を経由して commit できる (anchor を書き側に選ぶ)
  run refreshCommitReachableTest =
    init.then(begin(1, { reads: Set(1), pred: 0, writes: Set(3) }, 1))
        .then(readKey(1, 1))
        .then(sendCommit(1, 2))
        .then(prepare(1, 1))
        .then(tick(2))
        .then(anchorPrepare(1))
        .expect(txns.get(1).status == Refreshing)
        .then(refresh(1, 1))
        .expect(txns.get(1).status == Committed and txns.get(1).didRefresh and hlc.get(1) == txns.get(1).c)
}

module m1_green3 {
  import m1_core(RED_A = false, RED_B = false, RED_C = false, RED_D = false, RED_E = false, RED_F = false, RED_G = false,
                 NTXN = 3, CLOCK_MAX = 2).*
}

// (a) 読み取り専用参加者へ prepare を送らない → 読んだシャードの検証が抜ける
module m1_red_a {
  import m1_core(RED_A = true, RED_B = false, RED_C = false, RED_D = false, RED_E = false, RED_F = false, RED_G = false,
                 NTXN = 2, CLOCK_MAX = 2).*
  // W1: x@S1 を T=0 で読み y@S2 に書く。W2: x に blind write、c2 = 1。
  // W1 は S2 だけで prepare (読み専用の S1 は参加者でない) → c1 = 3 > c2 なのに古い x を読んでいる。
  run counterexampleTest =
    init.then(begin(1, { reads: Set(1), pred: 0, writes: Set(3) }, 1))
        .then(readKey(1, 1))
        .then(begin(2, { reads: Set(), pred: 0, writes: Set(1) }, 1))
        .then(sendCommit(2, 1))
        .then(anchorPrepare(2))
        .then(apply(2, 1))
        .then(tick(2)).then(tick(2))
        .then(sendCommit(1, 2))
        .then(anchorPrepare(1))
        .then(apply(1, 2))
        .expect(txns.get(1).status == Committed and txns.get(2).status == Committed
                and txns.get(2).c < txns.get(1).c and not(serializable))
}

// (b) anchor が受け取った prepare_ts を取り込まない → anchor 自身の未保護 span が (pts_a, c] で未検証
module m1_red_b {
  import m1_core(RED_A = false, RED_B = true, RED_C = false, RED_D = false, RED_E = false, RED_F = false, RED_G = false,
                 NTXN = 2, CLOCK_MAX = 2).*
  // W1: x@S1 (anchor、HLC 0) を読み y@S2 (HLC 2) に書く。S2 の pts = 3、anchor の pts = 1、c = 3。
  // S1 の HLC は 1 のまま。W2 が x に blind write、c2 = 2 < c1 = 3。W1 は W2 を見ていない。
  run counterexampleTest =
    init.then(tick(2)).then(tick(2))
        .then(begin(1, { reads: Set(1), pred: 0, writes: Set(3) }, 1))
        .then(readKey(1, 1))
        .then(sendCommit(1, 1))
        .then(prepare(1, 2))
        .then(anchorPrepare(1))
        .expect(txns.get(1).status == Committed and txns.get(1).c == 3 and hlc.get(1) == 1)
        .then(begin(2, { reads: Set(), pred: 0, writes: Set(1) }, 1))
        .then(sendCommit(2, 1))
        .then(anchorPrepare(2))
        .then(apply(2, 1))
        .then(apply(1, 2))
        .expect(txns.get(2).c == 2 and not(serializable))
}

// (c) refresh が HLC を c まで進めない → refresh 後に c 以下の prepare_ts で intent が置ける
module m1_red_c {
  import m1_core(RED_A = false, RED_B = false, RED_C = true, RED_D = false, RED_E = false, RED_F = false, RED_G = false,
                 NTXN = 2, CLOCK_MAX = 2).*
  // W1: x@S1 (HLC 0) を読み y@S2 (HLC 2) に書く、anchor S2。S1 の pts = 1、c1 = 3。
  // S1 を refresh するが HLC を 3 まで進めない (HLC 1 のまま)。
  // W2: x に blind write、S1 の pts = 2 → c2 = 2 < c1。W1 は W2 の x を見ていないのに後ろに並ぶ。
  run counterexampleTest =
    init.then(tick(2)).then(tick(2))
        .then(begin(1, { reads: Set(1), pred: 0, writes: Set(3) }, 1))
        .then(readKey(1, 1))
        .then(sendCommit(1, 2))
        .then(prepare(1, 1))
        .then(anchorPrepare(1))
        .expect(txns.get(1).status == Refreshing and txns.get(1).c == 3)
        .then(refresh(1, 1))
        .expect(txns.get(1).status == Committed and hlc.get(1) == 1)
        .then(begin(2, { reads: Set(), pred: 0, writes: Set(1) }, 1))
        .then(sendCommit(2, 1))
        .then(anchorPrepare(2))
        .expect(txns.get(2).status == Committed and txns.get(2).c == 2)
        .then(apply(2, 1)).then(apply(1, 2))
        .expect(not(serializable))
}

// (d) 述語読みを保護済み扱い → phantom insert を見逃す
module m1_red_d {
  import m1_core(RED_A = false, RED_B = false, RED_C = false, RED_D = true, RED_E = false, RED_F = false, RED_G = false,
                 NTXN = 2, CLOCK_MAX = 2).*
  // W1: S1 を述語読み ({x})、x と y を書く、anchor S2 (HLC 2)。S1 の pts = 1、c1 = 3。
  // RED_D では S1 の span が保護済みなので refresh しない。
  // W2: xi を insert、c2 = 2 < c1。W1 の読み {x} は c1 時点の {x, xi} と一致しない。
  run counterexampleTest =
    init.then(tick(2)).then(tick(2))
        .then(begin(1, { reads: Set(), pred: 1, writes: Set(1, 3) }, 1))
        .then(readPred(1))
        .then(sendCommit(1, 2))
        .then(prepare(1, 1))
        .then(anchorPrepare(1))
        .expect(txns.get(1).status == Committed and txns.get(1).c == 3)
        .then(begin(2, { reads: Set(), pred: 0, writes: Set(2) }, 1))
        .then(sendCommit(2, 1))
        .then(anchorPrepare(2))
        .then(apply(2, 1))
        .then(apply(1, 1)).then(apply(1, 2))
        .expect(txns.get(2).c == 2 and not(serializable))
}

// (e) 検証で intent を見ない → 互いの intent を見逃して write skew
module m1_red_e {
  import m1_core(RED_A = false, RED_B = false, RED_C = false, RED_D = false, RED_E = true, RED_F = false, RED_G = false,
                 NTXN = 2, CLOCK_MAX = 2).*
  // W1: x@S1 読み y@S2 書き、anchor S1。W2: y@S2 読み x@S1 書き、anchor S2。
  // W1 が S2 に y の intent、W2 が S1 に x の intent を置く。
  // W1 の anchor prepare (S1): x に W2 の intent があるが無視 → commit。
  // W2 の anchor prepare (S2): y に W1 の intent (committed、未適用) があるが無視 → commit。
  run counterexampleTest =
    init.then(begin(1, { reads: Set(1), pred: 0, writes: Set(3) }, 1))
        .then(readKey(1, 1))
        .then(begin(2, { reads: Set(3), pred: 0, writes: Set(1) }, 2))
        .then(readKey(2, 3))
        .then(sendCommit(1, 1))
        .then(prepare(1, 2))
        .then(sendCommit(2, 2))
        .then(prepare(2, 1))
        .then(anchorPrepare(1))
        .expect(txns.get(1).status == Committed)
        .then(anchorPrepare(2))
        .expect(txns.get(2).status == Committed)
        .then(apply(1, 2)).then(apply(2, 1))
        .expect(not(serializable))
}

// (g) 検査で見つかった設計バグ: c 決定後の refresh 窓で push を受理すると、push は c を動かせないのに
//     読み手は「push 成功」として intent を無視し、c <= T の書き込みを見落とす。
module m1_red_g {
  import m1_core(RED_A = false, RED_B = false, RED_C = false, RED_D = false, RED_E = false, RED_F = false, RED_G = true,
                 NTXN = 2, CLOCK_MAX = 2).*
  // W1: S2 を述語読み (T=0)、x@S1 と y@S2 を書く、anchor S1。S2 の pts = 1、anchor pts = c = 2、S2 を refresh 待ち。
  // R: T = hlc[S1] = 2 で開始。x の intent (pts 2 <= T、W1 は Refreshing) を push → 受理されるが c = 2 は変わらない。
  // R は x, y の古い値を読む。W1 は refresh を通って c = 2 <= T で commit。R は W1 より後ろなのに W1 を見ていない。
  run counterexampleTest =
    init.then(begin(1, { reads: Set(), pred: 2, writes: Set(1, 3) }, 1))
        .then(readPred(1))
        .then(sendCommit(1, 1))
        .then(prepare(1, 2))
        .then(anchorPrepare(1))
        .expect(txns.get(1).status == Refreshing and txns.get(1).c == 2)
        .then(begin(2, { reads: Set(1, 3), pred: 0, writes: Set() }, 1))
        .expect(txns.get(2).T == 2)
        .then(readKey(2, 1))
        .expect(txns.get(1).pushed == 2 and txns.get(2).readVals.get(1) == 0)
        .then(readKey(2, 3))
        .then(finishRO(2))
        .then(refresh(1, 2))
        .expect(txns.get(1).status == Committed and txns.get(1).c == 2 and not(serializable))
}

// M2: マルチシャード読みの atomic visibility。green は push、red は in-flight intent をタイムアウトで通過
module m2_green {
  import m1_core(RED_A = false, RED_B = false, RED_C = false, RED_D = false, RED_E = false, RED_F = false, RED_G = false,
                 NTXN = 2, CLOCK_MAX = 2).*
  // witness: 読み手がクロスシャード書き込みを両シャードで見る
  run roSeesBothTest =
    init.then(begin(1, { reads: Set(), pred: 0, writes: Set(1, 3) }, 1))
        .then(sendCommit(1, 1))
        .then(prepare(1, 2))
        .then(anchorPrepare(1))
        .then(apply(1, 1)).then(apply(1, 2))
        .then(begin(2, { reads: Set(1, 3), pred: 0, writes: Set() }, 1))
        .then(readKey(2, 1)).then(readKey(2, 3))
        .then(finishRO(2))
        .expect(txns.get(2).readVals == Map(1 -> 1, 3 -> 1) and atomicVisibility)
}

module m2_red {
  import m1_core(RED_A = false, RED_B = false, RED_C = false, RED_D = false, RED_E = false, RED_F = true, RED_G = false,
                 NTXN = 2, CLOCK_MAX = 2).*
  // W: x@S1, y@S2 に blind write、anchor S1。S2 で prepare (pts 1)。
  // S2 の時計が進み (HLC 2)、R が T = 2 で開始。R は y の in-flight intent (pts 1 <= T) を push せず通過 → 古い y。
  // W の anchor prepare: c = 2 <= T。W が S1 に適用された後、R が x を読む → 新しい x。
  run counterexampleTest =
    init.then(begin(1, { reads: Set(), pred: 0, writes: Set(1, 3) }, 1))
        .then(sendCommit(1, 1))
        .then(prepare(1, 2))
        .then(tick(2))
        .then(begin(2, { reads: Set(1, 3), pred: 0, writes: Set() }, 2))
        .then(readKey(2, 3))
        .expect(txns.get(2).readVals.get(3) == 0 and txns.get(1).pushed == 0)
        .then(anchorPrepare(1))
        .expect(txns.get(1).status == Committed and txns.get(1).c <= txns.get(2).T)
        .then(apply(1, 1))
        .then(readKey(2, 1))
        .then(finishRO(2))
        .expect(txns.get(2).readVals.get(1) == 1 and not(atomicVisibility))
}
