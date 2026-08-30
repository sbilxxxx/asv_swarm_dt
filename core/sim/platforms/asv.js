/**
 * asv.js — 今回実装する唯一のPlatform: ASVの簡易運動学
 *
 * 6自由度は扱わず、水面上の2D運動（位置x,y・進行方向heading・速度speed）のみ。
 * AUVを追加する場合は PlatformBase を継承した auv.js を作り index.js に登録する。
 * ただしそれだけでは不十分（B-5）: EntityStateへの深度(z)フィールド追加と
 * GNSS/レーダー/通信センサーの3D対応が別途必要（現状は2D専用）。詳細はindex.jsのコメント参照。
 */

import { PlatformBase } from './platform_base.js';
import { shipClassOf } from '../ship_classes.js';

export class AsvPlatform extends PlatformBase {
  /**
   * 運動性能は艦種から決まる（core/sim/ship_classes.js）。艦種ごとに別クラスを作らず
   * 1クラスをパラメータで振り分けるのは、差が「表の数値」であって挙動の型ではないから。
   * @param {{shipClass?: string}} [config] - 省略時は既定艦種（後方互換: 従来の単一性能に近い runner ではなく
   *   ship_classes.js の DEFAULT_SHIP_CLASS が使われる）
   */
  constructor(config = {}) {
    super(config);
    this.shipClass = shipClassOf(config.shipClass);
  }

  // B-3対応: environment.sample()を運動学に配線。差し込み口を「効く」状態にする。
  step(state, index, action, dt, environment, t) {
    const throttle = clamp(action?.throttle ?? 0, -1, 1);
    const steering = clamp(action?.steering ?? 0, -1, 1);
    const { maxSpeedMps, maxTurnRateRadS, accelMps2 } = this.shipClass;

    state.speed[index] = clamp(state.speed[index] + throttle * accelMps2 * dt, 0, maxSpeedMps);
    state.heading[index] += steering * maxTurnRateRadS * dt;

    state.x[index] += Math.cos(state.heading[index]) * state.speed[index] * dt;
    state.y[index] += Math.sin(state.heading[index]) * state.speed[index] * dt;

    // 環境力（波・海流サロゲートモデル）による並進のみを加える小さな摂動。
    // CalmSeaEnvironmentはcurrentX=currentY=0を返すため既定シナリオの挙動は変わらない。
    // environment省略時（呼び出し側の後方互換）は何もしない。
    if (environment) {
      const { currentX = 0, currentY = 0 } = environment.sample(state.x[index], state.y[index], t ?? 0);
      state.x[index] += currentX * dt;
      state.y[index] += currentY * dt;
    }
  }
}

function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}
