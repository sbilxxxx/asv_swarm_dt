// capture-2d.js — swarm-sim（Canvas 2D、WebGL不使用）専用の軽量フレームキャプチャ
// .devtools/capture-gif-frames.js の --enable-webgl 等のGPUフラグが本機で異常なCPU消費を
// 引き起こしたため、GPU関連フラグを一切渡さない最小構成で撮り直す。
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const puppeteer = require('/home/ben_ben/automata2/asv_swarm_dt/.devtools/node_modules/puppeteer');

const ROOT = path.resolve(__dirname, '../..');
const PORT = 8977;
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

async function main() {
  const [, , urlPath, outDir, framesArg, intervalArg] = process.argv;
  const frames = parseInt(framesArg || '40', 10);
  const intervalMs = parseInt(intervalArg || '400', 10);
  fs.mkdirSync(outDir, { recursive: true });

  const server = await startServer();
  const t0 = Date.now();
  const browser = await puppeteer.launch({
    headless: 'shell',
    args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'],
  });
  console.log(`launch: ${Date.now() - t0}ms`);
  const page = await browser.newPage();
  await page.setViewport({ width: 960, height: 720 });
  page.on('pageerror', (e) => console.log('[pageerror]', e.message));
  page.on('console', (m) => { if (m.type() === 'error') console.log('[console.error]', m.text()); });

  const t1 = Date.now();
  await page.goto(`http://localhost:${PORT}${urlPath}`, { waitUntil: 'domcontentloaded', timeout: 15000 });
  console.log(`goto: ${Date.now() - t1}ms`);
  await new Promise((r) => setTimeout(r, 2000));

  for (let i = 0; i < frames; i++) {
    const ts = Date.now();
    await page.screenshot({ path: path.join(outDir, `frame_${String(i).padStart(4, '0')}.png`) });
    console.log(`frame ${i}: ${Date.now() - ts}ms`);
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  console.log(`Captured ${frames} frames to ${outDir}`);

  await browser.close();
  server.close();
}

main().catch((e) => { console.error(e); process.exit(1); });
