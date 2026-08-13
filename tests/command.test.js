/**
 * command.test.js — 指揮官階層・時間モデルまわりの回帰テスト
 *
 * tests/core_smoke.test.js と同じ理由で CommonJS のまま書き、core/ の ESM は
 * await import() で動的ロードする。実行: node tests/command.test.js
 */
'use strict';

const assert = require('node:assert');

async function loadCore() {
  const { World } = await import('../core/sim/world.js');
  const { EnvApi } = await import('../core/env/env_api.js');
  const { createOriginProjection } = await import('../core/coord.js');
  const { loadSceneFromScenario } = await import('../core/data/adapters/index.js');
  return { World, EnvApi, createOriginProjection, loadSceneFromScenario };
}

function minimalScene({ createOriginProjection }, originLatLon = { lat: 35.45, lon: 139.75 }) {
  return { projection: createOriginProjection(originLatLon) };
}

async function testRadarRangeIsConfigurable(core) {
  const scene = minimalScene(core);

  function worldWithRange(radarRangeM) {
    const w = new core.World({ scene, capacity: 2, radarRangeM });
    w.spawn({ id: 'a', faction: 'defender', platform: 'asv', x: 0, y: 0, heading: 0 });
    w.spawn({ id: 'b', faction: 'intruder', platform: 'asv', x: 500, y: 0, heading: 0 });
    return w;
  }

  const wide = worldWithRange(1500).observe('a', 'radar');
  assert.strictEqual(wide.contacts.length, 1, '500m away is inside a 1500m radar');
  assert.strictEqual(wide.rangeM, 1500);

  const narrow = worldWithRange(300).observe('a', 'radar');
  assert.strictEqual(narrow.contacts.length, 0, '500m away is outside a 300m radar');
  assert.strictEqual(narrow.rangeM, 300);

  console.log('OK: radar detection range is configurable per world');
}

async function testObservationIsEntityBasedAndTracksFuse(core) {
  const scene = minimalScene(core);
  // agent を一切登録しない World。v2 では艇はエージェントオブジェクトを持たない
  const world = new core.World({ scene, capacity: 4, radarRangeM: 600, protectedAsset: { x: 0, y: 0 } });
  world.spawn({ id: 'd1', faction: 'defender', platform: 'asv', x: 0, y: 0, heading: 0 });
  world.spawn({ id: 'd2', faction: 'defender', platform: 'asv', x: 2000, y: 0, heading: 0 }); // d1のレーダー外
  world.spawn({ id: 'i1', faction: 'intruder', platform: 'asv', x: 2000, y: 300, heading: Math.PI });
  world.spawn({ id: 'i2', faction: 'intruder', platform: 'asv', x: 9000, y: 0, heading: Math.PI }); // 誰のレーダー外
  const env = new core.EnvApi(world);

  const obs = env.reset({ scenario: 'test', episodeIndex: 1 });
  assert.ok(obs.d1 && obs.d2 && obs.i1, 'observations exist without any registered agent');
  assert.strictEqual(typeof obs.d1.position.speed, 'number', 'position carries speed');

  // i1 は d2 のレーダー（600m）内・d1 の外 → defender 陣営のトラックに統合される
  env.step({});
  const tracks = world.tracks.defender.list();
  assert.strictEqual(tracks.length, 1, 'enemy seen by any friendly radar becomes a faction track');
  assert.strictEqual(tracks[0].id, 'i1');
  assert.strictEqual(tracks[0].seenBy, 'd2');
  assert.ok(Math.abs(tracks[0].x - 2000) < 30 && Math.abs(tracks[0].y - 300) < 30, 'track position is world coords');

  // intruder 側のトラックにも defender が載る（対称）
  assert.ok(world.tracks.intruder.list().some((t) => t.id === 'd2'), 'intruder side tracks defenders too');

  // レーダー外へ消えてもトラックは残り、lastSeenT が古いまま止まる（stale）
  const i = world.state.indexOf('i1');
  world.state.x[i] = 5000;
  const before = world.tracks.defender.list()[0].lastSeenT;
  env.step({});
  env.step({});
  const after = world.tracks.defender.list().find((t) => t.id === 'i1');
  assert.ok(after, 'stale track is retained, not deleted');
  assert.strictEqual(after.lastSeenT, before, 'lastSeenT freezes when contact is lost');

  // reset でトラックも消える。ただし reset 直後の観測で「今見えている敵」は即座に
  // 再統合されるので、消えたことを確かめるには reset 後に見えなくなる敵で判定する。
  // i2 は spawn 位置が全レーダー外なので、reset でスポーンへ戻れば消えるはず。
  const i2 = world.state.indexOf('i2');
  world.state.x[i2] = 100; // d1 のレーダー内へ入れる
  env.step({});
  assert.ok(world.tracks.defender.list().some((t) => t.id === 'i2'), 'i2 is tracked while inside a radar');

  env.reset({ scenario: 'test', episodeIndex: 2 });
  assert.ok(
    !world.tracks.defender.list().some((t) => t.id === 'i2'),
    'reset clears tracks: i2 returns to its out-of-range spawn and must not linger'
  );

  console.log('OK: observations are entity-based; faction tracks fuse, persist stale, and reset');
}

