/**
 * map_view.js — SceneGeometry（②） → Canvas描画（海岸線・防護対象）＋ 座標変換
 *
 * digital-twinのscene_builder.jsと役割は対になるが、こちらはThree.jsではなくCanvas 2D。
 * ワールド座標（メートル）→ 画面ピクセルの変換をここで一元管理し、agent_view.jsと共有する
 * （座標変換を2箇所に重複させない）。
 */

import { ASSET_BREACH_RANGE_M } from '../core/sim/mission.js';

const PADDING_PX = 40;

/** @returns {number} ワールド座標(m) → 画面px の縮尺（project()と同じ計算をcircle半径等でも使うため公開） */
export function computeScale(canvas, bounds) {
  const w = Math.max(bounds.maxX - bounds.minX, 1);
  const h = Math.max(bounds.maxY - bounds.minY, 1);
  const cw = Math.max(canvas.width - PADDING_PX * 2, 1);
  const ch = Math.max(canvas.height - PADDING_PX * 2, 1);
  return Math.min(cw / w, ch / h);
}

/**
 * @param {HTMLCanvasElement} canvas
 * @param {import('../core/scene/scene_format.js').SceneGeometry} scene
 * @returns {(x:number, y:number) => {px:number, py:number}}
 */
export function createProjection(canvas, scene) {
  const { minX, maxY } = scene.bounds;

  return function project(x, y) {
    const scale = computeScale(canvas, scene.bounds);
    const px = PADDING_PX + (x - minX) * scale;
    const py = PADDING_PX + (maxY - y) * scale; // world y(北)が上になるようcanvasのy(下向き)を反転
    return { px, py };
  };
}

export function drawMap(ctx, canvas, scene, project) {
  ctx.fillStyle = '#0e1b1f';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  ctx.beginPath();
  scene.coastline.forEach((p, i) => {
    const { px, py } = project(p.x, p.y);
    if (i === 0) ctx.moveTo(px, py);
    else ctx.lineTo(px, py);
  });
  ctx.closePath();
  ctx.fillStyle = '#233524';
  ctx.fill();
  ctx.strokeStyle = '#3c5a3d';
  ctx.lineWidth = 2;
  ctx.stroke();
}

/**
 * 防護対象（侵入側の到達目標）を、突破判定半径（ASSET_BREACH_RANGE_M）の円とあわせて描画する。
 * 半径は core/sim/mission.js の定数をそのまま使う（見た目とルールがズレないように）。
 * @param {CanvasRenderingContext2D} ctx
 * @param {HTMLCanvasElement} canvas
 * @param {import('../core/scene/scene_format.js').SceneGeometry} scene
 * @param {(x:number, y:number) => {px:number, py:number}} project
 * @param {{x:number, y:number}|null} asset
 */
export function drawProtectedAsset(ctx, canvas, scene, project, asset) {
  if (!asset) return;
  const { px, py } = project(asset.x, asset.y);
  const scale = computeScale(canvas, scene.bounds);
  const radiusPx = ASSET_BREACH_RANGE_M * scale;

  ctx.save();

  ctx.strokeStyle = 'rgba(255, 214, 120, 0.55)';
  ctx.setLineDash([6, 4]);
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.arc(px, py, radiusPx, 0, Math.PI * 2);
  ctx.stroke();
  ctx.setLineDash([]);

  ctx.fillStyle = '#ffd678';
  ctx.strokeStyle = '#4a3a10';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(px, py - 9);
  ctx.lineTo(px + 9, py);
  ctx.lineTo(px, py + 9);
  ctx.lineTo(px - 9, py);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();

  ctx.fillStyle = '#ffd678';
  ctx.font = '10px system-ui';
  ctx.fillText('防護対象', px + 12, py - 10);

  ctx.restore();
}
