---
name: gpu-jobs
description: GPU推論を伴う処理を実行する前に必ず読む運用ルール。ollama でモデルをロードする、headless_run.js や vlm_navigator_run.js など推論を伴うスクリプトを走らせる、num_ctx やモデルを選ぶ、GPUメモリ不足やCPU退避を調べる、といった場面で適用する。§1 に現行機（単一GPU）の制約、§7 以降にクラスタ時代（8×RTX A5000）の実測を残してある。
---

# GPU ジョブ運用ルール

**このファイルは2つの環境を扱う。**§0〜§6 が現行機のルール、§7 がクラスタ時代（2026-08〜09、
8×RTX A5000・gpu-sv-007）の実測記録。クラスタは使えなくなったが、そこで測った数字
（num_ctx と VRAM の関係、thinking のコスト、並列対応の可否）は**モデル側の性質**なので今も有効。
機材の話とモデルの話を混ぜないために節を分けてある。

## 0. 実行前チェックリスト（推論を1回でも走らせる前に）

1. `nvidia-smi` で空き VRAM を見る。**ディスプレイ出力に同じGPUを使っているなら、
   空きは公称容量より 1〜1.5GB 少ない**（デスクトップ環境が掴んでいる）
2. 使うモデルの `num_ctx` を実測で決める（§2）。既定のまま載せない
3. `ollama ps` の `PROCESSOR` 欄が `100% GPU` であることを確認する。
   そうでなければそのジョブは計測として無効（§3）

## 1. 現行機は単一GPU（RTX 3060 12GB）— 何が載って何が載らないか

クラスタは GPU 8基・合計192GB だった。現行機は**12GB 1基**。桁が違うので、
「クラスタで動いていたから動くはず」という推測をそのまま持ち込まない。

実 VRAM = **重み + `OLLAMA_NUM_PARALLEL` × `num_ctx` 分の KV キャッシュ**。

| モデル | 重み | 12GB に載るか |
|---|---:|---|
| `qwen2.5:7b` / `sim-boat-7b` | 4.7GB | ○ `num_ctx 4096` で実測 6.0GB |
| `qwen2.5vl:7b` / `qwen2.5vl-7b-ctx3k` | 6.0GB | ○ `num_ctx 3072` で約 7.5GB |
| `qwen3-vl:8b` / `qwen3-vl-8b-ctx8k` | 6.1GB | △ `num_ctx 8192` で約 10GB。ディスプレイ併用だと危険 |
| `gemma3:27b` / `qwen3.8:27b` 系 | 17GB | **×** |
| `qwen2.5:32b` / `sim-cmd-32b` / `qwen2.5vl:32b` 系 | 19〜21GB | **×** |
| `qwen2.5:72b` / `sim-cmd-72b` | 47GB | **×** |
| `qwen3.5:122b` | 81GB | **×** |

**指揮官モデル（`sim-cmd-32b` / `sim-cmd-72b` / `sim-cmd-27b-think`）は載らない。**
マルチエージェント実験を続けるには、次のどれかを選ぶ必要がある——
(a) 指揮官も 7B にする（判断品質が変わるので過去の測定とは比較できない）、
(b) 指揮官だけクラウドAPIに出す、(c) 指揮官実験は凍結して単艦VLM航行（L1）に集中する。
**黙って小さいモデルに差し替えて過去の数字と並べない。** どれを選んだかは実験ログに残す。

### `OLLAMA_NUM_PARALLEL` は 1 にする

KV キャッシュは並列数だけ倍化する。クラスタでは 4 にしていたが、12GB では
`num_ctx 4096` の 7B ですら並列4で 10GB 近くになる。**艇が複数いても直列で回す**
（シム結果は宣言値 `latencyS` だけで決まるので、直列化しても結果は変わらない。§4）。

```bash
OLLAMA_HOST=127.0.0.1:11434 OLLAMA_NUM_PARALLEL=1 OLLAMA_KEEP_ALIVE=20m \
OLLAMA_MODELS=$HOME/.ollama/models \
nohup ollama serve > /tmp/ollama.log 2>&1 &
```

### GPU分割（vlm / sim）は現行機では意味がない

