# 本物の Cloudflare での確認 (2026-11-12)

計画書の「公開を止める条件」の 4 のための記録である。持ち主の了承 (2026-11-12、「無料枠は考慮せず、1 ドルは超えないでね」、
「CPU使用量は少な目のほうが嬉しい」) を得て流した。アカウントの ID、workers.dev の名前、トークンは書かない。

## 流し方

`scripts/cloudflare-check.sh` を流した。
このスクリプトは、`packages/cf-d-infinity/wrangler.jsonc` から一時的な構成を作り、Worker を置き、`test/workerd.test.ts` をその Worker へ向けて流し (`DINF_LIVE_URL`)、Worker を消す。
本番の構成からの違いは 4 つある。名前を `dinf-check-<乱数>` にし、シャードを 4 つにし、Cron Trigger を外し、1 回の呼び出しの CPU に 5 秒の上限 (`limits.cpu_ms`) を付けた。
トークンは毎回乱数で作った。wrangler は 4.158.0 である。

## 結果

| 回 | コミット | Worker | 試験 | HTTP の要求 | 試験の時間 |
|---|---|---|---|---|---|
| 1 | `b3bea14` | `dinf-check-a24200` | 24 件すべて通った | 135 | 15 秒 |
| 2 | `634832d` | `dinf-check-e2a4a2` | 25 件すべて通った | 143 | 30 秒 |

2 回目は、1 回目の後に足した試験 (期限より長くかかる index の作成) を含む。その作成は 7,071 ms かかり、成功した。

どちらの回も、終わった後に Worker を消した (`wrangler delete`)。
消した後、アカウントの Worker の一覧と Durable Object の名前空間の一覧を API で引き、`dinf` で始まるものが残っていないことを確かめた。

## 本物で確かめたこと

- 認証 (データと管理のトークンを分ける)、計測用の入口がないこと、改ざんした baton を断ること。
- 手を加えていない `@libsql/client` が、HTTP と WebSocket (hrana2) の両方で、文、batch、対話的な取引を流せる。Drizzle の libSQL ドライバが動く。
- シャードをまたぐ取引が、並行しても原子的である (残高の移動。合計が変わらない)。
- Drizzle の libSQL の移行が通る。行のある表に UNIQUE の index を作る (書き込み禁止、Meta の `renewLock` による最初の延長、公開)。表を作り直す (DROP の守り: `lockTables`、シャードの適用、`unchanged`、`finishLock`)。
- 対話的な取引の中の DDL が、HTTP の要求をまたいで通る (先の確定と、次の取引を開くこと)。
- `/admin/split` で、シャードの一部を新しいシャードへ移せる。保守の操作の枠を取り (`beginSplit`)、子の受け入れが Meta の `startSplit` を、親の fence が `checkSplit` を呼び、終わりに枠を返す (`endSplit`)。移った行も含めて全部の行が読め、書け、その後の表定義の変更が待たずに通る。
- (2 回目) 期限 (5 秒) より長くかかる UNIQUE の index の作成が、周期の延長で書き込み禁止を保ち、成功する。開いたままだった取引は、表定義の変更による衝突で失敗し、行と index は一致する。

## 本物で確かめていないこと

- 自動の分割 (Autoscaler が Cron と alarm で負荷を追い、割る)。Cron を外したので動かしていない。分割は `/admin/split` からだけ通した。手元の workerd では `test/autoscale-cron.test.ts` が通している。
- 書き込み禁止の間に来た、別の書き込みが待たされること (`TableLocked` を受けて待つ経路)。2 回目の試験で断られたのは、禁止の前に書いて開いたままだった取引である。
- 資源の上限 (1 つの文の束縛の数 100、1 回の呼び出しの要求の数など) に近い大きさの文。行は数十しか入れていない。
- 複数の場所 (colo) から同時に来る要求、DO の再起動、Cloudflare 側の障害。

## 費用

Cloudflare の集計 (GraphQL の `workersInvocationsAdaptive`、`durableObjectsInvocationsAdaptiveGroups`、`durableObjectsPeriodicGroups`) を、流した 15 分後まで引いた。
返ったのは一部だけで、実際の使用量の全体は分からない。
消した Worker の Worker の要求は、返らなかった (同じ時間のほかの Worker の行は返る)。
DO の要求は、script の名前が `__unknown__` の 3 つの名前空間について合わせて 792 回が返った。
DO の実行時間と行の数は、1 分ぶんしか返らなかった。
返った値は、下の見積もりの範囲に収まる。
以下は、数えた HTTP の要求の数からの、上限の見積もりである。Workers Paid の単価で、含まれる量を差し引かずに数えた。

- Worker の要求: 2 回で 278 回と WebSocket が数本。300 回 × $0.30/100 万 = $0.0001。
- Worker の CPU: 1 回 100 ms までとして 3 万 ms × $0.02/100 万 ms = $0.0006。
- DO の要求: HTTP の要求 1 回につき 20 回までとして 6,000 回 × $0.15/100 万 = $0.001。
- DO の実行時間: 2 回 × 8 個 × 3 分 × 128 MB = 360 GB-s × $12.50/100 万 = $0.005。
- 行の書き込み: HTTP の要求 1 回につき 100 行までとして 3 万行 × $1.00/100 万 = $0.03。読みと保存は、これより小さい。

合わせて $0.04 を超えない。持ち主の上限 ($1) の 25 分の 1 である。
