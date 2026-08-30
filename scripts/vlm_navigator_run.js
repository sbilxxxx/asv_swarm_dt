/**
 * vlm_navigator_run.js — VLM航海士の閉ループを1エピソード走らせる（docs/l1-vlm-navigator-plan.md の縦切り最小版）
 *
 * 何が閉じているか:
 *   3DCG（digital-twin/）のブリッジ一人称カメラ → VLM → 航路プラン（waypoint列）
 *     → World.orders → 既存 BoatController → AsvPlatform の運動学 → 船が動く → 次サイクルの絵
 * つまり「海域デジタルツインの画像を読ませて航路を決めさせ、その決定で実際に船が動く」ところまでを
 * 1本のコマンドで回す。判断は intervalS シム秒ごと、追従は毎物理ステップ（dt=0.1s）。
 *
 * 作りの制約と理由:
 * - シムとレンダリングはブラウザ（digital-twin/）側に置き、Node は「推論と検証」だけを持つ。
 *   Ollama を Node から叩くのでブラウザの CORS 設定に依存しない（CLAUDE.md: APIキー/推論URLを
 *   ブラウザに埋めない方針とも整合する）。
 * - digital-twin/main.js の rAF ループは止め（__debug.paused）、このスクリプトが
 *   advance(simSeconds) でシム時間を進める。実時間ではなくシム時間で刻むので、
 *   推論に何秒かかっても軌跡は変わらない（docs/time-model.md §9 の headless 側の扱いと同じ）。
 * - 追従制御・運動学・センサーは既存モジュールをそのまま使う（計画 §3「無変更で再利用」）。
 *
 * アーム:
 *   --arm vlm      画像＋状況テキスト → VLM が keep/replace を返す（主経路）
 *   --arm blind    同じ状況テキストのみ（画像なし）。視覚が効いているかの統制群
 *   --arm scripted 推論なし。目的地へ直行。サーバが無くても必ず完走する基準線
 *
 * 使い方:
 *   node scripts/vlm_navigator_run.js --arm vlm --model qwen2.5vl:7b
 *   node scripts/vlm_navigator_run.js --arm scripted --cycles 12
 *
 *   --arm vlm|blind|scripted  既定 vlm
 *   --model NAME       既定 qwen2.5vl:7b
 *   --url URL          既定 http://localhost:11434/v1
 *   --cycles N         最大判断サイクル数。既定 12
 *   --interval S       判断間隔（シム秒）。既定 10
 *   --res WxH          カメラ画像の解像度。既定 640x360
 *   --arrival M        到達半径。既定 40
 *   --max-tokens N     既定 400
 *   --timeout-ms N     既定 60000
 *   --out-dir DIR      既定 logs/vlm-nav-<YYYY-MM-DD_HHMM>-<arm>
 *   --no-warmup        ウォームアップ推論（コールドスタート約20s）を省く
 *   --port N           既定 8974
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

const DT_S = 0.1; // 物理ステップ（headless_run.js と同じ）
const MAX_WAYPOINTS = 5;
/** 自船位置と重なる waypoint は捨てる（スモークで実際に混入した。計画 §4） */
const SELF_WAYPOINT_REJECT_M = 25;
/** 連続する同一点はこの距離未満なら1点に畳む（実測: 目的地を3回並べて返す退化が出た） */
const DUPLICATE_WAYPOINT_M = 20;

