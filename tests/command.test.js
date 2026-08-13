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

async function main() {
  const core = await loadCore();
  await testRadarRangeIsConfigurable(core);
  console.log('\nAll command tests passed.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
