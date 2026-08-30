/**
 * mission.js — 攻防シナリオの勝敗判定と報酬
 *
 * このファイルが「単なる相互追跡」を「攻防」にする。
 *
 * ルール:
 *   - 侵入側(intruder)のうち **重装艇（decisiveOnAsset）だけ** が旗（protectedAsset）に届けば勝つ。
 *     快速艇・索敵艇は旗に着いても何も起きない（爆弾を積んでいない）。
 *   - 迎撃は自爆による相討ち。相手の爆破半径へ入った時点で起爆し、双方が消える。
 *   - **爆破半径の中に旗があれば旗も壊れる**（下記）。
 *   - どちらかが達成するか、制限時間を超えるとエピソード終了。
 *
 * 【なぜ巻き添えが要るのか】
 * これが無いと防御側は旗の上に固まって待つだけで勝ててしまう。侵入側の重装艇は
 * 旗の ASSET_BREACH_RANGE_M 以内へ入る必要があり、そこに爆破半径 100m の防御艇が
 * 座っていれば近づいた瞬間に相討ちで終わる——守る側が一方的に有利で、ゲームにならない。
 * 巻き添えを入れると籠城が禁じ手になり、防御側は「旗から十分離れた場所で重装艇を
 * 見つけて止める」必要が生まれる。前に出るほど敵の護衛と接触する危険が増える、という
 * 張り合いがここで初めて成立する。物理的にも自然で、自爆兵器を自陣拠点の至近で
 * 起爆させれば自滅する。
 *
 * 報酬は防御側視点のスカラー（強化学習・自己対戦での利用を想定）。
 * 学習パイプライン本体は対象外だが、報酬と終了条件をここに置くことで、
 * FR8のログが「学習データとして意味のある単位」になる。
 */

import { shipClassOf } from './ship_classes.js';

/**
 * 旧・単一の捕捉距離。艦種ごとの爆破半径（ship_classes.js）へ移したが、
 * 指揮官プロンプト（commander_prompt.js）が「おおよその間合い」を1つの数で言うために残す。
 * 判定そのものには使わない。
 */
export const INTERCEPT_RANGE_M = 60;
/** 侵入側の重装艇が防護対象に到達したとみなす距離 */
export const ASSET_BREACH_RANGE_M = 80;
/** エピソードの制限時間（シミュレーション秒） */
export const EPISODE_TIME_LIMIT_S = 240;

/**
 * 1ステップ分の判定を行い、状態を更新する（相討ちになった双方の alive を落とす）。
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

  // --- 自爆による相討ち ---
  // 敵対する2艇の距離が「どちらかの爆破半径」以内なら、半径の大きいほうが起爆したものとして
  // 双方を消す。索敵艇（半径0）同士はここで決して起爆しない。
  let assetDestroyedBy = null;
  for (const ii of intruders) {
    if (!state.alive[ii]) continue;
    for (const di of defenders) {
      if (!state.alive[di] || !state.alive[ii]) continue;
      const d = Math.hypot(state.x[ii] - state.x[di], state.y[ii] - state.y[di]);
      const blastM = Math.max(
        shipClassOf(state.shipClass[ii]).blastRadiusM,
        shipClassOf(state.shipClass[di]).blastRadiusM
      );
      if (blastM <= 0 || d > blastM) continue;

      state.alive[ii] = 0;
      state.alive[di] = 0;
      reward += 1; // 侵入艇を1隻消した（同時に自艇も失っているが、旗が主目的なので正）
      events.push({
        type: 'mutual_destruction',
        intruder: state.id[ii],
        defender: state.id[di],
        blastRadiusM: blastM,
        t: world.clock,
      });

      // 巻き添え: 爆心から旗までが爆破半径以内なら旗も壊れる。
      // 爆心は相討ちした2艇の中点とする（どちらが起爆したかを決めずに済む）。
      if (asset && assetDestroyedBy === null) {
        const cx = (state.x[ii] + state.x[di]) / 2;
        const cy = (state.y[ii] + state.y[di]) / 2;
        if (Math.hypot(cx - asset.x, cy - asset.y) <= blastM) {
          assetDestroyedBy = { intruder: state.id[ii], defender: state.id[di] };
        }
      }
    }
  }

  if (assetDestroyedBy) {
    reward -= 1;
    events.push({ type: 'asset_destroyed_by_blast', ...assetDestroyedBy, t: world.clock });
    return { done: true, reward, outcome: 'breached', events };
  }

  // --- 侵入側の重装艇による旗への到達 ---
  // 積荷を持つ艦種だけが勝敗を決する。快速艇・索敵艇の到達は無視する（囮が意味を持つ根拠）。
  if (asset) {
    for (const ii of intruders) {
      if (!state.alive[ii]) continue;
      if (!shipClassOf(state.shipClass[ii]).decisiveOnAsset) continue;
      const d = Math.hypot(state.x[ii] - asset.x, state.y[ii] - asset.y);
      if (d <= ASSET_BREACH_RANGE_M) {
        reward -= 1;
        events.push({ type: 'asset_breached', intruder: state.id[ii], t: world.clock });
        return { done: true, reward, outcome: 'breached', events };
      }
    }
  }

  // --- 決着 ---
  // 「侵入艇が全滅したか」ではなく「積荷を持つ艇が残っているか」で見る。
  // 囮の快速艇だけが残っても侵入側に勝ち目は無く、そこから時間切れまで回すのは
  // エピソードの引き延ばしでしかない。
  const decisiveLeft = intruders.filter(
    (i) => state.alive[i] && shipClassOf(state.shipClass[i]).decisiveOnAsset
  ).length;
  if (decisiveLeft === 0) {
    return { done: true, reward, outcome: 'defended', events };
  }
  if (world.clock >= EPISODE_TIME_LIMIT_S) {
    // 時間切れは侵入を防ぎ切ったとまでは言えないが、突破もされていない
    return { done: true, reward, outcome: 'timeout', events };
  }

  return { done: false, reward, outcome: null, events };
}
