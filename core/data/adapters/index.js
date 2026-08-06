/**
 * index.js — ①アダプターの登録レジストリ
 *
 * 新しいデータソース（AIS/ドローン観測/S-100/PLATEAU/Google Maps・Earth/衛星画像/OpenUSD）を
 * 追加する場合は、ここに登録を追加するだけで済むようにする。
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
