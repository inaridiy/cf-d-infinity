// M12: 行のある表に、シャードをまたぐ UNIQUE の index を作る
//
// M11 は index を (値, 行) の組の集合として持つ。実装は違う。index の表は値を主キーにした 1 行で、どの行がその値を持つかを
// 覚える。行が値を手放すと、その値の項目を、誰の項目かを確かめずに消す。この違いのせいで、M11 は次の欠陥を見つけられなかった
// (test/ddl-concurrent.test.ts の seed 100 と 364、test/open/unique-index-build.test.ts)。
//
//   index を作っている最中は、まだ項目のない行 Y が値 k を持っているとき、別の行 X が k を取れる。Y が k を手放すと、X の項目が消える。
//   作っている最中の index を、読みと書き込みが、出来上がったものとして使う。
//
// ここでは index を実装と同じ形で持ち、2 つの作り方を比べる。
//
//   作りながら書く (2026-11 までの設計): index を記録した時点から、取引が index を保守し、一意性を index で確かめる。
//                                         既存の行の項目は、後から 1 行ずつ埋める。
//   書き込みを止めて作る (決めた設計):    index を記録する版が、表を書き込み禁止にする。シャードが、その表への書き込みを断る。
//                                         出来上がるまで、index は Worker の計画から見えない。既存の行を、止まった状態で埋める。
//
// 書き込みを止める設計は、すでにある 3 つの仕組みの上に立つ。モデルは、どれが欠けても壊れることを示す。
//   シャードは、自分より古い版で計画された書き込みを断る (REJECT_STALE)。
//   シャードは、版を進める前に、持っている intent を決着させる (DRAIN_INTENTS)。
//   取引は、書き込みを計画した版を、確定まで持ち続ける (PIN_VERSION)。
// 3 つ目は、実装では守られていなかった (test/open/txn-across-schema-change.test.ts)。接続をまたぐ取引と、知らない表を
// 読んだ後の取引が、溜めた書き込みを計画し直さずに、新しい版の番号を名乗る。
//
// 行は 2 個 (行 r はシャード r にある)。値は 1、2、値なし (0)。最初の値は何でもよい (重複もある)。
// 取引は 1 行の値を書き換える。文の実行 (plan)、prepare、確定 (commit) の 3 段。計画には、そのときの catalog の版を使う
// (古い版でもよい)。index の項目は、行と同じ取引で変わる (index の表の 2PC は M1 と M9 に任せる)。
// DDL は、記録 (ddlStart)、各シャードへの適用 (applyVer)、既存の行を埋める (backfill)、公開 (publish) か取り消しで進む。
// 版は実装と同じに数える。0 は index がない。1 は index を記録した版 (作っている最中)。2 は終わった版 (公開か、取り消し)。
// 公開も取り消しも、Meta が「最新の版が 1 のまま」のときだけ版 2 を積む。だから、どちらか片方しか起きない (ONE_EXIT)。
// 期限切れ (expire) は Meta が自分で取り消す。DDL を進める側が止まっても起きる。
// 行を埋める処理は、行を読む要求に版 1 を付ける。シャードは、版 1 を適用してから答える (SCAN_AT_VERSION)。
//
// invariant (buildSafe はこれらの連言):
//   indexMatches:        公開された index は、値を持つ行のすべてについて、その行を指す項目を持ち、行のない項目を持たない
//                        (だから、同じ値の行が 2 つない)
//   noWriteWhileLocked:  書き込み禁止の版にいるシャードで、行の書き込みが確定しない
//   notRelied:           出来上がっていない index を、文が使わない (一意性の確認にも、項目の保守にも)
//   oneExit:             終わり方は、公開か取り消しのどちらか 1 回だけである
//   noIntentWhileLocked: 書き込み禁止の版にいるシャードに、その表の intent がない。
//                        だから、終わった版 (2) の適用は待たされない。期限切れはいつでも起きられるので、禁止は必ず解ける
module m12_core {
  const SHARD_LOCK: bool      // シャードが、index を作っている間、表への書き込みを断る
  const WORKER_LOCK: bool     // Worker も、シャードへ送る前に断る (早く失敗させるだけ)
  const BUILD_VISIBLE: bool   // 作っている最中の index を、Worker の計画が使う (一意性の確認と、項目の保守)
  const DRAIN_INTENTS: bool   // シャードは、版を進める前に、持っている intent を決着させる
  const REJECT_STALE: bool    // シャードは、自分より古い版で計画された書き込みを断る
  const ONE_EXIT: bool        // 公開と取り消しは、作っている状態からだけ起きる
  const PIN_VERSION: bool     // 取引は、書き込みを計画した版を、確定まで持ち続ける
  const SCAN_AT_VERSION: bool // 行を埋める処理が読むシャードは、index を記録した版を適用してから答える

