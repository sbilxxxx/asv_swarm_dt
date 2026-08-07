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
   * @param {import('../environment/environment_base.js').EnvironmentBase} [environment] - B-3対応:
   *   波・海流サロゲートモデルの差し込み口。未指定なら環境力を無視する（呼び出し側の後方互換用）
   * @param {number} [t] - シミュレーション時刻（秒）。environment.sample(x,y,t)に渡す
   */
  step(state, index, action, dt, environment, t) {
    throw new Error('PlatformBase.step() must be implemented by subclass');
  }
}
