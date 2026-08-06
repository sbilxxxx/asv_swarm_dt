/**
 * adapter_base.js — ①データ取り込み層の共通インターフェース
 *
 * 静的地物系（地形・海岸線等）と動的観測系（AIS・ドローン観測等）の
 * 2種類を想定するが、今回実装するのは静的地物系のみ（manual_coastline.js）。
 * 新しいデータソースを追加する場合はこのクラスを継承する。
 */

export class StaticGeometryAdapter {
  /**
   * @returns {Promise<import('../../scene/scene_format.js').SceneGeometry>}
   */
  async load() {
    throw new Error('StaticGeometryAdapter.load() must be implemented by subclass');
  }
}

/**
 * 動的観測系（AIS・ドローン観測等）。今回は未実装。
 * 将来: AISアダプター、ドローン観測アダプターがこれを継承する。
 */
export class DynamicObservationAdapter {
  /**
   * @returns {AsyncIterable<object>}
   */
  async *stream() {
    throw new Error('DynamicObservationAdapter.stream() must be implemented by subclass');
  }
}
