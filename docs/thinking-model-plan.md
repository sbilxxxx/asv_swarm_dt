# thinking 系モデル対応と大規模モデル実験の計画

> 作成: 2026-08-31
> 前提: [`time-model.md`](time-model.md)（遅延は設定値・実測は記録のみ）、
> [`development-roadmap.md`](development-roadmap.md) §2（計算資源）
> 実測の出所: [`../submission/measurements/multi-llm-32b-2026-08-30.md`](../submission/measurements/multi-llm-32b-2026-08-30.md)

## 0. `qwen3.5` は実在する（初版の記載は誤りだった）

初版で「`qwen3.5` は存在しない」と書いたのは**誤り**である。
存在しないタグ `qwen3.5:32b` で manifest を引いて 404 を得ただけであり、
実際のタグは `27b` / `35b` / `122b` で、`:32b` という刻みが無かったにすぎない。

実在するタグとサイズ（`registry.ollama.ai` の manifest 実測）:

| タグ | 配布サイズ |
|---|---:|
| `qwen3.5:9b`（= `latest`） | 6.6 GB |
| `qwen3.5:27b` | 17.4 GB |
| `qwen3.5:35b` | 23.9 GB |
| **`qwen3.5:122b`** | **81.4 GB** |
| `qwen3.5:397b-cloud` | クラウド専用（ローカル不可） |

`qwen3.5:122b` は総パラメータ 125B の **MoE（Gated Delta Networks ＋ sparse MoE）**で、
モデルページに **thinking** の能力タグが付く。81.4 GB は本機 192 GB に余裕で収まり、
**ローカルで回せる最高性能の候補**である。

## 1. 何が問題か — thinking がシミュレーションと噛み合わない

`qwen3:32b` は8基GPUへ分散ロードできたが、**全判断が不成立**（`no usable decision`）になった。

実測（艇1体・1回の判断、`max_tokens=4000`）:

```
prompt_tokens=187   completion_tokens=3925   finish_reason=stop
reasoning=11,239文字   content={"move_to":[182,48],"reason":"..."}
応答まで 2分超
```

reasoning は**最終回答と同じ `max_tokens` 予算を食い合う**。既定（指揮官300 / 艇200）では
reasoning だけで使い切り `content:""` を返す（`llm_http.js` の `EMPTY_CONTENT`）。
艇3隻・`intervalS=3s` という運用条件に対して、1判断2分は成立しない。

## 2. thinking を切る方法 — 実測した4通り

| # | 方法 | エンドポイント | 結果 |
|---|---|---|---|
| A | `"think": false` | `/v1/chat/completions` | **✗** 無視される（reasoning 82トークン） |
| B | プロンプト末尾に `/no_think` | `/v1/chat/completions` | **✗** 制御語ではなく本文として読まれる |
| C | `"chat_template_kwargs": {"enable_thinking": false}` | `/v1/chat/completions` | **✗** 無視される（reasoning 552文字・`content:""`） |
| D | `"think": false` | **`/api/chat`（Ollamaネイティブ）** | **✓** reasoning 無し・2トークンで即答 |

**結論: Ollama で thinking を切れるのはネイティブ API だけ。** OpenAI 互換経路には手段が無い。

### なぜこれが設計判断になるのか

`core/sim/agents/llm_http.js` の冒頭コメントが宣言しているとおり、この層は
「開発は Ollama、GPU サーバでは vLLM。**どちらも同じエンドポイント形式**なので、
ベースURLの差し替えだけで移行できる」ことを前提に書かれている。
D を採ると、この前提（1つの経路で両バックエンドを賄う）が崩れる。

なお **vLLM は方式 C（`chat_template_kwargs`）を OpenAI 互換で受ける**ため、
「バックエンドごとに thinking の切り方が違う」状態は、どちらにせよ避けられない。
つまり**差異を隠す層を1枚入れるのが正しい**という結論になる。

## 3. 実装計画 — `thinking` を明示的な設定項目にする

### 方針

`llm_http.js` に「thinking をどう扱うか」の**宣言**を足し、バックエンド差はこの層で吸収する。
呼び出し側（`llm_commander.js` / `boat_agent.js`）とシムのルールは一切変えない。

