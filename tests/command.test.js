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
  await testSynthesizedSpawnsAreNotBornDecided(core);
  console.log('\nAll command tests passed.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
