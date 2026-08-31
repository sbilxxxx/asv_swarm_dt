/**
 * vlm_id_probe.js — 艦種の視覚識別が成立する距離を測る（docs/vlm-multi-agent-plan.md の Step 0）
 *
 * 測る問い: **レーダーには点しか映らない艦種を、カメラでどこまで見分けられるか。**
 * flag_defence_squadrons では重装艇(heavy)1隻だけが旗を壊せるが、radar.js は艦種を返さない
 * （設計上の意図。core/sim/sensors/radar.js 末尾）。一方 scene_builder.js は艦種を見た目で
 * 描き分けている（scale 0.82/1.0/1.32・積荷クレートの有無と大きさ）。
 * つまり「カメラだけが解ける識別問題」が既に仕込まれている——が、**何メートルまで解けるかは未実測**。
 * VLM を艇に載せる設計（案A/C）はこの距離に依存して成否が決まるので、実装より先にここを測る。
 *
 * 作りの制約（vlm_probe.js / vlm_navigator_run.js と同じ）:
 * - digital-twin/ と core/ は無変更。window.__debug のフック経由で配置・撮影する
 * - 推論は Node 側（ブラウザから Ollama を叩かない）
 * - シムは進めない。1枚ごとに「観測艇と標的艇だけを所定の距離・姿勢に置いて撮る」静的な配置
 *
 * アーム（同じ場面を2通りのカメラで撮る）:
 *   wide  現行のブリッジ一人称カメラ（sensorCamera fov 70°）
 *   zoom  識別用の望遠（fov を狭める）。レーダーが方位を与える前提の「指向された目」
 *
 * 使い方:
 *   node scripts/vlm_id_probe.js --stage-only                 # 画像だけ作って目視確認（推論なし）
 *   node scripts/vlm_id_probe.js --model qwen2.5vl:7b --samples 3
 *
 *   --model NAME        既定 qwen2.5vl:7b
 *   --url URL           既定 http://localhost:11434/v1
 *   --distances LIST    既定 100,200,300,400,600 （m）
 *   --classes LIST      既定 heavy,runner,scout
 *   --arms LIST         既定 wide,zoom
 *   --aspect beam|bow   標的の姿勢。既定 beam（真横＝最も見分けやすい条件）
 *   --samples N         1条件あたりの推論回数。既定 3
 *   --res WxH           既定 640x360
 *   --zoom-fov DEG      zoom アームの垂直画角。既定 20
 *   --max-tokens N      既定 200
 *   --timeout-ms N      既定 60000
 *   --stage-only        画像生成だけ行い推論しない
 *   --out-dir DIR       既定 logs/vlm-id-<YYYY-MM-DD_HHMM>
 *   --port N            既定 8976
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');

const ROOT = path.resolve(__dirname, '..');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.css': 'text/css', '.png': 'image/png', '.gif': 'image/gif' };
const SCENARIO = 'flag_defence_squadrons';
const OBSERVER_ID = 'def-scout';
/** 標的（侵入側）。艦種→艇id。scene_builder は faction で船体色を変えるので侵入側で揃える */
const TARGET_BY_CLASS = { heavy: 'int-heavy', runner: 'int-runner-1', scout: 'int-scout' };

function parseArgs(argv) {
  const o = {
    model: 'qwen2.5vl:7b',
    url: 'http://localhost:11434/v1',
    distances: [100, 200, 300, 400, 600],
    classes: ['heavy', 'runner', 'scout'],
    arms: ['wide', 'zoom'],
    aspect: 'beam',
    samples: 3,
    res: { w: 640, h: 360 },
    zoomFovDeg: 20,
    maxTokens: 200,
    timeoutMs: 60000,
    stageOnly: false,
    outDir: null,
    port: 8976,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--model') o.model = argv[++i];
    else if (a === '--url') o.url = argv[++i];
    else if (a === '--distances') o.distances = argv[++i].split(',').map(Number);
    else if (a === '--classes') o.classes = argv[++i].split(',');
    else if (a === '--arms') o.arms = argv[++i].split(',');
    else if (a === '--aspect') o.aspect = argv[++i];
    else if (a === '--samples') o.samples = Number(argv[++i]);
    else if (a === '--zoom-fov') o.zoomFovDeg = Number(argv[++i]);
    else if (a === '--max-tokens') o.maxTokens = Number(argv[++i]);
    else if (a === '--timeout-ms') o.timeoutMs = Number(argv[++i]);
    else if (a === '--stage-only') o.stageOnly = true;
    else if (a === '--out-dir') o.outDir = argv[++i];
    else if (a === '--port') o.port = Number(argv[++i]);
    else if (a === '--res') {
      const m = /^(\d+)x(\d+)$/.exec(argv[++i]);
      if (!m) throw new Error('--res の形式は 640x360');
      o.res = { w: Number(m[1]), h: Number(m[2]) };
    } else if (a === '--help') {
      console.log(fs.readFileSync(__filename, 'utf8').split('*/')[0]);
      process.exit(0);
    } else throw new Error(`unknown option: ${a}`);
  }
  if (!['beam', 'bow'].includes(o.aspect)) throw new Error('--aspect は beam|bow');
  for (const c of o.classes) if (!TARGET_BY_CLASS[c]) throw new Error(`未知の艦種: ${c}`);
  if (!o.outDir) {
    const d = new Date();
    const p = (n) => String(n).padStart(2, '0');
    o.outDir = path.join(ROOT, 'logs', `vlm-id-${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}`);
  }
  return o;
}

