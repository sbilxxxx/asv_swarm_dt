# 作業ログ 2026-08-14 — L0 完了

> ブランチ: `feat/l0-command-hierarchy`（**未コミット**。最終コミット `af5f5c4`）
> 計画: [`l0-llm-agent-plan.md`](l0-llm-agent-plan.md) ／ 時間設計: [`time-model.md`](time-model.md) v2.0 ／ 全体計画: [`development-roadmap.md`](development-roadmap.md)
> 実測: [`l0-experiment-log.md`](l0-experiment-log.md)（指揮官アーム比較）・[`llm-probe-measurements-2026-08-13.md`](llm-probe-measurements-2026-08-13.md)（推論サーバ）
> 前回: [`worklog-2026-08-13_l0-handoff.md`](worklog-2026-08-13_l0-handoff.md)

## この日やったこと

**L0（Task 1〜10）を全部終えた。** 指揮官階層と時間フレームワークが実装され、ローカル Ollama に対する実推論で
3アームの比較ランを回し、結果を [`l0-experiment-log.md`](l0-experiment-log.md) に記録した。
レビュー指摘 B-7「LLM/VLM/VLA のコードが1行も無い」は**指揮官レベルまで対応済**になった（1,893行）。

そして**実験の結論は帰無だった**。指揮官を LLM にしても、統制群に対する勝率の改善は 25エピソード/アームでは
統計的に確認できない。これは失敗ではなく、正しく測った結果として公開する（§「押さえておくべき2点」）。

## 計画のタスク一覧

| 計画 | 状態 | 主な成果物 |
|---|---|---|
| Task 1: 推論サーバの実測 | **完了** | `scripts/llm_probe.js`、[`llm-probe-measurements-2026-08-13.md`](llm-probe-measurements-2026-08-13.md)。`latencyS=3s` は変更不要と判定 |
| Task 2: レーダー探知距離のシナリオ設定化 | 完了（`0125daa`） | |
| Task 3: 観測のエンティティ基準化・トラックストア | 完了（`dfe09fa`） | `core/sim/command/tracks.js` |
| Task 4: orders と艇の追従制御 | 完了（`413c28d`） | `core/sim/command/orders.js`・`boat_controller.js` |
| Task 5: DecisionScheduler | **完了**（未コミット） | `core/sim/command/decision_scheduler.js`。発行トークン・`deadlineS`・`onMiss`・ステージ別の実測記録（D-1/D-2/D-3 すべて反映） |
| Task 6: 統合図・パース・scripted 指揮官 | **完了**（未コミット） | `fused_picture.js`・`commander_prompt.js`・`parse_orders.js`・`scripted_commanders.js` |
| Task 7: LLM 指揮官 | **完了**（未コミット） | `llm_commander.js`・`core/sim/agents/llm_http.js`（OpenAI 互換） |
| Task 8: headless 配線 | **完了**（未コミット） | `scripts/headless_run.js` v2（`--blue/--red`・`--llm-log`・`--decision-log`・判断サイクルの検証行） |
| Task 9: ブラウザ配線 | **完了**（未コミット） | `swarm-sim/` をスケジューラ駆動へ。指示オーバーレイ・推論待ち停止・不成立表示 |
| Task 10: 比較ランと記録 | **完了**（Step 7 のコミットを除く） | [`l0-experiment-log.md`](l0-experiment-log.md)、B-7 更新、README 更新 |

**計画書 [`l0-llm-agent-plan.md`](l0-llm-agent-plan.md) のチェックボックスは意図的に触っていない**（同ファイルは元から
どのタスクも完了印を付けない運用。Task 2/3/4 も未チェックのままなので体裁を合わせた）。実際の完了状態はこの表を正とする。

## 完了条件の判定（計画書「完了条件」）

| 条件 | 判定 | 根拠 |
|---|---|---|
| `command.test.js` / `core_smoke.test.js` 全件 PASS | **満たす** | 27 + 11 = 38 件 PASS |
| 3アームが完走し勝率が並ぶ | **満たす** | 76.0% / 88.0% / 100.0%（[実験ログ §2](l0-experiment-log.md)）。**ただし差は有意ではない** |
| keptOrders 率 20% 未満 | **満たす** | 3アーム 533 コールで 0 件。全 1,554 コールでも 1 件（0.06%） |
| 発効が `t_issue + latencyS` に厳密一致 | **満たす** | 2,701 サイクル全件一致・最大ずれ 1.7e-13 s。`command.test.js` でも担保 |
| ブラウザ既定はサーバー不要・LLM モードで推論待ち表示 | **満たす** | 既定は両陣営 scripted。`?blue=llm` で停止オーバーレイと不成立表示を実機確認 |
| `l0-experiment-log.md` が実測で埋まり、`system-design.md` に時間モデルの節がある | **満たす** | 両方あり |

