/**
 * traffic.js — spline 経路を一定速力で走る交通船（VLM航行の障害物）
 *
 * 【何のために置くか】単艦VLM航行の M1（空海面・直行）では、VLM に画像を見せても
 * 見せなくても結果が変わらない——避けるものが無いからである
 * （docs/l1-vlm-navigator-implementation-2026-09-05.md §6 の最大の穴）。
 * 避ける対象を海上に置いて初めて「VLM が waypoint を引き直して回避したか」を測れる。
 *
 * 【自艇と違って推論も追従制御もしない】交通船は経路上を弧長で進めるだけの運動学で動かす。
 * BoatController を通さないのは意図的で、
 *   1. 障害物の動きが実験のたびに揺れない（決定論。乱数も実時刻も使わない）
 *   2. 「自艇の回避」だけを観察対象にできる（相手も避けてくると効果が混ざる）
 * の2点による。実運用の交通船モデルとしては単純化しすぎだが、この計画で測りたいのは
 * 自艇の判断であって交通船の賢さではない。
 *
 * 【レーダーにもカメラにも映る】交通船は World に spawn した通常のエンティティなので、
 * radar.js が点として返し、3D は船として描く。つまり
 *   ・レーダー（テキスト）で位置が分かる
 *   ・カメラ（画像）で見える
 * の両方が成立する。どちらが効いたかは `?nav=vlm` と `?nav=blind` の比較で切り分ける。
 */

import { SplinePath } from './spline_path.js';

/** 交通船の既定速力。自艇の巡航（約6 m/s）より遅くし、追い越し・横切りが成立する速さ */
const DEFAULT_SPEED_MPS = 3.0;
/** 交通船の既定陣営。攻防の判定に混ざらないよう、defender/intruder のどちらでもない名前にする */
export const TRAFFIC_FACTION = 'traffic';

/**
 * シナリオの `traffic` 節を読んで経路を組む。
 *
 * シナリオ側の形（`core/scenarios/pilotage_m3.json` 参照）:
 *   "traffic": [
 *     { "id": "traffic-1", "shipClass": "runner", "speedMps": 3.0, "loop": true,
 *       "startS": 0, "pathLatLon": [{lat,lon}, ...] }
 *   ]
 *
 * @param {object} scenario
 * @param {{latLonToLocal:Function}} projection - scene.projection
 * @returns {Array<{id:string, shipClass:string, speedMps:number, startS:number, path:SplinePath}>}
 */
export function buildTrafficFromScenario(scenario, projection) {
  const specs = Array.isArray(scenario?.traffic) ? scenario.traffic : [];
  return specs.map((spec, i) => {
    if (!spec?.id) throw new Error(`traffic[${i}]: id は必須`);
    if (!Array.isArray(spec.pathLatLon) || spec.pathLatLon.length < 2) {
      throw new Error(`traffic[${i}] (${spec.id}): pathLatLon は2点以上が必要`);
    }
    const points = spec.pathLatLon.map((p) => {
      const local = projection.latLonToLocal(p.lat, p.lon);
      return { x: local.x, y: local.y };
    });
    return {
      id: spec.id,
      shipClass: spec.shipClass ?? 'runner',
      speedMps: Number.isFinite(spec.speedMps) ? spec.speedMps : DEFAULT_SPEED_MPS,
      startS: Number.isFinite(spec.startS) ? spec.startS : 0,
      path: new SplinePath(points, { loop: spec.loop === true }),
    };
  });
}

export class SplineTraffic {
  /** @param {ReturnType<typeof buildTrafficFromScenario>} specs */
  constructor(specs) {
    this.specs = specs ?? [];
    /** @type {Map<string, number>} id -> 経路上の弧長（m） */
    this.progress = new Map();
    this.reset();
  }

  get count() {
    return this.specs.length;
  }

  /** エピソード開始時。startS へ戻す（発行トークンと同じく、跨いだ状態を残さない） */
  reset() {
    this.progress.clear();
    for (const spec of this.specs) this.progress.set(spec.id, spec.startS);
  }

  /**
   * World へ交通船を spawn する。**自艇の spawn より後に呼ぶ**
   * （EntityState の index 順が「自艇が0番」という前提を崩さないため）。
   */
  spawn(world) {
    for (const spec of this.specs) {
      const p = spec.path.at(spec.startS);
      world.spawn({
        id: spec.id,
        faction: TRAFFIC_FACTION,
        shipClass: spec.shipClass,
        platform: 'asv',
        x: p.x,
        y: p.y,
        heading: p.headingRad,
      });
    }
  }

  /**
   * 交通船を dt 秒ぶん進める。EntityState を直接書く（運動学を解かない）。
   * 端に着いた非loop経路の船はその場に留まる（消さない——消すと
   * レーダーの探知履歴と3Dの表示が食い違う）。
   * @param {import('./world.js').World} world
   * @param {number} dt
   */
  step(world, dt) {
    for (const spec of this.specs) {
      const i = world.state.indexOf(spec.id);
      if (i < 0 || !world.state.alive[i]) continue;
      const s = (this.progress.get(spec.id) ?? 0) + spec.speedMps * dt;
      this.progress.set(spec.id, s);
      const p = spec.path.at(s);
      world.state.x[i] = p.x;
      world.state.y[i] = p.y;
      world.state.heading[i] = p.headingRad;
      world.state.speed[i] = p.clamped ? 0 : spec.speedMps;
    }
  }

  /**
   * 指定した艇から最も近い交通船までの距離（m）。M3 の主指標「最接近距離」の材料。
   * @returns {{id:string, rangeM:number}|null}
   */
  nearestTo(world, boatId) {
    const i = world.state.indexOf(boatId);
    if (i < 0) return null;
    const x = world.state.x[i];
    const y = world.state.y[i];
    let best = null;
    for (const spec of this.specs) {
      const j = world.state.indexOf(spec.id);
      if (j < 0 || !world.state.alive[j]) continue;
      const rangeM = Math.hypot(world.state.x[j] - x, world.state.y[j] - y);
      if (!best || rangeM < best.rangeM) best = { id: spec.id, rangeM };
    }
    return best;
  }

  /** 3D表示用に、各経路のポリラインを返す（真値の航路。VLM への入力ではない） */
  polylines(stepM = 12) {
    return this.specs.map((spec) => ({ id: spec.id, points: spec.path.polyline(stepM) }));
  }
}