### Step 1: `postChatCompletion` に `thinking` オプションを足す

```js
/**
 * @param {'auto'|'off'} [thinking='auto']
 *   'auto' — 何もしない（従来どおり）。非 thinking モデルはこれでよい
 *   'off'  — バックエンドごとの手段で reasoning を止める
 * @param {'openai'|'ollama'} [transport='openai']
 *   'openai' — /chat/completions（vLLM・Ollama 共通。thinking:'off' は chat_template_kwargs で送る）
 *   'ollama' — /api/chat（Ollama 専用。thinking:'off' は think:false で送る）
 */
```

- `transport:'openai'` かつ `thinking:'off'` → body に `chat_template_kwargs:{enable_thinking:false}` を足す
  （vLLM で効く。Ollama では効かないことが実測済みなので、**Ollama では 'ollama' を選ぶこと**を
  JSDoc に明記する）
- `transport:'ollama'` → URL を `{baseUrl}/api/chat` にし、body を
  `{model, messages, stream:false, think:false, options:{temperature, num_predict}}` に組み替え、
  応答 `message.content` を OpenAI 形と同じ `{text, outputTokens, finishReason}` へ正規化する

**触ってはいけないもの**: 有界時間の担保（AbortSignal ＋ 締切レースの二重構造）と
`LlmHttpError` の kind 体系。ここは経路が増えても同一に保つ。

### Step 2: 失敗モードを1つ足す

`EMPTY_CONTENT` は現在「thinking が予算を使い切った」ケースも飲み込んでいる。
`reasoning` が非空なのに `content` が空なら **`THINKING_OVERRUN`** として分けると、
実験ログから「モデル選定の問題」と「プロンプトの問題」を判別できる（本モジュールの契約2）。

### Step 3: CLI へ露出

`scripts/headless_run.js` に以下を足す:

| フラグ | 既定 | 用途 |
|---|---|---|
| `--thinking auto\|off` | `auto` | thinking の扱い |
| `--llm-transport openai\|ollama` | `openai` | 経路の選択 |
| `--timeout-ms N` | 30000 | **現在ハードコードで調整不可**。大規模モデルでは必須 |

`--timeout-ms` は thinking と独立に今すぐ要る。32b で指揮官 `meanLatency=5.4s`、
70B級では十数秒が見込まれ、4並列で詰まると既定30秒を超えうる。

### Step 4: テスト

`tests/` に `llm_http` の経路テストを足す（`fetchImpl` を差し替えれば HTTP 不要）:

- `transport:'ollama'` で URL が `/api/chat` になり、body に `think:false` が入る
- `transport:'openai'` ＋ `thinking:'off'` で `chat_template_kwargs` が入る
- Ollama 応答形（`message.content`）が OpenAI 形と同じ戻り値に正規化される
- `reasoning` 非空 ＋ `content` 空 → `THINKING_OVERRUN`

## 3.5 thinking を「切る」のではなく「使う」設計

§2・§3 は thinking を止める話だが、本来やりたいのは**深い推論を意思決定に効かせること**である。
ここが本計画の中心になる。

### 前提の確認 — thinking はシミュレーションを壊さない

**シム時間と実時間は独立している**（[`time-model.md`](time-model.md) §2.5）。
1回の推論に実時間で2分かかっても、シムの中で経過するのは宣言値 `latencyS` の分だけであり、
実験条件は変わらない。変わるのは**ランの実行にかかる実時間だけ**である。

つまり thinking の 2分は「不具合」ではなく「実行コスト」にすぎない。
問題は2つだけで、どちらも設定で扱える:

1. `max_tokens` が reasoning に食われる → 予算を上げる（`THINKING_OVERRUN` で検出）
2. 実時間コストが呼び出し回数ぶん積み上がる → **どこに thinking を置くかを選ぶ**

### 設計1 — 非対称な認知（thinking は指揮官だけに置く）

20エピソードランの呼び出し内訳は **指揮官84回 / 艇483回**（艇が85%）。
一方で、判断の性質は非対称である。

