#!/usr/bin/env node
/**
 * analyze_run.js — headless_run.js が吐いた JSONL を読んで、単一ファイルの HTML レポートを作る
 *
 * 目的は数字を並べることではなく、**結論を疑えるようにする**こと。勝率は必ず信頼区間と一緒に出し、
 * 統制群との差は対応ありの検定に掛ける（エピソード番号が同じなら侵入艇の接近角も同じなので、
 * アーム間には対応がある）。N が足りなければ足りないと書く。
 *
 * 使い方:
 *   node scripts/headless_run.js --blue scripted --red scripted --boats 3 --episodes 25 \
 *     --out logs/ss.jsonl --decision-log logs/ss-decisions.jsonl
 *   node scripts/headless_run.js --blue llm --red scripted --model qwen2.5:7b --boats 3 --episodes 25 \
 *     --out logs/ls.jsonl --decision-log logs/ls-decisions.jsonl --llm-log logs/ls-calls.jsonl
 *
 *   node scripts/analyze_run.js \
 *     --run "scripted x scripted=logs/ss" \
 *     --run "llm x scripted=logs/ls" \
 *     --out logs/report.html
 *
 * --run の値は「表示名=プレフィックス」。プレフィックスから次の3つを探す:
 *   <prefix>.jsonl            env.logger の全ステップ（航跡・結末）
 *   <prefix>-decisions.jsonl  判断サイクル（発行/発効時刻・不成立・ステージ別実測）
 *   <prefix>-calls.jsonl      LLM 呼び出し（プロンプト・応答・レイテンシ）。scripted 腕には無い
 * 無い物は黙って飛ばすので、scripted 腕と LLM 腕を同じコマンドで並べられる。
 *
 * 最初の --run が統制群（ベースライン）として扱われ、以降のアームはこれと対応ありで比較される。
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');

/** 航跡の間引き。1エピソード数百〜2000ステップを全部埋め込むと HTML が肥大するだけで読めない */
const TRACK_STRIDE = 10;
/** 「見えている track から遠い move_to」の閾値。突破圏 80m・迎撃圏 60m より十分大きく取る */
const STALE_WAYPOINT_M = 200;
/** カテゴリ色は3枠まで（4枠目で黄とオレンジが並び、全ペア検証を通らない） */
const MAX_ARMS_COLORED = 3;

// ================================================================ 読み込み

function readJsonl(file) {
  if (!fs.existsSync(file)) return null;
  const rows = [];
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const s = line.trim();
    if (!s) continue;
    try {
      rows.push(JSON.parse(s));
    } catch {
      /* 実行中のファイルを読むと最終行が途中で切れていることがある。捨てる */
    }
  }
  return rows;
}

/**
 * プロンプト本文から ENEMY TRACKS の座標を拾う。
 * 指揮官がその時点で見ていたものは世界の真値ではなくプロンプトに書かれた物が全てなので、
 * 采配の質はここを基準に測るのが正しい。
 *   "  intruder-1 at (800, 300) — last seen 0.0s ago by defender-2"
 */
function parseTracksFromPrompt(prompt) {
  if (typeof prompt !== 'string') return [];
  const section = prompt.split(/ENEMY TRACKS[^\n]*\n/)[1];
  if (!section) return [];
  const tracks = [];
  for (const line of section.split('\n')) {
    if (!/^\s{2}\S/.test(line)) break; // インデントが切れたら次の節
    const m = line.match(/^\s*(\S+)\s+at\s+\(\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*\)/);
    if (m) tracks.push({ id: m[1], east: Number(m[2]), north: Number(m[3]) });
  }
  return tracks;
}

function waypointOf(order) {
  const p = order && (order.waypoint || order.center);
  if (!p || typeof p !== 'object') return null;
  const e = p.eastM !== undefined ? p.eastM : p.east_m;
  const n = p.northM !== undefined ? p.northM : p.north_m;
  return Number.isFinite(e) && Number.isFinite(n) ? { east: e, north: n } : null;
}

// ================================================================ 統計

/** Wilson score 区間。小 N で正規近似を使うと下端が負になって嘘になる */
function wilson(k, n, z = 1.96) {
  if (n === 0) return { lo: 0, hi: 1 };
  const p = k / n;
  const d = 1 + (z * z) / n;
  const c = p + (z * z) / (2 * n);
  const s = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  return { lo: Math.max(0, (c - s) / d), hi: Math.min(1, (c + s) / d) };
}

function logChoose(n, k) {
  let r = 0;
  for (let i = 1; i <= k; i++) r += Math.log(n - k + i) - Math.log(i);
  return r;
}

/**
 * McNemar 厳密二項（両側）。b/c は不一致ペアの数。
 * 対応ありで比べられるのは、同じエピソード番号なら侵入艇の接近角も同じだからで、
 * 対応なしの二標本検定より検出力が高い。
 */
function mcnemarExact(b, c) {
  const n = b + c;
  if (n === 0) return 1;
  const k = Math.min(b, c);
  let tail = 0;
  for (let i = 0; i <= k; i++) tail += Math.exp(logChoose(n, i) - n * Math.LN2);
  return Math.min(1, 2 * tail);
}

function quantile(sorted, q) {
  if (sorted.length === 0) return NaN;
  const i = (sorted.length - 1) * q;
  const lo = Math.floor(i);
  const hi = Math.ceil(i);
  return lo === hi ? sorted[lo] : sorted[lo] + (sorted[hi] - sorted[lo]) * (i - lo);
}

function mean(xs) {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
}

// ================================================================ 1アームの集計

