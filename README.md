# asv_swarm_dt

マルチASVスウォーム攻防シミュレーション基盤 — 海域デジタルツイン × フィジカルAI（LLM/VLM/VLA） × 安全保障

「AIエージェント社会シミュレーションハッカソン Vol.2」（[automata-lab](https://hackathon.automata-lab.jp/)）向けの開発リポジトリ。

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

## 実LLM/VLM/VLAへの差し替え

デフォルトはAPIキー不要のルールベース関数（`core/sim/agents/rule_based_fallback.js`）。実際のLLM呼び出しに差し替える場合は、`LlmAgent`の`decideFn`にOllama等のHTTP APIを呼ぶ関数を渡す（ブラウザから直接クラウドAPIキーを扱わないための設計判断。詳細はチャットでの設計議論・`docs/system-design.md`参照）。
