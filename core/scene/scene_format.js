/**
 * scene_format.js — ②データソース非依存の中間シーン表現
 *
 * すべての①アダプターはこの形式に変換して出力する。
 * digital-twin（Three.js）・swarm-sim（Canvas）はこの形式だけを見ればよく、
 * データソースが何であるかを知る必要はない。
 * 将来 OpenUSD へ入出力する場合も、このオブジェクトを起点に変換する想定。
 *
 * レビューB-4対応: `obstacles` はスキーマ・型定義のみで実装（描画・衝突判定）が
 * 一切無いまま放置されていたため、実装するまでスキーマからも外した。障害物対応が
 * 必要になったら、描画（digital-twin/swarm-sim双方）・衝突判定・シナリオJSONのデータを
 * 揃えた上で改めて追加すること。
 *
 * @typedef {Object} SceneGeometry
 * @property {string} name
 * @property {{lat: number, lon: number}} originLatLon - ローカル座標系の原点
 * @property {{origin: {lat:number,lon:number}, latLonToLocal: Function, localToLatLon: Function}} projection - このシーン専用の緯度経度⇔ローカル座標変換（core/coord.js#createProjection の戻り値。A-7/E-6対応: シーンごとに独立させ、モジュールグローバルoriginを廃止した）
 * @property {Array<{x: number, y: number}>} coastline - ローカル座標のポリゴン頂点（1周分）
 * @property {{minX:number,maxX:number,minY:number,maxY:number}} bounds - 表示・カメラ配置の基準となる範囲（coastline＋運用エリアの外接矩形）
 * @property {string} [landmarkSet] - 任意。digital-twinの背景ランドマーク群の選択キー（例: "tokyo_bay"）。未指定ならランドマークを描画しない（B-8対応）
 */

import { createProjection } from '../coord.js';

/**
 * boundsはcoastlineだけでなく、実際にエンティティが運用される範囲（spawnsAreaLatLon）も
 * 含めて計算する。海岸線の外に開けた海（外洋）でASVが動く構図があるため、
 * 海岸線だけでboundsを決めると、2Dマップ・3Dカメラの画角から船がはみ出す。
 *
 * @param {{name: string, originLatLon: {lat:number,lon:number}, coastlineLatLon: Array<{lat:number,lon:number}>, spawnsAreaLatLon?: Array<{lat:number,lon:number}>, landmarkSet?: string}} input
 * @returns {SceneGeometry}
 */
export function createSceneGeometry(input) {
  const projection = createProjection(input.originLatLon);
  const coastline = input.coastlineLatLon.map((p) => projection.latLonToLocal(p.lat, p.lon));
  const spawnsArea = (input.spawnsAreaLatLon ?? []).map((p) => projection.latLonToLocal(p.lat, p.lon));
  return {
    name: input.name,
    originLatLon: input.originLatLon,
    projection,
    coastline,
    bounds: computeBounds([...coastline, ...spawnsArea]),
    landmarkSet: input.landmarkSet,
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
