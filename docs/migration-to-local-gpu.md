# GPUクラスタからローカルGPUデスクトップへの移行

作成: 2026-09-11 / 移行元: `gpu-sv-007`（8×RTX A5000・192GB）/ 移行先: RTX 3060 12GB のデスクトップ
経路: クラスタ → **Mac** → デスクトップ

クラスタが使えなくなる。**復元できないものを先に外へ出し、再取得できるものは持ち出さない**
という方針で分けた。

## 1. 何をどう運ぶか

| 対象 | 量 | 運び方 | 状態 |
|---|---:|---|---|
| コード・ドキュメント | 数MB | **GitHub**（`chore/migrate-off-gpu-cluster` ブランチ） | 済 |
| GPU運用ルール（旧 `~/.claude/skills/`） | 8KB | 同上（`.claude/skills/gpu-jobs/`） | 済 |
| 派生モデル定義（`num_ctx`） | 12KB | 同上（`ops/models/`） | 済 |
| `gpujob` / GPU掲示（旧 `/tmp`） | 20KB | 同上（`ops/`） | 済 |
| 測定データ（tracked 分） | 70MB | 同上（git 履歴） | 済 |
| **測定データ（untracked 758MB）** | 157MB | **アーカイブ → Mac → デスクトップ** | 要転送 |
| **`logs/`（gitignore 対象）** | 75MB | 同上 | 要転送 |
| gpujob 実行記録 | 48KB | 同上 | 要転送 |
| LLM の重み 234GB | — | **運ばない**（registry から再取得） | — |

### 運ばないもの・消えるもの

- **`~/.local/ollama/models`（234GB）** — `ollama pull` で再取得できる。回線を数時間占有して運ぶ価値はない
- **`/tmp/GPU-USAGE-CONVENTION.md`** — `ops/` に退避済み。クラスタ固有なので移行先では使わない
- `.devtools/node_modules` — 再インストールできる
- `~/.claude.json`（セッション履歴 49KB）— 必要なら個別に退避する。作業の再現には不要

## 2. アーカイブ（クラスタ側・作成済み）

`~/migration/` に作ってある。作り直すには `~/migration/make_archives.sh`。

```
asv-measurements-20260911.tar.zst   157 MB   （展開後 985MB / submission/measurements 全体）
asv-logs-20260911.tar.zst            75 MB   （展開後  91MB / logs）
gpujob-records-20260911.tar.zst      48 KB   （~/.local/share/gpujobs）
SHA256SUMS
```

`submission/measurements` は**tracked 分も含めて丸ごと**入れてある。
git 側と重複するが、展開すれば内容が一致するので害はなく、
「アーカイブだけで測定データが揃う」ほうが復元時に迷わない。

## 3. 転送手順

### 3.1 クラスタ → Mac（**クラスタが止まる前に必ず完了させる**）

Mac から引く。`rsync` は中断しても `--partial` で再開できる。

```bash
# Mac 側
mkdir -p ~/asv-migration
rsync -avP ben_ben@10.10.0.107:'~/migration/*' ~/asv-migration/
```

**転送直後に必ず検証する**（untracked の 758MB は他にコピーが無い）:

```bash
# Mac 側（macOS は sha256sum ではなく shasum）
cd ~/asv-migration && shasum -a 256 -c SHA256SUMS
```

3行とも `OK` が出るまでクラスタ側を消さない。

### 3.2 Mac → デスクトップ

```bash
rsync -avP ~/asv-migration/ <user>@<desktop>:~/asv-migration/
# または USB。その場合もコピー後に shasum -c SHA256SUMS を回す
```

## 4. 移行先での復元

```bash
# 1) コード
git clone https://github.com/sbilxxxx/asv_swarm_dt.git
cd asv_swarm_dt
git checkout chore/migrate-off-gpu-cluster     # master へ取り込み済みならそちら

# 2) データ（アーカイブはリポジトリルート基準のパスで作ってある）
tar --use-compress-program=unzstd -xf ~/asv-migration/asv-measurements-20260911.tar.zst
tar --use-compress-program=unzstd -xf ~/asv-migration/asv-logs-20260911.tar.zst

# 3) gpujob 実行記録（参照用。現行機では gpujob 自体は使わない）
tar --use-compress-program=unzstd -xf ~/asv-migration/gpujob-records-20260911.tar.zst -C ~/.local/share

# 4) モデル（12GB に載る4つだけ）
ollama pull qwen2.5vl:7b && ollama create qwen2.5vl-7b-ctx3k -f ops/models/Modelfile.qwen2.5vl-7b-ctx3k
ollama pull qwen2.5:7b   && ollama create sim-boat-7b        -f ops/models/Modelfile.sim-boat-7b
ollama pull qwen2.5:7b   && ollama create qwen2.5-7b-ctx8k   -f ops/models/Modelfile.qwen2.5-7b-ctx8k
ollama pull qwen3-vl:8b  && ollama create qwen3-vl-8b-ctx8k  -f ops/models/Modelfile.qwen3-vl-8b-ctx8k

# 5) 検証
node --test tests/*.test.js          # 3ファイルとも green になること
git status --porcelain               # untracked の測定データだけが出る状態（tracked に差分なし）
```

`git status` で **tracked ファイルに差分が出たら展開が壊れている**（アーカイブと git の内容が
一致しているはずなので）。untracked として `submission/measurements/bigfield/` などが出るのは正常。

## 5. 移行で変わること（実験計画への影響）

VRAM が 192GB → 12GB になる。**同じ実験がそのまま続けられるわけではない。**

- **指揮官モデル（32B/72B/27B-think）が載らない。** マルチエージェント実験は
  (a) 指揮官も 7B にする / (b) 指揮官だけクラウドAPI / (c) 凍結して単艦VLM航行（L1）に集中、
  のどれかを選ぶ。**黙って小さいモデルへ差し替えて過去の数字と並べない**
- **`OLLAMA_NUM_PARALLEL` は 1。** KV は並列数だけ倍化するので 12GB では 4 は無理。
  艇が複数でも直列で回す（シム結果は宣言値 `latencyS` だけで決まるので結果は変わらない）
- **ポートは 11434 の1本。** `vlm`(11434) / `sim`(11435) の分割は GPU が8基あって
  NUMA 境界で切れたから成立していたもので、1基では意味がない
- **過去のシム結果は再実行不要。** `docs/time-model.md` §9 のとおり実測レイテンシは「記録」であって
  「ルール」ではない。測り直しが要るのは「この機材で `latencyS` の宣言値が現実的か」を見るときだけ
- **3060 は A5000 より遅い。** クラスタで測った p95（thinking 指揮官 47.7秒 など）は
  そのまま移行先の数字として引用しない

詳細は `.claude/skills/gpu-jobs/SKILL.md` §1。

## 6. 残っている判断

- **untracked の測定データ 758MB を git 管理下に入れるか。** 現状は「アーカイブでのみ保全」。
  public リポジトリが約1GBになるのを避けたが、**複製が1本しかない**状態でもある。
  Mac とデスクトップの両方にアーカイブが残れば3重になるので、それで足りるかを決める
- **`chore/migrate-off-gpu-cluster` を master へマージするか**（PR にするか直接 fast-forward か）
