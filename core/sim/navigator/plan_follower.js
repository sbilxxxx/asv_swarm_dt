/**
 * plan_follower.js — 航路プラン（waypoint 列）の保持と、毎ステップの指示への変換
 *
 * VLM は判断サイクルごとにしか喋らないが、船は毎物理ステップ動く。その間を埋めるのがここで、
 * 「現在のプラン」→「今この瞬間の move_to 指示」を作る。**推論は一切しない純データ構造**である。
 *
 * 【責務の線引き】
 *   VLM        どこを通るか（waypoint 列。判断サイクルごと）
 *   RoutePlan  いまどの waypoint を目指しているか（毎ステップ）
 *   BoatController（既存・無変更）  その点へどう舵を切るか（毎ステップ）
 *   AsvPlatform（既存・無変更）     舵と推力で船がどう動くか（毎ステップ）
 *
 * この分割によって、VLM が黙っても・落ちても船は現行プランのまま走り続ける。
 * 初期プランを「目的地1点への直行」にしてあるのも同じ理由で、推論サーバが死んでいても
 * エピソードは scripted 統制群と同じ挙動へ退化して必ず終わる（計画 §4）。
 *
 * 【通過した waypoint を落とす責務はここにある】
 * BoatController は「与えられた1点へ向かう」だけで、点を進める判断はしない。
 * 落とすのは先頭から順で、**最後の1点（目的地）は残す**——残さないとプランが空になり、
 * 到達判定の基準が消える。
 *
 * 【既知の制限】通過判定は距離だけで、「行き過ぎたか」は見ない。大きく行き過ぎた waypoint は
 * 落ちず、船は一度引き返す。2026-08-30 の実測プロトタイプと同じ意味論をそのまま移してあり、
 * 実測（到達・経路長比 1.01）では表面化していない。進行方向への射影で落とす案は
 * 「1回に1つ」の原則にしたがい、挙動指標つきの別変更として扱うこと。
 */

import { DEFAULT_ARRIVAL_RADIUS_M } from './navigator_picture.js';

export class RoutePlan {
  /**
   * @param {{destination:{eastM:number,northM:number}, arrivalM?:number,
   *   waypoints?:Array<{eastM:number,northM:number}>}} config
   *   waypoints 省略時は目的地1点への直行（＝推論なしで成立する初期プラン）
   */
  constructor({ destination, arrivalM = DEFAULT_ARRIVAL_RADIUS_M, waypoints = null } = {}) {
    if (!destination || !Number.isFinite(destination.eastM) || !Number.isFinite(destination.northM)) {
      throw new TypeError('RoutePlan: destination {eastM, northM} is required');
    }
    if (!Number.isFinite(arrivalM) || arrivalM <= 0) {
      throw new TypeError(`RoutePlan: arrivalM must be a positive number, got ${arrivalM}`);
    }
    this.destination = { eastM: destination.eastM, northM: destination.northM };
    this.arrivalM = arrivalM;
    /** @type {Array<{eastM:number,northM:number}>} */
    this.waypoints = [];
    /** 差し替えた回数（記録用。シムのルールには一切影響しない） */
    this.revision = 0;
    this.setWaypoints(waypoints ?? [this.destination]);
    this.revision = 0; // 初期プランは「差し替え」ではないので数えない
  }

  /** 現在のプランの複製。呼び出し側が持ち回っても内部状態が変わらないようにする */
  snapshot() {
    return this.waypoints.map((w) => ({ eastM: w.eastM, northM: w.northM }));
  }

  /**
   * プランを差し替える。空・不正なら**現行プランを維持する**（黙って直行へ戻さない——
   * 戻すと「VLM が壊れた返答をした」ことが軌跡から消える）。
   * @returns {boolean} 差し替えたら true
   */
  setWaypoints(waypoints) {
    if (!Array.isArray(waypoints)) return false;
    const clean = waypoints
      .filter((w) => w && Number.isFinite(w.eastM) && Number.isFinite(w.northM))
      .map((w) => ({ eastM: w.eastM, northM: w.northM }));
    if (clean.length === 0) return false;
    this.waypoints = clean;
    this.revision += 1;
    return true;
  }

  /**
   * 到達済みの waypoint を先頭から落とす。最後の1点は残す。
   * @param {{eastM:number, northM:number}} pose
   * @returns {number} 落とした数
   */
  advance(pose) {
    let dropped = 0;
    while (
      this.waypoints.length > 1 &&
      Math.hypot(this.waypoints[0].eastM - pose.eastM, this.waypoints[0].northM - pose.northM) <= this.arrivalM
    ) {
      this.waypoints.shift();
      dropped += 1;
    }
    return dropped;
  }

  /** いま目指している点。プランが空になっていても目的地へ落ちる（船が止まらない） */
  currentTarget() {
    return this.waypoints[0] ?? this.destination;
  }

  /**
   * 現在の指示。指揮官の指示（command/orders.js）と同じ形なので、
   * World.orders へそのまま入れれば既存の BoatController が無変更で追従する。
   */
  currentOrder() {
    const wp = this.currentTarget();
    return { action: 'move_to', waypointWorld: { x: wp.eastM, y: wp.northM } };
  }

  /** 目的地に着いたか（waypoint の通過判定とは別。基準は常に目的地そのもの） */
  hasArrived(pose) {
    return Math.hypot(this.destination.eastM - pose.eastM, this.destination.northM - pose.northM) <= this.arrivalM;
  }
}

/**
 * プランを World の指示へ書き込む。**毎物理ステップ呼ぶ**。
 *
 * applyOrders() を通さないのは、あれが指揮官の「陣営ぶんの指示の束」を検証して配る関数で、
 * 単艦の航海士には陣営も名簿も無いためである（計画 §3「使わない: 指揮系統」）。
 * 書き込む形は applyOrders の出力と同一なので、下流（BoatController）から見た区別は無い。
 *
 * @param {import('../world.js').World} world
 * @param {string} boatId
 * @param {RoutePlan} plan
 * @returns {{order:object, dropped:number, arrived:boolean}}
 */
export function applyPlanOrder(world, boatId, plan) {
  const i = world.state.indexOf(boatId);
  if (i < 0) throw new Error(`applyPlanOrder: unknown boat "${boatId}"`);
  const pose = { eastM: world.state.x[i], northM: world.state.y[i] };
  const dropped = plan.advance(pose);
  const order = plan.currentOrder();
  world.orders.set(boatId, order);
  return { order, dropped, arrived: plan.hasArrived(pose) };
}
