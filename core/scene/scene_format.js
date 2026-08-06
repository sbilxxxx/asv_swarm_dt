/**
 * scene_format.js — ②データソース非依存の中間シーン表現
 *
 * すべての①アダプターはこの形式に変換して出力する。
 * digital-twin（Three.js）・swarm-sim（Canvas）はこの形式だけを見ればよく、
 * データソースが何であるかを知る必要はない。
 * 将来 OpenUSD へ入出力する場合も、このオブジェクトを起点に変換する想定。
 *
 * @typedef {Object} SceneGeometry
 * @property {string} name
 * @property {{lat: number, lon: number}} originLatLon - ローカル座標系の原点
 * @property {Array<{x: number, y: number}>} coastline - ローカル座標のポリゴン頂点（1周分）
 * @property {Array<{x: number, y: number, radius: number, kind: string}>} obstacles
 * @property {{minX:number,maxX:number,minY:number,maxY:number}} bounds - coastlineの外接矩形
 */

import { setOrigin, latLonToLocal } from '../coord.js';

/**
 * @param {{name: string, originLatLon: {lat:number,lon:number}, coastlineLatLon: Array<{lat:number,lon:number}>, obstacles?: Array<any>}} input
 * @returns {SceneGeometry}
 */
export function createSceneGeometry(input) {
  setOrigin(input.originLatLon);
  const coastline = input.coastlineLatLon.map((p) => latLonToLocal(p.lat, p.lon));
  return {
    name: input.name,
    originLatLon: input.originLatLon,
    coastline,
    obstacles: input.obstacles ?? [],
    bounds: computeBounds(coastline),
  };
}

function computeBounds(points) {
  const xs = points.map((p) => p.x);
  const ys = points.map((p) => p.y);
  return {
    minX: Math.min(...xs),
    maxX: Math.max(...xs),
    minY: Math.min(...ys),
    maxY: Math.max(...ys),
  };
}
