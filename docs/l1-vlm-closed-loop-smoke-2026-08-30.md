# L1 スモーク — 実レンダ画像でのVLM航海士・閉ループ（2026-08-30）

> [`l1-vlm-navigator-plan.md`](l1-vlm-navigator-plan.md) の Task 1 と、縦切り（Task 5〜7）の最小版を
> 1セッションで通したときの実測。合成画像1枚だった 08-14 のスモークと違い、
> **`digital-twin/` が実際に描いているブリッジ一人称の絵**をそのまま VLM に渡している。

## 1. 何を作ったか

| 追加物 | 役割 |
|---|---|
| [`scripts/vlm_probe.js`](../scripts/vlm_probe.js) | 単発計測。実レンダ画像 × 解像度水準で、A グラウンディング / B 航路判断（画像あり）/ C 同テキスト画像なし を測る |
| [`scripts/vlm_navigator_run.js`](../scripts/vlm_navigator_run.js) | **閉ループ1エピソード**。カメラ画像＋GNSS＋レーダー＋目的地 → VLM が `keep/replace` とwaypoint列 → `World.orders` → 既存 `BoatController` → 運動学 → 船が動く → 次サイクルの絵 |

作りの制約:

- **`digital-twin/`・`core/` は無変更。** ページには `window.__debug` フック経由でスクリプトを注入し、
  撮影・進行はそこから駆動する。既存の `ThreeCameraSensor` / `RadarSensor` / `GnssSensor` /
  `BoatController` / `AsvPlatform` をそのまま使っている（計画 §3 の「無変更で再利用」）。
- 推論呼び出しは Node 側。ブラウザから Ollama を叩かないので CORS 設定に依存せず、
  推論URL・モデル名がブラウザ側に残らない（CLAUDE.md の方針と整合）。
- 進行はシム時間で刻む（dt=0.1s、判断は intervalS=10 シム秒ごと）。推論に何秒かかっても
  軌跡は変わらない（[`time-model.md`](time-model.md) §9 の headless 側と同じ扱い）。
- 撮影のあいだだけ renderer を固定解像度に切り替えて元に戻すので、表示canvasのサイズに依存しない。

アーム: `vlm`（画像あり）/ `blind`（同テキスト・画像なし＝統制群）/ `scripted`（推論なし・直行＝基準線）。

## 2. 実測（RTX 3060 12GB × Ollama × qwen2.5vl:7b）

### 単発（`vlm_probe.js`、640×360、n=1）

| | prompt tokens | レイテンシ | 結果 |
|---|---|---|---|
| A グラウンディング | 1,238 | 22.7s（コールド） | 画面右90%の船を正しく報告。ただし後述の描画物を "barriers" と誤認 |
| B 航路判断（画像あり） | 1,437 | 2.7s | 有効JSON・`replace`・危険1行報告 |
| C 同テキスト（画像なし） | 397 | 1.4s | 有効JSON |

画像640×360で **+1,040トークン**・約41KB。08-14 の合成画像の目安（≈918トークン）と同じ桁。

### 閉ループ1エピソード（`vlm_navigator_run.js`、目的地まで直線381m、判断10シム秒ごと）

| アーム | 到達 | サイクル数 | 経路長比 | 推論 p50/max | keep率 | 同一プラン再送率 | パース失敗 |
|---|---|---|---|---|---|---|---|
| `vlm` | **到達** | 7 | 1.01 | 1.78s / 2.91s | 57% | 29% | 0 |
| `blind` | 到達 | 8 | 1.09 | 1.48s / 1.70s | 38% | 25% | 0 |
| `scripted` | 到達 | 7 | 1.01 | — | — | — | — |

レンダリング（撮影1枚）p50 84〜115ms。ウォームアップ1発は必須（コールド20s超）。

**M1（空海面・直行の完走）は成立**。`intervalS=10s` に対し render+infer が約2〜3s なので、
宣言値は `renderS≈0.1` / `inferS≈2.0`（p95側で3.0）が実測から出る目安。

## 3. 読み取り（08-14 のスモークと変わったところ）

1. **閉ループは回る。** 推論・追従・運動学・レンダの往復が10シム秒間隔で成立し、船は目的地に着いた。
2. **waypoint幾何の弱さは残っている。** `replace` のとき **目的地と同じ点を3つ並べて返す**退化が出た
   （08-14 の「自船位置混入・順序逆転」と同系統）。`sanitizePlan()` で自船位置近傍の除去・
   運用領域クランプ・**連続同一点の畳み込み**を行い、落とした件数を `notes` に必ず残している。
3. **このシナリオでは視覚の効果を分離できない。** 空海面＋直行なので `vlm` と `blind` の差は
   経路長比 1.01 vs 1.09 どまりで、n=1 では意味を持たない。計画 §6 のとおり
   **カメラにしか映らない障害物（ブイ列）を置く M2 を作らないと「視覚が効いている」は測れない**。
4. **入力画像そのものに描画上の問題がある。** ブリッジ視点に、海面パッチの境目とみられる明るい帯と
   灰色の板状物体が写り込み、VLM はこれを "barriers"（障害物）と報告した。
   VLM への入力が壊れている＝判断が壊れるので、M2 に進む前にここを詰める必要がある。
   俯瞰確認でも船の周囲が陸色になる絵が出ており、原因は未特定のまま残している。

## 4. 実行方法

```bash
# 単発計測（実レンダ画像 × 解像度2水準）
node scripts/vlm_probe.js --model qwen2.5vl:7b --samples 3

# 閉ループ1エピソード
node scripts/vlm_navigator_run.js --arm vlm --model qwen2.5vl:7b --cycles 12
node scripts/vlm_navigator_run.js --arm blind --model qwen2.5vl:7b --cycles 12
node scripts/vlm_navigator_run.js --arm scripted --cycles 12   # 推論サーバ不要
```

出力は `logs/vlm-nav-<日時>-<arm>/` に各サイクルの送信画像・`decisions.jsonl`（プロンプト・生応答・
パース結果・落とした waypoint の理由・実測 t_wall）・`summary.json`・`overview.png`。
初回は `cd .devtools && npx puppeteer browsers install chrome-headless-shell` が必要。

## 5. 計測の限界（そのまま設計に載せない）

- 各アーム **n=1**。§2 の挙動指標は「回った」ことの記録であって、アーム間の比較にはまだ使えない。
- 上表の `vlm` アームの数値は、連続同一点の畳み込みと毎ステップ `updateShips` の修正を入れる**前**の
  ランのもの（`blind` は畳み込みのみ入った状態）。比較ランは計画 Task 8 で条件を揃えて取り直すこと。
- 舞台は `tokyo_bay_minimal.json` のまま。目的地は `protectedAsset` を流用しており、
  L1 用のシナリオ（計画 Task 3 の `pilotage_m1..m3`）はまだ無い。
