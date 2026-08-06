/**
 * map_view.js — SceneGeometry（②） → Canvas描画（海岸線）＋ 座標変換
 *
 * digital-twinのscene_builder.jsと役割は対になるが、こちらはThree.jsではなくCanvas 2D。
 * ワールド座標（メートル）→ 画面ピクセルの変換をここで一元管理し、agent_view.jsと共有する
 * （座標変換を2箇所に重複させない）。
 */

const PADDING_PX = 40;

/**
 * @param {HTMLCanvasElement} canvas
 * @param {import('../core/scene/scene_format.js').SceneGeometry} scene
 * @returns {(x:number, y:number) => {px:number, py:number}}
 */
export function createProjection(canvas, scene) {
  const { minX, maxX, minY, maxY } = scene.bounds;
  const w = Math.max(maxX - minX, 1);
  const h = Math.max(maxY - minY, 1);

  return function project(x, y) {
    const cw = Math.max(canvas.width - PADDING_PX * 2, 1);
    const ch = Math.max(canvas.height - PADDING_PX * 2, 1);
    const scale = Math.min(cw / w, ch / h);
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
