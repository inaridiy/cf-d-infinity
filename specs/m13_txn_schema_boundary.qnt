// M13: 取引の中の DDL と、取引が名乗る表定義の版
//
// 取引の書き込みは、COMMIT まで Worker の手元に溜まる。DDL は、取引の中でも、その場で全シャードに効く。
// 何もしなければ、効く順序が、書いた順序と入れ替わる。表を作り直す移行 (新しい表を作る、行を写す、古い表を消す、名前を変える)
// では、行を写す前に古い表が消える (test/open/migration-tools.test.ts)。
//
// 持ち主の決定 (2026-11-11): DDL は、開いている取引を先に確定してから実行し、その後の文は新しい取引になる (MySQL と同じ)。
// 取引の中の文は、DDL で区切られた「区切り」ごとに 1 つの取引になる。
//
// もう 1 つの規則: 取引は、最初に読むか書くかしたときの表定義の版を、確定まで名乗り続ける。シャードは、自分より古い版の
// 計画を断る (M11)。その確認は「要求が名乗る版は、計画に使った版である」ことを前提にする。溜めた書き込みを計画し直さずに
// 新しい版を名乗ると、新しい index を保守しない書き込みが通る (test/txn-across-schema-change.test.ts)。
//
// モデルは 1 つの接続の文の並び (書き込み、DDL、書き込み、DDL、書き込み、COMMIT) と、別の接続の DDL 1 回である。
// 確定は、区切りの書き込みを全部名乗った版で、シャードが受けるかどうかで決まる。競合で断られることもある (nondet)。
// 断られた区切りは、やり直してよい (batch と、取引を関数で渡す入口は、自分でやり直す)。
//
// invariant (boundarySafe はこれらの連言):
//   prefixOfScript:  効いた文 (確定した書き込みと、実行した DDL) は、文の並びの頭から順に、抜けも重なりもなく並ぶ
//   pinned:          確定した書き込みは、どれも、確定のときに名乗った版で計画されている
//   ownDdlVisible:   文は、同じ接続が先に実行した DDL を見て計画される (自分が作った表へ書ける)
//   completeWhenOk:  COMMIT が成功を返したなら、全部の文が効いている
module m13_core {
  const IMPLICIT_COMMIT: bool            // DDL は、開いている取引を先に確定してから実行する
  const PIN: bool                        // 取引は、最初に触ったときの版を確定まで名乗る
  const RETRY_WHOLE: bool                // 断られたら、区切りの頭ではなく、文の並びの頭からやり直す (確定した分を 2 度実行する)
  const DDL_DESPITE_FAILED_COMMIT: bool  // 先に確定するのに失敗しても、DDL を実行する

  pure val SCRIPT: List[str] = ["W", "D", "W", "D", "W", "C"]
  pure val N = SCRIPT.length()
  /** 効く文 (COMMIT 以外) の位置。 */
  pure val EFFECTFUL: List[int] = range(0, N).select(i => SCRIPT[i] != "C")

  var pc: int                    // 次に実行する文の位置
  var meta: int                  // Meta の版 (シャードはすぐに適用するものとする)
  var segVer: int                // 開いている区切りが名乗る版。-1 はまだ何も触っていない
  var segStart: int              // 開いている区切りの最初の文の位置
  var buffer: Set[(int, int)]    // 溜めた書き込み (文の位置、計画した版)
  var lastOwn: int               // この接続が最後に実行した DDL の後の版
  var effects: List[int]         // ghost: 効いた文の位置の並び
  var otherDone: bool
  var retries: int
  var status: str                // "running" | "ok" | "failed"
  var badPin: bool               // ghost
  var ownInvisible: bool         // ghost

  pure def appendOps(l: List[int], ops: Set[int]): List[int] =
    range(0, N).foldl(l, (acc, i) => if (ops.contains(i)) acc.append(i) else acc)
  pure def isPrefix(a: List[int], b: List[int]): bool =
    a.length() <= b.length() and range(0, a.length()).foldl(true, (ok, i) => ok and a[i] == b[i])

  action init = all {
    pc' = 0, meta' = 0, segVer' = -1, segStart' = 0, buffer' = Set(), lastOwn' = 0, effects' = List(),
    otherDone' = false, retries' = 0, status' = "running", badPin' = false, ownInvisible' = false,
  }