function startServer(port) {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      let filePath = path.join(ROOT, decodeURIComponent(req.url.split('?')[0]));
      if (filePath.endsWith(path.sep)) filePath = path.join(filePath, 'index.html');
      fs.readFile(filePath, (err, data) => {
        if (err) { res.writeHead(404); res.end('not found: ' + filePath); return; }
        res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] ?? 'application/octet-stream' });
        res.end(data);
      });
    });
    server.on('error', reject);
    server.listen(port, () => resolve(server));
  });
}

// ---------------------------------------------------------------------------
// ページ側（digital-twin/ は無変更）
//
// 「観測艇と標的艇だけを置いて撮る」。他艇は Group.visible=false で消す——
// state.snapshot() が死んだ艇を落とすのに updateShips は Group を消さない、という
// 既知の穴（計画 §6.2）と同じ処置をここでも要る形で行う。
// ---------------------------------------------------------------------------
const INSTALL = `
window.__idProbe = (() => {
  const { three, world } = window.__debug;
  window.__debug.paused = true;

  const asset = world.protectedAsset ?? { x: 0, y: 0 };
  const OBS = ${JSON.stringify(OBSERVER_ID)};

  function groupOf(id) { return three.scene3d.getObjectByName('ship-' + id); }

  function showOnly(ids) {
    for (let i = 0; i < world.state.count; i++) {
      const g = groupOf(world.state.id[i]);
      if (g) g.visible = ids.includes(world.state.id[i]);
    }
  }

  /** 標的の画面上の大きさ（px）。Box3 の8隅を sensorCamera へ投影して外接矩形を取る */
  function screenExtent(id, w, h) {
    const g = groupOf(id);
    if (!g || !g.visible) return null;
    const cam = three.sensorCamera;
    // Vector3 の型は three を import 済みのページ側オブジェクトから借りる（このスクリプトは three を import しない）
    const V = g.position.constructor;
    // 子メッシュの geometry.boundingBox の8隅をワールド→スクリーンへ写して外接矩形を取る
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity, any = false;
    g.updateWorldMatrix(true, true);
    g.traverse((o) => {
      if (!o.isMesh || !o.geometry) return;
      // 航跡・船首波（水面に寝かせた加算合成の平面。船体の 2 倍以上の広がりを持つ）は数えない。
      // 数えると「艦種を見分けられる大きさ」の指標が航跡の長さで水増しされる。
      // 判別条件は depthWrite:false（scene_builder.js が wakeMat にだけ立てている）。
      if (o.material && o.material.depthWrite === false) return;
      if (!o.geometry.boundingBox) o.geometry.computeBoundingBox();
      const bb = o.geometry.boundingBox;
      for (const cx of [bb.min.x, bb.max.x]) for (const cy of [bb.min.y, bb.max.y]) for (const cz of [bb.min.z, bb.max.z]) {
        const p = new V(cx, cy, cz);
        o.localToWorld(p);
        p.project(cam);
        const sx = (p.x * 0.5 + 0.5) * w;
        const sy = (-p.y * 0.5 + 0.5) * h;
        if (p.z > 1) continue; // カメラ後方
        minX = Math.min(minX, sx); maxX = Math.max(maxX, sx);
        minY = Math.min(minY, sy); maxY = Math.max(maxY, sy);
        any = true;
      }
    });
    if (!any) return null;
    return { wPx: maxX - minX, hPx: maxY - minY, cx: (minX + maxX) / 2, cy: (minY + maxY) / 2 };
  }

  function setPose(id, x, y, headingRad, speed) {
    const i = world.state.indexOf(id);
    if (i < 0) throw new Error('no such entity: ' + id);
    world.state.x[i] = x; world.state.y[i] = y;
    world.state.heading[i] = headingRad; world.state.speed[i] = speed;
    world.state.alive[i] = true;
    return i;
  }

  return {
    /**
     * 観測艇と標的艇だけを置いて1枚撮る。
     * 観測艇はアセットの西 200m に置き、真東（heading 0）を向く＝外洋側を見る（北は海岸線）。
     * 標的は正面 distanceM の位置。aspect='beam' で真横（船首を北）、'bow' で正面（船首をこちらへ）。
     */
    shot({ targetId, distanceM, aspect, fovDeg, w, h }) {
      const obsX = asset.x - 200, obsY = asset.y, obsHeading = 0; // +x = 東
      setPose(OBS, obsX, obsY, obsHeading, 3.0);
      const tx = obsX + Math.cos(obsHeading) * distanceM;
      const ty = obsY + Math.sin(obsHeading) * distanceM;
      const tHeading = aspect === 'beam' ? Math.PI / 2 : Math.PI; // 北向き（真横）／西向き（船首こちら）
      setPose(targetId, tx, ty, tHeading, 4.0);
      showOnly([OBS, targetId]);

      // 近傍海面パッチ・影のカメラは注視点へ 8%/回でしか寄らない（08-30 スモークの実測）。
      // 静止配置なので、収束するまで空回しする。ここを省くと海の無い絵（陸色）が写る。
      const snap = [
        { id: OBS, faction: world.state.faction[world.state.indexOf(OBS)], shipClass: world.state.shipClass[world.state.indexOf(OBS)], x: obsX, y: obsY, heading: obsHeading, speed: 3.0 },
        { id: targetId, faction: world.state.faction[world.state.indexOf(targetId)], shipClass: world.state.shipClass[world.state.indexOf(targetId)], x: tx, y: ty, heading: tHeading, speed: 4.0 },
      ];
      for (let k = 0; k < 80; k++) three.updateShips(snap, 0);

      const renderer = three.renderer;
      const canvas = renderer.domElement;
      const prevW = canvas.clientWidth, prevH = canvas.clientHeight, prevFov = three.sensorCamera.fov;
      renderer.setPixelRatio(1);
      renderer.setSize(w, h, false);
      three.sensorCamera.fov = fovDeg;
      three.sensorCamera.aspect = w / Math.max(h, 1);
      three.sensorCamera.updateProjectionMatrix();
      const cam = world.observe(OBS, 'camera');   // ThreeCameraSensor をそのまま使う
      const extent = screenExtent(targetId, w, h);
      three.sensorCamera.fov = prevFov;
      renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
      renderer.setSize(prevW, prevH, false);
      three.resize();

      const radar = world.observe(OBS, 'radar');
      return {
        imageDataUrl: cam ? cam.imageDataUrl : null,
        extent,
        observer: { eastM: obsX, northM: obsY, headingDeg: 0 },
        target: { id: targetId, eastM: tx, northM: ty, headingDeg: (tHeading * 180) / Math.PI },
        radarSeesTarget: (radar.contacts ?? []).some((c) => c.id === targetId),
        radarRangeM: radar.rangeM,
      };
    },

    /** 俯瞰1枚（配置そのものの目視確認用） */
    overview({ targetId, distanceM }) {
      const obsX = asset.x - 200, obsY = asset.y;
      const midX = obsX + distanceM / 2;
      three.overviewCamera.position.set(midX, distanceM * 0.9 + 60, -obsY + distanceM * 0.8);
      three.overviewCamera.lookAt(midX, 0, -obsY);
      three.render(0);
      return three.renderer.domElement.toDataURL('image/png');
    },
  };
})();
true;
`;

