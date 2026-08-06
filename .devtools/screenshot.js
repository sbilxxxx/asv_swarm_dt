// screenshot.js — 開発時にレンダリング結果を自動でスクリーンショット確認するツール
// 目的: 「動くはず」で終わらせず、実際の描画結果を毎回目視相当で確認するため。
// Usage: node screenshot.js <path e.g. /digital-twin/> <outfile.png> [waitMs] [afterMs]

const http = require('http');
const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer');

const ROOT = path.resolve(__dirname, '..');
const PORT = 8971;

const MIME = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.json': 'application/json',
  '.css': 'text/css',
};

function startServer() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      let filePath = path.join(ROOT, decodeURIComponent(req.url.split('?')[0]));
      if (filePath.endsWith(path.sep)) filePath = path.join(filePath, 'index.html');
      fs.readFile(filePath, (err, data) => {
        if (err) {
          res.writeHead(404);
          res.end('not found: ' + filePath);
          return;
        }
        const ext = path.extname(filePath);
        res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
        res.end(data);
      });
    });
    server.listen(PORT, () => resolve(server));
  });
}

async function main() {
  const [, , urlPath, outFile, waitMsArg] = process.argv;
  if (!urlPath || !outFile) {
    console.error('Usage: node screenshot.js <path> <outfile.png> [waitMs]');
    process.exit(1);
  }
  const waitMs = parseInt(waitMsArg || '3000', 10);

  const server = await startServer();
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

  const consoleMsgs = [];
  page.on('console', (msg) => consoleMsgs.push(`[${msg.type()}] ${msg.text()}`));
  page.on('pageerror', (err) => consoleMsgs.push(`[pageerror] ${err.message}`));

  await page.goto(`http://localhost:${PORT}${urlPath}`, { waitUntil: 'domcontentloaded', timeout: 15000 });
  await new Promise((r) => setTimeout(r, waitMs));
  await page.screenshot({ path: outFile });

  console.log('Saved screenshot to', outFile);
  console.log('--- console output ---');
  consoleMsgs.forEach((m) => console.log(m));

  await browser.close();
  server.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