function parseArgs(argv) {
  const o = {
    arm: 'vlm',
    model: 'qwen2.5vl:7b',
    url: 'http://localhost:11434/v1',
    cycles: 12,
    intervalS: 10,
    res: { w: 640, h: 360 },
    arrivalM: 40,
    maxTokens: 400,
    timeoutMs: 60000,
    outDir: null,
    warmup: true,
    port: 8974,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--arm') o.arm = argv[++i];
    else if (a === '--model') o.model = argv[++i];
    else if (a === '--url') o.url = argv[++i];
    else if (a === '--cycles') o.cycles = Number(argv[++i]);
    else if (a === '--interval') o.intervalS = Number(argv[++i]);
    else if (a === '--arrival') o.arrivalM = Number(argv[++i]);
    else if (a === '--max-tokens') o.maxTokens = Number(argv[++i]);
    else if (a === '--timeout-ms') o.timeoutMs = Number(argv[++i]);
    else if (a === '--out-dir') o.outDir = argv[++i];
    else if (a === '--no-warmup') o.warmup = false;
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
  if (!['vlm', 'blind', 'scripted'].includes(o.arm)) throw new Error(`--arm は vlm|blind|scripted: ${o.arm}`);
  if (!o.outDir) {
    const d = new Date();
    const p = (n) => String(n).padStart(2, '0');
    const stamp = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}`;
    o.outDir = path.join(ROOT, 'logs', `vlm-nav-${stamp}-${o.arm}`);
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
// ページ側（digital-twin/ は無変更。window.__debug のフックだけを使う）
//
// ここに置くコードだけが core のシム部品に触れる。判断は一切しない
// （推論は Node 側。ページは「進める・撮る・見せる」だけ）。
// ---------------------------------------------------------------------------

const INSTALL_NAV = (arrivalM) => `
window.__vlmNav = (() => {
  const { three, world } = window.__debug;
  window.__debug.paused = true;              // main.js の rAF ループを止め、進行はこちらが持つ
  const heroId = world.state.id[0];
  const heroIndex = world.state.indexOf(heroId);
  const ARRIVAL_M = ${arrivalM};
  const DT = ${DT_S};

  const dest = world.protectedAsset
    ? { eastM: world.protectedAsset.x, northM: world.protectedAsset.y }
    : { eastM: world.state.x[heroIndex] + 500, northM: world.state.y[heroIndex] - 300 };

  let plan = [{ ...dest }];                  // 初期プラン＝目的地へ直行（計画 §4）
  const trail = [];
  let arrived = false;
  let pathLengthM = 0;

  function observationsForAll() {
    const obs = {};
    for (let i = 0; i < world.state.count; i++) {
      if (!world.state.alive[i]) continue;
      const id = world.state.id[i];
      obs[id] = {
        radar: world.observe(id, 'radar'),
        position: { x: world.state.x[i], y: world.state.y[i], heading: world.state.heading[i], speed: world.state.speed[i] },
        timestamp: world.clock,
      };
    }
    return obs;
  }

  function heroPose() {
    return {
      eastM: world.state.x[heroIndex],
      northM: world.state.y[heroIndex],
      headingDeg: (world.state.heading[heroIndex] * 180) / Math.PI,
      speedMps: world.state.speed[heroIndex],
    };
  }

  return {
    heroId,
    destination: dest,
    bounds: world.scene.bounds,

    setPlan(waypoints) { plan = waypoints.map((w) => ({ ...w })); },
    getPlan() { return plan.map((w) => ({ ...w })); },

    /** シム時間を simSeconds だけ進める。実時間ではなくシム時間で刻むので推論の速さが軌跡に混ざらない */
    advance(simSeconds) {
      const steps = Math.round(simSeconds / DT);
      for (let k = 0; k < steps; k++) {
        const pose = heroPose();
        // 到達した waypoint は落とす（最後の1点＝目的地は残し、到達判定に使う）
        while (plan.length > 1 && Math.hypot(plan[0].eastM - pose.eastM, plan[0].northM - pose.northM) <= ARRIVAL_M) {
          plan.shift();
        }
        const wp = plan[0] ?? dest;
        world.orders.set(heroId, { action: 'move_to', waypointWorld: { x: wp.eastM, y: wp.northM } });

        const obs = observationsForAll();
        for (let i = 0; i < world.state.count; i++) {
          if (!world.state.alive[i]) continue;
          const id = world.state.id[i];
          const platform = world.platformInstances.get(id);
          const action = id === heroId
            ? world.boatController.decide(world.orders.get(id), obs[id], id, world.state.faction[i])
            : { throttle: 0.3, steering: 0.04 };   // 周囲の交通は main.js と同じスクリプト動作
          const x0 = world.state.x[i], y0 = world.state.y[i];
          platform.step(world.state, i, action, DT, world.environment, world.clock);
          if (id === heroId) pathLengthM += Math.hypot(world.state.x[i] - x0, world.state.y[i] - y0);
        }
        world.clock += DT;

        // 毎ステップ updateShips を呼ぶ（間引かない）。近傍海面パッチと影のカメラは
        // updateShips の中で注視点へ 8%/回の補間で追従する作りなので、判断サイクルごとに
        // 1回しか呼ばないと船が海面パッチから出てしまい、カメラ画像に海の無い領域
        // （地面がそのまま見える）が写る。VLM への入力画像が壊れるので間引けない。
        three.updateShips(world.state.snapshot(), world.clock);

        const p = heroPose();
        if (Math.hypot(dest.eastM - p.eastM, dest.northM - p.northM) <= ARRIVAL_M) { arrived = true; break; }
      }
      const p = heroPose();
      trail.push({ t: world.clock, ...p });
      three.updateOverviewCamera(DT);
      three.render(world.clock);
      return { clock: world.clock, arrived, pathLengthM, pose: p };
    },

    /** ブリッジ一人称を固定解像度で1枚。撮影中だけ renderer を切り替えて元に戻す */
    capture(w, h) {
      const renderer = three.renderer;
      const canvas = renderer.domElement;
      const prevW = canvas.clientWidth, prevH = canvas.clientHeight;
      renderer.setPixelRatio(1);
      renderer.setSize(w, h, false);
      three.sensorCamera.aspect = w / Math.max(h, 1);
      three.sensorCamera.updateProjectionMatrix();
      const cam = world.observe(heroId, 'camera');
      renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
      renderer.setSize(prevW, prevH, false);
      three.resize();

      const radar = world.observe(heroId, 'radar');
      const pose = heroPose();
      let minContactM = Infinity;
      for (const c of radar.contacts) minContactM = Math.min(minContactM, c.rangeM);
      return {
        imageDataUrl: cam ? cam.imageDataUrl : null,
        clock: world.clock,
        self: pose,
        destination: dest,
        plan: plan.map((w) => ({ ...w })),
        arrived,
        pathLengthM,
        minContactM: Number.isFinite(minContactM) ? minContactM : null,
        radar: {
          rangeM: radar.rangeM,
          contacts: radar.contacts.map((c) => ({
            id: c.id, faction: c.faction, rangeM: c.rangeM, bearingDeg: (c.bearingRad * 180) / Math.PI,
          })),
        },
      };
    },

    /**
     * 俯瞰の1枚（最終位置の目視確認用）。
     * three.updateOverviewCamera() のオービット注視点は毎フレーム 0.08 ずつしか寄らない前提の
     * 補間なので、10シム秒に1回しか呼ばれないこのループでは船に追いつかない（実際に空の海面が
     * 写った）。ここではヒーロー艇の現在位置に直接カメラを置く。
     */
    overview() {
      const p = heroPose();
      three.overviewCamera.position.set(p.eastM + 70, 34, -p.northM + 70);
      three.overviewCamera.lookAt(p.eastM, 4, -p.northM);
      three.render(world.clock);
      return three.renderer.domElement.toDataURL('image/png');
    },

    trail() { return trail.slice(); },
  };
})();
true;
`;

// ---------------------------------------------------------------------------
// プロンプトと推論
// ---------------------------------------------------------------------------

const NAV_SYSTEM = [
  'You are the navigator of an uncrewed surface vessel (ASV) in coastal water.',
  'Each cycle you get own-ship state, radar contacts, the destination, the current route plan,',
  'and (unless stated otherwise) the forward bridge camera image.',
  'Coordinates are metres in a fixed scene frame: east = +x, north = +y.',
  'Heading is degrees, 0 = east, counter-clockwise (90 = north).',
  'Reply with ONE JSON object and nothing else:',
  '{"watch": "<one line: the hazard you see, or none>",',
  ' "action": "keep" | "replace",',
  ' "waypoints": [{"eastM": <number>, "northM": <number>}],',
  ' "speed": "stop" | "slow" | "cruise"}',
  'Use "keep" when the current plan is still safe; then waypoints must be [].',
  'Use "replace" only to change the route: 1-3 waypoints in order, absolute scene metres,',
  'never your own current position, and the last one at the destination.',
].join('\n');

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

function buildSituation(raw) {
  const self = raw.self;
  const dest = raw.destination;
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
    plan: raw.plan,
    destination: {
      ...dest,
      rangeM: Math.hypot(dx, dy),
      bearingDeg: destBearing,
      relative: relativeSide(destBearing - self.headingDeg),
    },
    radar: { rangeM: raw.radar.rangeM, contacts },
  };
}

function navUserPrompt(sit, withImage, arrivalM) {
  const lines = [];
  lines.push(`Time: t=${sit.clock.toFixed(1)} s`);
  lines.push(
    `Own ship (GNSS): east=${sit.self.eastM.toFixed(0)} m, north=${sit.self.northM.toFixed(0)} m, ` +
      `heading=${sit.self.headingDeg.toFixed(0)} deg, speed=${sit.self.speedMps.toFixed(1)} m/s`
  );
  lines.push(
    `Destination: east=${sit.destination.eastM.toFixed(0)} m, north=${sit.destination.northM.toFixed(0)} m ` +
      `(range ${sit.destination.rangeM.toFixed(0)} m, ${sit.destination.relative}), arrival radius ${arrivalM} m`
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
    `Current plan: ${sit.plan.map((p) => `(${p.eastM.toFixed(0)},${p.northM.toFixed(0)})`).join(' -> ')}`
  );
  lines.push(
    withImage
      ? 'The attached image is the bridge camera looking straight ahead over the bow.'
      : 'No camera image is available this cycle.'
  );
  lines.push('Decide now.');
  return lines.join('\n');
}

async function chat({ url, model, systemPrompt, userPrompt, imageDataUrl, maxTokens, timeoutMs }) {
  const content = imageDataUrl
    ? [
        { type: 'text', text: userPrompt },
        { type: 'image_url', image_url: { url: imageDataUrl } },
      ]
    : userPrompt;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const t0 = Date.now();
  try {
    const res = await fetch(`${url.replace(/\/+$/, '')}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: controller.signal,
      body: JSON.stringify({
        model,
        temperature: 0.2,
        max_tokens: maxTokens,
        stream: false,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content },
        ],
      }),
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