  action keepGhost = all { badPin' = badPin, ownInvisible' = ownInvisible, otherDone' = otherDone }

  /** シャードが区切りの確定を受けるか。名乗る版が古ければ断る。競合でも断られる。 */
  def accepts(conflict: bool): bool = not(conflict) and (buffer == Set() or segVer == meta)

  /** 区切りの確定が断られた。溜めた書き込みを捨てる。1 度までやり直す。 */
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
      // 自分が先に実行した DDL を知らない版で計画した (作った表が見えない)。文が失敗する。
      all {
        status' = "failed", ownInvisible' = true,
        pc' = pc, meta' = meta, segVer' = segVer, segStart' = segStart, buffer' = buffer, lastOwn' = lastOwn,
        effects' = effects, otherDone' = otherDone, retries' = retries, badPin' = badPin,
      }
    else if (v < meta)
      // 別の接続の DDL の後で、古い版の計画をシャードが断る。
      all { abortSegment, meta' = meta, lastOwn' = lastOwn, effects' = effects, keepGhost }
    else all {
      buffer' = buffer.union(Set((pc, v))), segVer' = v, pc' = pc + 1,
      meta' = meta, segStart' = segStart, lastOwn' = lastOwn, effects' = effects, retries' = retries, status' = status, keepGhost,
    }
  }

  /** 取引が、溜めた書き込みを計画し直さずに、新しい版を名乗る (接続をまたいだ取引の組み立て直し、知らない表の後の取り直し)。 */
  action repin: bool = all {
    not(PIN), status == "running", segVer >= 0, segVer < meta,
    segVer' = meta,
    pc' = pc, meta' = meta, segStart' = segStart, buffer' = buffer, lastOwn' = lastOwn, effects' = effects,
    retries' = retries, status' = status, keepGhost,
  }

  action ddl(conflict: bool): bool = all {
    status == "running", pc < N, SCRIPT[pc] == "D",
    if (IMPLICIT_COMMIT and buffer != Set() and not(accepts(conflict)))
      if (DDL_DESPITE_FAILED_COMMIT) all {
        meta' = meta + 1, lastOwn' = meta + 1, effects' = effects.append(pc),
        buffer' = Set(), segVer' = -1, segStart' = pc + 1, pc' = pc + 1, retries' = retries, status' = status, keepGhost,
      } else all { abortSegment, meta' = meta, lastOwn' = lastOwn, effects' = effects, keepGhost }
    else all {
      meta' = meta + 1, lastOwn' = meta + 1,
      effects' = (if (IMPLICIT_COMMIT) appendOps(effects, buffer.map(b => b._1)) else effects).append(pc),
      buffer' = if (IMPLICIT_COMMIT) Set() else buffer,
      segVer' = if (IMPLICIT_COMMIT) -1 else segVer,
      segStart' = if (IMPLICIT_COMMIT) pc + 1 else segStart,
      pc' = pc + 1,
      badPin' = (badPin or (IMPLICIT_COMMIT and buffer.exists(b => b._2 != segVer))),
      retries' = retries, status' = status, ownInvisible' = ownInvisible, otherDone' = otherDone,
    }
  }

  action commit(conflict: bool): bool = all {
    status == "running", pc < N, SCRIPT[pc] == "C",
    if (accepts(conflict)) all {
      effects' = appendOps(effects, buffer.map(b => b._1)),
      badPin' = (badPin or buffer.exists(b => b._2 != segVer)),
      status' = "ok", pc' = N, buffer' = Set(), segVer' = -1,
      meta' = meta, lastOwn' = lastOwn, segStart' = segStart, retries' = retries, ownInvisible' = ownInvisible, otherDone' = otherDone,
    } else all { abortSegment, meta' = meta, lastOwn' = lastOwn, effects' = effects, keepGhost }
  }

  /** 別の接続の DDL。 */
  action otherDdl: bool = all {
    not(otherDone),
    meta' = meta + 1, otherDone' = true,
    pc' = pc, segVer' = segVer, segStart' = segStart, buffer' = buffer, lastOwn' = lastOwn, effects' = effects,
    retries' = retries, status' = status, badPin' = badPin, ownInvisible' = ownInvisible,
  }

  action step = any {
    write,
    repin,
    { nondet x = oneOf(Set(true, false)) ddl(x) },
    { nondet x = oneOf(Set(true, false)) commit(x) },
    otherDdl,
  }

  val prefixOfScript = isPrefix(effects, EFFECTFUL)
  val pinned = not(badPin)
  val ownDdlVisible = not(ownInvisible)
  val completeWhenOk = status != "ok" or effects == EFFECTFUL
  val boundarySafe = prefixOfScript and pinned and ownDdlVisible and completeWhenOk

  // witness (not(到達したい状態) を invariant にして、違反が出れば到達できる)
  val witnessDone = not(status == "ok")
  val witnessRetriedAndDone = not(status == "ok" and retries == 1)
  val witnessOtherDdlThenDone = not(status == "ok" and otherDone)
}

// 決めた設計。DDL の前に確定し、取引は版を名乗り続け、断られた区切りだけをやり直す。
module m13_green {
  import m13_core(IMPLICIT_COMMIT = true, PIN = true, RETRY_WHOLE = false, DDL_DESPITE_FAILED_COMMIT = false).*
  run migrationTest =
    init.then(write).then(ddl(false)).then(write).then(ddl(false)).then(write).then(commit(false))
        .expect(status == "ok" and boundarySafe)
}

// 2026-11 までの実装。DDL はその場で効き、書き込みは COMMIT まで溜まる。取引は、知らない表に当たると版を取り直す。
module m13_red_main {
  import m13_core(IMPLICIT_COMMIT = false, PIN = false, RETRY_WHOLE = false, DDL_DESPITE_FAILED_COMMIT = false).*
  run outOfOrderTest =
    init.then(write).then(ddl(false))
        .expect(not(prefixOfScript))
}

// 版を名乗り続けるが、DDL の前に確定しない。自分が作った表へ書けない。
module m13_red_pin_only {
  import m13_core(IMPLICIT_COMMIT = false, PIN = true, RETRY_WHOLE = false, DDL_DESPITE_FAILED_COMMIT = false).*
}

// DDL の前に確定するが、取引が、計画し直さずに新しい版を名乗る。
module m13_red_repin {
  import m13_core(IMPLICIT_COMMIT = true, PIN = false, RETRY_WHOLE = false, DDL_DESPITE_FAILED_COMMIT = false).*
}

// 断られたら、文の並びの頭からやり直す。確定した区切りと DDL を 2 度実行する。
module m13_red_retry_whole {
  import m13_core(IMPLICIT_COMMIT = true, PIN = true, RETRY_WHOLE = true, DDL_DESPITE_FAILED_COMMIT = false).*
}

// 先に確定するのに失敗しても、DDL を実行する。前の区切りの書き込みが失われたまま、DDL だけが効く。
module m13_red_ddl_anyway {
  import m13_core(IMPLICIT_COMMIT = true, PIN = true, RETRY_WHOLE = false, DDL_DESPITE_FAILED_COMMIT = true).*
}
