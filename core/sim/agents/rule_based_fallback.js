/**
 * rule_based_fallback.js — APIキー・ローカルLLM不要のデフォルト意思決定
 *
 * LlmAgent の decideFn を差し替えなかった場合に使われる。GitHub Pages上でもセットアップなしに動く。
 *
 * docs/review-findings-2026-08-07.md 優先度4（攻防のゲーム化）に対応し、
 * 陣営（self.faction）ごとに別の優先順位で行動する。以前は両陣営とも同じ
 * 「見えている敵を追う→直進」のロジックで、目標も勝敗も無いまま互いに
 * 追いかけ合うだけだった（＝「対称な相互追跡」）。今回、防護対象
 * （observation.protectedAsset、core/env/env_api.js参照）を目標／哨戒基地として
 * 使うことで、侵入・防御という非対称な役割を行動レベルで作る。
 *
 * 【侵入側(intruder)】
 *   1. 防護対象（protectedAsset）への到達を最優先の目標とする
 *   2. 敵陣営のレーダーコンタクトが近い（EVASION_RANGE_M以内）場合、目標方位に
 *      「その敵から離れる方位」を軽くブレンドして回避しつつ前進する
 *      （回避オンリーにはしない＝目標を見失うと永久に逃げ回るだけになるため）
 *   3. 防護対象が無い（テスト等）場合は直進を維持する
 *
 * 【防御側(defender)】
 *   1. 自分のレーダーが直接捉えたコンタクトへ向かう（最優先＝迎撃）
 *   2. 直接は見えていないが、味方からの通信（contact_report）で位置を知らされていれば、
 *      その報告位置へ向かう（＝lunar_agentsで実証した「個体の観測が近傍通信で伝播し、
 *      チーム全体の行動に波及する」連鎖を、ここでも再現する）
 *   3. どちらも無ければ、防護対象を哨戒する（NEW）。旧実装は「敵が見えなければ直進」
 *      だったため、何もない海域をひたすら直進し続けて画面外へ出るか、他艇と団子状態で
 *      回転し続けるだけだった。防護対象から離れていれば戻り、近ければ緩やかに周回する。
 *
 * 操舵計算の注意: レーダーの bearingRad はワールド座標系での絶対方位（RadarSensorのatan2結果）。
 * 操舵（steering）は「自艇の現在針路から見て何ラジアン曲げるか」の相対量なので、
 * 必ず自艇の heading を差し引いてから使う（絶対方位をそのまま使うと誤った方向へ曲がる）。
 */

/** 敵コンタクトをこの距離以内に検知したら、侵入側は回避方位を目標方位へブレンドする */
const EVASION_RANGE_M = 200;
/** 回避方位への重み（0=完全に目標方位のみ、1=完全に回避方位のみ）。前進を優先するため控えめにする */
const EVASION_WEIGHT = 0.55;
/** 防御側: 防護対象からこの距離より離れていれば戻る（哨戒基地への帰投） */
const GUARD_RETURN_RANGE_M = 150;

export async function simpleRuleBasedDecision(observation, self, memory) {
  const heading = observation?.position?.heading ?? 0;
  const position = observation?.position;
  const radar = observation?.radar;

  const nearestOpposing = radar?.contacts
    ?.filter((c) => c.faction !== self.faction)
    ?.sort((a, b) => a.rangeM - b.rangeM)[0];

  if (self.faction === 'intruder') {
    return decideIntruder({ observation, position, heading, nearestOpposing });
  }
  return decideDefender({ observation, self, position, heading, nearestOpposing });
}

/** 侵入側: 防護対象へ向かいつつ、近い敵から軽く逃げる */
function decideIntruder({ observation, position, heading, nearestOpposing }) {
  const asset = observation?.protectedAsset;

  let targetBearing = heading; // 目標が無ければ直進を維持（旧挙動と同じフォールバック）
  if (asset && position) {
    targetBearing = Math.atan2(asset.y - position.y, asset.x - position.x);
  }

  if (position && nearestOpposing && nearestOpposing.rangeM < EVASION_RANGE_M) {
    // bearingRadは自艇から見た敵の絶対方位。+πで「敵から離れる方位」になる
    const awayBearing = nearestOpposing.bearingRad + Math.PI;
    targetBearing = blendBearings(targetBearing, awayBearing, EVASION_WEIGHT);
  }

  return { throttle: 0.85, steering: relativeBearingToSteering(targetBearing, heading) };
}

/** 防御側: 迎撃最優先、無ければ通報位置へ、それも無ければ防護対象を哨戒 */
function decideDefender({ observation, self, position, heading, nearestOpposing }) {
  if (nearestOpposing) {
    // 追跡はintruderの巡航throttle(0.85、上のEVASION参照)以上で追わないと、純粋追跡（自機の現在位置を
    // 目がけ続けるだけの操舵）では速度が追いつかない限り理論上ずっと詰め切れない
    // （等速以下の追跡は漸近的に一定の車間距離へ収束するだけで絶対に追いつかない）。
    // 実測: 0.6のままだと3隻とも同じ隊列を保ったまま240秒以内に必ずbreachし、
    // 毎エピソード同一の結果になっていた（core最短距離ログで検証: 常に約95m止まり）。
    return { throttle: 1.0, steering: relativeBearingToSteering(nearestOpposing.bearingRad, heading) };
  }

  const reported = (observation?.messages ?? [])
    .filter((m) => m.type === 'contact_report' && m.value?.contactFaction !== self.faction)
    .sort((a, b) => b.confidence - a.confidence)[0];

  if (reported && position) {
    const dx = reported.location.x - position.x;
    const dy = reported.location.y - position.y;
    const absoluteBearing = Math.atan2(dy, dx);
    // 通報位置は他艇からの伝聞（位置がずれている可能性がある）なので、直接視認より少し抑える
    return { throttle: 0.8, steering: relativeBearingToSteering(absoluteBearing, heading) };
  }

  const asset = observation?.protectedAsset;
  if (asset && position) {
    const dx = asset.x - position.x;
    const dy = asset.y - position.y;
    const distanceToAsset = Math.hypot(dx, dy);
    if (distanceToAsset > GUARD_RETURN_RANGE_M) {
      // 哨戒基地（防護対象）へ帰投する
      return { throttle: 0.5, steering: relativeBearingToSteering(Math.atan2(dy, dx), heading) };
    }
    // 近傍にいるときは一定の舵を切り続けて緩やかに周回する（見張り）
    return { throttle: 0.35, steering: 0.2 };
  }

  // 防護対象すら無い（テスト等）場合のみ、旧挙動どおり直進する
  return { throttle: 0.4, steering: 0 };
}

/**
 * 2つの絶対方位を単位ベクトルの加重平均で合成する（角度の単純平均だと±πをまたぐ際に破綻するため）。
 * @param {number} bearingA
 * @param {number} bearingB
 * @param {number} weightB - 0〜1。bearingBの重み（bearingAの重みは1-weightB）
 */
function blendBearings(bearingA, bearingB, weightB) {
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
function relativeBearingToSteering(absoluteBearingRad, selfHeadingRad) {
  const relative = Math.atan2(
    Math.sin(absoluteBearingRad - selfHeadingRad),
    Math.cos(absoluteBearingRad - selfHeadingRad)
  );
  return Math.max(-1, Math.min(1, relative / Math.PI));
}
