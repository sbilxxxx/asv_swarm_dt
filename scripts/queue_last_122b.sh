#!/usr/bin/env bash
# queue_last_122b.sh — 最後のキュー。全ジョブ完了後、時間が余っていれば
# ローカル最大級の qwen3.5:122b（81.4GB・総125B の MoE）で指揮官を回す。
#
# 【位置づけ】「余力があれば」の実験なので、途中で打ち切られても他の結果に影響しない
# 最後尾に置く。先行する queue_all.sh / queue_scale72.sh の完全終了を待ってから動く。
#
# 【なぜ先に計測するか】
# 122B の1判断が何秒かかるかは未知で、エピソード数を先に決め打ちすると
# 「何時間かかるか分からないジョブ」になる。llm_probe で p95 を測ってから
# 実行規模を決める（この順序は docs/thinking-model-plan.md §5.5 と同じ考え方。
# 測ってから宣言値と規模を人が決める）。
# なお probe 自体が有用な成果物なので、後続のアームが打ち切られても計測は残る。
#
# 使い方: nohup bash scripts/queue_last_122b.sh > logs/queue-last-122b.log 2>&1 &
set -u
cd "$(dirname "$0")/.."
export PATH="$HOME/.local/ollama/bin:$PATH"

OLLAMA=http://127.0.0.1:11434
M_CMD=qwen3.5:122b
M_BOAT=qwen3.5:9b
OUT=submission/measurements/scaleup
EM=submission/measurements/emergence

# 1アームに割ける実時間の上限（秒）。これを超える見積りなら episodes を削る。
# 余力ジョブなので、無制限に居座らせない。
ARM_BUDGET_S=7200   # 2時間/アーム

mkdir -p "$OUT" "$EM" logs
log(){ echo "[$(date '+%m-%d %H:%M:%S')] $*"; }

log "=== queue_last_122b 開始（最後尾ジョブ）==="

# --- 1) 先行キューの完全終了を待つ ---
for s in "bash scripts/queue_all.sh" "bash scripts/queue_scale72.sh"; do
  if pgrep -f "$s" >/dev/null; then
    log "待機: $s"
    waited=0
    while pgrep -f "$s" >/dev/null; do
      sleep 60; waited=$((waited+60))
      [ $((waited % 1800)) -eq 0 ] && log "  ...$((waited/60)) 分経過"
    done
  fi
done
while pgrep -f "node scripts/headless_run.js" >/dev/null || pgrep -f "node scripts/llm_probe.js" >/dev/null; do
  sleep 30
done
log "全先行ジョブの完了と GPU 解放を確認"

# --- 2) モデル確認 ---
if ! ollama list 2>/dev/null | awk '{print $1}' | grep -qx "$M_CMD"; then
  log "pull $M_CMD（81GB）"
  ollama pull "$M_CMD" >/dev/null 2>&1 || { log "!! pull 失敗 → 中止"; exit 1; }
fi
for m in $(ollama ps 2>/dev/null | awk 'NR>1{print $1}'); do ollama stop "$m" >/dev/null 2>&1; done
sleep 10

# --- 3) まず計測（この結果自体が成果物）---
log "STEP1: レイテンシ計測（thinking off / on）"
for mode in off on; do
  node scripts/llm_probe.js --model "$M_CMD" --api ollama --url "$OLLAMA" \
    --profile commander --concurrency "" --warm 6 --think "$mode" --max-tokens 4000 \
    --json "logs/probe-122b-$mode.json" > "logs/probe-122b-$mode.log" 2>&1 \
    && log "  think=$mode: $(grep -E 'latencyS の目安' "logs/probe-122b-$mode.log" | tail -1)" \
    || log "  !! probe 失敗: think=$mode"
done

# 実測 p95(ms) を読む。取れなければ保守的に 120s とみなす
p95_of(){ node -e '
try{const d=require(process.argv[1]);const v=d?.warm?.latencyMs?.p95;process.stdout.write(String(Number.isFinite(v)?Math.round(v):120000));}
catch(e){process.stdout.write("120000");}' "$PWD/logs/probe-122b-$1.json" 2>/dev/null || echo 120000; }

# --- 4) 実測から規模を決めてアームを回す ---
SCEN=core/scenarios/flag_defence_squadrons.json   # 既定盤面。32b/72b と同条件で比べる
run_arm(){  # $1=label $2=thinking
  local label="$1" mode="$2"
  local p95; p95=$(p95_of "$mode")
  # 1エピソードあたりの指揮官判断は既定盤面で約3回、艇は軽量なので無視できる
  local per_ep_s=$(( (p95/1000) * 3 + 20 ))
  local eps=$(( ARM_BUDGET_S / (per_ep_s > 0 ? per_ep_s : 1) ))
  [ "$eps" -gt 20 ] && eps=20
  [ "$eps" -lt 4 ]  && eps=4
  log "STEP2: $label — p95 $((p95/1000))s → 1エピソード約 ${per_ep_s}s と見積り、episodes=$eps"
  node scripts/headless_run.js --scenario "$SCEN" --blue llm --boat-mode llm \
    --model "$M_CMD" --boat-model "$M_BOAT" \
    --llm-transport ollama --llm-url "$OLLAMA" \
    --thinking "$mode" --boat-thinking off \
    --max-tokens 4000 --boat-max-tokens 300 --timeout-ms 600000 \
    --episodes "$eps" --quiet \
    --out "$OUT/$label.jsonl" --decision-log "$OUT/$label-decisions.jsonl" \
    --llm-log "$OUT/$label-calls.jsonl" > "$OUT/console-$label.txt" 2>&1 \
    && log "  -> $(grep -E '^outcomes:' "$OUT/console-$label.txt" || echo '集計行なし')" \
    || log "  !! 失敗: $label"
  node scripts/extract_emergence.js "$OUT/$label-calls.jsonl" \
    --out "$EM/emergence-$label.md" --samples 8 >/dev/null 2>&1 && log "  emergence 生成"
}

run_arm cmd122b-nothink off
run_arm cmd122b-think   on

log "=== queue_last_122b 完了 ==="
log "比較: 指揮官 32b(20ep) 勝率 65.0% / 72b は $OUT/console-scale-cmd72b-20ep.txt"
