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

**単艦VLM自動航行（L1）は [`core/sim/navigator/`](core/sim/navigator/) が実装の正典。**
状況図・プロンプト・パース/サニタイズ・航路プランの4モジュールで、
**ブラウザで見る経路（`digital-twin/?nav=vlm`・[`digital-twin/nav_mode.js`](digital-twin/nav_mode.js)）と
ヘッドレスで測る経路（[`scripts/vlm_navigator_run.js`](scripts/vlm_navigator_run.js)）が同じモジュールを使う。**
どちらか一方に判断ロジックを書き足さないこと（画面の挙動と実験ログの数字が別コードから出た瞬間、
デモで良く見えたものが実験で再現しなくなる）。経緯・実測・残課題は
[`docs/l1-vlm-navigator-implementation-2026-09-05.md`](docs/l1-vlm-navigator-implementation-2026-09-05.md)。
**モデルは非thinkingのVLMを選ぶ**（thinking系は画像判断で本文が空になる。同ドキュメント §3.3）。

**GPUクラスタで動かして手元のブラウザで見る方法は
[`docs/remote-viewer-connectivity.md`](docs/remote-viewer-connectivity.md) が正典。**
3Dの描画は見ている側のブラウザで走るので画面転送は不要で、SSHのローカルポート転送1本で足りる。
[`scripts/serve_vlm.js`](scripts/serve_vlm.js) は**既定で 127.0.0.1 にしか bind しない**
（この中継は事実上「無認証のGPU推論API」であり、共有クラスタで素で公開してはいけない）。
公開したくなったら理由を同ドキュメント §8 と突き合わせること。

**VLM側の全体像・作業TODO・自律反復の手順は
[`docs/vlm-system-and-worklist.md`](docs/vlm-system-and-worklist.md) が入口。**
システム構成の不変条件5つ、シム／ビューアの役割分担、`gpujob` を通したGPU運用、
改修TODO（H0〜H7・M2）とマルチエージェントTODO（MA-1〜5・MT-1〜5）、
そして**1イテレーションの手順と停止条件**をここに固定してある。
作業を始めるとき・再開するときはここを見る。

**知覚〜航路計画のフロー（現状と理想・改修の順序）は
[`docs/perception-to-waypoint-flow.md`](docs/perception-to-waypoint-flow.md) が正典。**
現状は7段のうち「検知」と「対応づけ」の2段が無く、残りを1回の推論に押し込んでいる。
その結果 VLM は危険を言語では正しく報告しながら**その座標をそのまま waypoint にする**
（実測: 採用24点中6点）。改修は「VLMを賢く使う」ではなく**壊れている作業＝座標生成を取り上げる**方向。
着手順は同 §4（**H0 の接触id匿名化が最優先**——`traffic-cross` という名前が答えを漏らしている）。

**GPUメモリと `num_ctx` は [`docs/multi-vlm-gpu-budget.md`](docs/multi-vlm-gpu-budget.md) が正典。**
Ollama は `num_ctx` で宣言した長さのKVキャッシュを**先に丸ごと確保する**ため、
素の `qwen2.5vl:7b`（num_ctx=128,000）は重み約6GBに対して **85.9GB** を占有する（実測）。
**モデルは `scripts/suggest_num_ctx.js` で実測して絞った派生モデルを使う**
（例 `qwen2.5vl-7b-ctx3k` = 3,072）。`num_ctx` をコード側に書かないこと——
値の出所はモデル1つだけにし、コードは `/api/show` から読んで実測 `prompt_tokens` と
突き合わせるだけにする（[`core/sim/agents/context_budget.js`](core/sim/agents/context_budget.js)）。
**小さすぎる `num_ctx` はエラーにならず黙ってプロンプトを切り捨てる**（画像が届かないまま答える）。
このマシンのGPU分割の取り決めは `/tmp/GPU-USAGE-CONVENTION.md`（vlm=GPU0-3:11434 / sim=GPU4-7:11435）。

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

**盤面を広げる実験と3Dの大盤面対応は [`docs/3d-large-field-plan.md`](docs/3d-large-field-plan.md) が計画。**
盤面 f=16（一辺 約8.8km）まで広げる理由は、指揮官が1エピソードで判断できる回数が
f=1 では**3回**しかなく采配が展開しないため（f=16 で201回）。必要VRAMは盤面サイズと無関係
（プロンプトが伸びないため36GBのまま）で、増えるのは実行時間だけ。
3D側は「注目領域のみ高精細」（案A）で対応する——盤面全体の高精細化は面積256倍で原理的に破綻する。
**このリポジトリは2つのチャットが同時に触っているので、担当と共有ファイルの扱いは
[`docs/development-roadmap.md`](docs/development-roadmap.md) §11 を必ず確認すること。**

**[`docs/3d-quality-plan.md`](docs/3d-quality-plan.md) は3D表現の品質向上計画。**
「動いてはいるが品質が足りない」箇所（頂点予算の83%を平坦な海面が占める、影が3.7m/テクセルで機能していない、等）と、
その再設計案・優先順位・**意図的にやらないこと**を記載。同ドキュメントの§5に、
3D品質と中身（攻防の成立・隻数・LLMエージェント実装）の優先順位判断も書いてある。

## GPU 実行のルール

**推論を伴う処理を走らせる前に、必ず `gpu-jobs` スキルを読む**（`~/.claude/skills/gpu-jobs/SKILL.md`）。
このマシンはスケジューラが無く sudo も使えないため、GPU の割り当ては規律でしか守れない。要点:

- GPU は `vlm`（0-3・:11434）と `sim`（4-7・:11435）に静的分割。**跨いで載せない**
- **`num_ctx` は必ず実測で決める**（[`scripts/suggest_num_ctx.js`](scripts/suggest_num_ctx.js)）。
  既定のまま載せると 7B のモデルでも 85GB を占有し、2026-09-05 に実験が CPU へ退避して7時間空回りした
- **VRAM に載らないなら実行しない。** CPU 退避で粘ると、計測がハードウェア速度に支配されて無意味になる
- 単発の疎通確認以外は `gpujob submit` でキューに積む（グループ内で推論を並走させない）

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
