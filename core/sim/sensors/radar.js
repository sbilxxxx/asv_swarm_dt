/**
 * radar.js — レーダーセンサー（純粋計算、シーン内オブジェクトとの距離・方位を算出）
 *
 * 実測ではなく EntityState からの幾何計算による簡易モデル。
 */

import { SensorBase } from './sensor_base.js';

/** 既定の探知距離。シナリオが sensors.radarRangeM を指定しない場合に使う */
export const DEFAULT_RADAR_RANGE_M = 1500;

export class RadarSensor extends SensorBase {
  /**
   * @param {{rangeM?: number}} [options] - 探知距離。運用領域より広い固定値のままだと
   *   全艇が全艇を常時捕捉し、部分観測（統合図の意味）が成立しない
   *   （docs/l0-llm-agent-plan.md Task 2）。
   */
  constructor({ rangeM = DEFAULT_RADAR_RANGE_M } = {}) {
    super();
    this.rangeM = rangeM;
  }

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
      if (range > this.rangeM) continue;
      contacts.push({
        id: world.state.id[j],
        faction: world.state.faction[j],
        rangeM: range,
        bearingRad: Math.atan2(dy, dx),
      });
    }

    return { type: 'radar', rangeM: this.rangeM, contacts, timestamp: world.clock };
  }
}