  pure val ROWS = Set(1, 2)
  pure val VALS = Set(1, 2)
  pure val NONE = 0                       // 値がない。index の項目がない
  pure val ALLV = Set(0, 1, 2)
  pure val TXNS = Set(1, 2)

  // meta の状態
  pure val NO_INDEX = 0
  pure val BUILDING = 1
  pure val PUBLIC = 2
  pure val WITHDRAWN = 3

  // phase: 0 未使用、1 文を実行した、2 prepare 済み (intent がある)、3 終わった
  type Txn = { phase: int, row: int, old: int, new: int, cv: int, maintain: bool, seen: int }
  pure val idle: Txn = { phase: 0, row: 0, old: 0, new: 0, cv: 0, maintain: false, seen: 0 }
  pure val done: Txn = { phase: 3, row: 0, old: 0, new: 0, cv: 0, maintain: false, seen: 0 }

  var meta: int                 // index の状態
  var ver: int -> int           // シャード -> 適用した版 (0: index なし、1: 作っている最中、2: 終わった)
  var value: int -> int         // 行 -> 値
  var idx: int -> int           // 値 -> その値を持つ行 (0 = 項目なし)
  var scanned: Set[int]         // 既存の行を埋める処理が済ませた行
  var txns: int -> Txn
  var exits: int                // ghost: 公開と取り消しが起きた回数
  var wroteLocked: bool         // ghost
  var relied: bool              // ghost
  var refusedByLock: bool       // ghost: シャードが、書き込み禁止を理由に prepare を断った

  pure def metaVer(m: int): int = if (m == NO_INDEX) 0 else if (m == BUILDING) 1 else 2
  pure val noEntries: int -> int = VALS.mapBy(_ => 0)

  action init = {
    nondet a = oneOf(ALLV)
    nondet b = oneOf(ALLV)
    all {
      meta' = NO_INDEX, ver' = ROWS.mapBy(_ => 0),
      value' = Map(1 -> a, 2 -> b), idx' = noEntries, scanned' = Set(),
      txns' = TXNS.mapBy(_ => idle),
      exits' = 0, wroteLocked' = false, relied' = false, refusedByLock' = false
    }
  }

  action keepDdl = all { meta' = meta, ver' = ver, scanned' = scanned, exits' = exits }
  action keepData = all { value' = value, idx' = idx }
  action keepGhost = all { wroteLocked' = wroteLocked, relied' = relied, refusedByLock' = refusedByLock }

  // ---- 取引 -------------------------------------------------------------------
  // 計画に使う catalog の版 cv が、index をどう見ているか。版 2 は、終わった後の状態 (公開か、取り消し) である。
  def stateAt(cv: int): int = if (cv == 0) NO_INDEX else if (cv == 1) BUILDING else meta

  // 文を実行する。行 r の値を nv に書き換える。index を使う計画なら、一意性を index で確かめる。
  action plan(t: int, r: int, nv: int, cv: int): bool = all {
    txns.get(t).phase == 0,
    cv <= metaVer(meta),
    nv != value.get(r),
    val st = stateAt(cv)
    val uses = (st == PUBLIC) or (st == BUILDING and BUILD_VISIBLE)
    val holder = if (uses and nv != NONE) idx.get(nv) else 0
    all {
      // Worker が、作っている最中の表への書き込みを、送る前に断る
      not(WORKER_LOCK and st == BUILDING),
      txns' = txns.set(t,
        // 同じ値の項目が別の行を指していれば、UNIQUE 違反で文が失敗する
        if (holder != 0 and holder != r) done
        else { phase: 1, row: r, old: value.get(r), new: nv, cv: cv, maintain: uses, seen: holder }),
      relied' = (relied or (uses and st == BUILDING)),
      wroteLocked' = wroteLocked, refusedByLock' = refusedByLock, keepDdl, keepData
    }
  }