| | 指揮官 | 艇 |
|---|---|---|
| 判断周期 | 10 シム秒 | 3 シム秒 |
| 入力 | 陣営全体の統合図（数秒古い） | 自艇レーダー（今） |
| 判断の中身 | **4隻を4標的へ割り当てる＝組合せ最適化** | 自艇の針路を局所修正＝反射的 |
| 呼び出し回数 | 少 | 多 |

**深い推論が効くのは指揮官側であり、そこは呼び出し回数が最も少ない。**
指揮官だけを thinking にすれば、コスト増は全呼び出しの15%に留めつつ、
最も推論を要する判断に深さを与えられる。艇は非 thinking のまま反射的でよい
（むしろ「現場は速く反応する」という役割分担がプロンプト設計と一致する）。

### 設計2 — thinking の遅さを実験変数として測る（本題）

本プロジェクトの中心の問い（[`../submission/slides/outline.md`](../submission/slides/outline.md) スライド6）は
**「指揮が遅い陣営は負けるのか」**である。thinking する指揮官は**賢いが遅い**。
これは回避すべき副作用ではなく、**時間モデルがまさに測るために作られた treatment** である。

| アーム | 指揮官 | 宣言 `latencyS` | 何が分かるか |
|---|---|---|---|
| **A** | 非 thinking | 3 s | 現行ベースライン |
| **B** | thinking | 3 s | **推論の質だけ**を取り出す（遅延コストを免除した反実仮想） |
| **C** | thinking | 実測 t_wall に基づく大きい値 | 推論の質**と**その時間コストを両方負う現実条件 |

- **B > A かつ C < A** なら「熟慮は判断を改善するが、その遅さの代償を払えていない」。
  時間が制約となる指揮において AI に何を任せるべきかという、主題そのものへの答えになる。
- **この反実仮想アーム B が作れるのは、`latencyS` が実測ではなく設定値だからである。**
  時間モデルをこう設計したことの見返りがここで出る。実測を遅延に使う設計だったら、
  「賢さ」と「遅さ」を分離できない。

宣言値の決め方: 実測 t_wall は**記録側にしか書かない**という不変条件（§7）は保つ。
C の `latencyS` は実測を*根拠として人間が選ぶ*設定値であり、自動で書き戻すのではない。

### 設計3 — `reasoning_effort` を実験軸にする

`qwen3.8` は **thinking 既定ON・`reasoning_effort` で深さ調整可・`preserve_thinking` で
過去の推論を保持可**と明記されている（モデルページ）。`reasoning_effort` は
「深く考えるほど良い判断になるのか」を直接掃引できる軸になる。

設計2と組み合わせると2次元の実験になる:

```
        reasoning_effort:  low    medium   high
宣言 latencyS = 3s (反実)   B-low  B-med   B-high
宣言 latencyS = 実測相当     C-low  C-med   C-high
```

### 検証したい具体的な仮説 — 「死んだ waypoint」は熟慮で直るか

L0 実験で**再現する具体的な欠陥**が記録されている
（[`development-roadmap.md`](development-roadmap.md) §1）:
**`move_to` の 80.9% が直前と同一座標の再送＝更新されない死んだ waypoint。**
プロンプトに説明を足す A/B では**悪化した**。

これは「状況を読み直して座標を更新する」ことの失敗であり、まさに熟慮が効きうる箇所である。
`analyze_run.js` は既に `STALE_WAYPOINT_M` でこれを測っているので、**新しい指標を作らずに検証できる**。

- 仮説: thinking 指揮官では死んだ waypoint 率が下がる
- 反証可能: 下がらなければ「この欠陥は推論の深さの問題ではない」と分かり、それも成果である

### 設計上の注意 — `preserve_thinking` は無料ではない

`preserve_thinking`（過去メッセージの推論文脈を保持）は魅力的だが、
**現行の契約を1つ壊す**。いま `decide(picture)` は
「t_issue 時点のスナップショットだけを見て決める」ステートレスな関数であり、
観測は発行時に凍結される（[`time-model.md`](time-model.md) I3）。
推論文脈を持ち越すと**エージェントが記憶を持つ**ことになり、これは新機能であって副作用ではない。

入れるなら、エピソードを跨いだ汚染（`DecisionScheduler` の generation で防いでいるもの）を
どう扱うかを含めて別途設計する。**Phase C の初回では使わない。**

