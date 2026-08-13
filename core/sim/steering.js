/**
 * steering.js — 操舵の共通数学
 *
 * rule_based_fallback.js（旧・艇単位ルールエージェント）と
 * command/boat_controller.js（v2・指示追従制御）の両方が使う。
 */

/** レーダーの相対値（bearingRad・rangeM）から、コンタクトのワールド絶対座標を復元する */
export function contactWorldPosition(observerPosition, contact) {
  return {
    x: observerPosition.x + Math.cos(contact.bearingRad) * contact.rangeM,
    y: observerPosition.y + Math.sin(contact.bearingRad) * contact.rangeM,
  };
}

/**
 * 2つの絶対方位を単位ベクトルの加重平均で合成する（角度の単純平均だと±πをまたぐ際に破綻するため）。
 * @param {number} bearingA
 * @param {number} bearingB
 * @param {number} weightB - 0〜1。bearingBの重み（bearingAの重みは1-weightB）
 */
export function blendBearings(bearingA, bearingB, weightB) {
  const weightA = 1 - weightB;
  const x = Math.cos(bearingA) * weightA + Math.cos(bearingB) * weightB;
  const y = Math.sin(bearingA) * weightA + Math.sin(bearingB) * weightB;
  if (x === 0 && y === 0) return bearingA; // 完全に打ち消し合う稀なケース
  return Math.atan2(y, x);
}

/**
 * @param {number} absoluteBearingRad - ワールド座標系での絶対方位
 * @param {number} selfHeadingRad - 自艇の現在針路
 * @returns {number} -1〜1 の操舵量
 */
export function relativeBearingToSteering(absoluteBearingRad, selfHeadingRad) {
  const relative = Math.atan2(
    Math.sin(absoluteBearingRad - selfHeadingRad),
    Math.cos(absoluteBearingRad - selfHeadingRad)
  );
  return Math.max(-1, Math.min(1, relative / Math.PI));
}
