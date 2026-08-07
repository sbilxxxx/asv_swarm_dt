/**
 * headless_run.js — coreをNode上でheadless実行するランナー（npm依存なし）
 *
 * docs/review-findings-2026-08-07.md E-5 / §C「headlessランナーが同梱されていない」対応。
 * これまで「core/はDOM非依存でNodeで無改造実行できる（3隻38k steps/s）」は主張のみで、
 * 実測するにはレビュアーが自前でスクリプトを書く必要があった。本スクリプトはそれを
 * リポジトリ同梱の再現可能な形にする（swarm-sim/main.js と同じ配線パターンをNode向けに移植）。
 *
 * tests/core_smoke.test.js と同じ理由（リポジトリルートにpackage.jsonが無く
 * "type":"module"指定も無い）で、このファイル自体はCommonJSのままにし、
 * core/配下のESMは `await import()` で動的ロードする。
 *
 * 使い方:
 *   node scripts/headless_run.js [--episodes N] [--boats N] [--out path.jsonl] [--quiet]
 *
 *   --episodes N  実行するエピソード数（既定5）
 *   --boats N     隻数（既定: シナリオ既定のspawn数=3のまま）。シナリオのspawn数を超える場合、
 *                 既存spawnを起点に渦巻き状へオフセットしたspawnを決定論的に追加合成する
 *                 （陣営はdefender/intruderを交互割当。乱数は使わない方針を踏襲）。
 *                 ただし合成後の陣営がdefender/intruderのどちらかに偏る（例: --boats 1, 2）と
 *                 evaluateMission()が初手でdefended/timeout判定してしまい、意味の無い
 *                 steps/sが出るため、両陣営が最低1隻ずつ揃わない場合はエラーで終了する
 *   --out path    env.logger.toJsonl() の内容をファイルへ書き出す（core自体はfs非依存のまま、
 *                 ファイルI/OはこのNode専用スクリプト側に隔離する）
 *   --quiet       エピソードごとの進捗行を省略し、最終サマリのみ出力
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const SCENARIO_PATH = path.join(__dirname, '../core/scenarios/tokyo_bay_minimal.json');
// swarm-sim/main.js・tests/core_smoke.test.jsと同じ間引き間隔（物理6stepにつき意思決定1回）
const DECISION_INTERVAL_STEPS = 6;

function parseArgs(argv) {
  const opts = { episodes: 5, boats: null, out: null, quiet: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--episodes') opts.episodes = Number(argv[++i]);
    else if (arg === '--boats') opts.boats = Number(argv[++i]);
    else if (arg === '--out') opts.out = argv[++i];
    else if (arg === '--quiet') opts.quiet = true;
    else throw new Error(`unknown argument: ${arg} (known: --episodes N, --boats N, --out path, --quiet)`);
  }
  if (!Number.isInteger(opts.episodes) || opts.episodes < 1) {
    throw new Error(`--episodes must be a positive integer, got: ${opts.episodes}`);
  }
  if (opts.boats !== null && (!Number.isInteger(opts.boats) || opts.boats < 1)) {
    throw new Error(`--boats must be a positive integer, got: ${opts.boats}`);
  }
  return opts;
}

/**
 * シナリオのspawnsを目標隻数まで決定論的に増やす。既存spawnを起点に、渦巻き状
 * （角度は合成順nに単調増加、半径は同じ基点を再訪するたび60m刻みで広がる）へ
 * オフセットした位置を追加する。角度がn全体（0〜targetCount-1）にわたって単調に
 * 増えていくため、実際の軌跡はリング（同心円）ではなく外向きのスパイラルになる。
 * 陣営はdefender/intruderを交互に割り当てる（3隻のシナリオ既定は2防御:1侵入だが、
 * 大量隻数のスループット計測ではバランスより「決定論的に再現できること」を優先する）。
 * origin(coord.js)はcreateSceneGeometry()で設定済みであること前提（呼び出し順に注意）。
 *
 * 戻り値の陣営構成は呼び出し側（main()）で検証する。targetCountが1〜2隻など
 * 小さい場合、元のspawnsをslice()するだけでは片方の陣営が消え（例:
 * --boats 2 → defender-1, defender-2のみでintruderが0隻）、evaluateMission()が
 * 初手で'defended'/'timeout'と誤判定して意味の無いsteps/sを出してしまう。
 */
function synthesizeSpawns(baseSpawns, targetCount, { latLonToLocal, localToLatLon }) {
  if (targetCount <= baseSpawns.length) return baseSpawns.slice(0, targetCount);
  const spawns = baseSpawns.slice();
  let n = 0;
  while (spawns.length < targetCount) {
    const base = baseSpawns[n % baseSpawns.length];
    const ring = Math.floor(n / baseSpawns.length) + 1;
    const angle = (2 * Math.PI * n) / targetCount;
    const radiusM = 60 * ring;
    const faction = n % 2 === 0 ? 'defender' : 'intruder';
    const baseLocal = latLonToLocal(base.lat, base.lon);
    const { lat, lon } = localToLatLon(
      baseLocal.x + radiusM * Math.cos(angle),
      baseLocal.y + radiusM * Math.sin(angle)
    );
    spawns.push({
      id: `${faction}-synth-${n + 1}`,
      faction,
      platform: base.platform ?? 'asv',
      lat,
      lon,
      headingDeg: (base.headingDeg + n * 13) % 360,
    });
    n++;
  }
  return spawns;
}