/**
 * VLM の生プランを実行可能なプランに直す。ここが「見るのは強い・測るのは弱い」への防波堤で、
 * 落としたものは必ず数える（黙って直すと、プロンプトを直すべきか幾何を code 側に移すべきかが
 * 実験ログから判別できなくなる）。
 */
function sanitizePlan(parsed, sit, bounds, destination) {
  const notes = [];
  if (!parsed || typeof parsed !== 'object') return { action: 'keep', waypoints: null, notes: ['unparsable'] };
  const action = parsed.action === 'replace' ? 'replace' : 'keep';
  if (action === 'keep') return { action: 'keep', waypoints: null, notes, watch: parsed.watch, speed: parsed.speed };

  const raw = Array.isArray(parsed.waypoints) ? parsed.waypoints : [];
  const clean = [];
  for (const w of raw) {
    const e = Number(w?.eastM);
    const n = Number(w?.northM);
    if (!Number.isFinite(e) || !Number.isFinite(n)) {
      notes.push('non-numeric waypoint dropped');
      continue;
    }
    if (Math.hypot(e - sit.self.eastM, n - sit.self.northM) < SELF_WAYPOINT_REJECT_M) {
      notes.push('own-position waypoint dropped');
      continue;
    }
    const ce = Math.min(Math.max(e, bounds.minX), bounds.maxX);
    const cn = Math.min(Math.max(n, bounds.minY), bounds.maxY);
    if (ce !== e || cn !== n) notes.push('waypoint clamped to scene bounds');
    // 実測で出た退化: 同じ点（多くは目的地そのもの）を3つ並べて返してくる。
    // 追従には無害だが「プランを変えた」ように見えてしまうので、ここで畳んで数える。
    const prev = clean[clean.length - 1];
    if (prev && Math.hypot(prev.eastM - ce, prev.northM - cn) < DUPLICATE_WAYPOINT_M) {
      notes.push('duplicate waypoint collapsed');
      continue;
    }
    clean.push({ eastM: ce, northM: cn });
    if (clean.length >= MAX_WAYPOINTS) break;
  }
  if (clean.length === 0) return { action: 'keep', waypoints: null, notes: [...notes, 'no usable waypoint'] };

  // 目的地で終わらないプランは、そのままだと目的地に着かない。最後に目的地を足す
  const last = clean[clean.length - 1];
  if (Math.hypot(last.eastM - destination.eastM, last.northM - destination.northM) > 60) {
    clean.push({ ...destination });
    notes.push('destination appended');
  }
  return { action: 'replace', waypoints: clean, notes, watch: parsed.watch, speed: parsed.speed };
}

