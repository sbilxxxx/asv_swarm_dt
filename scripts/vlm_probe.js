/**
 * vlm_probe.js — 海域デジタルツインの実レンダ画像でVLMを計測する（docs/l1-vlm-navigator-plan.md Task 1）
 *
 * 2026-08-14 のスモークは合成画像1枚（640×360の手描き相当）だった。この本計測は
 * **digital-twin/ が実際に描いているブリッジ一人称の絵**をそのまま VLM に渡し、
 *   A. グラウンディング（何がどちら側に見えるか）
 *   B. 航路判断（画像＋自船状態＋レーダー＋目的地 → keep/replace の航路プランJSON）
 *   C. 同じテキストで画像なし（統制群。画像が判断を変えているかの切り分け）
 * を解像度2水準で測る。得られる数字が l1 計画の宣言値（renderS / inferS / intervalS）の根拠になる。
 *
 * 画像は Puppeteer で digital-twin/ を headless 起動し、既存の ThreeCameraSensor
 * （world.observe(hero,'camera')）で撮る。撮影時だけ renderer を指定解像度に切り替えるので、
 * 表示用canvasのサイズに依存しない固定解像度が得られる（計画 §4 の「固定解像度オフスクリーン」）。
 * digital-twin/ 側のコードは変更していない（window.__debug フック経由）。
 *
 * 使い方:
 *   node scripts/vlm_probe.js --model qwen2.5vl:7b
 *   node scripts/vlm_probe.js --model qwen2.5vl:7b --samples 3 --res 640x360,384x216
 *
 *   --model NAME     既定 qwen2.5vl:7b
 *   --url URL        OpenAI互換ベースURL。既定 http://localhost:11434/v1
 *   --samples N      サンプル数（サンプルごとにシムを進めて別の絵を撮る）。既定 3
 *   --res LIST       解像度リスト。既定 640x360,384x216
 *   --advance-ms MS  サンプル間にシムを走らせる実時間。既定 4000
 *   --settle-ms MS   ページ読み込み後に待つ時間。既定 5000
 *   --max-tokens N   既定 400
 *   --timeout-ms N   1コールの締切。既定 60000（コールドスタート12s実測を飲み込む）
 *   --out-dir DIR    画像とJSONLの出力先。既定 logs/vlm-probe-<YYYY-MM-DD>
 *   --no-grounding   プロンプトA（グラウンディング）を省く
 *   --port N         静的配信ポート。既定 8973
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');

const ROOT = path.resolve(__dirname, '..');
const MIME = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.json': 'application/json',
  '.css': 'text/css',
  '.png': 'image/png',
  '.gif': 'image/gif',
};

function parseArgs(argv) {
  const o = {
    model: 'qwen2.5vl:7b',
    url: 'http://localhost:11434/v1',
    samples: 3,
    res: [
      { w: 640, h: 360 },
      { w: 384, h: 216 },
    ],
    advanceMs: 4000,
    settleMs: 5000,
    maxTokens: 400,
    timeoutMs: 60000,
    outDir: null,
    grounding: true,
    port: 8973,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--model') o.model = argv[++i];
    else if (a === '--url') o.url = argv[++i];
    else if (a === '--samples') o.samples = Number(argv[++i]);
    else if (a === '--advance-ms') o.advanceMs = Number(argv[++i]);
    else if (a === '--settle-ms') o.settleMs = Number(argv[++i]);
    else if (a === '--max-tokens') o.maxTokens = Number(argv[++i]);
    else if (a === '--timeout-ms') o.timeoutMs = Number(argv[++i]);
    else if (a === '--out-dir') o.outDir = argv[++i];
    else if (a === '--no-grounding') o.grounding = false;
    else if (a === '--port') o.port = Number(argv[++i]);
    else if (a === '--res') {
      o.res = argv[++i].split(',').map((s) => {
        const m = /^(\d+)x(\d+)$/.exec(s.trim());
        if (!m) throw new Error(`--res の形式は 640x360 のようにする: ${s}`);
        return { w: Number(m[1]), h: Number(m[2]) };
      });
    } else if (a === '--help') {
      console.log(fs.readFileSync(__filename, 'utf8').split('*/')[0]);
      process.exit(0);
    } else throw new Error(`unknown option: ${a}`);
  }
  if (!o.outDir) {
    const d = new Date();
    const stamp = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    o.outDir = path.join(ROOT, 'logs', `vlm-probe-${stamp}`);
  }
  return o;
}