async function testOrdersApplyAndDefaults(core) {
  const { applyOrders, applyDefaultOrders } = await import('../core/sim/command/orders.js');
  const scene = minimalScene(core);
  const world = new core.World({ scene, capacity: 3, protectedAsset: { x: 100, y: 200 } });
  world.spawn({ id: 'd1', faction: 'defender', platform: 'asv', x: 0, y: 0, heading: 0 });
  world.spawn({ id: 'd2', faction: 'defender', platform: 'asv', x: 50, y: 0, heading: 0 });
  world.spawn({ id: 'i1', faction: 'intruder', platform: 'asv', x: 500, y: 0, heading: 0 });

  applyDefaultOrders(world);
  assert.strictEqual(world.orders.get('d1').action, 'patrol', 'defenders default to patrolling the asset');
  assert.strictEqual(world.orders.get('i1').action, 'move_to', 'intruders default to heading for the asset');
  assert.ok(
    Math.abs(world.orders.get('i1').waypointWorld.x - 100) < 1e-9,
    'default waypoint is the asset (world coords)'
  );

  // east/north（アセット基準）→ ワールド座標への変換と、他陣営の艇・未知の艇の無視
  world.tracks.defender.tracks.set('i1', { id: 'i1', x: 500, y: 0, lastSeenT: 0, seenBy: 'd1' });
  applyOrders(world, 'defender', [
    { boat: 'd1', action: 'move_to', waypoint: { eastM: 10, northM: -20 } },
    { boat: 'd2', action: 'intercept', target: 'i1' },
    { boat: 'i1', action: 'patrol', center: 'asset', radiusM: 100 }, // 敵艇への指示 → 無視
    { boat: 'ghost', action: 'patrol', center: 'asset', radiusM: 100 }, // 存在しない艇 → 無視
  ]);
  assert.strictEqual(world.orders.get('d1').action, 'move_to');
  assert.ok(Math.abs(world.orders.get('d1').waypointWorld.x - 110) < 1e-9, 'east_m is relative to the asset');
  assert.ok(Math.abs(world.orders.get('d1').waypointWorld.y - 180) < 1e-9, 'north_m is relative to the asset');
  assert.strictEqual(world.orders.get('d2').action, 'intercept');
  assert.ok(world.orders.get('d2').lastKnown, 'intercept order carries last known target position from tracks');
  assert.strictEqual(world.orders.get('i1').action, 'move_to', 'cross-faction order is ignored');

  // reset で既定指示へ戻る
  world.resetEntities();
  assert.strictEqual(world.orders.get('d1').action, 'patrol', 'reset restores default orders');

  console.log('OK: orders normalise to world coords, guard factions, and reset to defaults');
}

