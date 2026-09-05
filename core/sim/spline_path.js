/**
 * spline_path.js — 制御点列を通る滑らかな経路（Catmull-Rom）と、その弧長パラメータ化
 *
 * 用途は交通船（traffic.js）の航路。折れ線で与えると角で船が瞬間的に向きを変えて
 * 「船らしくない」動きになるので、制御点を通る曲線に通す。
 *
 * 【なぜ弧長でパラメータ化するか】Catmull-Rom の素のパラメータ t は区間ごとに進み方が違う。
 * t を一定速度で進めると、制御点の間隔が広い区間では速く・狭い区間では遅く動く。
 * 交通船は「一定速力で走る障害物」であってほしいので、
 * 事前にサンプリングして弧長 s（メートル）→ 位置の表を作り、s を速力×dt で進める。
 *
 * 【決定論】ここには乱数も実時刻も無い。同じ制御点・同じ dt 列からは必ず同じ軌跡が出る
 * （docs/time-model.md の決定論の要件。交通船の動きが実験のたびに変わってはならない）。
 */

/** 1区間あたりのサンプル数。弧長テーブルの解像度で、増やすほど等速性が正確になる */
const SAMPLES_PER_SEGMENT = 24;

/** Catmull-Rom（uniform, tension 1/2）の1成分 */
function catmullRom(p0, p1, p2, p3, t) {
  const t2 = t * t;
  const t3 = t2 * t;
  return (
    0.5 *
    (2 * p1 + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 + (-p0 + 3 * p1 - 3 * p2 + p3) * t3)
  );
}

export class SplinePath {
  /**
   * @param {Array<{x:number, y:number}>} controlPoints - 2点以上。x=東 / y=北（メートル）
   * @param {{loop?:boolean}} [options] loop:true なら終点から始点へ滑らかに戻る閉曲線
   */
  constructor(controlPoints, { loop = false } = {}) {
    if (!Array.isArray(controlPoints) || controlPoints.length < 2) {
      throw new TypeError(`SplinePath: controlPoints は2点以上が必要（got ${controlPoints?.length}）`);
    }
    for (const p of controlPoints) {
      if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.y)) {
        throw new TypeError(`SplinePath: 制御点は {x, y} の有限数（got ${JSON.stringify(p)}）`);
      }
    }
    this.loop = loop;
    this.controlPoints = controlPoints.map((p) => ({ x: p.x, y: p.y }));

    // 弧長テーブル。samples[i] = {x, y, s}（s は始点からの累積距離）
    this.samples = [];
    const n = this.controlPoints.length;
    const segments = loop ? n : n - 1;
    let s = 0;
    let prev = null;
    for (let seg = 0; seg < segments; seg++) {
      for (let k = 0; k < SAMPLES_PER_SEGMENT; k++) {
        const t = k / SAMPLES_PER_SEGMENT;
        const p = this._evalSegment(seg, t);
        if (prev) s += Math.hypot(p.x - prev.x, p.y - prev.y);
        this.samples.push({ x: p.x, y: p.y, s });
        prev = p;
      }
    }
    // 終端を1点足して閉じる（loop なら始点へ、非loop なら最後の制御点へ）
    const end = loop ? this._evalSegment(0, 0) : this._evalSegment(segments - 1, 1);
    if (prev) s += Math.hypot(end.x - prev.x, end.y - prev.y);
    this.samples.push({ x: end.x, y: end.y, s });
    /** 全長（メートル） */
    this.length = s;
  }

  /** 制御点を端で複製して、区間 seg の局所パラメータ t（0..1）を評価する */
  _evalSegment(seg, t) {
    const pts = this.controlPoints;
    const n = pts.length;
    const idx = (i) => {
      if (this.loop) return pts[((i % n) + n) % n];
      return pts[Math.min(Math.max(i, 0), n - 1)];
    };
    const p0 = idx(seg - 1);
    const p1 = idx(seg);
    const p2 = idx(seg + 1);
    const p3 = idx(seg + 2);
    return {
      x: catmullRom(p0.x, p1.x, p2.x, p3.x, t),
      y: catmullRom(p0.y, p1.y, p2.y, p3.y, t),
    };
  }

  /**
   * 弧長 s（メートル）の位置。loop なら s を全長で折り返し、そうでなければ端で止める。
   * @returns {{x:number, y:number, headingRad:number, clamped:boolean}}
   *   headingRad は数学系（0=東・反時計回り）。EntityState.heading と同じ規約
   */
  at(s) {
    let d = s;
    let clamped = false;
    if (this.loop) {
      d = ((d % this.length) + this.length) % this.length;
    } else if (d <= 0) {
      d = 0;
      clamped = true;
    } else if (d >= this.length) {
      d = this.length;
      clamped = true;
    }

    // 弧長テーブルの二分探索
    const arr = this.samples;
    let lo = 0;
    let hi = arr.length - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (arr[mid].s <= d) lo = mid;
      else hi = mid;
    }
    const a = arr[lo];
    const b = arr[hi];
    const span = b.s - a.s;
    const f = span > 1e-9 ? (d - a.s) / span : 0;
    const x = a.x + (b.x - a.x) * f;
    const y = a.y + (b.y - a.y) * f;
    // 進行方向は前後のサンプル差から。端では隣接サンプルを使う
    const ahead = arr[Math.min(hi + 1, arr.length - 1)];
    const behind = arr[Math.max(lo - 1, 0)];
    const headingRad = Math.atan2(ahead.y - behind.y, ahead.x - behind.x);
    return { x, y, headingRad, clamped };
  }

  /** 描画用のポリライン。3Dの航路表示などで使う */
  polyline(stepM = 10) {
    const out = [];
    for (let d = 0; d < this.length; d += stepM) {
      const p = this.at(d);
      out.push({ x: p.x, y: p.y });
    }
    const end = this.at(this.length);
    out.push({ x: end.x, y: end.y });
    return out;
  }
}
