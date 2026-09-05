#!/usr/bin/env bash
# queue_all.sh — 計画（docs/thinking-model-plan.md）の残り実験を順に全部回す。
#
# 【原則1】推論ジョブは絶対に同時実行しない。
#   レイテンシ実測そのものが成果物であり、GPU を奪い合うと計測が汚染される。
#   各ジョブの前に他の推論プロセスが居ないことを待つ。
# 【原則2】宣言値 latencyS は実測から人が決めた設定値であって、自動で書き戻さない。
#   下の LAT_THINK / LAT_NOTHINK は 2026-08-31 の実測 p95 を根拠に**このファイルへ手で書いた**値。
#   実測が変われば人がここを直す（docs/time-model.md §2.5 I1 の不変条件）。
#
# 使い方:  nohup bash scripts/queue_all.sh > logs/queue-all.log 2>&1 &
# 進捗:    tail -f logs/queue-all.log
# 中断:    pkill -f queue_all.sh ; pkill -f headless_run.js
set -u
cd "$(dirname "$0")/.."
export PATH="$HOME/.local/ollama/bin:$PATH"

OLLAMA=http://127.0.0.1:11434
M_BOAT=qwen3.5:9b      # 艇=呼び出しが多い → 軽量（§3.5 設計1 非対称な認知）
M_CMD=qwen2.5:32b      # 非thinking の基準（170ep 実測済み）
M_THINK=qwen3.8:27b    # thinking 実験用
OUT=submission/measurements/scaleup
EM=submission/measurements/emergence

# --- 宣言 latencyS（シム秒）。2026-08-31 の llm_probe 実測 p95 を根拠に選んだ設定値 ---
#   thinking off : p95 1.9s  → 2s
#   thinking on  : p95 47.7s → 48s
# 既存ベースラインが「実測 mean 3.8s に対し declared 3s」という置き方だったので、
# p95 をそのまま宣言値に採る方針で桁を揃えている。
LAT_NOTHINK=2
LAT_THINK=48

mkdir -p "$OUT" "$EM" logs
log(){ echo "[$(date '+%m-%d %H:%M:%S')] $*"; }

wait_for_gpu() {
  local waited=0
  # 自分自身の pgrep が引っかからないよう -x 相当に絞る
  while pgrep -f "node scripts/headless_run.js" >/dev/null || pgrep -f "node scripts/llm_probe.js" >/dev/null; do
    sleep 30; waited=$((waited+30))
    [ $((waited % 600)) -eq 0 ] && log "  ...GPU 待ち ${waited}s"
  done
}
have_model(){ ollama list 2>/dev/null | awk '{print $1}' | grep -qx "$1"; }
ensure_model(){
  have_model "$1" && return 0
  log "pull $1"
  ollama pull "$1" >/dev/null 2>&1 && return 0
  log "  !! pull 失敗: $1 → 関連ジョブを飛ばす"; return 1
}
unload_all(){ for m in $(ollama ps 2>/dev/null | awk 'NR>1{print $1}'); do ollama stop "$m" >/dev/null 2>&1; done; sleep 5; }

# fieldScale/radarScale から派生シナリオを作る（sweep_scenarios.js と同じ相似拡大）
gen_scenario(){
  node -e '
const fs=require("fs");
const [f,r]=[Number(process.argv[1]),Number(process.argv[2])];
const b=JSON.parse(fs.readFileSync("core/scenarios/flag_defence_squadrons.json","utf8"));
const a=b.protectedAssetLatLon;
const sc=p=>({...p,lat:a.lat+(p.lat-a.lat)*f,lon:a.lon+(p.lon-a.lon)*f});
b.spawns=b.spawns.map(sc);
if(Array.isArray(b.spawnsAreaLatLon)) b.spawnsAreaLatLon=b.spawnsAreaLatLon.map(sc);
b.sensors={...(b.sensors||{}),radarScale:r};
b.episodeTimeLimitS=Math.round(240*Math.max(1,f));
b.name=`flag_defence_squadrons__f${f}_r${r}`;
const p=`/tmp/scen_f${f}_r${r}.json`; fs.writeFileSync(p,JSON.stringify(b,null,2)); console.log(p);
' "$1" "$2"
}

summarize(){ grep -E '^outcomes:' "$1" 2>/dev/null || echo '(集計行なし)'; }

log "=== queue_all 開始 ==="
wait_for_gpu
log "GPU 解放を確認"

