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

async function testDecisionSchedulerDoomedDrawsAreNeverApplied() {
  const { DecisionScheduler } = await import('../core/sim/command/decision_scheduler.js');

  // docs/time-model.md §12.5:「drawn > deadlineS: その判断は t_issue + deadlineS の時点で
  // 不成立が確定する」「モデルが不成立と言った判断は、手元に結果があっても捨てる」。
  // 呼び出し側は dt グリッドの上でしか問い合わせないので、締切と t_apply が同じ dt 窓へ
  // 落ちる引き（例: 締切 25.99 / 発効 26.0）でも取りこぼしてはいけない。
  const runGrid = (s, fromT, toT, dt = 0.1) => {
    const log = [];
    const steps = Math.round((toT - fromT) / dt);
    for (let i = 0; i <= steps; i++) {
      const t = fromT + i * dt;
      for (const m of s.missedAt(t)) {
        log.push({ kind: 'missed', t, entry: m });
        s.takeMissed(m.id);
      }
      for (const id of s.dueToApply(t)) log.push({ kind: 'applied', t, result: s.takeResult(id) });
    }
    return log;
  };

  const tight = new DecisionScheduler();
  tight.register('blue', { intervalS: 10, latencyS: 6, deadlineS: 5.99 });
  const tightToken = tight.markIssued('blue', 20);
  assert.strictEqual(
    tight.provideResult('blue', { orders: [], intent: 'DOOMED' }, tightToken),
    false,
    '不成立が確定した判断の結果は、届いても格納しない'
  );
  const tightLog = runGrid(tight, 20, 30);
  assert.deepStrictEqual(
    tightLog.map((e) => e.kind),
    ['missed'],
    '締切 25.99 と発効 26.0 が同じ dt 窓でも、発効ではなく不成立になる'
  );
  assert.ok(Math.abs(tightLog[0].t - 26.0) < 1e-9, `不成立は締切直後の刻みで出る (got ${tightLog[0].t})`);
  assert.strictEqual(tightLog[0].entry.reason, 'doomed');
  assert.strictEqual(tightLog[0].entry.deterministic, true, 'drawn>deadlineS はルール側だけで決まる＝決定論');

  // §12.5 の例（intervalS=10・deadlineS=6・drawn=9）。t_apply を跨いでも不成立のまま
  const example = new DecisionScheduler();
  example.register('blue', { intervalS: 10, latencyS: 9, deadlineS: 6 });
  const exampleToken = example.markIssued('blue', 20);
  example.provideResult('blue', { orders: [], intent: 'DOOMED' }, exampleToken);
  assert.strictEqual(example.missedAt(26.0).length, 1, 't_issue+deadlineS で不成立が確定する');
  assert.deepStrictEqual(example.dueToApply(29.0), [], 't_apply に達しても発効しない');
  assert.strictEqual(example.missedAt(29.0).length, 1, '一度確定した不成立は発効へ戻らない');

  // 分布 × 締切の総当たり: 締切を超えた引きは必ず不成立、間に合った引きは必ず発効
  let doomedSeen = 0;
  for (let seed = 0; seed < 200; seed++) {
    const s = new DecisionScheduler();
    s.register('blue', {
      intervalS: 100,
      deadlineS: 2.95,
      latencyModel: { kind: 'uniform', minS: 2, maxS: 4, seed: `sweep${seed}` },
    });
    const token = s.markIssued('blue', 0);
    const drawn = s.deciders.get('blue').pending.drawnLatencyS;
    s.provideResult('blue', { orders: [] }, token);
    const kinds = runGrid(s, 0, 6).map((e) => e.kind);
    if (drawn > 2.95) {
      doomedSeen++;
      assert.deepStrictEqual(kinds, ['missed'], `drawn=${drawn} > deadlineS=2.95 は不成立 (got ${kinds})`);
    } else {
      assert.deepStrictEqual(kinds, ['applied'], `drawn=${drawn} <= deadlineS=2.95 は発効 (got ${kinds})`);
    }
  }
  assert.ok(doomedSeen > 0, 'スイープに締切超過の引きが含まれていること');

  console.log('OK: a draw that exceeds the deadline is missed at t_issue+deadlineS, never applied');
}

async function testDecisionSchedulerFiniteDeadlineKeepsTheSimRunning() {
  const { DecisionScheduler } = await import('../core/sim/command/decision_scheduler.js');

  // ブラウザ実行器の1フレーム（§8・§9）。結果が永久に届かない場合の挙動を見る。
  // blockedAt が真の間はシム時刻が進まないので、有限の締切を「進んだ t で判定」する作りだと
  // t が deadlineAtT へ永久に届かず、締切を入れた意味が消える（§9「待ち続けることをやめる」）。
  function browserFrames(deadlineS, frames = 3000) {
    const s = new DecisionScheduler();
    s.register('blue', { intervalS: 10, latencyS: 3, deadlineS });
    let t = 0;
    let misses = 0;
    let blockedFrames = 0;
    const reasons = new Set();
    for (let f = 0; f < frames; f++) {
      for (const id of s.dueToApply(t)) s.takeResult(id);
      for (const m of s.missedAt(t)) {
        misses++;
        reasons.add(m.reason);
        s.takeMissed(m.id);
      }
      for (const id of s.dueToIssue(t)) s.markIssued(id, t); // fire-and-forget（結果は届かない）
      if (s.blockedAt(t).length > 0) {
        blockedFrames++; // このフレームは「推論待ち」で終了し、env.step へ進まない
        continue;
      }
      t += 0.1;
    }
    return { t, misses, blockedFrames, reasons: [...reasons] };
  }

  const stalled = browserFrames(Infinity);
  assert.ok(Math.abs(stalled.t - 3.0) < 1e-9, 'deadlineS=∞ は L0 の全停止モデル: t_apply で待ち続ける');
  assert.ok(stalled.blockedFrames > 0 && stalled.misses === 0, '∞ では不成立にならず blocked のまま');

  const finite = browserFrames(6);
  assert.strictEqual(finite.blockedFrames, 0, '有限の締切があるならシムを止めて待たない（§9）');
  assert.ok(finite.t > 200, `有限の締切ではシム時刻が進み続ける (got t=${finite.t})`);
  assert.ok(finite.misses > 0, '未着のまま締切を過ぎた判断は不成立として処理される');
  assert.deepStrictEqual(finite.reasons, ['unarrived']);

  // 到着で決まる不成立は I4 の意図的な例外なので、実行器がログで弾けるよう印を付ける
  const s = new DecisionScheduler();
  s.register('blue', { intervalS: 10, latencyS: 3, deadlineS: 6 });
  s.markIssued('blue', 0);
  const [entry] = s.missedAt(6.0);
  assert.strictEqual(entry.reason, 'unarrived');
  assert.strictEqual(entry.deterministic, false, '結果の到着で決まる不成立はマシン速度依存＝非決定論');

  console.log('OK: a finite deadline stops the wait instead of freezing the sim clock');
}

