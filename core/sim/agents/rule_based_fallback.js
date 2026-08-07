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
 *   1. 防護対象（protectedAsset）への到達を最優先の目標とする。ただし遠方にいる間は
 *      エピソード番号から決定論的に導いた角度だけ迂回してから接近する（NEW、下記参照）
 *   2. 敵陣営のレーダーコンタクトが近い（EVASION_RANGE_M以内）場合、目標方位に
 *      「その敵から離れる方位」を軽くブレンドして回避しつつ前進する
 *      （回避オンリーにはしない＝目標を見失うと永久に逃げ回るだけになるため）
 *   3. 防護対象が無い（テスト等）場合は直進を維持する
 *
 * 【防御側(defender)】
 *   1. 自分のレーダーが直接捉えたコンタクトへ向かう（最優先＝迎撃）。単純な純追跡
 *      （相手の現在位置を追いかけ続けるだけ）ではなく、簡易lead（見越し）予測を使う（NEW、下記参照）
 *   2. 直接は見えていないが、味方からの通信（contact_report）で位置を知らされていれば、
 *      その報告位置へ向かう（＝lunar_agentsで実証した「個体の観測が近傍通信で伝播し、
 *      チーム全体の行動に波及する」連鎖を、ここでも再現する）
 *   3. どちらも無ければ、防護対象を哨戒する。旧実装は「敵が見えなければ直進」
 *      だったため、何もない海域をひたすら直進し続けて画面外へ出るか、他艇と団子状態で
 *      回転し続けるだけだった。防護対象から離れていれば戻り、近ければ緩やかに周回する。
 *
 * 【lead pursuit（見越し追跡）を追加した理由】
 * AsvPlatform（core/sim/platforms/asv.js）は加速度こそthrottleに比例するが、最高速度
 * MAX_SPEED_MPS(=6)は陣営に関係なく共通で、加速が終わった後は防御側・侵入側とも同じ
 * 巡航速度になる。等速の純追跡（＝相手の"現在"位置へ向けて操舵し続けるだけ）は、
 * 古典的な追跡曲線問題として、双方が等速である限り幾何学的に距離をゼロへ詰め切れない
 * （実測: 常に約90〜95m止まりで頭打ち。INTERCEPT_RANGE_M=60に届かず、既定シナリオが
 * 毎回ほぼ同じタイミングでbreachする決定論的な展開になっていた）。
 * これを解決するため、防御側は相手コンタクトの絶対位置を複数tickぶんmemoryから拾って
 * 有限差分で速度を推定し、その速度で数秒先まで進んだ「見越し点」を狙うようにする。
 *
 * 【エピソードごとに侵入経路を変える理由】
 * 本シムは乱数を一切使わない決定論的な意思決定なので、同じシナリオを繰り返すと
 * 「侵入側の初速・防御側の初期配置」が毎回全く同じになり、結果として勝敗も毎回同じになる
 * （実測: 常にbreachedで、defendedが理論上も到達しにくい）。これ自体は「決定論的であれ」
 * という要件には反しないが、「反復対戦→戦術学習」という物語が画面上で成立しない。
 * 乱数の代わりに observation.episode（EnvApi._observationForAll()参照）を種にした
 * 決定論的な経路バリエーション（左寄り／直進／右寄り接近）を侵入側に持たせることで、
 * 「エピソードごとに違う」かつ「同じエピソード番号なら毎回同じ」を両立させる。
 *
 * 操舵計算の注意: レーダーの bearingRad はワールド座標系での絶対方位（RadarSensorのatan2結果）。
 * 操舵（steering）は「自艇の現在針路から見て何ラジアン曲げるか」の相対量なので、
 * 必ず自艇の heading を差し引いてから使う（絶対方位をそのまま使うと誤った方向へ曲がる）。
 */

/** 敵コンタクトをこの距離以内に検知したら、侵入側は回避方位を目標方位へブレンドする */
const EVASION_RANGE_M = 200;
/** 回避方位への重み（0=完全に目標方位のみ、1=完全に回避方位のみ）。前進を優先するため控えめにする */
const EVASION_WEIGHT = 0.25;
/** 防御側: 防護対象からこの距離より離れていれば戻る（哨戒基地への帰投） */
const GUARD_RETURN_RANGE_M = 150;

/** lead pursuit用の自艇速度の概算（AsvPlatformのMAX_SPEED_MPSに合わせる）。observationに自艇速度が無いための近似値 */
const OWN_SPEED_ESTIMATE_MPS = 6;
/** 見越し秒数の上限。rangeM/speedがこれを超える遠方コンタクトでは予測が発散するため頭打ちにする */
const MAX_LOOKAHEAD_S = 6;