function analyzeRun(label, prefix) {
  const steps = readJsonl(`${prefix}.jsonl`);
  const decisions = readJsonl(`${prefix}-decisions.jsonl`) || [];
  const calls = readJsonl(`${prefix}-calls.jsonl`) || [];
  if (!steps) throw new Error(`env ログが見つからない: ${prefix}.jsonl`);

  // --- エピソード（結末・長さ・航跡）
  const episodes = new Map();
  let config = null;
  for (const r of steps) {
    if (r.type === 'episode_start') {
      if (!config) config = r;
      episodes.set(r.episode, { episode: r.episode, outcome: null, steps: 0, simTimeS: 0, tracks: new Map() });
      continue;
    }
    if (r.type === 'episode_end') {
      const ep = episodes.get(r.episode);
      if (ep) {
        ep.outcome = r.outcome || ep.outcome;
        if (Number.isFinite(r.t)) ep.simTimeS = Math.max(ep.simTimeS, r.t);
      }
      continue;
    }
    if (r.type !== 'step') continue;
    const ep = episodes.get(r.episode);
    if (!ep) continue;
    const nth = Math.round((r.t || 0) / 0.1);
    ep.steps = Math.max(ep.steps, nth);
    ep.simTimeS = Math.max(ep.simTimeS, r.t || 0);
    if (r.outcome && !ep.outcome) ep.outcome = r.outcome;
    if (nth % TRACK_STRIDE !== 0) continue; // 航跡は間引く
    if (!ep.tracks.has(r.id)) ep.tracks.set(r.id, { id: r.id, faction: r.faction, pts: [] });
    ep.tracks.get(r.id).pts.push([Math.round(r.x), Math.round(r.y)]);
  }

  const epList = [...episodes.values()].sort((a, b) => a.episode - b.episode);
  const defended = epList.filter((e) => e.outcome === 'defended').length;
  const breached = epList.filter((e) => e.outcome === 'breached').length;
  const timeout = epList.filter((e) => e.outcome === 'timeout').length;

  // --- 判断サイクル
  const byDecider = new Map();
  const decisionsByEpisode = new Map();
  let exactApplies = 0;
  let applies = 0;
  let kept = 0;
  let missed = 0;
  let maxLagS = 0;
  for (const d of decisions) {
    if (!byDecider.has(d.decider)) {
      byDecider.set(d.decider, {
        decider: d.decider, faction: d.faction, issued: 0, applied: 0, kept: 0, missed: 0, wallMs: [],
      });
    }
    const s = byDecider.get(d.decider);
    s.issued += 1;
    if (d.outcome === 'applied') {
      s.applied += 1;
      applies += 1;
      const lag = Math.abs(d.applyLagS || 0);
      maxLagS = Math.max(maxLagS, lag);
      if (lag < 1e-6) exactApplies += 1;
    } else if (d.outcome === 'kept') {
      s.kept += 1;
      kept += 1;
    } else if (d.outcome === 'missed') {
      s.missed += 1;
      missed += 1;
    }
    const infer = d.stageWallMs && d.stageWallMs.infer;
    if (Number.isFinite(infer)) s.wallMs.push(infer);

    if (!decisionsByEpisode.has(d.episode)) decisionsByEpisode.set(d.episode, []);
    // シム時刻は 0.1 の蓄積なので 9.999999999999998 のような値が入る。表示は丸める
    decisionsByEpisode.get(d.episode).push({
      decider: d.decider,
      faction: d.faction,
      tIssueS: Number.isFinite(d.tIssueS) ? Number(d.tIssueS.toFixed(1)) : null,
      tAppliedS: Number.isFinite(d.tAppliedS) ? Number(d.tAppliedS.toFixed(1)) : null,
      outcome: d.outcome,
      orders: d.orders || 0,
      intent: d.intent || null,
      wallMs: Number.isFinite(infer) ? Math.round(infer) : null,
    });
  }

  // --- LLM 呼び出しと采配の質
  const outcomes = new Map();
  const latencies = [];
  const orderMix = { intercept: 0, move_to: 0, patrol: 0 };
  let moveToTotal = 0;
  let moveToStale = 0;
  let moveToWithPrev = 0;
  let moveToRepeat = 0;
  const lastWaypoint = new Map();
  let lastEpisode = null;

  for (const c of calls) {
    outcomes.set(c.outcome, (outcomes.get(c.outcome) || 0) + 1);
    if (Number.isFinite(c.latencyMs)) latencies.push(c.latencyMs);
    if (c.episode !== lastEpisode) {
      lastWaypoint.clear();
      lastEpisode = c.episode;
    }
    const tracks = parseTracksFromPrompt(c.userPrompt);
    const orders = (c.result && c.result.orders) || [];
    for (const o of orders) {
      const action = o.action || o.kind;
      if (Object.prototype.hasOwnProperty.call(orderMix, action)) orderMix[action] += 1;
      if (action !== 'move_to') continue;
      const wp = waypointOf(o);
      if (!wp) continue;
      moveToTotal += 1;
      // (a) 見えている track からどれだけ離れた点を指したか
      if (tracks.length > 0) {
        let nearest = Infinity;
        for (const t of tracks) nearest = Math.min(nearest, Math.hypot(wp.east - t.east, wp.north - t.north));
        if (nearest > STALE_WAYPOINT_M) moveToStale += 1;
      }
      // (b) 同じ艇へ前回と完全に同じ点を再発行していないか
      const prev = lastWaypoint.get(o.boat);
      if (prev) {
        moveToWithPrev += 1;
        if (prev.east === wp.east && prev.north === wp.north) moveToRepeat += 1;
      }
      lastWaypoint.set(o.boat, wp);
    }
  }

  const lens = epList.map((e) => e.simTimeS).sort((a, b) => a - b);
  const lats = latencies.slice().sort((a, b) => a - b);

  return {
    label,
    prefix,
    config,
    hasLlm: calls.length > 0,
    episodes: epList.map((e) => ({
      episode: e.episode,
      outcome: e.outcome,
      simTimeS: Number(e.simTimeS.toFixed(1)),
      steps: e.steps,
      tracks: [...e.tracks.values()],
      decisions: decisionsByEpisode.get(e.episode) || [],
    })),
    outcome: { defended, breached, timeout, n: epList.length },
    winRate: epList.length ? defended / epList.length : 0,
    ci: wilson(defended, epList.length),
    length: {
      min: quantile(lens, 0), p25: quantile(lens, 0.25), median: quantile(lens, 0.5),
      p75: quantile(lens, 0.75), max: quantile(lens, 1), mean: mean(lens),
      values: lens,
    },
    timing: { applies, exactApplies, kept, missed, maxLagS },
    deciders: [...byDecider.values()].map((d) => ({
      decider: d.decider, faction: d.faction, issued: d.issued, applied: d.applied,
      kept: d.kept, missed: d.missed,
      wallMeanMs: d.wallMs.length ? mean(d.wallMs) : null,
    })),
    llm: {
      calls: calls.length,
      outcomes: [...outcomes.entries()].sort((a, b) => b[1] - a[1]),
      latency: {
        n: lats.length, p50: quantile(lats, 0.5), p95: quantile(lats, 0.95),
        mean: mean(lats), values: lats,
      },
      orderMix,
      moveTo: { total: moveToTotal, stale: moveToStale, withPrev: moveToWithPrev, repeat: moveToRepeat },
    },
  };
}

