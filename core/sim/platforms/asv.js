/**
 * asv.js — 今回実装する唯一のPlatform: ASVの簡易運動学
 *
 * 6自由度は扱わず、水面上の2D運動（位置x,y・進行方向heading・速度speed）のみ。
 * AUVを追加する場合は PlatformBase を継承した auv.js を作り index.js に登録する。
 */

import { PlatformBase } from './platform_base.js';

const MAX_SPEED_MPS = 6; // 目安値。要調整
const MAX_TURN_RATE_RAD_S = 0.5; // 目安値。要調整
const ACCEL_MPS2 = 1.5; // 目安値。要調整

export class AsvPlatform extends PlatformBase {
  step(state, index, action, dt) {
    const throttle = clamp(action?.throttle ?? 0, -1, 1);
    const steering = clamp(action?.steering ?? 0, -1, 1);

    state.speed[index] = clamp(state.speed[index] + throttle * ACCEL_MPS2 * dt, 0, MAX_SPEED_MPS);
    state.heading[index] += steering * MAX_TURN_RATE_RAD_S * dt;

    state.x[index] += Math.cos(state.heading[index]) * state.speed[index] * dt;
    state.y[index] += Math.sin(state.heading[index]) * state.speed[index] * dt;
  }
}

function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}