async function testDecisionSchedulerLatencyHasASingleSource() {
  const { DecisionScheduler } = await import('../core/sim/command/decision_scheduler.js');
  const dist = { kind: 'uniform', minS: 2, maxS: 5, seed: 'probe' };

  // 分布は単独で宣言できる（誰も読まないダミーの latencyS を書かせない）
  const s = new DecisionScheduler();
  s.register('blue', { intervalS: 10, latencyModel: dist });
  s.markIssued('blue', 0);
  const drawn = s.deciders.get('blue').pending.drawnLatencyS;
  assert.ok(drawn >= 2 && drawn < 5, `drawn=${drawn} は宣言した分布から引かれる`);
  assert.strictEqual(s.deciders.get('blue').latencyS, null, '分布のときは1本の宣言値を持たない');

  // シードも設定値なので、同じ設定なら同じ引き（決定論・ハードウェア非依存）
  const twin = new DecisionScheduler();
  twin.register('blue', { intervalS: 10, latencyModel: dist });
  twin.markIssued('blue', 0);
  assert.strictEqual(twin.deciders.get('blue').pending.drawnLatencyS, drawn);

  // 分布と latencyS / stages の併記は設定ミス（§2.5 ルール側の変数は単一の出所を持つ）。
  // 許すと「宣言は 3s なのに実際は引いた値で発効する」状態に誰も気付けない
  assert.throws(
    () => new DecisionScheduler().register('blue', { intervalS: 10, latencyS: 3, latencyModel: dist }),
    /Declare it once/
  );
  assert.throws(
    () =>
      new DecisionScheduler().register('blue', {
        intervalS: 10,
        stages: [{ name: 'infer', seconds: 3 }],
        latencyModel: dist,
      }),
    /Declare it once/
  );
  // constant のときは従来どおり latencyS か stages が要る
  assert.throws(() => new DecisionScheduler().register('blue', { intervalS: 10 }), /latencyS must be a finite number/);

  console.log('OK: latencyS / stages / latencyModel stay a single source of truth for the latency');
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

async function testFusedPictureAndPromptText(core) {
  const { buildFusedPicture } = await import('../core/sim/command/fused_picture.js');
  const { renderPictureText, buildCommanderSystemPrompt } = await import('../core/sim/command/commander_prompt.js');
  const scene = minimalScene(core);
  const world = new core.World({ scene, capacity: 3, radarRangeM: 600, protectedAsset: { x: 100, y: 200 } });
  world.spawn({ id: 'd1', faction: 'defender', platform: 'asv', x: 100, y: 200, heading: Math.PI / 2 });
  world.spawn({ id: 'd2', faction: 'defender', platform: 'asv', x: 400, y: 200, heading: 0 });
  // i1 は d1 から 610m（レーダー 600m の外）・d2 から 310m（内）に置く。d1 との距離を
  // ちょうど 600m にすると radar.js の判定が `range > rangeM` のため d1 も探知され、
  // 「見えていない敵は統合図に載らない」という下の検証が成立しなくなる。
  world.spawn({ id: 'i1', faction: 'intruder', platform: 'asv', x: 710, y: 200, heading: Math.PI });
  const env = new core.EnvApi(world);
  env.reset({ scenario: 'test', episodeIndex: 1 });
  env.step({}); // トラック統合を1回走らせる（i1 は d2 の 310m 東 → defender 側に track が立つ）

  const picture = buildFusedPicture(world, 'defender', { episode: 1 });
  assert.strictEqual(picture.faction, 'defender');
  assert.strictEqual(picture.ownForce.length, 2, 'own force lists only own faction');
  const d1 = picture.ownForce.find((b) => b.id === 'd1');
  assert.ok(Math.abs(d1.eastM - 0) < 1e-6 && Math.abs(d1.northM - 0) < 1e-6, 'asset-relative coords');
  assert.strictEqual(d1.compassHeadingDeg, 0, 'math π/2 (north) renders as compass 000');
  assert.strictEqual(picture.tracks.length, 1);
  assert.ok(Math.abs(picture.tracks[0].eastM - 600) < 30, 'track east of asset by ~600m');
  assert.strictEqual(typeof picture.tracks[0].ageS, 'number');

  // 敵の真位置は統合図に混入しない: intruder 側の picture に「見えていない敵」が居ないこと
  const redPicture = buildFusedPicture(world, 'intruder', { episode: 1 });
  assert.ok(
    redPicture.tracks.every((t) => t.id !== 'd1'),
    'd1 is outside every intruder radar (600m) and must not appear'
  );

  const text = renderPictureText(picture);
  assert.ok(text.includes('d1') && text.includes('ASSET at (0, 0)'), text);
  assert.ok(/last seen/.test(text), 'track staleness is rendered');
  assert.ok(!/"x"|\bx=/.test(text), 'raw world coords must not leak');
  // 指示の要約もアセット基準であること。艇が (0, 0)・その哨戒中心がワールドの (100, 200)
  // と同じ行に並ぶと、指揮官は1枚の図の中で二つの座標系を読まされる。
  assert.ok(!/\(100, 200\)/.test(text), 'order summaries must be asset-relative too');

  const sys = buildCommanderSystemPrompt('defender', { intervalS: 10, latencyS: 3 });
  assert.ok(/80 m/.test(sys) && /60 m/.test(sys), 'mission radii stated');
  assert.ok(/orders/.test(sys) && /intercept/.test(sys) && /move_to/.test(sys) && /patrol/.test(sys));
  assert.ok(/3 s/.test(sys), 'latency is told to the commander (its orders arrive late)');
  assert.notStrictEqual(sys, buildCommanderSystemPrompt('intruder', { intervalS: 10, latencyS: 3 }));

  console.log('OK: fused picture is asset-relative, faction-scoped, and renders with staleness');
}

async function testParseOrdersPartialAcceptance() {
  const { parseOrders } = await import('../core/sim/command/parse_orders.js');
  const roster = { ownBoatIds: ['d1', 'd2'], trackIds: ['i1'] };

  const good = parseOrders(
    'Plan: ```json\n{"orders":[{"boat":"d1","action":"intercept","target":"i1"},' +
      '{"boat":"d2","action":"move_to","waypoint":{"east_m":100,"north_m":-50}}],"intent":"pincer"}\n```',
    roster
  );
  assert.strictEqual(good.ok, true);
  assert.strictEqual(good.orders.length, 2);
  assert.strictEqual(good.orders[1].waypoint.eastM, 100, 'east_m normalises to eastM');
  assert.strictEqual(good.intent, 'pincer');

  // 部分受理: 不正な行だけ落とし、正しい行は生かす
  const partial = parseOrders(
    '{"orders":[{"boat":"ghost","action":"patrol","center":"asset"},' +
      '{"boat":"d1","action":"intercept","target":"unknown-track"},' +
      '{"boat":"d1","action":"teleport"},' +
      '{"boat":"d2","action":"patrol","center":{"east_m":0,"north_m":0},"radius_m":150}],"intent":"x"}',
    roster
  );
  assert.strictEqual(partial.ok, true);
  assert.strictEqual(partial.orders.length, 1, 'only the valid patrol order survives');
  assert.strictEqual(partial.orders[0].boat, 'd2');
  assert.strictEqual(partial.orders[0].radiusM, 150);
  assert.strictEqual(partial.dropped.length, 3);

  // 同一艇への重複指示は後勝ち
  const dup = parseOrders(
    '{"orders":[{"boat":"d1","action":"patrol","center":"asset"},' +
      '{"boat":"d1","action":"intercept","target":"i1"}]}',
    roster
  );
  assert.strictEqual(dup.orders.length, 1);
  assert.strictEqual(dup.orders[0].action, 'intercept', 'later order for the same boat wins');

  assert.strictEqual(parseOrders('no json here', roster).ok, false);
  assert.strictEqual(parseOrders('{"orders":[]}', roster).ok, false, 'empty orders is a failure (keep current)');

  console.log('OK: parseOrders extracts fenced JSON, partially accepts, and normalises keys');
}

async function testScriptedCommanders() {
  const { scriptedDefenderCommander, scriptedIntruderCommander } = await import(
    '../core/sim/command/scripted_commanders.js'
  );

  const picture = {
    faction: 'defender',
    t: 20,
    episode: 1,
    asset: { eastM: 0, northM: 0 },
    ownForce: [
      { id: 'd1', eastM: -100, northM: 0, compassHeadingDeg: 90, speedMps: 5, orderSummary: 'patrol' },
      { id: 'd2', eastM: 300, northM: 0, compassHeadingDeg: 90, speedMps: 5, orderSummary: 'patrol' },
    ],
    tracks: [{ id: 'i1', eastM: 500, northM: 0, ageS: 1.0, seenBy: 'd2' }],
  };
  const blue = scriptedDefenderCommander(picture);
  const intercept = blue.orders.find((o) => o.action === 'intercept');
  assert.ok(intercept, 'a fresh track gets an interceptor');
  assert.strictEqual(intercept.boat, 'd2', 'the nearest defender is assigned');
  assert.strictEqual(intercept.target, 'i1');
  assert.ok(blue.orders.some((o) => o.boat === 'd1' && o.action === 'patrol'), 'the rest patrol');
  assert.ok(typeof blue.intent === 'string' && blue.intent.length > 0);

  // stale トラック（20s超）には割り当てない
  const stalePicture = { ...picture, tracks: [{ id: 'i1', eastM: 500, northM: 0, ageS: 60, seenBy: 'd2' }] };
  assert.ok(
    scriptedDefenderCommander(stalePicture).orders.every((o) => o.action !== 'intercept'),
    'stale tracks are not chased'
  );

  const redPicture = {
    faction: 'intruder',
    t: 0,
    episode: 2,
    asset: { eastM: 0, northM: 0 },
    ownForce: [{ id: 'i1', eastM: 600, northM: 0, compassHeadingDeg: 270, speedMps: 0, orderSummary: 'move_to' }],
    tracks: [],
  };
  const red = scriptedIntruderCommander(redPicture);
  assert.strictEqual(red.orders.length, 1);
  assert.strictEqual(red.orders[0].action, 'move_to');
  // 遠方（>450m）ではエピソード依存の迂回点、近傍ではアセット直行
  const nearPicture = { ...redPicture, ownForce: [{ ...redPicture.ownForce[0], eastM: 200 }] };
  const nearRed = scriptedIntruderCommander(nearPicture);
  assert.strictEqual(nearRed.orders[0].waypoint.eastM, 0);
  assert.strictEqual(nearRed.orders[0].waypoint.northM, 0);

  // 決定論: 同じ統合図からは何度呼んでも同じ指示になる（乱数も実時刻も使わない）
  assert.deepStrictEqual(scriptedIntruderCommander(redPicture), red, 'scripted commanders are deterministic');

  console.log('OK: scripted commanders assign interceptors and stage approaches');
}

/**
 * 統合図テキストは自分の陣営を名乗り、相手陣営の統合図を渡されたら描かずに止まる。
 *
 * 指揮官の陣営（system プロンプト）と統合図の陣営は別々の場所で決まる。Task 7 の
 * createLlmCommanderFn は systemPrompt を生成時に1度だけ作り、picture は判断ごとに
 * 受け取るので、両者の取り違えはモジュール内では検出できなかった。
 * 取り違えの被害は「敵トラックが少し古い」程度の劣化ではない: 相手の統合図には
 * 相手全艇の真位置が OWN FORCE (truth) として載っているので、そのまま敵位置の
 * 全面開示になる。しかも文面は well-formed で、正しいものと見分けが付かない。
 */
async function testPictureTextIsFactionInterlocked(core) {
  const { buildFusedPicture } = await import('../core/sim/command/fused_picture.js');
  const { renderPictureText, buildCommanderSystemPrompt } = await import('../core/sim/command/commander_prompt.js');
  const scene = minimalScene(core);
  // どの防御レーダー（600m）にも侵入艇が映らない配置。防御側の正しい統合図は tracks 空になる。
  const world = new core.World({ scene, capacity: 4, radarRangeM: 600, protectedAsset: { x: 0, y: 0 } });
  world.spawn({ id: 'defender-1', faction: 'defender', platform: 'asv', x: 0, y: 0, heading: 0 });
  world.spawn({ id: 'defender-2', faction: 'defender', platform: 'asv', x: 150, y: 100, heading: 0 });
  world.spawn({ id: 'intruder-1', faction: 'intruder', platform: 'asv', x: 2000, y: 1500, heading: Math.PI });
  world.spawn({ id: 'intruder-2', faction: 'intruder', platform: 'asv', x: 2200, y: -900, heading: Math.PI });
  const env = new core.EnvApi(world);
  env.reset({ scenario: 'test', episodeIndex: 1 });
  env.step({});

  const blue = buildFusedPicture(world, 'defender', { episode: 1 });
  const red = buildFusedPicture(world, 'intruder', { episode: 1 });
  assert.strictEqual(blue.tracks.length, 0, 'no defender radar has ever seen an intruder');

  // 1. 陣営が本文に出る。system 側の名乗り（DEFENDER/INTRUDER）と同じ語なので突き合わせられる。
  const blueText = renderPictureText(blue);
  const redText = renderPictureText(red);
  assert.ok(/DEFENDER/.test(blueText), blueText);
  assert.ok(/INTRUDER/.test(redText), redText);
  const sys = buildCommanderSystemPrompt('defender', { intervalS: 10, latencyS: 3 });
  assert.ok(sys.includes('DEFENDER'), 'the system prompt names the same faction word the picture does');

  // 2. 取り違えたときに何が渡るのか（＝この検査が守っているもの）を明示しておく
  assert.ok(!/intruder-/.test(blueText), 'the correct defender picture names no intruder at all');
  assert.ok(/intruder-1/.test(redText) && /intruder-2/.test(redText), 'the intruder picture carries intruder truth');

  // 3. 指揮官の陣営を渡せば、取り違えは描かれる前に落ちる
  assert.throws(
    () => renderPictureText(red, { expectFaction: 'defender' }),
    /faction mismatch/,
    'a defender commander must never be handed the intruder picture'
  );
  assert.throws(() => renderPictureText(blue, { expectFaction: 'intruder' }), /faction mismatch/);
  assert.strictEqual(renderPictureText(blue, { expectFaction: 'defender' }), blueText, 'a match renders as before');
  assert.throws(() => renderPictureText({ ...blue, faction: 'green' }), /unknown faction/);

  console.log('OK: picture text names its faction and refuses the other side’s picture');
}

/**
 * 統合図は全ての位置を `(east, north)` と描く。小さいモデルはその表記のまま返してくるので、
 * 座標の書き方の揺れは受け止める（フレームは常にアセット基準 east/north で不変）。
 *
 * 実測（本機 Ollama・本物の buildCommanderSystemPrompt + renderPictureText・温度1.0・24呼び出し）:
 *   llama3.2:latest  center:"(0, 0)" を 4 回返し、全て bad_center で落ちていた
 *   qwen2.5:7b       0 回（表記ゆれはモデル依存で、常には起きない）
 * "(0, 0)" はアセットそのもの、つまり patrol の "asset" と同じ意味の指示だった。
 */
async function testParseOrdersAcceptsThePicturesOwnCoordinateNotation() {
  const { parseOrders } = await import('../core/sim/command/parse_orders.js');
  const roster = { ownBoatIds: ['d1', 'd2', 'd3'], trackIds: ['i1'] };

  const tuple = parseOrders(
    '{"orders":[{"boat":"d1","action":"patrol","center":"(0, 0)","radius_m":200},' +
      '{"boat":"d2","action":"move_to","waypoint":"(120, -80)"},' +
      '{"boat":"d3","action":"move_to","waypoint":[100,200]}],"intent":"hold"}',
    roster
  );
  assert.strictEqual(tuple.dropped.length, 0, JSON.stringify(tuple.dropped));
  assert.strictEqual(tuple.orders.length, 3);
  const [patrol, tupleWaypoint, arrayWaypoint] = tuple.orders;
  assert.deepStrictEqual(patrol.center, { eastM: 0, northM: 0 }, '"(0, 0)" is the asset, not a parse error');
  assert.strictEqual(patrol.radiusM, 200);
  assert.deepStrictEqual(tupleWaypoint.waypoint, { eastM: 120, northM: -80 });
  assert.deepStrictEqual(arrayWaypoint.waypoint, { eastM: 100, northM: 200 }, 'an array is [east, north]');

  // 受けるのは表記だけ。フレームが曖昧なもの・数でないものは従来どおり落とす。
  // とくに {x, y} はワールド座標を思わせるが、どちらの基準かは判別できないので受けない。
  const bad = parseOrders(
    '{"orders":[{"boat":"d1","action":"move_to","waypoint":{"x":100,"y":200}},' +
      '{"boat":"d2","action":"move_to","waypoint":"north-east of the asset"},' +
      '{"boat":"d3","action":"move_to","waypoint":[100,200,300]}]}',
    roster
  );
  assert.strictEqual(bad.ok, false, 'world-frame {x,y}, prose and 3-tuples stay rejected');
  assert.strictEqual(bad.dropped.length, 3);
  assert.ok(bad.dropped.every((d) => d.reason === 'bad_waypoint'), JSON.stringify(bad.dropped));

  console.log('OK: parseOrders accepts (e, n) and [e, n] — the notation its own picture uses');
}

// ---------------------------------------------------------------------------
// Task 7: LLM 指揮官（core/sim/agents/llm_http.js + core/sim/command/llm_commander.js）
//
// テストは推論サーバを一切必要としない。fetch は注入（fetchImpl）で差し替える。
// 実サーバを叩くテストは「Ollama が起きていないと落ちる」＝回帰テストとして使えない。
// 実機確認は scripts/llm_probe.js（Task 1）と headless ランナー（Task 8）の役目。
// ---------------------------------------------------------------------------

/** fetch のスタブ。呼び出しごとに {url, init, body(パース済み)} を記録する */
function fakeFetch(responder) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) });
    return responder(calls.length, init);
  };
  impl.calls = calls;
  return impl;
}