async function testBoatControllerFollowsOrders() {
  const { BoatController } = await import('../core/sim/command/boat_controller.js');
  const ctl = new BoatController();

  const obsAt = (x, y, heading, contacts = []) => ({
    timestamp: 10,
    position: { x, y, heading, speed: 3 },
    radar: { rangeM: 600, contacts },
    protectedAsset: null,
  });

  // move_to: 真北の waypoint へは左旋回（heading 0 = 東, 数学規約で北= +π/2 = steering正）
  const north = ctl.decide({ action: 'move_to', waypointWorld: { x: 0, y: 1000 } }, obsAt(0, 0, 0), 'd1', 'defender');
  assert.ok(north.throttle > 0.5, 'move_to drives forward');
  assert.ok(north.steering > 0.3, `turn toward north expected positive steering, got ${north.steering}`);

  // move_to 到達後は待機周回に切り替わる（暴走して通り過ぎない）
  const arrived = ctl.decide({ action: 'move_to', waypointWorld: { x: 5, y: 0 } }, obsAt(0, 0, 0), 'd1', 'defender');
  assert.ok(arrived.throttle < 0.5, 'arrival switches to low-throttle loiter');

  // intercept: 見えている目標に向かう。2回目の呼び出しで速度推定つき（履歴使用）でも破綻しない
  const contact = { id: 'i1', faction: 'intruder', rangeM: 300, bearingRad: 0 };
  const first = ctl.decide(
    { action: 'intercept', target: 'i1' },
    obsAt(0, 0, Math.PI / 2, [contact]),
    'd1',
    'defender'
  );
  assert.ok(first.throttle === 1, 'intercept is full throttle');
  assert.ok(first.steering < -0.3, 'target dead east while heading north => starboard turn (negative)');
  const second = ctl.decide(
    { action: 'intercept', target: 'i1' },
    { ...obsAt(0, 0, Math.PI / 2, [{ ...contact, rangeM: 280 }]), timestamp: 11 },
    'd1',
    'defender'
  );
  assert.ok(Number.isFinite(second.steering), 'lead pursuit with history stays finite');

  // intercept: 目標が見えないときは lastKnown へ向かう
  const blind = ctl.decide(
    { action: 'intercept', target: 'i1', lastKnown: { x: 0, y: 500 } },
    obsAt(0, 0, 0),
    'd1',
    'defender'
  );
  assert.ok(blind.steering > 0.3, 'blind intercept heads for last known position');

  // patrol: 中心の近くでは一定舵の周回
  const patrol = ctl.decide(
    { action: 'patrol', centerWorld: { x: 0, y: 0 }, radiusM: 200 },
    obsAt(50, 0, 0),
    'd1',
    'defender'
  );
  assert.ok(patrol.steering !== 0 && patrol.throttle < 0.5, 'patrol near center is a slow constant turn');

  // reset で追跡履歴が消える
  ctl.reset();
  assert.strictEqual(ctl.targetHistory.size, 0);

  console.log('OK: boat controller follows move_to / intercept / patrol orders');
}

/* ===========================================================================
 * 以下3つは Task 5（core/sim/command/decision_scheduler.js）の仕様であり、
 * 実装が入るまで main() から呼ばない（呼ぶとモジュール未作成で落ちるため）。
 *
 * 実装を始めるときの手順:
 *   1. main() の末尾で PENDING_TASK5_TESTS を回すようにする（red を確認）
 *   2. decision_scheduler.js を書く
 *   3. green を確認して、この囲みコメントごと削除する
 *
 * 内容は docs/time-model.md v2.0 に対応する:
 *   - Lifecycle: §4（t_issue → t_apply）・§10（状態と操作）
 *   - IssueTokens: §12（エピソード跨ぎの取り違え）＋§12.5（発行トークン）
 *   - Deadline: §12.5（締切と不成立。既定 deadlineS=Infinity で L0 の挙動は不変）
 * =========================================================================== */

async function testDecisionSchedulerLifecycle() {
  const { DecisionScheduler } = await import('../core/sim/command/decision_scheduler.js');
  const s = new DecisionScheduler();
  s.register('blue', { intervalS: 10, latencyS: 3 });
  s.register('red', { intervalS: 10, latencyS: 3 });

  // t=0: 両方発行対象
  assert.deepStrictEqual(s.dueToIssue(0).sort(), ['blue', 'red']);
  const blueToken = s.markIssued('blue', 0);
  s.markIssued('red', 0);
  assert.deepStrictEqual(s.dueToIssue(0), [], 'pending中は再発行しない');

  // 結果が来る前に applyAtT へ達したら blocked（ブラウザの推論待ちの判定に使う）
  assert.deepStrictEqual(s.dueToApply(2.9), []);
  assert.deepStrictEqual(s.blockedAt(3.0).sort(), ['blue', 'red']);

  // 結果を渡すと t_apply 以降に適用対象になる。t_apply より前には決してならない
  s.provideResult('blue', { orders: [], intent: 'hold' }, blueToken);
  assert.deepStrictEqual(s.dueToApply(2.9), [], '結果が来ていても t_apply 前は適用しない');
  assert.deepStrictEqual(s.dueToApply(3.0), ['blue']);
  assert.deepStrictEqual(s.blockedAt(3.0), ['red'], 'redはまだ未着');

  const result = s.takeResult('blue');
  assert.strictEqual(result.intent, 'hold');
  assert.deepStrictEqual(s.dueToApply(3.0), [], 'take後は消える');

  // 浮動小数の蓄積誤差に耐える（0.1を30回足した値は3.0と厳密一致しない）
  const redToken = s.deciders.get('red').pending.token;
  s.provideResult('red', { orders: [], intent: 'x' }, redToken);
  let t = 0;
  for (let i = 0; i < 30; i++) t += 0.1;
  assert.deepStrictEqual(s.dueToApply(t), ['red'], `float-accumulated t=${t} must count as reaching 3.0`);
  s.takeResult('red');

  // 次の発行は nextIssueAtT（t=10）から。resetで全て初期化
  assert.deepStrictEqual(s.dueToIssue(9.9), []);
  assert.deepStrictEqual(s.dueToIssue(10.0).sort(), ['blue', 'red']);
  s.reset();
  assert.deepStrictEqual(s.dueToIssue(0).sort(), ['blue', 'red']);

  console.log('OK: DecisionScheduler issues, blocks, applies at t_apply, and resets');
}

