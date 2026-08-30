// replay_3d.js — headlessランで記録した艇の軌跡(x/y/heading/speed)を
// digital-twin/ の3Dシーンへ後から流し込み、静止画連番として撮る。
// digital-twinはswarm-simと別Worldで固定舵(throttle=0.3)のデモにすぎないため
// (main.js参照)、まず固定物理を無効化してからworld.stateへ記録値を直接書き込む。
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const puppeteer = require('/home/ben_ben/automata2/asv_swarm_dt/.devtools/node_modules/puppeteer');

const ROOT = path.resolve(__dirname, '../..');
const PORT = 8978;
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json' };

function startServer() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      let filePath = path.join(ROOT, decodeURIComponent(req.url.split('?')[0]));
      if (filePath.endsWith(path.sep)) filePath = path.join(filePath, 'index.html');
      fs.readFile(filePath, (err, data) => {
        if (err) { res.writeHead(404); res.end('not found'); return; }
        res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream' });
        res.end(data);
      });
    });
    server.listen(PORT, () => resolve(server));
  });
}

/** positions-ep1.jsonl(type:'step'行) を id -> ソート済み{t,x,y,heading,speed}[] へ */
function loadReplay(logPath) {
  const rows = fs
    .readFileSync(logPath, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l))
    .filter((r) => r.type === 'step');
  const byId = new Map();
  for (const r of rows) {
    if (!byId.has(r.id)) byId.set(r.id, []);
    byId.get(r.id).push(r);
  }
  for (const list of byId.values()) list.sort((a, b) => a.t - b.t);
  return byId;
}

/** 各tでの各艇の記録値。無ければ直前値で保持（=撃沈後は最後の位置で静止） */
function frameAt(byId, t) {
  const out = {};
  for (const [id, rows] of byId) {
    let picked = null;
    for (const r of rows) {
      if (r.t > t) break;
      picked = r;
    }
    if (picked) out[id] = picked;
  }
  return out;
}

async function main() {
  const [, , logPath, outDir, frameCountArg] = process.argv;
  if (!logPath || !outDir) {
    console.error('usage: node replay_3d.js <positions.jsonl> <outDir> [frames]');
    process.exit(1);
  }
  const frameCount = parseInt(frameCountArg || '30', 10);
  fs.mkdirSync(outDir, { recursive: true });

  const byId = loadReplay(logPath);
  const allT = [...byId.values()].flatMap((rows) => rows.map((r) => r.t));
  const tMax = Math.max(...allT);
  console.log(`replay duration: ${tMax.toFixed(1)}s, boats: ${byId.size}, frames: ${frameCount}`);

  const server = await startServer();
  const browser = await puppeteer.launch({
    headless: 'shell',
    // digital-twin は Three.js(WebGL) 描画が要る。swarm-simのCanvas2D撮影と違い
    // GPUフラグは削れない(capture-2d.jsの教訓とは逆)。
    args: ['--no-sandbox', '--use-angle=swiftshader', '--enable-webgl', '--ignore-gpu-blocklist', '--disable-gpu-sandbox'],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 720 });
  page.on('pageerror', (e) => console.log('[pageerror]', e.message));

  await page.goto(`http://localhost:${PORT}/digital-twin/index.html?scenario=flag_defence_squadrons`, {
    waitUntil: 'domcontentloaded',
    timeout: 20000,
  });
  await new Promise((r) => setTimeout(r, 4000)); // シーン初期化・シナリオ読み込みが落ち着くまで

  // 固定舵デモの物理を止める(main.jsのplatform.step()を無効化)。
  await page.evaluate(() => {
    const world = window.__debug.world;
    for (const platform of world.platformInstances.values()) {
      platform.step = () => {};
    }
  });
  console.log('live physics disabled');

  for (let i = 0; i < frameCount; i++) {
    const t = (tMax * i) / (frameCount - 1);
    const frame = frameAt(byId, t);
    await page.evaluate((frameData, tNow) => {
      const world = window.__debug.world;
      for (const [id, row] of Object.entries(frameData)) {
        const idx = world.state.indexOf(id);
        if (idx < 0) continue;
        world.state.x[idx] = row.x;
        world.state.y[idx] = row.y;
        world.state.heading[idx] = row.heading;
        world.state.speed[idx] = row.speed;
      }
      world.clock = tNow;
    }, frame, t);
    // 内部のrequestAnimationFrameループ(main.js)が次のtickでworld.state.snapshot()を
    // 読みThree.jsへ反映するのを待つ
    await new Promise((r) => setTimeout(r, 120));
    await page.screenshot({ path: path.join(outDir, `frame_${String(i).padStart(4, '0')}.png`) });
    console.log(`frame ${i}: t=${t.toFixed(1)}s (${Object.keys(frame).length} boats)`);
  }

  await browser.close();
  server.close();
  console.log(`done: ${frameCount} frames in ${outDir}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