/** swarm-sim/main.jsのsimulateOneStep()と同じ間引きで1エピソードをdoneまで走らせる */
async function runEpisode(world, env, meta, maxSteps) {
  let observation = env.reset(meta);
  let stepCount = 0;
  let result;
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < maxSteps; i++) {
    const decideThisStep = stepCount % DECISION_INTERVAL_STEPS === 0;
    const actions = {};
    for (const [id, agent] of world.agents.entries()) {
      const idx = world.state.indexOf(id);
      if (idx < 0 || !world.state.alive[idx]) continue; // 撃破済みはdecide()自体をスキップ（A-8/Viewと同じガード）
      if (decideThisStep || !agent.lastAction) agent.lastAction = await agent.decide(observation[id]);
      actions[id] = agent.lastAction ?? { throttle: 0, steering: 0 };
    }
    result = env.step(actions);
    observation = result.observation;
    stepCount++;
    if (result.done) break;
  }
  const wallS = Number(process.hrtime.bigint() - t0) / 1e9;
  if (!result || !result.done) {
    throw new Error(`episode did not reach done within ${maxSteps} steps (meta=${JSON.stringify(meta)})`);
  }
  return { result, stepCount, wallS };
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));

  const { World } = await import('../core/sim/world.js');
  const { EnvApi } = await import('../core/env/env_api.js');
  const missionMod = await import('../core/sim/mission.js');
  const { createSceneGeometry } = await import('../core/scene/scene_format.js');
  const { latLonToLocal, localToLatLon } = await import('../core/coord.js');
  const { LlmAgent } = await import('../core/sim/agents/llm_agent.js');

  const scenario = JSON.parse(fs.readFileSync(SCENARIO_PATH, 'utf8'));
  const scene = createSceneGeometry(scenario); // coord.jsのoriginをこのシナリオへ設定（spawn合成より先に必要）

  const boatsTarget = opts.boats ?? scenario.spawns.length;
  const spawns = synthesizeSpawns(scenario.spawns, boatsTarget, { latLonToLocal, localToLatLon });

  // 片方の陣営が0隻だと、evaluateMission()がintruder不在=defended（またはtimeout）を
  // 初手で返してしまい、意味の無い(steps=1桁の)steps/sを出してしまう
  // （例: --boats 2 は元のdefender-1/defender-2のみが残りintruderが消える）。
  // これは「スループット計測ツールが無意味な設定を黙って受理する」バグなので、
  // 未知フラグと同じくthrow -> main().catch()経由でエラーメッセージ・非ゼロ終了にする。
  const hasDefender = spawns.some((s) => s.faction === 'defender');
  const hasIntruder = spawns.some((s) => s.faction === 'intruder');
  if (!hasDefender || !hasIntruder) {
    throw new Error(
      `--boats ${spawns.length} produces a degenerate spawn set (defender=${spawns.filter((s) => s.faction === 'defender').length}, ` +
        `intruder=${spawns.filter((s) => s.faction === 'intruder').length}); need at least 1 of each faction for a meaningful episode. ` +
        'Use --boats >= 3 (or omit --boats to keep the scenario default).'
    );
  }

  const protectedAsset = scenario.protectedAssetLatLon
    ? latLonToLocal(scenario.protectedAssetLatLon.lat, scenario.protectedAssetLatLon.lon)
    : null;
  const world = new World({ scene, capacity: spawns.length, protectedAsset });
  for (const s of spawns) {
    const { x, y } = latLonToLocal(s.lat, s.lon);
    world.spawn({
      id: s.id,
      faction: s.faction,
      platform: s.platform ?? 'asv',
      x,
      y,
      heading: (s.headingDeg * Math.PI) / 180,
      agent: new LlmAgent({ id: s.id, faction: s.faction }),
    });
  }

  const env = new EnvApi(world); // dt既定0.1s
  // EPISODE_TIME_LIMIT_S(240s)により全エピソードは必ずtimeoutでdoneになる。dt刻み数+余裕をハードリミットにする。
  const maxSteps = Math.ceil(missionMod.EPISODE_TIME_LIMIT_S / env.dt) + 50;

  let totalSteps = 0;
  let totalWallS = 0;
  for (let ep = 1; ep <= opts.episodes; ep++) {
    const meta = { scenario: scenario.name, episodeIndex: ep };
    const { result, stepCount, wallS } = await runEpisode(world, env, meta, maxSteps);
    totalSteps += stepCount;
    totalWallS += wallS;
    if (!opts.quiet) {
      console.log(
        `episode ${ep}/${opts.episodes}: outcome=${result.info.outcome} ` +
          `simTime=${world.clock.toFixed(1)}s wallTime=${wallS.toFixed(3)}s steps=${stepCount}`
      );
    }
  }

  const stepsPerSec = totalSteps / totalWallS;
  console.log('---');
  console.log(
    `boats=${spawns.length} episodes=${opts.episodes} totalSteps=${totalSteps} totalWallTime=${totalWallS.toFixed(3)}s`
  );
  console.log(`steps/s = ${stepsPerSec.toFixed(1)}`);
  console.log(`steps/s per boat = ${(stepsPerSec / spawns.length).toFixed(1)}`);

  if (opts.out) {
    fs.writeFileSync(opts.out, env.logger.toJsonl());
    console.log(`log written to ${opts.out} (${env.logger.rows.length} rows)`);
  }
}

main().catch((err) => {
  console.error('headless_run failed:', err.message);
  process.exit(1);
});