## 4. モデル候補（実在タグとサイズを確認済み）

GPU: RTX A5000 × 8基 = 192GB。4bit 量子化の配布サイズ。

| モデル | 配布サイズ | thinking | 位置づけ |
|---|---:|---|---|
| `qwen2.5:32b` | 19 GB | 無 | **現行の基準**。20ep 実測済み・170ep 実行中 |
| **`qwen3.8:27b`** | **17.7 GB** | **有（既定ON・`reasoning_effort` 可変・`preserve_thinking`）** | **本命**。深さを掃引できる唯一の候補。256K コンテキスト。**マルチモーダル（画像・動画）なので L1 の VLM もこれ1つで賄える** |
| `qwen3.5:27b` | 17.4 GB | 有 | qwen3.8 との世代比較 |
| `qwen3.5:35b` | 23.9 GB | 有 | 同上・一回り大きい |
| **`qwen3.5:122b`** | **81.4 GB** | 有 | **ローカル最高性能**。総125B の MoE（Gated Delta Networks） |
| `qwen3:30b-a3b` | 18.6 GB | 有 | MoE（30B総/3B活性）。活性が小さく速い |
| `qwq:32b` | 19.9 GB | 有 | 推論特化32B |
| `magistral:24b` | 14.3 GB | 有 | 軽量 thinking |
| `llama3.3:70b` | 42.5 GB | 無 | **非thinkingで規模だけ上げる**対照。実装変更なしで即実験可 |
| `qwen2.5:72b` | 47.4 GB | 無 | 同上。Qwen 系列内で 32b→72b の規模比較 |
| `qwen3:235b-a22b` | 142.2 GB | 有 | 192GB に収まる最大（ただし §4.2 の理由で優先度は低い） |

### 4.1 軽量候補（掃引の条件数を稼ぐ用）

`reasoning_effort` や `latencyS` の掃引は条件数が多いので、軽いモデルで先に形を出す価値がある。

| モデル | 配布サイズ | thinking |
|---|---:|---|
| `granite4:latest` | 2.1 GB | — |
| `qwen3.5:4b` | 3.4 GB | 有 |
| `qwen3:8b` | 5.2 GB | 有 |
| `qwen3.5:9b`（= `qwen3.5:latest`） | 6.6 GB | 有 |
| `qwen3:14b` | 9.3 GB | 有 |
| `gemma4:latest` | 9.6 GB | — |

### 4.2 使えないもの — `kimi-k3` はクラウド専用

`kimi-k3` は実在するが、**ローカルに落とせるタグが無い**（`kimi-k3:cloud` のみ。
`latest` / サイズ付きタグはいずれも 404）。総 2.81T・896エキスパート中16活性の MoE で
1M コンテキストという規模であり、本機 192GB には元より載らない。

さらに `CLAUDE.md` の方針（APIキーが要る実 LLM 呼び出しをリポジトリに埋め込まない）と、
クラウド経由では**推論レイテンシが外部要因に左右され実測の意味が薄れる**ことから、
**本計画では対象外**とする。`qwen3:235b-a22b`（142GB・ローカル可）を優先度低で残すのは、
「ローカルで完結する」という制約を保ったまま最大規模を試す選択肢としてである。

## 5. 実験の順序

**原則**: 実装変更が要らないものを先に回し、GPU を遊ばせない。

### Phase A — 実装変更なし（今すぐ回せる）

1. **`qwen2.5:32b` を 170エピソードへ拡大**。20ep では所見が結論に届かない
   （`emergence/README.md` 所見2・4）。統制群 scripted 170ep は取得済み（勝率 74.7%）。
2. **`qwen2.5:72b` / `llama3.3:70b` で規模比較**。非 thinking なので現行コードで動く。
   32b との差が「規模」なのか「thinking」なのかを、thinking 実装前に切り分けられる。

### Phase B — `--timeout-ms` だけ先に実装

70B級は 4並列で既定30秒を超えうる。Phase A-2 の前に入れておくのが安全。

### Phase C — thinking 対応（§3）を実装し、`qwen3.8:27b` で本命実験

