/**
 * llm_probe.js — 推論サーバを単体で計測する（シミュレータ非依存）
 *
 * docs/l0-llm-agent-plan.md Task 1。latencyS（時間モデルの設定値）の根拠となる
 * 実測値（1判断のレイテンシ・出力トークン数・同時実行スループット）を得る。
 * docs/time-model.md §5 のとおり、実測値そのものはシムに流し込まない。
 * 「latencyS を何秒に設定するのが妥当か」の材料としてだけ使う。
 *
 * 計測の作り:
 * - プロンプトは実際の指揮官プロンプト（core/sim/command/commander_prompt.js、Task 6）と
 *   同じ体裁・同程度の長さにそろえる。system は固定・user は毎回変える。実運用でも
 *   system 側だけが KV キャッシュに残るので、この非対称を再現しないと prompt eval を
 *   過小評価する。
 * - コールドスタート（初回＝モデルの VRAM ロード込み）とウォーム定常を分けて出す。
 *   両者は1桁違うので、混ぜた平均には意味が無い。
 * - ウォームは p50 / p95 / mean を出す。latencyS は「たまに遅い」側も飲み込める値に
 *   したいので、平均だけでは決められない。
 *
 * API:
 * - `--api openai`（既定）: OpenAI 互換 `POST {url}/chat/completions`。vLLM でもそのまま動く。
 *   Task 7 の core/sim/agents/llm_http.js と同じ経路を測る。
 * - `--api ollama`: Ollama ネイティブ `POST {url}/api/chat`。load_duration・eval_duration 等の
 *   ナノ秒計測が返るので、ロード時間と生成時間を分離できる。
 *
 * 使い方:
 *   node scripts/llm_probe.js --model qwen2.5:7b
 *   node scripts/llm_probe.js --model qwen2.5:7b --api ollama --warm 16 --concurrency 1,2,4,6
 *   node scripts/llm_probe.js --model qwen2.5:7b --api ollama --profile boat --json out.json
 *
 *   --model NAME        必須。例 qwen2.5:7b
 *   --url URL           既定 http://localhost:11434/v1（--api ollama のときは http://localhost:11434）
 *   --api openai|ollama 既定 openai
 *   --profile commander|boat  プロンプト種別。既定 commander（L0 指揮官＝数百トークン入力）。
 *                       boat は Phase 2 の艇レベル（小さいプロンプトの持続負荷、roadmap §5）
 *   --warm N            ウォーム定常の連続サンプル数（既定 12）。p95 を見るので 8 以上を推奨
 *   --concurrency LIST  同時実行スイープ。既定 1,2,4。空文字で省略
 *   --requests N        同時実行スイープ1設定あたりのリクエスト数（既定 12）
 *   --max-tokens N      既定 300
 *   --no-cold           コールドスタート計測（アンロード→初回）を省略
 *   --json PATH         生の計測結果を JSON で書き出す
 *   --think on|off      thinking の明示制御。**--api ollama でのみ有効**（OpenAI 互換経路は
 *                       think も chat_template_kwargs.enable_thinking も無視することを実測済み。
 *                       docs/thinking-model-plan.md §2）。指定しなければモデル既定に任せる
 *   --reasoning-effort low|medium|high
 *                       推論の深さ（qwen3.8 系）。thinking 系モデルで
 *                       「深く考えるほど良いのか」を掃引するための軸
 *
 * thinking を測るときに見るもの:
 * - reasoning の文字数（トークン数は本文と合算でしか返らないので相対比較用）
 * - **THINKING_OVERRUN**: reasoning は出たのに本文が空。latencyS 以前に
 *   「そのモデルとその max_tokens では判断が成立しない」ことを意味する
 * - finish_reason=length の件数（予算での打ち切り）
 */
'use strict';

const fs = require('node:fs');

const DEFAULT_URL_OPENAI = 'http://localhost:11434/v1';
const DEFAULT_URL_OLLAMA = 'http://localhost:11434';