クラスタの `vlm`(GPU0-3:11434) / `sim`(GPU4-7:11435) という分割は、
**GPUが8基あって NUMA 境界で切れたから**成立していた。1基しかない今、分割する対象がない。
**ポートは 11434 の1本に統一する。** コード側の `--llm-url` 既定値もそれに合わせる。
`ops/gpujob` はクラスタ用のまま残してあるが、現行機では使わない（`--need-gb` の
事前検査だけは価値があるので、必要なら1グループ設定に縮めて再利用する）。

### レイテンシは測り直し。ただし過去のシム結果は生きている

3060 は A5000 より遅いので、クラスタで測った p95 はそのまま使えない。
一方で **`docs/time-model.md` §9 の設計により、シム結果は宣言値 `latencyS` だけで決まる**——
実測レイテンシは「記録」であって「ルール」ではない。だから
**過去の実験結果は再実行しなくても有効**で、測り直しが要るのは
「この機材で `latencyS` の宣言値が現実的か」を確かめるときだけ。

## 2. `num_ctx` は必ず実測で決める — 最大の事故要因

Ollama は `num_ctx` で宣言した長さの KV キャッシュを**先に丸ごと確保する**。
実際に使う長さとは無関係。最近のモデルは既定が 128K〜256K なので、**既定のまま載せると
7B のモデルでも 85GB を占有する。**

実測（2026-09-05、同一の `qwen2.5:7b`）:

| `num_ctx` | 実 VRAM |
|---:|---:|
| 128,000 | **85 GB** |
| 8,192 | **8.7 GB** |
| 4,096 | 6.0 GB |

12GB 機では、**素の `qwen2.5vl:7b` を `ollama run` しただけで載らない。**
必ず `ops/models/` の派生モデルを作ってから使う（§6）。

### 決め方

```bash
node scripts/suggest_num_ctx.js --model MODEL --url http://127.0.0.1:11434 \
  --prompt-file 実プロンプト.txt --max-tokens N [--create 派生モデル名]
```

`num_predict=1` で1回叩き `prompt_eval_count` を読む（Ollama に `/api/tokenize` は無い。0.33.2 で 404）。
推奨値は `(プロンプト + max_tokens) × 1.5` を 1024 の倍数へ切り上げ。

**小さすぎる `num_ctx` はエラーにならず黙ってプロンプトを切り捨てる**（画像が届かないまま答える）。
`core/sim/agents/context_budget.js` が `/api/show` の宣言値と実測 `prompt_tokens` を
突き合わせて検知する。値をコード側に書かない——出所はモデル1つだけにする。

**VLM は別物として測る。** 画像はテキストよりはるかに高い:

| | トークン |
|---|---:|
| テキストのみ | 30 |
| ＋1280x720 の画像1枚 | 1,228（**画像分 1,198**） |

「プロンプトは数百トークンだから小さくてよい」という text 側の勘を VLM に持ち込まない。
**実際に使う画像・枚数・解像度で測る。**

## 3. CPU 退避で粘らない

VRAM に載らないなら**実行しない**。`ollama ps` の `PROCESSOR` 欄が `100% GPU` でなければ
そのジョブは計測として無意味（レイテンシが CPU 速度に支配される）。

クラスタでは並列8 × 256K で KV 56GB を確保しようとして載らず、
**推論が 86% CPU へ退避して実験が7時間空回りした**（2026-09-05 の事故）。
12GB 機ではこれがもっと起きやすい。**走り出したら `ollama ps` を必ず1回見る。**

## 4. ジョブは2種類ある — shared（並走可）と exclusive（単独）

**シムジョブの結果は GPU 競合の影響を受けない**（`docs/time-model.md` §9: headless は推論を
await し、シム結果は宣言値 `latencyS` だけで決まる。競合で変わるのは実行時間と記録専用の実測値だけ）。
一方**レイテンシ計測ジョブ（`llm_probe` / `suggest_num_ctx`）はレイテンシそのものが成果物**なので
単独で走らせる。

現行機では VRAM が足りないので **shared も実質1本**。区別が効くのは
「計測中に他のシムを走らせない」という規律の側だけ。**計測ジョブを投げるときは他を止める。**

## 5. モデル選定時に確認すること

