/**
 * main.js — digital-twin View のエントリポイント
 *
 * core/ をインポートしてWorldを初期化し、シミュレーションループを駆動する。
 *
 * 既定（?nav= 無指定）はセンサー実証。艇は単純なスクリプト動作で走り、
 * カメラ・レーダー・GNSS の値をHUDに出すだけで、意思決定は一切しない。
 * サーバー不要の静的サイトとしてそのまま動く（CLAUDE.md の構成方針）。
 *
 * `?nav=vlm` を付けると**1隻をVLMに自動航行させる**モードになる（nav_mode.js）。
 * このとき進行は rAF の実時間そのままではなく固定ステップ（DT_S）の蓄積で刻み、
 * 発行・発効・推論待ちを DecisionScheduler が管理する（docs/time-model.md §8・§9）。
 * 推論は同一オリジンの /vlm/v1 へ投げる前提で、中継は scripts/serve_vlm.js が行う
 * （推論URL・モデル名をページに埋め込まないため）。
 */

import { loadSceneFromScenario } from '../core/data/adapters/index.js';
import { World } from '../core/sim/world.js';
import { buildThreeScene } from './scene_builder.js';
import { ThreeCameraSensor } from './camera_sensor.js';
import { renderCameraPanel, renderRadarPanel, renderGnssPanel } from './hud.js';
import { parseNavOptions, createNavigatorMode, DT_S } from './nav_mode.js';
import { mountNavPanel, renderNavPanel } from './nav_hud.js';
import { createPlanOverlay } from './nav_overlay_3d.js';
import { buildTrafficFromScenario, SplineTraffic } from '../core/sim/traffic.js';

const DEFAULT_SCENARIO = 'tokyo_bay_minimal';

/** ?scenario= はswarm-sim/main.jsと同じ名前解決（core/scenarios/<name>.json）。既定は従来どおりtokyo_bay_minimal */
async function loadScenario(params) {
  const name = (params.get('scenario') ?? DEFAULT_SCENARIO).replace(/[^a-z0-9_]/gi, '');
  const res = await fetch(`../core/scenarios/${name}.json`);
  if (!res.ok) throw new Error(`シナリオ読み込み失敗: ${res.status} (${name})`);
  return res.json();
}

/**
 * 航行モードの目的地。「外部から大まかに与えられた目的地」（計画 §1）の実体で、出所は3つある。
 * 優先順は ?dest= → シナリオの destinationLatLon → protectedAsset。
 * どれも無ければ現在地から南東へ 500m 先を置く（シナリオを選ばずに動かせるようにするため）。
 */
function resolveDestination({ navOptions, scenario, scene, spawnLocal }) {
  if (navOptions.destination) return navOptions.destination;
  if (scenario.destinationLatLon) {
    const p = scene.projection.latLonToLocal(scenario.destinationLatLon.lat, scenario.destinationLatLon.lon);
    return { eastM: p.x, northM: p.y };
  }
  if (scenario.protectedAssetLatLon) {
    const p = scene.projection.latLonToLocal(scenario.protectedAssetLatLon.lat, scenario.protectedAssetLatLon.lon);
    return { eastM: p.x, northM: p.y };
  }
  const start = spawnLocal[0].local;
  return { eastM: start.x + 500, northM: start.y - 300 };
}

