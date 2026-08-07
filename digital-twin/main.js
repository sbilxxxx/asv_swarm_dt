/**
 * main.js — digital-twin View のエントリポイント
 *
 * core/ をインポートしてWorldを初期化し、シミュレーションループを駆動する。
 * ここでの目的はセンサー実証（カメラ・レーダー・GNSS）であり、
 * 意思決定エージェント（LLM/VLM/VLA）はswarm-sim側の役割のため、
 * ここでは単純なスクリプト動作でASVを走らせる。
 */

import { loadSceneFromScenario } from '../core/data/adapters/index.js';
import { World } from '../core/sim/world.js';
import { buildThreeScene } from './scene_builder.js';
import { ThreeCameraSensor } from './camera_sensor.js';
import { renderCameraPanel, renderRadarPanel, renderGnssPanel } from './hud.js';

async function loadScenario() {
  const res = await fetch('../core/scenarios/tokyo_bay_minimal.json');
  if (!res.ok) throw new Error(`シナリオ読み込み失敗: ${res.status}`);
  return res.json();
}

async function main() {
  const scenario = await loadScenario();
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
  const world = new World({ scene, cameraSensor, capacity: scenario.spawns.length, protectedAsset });
  window.__debug = { three, world, focus, scene }; // devtools確認用フック

  for (const spawn of spawnLocal) {
    world.spawn({
      id: spawn.id,
      faction: spawn.faction,
      platform: spawn.platform,
      x: spawn.local.x,
      y: spawn.local.y,
      heading: (spawn.headingDeg * Math.PI) / 180,
    });
  }

  let camTick = 0;
  let lastT = performance.now();
  let elapsed = 0;

  window.addEventListener('resize', () => three.resize());

  function loop(nowMs) {
    if (window.__debug?.paused) {
      requestAnimationFrame(loop);
      return;
    }
    const dt = Math.min((nowMs - lastT) / 1000, 0.1);
    lastT = nowMs;
    elapsed += dt;

    for (let i = 0; i < world.state.count; i++) {
      const platform = world.platformInstances.get(world.state.id[i]);
      platform.step(world.state, i, { throttle: 0.3, steering: 0.04 }, dt);
    }
    world.clock += dt;

    three.updateShips(world.state.snapshot(), elapsed);
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
