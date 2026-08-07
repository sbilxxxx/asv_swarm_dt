/**
 * coord.js — 緯度経度 ⇔ ローカル座標（メートル）の変換ユーティリティ
 *
 * 小規模な海域（湾程度のスケール）を対象とした簡易等距円筒図法。
 * どのデータアダプター・シナリオでも同じ変換を使うことで座標系のブレを防ぐ。
 *
 * レビュー指摘A-7/E-6対応: 以前はこのモジュールがoriginを1つだけのモジュールグローバル変数として
 * 保持しており、別originのシナリオでcreateSceneGeometry()を呼ぶと既存ワールドのGNSSが
 * 壊れる不具合があった（「グローバル変数非依存・並列実行を妨げない」という設計原則への違反。
 * 実測: 既存ワールドのGNSSが(35.45,139.75)→(34.00,133.50)へ変化した）。
 * 現在はモジュールグローバル状態を一切持たず、createProjection(originLatLon) がシナリオ（scene）
 * ごとに独立した変換関数のペアを返す。呼び出し側（SceneGeometry）がこのprojectionを保持し、
 * 複数のWorld/シーンを同時に存在させても互いのorigin変換が干渉しない。
 */

const EARTH_RADIUS_M = 6378137;

/**
 * 指定originに束縛された緯度経度⇔ローカル座標変換関数のペアを生成する。
 * @param {{lat: number, lon: number}} originLatLon
 * @returns {{
 *   origin: {lat: number, lon: number},
 *   latLonToLocal: (lat: number, lon: number) => {x: number, y: number},
 *   localToLatLon: (x: number, y: number) => {lat: number, lon: number},
 * }}
 */
export function createProjection(originLatLon) {
  const origin = { ...originLatLon };
  const latRad = (origin.lat * Math.PI) / 180;
  const cosLat = Math.cos(latRad);

  /**
   * 緯度経度 → ローカルXY（メートル、原点基準。x=東, y=北）
   * @param {number} lat
   * @param {number} lon
   * @returns {{x: number, y: number}}
   */
  function latLonToLocal(lat, lon) {
    const x = (((lon - origin.lon) * Math.PI) / 180) * EARTH_RADIUS_M * cosLat;
    const y = (((lat - origin.lat) * Math.PI) / 180) * EARTH_RADIUS_M;
    return { x, y };
  }

  /**
   * ローカルXY（メートル）→ 緯度経度
   * @param {number} x
   * @param {number} y
   * @returns {{lat: number, lon: number}}
   */
  function localToLatLon(x, y) {
    const lon = origin.lon + (x / (EARTH_RADIUS_M * cosLat)) * (180 / Math.PI);
    const lat = origin.lat + (y / EARTH_RADIUS_M) * (180 / Math.PI);
    return { lat, lon };
  }

  return { origin: { ...origin }, latLonToLocal, localToLatLon };
}
