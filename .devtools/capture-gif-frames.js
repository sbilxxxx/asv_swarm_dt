// capture-gif-frames.js — README用デモGIFのフレームを連続キャプチャする
// Usage: node capture-gif-frames.js <path> <outDir> <frames> <intervalMs>

const http = require('http');
const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer');

const ROOT = path.resolve(__dirname, '..');
const PORT = 8976;
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
  const intervalMs = parseInt(intervalArg || '200', 10);
  fs.mkdirSync(outDir, { recursive: true });

  const server = await startServer();
  const browser = await puppeteer.launch({
    headless: 'shell',
    args: ['--headless=new', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--enable-webgl', '--ignore-gpu-blocklist', '--disable-gpu-sandbox', '--no-sandbox'],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 960, height: 720 });
  page.on('pageerror', (e) => console.log('[pageerror]', e.message));

  await page.goto(`http://localhost:${PORT}${urlPath}`, { waitUntil: 'domcontentloaded', timeout: 15000 });
  await new Promise((r) => setTimeout(r, 3000)); // シーン初期化・シナリオ読み込みが落ち着くまで待つ

  for (let i = 0; i < frames; i++) {
    await page.screenshot({ path: path.join(outDir, `frame_${String(i).padStart(4, '0')}.png`) });
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  console.log(`Captured ${frames} frames to ${outDir}`);

  await browser.close();
  server.close();
}

main().catch((e) => { console.error(e); process.exit(1); });
