# マルチLLM相互作用の創発ログ抽出

元ログ: `submission/measurements/multi-llm/llm-log-final.jsonl` — 指揮官の采配 12 回 / 艇の判断 117 回

「創発」を主観で語らずに済むよう、**system prompt に書いていない振る舞い**だけを4種に絞って数えた。
プロンプト本文は `core/sim/command/commander_prompt.js` と `core/sim/agents/boat_agent.js` を参照。

## E-1 標的の重複解消 — 指揮官は言われずに敵を配分したか

指揮官プロンプトは「1隻に1標的」「重複を避けろ」を**要求していない**。全艇を最寄りの1隻に
殺到させる采配も文法上は妥当に通る。それでも別々の標的へ配ったなら、配分は指示ではなく判断から出ている。

| 指標 | 値 |
|---|---:|
| 標的つき采配の回数 | 11 |
| 全艇に相異なる標的を割り当てた采配 | 11 (100.0%) |

## E-2 艦種の対応づけ — heavy には heavy を当てたか

艇の id には艦種名が入る（`def-heavy` / `int-scout` 等）が、プロンプトは**艦種を対応させろとは書いていない**。
それでも同種同士が噛み合ったなら、id の語からモデルが役割を読み取ったことになる。

| 指標 | 値 |
|---|---:|
| 個別の指示のうち艦種が一致したもの | 31 / 31 (100.0%) |
| 采配まるごと艦種が揃ったもの | 11 / 11 (100.0%) |

## E-3 階層の不一致 — override は「反抗」か「再確認」か

艇が override したとき、指揮官と**違う標的**を選んだのか（反抗）、**同じ標的のまま**自前の
新しい観測で取り直したのか（再確認）を分ける。同じ override でも意味がまるで違う。

- 反抗（指揮官と別の標的）: **37** 件
- 再確認（同じ標的を自前の鮮度で）: **59** 件

### 反抗の実例

**ep1 t=12.0s — def-runner-1**

```
指揮官の命令 : intercept int-runner-1
艇の選択     : intercept int-heavy
艇の言い分   : closest threat
自艇レーダー :
  def-scout (defender) at (406, 8) — 76 m away
  int-runner-1 (intruder) at (471, 122) — 116 m away
  def-runner-2 (defender) at (366, -82) — 155 m away
  int-heavy (intruder) at (512, -6) — 166 m away
  def-heavy (defender) at (182, 2) — 197 m away
  int-scout (intruder) at (593, -7) — 241 m away
  int-runner-2 (intruder) at (466, -149) — 243 m away
```

**ep1 t=15.0s — def-runner-1**

```
指揮官の命令 : intercept int-heavy
艇の選択     : intercept int-runner-1
艇の言い分   : closest intruder within range
自艇レーダー :
  int-runner-1 (intruder) at (448, 108) — 64 m away
  def-runner-2 (defender) at (388, -97) — 172 m away
  int-scout (intruder) at (575, -12) — 202 m away
  def-heavy (defender) at (194, 3) — 211 m away
  int-runner-2 (intruder) at (439, -152) — 231 m away
```

**ep2 t=12.0s — def-scout**

```
指揮官の命令 : intercept int-scout
艇の選択     : intercept int-heavy
艇の言い分   : closest threat
自艇レーダー :
  def-runner-1 (defender) at (366, 82) — 60 m away
  def-runner-2 (defender) at (366, -71) — 102 m away
  int-heavy (intruder) at (513, 8) — 122 m away
  int-runner-1 (intruder) at (468, 163) — 155 m away
  int-runner-2 (intruder) at (482, -107) — 162 m away
  int-scout (intruder) at (595, 12) — 203 m away
  def-heavy (defender) at (183, 3) — 211 m away
```

**ep2 t=12.0s — def-runner-1**

```
指揮官の命令 : intercept int-runner-1
艇の選択     : intercept int-heavy
艇の言い分   : nearest threat
自艇レーダー :
  def-scout (defender) at (392, 28) — 60 m away
  int-runner-1 (intruder) at (468, 163) — 131 m away
  def-runner-2 (defender) at (366, -71) — 153 m away
  int-heavy (intruder) at (513, 8) — 165 m away
  def-heavy (defender) at (183, 3) — 199 m away
  int-runner-2 (intruder) at (482, -107) — 222 m away
  int-scout (intruder) at (595, 12) — 239 m away
```

**ep2 t=15.0s — def-scout**