function samePlan(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  return a.every((p, i) => Math.abs(p.eastM - b[i].eastM) < 1 && Math.abs(p.northM - b[i].northM) < 1);
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  fs.mkdirSync(opts.outDir, { recursive: true });
  const decisionLog = fs.createWriteStream(path.join(opts.outDir, 'decisions.jsonl'), { flags: 'a' });

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

  console.log(`[nav] arm=${opts.arm} model=${opts.model} cycles=${opts.cycles} interval=${opts.intervalS}s`);
  await page.goto(`http://localhost:${opts.port}/digital-twin/`, { waitUntil: 'domcontentloaded', timeout: 20000 });
  await page.waitForFunction('window.__debug && window.__debug.world && window.__debug.world.state.count > 0', {
    timeout: 30000,
  });
  await new Promise((r) => setTimeout(r, 4000)); // シーン（水面・ランドマーク）が出そろうのを待つ
  const nav = await page.evaluate(INSTALL_NAV(opts.arrivalM));
  const setup = await page.evaluate('({ hero: window.__vlmNav.heroId, dest: window.__vlmNav.destination, bounds: window.__vlmNav.bounds })');
  console.log(
    `[nav] hero=${setup.hero} destination=(${setup.dest.eastM.toFixed(0)}, ${setup.dest.northM.toFixed(0)}) ` +
      `bounds x[${setup.bounds.minX.toFixed(0)},${setup.bounds.maxX.toFixed(0)}] y[${setup.bounds.minY.toFixed(0)},${setup.bounds.maxY.toFixed(0)}]`
  );

  if (opts.arm !== 'scripted' && opts.warmup) {
    process.stdout.write('[nav] warming up the model ... ');
    const w = await chat({
      url: opts.url,
      model: opts.model,
      systemPrompt: NAV_SYSTEM,
      userPrompt: 'warmup. reply {"watch":"none","action":"keep","waypoints":[],"speed":"cruise"}',
      imageDataUrl: null,
      maxTokens: 64,
      timeoutMs: opts.timeoutMs,
    });
    console.log(`${w.ok ? 'ok' : 'FAILED ' + w.kind} ${w.elapsedMs} ms`);
  }

  const start = await page.evaluate(`window.__vlmNav.capture(${opts.res.w}, ${opts.res.h})`);
  const directDistanceM = Math.hypot(
    setup.dest.eastM - start.self.eastM,
    setup.dest.northM - start.self.northM
  );

  const cycleRows = [];
  let arrived = false;
  let lastPlan = start.plan;
  let minContactSeenM = Infinity;

  for (let cycle = 0; cycle < opts.cycles && !arrived; cycle++) {
    const tRender0 = Date.now();
    const raw = await page.evaluate(`window.__vlmNav.capture(${opts.res.w}, ${opts.res.h})`);
    const renderMs = Date.now() - tRender0;
    if (!raw.imageDataUrl) throw new Error('camera sensor returned no image');
    if (raw.minContactM != null) minContactSeenM = Math.min(minContactSeenM, raw.minContactM);

    const imgName = `c${String(cycle).padStart(2, '0')}.png`;
    fs.writeFileSync(path.join(opts.outDir, imgName), Buffer.from(raw.imageDataUrl.split(',')[1], 'base64'));
    const sit = buildSituation(raw);

    let call = null;
    let decision = { action: 'keep', waypoints: null, notes: ['scripted arm'] };
    if (opts.arm !== 'scripted') {
      const userPrompt = navUserPrompt(sit, opts.arm === 'vlm', opts.arrivalM);
      call = await chat({
        url: opts.url,
        model: opts.model,
        systemPrompt: NAV_SYSTEM,
        userPrompt,
        imageDataUrl: opts.arm === 'vlm' ? raw.imageDataUrl : null,
        maxTokens: opts.maxTokens,
        timeoutMs: opts.timeoutMs,
      });
      const parsed = call.ok ? parseJsonLoose(call.text) : null;
      decision = sanitizePlan(parsed, sit, setup.bounds, setup.dest);
      decision.parsed = parsed;
      decision.userPrompt = userPrompt;
    }

    const resent = decision.action === 'replace' && samePlan(decision.waypoints, lastPlan);
    if (decision.action === 'replace' && decision.waypoints) {
      await page.evaluate(`window.__vlmNav.setPlan(${JSON.stringify(decision.waypoints)})`);
      lastPlan = decision.waypoints;
    }

    const after = await page.evaluate(`window.__vlmNav.advance(${opts.intervalS})`);
    arrived = after.arrived;

    const row = {
      cycle,
      tIssueS: sit.clock,
      tAfterS: after.clock,
      renderMs,
      inferMs: call?.elapsedMs ?? 0,
      promptTokens: call?.promptTokens ?? null,
      outputTokens: call?.outputTokens ?? null,
      callOk: call ? call.ok : null,
      callKind: call?.kind ?? null,
      parseOk: call ? Boolean(decision.parsed) : null,
      action: decision.action,
      resentSamePlan: resent,
      watch: decision.watch ?? null,
      speed: decision.speed ?? null,
      waypoints: decision.waypoints,
      notes: decision.notes,
      situation: sit,
      image: imgName,
      rawText: call?.text ?? null,
      error: call?.error ?? null,
      pose: after.pose,
      pathLengthM: after.pathLengthM,
      arrived: after.arrived,
    };
    cycleRows.push(row);
    decisionLog.write(JSON.stringify(row) + '\n');

    const wpStr = decision.waypoints
      ? decision.waypoints.map((w) => `(${w.eastM.toFixed(0)},${w.northM.toFixed(0)})`).join('->')
      : '-';
    console.log(
      `\n[c${cycle}] t=${sit.clock.toFixed(0)}s own(${sit.self.eastM.toFixed(0)},${sit.self.northM.toFixed(0)}) ` +
        `hdg ${sit.self.headingDeg.toFixed(0)}deg  dest ${sit.destination.rangeM.toFixed(0)}m ${sit.destination.relative}` +
        `  contacts=${sit.radar.contacts.length}` +
        (call ? `\n      infer ${call.elapsedMs}ms ${call.ok ? '' : 'FAIL ' + call.kind + ' ' + call.error} tokens ${call.promptTokens ?? '?'}/${call.outputTokens ?? '?'}` : '') +
        `\n      watch: ${decision.watch ?? '-'}` +
        `\n      action: ${decision.action}${resent ? ' (same plan resent)' : ''}  plan: ${wpStr}` +
        (decision.notes.length ? `  notes: ${decision.notes.join('; ')}` : '') +
        `\n      -> after ${opts.intervalS}s: (${after.pose.eastM.toFixed(0)},${after.pose.northM.toFixed(0)}) ` +
        `speed ${after.pose.speedMps.toFixed(1)} m/s${after.arrived ? '  ARRIVED' : ''}`
    );
  }

  // 俯瞰1枚と軌跡
  const overviewUrl = await page.evaluate('window.__vlmNav.overview()');
  fs.writeFileSync(path.join(opts.outDir, 'overview.png'), Buffer.from(overviewUrl.split(',')[1], 'base64'));
  const trail = await page.evaluate('window.__vlmNav.trail()');
  fs.writeFileSync(path.join(opts.outDir, 'trail.json'), JSON.stringify(trail, null, 2));

  const last = cycleRows[cycleRows.length - 1];
  const infers = cycleRows.map((r) => r.inferMs).filter((v) => v > 0).sort((a, b) => a - b);
  const summary = {
    arm: opts.arm,
    model: opts.arm === 'scripted' ? null : opts.model,
    cycles: cycleRows.length,
    arrived,
    directDistanceM,
    pathLengthM: last?.pathLengthM ?? 0,
    pathRatio: last?.pathLengthM ? last.pathLengthM / directDistanceM : null,
    simSecondsElapsed: last?.tAfterS ?? 0,
    minContactSeenM: Number.isFinite(minContactSeenM) ? minContactSeenM : null,
    keepRate: cycleRows.filter((r) => r.action === 'keep').length / Math.max(cycleRows.length, 1),
    resentSamePlanRate: cycleRows.filter((r) => r.resentSamePlan).length / Math.max(cycleRows.length, 1),
    parseFailures: cycleRows.filter((r) => r.parseOk === false).length,
    callFailures: cycleRows.filter((r) => r.callOk === false).length,
    inferMs: infers.length
      ? { n: infers.length, p50: infers[Math.floor(infers.length / 2)], max: infers[infers.length - 1] }
      : null,
    renderMsP50: (() => {
      const rs = cycleRows.map((r) => r.renderMs).sort((a, b) => a - b);
      return rs.length ? rs[Math.floor(rs.length / 2)] : null;
    })(),
    pageErrors,
  };
  fs.writeFileSync(path.join(opts.outDir, 'summary.json'), JSON.stringify(summary, null, 2));

  console.log('\n================ episode summary ================');
  console.log(`arm                 ${summary.arm}${summary.model ? ' / ' + summary.model : ''}`);
  console.log(`arrived             ${summary.arrived}  (${summary.cycles} cycles, ${summary.simSecondsElapsed.toFixed(0)} sim s)`);
  console.log(`direct / path       ${summary.directDistanceM.toFixed(0)} m / ${summary.pathLengthM.toFixed(0)} m  ratio ${summary.pathRatio ? summary.pathRatio.toFixed(2) : '-'}`);
  console.log(`min contact seen    ${summary.minContactSeenM != null ? summary.minContactSeenM.toFixed(0) + ' m' : '-'}`);
  console.log(`keep rate           ${(summary.keepRate * 100).toFixed(0)} %   same-plan resend ${(summary.resentSamePlanRate * 100).toFixed(0)} %`);
  console.log(`parse / call fails  ${summary.parseFailures} / ${summary.callFailures}`);
  console.log(`infer p50 / max     ${summary.inferMs ? summary.inferMs.p50 + ' / ' + summary.inferMs.max + ' ms' : '-'}   render p50 ${summary.renderMsP50} ms`);
  console.log(`\n[nav] images + decisions.jsonl + summary.json + overview.png -> ${path.relative(ROOT, opts.outDir)}`);
  if (pageErrors.length) console.log('[nav] page errors:', pageErrors);

  decisionLog.end();
  await browser.close();
  server.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
