/**
 * comms_view.js — エージェント間の通信（会話）を地図上に可視化する
 *
 * lunar_agentsで実証した構造化メッセージング（message_type/location/value/confidence/
 * requested_action）が実際に近傍エージェント間を飛び交っている様子を、
 * 発信元→宛先を結ぶ短命のパルス線として描画する。ログパネル（log_panel.js）と対になる。
 */

const PULSE_LIFETIME_S = 1.2;

export class CommsPulses {
  constructor() {
    this.pulses = [];
  }

  /** @param {Array<{from:string, to:string, type:string, confidence:number}>} events */
  addEvents(events) {
    for (const e of events) {
      this.pulses.push({ ...e, age: 0 });
    }
  }

  update(dt) {
    for (const p of this.pulses) p.age += dt;
    this.pulses = this.pulses.filter((p) => p.age < PULSE_LIFETIME_S);
  }

  /**
   * @param {CanvasRenderingContext2D} ctx
   * @param {Map<string, {x:number,y:number}>} entityById
   * @param {(x:number, y:number) => {px:number, py:number}} project
   */
  draw(ctx, entityById, project) {
    for (const p of this.pulses) {
      const from = entityById.get(p.from);
      const to = entityById.get(p.to);
      if (!from || !to) continue;
      const a = project(from.x, from.y);
      const b = project(to.x, to.y);
      const t = p.age / PULSE_LIFETIME_S;
      const alpha = 0.7 * (1 - t);

      ctx.strokeStyle = `rgba(255, 214, 120, ${alpha})`;
      ctx.lineWidth = 1.2;
      ctx.setLineDash([4, 4]);
      ctx.beginPath();
      ctx.moveTo(a.px, a.py);
      ctx.lineTo(b.px, b.py);
      ctx.stroke();
      ctx.setLineDash([]);

      // 進行中のパルス（発信元→宛先へ移動する小さな点）
      const px = a.px + (b.px - a.px) * Math.min(t * 2.2, 1);
      const py = a.py + (b.py - a.py) * Math.min(t * 2.2, 1);
      ctx.fillStyle = `rgba(255, 214, 120, ${alpha})`;
      ctx.beginPath();
      ctx.arc(px, py, 2.2, 0, Math.PI * 2);
      ctx.fill();
    }
  }
}
