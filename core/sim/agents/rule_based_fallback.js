/**
 * rule_based_fallback.js — APIキー・ローカルLLM不要のデフォルト意思決定
 *
 * LlmAgent の decideFn を差し替えなかった場合に使われる。GitHub Pages上でもセットアップなしに動く。
 *
 * 優先順位:
 *   1. 自分のレーダーが直接捉えたコンタクトへ向かう
 *   2. 直接は見えていないが、味方からの通信（contact_report）で位置を知らされていれば、
 *      その報告位置へ向かう（＝lunar_agentsで実証した「個体の観測が近傍通信で伝播し、
 *      チーム全体の行動に波及する」連鎖を、ここでも再現する）
 *   3. どちらも無ければ直進
 *
 * 操舵計算の注意: レーダーの bearingRad はワールド座標系での絶対方位（RadarSensorのatan2結果）。
 * 操舵（steering）は「自艇の現在針路から見て何ラジアン曲げるか」の相対量なので、
 * 必ず自艇の heading を差し引いてから使う（絶対方位をそのまま使うと誤った方向へ曲がる）。
 */

export async function simpleRuleBasedDecision(observation, self, memory) {
  const heading = observation?.position?.heading ?? 0;
  const radar = observation?.radar;

  const nearestContact = radar?.contacts
    ?.filter((c) => c.faction !== self.faction)
    ?.sort((a, b) => a.rangeM - b.rangeM)[0];

  if (nearestContact) {
    return { throttle: 0.6, steering: relativeBearingToSteering(nearestContact.bearingRad, heading) };
  }

  const reported = (observation?.messages ?? [])
    .filter((m) => m.type === 'contact_report' && m.value?.contactFaction !== self.faction)
    .sort((a, b) => b.confidence - a.confidence)[0];

  if (reported && observation?.position) {
    const dx = reported.location.x - observation.position.x;
    const dy = reported.location.y - observation.position.y;
    const absoluteBearing = Math.atan2(dy, dx);
    return { throttle: 0.55, steering: relativeBearingToSteering(absoluteBearing, heading) };
  }

  return { throttle: 0.4, steering: 0 };
}

/**
 * @param {number} absoluteBearingRad - ワールド座標系での絶対方位
 * @param {number} selfHeadingRad - 自艇の現在針路
 * @returns {number} -1〜1 の操舵量
 */
function relativeBearingToSteering(absoluteBearingRad, selfHeadingRad) {
  const relative = Math.atan2(
    Math.sin(absoluteBearingRad - selfHeadingRad),
    Math.cos(absoluteBearingRad - selfHeadingRad)
  );
  return Math.max(-1, Math.min(1, relative / Math.PI));
}