// ---------------------------------------------------------------------------
// プロンプト（識別だけを訊く。航路や座標は一切訊かない＝VLM に幾何を作らせない方針）
// ---------------------------------------------------------------------------
const ID_SYSTEM = [
  'You are the lookout on an uncrewed surface vessel (ASV). You are shown the forward camera image.',
  'One other vessel is visible ahead. Radar gives you its range and bearing but NOT its type,',
  'so the type must come from what you can see.',
  'The three types differ only in hull size and deck cargo:',
  '  "scout"  — smallest hull, NO cargo crate on deck',
  '  "runner" — medium hull, ONE SMALL cargo crate on deck',
  '  "heavy"  — largest hull, ONE LARGE cargo crate on deck',
  'Reply with ONLY one JSON object:',
  '{"seen": "<one line: what you can actually make out of the vessel>",',
  ' "class": "scout" | "runner" | "heavy" | "unknown",',
  ' "confidence": <0.0-1.0>}',
  'Answer "unknown" when the vessel is too small or unclear to tell the types apart.',
  'Do not guess a type you cannot see evidence for.',
].join('\n');

function idUserPrompt(distanceM) {
  return [
    `Radar contact bearing dead ahead, range ${Math.round(distanceM)} m.`,
    'Identify the vessel type from the camera image.',
  ].join('\n');
}