- **並列対応か**: Ollama 0.33.2 は `qwen3.5` / `qwen3vl` アーキテクチャで
  `"model architecture does not currently support parallel requests"` を出す。
  艇など同時に複数リクエストを投げる用途には使えない（直列化して遅くなる）。
  serve ログで確認する: `grep "does not currently support parallel" /tmp/ollama*.log`
  （現行機は `OLLAMA_NUM_PARALLEL=1` なのでどのみち直列）
- **thinking 系か**: thinking は `max_tokens` を最終回答と食い合う。予算不足だと
  `content:""` が返る（`THINKING_OVERRUN`）。実測では `qwen3.8:27b` の指揮官判断で
  reasoning 3,300〜4,000 文字・**p95 47.7秒**（非 thinking は 0.9 秒。33倍差）。
  **画像判断では thinking 系は本文が空になる**ので、VLM は非thinkingを選ぶ
  （`docs/l1-vlm-navigator-implementation-2026-09-05.md` §3.3）
- **Ollama で thinking を切るにはネイティブ API が要る**: `/v1/chat/completions` は
  `think` も `chat_template_kwargs.enable_thinking` も**無視する**（実測）。
  `/api/chat` に `think:false` を送る経路（`--llm-transport ollama`）を使う
- **サイズは配布サイズで見積もらない**: 重みだけの数字。実 VRAM は `重み + 並列数 × num_ctx 分の KV`

## 6. モデルの再構築（新しい機械に載せるとき）

`ops/models/Modelfile.*` が派生モデルの定義。重みは含まれない（再ダウンロードする）。

```bash
ollama pull qwen2.5vl:7b                                     # ベースを取る
ollama create qwen2.5vl-7b-ctx3k -f ops/models/Modelfile.qwen2.5vl-7b-ctx3k
```

**12GB 機で作る意味があるのは 7B/8B の4つだけ**:
`qwen2.5vl-7b-ctx3k`（VLM航行）、`sim-boat-7b`（艇）、`qwen2.5-7b-ctx8k`、`qwen3-vl-8b-ctx8k`。
32B/72B 系の Modelfile も残してあるが、これは**過去の実験がどの設定で走ったかの記録**であって、
現行機で作るためのものではない。手順は `docs/migration-to-local-gpu.md`。

## 7. 【記録】クラスタ時代の運用（8×RTX A5000 / gpu-sv-007、2026-08〜09）

以下は使えなくなった機材の話。**同種のマルチGPU環境を再び使うときのために残す。**

- GPU は2グループに静的分割していた: `vlm`(0-3・:11434) / `sim`(4-7・:11435)。
  NVLink が無く GPU0-3 と GPU4-7 が別 NUMA（`nvidia-smi topo -m` が `SYS`）だったため、
  この境界で切ると分割コストが最小になる
- **`CUDA_VISIBLE_DEVICES` だけでは分割にならない（2026-09-06 の実測）。**
  Vulkan バックエンドはこの変数を無視して独自に GPU を列挙し、**分割の外側へモデルを載せる**
  （`qwen3.8:27b` が vlm 群の GPU2 に載り、空き不足で 76% CPU 退避した）。
  `OLLAMA_VULKAN=0 GGML_VK_VISIBLE_DEVICES=""` を必ず併記する。
  検証: `grep -oE "(CUDA|Vulkan)[0-9]+ " /tmp/ollama_<group>.log | sort -u` で
  CUDA が4つ・**Vulkan が0** であること
- ジョブ管理は `ops/gpujob`（flock ベース）。`shared` は `flock -s` で最大3本並走、
  `exclusive` は `flock -x` で単独。効果の実測（2026-09-06）: 直列（v1）はシム1本で
  GPU 1基が 13〜71%・他7基が 0%。shared 3本の並走（v2）で sim 群4基すべてが 16〜95% 稼働。
  モデルは ollama が共有するので、3ジョブでも VRAM は使うモデルの合計しか食わない（32b+27b+7b ≒ 55GB）
- スケジューラも sudo も無い共有機だったので、他ユーザーのプロセスを自グループに見つけたら
  **自ジョブを止めて譲る**（`gpujob` の YIELD）。掲示は `ops/gpu-usage-convention-cluster.md`
- 長時間ジョブ: 走行中のスクリプトを編集しない（bash はファイルを逐次読むので実行が壊れる）。
  実測時間の見積りは「1判断の p95 × 1エピソードあたりの判断回数 × エピソード数」
