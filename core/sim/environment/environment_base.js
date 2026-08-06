/**
 * environment_base.js — ③環境力学（波・海流等）の共通インターフェース
 *
 * 今回は静水面のみ（calm_sea.js）。将来、簡易解析式モデルや
 * 学習済みサロゲートモデルに差し替える場合はこれを継承する。
 */

export class EnvironmentBase {
  /**
   * @param {number} x
   * @param {number} y
   * @param {number} t - シミュレーション時刻（秒）
   * @returns {{waveHeightM: number, currentX: number, currentY: number}}
   */
  sample(x, y, t) {
    throw new Error('EnvironmentBase.sample() must be implemented by subclass');
  }
}
