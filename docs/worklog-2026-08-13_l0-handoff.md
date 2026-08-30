# 作業ログ 2026-08-13 — L0 実装の途中引き継ぎ

> ブランチ: `feat/l0-command-hierarchy`（push 済み）
> 計画: [`l0-llm-agent-plan.md`](l0-llm-agent-plan.md) ／ 時間設計: [`time-model.md`](time-model.md) v2.0 ／ 全体計画: [`development-roadmap.md`](development-roadmap.md)
> 次の作業は別マシン（GPU 環境）で再開する想定。環境の準備は [`../README.md`](../README.md) 「別環境で作業を再開する」を参照。

## この日やったこと

**設計**: `time-model.md` を v2.0 へ改稿した。v1.1 が「未決の論点 A/B/C」として残していた複数処理パイプラインの扱いを設計に置き換えている。要点は、全停止とローカルタイムアウトが対立するアーキテクチャではなく締切 `deadlineS` の両端だと分かったこと、レイテンシをステージの宣言合成（直列＝和・並列＝max）にしたこと、発行トークンを必須にしたこと。`development-roadmap.md` を新規作成し、L0 → Phase 2 → L1 → L2 の依存関係と GPU 採択有無の分岐を書いた。

**実装**: 計画の Task 2・3・4 を完了。Task 1（`llm_probe` の実測）は Ollama にモデルが未取得のため未着手のまま飛ばした。

| 計画 | 状態 | コミット |
|---|---|---|
| Task 1: 推論サーバの実測 | **未着手**（Ollama にモデルが無い。約5GBの pull が必要） | — |
| Task 2: レーダー探知距離のシナリオ設定化 | 完了 | `0125daa` |
| （計画外）合成 spawn の配置バグ修正 | 完了 | `a01f701` |
| Task 3: 観測のエンティティ基準化・トラックストア | 完了 | `dfe09fa` |
| Task 4: orders と艇の追従制御 | 完了 | `413c28d` |
| Task 5: DecisionScheduler | **テストのみ**（実装は次） | `tests/command.test.js` に parked |
| Task 6〜10 | 未着手 | — |

## 計画外の修正（Task 2 の途中で発見）

`--boats 6` が全エピソード1ステップで終わっていた。合成 spawn の渦巻き半径が 60m 刻みで、これが `INTERCEPT_RANGE_M`（60m）と一致していたため、最初の合成侵入艇が既存防御艇の迎撃圏ちょうどに生まれていた。半径を 150m 刻みへ広げたところ、それが隠していた2件目——30隻時に合成侵入艇が防護対象の 70m（突破圏 80m の内側）に生まれる——が露出したので、侵入艇はアセットから 250m まで放射方向に押し出すようにした（乱数を使わないので決定論は維持）。

**master にも存在した既存バグで、今回の変更による回帰ではない**（`git stash` して master 上で再現確認済み）。放置すると Task 8 Step 4 のベースライン計測（`--boats 6` で defended と breached の両方が出ること）が成立しないため、先に潰した。修正後は6隻で 151〜2166 ステップの実のあるエピソードになり、両方の結末が出る。30隻のスループットは約1,900 steps/s のままで README の数字と整合する。

## 次にやること — Task 5（DecisionScheduler）

**テストは書き終えていて、`tests/command.test.js` の末尾に置いてある。** ただし実装が無いと落ちるので `main()` からは呼んでいない。再開の手順はそのファイルの囲みコメントに書いた通り:

1. `main()` の末尾で `PENDING_TASK5_TESTS` を回すようにする（red を確認）
2. `core/sim/command/decision_scheduler.js` を書く
3. green を確認して囲みコメントごと削除する

**計画書 Task 5 のコード例は 2026-08-12 時点のもので、発行トークンを持っていない。** v2.0 で必須化した差分（roadmap §4 の D-1/D-2/D-3）を必ず反映すること。テストはその差分込みで書いてあるので、計画書のコードをそのまま貼ると3本のうち2本が落ちる。具体的には:

- `markIssued(id, t)` が発行ごとのトークンを返し、`provideResult(id, result, token)` はトークン一致時のみ書き込む。`reset()` は世代を進める。同一エピソード内でも発行ごとに別トークン（世代だけでは前サイクルの結果を弾けない）。
- `register()` が `deadlineS`（既定 `Infinity`）・`onMiss`（既定 `'keep-current'`）を受け付け、締切超過を `missedAt(t)` / `takeMissed(id)` で公開する。既定値なら L0 の挙動は計画どおりで変わらない。
- 不成立の確定後に遅れて届いた結果は、トークンが一致していても捨てる（pending が既に無い）。発行のリズム（`nextIssueAtT`）は崩さない。

## 環境まわりの注意

- **Task 1 には `ollama pull` が必要**（約5GB）。手元の PC には Ollama 本体はあるがモデルが1つも入っていない。`latencyS` の既定 3s が実測と大きく乖離するなら、計画書 Task 1 Step 3 の指示どおり既定値の方を実測に寄せる。
- 推論サーバは別ホストでよい（`--llm-url` の向き先を変えるだけ）。`latencyS` が設定値なので、実行環境が変わってもシムの展開は同一になる。
- `.devtools/` の puppeteer は `node_modules/` が gitignore 対象なので、スクリーンショット QA を使うなら移行先で `npm install` が要る。Task 9（ブラウザ配線）の目視確認で必要になる。
