/**
 * vlm_navigator_run.js — VLM航海士の閉ループを1エピソード走らせる（ヘッドレス実験ランナー）
 *
 * 何が閉じているか:
 *   3DCG（digital-twin/）のブリッジ一人称カメラ → VLM → 航路プラン（waypoint列）
 *     → World.orders → 既存 BoatController → AsvPlatform の運動学 → 船が動く → 次サイクルの絵
 *
 * 【判断のロジックはこのファイルに無い】
 * 状況図・プロンプト・パース・サニタイズ・プランの保持は全て core/sim/navigator/ にあり、
 * ページ側（digital-twin/?nav=vlm）も同じモジュールを使う。したがって
 * **画面で見えている挙動と、このランナーが出す実験ログの数字は同じコードから出る**。
 * ここに残っているのは「実験の運営」だけである: ブラウザの起動、シム時間の刻み、
 * 画像とJSONLの保存、集計の表示。
 *
 * 作りの制約と理由:
 * - シムとレンダリングはブラウザ（digital-twin/）側に置き、Node は「推論と記録」だけを持つ。
 *   Ollama を Node から叩くのでブラウザの CORS 設定に依存しない（ページ側で動かす場合は
 *   scripts/serve_vlm.js の同一オリジン中継を使う）。
 * - digital-twin/ のコードは無変更で使う。ページには window.__debug 経由でスクリプトを注入し、
 *   撮影・進行はそこから駆動する。注入コードも core/sim/navigator/ を動的 import するので、
 *   ページ内に判断ロジックの複製は無い。
 * - 進行はシム時間で刻む（dt=0.1s、判断は intervalS シム秒ごと）。推論に何秒かかっても
 *   軌跡は変わらない（docs/time-model.md §9 の headless 側の扱いと同じ）。
 * - 撮影のあいだだけ renderer を固定解像度へ切り替えて元に戻すので、表示canvasのサイズに依存しない
 *   （ThreeCameraSensor.captureSize）。
 *
 * アーム:
 *   --arm vlm      画像＋状況テキスト → VLM が keep/replace を返す（主経路）
 *   --arm blind    同じ状況テキストのみ（画像なし）。視覚が効いているかの統制群
 *   --arm scripted 推論なし。目的地へ直行。サーバが無くても必ず完走する基準線
 *
 * 使い方:
 *   node scripts/vlm_navigator_run.js --arm vlm --model qwen2.5vl:7b
 *   node scripts/vlm_navigator_run.js --arm scripted --scenario pilotage_m1
 *
 *   --arm vlm|blind|scripted  既定 vlm
 *   --scenario NAME    core/scenarios/<name>.json。既定 pilotage_m3（交通船2隻あり）。
 *                      pilotage_m1 は同じ出発点・目的地で空海面（統制用の基準線）
 *   --model NAME       既定 qwen2.5vl:7b。**非thinkingのVLMを選ぶこと**——thinking 系
 *                      （qwen3-vl:8b 等）は画像1枚の判断で reasoning が予算を食い切り、
 *                      maxTokens 1,400 でも本文が空のまま返る（thinking_overrun）。
 *                      Ollama 0.33.2 では think:false でも止まらないことを実測（2026-09-05）
 *   --url URL          既定 http://localhost:11434/v1
 *   --transport openai|ollama  推論サーバへの経路。既定 openai。
 *                      thinking 系VLM（qwen3-vl 等）で thinking を切るには ollama が要る
 *                      （実測: OpenAI互換の enable_thinking を Ollama は無視する）
 *   --thinking auto|on|off     既定 auto
 *   --cycles N         最大判断サイクル数。既定 12
 *   --interval S       判断間隔（シム秒）。既定 10
 *   --render S         render ステージの宣言値（シム秒）。既定 0.1
 *   --infer S          infer ステージの宣言値（シム秒）。既定 2.0
 *   --res WxH          カメラ画像の解像度。既定 640x360
 *   --arrival M        到達半径。既定 40
 *   --dest E,N         目的地の上書き（シーン原点基準のメートル）
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

/** 物理ステップ。headless_run.js / digital-twin/nav_mode.js と同じ */
const DT_S = 0.1;

