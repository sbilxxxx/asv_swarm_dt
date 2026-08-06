/**
 * sensor_base.js — ③センサーの共通インターフェース
 *
 * observe() の入出力さえ守れば、GNSS・レーダーのような純粋計算のセンサーも、
 * カメラのようにレンダリングエンジンを要するセンサーも同じ扱いにできる。
 */

export class SensorBase {
  /**
   * @param {import('../world.js').World} world
   * @param {string} entityId - 観測主体のエンティティID
   * @returns {object} センサー種別ごとのデータ
   */
  observe(world, entityId) {
    throw new Error('SensorBase.observe() must be implemented by subclass');
  }
}
