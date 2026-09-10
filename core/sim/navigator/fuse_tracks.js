/**
 * fuse_tracks.js — レーダー接触を「トラック」へ（匿名化 ＋ 速度の推定）
 *
 * 位置づけ: docs/perception-to-waypoint-flow.md §3 の③「対応づけ」。
 * 現時点で扱うのはレーダーだけで、画像側の検知（②）は後から `sources` に足せる形にしてある。
 *
 * 【なぜ必要になったか — 2026-09-06 の実測】
 * `avoidance.js` は相手を**静止として扱っていた**（レーダーは点しか返さないため）。
 * 生成した通過点は「相手が今いる場所」の横に置かれ、着いた頃には相手が移動していて
 * 離隔が足りない——`planClearance` の事後検査が 6エピソードで **21回**
 * 「生成プランが offset より近い」と鳴った。相手が動くなら**動きを見積もらないと避けられない**。
 *
 * 【推定の方法】同じトラックの連続する観測の有限差分。
 * `command/boat_controller.js` の lead pursuit が既に同じことをしている
 * （「等速の純追跡は幾何学的に間合いを詰め切れない」ため直前観測との差分で見越し点を狙う）。
 * その考え方を航海士側へ持ち込んだだけで、新しい発明はしていない。
 *
 * 【匿名化もここが持つ】トラック id の発番元を1箇所にする。
 * シナリオのエンティティ id（例 `traffic-cross`）はそのままでは答えを漏らす
 * （名前を読むだけで「横切る船」だと分かる）。
 */

/** 速度推定に使う観測間隔の下限（秒）。これより短い差分はノイズが増幅される */
const MIN_DT_S = 0.5;
/** 上限（秒）。古すぎる観測との差分は等速の仮定が崩れる */
const MAX_DT_S = 30;
/** 推定速力の上限（m/s）。艦種の最大速力を超える値はノイズとして捨てる */
const MAX_SPEED_MPS = 20;

export class TrackStore {
  /** @param {{prefix?:string}} [options] */
  constructor({ prefix = 'TRK' } = {}) {
    this.prefix = prefix;
    /**
     * @type {Map<string, {id:string, lastT:number, lastE:number, lastN:number,
     *   courseRad:number|null, speedMps:number|null, seen:number}>} 真の id -> トラック
     */
    this.tracks = new Map();
  }

  /** エピソード開始時。跨いだ対応・速度推定を残さない */
  reset() {
    this.tracks.clear();
  }

  /** 表示名 → 真の id（実験ログで真値と照合するため） */
  trueIdOf(label) {
    for (const [trueId, t] of this.tracks) if (t.id === label) return trueId;
    return null;
  }

  /**
   * この瞬間の接触を取り込み、トラックへ更新する。
   *
   * @param {Array<{id:string, eastM:number, northM:number}>} contacts - 真の id を持つ生の接触
   * @param {number} t - 観測時刻（シム秒）
   * @returns {Array<{id:string, trueId:string, courseDeg:number|null, speedMps:number|null,
   *   seen:number, sources:string[]}>} 入力と同じ順序
   */
  observe(contacts, t) {
    const out = [];
    for (const c of contacts ?? []) {
      let track = this.tracks.get(c.id);
      if (!track) {
        // 初出。名前は**初出順**に振る（距離順だと接近・離脱で名前が入れ替わり、
        // サイクルを跨いだ参照「さっき言った TRK-01」が壊れる）
        track = {
          id: `${this.prefix}-${String(this.tracks.size + 1).padStart(2, '0')}`,
          lastT: t,
          lastE: c.eastM,
          lastN: c.northM,
          courseRad: null,
          speedMps: null,
          seen: 1,
        };
        this.tracks.set(c.id, track);
      } else {
        const dt = t - track.lastT;
        if (dt >= MIN_DT_S && dt <= MAX_DT_S) {
          const vx = (c.eastM - track.lastE) / dt;
          const vy = (c.northM - track.lastN) / dt;
          const speed = Math.hypot(vx, vy);
          if (speed <= MAX_SPEED_MPS) {
            track.courseRad = Math.atan2(vy, vx);
            track.speedMps = speed;
          }
          track.lastT = t;
          track.lastE = c.eastM;
          track.lastN = c.northM;
          track.seen += 1;
        } else if (dt > MAX_DT_S) {
          // 久しぶりの再探知。差分は使えないので推定を捨て、位置だけ更新する
          track.courseRad = null;
          track.speedMps = null;
          track.lastT = t;
          track.lastE = c.eastM;
          track.lastN = c.northM;
          track.seen += 1;
        }
      }
      out.push({
        id: track.id,
        trueId: c.id,
        courseDeg: track.courseRad === null ? null : (track.courseRad * 180) / Math.PI,
        speedMps: track.speedMps,
        seen: track.seen,
        // 画像側の検知（同 §3 の②）を足すときはここへ 'camera' が入る
        sources: ['radar'],
      });
    }
    return out;
  }
}
