# マルチLLM相互作用の創発ログ抽出

元ログ: `submission/measurements/qwen2.5-32b/qwen2.5-32b-20ep-calls.jsonl` — 指揮官の采配 85 回 / 艇の判断 483 回

「創発」を主観で語らずに済むよう、**system prompt に書いていない振る舞い**だけを4種に絞って数えた。
プロンプト本文は `core/sim/command/commander_prompt.js` と `core/sim/agents/boat_agent.js` を参照。

## E-1 標的の重複解消 — 指揮官は言われずに敵を配分したか

指揮官プロンプトは「1隻に1標的」「重複を避けろ」を**要求していない**。全艇を最寄りの1隻に
殺到させる采配も文法上は妥当に通る。それでも別々の標的へ配ったなら、配分は指示ではなく判断から出ている。

| 指標 | 値 |
|---|---:|
| 標的つき采配の回数 | 84 |
| 全艇に相異なる標的を割り当てた采配 | 84 (100.0%) |

## E-2 艦種の対応づけ — heavy には heavy を当てたか

艇の id には艦種名が入る（`def-heavy` / `int-scout` 等）が、プロンプトは**艦種を対応させろとは書いていない**。
それでも同種同士が噛み合ったなら、id の語からモデルが役割を読み取ったことになる。

| 指標 | 値 |
|---|---:|
| 個別の指示のうち艦種が一致したもの | 204 / 243 (84.0%) |
| 采配まるごと艦種が揃ったもの | 45 / 84 (53.6%) |

## E-3 階層の不一致 — override は「反抗」か「再確認」か

艇が override したとき、指揮官と**違う標的**を選んだのか（反抗）、**同じ標的のまま**自前の
新しい観測で取り直したのか（再確認）を分ける。同じ override でも意味がまるで違う。

- 反抗（指揮官と別の標的）: **26** 件
- 再確認（同じ標的を自前の鮮度で）: **267** 件

### 反抗の実例

**ep3 t=24.0s — def-runner-2**

```
指揮官の命令 : intercept int-scout
艇の選択     : intercept int-runner-2
艇の言い分   : closer threat immediately
自艇レーダー :
  int-runner-2 (intruder) at (380, -231) — 57 m away
  int-scout (intruder) at (542, -66) — 178 m away
  def-heavy (defender) at (231, 2) — 251 m away
```

**ep3 t=33.0s — def-runner-2**

```
指揮官の命令 : intercept int-scout
艇の選択     : intercept int-runner-2
艇の言い分   : Closer threat to asset.
自艇レーダー :
  int-runner-2 (intruder) at (304, -256) — 85 m away
  int-scout (intruder) at (496, -95) — 187 m away
  def-heavy (defender) at (267, 1) — 276 m away
```

**ep3 t=54.0s — def-runner-2**

```
指揮官の命令 : intercept int-scout
艇の選択     : intercept int-runner-2
艇の言い分   : closer威胁更近
自艇レーダー :
  int-runner-2 (intruder) at (139, -185) — 77 m away
  int-scout (intruder) at (389, -160) — 193 m away
  def-heavy (defender) at (351, -4) — 262 m away
```

**ep3 t=63.0s — def-runner-2**

```
指揮官の命令 : intercept int-scout
艇の選択     : intercept int-runner-2
艇の言い分   : Closer threat to asset.
自艇レーダー :
  int-runner-2 (intruder) at (82, -127) — 83 m away
  int-scout (intruder) at (337, -172) — 179 m away
  def-heavy (defender) at (387, -7) — 274 m away
```

**ep5 t=24.0s — def-runner-1**

```
指揮官の命令 : intercept int-scout
艇の選択     : intercept int-runner-1
艇の言い分   : closer threat
自艇レーダー :
  int-runner-1 (intruder) at (390, 244) — 70 m away
  int-scout (intruder) at (549, 72) — 175 m away
  def-heavy (defender) at (231, 7) — 246 m away
```

**ep5 t=33.0s — def-runner-1**

```
指揮官の命令 : intercept int-scout
艇の選択     : intercept int-runner-1
艇の言い分   : closer威胁更近
自艇レーダー :
  int-runner-1 (intruder) at (314, 270) — 88 m away
  int-scout (intruder) at (509, 108) — 177 m away
  def-heavy (defender) at (267, 8) — 274 m away
```