function startServer(port) {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      let filePath = path.join(ROOT, decodeURIComponent(req.url.split('?')[0]));
      if (filePath.endsWith(path.sep)) filePath = path.join(filePath, 'index.html');
      fs.readFile(filePath, (err, data) => {
        if (err) {
          res.writeHead(404);
          res.end('not found: ' + filePath);
          return;
        }
        res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream' });
        res.end(data);
      });
    });
    server.on('error', reject);
    server.listen(port, () => resolve(server));
  });
}

// ---------------------------------------------------------------------------
// プロンプト
// ---------------------------------------------------------------------------

const GROUNDING_SYSTEM = [
  'You are a lookout on the bridge of an uncrewed surface vessel (ASV).',
  'You describe only what is visible in the camera image. You never invent objects.',
  'Answer with a single JSON object and nothing else.',
].join(' ');

const GROUNDING_USER = [
  'This is the forward-looking bridge camera of your own ship.',
  'Report what you can see, as JSON:',
  '{"horizonVisible": true|false, "land": {"visible": true|false, "side": "left"|"ahead"|"right"|null},',
  ' "vessels": [{"side": "left"|"ahead"|"right", "horizontalPercent": 0-100, "distance": "near"|"mid"|"far"}],',
  ' "otherObjects": [{"what": "...", "side": "left"|"ahead"|"right", "horizontalPercent": 0-100}]}',
  'horizontalPercent is measured left(0) to right(100) across the image.',
].join('\n');

const NAV_SYSTEM = [
  'You are the navigator of an uncrewed surface vessel (ASV) in coastal water.',
  'You are given the forward bridge camera image, own-ship state, radar contacts and the destination.',
  'Coordinates are metres in a scene frame: east = +x, north = +y. Heading is degrees, 0 = east, counter-clockwise.',
  'Your job is to keep a safe route to the destination.',
  'Reply with ONE JSON object and nothing else:',
  '{"watch": "<one line: the hazard you can see, or none>",',
  ' "action": "keep" | "replace",',
  ' "waypoints": [{"eastM": <number>, "northM": <number>}],',
  ' "speed": "stop" | "slow" | "cruise"}',
  'Use "keep" when the current plan is still safe; then waypoints must be [].',
  'Use "replace" only when you must change the route; give 1-3 waypoints in order, absolute scene metres,',
  'never your own current position, and the last one at or near the destination.',
].join('\n');

