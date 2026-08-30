/**
 * boat_controller.js — 指示（order）→ {throttle, steering} の追従制御
 *
 * LLM ではない純関数的モジュール。毎物理ステップ実行され、シム上は瞬時扱い
 * （実機でも追従制御は 100Hz 級で回る層。時間モデルの遅延は LLM 層にだけかかる）。
 * 定数・lead pursuit の考え方は旧 rule_based_fallback.js を踏襲する。
 *
 * targetHistory（lead pursuit 用の直前目標位置）だけが状態。エピソードごとに reset() する。
 */

import { contactWorldPosition, blendBearings, relativeBearingToSteering } from '../steering.js';

const EVASION_RANGE_M = 200;
const EVASION_WEIGHT = 0.25;
const OWN_SPEED_ESTIMATE_MPS = 6;
const MAX_LOOKAHEAD_S = 6;
const ARRIVE_RADIUS_M = 30;
const PATROL_THROTTLE = 0.35;
const PATROL_STEERING = 0.2;
/** intercept で目標を見失ったとき、lastKnown をこの半径まで詰めたら捜索周回へ移る */
const SEARCH_RADIUS_M = 120;

export class BoatController {
  constructor() {
    /** @type {Map<string, {targetId:string, x:number, y:number, t:number}>} boatId -> 直前の目標観測 */
    this.targetHistory = new Map();
  }

  reset() {
    this.targetHistory.clear();
  }

  /**
   * @param {object|null} order - World.orders の1件（applyOrders が正規化済み）
   * @param {object} observation - EnvApi の1艇分観測
   * @param {string} selfId
   * @param {string} faction
   * @returns {{throttle:number, steering:number}}
   */
  decide(order, observation, selfId, faction) {
    const position = observation?.position;
    const heading = position?.heading ?? 0;
    if (!order || !position) return { throttle: 0.3, steering: 0 };

    if (order.action === 'intercept') return this._intercept(order, observation, selfId, position, heading);
    if (order.action === 'move_to') return this._moveTo(order, observation, faction, position, heading);
    if (order.action === 'patrol') return this._patrol(order.centerWorld, order.radiusM, position, heading);
    return { throttle: 0.3, steering: 0 };
  }

  _intercept(order, observation, selfId, position, heading) {
    const contact = observation.radar?.contacts?.find((c) => c.id === order.target);
    if (contact) {
      const world = contactWorldPosition(position, contact);
      const prev = this.targetHistory.get(selfId);
      let aim = contact.bearingRad;
      // lead pursuit: 等速の純追跡は幾何学的に間合いを詰め切れない（旧実装の実測どおり）。
      // 直前観測との有限差分で目標速度を推定し、見越し点を狙う。
      if (prev && prev.targetId === order.target && observation.timestamp > prev.t) {
        const dt = observation.timestamp - prev.t;
        const vx = (world.x - prev.x) / dt;
        const vy = (world.y - prev.y) / dt;
        const lookahead = Math.min(contact.rangeM / OWN_SPEED_ESTIMATE_MPS, MAX_LOOKAHEAD_S);
        aim = Math.atan2(world.y + vy * lookahead - position.y, world.x + vx * lookahead - position.x);
      }
      this.targetHistory.set(selfId, { targetId: order.target, x: world.x, y: world.y, t: observation.timestamp });
      return { throttle: 1.0, steering: relativeBearingToSteering(aim, heading) };
    }
    // 目標が自レーダーに映っていない: 発令時の last known へ向かい、着いたら捜索周回
    if (order.lastKnown) {
      const dx = order.lastKnown.x - position.x;
      const dy = order.lastKnown.y - position.y;
      if (Math.hypot(dx, dy) > SEARCH_RADIUS_M) {
        return { throttle: 0.9, steering: relativeBearingToSteering(Math.atan2(dy, dx), heading) };
      }
      return this._patrol(order.lastKnown, SEARCH_RADIUS_M, position, heading);
    }
    return { throttle: 0.5, steering: 0.15 }; // 手がかり無し: 緩い旋回で捜索
  }

  _moveTo(order, observation, faction, position, heading) {
    const wp = order.waypointWorld;
    const dx = wp.x - position.x;
    const dy = wp.y - position.y;
    if (Math.hypot(dx, dy) <= ARRIVE_RADIUS_M) {
      // ASV運動学に抗力が無く throttle 0 でも速度が残るため、到達後は小半径の待機周回にする
      return this._patrol(wp, 40, position, heading);
    }
    let bearing = Math.atan2(dy, dx);
    // 侵入艇の回避反射（艇レベルの反射であって戦術判断ではないので、指揮官の層ではなくここに置く）
    if (faction === 'intruder') {
      const nearest = observation.radar?.contacts
        ?.filter((c) => c.faction !== faction)
        ?.sort((a, b) => a.rangeM - b.rangeM)[0];
      if (nearest && nearest.rangeM < EVASION_RANGE_M) {
        bearing = blendBearings(bearing, nearest.bearingRad + Math.PI, EVASION_WEIGHT);
      }
    }
    return { throttle: 0.85, steering: relativeBearingToSteering(bearing, heading) };
  }

  _patrol(center, radiusM, position, heading) {
    const dx = center.x - position.x;
    const dy = center.y - position.y;
    if (Math.hypot(dx, dy) > radiusM) {
      return { throttle: 0.5, steering: relativeBearingToSteering(Math.atan2(dy, dx), heading) };
    }
    return { throttle: PATROL_THROTTLE, steering: PATROL_STEERING };
  }
}

/**
 * 全生存艇の action をまとめて計算する（headless / swarm-sim 共用のヘルパー）。
 * @param {import('../world.js').World} world
 * @param {Record<string, object>} observations - 直前 step の観測
 * @returns {Record<string, {throttle:number, steering:number}>}
 */
export function computeBoatActions(world, observations) {
  const actions = {};
  const state = world.state;
  for (let i = 0; i < state.count; i++) {
    if (!state.alive[i]) continue;
    const id = state.id[i];
    const obs = observations?.[id];
    if (!obs) continue;
    actions[id] = world.boatController.decide(world.orders.get(id), obs, id, state.faction[i]);
  }
  return actions;
}