async function testDecisionSchedulerIssueTokens() {
  const { DecisionScheduler } = await import('../core/sim/command/decision_scheduler.js');

  // エピソードを跨いだ結果の取り違え（docs/time-model.md §12）。ブラウザは fire-and-forget
  // なので、旧エピソードの推論が新エピソードの pending へ紛れ込みうる。
  const s = new DecisionScheduler();
  s.register('blue', { intervalS: 10, latencyS: 3 });
  const staleToken = s.markIssued('blue', 0);
  s.reset(); // エピソード終了
  const freshToken = s.markIssued('blue', 0);
  s.provideResult('blue', { orders: [], intent: 'STALE' }, staleToken);
  assert.deepStrictEqual(s.dueToApply(3.0), [], '旧エピソードの結果は現在の pending を満たさない');
  s.provideResult('blue', { orders: [], intent: 'fresh' }, freshToken);
  assert.deepStrictEqual(s.dueToApply(3.0), ['blue']);
  assert.strictEqual(s.takeResult('blue').intent, 'fresh');

  // 同一エピソード内でも、発行ごとに別トークン（世代だけでは足りない）
  const t2 = new DecisionScheduler();
  t2.register('blue', { intervalS: 10, latencyS: 3 });
  const first = t2.markIssued('blue', 0);
  t2.provideResult('blue', { orders: [], intent: 'first' }, first);
  t2.takeResult('blue');
  const second = t2.markIssued('blue', 10);
  t2.provideResult('blue', { orders: [], intent: 'late-first' }, first);
  assert.deepStrictEqual(t2.dueToApply(13.0), [], '前サイクルのトークンでは書き込めない');
  t2.provideResult('blue', { orders: [], intent: 'second' }, second);
  assert.strictEqual(t2.takeResult('blue').intent, 'second');

  console.log('OK: issue tokens reject results from a previous episode or cycle');
}