async function main() {
  const params = new URLSearchParams(location.search);
  const navOptions = parseNavOptions(params);
  const scenario = await loadScenario(params);
  const scene = await loadSceneFromScenario(scenario);

  const spawnLocal = scenario.spawns.map((s) => ({ ...s, local: scene.projection.latLonToLocal(s.lat, s.lon) }));
  const focus = {
    x: spawnLocal.reduce((sum, s) => sum + s.local.x, 0) / spawnLocal.length,
    y: spawnLocal.reduce((sum, s) => sum + s.local.y, 0) / spawnLocal.length,
  };

  // HUDにセンサー値を表示する艇を主役とし、3Dカメラも同じ艇を追う（表示の一貫性）
  const heroId = scenario.spawns[0].id;

  const canvas = document.getElementById('scene-canvas');
  const three = buildThreeScene(canvas, scene, { focus, focusEntityId: heroId });
  const cameraSensor = new ThreeCameraSensor(three);
  // protectedAssetはswarm-sim側の攻防ロジック（mission.js）が使う。ここではまだ評価・描画しないが、
  // 同じWorld設定を素通しでき、Worldインスタンスの構成をswarm-sim/env_apiと揃えておく。
  const protectedAsset = scenario.protectedAssetLatLon
    ? scene.projection.latLonToLocal(scenario.protectedAssetLatLon.lat, scenario.protectedAssetLatLon.lon)
    : null;
  const world = new World({
    scene,
    cameraSensor,
    // 交通船（シナリオの traffic 節）も同じ EntityState に乗るので、容量に数える
    capacity: scenario.spawns.length + (scenario.traffic?.length ?? 0),
    protectedAsset,
    radarRangeM: scenario.sensors?.radarRangeM,
    radarPerShipClass: scenario.sensors?.perShipClass === true,
    radarRangeScale: scenario.sensors?.radarScale,
    episodeTimeLimitS: scenario.episodeTimeLimitS,
  });
  // devtools確認用フック。ヘッドレス実験ランナー（scripts/vlm_navigator_run.js）が
  // ページ側へコードを注入する際の唯一の入口でもあるので、注入側が必要とするものは全部載せる
  // （載せ忘れるとランナーが core の部品を再実装することになり、画面と実験ログが別コードになる）。
  window.__debug = { three, world, focus, scene, scenario, heroId, cameraSensor };

  for (const spawn of spawnLocal) {
    world.spawn({
      id: spawn.id,
      faction: spawn.faction,
      shipClass: spawn.shipClass,
      platform: spawn.platform,
      x: spawn.local.x,
      y: spawn.local.y,
      heading: (spawn.headingDeg * Math.PI) / 180,
    });
  }

  // 交通船（spline 経路を一定速力で走る障害物）。シナリオに traffic 節が無ければ null。
  // 自艇の spawn より後に置くのは、EntityState の index 0 が主役艇である前提を崩さないため。
  const trafficSpecs = buildTrafficFromScenario(scenario, scene.projection);
  const traffic = trafficSpecs.length > 0 ? new SplineTraffic(trafficSpecs) : null;
  if (traffic) traffic.spawn(world);
  // 注入側（scripts/vlm_navigator_run.js）が同じインスタンスを進めるために公開する。
  // ここで公開せずに注入側で作り直すと、交通船が二重に spawn されるか進行が食い違う。
  window.__debug.traffic = traffic;

  // --- 航行モード（?nav=）---
  let nav = null;
  if (navOptions) {
    const destination = resolveDestination({ navOptions, scenario, scene, spawnLocal });
    // 回り続ける俯瞰カメラでは、航路と waypoint の左右がフレームごとに入れ替わって読めない。
    // 航行モードでは方位固定の第三者視点を既定にする（?cam=orbit で従来表示へ戻せる）。
    three.setCameraMode(navOptions.cameraMode);
    const overlay = navOptions.plan3d ? createPlanOverlay(three.scene3d, three.overviewCamera) : null;
    nav = createNavigatorMode({
      world,
      three,
      cameraSensor,
      boatId: heroId,
      destination,
      options: navOptions,
      traffic,
      overlay,
    });
    mountNavPanel();
    document.getElementById('caption').textContent =
      `VLM航行モード（arm=${navOptions.arm}）— 艇 ${heroId} が目的地 ` +
      `(${Math.round(destination.eastM)}, ${Math.round(destination.northM)}) へ自動航行する` +
      (traffic ? ` / 交通船 ${traffic.count} 隻を回避する` : '');
    window.__nav = nav; // devtools から状態・記録を覗くためのフック
    nav.warmUp(); // コールドスタート（実測20s超）は待たずに始め、HUD に進捗を出す
  }

  let camTick = 0;
  let lastT = performance.now();
  let elapsed = 0;
  let accumulatorS = 0;

  window.addEventListener('resize', () => three.resize());

  function loop(nowMs) {
    if (window.__debug?.paused) {
      requestAnimationFrame(loop);
      return;
    }
    const dt = Math.min((nowMs - lastT) / 1000, 0.1);
    lastT = nowMs;
    elapsed += dt;

    if (nav) {
      // 固定ステップで刻む。推論に何秒かかっても軌跡は変わらない（time-model.md §9）
      accumulatorS += dt * navOptions.timeScale;
      while (accumulatorS >= DT_S) {
        if (!nav.stepOnce(nowMs)) {
          // 推論待ち・到達。溜まった時間は捨てる（残すと再開時に早送りになり、
          // latencyS で表現している「指示が効くまでの間」が画面から消える）
          accumulatorS = 0;
          break;
        }
        accumulatorS -= DT_S;
      }
    } else {
      for (let i = 0; i < world.state.count; i++) {
        const platform = world.platformInstances.get(world.state.id[i]);
        // B-3対応: EnvApi.step()と同じくenvironment/現在時刻を渡す（差し込み口が両方の
        // 呼び出し経路で一貫して効くようにする。CalmSeaEnvironmentは近ゼロ効果のため
        // 見た目は変化しない）。
        platform.step(world.state, i, { throttle: 0.3, steering: 0.04 }, dt, world.environment, world.clock);
      }
      world.clock += dt;
    }

    three.updateShips(world.state.snapshot(), elapsed);
    if (nav) nav.updateOverlay();
    three.updateOverviewCamera(dt);
    three.render(elapsed);

    // カメラは重いので数フレームに1回だけ取得（§計算効率化の指針: 意思決定/センサーの間引き）
    camTick++;
    if (camTick % 12 === 0) {
      renderCameraPanel(world.observe(heroId, 'camera'));
    }
    const heroIndex = world.state.indexOf(heroId);
    renderRadarPanel(world.observe(heroId, 'radar'), world.state.heading[heroIndex]);
    renderGnssPanel(world.observe(heroId, 'gnss'));
    if (nav) renderNavPanel(nav, { bounds: scene.bounds, nowMs, clockS: world.clock });

    requestAnimationFrame(loop);
  }

  requestAnimationFrame(loop);
}

main().catch((err) => {
  console.error(err);
  const pre = document.createElement('pre');
  pre.style.cssText = 'position:absolute;top:0;left:0;background:#200;color:#e0708e;padding:8px;max-width:90%;white-space:pre-wrap;';
  pre.textContent = String(err?.stack ?? err);
  document.body.appendChild(pre);
});
