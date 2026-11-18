// -*- mode: Bluespec; -*-
// M23i: 取引が読んだ表を DROP する前の確かめを、範囲の移動をまたいで通す (未解決の問題 37 の続き)
//
// 2026-11-17 に書いた。実装より先に書いたモデルである。設計は docs/design-refresh-across-move.md の「3 回目の実装の規則」にある。
//
// 背景。取引の中で表を作り直すとき (古い表を読んで新しい表へ写し、古い表を DROP する)、DROP は、写す取引が古い表を読んだ後に、別の
// 接続がその表へ書いていないことを確かめる (M14、M21 の DROP の場面)。DROP の prepare が表を書き込み禁止にし、シャードは prepare を
// 適用した後で、読んだ範囲に、読んだ時刻より後の変更がないかを答える (unchanged)。
// 写す取引が読んだ後に、読んだ範囲が別のシャードへ動いていると、いまのコードは、確かめを読んだシャードへ送り、渡したシャードが
// NotOwner で断って、DROP が競合になる (「何も消していない」)。答えは誤らないが、移動だけで DROP が失敗する (規則 4)。
// M21 の DROP の場面 (m21_green_drop、m21_guard_green) に移動はない。M23 と M23b の確定の検証は、この入口を通らない。
//
// 規則。確かめも、確定の検証と同じ規則で通す。
//   REHOME      Worker は、読んだ範囲を、DROP の範囲表 (prepare の epoch のスナップショット) の持ち主へ分け直して送る。prepare から
//               commit までの間は移動が開かない (M21) ので、この範囲表は変わらない
//   ASK         持ち主は、prepare を適用した後で、読んだ時刻が受け持ち始めた時刻より前なら、前の持ち主に (読んだ時刻, 到着の m] を尋ねる
//   OWN_FROM_T  持ち主は、自分の記録を、読んだ時刻から確かめる (到着の m からではない。pull に乗った intent は、m より小さい c で
//               持ち主に適用される)
// 尋ねてから同期区間に入るまでに、受け取りの記録は変わらない。移動が開かないからである (M23g の入口の確かめは、ここでは起きない
// が、同じ入口を通るので、入れておく)。
//
// 舞台。古い表の行のグループが 1 つ。シャード P が持ち、C へ動くことがある (pull と recv の 2 手。prepare の前だけ)。時計は 1 つ。
// 写す取引は、持ち主で古い表を時刻 T で読み、確定する (確定の検証は M23 の規則で、ここでは正しく答えるものとして 1 手にした)。
// 別の接続の書き込みは、autocommit の W と、2 相の Y (持ち主で prepare し、anchor が c を決め、phase 2 はそのときの持ち主に届く)。
// DROP は、Meta が prepare を記録し、シャードが (intent を決着させてから) 適用し、持ち主が確かめに答え、Meta が commit を記録する。
// 期限が切れると abort になる。
//
// invariant
//   noLostWrite           DROP が commit されたなら、写す取引が読んだ後の、別の接続の確定はない
//   guardHolds            持ち主が「変わっていない」と答えた後、commit までの間に、読んだ範囲は変わらない
//   placementIndependent  DROP が abort になるのは、読んだ後に別の接続の確定があったときか、期限が切れたときだけである
module m23i_core {
  const REHOME: bool
  const ASK: bool
  const OWN_FROM_T: bool
  const HAS_Y: bool
  const WRITES_N: int

  pure val P = 1
  pure val C = 2
  pure val SHARDS = Set(1, 2)
  pure val FLYING = 8
  pure val APPLIED = 9
  // DROP の進み
  pure val BEFORE = 0           // 写す取引は、まだ読んでいない
  pure val READ = 1             // 写す取引が、古い表を T で読んだ
  pure val COPIED = 2           // 写す取引が確定した
  pure val PREPARED = 3         // Meta が prepare を記録した (古い表は書き込み禁止)
  pure val DROPPED = 4          // Meta が commit を記録した
  pure val ABORTED = 5          // Meta が abort を記録した
  pure val COPY_REFUSED = 9     // 写す取引の確定が、競合で断られた

  type Intent = { where: int, pts: int, c: int, pushed: int }
  type Ghost = {
    moveRefused: bool,          // 確かめが、渡したシャードに NotOwner で断られた
    expired: bool,
    asked: bool,                // 持ち主が、前の持ち主に尋ねた
    viaAsk: bool,               // 前の持ち主の記録に、読んだ後の確定があった
    viaOwn: bool,               // 持ち主の記録に、受け持ち始める前の c の確定があった (pull に乗った intent)
  }

