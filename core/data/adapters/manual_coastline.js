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
   * @param {{name: string, originLatLon: {lat: number, lon: number}, coastlineLatLon: Array<{lat: number, lon: number}>, obstacles?: Array<any>}} config
   */
  constructor(config) {
    super();
    this.config = config;
  }

  async load() {
    // TODO: 実データ（S-100/PLATEAU等）に差し替える場合はここを別アダプターとして実装する
    return createSceneGeometry({
      name: this.config.name,
      originLatLon: this.config.originLatLon,
      coastlineLatLon: this.config.coastlineLatLon,
      obstacles: this.config.obstacles ?? [],
    });
  }
}