/** 統制群（先頭のアーム）と対応ありで比較する */
function compare(baseline, arm) {
  const base = new Map(baseline.episodes.map((e) => [e.episode, e.outcome]));
  let b = 0; // 統制群では突破 → このアームでは防衛
  let c = 0; // 統制群では防衛 → このアームでは突破
  let shared = 0;
  for (const e of arm.episodes) {
    const o = base.get(e.episode);
    if (o === undefined) continue;
    shared += 1;
    if (o !== 'defended' && e.outcome === 'defended') b += 1;
    if (o === 'defended' && e.outcome !== 'defended') c += 1;
  }
  return { shared, b, c, p: mcnemarExact(b, c), delta: arm.winRate - baseline.winRate };
}

// ================================================================ HTML 生成

const PALETTE = {
  // カテゴリ（アーム識別）: 検証済み配色の第1〜3枠。全ペアで CVD ΔE を満たすのはここまで
  series: [
    { light: '#2a78d6', dark: '#3987e5' },
    { light: '#eb6834', dark: '#d95926' },
    { light: '#1baf7a', dark: '#199e70' },
  ],
  // 発散（結末の極性）: 青 ↔ 赤、中立はグレー
  defended: { light: '#2a78d6', dark: '#3987e5' },
  breached: { light: '#e34948', dark: '#e66767' },
  timeout: { light: '#8a8985', dark: '#8a8985' },
};

