/**
 * radar.js — レーダーセンサー（純粋計算、シーン内オブジェクトとの距離・方位を算出）
 *
 * 実測ではなく EntityState からの幾何計算による簡易モデル。
 */

import { SensorBase } from './sensor_base.js';
import { SHIP_CLASSES } from '../ship_classes.js';

/** 既定の探知距離。シナリオが sensors.radarRangeM を指定しない場合に使う */
export const DEFAULT_RADAR_RANGE_M = 1500;

export class RadarSensor extends SensorBase {
  /**
   * @param {{rangeM?: number, perShipClass?: boolean}} [options]
   *   rangeM: 探知距離。運用領域より広い固定値のままだと全艇が全艇を常時捕捉し、
   *     部分観測（統合図の意味）が成立しない（docs/l0-llm-agent-plan.md Task 2）。
   *   perShipClass: true なら艇ごとに艦種の探知距離（ship_classes.js）を使い、rangeM は無視する。
   *     索敵艇が「遠くまで見える」ことが駒の個体差の一つなので、艦種入りシナリオではこちらを使う。
   */
  constructor({ rangeM = DEFAULT_RADAR_RANGE_M, perShipClass = false } = {}) {
    super();
    this.rangeM = rangeM;
    this.perShipClass = perShipClass;
  }

  /** この艇の探知距離。perShipClass なら艦種から、そうでなければ一律 */
  rangeFor(world, index) {
    if (!this.perShipClass) return this.rangeM;
    const cls = SHIP_CLASSES[world.state.shipClass[index]];
    return cls ? cls.radarRangeM : this.rangeM;
  }

  observe(world, entityId) {
    const i = world.state.indexOf(entityId);
    if (i < 0) return null;
    const selfX = world.state.x[i];
    const selfY = world.state.y[i];
    const rangeM = this.rangeFor(world, i);

    const contacts = [];
    for (let j = 0; j < world.state.count; j++) {
      if (j === i || !world.state.alive[j]) continue;
      const dx = world.state.x[j] - selfX;
      const dy = world.state.y[j] - selfY;
      const range = Math.hypot(dx, dy);
      if (range > rangeM) continue;
      contacts.push({
        id: world.state.id[j],
        faction: world.state.faction[j],
        rangeM: range,
        bearingRad: Math.atan2(dy, dx),
      });
    }

    // rangeM はこの艇の探知距離（艦種差を反映）。艦種そのものは返さない——
    // レーダーに映るのは「点」であって、どれが重装艇かは分からない（ship_classes.js の設計）。
    return { type: 'radar', rangeM, contacts, timestamp: world.clock };
  }
}