3. **`qwen3.8:27b`** に `--thinking off` / `--reasoning-effort low|medium|high` を通す。
   同一モデル・同一プロンプトで深さだけを変えられるので、
   「深く考えるほど良い判断になるのか」を交絡なしに測れる。
4. **§3.5 設計2 の3アーム**（A: 非thinking / B: thinking＋latencyS=3s / C: thinking＋実測相当）。
   ここが本計画の中心。**指揮官のみ thinking、艇は非 thinking**（設計1）。
5. **死んだ waypoint 仮説**の検証（§3.5）。`analyze_run.js` の既存指標で測る。
6. 余力があれば **`qwen3.5:122b`** でローカル最高性能を確認。

### Phase D — L1（VLM）への合流

`qwen3.8:27b` はマルチモーダル（画像・動画）なので、**Phase C で通した経路がそのまま L1 で使える**。
[`development-roadmap.md`](development-roadmap.md) §6 は VLM を別フェーズとして描いているが、
モデルを1つに揃えられるなら `[render] → [infer]` のステージ宣言を足すだけで届く可能性がある。
Phase C 完了時点で roadmap を見直す。

## 5.5 TODO — qwen3.8 の推論時間を実測し、必要な実装を確定する

**なぜ計測が先か**: §3.5 設計2 のアーム C（thinking＋実測相当の `latencyS`）は、
宣言値を決めるための実測が無いと組めない。`latencyS` は設定値だが、
**根拠のない設定値では実験にならない**。

### 実行条件（重要）

**他の推論ランと同時に走らせてはいけない。** 現在 `qwen2.5:32b` の 170エピソードランが
GPU8基すべてを占有している（各基 約11GB・稼働率 11〜15%）。空き VRAM は足りるが、
**計算資源を奪い合うとレイテンシ実測が汚染される**——計測そのものが成果物なので本末転倒になる。
170ep ランの完了を待ってから実行する。

### 計測手順（`llm_probe.js` は拡張済み）

```bash
# 1) thinking 既定ON のまま（qwen3.8 の素の挙動）
node scripts/llm_probe.js --model qwen3.8:27b --api ollama --profile commander \
  --warm 12 --max-tokens 4000 --json logs/probe-qwen38-commander-default.json

# 2) thinking を切る（設計1: 艇側に使う想定の下限）
node scripts/llm_probe.js --model qwen3.8:27b --api ollama --profile boat \
  --think off --warm 12 --max-tokens 300 --json logs/probe-qwen38-boat-nothink.json

# 3) 深さの掃引（設計3 の軸。指揮官プロファイル）
for e in low medium high; do
  node scripts/llm_probe.js --model qwen3.8:27b --api ollama --profile commander \
    --think on --reasoning-effort $e --warm 12 --max-tokens 4000 \
    --json logs/probe-qwen38-commander-$e.json
done
```

### 実測結果（2026-08-31 実施済み・`logs/probe-qwen38-*.json`）

`qwen3.8:27b` / Ollama ネイティブ / warm n=10 / max_tokens=4000。

| 条件 | p50 | p95 | reasoning 文字 | THINKING_OVERRUN |
|---|---:|---:|---:|---:|
| 艇プロンプト・**thinking off** | **0.9 s** | 1.9 s | 0 | 0 |
| 指揮官・thinking 既定(on) | 30.1 s | 44.4 s | 3,334 | 0 |
| 指揮官・effort=low | 28.5 s | 46.6 s | 3,049 | 0 |
| 指揮官・effort=medium | 29.5 s | 44.9 s | 3,281 | 0 |
| 指揮官・effort=high | 31.9 s | **47.7 s** | 3,987 | 0 |

**判明したこと3点:**

1. **`think:false` は完全に効き、かつ速い。** thinking on との差は **33倍**（0.9 s 対 30 s）。
   §3.5 設計1（艇は非 thinking で反射的に、指揮官だけ熟慮）はこの差の上に成り立つ。
2. **`reasoning_effort` は実験軸として弱い。** low→high でレイテンシ +12%、reasoning +30% しか
   動かない。「深く考えるほど良い判断になるか」を掃引する軸として当てにできる幅ではないので、
   **§3.5 設計3 の2次元掃引は縮小し、thinking の on/off を主軸に据える。**
