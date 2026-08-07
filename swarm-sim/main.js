/**
 * main.js — swarm-sim View のエントリポイント
 *
 * core/ をインポートしてWorldを初期化し、EnvApi.step() を回しながら
 * map_view.js / agent_view.js / comms_view.js / log_panel.js / hud_panel.js で描画する。
 * digital-twin とは別インスタンスのWorldを持つ（今回はランタイム非接続。
 * docs/system-design.md §2.2 参照）。
 *
 * 意思決定はAPIキー不要のルールベース関数（core/sim/agents/rule_based_fallback.js）を
 * デフォルトで使用する。実LLMに差し替える場合は LlmAgent の decideFn を渡す。
 *
 * 【固定タイムステップ・ループ（A-5対応）】
 * 旧実装は requestAnimationFrame 1回につき env.step() を1回呼んでいたため、
 * シム速度がモニタのリフレッシュレートに直結していた（60Hzで旧dt=0.5秒設定なら30倍速）。
 * 今回は「実時間の経過を貯めて、env.dt刻みで必要な回数だけstep()する」アキュムレータ方式にし、
 * TIME_SCALE倍速を除けば 1シム秒 ≈ 1実秒 になるようにする。
 * バックグラウンドタブ復帰時に経過時間が一気に貯まって大量step()が走らないよう、
 * 1フレームで加算する実時間は MAX_FRAME_DT_S でクランプする。
 */

import { loadSceneFromScenario } from '../core/data/adapters/index.js';
import { World } from '../core/sim/world.js';
import { EnvApi } from '../core/env/env_api.js';
import { LlmAgent } from '../core/sim/agents/llm_agent.js';
import { createProjection, drawMap, drawProtectedAsset } from './map_view.js';
import { drawAgents } from './agent_view.js';
import { CommsPulses } from './comms_view.js';
import { appendLogEntry, appendCommsEntry, appendMissionEntry } from './log_panel.js';
import { updateHud, showOutcomeBanner, hideOutcomeBanner, wireDownloadButton } from './hud_panel.js';

// 意思決定は物理更新より間引く（§計算効率化の指針）。env.dt(既定0.1s)換算で0.6秒に1回。
// フレームレートではなく「シムステップ数」基準にすることで、TIME_SCALEを変えても
// 意思決定の頻度（シム時間あたり）は変わらない。
const DECISION_INTERVAL_STEPS = 6;

// 実時間の何倍でシムを進めるか。EPISODE_TIME_LIMIT_S=240sをそのまま等倍で見せると
// 決着まで最大4分かかり待たされる一方、10倍速などにすると操船・回避行動が目で追えなくなる。
// 3倍速なら最長でも実時間80秒で1エピソードが決着し、「見ていて忙しくなく、かつ待たされない」
// 落としどころとして選んだ（要件のe.g. 2〜4倍の範囲内）。
const TIME_SCALE = 3;

// 1フレームで加算する実経過時間の上限。バックグラウンドタブから復帰した際などに
// 巨大なdtが一度に積まれてstep()が暴走的に大量発行されるのを防ぐ。
const MAX_FRAME_DT_S = 0.25;

// 結果バナーを表示しておく実時間（ミリ秒）。この間はstep()を呼ばず、wall timeで待つ
// （env.step()はdone後短絡キャッシュを返すだけなので、ポーズの管理をstep呼び出しに頼らない）。
const BANNER_DURATION_MS = 3000;

async function loadScenario() {
  const res = await fetch('../core/scenarios/tokyo_bay_minimal.json');
  if (!res.ok) throw new Error(`シナリオ読み込み失敗: ${res.status}`);
  return res.json();
}

