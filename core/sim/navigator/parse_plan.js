/**
 * parse_plan.js — VLM の返答を実行可能な航路プランへ直す
 *
 * ここが「見るのは強い・測るのは弱い」への防波堤である（計画 §5）。7B〜32B 級の VLM は
 * 画面に何がどちら側に見えるかは正確に言える一方、そこから幾何的に妥当な waypoint を
 * 置く能力が弱い。2回の実測で次の退化が実際に出ている:
 *
 *   2026-08-14 自船位置(0,0)を waypoint に混入・順序逆転・危険物への横偏位なし
 *   2026-08-30 目的地と同じ点を3つ並べて返す
 *   2026-09-06 **レーダー接触の座標をそのまま waypoint にする**（＝危険へ舵を向ける）
 *
 * 【落としたものは必ず数える】黙って直すと、次に直すべきなのがプロンプトなのか、
 * 幾何をコード側へ移すこと（計画 §5 の vlm-watch アーム）なのかが実験ログから判別できなくなる。
 * したがって全ての除去・クランプ・畳み込みは notes に理由つきで残す。
 * llm_http.js の「失敗に名前を付ける」契約と同じ考え方である。
 *
 * 【失敗は必ず keep へ落ちる】パース不能・空配列・全滅は例外にせず `keep` を返す。
 * 航海士が黙っても船は現行プランのまま走り続け、エピソードは必ず終わる（計画 §4）。
 */

import { extractFirstJsonObject } from '../command/parse_orders.js';

/** 1プランの waypoint 上限。これを超えた分は捨てる（プロンプトは 1-3 と言っている） */
export const MAX_WAYPOINTS = 5;
/** 自船位置と重なる waypoint は捨てる（2026-08-14 実測で実際に混入した） */
export const SELF_WAYPOINT_REJECT_M = 25;
/** 連続する同一点はこの距離未満なら1点に畳む（2026-08-30 実測: 目的地を3回並べて返す退化） */
export const DUPLICATE_WAYPOINT_M = 20;
/**
 * レーダー接触の位置と重なる waypoint は捨てる（2026-09-06 実測）。
 *
 * 交通船を置いたシナリオ（pilotage_m3）で、VLM は**危険を正しく報告しながら、その危険の座標を
 * そのまま waypoint として返した**。プロンプトに
 *   `- traffic-cross: range 36 m, ..., at east=37, north=-494`
 * と書いてあると、応答が `{"eastM": 37, "northM": -494}` になる——つまり
 * 「避けろ」と言われた点へ舵を向ける。採用された24点のうち6点がこれだった。
 *
 * 自船位置の混入（SELF_WAYPOINT_REJECT_M）と原因は同じで、
 * **プロンプト中の目立つ座標をそのまま書き写す**という失敗である。同じ対処を与える。
 * ここも「落として数える」だけで、迂回点をコード側で作ることはしない
 * （作ると VLM の幾何能力の評価にコード側の航法が混ざる。計画 §5）。
 */
export const CONTACT_WAYPOINT_REJECT_M = 30;
/** 最終点がここまで目的地から離れていたら、目的地を末尾に足す（足さないと着かない） */
export const DESTINATION_APPEND_M = 60;

/** notes に載る理由の名前。集計側（analyze/ログ）が文字列を読み替えないよう定数にする */
export const PLAN_NOTES = Object.freeze({
  UNPARSABLE: 'unparsable',
  NON_NUMERIC: 'non-numeric waypoint dropped',
  OWN_POSITION: 'own-position waypoint dropped',
  /** レーダー接触の位置をそのまま waypoint にしてきた（＝危険へ舵を向けるプラン） */
  ON_CONTACT: 'waypoint on a radar contact dropped',
  CLAMPED: 'waypoint clamped to scene bounds',
  DUPLICATE: 'duplicate waypoint collapsed',
  OVERFLOW: 'waypoint beyond the limit dropped',
  NO_USABLE: 'no usable waypoint',
  DESTINATION_APPENDED: 'destination appended',
  /**
   * プランが引き返している（自船からの距離が単調増加でない）。**落とさず、数えるだけ**。
   * 2026-08-14 に記録された「順序逆転」の退化で、2026-09-05 のブラウザ実測でも
   * `(dest) → (中間点) → (dest)` という形で再現した。並べ替えて黙って直すことはしない——
   * 直すと VLM の空間計画の弱さが軌跡から消え、責務をコード側へ移すべきか
   * （計画 §5 の vlm-watch アーム）の判断材料が実験ログから失われる。
   */
  DOUBLES_BACK: 'plan doubles back (waypoints not ordered by distance)',
});

function clamp(v, lo, hi) {
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) return v;
  return Math.min(Math.max(v, lo), hi);
}

