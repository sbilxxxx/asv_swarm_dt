/**
 * parse_orders.js — LLM の生テキスト → 正規化済み orders
 *
 * 小さいモデルは「```json フェンス」「前後の散文」付きで返すため、まず均衡した
 * 最初の {...} を文字列走査で切り出してからパースする。
 * 検証は**部分受理**: 不正な指示行だけ落とし（dropped に理由を残す）、正しい行は生かす。
 * 座標の表記ゆれ（"(e, n)" / [e, n] / {east_m, north_m}）も同じ理由で吸収する（validatePoint）。
 * 全滅（ok=false）のときの意味は「現在の指示を維持」であり、呼び出し側
 * （llm_commander.js）がそのように扱う。
 *
 * ここが「対外 snake_case（east_m / north_m / radius_m）→ core 内部 camelCase
 * （eastM / northM / radiusM）」の唯一の翻訳点。applyOrders が読むのは camelCase の方。
 * roster による名簿検証は第一の防壁（自分が指揮しない艇・自軍が探知していない
 * トラックへの指示を弾く）で、applyOrders 側の存在・生存・陣営チェックが第二の防壁。
 */

export const ORDER_PARSE_ERRORS = {
  NO_JSON: 'no_json',
  BAD_JSON: 'bad_json',
  NO_ORDERS: 'no_orders',
};

/** 文字列リテラル内の波括弧を深さ計算から除外しつつ、最初の均衡した {...} を切り出す */
export function extractFirstJsonObject(text) {
  if (typeof text !== 'string') return null;
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === '{') {
      if (depth === 0) start = i;
      depth++;
      continue;
    }
    if (ch === '}') {
      depth--;
      if (depth === 0 && start >= 0) return text.slice(start, i + 1);
      if (depth < 0) {
        // 対応しない '}' が先に現れた場合。以降を新しい候補として読み直す。
        depth = 0;
        start = -1;
      }
    }
  }
  return null;
}

/** 数値、または数値を引用符で囲んだ文字列（モデルがよくやる）を受ける */
function toFiniteNumber(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

/** "(120, -80)" → ['120', '-80']。囲みの括弧を落とし、カンマ／セミコロン／空白で割るだけ */
function splitTuple(s) {
  return s
    .trim()
    .replace(/^[([]/, '')
    .replace(/[)\]]$/, '')
    .split(/[,;\s]+/)
    .filter((part) => part !== '');
}

/**
 * 座標1点。フレームは常にアセット基準の east/north (m) で、揺れるのは書き方だけ:
 *   - {east_m, north_m} / {eastM, northM} … プロンプトが指定する正規形
 *   - "(east, north)" / "east, north"     … 統合図がすべての位置を `(e, n)` と描くので、
 *                                           小さいモデルはその表記のまま返してくる
 *   - [east, north]                       … 配列で返すモデルがいる
 * 出力は常に camelCase。順序は必ず east が先——統合図の描き方がそうなので、
 * モデルが真似る並びもこれになる。
 *
 * 受けるのは表記だけで、フレームの曖昧なものは受けない。とくに {x, y} は
 * ワールド座標を思わせるが、ここへ来る値がどちらの基準かは判別できない。
 * 静かに別の場所へ向かわせるより、落として dropped に理由を残すほうが安全。
 */
function validatePoint(p) {
  if (Array.isArray(p)) {
    if (p.length !== 2) return null;
    const eastM = toFiniteNumber(p[0]);
    const northM = toFiniteNumber(p[1]);
    if (eastM === null || northM === null) return null;
    return { eastM, northM };
  }
  if (typeof p === 'string') {
    const parts = splitTuple(p);
    if (parts.length !== 2) return null;
    const eastM = toFiniteNumber(parts[0]);
    const northM = toFiniteNumber(parts[1]);
    if (eastM === null || northM === null) return null;
    return { eastM, northM };
  }
  const eastM = toFiniteNumber(p?.east_m ?? p?.eastM);
  const northM = toFiniteNumber(p?.north_m ?? p?.northM);
  if (eastM === null || northM === null) return null;
  return { eastM, northM };
}

function validateOrder(raw, roster) {
  const boat = raw?.boat;
  if (typeof boat !== 'string' || !roster.ownBoatIds.includes(boat)) {
    return { ok: false, boat, reason: 'unknown_or_enemy_boat' };
  }
  const action = raw?.action;
  if (action === 'intercept') {
    // 自軍が一度も探知していないコンタクトは指示できない（トラック名簿が視界の境界）
    if (typeof raw.target !== 'string' || !roster.trackIds.includes(raw.target)) {
      return { ok: false, boat, reason: 'unknown_target' };
    }
    return { ok: true, order: { boat, action, target: raw.target } };
  }
  if (action === 'move_to') {
    const waypoint = validatePoint(raw.waypoint);
    if (!waypoint) return { ok: false, boat, reason: 'bad_waypoint' };
    return { ok: true, order: { boat, action, waypoint } };
  }
  if (action === 'patrol') {
    let center;
    if (raw.center === 'asset') center = 'asset';
    else {
      center = validatePoint(raw.center);
      if (!center) return { ok: false, boat, reason: 'bad_center' };
    }
    const radiusM = toFiniteNumber(raw.radius_m ?? raw.radiusM);
    return {
      ok: true,
      // 半径未指定は undefined のまま渡す。applyOrders が既定値（200m）を当てる。
      order: { boat, action, center, radiusM: radiusM !== null ? Math.min(Math.max(radiusM, 50), 1000) : undefined },
    };
  }
  return { ok: false, boat, reason: 'unknown_action' };
}

/**
 * @param {string} text - LLM の生出力
 * @param {{ownBoatIds: string[], trackIds: string[]}} roster - 検証用の名簿（提示した統合図から作る）
 * @returns {{ok: boolean, error: string|null, orders: Array, dropped: Array, intent: string|null}}
 */
export function parseOrders(text, roster) {
  const json = extractFirstJsonObject(text);
  if (json === null) return { ok: false, error: ORDER_PARSE_ERRORS.NO_JSON, orders: [], dropped: [], intent: null };
  let obj;
  try {
    obj = JSON.parse(json);
  } catch {
    return { ok: false, error: ORDER_PARSE_ERRORS.BAD_JSON, orders: [], dropped: [], intent: null };
  }
  // intent は orders の検査より先に拾う。指示が全滅した返答でも「何をしようとしたか」は
  // ログに残る価値がある。120字は記録側の保険であり、プロンプトの「12語以内」とは別の制約。
  const intent = typeof obj?.intent === 'string' ? obj.intent.slice(0, 120) : null;
  if (!obj || !Array.isArray(obj.orders)) {
    return { ok: false, error: ORDER_PARSE_ERRORS.NO_ORDERS, orders: [], dropped: [], intent };
  }
  const byBoat = new Map(); // 同一艇への重複指示は後勝ち（実際の口頭指揮の「訂正」に相当）
  const dropped = [];
  for (const raw of obj.orders) {
    const v = validateOrder(raw, roster);
    if (v.ok) byBoat.set(v.order.boat, v.order);
    else dropped.push(v);
  }
  const orders = [...byBoat.values()];
  // 空の orders は「有効な無指示」ではなく失敗として扱う。意味は「現在の指示を維持」。
  return {
    ok: orders.length > 0,
    error: orders.length > 0 ? null : ORDER_PARSE_ERRORS.NO_ORDERS,
    orders,
    dropped,
    intent,
  };
}