// ---------------------------------------------------------------------------
// プロンプト（commander_prompt.js の体裁に合わせる。定数は core/sim/mission.js と同値）
// ---------------------------------------------------------------------------

const INTERCEPT_RANGE_M = 60;
const ASSET_BREACH_RANGE_M = 80;
const EPISODE_TIME_LIMIT_S = 240;

const COMMANDER_SYSTEM_PROMPT = [
  'You are the DEFENDER commander of uncrewed surface vessels (ASVs).',
  `Protect the asset: you lose if any intruder gets within ${ASSET_BREACH_RANGE_M} m of it.`,
  `A defender neutralises an intruder by closing within ${INTERCEPT_RANGE_M} m of it.`,
  'Coordinates are meters east/north of the protected asset at (0, 0).',
  "You see only your own force's fused sensor picture. Enemy tracks may be stale or missing entirely.",
  'You may issue orders every 10 s. Orders take 3 s to reach your boats;',
  'until then each boat keeps executing its current order.',
  'Reply with ONLY one JSON object:',
  '{"orders": [',
  '  {"boat": "<own boat id>", "action": "intercept", "target": "<track id>"}',
  '  or {"boat": "<own boat id>", "action": "move_to", "waypoint": {"east_m": <num>, "north_m": <num>}}',
  '  or {"boat": "<own boat id>", "action": "patrol", "center": "asset" | {"east_m": <num>, "north_m": <num>}, "radius_m": <num>}',
  '], "intent": "<your plan in at most 12 words>"}',
  'Boats you do not mention keep their current order.',
].join('\n');

const BOAT_SYSTEM_PROMPT = [
  'You are ASV defender-1, an uncrewed surface vessel under a commander.',
  'You may accept your current order or locally amend it using what you see yourself.',
  'Coordinates are meters east/north of the protected asset at (0, 0).',
  'Reply with ONLY one JSON object:',
  '{"accept": true} or {"accept": false, "amend": {"action": "intercept"|"move_to", ' +
    '"target": "<track id>", "waypoint": {"east_m": <num>, "north_m": <num>}}, "why": "<max 8 words>"}',
].join('\n');

