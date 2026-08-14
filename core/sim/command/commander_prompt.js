/**
 * commander_prompt.js — 統合図→テキスト、指揮官のシステムプロンプト
 *
 * 設計上の約束ごと:
 * 1. ワールド生座標を渡さない。すべてアセット基準 (east_m, north_m)。
 * 2. トラックの鮮度（last seen X s ago）を必ず示す。stale な情報に基づく采配も
 *    それ自体が観察対象なので、隠さずに古さを明示する。
 * 3. 指揮のリズム（intervalS ごと発令・latencyS 遅れて発効）をプロンプトで明示する。
 *    自分の指示が遅れて届くことを知らない指揮官は原理的に正しく采配できない。
 * 4. 統合図には陣営を書き、指揮官の陣営と突き合わせられるようにする（renderPictureText の
 *    expectFaction）。取り違えた統合図は敵全艇の真位置をそのまま渡す全面漏洩であり、
 *    しかも文面としては正しいものと見分けが付かない。
 *
 * intervalS / latencyS は DecisionScheduler.register() に渡すものと同一の設定オブジェクトを
 * 使うこと（数値を打ち直すと、プロンプトの言う指揮リズムと実際の発効が食い違う）。
 * 勝敗の距離は mission.js を唯一の出所とし、ここでは決してハードコードしない。
 */

import { INTERCEPT_RANGE_M, ASSET_BREACH_RANGE_M, EPISODE_TIME_LIMIT_S } from '../mission.js';

// 対外（LLM）向けの線表記は snake_case。core 内部の正規化済み表現は camelCase で、
// その翻訳点は parse_orders.js ただ一箇所に置く。
const ORDERS_SCHEMA = [
  'Reply with ONLY one JSON object:',
  '{"orders": [',
  '  {"boat": "<own boat id>", "action": "intercept", "target": "<track id>"}',
  '  or {"boat": "<own boat id>", "action": "move_to", "waypoint": {"east_m": <num>, "north_m": <num>}}',
  '  or {"boat": "<own boat id>", "action": "patrol", "center": "asset" | {"east_m": <num>, "north_m": <num>}, "radius_m": <num>}',
  '], "intent": "<your plan in at most 12 words>"}',
  'Boats you do not mention keep their current order.',
].join('\n');

/**
 * @param {string} faction - 'defender' | 'intruder'
 * @param {{intervalS: number, latencyS: number}} timing - DecisionScheduler.register() と同じ設定
 * @returns {string}
 */
export function buildCommanderSystemPrompt(faction, { intervalS, latencyS }) {
  const shared = [
    'Coordinates are meters east/north of the protected asset at (0, 0).',
    "You see only your own force's fused sensor picture. Enemy tracks may be stale or missing entirely.",
    `You may issue orders every ${intervalS} s. Orders take ${latencyS} s to reach your boats;`,
    'until then each boat keeps executing its current order.',
    ORDERS_SCHEMA,
  ];
  if (faction === 'defender') {
    return [
      'You are the DEFENDER commander of uncrewed surface vessels (ASVs).',
      `Protect the asset: you lose if any intruder gets within ${ASSET_BREACH_RANGE_M} m of it.`,
      `A defender neutralises an intruder by closing within ${INTERCEPT_RANGE_M} m of it.`,
      ...shared,
    ].join('\n');
  }
  if (faction === 'intruder') {
    return [
      'You are the INTRUDER commander of uncrewed surface vessels (ASVs).',
      `Win by getting any of your boats within ${ASSET_BREACH_RANGE_M} m of the asset at (0, 0).`,
      `Defenders neutralise your boats by closing within ${INTERCEPT_RANGE_M} m.`,
      ...shared,
    ].join('\n');
  }
  throw new Error(`buildCommanderSystemPrompt: unknown faction "${faction}"`);
}

// 陣営名は「指揮官のシステムプロンプト」と「統合図」の両方に現れる唯一の共有語。
// ここを突き合わせ点にする（renderPictureText の expectFaction）。
const FACTIONS = ['defender', 'intruder'];

/** 位置は整数メートルで書く（小数はモデルの注意を食うだけで判断を変えない） */
function fmt(n) {
  return String(Math.round(n));
}

/**
 * 統合図をプロンプト本文へ描く。
 *
 * 陣営の取り違えはこのモジュールで最も高くつく事故なので二重に防ぐ:
 * 1. FORCE PICTURE 行に陣営を書く。system 側は buildCommanderSystemPrompt(faction) が
 *    「You are the DEFENDER commander」と名乗っているので、食い違えば人もモデルも
 *    読んで気付ける。陣営を書かないと、取り違えたプロンプトが正しいものと見分けの
 *    つかない well-formed なテキストになってしまう。
 * 2. expectFaction を渡すと不一致を実行時に投げて止める。指揮官の陣営と統合図の陣営が
 *    別々の場所で決まる呼び出し側は必ず渡すこと。llm_commander.js（Task 7）は
 *    systemPrompt を生成時に1度だけ作り、picture は判断ごとに受け取る——
 *    まさにこの二つが離れている形なので、そこが第一の適用先。
 *
 * 取り違えは「敵トラックが少し古い」程度の劣化ではない。相手陣営の統合図には相手全艇の
 * 真位置が OWN FORCE (truth) として載っているので、そのまま敵位置の全面開示になる。
 *
 * @param {ReturnType<import('./fused_picture.js').buildFusedPicture>} picture
 * @param {{expectFaction?: string|null}} [options] - 指揮官側の陣営。渡すと不一致で throw
 * @returns {string}
 */
export function renderPictureText(picture, { expectFaction = null } = {}) {
  const faction = picture?.faction;
  if (!FACTIONS.includes(faction)) {
    throw new Error(`renderPictureText: unknown faction "${faction}" in picture`);
  }
  if (expectFaction !== null && expectFaction !== faction) {
    throw new Error(
      `renderPictureText: faction mismatch — commander is "${expectFaction}" but the picture is ` +
        `"${faction}" (相手陣営の統合図を描くと、その全艇の真位置がそのまま渡る)`
    );
  }
  const lines = [];
  lines.push(
    `FORCE PICTURE t=${picture.t.toFixed(1)}s — ${faction.toUpperCase()} force — ` +
      `you command: ${picture.ownForce.map((b) => b.id).join(', ') || '(none)'}`
  );
  lines.push('ASSET at (0, 0)');
  lines.push('OWN FORCE (truth):');
  for (const b of picture.ownForce) {
    lines.push(
      `  ${b.id} at (${fmt(b.eastM)}, ${fmt(b.northM)}) heading ${String(b.compassHeadingDeg).padStart(3, '0')} ` +
        `speed ${b.speedMps.toFixed(1)} m/s — order: ${b.orderSummary}`
    );
  }
  lines.push('ENEMY TRACKS (fused from own radars; may be stale):');
  if (picture.tracks.length === 0) {
    lines.push('  (none detected)');
  } else {
    // 新しいトラックから読ませる。入力配列は複製してから並べ替える（統合図は呼び出し側の所有物）。
    for (const tr of [...picture.tracks].sort((a, b) => a.ageS - b.ageS)) {
      lines.push(
        `  ${tr.id} at (${fmt(tr.eastM)}, ${fmt(tr.northM)}) — last seen ${tr.ageS.toFixed(1)}s ago by ${tr.seenBy}`
      );
    }
  }
  lines.push(`TIME ${picture.t.toFixed(1)} / ${EPISODE_TIME_LIMIT_S} s`);
  return lines.join('\n');
}