# ==========================================================================
# JOB 1: Stage 2 — 盤面スケールアップを軽量モデルで（§5.6）
#   Stage 1(scripted) で勝率25〜75%に残った条件から、指揮官の判断回数が段階的に増える3点。
#   隻数は増やさない: 「侵入側は1隻通せば勝ち／防御側は全隻止める」非対称により隻数↑で
#   防御側勝率が単調に下がり、補償なしでは「盤面が防御不能」を測ってしまうため。
# ==========================================================================
if ensure_model "$M_BOAT" && ensure_model "$M_CMD"; then
  for f in 1 2 4; do
    scen=$(gen_scenario "$f" 0.5)
    label="scale-f${f}-r0.5-20ep"
    wait_for_gpu; unload_all
    log "JOB1: $label"
    node scripts/headless_run.js --scenario "$scen" --blue llm --boat-mode llm \
      --model "$M_CMD" --boat-model "$M_BOAT" --llm-url "$OLLAMA/v1" \
      --episodes 20 --command-interval 10 --timeout-ms 120000 --quiet \
      --out "$OUT/$label.jsonl" --decision-log "$OUT/$label-decisions.jsonl" \
      --llm-log "$OUT/$label-calls.jsonl" > "$OUT/console-$label.txt" 2>&1 \
      && log "  -> $(summarize "$OUT/console-$label.txt")" \
      || log "  !! 失敗: $label"
  done
else
  log "JOB1 skip"
fi

# ==========================================================================
# JOB 2: thinking の3アーム（§3.5 設計2）— 指揮官のみ thinking、艇は軽量・非thinking
#   A: 非thinking + latencyS=2s   … 実測に見合う速い指揮官
#   B: thinking   + latencyS=2s   … 遅延コストを免除した反実仮想（賢さだけ取り出す）
#   C: thinking   + latencyS=48s  … 賢さと遅さの両方を負う現実条件
#   B>A かつ C<A なら「熟慮は判断を改善するが、その遅さの代償を払えていない」。
#   この反実仮想 B が作れるのは latencyS が実測ではなく設定値だからである。
#
#   盤面は f=2（1エピソード約100シム秒・指揮官10回判断）。f=4 だと指揮官の推論だけで
#   1エピソード20分を超え、現実的な時間に収まらない。
# ==========================================================================
if ensure_model "$M_THINK" && ensure_model "$M_BOAT"; then
  SCEN=$(gen_scenario 2 0.5)
  think_arm(){  # $1=label $2=latencyS $3=thinking
    wait_for_gpu; unload_all
    log "JOB2: $1 (latencyS=$2 thinking=$3)"
    node scripts/headless_run.js --scenario "$SCEN" --blue llm --boat-mode llm \
      --model "$M_THINK" --boat-model "$M_BOAT" \
      --llm-transport ollama --llm-url "$OLLAMA" \
      --thinking "$3" --boat-thinking off \
      --max-tokens 4000 --boat-max-tokens 300 --timeout-ms 300000 \
      --command-latency "$2" --episodes 12 --quiet \
      --out "$OUT/$1.jsonl" --decision-log "$OUT/$1-decisions.jsonl" --llm-log "$OUT/$1-calls.jsonl" \
      > "$OUT/console-$1.txt" 2>&1 \
      && log "  -> $(summarize "$OUT/console-$1.txt")" \
      || log "  !! 失敗: $1"
  }
  think_arm "armA-nothink-l${LAT_NOTHINK}"  "$LAT_NOTHINK" off
  think_arm "armB-think-l${LAT_NOTHINK}"    "$LAT_NOTHINK" on
  think_arm "armC-think-l${LAT_THINK}"      "$LAT_THINK"   on
else
  log "JOB2 skip"
fi

# ==========================================================================
# JOB 3: 解析（GPU 不要）
# ==========================================================================
log "JOB3: 解析"
for f in "$OUT"/*-calls.jsonl; do
  [ -e "$f" ] || continue
  b=$(basename "$f" -calls.jsonl)
  node scripts/extract_emergence.js "$f" --out "$EM/emergence-$b.md" --samples 8 >/dev/null 2>&1 \
    && log "  emergence: $b" || log "  !! emergence 失敗: $b"
  [ -e "$OUT/$b.jsonl" ] && {
    node scripts/analyze_run.js --run "$b=$OUT/$b" --title "$b" --out "$OUT/report-$b.html" >/dev/null 2>&1 \
      && log "  report: $b" || log "  !! report 失敗: $b"
  }
done

log "=== queue_all 完了 ==="
log "結果: $OUT/   創発レポート: $EM/"