  // 取引が、溜めた書き込みを計画し直さずに、新しい版を名乗る。PIN_VERSION なら起きない。
  action repin(t: int): bool = all {
    not(PIN_VERSION),
    txns.get(t).phase == 1,
    txns.get(t).cv < metaVer(meta),
    txns' = txns.set(t, txns.get(t).with("cv", metaVer(meta))),
    keepDdl, keepData, keepGhost
  }

  // prepare。行のあるシャードが、版と、書き込み禁止と、読んだ後に変わっていないことを確かめて、intent を置く。
  // 確かめに通らなければ、取引は終わる (何も書かない)。
  action prepare(t: int): bool = all {
    txns.get(t).phase == 1,
    val x = txns.get(t)
    val s = x.row
    all {
      // シャードが先の版を知らなければ、適用が先 (applyVer)
      x.cv <= ver.get(s),
      val stale = REJECT_STALE and x.cv < ver.get(s)
      // シャードが知っているのは、自分が適用した版だけである。版 1 の表定義が「書き込み禁止」と言っている。
      val locked = SHARD_LOCK and ver.get(s) == 1
      val changed = value.get(x.row) != x.old or (x.maintain and x.new != NONE and idx.get(x.new) != x.seen)
      // 行の intent と、index の項目の intent。項目も行なので、同じ値の項目を触る 2 つの取引は、片方しか prepare できない。
      val busy = TXNS.exists(u => u != t and txns.get(u).phase == 2 and
        (txns.get(u).row == x.row or
         (x.maintain and txns.get(u).maintain and
          Set(x.old, x.new).exclude(Set(NONE)).intersect(Set(txns.get(u).old, txns.get(u).new)) != Set())))
      all {
        txns' = txns.set(t, if (stale or locked or changed or busy) done else x.with("phase", 2)),
        refusedByLock' = (refusedByLock or (locked and not(stale))),
      },
      wroteLocked' = wroteLocked, relied' = relied, keepDdl, keepData
    }
  }

  // 確定。行を書き換える。index を使う計画なら、古い値の項目を消し (誰の項目かは確かめない)、新しい値の項目を足す。
  action commit(t: int): bool = all {
    txns.get(t).phase == 2,
    val x = txns.get(t)
    val removed = if (x.maintain and x.old != NONE) idx.set(x.old, 0) else idx
    all {
      value' = value.set(x.row, x.new),
      idx' = if (x.maintain and x.new != NONE) removed.set(x.new, x.row) else removed,
      txns' = txns.set(t, done),
      wroteLocked' = (wroteLocked or ver.get(x.row) == 1),
      relied' = relied, refusedByLock' = refusedByLock, keepDdl
    }
  }

  // ---- DDL --------------------------------------------------------------------
  // index を記録する。この版が、表を書き込み禁止にする (SHARD_LOCK のとき)。
  action ddlStart = all {
    meta == NO_INDEX,
    meta' = BUILDING,
    ver' = ver, scanned' = scanned, exits' = exits, txns' = txns, keepData, keepGhost
  }

  // シャードが次の版を適用する。DRAIN_INTENTS なら、その表の intent を持っている間は適用しない。
  action applyVer(s: int): bool = all {
    ver.get(s) < metaVer(meta),
    not(DRAIN_INTENTS) or TXNS.forall(t => not(txns.get(t).phase == 2 and txns.get(t).row == s)),
    ver' = ver.set(s, ver.get(s) + 1),
    meta' = meta, scanned' = scanned, exits' = exits, txns' = txns, keepData, keepGhost
  }