async function chat({ url, model, systemPrompt, userPrompt, imageDataUrl, maxTokens, timeoutMs }) {
  const content = imageDataUrl
    ? [{ type: 'text', text: userPrompt }, { type: 'image_url', image_url: { url: imageDataUrl } }]
    : userPrompt;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const t0 = Date.now();
  try {
    const res = await fetch(`${url.replace(/\/+$/, '')}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, temperature: 0.2, max_tokens: maxTokens, stream: false, messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content }] }),
      signal: controller.signal,
    });
    if (!res.ok) {
      const snippet = (await res.text().catch(() => '')).slice(0, 200);
      return { ok: false, kind: 'http_status', elapsedMs: Date.now() - t0, error: `HTTP ${res.status}: ${snippet}` };
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
    };
  } catch (err) {
    return { ok: false, kind: err?.name === 'AbortError' ? 'timeout' : 'connection', elapsedMs: Date.now() - t0, error: String(err?.message ?? err) };
  } finally {
    clearTimeout(timer);
  }
}

function parseJsonLoose(text) {
  if (typeof text !== 'string') return null;
  let s = text.trim();
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(s);
  if (fence) s = fence[1].trim();
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try { return JSON.parse(s.slice(start, end + 1)); } catch { return null; }
}

function writeDataUrlPng(dataUrl, file) {
  fs.writeFileSync(file, Buffer.from(String(dataUrl).split(',')[1], 'base64'));
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  fs.mkdirSync(path.join(opts.outDir, 'images'), { recursive: true });
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
  await page.setViewport({ width: 1280, height: 720 });
  page.on('pageerror', (e) => console.error('[page error]', e.message));

  const url = `http://localhost:${opts.port}/digital-twin/index.html?scenario=${SCENARIO}`;
  console.log(`[id-probe] ${url}`);
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForFunction('window.__debug && window.__debug.world && window.__debug.world.state.count > 0', { timeout: 60000 });
  await new Promise((r) => setTimeout(r, 2500)); // テクスチャ・環境マップの生成待ち
  await page.evaluate(INSTALL);

  const rows = [];
  const shots = [];

  // --- 1. 配置と撮影（推論なしでも必ずここまでは行う。入力画像の健全性が先） ---
  for (const arm of opts.arms) {
    const fovDeg = arm === 'zoom' ? opts.zoomFovDeg : 70;
    for (const cls of opts.classes) {
      for (const distanceM of opts.distances) {
        const targetId = TARGET_BY_CLASS[cls];
        const shot = await page.evaluate(
          (args) => window.__idProbe.shot(args),
          { targetId, distanceM, aspect: opts.aspect, fovDeg, w: opts.res.w, h: opts.res.h }
        );
        const name = `${arm}-${cls}-${distanceM}m.png`;
        writeDataUrlPng(shot.imageDataUrl, path.join(opts.outDir, 'images', name));
        shots.push({ arm, cls, distanceM, fovDeg, name, ...shot, imageDataUrl: undefined });
        console.log(
          `  [shot] ${arm.padEnd(4)} ${cls.padEnd(6)} ${String(distanceM).padStart(4)}m  ` +
            `target ${shot.extent ? `${shot.extent.wPx.toFixed(1)}x${shot.extent.hPx.toFixed(1)} px` : 'off-screen'}` +
            `  radar:${shot.radarSeesTarget ? 'yes' : 'no'}`
        );
      }
    }
  }
  // 配置そのものの俯瞰（1枚だけ。目視確認用）
  const ov = await page.evaluate((a) => window.__idProbe.overview(a), { targetId: TARGET_BY_CLASS[opts.classes[0]], distanceM: opts.distances[Math.floor(opts.distances.length / 2)] });
  writeDataUrlPng(ov, path.join(opts.outDir, 'images', 'overview.png'));

  // --- 2. 推論 ---
  if (!opts.stageOnly) {
    console.log(`\n[id-probe] warmup ${opts.model} ...`);
    const warm = await chat({ url: opts.url, model: opts.model, systemPrompt: 'You are a helpful assistant.', userPrompt: 'Reply with OK.', maxTokens: 8, timeoutMs: opts.timeoutMs });
    console.log(`  warmup ${warm.ok ? 'ok' : `FAILED (${warm.kind}: ${warm.error})`} ${warm.elapsedMs} ms`);

    for (const s of shots) {
      const imageDataUrl = 'data:image/png;base64,' + fs.readFileSync(path.join(opts.outDir, 'images', s.name)).toString('base64');
      for (let k = 0; k < opts.samples; k++) {
        const res = await chat({
          url: opts.url, model: opts.model,
          systemPrompt: ID_SYSTEM, userPrompt: idUserPrompt(s.distanceM),
          imageDataUrl, maxTokens: opts.maxTokens, timeoutMs: opts.timeoutMs,
        });
        const parsed = res.ok ? parseJsonLoose(res.text) : null;
        const answer = parsed && typeof parsed.class === 'string' ? parsed.class.toLowerCase().trim() : null;
        const row = {
          arm: s.arm, truth: s.cls, distanceM: s.distanceM, sample: k,
          answer, correct: answer === s.cls, unknown: answer === 'unknown',
          confidence: parsed?.confidence ?? null, seen: parsed?.seen ?? null,
          targetPx: s.extent ? Number(s.extent.wPx.toFixed(1)) : null,
          latencyMs: res.elapsedMs, promptTokens: res.promptTokens ?? null,
          failure: res.ok ? (parsed ? null : 'parse') : res.kind,
          raw: res.text ?? res.error ?? null, image: s.name,
        };
        rows.push(row);
        fs.appendFileSync(path.join(opts.outDir, 'results.jsonl'), JSON.stringify(row) + '\n');
        console.log(
          `  ${s.arm.padEnd(4)} ${s.cls.padEnd(6)} ${String(s.distanceM).padStart(4)}m #${k} -> ` +
            `${String(answer ?? row.failure).padEnd(8)} ${row.correct ? 'OK ' : '   '} ${row.latencyMs} ms`
        );
      }
    }
  }

  // --- 3. 集計 ---
  const summary = { model: opts.model, aspect: opts.aspect, res: opts.res, zoomFovDeg: opts.zoomFovDeg, samples: opts.samples, shots, cells: [] };
  for (const arm of opts.arms) {
    for (const distanceM of opts.distances) {
      const cell = rows.filter((r) => r.arm === arm && r.distanceM === distanceM);
      if (cell.length === 0) continue;
      summary.cells.push({
        arm, distanceM,
        n: cell.length,
        correct: cell.filter((r) => r.correct).length,
        unknown: cell.filter((r) => r.unknown).length,
        failures: cell.filter((r) => r.failure).length,
        targetPx: shots.find((s) => s.arm === arm && s.distanceM === distanceM)?.extent?.wPx ?? null,
      });
    }
  }
  fs.writeFileSync(path.join(opts.outDir, 'summary.json'), JSON.stringify(summary, null, 2));

  if (summary.cells.length > 0) {
    console.log('\n=== 正解率（艦種3種・チャンスレベル 33%） ===');
    console.log('arm   dist   px    correct   unknown');
    for (const c of summary.cells) {
      console.log(
        `${c.arm.padEnd(5)} ${String(c.distanceM).padStart(4)}m ${String(c.targetPx ? c.targetPx.toFixed(0) : '-').padStart(4)} ` +
          `  ${String(c.correct + '/' + c.n).padStart(6)}   ${String(c.unknown + '/' + c.n).padStart(6)}`
      );
    }
  }
  console.log(`\n[id-probe] -> ${path.relative(ROOT, opts.outDir)}`);

  await browser.close();
  server.close();
}

main().catch((err) => { console.error(err); process.exit(1); });
