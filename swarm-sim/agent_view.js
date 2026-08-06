/**
 * agent_view.js — ASV（防御・侵入）のアイコン・航跡を描画
 *
 * 座標変換は map_view.js の project() を再利用し、重複させない。
 */

const trails = new Map(); // id -> array of {px, py}
const MAX_TRAIL_POINTS = 60;

/**
 * @param {CanvasRenderingContext2D} ctx
 * @param {Array<{id:string, faction:string, x:number, y:number, heading:number}>} entities
 * @param {(x:number, y:number) => {px:number, py:number}} project
 */
export function drawAgents(ctx, entities, project) {
  for (const e of entities) {
    const { px, py } = project(e.x, e.y);

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
    ctx.fillStyle = e.faction === 'defender' ? '#4fb8d6' : '#e0708e';
    ctx.beginPath();
    ctx.moveTo(7, 0);
    ctx.lineTo(-4, 4);
    ctx.lineTo(-4, -4);
    ctx.closePath();
    ctx.fill();
    ctx.restore();

    ctx.fillStyle = '#8fa8a4';
    ctx.font = '10px system-ui';
    ctx.fillText(e.id, px + 9, py - 9);
  }
}