  // 既存の行を 1 つ埋める。行を読む要求は版 1 を名乗るので、シャードは版 1 を適用してから答える。
  // 同じ値の項目が別の行を指していれば、重複なので、取り消す。
  action backfill(r: int): bool = all {
    meta == BUILDING,
    not(SCAN_AT_VERSION) or ver.get(r) >= 1,
    not(scanned.contains(r)),
    // 埋める処理も、行を読んで項目を書く取引である。その行か、その項目に intent があれば、決着を待つ。
    TXNS.forall(u => not(txns.get(u).phase == 2 and
      (txns.get(u).row == r or
       (txns.get(u).maintain and value.get(r) != NONE and Set(txns.get(u).old, txns.get(u).new).contains(value.get(r)))))),
    val v = value.get(r)
    val dup = v != NONE and idx.get(v) != 0 and idx.get(v) != r
    all {
      meta' = if (dup) WITHDRAWN else meta,
      exits' = if (dup) exits + 1 else exits,
      idx' = if (dup) noEntries else if (v != NONE) idx.set(v, r) else idx,
      scanned' = scanned.union(Set(r)),
      ver' = ver, value' = value, txns' = txns, keepGhost
    }
  }

  // 公開する。DDL を進める側は、全部の行を埋め終えたと思っている。
  // ONE_EXIT なら、作っている状態からだけ起きる。そうでなければ、取り消された後でも公開してしまう。
  action publish = all {
    scanned == ROWS,
    if (ONE_EXIT) meta == BUILDING else (meta == BUILDING or meta == WITHDRAWN),
    meta' = PUBLIC, exits' = exits + 1,
    ver' = ver, scanned' = scanned, txns' = txns, keepData, keepGhost
  }

  // 期限切れ。DDL を進める側が止まっても、取り消せる。項目は捨てる。
  action expire = all {
    meta == BUILDING,
    meta' = WITHDRAWN, exits' = exits + 1, idx' = noEntries,
    ver' = ver, scanned' = scanned, value' = value, txns' = txns, keepGhost
  }

  action step = any {
    { nondet t = oneOf(TXNS) nondet r = oneOf(ROWS) nondet nv = oneOf(ALLV) nondet cv = oneOf(Set(0, 1, 2)) plan(t, r, nv, cv) },
    { nondet t = oneOf(TXNS) repin(t) },
    { nondet t = oneOf(TXNS) prepare(t) },
    { nondet t = oneOf(TXNS) commit(t) },
    ddlStart,
    { nondet s = oneOf(ROWS) applyVer(s) },
    { nondet r = oneOf(ROWS) backfill(r) },
    publish,
    expire
  }

  // ---- 不変条件 -------------------------------------------------------------
  val indexMatches = meta != PUBLIC or
    (ROWS.forall(r => value.get(r) == NONE or idx.get(value.get(r)) == r) and
     VALS.forall(v => idx.get(v) == 0 or value.get(idx.get(v)) == v))
  val noWriteWhileLocked = not(wroteLocked)
  val notRelied = not(relied)
  val oneExit = exits <= 1
  val noIntentWhileLocked = ROWS.forall(s =>
    not(SHARD_LOCK and ver.get(s) == 1) or
    TXNS.forall(t => not(txns.get(t).phase == 2 and txns.get(t).row == s)))
  val buildSafe = indexMatches and noWriteWhileLocked and notRelied and oneExit and noIntentWhileLocked

  // witness (not(到達したい状態) を invariant にして、違反が出れば到達できる)
  // 公開された後で、index を使う書き込みが確定し、両方の行が値を持つ
  val witnessPublicThenWrite = not(meta == PUBLIC and txns.get(1).phase == 3 and txns.get(2).phase == 3
                                   and value.get(1) != NONE and value.get(2) != NONE and idx.get(value.get(1)) == 1)
  // 重複のために取り消される
  val witnessWithdrawnOnDuplicate = not(meta == WITHDRAWN and value.get(1) == value.get(2) and value.get(1) != NONE and scanned != Set())
  // index を作っている間に、書き込みがシャードで断られる
  val witnessRefusedByLock = not(refusedByLock)
}