function navUserPrompt(sit, withImage) {
  const lines = [];
  lines.push(`Time: t=${sit.clock.toFixed(1)} s`);
  lines.push(
    `Own ship (GNSS): east=${sit.self.eastM.toFixed(0)} m, north=${sit.self.northM.toFixed(0)} m, ` +
      `heading=${sit.self.headingDeg.toFixed(0)} deg, speed=${sit.self.speedMps.toFixed(1)} m/s`
  );
  lines.push(
    `Destination: east=${sit.destination.eastM.toFixed(0)} m, north=${sit.destination.northM.toFixed(0)} m ` +
      `(range ${sit.destination.rangeM.toFixed(0)} m, ${sit.destination.relative}), arrival radius 40 m`
  );
  if (sit.radar.contacts.length === 0) {
    lines.push('Radar: no contacts.');
  } else {
    lines.push(`Radar (range ${sit.radar.rangeM} m):`);
    for (const c of sit.radar.contacts) {
      lines.push(
        `  - ${c.id}: range ${c.rangeM.toFixed(0)} m, relative bearing ${c.relBearingDeg.toFixed(0)} deg ` +
          `(${c.relative}), at east=${c.eastM.toFixed(0)}, north=${c.northM.toFixed(0)}`
      );
    }
  }
  lines.push('Land: the coast runs along the north side of the area. Open water is to the south.');
  lines.push(
    `Current plan: ${sit.plan.map((p) => `(${p.eastM.toFixed(0)},${p.northM.toFixed(0)})`).join(' -> ')} ` +
      `[${sit.plan.length} waypoint(s), direct to destination]`
  );
  lines.push(
    withImage
      ? 'The attached image is the bridge camera looking straight ahead over the bow.'
      : 'No camera image is available this cycle.'
  );
  lines.push('Decide now.');
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// 推論呼び出し（OpenAI互換 image_url。core/sim/agents/llm_http.js の画像対応版の先取り）
// ---------------------------------------------------------------------------

async function chat({ url, model, systemPrompt, userPrompt, imageDataUrl, maxTokens, timeoutMs }) {
  const content = imageDataUrl
    ? [
        { type: 'text', text: userPrompt },
        { type: 'image_url', image_url: { url: imageDataUrl } },
      ]
    : userPrompt;
  const body = {
    model,
    temperature: 0.2,
    max_tokens: maxTokens,
    stream: false,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content },
    ],
  };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const t0 = Date.now();
  try {
    const res = await fetch(`${url.replace(/\/+$/, '')}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const elapsedMs = Date.now() - t0;
    if (!res.ok) {
      const snippet = (await res.text().catch(() => '')).slice(0, 200);
      return { ok: false, kind: 'http_status', elapsedMs, error: `HTTP ${res.status}: ${snippet}` };
    }
    const json = await res.json();
    const text = json?.choices?.[0]?.message?.content ?? '';
    return {
      ok: text.trim() !== '',
      kind: text.trim() === '' ? 'empty_content' : null,
      elapsedMs: Date.now() - t0,
      text,
      promptTokens: json?.usage?.prompt_tokens ?? null,
      outputTokens: json?.usage?.completion_tokens ?? null,
      finishReason: json?.choices?.[0]?.finish_reason ?? null,
    };
  } catch (err) {
    return {
      ok: false,
      kind: err?.name === 'AbortError' ? 'timeout' : 'connection',
      elapsedMs: Date.now() - t0,
      error: String(err?.message ?? err),
    };
  } finally {
    clearTimeout(timer);
  }
}

/** ```json フェンス付きで返るのは実測済み（計画 §2）。剥がしてから JSON.parse する */
function parseJsonLoose(text) {
  if (typeof text !== 'string') return null;
  let s = text.trim();
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(s);
  if (fence) s = fence[1].trim();
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(s.slice(start, end + 1));
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// ページ側フック（digital-twin/ は無変更。window.__debug 経由で撮る）
// ---------------------------------------------------------------------------

const INSTALL_HOOK = `
window.__vlmProbe = {
  capture(w, h) {
    const { three, world } = window.__debug;
    const heroId = world.state.id[0];
    const i = world.state.indexOf(heroId);
    const renderer = three.renderer;
    const canvas = renderer.domElement;
    const prevW = canvas.clientWidth;
    const prevH = canvas.clientHeight;

    // 撮影のあいだだけ固定解像度にする（表示用canvasのサイズに依存させない）
    renderer.setPixelRatio(1);
    renderer.setSize(w, h, false);
    three.sensorCamera.aspect = w / Math.max(h, 1);
    three.sensorCamera.updateProjectionMatrix();
    const cam = world.observe(heroId, 'camera');
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(prevW, prevH, false);
    three.resize();

    const gnss = world.observe(heroId, 'gnss');
    const radar = world.observe(heroId, 'radar');
    return {
      imageDataUrl: cam ? cam.imageDataUrl : null,
      clock: world.clock,
      heroId,
      self: {
        eastM: world.state.x[i],
        northM: world.state.y[i],
        headingDeg: gnss.headingDeg,
        speedMps: gnss.speedMps,
        lat: gnss.lat,
        lon: gnss.lon,
      },
      destination: world.protectedAsset
        ? { eastM: world.protectedAsset.x, northM: world.protectedAsset.y }
        : null,
      radar: {
        rangeM: radar.rangeM,
        contacts: radar.contacts.map((c) => ({
          id: c.id,
          faction: c.faction,
          rangeM: c.rangeM,
          bearingDeg: (c.bearingRad * 180) / Math.PI,
        })),
      },
    };
  },
  pause(v) { window.__debug.paused = v; },
};
true;
`;

function wrapDeg(d) {
  return (((d + 180) % 360) + 360) % 360 - 180;
}

function relativeSide(relBearingDeg) {
  const b = wrapDeg(relBearingDeg);
  if (Math.abs(b) <= 15) return 'dead ahead';
  if (b > 15 && b <= 112.5) return 'on the port bow / port side';
  if (b < -15 && b >= -112.5) return 'on the starboard bow / starboard side';
  return 'astern';
}

/** ページから来た生の観測を、プロンプトに載る「状況図」に整える */
function buildSituation(raw) {
  const self = raw.self;
  const dest = raw.destination ?? { eastM: self.eastM + 500, northM: self.northM - 300 };
  const dx = dest.eastM - self.eastM;
  const dy = dest.northM - self.northM;
  const destBearing = (Math.atan2(dy, dx) * 180) / Math.PI;
  const contacts = raw.radar.contacts.map((c) => {
    const rel = wrapDeg(c.bearingDeg - self.headingDeg);
    return {
      id: c.id,
      rangeM: c.rangeM,
      relBearingDeg: rel,
      relative: relativeSide(rel),
      eastM: self.eastM + Math.cos((c.bearingDeg * Math.PI) / 180) * c.rangeM,
      northM: self.northM + Math.sin((c.bearingDeg * Math.PI) / 180) * c.rangeM,
    };
  });
  return {
    clock: raw.clock,
    self,
    destination: {
      ...dest,
      rangeM: Math.hypot(dx, dy),
      bearingDeg: destBearing,
      relative: relativeSide(destBearing - self.headingDeg),
    },
    radar: { rangeM: raw.radar.rangeM, contacts },
    plan: [dest],
  };
}

function stats(values) {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const q = (p) => s[Math.min(s.length - 1, Math.floor(p * s.length))];
  return {
    n: s.length,
    minMs: s[0],
    p50Ms: q(0.5),
    p95Ms: q(0.95),
    maxMs: s[s.length - 1],
    meanMs: Math.round(s.reduce((a, b) => a + b, 0) / s.length),
  };
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  fs.mkdirSync(opts.outDir, { recursive: true });
  const callLog = fs.createWriteStream(path.join(opts.outDir, 'calls.jsonl'), { flags: 'a' });
  const record = (row) => callLog.write(JSON.stringify(row) + '\n');

  const puppeteer = require(path.join(ROOT, '.devtools', 'node_modules', 'puppeteer'));
  const server = await startServer(opts.port);
  const browser = await puppeteer.launch({
    headless: 'shell',
    args: [
      '--headless=new',
      '--use-angle=swiftshader',
      '--enable-unsafe-swiftshader',
      '--enable-webgl',
      '--ignore-gpu-blocklist',
      '--disable-gpu-sandbox',
      '--no-sandbox',
    ],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 960, height: 720 });
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(String(e.message)));

  console.log(`[probe] model=${opts.model} url=${opts.url}`);
  console.log(`[probe] opening http://localhost:${opts.port}/digital-twin/ ...`);
  await page.goto(`http://localhost:${opts.port}/digital-twin/`, { waitUntil: 'domcontentloaded', timeout: 20000 });
  await page.waitForFunction('window.__debug && window.__debug.world && window.__debug.world.state.count > 0', {
    timeout: 30000,
  });
  await new Promise((r) => setTimeout(r, opts.settleMs));
  await page.evaluate(INSTALL_HOOK);

  const results = [];
  let callIndex = 0;

  for (let sample = 0; sample < opts.samples; sample++) {
    if (sample > 0) {
      await page.evaluate('window.__vlmProbe.pause(false)');
      await new Promise((r) => setTimeout(r, opts.advanceMs));
    }
    await page.evaluate('window.__vlmProbe.pause(true)');

    for (const res of opts.res) {
      const tRender0 = Date.now();
      const raw = await page.evaluate(`window.__vlmProbe.capture(${res.w}, ${res.h})`);
      const renderMs = Date.now() - tRender0;
      if (!raw.imageDataUrl) throw new Error('camera sensor returned no image');

      const bytes = Buffer.from(raw.imageDataUrl.split(',')[1], 'base64');
      const imgName = `s${sample}_${res.w}x${res.h}.png`;
      fs.writeFileSync(path.join(opts.outDir, imgName), bytes);

      const sit = buildSituation(raw);
      console.log(
        `\n=== sample ${sample} @ ${res.w}x${res.h} === t=${sit.clock.toFixed(1)}s ` +
          `own(${sit.self.eastM.toFixed(0)},${sit.self.northM.toFixed(0)}) hdg ${sit.self.headingDeg.toFixed(0)}deg ` +
          `contacts=${sit.radar.contacts.length} image ${(bytes.length / 1024).toFixed(0)}KB render ${renderMs}ms -> ${imgName}`
      );

      if (opts.grounding) {
        const r = await chat({
          url: opts.url,
          model: opts.model,
          systemPrompt: GROUNDING_SYSTEM,
          userPrompt: GROUNDING_USER,
          imageDataUrl: raw.imageDataUrl,
          maxTokens: opts.maxTokens,
          timeoutMs: opts.timeoutMs,
        });
        callIndex++;
        record({ callIndex, sample, res: `${res.w}x${res.h}`, prompt: 'A-grounding', image: imgName, ...r });
        results.push({ prompt: 'A-grounding', res: `${res.w}x${res.h}`, sample, ...r });
        console.log(
          `  [A grounding] ${r.ok ? 'ok' : 'FAIL ' + r.kind} ${r.elapsedMs}ms ` +
            `prompt_tokens=${r.promptTokens ?? '?'} out=${r.outputTokens ?? '?'}`
        );
        console.log('    ' + (r.ok ? JSON.stringify(parseJsonLoose(r.text) ?? r.text.slice(0, 300)) : r.error));
      }

      const navUser = navUserPrompt(sit, true);
      const rb = await chat({
        url: opts.url,
        model: opts.model,
        systemPrompt: NAV_SYSTEM,
        userPrompt: navUser,
        imageDataUrl: raw.imageDataUrl,
        maxTokens: opts.maxTokens,
        timeoutMs: opts.timeoutMs,
      });
      callIndex++;
      const planB = rb.ok ? parseJsonLoose(rb.text) : null;
      record({
        callIndex,
        sample,
        res: `${res.w}x${res.h}`,
        prompt: 'B-nav',
        image: imgName,
        situation: sit,
        userPrompt: navUser,
        parsed: planB,
        ...rb,
      });
      results.push({ prompt: 'B-nav', res: `${res.w}x${res.h}`, sample, parsed: planB, ...rb });
      console.log(
        `  [B nav+image] ${rb.ok ? 'ok' : 'FAIL ' + rb.kind} ${rb.elapsedMs}ms ` +
          `prompt_tokens=${rb.promptTokens ?? '?'} out=${rb.outputTokens ?? '?'} parse=${planB ? 'ok' : 'FAILED'}`
      );
      console.log('    ' + (rb.ok ? JSON.stringify(planB ?? rb.text.slice(0, 300)) : rb.error));

      // 統制群: 同じテキスト・画像なし
      const rc = await chat({
        url: opts.url,
        model: opts.model,
        systemPrompt: NAV_SYSTEM,
        userPrompt: navUserPrompt(sit, false),
        imageDataUrl: null,
        maxTokens: opts.maxTokens,
        timeoutMs: opts.timeoutMs,
      });
      callIndex++;
      const planC = rc.ok ? parseJsonLoose(rc.text) : null;
      record({ callIndex, sample, res: `${res.w}x${res.h}`, prompt: 'C-blind', parsed: planC, ...rc });
      results.push({ prompt: 'C-blind', res: `${res.w}x${res.h}`, sample, parsed: planC, ...rc });
      console.log(
        `  [C blind]     ${rc.ok ? 'ok' : 'FAIL ' + rc.kind} ${rc.elapsedMs}ms ` +
          `prompt_tokens=${rc.promptTokens ?? '?'} out=${rc.outputTokens ?? '?'} parse=${planC ? 'ok' : 'FAILED'}`
      );
      console.log('    ' + (rc.ok ? JSON.stringify(planC ?? rc.text.slice(0, 300)) : rc.error));
    }
  }

  console.log('\n================ summary ================');
  const groups = new Map();
  for (const r of results) {
    const key = `${r.prompt} @ ${r.res}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r);
  }
  const summary = [];
  for (const [key, rows] of groups) {
    const okRows = rows.filter((r) => r.ok);
    const lat = stats(okRows.map((r) => r.elapsedMs));
    const warm = stats(okRows.slice(1).map((r) => r.elapsedMs)); // 1本目はコールド寄り
    const promptTok = okRows.map((r) => r.promptTokens).filter((v) => Number.isFinite(v));
    const line = {
      key,
      n: rows.length,
      ok: okRows.length,
      parsedOk: rows.filter((r) => r.parsed).length,
      latency: lat,
      warmLatency: warm,
      promptTokensMedian: promptTok.length ? promptTok.sort((a, b) => a - b)[Math.floor(promptTok.length / 2)] : null,
    };
    summary.push(line);
    console.log(
      `${key.padEnd(24)} ok ${okRows.length}/${rows.length} ` +
        `p50 ${lat ? lat.p50Ms : '-'}ms max ${lat ? lat.maxMs : '-'}ms ` +
        `warm p50 ${warm ? warm.p50Ms : '-'}ms prompt_tokens~${line.promptTokensMedian ?? '?'}`
    );
  }
  fs.writeFileSync(
    path.join(opts.outDir, 'summary.json'),
    JSON.stringify({ options: opts, summary, pageErrors }, null, 2)
  );
  console.log(`\n[probe] images + calls.jsonl + summary.json -> ${path.relative(ROOT, opts.outDir)}`);
  if (pageErrors.length) console.log('[probe] page errors:', pageErrors);

  callLog.end();
  await browser.close();
  server.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
