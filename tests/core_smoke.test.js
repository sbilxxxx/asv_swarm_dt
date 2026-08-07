/**
 * core_smoke.test.js — coreの配線が実際に動くかを確認するNodeスモークテスト
 *
 * リポジトリにはテストフレームワークが無いため、node:assertのみで書いた
 * プレーンなNodeスクリプト。`node tests/core_smoke.test.js` で実行する。
 *
 * core/ 配下はESM（import/export）だが、リポジトリルートに
 * package.jsonが無く"type":"module"指定も無い（.devtoolsだけがCJS前提の
 * 独自package.jsonを持つ）。このファイル自体をESMにするとルートの実行方法に
 * 制約が増えるため、あえてCommonJSのまま `await import()` でcore側のESMを
 * 動的ロードする（トップレベルawaitはCJSで使えないため、全体をasync main()に包む）。
 *
 * 確認する内容（docs/review-findings-2026-08-07.md A-6 / A-7 / A-8 / B-6 対応の回帰テスト）:
 *   1. reset()後にspawn位置へ戻ること（旧バグ: 移動後も(260.6,-264.9)のまま戻らなかった）
 *   2. 1エピソードがdoneまで走ること（'breached' / 'defended' / 'timeout' の3パターン）
 *   3. reset()後の2エピソード目も正しく走ること
 *   4. 無力化された侵入艇はactionを与えても動かないこと（A-8のガード）
 *   5. 30隻×2000stepのログがtoJsonl()でクラッシュせず、各行がJSON.parseできること（B-6）
 *   6. 既定シナリオ・実エージェント（rule_based_fallback.js）で複数エピソード回したとき、
 *      'defended'と'breached'の両方が実際に起こること（優先度4フォローアップ: 防御側の
 *      lead pursuitと侵入側のエピソード別迂回を入れる前は、等速の純追跡が幾何学的に
 *      間合いを詰め切れず毎回'breached'で決定論的に終わっていた）
 *   7. 別originの2つ目のシーンを生成しても、先に作った1つ目のワールドのGNSS変換が
 *      壊れないこと（A-7/E-6の回帰: 旧coord.jsはモジュールグローバルoriginを持っており、
 *      実測で既存ワールドのGNSSが(35.45,139.75)→(34.00,133.50)へ化けるバグがあった）
 */
'use strict';

const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');

const EPS = 1e-6;

function approxEqual(a, b, eps = EPS, msg = '') {
  assert.ok(Math.abs(a - b) <= eps, `${msg} expected ${a} ≈ ${b}`);
}

async function loadCore() {
  const { World } = await import('../core/sim/world.js');
  const { EnvApi } = await import('../core/env/env_api.js');
  const missionMod = await import('../core/sim/mission.js');
  const { loadSceneFromScenario } = await import('../core/data/adapters/index.js');
  const { createOriginProjection } = await import('../core/coord.js');
  const { LlmAgent } = await import('../core/sim/agents/llm_agent.js');
  return { World, EnvApi, missionMod, loadSceneFromScenario, createOriginProjection, LlmAgent };
}

/** scene:{} だけでは動かないテスト（GnssSensorがworld.scene.projectionを見るため）向けの最小scene */
function minimalScene({ createOriginProjection }, originLatLon = { lat: 35.45, lon: 139.75 }) {
  return { projection: createOriginProjection(originLatLon) };
}

/** 実シナリオファイルからWorldを構築する（core自身はfetchできないため、テスト側でJSONを読む） */
async function buildScenarioWorld({ World, loadSceneFromScenario }) {
  const scenarioPath = path.join(__dirname, '../core/scenarios/tokyo_bay_minimal.json');
  const scenario = JSON.parse(fs.readFileSync(scenarioPath, 'utf8'));
  const scene = await loadSceneFromScenario(scenario); // scene.projectionがこのシナリオ専用のorigin変換を持つ

  const world = new World({ scene, capacity: scenario.spawns.length });
  const spawnLocal = [];
  for (const s of scenario.spawns) {
    const { x, y } = scene.projection.latLonToLocal(s.lat, s.lon);
    const heading = (s.headingDeg * Math.PI) / 180;
    world.spawn({ id: s.id, faction: s.faction, platform: s.platform, x, y, heading });
    spawnLocal.push({ id: s.id, x, y, heading });
  }
  return { world, scenario, spawnLocal };
}

