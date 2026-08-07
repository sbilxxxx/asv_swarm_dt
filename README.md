# asv_swarm_dt

マルチASVスウォーム攻防シミュレーション基盤 — 海域デジタルツイン × フィジカルAI（LLM/VLM/VLA） × 安全保障

「AIエージェント社会シミュレーションハッカソン Vol.2」（[automata-lab](https://hackathon.automata-lab.jp/)）向けの開発リポジトリ。

- **公開デモ（GitHub Pages）**: [digital-twin（3D海域DT）](https://sbilxxxx.github.io/asv_swarm_dt/digital-twin/) / [swarm-sim（2Dバードビュー）](https://sbilxxxx.github.io/asv_swarm_dt/swarm-sim/)
- 設計の詳細: [`docs/system-design.md`](docs/system-design.md)
- **舞台となる海域は固定しない。** デフォルトのデモシナリオは東京湾（[`core/scenarios/tokyo_bay_minimal.json`](core/scenarios/tokyo_bay_minimal.json)）。座標・海岸線は簡略化した例示データで、実際の地理を正確には表さない。

## 構成

| ディレクトリ | 役割 |
|---|---|
| [`core/`](core/) | データ取り込み・シーン表現・シミュレーション・意思決定・学習データ互換ログを担う共有ロジック |
| [`digital-twin/`](digital-twin/) | 3D海域DT（センサー実証: カメラ・レーダー・GNSS） |
| [`swarm-sim/`](swarm-sim/) | 2Dバードビューの戦術マップ・マルチASVスウォーム |

## 実行方法

ビルド不要のES Modulesで書かれているが、`fetch()`でシナリオJSONを読むためローカルの静的サーバー経由で開く必要がある（`file://`で直接開くとCORSエラーになる）。

```bash
# リポジトリ直下で
npx serve .
# または
python -m http.server 8000
```

起動後、ブラウザで以下を開く。

- `http://localhost:8000/digital-twin/` — 3D海域DT（センサー実証）
- `http://localhost:8000/swarm-sim/` — 2Dバードビュー戦術マップ

両者は現在ランタイムを接続していない（独立したシナリオ・独立した`core`インスタンス）。接続方式の設計は[`docs/system-design.md`](docs/system-design.md) §2.2を参照。

## 現在の実装状況

- `core/`: データ取り込み（手書き海岸線1種のみ）・シーン表現・ASV運動学・GNSS/レーダー（実装済み）・カメラ（インターフェースのみ、実装は`digital-twin/`側）・ルールベースの意思決定（APIキー不要）・学習データ互換ログの型を実装
- `digital-twin/`: Three.jsで簡易3Dシーンを構築し、船体視点のカメラ画像・レーダー・GNSSをHUDに表示
- `swarm-sim/`: Canvas 2Dで海岸線・ASVアイコン・航跡を描画し、ルールベースエージェントで意思決定ループを駆動

未実装（インターフェースのみ予約、詳細は`docs/system-design.md`）: AUV、AIS/ドローン観測アダプター、他海域データアダプター、OpenUSD対応、波のサロゲートモデル、学習パイプライン本体、DTとswarm-simのランタイム接続（L1で実施）。

## ヘッドレス実行

`core/`はDOM非依存のためNode上でも無改造で動く（ブラウザ・Three.js・Canvas一切不要）。
その主張を実証するためのランナーを同梱している（[`scripts/headless_run.js`](scripts/headless_run.js)、npm依存なし）。

```bash
# 既定シナリオ（3隻: 防御2・侵入1）で5エピソード
node scripts/headless_run.js --episodes 5

# 隻数を30隻まで増やして5エピソード（シナリオのspawnを起点にリング状へ決定論的に合成）
node scripts/headless_run.js --episodes 5 --boats 30

# ログをJSON Linesとしてファイルへ書き出す（core自体はfs非依存のまま、書き出しはこのスクリプト側の責務）
node scripts/headless_run.js --episodes 5 --out episodes.jsonl --quiet
```

エピソードごとに`outcome`（defended/breached/timeout）・シム時間・壁時計時間を表示し、
最後に総step数・総壁時計時間・**steps/s**（1隻あたりのsteps/sも）を出力する。
意思決定は`swarm-sim/main.js`と同じ間引き間隔（物理6stepに1回、`DECISION_INTERVAL_STEPS=6`）で行う。

**実測値（Windowsノートで実測、Node v22.17.0、Intel Core i5-1145G7 @ 2.60GHz、1コアで実行）**:

| 隻数 | 条件 | steps/s |
|---|---|---|
| 3隻（シナリオ既定） | `--episodes 5` | 約38,400 steps/s |
| 30隻（合成spawn） | `--episodes 5 --boats 30` | 約1,900〜2,000 steps/s |

30隻側は`docs/review-findings-2026-08-07.md`記載の従来測定（移動のみのストレステストで約3,100 steps/s）より
低めに出るが、これは本ランナーが素の移動ループではなく、レーダーO(n²)・ミッション判定
（`evaluateMission()`）・ルールベース意思決定（`decide()`、6stepに1回）を含む実際のエピソードを
最後まで走らせているため（合成spawnにより短時間でbreachするエピソードが多く、1エピソードあたりの
初期化コストの比率も相対的に増える）。いずれも「GPUで並列に多数体・多エピソードを回せる」という
主張を、外部スクリプト無しでこのリポジトリだけで再現・検証できることを実測で示す。

## 実LLM/VLM/VLAへの差し替え

デフォルトはAPIキー不要のルールベース関数（`core/sim/agents/rule_based_fallback.js`）。実際のLLM呼び出しに差し替える場合は、`LlmAgent`の`decideFn`にOllama等のHTTP APIを呼ぶ関数を渡す（ブラウザから直接クラウドAPIキーを扱わないための設計判断。詳細はチャットでの設計議論・`docs/system-design.md`参照）。
