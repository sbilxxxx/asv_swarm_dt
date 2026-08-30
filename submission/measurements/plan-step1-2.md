# 実施計画書 — 工程1（開発）・工程2（試験） 2026-08-30

> 作成: Fable（計画） / 実行: Opus（本書に従う）
> リポジトリ: /home/ben_ben/automata2/asv_swarm_dt（master・作業ツリーに headless_run.js の未コミット編集あり）
> タイムボックス: 合計25分。超過しそうなら §6 の縮退順に従う。

## 0. 目的と完了条件

ハッカソン提出物の土台として、**新盤面（flag_defence_squadrons）が headless で決着し、勝敗分布が数字で出る**状態にする。

- 工程1完了 = `node tests/core_smoke.test.js` と `node tests/command.test.js` が緑、新ルールの単体テスト1本追加
- 工程2完了 = 20エピソードの勝敗分布が記録ファイルに残る

## 1. 前提知識（実行前に必ず読む）

- [docs/game-design.md](../docs/game-design.md) §2 — 爆破半径の3つの意味（対艦・対旗・巻き添え）。**ルールの正典はここ**
- [docs/implementation-plan.md](../docs/implementation-plan.md) §2 — フェーズAタスク表（本書は A-1/A-8/A-9 のみ扱う）
- core/sim/ship_classes.js — runner(9m/s, 爆破50m) / scout(6m/s, 爆破0m=非武装) / heavy(4m/s, 爆破100m, decisiveOnAsset)
- core/sim/mission.js — 相討ち（どちらかの爆破半径内で双方消滅）・巻き添え（爆心=中点から旗が半径内なら旗破壊）・ブリーチ（現状は heavy 限定・80m固定）

## 2. 済んでいること（再実行不要・ただし検証はする）

scripts/headless_run.js に以下を適用済み（未検証）:

1. `--scenario NAME|path`（名前は core/scenarios/<NAME>.json に解決。未知名はシナリオ一覧つきエラー）
2. `world.spawn(...)` に `shipClass: s.shipClass` を配線（従来は捨てられ全艇 runner になっていた）
3. `World` へ `radarPerShipClass: scenario.sensors?.perShipClass === true` を配線

**注意**: `synthesizeSpawns()`（scripts/headless_run.js:207）は合成spawnに shipClass を付けない。
`--boats` 未指定（シナリオ既定の隻数）なら合成は走らないので工程2はそのまま成立する。
合成時は state.add の既定で runner に落ちる——これは仕様として許容し、直さない（時間外）。

## 3. 工程1a — 既存テストの追随修正（A-8前半、目安10分）

### 診断済みの事実（信じてよい）

両テストの赤はどちらも**新ミッション（相討ち）が旧テストの前提を壊したもの**。旧ルールでは
迎撃で侵入艇だけが消えたが、今は防御艇も消える。テスト用spawnは shipClass 未指定
→ 既定 runner（爆破50m）なので、艇同士が50m以内に近づいた時点で双方消える。

- tests/command.test.js:85 「i2 is tracked while inside a radar」: i2 を x=100（d1 から100m）へ
  置いて step するが、それ以前の step で艇が移動し d1 が相討ちで消えている可能性が高い。
  死んだ艇はレーダーを出さない → i2 が誰にも見えない。
- tests/core_smoke.test.js:138 「defender-1 should have moved away from spawn」:
  defender-1 が相討ちで消えて（alive=0）動かなくなった可能性が高い。

※ 上記は仮説を含む。**修正前に、失敗テストへ一時的に alive 配列と距離を print して裏取りする**
（5分以内。裏取りできたら print は消す）。

### 修正方針（テストの意図を保つ最小手）

- **追跡・トラック・リセット・スモークの検証が目的のテスト**: spawn に `shipClass: 'scout'`
  （爆破0m・非武装）を明示し、相討ちを構造的に無効化する。速力が 6m/s に変わるので、
  「動いたか」を距離しきい値で見る箇所はしきい値が妥当か確認する。