// 決めた設計。書き込みを止めて作る。作っている最中の index は、Worker の計画から見えない。
module m12_green {
  import m12_core(SHARD_LOCK = true, WORKER_LOCK = true, BUILD_VISIBLE = false,
                  DRAIN_INTENTS = true, REJECT_STALE = true, ONE_EXIT = true,
                  PIN_VERSION = true, SCAN_AT_VERSION = true).*
}

// 守っているのはシャードである。Worker が断らなくても成り立つ (Worker の確認は、早く失敗させるためだけにある)。
module m12_green_shard_only {
  import m12_core(SHARD_LOCK = true, WORKER_LOCK = false, BUILD_VISIBLE = false,
                  DRAIN_INTENTS = true, REJECT_STALE = true, ONE_EXIT = true,
                  PIN_VERSION = true, SCAN_AT_VERSION = true).*
  run refusedByShardTest =
    init.then(ddlStart).then(applyVer(1)).then(applyVer(2))
        .then(plan(1, 1, if (value.get(1) == 1) 2 else 1, 1))   // 作っている最中の版で計画する。index は見えない
        .expect(txns.get(1).phase == 1 and not(txns.get(1).maintain) and not(relied))
        .then(prepare(1))                                        // シャードが断る
        .expect(txns.get(1).phase == 3 and buildSafe)
}

// 2026-11 までの設計。作りながら書く。取引が index を保守し、一意性を、出来上がっていない index で確かめる。
module m12_red_online {
  import m12_core(SHARD_LOCK = false, WORKER_LOCK = false, BUILD_VISIBLE = true,
                  DRAIN_INTENTS = true, REJECT_STALE = true, ONE_EXIT = true,
                  PIN_VERSION = true, SCAN_AT_VERSION = true).*
}

// 書き込みを止めず、作っている最中の index も使わない。埋めた後で変わった行の項目が、古いままになる。
module m12_red_no_lock {
  import m12_core(SHARD_LOCK = false, WORKER_LOCK = false, BUILD_VISIBLE = false,
                  DRAIN_INTENTS = true, REJECT_STALE = true, ONE_EXIT = true,
                  PIN_VERSION = true, SCAN_AT_VERSION = true).*
}

// 書き込みは止めるが、作っている最中の index を、Worker の計画が使う。確定はしないが、文が、出来上がっていない index の
// 答え (UNIQUE 違反) を受け取る。
module m12_red_visible {
  import m12_core(SHARD_LOCK = true, WORKER_LOCK = false, BUILD_VISIBLE = true,
                  DRAIN_INTENTS = true, REJECT_STALE = true, ONE_EXIT = true,
                  PIN_VERSION = true, SCAN_AT_VERSION = true).*
}

// シャードが、intent を持ったまま版を進める。禁止の前に prepare した取引が、行を埋めた後で確定する。
module m12_red_no_drain {
  import m12_core(SHARD_LOCK = true, WORKER_LOCK = true, BUILD_VISIBLE = false,
                  DRAIN_INTENTS = false, REJECT_STALE = true, ONE_EXIT = true,
                  PIN_VERSION = true, SCAN_AT_VERSION = true).*
}

// シャードが、古い版で計画された書き込みを断らない。index を知らない計画が、公開の後で確定する。
module m12_red_stale {
  import m12_core(SHARD_LOCK = true, WORKER_LOCK = true, BUILD_VISIBLE = false,
                  DRAIN_INTENTS = true, REJECT_STALE = false, ONE_EXIT = true,
                  PIN_VERSION = true, SCAN_AT_VERSION = true).*
}

// 公開が、作っている状態かどうかを確かめない。期限切れで取り消された後に、遅れてきた公開が通る。
module m12_red_two_exits {
  import m12_core(SHARD_LOCK = true, WORKER_LOCK = true, BUILD_VISIBLE = false,
                  DRAIN_INTENTS = true, REJECT_STALE = true, ONE_EXIT = false,
                  PIN_VERSION = true, SCAN_AT_VERSION = true).*
}

// 取引が、溜めた書き込みを計画し直さずに、新しい版を名乗る。index を知らない計画が、公開の後の版の番号で確定する。
// 実装にあった欠陥である (test/open/txn-across-schema-change.test.ts)。
module m12_red_repin {
  import m12_core(SHARD_LOCK = true, WORKER_LOCK = true, BUILD_VISIBLE = false,
                  DRAIN_INTENTS = true, REJECT_STALE = true, ONE_EXIT = true,
                  PIN_VERSION = false, SCAN_AT_VERSION = true).*
}

