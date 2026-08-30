/**
 * scripted_commanders.js — スクリプテッド指揮官（統制群・フォールバックの基準線）
 *
 * LLM 指揮官と同じ入力（統合図）・同じ出力（正規化済み orders + intent）を持つ。
 * 同型だからこそ実験の腕として差し替えられる。
 * 采配ロジックは旧 rule_based_fallback.js の陣営別行動を指揮官レベルへ持ち上げたもの:
 *   防御: 新しいトラックに最寄りの防御艇を1隻ずつ割り当て、残りはアセット哨戒
 *   侵入: 遠方ではエピソード番号による決定論的な迂回点、近傍ではアセット直行
 * 乱数も実時刻も使わない（core/sim/ の不変条件。変化の種は picture.episode だけ）。
 *
 * 【なぜ接近角が「エピソード番号 mod N」ではないのか】
 * この腕は LLM 腕の統制群であり、両者の勝率を並べて読む。統制群の接近角が周期 N で
 * 巡回すると、異なるエピソードは N 種類しか存在せず、勝率は episodes を増やしても
 * 動かない定数（実測: 旧実装の mod 3 では厳密に 2/3）になる。それは「分散の小さい
 * 統制群」ではなく実効標本サイズ N の 1 点観測で、温度 0.7 で本物のばらつきを持つ
 * LLM 腕と比較できる量ではない。しかも episodes が N で割り切れないときだけ端数が出る
 * ので、20 エピソードの 65.0% のような「測定に見える打ち切り誤差」を生む。
 * そこで接近角は黄金比の加法列（低食い違い列）で与える。episode の関数である点も、
 * 乱数も実時刻も使わない点も変わらない＝決定論は保ったまま、エピソードごとに異なる
 * 角度を取り、N を増やせば ±55° を一様に埋めていく。
 *
 * 出力の指示は parse_orders.js の正規化済み形と同一（camelCase の eastM/northM/radiusM）。
 * ここで snake_case を書くと applyOrders の座標変換が NaN になり、しかも黙って通る。
 */

/** これより古いトラックは追わない（消えた敵の最後の位置を全艇で追い回さないため） */
const FRESH_TRACK_MAX_AGE_S = 20;
/** 侵入側: アセットからこの距離より外では迂回点を経由する */
const APPROACH_SWITCH_RANGE_M = 450;
/** 侵入側: エピソードごとの接近角のふり幅（±55°） */
const APPROACH_VARIATION_STEP_RAD = (55 * Math.PI) / 180;
/**
 * 黄金比の小数部 1/φ。加法列 frac(episode/φ) は無理数回転なので巡回せず、
 * どの N で切っても区間をほぼ一様に埋める（1次元の低食い違い列としては最良）。
 * 乱数ではない: episode だけの純関数であり、同じ episode は常に同じ角を返す。
 */
const GOLDEN_RATIO_CONJUGATE = 0.618033988749895;

/**
 * エピソード番号 → 接近角のふれ（-1 以上 +1 未満）。
 * @param {number} episode 1 始まりのエピソード番号
 */
export function approachVariation(episode) {
  const e = Number.isFinite(episode) ? Math.trunc(episode) : 1;
  const frac = ((e * GOLDEN_RATIO_CONJUGATE) % 1 + 1) % 1; // 負の episode でも [0,1) に入れる
  return frac * 2 - 1;
}
/** 防御側: 手空きの艇がアセットを守る哨戒半径 */
const GUARD_PATROL_RADIUS_M = 200;

/** @param {ReturnType<import('./fused_picture.js').buildFusedPicture>} picture */
export function scriptedDefenderCommander(picture) {
  const fresh = picture.tracks
    .filter((tr) => tr.ageS <= FRESH_TRACK_MAX_AGE_S)
    .sort((a, b) => Math.hypot(a.eastM, a.northM) - Math.hypot(b.eastM, b.northM)); // アセットに近い脅威から
  const free = new Map(picture.ownForce.map((b) => [b.id, b]));
  const orders = [];
  let interceptCount = 0;
  for (const tr of fresh) {
    let bestId = null;
    let bestD = Infinity;
    for (const [id, b] of free) {
      const d = Math.hypot(b.eastM - tr.eastM, b.northM - tr.northM);
      if (d < bestD) {
        bestD = d;
        bestId = id;
      }
    }
    if (bestId === null) break; // 防御艇が足りない
    free.delete(bestId);
    orders.push({ boat: bestId, action: 'intercept', target: tr.id });
    interceptCount++; // 1トラックに1隻。群がらせない
  }
  for (const id of free.keys()) {
    orders.push({ boat: id, action: 'patrol', center: 'asset', radiusM: GUARD_PATROL_RADIUS_M });
  }
  return { orders, intent: `intercept ${interceptCount} track(s), ${free.size} guarding asset` };
}

/** @param {ReturnType<import('./fused_picture.js').buildFusedPicture>} picture */
export function scriptedIntruderCommander(picture) {
  // 変化の唯一の種。エピソード番号（EpisodeLogger の採番）で接近角が決まる（巡回しない）。
  const episode = picture.episode ?? 1;
  const variation = approachVariation(episode);
  const variationRad = variation * APPROACH_VARIATION_STEP_RAD;
  const orders = [];
  for (const b of picture.ownForce) {
    const d = Math.hypot(b.eastM, b.northM);
    if (d > APPROACH_SWITCH_RANGE_M) {
      // 艇→アセット方向をエピソード依存の角度だけ回した先に迂回点を置く（旧・侵入側迂回の指揮官版）
      const angle = Math.atan2(-b.northM, -b.eastM) + variationRad;
      const legM = Math.max(d - 350, 100);
      orders.push({
        boat: b.id,
        action: 'move_to',
        waypoint: { eastM: b.eastM + Math.cos(angle) * legM, northM: b.northM + Math.sin(angle) * legM },
      });
    } else {
      orders.push({ boat: b.id, action: 'move_to', waypoint: { eastM: 0, northM: 0 } });
    }
  }
  return { orders, intent: `advance on asset (approach offset ${((variationRad * 180) / Math.PI).toFixed(1)} deg)` };
}
