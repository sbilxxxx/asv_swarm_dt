/**
 * platform_base.js — ③機体（Platform）の共通インターフェース
 *
 * ASV（水上）とAUV（水中、将来）で運動学・力学が大きく異なるため、
 * 「機体」を差し替え可能な単位として抽象化する。
 */

export class PlatformBase {
  /**
   * 1ステップ分の運動を計算し、EntityStateを直接更新する。
   * @param {import('../state.js').EntityState} state
   * @param {number} index
   * @param {{throttle: number, steering: number}} action
   * @param {number} dt - 秒
   */
  step(state, index, action, dt) {
    throw new Error('PlatformBase.step() must be implemented by subclass');
  }
}