3. **`max_tokens=4000` で overrun ゼロ。** 予算はこの値で足りる（§1 の qwen3:32b は
   reasoning 3,925 トークンを要したので、4,000 はその実測とも整合する）。

### 実測から決めること

| 実測値 | 何を決めるか |
|---|---|
| warm p95 レイテンシ（effort 別） | アーム C の宣言 `latencyS`。**p95 を使う**（平均だと「たまに遅い」を飲み込めない） |
| `THINKING_OVERRUN` の有無 | `--max-tokens` の下限。1件でも出るなら判断が成立しない |
| reasoning 文字数の分布 | effort が実際に効いているかの確認。効いていなければ軸として使えない |
| cold vs warm の差 | ラン開始時のウォームアップ要否 |
| concurrency スイープ | 指揮官のみ thinking にしたときの実効スループット |

### 実測後に確定する実装（§3 の詳細を埋める）

1. `llm_http.js` に `transport:'ollama'` 経路（`/api/chat` ＋ `think`）
2. `LLM_HTTP_FAILURES.THINKING_OVERRUN` の追加
3. `--timeout-ms`（**実測 p95 から必要値が決まる**。現在30秒ハードコード）
4. `--thinking` / `--reasoning-effort` を `headless_run.js` へ露出
5. 指揮官と艇で別々に thinking を設定できるようにする（設計1: 指揮官のみ thinking）
   — 現在 `--model` 等は両者で共通なので、**艇側だけ別設定にする分岐が要る**

## 5.6 TODO — 盤面スケールアップの2段階パラメータ探索

### なぜ2段階か

scripted 腕は実測 20,000〜30,000 steps/s、LLM 腕は 11 steps/s——**約2,600倍の差**がある。
全条件を LLM で回すのは無駄なので、**盤面として成立しない条件を LLM に食わせない**。

- **Stage 1**（[`../scripts/sweep_scenarios.js`](../scripts/sweep_scenarios.js)・**GPU不要**）:
  scripted 同士で格子を掃引し、勝率が 25〜75% に収まる条件だけを残す。
  36条件 × 40エピソード = 1,440エピソードが **123秒**で終わる。
- **Stage 2**（GPU必要）: 生き残った条件にだけ LLM 腕を回す。

### 掃引の根拠（2026-08-31 の実測）

[`../submission/measurements/emergence/mechanism-verification.md`](../submission/measurements/emergence/mechanism-verification.md)
で判明した創発の律速は2つ:

1. **部分観測が成立していない** — 索敵艇のレーダー 1,200 m に対し戦場が約 550 m しかなく、
   指揮官の統合図は85回の采配すべてで敵を1隻も取りこぼしていなかった（100%）。
2. **指揮官が参加できていない** — 防御成功エピソードは16〜21秒で、指揮官の判断は**2回**だけ。
   創発には反復（適応→観測→再適応）が要るが、2回ではループが1周もしない。

### Stage 1 の実測結果（fieldScale の効き）

| fieldScale | 平均エピソード長 | 指揮官の判断回数 | scripted 勝率 |
|---:|---:|---:|---:|
| 1（現行・約550m） | 34.3 s | **3回** | 75.0% |
| 2 | 96.5 s | **9回** | 57.5% |
| 4 | 251.7 s | **25回** | 45.0% |

**戦場を広げると指揮官の判断機会が3回→25回へ増え、同時に勝率も拮抗へ寄る。**
`--command-interval 5` と組み合わせると 52回まで伸びる。

### この探索で見つけた既存バグ2件（修正済み）

1. **`maxSteps` が制限時間の上書きを見ていなかった** — `EPISODE_TIME_LIMIT_S`（240s）から
   ハードリミットを計算していたため、戦場を広げて制限時間を伸ばした盤面が判定前に落ちていた。
   → `episodeTimeLimitOf(world)` を見るよう修正。
2. **`--boats` の合成で艦種が陣営間でねじれていた** — `faction = n % 2` がベース艇の陣営と
   切り離されており、防御側に低速の重装艇（4 m/s）が、侵入側に高速の快速艇（9 m/s・
   爆破半径50mで旗を壊せる）が偏って増えていた。`--boats 16` の防御側勝率が 0〜17% に
   張り付いていた真因。→ 同じ陣営の艇から複製するよう修正し、**7.5% → 40%** に均衡。

