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
  console.log('\nAll command tests passed.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
