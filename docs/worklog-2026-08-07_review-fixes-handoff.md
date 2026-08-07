# 作業引き継ぎ記録 — レビュー指摘対応＋3D品質向上（2026-08-07）

- 作業場所: **git worktree `../asv_swarm_dt-review-fixes`、ブランチ `fix/review-findings`**（HEAD `a625584`、origin に push 済み、**master 未マージ**）。本体 checkout `asv_swarm_dt` は別セッションが並行作業していたため隔離した。
- 進め方: マルチエージェント（実装→仕様レビュー→品質レビューの二段レビュー、指摘は修正して再レビュー）。
- 参照: [`review-findings-2026-08-07.md`](review-findings-2026-08-07.md)（状態欄は対応済分を更新済み）／[`3d-quality-plan.md`](3d-quality-plan.md)
- 回帰テスト: `node tests/core_smoke.test.js`（10チェック、全通過）
- headless実行: `node scripts/headless_run.js --episodes 5 [--boats 30] [--out log.jsonl]`

## 完了済み（コミット済み、二段レビュー通過）

| コミット | 内容 | 対応した指摘 |
|---|---|---|
| `a7826ba` | mission→EnvApi配線（reward/done/outcome/events）、reset()でエピソード反復、撃破艇の行動無効化、ログをper-agentフラットJSONL化、dt設定可能化(既定0.1s) | A-6, A-8, B-6 |
| `0f56c0f` | done後のstep()を冪等化（episode_end行の無限追記を防止） | B-6再発防止 |
| `21b78e0`〜`b7cc661` | swarm-sim攻防ゲーム化: 固定タイムステップ、防護対象、防御側リード追尾、HUD/勝敗バナー/自動リセット、JSONLダウンロード | A-5(2D側), E-4, E-7 |
| `ca76117`〜`c75fe39` | headlessランナー同梱 `scripts/headless_run.js`、README実測値（3隻≈38k steps/s、30隻≈2k steps/s）、縮退構成のエラー化 | E-5, §C |
| `8e83c53`〜`f2366e4` | **3D品質計画①〜⑤すべて**: 環境マップ(PMREM)、影の実用化(400m/2048px・ヒーロー艇追従)、船体多断面化(437→4,083頂点/隻・喫水線塗り分け)、海面LOD(近傍600m/128×128・遠方9,000m/24×24)、船首波・デッキ部品 | 3d-quality-plan §3 全行 |
| `a625584` | 上記③④間の回帰修正: 波高増(④)が喫水線塗り分け(③)を水没させ不可視化していた問題を、境界マージンをWAVE_AMPLITUDE_SUMに比例させて解消。ピクセルサンプリングで実効確認 | 3d-quality-plan §3 item3再検証 |
| `060c886`〜`24bc0dd` | coord.js脱シングルトン化(origin per-scene化)＋回帰テスト追加、アダプターレジストリ配線、spawnsAreaLatLon整合、obstacles未実装スキーマ削除、landmarksのシナリオ駆動化 | A-7/E-6, A-9, B-1/E-8, B-4, B-8 |
| `e1224c9` | coord.jsのcreateProjectionをcreateOriginProjectionへ改名（map_view.jsの同名関数との衝突解消） | レビューMinor |

- 3D実装は品質レビューでImportant指摘2件（非ブロッキング・follow-up扱いで記録のみ）: ①波比率マージンの近似的性質をコード内コメントにも明記すべき ②WAVE_TERMS変更時の可視性回帰を検知する自動チェックが無い。次回WAVE_TERMSを触る際に対応。

## 未完了・注意事項

1. **レビュー指摘の残り**: E-3残り（GNSS表示の北基準CW 0-360°正規化）、B-3/E-9（environment.sample()の運動学への配線）、B-5（AUVドキュメント正直化）、QA手順への「船のクローズアップ確認」追記、digital-twin側の固定dt統一（A-5の残り）、B-2（アダプターstream消費者、意図的に未着手のまま）。
2. **マージ・公開**: `fix/review-findings` は master 未マージ。マージ時は master 側の並行コミットとの衝突に注意（特に scene_builder.js は両側で触られている可能性が高い）。マージ後に GitHub へ push（E-1/B-9: 審査員が見るのは公開デモのみ）。
3. **教訓（マルチエージェント運用、[[subagent-verify-commits]]参照）**: サブエージェントの「完了」通知が作業途中で発火し、その時点の報告に実在しないコミットSHAが含まれていたことがあった（当該エージェントはその後完走し、最終的には実在するコミットで完了）。完了報告のコミット主張は `git log`/`git show --stat` の実出力貼付を必須とし、オーケストレーター側でも実在検証すること。

## 再開手順

```
cd C:\Users\2240604\work\others\dev\asv_swarm_dt-review-fixes
git status                          # 未コミット差分がないか確認
node tests/core_smoke.test.js       # 回帰確認（10チェック）
node scripts/headless_run.js --episodes 3   # 動作確認
```
