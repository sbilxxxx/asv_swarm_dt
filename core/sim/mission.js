/**
 * mission.js — 攻防シナリオの勝敗判定と報酬
 *
 * このファイルが「単なる相互追跡」を「攻防」にする。
 *
 * ルール:
 *   - 侵入側(intruder)は防護対象(protectedAsset)への到達を目指す
 *   - 防御側(defender)は侵入側を捕捉圏内に捉えれば無力化できる
 *   - どちらかが達成するか、制限時間を超えるとエピソード終了
 *
 * 報酬は防御側視点のスカラー（強化学習・自己対戦での利用を想定）。
 * 学習パイプライン本体は対象外だが、報酬と終了条件をここに置くことで、
 * FR8のログが「学習データとして意味のある単位」になる。
 */

/** 防御側が侵入側を無力化できる距離 */
export const INTERCEPT_RANGE_M = 60;
/** 侵入側が防護対象に到達したとみなす距離 */
export const ASSET_BREACH_RANGE_M = 80;
/** エピソードの制限時間（シミュレーション秒） */
export const EPISODE_TIME_LIMIT_S = 240;

/**
 * 1ステップ分の判定を行い、状態を更新する（撃破された侵入艇の alive を落とす）。
 *
 * @param {import('./world.js').World} world
 * @returns {{done: boolean, reward: number, outcome: string|null, events: Array<object>}}
 *   outcome: 'defended' | 'breached' | 'timeout' | null（継続中）
 */
export function evaluateMission(world) {
  const events = [];
  let reward = 0;

  const asset = world.protectedAsset;
  const state = world.state;

  const defenders = [];
  const intruders = [];
  for (let i = 0; i < state.count; i++) {
    if (!state.alive[i]) continue;
    if (state.faction[i] === 'defender') defenders.push(i);
    else if (state.faction[i] === 'intruder') intruders.push(i);
  }

  // 防御側による捕捉
  for (const ii of intruders) {
    for (const di of defenders) {
      const d = Math.hypot(state.x[ii] - state.x[di], state.y[ii] - state.y[di]);
      if (d <= INTERCEPT_RANGE_M) {
        state.alive[ii] = 0;
        reward += 1;
        events.push({
          type: 'intercepted',
          intruder: state.id[ii],
          by: state.id[di],
          t: world.clock,
        });
        break;
      }
    }
  }

  // 侵入側による防護対象への到達
  if (asset) {
    for (const ii of intruders) {
      if (!state.alive[ii]) continue;
      const d = Math.hypot(state.x[ii] - asset.x, state.y[ii] - asset.y);
      if (d <= ASSET_BREACH_RANGE_M) {
        reward -= 1;
        events.push({ type: 'asset_breached', intruder: state.id[ii], t: world.clock });
        return { done: true, reward, outcome: 'breached', events };
      }
    }
  }

  const remainingIntruders = intruders.filter((i) => state.alive[i]).length;
  if (remainingIntruders === 0) {
    return { done: true, reward, outcome: 'defended', events };
  }
  if (world.clock >= EPISODE_TIME_LIMIT_S) {
    // 時間切れは侵入を防ぎ切ったとまでは言えないが、突破もされていない
    return { done: true, reward, outcome: 'timeout', events };
  }

  return { done: false, reward, outcome: null, events };
}