- **迎撃・ミッション判定が目的のテスト**（旧 INTERCEPT_RANGE_M 前提の箇所）: 新ルールへ書き換える。
  「侵入艇だけ消える」の検証は「双方消える（mutual_destruction イベント）」の検証に置換。
- テストの検証意図そのものを削らない。通すためだけの assert 削除は禁止。

## 4. 工程1b — A-1: 旗の破壊を「全武装艦の爆破半径」へ（目安5分）

コミットメッセージ自身が「heavy-only breach (to be revised)」と書いており、
implementation-plan §2 A-1 が正典への追随を求めている。**工程2の計測前に入れる**
（計測後にルールを変えると計測が無駄になるため、この順序は変えない）。

- mission.js のブリーチ判定を「decisiveOnAsset の艇が 80m 以内」から
  **「blastRadiusM > 0 の侵入艇が、旗を自分の爆破半径内に収めたら破壊」**へ変更
  （game-design.md §2「対旗」の定義どおり。runner は 50m、heavy は 100m、scout は不可）。
- `ASSET_BREACH_RANGE_M` は commander_prompt.js が読むため **export は残す**（判定には使わない旨のコメントを更新）。
- `decisiveOnAsset` フラグは ship_classes.js に残してよい（削除はスコープ外）。
- game-design.md §2 の記述と食い違う実装を見つけたら、**正典（game-design.md）に合わせる**。

## 5. 工程1c — 新ルールの単体テスト1本（目安5分）

tests/command.test.js か新ファイルに、物理を回さず状態を直接置いて `evaluateMission()` を呼ぶテストを1本:

1. 相討ち: runner(def) と heavy(int) を 80m に置く → 双方 alive=0、`mutual_destruction` イベント
2. 巻き添え: 相討ちの中点から旗が 100m 以内 → outcome 'breached'、`asset_destroyed_by_blast`
3. ブリーチ（A-1後）: runner(int) が旗から 45m → breached / scout(int) が旗の真上 → 何も起きない
4. 非武装同士: scout(def) と scout(int) を 10m に置く → 何も起きない

## 6. 工程2 — 試験（目安5分＋バッファ）

```bash
node scripts/headless_run.js --scenario flag_defence_squadrons --episodes 20 --quiet \
  --out /tmp/claude-1001/-home-ben-ben-automata2-asv-swarm-dt/7257aa5c-c773-4af6-a886-509255e3544a/scratchpad/run-squadrons-20ep.json
node scripts/headless_run.js --episodes 5 --quiet   # 回帰: 既定シナリオが従来どおり完走すること
```

- 勝敗分布（defended / breached / timeout の件数）、平均エピソード秒、steps/s を
  scratchpad の `results-step2.md` に表で記録する。
- **片方が100%でも調整はしない**（記録だけ。調整ノブはユーザー判断事項）。
- scripted 指揮官（scripted_commanders.js）が新シナリオで null や例外を出す場合のみ、
  最小修正で「動く」状態にする（語彙拡張 A-5/A-7 はやらない）。

### 縮退順（時間切れのとき、後ろから捨てる）

1. 新ルール単体テスト（§5）→ 2. A-1（§4）→ 3. command.test の一部（スキップ理由を明記）
※ 工程2の20エピソード計測だけは**絶対に捨てない**（提出物の数字がこれ）。

## 7. やらないこと

- LLM/VLM 関連の実行（Ollama を叩かない）
- 識別台帳（A-2/A-3）・指揮官語彙（A-5/A-7）・事前航路（A-4）・swarm-sim ブラウザ側の修正
- mission.js の A-1 以外のルール変更、シナリオJSONのバランス調整
- コミット（変更は作業ツリーに残す。コミットはユーザー確認後に親セッションで行う）

## 8. 報告フォーマット

最終報告に必ず含める: (1) テスト2本＋新テストの緑/赤、(2) 20エピソードの勝敗分布表、
(3) 回帰ラン（既定シナリオ）の結果、(4) 変更ファイル一覧と各変更の1行説明、
(5) 縮退した項目があればその理由。