### 隻数は「自由な軸」ではない（掃引で判明した非対称性）

合成の偏りを直した後でも、隻数を増やすと防御側の勝率が単調に下がる:

| 隻数 | 勝率 平均 | 範囲 | n |
|---:|---:|---|---:|
| 8 | **46.1%** | 20.0〜75.0% | 18 |
| 12 | 22.4% | 5.0〜45.0% | 18 |
| 16 | **10.1%** | 0.0〜40.0% | 18 |

これはバグではなく盤面本来の非対称性である。**侵入側は武装艦を1隻通せば勝ち、
防御側は武装艦を全隻止めねばならない。** 両陣営を相似に増やしても、要求される仕事量は
防御側だけが線形に増える。

したがって隻数を増やす実験では、**別の軸で補償しないと「LLM が弱い」ではなく
「盤面が防御不能」を測ってしまう**。補償の候補: 防御側の隻数を多めにする／
迎撃圏 `INTERCEPT_RANGE_M` を広げる／侵入側の武装艦比率を下げる。
補償なしで隻数だけ上げた条件は Stage 2 へ送らないこと。

### 追加した設定軸（既定値では挙動不変を確認済み）

| 軸 | 場所 | 既定 |
|---|---|---|
| `sensors.radarScale` | シナリオ | 1（艦種間の比を保ったまま探知距離を倍率で掃引） |
| `episodeTimeLimitS` | シナリオ | 未指定なら `EPISODE_TIME_LIMIT_S`(240) |

### 統制群との比較（170エピソード・両腕とも取得済み）

分離に必要な規模（roadmap §1「1アーム約170エピソード」）で揃えた。

| アーム | defended | breached | 勝率 |
|---|---:|---:|---:|
| scripted × scripted | 127 | 43 | **74.7%** |
| LLM指揮官＋LLM艇（qwen2.5:32b）× scripted | 110 | 60 | **64.7%** |

20エピソードでの比較（80.0% 対 65.0%）では15ポイント差だったが、170エピソードでは
**10ポイント差**に縮んだ。20エピソードの差は揺らぎを多く含んでいたことになる。
`totalWallTime` は LLM 腕で 7,966 秒（2.2 時間）、scripted 腕は 2.0 秒。

### Stage 2 の実行条件（GPU が空いたら）

**軽量モデルを使う。** Stage 2 は条件数 × エピソード数 × 艇数で呼び出しが増えるので、
艇には `qwen3.5:9b`（6.6 GB）等を、指揮官にだけ大きい/thinking モデルを割り当てる
（§3.5 設計1 の非対称な認知と同じ構図）。**これには §3 実装5「指揮官と艇で別々に
モデル・設定を持てるようにする分岐」が前提**であり、thinking 対応と同じ変更で解禁される。

実行順:
1. 170ep ラン完了 → qwen3.8 レイテンシ計測（§5.5、キュー済み）
2. 指揮官/艇の設定分離を実装
3. Stage 1 の生存条件から代表を数点選び、軽量モデルで Stage 2
4. 有望条件だけ大きいモデル・thinking で本番

## 6. 測る指標（既存ツールで足りる）

- 勝敗と `outcome`（`headless_run.js` の集計）
- `parseFailures` / `empty_content` / `THINKING_OVERRUN` / `timeout`（失敗モード別）
- `meanLatency` / `meanOutputTokens`（記録側。**ルールの `latencyS` には混ぜない**）
- 創発4指標（[`scripts/extract_emergence.js`](../scripts/extract_emergence.js)）:
  標的の重複解消・艦種の対応づけ・反抗/再確認・役割の分化

## 7. 意図的にやらないこと

- **`latencyS` を実測へ寄せること**。遅延は設定値であり続ける（`time-model.md` §2.5）。
  モデルを替えても実験条件は変わらず、変わるのは実行にかかる実時間だけ、という性質を壊さない。
- **thinking の中身（reasoning 本文）を判断に使うこと**。記録はするが、
  パースして意思決定に混ぜると出力スキーマの契約が崩れる。
- vLLM への移行そのもの。Ollama で足りているうちは動かさない。
