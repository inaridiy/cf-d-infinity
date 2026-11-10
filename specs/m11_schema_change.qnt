// M11: 取引と並行に進む表定義の変更 (DDL)
//
// 実装 (client/db.ts の Db.ddl と backfill、meta.ts、shard/core.ts の ensureSchema) の仕組みをそのまま写す。
//   - Meta が表定義の版を上げる (issue)。
//   - DDL を実行した Worker は、全シャードへ適用 (sync) してから先へ進む。シャードは新しい版の要求が来たときにも自分で適用する。
//   - 要求は計画に使った catalog の版を持つ。シャードは自分より古い版の要求を拒否する。
//   - グローバル index は write-only で作り、既存の行を埋め (backfill)、最後に public にする。
//     backfill は 1 シャードずつ、表を読み (bfScan)、別の取引で index へ書く (bfWrite)。
//   - Worker は古い catalog で計画してよい (cat = 0: index を知らない、1: write-only、2: public)。
//   - 取引は 1 シャードの autocommit (版の確認 localEnter と書き込み localApply の間に待ちが入り得る) と、
//     2 シャードの 2PC (anchor が版を確認 crossEnter、参加者が prepare、anchor が自分の prepare と確定 crossDecide、
//     各シャードで適用 apply) の 2 種類。
//
// DDL は 1 本で、種類は定数で選ぶ。
//   RECREATE = false: CREATE [UNIQUE] INDEX ix ON t(v)。v はシャードキーを含まないのでグローバル index になる。
//   RECREATE = true:  DROP TABLE t と CREATE TABLE t (同じ名前で作り直す)。シャードは適用時に表の中身を捨てる。
//
// 行は 2 個 (行 1 は S1、行 2 は S2。COLOCATED なら両方 S1)。値は 0 (行なし)、1、2。最初は行 1 = 1 だけがある。
// index の項目は (値, 行) の集合で、取引の確定と同時に変わる (index の表自体の 2PC は M1 と M9 に任せる)。
// 表の行は確定後に各シャードで適用されるので、「確定済みで未適用」の intent がシャードに残る。
//
// invariant (schemaSafe はこれらの連言):
//   indexComplete: public な index は、すべての行の項目を持つ (index で引いて見えない行がない)
//   noDangling:    public な index に、行のない項目がない
//   uniqueSafe:    public な UNIQUE index があるなら、同じ値の行が 2 つない
//   noLostWrite:   DDL が完了を返した後に成功を返した書き込みは、DDL の適用で消えない
//   noResurrect:   DDL の発行前に確定した書き込みは、作り直した表に現れない
//
// 定数は 2 組ある。
//   実装にある防御 (red で 1 つずつ外す): REJECT_STALE、SYNC_FIRST、WRITE_ONLY、PUBLIC_LAST
//   実装にない防御 (green で入れた修正案。impl では外す): RECHECK_AUTO、RECHECK_ANCHOR、DRAIN、BF_VALIDATE、CHUNK_DEDUP
// つまり green は実装そのものではない。実装どおりの m11_impl は schemaSafe を破る (test/ddl-concurrent.test.ts の BUG-1 から BUG-5)。
module m11_core {
  const RECREATE: bool
  const UNIQUE: bool
  const COLOCATED: bool
  const NTXN: int

  // 実装にある防御
  const REJECT_STALE: bool    // シャードが自分より古い版の要求を拒否する (core.ts ensureSchema)
  const SYNC_FIRST: bool      // 全シャードへ適用してから backfill を始め、完了を返す (db.ts ddl)
  const WRITE_ONLY: bool      // write-only の index を書き込みが更新する (db.ts indexChanges)
  const PUBLIC_LAST: bool     // 全シャードの backfill が終わってから public にする (db.ts backfill)

  // 実装にない防御
  const RECHECK_AUTO: bool    // autocommit の書き込みが、待ちの後で版を確かめ直す
  const RECHECK_ANCHOR: bool  // anchor が、参加者の prepare を待った後で版を確かめ直す
  const DRAIN: bool           // シャードは、intent を持っている間は DDL を適用しない (先に決着させる)
  const BF_VALIDATE: bool     // backfill の書き込みが、読んだ後に行が変わっていないことを確かめる (変わっていれば読み直す)
  const CHUNK_DEDUP: bool     // UNIQUE の backfill が、同じ取引の中の重複を上書きせずに失敗にする

