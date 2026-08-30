# マルチLLM相互作用の創発ログ抽出

元ログ: `submission/measurements/qwen2.5-32b/qwen2.5-32b-ep1-calls.jsonl` — 指揮官の采配 2 回 / 艇の判断 17 回

「創発」を主観で語らずに済むよう、**system prompt に書いていない振る舞い**だけを4種に絞って数えた。
プロンプト本文は `core/sim/command/commander_prompt.js` と `core/sim/agents/boat_agent.js` を参照。

## E-1 標的の重複解消 — 指揮官は言われずに敵を配分したか

指揮官プロンプトは「1隻に1標的」「重複を避けろ」を**要求していない**。全艇を最寄りの1隻に
殺到させる采配も文法上は妥当に通る。それでも別々の標的へ配ったなら、配分は指示ではなく判断から出ている。

| 指標 | 値 |
|---|---:|
| 標的つき采配の回数 | 2 |
| 全艇に相異なる標的を割り当てた采配 | 2 (100.0%) |

## E-2 艦種の対応づけ — heavy には heavy を当てたか

艇の id には艦種名が入る（`def-heavy` / `int-scout` 等）が、プロンプトは**艦種を対応させろとは書いていない**。
それでも同種同士が噛み合ったなら、id の語からモデルが役割を読み取ったことになる。

| 指標 | 値 |
|---|---:|
| 個別の指示のうち艦種が一致したもの | 8 / 8 (100.0%) |
| 采配まるごと艦種が揃ったもの | 2 / 2 (100.0%) |

## E-3 階層の不一致 — override は「反抗」か「再確認」か

艇が override したとき、指揮官と**違う標的**を選んだのか（反抗）、**同じ標的のまま**自前の
新しい観測で取り直したのか（再確認）を分ける。同じ override でも意味がまるで違う。

- 反抗（指揮官と別の標的）: **0** 件
- 再確認（同じ標的を自前の鮮度で）: **7** 件

### 再確認の実例（標的は同意、鮮度だけ取り直す）

**ep1 t=3.0s — def-scout** — 命令「intercept int-scout」に対し `int-scout` を選び直し、理由は「Closest to asset protection」
**ep1 t=6.0s — def-scout** — 命令「intercept int-scout」に対し `int-scout` を選び直し、理由は「closest to asset threat priority」
**ep1 t=6.0s — def-runner-2** — 命令「intercept int-runner-2」に対し `int-runner-2` を選び直し、理由は「Closer intercept more efficient」

## E-4 役割の分化 — 同じプロンプト・同じモデルで、逆らう頻度が割れたか

3体の艇は**同一の system prompt・同一モデル**で動く。違うのは置かれた位置と、そこから見える
レーダーだけ。それでも override 率が割れるなら、役割は設定ではなく入力から生じている。

| 艇 | 艦種 | obey | override | うち反抗 | うち再確認 | override率 |
|---|---|---:|---:|---:|---:|---:|
| def-runner-1 | runner | 5 | 1 | 0 | 1 | 16.7% |
| def-runner-2 | runner | 4 | 2 | 0 | 2 | 33.3% |
| def-scout | scout | 1 | 4 | 0 | 4 | 80.0% |

## 付録 — 指揮官の意図（intent）の推移

采配ごとに指揮官が自分で書いた一行。戦況に応じて言葉が変わるかを見る。

- ep1 t=0.0s — 「Engage and neutralize all threats before they reach the asset.」（4隻へ、標的 4 種）
- ep1 t=10.0s — 「Continue intercepting enemy vessels to protect asset.」（4隻へ、標的 4 種）
