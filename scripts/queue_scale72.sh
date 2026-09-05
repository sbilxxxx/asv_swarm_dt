#!/usr/bin/env bash
# queue_scale72.sh — 規模比較（Phase A-2）の追加1本。指揮官を qwen2.5:72b にする。
#
# 【なぜ別スクリプトか】
# queue_all.sh は実行中で、bash はスクリプトを逐次読むため走行中の編集は実行を壊す。
# そこで独立したスクリプトにし、**queue_all.sh の完全終了を待ってから**開始する。
# 「GPU が空いたら」で待つと queue_all.sh の次ジョブと同時に起動する競合があり、
# 推論ジョブの直列という前提（レイテンシ実測の汚染防止）が崩れるため、プロセス完了で待つ。
#
# 【比較の条件】指揮官のモデルだけを動かし、他は既存 32b ランと完全に揃える:
#   シナリオ flag_defence_squadrons（既定盤面 f=1）/ 20エピソード
#   --command-interval 10 / --command-latency 3（既定）/ temperature 0.7（既定）
#   艇は qwen3.5:9b に固定（指揮官の規模だけを見るため）
#   すべて非 thinking なので実装変更は要らない
#
# 使い方: nohup bash scripts/queue_scale72.sh > logs/queue-scale72.log 2>&1 &
set -u
cd "$(dirname "$0")/.."
export PATH="$HOME/.local/ollama/bin:$PATH"

OLLAMA=http://127.0.0.1:11434
M_CMD=qwen2.5:72b
M_BOAT=qwen3.5:9b
OUT=submission/measurements/scaleup
EM=submission/measurements/emergence
LABEL=scale-cmd72b-20ep

mkdir -p "$OUT" "$EM" logs
log(){ echo "[$(date '+%m-%d %H:%M:%S')] $*"; }

log "=== queue_scale72 開始 ==="

# 1) queue_all.sh の完全終了を待つ（同時実行を作らない）
if pgrep -f "bash scripts/queue_all.sh" >/dev/null; then
  log "queue_all.sh の完了を待つ"
  waited=0
  while pgrep -f "bash scripts/queue_all.sh" >/dev/null; do
    sleep 60; waited=$((waited+60))
    [ $((waited % 1800)) -eq 0 ] && log "  ...待機 $((waited/60)) 分"
  done
fi
# 念のため推論プロセスの残りも待つ
while pgrep -f "node scripts/headless_run.js" >/dev/null || pgrep -f "node scripts/llm_probe.js" >/dev/null; do
  sleep 30
done
log "GPU 解放を確認"

# 2) モデル確認（ダウンロードは別途先行実施済みのはず）
if ! ollama list 2>/dev/null | awk '{print $1}' | grep -qx "$M_CMD"; then
  log "pull $M_CMD"
  ollama pull "$M_CMD" >/dev/null 2>&1 || { log "!! pull 失敗: $M_CMD"; exit 1; }
fi
for m in $(ollama ps 2>/dev/null | awk 'NR>1{print $1}'); do ollama stop "$m" >/dev/null 2>&1; done
sleep 5

# 3) 実行
log "指揮官=$M_CMD 艇=$M_BOAT で 20 エピソード"
node scripts/headless_run.js --scenario flag_defence_squadrons --blue llm --boat-mode llm \
  --model "$M_CMD" --boat-model "$M_BOAT" --llm-url "$OLLAMA/v1" \
  --episodes 20 --timeout-ms 180000 --quiet \
  --out "$OUT/$LABEL.jsonl" \
  --decision-log "$OUT/$LABEL-decisions.jsonl" \
  --llm-log "$OUT/$LABEL-calls.jsonl" \
  > "$OUT/console-$LABEL.txt" 2>&1 \
  && log "  -> $(grep -E '^outcomes:' "$OUT/console-$LABEL.txt" || echo '集計行なし')" \
  || { log "  !! 失敗（$OUT/console-$LABEL.txt を見ること）"; exit 1; }

# 4) 解析
node scripts/extract_emergence.js "$OUT/$LABEL-calls.jsonl" \
  --out "$EM/emergence-$LABEL.md" --samples 8 >/dev/null 2>&1 && log "emergence 生成"
node scripts/analyze_run.js --run "$LABEL=$OUT/$LABEL" --title "規模比較 指揮官 qwen2.5:72b" \
  --out "$OUT/report-$LABEL.html" >/dev/null 2>&1 && log "report 生成"

log "=== queue_scale72 完了 ==="
log "比較対象: 指揮官 32b の 20ep は $OUT/../qwen2.5-32b/console-20ep.txt（勝率 65.0%）"