  pure val SHARDS = Set(1, 2)
  pure val ROWS = Set(1, 2)
  pure val VALS = Set(0, 1, 2)
  pure val CATS = Set(0, 1, 2)
  pure val TXNS = 1.to(NTXN)

  type Phase = NotIssued | Issued | Returned | Public | Failed
  type St = Idle | L0 | L1 | C0 | C1 | C2 | Committed | Aborted | Rejected
  // t = 0 は intent なし。d は確定済み (未適用)
  type Intent = { t: int, v: int, d: bool }
  // cross でなければ行 r へ k1 を書く。cross なら行 1 へ k1、行 2 へ k2 を書く。
  // m は index を更新する計画かどうか。ack は確定した時点の DDL の段階 (0: 発行前、1: 途中、2: 完了後)。
  // dead は、計画の後に同じ行へ別の取引が確定したことを表す。2PC の取引は commit の検証 (write after T) で中止になる。
  // autocommit は書く時点の最新の行に対して文を実行するので、この検証はない
  type Txn = { st: St, cross: bool, r: int, k1: int, k2: int, cat: int, m: bool, ack: int, dead: bool }

  var phase: Phase
  var sv: int -> int               // シャードが適用した版 (0 か 1)
  var bf: int -> int               // backfill の進み (0: 未読、1: 読んだ、2: 書いた)
  var buf: int -> int              // backfill が読んだ行の値
  var tbl: int -> int
  var idx: Set[(int, int)]
  var intent: int -> Intent
  var txn: int -> Txn
  var lastW: int -> int            // ghost: 行を最後に確定で書いた取引

  pure val NONE: Intent = { t: 0, v: 0, d: false }
  pure def shardOf(r: int): int = if (r == 1 or COLOCATED) 1 else 2
  pure def rowsOf(s: int): Set[int] = ROWS.filter(r => shardOf(r) == s)

  // 確定済みの intent を適用した後の値。読み手は確定済みの intent を決着させてから読む (core.ts settleIntents)
  def lv(r: int): int = if (intent.get(r).t != 0 and intent.get(r).d) intent.get(r).v else tbl.get(r)
  def catNow: int = if (phase == NotIssued) 0 else if (phase == Public or phase == Failed) 2 else 1
  def phaseNum: int = if (phase == NotIssued) 0 else if (phase == Issued) 1 else 2
  def indexAlive: bool = not(RECREATE) and (phase == Issued or phase == Public)
  def reqVer(x: int): int = if (txn.get(x).cat >= 1) 1 else 0
  def stale(x: int, s: int): bool = REJECT_STALE and sv.get(s) > reqVer(x)
  def noIntents(s: int): bool = rowsOf(s).forall(r => intent.get(r).t == 0)
  def synced: bool = SHARDS.forall(s => sv.get(s) == 1)

  // シャード s が DDL を適用する。作り直しなら表の中身が消える
  def tblAfterSync(s: int): int -> int = if (RECREATE) ROWS.mapBy(r => if (shardOf(r) == s) 0 else tbl.get(r)) else tbl
  // 新しい版の要求が、まだ適用していないシャードに届くと、シャードは先に DDL を適用する
  def canEnsure(x: int, s: int): bool = sv.get(s) >= reqVer(x) or not(DRAIN) or noIntents(s)
  def svAfter(x: int, s: int): int -> int = if (sv.get(s) < reqVer(x)) sv.set(s, 1) else sv
  def tblAfter(x: int, s: int): int -> int = if (sv.get(s) < reqVer(x)) tblAfterSync(s) else tbl

  pure def idxPut(ix: Set[(int, int)], r: int, old: int, k: int): Set[(int, int)] =
    ix.exclude(Set((old, r))).union(if (k != 0) Set((k, r)) else Set())
  pure def clash(ix: Set[(int, int)], r: int, k: int): bool = k != 0 and ix.exists(e => e._1 == k and e._2 != r)
  def maint(t: Txn): bool = t.m and indexAlive
  def uniq(t: Txn): bool = UNIQUE and maint(t)
  // 取引 x が確定した。計画済みで未確定の 2PC の取引は、x と同じ行を書くので検証で落ちる (2PC は両方の行を書く)
  def commitOf(x: int, t: Txn): int -> Txn = TXNS.mapBy(y =>
    if (y == x) { ...t, st: Committed, ack: phaseNum }
    else if (txn.get(y).cross and (txn.get(y).st == C0 or txn.get(y).st == C1 or txn.get(y).st == C2)) { ...txn.get(y), dead: true }
    else txn.get(y))

