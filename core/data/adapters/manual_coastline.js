/**
 * manual_coastline.js — 今回実装する唯一の①アダプター（静的地物系）
 *
 * 手書きの簡易海岸線データ。実データ（S-100/PLATEAU等）に差し替える場合は
 * StaticGeometryAdapter を継承した新しいアダプターを追加し、index.js に登録する。
 * 座標は簡略化した例示用ポリゴンであり、実際の海岸線を正確には表さない。
 */

import { StaticGeometryAdapter } from './adapter_base.js';
import { createSceneGeometry } from '../../scene/scene_format.js';

export class ManualCoastlineAdapter extends StaticGeometryAdapter {
  /**
   * @param {{name: string, originLatLon: {lat: number, lon: number}, coastlineLatLon: Array<{lat: number, lon: number}>, spawnsAreaLatLon?: Array<{lat: number, lon: number}>, landmarkSet?: string}} config
   */
  constructor(config) {
    super();
    this.config = config;
  }

  async load() {
    // TODO: 実データ（S-100/PLATEAU等）に差し替える場合はここを別アダプターとして実装する
    // レビューA-9対応: spawnsAreaLatLon を渡し忘れていたため、boundsに運用エリアが
    // 反映されずspawnがbounds外に出る不具合があった。ここで確実に素通しする。
    return createSceneGeometry({
      name: this.config.name,
      originLatLon: this.config.originLatLon,
      coastlineLatLon: this.config.coastlineLatLon,
      spawnsAreaLatLon: this.config.spawnsAreaLatLon,
      landmarkSet: this.config.landmarkSet,
    });
  }
}