async function testDecisionSchedulerDeadline() {
  const { DecisionScheduler } = await import('../core/sim/command/decision_scheduler.js');

  // 既定は deadlineS=Infinity。L0 の挙動（全停止して待ち続ける）は変わらない
  const never = new DecisionScheduler();
  never.register('blue', { intervalS: 10, latencyS: 3 });
  never.markIssued('blue', 0);
  assert.deepStrictEqual(never.missedAt(1000), [], 'deadlineS=Infinity では不成立にならない');
  assert.deepStrictEqual(never.blockedAt(1000), ['blue'], '代わりに blocked のまま待つ');

  // 有限の締切: t_issue + deadlineS を過ぎたら不成立が確定する
  const s = new DecisionScheduler();
  s.register('blue', { intervalS: 10, latencyS: 3, deadlineS: 6, onMiss: 'default-order' });
  const token = s.markIssued('blue', 20);
  assert.deepStrictEqual(s.missedAt(25.9), [], '締切前は不成立ではない');
  const missed = s.missedAt(26.0);
  assert.strictEqual(missed.length, 1);
  assert.strictEqual(missed[0].id, 'blue');
  assert.strictEqual(missed[0].onMiss, 'default-order', '呼び出し側が挙動を選べるよう onMiss を伝える');

  s.takeMissed('blue');
  assert.deepStrictEqual(s.missedAt(26.0), [], 'take後は消える');
  assert.deepStrictEqual(s.blockedAt(26.0), [], '不成立の解消後は blocked でもない');

  // 遅れて届いた結果はトークンが一致しても捨てる（pending はもう無い）
  s.provideResult('blue', { orders: [], intent: 'too late' }, token);
  assert.deepStrictEqual(s.dueToApply(30), [], '不成立確定後に届いた結果は適用しない');
  // 発行のリズムは崩さない: 次は nextIssueAtT（20+10）のまま
  assert.deepStrictEqual(s.dueToIssue(29.9), []);
  assert.deepStrictEqual(s.dueToIssue(30.0), ['blue']);

  // 締切に間に合った結果は通常どおり発効する
  const ok = new DecisionScheduler();
  ok.register('blue', { intervalS: 10, latencyS: 3, deadlineS: 6 });
  const okToken = ok.markIssued('blue', 0);
  ok.provideResult('blue', { orders: [], intent: 'in time' }, okToken);
  assert.deepStrictEqual(ok.dueToApply(3.0), ['blue']);
  assert.deepStrictEqual(ok.missedAt(6.0), [], '発効済みの判断は不成立にならない');

  console.log('OK: deadlineS turns a stalled decider into an explicit miss without breaking the issue rhythm');
}

/** Task 5 実装時に main() から回す（上の囲みコメント参照） */
const PENDING_TASK5_TESTS = [
  testDecisionSchedulerLifecycle,
  testDecisionSchedulerIssueTokens,
  testDecisionSchedulerDeadline,
];

async function testSynthesizedSpawnsAreNotBornDecided(core) {
  const { synthesizeSpawns } = require('../scripts/headless_run.js');
  const { INTERCEPT_RANGE_M, ASSET_BREACH_RANGE_M } = await import('../core/sim/mission.js');
  const scenario = JSON.parse(
    require('node:fs').readFileSync(
      require('node:path').join(__dirname, '..', 'core', 'scenarios', 'tokyo_bay_minimal.json'),
      'utf8'
    )
  );
  const scene = await core.loadSceneFromScenario(scenario);
  const { latLonToLocal, localToLatLon } = scene.projection;
  const asset = latLonToLocal(scenario.protectedAssetLatLon.lat, scenario.protectedAssetLatLon.lon);

  // 合成 spawn が敵艇の迎撃圏内・防護対象の突破圏内に生まれると、エピソードが
  // 1ステップで決着して計測にもベースラインにもならない（--boats 6 で実際に起きていた）。
  for (const boats of [4, 6, 8, 12, 30]) {
    const spawns = synthesizeSpawns(scenario.spawns, boats, {
      latLonToLocal,
      localToLatLon,
      protectedAssetLocal: asset,
    });
    const local = spawns.map((s) => ({ ...s, ...latLonToLocal(s.lat, s.lon) }));
    for (const a of local) {
      const dAsset = Math.hypot(a.x - asset.x, a.y - asset.y);
      assert.ok(
        a.faction !== 'intruder' || dAsset > ASSET_BREACH_RANGE_M,
        `--boats ${boats}: ${a.id} spawns ${dAsset.toFixed(0)}m from the asset (breach range ${ASSET_BREACH_RANGE_M}m)`
      );
      for (const b of local) {
        if (a.id === b.id || a.faction === b.faction) continue;
        const d = Math.hypot(a.x - b.x, a.y - b.y);
        assert.ok(
          d > INTERCEPT_RANGE_M,
          `--boats ${boats}: ${a.id} and ${b.id} spawn ${d.toFixed(0)}m apart (intercept range ${INTERCEPT_RANGE_M}m)`
        );
      }
    }
  }

  console.log('OK: synthesized spawns start outside intercept and breach ranges');
}

async function main() {
  const core = await loadCore();
  await testRadarRangeIsConfigurable(core);
  await testObservationIsEntityBasedAndTracksFuse(core);
  await testOrdersApplyAndDefaults(core);
  await testBoatControllerFollowsOrders();
  await testSynthesizedSpawnsAreNotBornDecided(core);

  // Task 5（DecisionScheduler）の3テストは実装待ちのため、まだここから呼ばない。
  // 下の PENDING_TASK5_TESTS を main() の最後で回すよう戻せば red から始められる。
  console.log('\nAll command tests passed.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