```
指揮官の命令 : intercept int-heavy
艇の選択     : intercept int-runner-2
艇の言い分   : closest intruder
自艇レーダー :
  def-runner-1 (defender) at (390, 93) — 64 m away
  def-runner-2 (defender) at (392, -67) — 99 m away
  int-runner-2 (intruder) at (466, -85) — 131 m away
  int-runner-1 (intruder) at (444, 176) — 150 m away
  int-scout (intruder) at (579, 21) — 173 m away
  def-heavy (defender) at (195, 4) — 213 m away
```

**ep2 t=15.0s — def-runner-1**

```
指揮官の命令 : intercept int-heavy
艇の選択     : intercept int-runner-1
艇の言い分   : Closest intruder threat
自艇レーダー :
  int-runner-1 (intruder) at (444, 176) — 99 m away
  def-runner-2 (defender) at (392, -67) — 161 m away
  int-runner-2 (intruder) at (466, -85) — 194 m away
  int-scout (intruder) at (579, 21) — 202 m away
  def-heavy (defender) at (195, 4) — 215 m away
```

**ep2 t=18.0s — def-scout**

```
指揮官の命令 : intercept int-heavy
艇の選択     : intercept int-scout
艇の言い分   : closer threat
自艇レーダー :
  def-runner-1 (defender) at (416, 100) — 70 m away
  int-scout (intruder) at (563, 30) — 157 m away
  int-runner-1 (intruder) at (420, 187) — 157 m away
  def-heavy (defender) at (207, 5) — 201 m away
```

**ep2 t=18.0s — def-runner-2**

```
指揮官の命令 : intercept int-runner-2
艇の選択     : intercept int-runner-1
艇の言い分   : closer intruder
自艇レーダー :
  def-runner-1 (defender) at (416, 100) — 163 m away
  int-scout (intruder) at (563, 30) — 181 m away
  def-heavy (defender) at (207, 5) — 212 m away
  int-runner-1 (intruder) at (420, 187) — 250 m away
```

### 再確認の実例（標的は同意、鮮度だけ取り直す）

**ep1 t=3.0s — def-scout** — 命令「intercept int-scout」に対し `int-scout` を選び直し、理由は「 closest intruder」
**ep1 t=3.0s — def-runner-2** — 命令「intercept int-runner-2」に対し `int-runner-2` を選び直し、理由は「closest intruder」
**ep1 t=3.0s — def-runner-1** — 命令「intercept int-runner-1」に対し `int-runner-1` を選び直し、理由は「closer intruder」

## E-4 役割の分化 — 同じプロンプト・同じモデルで、逆らう頻度が割れたか

3体の艇は**同一の system prompt・同一モデル**で動く。違うのは置かれた位置と、そこから見える
レーダーだけ。それでも override 率が割れるなら、役割は設定ではなく入力から生じている。

| 艇 | 艦種 | obey | override | うち反抗 | うち再確認 | override率 |
|---|---|---:|---:|---:|---:|---:|
| def-runner-1 | runner | 0 | 37 | 8 | 24 | 100.0% |
| def-runner-2 | runner | 2 | 32 | 10 | 19 | 94.1% |
| def-scout | scout | 0 | 39 | 19 | 16 | 100.0% |

## 付録 — 指揮官の意図（intent）の推移

采配ごとに指揮官が自分で書いた一行。戦況に応じて言葉が変わるかを見る。

- ep1 t=0.0s — 「Move def-heavy to int-heavy, intercept other intruders.」（3隻へ、標的 3 種）
- ep1 t=10.0s — 「Move def-heavy to asset, intercept other intruders.」（3隻へ、標的 3 種）
- ep2 t=0.0s — 「Intercept all incoming intruders.」（4隻へ、標的 4 種）
- ep2 t=10.0s — 「Intercept all known intruders.」（4隻へ、標的 4 種）
- ep2 t=20.0s — 「Intercept known threats.」（2隻へ、標的 2 種）
- ep2 t=30.0s — 「Intercept known threats.」（2隻へ、標的 2 種）
- ep2 t=40.0s — 「Intercept all known threats.」（2隻へ、標的 2 種）
- ep2 t=50.0s — 「Patrol around asset, intercept runner-1.」（1隻へ、標的 1 種）
- ep3 t=0.0s — 「Intercept all intruders.」（4隻へ、標的 4 種）
- ep3 t=10.0s — 「Intercept all known intruders.」（4隻へ、標的 4 種）
- ep3 t=20.0s — 「Intercept known threats, patrol for others.」（2隻へ、標的 2 種）