function parseArgs(argv) {
  const o = {
    arm: 'vlm',
    scenario: 'pilotage_m3',
    model: 'qwen2.5vl-7b-ctx3k',
    url: 'http://localhost:11434/v1',
    transport: 'openai',
    thinking: 'auto',
    cycles: 12,
    intervalS: 10,
    renderS: 0.1,
    inferS: 2.0,
    res: { w: 640, h: 360 },
    arrivalM: 40,
    destination: null,
    maxTokens: 400,
    timeoutMs: 60000,
    outDir: null,
    warmup: true,
    port: 8974,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--arm') o.arm = argv[++i];
    else if (a === '--scenario') o.scenario = argv[++i];
    else if (a === '--model') o.model = argv[++i];
    else if (a === '--url') o.url = argv[++i];
    else if (a === '--transport') o.transport = argv[++i];
    else if (a === '--thinking') o.thinking = argv[++i];
    else if (a === '--cycles') o.cycles = Number(argv[++i]);
    else if (a === '--interval') o.intervalS = Number(argv[++i]);
    else if (a === '--render') o.renderS = Number(argv[++i]);
    else if (a === '--infer') o.inferS = Number(argv[++i]);
    else if (a === '--arrival') o.arrivalM = Number(argv[++i]);
    else if (a === '--max-tokens') o.maxTokens = Number(argv[++i]);
    else if (a === '--timeout-ms') o.timeoutMs = Number(argv[++i]);
    else if (a === '--out-dir') o.outDir = argv[++i];
    else if (a === '--no-warmup') o.warmup = false;
    else if (a === '--port') o.port = Number(argv[++i]);
    else if (a === '--dest') {
      const parts = String(argv[++i]).split(',').map(Number);
      if (parts.length !== 2 || !parts.every(Number.isFinite)) throw new Error('--dest の形式は east,north');
      o.destination = { eastM: parts[0], northM: parts[1] };
    } else if (a === '--res') {
      const m = /^(\d+)x(\d+)$/.exec(argv[++i]);
      if (!m) throw new Error('--res の形式は 640x360');
      o.res = { w: Number(m[1]), h: Number(m[2]) };
    } else if (a === '--help') {
      console.log(fs.readFileSync(__filename, 'utf8').split('*/')[0]);
      process.exit(0);
    } else throw new Error(`unknown option: ${a}`);
  }
  if (!['vlm', 'blind', 'scripted'].includes(o.arm)) throw new Error(`--arm は vlm|blind|scripted: ${o.arm}`);
  if (!['openai', 'ollama'].includes(o.transport)) throw new Error(`--transport は openai|ollama: ${o.transport}`);
  if (!['auto', 'on', 'off'].includes(o.thinking)) throw new Error(`--thinking は auto|on|off: ${o.thinking}`);
  // Ollama ネイティブは /api/chat に居る。/v1 付きの既定URLをそのまま渡すと 404 になるので直す
  if (o.transport === 'ollama') o.url = o.url.replace(/\/v1\/?$/, '');
  if (o.renderS + o.inferS >= o.intervalS) {
    // 発効前に次の発行が来る設定。スケジューラなら pending 中は再発行しないだけだが、
    // このランナーは1サイクル＝1発行の単純な形なので、設定ミスとしてここで落とす
    throw new Error(`--render + --infer (${o.renderS + o.inferS}s) は --interval (${o.intervalS}s) 未満である必要がある`);
  }
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
// ここに置くコードは判断を一切しない（推論は Node 側）。やるのは
// 「core/sim/navigator/ の部品でシムを進め、状況図と絵を返す」ことだけである。
// 状況図の作り方をここに書き写さないのが要——書き写した瞬間、画面と実験ログが別物になる。
// ---------------------------------------------------------------------------

const INSTALL_NAV = ({ arrivalM, destination, withImage, res }) => `
(async () => {
  const { three, world, scenario, traffic } = window.__debug;
  window.__debug.paused = true;              // main.js の rAF ループを止め、進行はこちらが持つ
  const [picMod, planMod] = await Promise.all([
    import('/core/sim/navigator/navigator_picture.js'),
    import('/core/sim/navigator/plan_follower.js'),
  ]);
  const heroId = window.__debug.heroId ?? world.state.id[0];
  const ARRIVAL_M = ${arrivalM};
  const DT = ${DT_S};

  // 目的地の出所は --dest → シナリオ destinationLatLon → protectedAsset の順（ページ側と同じ規則）
  const override = ${JSON.stringify(destination)};
  let dest;
  if (override) dest = override;
  else if (scenario?.destinationLatLon) {
    const p = world.scene.projection.latLonToLocal(scenario.destinationLatLon.lat, scenario.destinationLatLon.lon);
    dest = { eastM: p.x, northM: p.y };
  } else if (world.protectedAsset) dest = { eastM: world.protectedAsset.x, northM: world.protectedAsset.y };
  else {
    const i = world.state.indexOf(heroId);
    dest = { eastM: world.state.x[i] + 500, northM: world.state.y[i] - 300 };
  }

  const plan = new planMod.RoutePlan({ destination: dest, arrivalM: ARRIVAL_M });
  if (${withImage ? 'true' : 'false'}) world.sensors.camera.captureSize = { w: ${res.w}, h: ${res.h} };

  const trail = [];
  let arrived = false;
  let pathLengthM = 0;
  let minTrafficM = Infinity;   // M3 の主指標（最接近距離）

  function pose() {
    const i = world.state.indexOf(heroId);
    return { eastM: world.state.x[i], northM: world.state.y[i] };
  }

  window.__vlmNav = {
    heroId,
    destination: dest,
    bounds: world.scene.bounds,

    setPlan(waypoints) { return plan.setWaypoints(waypoints); },
    getPlan() { return plan.snapshot(); },

    /** 発行時刻の状況図を1つ。撮影もここで行う（画像は状況図の一部） */
    picture() {
      let image = null;
      let renderMs = 0;
      if (${withImage ? 'true' : 'false'}) {
        const t0 = performance.now();
        const cam = world.observe(heroId, 'camera');
        renderMs = performance.now() - t0;
        image = cam ? cam.imageDataUrl : null;
      }
      const pic = picMod.buildNavigatorPicture(world, heroId, {
        destination: dest,
        plan: plan.snapshot(),
        arrivalM: ARRIVAL_M,
        image,
      });
      return { picture: pic, renderMs, arrived, pathLengthM };
    },

    /** シム時間を simSeconds だけ進める。実時間ではなくシム時間で刻む */
    advance(simSeconds) {
      const steps = Math.round(simSeconds / DT);
      const trafficIds = traffic ? new Set(traffic.specs.map((sp) => sp.id)) : null;
      for (let k = 0; k < steps; k++) {
        planMod.applyPlanOrder(world, heroId, plan);   // 通過した waypoint を落とし、指示を書く
        for (let i = 0; i < world.state.count; i++) {
          if (!world.state.alive[i]) continue;
          const id = world.state.id[i];
          // 交通船は spline 上を進めるので運動学を解かない（core/sim/traffic.js）
          if (trafficIds && trafficIds.has(id)) continue;
          const platform = world.platformInstances.get(id);
          let action;
          if (id === heroId) {
            const observation = {
              radar: world.observe(id, 'radar'),
              position: { x: world.state.x[i], y: world.state.y[i], heading: world.state.heading[i], speed: world.state.speed[i] },
              timestamp: world.clock,
            };
            action = world.boatController.decide(world.orders.get(id), observation, id, world.state.faction[i]);
          } else {
            action = { throttle: 0.3, steering: 0.04 };   // 周囲の交通は main.js と同じスクリプト動作
          }
          const x0 = world.state.x[i], y0 = world.state.y[i];
          platform.step(world.state, i, action, DT, world.environment, world.clock);
          if (id === heroId) pathLengthM += Math.hypot(world.state.x[i] - x0, world.state.y[i] - y0);
        }
        if (traffic) {
          traffic.step(world, DT);
          const nearest = traffic.nearestTo(world, heroId);
          if (nearest && nearest.rangeM < minTrafficM) minTrafficM = nearest.rangeM;
        }
        world.clock += DT;

        // 毎ステップ updateShips を呼ぶ（間引かない）。近傍海面パッチと影のカメラは
        // updateShips の中で注視点へ 8%/回の補間で追従する作りなので、判断サイクルごとに
        // 1回しか呼ばないと船が海面パッチから出てしまい、カメラ画像に海の無い領域
        // （地面がそのまま見える）が写る。VLM への入力画像が壊れるので間引けない。
        three.updateShips(world.state.snapshot(), world.clock);

        if (plan.hasArrived(pose())) { arrived = true; break; }
      }
      const p = pose();
      const i = world.state.indexOf(heroId);
      trail.push({ t: world.clock, ...p, headingDeg: (world.state.heading[i] * 180) / Math.PI });
      three.updateOverviewCamera(DT);
      three.render(world.clock);
      return {
        clock: world.clock,
        arrived,
        pathLengthM,
        pose: p,
        plan: plan.snapshot(),
        minTrafficM: Number.isFinite(minTrafficM) ? minTrafficM : null,
        trafficCount: traffic ? traffic.count : 0,
      };
    },

    /**
     * 俯瞰の1枚（最終位置の目視確認用）。
     * three.updateOverviewCamera() のオービット注視点は毎フレーム 0.08 ずつしか寄らない前提の
     * 補間なので、10シム秒に1回しか呼ばれないこのループでは船に追いつかない（実際に空の海面が
     * 写った）。ここではヒーロー艇の現在位置に直接カメラを置く。
     */
    overview() {
      const p = pose();
      three.overviewCamera.position.set(p.eastM + 70, 34, -p.northM + 70);
      three.overviewCamera.lookAt(p.eastM, 4, -p.northM);
      three.render(world.clock);
      return three.renderer.domElement.toDataURL('image/png');
    },

    trail() { return trail.slice(); },
  };
  return true;
})()
`;

// ---------------------------------------------------------------------------

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  fs.mkdirSync(opts.outDir, { recursive: true });
  const decisionLog = fs.createWriteStream(path.join(opts.outDir, 'decisions.jsonl'), { flags: 'a' });

  // 判断は core/sim/navigator/ の decider がそのまま行う（ページ側と同じインスタンス型）
  const { createVlmNavigatorFn, scriptedNavigator } = await import('../core/sim/navigator/vlm_navigator.js');
  const { postChatCompletion } = await import('../core/sim/agents/llm_http.js');
  const { fetchDeclaredNumCtx } = await import('../core/sim/agents/context_budget.js');

  // モデルが宣言している num_ctx を読む。コード側に書かない（食い違いを構造的に無くす）。
  // これが取れると、実測 prompt_tokens と突き合わせて「入力が切り捨てられたか」を判定できる
  // ——切り捨てはエラーにならないので、判定しないと気付けない（docs/multi-vlm-gpu-budget.md §2）。
  const declaredNumCtx =
    opts.arm === 'scripted' ? null : await fetchDeclaredNumCtx({ baseUrl: opts.url, model: opts.model });
  if (opts.arm !== 'scripted') {
    console.log(
      `[nav] num_ctx（モデルの宣言）= ${declaredNumCtx ?? '未宣言（モデル既定＝非常に大きい可能性）'}` +
        (declaredNumCtx ? '' : ' — scripts/suggest_num_ctx.js で絞った派生モデルを推奨')
    );
  }

  const withImage = opts.arm === 'vlm';
  const latencyS = opts.renderS + opts.inferS;

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

  console.log(
    `[nav] arm=${opts.arm} scenario=${opts.scenario} model=${opts.model} ` +
      `cycles=${opts.cycles} interval=${opts.intervalS}s stages=render ${opts.renderS}s + infer ${opts.inferS}s`
  );
  await page.goto(`http://localhost:${opts.port}/digital-twin/?scenario=${encodeURIComponent(opts.scenario)}`, {
    waitUntil: 'domcontentloaded',
    timeout: 20000,
  });
  await page.waitForFunction('window.__debug && window.__debug.world && window.__debug.world.state.count > 0', {
    timeout: 30000,
  });
  await new Promise((r) => setTimeout(r, 4000)); // シーン（水面・ランドマーク）が出そろうのを待つ
  await page.evaluate(INSTALL_NAV({ arrivalM: opts.arrivalM, destination: opts.destination, withImage, res: opts.res }));
  const setup = await page.evaluate(
    '({ hero: window.__vlmNav.heroId, dest: window.__vlmNav.destination, bounds: window.__vlmNav.bounds })'
  );
  console.log(
    `[nav] hero=${setup.hero} destination=(${setup.dest.eastM.toFixed(0)}, ${setup.dest.northM.toFixed(0)}) ` +
      `bounds x[${setup.bounds.minX.toFixed(0)},${setup.bounds.maxX.toFixed(0)}] y[${setup.bounds.minY.toFixed(0)},${setup.bounds.maxY.toFixed(0)}]`
  );

  // onCall で1コールぶんの記録（プロンプト・生応答・落とした点の理由・実測 t_wall）を受け取る
  let lastCall = null;
  const decide =
    opts.arm === 'scripted'
      ? scriptedNavigator({ boatId: setup.hero })
      : createVlmNavigatorFn({
          boatId: setup.hero,
          intervalS: opts.intervalS,
          latencyS,
          baseUrl: opts.url,
          model: opts.model,
          maxTokens: opts.maxTokens,
          timeoutMs: opts.timeoutMs,
          transport: opts.transport,
          thinking: opts.thinking,
          numCtx: declaredNumCtx,
          onCall: (record) => {
            lastCall = record;
          },
        });

  if (opts.arm !== 'scripted' && opts.warmup) {
    process.stdout.write('[nav] warming up the model ... ');
    const t0 = Date.now();
    try {
      await postChatCompletion({
        baseUrl: opts.url,
        model: opts.model,
        maxTokens: 64,
        timeoutMs: opts.timeoutMs,
        transport: opts.transport,
        thinking: opts.thinking,
        systemPrompt: 'reply with JSON only',
        userPrompt: 'warmup. reply {"watch":"none","action":"keep","waypoints":[],"speed":"cruise"}',
      });
      console.log(`ok ${Date.now() - t0} ms`);
    } catch (err) {
      console.log(`FAILED ${err?.kind ?? 'unknown'} ${Date.now() - t0} ms — ${err?.message ?? err}`);
    }
  }

  const start = await page.evaluate('window.__vlmNav.picture()');
  const directDistanceM = Math.hypot(
    setup.dest.eastM - start.picture.self.eastM,
    setup.dest.northM - start.picture.self.northM
  );

  const cycleRows = [];
  let arrived = false;
  let minContactSeenM = Infinity;

  for (let cycle = 0; cycle < opts.cycles && !arrived; cycle++) {
    const snap = await page.evaluate('window.__vlmNav.picture()');
    const picture = snap.picture;
    if (withImage && !picture.imageDataUrl) throw new Error('camera sensor returned no image');
    for (const c of picture.radar.contacts) minContactSeenM = Math.min(minContactSeenM, c.rangeM);

    let imgName = null;
    if (picture.imageDataUrl) {
      imgName = `c${String(cycle).padStart(2, '0')}.png`;
      fs.writeFileSync(path.join(opts.outDir, imgName), Buffer.from(picture.imageDataUrl.split(',')[1], 'base64'));
    }

    lastCall = null;
    const decision = await decide(picture);

    // 発効は t_issue + renderS + inferS（宣言値）。それまでは現行プランのまま進める。
    // headless_run.js §9 と同じ理屈で、推論を await してから物理を進めても決定論は保たれる
    // ——t_issue〜t_apply の物理は現行プランだけで決まり、発行中の推論結果に依存しないため。
    // 「推論が速かったから早く曲がった」が起きないのはこの2段構えによる。
    const beforeApply = await page.evaluate(`window.__vlmNav.advance(${latencyS})`);
    let applied = false;
    if (!beforeApply.arrived && decision.action === 'replace' && decision.waypoints) {
      applied = await page.evaluate(`window.__vlmNav.setPlan(${JSON.stringify(decision.waypoints)})`);
    }
    const after = beforeApply.arrived
      ? beforeApply
      : await page.evaluate(`window.__vlmNav.advance(${opts.intervalS - latencyS})`);
    arrived = after.arrived;

    const row = {
      cycle,
      tIssueS: picture.t,
      tApplyS: picture.t + latencyS,
      appliedPlan: applied,
      tAfterS: after.clock,
      // 宣言値（ルール側）と実測（記録側）は別の項目にする。混ぜない（time-model.md §2.5 I1）
      declared: { intervalS: opts.intervalS, renderS: opts.renderS, inferS: opts.inferS, latencyS },
      measured: { renderMs: Math.round(snap.renderMs), inferMs: decision.latencyMs },
      outcome: decision.outcome,
      promptTokens: decision.promptTokens,
      context: decision.context,
      action: decision.action,
      resentSamePlan: decision.resentSamePlan,
      watch: decision.watch,
      speed: decision.speed,
      waypoints: decision.waypoints,
      notes: decision.notes,
      failure: decision.failure,
      hadImage: decision.hadImage,
      userPrompt: lastCall?.userPrompt ?? null,
      rawText: lastCall?.raw ?? null,
      // 画像は別ファイルに書いてある。JSONL に data URL を入れると1行が数十KBになる
      situation: { ...picture, imageDataUrl: undefined },
      image: imgName,
      pose: after.pose,
      planAfter: after.plan,
      pathLengthM: after.pathLengthM,
      minTrafficM: after.minTrafficM,
      trafficCount: after.trafficCount,
      arrived: after.arrived,
    };
    cycleRows.push(row);
    decisionLog.write(JSON.stringify(row) + '\n');

    const wpStr = decision.waypoints
      ? decision.waypoints.map((w) => `(${w.eastM.toFixed(0)},${w.northM.toFixed(0)})`).join('->')
      : '-';
    console.log(
      `\n[c${cycle}] t=${picture.t.toFixed(0)}s own(${picture.self.eastM.toFixed(0)},${picture.self.northM.toFixed(0)}) ` +
        `hdg ${picture.self.headingDeg.toFixed(0)}deg  dest ${picture.destination.rangeM.toFixed(0)}m ${picture.destination.relative}` +
        `  contacts=${picture.radar.contacts.length}` +
        `\n      render ${Math.round(snap.renderMs)}ms  infer ${decision.latencyMs}ms  outcome ${decision.outcome}` +
        (decision.failure ? ` — ${decision.failure}` : '') +
        `\n      watch: ${decision.watch ?? '-'}` +
        `\n      action: ${decision.action}${decision.resentSamePlan ? ' (same plan resent)' : ''}  plan: ${wpStr}` +
        (decision.notes.length ? `  notes: ${decision.notes.join('; ')}` : '') +
        `\n      -> after ${opts.intervalS}s: (${after.pose.eastM.toFixed(0)},${after.pose.northM.toFixed(0)})` +
        `${after.arrived ? '  ARRIVED' : ''}`
    );
  }

  // 俯瞰1枚と軌跡
  const overviewUrl = await page.evaluate('window.__vlmNav.overview()');
  fs.writeFileSync(path.join(opts.outDir, 'overview.png'), Buffer.from(overviewUrl.split(',')[1], 'base64'));
  const trail = await page.evaluate('window.__vlmNav.trail()');
  fs.writeFileSync(path.join(opts.outDir, 'trail.json'), JSON.stringify(trail, null, 2));

  const last = cycleRows[cycleRows.length - 1];
  const infers = cycleRows.map((r) => r.measured.inferMs).filter((v) => v > 0).sort((a, b) => a - b);
  const renders = cycleRows.map((r) => r.measured.renderMs).filter((v) => v > 0).sort((a, b) => a - b);
  const stats = decide.stats ?? {};
  const summary = {
    arm: opts.arm,
    scenario: opts.scenario,
    model: opts.arm === 'scripted' ? null : opts.model,
    transport: opts.transport,
    thinking: opts.thinking,
    numCtxDeclared: declaredNumCtx,
    maxPromptTokens: stats.maxPromptTokens ?? null,
    contextOverflows: stats.contextOverflows ?? 0,
    contextTight: stats.contextTight ?? 0,
    declared: { intervalS: opts.intervalS, renderS: opts.renderS, inferS: opts.inferS, latencyS },
    cycles: cycleRows.length,
    arrived,
    directDistanceM,
    pathLengthM: last?.pathLengthM ?? 0,
    pathRatio: last?.pathLengthM ? last.pathLengthM / directDistanceM : null,
    simSecondsElapsed: last?.tAfterS ?? 0,
    minContactSeenM: Number.isFinite(minContactSeenM) ? minContactSeenM : null,
    // 交通船との最接近距離。M3 の主指標（計画 §6）で、回避できたかはここに出る
    trafficCount: last?.trafficCount ?? 0,
    minTrafficM: last?.minTrafficM ?? null,
    keepRate: (stats.keeps ?? 0) / Math.max(stats.calls ?? cycleRows.length, 1),
    resentSamePlan: stats.resentSamePlan ?? 0,
    parseFailures: stats.parseFailures ?? 0,
    transportFailures: stats.transportFailures ?? 0,
    droppedByReason: stats.droppedByReason ?? {},
    byOutcome: stats.byOutcome ?? {},
    totalOutputTokens: stats.totalOutputTokens ?? 0,
    measured: {
      inferMs: infers.length ? { n: infers.length, p50: infers[Math.floor(infers.length / 2)], max: infers[infers.length - 1] } : null,
      renderMs: renders.length ? { n: renders.length, p50: renders[Math.floor(renders.length / 2)], max: renders[renders.length - 1] } : null,
    },
    pageErrors,
  };
  fs.writeFileSync(path.join(opts.outDir, 'summary.json'), JSON.stringify(summary, null, 2));

  console.log('\n================ episode summary ================');
  console.log(`arm / scenario      ${summary.arm} / ${summary.scenario}${summary.model ? ' / ' + summary.model : ''}`);
  console.log(`arrived             ${summary.arrived}  (${summary.cycles} cycles, ${summary.simSecondsElapsed.toFixed(0)} sim s)`);
  console.log(`direct / path       ${summary.directDistanceM.toFixed(0)} m / ${summary.pathLengthM.toFixed(0)} m  ratio ${summary.pathRatio ? summary.pathRatio.toFixed(2) : '-'}`);
  console.log(
    `traffic             ${summary.trafficCount} 隻   最接近 ${summary.minTrafficM != null ? summary.minTrafficM.toFixed(0) + ' m' : '-'}`
  );
  console.log(`keep rate           ${(summary.keepRate * 100).toFixed(0)} %   same-plan resend ${summary.resentSamePlan}`);
  console.log(`parse / transport   ${summary.parseFailures} / ${summary.transportFailures}`);
  if (opts.arm !== 'scripted') {
    const budget =
      summary.numCtxDeclared && summary.maxPromptTokens
        ? `${summary.maxPromptTokens} + ${opts.maxTokens} / ${summary.numCtxDeclared}`
        : `${summary.maxPromptTokens ?? '-'} tok（宣言 num_ctx 不明）`;
    console.log(
      `context            prompt最大 ${budget}` +
        `   overflow ${summary.contextOverflows} / tight ${summary.contextTight}` +
        (summary.contextOverflows > 0 ? '  ← **入力が切り捨てられた。この結果は信用できない**' : '')
    );
  }
  console.log(`dropped waypoints   ${Object.entries(summary.droppedByReason).map(([k, v]) => `${k}×${v}`).join(', ') || '-'}`);
  console.log(
    `measured (記録のみ)  infer p50/max ${summary.measured.inferMs ? summary.measured.inferMs.p50 + '/' + summary.measured.inferMs.max + ' ms' : '-'}` +
      `   render p50 ${summary.measured.renderMs ? summary.measured.renderMs.p50 + ' ms' : '-'}`
  );
  console.log(`declared (ルール側)  interval ${opts.intervalS}s / apply at t_issue + ${latencyS.toFixed(1)}s`);
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