function esc(s) {
  return String(s === null || s === undefined ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function pct(x, digits = 1) {
  return `${(x * 100).toFixed(digits)}%`;
}

/** 度数分布。ヒストグラムの棒は SVG で描く（外部ライブラリを使わない） */
function histogram(values, binCount = 18) {
  if (values.length === 0) return { bins: [], lo: 0, hi: 0, width: 0 };
  const lo = Math.min(...values);
  const hi = Math.max(...values);
  const width = (hi - lo) / binCount || 1;
  const bins = new Array(binCount).fill(0);
  for (const v of values) {
    const i = Math.min(binCount - 1, Math.floor((v - lo) / width));
    bins[i] += 1;
  }
  return { bins, lo, hi, width };
}

/**
 * 統制群との違いが「片側だけ」か「両側」かを見る。
 * 両陣営の指揮官を同時に替えたアームは、差が出ても**どちらの寄与か切り分けられない**。
 * 有意差が出たときほどこの注意が要る（勝率が上がったのは自陣が強いからではなく、
 * 相手が弱いからかもしれない）。
 */
function armDiff(baseline, arm) {
  const b = baseline.config || {};
  const a = arm.config || {};
  const changed = [];
  if (b.blue !== a.blue) changed.push(`防御側 ${b.blue} → ${a.blue}`);
  if (b.red !== a.red) changed.push(`侵入側 ${b.red} → ${a.red}`);
  return changed;
}

function verdictText(runs, comparisons) {
  if (runs.length < 2) return null;
  const lines = [];
  for (let i = 1; i < runs.length; i++) {
    const cmp = comparisons[i - 1];
    const arm = runs[i];
    const sig = cmp.p < 0.05;
    const changed = armDiff(runs[0], arm);
    const delta = `${cmp.delta >= 0 ? '+' : ''}${(cmp.delta * 100).toFixed(1)} pt`;
    const stat = `McNemar p = ${cmp.p.toFixed(3)}、不一致 ${cmp.b}/${cmp.c}、対応 ${cmp.shared} エピソード`;
    let text = sig
      ? `統制群との差 ${delta} は有意（${stat}）。`
      : `統制群との差 ${delta} は**有意ではない**（${stat}）。この N では偶然と区別できない。`;
    if (changed.length > 1) {
      text += ` ただし統制群からの変更点が複数ある（${changed.join('、')}）ため、**この差をどちらか一方の寄与に帰属させることはできない**。`;
    }
    lines.push({ arm: arm.label, delta: cmp.delta, p: cmp.p, significant: sig, confounded: changed.length > 1, text });
  }
  return lines;
}

function renderHtml(runs, comparisons, meta) {
  const verdicts = verdictText(runs, comparisons);
  const payload = {
    runs: runs.map((r, i) => ({
      label: r.label,
      colorIndex: i < MAX_ARMS_COLORED ? i : null,
      episodes: r.episodes,
      hasLlm: r.hasLlm,
    })),
  };

  const seriesVars = PALETTE.series
    .map((c, i) => `    --series-${i + 1}: ${c.light};`)
    .join('\n');
  const seriesVarsDark = PALETTE.series
    .map((c, i) => `    --series-${i + 1}: ${c.dark};`)
    .join('\n');

  // charset は先頭 1024 バイト以内に置く。file:// で直接開くと Content-Type が付かず、
  // これが無いと日本語が全て文字化けする（実際に一度やった）。
  return `<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(meta.title || 'L0 実験レポート')}</title>
<style>
  :root {
    color-scheme: light;
    --surface-0: #f5f4f1;
    --surface-1: #fcfcfb;
    --surface-2: #eceae5;
    --border: #d9d7d0;
    --text-primary: #0b0b0b;
    --text-secondary: #52514e;
    --text-muted: #78766f;
    --defended: ${PALETTE.defended.light};
    --breached: ${PALETTE.breached.light};
    --timeout: ${PALETTE.timeout.light};
${seriesVars}
  }
  @media (prefers-color-scheme: dark) {
    :root:not([data-theme="light"]) {
      color-scheme: dark;
      --surface-0: #131312;
      --surface-1: #1a1a19;
      --surface-2: #232322;
      --border: #383835;
      --text-primary: #ffffff;
      --text-secondary: #c3c2b7;
      --text-muted: #97968c;
      --defended: ${PALETTE.defended.dark};
      --breached: ${PALETTE.breached.dark};
      --timeout: ${PALETTE.timeout.dark};
${seriesVarsDark}
    }
  }
  :root[data-theme="dark"] {
    color-scheme: dark;
    --surface-0: #131312;
    --surface-1: #1a1a19;
    --surface-2: #232322;
    --border: #383835;
    --text-primary: #ffffff;
    --text-secondary: #c3c2b7;
    --text-muted: #97968c;
    --defended: ${PALETTE.defended.dark};
    --breached: ${PALETTE.breached.dark};
    --timeout: ${PALETTE.timeout.dark};
${seriesVarsDark}
  }

  body {
    margin: 0;
    background: var(--surface-0);
    color: var(--text-primary);
    font-family: ui-sans-serif, system-ui, "Hiragino Kaku Gothic ProN", "Yu Gothic UI", Meiryo, sans-serif;
    font-size: 15px;
    line-height: 1.65;
  }
  .wrap { max-width: 1120px; margin: 0 auto; padding: 40px 24px 96px; }
  h1 { font-size: 27px; letter-spacing: -0.01em; margin: 0 0 6px; }
  h2 {
    font-size: 19px; margin: 52px 0 6px; padding-top: 22px;
    border-top: 1px solid var(--border); letter-spacing: -0.005em;
  }
  h3 { font-size: 15px; margin: 26px 0 8px; color: var(--text-secondary); font-weight: 600; }
  p { margin: 8px 0; color: var(--text-secondary); max-width: 74ch; }
  .lede { font-size: 16px; color: var(--text-secondary); max-width: 74ch; }
  .muted { color: var(--text-muted); font-size: 13px; }
  code { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 0.9em;
         background: var(--surface-2); padding: 1px 5px; border-radius: 4px; }
  a { color: var(--series-1); }

  .card { background: var(--surface-1); border: 1px solid var(--border); border-radius: 10px; padding: 18px 20px; }
  .tiles { display: grid; grid-template-columns: repeat(auto-fit, minmax(215px, 1fr)); gap: 12px; margin: 18px 0; }
  .tile { background: var(--surface-1); border: 1px solid var(--border); border-radius: 10px; padding: 15px 17px; }
  .tile .label { font-size: 12px; color: var(--text-muted); display: flex; align-items: center; gap: 7px; }
  .swatch { width: 10px; height: 10px; border-radius: 3px; flex: none; }
  .tile .value { font-size: 30px; font-weight: 650; letter-spacing: -0.02em; margin-top: 4px;
                 font-variant-numeric: tabular-nums; }
  .tile .sub { font-size: 12.5px; color: var(--text-secondary); font-variant-numeric: tabular-nums; }

  .verdict { border-left: 3px solid var(--series-1); background: var(--surface-1);
             border-radius: 0 10px 10px 0; padding: 14px 18px; margin: 18px 0; }
  .verdict.null-result { border-left-color: var(--timeout); }
  .verdict strong { color: var(--text-primary); }

  table { border-collapse: collapse; width: 100%; font-size: 13.5px; font-variant-numeric: tabular-nums; }
  th, td { text-align: right; padding: 7px 10px; border-bottom: 1px solid var(--border); }
  th:first-child, td:first-child { text-align: left; }
  thead th { color: var(--text-muted); font-weight: 600; font-size: 12px; white-space: nowrap; }
  tbody tr:last-child td { border-bottom: none; }
  .scroll { overflow-x: auto; }

  .legend { display: flex; gap: 16px; flex-wrap: wrap; margin: 10px 0 4px; font-size: 12.5px;
            color: var(--text-secondary); align-items: center; }
  .legend span { display: inline-flex; align-items: center; gap: 6px; }

  .grid-row { display: flex; align-items: center; gap: 10px; margin-bottom: 5px; }
  .grid-name { width: 168px; flex: none; font-size: 12.5px; color: var(--text-secondary);
               text-align: right; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .cells { display: flex; gap: 2px; flex-wrap: wrap; }
  .cell { width: 22px; height: 22px; border-radius: 4px; cursor: default; }

  svg { display: block; max-width: 100%; overflow: visible; }
  .axis { stroke: var(--border); stroke-width: 1; }
  .axis-text { fill: var(--text-muted); font-size: 11px; font-variant-numeric: tabular-nums; }

  .explorer-controls { display: flex; gap: 12px; flex-wrap: wrap; align-items: center; margin: 14px 0 16px; }
  select { background: var(--surface-1); color: var(--text-primary); border: 1px solid var(--border);
           border-radius: 7px; padding: 7px 11px; font: inherit; font-size: 13.5px; }
  label { font-size: 12.5px; color: var(--text-muted); display: flex; gap: 7px; align-items: center; }

  .explorer { display: grid; grid-template-columns: minmax(0, 1.05fr) minmax(0, 1fr); gap: 18px; }
  @media (max-width: 860px) { .explorer { grid-template-columns: 1fr; } .grid-name { width: 110px; } }

  .timeline { max-height: 470px; overflow-y: auto; }
  .decision { border-left: 2px solid var(--border); padding: 7px 0 7px 13px; margin-bottom: 3px; }
  .decision.applied { border-left-color: var(--series-1); }
  .decision.kept { border-left-color: var(--timeout); }
  .decision.missed { border-left-color: var(--breached); }
  .decision .head { font-size: 12px; color: var(--text-muted); font-variant-numeric: tabular-nums; }
  .decision .intent { font-size: 13.5px; color: var(--text-primary); }

  #tip { position: fixed; pointer-events: none; opacity: 0; transition: opacity .1s;
         background: var(--surface-1); border: 1px solid var(--border); border-radius: 7px;
         padding: 7px 10px; font-size: 12.5px; box-shadow: 0 4px 16px rgba(0,0,0,.16);
         font-variant-numeric: tabular-nums; z-index: 50; max-width: 300px; }
  details { margin-top: 14px; }
  summary { cursor: pointer; color: var(--text-secondary); font-size: 13.5px; }
</style>

<div class="wrap">
<h1>L0 実験レポート</h1>
<p class="lede">${esc(meta.subtitle)}</p>
<p class="muted">生成: <code>node scripts/analyze_run.js</code> ／ アーム ${runs.length} 本 ／ ${esc(meta.generatedAt)}</p>

${verdicts ? `<h2>結論</h2>
${verdicts.map((v) => `<div class="verdict${v.significant && !v.confounded ? '' : ' null-result'}">
  <strong>${esc(v.arm)}</strong> — ${v.text.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')}
</div>`).join('\n')}
<p>勝率だけを見て強弱を語らないこと。同一条件でも実行ごとに揺れる（LLM アームは temperature が 0 でない限り決定論ではない）ので、
差が反復幅より小さければそれは測定できていないという意味になる。</p>` : ''}

<h2>アーム比較</h2>
<div class="tiles">
${runs.map((r, i) => {
  const color = i < MAX_ARMS_COLORED ? `var(--series-${i + 1})` : 'var(--text-muted)';
  return `  <div class="tile">
    <div class="label"><span class="swatch" style="background:${color}"></span>${esc(r.label)}</div>
    <div class="value">${pct(r.winRate, 1)}</div>
    <div class="sub">防衛 ${r.outcome.defended} / 突破 ${r.outcome.breached}${r.outcome.timeout ? ` / 時間切れ ${r.outcome.timeout}` : ''} （N=${r.outcome.n}）</div>
    <div class="sub muted">95% CI [${pct(r.ci.lo, 1)}, ${pct(r.ci.hi, 1)}]</div>
  </div>`;
}).join('\n')}
</div>

<div class="scroll"><table>
  <thead><tr>
    <th>アーム</th><th>N</th><th>防衛</th><th>突破</th><th>勝率</th><th>95% CI</th>
    <th>統制群との差</th><th>McNemar p</th><th>keptOrders</th><th>発効時刻の一致</th>
  </tr></thead>
  <tbody>
${runs.map((r, i) => {
  const cmp = i === 0 ? null : comparisons[i - 1];
  const keptTotal = r.timing.applies + r.timing.kept;
  const keptRate = keptTotal ? r.timing.kept / keptTotal : 0;
  return `    <tr>
      <td>${esc(r.label)}${i === 0 ? ' <span class="muted">(統制群)</span>' : ''}</td>
      <td>${r.outcome.n}</td><td>${r.outcome.defended}</td><td>${r.outcome.breached}</td>
      <td>${pct(r.winRate, 1)}</td>
      <td class="muted">[${pct(r.ci.lo, 1)}, ${pct(r.ci.hi, 1)}]</td>
      <td>${cmp ? `${cmp.delta >= 0 ? '+' : ''}${(cmp.delta * 100).toFixed(1)} pt` : '—'}</td>
      <td>${cmp ? cmp.p.toFixed(3) : '—'}</td>
      <td>${keptTotal ? `${pct(keptRate, 1)} <span class="muted">(${r.timing.kept}/${keptTotal})</span>` : '—'}</td>
      <td>${r.timing.applies ? `${r.timing.exactApplies}/${r.timing.applies}` : '—'}</td>
    </tr>`;
}).join('\n')}
  </tbody>
</table></div>
<p class="muted">「発効時刻の一致」は指示が <code>t_issue + latencyS</code> ちょうどに効いた回数。計画の完了条件のひとつ。
最大ずれ ${runs.map((r) => r.timing.maxLagS.toExponential(1)).join(' / ')} 秒（dt=0.1s に対する浮動小数の丸め誤差）。</p>

<h2>エピソードごとの結末</h2>
<p>アームは同じエピソード番号で同じ初期条件を使う（侵入艇の接近角はエピソード番号の純関数）ので、
縦に並べると<strong>どのエピソードで判断が分かれたか</strong>が直接読める。McNemar 検定はこの縦の不一致だけを数えている。</p>
<div class="legend">
  <span><span class="swatch" style="background:var(--defended)"></span>防衛</span>
  <span><span class="swatch" style="background:var(--breached)"></span>突破</span>
  <span><span class="swatch" style="background:var(--timeout)"></span>時間切れ</span>
</div>
<div class="card">
${runs.map((r) => `  <div class="grid-row">
    <div class="grid-name">${esc(r.label)}</div>
    <div class="cells">
${r.episodes.map((e) => `      <div class="cell" data-tip="ep ${e.episode} — ${esc(e.outcome || '不明')} / ${e.simTimeS}s / ${e.steps} steps" style="background:var(--${e.outcome || 'timeout'})"></div>`).join('\n')}
    </div>
  </div>`).join('\n')}
</div>

<h2>エピソード長の分布</h2>
<p>結末が同じでも中身は違う。短いエピソードは即座に迎撃できた／即座に突破されたことを意味し、
長いものは膠着を意味する。分布が二峰なら、勝率という1つの数字はその2つの体制を平均して潰している。</p>
${runs.map((r, i) => {
  const color = i < MAX_ARMS_COLORED ? `var(--series-${i + 1})` : 'var(--text-muted)';
  const L = r.length;
  const allMax = Math.max(...runs.map((x) => x.length.max));
  const W = 720; const H = 46; const PAD = 8;
  const sx = (v) => PAD + (v / allMax) * (W - 2 * PAD);
  return `<h3><span class="swatch" style="background:${color};display:inline-block;margin-right:7px"></span>${esc(r.label)}</h3>
<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img"
     aria-label="${esc(r.label)} のエピソード長: 中央値 ${L.median.toFixed(1)} 秒">
  <line class="axis" x1="${PAD}" y1="${H - 13}" x2="${W - PAD}" y2="${H - 13}"></line>
  <rect x="${sx(L.p25)}" y="12" width="${Math.max(2, sx(L.p75) - sx(L.p25))}" height="12" rx="4"
        fill="${color}" opacity="0.28"></rect>
  <line x1="${sx(L.median)}" y1="9" x2="${sx(L.median)}" y2="27" stroke="${color}" stroke-width="2"></line>
${r.length.values.map((v) => `  <circle cx="${sx(v).toFixed(1)}" cy="18" r="3.2" fill="${color}" opacity="0.62"
        stroke="var(--surface-1)" stroke-width="2"><title>${v.toFixed(1)} 秒</title></circle>`).join('\n')}
  <text class="axis-text" x="${PAD}" y="${H - 2}">0s</text>
  <text class="axis-text" x="${sx(L.median).toFixed(1)}" y="${H - 2}" text-anchor="middle">中央値 ${L.median.toFixed(0)}s</text>
  <text class="axis-text" x="${W - PAD}" y="${H - 2}" text-anchor="end">${allMax.toFixed(0)}s</text>
</svg>`;
}).join('\n')}

${runs.some((r) => r.hasLlm) ? `
<h2>推論の実測</h2>
<p><code>latencyS</code> は<strong>設定値</strong>であってこの実測値ではない（時間モデル §5）。ここに出るのは
「宣言した遅延の中に実測が収まっているか」を確かめるための記録側の数字で、シムの展開には一切影響しない。</p>
<div class="tiles">
${runs.filter((r) => r.hasLlm).map((r) => {
  const i = runs.indexOf(r);
  const color = i < MAX_ARMS_COLORED ? `var(--series-${i + 1})` : 'var(--text-muted)';
  const l = r.llm.latency;
  return `  <div class="tile">
    <div class="label"><span class="swatch" style="background:${color}"></span>${esc(r.label)}</div>
    <div class="value">${(l.p50 / 1000).toFixed(2)}<span style="font-size:16px;font-weight:500"> s</span></div>
    <div class="sub">p50 ／ p95 ${(l.p95 / 1000).toFixed(2)}s ／ 平均 ${(l.mean / 1000).toFixed(2)}s</div>
    <div class="sub muted">${r.llm.calls} 回 ／ ${r.llm.outcomes.map(([k, v]) => `${esc(k)} ${v}`).join(' · ')}</div>
  </div>`;
}).join('\n')}
</div>
${runs.filter((r) => r.hasLlm).map((r) => {
  const i = runs.indexOf(r);
  const color = i < MAX_ARMS_COLORED ? `var(--series-${i + 1})` : 'var(--text-muted)';
  const h = histogram(r.llm.latency.values, 20);
  const W = 720; const H = 130; const PAD = 30;
  const maxCount = Math.max(...h.bins, 1);
  const bw = (W - 2 * PAD) / h.bins.length;
  return `<h3><span class="swatch" style="background:${color};display:inline-block;margin-right:7px"></span>${esc(r.label)} の応答時間分布</h3>
<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img"
     aria-label="${esc(r.label)} の推論応答時間ヒストグラム">
  <line class="axis" x1="${PAD}" y1="${H - 22}" x2="${W - PAD}" y2="${H - 22}"></line>
${h.bins.map((c, bi) => {
  const bh = (c / maxCount) * (H - 42);
  const x = PAD + bi * bw;
  const lo = (h.lo + bi * h.width) / 1000;
  const hi = (h.lo + (bi + 1) * h.width) / 1000;
  return `  <rect x="${(x + 1).toFixed(1)}" y="${(H - 22 - bh).toFixed(1)}" width="${(bw - 2).toFixed(1)}"
        height="${bh.toFixed(1)}" rx="3" fill="${color}"
        data-tip="${lo.toFixed(2)}–${hi.toFixed(2)} s: ${c} 回"></rect>`;
}).join('\n')}
  <text class="axis-text" x="${PAD}" y="${H - 7}">${(h.lo / 1000).toFixed(2)}s</text>
  <text class="axis-text" x="${W - PAD}" y="${H - 7}" text-anchor="end">${(h.hi / 1000).toFixed(2)}s</text>
  <text class="axis-text" x="${PAD - 6}" y="${H - 22}" text-anchor="end">0</text>
  <text class="axis-text" x="${PAD - 6}" y="26" text-anchor="end">${maxCount}</text>
</svg>`;
}).join('\n')}

<h2>采配の質</h2>
<p>勝率は結果しか見ない。指示の中身が妥当だったかは別に測る必要がある。
<code>intercept</code> は track を追い続けるが <code>move_to</code> は固定点なので、
<strong>見えている track から遠い move_to</strong> と <strong>前回と同じ点の再発行</strong>は、
指揮官が古い接触位置へ艇を走らせ続けている兆候になる。</p>
<div class="scroll"><table>
  <thead><tr>
    <th>アーム</th><th>intercept</th><th>move_to</th><th>patrol</th>
    <th>track から ${STALE_WAYPOINT_M}m 超</th><th>前回と同一の再発行</th>
  </tr></thead>
  <tbody>
${runs.filter((r) => r.hasLlm).map((r) => {
  const m = r.llm.orderMix;
  const t = m.intercept + m.move_to + m.patrol || 1;
  const mt = r.llm.moveTo;
  return `    <tr>
      <td>${esc(r.label)}</td>
      <td>${m.intercept} <span class="muted">(${pct(m.intercept / t, 0)})</span></td>
      <td>${m.move_to} <span class="muted">(${pct(m.move_to / t, 0)})</span></td>
      <td>${m.patrol} <span class="muted">(${pct(m.patrol / t, 0)})</span></td>
      <td>${mt.total ? `${pct(mt.stale / mt.total, 1)} <span class="muted">(${mt.stale}/${mt.total})</span>` : '—'}</td>
      <td>${mt.withPrev ? `${pct(mt.repeat / mt.withPrev, 1)} <span class="muted">(${mt.repeat}/${mt.withPrev})</span>` : '—'}</td>
    </tr>`;
}).join('\n')}
  </tbody>
</table></div>
` : ''}

<h2>エピソードを1本ずつ見る</h2>
<p>航跡と、その裏で指揮官が何を考えていたか（intent）を並べる。勝敗の理由は集計では見えないので、
分かれたエピソードをここで開いて確かめる。</p>
<div class="explorer-controls">
  <label>アーム <select id="sel-arm"></select></label>
  <label>エピソード <select id="sel-ep"></select></label>
  <span class="muted" id="ep-summary"></span>
</div>
<div class="explorer">
  <div class="card"><svg id="map" viewBox="0 0 520 520" width="520" height="520" role="img" aria-label="航跡図"></svg>
    <div class="legend" style="margin-top:10px">
      <span><span class="swatch" style="background:var(--defended)"></span>防御艇</span>
      <span><span class="swatch" style="background:var(--breached)"></span>侵入艇</span>
      <span><span class="swatch" style="background:var(--text-muted);border-radius:50%"></span>防護対象</span>
    </div>
  </div>
  <div class="card timeline" id="timeline"></div>
</div>

<h2>データ</h2>
<details>
  <summary>アームごとの決定者の内訳を表で見る</summary>
  <div class="scroll" style="margin-top:12px"><table>
    <thead><tr><th>アーム</th><th>決定者</th><th>陣営</th><th>発行</th><th>発効</th><th>維持</th><th>不成立</th><th>実測 t_wall 平均</th></tr></thead>
    <tbody>
${runs.flatMap((r) => r.deciders.map((d) => `      <tr>
        <td>${esc(r.label)}</td><td>${esc(d.decider)}</td><td>${esc(d.faction)}</td>
        <td>${d.issued}</td><td>${d.applied}</td><td>${d.kept}</td><td>${d.missed}</td>
        <td>${d.wallMeanMs === null ? '—' : `${d.wallMeanMs.toFixed(1)} ms`}</td>
      </tr>`)).join('\n')}
    </tbody>
  </table></div>
</details>
<details>
  <summary>エピソードごとの結末を表で見る</summary>
  <div class="scroll" style="margin-top:12px"><table>
    <thead><tr><th>エピソード</th>${runs.map((r) => `<th>${esc(r.label)}</th>`).join('')}</tr></thead>
    <tbody>
${(runs[0] ? runs[0].episodes : []).map((e) => `      <tr><td>${e.episode}</td>${runs.map((r) => {
  const m = r.episodes.find((x) => x.episode === e.episode);
  return `<td>${m ? `${esc(m.outcome || '—')} <span class="muted">${m.simTimeS}s</span>` : '—'}</td>`;
}).join('')}</tr>`).join('\n')}
    </tbody>
  </table></div>
</details>

<p class="muted" style="margin-top:44px">ログの出所: ${runs.map((r) => `<code>${esc(r.prefix)}</code>`).join(' ／ ')}</p>
</div>

<div id="tip"></div>

<script>
const DATA = ${JSON.stringify(payload)};
const SERIES_COUNT = ${MAX_ARMS_COLORED};

// ---- ツールチップ（data-tip を持つ全要素で共通）
const tip = document.getElementById('tip');
document.addEventListener('mouseover', (e) => {
  const el = e.target.closest('[data-tip]');
  if (!el) return;
  tip.textContent = el.getAttribute('data-tip');
  tip.style.opacity = '1';
});
document.addEventListener('mousemove', (e) => {
  if (tip.style.opacity !== '1') return;
  const pad = 14;
  let x = e.clientX + pad;
  let y = e.clientY + pad;
  const r = tip.getBoundingClientRect();
  if (x + r.width > window.innerWidth - 8) x = e.clientX - r.width - pad;
  if (y + r.height > window.innerHeight - 8) y = e.clientY - r.height - pad;
  tip.style.left = x + 'px';
  tip.style.top = y + 'px';
});
document.addEventListener('mouseout', (e) => {
  if (e.target.closest('[data-tip]')) tip.style.opacity = '0';
});

// ---- エピソード探索
const selArm = document.getElementById('sel-arm');
const selEp = document.getElementById('sel-ep');
const epSummary = document.getElementById('ep-summary');
const mapEl = document.getElementById('map');
const timelineEl = document.getElementById('timeline');

DATA.runs.forEach((r, i) => {
  const o = document.createElement('option');
  o.value = String(i);
  o.textContent = r.label;
  selArm.appendChild(o);
});

function fillEpisodes() {
  const run = DATA.runs[Number(selArm.value)];
  selEp.innerHTML = '';
  run.episodes.forEach((e) => {
    const o = document.createElement('option');
    o.value = String(e.episode);
    o.textContent = 'ep ' + e.episode + ' — ' + (e.outcome || '?');
    selEp.appendChild(o);
  });
}

function draw() {
  const run = DATA.runs[Number(selArm.value)];
  const ep = run.episodes.find((e) => String(e.episode) === selEp.value) || run.episodes[0];
  if (!ep) return;

  epSummary.textContent = ep.outcome + ' ／ ' + ep.simTimeS + ' 秒 ／ ' + ep.steps + ' steps ／ 判断 ' + ep.decisions.length + ' 回';

  // 航跡の座標範囲。防護対象（原点）を必ず含める
  let minX = 0, maxX = 0, minY = 0, maxY = 0;
  for (const t of ep.tracks) for (const p of t.pts) {
    if (p[0] < minX) minX = p[0];
    if (p[0] > maxX) maxX = p[0];
    if (p[1] < minY) minY = p[1];
    if (p[1] > maxY) maxY = p[1];
  }
  const span = Math.max(maxX - minX, maxY - minY, 200) * 1.12;
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;
  const S = 520, PAD = 26;
  const px = (x) => PAD + ((x - cx) / span + 0.5) * (S - 2 * PAD);
  const py = (y) => S - PAD - ((y - cy) / span + 0.5) * (S - 2 * PAD); // 北を上に

  const parts = [];
  parts.push('<rect x="0" y="0" width="' + S + '" height="' + S + '" fill="var(--surface-2)" rx="8"/>');
  // 防護対象と突破圏
  const r80 = Math.abs(px(80) - px(0));
  parts.push('<circle cx="' + px(0) + '" cy="' + py(0) + '" r="' + r80 + '" fill="none" stroke="var(--text-muted)" stroke-width="1" stroke-dasharray="4 4" opacity="0.7"/>');
  parts.push('<circle cx="' + px(0) + '" cy="' + py(0) + '" r="6" fill="var(--text-muted)"/>');

  for (const t of ep.tracks) {
    const color = t.faction === 'intruder' ? 'var(--breached)' : 'var(--defended)';
    const d = t.pts.map((p, i) => (i ? 'L' : 'M') + px(p[0]).toFixed(1) + ' ' + py(p[1]).toFixed(1)).join(' ');
    parts.push('<path d="' + d + '" fill="none" stroke="' + color + '" stroke-width="2" opacity="0.8" stroke-linecap="round" stroke-linejoin="round"/>');
    const last = t.pts[t.pts.length - 1];
    const first = t.pts[0];
    if (first) parts.push('<circle cx="' + px(first[0]).toFixed(1) + '" cy="' + py(first[1]).toFixed(1) + '" r="3" fill="var(--surface-2)" stroke="' + color + '" stroke-width="2"/>');
    if (last) {
      parts.push('<circle cx="' + px(last[0]).toFixed(1) + '" cy="' + py(last[1]).toFixed(1) + '" r="5" fill="' + color + '" stroke="var(--surface-2)" stroke-width="2"><title>' + t.id + '</title></circle>');
      parts.push('<text x="' + (px(last[0]) + 9).toFixed(1) + '" y="' + (py(last[1]) + 4).toFixed(1) + '" class="axis-text" fill="var(--text-secondary)">' + t.id + '</text>');
    }
  }
  parts.push('<text x="' + (S - PAD) + '" y="' + (S - 8) + '" text-anchor="end" class="axis-text">約 ' + Math.round(span) + ' m 四方 ／ 上が北</text>');
  mapEl.innerHTML = parts.join('');

  if (ep.decisions.length === 0) {
    timelineEl.innerHTML = '<p class="muted">このアームには判断ログ（--decision-log）がありません。</p>';
    return;
  }
  const rows = ep.decisions.slice().sort((a, b) => a.tIssueS - b.tIssueS).map((d) => {
    const wall = d.wallMs === null ? '' : ' ／ 実測 ' + (d.wallMs / 1000).toFixed(2) + 's';
    const applied = d.tAppliedS === null ? '未発効' : '発効 t=' + d.tAppliedS + 's';
    return '<div class="decision ' + d.outcome + '">' +
      '<div class="head">t=' + d.tIssueS + 's 発行 → ' + applied + ' ／ ' + d.decider + ' ／ ' + d.outcome + ' ／ ' + d.orders + ' 件' + wall + '</div>' +
      (d.intent ? '<div class="intent">' + d.intent.replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c])) + '</div>' : '') +
      '</div>';
  });
  timelineEl.innerHTML = rows.join('');
}

selArm.addEventListener('change', () => { fillEpisodes(); draw(); });
selEp.addEventListener('change', draw);
fillEpisodes();
draw();
</script>
`;
}

// ================================================================ CLI

function parseArgs(argv) {
  const runs = [];
  let out = 'logs/report.html';
  let subtitle = '';
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--run') {
      const v = argv[++i] || '';
      const eq = v.indexOf('=');
      if (eq < 0) throw new Error(`--run は "表示名=プレフィックス" の形で渡す（受け取った値: ${v}）`);
      runs.push({ label: v.slice(0, eq).trim(), prefix: v.slice(eq + 1).trim() });
    } else if (a === '--out') {
      out = argv[++i];
    } else if (a === '--subtitle') {
      subtitle = argv[++i];
    } else if (a === '--help' || a === '-h') {
      return null;
    } else {
      throw new Error(`知らない引数: ${a}`);
    }
  }
  return { runs, out, subtitle };
}

