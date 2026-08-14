/**
 * fused_picture.js — 指揮官の視界: 味方センサー統合図（構造化データ）
 *
 * 「完全俯瞰（神の視点）」ではない。含むのは
 *   - 味方全艇の真位置（艦隊データリンクで常時共有される想定）
 *   - 味方レーダーが捉えた敵トラック（tracks.js。映らなくなった敵は stale に古びる）
 * のみ。敵の真位置がここへ混入した時点で部分観測の前提が壊れるので、
 * World の EntityState から敵陣営を直接読むコードをこのファイルに書かないこと。
 * データ源は (a) state.faction[i] === faction の行 と (b) world.tracks[faction] の二つだけ。
 *
 * 座標系はアセット基準の east/north (m)。針路は北基準・時計回りのコンパス度
 * （LLM に数学規約の heading を渡すと解釈を誤るため、表示側の規約に揃える）。
 * 指示の要約もアセット基準で書く（describeOrder に asset を渡す）。艇の位置が
 * アセット基準・指示の座標がワールド基準、という混在は1行の中で必ず読み違えられる。
 *
 * 副作用は持たず、World への参照も残さない: この統合図から作られた指示が実際に
 * 発効するのは latencyS 後であり、その間に World は進む（docs/time-model.md §8）。
 */

import { describeOrder } from './orders.js';

/** 数学規約（+x=東・CCW正・ラジアン）→ コンパス度（北0・時計回り・0〜359） */
export function toCompassDeg(mathRad) {
  return Math.round((90 - (mathRad * 180) / Math.PI + 360) % 360);
}

/**
 * @param {import('../world.js').World} world
 * @param {string} faction - 'defender' | 'intruder'
 * @param {{episode?: number}} [meta]
 * @returns {{faction: string, t: number, episode: number|null, asset: {eastM: number, northM: number},
 *   ownForce: Array<{id: string, eastM: number, northM: number, compassHeadingDeg: number,
 *     speedMps: number, orderSummary: string}>,
 *   tracks: Array<{id: string, eastM: number, northM: number, ageS: number, seenBy: string}>}}
 */
export function buildFusedPicture(world, faction, { episode = null } = {}) {
  const store = world.tracks?.[faction];
  if (!store) {
    // World が持つトラックストアは defender / intruder の二つだけ。未知の陣営を
    // 素の TypeError で落とすと呼び出し側で原因が分からないので名前を付けて投げる。
    throw new Error(`buildFusedPicture: unknown faction "${faction}"`);
  }
  const asset = world.protectedAsset ?? { x: 0, y: 0 };
  const state = world.state;

  const ownForce = [];
  for (let i = 0; i < state.count; i++) {
    if (!state.alive[i] || state.faction[i] !== faction) continue;
    ownForce.push({
      id: state.id[i],
      eastM: state.x[i] - asset.x,
      northM: state.y[i] - asset.y,
      compassHeadingDeg: toCompassDeg(state.heading[i]),
      speedMps: state.speed[i],
      orderSummary: describeOrder(world.orders.get(state.id[i]), asset),
    });
  }

  // 古いトラックもそのまま載せる。鮮度で切り捨てるのは指揮官の判断であって、
  // 統合図の仕事ではない（ageS を隠さず渡すのがこのモジュールの責務）。
  const tracks = store.list().map((tr) => ({
    id: tr.id,
    eastM: tr.x - asset.x,
    northM: tr.y - asset.y,
    ageS: world.clock - tr.lastSeenT,
    seenBy: tr.seenBy,
  }));

  // asset は常に (0, 0)。全体がアセット基準なので自明だが、プロンプトの座標系を
  // 一目で示すためにデータ側にも置いておく。
  return { faction, t: world.clock, episode, asset: { eastM: 0, northM: 0 }, ownForce, tracks };
}