/** OpenAI 互換の 200 応答（Ollama / vLLM がどちらもこの形で返す） */
function jsonResponse(content, { completionTokens = 60, finishReason = 'stop', extraMessage = null } = {}) {
  return {
    ok: true,
    status: 200,
    async json() {
      return {
        choices: [{ message: { content, ...(extraMessage ?? {}) }, finish_reason: finishReason }],
        usage: { completion_tokens: completionTokens },
      };
    },
  };
}

const SAMPLE_PICTURE = {
  faction: 'defender',
  t: 20,
  episode: 1,
  asset: { eastM: 0, northM: 0 },
  ownForce: [{ id: 'd1', eastM: -100, northM: 0, compassHeadingDeg: 90, speedMps: 5, orderSummary: 'patrol' }],
  tracks: [{ id: 'i1', eastM: 500, northM: 0, ageS: 1.0, seenBy: 'd1' }],
};

/** 同じ盤面の「相手陣営の」統合図。防御指揮官へ渡してはならないもの（下の陣営インターロック） */
const SAMPLE_RED_PICTURE = {
  faction: 'intruder',
  t: 20,
  episode: 1,
  asset: { eastM: 0, northM: 0 },
  ownForce: [{ id: 'i1', eastM: 500, northM: 0, compassHeadingDeg: 270, speedMps: 5, orderSummary: 'move_to' }],
  tracks: [{ id: 'd1', eastM: -100, northM: 0, ageS: 1.0, seenBy: 'i1' }],
};

const LLM_OPTS = { faction: 'defender', intervalS: 10, latencyS: 3, baseUrl: 'http://x/v1', model: 'm' };

async function testLlmCommanderParsesAndRecordsStats() {
  const { createLlmCommanderFn } = await import('../core/sim/command/llm_commander.js');
  const fetchImpl = fakeFetch(() =>
    jsonResponse('{"orders":[{"boat":"d1","action":"intercept","target":"i1"}],"intent":"take it down"}')
  );
  const onCallRecords = [];
  const decide = createLlmCommanderFn({
    faction: 'defender',
    intervalS: 10,
    latencyS: 3,
    baseUrl: 'http://localhost:11434/v1',
    model: 'test-model',
    fetchImpl,
    onCall: (rec) => onCallRecords.push(rec),
  });

  const result = await decide(SAMPLE_PICTURE);
  assert.strictEqual(result.orders.length, 1);
  assert.strictEqual(result.orders[0].action, 'intercept');
  assert.strictEqual(result.orders[0].target, 'i1');
  assert.strictEqual(result.intent, 'take it down');
  assert.strictEqual(decide.stats.calls, 1);
  assert.strictEqual(decide.stats.ok, 1);
  assert.strictEqual(decide.stats.keptOrders, 0);
  assert.strictEqual(decide.stats.droppedOrders, 0);
  assert.strictEqual(decide.stats.totalOutputTokens, 60);
  assert.strictEqual(decide.stats.byOutcome.ok, 1);

  // 送信内容: OpenAI 互換のパス・system/user の2通・非ストリーム
  const sent = fetchImpl.calls[0];
  assert.ok(sent.url.endsWith('/v1/chat/completions'), sent.url);
  assert.strictEqual(sent.body.model, 'test-model');
  assert.strictEqual(sent.body.stream, false);
  assert.strictEqual(sent.body.messages[0].role, 'system');
  assert.ok(sent.body.messages[0].content.includes('DEFENDER'), 'the system prompt names the commander’s faction');
  assert.strictEqual(sent.body.messages[1].role, 'user');
  assert.ok(sent.body.messages[1].content.includes('FORCE PICTURE'), sent.body.messages[1].content);

  // onCall は「あとから読める1件の記録」。生応答を落とすと失敗の原因調査ができなくなる。
  assert.strictEqual(onCallRecords.length, 1);
  assert.ok(onCallRecords[0].raw.includes('intercept'), 'onCall carries the raw response for later analysis');
  assert.strictEqual(onCallRecords[0].outcome, 'ok');
  assert.strictEqual(onCallRecords[0].faction, 'defender');
  assert.strictEqual(onCallRecords[0].t, 20);
  assert.strictEqual(onCallRecords[0].episode, 1);
  assert.strictEqual(onCallRecords[0].failure, null);
  assert.strictEqual(typeof onCallRecords[0].latencyMs, 'number');

  // 部分受理された分は droppedOrders に積む（プロンプト調整の材料。指示は生きたまま）
  const withJunk = createLlmCommanderFn({
    ...LLM_OPTS,
    fetchImpl: fakeFetch(() =>
      jsonResponse(
        '{"orders":[{"boat":"ghost","action":"patrol","center":"asset"},' +
          '{"boat":"d1","action":"intercept","target":"i1"}],"intent":"x"}'
      )
    ),
  });
  const partial = await withJunk(SAMPLE_PICTURE);
  assert.strictEqual(partial.orders.length, 1, 'the valid order survives');
  assert.strictEqual(withJunk.stats.ok, 1);
  assert.strictEqual(withJunk.stats.droppedOrders, 1, 'the order for a boat it does not command is counted, not hidden');
  assert.strictEqual(withJunk.stats.keptOrders, 0);

  console.log('OK: LLM commander calls the endpoint, parses orders, and records stats');
}

