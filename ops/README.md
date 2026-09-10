# ops/ — リポジトリ外にあった運用資産の退避先

GPUクラスタ（gpu-sv-007）が使えなくなるにあたって、**リポジトリの外にあって
消えると復元できないもの**をここへ取り込んだ（2026-09-11）。

| ファイル | 元の場所 | 何か |
|---|---|---|
| `models/Modelfile.*` | ollama の内部ストア | **派生モデルの定義**。`num_ctx` を実測で絞った値が入っている。重みは含まない（再取得する）。§下記 |
| `gpujob` | `~/.local/bin/gpujob` | クラスタ用のジョブキュー（flock ベース・8GPU 2グループ前提）。現行機では使わないが設計の記録として残す |
| `gpu-usage-convention-cluster.md` | **`/tmp/GPU-USAGE-CONVENTION.md`** | 共有機での GPU 割り当ての掲示。/tmp にあったので再起動で消える位置にあった |
| `claude-settings.json` | `~/.claude/settings.json` | Claude Code の設定（theme / model / effortLevel） |

GPU 運用ルールそのものは `.claude/skills/gpu-jobs/SKILL.md`（リポジトリ内のプロジェクトスキル）へ移した。
以前は `~/.claude/skills/` にあり、リポジトリを clone しても付いてこなかった。

## models/ — なぜ Modelfile だけ持ち出すのか

ollama の「モデル」は **重み（GGUF blob）＋ 設定（Modelfile）** の2階建て。
重みは合計 234GB あるが registry から再取得できる。持ち出す価値があるのは設定のほうで、
理由は `PARAMETER num_ctx` にある。

Ollama は `num_ctx` で宣言した長さの KV キャッシュを**先に丸ごと確保する**ので、
既定（128,000）のままだと 7B のモデルでも **85GB** を占有する（実測）。
`qwen2.5vl-7b-ctx3k` の `3072` や `sim-cmd-32b` の `4096` は、
`scripts/suggest_num_ctx.js` で実プロンプトを測って決めた値で、**再測定しないと出てこない**。

さらに実験ログには `sim-cmd-32b` というモデル名しか残らない。
定義を失うと、過去の測定が「どの設定で走ったか不明」になる。

| 派生モデル | ベース | `num_ctx` | 用途 |
|---|---|---:|---|
| `qwen2.5vl-7b-ctx3k` | `qwen2.5vl:7b` | 3,072 | 単艦VLM航行（L1）。`temperature 0.0001` |
| `sim-boat-7b` | `qwen2.5:7b` | 4,096 | 艇エージェント |
| `qwen2.5-7b-ctx8k` | `qwen2.5:7b` | 8,192 | 汎用 |
| `qwen3-vl-8b-ctx8k` | `qwen3-vl:8b` | 8,192 | VLM 比較用 |
| `sim-cmd-32b` | `qwen2.5:32b` | 4,096 | 指揮官 |
| `qwen2.5-32b-ctx8k` | `qwen2.5:32b` | 8,192 | 指揮官（長文脈） |
| `sim-cmd-27b-think` | `qwen3.8:27b` | 8,192 | 指揮官（thinking） |
| `qwen3.8-27b-ctx8k` | `qwen3.8:27b` | 8,192 | 同上（同一定義） |
| `gemma3-27b-ctx4k` | `gemma3:27b` | 4,096 | 比較用 |
| `qwen2.5vl-32b-ctx4k` | `qwen2.5vl:32b` | 4,096 | VLM 比較用（大） |
| `sim-cmd-72b` | `qwen2.5:72b` | 4,096 | 指揮官（大） |

再構築:

```bash
ollama pull qwen2.5vl:7b
ollama create qwen2.5vl-7b-ctx3k -f ops/models/Modelfile.qwen2.5vl-7b-ctx3k
```

**移行先（RTX 3060 12GB）で作る意味があるのは上4つ（7B/8B）だけ。**
27B 以上は 12GB に載らない。下7つは過去の実験条件の記録として残してある。

ベースモデルの digest（クラスタ時点、ollama 0.33.2）:

```
qwen2.5:7b      845dbda0ea48      qwen2.5vl:7b    5ced39dfa4ba
qwen2.5:32b     9f13ba1299af      qwen2.5vl:32b   3edc3a52fe98
qwen2.5:72b     424bad2cc13f      qwen3-vl:8b     901cae732162
qwen3.8:27b     22130167c4c2      gemma3:27b      a418f5838eaf
qwen3:32b       030ee887880f      qwen3.5:9b      6488c96fa5fa
qwen3.5:122b    8b9d11d807c5
```

registry のタグは更新されうるので、再取得した重みの digest がこれと違えば
**別の重みで測っていることになる**。過去の測定と比較するときは確認する。