/** 数値、または数値を引用符で囲んだ文字列（モデルがよくやる）を受ける。parse_orders.js と同じ寛容さ */
function toFiniteNumber(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

/** watch / speed は付加情報。壊れていても判断そのものは捨てない */
function toWatch(value) {
  return typeof value === 'string' ? value.slice(0, 160) : null;
}
function toSpeed(value) {
  return value === 'stop' || value === 'slow' || value === 'cruise' ? value : null;
}

/**
 * VLM の生テキスト → プラン。
 *
 * @param {string} text - モデルの応答（```json フェンス付きでも可）
 * @param {{picture:object, bounds?:{minX:number,maxX:number,minY:number,maxY:number}|null}} context
 *   picture: buildNavigatorPicture の出力。自船位置と目的地の出所はここだけ
 *   bounds: 運用領域。省略時は picture.bounds
 * @returns {{action:'keep'|'replace', waypoints:Array<{eastM:number,northM:number}>|null,
 *   watch:string|null, speed:string|null, notes:string[], parsed:object|null}}
 */
export function parseNavigatorPlan(text, { picture, bounds = undefined } = {}) {
  if (!picture?.self || !picture?.destination) {
    throw new TypeError('parseNavigatorPlan: picture with self/destination is required');
  }
  const box = bounds === undefined ? picture.bounds : bounds;
  const destination = picture.destination;
  const notes = [];

  const json = extractFirstJsonObject(typeof text === 'string' ? text : '');
  let parsed = null;
  if (json !== null) {
    try {
      parsed = JSON.parse(json);
    } catch {
      parsed = null;
    }
  }
  if (!parsed || typeof parsed !== 'object') {
    return { action: 'keep', waypoints: null, watch: null, speed: null, notes: [PLAN_NOTES.UNPARSABLE], parsed: null };
  }

  const watch = toWatch(parsed.watch);
  const speed = toSpeed(parsed.speed);
  // keep が既定。'replace' と明示されない限りプランは触らない（死んだ waypoint への対策）
  if (parsed.action !== 'replace') {
    return { action: 'keep', waypoints: null, watch, speed, notes, parsed };
  }

  const raw = Array.isArray(parsed.waypoints) ? parsed.waypoints : [];
  const clean = [];
  for (const w of raw) {
    if (clean.length >= MAX_WAYPOINTS) {
      notes.push(PLAN_NOTES.OVERFLOW);
      break;
    }
    const e = toFiniteNumber(w?.eastM ?? w?.east_m ?? w?.east);
    const n = toFiniteNumber(w?.northM ?? w?.north_m ?? w?.north);
    if (e === null || n === null) {
      notes.push(PLAN_NOTES.NON_NUMERIC);
      continue;
    }
    if (Math.hypot(e - picture.self.eastM, n - picture.self.northM) < SELF_WAYPOINT_REJECT_M) {
      notes.push(PLAN_NOTES.OWN_POSITION);
      continue;
    }
    // レーダーが「そこに船が居る」と言っている点は waypoint にできない。
    // 状況図に書いた座標をそのまま書き写してくる実測（上の CONTACT_WAYPOINT_REJECT_M 参照）への対処。
    const onContact = (picture.radar?.contacts ?? []).find(
      (c) => Math.hypot(e - c.eastM, n - c.northM) < CONTACT_WAYPOINT_REJECT_M
    );
    if (onContact) {
      notes.push(PLAN_NOTES.ON_CONTACT);
      continue;
    }
    const ce = box ? clamp(e, box.minX, box.maxX) : e;
    const cn = box ? clamp(n, box.minY, box.maxY) : n;
    if (ce !== e || cn !== n) notes.push(PLAN_NOTES.CLAMPED);
    const prev = clean[clean.length - 1];
    if (prev && Math.hypot(prev.eastM - ce, prev.northM - cn) < DUPLICATE_WAYPOINT_M) {
      notes.push(PLAN_NOTES.DUPLICATE);
      continue;
    }
    clean.push({ eastM: ce, northM: cn });
  }

  if (clean.length === 0) {
    notes.push(PLAN_NOTES.NO_USABLE);
    return { action: 'keep', waypoints: null, watch, speed, notes, parsed };
  }

  // 引き返しの検出。プランは「手前から順」と指示してあるので、自船からの距離は単調増加のはず。
  // ここは記録だけで、waypoint は1点も落とさない（軌跡はこの検出の有無で変わらない）。
  for (let i = 1; i < clean.length; i++) {
    const prevD = Math.hypot(clean[i - 1].eastM - picture.self.eastM, clean[i - 1].northM - picture.self.northM);
    const thisD = Math.hypot(clean[i].eastM - picture.self.eastM, clean[i].northM - picture.self.northM);
    if (thisD < prevD - DUPLICATE_WAYPOINT_M) {
      notes.push(PLAN_NOTES.DOUBLES_BACK);
      break;
    }
  }

  // 目的地で終わらないプランはそのままだと目的地に着かない。末尾に足して、足したことを残す
  const last = clean[clean.length - 1];
  if (Math.hypot(last.eastM - destination.eastM, last.northM - destination.northM) > DESTINATION_APPEND_M) {
    clean.push({ eastM: destination.eastM, northM: destination.northM });
    notes.push(PLAN_NOTES.DESTINATION_APPENDED);
  }

  return { action: 'replace', waypoints: clean, watch, speed, notes, parsed };
}

/**
 * 2つのプランが同じか（同一プランの再送を数えるための判定）。
 * L0 の主要な挙動指標「死んだ waypoint 率」の航海士版で、`replace` と言いながら
 * 中身が変わっていない回数を数えるために要る。
 */
export function samePlan(a, b, toleranceM = 1) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
  return a.every(
    (p, i) => Math.abs(p.eastM - b[i].eastM) <= toleranceM && Math.abs(p.northM - b[i].northM) <= toleranceM
  );
}
