// qa-shots.js — 3D品質向上作業のスクリーンショット駆動PDCA用ツール
// 目的: 「近接（船首方向・喫水線）」「中距離（接地感・船首波）」「広角（海面LODの継ぎ目・遠景フェード）」
// の3段階で、ヒーロー艇の実位置・針路を読み取ってからカメラを寄せる。peek.js のパターン（一時停止して
// カメラを手動配置）を踏襲しつつ、船の現在位置・headingに追従する形に一般化した。
// Usage: node qa-shots.js <output-prefix>
// 例: node qa-shots.js ../../../out/after   -> after_wide.png, after_bow.png, ... と vertex counts JSON を出力

const http = require('http');
const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer');

const ROOT = path.resolve(__dirname, '..');
const PORT = parseInt(process.env.SHOT_PORT || '8976', 10);
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json' };

function startServer() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      let filePath = path.join(ROOT, decodeURIComponent(req.url.split('?')[0]));
      if (filePath.endsWith(path.sep)) filePath = path.join(filePath, 'index.html');
      fs.readFile(filePath, (err, data) => {
        if (err) { res.writeHead(404); res.end('not found: ' + filePath); return; }
        res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream' });
        res.end(data);
      });
    });
    server.listen(PORT, () => resolve(server));
  });
}

async function main() {
  const [, , outPrefix] = process.argv;
  if (!outPrefix) {
    console.error('Usage: node qa-shots.js <output-prefix>');
    process.exit(1);
  }
  const outDir = path.dirname(path.resolve(outPrefix));
  fs.mkdirSync(outDir, { recursive: true });

  const server = await startServer();
  const browser = await puppeteer.launch({
    headless: 'shell',
    args: [
      '--headless=new', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
      '--enable-webgl', '--ignore-gpu-blocklist', '--disable-gpu-sandbox', '--no-sandbox',
    ],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 960, height: 720 });
  const consoleMsgs = [];
  page.on('console', (m) => consoleMsgs.push(`[${m.type()}] ${m.text()}`));
  page.on('pageerror', (e) => consoleMsgs.push(`[pageerror] ${e.message}`));

  await page.goto(`http://localhost:${PORT}/digital-twin/`, { waitUntil: 'domcontentloaded', timeout: 15000 });
  await new Promise((r) => setTimeout(r, 3500)); // 波・航跡が落ち着くまで待つ
  await page.evaluate(() => { window.__debug.paused = true; });
  await new Promise((r) => setTimeout(r, 100));

  // ヒーロー艇の現在位置・針路を読み取り、そこからの相対位置でカメラを組む
  const state = await page.evaluate(() => {
    const d = window.__debug;
    const heroId = d.world.state.id[0]; // spawns[0] = hero (main.jsの規約)
    const idx = d.world.state.indexOf(heroId);
    return {
      x: d.world.state.x[idx],
      y: d.world.state.y[idx],
      heading: d.world.state.heading[idx],
    };
  });
  const { x, y, heading } = state;
  const wx = x, wz = -y; // world座標（scene_builder.jsの規約: worldZ = -simY）
  const fx = Math.cos(heading), fz = -Math.sin(heading); // forward（world XZ）
  const rx = -fz, rz = fx; // forwardを+90度回した右方向

  const views = [
    {
      name: 'wide',
      // 既定のオービットカメラそのまま（LODの継ぎ目・遠景ランドマークのフェードを見る）
      pos: null,
    },
    {
      name: 'bow',
      // 船首方向 vs 進行方向、喫水線、超構造物のディテールを見る近接ショット
      pos: [wx - fx * 16 + rx * 9, 6.5, wz - fz * 16 + rz * 9],
      look: [wx + fx * 8, 1.5, wz + fz * 8],
    },
    {
      name: 'beam',
      // 真横から。喫水線の塗り分け・接地感（影）を見る
      pos: [wx + rx * 20, 2.0, wz + rz * 20],
      look: [wx, 0.5, wz],
    },
    {
      name: 'mid_shadow',
      // 影は太陽と反対側（水平成分 -sunDir.xz 方向）に伸びる。太陽側から見下ろすことで
      // 船と影の両方をフレームに収める（sunDir=(0.5,0.8,0.35)正規化 → 水平成分は概ね(+X,+Z)側）。
      pos: [wx + 0.821 * 26, 15, wz + 0.575 * 26],
      look: [wx - 0.821 * 6, 0.5, wz - 0.575 * 6],
    },
  ];

  for (const v of views) {
    if (v.pos) {
      await page.evaluate((view) => {
        const cam = window.__debug.three.overviewCamera;
        cam.position.set(...view.pos);
        cam.lookAt(...view.look);
        window.__debug.three.render(window.__debug.three.__lastElapsed ?? 6);
      }, v);
    } else {
      // wideは一時停止直前のオービットカメラのまま再描画するだけ
      await page.evaluate(() => {
        window.__debug.three.render(6);
      });
    }
    await page.screenshot({ path: `${outPrefix}_${v.name}.png` });
  }

  // 頂点数の実測（renderer.info + シーングラフ走査の両方）
  const counts = await page.evaluate(() => {
    const d = window.__debug;
    const info = d.three.renderer.info;
    const byLabel = {};
    const perShip = {};
    d.three.scene3d.traverse((obj) => {
      if (obj.isMesh && obj.geometry) {
        const label = obj.name || obj.geometry.type || 'mesh';
        const posAttr = obj.geometry.attributes?.position;
        const n = posAttr ? posAttr.count : 0;
        byLabel[label] = (byLabel[label] || 0) + n;
        // 祖先を辿って ship-<id> グループに属するかを判定し、船単体の頂点数を分離する
        let p = obj.parent;
        while (p) {
          if (p.name && p.name.startsWith('ship-')) {
            perShip[p.name] = (perShip[p.name] || 0) + n;
            break;
          }
          p = p.parent;
        }
      }
    });
    let shipCount = 0;
    d.world.state.snapshot().forEach(() => { shipCount++; });
    return {
      rendererInfoTriangles: info.render.triangles, // 参考値（頂点数ではなく三角形数）
      geometryTotalByLabel: byLabel,
      grandTotalVertices: Object.values(byLabel).reduce((a, b) => a + b, 0),
      perShipVertices: perShip,
      shipEntityCount: shipCount,
    };
  });

  const report = { state, counts, consoleMsgs };
  fs.writeFileSync(`${outPrefix}_report.json`, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));

  await browser.close();
  server.close();
}

main().catch((e) => { console.error(e); process.exit(1); });