/**
 * 指揮官の失敗は「新しい指示が来ない」という形で世界に現れる（艇レベルの LlmAgent が
 * simpleRuleBasedDecision へ落ちるのとは別の設計。艇は毎tick 操舵量を出す義務があるが、
 * 指揮官には「今回は何も言わない」という正当な状態がある）。
 * ただし黙って通してはならない: 全ての失敗はモード別に数え、keptOrders（維持）へ積む。
 * 完了条件が見るのは keptOrders 率（< 20%）なので、ここが数えられなければ実験が判定できない。
 */
async function testLlmCommanderKeepsOrdersOnFailure() {
  const { createLlmCommanderFn } = await import('../core/sim/command/llm_commander.js');

  const garbage = createLlmCommanderFn({
    ...LLM_OPTS,
    fetchImpl: fakeFetch(() => jsonResponse('I would consider a defensive posture.')),
  });
  assert.strictEqual(await garbage(SAMPLE_PICTURE), null, 'unparseable output means: keep current orders');
  assert.strictEqual(garbage.stats.parseFailures, 1);
  assert.strictEqual(garbage.stats.keptOrders, 1);
  assert.strictEqual(garbage.stats.byOutcome.parse, 1);
  assert.strictEqual(garbage.stats.transportFailures, 0, 'the server answered fine — this is a prompt problem');

  const dead = createLlmCommanderFn({
    ...LLM_OPTS,
    fetchImpl: async () => {
      throw new Error('ECONNREFUSED');
    },
  });
  assert.strictEqual(await dead(SAMPLE_PICTURE), null, 'a dead server must not crash the episode');
  assert.strictEqual(dead.stats.transportFailures, 1);
  assert.strictEqual(dead.stats.keptOrders, 1);
  assert.strictEqual(dead.stats.byOutcome.connection, 1);

  // 失敗モードごとに別の名前が付き、どれも keptOrders を1つ積む。
  // 「落ちた理由が分からない」ままだと、プロンプトを直すべきかサーバを直すべきか決められない。
  const cases = [
    { name: 'http_status', responder: () => ({ ok: false, status: 500, async text() { return 'internal error'; } }) },
    {
      name: 'malformed_body',
      responder: () => ({ ok: true, status: 200, async json() { throw new Error('Unexpected token <'); } }),
    },
    // gpt-oss:20b は thinking 系で、max_tokens=300 では推論に予算を食われて content:"" を返す
    // （docs/llm-probe-measurements-2026-08-13.md）。空文字は parse 失敗ではなくサーバ側の事象。
    { name: 'empty_content', responder: () => jsonResponse('', { finishReason: 'length', completionTokens: 300 }) },
  ];
  for (const c of cases) {
    const records = [];
    const decide = createLlmCommanderFn({
      ...LLM_OPTS,
      fetchImpl: fakeFetch(c.responder),
      onCall: (rec) => records.push(rec),
    });
    assert.strictEqual(await decide(SAMPLE_PICTURE), null, `${c.name}: keeps current orders`);
    assert.strictEqual(decide.stats.byOutcome[c.name], 1, `${c.name} is counted under its own name`);
    assert.strictEqual(decide.stats.keptOrders, 1, `${c.name} counts toward the kept-orders rate`);
    assert.strictEqual(decide.stats.transportFailures, 1, `${c.name} is a transport-side failure, not a prompt problem`);
    assert.strictEqual(records[0].outcome, c.name);
    assert.ok(typeof records[0].failure === 'string' && records[0].failure.length > 0, `${c.name} is reported`);
  }

  // 詰まったサーバー1台で無人実行が止まらないこと。signal を無視する fetch でも打ち切れる。
  const stalled = createLlmCommanderFn({
    ...LLM_OPTS,
    timeoutMs: 30,
    fetchImpl: () => new Promise(() => {}), // 永遠に解決しない＝サーバが握ったまま返さない状態
  });
  const startedAt = Date.now();
  assert.strictEqual(await stalled(SAMPLE_PICTURE), null, 'a stalled server must not hang the simulation');
  assert.ok(Date.now() - startedAt < 5000, `the call returned in ${Date.now() - startedAt}ms, bounded by timeoutMs`);
  assert.strictEqual(stalled.stats.byOutcome.timeout, 1);
  assert.strictEqual(stalled.stats.keptOrders, 1);

  console.log('OK: LLM commander degrades to keeping current orders on any failure');
}

/**
 * 指揮官の陣営と統合図の陣営のインターロック（commander_prompt.js の expectFaction）を配線する。
 * createLlmCommanderFn は systemPrompt を生成時に1度だけ作り、picture は判断ごとに受け取る——
 * 両者が離れているので、取り違えはこのモジュール自身では検出できない。
 * 取り違えると相手陣営の全艇の真位置（OWN FORCE (truth)）がそのままプロンプトに載る。
 *
 * これは推論の失敗ではなく配線の誤りなので、keptOrders に数えて飲み込まず、そのまま投げる。
 * 静かに「維持」へ落とすと、全エピソードが間違った統合図のまま完走してしまう。
 */
async function testLlmCommanderRefusesTheOtherFactionsPicture() {
  const { createLlmCommanderFn } = await import('../core/sim/command/llm_commander.js');
  const fetchImpl = fakeFetch(() => jsonResponse('{"orders":[{"boat":"d1","action":"patrol","center":"asset"}]}'));
  const decide = createLlmCommanderFn({ ...LLM_OPTS, fetchImpl });

  await assert.rejects(() => decide(SAMPLE_RED_PICTURE), /faction mismatch/);
  assert.strictEqual(fetchImpl.calls.length, 0, 'the other side’s truth never reaches the wire');
  assert.strictEqual(decide.stats.calls, 0, 'a wiring error is not an inference failure');
  assert.strictEqual(decide.stats.keptOrders, 0);

  // 自陣営の統合図は素通りする（インターロックが正常系を止めていないこと）
  assert.ok(await decide(SAMPLE_PICTURE));
  assert.strictEqual(fetchImpl.calls.length, 1);

  console.log('OK: LLM commander refuses a picture from the other faction before it reaches the server');
}

/**
 * HTTP 層は「必ず有界時間で、名前の付いた失敗として返る」ことが仕事。
 * ここが素の例外・無限待ちを漏らすと、失敗の集計（keptOrders）も無人実行も成り立たない。
 */
async function testLlmHttpFailsInNamedBoundedWays() {
  const { postChatCompletion, LlmHttpError, LLM_HTTP_FAILURES } = await import('../core/sim/agents/llm_http.js');
  const base = { baseUrl: 'http://x/v1', model: 'm', systemPrompt: 'sys', userPrompt: 'usr', timeoutMs: 1000 };

  const ok = await postChatCompletion({ ...base, fetchImpl: fakeFetch(() => jsonResponse('hello')) });
  assert.strictEqual(ok.text, 'hello');
  assert.strictEqual(ok.outputTokens, 60);
  assert.strictEqual(ok.finishReason, 'stop');

  // 末尾スラッシュの有無でパスが二重にならないこと
  const trailing = fakeFetch(() => jsonResponse('hello'));
  await postChatCompletion({ ...base, baseUrl: 'http://x/v1/', fetchImpl: trailing });
  assert.strictEqual(trailing.calls[0].url, 'http://x/v1/chat/completions');

  async function kindOf(overrides) {
    try {
      await postChatCompletion({ ...base, ...overrides });
      return null;
    } catch (err) {
      assert.ok(err instanceof LlmHttpError, `expected LlmHttpError, got ${err?.name}: ${err?.message}`);
      return err;
    }
  }

  const refused = await kindOf({
    fetchImpl: async () => {
      throw new Error('fetch failed');
    },
  });
  assert.strictEqual(refused.kind, LLM_HTTP_FAILURES.CONNECTION);

  const status = await kindOf({
    fetchImpl: fakeFetch(() => ({ ok: false, status: 404, async text() { return 'model "m" not found'; } })),
  });
  assert.strictEqual(status.kind, LLM_HTTP_FAILURES.HTTP_STATUS);
  assert.strictEqual(status.status, 404);
  assert.ok(/404/.test(status.message) && /not found/.test(status.message), status.message);

  const malformed = await kindOf({
    fetchImpl: fakeFetch(() => ({ ok: true, status: 200, async json() { throw new Error('Unexpected token <'); } })),
  });
  assert.strictEqual(malformed.kind, LLM_HTTP_FAILURES.MALFORMED_BODY);

  // thinking 系モデルの landmine: 200 で返るが content は空。max_tokens を推論が食い切っている。
  // reasoning が付いているかどうかで別の名前を付ける——直し方が違うため（本モジュールの契約2）。
  //   reasoning あり → THINKING_OVERRUN（maxTokens を上げる / thinking を切る / 非 thinking モデル）
  //   reasoning なし → EMPTY_CONTENT   （モデルが単に空を返した。プロンプト側を疑う）
  const overrun = await kindOf({
    fetchImpl: fakeFetch(() =>
      jsonResponse('', { finishReason: 'length', completionTokens: 300, extraMessage: { reasoning: 'thinking...' } })
    ),
  });
  assert.strictEqual(overrun.kind, LLM_HTTP_FAILURES.THINKING_OVERRUN);
  assert.ok(/length/.test(overrun.message), 'the finish reason is reported so the cause is visible');
  assert.ok(/maxTokens|max_tokens/.test(overrun.message), `the fix is named in the message: ${overrun.message}`);
  assert.ok(/thinking/.test(overrun.message), 'thinking is named as the cause');

  const empty = await kindOf({
    fetchImpl: fakeFetch(() => jsonResponse('', { finishReason: 'length', completionTokens: 300 })),
  });
  assert.strictEqual(empty.kind, LLM_HTTP_FAILURES.EMPTY_CONTENT);
  assert.notStrictEqual(
    empty.kind,
    overrun.kind,
    'reasoning の有無で失敗の名前が分かれる（原因の所在が判別できる）'
  );

  // タイムアウトは (1) 有界であること (2) signal で相手にも中断を伝えること の両方
  let seenInit = null;
  const stalledAt = Date.now();
  const timedOut = await kindOf({
    timeoutMs: 30,
    fetchImpl: (_url, init) => {
      seenInit = init;
      return new Promise(() => {});
    },
  });
  assert.strictEqual(timedOut.kind, LLM_HTTP_FAILURES.TIMEOUT);
  assert.ok(Date.now() - stalledAt < 5000, 'the request is abandoned, not awaited forever');
  assert.ok(seenInit.signal, 'an AbortSignal is passed so a real fetch stops transferring too');
  assert.strictEqual(seenInit.signal.aborted, true);

  // AbortError（signal を尊重する本物の fetch）もタイムアウトとして名付けられる
  const aborted = await kindOf({
    timeoutMs: 30,
    fetchImpl: (_url, init) =>
      new Promise((_resolve, reject) => {
        init.signal.addEventListener('abort', () => {
          const err = new Error('This operation was aborted');
          err.name = 'AbortError';
          reject(err);
        });
      }),
  });
  assert.strictEqual(aborted.kind, LLM_HTTP_FAILURES.TIMEOUT);

  console.log('OK: llm_http bounds every request and names every failure mode');
}