/**
 * 実シナリオ＋protectedAsset＋LlmAgent（既定=rule_based_fallback.js）でWorldを構築する。
 * swarm-sim/main.js の初期化と同じ組み方（agentを渡してdecide()を実際に回せるようにする）。
 */
async function buildScenarioWorldWithAgents({ World, loadSceneFromScenario, LlmAgent }) {
  const scenarioPath = path.join(__dirname, '../core/scenarios/tokyo_bay_minimal.json');
  const scenario = JSON.parse(fs.readFileSync(scenarioPath, 'utf8'));
  const scene = await loadSceneFromScenario(scenario);
  const protectedAsset = scenario.protectedAssetLatLon
    ? scene.projection.latLonToLocal(scenario.protectedAssetLatLon.lat, scenario.protectedAssetLatLon.lon)
    : null;

  const world = new World({ scene, capacity: scenario.spawns.length, protectedAsset });
  for (const s of scenario.spawns) {
    const { x, y } = scene.projection.latLonToLocal(s.lat, s.lon);
    world.spawn({
      id: s.id,
      faction: s.faction,
      platform: s.platform,
      x,
      y,
      heading: (s.headingDeg * Math.PI) / 180,
      agent: new LlmAgent({ id: s.id, faction: s.faction }),
    });
  }
  return { world, scenario };
}