  action init = all {
    phase' = NotIssued, sv' = SHARDS.mapBy(_ => 0), bf' = SHARDS.mapBy(_ => 0), buf' = ROWS.mapBy(_ => 0),
    tbl' = ROWS.mapBy(r => if (r == 1) 1 else 0), idx' = Set(), intent' = ROWS.mapBy(_ => NONE),
    txn' = TXNS.mapBy(_ => { st: Idle, cross: false, r: 1, k1: 0, k2: 0, cat: 0, m: false, ack: -1, dead: false }),
    lastW' = ROWS.mapBy(_ => 0),
  }
  action keepDdl = all { phase' = phase, bf' = bf, buf' = buf }
  action keepData = all { tbl' = tbl, idx' = idx, intent' = intent, lastW' = lastW }

  // ---- DDL ----

  action issue = all { phase == NotIssued, phase' = Issued, bf' = bf, buf' = buf, sv' = sv, txn' = txn, keepData }

  action sync(s: int): bool = all {
    phase != NotIssued, sv.get(s) == 0, not(DRAIN) or noIntents(s),
    sv' = sv.set(s, 1), tbl' = tblAfterSync(s),
    idx' = idx, intent' = intent, lastW' = lastW, txn' = txn, keepDdl,
  }

  // 作り直しの DDL が完了を返す
  action ddlReturn = all {
    RECREATE, phase == Issued, not(SYNC_FIRST) or synced,
    phase' = Returned, bf' = bf, buf' = buf, sv' = sv, txn' = txn, keepData,
  }

  // backfill がシャード s の表を読む。確定済みの intent は決着させ、未確定の intent は押し出して読み飛ばす
  action bfScan(s: int): bool = all {
    not(RECREATE), phase == Issued, bf.get(s) == 0, not(SYNC_FIRST) or synced,
    sv.get(s) == 1 or not(DRAIN) or noIntents(s),
    sv' = sv.set(s, 1),
    buf' = ROWS.mapBy(r => if (shardOf(r) == s) lv(r) else buf.get(r)),
    bf' = bf.set(s, 1), phase' = phase, txn' = txn, keepData,
  }

  // backfill がシャード s の分を index へ書く。1 シャードの行は 1 つの取引で書く
  action bfWrite(s: int): bool = {
    val rows = rowsOf(s)
    val changed = rows.exists(r => lv(r) != buf.get(r))
    val entries = rows.filter(r => buf.get(r) != 0).map(r => (buf.get(r), r))
    val dupInChunk = UNIQUE and rows.exists(a => rows.exists(b => a < b and buf.get(a) != 0 and buf.get(a) == buf.get(b)))
    // 実装は同じ取引の中の 2 件目で 1 件目を上書きする (UNIQUE の index 表の主キーは値だけである)
    val kept = if (dupInChunk) entries.filter(e => e._2 == 2) else entries
    val conflict = UNIQUE and kept.exists(e => clash(idx, e._2, e._1))
    all {
      not(RECREATE), phase == Issued, bf.get(s) == 1,
      if (BF_VALIDATE and changed) all { bf' = bf.set(s, 0), idx' = idx, phase' = phase }
      else if (conflict or (dupInChunk and CHUNK_DEDUP)) all { phase' = Failed, idx' = Set(), bf' = bf }
      else all { idx' = idx.union(kept), bf' = bf.set(s, 2), phase' = phase },
      buf' = buf, sv' = sv, tbl' = tbl, intent' = intent, lastW' = lastW, txn' = txn,
    }
  }

  action publish = all {
    not(RECREATE), phase == Issued, not(PUBLIC_LAST) or SHARDS.forall(s => bf.get(s) == 2),
    phase' = Public, bf' = bf, buf' = buf, sv' = sv, txn' = txn, keepData,
  }

  // ---- 1 シャードの autocommit ----

  def planned(c: int): bool = (c == 1 and WRITE_ONLY) or (c == 2 and phase == Public)

  action planLocal(x: int, r: int, k: int, c: int): bool = all {
    txn.get(x).st == Idle, c <= catNow,
    txn' = txn.set(x, { st: L0, cross: false, r: r, k1: k, k2: 0, cat: c, m: planned(c), ack: -1, dead: false }),
    sv' = sv, keepDdl, keepData,
  }

  // シャードが要求を受け、版を確かめる
  action localEnter(x: int): bool = {
    val t = txn.get(x)
    val s = shardOf(t.r)
    all {
      t.st == L0,
      if (stale(x, s)) all { txn' = txn.set(x, { ...t, st: Rejected }), sv' = sv, tbl' = tbl }
      else all { canEnsure(x, s), txn' = txn.set(x, { ...t, st: L1 }), sv' = svAfter(x, s), tbl' = tblAfter(x, s) },
      idx' = idx, intent' = intent, lastW' = lastW, keepDdl,
    }
  }

  // 行ロックか intent の決着を待った後で、書いて確定する
  action localApply(x: int): bool = {
    val t = txn.get(x)
    val s = shardOf(t.r)
    all {
      t.st == L1,
      if (RECHECK_AUTO and stale(x, s)) all { txn' = txn.set(x, { ...t, st: Rejected }), tbl' = tbl, idx' = idx, lastW' = lastW }
      else all {
        intent.get(t.r).t == 0,
        if (uniq(t) and clash(idx, t.r, t.k1)) all { txn' = txn.set(x, { ...t, st: Aborted }), tbl' = tbl, idx' = idx, lastW' = lastW }
        else all {
          tbl' = tbl.set(t.r, t.k1),
          idx' = if (maint(t)) idxPut(idx, t.r, tbl.get(t.r), t.k1) else idx,
          lastW' = lastW.set(t.r, x),
          txn' = commitOf(x, t),
        },
      },
      intent' = intent, sv' = sv, keepDdl,
    }
  }

  // ---- 2 シャードの 2PC (anchor は S1) ----

  action planCross(x: int, k1: int, k2: int, c: int): bool = all {
    not(COLOCATED), txn.get(x).st == Idle, c <= catNow,
    txn' = txn.set(x, { st: C0, cross: true, r: 1, k1: k1, k2: k2, cat: c, m: planned(c), ack: -1, dead: false }),
    sv' = sv, keepDdl, keepData,
  }

  // anchor が COMMIT を受け、版を確かめる
  action crossEnter(x: int): bool = {
    val t = txn.get(x)
    all {
      t.st == C0,
      if (stale(x, 1)) all { txn' = txn.set(x, { ...t, st: Rejected }), sv' = sv, tbl' = tbl }
      else all { canEnsure(x, 1), txn' = txn.set(x, { ...t, st: C1 }), sv' = svAfter(x, 1), tbl' = tblAfter(x, 1) },
      idx' = idx, intent' = intent, lastW' = lastW, keepDdl,
    }
  }

  // 参加者 S2 が版を確かめ、intent を置く
  action crossPrepare(x: int): bool = {
    val t = txn.get(x)
    all {
      t.st == C1,
      if (stale(x, 2)) all { txn' = txn.set(x, { ...t, st: Rejected }), sv' = sv, tbl' = tbl, intent' = intent }
      else all {
        canEnsure(x, 2), intent.get(2).t == 0,
        intent' = intent.set(2, { t: x, v: t.k2, d: false }),
        txn' = txn.set(x, { ...t, st: C2 }), sv' = svAfter(x, 2), tbl' = tblAfter(x, 2),
      },
      idx' = idx, lastW' = lastW, keepDdl,
    }
  }

  // anchor が応答を受け、自分の prepare と確定を 1 つの同期区間で行う。index の項目も同時に変わる
  action crossDecide(x: int): bool = {
    val t = txn.get(x)
    all {
      t.st == C2,
      if (RECHECK_ANCHOR and stale(x, 1)) all {
        txn' = txn.set(x, { ...t, st: Rejected }), intent' = intent.set(2, NONE), idx' = idx, lastW' = lastW,
      } else all {
        intent.get(1).t == 0,
        if (t.dead or (uniq(t) and (clash(idx, 1, t.k1) or clash(idx, 2, t.k2) or (t.k1 != 0 and t.k1 == t.k2)))) all {
          txn' = txn.set(x, { ...t, st: Aborted }), intent' = intent.set(2, NONE), idx' = idx, lastW' = lastW,
        } else all {
          intent' = intent.set(1, { t: x, v: t.k1, d: true }).set(2, { t: x, v: t.k2, d: true }),
          idx' = if (maint(t)) idxPut(idxPut(idx, 1, lv(1), t.k1), 2, lv(2), t.k2) else idx,
          lastW' = lastW.set(1, x).set(2, x),
          txn' = commitOf(x, t),
        },
      },
      tbl' = tbl, sv' = sv, keepDdl,
    }
  }

  // 確定前の中止 (参加者の拒否、競合、時間切れ)
  action abortCross(x: int): bool = {
    val t = txn.get(x)
    all {
      t.st == C1 or t.st == C2,
      txn' = txn.set(x, { ...t, st: Aborted }),
      intent' = if (t.st == C2) intent.set(2, NONE) else intent,
      tbl' = tbl, idx' = idx, lastW' = lastW, sv' = sv, keepDdl,
    }
  }

  // phase 2。確定済みの intent を表へ適用する。実装は表定義の版を確かめない (core.ts finalize)
  action apply(r: int): bool = all {
    intent.get(r).t != 0, intent.get(r).d,
    tbl' = tbl.set(r, intent.get(r).v), intent' = intent.set(r, NONE),
    idx' = idx, lastW' = lastW, sv' = sv, txn' = txn, keepDdl,
  }

  action step = any {
    issue, publish, ddlReturn,
    nondet s = SHARDS.oneOf() any { sync(s), bfScan(s), bfWrite(s) },
    nondet r = ROWS.oneOf() apply(r),
    nondet x = TXNS.oneOf() any { localEnter(x), localApply(x), crossEnter(x), crossPrepare(x), crossDecide(x), abortCross(x) },
    nondet x = TXNS.oneOf() nondet r = ROWS.oneOf() nondet k = VALS.oneOf() nondet c = CATS.oneOf() planLocal(x, r, k, c),
    nondet x = TXNS.oneOf() nondet k1 = VALS.oneOf() nondet k2 = VALS.oneOf() nondet c = CATS.oneOf() planCross(x, k1, k2, c),
  }

  // ---- invariant ----

  def logical: Set[(int, int)] = ROWS.filter(r => lv(r) != 0).map(r => (lv(r), r))
  val indexComplete = phase == Public implies logical.subseteq(idx)
  val noDangling = phase == Public implies idx.subseteq(logical)
  val uniqueSafe = (UNIQUE and phase == Public) implies not(lv(1) != 0 and lv(1) == lv(2))
  def wrote(x: int, r: int): int = if (txn.get(x).cross and r == 2) txn.get(x).k2 else txn.get(x).k1
  val noLostWrite = ROWS.forall(r => {
    val x = lastW.get(r)
    (x != 0 and txn.get(x).ack == 2 and intent.get(r).t == 0) implies tbl.get(r) == wrote(x, r)
  })
  val noResurrect = ROWS.forall(r => {
    val x = lastW.get(r)
    (RECREATE and x != 0 and txn.get(x).ack == 0 and sv.get(shardOf(r)) == 1 and intent.get(r).t == 0) implies tbl.get(r) == 0
  })
  val schemaSafe = indexComplete and noDangling and uniqueSafe and noLostWrite and noResurrect

  // ---- witness ----

  // index が public になり、その途中で 2 件の取引が確定している (1 件は index を知らない計画、1 件は write-only の計画)
  val witnessPublicWithWriters = not(
    phase == Public and idx.size() == 2 and
    TXNS.exists(x => txn.get(x).st == Committed and txn.get(x).cat == 0 and txn.get(x).ack == 1) and
    TXNS.exists(x => txn.get(x).st == Committed and txn.get(x).cat == 1 and txn.get(x).ack == 1))
  // 古い catalog の要求が拒否され、index は public になっている
  val witnessStaleRejected = not(phase == Public and TXNS.exists(x => txn.get(x).st == Rejected and txn.get(x).cat == 0))
  // 2PC の取引が DDL の途中で確定し、後から適用される
  val witnessCrossDuringDdl = not(
    phase == Public and TXNS.exists(x => txn.get(x).st == Committed and txn.get(x).cross and txn.get(x).ack == 1) and
    ROWS.forall(r => intent.get(r).t == 0) and logical.size() == 2)
  // 重複のために UNIQUE index の作成が失敗する。重複がなければ public になる
  val witnessUniqueFailed = not(phase == Failed and lv(1) != 0 and lv(1) == lv(2))
  val witnessUniquePublic = not(UNIQUE and phase == Public and idx.size() == 2)
  // 作り直しの後に書いた行が残る
  val witnessRecreateWritten = not(
    phase == Returned and synced and TXNS.exists(x => txn.get(x).st == Committed and txn.get(x).ack == 2) and
    ROWS.exists(r => tbl.get(r) != 0))
}

// ---- green: 修正案 (待ちの後の版の確認、適用前の intent の決着、backfill の検証) を入れた版 ----

module m11_green {
  import m11_core(RECREATE = false, UNIQUE = false, COLOCATED = false, NTXN = 2,
    REJECT_STALE = true, SYNC_FIRST = true, WRITE_ONLY = true, PUBLIC_LAST = true,
    RECHECK_AUTO = true, RECHECK_ANCHOR = true, DRAIN = true, BF_VALIDATE = true, CHUNK_DEDUP = true).*
  // backfill が読んだ後に行が変わると、書かずに読み直す
  run rescanTest =
    init.then(issue).then(sync(1)).then(sync(2)).then(bfScan(1))
        .then(planLocal(1, 1, 2, 1)).then(localEnter(1)).then(localApply(1))
        .then(bfWrite(1)).expect(bf.get(1) == 0 and idx == Set((2, 1)))
        .then(bfScan(1)).then(bfWrite(1)).then(bfScan(2)).then(bfWrite(2)).then(publish)
        .expect(schemaSafe and phase == Public and idx == Set((2, 1)))
}
module m11_green_unique {
  import m11_core(RECREATE = false, UNIQUE = true, COLOCATED = false, NTXN = 2,
    REJECT_STALE = true, SYNC_FIRST = true, WRITE_ONLY = true, PUBLIC_LAST = true,
    RECHECK_AUTO = true, RECHECK_ANCHOR = true, DRAIN = true, BF_VALIDATE = true, CHUNK_DEDUP = true).*
}
module m11_green_unique_colocated {
  import m11_core(RECREATE = false, UNIQUE = true, COLOCATED = true, NTXN = 2,
    REJECT_STALE = true, SYNC_FIRST = true, WRITE_ONLY = true, PUBLIC_LAST = true,
    RECHECK_AUTO = true, RECHECK_ANCHOR = true, DRAIN = true, BF_VALIDATE = true, CHUNK_DEDUP = true).*
}
module m11_green_recreate {
  import m11_core(RECREATE = true, UNIQUE = false, COLOCATED = false, NTXN = 2,
    REJECT_STALE = true, SYNC_FIRST = true, WRITE_ONLY = true, PUBLIC_LAST = true,
    RECHECK_AUTO = true, RECHECK_ANCHOR = true, DRAIN = true, BF_VALIDATE = true, CHUNK_DEDUP = true).*
}
// BUG-4 は、anchor の確認し直しと、適用前の決着のどちらか一方でも塞がる (index の DDL に限る)
module m11_fix_recheck_only {
  import m11_core(RECREATE = false, UNIQUE = false, COLOCATED = false, NTXN = 2,
    REJECT_STALE = true, SYNC_FIRST = true, WRITE_ONLY = true, PUBLIC_LAST = true,
    RECHECK_AUTO = true, RECHECK_ANCHOR = true, DRAIN = false, BF_VALIDATE = true, CHUNK_DEDUP = true).*
}
module m11_fix_drain_only {
  import m11_core(RECREATE = false, UNIQUE = false, COLOCATED = false, NTXN = 2,
    REJECT_STALE = true, SYNC_FIRST = true, WRITE_ONLY = true, PUBLIC_LAST = true,
    RECHECK_AUTO = true, RECHECK_ANCHOR = false, DRAIN = true, BF_VALIDATE = true, CHUNK_DEDUP = true).*
}

// index の DDL では、全シャードへの先行適用を外しても破れない。backfill の読みが新しい版の要求なので、
// 読まれたシャードは必ず適用を済ませているからである。先行適用が効くのは表の作り直しである (m11_red_no_sync)
module m11_index_no_sync {
  import m11_core(RECREATE = false, UNIQUE = false, COLOCATED = false, NTXN = 2,
    REJECT_STALE = true, SYNC_FIRST = false, WRITE_ONLY = true, PUBLIC_LAST = true,
    RECHECK_AUTO = true, RECHECK_ANCHOR = true, DRAIN = true, BF_VALIDATE = true, CHUNK_DEDUP = true).*
}

// ---- impl: 実装どおり。実装にない防御を外す ----

module m11_impl {
  import m11_core(RECREATE = false, UNIQUE = false, COLOCATED = false, NTXN = 2,
    REJECT_STALE = true, SYNC_FIRST = true, WRITE_ONLY = true, PUBLIC_LAST = true,
    RECHECK_AUTO = false, RECHECK_ANCHOR = false, DRAIN = false, BF_VALIDATE = false, CHUNK_DEDUP = false).*
}
// BUG-3: autocommit の書き込みが版を入口でだけ確かめる。待ちの間に DDL が最後まで進み、index を更新しない書き込みが通る
module m11_impl_wait {
  import m11_core(RECREATE = false, UNIQUE = false, COLOCATED = false, NTXN = 1,
    REJECT_STALE = true, SYNC_FIRST = true, WRITE_ONLY = true, PUBLIC_LAST = true,
    RECHECK_AUTO = false, RECHECK_ANCHOR = true, DRAIN = true, BF_VALIDATE = true, CHUNK_DEDUP = true).*
  run counterexampleTest =
    init.then(planLocal(1, 2, 1, 0)).then(localEnter(1))
        .then(issue).then(sync(1)).then(sync(2))
        .then(bfScan(1)).then(bfWrite(1)).then(bfScan(2)).then(bfWrite(2)).then(publish)
        .expect(schemaSafe)
        .then(localApply(1))
        .expect(txn.get(1).st == Committed and not(indexComplete))
}
// BUG-4: 2PC の途中の取引。参加者は版を確かめて intent を置き、anchor は応答の後で確かめ直さない。
// backfill は未確定の intent を読み飛ばす。取引は public の後で、index を更新せずに確定する
module m11_impl_inflight {
  import m11_core(RECREATE = false, UNIQUE = false, COLOCATED = false, NTXN = 1,
    REJECT_STALE = true, SYNC_FIRST = true, WRITE_ONLY = true, PUBLIC_LAST = true,
    RECHECK_AUTO = true, RECHECK_ANCHOR = false, DRAIN = false, BF_VALIDATE = true, CHUNK_DEDUP = true).*
  run counterexampleTest =
    init.then(planCross(1, 2, 1, 0)).then(crossEnter(1)).then(crossPrepare(1))
        .then(issue).then(sync(1)).then(sync(2))
        .then(bfScan(1)).then(bfWrite(1)).then(bfScan(2)).then(bfWrite(2)).then(publish)
        .expect(schemaSafe and idx == Set((1, 1)))
        .then(crossDecide(1))
        .expect(txn.get(1).st == Committed and not(indexComplete) and not(noDangling))
}
// BUG-2: backfill は表を読んだ後、別の取引で index へ書く。その間の更新で、古い値の項目が残る
module m11_impl_backfill {
  import m11_core(RECREATE = false, UNIQUE = false, COLOCATED = false, NTXN = 1,
    REJECT_STALE = true, SYNC_FIRST = true, WRITE_ONLY = true, PUBLIC_LAST = true,
    RECHECK_AUTO = true, RECHECK_ANCHOR = true, DRAIN = true, BF_VALIDATE = false, CHUNK_DEDUP = true).*
  run counterexampleTest =
    init.then(issue).then(sync(1)).then(sync(2)).then(bfScan(1))
        .then(planLocal(1, 1, 2, 1)).then(localEnter(1)).then(localApply(1))
        .expect(idx == Set((2, 1)))
        .then(bfWrite(1)).then(bfScan(2)).then(bfWrite(2)).then(publish)
        .expect(indexComplete and not(noDangling) and idx == Set((1, 1), (2, 1)))
}
// BUG-1: UNIQUE の backfill が、同じシャードの 2 行の重複を上書きして見逃す
module m11_impl_chunk {
  import m11_core(RECREATE = false, UNIQUE = true, COLOCATED = true, NTXN = 1,
    REJECT_STALE = true, SYNC_FIRST = true, WRITE_ONLY = true, PUBLIC_LAST = true,
    RECHECK_AUTO = true, RECHECK_ANCHOR = true, DRAIN = true, BF_VALIDATE = true, CHUNK_DEDUP = false).*
  run counterexampleTest =
    init.then(planLocal(1, 2, 1, 0)).then(localEnter(1)).then(localApply(1))
        .then(issue).then(sync(1)).then(sync(2))
        .then(bfScan(1)).then(bfWrite(1)).then(bfScan(2)).then(bfWrite(2)).then(publish)
        .expect(phase == Public and not(uniqueSafe) and idx == Set((1, 2)))
}
// BUG-5: 確定済みで未適用の intent が DROP の後に残り、作り直した表へ適用される
module m11_impl_drop {
  import m11_core(RECREATE = true, UNIQUE = false, COLOCATED = false, NTXN = 1,
    REJECT_STALE = true, SYNC_FIRST = true, WRITE_ONLY = true, PUBLIC_LAST = true,
    RECHECK_AUTO = true, RECHECK_ANCHOR = true, DRAIN = false, BF_VALIDATE = true, CHUNK_DEDUP = true).*
  run counterexampleTest =
    init.then(planCross(1, 2, 1, 0)).then(crossEnter(1)).then(crossPrepare(1)).then(crossDecide(1)).then(apply(1))
        .then(issue).then(sync(1)).then(sync(2)).then(ddlReturn)
        .expect(schemaSafe and tbl.get(1) == 0 and tbl.get(2) == 0)
        .then(apply(2))
        .expect(not(noResurrect) and tbl.get(1) == 0 and tbl.get(2) == 1)
}

// ---- red: 実装にある防御を 1 つ外す ----

// シャードが古い版の要求を拒否しない。public の後に、index を知らない Worker の書き込みが通る
module m11_red_no_reject {
  import m11_core(RECREATE = false, UNIQUE = false, COLOCATED = false, NTXN = 1,
    REJECT_STALE = false, SYNC_FIRST = true, WRITE_ONLY = true, PUBLIC_LAST = true,
    RECHECK_AUTO = true, RECHECK_ANCHOR = true, DRAIN = true, BF_VALIDATE = true, CHUNK_DEDUP = true).*
  run counterexampleTest =
    init.then(issue).then(sync(1)).then(sync(2))
        .then(bfScan(1)).then(bfWrite(1)).then(bfScan(2)).then(bfWrite(2)).then(publish)
        .then(planLocal(1, 2, 1, 0)).then(localEnter(1)).then(localApply(1))
        .expect(txn.get(1).st == Committed and not(indexComplete))
}
// backfill が終わる前に public にする
module m11_red_early_public {
  import m11_core(RECREATE = false, UNIQUE = false, COLOCATED = false, NTXN = 1,
    REJECT_STALE = true, SYNC_FIRST = true, WRITE_ONLY = true, PUBLIC_LAST = false,
    RECHECK_AUTO = true, RECHECK_ANCHOR = true, DRAIN = true, BF_VALIDATE = true, CHUNK_DEDUP = true).*
  run counterexampleTest = init.then(issue).then(publish).expect(not(indexComplete))
}
// write-only の index を書き込みが更新しない。backfill が読んだ後の書き込みが index に入らない
module m11_red_no_write_only {
  import m11_core(RECREATE = false, UNIQUE = false, COLOCATED = false, NTXN = 1,
    REJECT_STALE = true, SYNC_FIRST = true, WRITE_ONLY = false, PUBLIC_LAST = true,
    RECHECK_AUTO = true, RECHECK_ANCHOR = true, DRAIN = true, BF_VALIDATE = true, CHUNK_DEDUP = true).*
  run counterexampleTest =
    init.then(issue).then(sync(1)).then(sync(2))
        .then(bfScan(1)).then(bfWrite(1)).then(bfScan(2)).then(bfWrite(2))
        .then(planLocal(1, 2, 1, 1)).then(localEnter(1)).then(localApply(1)).then(publish)
        .expect(txn.get(1).st == Committed and not(indexComplete))
}
// 全シャードへ適用する前に DDL が完了を返す。古い catalog の Worker が未適用のシャードへ書き、後から DROP が適用されて消える
module m11_red_no_sync {
  import m11_core(RECREATE = true, UNIQUE = false, COLOCATED = false, NTXN = 1,
    REJECT_STALE = true, SYNC_FIRST = false, WRITE_ONLY = true, PUBLIC_LAST = true,
    RECHECK_AUTO = true, RECHECK_ANCHOR = true, DRAIN = true, BF_VALIDATE = true, CHUNK_DEDUP = true).*
  run counterexampleTest =
    init.then(issue).then(sync(1)).then(ddlReturn)
        .then(planLocal(1, 2, 1, 0)).then(localEnter(1)).then(localApply(1))
        .expect(txn.get(1).st == Committed and tbl.get(2) == 1 and schemaSafe)
        .then(sync(2))
        .expect(not(noLostWrite) and tbl.get(2) == 0)
}