// 行を埋める処理が、まだ書き込みを止めていないシャードの行を読む。読んだ後で、その行が変わる。
module m12_red_scan_early {
  import m12_core(SHARD_LOCK = true, WORKER_LOCK = true, BUILD_VISIBLE = false,
                  DRAIN_INTENTS = true, REJECT_STALE = true, ONE_EXIT = true,
                  PIN_VERSION = true, SCAN_AT_VERSION = false).*
}

// ---- 公開の時刻 ---------------------------------------------------------------
//
// 取引の直列な順序は、時刻の順である (M1)。index の公開は、文の意味を変える (UNIQUE 違反で失敗する、衝突する行を消す)。
// だから公開も、時刻の順の中に 1 点を持たなければならない。
//
//   index を使わない書き込み (公開の前の計画) の確定の時刻  <=  公開の時刻 m  <=  index を使う文の読む時刻
//
// 版はシャードごとに、ばらばらの実時間に適用される。シャードの時計もずれている。何もしなければ、時計の遅いシャードで
// index を使う文が、時計の進んだシャードの古い書き込みより、小さい時刻を持つ。
// 決めた設計: 行を埋める処理が、各シャードの行を読んだ時刻の最大を m として、公開の版に載せる。シャードは、公開の版を
// 適用するときに、時計を m まで進める (範囲の移動で親の時計を子へ渡す M5b の finishRange と同じ形)。
//
// ここでは index の中身を持たない。上のモデルが示した次の 2 つを前提にする。
//   index を使わない書き込みは、書き込み禁止の版 (1) を適用したシャードでは確定しない (noWriteWhileLocked、REJECT_STALE)。
//   行を読む要求には版 1 が付くので、読まれたシャードは版 1 を適用している (SCAN_AT_VERSION)。
module m12_clock_core {
  const PUBLISH_CARRIES_CLOCK: bool   // 公開の版が時刻 m を運び、シャードは適用のときに時計を m まで進める
  const SCAN_EVERY_SHARD: bool        // 行を埋める処理は、行のないシャードも読む (時刻を得るため)

  pure val SHARDS = Set(1, 2)
  pure val MAXC = 3                    // 時計の上限

  var meta: int                 // 0 index なし、1 作っている最中、2 公開
  var ver: int -> int           // シャード -> 適用した版
  var clock: int -> int         // シャード -> 時計
  var scanT: int -> int         // シャード -> 行を読んだ時刻 (-1 = まだ読んでいない)
  var pubTs: int                // 公開の版が運ぶ時刻
  var legacyMax: int            // ghost: index を使わない書き込みの確定の時刻の最大
  var awareOk: bool             // ghost: index を使う文が、index を使わない書き込みをすべて見た

  pure def max(a: int, b: int): int = if (a > b) a else b

  action init = all {
    meta' = 0, ver' = SHARDS.mapBy(_ => 0), clock' = SHARDS.mapBy(_ => 0), scanT' = SHARDS.mapBy(_ => -1),
    pubTs' = 0, legacyMax' = 0, awareOk' = true
  }

  // 時計が進む (物理時刻、ほかの表の書き込み)
  action tick(s: int): bool = all {
    clock.get(s) < MAXC,
    clock' = clock.set(s, clock.get(s) + 1),
    meta' = meta, ver' = ver, scanT' = scanT, pubTs' = pubTs, legacyMax' = legacyMax, awareOk' = awareOk
  }

  // index を使わない書き込みが確定する。書き込み禁止の版を適用したシャードでは起きない。
  action legacyWrite(s: int): bool = all {
    ver.get(s) == 0,
    clock.get(s) < MAXC,
    clock' = clock.set(s, clock.get(s) + 1),
    legacyMax' = max(legacyMax, clock.get(s) + 1),
    meta' = meta, ver' = ver, scanT' = scanT, pubTs' = pubTs, awareOk' = awareOk
  }