/** swarm-sim/main.jsと同じ間引き間隔でdecide()を呼びながら1エピソードをdoneまで走らせる */
async function runOneEpisode(world, env, meta) {
  const DECISION_INTERVAL_STEPS = 6;
  let observation = env.reset(meta);
  let stepCount = 0;
  let result;
  for (let i = 0; i < 3000; i++) {
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
  assert.ok(result.done, `episode did not reach done within the step guard (meta=${JSON.stringify(meta)})`);
  return result;
}

async function testResetReturnsToSpawn({ World, EnvApi, loadSceneFromScenario }) {
  const { world, spawnLocal } = await buildScenarioWorld({ World, loadSceneFromScenario });
  const env = new EnvApi(world, { dt: 0.1 });

  env.reset({ scenario: 'tokyo_bay_minimal', episodeIndex: 1 });

  // 全艇を200step動かす（moveした状態を作る）
  const actions = {};
  for (const s of spawnLocal) actions[s.id] = { throttle: 1, steering: 0.4 };
  for (let step = 0; step < 200; step++) env.step(actions);

  // 動いたことを確認（旧バグの逆: 動かないと今回のテストの意味が無い）
  for (const s of spawnLocal) {
    const i = world.state.indexOf(s.id);
    const moved = Math.abs(world.state.x[i] - s.x) > 1 || Math.abs(world.state.y[i] - s.y) > 1;
    assert.ok(moved, `${s.id} should have moved away from spawn before reset`);
  }

  env.reset({ scenario: 'tokyo_bay_minimal', episodeIndex: 2 });

  for (const s of spawnLocal) {
    const i = world.state.indexOf(s.id);
    approxEqual(world.state.x[i], s.x, 1e-6, `${s.id}.x after reset`);
    approxEqual(world.state.y[i], s.y, 1e-6, `${s.id}.y after reset`);
    approxEqual(world.state.heading[i], s.heading, 1e-6, `${s.id}.heading after reset`);
    approxEqual(world.state.speed[i], 0, 1e-6, `${s.id}.speed after reset`);
    assert.strictEqual(world.state.alive[i], 1, `${s.id}.alive after reset`);
  }
  console.log('OK: reset() restores spawn positions/heading/speed/alive after movement');
}

async function testBreachedOutcomeAndSecondEpisode({ World, EnvApi, createOriginProjection }) {
  // 侵入艇をprotectedAssetの真上にスポーンさせ、1歩目で'breached'を強制する
  const x = 100;
  const y = 200;
  const world = new World({ scene: minimalScene({ createOriginProjection }), capacity: 4, protectedAsset: { x, y } });
  // agentを登録しないとEnvApi._observationForAll()がこのentityを素通りする（agents Mapのkeysを回すため）
  world.spawn({ id: 'intruder-1', faction: 'intruder', x, y, heading: 0, agent: {} });

  const env = new EnvApi(world, { dt: 0.1 });
  env.reset({ scenario: 'forced-breach', episodeIndex: 1 });

  const result = env.step({}); // アクション無し＝動かない。距離0なので即breach
  assert.strictEqual(result.done, true, 'breach episode should be done on first step');
  assert.strictEqual(result.info.outcome, 'breached', 'outcome should be breached');
  assert.strictEqual(result.reward, -1, 'breach reward should be -1');
  assert.ok(
    result.info.events.some((e) => e.type === 'asset_breached'),
    'events should contain asset_breached'
  );
  // observationにprotectedAssetが含まれること（View側の目標到達・哨戒行動に必要）
  assert.deepStrictEqual(
    result.observation['intruder-1'].protectedAsset,
    { x, y },
    'observation.protectedAsset should mirror world.protectedAsset'
  );

  const jsonl = env.logger.toJsonl();
  const lastLines = jsonl.trim().split('\n');
  const lastRow = JSON.parse(lastLines[lastLines.length - 1]);
  assert.strictEqual(lastRow.type, 'episode_end', 'last logged row should be episode_end');
  assert.strictEqual(lastRow.outcome, 'breached', 'episode_end row should carry outcome');
  console.log('OK: forced breach scenario ends the episode with outcome=breached, reward=-1');

  // 2エピソード目: reset()後に同じWorldインスタンスで再度回せること
  env.reset({ scenario: 'forced-breach', episodeIndex: 2 });
  const i = world.state.indexOf('intruder-1');
  approxEqual(world.state.x[i], x, 1e-6, 'intruder-1.x after second reset');
  approxEqual(world.state.y[i], y, 1e-6, 'intruder-1.y after second reset');
  assert.strictEqual(world.state.alive[i], 1, 'intruder-1 revived after second reset');

  const result2 = env.step({});
  assert.strictEqual(result2.done, true, 'second episode should also reach done');
  assert.strictEqual(result2.info.outcome, 'breached', 'second episode outcome should be breached');
  console.log('OK: second episode after reset() runs correctly from spawn positions');
}

async function testDefendedOutcomeAndDeadIntruderStopsMoving({ World, EnvApi, createOriginProjection }) {
  // 防御艇を侵入艇の近く（INTERCEPT_RANGE_M=60m以内）に置き、1歩目で'defended'を強制する
  const world = new World({ scene: minimalScene({ createOriginProjection }), capacity: 4 }); // protectedAsset無し=breach判定はスキップされる
  world.spawn({ id: 'defender-1', faction: 'defender', x: 0, y: 0, heading: 0, agent: {} });
  world.spawn({ id: 'intruder-1', faction: 'intruder', x: 30, y: 0, heading: 0 });

  const env = new EnvApi(world, { dt: 0.1 });
  env.reset({ scenario: 'forced-defend', episodeIndex: 1 });

  const result = env.step({});
  assert.strictEqual(result.done, true, 'defended episode should be done on first step');
  assert.strictEqual(result.info.outcome, 'defended', 'outcome should be defended');
  assert.strictEqual(result.reward, 1, 'defended reward should be +1');
  assert.strictEqual(
    result.observation['defender-1'].protectedAsset,
    null,
    'observation.protectedAsset should be null when the world has no protectedAsset configured'
  );

  const i = world.state.indexOf('intruder-1');
  assert.strictEqual(world.state.alive[i], 0, 'intercepted intruder should be alive=0');
  const xBefore = world.state.x[i];
  const yBefore = world.state.y[i];

  // 死亡後にactionを与えても動かないこと（A-8）
  env.step({ 'intruder-1': { throttle: 1, steering: 1 } });
  env.step({ 'intruder-1': { throttle: 1, steering: 1 } });
  approxEqual(world.state.x[i], xBefore, 1e-9, 'dead intruder x should not move');
  approxEqual(world.state.y[i], yBefore, 1e-9, 'dead intruder y should not move');
  console.log('OK: forced defended scenario ends the episode with outcome=defended, reward=+1');
  console.log('OK: dead (alive=0) intruder ignores supplied actions and stays put');
}

async function testStepAfterDoneIsIdempotent({ World, EnvApi, createOriginProjection }) {
  // done後、reset()を挟まずstep()を呼び続けるケース（swarm-simの描画ループがdoneを
  // 見ずに毎フレームstep()を呼ぶ想定）で、episode_end行が複製されず、Worldの状態も
  // 進まないことを確認する（コードレビュー指摘: B-6再発の回帰テスト）。
  const world = new World({ scene: minimalScene({ createOriginProjection }), capacity: 4 });
  world.spawn({ id: 'defender-1', faction: 'defender', x: 0, y: 0, heading: 0 });
  world.spawn({ id: 'intruder-1', faction: 'intruder', x: 30, y: 0, heading: 0 });

  const env = new EnvApi(world, { dt: 0.1 });
  env.reset({ scenario: 'forced-defend-idempotent', episodeIndex: 1 });

  const first = env.step({}); // 1歩目でintercept -> done=true, outcome='defended'
  assert.strictEqual(first.done, true, 'first step should already be done');

  const clockAfterDone = world.clock;
  const rowCountAfterDone = env.logger.rows.length;

  for (let n = 0; n < 20; n++) {
    // 死んだ侵入艇にすら動くはずのactionを与えて、それでも状態が進まないことを確認する
    const again = env.step({ 'intruder-1': { throttle: 1, steering: 1 } });
    assert.strictEqual(again.done, true, `step ${n} after done should still report done`);
    assert.strictEqual(again.info.outcome, 'defended', `step ${n} after done should keep the original outcome`);
    assert.strictEqual(again, first, `step ${n} after done should return the exact cached terminal result`);
  }

  assert.strictEqual(world.clock, clockAfterDone, 'world.clock must not advance after done without reset()');
  assert.strictEqual(
    env.logger.rows.length,
    rowCountAfterDone,
    'logger must not grow after done without reset() (no repeated episode_end / step rows)'
  );

  const jsonl = env.logger.toJsonl();
  const endRows = jsonl
    .split('\n')
    .map((line) => JSON.parse(line))
    .filter((row) => row.type === 'episode_end');
  assert.strictEqual(endRows.length, 1, 'exactly one episode_end row should be logged for this episode');
  console.log('OK: step() after done is idempotent (single episode_end row, world state frozen until reset())');
}

async function testTimeoutOutcome({ World, EnvApi, missionMod, createOriginProjection }) {
  const world = new World({ scene: minimalScene({ createOriginProjection }), capacity: 4 });
  // 互いに遠く離して配置し、actionも与えないので誰も動かない -> timeout一択
  world.spawn({ id: 'defender-1', faction: 'defender', x: -1000, y: -1000, heading: 0 });
  world.spawn({ id: 'intruder-1', faction: 'intruder', x: 1000, y: 1000, heading: 0 });

  const dt = 10; // 大きめのdtで短いループ数で時間切れに到達させる
  const env = new EnvApi(world, { dt });
  env.reset({ scenario: 'forced-timeout', episodeIndex: 1 });

  let result;
  let guard = 0;
  do {
    result = env.step({});
    guard++;
    assert.ok(guard < 1000, 'timeout test should not loop forever');
  } while (!result.done);

  assert.strictEqual(result.info.outcome, 'timeout', 'outcome should be timeout');
  assert.ok(world.clock >= missionMod.EPISODE_TIME_LIMIT_S, 'clock should reach the episode time limit');
  console.log(`OK: stationary episode times out after clock=${world.clock.toFixed(1)}s (outcome=timeout)`);
}

async function testLoggerStress({ World, EnvApi, createOriginProjection }) {
  const BOATS = 30;
  const STEPS = 2000;
  const world = new World({ scene: minimalScene({ createOriginProjection }), capacity: BOATS });
  const ids = [];
  for (let n = 0; n < BOATS; n++) {
    const id = `intruder-${n}`; // 全艇同陣営にして捕捉判定を起こさせず、純粋にログ量だけ見る
    world.spawn({ id, faction: 'intruder', x: n * 50, y: 0, heading: 0 });
    ids.push(id);
  }

  const env = new EnvApi(world, { dt: 0.1 }); // 2000step * 0.1s = 200s < EPISODE_TIME_LIMIT_S(240s)なのでdoneにならない
  env.reset({ scenario: 'stress', episodeIndex: 1 });

  const actions = {};
  for (const id of ids) actions[id] = { throttle: 0.2, steering: 0.05 };

  for (let step = 0; step < STEPS; step++) {
    const result = env.step(actions);
    assert.strictEqual(result.done, false, 'stress run should not hit a done condition before STEPS steps');
  }

  const jsonl = env.logger.toJsonl();
  assert.strictEqual(typeof jsonl, 'string', 'toJsonl() should return a string without throwing');
  const lines = jsonl.split('\n');
  assert.strictEqual(lines.length, 1 + BOATS * STEPS, 'row count should be 1 header + boats*steps');
  for (const line of lines) {
    const row = JSON.parse(line); // 1行ずつJSON.parseできること
    assert.ok(row.type, 'every row should have a type field');
  }
  console.log(
    `OK: logger survives ${BOATS} boats x ${STEPS} steps (${lines.length} rows, ${(jsonl.length / 1e6).toFixed(2)}MB), toJsonl() lines all parse`
  );
}

/**
 * 既定シナリオ・実エージェントで複数エピソード回し、'defended'と'breached'の両方が
 * 実際に起こることを確認する。乱数は使わないため、同一シナリオを繰り返すだけでは
 * 毎回同じ結果になりがちだった（フォローアップ前の実測: 常にbreached、約94〜96mで
 * 頭打ちの純追跡）。防御側のlead pursuit（core/sim/agents/rule_based_fallback.js）と
 * 侵入側のエピソード別迂回（observation.episode由来）を入れたことで、決定論のまま
 * エピソードごとに違う展開・違う結果になることをここで固定する。
 */
async function testMultiEpisodeOutcomeVariety({ World, EnvApi, loadSceneFromScenario, LlmAgent }) {
  const { world, scenario } = await buildScenarioWorldWithAgents({ World, loadSceneFromScenario, LlmAgent });
  const env = new EnvApi(world, { dt: 0.1 });

  const NUM_EPISODES = 6;
  const outcomes = [];
  for (let ep = 1; ep <= NUM_EPISODES; ep++) {
    const result = await runOneEpisode(world, env, { scenario: scenario.name, episodeIndex: ep });
    outcomes.push(result.info.outcome);
  }

  assert.ok(
    outcomes.includes('defended'),
    `expected at least one 'defended' outcome among ${NUM_EPISODES} episodes, got: ${outcomes.join(', ')}`
  );
  assert.ok(
    outcomes.includes('breached'),
    `expected at least one 'breached' outcome among ${NUM_EPISODES} episodes, got: ${outcomes.join(', ')}`
  );
  console.log(`OK: ${NUM_EPISODES} consecutive episodes produced both defended and breached: [${outcomes.join(', ')}]`);
}

/**
 * A-7/E-6の回帰テスト。レビューが実測した不具合を再現する:
 * 「別originのシナリオでcreateSceneGeometry()を呼ぶと、既存ワールドのGNSSが変わってしまう」
 * （旧coord.jsのモジュールグローバルoriginのせい。実測: (35.45,139.75)→(34.00,133.50)）。
 * 現在はSceneGeometryごとに独立したprojectionを持つため、2つ目のシーン/Worldを作っても
 * 1つ目のWorldのGNSS出力は変化しないはずである。
 */
async function testCoordProjectionIsolatedPerScene({ World, loadSceneFromScenario }) {
  const squareAround = (originLatLon, halfDeg = 0.01) => [
    { lat: originLatLon.lat + halfDeg, lon: originLatLon.lon - halfDeg },
    { lat: originLatLon.lat + halfDeg, lon: originLatLon.lon + halfDeg },
    { lat: originLatLon.lat - halfDeg, lon: originLatLon.lon + halfDeg },
    { lat: originLatLon.lat - halfDeg, lon: originLatLon.lon - halfDeg },
  ];

  const originA = { lat: 35.45, lon: 139.75 }; // レビュー実測時の1つ目のシナリオorigin
  const originB = { lat: 34.0, lon: 133.5 }; // レビュー実測時の2つ目のシナリオorigin（この切替でAが化けた）

  const sceneA = await loadSceneFromScenario({
    name: 'origin-a',
    adapter: 'manual_coastline',
    originLatLon: originA,
    coastlineLatLon: squareAround(originA),
  });
  const worldA = new World({ scene: sceneA, capacity: 2 });
  worldA.spawn({ id: 'boat-a', faction: 'defender', x: 500, y: 300, heading: 0 });

  const gnssBefore = worldA.observe('boat-a', 'gnss');

  // ここで別originの2つ目のシーン/Worldを生成する。旧実装ではcoord.jsのグローバルoriginが
  // ここで書き換わり、worldAのGNSS変換まで巻き込んで壊れていた。
  const sceneB = await loadSceneFromScenario({
    name: 'origin-b',
    adapter: 'manual_coastline',
    originLatLon: originB,
    coastlineLatLon: squareAround(originB),
  });
  const worldB = new World({ scene: sceneB, capacity: 2 });
  worldB.spawn({ id: 'boat-b', faction: 'defender', x: 0, y: 0, heading: 0 });

  const gnssAfter = worldA.observe('boat-a', 'gnss');
  approxEqual(gnssAfter.lat, gnssBefore.lat, 1e-9, 'worldA GNSS lat must be unaffected by worldB creation');
  approxEqual(gnssAfter.lon, gnssBefore.lon, 1e-9, 'worldA GNSS lon must be unaffected by worldB creation');
  assert.ok(
    Math.abs(gnssAfter.lat - originA.lat) < 1,
    `worldA GNSS should stay near its own origin (${originA.lat}), got ${gnssAfter.lat} (old bug moved it toward ${originB.lat})`
  );

  // worldBは自分自身のoriginを反映していること（worldAのoriginへ引きずられていないこと）
  const gnssB = worldB.observe('boat-b', 'gnss');
  approxEqual(gnssB.lat, originB.lat, 1e-6, 'worldB GNSS lat should equal its own origin at (0,0)');
  approxEqual(gnssB.lon, originB.lon, 1e-6, 'worldB GNSS lon should equal its own origin at (0,0)');

  console.log(
    'OK: two scenes with different origins keep independent GNSS conversions ' +
      `(worldA stayed at lat≈${gnssAfter.lat.toFixed(4)}, worldB at lat≈${gnssB.lat.toFixed(4)}) (A-7/E-6 regression)`
  );
}

/**
 * B-3の回帰テスト。旧実装ではWorldがenvironmentを保持するだけでasv.js側からは
 * 一度もsample()が呼ばれておらず、「波サロゲートモデルへの差し込み口」は差し替えても
 * 何も起きないデコイだった。ここではnon-zeroなcurrentX/currentYを返すテスト用
 * environmentを注入し、同じactions・同じstep数でも位置が変わることを確認する
 * （CalmSeaEnvironmentとの比較で、配線が実際に効いていることを示す）。
 */
async function testEnvironmentSampleIsWiredIntoKinematics({ World, EnvApi, createOriginProjection }) {
  const DRIFT_MPS = 2; // CalmSea(0)よりはっきり分かる程度の、しかし物理を壊さない程度の小さな一定海流
  class DriftEnvironment {
    sample(x, y, t) {
      return { waveHeightM: 0, currentX: DRIFT_MPS, currentY: 0 };
    }
  }

  async function runFixedSteps(environment) {
    const world = new World({ scene: minimalScene({ createOriginProjection }), capacity: 2, environment });
    // faction='intruder'かつprotectedAsset未設定にする: mission.evaluateMission()は
    // 「生存intruderが0」でdefended、breachはasset未設定でスキップされるため、
    // このテストが見たい50step分の純粋な運動学の違いが、doneによる早期打ち切りで
    // 隠れないようにする（'defender'単騎だとintruder不在で1step目にdefended判定されてしまう）。
    world.spawn({ id: 'boat-1', faction: 'intruder', x: 0, y: 0, heading: 0, agent: {} });
    const env = new EnvApi(world, { dt: 0.1 });
    env.reset({ scenario: 'env-sample-wiring', episodeIndex: 1 });
    for (let step = 0; step < 50; step++) env.step({ 'boat-1': { throttle: 1, steering: 0 } });
    const i = world.state.indexOf('boat-1');
    return { x: world.state.x[i], y: world.state.y[i] };
  }

  const calmResult = await runFixedSteps(undefined); // Worldのデフォルト = CalmSeaEnvironment
  const driftResult = await runFixedSteps(new DriftEnvironment());

  const dx = driftResult.x - calmResult.x;
  assert.ok(
    Math.abs(dx) > 1,
    `non-zero environment.sample() should measurably perturb position vs CalmSeaEnvironment ` +
      `(calm.x=${calmResult.x}, drift.x=${driftResult.x}, dx=${dx})`
  );
  // 50step * dt(0.1) * DRIFT_MPS(2) = 10m相当が積算されているはず
  approxEqual(dx, 50 * 0.1 * DRIFT_MPS, 1e-6, 'drift perturbation should match 50 steps * dt * DRIFT_MPS');
  console.log(
    `OK: environment.sample() is wired into AsvPlatform.step() kinematics ` +
      `(calm.x=${calmResult.x.toFixed(3)}, drift.x=${driftResult.x.toFixed(3)}, dx=${dx.toFixed(3)}m)`
  );
}

async function main() {
  const core = await loadCore();
  await testResetReturnsToSpawn(core);
  await testBreachedOutcomeAndSecondEpisode(core);
  await testDefendedOutcomeAndDeadIntruderStopsMoving(core);
  await testStepAfterDoneIsIdempotent(core);
  await testTimeoutOutcome(core);
  await testLoggerStress(core);
  await testMultiEpisodeOutcomeVariety(core);
  await testCoordProjectionIsolatedPerScene(core);
  await testEnvironmentSampleIsWiredIntoKinematics(core);
  console.log('\nAll core smoke tests passed.');
}

main().catch((err) => {
  console.error('SMOKE TEST FAILED');
  console.error(err);
  process.exit(1);
});