async function main() {
  const scenario = await loadScenario();
  const scene = await loadSceneFromScenario(scenario);
  const world = new World({
    scene,
    capacity: scenario.spawns.length,
    protectedAsset: scenario.protectedAssetLatLon
      ? scene.projection.latLonToLocal(scenario.protectedAssetLatLon.lat, scenario.protectedAssetLatLon.lon)
      : null,
  });

  for (const spawn of scenario.spawns) {
    const { x, y } = scene.projection.latLonToLocal(spawn.lat, spawn.lon);
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

  wireDownloadButton(() => env.logger.toJsonl());

  function resizeCanvas() {
    canvas.width = canvas.clientWidth;
    canvas.height = canvas.clientHeight;
  }
  resizeCanvas();
  window.addEventListener('resize', resizeCanvas);

  // エピソード番号はenv.logger.currentEpisode（EpisodeLogger.startEpisode()が発番）を単一の情報源とし、
  // ここでは重複カウンタを持たない。episodeIndexはRNGの種ではなく、単にreset()呼び出し回数の記録用メタデータ
  // （JSONLヘッダに残る値の名前が「seed」だと乱数シードだと誤解されるため、この名前にしている）。
  let observation = env.reset({ scenario: scenario.name, episodeIndex: 1 });
  const tally = { defended: 0, breached: 0, timeout: 0 };

  let stepCount = 0;
  let accumulatorS = 0;
  let lastFrameMs = performance.now();
  /** @type {{outcome: string, untilMs: number}|null} エピソード終了バナーの表示状態 */
  let banner = null;

  /** シムを固定dt刻みで1step進める（物理・意思決定・ログ・コミュ/ミッションイベントの反映まで）。 */
  async function simulateOneStep() {
    const decideThisStep = stepCount % DECISION_INTERVAL_STEPS === 0;

    const actions = {};
    for (const [id, agent] of world.agents.entries()) {
      const idx = world.state.indexOf(id);
      if (idx < 0 || !world.state.alive[idx]) continue; // 撃破済みエンティティはdecide()自体をスキップ
      if (decideThisStep || !agent.lastAction) {
        const action = await agent.decide(observation[id]);
        agent.lastAction = action;
        appendLogEntry({ t: world.clock, id, action });
      }
      actions[id] = agent.lastAction ?? { throttle: 0, steering: 0 };
    }

    const result = env.step(actions);
    observation = result.observation;
    stepCount++;

    for (const ev of env.lastCommsEvents) {
      appendCommsEntry({ t: world.clock, ...ev });
    }
    commsPulses.addEvents(env.lastCommsEvents);

    for (const ev of result.info.events) {
      appendMissionEntry(ev);
    }

    return result;
  }

  function render() {
    const project = createProjection(canvas, scene);

    drawMap(ctx, canvas, scene, project);
    drawProtectedAsset(ctx, canvas, scene, project, world.protectedAsset);

    const entities = world.state.snapshot();
    const entityById = new Map(entities.map((e) => [e.id, e]));
    drawAgents(ctx, entities, project);
    commsPulses.draw(ctx, entityById, project);

    updateHud({ episode: env.logger.currentEpisode, clock: world.clock, tally });
    if (banner) showOutcomeBanner(banner.outcome);
    else hideOutcomeBanner();
  }

  async function tick(nowMs) {
    const rawDt = Math.min((nowMs - lastFrameMs) / 1000, MAX_FRAME_DT_S);
    lastFrameMs = nowMs;
    commsPulses.update(rawDt);

    if (banner) {
      // 結果バナー表示中はstep()を呼ばず、wall timeの経過だけで次エピソードへ遷移する
      if (nowMs >= banner.untilMs) {
        banner = null;
        stepCount = 0;
        accumulatorS = 0;
        observation = env.reset({ scenario: scenario.name, episodeIndex: env.logger.currentEpisode + 1 });
      }
    } else {
      accumulatorS += rawDt * TIME_SCALE;
      while (accumulatorS >= env.dt) {
        const result = await simulateOneStep();
        accumulatorS -= env.dt;
        if (result.done) {
          tally[result.info.outcome] = (tally[result.info.outcome] ?? 0) + 1;
          banner = { outcome: result.info.outcome, untilMs: nowMs + BANNER_DURATION_MS };
          accumulatorS = 0; // 次エピソード開始時に古い蓄積時間が一気に消化されないようにする
          break;
        }
      }
    }

    render();
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