// ---------------------------------------------------------------------------
// Task 8: headless ランナー v2（スケジューラ駆動。scripts/headless_run.js）
//
// ランナーは CommonJS だが、意思決定ループ（runEpisode）は core/ の部品を
// すべて引数で受け取る形にしてある。テストは実物の World/EnvApi/DecisionScheduler と、
// 差し替えた applyOrders（発効の瞬間を記録するスパイ）を渡してループだけを検証する。
// 推論サーバは一切必要としない（scripted 腕は core/sim/ の決定論の中で完結する）。
// ---------------------------------------------------------------------------

/** ランナーの1エピソードを回すのに足る最小の攻防世界（防御2・侵入1・防護対象あり） */
function runnerWorld(core) {
  const scene = minimalScene(core);
  const world = new core.World({ scene, capacity: 4, radarRangeM: 600, protectedAsset: { x: 0, y: 0 } });
  world.spawn({ id: 'defender-1', faction: 'defender', platform: 'asv', x: -150, y: 0, heading: 0 });
  world.spawn({ id: 'defender-2', faction: 'defender', platform: 'asv', x: 0, y: 150, heading: 0 });
  world.spawn({ id: 'intruder-1', faction: 'intruder', platform: 'asv', x: 700, y: 200, heading: Math.PI });
  return { world, env: new core.EnvApi(world) };
}

/** runEpisode に渡す core 側の部品一式 */
async function runnerParts() {
  const { DecisionScheduler } = await import('../core/sim/command/decision_scheduler.js');
  const { applyOrders, applyDefaultOrders } = await import('../core/sim/command/orders.js');
  const { computeBoatActions } = await import('../core/sim/command/boat_controller.js');
  const { buildFusedPicture } = await import('../core/sim/command/fused_picture.js');
  const { scriptedDefenderCommander, scriptedIntruderCommander } = await import(
    '../core/sim/command/scripted_commanders.js'
  );
  return {
    DecisionScheduler,
    applyOrders,
    applyDefaultOrders,
    computeBoatActions,
    buildFusedPicture,
    scriptedDefenderCommander,
    scriptedIntruderCommander,
  };
}

const RUNNER_MAX_STEPS = 2450; // EPISODE_TIME_LIMIT_S(240s) / dt(0.1s) + 余裕（ランナー本体と同じ算出）

/**
 * 完了条件そのもの: 指示は t_issue + latencyS ちょうどに発効する。
 * headless は発行を await する（§9）ので、発効が遅れることも早まることも起きてはならない。
 * 「早すぎない」ことは applyOrders スパイが記録した全発効時刻で担保する
 * （このスパイはエピソード中に world.orders を書き換える唯一の経路）。
 */
async function testHeadlessAppliesOrdersExactlyAtIssuePlusLatency(core) {
  const { runEpisode } = require('../scripts/headless_run.js');
  const parts = await runnerParts();
  const { world, env } = runnerWorld(core);

  const timing = { intervalS: 10, latencyS: 3, stages: [{ name: 'infer', seconds: 3 }] };
  const scheduler = new parts.DecisionScheduler();
  scheduler.register('blue-commander', timing);
  scheduler.register('red-commander', timing);

  const issuedAtT = [];
  const commanders = new Map([
    [
      'blue-commander',
      {
        faction: 'defender',
        timing,
        decide: async (picture) => {
          issuedAtT.push({ id: 'blue-commander', t: picture.t });
          return { orders: [{ boat: 'defender-1', action: 'patrol', center: 'asset', radiusM: 200 }], intent: 'guard' };
        },
      },
    ],
    [
      'red-commander',
      {
        faction: 'intruder',
        timing,
        decide: async (picture) => {
          issuedAtT.push({ id: 'red-commander', t: picture.t });
          return { orders: [{ boat: 'intruder-1', action: 'move_to', waypoint: { eastM: 0, northM: 0 } }], intent: 'go' };
        },
      },
    ],
  ]);

  const appliedAtT = [];
  const applyOrdersSpy = (w, faction, orders) => {
    appliedAtT.push({ faction, t: w.clock });
    return parts.applyOrders(w, faction, orders);
  };

  const { result, stepCount, cycles, counts } = await runEpisode({
    world,
    env,
    scheduler,
    commanders,
    buildPicture: parts.buildFusedPicture,
    applyOrders: applyOrdersSpy,
    applyDefaultOrders: parts.applyDefaultOrders,
    computeBoatActions: parts.computeBoatActions,
    meta: { scenario: 'test', episodeIndex: 1 },
    maxSteps: RUNNER_MAX_STEPS,
    quiet: true,
  });

  assert.ok(result.done, 'the episode must reach done');
  assert.ok(stepCount > 100, `the episode must actually run (steps=${stepCount})`);
  assert.ok(cycles.length >= 8, `both commanders must decide several times (cycles=${cycles.length})`);
  assert.ok(counts.issued === cycles.length, 'every issue must leave exactly one record row');

  // 発行は intervalS の格子上（0, 10, 20, ...）
  for (const issue of issuedAtT) {
    assert.ok(Math.abs(issue.t / 10 - Math.round(issue.t / 10)) < 1e-9, `issue at t=${issue.t} is off the 10s grid`);
  }
  // 発効は必ず発行の3秒後ちょうど。1件でも早ければ「発効前の物理が推論結果に依存した」ことになる
  assert.ok(appliedAtT.length > 0, 'orders must actually be applied');
  const firstApply = Math.min(...appliedAtT.map((a) => a.t));
  assert.ok(Math.abs(firstApply - 3.0) < 1e-9, `first order must take effect at t=3.0, got ${firstApply}`);
  // エピソードの決着が発効を追い越した最後の1サイクルは未発効（in-flight）で終わりうる。
  // それ以外の結末（kept / missed）は、この配線では起きてはならない。
  const appliedCycles = cycles.filter((c) => c.outcome === 'applied');
  const inFlight = cycles.filter((c) => c.outcome === 'in-flight');
  assert.strictEqual(
    appliedCycles.length + inFlight.length,
    cycles.length,
    `every cycle must be applied or in-flight, got ${JSON.stringify(cycles.map((c) => c.outcome))}`
  );
  assert.ok(inFlight.length <= commanders.size, `at most one unapplied cycle per commander (${inFlight.length})`);
  assert.ok(inFlight.every((c) => c.tAppliedS === null), 'an in-flight cycle has no apply time');
  for (const cycle of appliedCycles) {
    assert.ok(
      Math.abs(cycle.tAppliedS - (cycle.tIssueS + 3)) < 1e-9,
      `applied at t=${cycle.tAppliedS} but issued at t=${cycle.tIssueS} (+3s expected)`
    );
    assert.ok(Math.abs(cycle.applyLagS) < 1e-9, `applyLagS=${cycle.applyLagS} — latencyS is not the only source`);
  }
  assert.strictEqual(appliedAtT.length, appliedCycles.length, 'every applied cycle calls applyOrders exactly once');
  assert.strictEqual(counts.applied, appliedCycles.length);
  assert.strictEqual(counts.kept, 0);
  assert.strictEqual(counts.missed, 0);
  assert.strictEqual(counts.blocked, 0, 'headless awaits issuance, so it must never block (time-model §9)');
  assert.strictEqual(counts.exactApplies, counts.applied, 'every order must land exactly on t_issue+latencyS');

  // D-3: ステージ別の実測 t_wall は記録側だけに存在する（ルール側の latencyS は 3s のまま）
  for (const cycle of cycles) {
    assert.strictEqual(typeof cycle.stageWallMs.infer, 'number', 'the measured infer wall time must be recorded');
    assert.deepStrictEqual(cycle.stagesDeclared, [{ name: 'infer', seconds: 3 }]);
  }

  console.log('OK: headless applies orders exactly at t_issue + latencyS and never blocks');
}

/**
 * scripted 対 scripted の腕は完全に決定論で、推論サーバを必要としない。
 * 「必要としない」は fetch を落とし穴に差し替えて実証する（触れば例外で落ちる）。
 */
