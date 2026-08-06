const http = require('http');
const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer');
const ROOT = path.resolve(__dirname, '..');
const PORT = 8975;
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
  const server = await startServer();
  const browser = await puppeteer.launch({
    headless: 'shell',
    args: ['--headless=new', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--enable-webgl', '--ignore-gpu-blocklist', '--disable-gpu-sandbox', '--no-sandbox'],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 960, height: 720 });
  page.on('pageerror', (e) => console.log('[pageerror]', e.message));
  await page.goto(`http://localhost:${PORT}/digital-twin/`, { waitUntil: 'domcontentloaded', timeout: 15000 });
  await new Promise((r) => setTimeout(r, 1500));
  await page.evaluate(() => { window.__debug.paused = true; });
  await new Promise((r) => setTimeout(r, 50));

  const views = [
    { name: 'tanker', pos: [280, 40, -260], look: [280, 15, -330] },
    { name: 'fuji2', pos: [-2100, 300, -3800], look: [-2100, 350, -5600] },
  ];
  for (const v of views) {
    await page.evaluate((view) => {
      const d = window.__debug;
      const cam = d.three.overviewCamera;
      cam.position.set(...view.pos);
      cam.lookAt(...view.look);
      d.three.render(0);
    }, v);
    await page.screenshot({ path: `./peek-${v.name}.png` });
    console.log('captured', v.name);
  }

  await browser.close();
  server.close();
}
main().catch(e => { console.error(e); process.exit(1); });