  action ddlStart = all {
    meta == 0, meta' = 1,
    ver' = ver, clock' = clock, scanT' = scanT, pubTs' = pubTs, legacyMax' = legacyMax, awareOk' = awareOk
  }

  // シャードが次の版を適用する。公開の版なら、時計を m まで進める。
  action applyVer(s: int): bool = all {
    ver.get(s) < meta,
    ver' = ver.set(s, ver.get(s) + 1),
    clock' = if (PUBLISH_CARRIES_CLOCK and ver.get(s) == 1) clock.set(s, max(clock.get(s), pubTs)) else clock,
    meta' = meta, scanT' = scanT, pubTs' = pubTs, legacyMax' = legacyMax, awareOk' = awareOk
  }

  // 行を埋める処理が、シャードの行を読む。応答に、読んだ時刻が付く。
  action scan(s: int): bool = all {
    meta == 1, ver.get(s) == 1, scanT.get(s) < 0,
    scanT' = scanT.set(s, clock.get(s)),
    meta' = meta, ver' = ver, clock' = clock, pubTs' = pubTs, legacyMax' = legacyMax, awareOk' = awareOk
  }

  // 公開する。行のあるシャードは全部読んである。SCAN_EVERY_SHARD でなければ、行のないシャード (ここではシャード 2) を読まない。
  action publish = all {
    meta == 1,
    if (SCAN_EVERY_SHARD) SHARDS.forall(s => scanT.get(s) >= 0) else scanT.get(1) >= 0,
    meta' = 2,
    pubTs' = SHARDS.fold(0, (m, s) => max(m, scanT.get(s))),
    ver' = ver, clock' = clock, scanT' = scanT, legacyMax' = legacyMax, awareOk' = awareOk
  }

  // index を使う文が、シャード s で読む時刻を決める。公開の版を適用したシャードだけが、その計画を受ける。
  action awareRead(s: int): bool = all {
    meta == 2, ver.get(s) == 2,
    awareOk' = (awareOk and clock.get(s) >= legacyMax),
    meta' = meta, ver' = ver, clock' = clock, scanT' = scanT, pubTs' = pubTs, legacyMax' = legacyMax
  }

  action step = any {
    { nondet s = oneOf(SHARDS) tick(s) },
    { nondet s = oneOf(SHARDS) legacyWrite(s) },
    ddlStart,
    { nondet s = oneOf(SHARDS) applyVer(s) },
    { nondet s = oneOf(SHARDS) scan(s) },
    publish,
    { nondet s = oneOf(SHARDS) awareRead(s) }
  }

  // index を使う文は、index を使わない書き込みを全部見る (時刻の順で、公開の後ろにいる)
  val publishIsAPoint = awareOk
  // 公開の後、時計の遅かったシャードで index を使う文が読む
  val witnessAwareOnSlowShard = not(meta == 2 and ver.get(2) == 2 and legacyMax == 2 and scanT.get(2) == 0 and awareOk)
}

module m12_clock_green {
  import m12_clock_core(PUBLISH_CARRIES_CLOCK = true, SCAN_EVERY_SHARD = true).*
}

// 公開の版が時刻を運ばない。時計の遅いシャードで index を使う文が、別のシャードの古い書き込みより前の時刻で読む。
module m12_clock_red_no_clock {
  import m12_clock_core(PUBLISH_CARRIES_CLOCK = false, SCAN_EVERY_SHARD = true).*
  run slowShardTest =
    init.then(legacyWrite(1)).then(legacyWrite(1))               // シャード 1 の時計は 2
        .then(ddlStart).then(applyVer(1)).then(applyVer(2)).then(scan(1)).then(scan(2)).then(publish)
        .then(applyVer(2)).then(awareRead(2))                     // シャード 2 の時計は 0 のまま
        .expect(not(publishIsAPoint))
}

// 行のないシャードを読まない。そのシャードで、読まれる前に確定した書き込み (行を消すなど) の時刻が、m に入らない。
module m12_clock_red_skip_empty {
  import m12_clock_core(PUBLISH_CARRIES_CLOCK = true, SCAN_EVERY_SHARD = false).*
}
