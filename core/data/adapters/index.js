/**
 * index.js — ①アダプターの登録レジストリ
 *
 * 新しいデータソース（AIS/ドローン観測/S-100/PLATEAU/Google Maps・Earth/衛星画像/OpenUSD）を
 * 追加する場合は、ここに登録を追加するだけで済むようにする。
 *
 * レビューB-1/E-8対応: 以前は staticGeometryAdapters を参照するコードがゼロで、
 * digital-twin/swarm-simの両main.jsが createSceneGeometry(scenario) を直接呼んでいたため、
 * このレジストリは「差し込み口はあるが誰も呼ばない」状態だった。loadSceneFromScenario() を
 * 唯一のロード経路にし、シナリオJSONの "adapter" フィールドでアダプターを選択させる。
 */

import { ManualCoastlineAdapter } from './manual_coastline.js';

export const staticGeometryAdapters = {
  manual_coastline: ManualCoastlineAdapter,

  // 将来の拡張予約（未実装）:
  // s100: null,          // S-100（次世代航海データ標準）
  // plateau: null,       // Project PLATEAU（3D都市モデル）
  // google_maps: null,   // Google Maps / Earth
  // satellite: null,     // 衛星画像
  // usd: null,           // OpenUSD インポート
};

export const dynamicObservationAdapters = {
  // 将来の拡張予約（未実装）:
  // ais: null,           // AISデータ
  // drone_survey: null,  // 現地ドローン観測データ
};

/**
 * シナリオJSONの `adapter` フィールドでstaticGeometryAdaptersから実装を選び、SceneGeometryを
 * 構築する唯一のロード経路。digital-twin/swarm-sim/headless_run はすべてこれを通す。
 *
 * @param {{adapter?: string, name: string, originLatLon: object, coastlineLatLon: Array<object>, spawnsAreaLatLon?: Array<object>, landmarkSet?: string}} scenario
 * @returns {Promise<import('../../scene/scene_format.js').SceneGeometry>}
 */
export async function loadSceneFromScenario(scenario) {
  const AdapterClass = scenario.adapter ? staticGeometryAdapters[scenario.adapter] : undefined;
  if (!AdapterClass) {
    const known = Object.keys(staticGeometryAdapters).join(', ');
    throw new Error(
      `scenario.adapter "${scenario.adapter ?? '(未指定)'}" は不明です（既知のアダプター: ${known}）`
    );
  }
  const adapter = new AdapterClass({
    name: scenario.name,
    originLatLon: scenario.originLatLon,
    coastlineLatLon: scenario.coastlineLatLon,
    spawnsAreaLatLon: scenario.spawnsAreaLatLon,
    landmarkSet: scenario.landmarkSet,
  });
  return adapter.load();
}
