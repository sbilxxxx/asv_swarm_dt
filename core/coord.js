/**
 * coord.js — 緯度経度 ⇔ ローカル座標（メートル）の変換ユーティリティ
 *
 * 小規模な海域（湾程度のスケール）を対象とした簡易等距円筒図法。
 * どのデータアダプター・シナリオでも同じ変換を使うことで座標系のブレを防ぐ。
 */

const EARTH_RADIUS_M = 6378137;

/** ローカル座標系の原点。シナリオ読み込み時に setOrigin() で切り替える。 */
let origin = { lat: 35.45, lon: 139.75 };

/** @param {{lat: number, lon: number}} newOrigin */
export function setOrigin(newOrigin) {
  origin = { ...newOrigin };
}

export function getOrigin() {
  return { ...origin };
}

/**
 * 緯度経度 → ローカルXY（メートル、原点基準。x=東, y=北）
 * @param {number} lat
 * @param {number} lon
 * @returns {{x: number, y: number}}
 */
export function latLonToLocal(lat, lon) {
  const latRad = (origin.lat * Math.PI) / 180;
  const x = (((lon - origin.lon) * Math.PI) / 180) * EARTH_RADIUS_M * Math.cos(latRad);
  const y = (((lat - origin.lat) * Math.PI) / 180) * EARTH_RADIUS_M;
  return { x, y };
}

/**
 * ローカルXY（メートル）→ 緯度経度
 * @param {number} x
 * @param {number} y
 * @returns {{lat: number, lon: number}}
 */
export function localToLatLon(x, y) {
  const latRad = (origin.lat * Math.PI) / 180;
  const lon = origin.lon + (x / (EARTH_RADIUS_M * Math.cos(latRad))) * (180 / Math.PI);
  const lat = origin.lat + (y / EARTH_RADIUS_M) * (180 / Math.PI);
  return { lat, lon };
}