async function testHeadlessScriptedArmIsDeterministicAndOffline(core) {
  const { runEpisode } = require('../scripts/headless_run.js');
  const parts = await runnerParts();
  const timing = { intervalS: 10, latencyS: 3, stages: [{ name: 'infer', seconds: 3 }] };

  async function runTwoEpisodes() {
    const { world, env } = runnerWorld(core);
    const scheduler = new parts.DecisionScheduler();
    const commanders = new Map([
      ['blue-commander', { faction: 'defender', timing, decide: async (p) => parts.scriptedDefenderCommander(p) }],
      ['red-commander', { faction: 'intruder', timing, decide: async (p) => parts.scriptedIntruderCommander(p) }],
    ]);
    for (const [id, c] of commanders) scheduler.register(id, c.timing);
    const trace = [];
    for (let ep = 1; ep <= 2; ep++) {
      const { result, stepCount, cycles } = await runEpisode({
        world,
        env,
        scheduler,
        commanders,
        buildPicture: parts.buildFusedPicture,
        applyOrders: (w, faction, orders) => {
          trace.push(`${w.clock.toFixed(1)} ${faction} ${JSON.stringify(orders)}`);
          return parts.applyOrders(w, faction, orders);
        },
        applyDefaultOrders: parts.applyDefaultOrders,
        computeBoatActions: parts.computeBoatActions,
        meta: { scenario: 'test', episodeIndex: ep },
        maxSteps: RUNNER_MAX_STEPS,
        quiet: true,
      });
      trace.push(`episode ${ep}: ${result.info.outcome} steps=${stepCount} cycles=${cycles.length}`);
    }
    return trace;
  }

  const realFetch = globalThis.fetch;
  let first;
  let second;
  try {
    globalThis.fetch = () => {
      throw new Error('the scripted arm must not touch the network');
    };
    first = await runTwoEpisodes();
    second = await runTwoEpisodes();
  } finally {
    globalThis.fetch = realFetch;
  }

  assert.deepStrictEqual(second, first, 'the scripted arm must be bit-identical across runs');
  assert.ok(first.length > 8, `the scripted arm must actually issue orders (trace=${first.length} rows)`);
  // エピソード2は侵入側の接近角が変わる（picture.episode が唯一の変化の種）ので、同じ盤面でも同じ軌跡にならない
  const ep1 = first.filter((row) => row.startsWith('episode 1:'))[0];
  const ep2 = first.filter((row) => row.startsWith('episode 2:'))[0];
  assert.notStrictEqual(ep1.slice(ep1.indexOf(':')), ep2.slice(ep2.indexOf(':')), 'episodes must not be carbon copies');

  console.log('OK: the scripted arm is deterministic and needs no inference server');
}

/**
 * 締切に間に合わない判断は、結果が手元にあっても発効しない（§12.5）。
 * headless は await するので unarrived には原理的に入れない。入るのは doomed（発行時に確定）だけで、
 * これはシードと設定値だけで決まる＝決定論のまま「不安定な指揮系統」を再現できることの確認でもある。
 */
async function testHeadlessCountsMissesInsteadOfApplyingThem(core) {
  const { runEpisode } = require('../scripts/headless_run.js');
  const parts = await runnerParts();
  const { world, env } = runnerWorld(core);

  // deadlineS(1s) < latencyS(3s) → 全発行が発行時点で不成立確定
  const timing = { intervalS: 10, latencyS: 3, deadlineS: 1, onMiss: 'keep-current' };
  const scheduler = new parts.DecisionScheduler();
  const commanders = new Map([
    ['blue-commander', { faction: 'defender', timing, decide: async (p) => parts.scriptedDefenderCommander(p) }],
    ['red-commander', { faction: 'intruder', timing, decide: async (p) => parts.scriptedIntruderCommander(p) }],
  ]);
  for (const [id, c] of commanders) scheduler.register(id, c.timing);

  const defaultOrderCalls = [];
  const { result, cycles, counts } = await runEpisode({
    world,
    env,
    scheduler,
    commanders,
    buildPicture: parts.buildFusedPicture,
    applyOrders: parts.applyOrders,
    applyDefaultOrders: (w, options) => {
      defaultOrderCalls.push(options ?? null);
      return parts.applyDefaultOrders(w, options);
    },
    computeBoatActions: parts.computeBoatActions,
    meta: { scenario: 'test', episodeIndex: 1 },
    maxSteps: RUNNER_MAX_STEPS,
    quiet: true,
  });

  assert.ok(result.done, 'a commander that always misses must still let the episode finish');
  assert.strictEqual(counts.applied, 0, 'a missed decision must never take effect');
  assert.ok(counts.missed >= 4, `misses must be counted (missed=${counts.missed})`);
  assert.strictEqual(counts.blocked, 0);
  const missedCycles = cycles.filter((c) => c.outcome === 'missed');
  assert.strictEqual(missedCycles.length, counts.missed);
  assert.ok(
    cycles.every((c) => c.outcome === 'missed' || c.outcome === 'in-flight'),
    `a doomed decision can only be missed (or still in flight), got ${JSON.stringify(cycles.map((c) => c.outcome))}`
  );
  for (const cycle of missedCycles) {
    assert.strictEqual(cycle.missReason, 'doomed', 'headless can only miss deterministically (§12.5)');
    assert.strictEqual(cycle.deterministic, true);
    assert.strictEqual(cycle.tAppliedS, null);
  }
  // onMiss='keep-current' なので艇は既定指示のまま（applyDefaultOrders は呼ばれない）
  assert.deepStrictEqual(defaultOrderCalls, [], 'keep-current must not re-apply default orders');
  assert.strictEqual(world.orders.get('defender-1').issuedT, 0, 'the boat must still hold its default order');

  // onMiss='default-order' は「通信途絶で既定指示へ戻る」腕。陣営を限って適用されること
  const second = runnerWorld(core);
  const missTiming = { intervalS: 10, latencyS: 3, deadlineS: 1, onMiss: 'default-order' };
  const missScheduler = new parts.DecisionScheduler();
  missScheduler.register('blue-commander', missTiming);
  const resets = [];
  await runEpisode({
    world: second.world,
    env: second.env,
    scheduler: missScheduler,
    commanders: new Map([
      [
        'blue-commander',
        { faction: 'defender', timing: missTiming, decide: async (p) => parts.scriptedDefenderCommander(p) },
      ],
    ]),
    buildPicture: parts.buildFusedPicture,
    applyOrders: parts.applyOrders,
    applyDefaultOrders: (w, options) => {
      resets.push(options?.faction ?? null);
      return parts.applyDefaultOrders(w, options);
    },
    computeBoatActions: parts.computeBoatActions,
    meta: { scenario: 'test', episodeIndex: 1 },
    maxSteps: RUNNER_MAX_STEPS,
    quiet: true,
  });
  assert.ok(resets.length >= 1, 'default-order must re-apply the default orders on a miss');
  assert.deepStrictEqual([...new Set(resets)], ['defender'], 'a miss must only touch its own faction');

  console.log('OK: missed decisions are counted and never applied');
}

/**
 * 発効時刻の検算行（サマリの `timing:`）は、分子と分母が同じ母集団でなければ意味を成さない。
 *
 * この行は L0 の完了条件「指示は t_issue + latencyS ちょうどに効く」そのものを数で示す唯一の
 * 出力である。かつて exactApplies は「発効時刻に達したサイクル」全体（applied + kept）で
 * 数えられ、分母だけが applied だった。scripted 同士の腕では kept=0 なので 500/500 と正しく
 * 見え、推論が失敗しがちな LLM 腕でだけ 22/15 のような成立しない比になった——読者がこの行を
 * いちばん信用したい場面で壊れていた。ここでは「失敗する指揮官」を明示的に作って kept>0 を
 * 起こし、結末ごとに母集団が閉じていることを確かめる。
 */
async function testHeadlessTimingCountsSplitAppliedFromKept(core) {
  const { runEpisode } = require('../scripts/headless_run.js');
  const parts = await runnerParts();
  const { world, env } = runnerWorld(core);

  const timing = { intervalS: 10, latencyS: 3, stages: [{ name: 'infer', seconds: 3 }] };
  const scheduler = new parts.DecisionScheduler();
  scheduler.register('blue-commander', timing);
  scheduler.register('red-commander', timing);

  // 1回おきに null を返す＝推論の失敗（llm_commander が失敗を表す形）。決定論のため乱数は使わない。
  function flakyCommander(fn) {
    let n = 0;
    return async (picture) => (n++ % 2 === 0 ? fn(picture) : null);
  }
  const commanders = new Map([
    [
      'blue-commander',
      { faction: 'defender', timing, decide: flakyCommander(parts.scriptedDefenderCommander) },
    ],
    ['red-commander', { faction: 'intruder', timing, decide: flakyCommander(parts.scriptedIntruderCommander) }],
  ]);

  const { result, counts } = await runEpisode({
    world,
    env,
    scheduler,
    commanders,
    buildPicture: parts.buildFusedPicture,
    applyOrders: parts.applyOrders,
    applyDefaultOrders: parts.applyDefaultOrders,
    computeBoatActions: parts.computeBoatActions,
    meta: { scenario: 'test', episodeIndex: 1 },
    maxSteps: RUNNER_MAX_STEPS,
    quiet: true,
  });

  assert.ok(result.done, 'a commander that fails every other cycle must still finish the episode');
  assert.ok(counts.applied > 0, `the arm must apply something (applied=${counts.applied})`);
  // これが無いと、この検査は scripted 腕（kept=0）と同じ穴を通り抜けてしまう
  assert.ok(counts.kept > 0, `this test is only meaningful when decisions fail (kept=${counts.kept})`);
  assert.strictEqual(counts.exactApplies, counts.applied, 'exactApplies must be counted over applied cycles only');
  assert.strictEqual(counts.exactKeeps, counts.kept, 'a kept cycle is released on the same exact tick');
  assert.ok(
    counts.exactApplies <= counts.applied && counts.exactKeeps <= counts.kept,
    `each ratio must stay <= 1 (${counts.exactApplies}/${counts.applied}, ${counts.exactKeeps}/${counts.kept})`
  );
  assert.strictEqual(counts.blocked, 0);
  assert.strictEqual(counts.missed, 0);

  console.log('OK: the timing line counts applied and kept cycles against their own populations');
}

/**
 * 統制群（scripted 同士）の接近角はエピソードごとに異なり、巡回しない。
 *
 * 旧実装は `(episode % 3) - 1` で、存在するエピソードは 3 種類だけだった。勝率は
 * episodes を増やしても動かない定数（厳密に 2/3）で、端数が出るのは episodes が 3 で
 * 割り切れないときだけ——20 エピソードの 65.0% は測定ではなく打ち切り誤差である。
 * 温度 0.7 で本物のばらつきを持つ LLM 腕と勝率を比べる以上、統制群の実効標本サイズが
 * 3 では比較そのものが成立しない。決定論（乱数も実時刻も使わない）は保ったまま、
 * エピソードごとに異なる角を取ることを確かめる。
 */
