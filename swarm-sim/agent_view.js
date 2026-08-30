/**
 * agent_view.js — ASV（防御・侵入）のアイコン・航跡を描画
 *
 * 座標変換は map_view.js の project() を再利用し、重複させない。
 *
 * 【艦種の描き分け】core/sim/ship_classes.js の非対称性（速力・爆破半径・非武装）を
 * この俯瞰図では隠さない。艦種ごとに形・大きさを変え、武装艦（blastRadiusM > 0）には
 * 爆破半径の輪を薄く常時表示する——mission.js の「対艦」「対旗」判定に使う唯一の距離を
 * 見た目でも同じ数値のまま出す（drawProtectedAsset が突破判定円を描くのと同じ考え方）。
 * これはこの俯瞰デバッグ図の話であって、レーダー越しの索敵（radar.js は艦種を返さない）
 * とは別レイヤー。艦種を隠すのはセンサー・指揮官の視界だけで、この画面はいわば神の視点。
 */

import { shipClassOf } from '../core/sim/ship_classes.js';

const trails = new Map(); // id -> array of {px, py}
const MAX_TRAIL_POINTS = 60;

/** 艦種ごとの見た目。scaleは既存の快速艇サイズ(7/4/4)を基準にした倍率 */
const MARKERS = {
  runner: { scale: 1, shape: 'triangle', filled: true },
  scout: { scale: 0.85, shape: 'diamond', filled: false },
  heavy: { scale: 1.6, shape: 'triangle', filled: true },
};

function markerOf(shipClass) {
  return MARKERS[shipClass] ?? MARKERS.runner;
}

/** 艇体（三角）を原点中心・進行方向+xで描く */
function drawTriangleHull(ctx, scale, filled, color) {
  ctx.beginPath();
  ctx.moveTo(7 * scale, 0);
  ctx.lineTo(-4 * scale, 4 * scale);
  ctx.lineTo(-4 * scale, -4 * scale);
  ctx.closePath();
  if (filled) {
    ctx.fillStyle = color;
    ctx.fill();
  } else {
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.5;
    ctx.stroke();
  }
}

/** 索敵艇（非武装）はひし形の枠だけ。積荷を持たない=中身が空、という見た目にする */
function drawDiamondHull(ctx, scale, filled, color) {
  ctx.beginPath();
  ctx.moveTo(6 * scale, 0);
  ctx.lineTo(0, 4 * scale);
  ctx.lineTo(-6 * scale, 0);
  ctx.lineTo(0, -4 * scale);
  ctx.closePath();
  if (filled) {
    ctx.fillStyle = color;
    ctx.fill();
  } else {
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.5;
    ctx.stroke();
  }
}

/**
 * @param {CanvasRenderingContext2D} ctx
 * @param {Array<{id:string, faction:string, shipClass?:string, x:number, y:number, heading:number}>} entities
 * @param {(x:number, y:number) => {px:number, py:number}} project
 */
export function drawAgents(ctx, entities, project) {
  // 距離(m)→px の縮尺。爆破半径の輪をワールド座標の距離と同じ数値で描くために要る
  // （drawOrders/drawProtectedAssetと同じ導出方法。座標変換の出所を増やさない）。
  const pxPerM = project(1, 0).px - project(0, 0).px;

  for (const e of entities) {
    const { px, py } = project(e.x, e.y);
    const shipClass = shipClassOf(e.shipClass);
    const marker = markerOf(e.shipClass);
    const color = e.faction === 'defender' ? '#4fb8d6' : '#e0708e';

    // 爆破半径の輪（非武装の索敵艇は blastRadiusM=0 なので描かれない＝それ自体が「非武装」の表示）
    if (shipClass.blastRadiusM > 0) {
      ctx.save();
      ctx.strokeStyle = e.faction === 'defender' ? 'rgba(79,184,214,0.22)' : 'rgba(224,112,142,0.22)';
      ctx.setLineDash([2, 3]);
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.arc(px, py, shipClass.blastRadiusM * pxPerM, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
    }

    if (!trails.has(e.id)) trails.set(e.id, []);
    const trail = trails.get(e.id);
    trail.push({ px, py });
    if (trail.length > MAX_TRAIL_POINTS) trail.shift();

    ctx.strokeStyle = e.faction === 'defender' ? 'rgba(79,184,214,0.5)' : 'rgba(224,112,142,0.5)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    trail.forEach((p, i) => (i === 0 ? ctx.moveTo(p.px, p.py) : ctx.lineTo(p.px, p.py)));
    ctx.stroke();

    ctx.save();
    ctx.translate(px, py);
    ctx.rotate(-e.heading); // world(反時計回り・y上向き) → canvas(時計回り・y下向き)への符号反転
    if (marker.shape === 'diamond') drawDiamondHull(ctx, marker.scale, marker.filled, color);
    else drawTriangleHull(ctx, marker.scale, marker.filled, color);
    ctx.restore();

    ctx.fillStyle = '#8fa8a4';
    ctx.font = '10px system-ui';
    ctx.fillText(e.id, px + 9, py - 9);
  }
}
