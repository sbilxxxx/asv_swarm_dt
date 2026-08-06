/**
 * main.js — swarm-sim View のエントリポイント
 *
 * core/ をインポートしてWorldを初期化し、EnvApi.step() を回しながら
 * map_view.js / agent_view.js / comms_view.js / log_panel.js で描画する。
 * digital-twin とは別インスタンスのWorldを持つ（今回はランタイム非接続。
 * docs/system-design.md §2.2 参照）。
 *
 * 意思決定はAPIキー不要のルールベース関数（core/sim/agents/rule_based_fallback.js）を
 * デフォルトで使用する。実LLMに差し替える場合は LlmAgent の decideFn を渡す。
 */

import { createSceneGeometry } from '../core/scene/scene_format.js';
import { World } from '../core/sim/world.js';
import { EnvApi } from '../core/env/env_api.js';
import { LlmAgent } from '../core/sim/agents/llm_agent.js';
import { latLonToLocal } from '../core/coord.js';
import { createProjection, drawMap } from './map_view.js';
import { drawAgents } from './agent_view.js';
import { CommsPulses } from './comms_view.js';
import { appendLogEntry, appendCommsEntry } from './log_panel.js';

const DECISION_INTERVAL_STEPS = 6; // 意思決定は物理更新より間引く（§計算効率化の指針）

async function loadScenario() {
  const res = await fetch('../core/scenarios/tokyo_bay_minimal.json');
  if (!res.ok) throw new Error(`シナリオ読み込み失敗: ${res.status}`);
  return res.json();
}

async function main() {
  const scenario = await loadScenario();
  const scene = createSceneGeometry(scenario);
  const world = new World({ scene, capacity: scenario.spawns.length });

  for (const spawn of scenario.spawns) {
    const { x, y } = latLonToLocal(spawn.lat, spawn.lon);
    world.spawn({
      id: spawn.id,
      faction: spawn.faction,
      platform: spawn.platform,
      x,
      y,
      heading: (spawn.headingDeg * Math.PI) / 180,
      agent: new LlmAgent({ id: spawn.id, faction: spawn.faction }),
    });
  }

  const env = new EnvApi(world);
  const canvas = document.getElementById('map-canvas');
  const ctx = canvas.getContext('2d');
  const commsPulses = new CommsPulses();

  function resizeCanvas() {
    canvas.width = canvas.clientWidth;
    canvas.height = canvas.clientHeight;
  }
  resizeCanvas();
  window.addEventListener('resize', resizeCanvas);

  let observation = env.reset();
  let stepCount = 0;
  let lastFrameMs = performance.now();

  async function tick(nowMs) {
    const dt = Math.min((nowMs - lastFrameMs) / 1000, 0.2);
    lastFrameMs = nowMs;
    stepCount++;
    const decideThisTick = stepCount % DECISION_INTERVAL_STEPS === 0;

    const actions = {};
    for (const [id, agent] of world.agents.entries()) {
      if (decideThisTick || !agent.lastAction) {
        const action = await agent.decide(observation[id]);
        agent.lastAction = action;
        appendLogEntry({ t: world.clock, id, action });
      }
      actions[id] = agent.lastAction ?? { throttle: 0, steering: 0 };
    }

    const result = env.step(actions);
    observation = result.observation;

    // エージェント間の通信（構造化メッセージ）をログとマップの両方に反映する
    for (const ev of env.lastCommsEvents) {
      appendCommsEntry({ t: world.clock, ...ev });
    }
    commsPulses.addEvents(env.lastCommsEvents);
    commsPulses.update(dt);

    const entities = world.state.snapshot();
    const entityById = new Map(entities.map((e) => [e.id, e]));

    const project = createProjection(canvas, scene);
    drawMap(ctx, canvas, scene, project);
    drawAgents(ctx, entities, project);
    commsPulses.draw(ctx, entityById, project);

    requestAnimationFrame(tick);
  }

  requestAnimationFrame(tick);
}

main().catch((err) => {
  console.error(err);
  const pre = document.createElement('pre');
  pre.style.cssText =
    'position:absolute;top:0;left:0;background:#200;color:#e0708e;padding:8px;max-width:90%;white-space:pre-wrap;';
  pre.textContent = String(err?.stack ?? err);
  document.body.appendChild(pre);
});