/** 決定論的な擬似乱数（Math.random は使わない。core/sim/ の外だが方針を踏襲する） */
function makeRng(seed) {
  let s = seed >>> 0;
  return function next() {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

function fmt(n) {
  return String(Math.round(n));
}

/**
 * 統合図テキスト（commander_prompt.js renderPictureText と同じ体裁）を毎回わずかに変えて作る。
 * 同一プロンプトを繰り返すと prompt eval が KV キャッシュにヒットして消え、
 * 実運用より速い数字が出てしまう。
 */
function makeCommanderUserPrompt(i) {
  const rng = makeRng(0x5eed + i * 7919);
  const t = 12.0 + i * 10.0;
  const boats = ['defender-1', 'defender-2', 'defender-3'].map((id, k) => ({
    id,
    eastM: -300 + rng() * 600 + k * 40,
    northM: -260 + rng() * 520,
    headingDeg: Math.floor(rng() * 360),
    speedMps: 3.5 + rng() * 2.5,
    orderSummary:
      k === 0 ? 'patrol asset r=200' : k === 1 ? 'intercept intruder-1' : 'move_to (180, -140)',
  }));
  const tracks = [
    { id: 'intruder-1', eastM: 380 + rng() * 220, northM: 240 + rng() * 180, ageS: rng() * 3, seenBy: 'defender-3' },
    { id: 'intruder-2', eastM: 560 + rng() * 200, northM: -80 - rng() * 140, ageS: 8 + rng() * 12, seenBy: 'defender-1' },
    { id: 'intruder-3', eastM: -420 - rng() * 160, northM: 150 + rng() * 120, ageS: 1 + rng() * 4, seenBy: 'defender-2' },
  ];
  const lines = [];
  lines.push(`FORCE PICTURE t=${t.toFixed(1)}s — you command: ${boats.map((b) => b.id).join(', ')}`);
  lines.push('ASSET at (0, 0)');
  lines.push('OWN FORCE (truth):');
  for (const b of boats) {
    lines.push(
      `  ${b.id} at (${fmt(b.eastM)}, ${fmt(b.northM)}) heading ${String(b.headingDeg).padStart(3, '0')} ` +
        `speed ${b.speedMps.toFixed(1)} m/s — order: ${b.orderSummary}`
    );
  }
  lines.push('ENEMY TRACKS (fused from own radars; may be stale):');
  for (const tr of [...tracks].sort((a, b) => a.ageS - b.ageS)) {
    lines.push(
      `  ${tr.id} at (${fmt(tr.eastM)}, ${fmt(tr.northM)}) — last seen ${tr.ageS.toFixed(1)}s ago by ${tr.seenBy}`
    );
  }
  lines.push(`TIME ${t.toFixed(1)} / ${EPISODE_TIME_LIMIT_S} s`);
  return lines.join('\n');
}

/** Phase 2（艇レベル）の小さいプロンプト。roadmap §5「小さいプロンプトの持続負荷」用 */
function makeBoatUserPrompt(i) {
  const rng = makeRng(0xb0a7 + i * 6151);
  const t = 12.0 + i * 3.0;
  return [
    `t=${t.toFixed(1)}s  you: defender-1 at (${fmt(-200 + rng() * 400)}, ${fmt(-180 + rng() * 360)}) ` +
      `heading ${String(Math.floor(rng() * 360)).padStart(3, '0')} speed ${(3.5 + rng() * 2.5).toFixed(1)} m/s`,
    'ORDER FROM COMMANDER: intercept intruder-1',
    `LOCAL CONTACTS: intruder-1 at (${fmt(300 + rng() * 200)}, ${fmt(180 + rng() * 160)}) 0.4s ago`,
    `                intruder-2 at (${fmt(120 + rng() * 120)}, ${fmt(-60 - rng() * 100)}) 0.4s ago`,
  ].join('\n');
}

const PROFILES = {
  commander: { system: COMMANDER_SYSTEM_PROMPT, user: makeCommanderUserPrompt },
  boat: { system: BOAT_SYSTEM_PROMPT, user: makeBoatUserPrompt },
};

// ---------------------------------------------------------------------------
// 引数
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const opts = {
    url: null,
    api: 'openai',
    model: null,
    profile: 'commander',
    warm: 12,
    concurrency: [1, 2, 4],
    requests: 12,
    maxTokens: 300,
    cold: true,
    json: null,
    /** null=指定しない（モデル既定） / true / false。Ollama ネイティブの think に対応 */
    think: null,
    /** null=指定しない / 'low'|'medium'|'high'。qwen3.8 系の reasoning_effort */
    reasoningEffort: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--url') opts.url = argv[++i];
    else if (arg === '--api') opts.api = argv[++i];
    else if (arg === '--model') opts.model = argv[++i];
    else if (arg === '--profile') opts.profile = argv[++i];
    else if (arg === '--warm') opts.warm = Number(argv[++i]);
    else if (arg === '--concurrency') {
      const raw = argv[++i];
      opts.concurrency = raw.trim() === '' ? [] : raw.split(',').map(Number);
    } else if (arg === '--requests') opts.requests = Number(argv[++i]);
    else if (arg === '--max-tokens') opts.maxTokens = Number(argv[++i]);
    else if (arg === '--no-cold') opts.cold = false;
    else if (arg === '--json') opts.json = argv[++i];
    else if (arg === '--think') {
      const raw = String(argv[++i]).toLowerCase();
      if (raw !== 'on' && raw !== 'off') throw new Error('--think must be on|off');
      opts.think = raw === 'on';
    } else if (arg === '--reasoning-effort') opts.reasoningEffort = argv[++i];
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (!opts.model) throw new Error('--model is required (e.g. --model qwen2.5:7b)');
  if (opts.api !== 'openai' && opts.api !== 'ollama') throw new Error('--api must be openai|ollama');
  if (!PROFILES[opts.profile]) throw new Error(`--profile must be ${Object.keys(PROFILES).join('|')}`);
  if (opts.reasoningEffort != null && !['low', 'medium', 'high'].includes(opts.reasoningEffort)) {
    throw new Error('--reasoning-effort must be low|medium|high');
  }
  // think の指定は Ollama ネイティブでしか効かない（OpenAI 互換経路では黙って無視される）。
  // 黙って効かないまま「thinking を切って測った」ことにするのが一番まずいので、設定ミスとして落とす。
  if (opts.think != null && opts.api !== 'ollama') {
    throw new Error(
      '--think requires --api ollama. OpenAI 互換経路 (/v1/chat/completions) は think も ' +
        'chat_template_kwargs.enable_thinking も無視することを実測で確認済み ' +
        '(docs/thinking-model-plan.md §2)。'
    );
  }
  if (!opts.url) opts.url = opts.api === 'ollama' ? DEFAULT_URL_OLLAMA : DEFAULT_URL_OPENAI;
  return opts;
}

// ---------------------------------------------------------------------------
// 1リクエスト
// ---------------------------------------------------------------------------

const trimUrl = (u) => u.replace(/\/+$/, '');
const NS_PER_MS = 1e6;

async function oneRequestOpenAI(opts, promptIndex) {
  const profile = PROFILES[opts.profile];
  const startedAt = Date.now();
  const res = await fetch(`${trimUrl(opts.url)}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: opts.model,
      temperature: 0.7,
      max_tokens: opts.maxTokens,
      stream: false,
      ...(opts.reasoningEffort != null ? { reasoning_effort: opts.reasoningEffort } : {}),
      messages: [
        { role: 'system', content: profile.system },
        { role: 'user', content: profile.user(promptIndex) },
      ],
    }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
  const json = await res.json();
  const msg = json?.choices?.[0]?.message ?? {};
  return {
    latencyMs: Date.now() - startedAt,
    promptTokens: json?.usage?.prompt_tokens ?? null,
    // OpenAI 互換の completion_tokens は reasoning と本文の合計。分離できないので合計として扱う
    outputTokens: json?.usage?.completion_tokens ?? null,
    loadMs: null,
    promptEvalMs: null,
    evalMs: null,
    text: msg.content ?? '',
    reasoning: msg.reasoning ?? msg.reasoning_content ?? '',
    finishReason: json?.choices?.[0]?.finish_reason ?? null,
  };
}

async function oneRequestOllama(opts, promptIndex) {
  const profile = PROFILES[opts.profile];
  const startedAt = Date.now();
  const res = await fetch(`${trimUrl(opts.url)}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: opts.model,
      stream: false,
      // think は Ollama ネイティブのみが解釈する。null なら送らない（モデル既定に任せる）
      ...(opts.think != null ? { think: opts.think } : {}),
      options: {
        temperature: 0.7,
        num_predict: opts.maxTokens,
        ...(opts.reasoningEffort != null ? { reasoning_effort: opts.reasoningEffort } : {}),
      },
      messages: [
        { role: 'system', content: profile.system },
        { role: 'user', content: profile.user(promptIndex) },
      ],
    }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
  const json = await res.json();
  return {
    latencyMs: Date.now() - startedAt,
    promptTokens: json?.prompt_eval_count ?? null,
    outputTokens: json?.eval_count ?? null,
    loadMs: json?.load_duration != null ? json.load_duration / NS_PER_MS : null,
    promptEvalMs: json?.prompt_eval_duration != null ? json.prompt_eval_duration / NS_PER_MS : null,
    evalMs: json?.eval_duration != null ? json.eval_duration / NS_PER_MS : null,
    totalMs: json?.total_duration != null ? json.total_duration / NS_PER_MS : null,
    text: json?.message?.content ?? '',
    // Ollama は thinking を本文と別フィールドで返す。合算されたトークン数しか無いので、
    // 「reasoning がどれだけ予算を食ったか」は文字数で相対的に見るしかない
    reasoning: json?.message?.thinking ?? '',
    finishReason: json?.done_reason ?? null,
  };
}

function oneRequest(opts, promptIndex) {
  return opts.api === 'ollama'
    ? oneRequestOllama(opts, promptIndex)
    : oneRequestOpenAI(opts, promptIndex);
}

/** Ollama からモデルを追い出す（コールドスタート計測の前処理） */
async function unloadOllama(opts) {
  const base =
    opts.api === 'ollama' ? trimUrl(opts.url) : trimUrl(opts.url).replace(/\/v1$/, '');
  const res = await fetch(`${base}/api/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: opts.model, keep_alive: 0 }),
  });
  if (!res.ok) throw new Error(`unload failed: HTTP ${res.status}`);
  await res.json().catch(() => null);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ---------------------------------------------------------------------------
// 集計
// ---------------------------------------------------------------------------

/** nearest-rank の分位点。サンプル数が少ないと p95 は実質 max になる点に注意 */
function percentile(sortedAsc, p) {
  if (sortedAsc.length === 0) return null;
  const rank = Math.max(1, Math.ceil((p / 100) * sortedAsc.length));
  return sortedAsc[rank - 1];
}

function stats(values) {
  const xs = values
    .filter((v) => typeof v === 'number' && Number.isFinite(v))
    .slice()
    .sort((a, b) => a - b);
  if (xs.length === 0) return null;
  return {
    n: xs.length,
    min: xs[0],
    p50: percentile(xs, 50),
    p95: percentile(xs, 95),
    max: xs[xs.length - 1],
    mean: xs.reduce((a, v) => a + v, 0) / xs.length,
  };
}

async function runWarmSeries(opts, count, startIndex) {
  const samples = [];
  for (let i = 0; i < count; i++) samples.push(await oneRequest(opts, startIndex + i));
  return samples;
}

async function runBatch(opts, concurrency, requests, startIndex) {
  const results = [];
  const t0 = Date.now();
  let issued = 0;
  async function worker() {
    while (issued < requests) {
      const idx = startIndex + issued;
      issued++;
      results.push(await oneRequest(opts, idx));
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker));
  const wallS = (Date.now() - t0) / 1000;
  const lat = stats(results.map((r) => r.latencyMs));
  const outTokens = results.map((r) => r.outputTokens).filter((n) => n != null);
  const sumOut = outTokens.reduce((a, n) => a + n, 0);
  return {
    concurrency,
    requests: results.length,
    wallS,
    decisionsPerSec: results.length / wallS,
    latencyMs: lat,
    meanOutputTokens: outTokens.length ? sumOut / outTokens.length : null,
    outputTokensPerSec: outTokens.length ? sumOut / wallS : null,
  };
}

function pad(s, n) {
  return String(s).padStart(n);
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const report = { startedAtIso: new Date().toISOString(), opts, cold: null, warm: null, sweep: [] };

  console.log(
    `model=${opts.model} api=${opts.api} url=${opts.url} profile=${opts.profile} ` +
      `warm=${opts.warm} sweep=${opts.concurrency.join(',') || '(skip)'}x${opts.requests} ` +
      `max_tokens=${opts.maxTokens}`
  );

  // --- コールドスタート（モデルの VRAM ロード込みの初回） ---
  if (opts.cold) {
    process.stdout.write('\n[cold] unloading model ... ');
    try {
      await unloadOllama(opts);
      await sleep(1500);
      const first = await oneRequest(opts, 0);
      report.cold = first;
      console.log('done');
      console.log(
        `[cold] first call: ${first.latencyMs} ms` +
          (first.loadMs != null
            ? ` (load ${first.loadMs.toFixed(0)} ms, prompt eval ${first.promptEvalMs?.toFixed(0)} ms, gen ${first.evalMs?.toFixed(0)} ms)`
            : '') +
          ` / out ${first.outputTokens} tok`
      );
    } catch (err) {
      console.log(`skipped (${err.message})`);
    }
  }

  // --- サンプル応答（中身が orders になっているかを目視するため） ---
  const sample = await oneRequest(opts, 1);
  console.log('\n--- sample response ---');
  console.log(sample.text.trim());
  console.log(
    `(latency ${sample.latencyMs} ms, prompt ${sample.promptTokens} tok, output ${sample.outputTokens} tok)`
  );

  // --- ウォーム定常（concurrency=1 の逐次） ---
  const warm = await runWarmSeries(opts, opts.warm, 100);
  const warmLat = stats(warm.map((r) => r.latencyMs));
  const warmOut = stats(warm.map((r) => r.outputTokens));
  const warmPrompt = stats(warm.map((r) => r.promptTokens));
  const genTps = warm
    .filter((r) => r.evalMs != null && r.outputTokens != null && r.evalMs > 0)
    .map((r) => r.outputTokens / (r.evalMs / 1000));
  const e2eTps = warm
    .filter((r) => r.outputTokens != null && r.latencyMs > 0)
    .map((r) => r.outputTokens / (r.latencyMs / 1000));
  // thinking の実測。reasoning は本文と別フィールドで返るがトークン数は合算しか無いので、
  // 予算をどれだけ食ったかは文字数で相対的に見る。
  // 「reasoning は出たのに本文が空」は THINKING_OVERRUN（llm_http.js に足す失敗モードと同義）で、
  // latencyS 以前に「そのモデルとその max_tokens ではそもそも判断が成立しない」ことを意味する。
  const reasoningChars = warm.map((r) => (r.reasoning ?? '').length);
  const thinkingSeen = reasoningChars.some((n) => n > 0);
  const overruns = warm.filter((r) => (r.reasoning ?? '').length > 0 && String(r.text ?? '').trim() === '');
  const lengthCapped = warm.filter((r) => r.finishReason === 'length');
  report.warm = {
    samples: warm,
    latencyMs: warmLat,
    outputTokens: warmOut,
    promptTokens: warmPrompt,
    genTokensPerSec: stats(genTps),
    e2eTokensPerSec: stats(e2eTps),
    thinking: {
      requested: { think: opts.think, reasoningEffort: opts.reasoningEffort },
      seen: thinkingSeen,
      reasoningChars: stats(reasoningChars),
      overrunCount: overruns.length,
      lengthCappedCount: lengthCapped.length,
    },
  };

  console.log(`\n--- warm steady state (concurrency=1, n=${warmLat.n}) ---`);
  console.log(
    `latency  p50 ${warmLat.p50.toFixed(0)} ms / p95 ${warmLat.p95.toFixed(0)} ms / ` +
      `mean ${warmLat.mean.toFixed(0)} ms / min ${warmLat.min.toFixed(0)} / max ${warmLat.max.toFixed(0)}`
  );
  console.log(
    `tokens   prompt mean ${warmPrompt?.mean?.toFixed(0) ?? 'n/a'} / ` +
      `output p50 ${warmOut?.p50 ?? 'n/a'} mean ${warmOut?.mean?.toFixed(1) ?? 'n/a'} max ${warmOut?.max ?? 'n/a'}`
  );
  {
    const t = report.warm.thinking;
    const asked =
      (t.requested.think == null ? 'think=(default)' : `think=${t.requested.think ? 'on' : 'off'}`) +
      (t.requested.reasoningEffort != null ? ` effort=${t.requested.reasoningEffort}` : '');
    if (t.seen) {
      console.log(
        `thinking ${asked} -> OBSERVED. reasoning chars p50 ${t.reasoningChars.p50.toFixed(0)} / ` +
          `mean ${t.reasoningChars.mean.toFixed(0)} / max ${t.reasoningChars.max.toFixed(0)}`
      );
    } else {
      console.log(`thinking ${asked} -> not observed (reasoning フィールドが常に空)`);
    }
    if (t.overrunCount > 0) {
      console.log(
        `  !! THINKING_OVERRUN ${t.overrunCount}/${warmLat.n}: reasoning は出たが本文が空。` +
          `max_tokens=${opts.maxTokens} では判断が成立しない`
      );
    }
    if (t.lengthCappedCount > 0) {
      console.log(`  !! finish_reason=length ${t.lengthCappedCount}/${warmLat.n}: 予算で打ち切られている`);
    }
  }
  if (report.warm.genTokensPerSec) {
    console.log(
      `gen tok/s mean ${report.warm.genTokensPerSec.mean.toFixed(1)} ` +
        `(p50 ${report.warm.genTokensPerSec.p50.toFixed(1)})  |  ` +
        `end-to-end tok/s mean ${report.warm.e2eTokensPerSec.mean.toFixed(1)}`
    );
  } else {
    console.log(
      `end-to-end tok/s mean ${report.warm.e2eTokensPerSec.mean.toFixed(1)} ` +
        `(--api ollama なら生成のみの tok/s も出る)`
    );
  }
  console.log(`decisions/s (c=1) ${(1000 / warmLat.mean).toFixed(2)}`);

  // --- 同時実行スイープ ---
  if (opts.concurrency.length > 0) {
    console.log('\n--- concurrency sweep ---');
    console.log('concurrency | decisions/s | mean ms | p50 ms | p95 ms | mean out tok | out tok/s');
    let idx = 1000;
    for (const c of opts.concurrency) {
      const r = await runBatch(opts, c, opts.requests, idx);
      idx += opts.requests;
      report.sweep.push(r);
      console.log(
        `${pad(r.concurrency, 11)} | ${pad(r.decisionsPerSec.toFixed(2), 11)} | ` +
          `${pad(r.latencyMs.mean.toFixed(0), 7)} | ${pad(r.latencyMs.p50.toFixed(0), 6)} | ` +
          `${pad(r.latencyMs.p95.toFixed(0), 6)} | ${pad(r.meanOutputTokens?.toFixed(1) ?? 'n/a', 12)} | ` +
          `${pad(r.outputTokensPerSec?.toFixed(1) ?? 'n/a', 9)}`
      );
    }
    const best = report.sweep.reduce((a, b) => (b.decisionsPerSec > a.decisionsPerSec ? b : a));
    console.log(
      `\nbest throughput: ${best.decisionsPerSec.toFixed(2)} decisions/s at concurrency=${best.concurrency}`
    );
    // docs/development-roadmap.md §5 の Phase 2 着手ゲート
    const GATE_DECISIONS_PER_SEC = 6.6;
    const ratio = best.decisionsPerSec / GATE_DECISIONS_PER_SEC;
    console.log(
      `Phase 2 gate (roadmap §5: 6艇 intervalS=3s × TIME_SCALE=3 = ${GATE_DECISIONS_PER_SEC} 回/秒): ` +
        (ratio >= 1
          ? `達成（${ratio.toFixed(2)}倍）`
          : `未達（ゲートの ${(ratio * 100).toFixed(0)}%＝${(1 / ratio).toFixed(1)}倍足りない）`)
    );
  }

  console.log(
    `\nlatencyS の目安（ウォーム）: p50 ${(warmLat.p50 / 1000).toFixed(1)}s / ` +
      `p95 ${(warmLat.p95 / 1000).toFixed(1)}s / mean ${(warmLat.mean / 1000).toFixed(1)}s`
  );

  if (opts.json) {
    fs.writeFileSync(opts.json, JSON.stringify(report, null, 2), 'utf8');
    console.log(`raw results -> ${opts.json}`);
  }
}

main().catch((err) => {
  console.error('llm_probe failed:', err.message);
  process.exit(1);
});