async function testScriptedIntruderApproachDoesNotCycle() {
  const { approachVariation, scriptedIntruderCommander } = await import(
    '../core/sim/command/scripted_commanders.js'
  );

  const N = 30;
  const variations = [];
  for (let e = 1; e <= N; e++) variations.push(approachVariation(e));
  assert.strictEqual(
    new Set(variations.map((v) => v.toFixed(12))).size,
    N,
    'every episode must get its own approach angle'
  );
  assert.ok(
    variations.every((v) => v >= -1 && v < 1),
    'the variation must stay inside the declared +/-55deg swing'
  );
  // 周期 p で巡回していないこと（旧実装は p=3 だった）
  for (const p of [2, 3, 4, 5, 6]) {
    assert.ok(
      variations.some((v, i) => i + p < N && Math.abs(v - variations[i + p]) > 1e-9),
      `the approach angle must not repeat with period ${p}`
    );
  }
  // 低食い違い列なので、少ない N でも範囲の両側を使う（片側だけを掃く列ではない）
  assert.ok(Math.min(...variations) < -0.8 && Math.max(...variations) > 0.8, 'both extremes must be reachable');

  // 決定論: 乱数も実時刻も使わない＝同じ episode は常に同じ角
  assert.strictEqual(approachVariation(7), approachVariation(7));
  const picture = {
    faction: 'intruder',
    t: 0,
    episode: 7,
    asset: { eastM: 0, northM: 0 },
    ownForce: [{ id: 'i1', eastM: 600, northM: 0, compassHeadingDeg: 270, speedMps: 0, orderSummary: 'move_to' }],
    tracks: [],
  };
  assert.deepStrictEqual(
    scriptedIntruderCommander(picture),
    scriptedIntruderCommander(picture),
    'the scripted intruder must stay deterministic'
  );
  // 迂回点はエピソードごとに動く（episode が唯一の変化の種であることの裏返し）
  const wp = (e) => scriptedIntruderCommander({ ...picture, episode: e }).orders[0].waypoint;
  const seen = new Set();
  for (let e = 1; e <= 10; e++) {
    const w = wp(e);
    seen.add(`${w.eastM.toFixed(6)},${w.northM.toFixed(6)}`);
  }
  assert.strictEqual(seen.size, 10, 'ten episodes must produce ten distinct approach waypoints');

  console.log('OK: the scripted intruder approach varies per episode and never cycles');
}

/** ランナーの引数の既定値は Task 8 以前の呼び出しと同じ意味を保つ（腕の既定は scripted＝GPU 不要） */
async function testHeadlessRunnerArgsKeepLegacyDefaults() {
  const { parseArgs } = require('../scripts/headless_run.js');

  const defaults = parseArgs([]);
  assert.strictEqual(defaults.episodes, 5, '--episodes default must stay 5');
  assert.strictEqual(defaults.boats, null, '--boats default must stay "scenario default"');
  assert.strictEqual(defaults.quiet, false);
  assert.strictEqual(defaults.blue, 'scripted', 'the default arm must not need an inference server');
  assert.strictEqual(defaults.red, 'scripted');
  assert.strictEqual(defaults.commandIntervalS, 10);
  assert.strictEqual(defaults.commandLatencyS, 3);
  assert.strictEqual(defaults.deadlineS, Infinity, 'L0 の既定は締切なし（全停止モデル）');
  assert.strictEqual(defaults.onMiss, 'keep-current');

  // Task 8 以前から使われている2つの呼び出しがそのまま通ること
  assert.strictEqual(parseArgs(['--episodes', '5']).episodes, 5);
  const legacy = parseArgs(['--boats', '6', '--episodes', '10']);
  assert.strictEqual(legacy.boats, 6);
  assert.strictEqual(legacy.episodes, 10);
  assert.strictEqual(legacy.blue, 'scripted');

  assert.throws(() => parseArgs(['--blue', 'llm']), /--model/, 'an LLM arm without --model must not start');
  assert.throws(() => parseArgs(['--blue', 'gpt']), /scripted/);
  assert.throws(() => parseArgs(['--bogus']), /unknown argument/);
  assert.throws(() => parseArgs(['--episodes', '0']), /--episodes/);
  assert.throws(() => parseArgs(['--command-interval', '0']), /--command-interval/);
  assert.throws(() => parseArgs(['--command-latency', '-1']), /--command-latency/);
  assert.throws(() => parseArgs(['--on-miss', 'panic']), /--on-miss/);

  console.log('OK: headless runner arguments keep the pre-Task-8 defaults');
}

/**
 * 記録フックが非同期（JSONL/fs ロガーの自然な形）で失敗しても、采配は止まらず、
 * 失敗は onCallErrors に数えられる。数えないと「記録が無い＝呼ばれていない」と読めてしまい、
 * 未処理の rejection のままだと無人実行が exit 1 で死ぬ。
 */
async function testLlmCommanderCountsAnAsyncOnCallFailure() {
  const { createLlmCommanderFn } = await import('../core/sim/command/llm_commander.js');
  const fetchImpl = fakeFetch(() =>
    jsonResponse('{"orders":[{"boat":"d1","action":"intercept","target":"i1"}],"intent":"go"}')
  );
  const unhandled = [];
  const onUnhandled = (err) => unhandled.push(err);
  process.on('unhandledRejection', onUnhandled);
  try {
    const decide = createLlmCommanderFn({
      ...LLM_OPTS,
      fetchImpl,
      onCall: async () => {
        await Promise.resolve();
        throw new Error('ENOSPC: no space left on device, write');
      },
    });
    const result = await decide(SAMPLE_PICTURE);
    assert.strictEqual(result.orders.length, 1, 'a logging failure must not swallow the orders');
    // 非同期フックの失敗はマイクロタスクの後に届く。unhandledRejection の判定もこの後で行う
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    assert.strictEqual(decide.stats.onCallErrors, 1, 'an async onCall rejection must be counted');
    assert.deepStrictEqual(unhandled, [], 'an async onCall rejection must not escape as an unhandled rejection');
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }

  console.log('OK: an async onCall failure is counted and never kills the run');
}

/**
 * 爆破半径という「唯一の距離」が持つ三つの意味（docs/game-design.md §2）を、物理を回さずに
 * 直接 evaluateMission() へ問う。艇を手で置いて1回だけ評価するので、操舵・追従・レーダーの
 * どれが壊れてもこのテストは動かない——ルールそのものだけを固定する。
 *
 * とくに A-1（旗を壊せるのは「重装艇だけ」ではなく「武装艦すべて。届く距離は自分の爆破半径」）は
 * 数字の入れ替えでは検出できない。旧ルール（decisiveOnAsset かつ 80m 固定）で落ちる点を
 * 意図的に含めてある: 快速艇 45m（旧: 何も起きない）と 重装艇 90m（旧: 80m 圏外で何も起きない）。
 */
