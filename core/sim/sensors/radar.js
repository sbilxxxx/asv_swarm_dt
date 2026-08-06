/**
 * radar.js — レーダーセンサー（純粋計算、シーン内オブジェクトとの距離・方位を算出）
 *
 * 実測ではなく EntityState からの幾何計算による簡易モデル。
 */

import { SensorBase } from './sensor_base.js';

const RANGE_M = 1500; // 目安値。要調整

export class RadarSensor extends SensorBase {
  observe(world, entityId) {
    const i = world.state.indexOf(entityId);
    if (i < 0) return null;
    const selfX = world.state.x[i];
    const selfY = world.state.y[i];

    const contacts = [];
    for (let j = 0; j < world.state.count; j++) {
      if (j === i || !world.state.alive[j]) continue;
      const dx = world.state.x[j] - selfX;
      const dy = world.state.y[j] - selfY;
      const range = Math.hypot(dx, dy);
      if (range > RANGE_M) continue;
      contacts.push({
        id: world.state.id[j],
        faction: world.state.faction[j],
        rangeM: range,
        bearingRad: Math.atan2(dy, dx),
      });
    }

    return { type: 'radar', rangeM: RANGE_M, contacts, timestamp: world.clock };
  }
}