  var now: int
  var phase: int
  var T: int
  var mvd: int                  // 0 移動の前、1 手放した (飛んでいる)、2 届いた
  var m: int                    // 手放した時刻
  var log: int -> Set[int]      // シャード -> 別の接続の確定の時刻
  var y: Intent
  var wN: int
  var applied: int -> bool      // シャードが prepare を適用した
  var gph: int                  // 確かめの進み。0 まだ、1 尋ねた、2 同期区間に入れる
  var gchg: bool                // 前の持ち主の答え
  var acked: bool               // 持ち主が「変わっていない」と答えた
  var g: Ghost

  pure def max(a: int, b: int): int = if (a > b) a else b
  action init = all {
    now' = 0, phase' = BEFORE, T' = -1, mvd' = 0, m' = 0, log' = SHARDS.mapBy(_ => Set()),
    y' = { where: 0, pts: 0, c: 0, pushed: 0 }, wN' = 0, applied' = SHARDS.mapBy(_ => false),
    gph' = 0, gchg' = false, acked' = false,
    g' = { moveRefused: false, expired: false, asked: false, viaAsk: false, viaOwn: false },
  }
  action keepMove = all { mvd' = mvd, m' = m }
  action keepGuard = all { gph' = gph, gchg' = gchg, acked' = acked }

  def holder: int = if (mvd == 0) P else if (mvd == 1) 0 else C
  def yAt(s: int): bool = y.where == s
  def yOpen: bool = y.where == P or y.where == C or y.where == FLYING
  def fenced(s: int): bool = applied.get(s) and phase == PREPARED
  // 写す取引が読んだ後の、別の接続の確定がある (Y は、c が決まったら確定している)
  def late: bool = T >= 0 and (SHARDS.exists(s => log.get(s).exists(c => c > T)) or (yOpen and y.c > T))

  // ---- 写す取引 ----
  action copyRead = all {
    phase == BEFORE, holder != 0, not(yAt(holder) and y.c > 0),
    phase' = READ, T' = now,
    y' = if (yAt(holder)) y.with("pushed", max(y.pushed, now)) else y,
    now' = now, log' = log, wN' = wN, applied' = applied, g' = g, keepMove, keepGuard,
  }
  action copyCommit = all {
    phase == READ, holder != 0,
    phase' = if (late or yOpen) COPY_REFUSED else COPIED,
    now' = now + 1,
    T' = T, log' = log, y' = y, wN' = wN, applied' = applied, g' = g, keepMove, keepGuard,
  }

  // ---- 別の接続の書き込み ----
  action wWrite = all {
    wN < WRITES_N, holder != 0, not(fenced(holder)), phase != DROPPED, not(yAt(holder)),
    now' = now + 1, wN' = wN + 1,
    log' = log.setBy(holder, cs => cs.union(Set(now + 1))),
    phase' = phase, T' = T, y' = y, applied' = applied, g' = g, keepMove, keepGuard,
  }
  action yPrepare = all {
    HAS_Y, y.where == 0, holder != 0, not(fenced(holder)), phase != DROPPED,
    now' = now + 1, y' = { where: holder, pts: now + 1, c: 0, pushed: 0 },
    phase' = phase, T' = T, log' = log, wN' = wN, applied' = applied, g' = g, keepMove, keepGuard,
  }
  action yDecide(c: int): bool = all {
    yOpen, y.c == 0, c >= y.pts, c > y.pushed, c <= now,
    y' = y.with("c", c),
    now' = now, phase' = phase, T' = T, log' = log, wN' = wN, applied' = applied, g' = g, keepMove, keepGuard,
  }
  action yPhase2 = all {
    y.where == P or y.where == C, y.c > 0,
    log' = log.setBy(y.where, cs => cs.union(Set(y.c))),
    y' = y.with("where", APPLIED),
    now' = now, phase' = phase, T' = T, wN' = wN, applied' = applied, g' = g, keepMove, keepGuard,
  }

  // ---- 移動 (prepare の前だけ。M21: 表定義の遷移が開いている間は、移動が開かない) ----
  action pull = all {
    mvd == 0, phase <= COPIED,
    mvd' = 1, m' = now + 1, now' = now + 1,
    y' = if (yAt(P)) y.with("where", FLYING) else y,
    phase' = phase, T' = T, log' = log, wN' = wN, applied' = applied, g' = g, keepGuard,
  }
  action recv = all {
    mvd == 1,
    mvd' = 2, m' = m,
    y' = if (y.where == FLYING) y.with("where", C) else y,
    now' = now, phase' = phase, T' = T, log' = log, wN' = wN, applied' = applied, g' = g, keepGuard,
  }

  // ---- DROP ----
  // Meta が prepare を記録する。移動が開いている間は記録しない (M21)
  action prepareOp = all {
    phase == COPIED, mvd != 1,
    phase' = PREPARED,
    now' = now, T' = T, log' = log, y' = y, wN' = wN, applied' = applied, g' = g, keepMove, keepGuard,
  }
  // シャードが prepare を適用する。intent が残っている間は適用しない (決着を待つ)
  action applyPrepare(s: int): bool = all {
    phase == PREPARED, not(applied.get(s)), not(yAt(s)),
    applied' = applied.set(s, true),
    now' = now, phase' = phase, T' = T, log' = log, y' = y, wN' = wN, g' = g, keepMove, keepGuard,
  }
  // Worker が確かめを送る。REHOME なら、読んだ範囲のいまの持ち主へ、そうでなければ読んだシャード (P) へ送る。渡したシャードは
  // NotOwner で断り、DROP は競合になる。持ち主は、prepare を適用した後で、受け持ち始める前からの窓を前の持ち主に尋ねる
  action gSend = all {
    phase == PREPARED, gph == 0, holder != 0,
    val target = if (REHOME) holder else P
    val asked = ASK and mvd == 2 and T < m
    if (target != holder) all {
      phase' = ABORTED, g' = g.with("moveRefused", true), gph' = gph, gchg' = gchg, acked' = acked,
      now' = now, T' = T, log' = log, y' = y, wN' = wN, applied' = applied, keepMove,
    } else all {
      applied.get(target),
      gph' = if (asked) 1 else 2, g' = g.with("asked", g.asked or asked), gchg' = gchg, acked' = acked,
      phase' = phase, now' = now, T' = T, log' = log, y' = y, wN' = wN, applied' = applied, keepMove,
    }
  }
  // 前の持ち主が、自分の記録の (読んだ時刻, m] を答える
  action gAnswer = all {
    phase == PREPARED, gph == 1,
    gph' = 2, gchg' = log.get(P).exists(c => c > T and c <= m), acked' = acked,
    now' = now, phase' = phase, T' = T, log' = log, y' = y, wN' = wN, applied' = applied, g' = g, keepMove,
  }
  // 持ち主が同期区間に入り、自分の記録を確かめて答える。決着していない intent も変更として数える
  action gEnter = all {
    phase == PREPARED, gph == 2, not(acked), holder != 0,
    val o = holder
    val from = if (OWN_FROM_T or mvd != 2) T else max(T, m)
    val own = log.get(o).exists(c => c > from) or yAt(o)
    val changed = own or gchg
    all {
      phase' = if (changed) ABORTED else phase,
      acked' = not(changed),
      g' = { ...g, viaAsk: g.viaAsk or gchg, viaOwn: g.viaOwn or (mvd == 2 and log.get(o).exists(c => c > T and c < m)) },
      gph' = gph, gchg' = gchg,
      now' = now, T' = T, log' = log, y' = y, wN' = wN, applied' = applied, keepMove,
    }
  }
  // Meta が commit (DROP) を記録する。持ち主が「変わっていない」と答えた後でだけ
  action commitOp = all {
    phase == PREPARED, acked,
    phase' = DROPPED,
    now' = now, T' = T, log' = log, y' = y, wN' = wN, applied' = applied, g' = g, keepMove, keepGuard,
  }
  // 期限切れ。DROP を進める側が止まっても、禁止は解ける
  action expire = all {
    phase == PREPARED,
    phase' = ABORTED, g' = g.with("expired", true),
    now' = now, T' = T, log' = log, y' = y, wN' = wN, applied' = applied, keepMove, keepGuard,
  }

  action step = any {
    copyRead, copyCommit, wWrite, yPrepare, yPhase2, pull, recv, prepareOp, gSend, gAnswer, gEnter, commitOp, expire,
    { nondet c = oneOf(1.to(8)) yDecide(c) },
    { nondet s = oneOf(SHARDS) applyPrepare(s) },
  }

  // ---- 不変条件 ----
  val noLostWrite = not(phase == DROPPED and late)
  val guardHolds = not(phase == PREPARED and acked and late)
  val placementIndependent = phase != ABORTED or late or g.expired
  val m23iSafe = noLostWrite and guardHolds and placementIndependent

  // ---- witness ----
  // 写す取引が読んだ後に範囲が動き、持ち主が前の持ち主に尋ねて、DROP が commit される
  val witnessDroppedAcrossMove = not(phase == DROPPED and g.asked)
  // 移動の前に、読んだシャードで確定した書き込みを、前の持ち主への尋ねが見つけて、DROP が abort になる
  val witnessRefusedByFormerOwner = not(phase == ABORTED and g.viaAsk and not(g.expired))
  // pull に乗った intent を、持ち主が受け持ち始める前の c で適用した確定を、持ち主の確かめが見つけて、DROP が abort になる
  val witnessRefusedByCarriedIntent = not(phase == ABORTED and g.viaOwn and not(g.viaAsk) and not(g.expired))
}

// 規則 (緑)。書き手 W 2 つと Y
module m23i_green {
  import m23i_core(REHOME = true, ASK = true, OWN_FROM_T = true, HAS_Y = true, WRITES_N = 2).*
  // 写す取引が P で読み、範囲が C へ動く。DROP の確かめは C へ行き、C は P に尋ねる。変更はなく、DROP が commit される
  run acrossMoveTest =
    init.then(copyRead).then(copyCommit)                                 // T = 0
        .then(pull).then(recv)                                           // m = 2
        .then(prepareOp).then(applyPrepare(C))
        .then(gSend).expect(gph == 1)
        .then(gAnswer).then(gEnter).then(commitOp)
        .expect(phase == DROPPED and m23iSafe and not(witnessDroppedAcrossMove))
  // 移動の前に P で確定した W を、P への尋ねが見つける
  run formerOwnerTest =
    init.then(copyRead).then(copyCommit).then(wWrite)                    // T = 0。W は c = 2
        .then(pull).then(recv).then(prepareOp).then(applyPrepare(C))
        .then(gSend).then(gAnswer).then(gEnter)
        .expect(phase == ABORTED and m23iSafe and not(witnessRefusedByFormerOwner))
}

// 赤: 確かめを、読んだシャードへ送る (いまのコード)。答えは誤らないが、移動だけで DROP が失敗する
module m23i_red_no_rehome {
  import m23i_core(REHOME = false, ASK = true, OWN_FROM_T = true, HAS_Y = true, WRITES_N = 2).*
  run notOwnerTest =
    init.then(copyRead).then(copyCommit).then(pull).then(recv).then(prepareOp).then(gSend)
        .expect(phase == ABORTED and g.moveRefused and not(placementIndependent) and noLostWrite)
}
// 赤: 持ち主が、前の持ち主に尋ねない。移動の前に、読んだシャードで確定した書き込みを失う
module m23i_red_no_ask {
  import m23i_core(REHOME = true, ASK = false, OWN_FROM_T = true, HAS_Y = true, WRITES_N = 2).*
  run lostWriteTest =
    init.then(copyRead).then(copyCommit).then(wWrite)
        .then(pull).then(recv).then(prepareOp).then(applyPrepare(C))
        .then(gSend).then(gEnter).then(commitOp)
        .expect(phase == DROPPED and not(noLostWrite))
}
// 赤: 持ち主が、自分の記録を到着の m から確かめる。pull に乗った intent を、m より小さい c で適用した確定を失う
module m23i_red_from_arrival {
  import m23i_core(REHOME = true, ASK = true, OWN_FROM_T = false, HAS_Y = true, WRITES_N = 2).*
  run carriedIntentTest =
    init.then(copyRead).then(copyCommit)                                 // T = 0
        .then(yPrepare)                                                  // pts 2
        .then(pull).then(recv)                                           // m = 3。intent は C へ
        .then(yDecide(2)).then(yPhase2)                                  // C が c = 2 で適用する
        .then(prepareOp).then(applyPrepare(C))
        .then(gSend).then(gAnswer).then(gEnter).then(commitOp)
        .expect(phase == DROPPED and not(noLostWrite))
}
