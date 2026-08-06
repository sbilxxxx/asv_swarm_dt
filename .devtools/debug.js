const http = require('http');
const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer');

const ROOT = path.resolve(__dirname, '..');
const PORT = 8972;
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
  page.on('console', (m) => console.log('[console]', m.text()));
  page.on('pageerror', (e) => console.log('[pageerror]', e.message));

  await page.goto(`http://localhost:${PORT}/digital-twin/`, { waitUntil: 'domcontentloaded', timeout: 15000 });
  await new Promise((r) => setTimeout(r, 3000));

  const info = await page.evaluate(() => {
    const d = window.__debug;
    if (!d) return { error: 'no debug hook' };
    const cam = d.three.overviewCamera;
    const ships = [];
    d.world.state.snapshot().forEach((e) => {
      const wx = e.x, wy = 1.1, wz = -e.y;
      const v = new (window.THREE ? window.THREE.Vector3 : Object)(wx, wy, wz);
      ships.push({ id: e.id, worldPos: [wx, wy, wz] });
    });
    return {
      focus: d.focus,
      cameraPos: [cam.position.x, cam.position.y, cam.position.z],
      cameraFov: cam.fov,
      ships,
      sceneBounds: d.scene.bounds,
    };
  });
  console.log(JSON.stringify(info, null, 2));

  await browser.close();
  server.close();
}

main().catch((e) => { console.error(e); process.exit(1); });