async function testMissionRulesOfTheBlastRadius(core) {
  const { evaluateMission } = await import('../core/sim/mission.js');
  const scene = minimalScene(core);

  /** 旗の位置と艇（id/faction/shipClass/x/y）を並べるだけの World を作る */
  function placed(asset, boats) {
    const world = new core.World({ scene, capacity: boats.length, protectedAsset: asset });
    for (const b of boats) {
      world.spawn({ id: b.id, faction: b.faction, shipClass: b.shipClass, platform: 'asv', x: b.x, y: b.y, heading: 0 });
    }
    return world;
  }
  const aliveOf = (world, id) => world.state.alive[world.state.indexOf(id)];
  const eventTypes = (r) => r.events.map((e) => e.type);

  // --- 1. 対艦: どちらかの爆破半径に入れば相討ち（半径の大きいほうが効く） ---
  {
    // 快速(50m) と 重装(100m) が 80m。快速の半径では届かないが、重装の 100m が双方を巻き込む
    const world = placed({ x: 5000, y: 5000 }, [
      { id: 'd1', faction: 'defender', shipClass: 'runner', x: 0, y: 0 },
      { id: 'i1', faction: 'intruder', shipClass: 'heavy', x: 80, y: 0 },
    ]);
    const r = evaluateMission(world);
    assert.strictEqual(aliveOf(world, 'd1'), 0, 'the defender dies too: interception is mutual destruction');
    assert.strictEqual(aliveOf(world, 'i1'), 0, 'the intruder dies');
    const md = r.events.find((e) => e.type === 'mutual_destruction');
    assert.ok(md, `mutual_destruction must be emitted (got ${eventTypes(r).join(',')})`);
    assert.strictEqual(md.blastRadiusM, 100, 'the larger blast radius (heavy) is the one that detonates');
    assert.strictEqual(md.intruder, 'i1');
    assert.strictEqual(md.defender, 'd1');
    // 武装した侵入艇が居なくなったので防御側の勝ち（自軍を失っていても旗が立っていれば勝ち）
    assert.strictEqual(r.outcome, 'defended', 'losing your own boat still counts as a defence');
    assert.strictEqual(r.done, true);
  }

  // --- 1b. 相討ちが起きない距離 ---
  {
    const world = placed({ x: 5000, y: 5000 }, [
      { id: 'd1', faction: 'defender', shipClass: 'runner', x: 0, y: 0 },
      { id: 'i1', faction: 'intruder', shipClass: 'heavy', x: 120, y: 0 },
    ]);
    const r = evaluateMission(world);
    assert.strictEqual(aliveOf(world, 'd1'), 1, '120m is outside the heavy 100m blast: nobody detonates');
    assert.strictEqual(aliveOf(world, 'i1'), 1);
    assert.strictEqual(r.done, false, 'the episode continues while an armed intruder lives');
  }

  // --- 2. 巻き添え: 迎撃の爆心（相討ちした2艇の中点）に旗が入れば旗も壊れる ---
  {
    // 中点は (40, 0)。旗をそこから 90m に置く → 爆破半径 100m の内側
    const world = placed({ x: 40, y: 90 }, [
      { id: 'd1', faction: 'defender', shipClass: 'runner', x: 0, y: 0 },
      { id: 'i1', faction: 'intruder', shipClass: 'heavy', x: 80, y: 0 },
    ]);
    const r = evaluateMission(world);
    assert.ok(eventTypes(r).includes('mutual_destruction'), 'the interception still happens');
    const blast = r.events.find((e) => e.type === 'asset_destroyed_by_blast');
    assert.ok(blast, `asset_destroyed_by_blast must be emitted (got ${eventTypes(r).join(',')})`);
    assert.strictEqual(blast.intruder, 'i1');
    assert.strictEqual(blast.defender, 'd1');
    assert.strictEqual(r.outcome, 'breached', 'collateral damage to the flag is an intruder win');
    assert.strictEqual(r.done, true);
  }
  {
    // 同じ迎撃でも、旗が爆心から 150m なら無傷 → 籠城しなければ迎撃してよい、という境界
    const world = placed({ x: 40, y: 150 }, [
      { id: 'd1', faction: 'defender', shipClass: 'runner', x: 0, y: 0 },
      { id: 'i1', faction: 'intruder', shipClass: 'heavy', x: 80, y: 0 },
    ]);
    const r = evaluateMission(world);
    assert.ok(eventTypes(r).includes('mutual_destruction'));
    assert.ok(!eventTypes(r).includes('asset_destroyed_by_blast'), '150m from the blast centre is outside the 100m radius');
    assert.strictEqual(r.outcome, 'defended');
  }

  // --- 3. 対旗: 武装した侵入艇はどれでも、自分の爆破半径だけ届く（A-1） ---
  const farDefender = { id: 'd-far', faction: 'defender', shipClass: 'runner', x: -4000, y: 0 };
  {
    // 快速艇 50m: 45m は内側 → 突破。旧ルール（重装限定）ではここは何も起きなかった
    const world = placed({ x: 0, y: 0 }, [farDefender, { id: 'i-run', faction: 'intruder', shipClass: 'runner', x: 45, y: 0 }]);
    const r = evaluateMission(world);
    const br = r.events.find((e) => e.type === 'asset_breached');
    assert.ok(br, `a runner inside its own 50m blast destroys the flag (got ${eventTypes(r).join(',')})`);
    assert.strictEqual(br.intruder, 'i-run');
    assert.strictEqual(br.blastRadiusM, 50, 'the reach is the runner own blast radius, not a shared constant');
    assert.strictEqual(r.outcome, 'breached');
  }
  {
    // 快速艇 60m: 自分の半径 50m の外 → 届かない。旧 ASSET_BREACH_RANGE_M(80m) の内側であっても関係ない
    const world = placed({ x: 0, y: 0 }, [farDefender, { id: 'i-run', faction: 'intruder', shipClass: 'runner', x: 60, y: 0 }]);
    const r = evaluateMission(world);
    assert.ok(!eventTypes(r).includes('asset_breached'), '60m is outside the runner 50m reach (the old 80m constant must not decide)');
    assert.strictEqual(r.done, false);
  }
  {
    // 重装艇 90m: 自分の半径 100m の内側 → 突破。旧ルール（80m 固定）では届かなかった
    const world = placed({ x: 0, y: 0 }, [farDefender, { id: 'i-hvy', faction: 'intruder', shipClass: 'heavy', x: 90, y: 0 }]);
    const r = evaluateMission(world);
    const br = r.events.find((e) => e.type === 'asset_breached');
    assert.ok(br, `a heavy reaches 100m, further than the old 80m constant (got ${eventTypes(r).join(',')})`);
    assert.strictEqual(br.blastRadiusM, 100);
    assert.strictEqual(r.outcome, 'breached');
  }
  {
    // 索敵艇は非武装。旗の真上に居ても何も起きない（武装した重装艇が別に生きているので継続する）
    const world = placed({ x: 0, y: 0 }, [
      farDefender,
      { id: 'i-scout', faction: 'intruder', shipClass: 'scout', x: 0, y: 0 },
      { id: 'i-hvy', faction: 'intruder', shipClass: 'heavy', x: 3000, y: 0 },
    ]);
    const r = evaluateMission(world);
    assert.ok(!eventTypes(r).includes('asset_breached'), 'a scout sitting on the flag does nothing: blast radius 0');
    assert.strictEqual(r.done, false);
  }
  {
    // 索敵艇しか残っていない侵入側には旗を壊す手段が無い → その場で防御側の勝ち
    const world = placed({ x: 0, y: 0 }, [farDefender, { id: 'i-scout', faction: 'intruder', shipClass: 'scout', x: 0, y: 0 }]);
    const r = evaluateMission(world);
    assert.strictEqual(r.outcome, 'defended', 'only unarmed intruders left means the defence has already succeeded');
    assert.strictEqual(r.done, true);
  }

  // --- 4. 非武装同士は接触しても何も起きない ---
  {
    const world = placed({ x: 5000, y: 5000 }, [
      { id: 'd-scout', faction: 'defender', shipClass: 'scout', x: 0, y: 0 },
      { id: 'i-scout', faction: 'intruder', shipClass: 'scout', x: 10, y: 0 },
      { id: 'i-hvy', faction: 'intruder', shipClass: 'heavy', x: 3000, y: 0 }, // 決着させないための生存艦
    ]);
    const r = evaluateMission(world);
    assert.strictEqual(aliveOf(world, 'd-scout'), 1, 'two unarmed scouts at 10m must both survive');
    assert.strictEqual(aliveOf(world, 'i-scout'), 1);
    assert.deepStrictEqual(eventTypes(r), [], 'no event at all: neither side can detonate');
    assert.strictEqual(r.done, false);
  }

  console.log('OK: blast radius decides interception, collateral damage, and the flag for every armed class');
}

/**
 * 艇の失敗は2種類あり、混ぜると直し方を誤る（2026-09-06）。
 *   PARSE            — 出力の形が壊れている。プロンプトのスキーマ説明かモデル選定を疑う
 *   OFF_RADAR_TARGET — 形は正しく、見えていない相手を指した。**判断**の問題であり、
 *                      プロンプトやサーバを直しても消えない
 * 実測では艇の失敗137件のうち JSON 破損は0件で、全件が後者だった。同じバケットに
 * 入れていたせいで「プロンプトかサーバを直せ」という誤った警告が出ていた。
 */
async function testBoatSeparatesOffRadarTargetFromParseFailure() {
  const { parseBoatDecision, BOAT_OUTCOMES } = await import('../core/sim/agents/boat_agent.js');
  const ctx = { boatId: 'def-runner-1', contactIds: ['int-heavy'] };

  // 形は妥当だが、レーダーに映っていない相手を指した
  const offRadar = parseBoatDecision(
    '{"decision":"override","action":"intercept","target":"int-runner-1","reason":"No intruder, but ordered to intercept."}',
    ctx
  );
  assert.strictEqual(offRadar.ok, false, 'unseen targets are still rejected');
  assert.strictEqual(offRadar.offRadarTarget, true, 'the rejection is labelled so it can be counted apart');
  assert.ok(/radar/.test(offRadar.error), offRadar.error);

  // 本当に壊れている出力には印を付けない
  const broken = parseBoatDecision('not json at all', ctx);
  assert.strictEqual(broken.ok, false);
  assert.notStrictEqual(broken.offRadarTarget, true, 'a malformed body is not an off-radar target');

  // 見えている相手は通る（防壁が厳しすぎないこと）
  const seen = parseBoatDecision('{"decision":"override","action":"intercept","target":"int-heavy"}', ctx);
  assert.strictEqual(seen.ok, true, 'a visible target is accepted');

  assert.notStrictEqual(
    BOAT_OUTCOMES.OFF_RADAR_TARGET,
    BOAT_OUTCOMES.PARSE,
    '2つの結末は別の名前を持つ（byOutcome で分けて数えられる）'
  );
  console.log('  ok: 艇の「見えない敵を指した」はパース失敗と別に数えられる');
}

async function main() {
  const core = await loadCore();
  await testRadarRangeIsConfigurable(core);
  await testObservationIsEntityBasedAndTracksFuse(core);
  await testMissionRulesOfTheBlastRadius(core);
  await testOrdersApplyAndDefaults(core);
  await testBoatControllerFollowsOrders();
  await testSynthesizedSpawnsAreNotBornDecided(core);
  await testDecisionSchedulerLifecycle();
  await testDecisionSchedulerIssueTokens();
  await testDecisionSchedulerDeadline();
  await testDecisionSchedulerDoomedDrawsAreNeverApplied();
  await testDecisionSchedulerFiniteDeadlineKeepsTheSimRunning();
  await testDecisionSchedulerLatencyHasASingleSource();
  await testFusedPictureAndPromptText(core);
  await testPictureTextIsFactionInterlocked(core);
  await testParseOrdersPartialAcceptance();
  await testParseOrdersAcceptsThePicturesOwnCoordinateNotation();
  await testScriptedCommanders();
  await testLlmHttpFailsInNamedBoundedWays();
  await testLlmCommanderParsesAndRecordsStats();
  await testLlmCommanderKeepsOrdersOnFailure();
  await testLlmCommanderRefusesTheOtherFactionsPicture();
  await testHeadlessRunnerArgsKeepLegacyDefaults();
  await testHeadlessAppliesOrdersExactlyAtIssuePlusLatency(core);
  await testHeadlessScriptedArmIsDeterministicAndOffline(core);
  await testHeadlessCountsMissesInsteadOfApplyingThem(core);
  await testHeadlessTimingCountsSplitAppliedFromKept(core);
  await testScriptedIntruderApproachDoesNotCycle();
  await testLlmCommanderCountsAnAsyncOnCallFailure();
  await testBoatSeparatesOffRadarTargetFromParseFailure();

  console.log('\nAll command tests passed.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