/** 侵入側の経路バリエーション: このレンジより外側にいる間だけ迂回角を適用し、最終接近では防護対象へ直進する */
const APPROACH_VARIATION_SWITCH_RANGE_M = 450;
/** 迂回角の大きさ。episode番号から-1/0/+1が決定論的に選ばれ、この角度だけ目標方位を振る */
const APPROACH_VARIATION_STEP_RAD = (55 * Math.PI) / 180;

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
  return decideDefender({ observation, self, position, heading, nearestOpposing, memory });
}

/** 侵入側: 防護対象へ向かいつつ、遠方ではエピソード毎に迂回し、近い敵からは軽く逃げる */
function decideIntruder({ observation, position, heading, nearestOpposing }) {
  const asset = observation?.protectedAsset;

  let targetBearing = heading; // 目標が無ければ直進を維持（旧挙動と同じフォールバック）
  if (asset && position) {
    const dx = asset.x - position.x;
    const dy = asset.y - position.y;
    targetBearing = Math.atan2(dy, dx);

    const distanceToAsset = Math.hypot(dx, dy);
    if (distanceToAsset > APPROACH_VARIATION_SWITCH_RANGE_M) {
      // episode(1始まり)を3で割った余りから-1/0/+1を決定論的に選ぶ（乱数は使わない）。
      // 最終接近レンジに入ったら迂回をやめて防護対象へ直進する（いつまでも避け続けると到達できないため）。
      const episode = observation?.episode ?? 1;
      const variationStep = (episode % 3) - 1; // -1, 0, 1 の周期
      targetBearing += variationStep * APPROACH_VARIATION_STEP_RAD;
    }
  }

  if (position && nearestOpposing && nearestOpposing.rangeM < EVASION_RANGE_M) {
    // bearingRadは自艇から見た敵の絶対方位。+πで「敵から離れる方位」になる
    const awayBearing = nearestOpposing.bearingRad + Math.PI;
    targetBearing = blendBearings(targetBearing, awayBearing, EVASION_WEIGHT);
  }

  return { throttle: 0.85, steering: relativeBearingToSteering(targetBearing, heading) };
}

/** 防御側: 迎撃最優先（lead pursuit）、無ければ通報位置へ、それも無ければ防護対象を哨戒 */
function decideDefender({ observation, self, position, heading, nearestOpposing, memory }) {
  if (nearestOpposing) {
    const leadBearing = predictInterceptBearing(observation, position, nearestOpposing, memory);
    const aimBearing = leadBearing ?? nearestOpposing.bearingRad; // 速度推定できるまでは純追跡にフォールバック
    return { throttle: 1.0, steering: relativeBearingToSteering(aimBearing, heading) };
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

/** レーダーの相対値（bearingRad・rangeM）から、コンタクトのワールド絶対座標を復元する */
function contactWorldPosition(observerPosition, contact) {
  return {
    x: observerPosition.x + Math.cos(contact.bearingRad) * contact.rangeM,
    y: observerPosition.y + Math.sin(contact.bearingRad) * contact.rangeM,
  };
}

/**
 * 直近のmemory（過去のobservation履歴、AgentBase.remember()参照）から同一idのコンタクトを探し、
 * 絶対位置の有限差分で速度を推定して、見越し点への絶対方位を返す。
 * 過去サンプルが無い（今回初めて捕捉した等）場合はnullを返し、呼び出し側で純追跡にフォールバックさせる。
 * @returns {number|null}
 */
function predictInterceptBearing(observation, position, contact, memory) {
  const currentT = observation?.timestamp;
  if (currentT == null || !position || !Array.isArray(memory)) return null;

  const currentWorld = contactWorldPosition(position, contact);

  // memoryは古い順（rememberが末尾へpushする）。直近から遡って同じidのコンタクトを持つ記録を1つ探す。
  for (let i = memory.length - 1; i >= 0; i--) {
    const past = memory[i];
    const pastObs = past?.observation;
    const pastContact = pastObs?.radar?.contacts?.find((c) => c.id === contact.id);
    if (!pastContact || !pastObs?.position || pastObs?.timestamp == null) continue;

    const dt = currentT - pastObs.timestamp;
    if (dt <= 0) continue; // 同一tickや時刻の乱れは使えない

    const pastWorld = contactWorldPosition(pastObs.position, pastContact);
    const vx = (currentWorld.x - pastWorld.x) / dt;
    const vy = (currentWorld.y - pastWorld.y) / dt;

    // 見越し秒数はレンジ/自艇速度の概算。遠方コンタクトで予測が発散しないよう上限を設ける
    const lookahead = Math.min(contact.rangeM / OWN_SPEED_ESTIMATE_MPS, MAX_LOOKAHEAD_S);
    const predicted = { x: currentWorld.x + vx * lookahead, y: currentWorld.y + vy * lookahead };
    return Math.atan2(predicted.y - position.y, predicted.x - position.x);
  }

  return null;
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