**ep5 t=54.0s — def-runner-1**

```
指揮官の命令 : intercept int-scout
艇の選択     : intercept int-runner-1
艇の言い分   : Closer threat requires immediate action
自艇レーダー :
  int-runner-1 (intruder) at (151, 181) — 78 m away
  int-scout (intruder) at (405, 178) — 190 m away
  def-heavy (defender) at (351, 12) — 245 m away
```

**ep5 t=63.0s — def-runner-1**

```
指揮官の命令 : intercept int-scout
艇の選択     : intercept int-runner-1
艇の言い分   : closer threat
自艇レーダー :
  int-runner-1 (intruder) at (92, 125) — 86 m away
  int-scout (intruder) at (360, 208) — 195 m away
  def-heavy (defender) at (387, 14) — 255 m away
```

### 再確認の実例（標的は同意、鮮度だけ取り直す）

**ep1 t=3.0s — def-scout** — 命令「intercept int-scout」に対し `int-scout` を選び直し、理由は「closest intruder to asset」
**ep1 t=6.0s — def-scout** — 命令「intercept int-scout」に対し `int-scout` を選び直し、理由は「Closer intercept needed」
**ep1 t=6.0s — def-runner-2** — 命令「intercept int-runner-2」に対し `int-runner-2` を選び直し、理由は「closest to intruder」

## E-4 役割の分化 — 同じプロンプト・同じモデルで、逆らう頻度が割れたか

3体の艇は**同一の system prompt・同一モデル**で動く。違うのは置かれた位置と、そこから見える
レーダーだけ。それでも override 率が割れるなら、役割は設定ではなく入力から生じている。

| 艇 | 艦種 | obey | override | うち反抗 | うち再確認 | override率 |
|---|---|---:|---:|---:|---:|---:|
| def-runner-1 | runner | 80 | 110 | 11 | 93 | 57.9% |
| def-runner-2 | runner | 67 | 125 | 14 | 107 | 65.1% |
| def-scout | scout | 19 | 82 | 1 | 67 | 81.2% |

## 付録 — 指揮官の意図（intent）の推移

采配ごとに指揮官が自分で書いた一行。戦況に応じて言葉が変わるかを見る。

- ep1 t=0.0s — 「Intercept all intruders before they reach the asset.」（4隻へ、標的 4 種）
- ep1 t=10.0s — 「Continue intercepting respective targets」（4隻へ、標的 4 種）
- ep2 t=0.0s — 「Intercept all intruders before they reach the asset.」（4隻へ、標的 4 種）
- ep2 t=10.0s — 「Engage and neutralize all intruders before they reach asset.」（4隻へ、標的 4 種）
- ep2 t=20.0s — 「Intercept high threat targets to protect asset.」（2隻へ、標的 2 種）
- ep3 t=0.0s — 「Engage all threats to protect asset.」（4隻へ、標的 4 種）
- ep3 t=10.0s — 「Intercept and neutralize all intruders before they reach asset.」（4隻へ、標的 4 種）
- ep3 t=20.0s — 「Intercept high threat targets to protect asset.」（2隻へ、標的 2 種）
- ep3 t=30.0s — 「Prioritize intercepting int-scout and int-heavy」（2隻へ、標的 2 種）
- ep3 t=40.0s — 「Intercept high priority targets first」（2隻へ、標的 2 種）
- ep3 t=50.0s — 「Prioritize neutralizing int-scout and int-heavy」（2隻へ、標的 2 種）
- ep3 t=60.0s — 「Intercept high-priority intruders to protect asset.」（2隻へ、標的 2 種）
- ep3 t=70.0s — 「Intercept new threats to protect asset」（2隻へ、標的 2 種）
- ep4 t=0.0s — 「Intercept all intruders before they reach the asset.」（4隻へ、標的 4 種）
- ep4 t=10.0s — 「Continue intercepting respective targets to neutralize」（4隻へ、標的 4 種）
- ep5 t=0.0s — 「Engage and neutralize all intruders before they reach the asset.」（4隻へ、標的 4 種）