function usage() {
  console.log(`
node scripts/analyze_run.js --run "表示名=プレフィックス" [--run ...] [--out path] [--subtitle 文]

  --run NAME=PREFIX   アームを1本追加する。PREFIX.jsonl / PREFIX-decisions.jsonl /
                      PREFIX-calls.jsonl を探し、あるものだけ読む。
                      最初の --run が統制群として扱われ、以降は対応ありで比較される。
  --out PATH          出力する HTML（既定 logs/report.html）。単一ファイルで完結する。
  --subtitle TEXT     レポート冒頭の説明文。
  --help              この一覧。

例:
  node scripts/analyze_run.js \\
    --run "scripted x scripted=logs/l0-ss" \\
    --run "llm x scripted=logs/l0-ls" \\
    --run "llm x llm=logs/l0-ll" \\
    --subtitle "3隻・25エピソード・qwen2.5:7b" \\
    --out logs/l0-report.html
`);
}

function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(`エラー: ${err.message}`);
    usage();
    process.exit(1);
  }
  if (!args || args.runs.length === 0) {
    usage();
    process.exit(args ? 1 : 0);
  }

  let runs;
  try {
    runs = args.runs.map((r) => {
      process.stderr.write(`読み込み中: ${r.label} <- ${r.prefix}*.jsonl\n`);
      return analyzeRun(r.label, r.prefix);
    });
  } catch (err) {
    console.error(`\nエラー: ${err.message}`);
    console.error('headless_run.js に --out を渡してログを書き出したか確認する。');
    process.exit(1);
  }
  const comparisons = runs.slice(1).map((r) => compare(runs[0], r));

  const html = renderHtml(runs, comparisons, {
    subtitle: args.subtitle || `${runs.length} 本のアームを比較`,
    generatedAt: new Date().toISOString().slice(0, 16).replace('T', ' ') + ' UTC',
  });

  const outDir = path.dirname(args.out);
  if (outDir && outDir !== '.' && !fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(args.out, html, 'utf8');

  const kb = (Buffer.byteLength(html, 'utf8') / 1024).toFixed(0);
  console.log(`\n書き出し: ${args.out} (${kb} KB)`);
  for (let i = 0; i < runs.length; i++) {
    const r = runs[i];
    const cmp = i === 0 ? null : comparisons[i - 1];
    const tail = cmp
      ? `  統制群との差 ${cmp.delta >= 0 ? '+' : ''}${(cmp.delta * 100).toFixed(1)}pt, McNemar p=${cmp.p.toFixed(3)}${cmp.p < 0.05 ? '' : ' (有意差なし)'}`
      : '  (統制群)';
    console.log(`  ${r.label}: ${(r.winRate * 100).toFixed(1)}% (${r.outcome.defended}/${r.outcome.n})${tail}`);
  }
}

if (require.main === module) main();

module.exports = { analyzeRun, compare, wilson, mcnemarExact, parseTracksFromPrompt };