**未達はゼロ。** ただし「勝率が並ぶ」の中身が帰無であることは条件表では表現できないので、下に書く。

## 押さえておくべき2点（実験の中身）

**(1) 76.0% → 88.0% を「改善」として引用してはいけない。** アームB（llm 対 scripted）を条件を変えずに3回回すと
88.0 / 76.0 / 84.0% で、**同条件反復の幅 12.0 ポイントは統制群との差 12.0 ポイントと同じ大きさ**である。
McNemar p = 0.45、対応のある平均差の 95% CI は [-8.2, +21.5] pt。分離には**1アームあたり約170エピソード**が要る
（現状の検出力は約19%）。LLM アームは1エピソード約15秒なので170×2アームで約1.4時間——L2 の設計に織り込むこと。
アームCの 100% も防御側の強さではなく、**LLM 侵入側が弱い**（指示の46%が防護対象ではなく護衛艇を追う `intercept`）ことの反映である。

**(2) 采配には再現する具体的な欠陥がある。** 防御側の `move_to` の **80.9% が直前とバイト単位で同一**の再送で、
35.7〜37.6% はどの可視トラックからも 200m 以上離れている（＝更新されない死んだ waypoint）。
これは勝率と違って反復間で安定した行動指標なので、N が小さくても読める。
**プロンプトに動作の説明を1行足す A/B（`ORDERS_SCHEMA` へ `intercept` / `move_to` / `patrol` の意味を1行）は悪化した**
（再送率 80.9% → 98.3%、遠い waypoint 36.6% → 68.9%、各版2反復でクラスタが非重複）。**この1行は revert 済み**で、
`commander_prompt.js` は実験前とバイト単位一致。必要なのは説明ではなく「すでに出した waypoint を出し直すな」という禁止か、
防御側スキーマからの `move_to` 除去——どちらも Phase 2 側の課題。

## 次にやること

**Phase 2（艇レベル LLM）が本命。** ハッカソンの主題そのもので、L0 で止めた状態は提出物として弱い（roadmap §2）。
着手前に [`time-model.md`](time-model.md) §12.5「段階適用」のゲートを通す必要がある。

L1（VLM）は GPU クラスタの採択が事実上の前提。時間フレームワーク側の追加は render ステージの直列宣言だけで済み、
ステージ別の実測 t_wall は既に `--decision-log` に出ているので、準備はできている。

## 人間に決めてもらうこと（3件）

### 1. `OLLAMA_NUM_PARALLEL=4` にするか（環境設定・すぐ効く）

稼働中の Ollama は既定の `NUM_PARALLEL=1` のままで、**指揮官2体の発行が直列化している**。
実測（[llm-probe §4.3](llm-probe-measurements-2026-08-13.md)）:

| | 判断/秒（同時4） | 2体同時の mean latency |
|---|---|---|
| `NUM_PARALLEL=1`（現状） | 0.50 | 3,772 ms |
| `NUM_PARALLEL=4` | **0.93（1.9倍）** | **2,489 ms** |

現状は2体目の実時間 3.8s が `latencyS=3s` を追い越すので、`TIME_SCALE=1` のブラウザでも可視の停止が出る。
4 にすれば 2.5s に収まり停止しなくなる。**シムの結果は変わらない**（I4。設定値だけが軌道を決める）ので、
実験の比較可能性には一切影響しない純粋な運用改善。

**本セッションでは変更していない**（ユーザーのサービス設定であり、勝手に触らない方針）。
`OLLAMA_NUM_PARALLEL=4 ollama serve` で起動する運用にするかどうかを決めてほしい。
なお `qwen2.5:14b` を使う場合は並列度 1〜2 に抑えること（12GB に KV キャッシュ4スロットが載らず CPU 退避で 33.8 → 20.0 tok/s に落ちる）。

### 2. Phase 2 の `TIME_SCALE=3` ゲート — 4択のどれを採るか

roadmap §5 のゲート算術: 艇6隻・`intervalS=3s` なら発行レート 2.2 回/シム秒、`TIME_SCALE=3` のブラウザが
止まらずに流れるには **6.6 回/実秒**が必要。実測は **1.94 回/秒（艇プロンプト・同時6）で 3.4倍不足**。

