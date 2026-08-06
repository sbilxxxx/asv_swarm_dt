/**
 * main.js — digital-twin View のエントリポイント
 *
 * core/ をインポートしてWorldを初期化し、シミュレーションループを駆動する。
 * ここでの目的はセンサー実証（カメラ・レーダー・GNSS）であり、
 * 意思決定エージェント（LLM/VLM/VLA）はswarm-sim側の役割のため、
 * ここでは単純なスクリプト動作でASVを走らせる。
 */

import { createSceneGeometry } from '../core/scene/scene_format.js';
import { World } from '../core/sim/world.js';
import { latLonToLocal } from '../core/coord.js';
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
  const scene = createSceneGeometry(scenario);

  const canvas = document.getElementById('scene-canvas');
  const three = buildThreeScene(canvas, scene);
  const cameraSensor = new ThreeCameraSensor(three);
  const world = new World({ scene, cameraSensor, capacity: scenario.spawns.length });

  for (const spawn of scenario.spawns) {
    const { x, y } = latLonToLocal(spawn.lat, spawn.lon);
    world.spawn({
      id: spawn.id,
      faction: spawn.faction,
      platform: spawn.platform,
      x,
      y,
      heading: (spawn.headingDeg * Math.PI) / 180,
    });
  }

  const heroId = scenario.spawns[0].id;
  let camTick = 0;

  window.addEventListener('resize', () => three.resize());

  function loop() {
    for (let i = 0; i < world.state.count; i++) {
      const platform = world.platformInstances.get(world.state.id[i]);
      platform.step(world.state, i, { throttle: 0.3, steering: 0.04 }, 0.05);
    }
    world.clock += 0.05;

    three.updateShips(world.state.snapshot());

    // カメラは重いので数フレームに1回だけ取得（§計算効率化の指針: 意思決定/センサーの間引き）
    camTick++;
    if (camTick % 10 === 0) {
      renderCameraPanel(world.observe(heroId, 'camera'));
    } else {
      three.render();
    }
    renderRadarPanel(world.observe(heroId, 'radar'));
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
