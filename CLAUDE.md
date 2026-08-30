# CLAUDE.md — asv_swarm_dt

マルチASVスウォーム攻防シミュレーション基盤（海域デジタルツイン × フィジカルAI × 安全保障）。
「AIエージェント社会シミュレーションハッカソン Vol.2」（automata-lab）向けの個人開発リポジトリ。

## 設計の正典

**[`docs/system-design.md`](docs/system-design.md) がこのリポジトリの設計の正典。**
アーキテクチャ（`core/` の①〜④層、`digital-twin/`・`swarm-sim/` の役割分担、Core⇔View接続方式）、
拡張性の方針（AUV・AIS・ドローン観測・OpenUSD・波サロゲートモデル等の差し込み口）はすべてここに書かれている。
実装判断に迷ったら、まずこのファイルを確認する。

## 開発計画

**[`docs/development-roadmap.md`](docs/development-roadmap.md) がフェーズの見取り図。**
現在地（実装済み／設計だけ／未着手）、L0 → Phase 2（艇レベルLLM＝ハッカソンの主題）→ L1（VLM）→ L2 の依存関係、
GPU 採択有無による分岐、意図的にやらないことを記載。個別の実装手順は各フェーズの計画書
（現在は [`docs/l0-llm-agent-plan.md`](docs/l0-llm-agent-plan.md)）にある。

**時間の扱いは [`docs/time-model.md`](docs/time-model.md) が正典。**
推論を含む意思決定はシム時間上で瞬時ではない（t_issue → t_apply）。変数は「ルール（結果を決める設定値）」と
「記録（実測ログ）」の2分類で、記録はルールに書き戻さない。複数処理パイプライン（レンダリング・推論・
センサ取得・通信）の合成と締切の設計は §12.5。**L0 実装時は time-model v2.0 との差分3点
（roadmap §4 の D-1/D-2/D-3）を必ず反映すること。**

## 未対応の課題（作業開始前に必ず確認）

**[`docs/review-findings-2026-08-07.md`](docs/review-findings-2026-08-07.md) に、独立レビューで判明した
バグ・設計と実装の乖離・未配線箇所が実測根拠つきで一覧化されている。**
「宣言はあるが動いていない」箇所（アダプターレジストリ未使用、`environment.sample()` 未呼び出し、
`obstacles` 未描画、AUV追加が実際には不成立、など）が明記されているので、
新しい機能を足す前にここを読み、同じ穴を増やさないこと。対応したら状態欄を更新する。

**[`docs/3d-quality-plan.md`](docs/3d-quality-plan.md) は3D表現の品質向上計画。**
「動いてはいるが品質が足りない」箇所（頂点予算の83%を平坦な海面が占める、影が3.7m/テクセルで機能していない、等）と、
その再設計案・優先順位・**意図的にやらないこと**を記載。同ドキュメントの§5に、
3D品質と中身（攻防の成立・隻数・LLMエージェント実装）の優先順位判断も書いてある。

## 品質担保

見た目に関わる変更は [`docs/quality-assurance-method.md`](docs/quality-assurance-method.md) の
スクリーンショット駆動PDCAで必ず確認する。静的チェック（構文・JSON・HTTP応答）は
「例外を投げずに動く」ことしか保証しない。過去に船の向きが90°ズレたまま、
航跡が空中に浮いたまま、レーダーが左右反転したまま素通りした実績がある。

## 開発方針

- ビルドツール不要のES Modules。Three.jsは`digital-twin/index.html`のimportmap経由でCDN読み込み
- サーバー不要でGitHub Pagesにそのまま置ける構成を維持する（`digital-twin/`・`swarm-sim/` はそれぞれ独立に動く静的サイト）
- 命名は開発段階（「デモ」等）ではなく機能で付ける
- **舞台となる海域は固定しない。** 特定の海域名（東京湾等）をコード本体・ディレクトリ名に埋め込まない。海域は `core/scenarios/*.json` のシナリオ設定として差し替える対象
- 学習パイプライン本体（データ収集ループ・学習・評価）は対象外。学習データ互換のログ形式（FR8、`core/log/episode_logger.js`）のみ実装する
- APIキーが必要な実LLM呼び出しはブラウザ側に埋め込まない（`core/sim/agents/llm_agent.js` のデフォルトはAPIキー不要のルールベース関数）

## 実行方法

[`README.md`](README.md)の「実行方法」を参照。ローカルは `npx serve .` または `python -m http.server` で静的配信し、`digital-twin/`・`swarm-sim/` をブラウザで開く（`file://`直接オープンは`fetch()`のCORSで動かない）。