| 選択肢 | 成立条件（実測 1.94 回/秒からの逆算） |
|---|---|
| `TIME_SCALE` を下げる | ≦ 0.88。**等倍ですら 12% 足りない** |
| `intervalS` を延ばす | `TIME_SCALE=1` なら ≧ 3.4s（現状 3s からわずか）。`TIME_SCALE=3` なら ≧ **13.4s** |
| 隻数を絞る | `TIME_SCALE=1`・3s 間隔で **5隻が上限**。`TIME_SCALE=3` では **1隻** |
| GPU 環境で回す | 約 **3.4倍**の演算性能 |

**`TIME_SCALE=3` を諦めれば Phase 2 は射程に入る**（5隻のまま、または6隻で `intervalS=3.4s`）というのが実測から見える形。
`TIME_SCALE=3` を維持したまま6隻を回すには `intervalS=13.4s` が必要で、それは「艇が自分で判断している」という
主題そのものを薄める。**この判断が Phase 2 計画書の最初の決定事項**になる。GPU 採択の可否で分岐する（roadmap §8）。

### 3. 有限 `deadlineS` の非決定論経路を認めるか（設計判断）

Task 5 の実装で、不成立の判定経路が**2つ**あることが分かった。[`time-model.md`](time-model.md) §12.5 に追記済み。

- 経路1（発行時に確定・`reason:'doomed'`）は設定値とシードだけで決まる＝決定論。
- 経路2（締切までに**結果が到着しなかった**・`reason:'unarrived'`）は「実物が届いたか」で判定するのでマシン速度依存＝ I4 を破る。スケジューラは `deterministic:false` を立てて実行器に伝える。

**headless は発行を await するので経路2に原理的に入れない**＝実験データの決定論は保たれる。効くのはブラウザデモだけ。
この非対称を設計として認めるか、有限 `deadlineS` をブラウザで無効化するかは**人間の判断に残してある**。
L0 の既定は `∞` なので経路2は一度も発火していない（実験ログの `missed=0`）。決める時期は Phase 2 で有限締切を採用するとき。

## リポジトリの状態（重要）

**すべて未コミットである。** L0 の実装本体（Task 5〜9）と本日のドキュメントが作業ツリーにあるだけで、
最終コミットは `af5f5c4`（Task 5 のテストを parked した時点）。**計画書 Task 8/9/10 の Step 7（コミット）は
本セッションの指示範囲外として実行していない。** B-9 の指摘どおり審査員が見るのは push された内容なので、
**次の作業の最初にコミットと push を行うこと。**

| 状態 | ファイル |
|---|---|
| 新規（未追跡） | `core/sim/command/{decision_scheduler,fused_picture,commander_prompt,parse_orders,llm_commander,scripted_commanders}.js`・`core/sim/agents/llm_http.js`・`scripts/llm_probe.js`・`docs/{l0-experiment-log,llm-probe-measurements-2026-08-13}.md`・本ファイル |
| 変更 | `.gitignore`（`logs/` 追加）・`README.md`・`scripts/headless_run.js`・`core/sim/command/orders.js`・`tests/command.test.js`・`swarm-sim/{main,map_view,log_panel,hud_panel}.js`・`swarm-sim/index.html`・`docs/{system-design,time-model,development-roadmap,review-findings-2026-08-07}.md` |

**`logs/` は `.gitignore` 対象**（約107MB）。実験の生ログはこのマシンにしか無い。
再現に必要な数値と手順は [`l0-experiment-log.md`](l0-experiment-log.md) §8 に全部書いたので、
リポジトリだけで追試できる（統制群アームは 0.23 秒、LLM アームは約42分）。

## 環境まわりの注意

- **`.devtools/` で `npm install` 済み**（`PUPPETEER_SKIP_DOWNLOAD=true`、システム Chrome を使う）。`node_modules/` は gitignore 対象なので別マシンでは再度必要。
- ブラウザ側は **http:// 経由で開くこと**（`file://` は `fetch()` の CORS で動かない）。既定パラメータなら推論サーバ不要。
- `swarm-sim/` の LLM モードは Ollama の既定 origin 許可（`http://localhost:*`）で動いた。別ホストの推論サーバを使うなら `OLLAMA_ORIGINS` が要る。
- コールドスタートは 8.7s（7B）で `latencyS` の約3倍。実行器は**エピソード開始前にウォームアップを1発撃つ**実装になっている（`--no-warmup` で省略可）。
