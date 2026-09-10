/**
 * avoidance.js — 「どちら側を通るか」から実際の waypoint を作る（幾何はコード側の責務）
 *
 * 【なぜコード側に置くか】2026-09-06 の実測で、VLM は
 *   ・危険を**言語では正しく報告する**（「Traffic ahead on the starboard side」）
 *   ・しかし**その危険の座標をそのまま waypoint として返す**（採用24点中6点）
 * という壊れ方をした。座標を作る作業そのものが苦手なので、取り上げる。
 * VLM に残すのは「どの相手を・どちら側に・どれだけ離して通るか」の離散的な選択だけで、
 * そこから通過点を置くのはここが決定論的に行う
 * （docs/perception-to-waypoint-flow.md §3 の⑥・§4 の H4）。
 *
 * 【CPA（最接近点）で考える】相手も動いているので、「今の位置から N m 離す」では足りない。
 * 相対速度が一定だと仮定して最接近する時刻を解き、**その時刻の相手の位置**の横に通過点を置く。
 * 仮定が粗いのは意図的で、判断サイクル（10 s）ごとに引き直すため長時間の予測は要らない。
 *
 * 【純関数】World も乱数も実時刻も触らない。入力が同じなら必ず同じ waypoint を返すので、
 * テストで「生成したプランの CPA が指定した離隔を満たす」ことを固定できる。
 */

/** 機動の選択肢。VLM にはこの中から選ばせる（自由な座標を作らせない） */
export const MANEUVERS = Object.freeze(['hold', 'pass_port', 'pass_starboard', 'slow', 'stop']);

/** 離隔の既定と範囲。狭すぎると意味が無く、広すぎると遠回りで到達しない */
export const DEFAULT_OFFSET_M = 120;
export const MIN_OFFSET_M = 40;
export const MAX_OFFSET_M = 400;
export { DEFAULT_HORIZON_S };

/** 通過点をこの距離より手前には置かない（真横に置くと追従制御が急旋回する） */
const MIN_LEAD_M = 60;
/**
 * CPA の探索上限（秒）の既定値。
 *
 * **等速直線の仮定が持つ時間より先を予測してはいけない。** 2026-09-06 の実測で、
 * ここを 120 s にしていたために悪化した:
 *   ・周回する交通船の針路は 40 秒で −76°→−14°（約1.5°/s）旋回していた
 *   ・速度の推定自体は正確（3.0 / 1.0 m/s ＝シナリオ値と一致）だったが、
 *     それを120秒も外挿した先に通過点を置いたため、実際の最接近は 16m→6m へ悪化した
 * 呼び出し側は**そのプランが実際に支配する時間**（判断間隔＋発効遅延）を渡すこと。
 * 引き直すたびに新しい観測が入るので、遠くまで当てる必要はない。
 */
const DEFAULT_HORIZON_S = 20;

function clamp(v, lo, hi) {
  return Math.min(Math.max(v, lo), hi);
}

/**
 * 等速直線を仮定した最接近（CPA）。
 *
 * @param {{eastM:number, northM:number, headingDeg:number, speedMps:number}} self
 * @param {{eastM:number, northM:number, headingDeg?:number, speedMps?:number}} other
 *   相手の針路・速力が分からない場合（レーダーは点しか返さない）は静止として扱う——
 *   **その仮定は保守的ではない**ので、呼び出し側が速力を推定できるなら渡すこと。
 * @param {{horizonS?:number}} [options] 外挿の上限（秒）。既定 DEFAULT_HORIZON_S
 * @returns {{tS:number, rangeM:number, selfAt:{eastM:number,northM:number},
 *   otherAt:{eastM:number,northM:number}}}
 */
export function closestPointOfApproach(self, other, { horizonS = DEFAULT_HORIZON_S } = {}) {
  const toRad = (d) => (d * Math.PI) / 180;
  const sv = {
    x: Math.cos(toRad(self.headingDeg)) * (self.speedMps ?? 0),
    y: Math.sin(toRad(self.headingDeg)) * (self.speedMps ?? 0),
  };
  const ov = {
    x: Math.cos(toRad(other.headingDeg ?? 0)) * (other.speedMps ?? 0),
    y: Math.sin(toRad(other.headingDeg ?? 0)) * (other.speedMps ?? 0),
  };
  const rx = other.eastM - self.eastM;
  const ry = other.northM - self.northM;
  const vx = ov.x - sv.x;
  const vy = ov.y - sv.y;
  const vv = vx * vx + vy * vy;
  // 相対速度がほぼ 0（並走・双方停止）なら今が最接近
  let tS = vv < 1e-9 ? 0 : -(rx * vx + ry * vy) / vv;
  tS = clamp(tS, 0, horizonS);
  const selfAt = { eastM: self.eastM + sv.x * tS, northM: self.northM + sv.y * tS };
  const otherAt = { eastM: other.eastM + ov.x * tS, northM: other.northM + ov.y * tS };
  return {
    tS,
    rangeM: Math.hypot(otherAt.eastM - selfAt.eastM, otherAt.northM - selfAt.northM),
    selfAt,
    otherAt,
  };
}

/**
 * 機動の選択 → waypoint 列（通過点2つ＋目的地）。
 *
 * `pass_port` は「相手を自分の左舷側に見て通る」＝**自分は相手の右側へ寄る**。
 * 船乗りの語彙（相手がどちらに見えるか）で選ばせ、幾何の解釈はここが持つ
 * ——VLM に「右へ 120m ずらせ」と座標で言わせないためである。
 *
 * @param {{self:{eastM:number,northM:number,headingDeg:number,speedMps:number},
 *   destination:{eastM:number,northM:number},
 *   target?:{eastM:number,northM:number,headingDeg?:number,speedMps?:number}|null,
 *   maneuver:string, offsetM?:number,
 *   bounds?:{minX:number,maxX:number,minY:number,maxY:number}|null}} input
 * @returns {{waypoints:Array<{eastM:number,northM:number}>, notes:string[],
 *   cpa:ReturnType<typeof closestPointOfApproach>|null}}
 *   `hold` / `slow` / `stop` は waypoints を空で返す（速力の指定は呼び出し側の責務で、
 *   航路は変えない）。
 */
export function planAvoidance({
  self,
  destination,
  target = null,
  maneuver,
  offsetM = DEFAULT_OFFSET_M,
  bounds = null,
  /** 外挿の上限（秒）。**そのプランが実際に支配する時間**＝判断間隔＋発効遅延を渡す */
  horizonS = DEFAULT_HORIZON_S,
} = {}) {
  if (!MANEUVERS.includes(maneuver)) {
    throw new TypeError(`planAvoidance: maneuver must be one of ${MANEUVERS.join(' | ')}, got ${maneuver}`);
  }
  const notes = [];
  if (maneuver === 'hold' || maneuver === 'slow' || maneuver === 'stop') {
    return { waypoints: [], notes, cpa: null };
  }
  if (!target) {
    notes.push('no target for the maneuver; keeping the route');
    return { waypoints: [], notes, cpa: null };
  }

  const requested = offsetM;
  const off = clamp(offsetM, MIN_OFFSET_M, MAX_OFFSET_M);
  if (off !== requested) notes.push(`offset clamped to ${off} m`);

  const cpa = closestPointOfApproach(self, target, { horizonS });

  // 相手の CPA 位置から、自船の進行方向に対して横へ off だけずらした点を通過点にする。
  // 横方向の符号は機動で決まる: pass_port（相手を左舷に見る）＝自分は相手の右側＝
  // 進行方向に対して右（-90度）へ寄る。
  const headRad = (self.headingDeg * Math.PI) / 180;
  const side = maneuver === 'pass_port' ? -1 : +1;
  const lateral = { x: -Math.sin(headRad) * side, y: Math.cos(headRad) * side };

  let via = {
    eastM: cpa.otherAt.eastM + lateral.x * off,
    northM: cpa.otherAt.northM + lateral.y * off,
  };

  // 真横・後方に置くと追従制御が急旋回するので、最低の前方距離を確保する
  const ahead = (via.eastM - self.eastM) * Math.cos(headRad) + (via.northM - self.northM) * Math.sin(headRad);
  if (ahead < MIN_LEAD_M) {
    via = {
      eastM: via.eastM + Math.cos(headRad) * (MIN_LEAD_M - ahead),
      northM: via.northM + Math.sin(headRad) * (MIN_LEAD_M - ahead),
    };
    notes.push('via point pushed forward to keep the turn gentle');
  }

  if (bounds) {
    const ce = clamp(via.eastM, bounds.minX, bounds.maxX);
    const cn = clamp(via.northM, bounds.minY, bounds.maxY);
    if (ce !== via.eastM || cn !== via.northM) notes.push('via point clamped to scene bounds');
    via = { eastM: ce, northM: cn };
  }

  // 通過点を1つだけ置くと、そこから目的地へ戻る脚が**相手を横切る**。
  // 2026-09-06 のテストが実際にこれを暴いた（予測CPAからの離隔が offset 120m に対し 93m）。
  // 相手を抜けきってから舵を戻すため、同じ横偏位のまま進行方向へ off だけ進めた点を足す。
  const viaOut = {
    eastM: via.eastM + Math.cos(headRad) * off,
    northM: via.northM + Math.sin(headRad) * off,
  };
  const clampPoint = (pt) =>
    bounds
      ? { eastM: clamp(pt.eastM, bounds.minX, bounds.maxX), northM: clamp(pt.northM, bounds.minY, bounds.maxY) }
      : pt;

  return {
    waypoints: [via, clampPoint(viaOut), { eastM: destination.eastM, northM: destination.northM }],
    notes,
    cpa,
  };
}

/**
 * プランの事後検査（H6）。**点が接触から離れていても、点と点を結ぶ線が接触を貫く**ことがある
 * ——`parse_plan.js` の `ON_CONTACT`（点だけを見る）では捕まらないケースで、
 * 実測でも「引き返すプラン」がこの形で出ていた。
 *
 * 自船 → waypoint 列の各線分について、接触までの最短距離を測る。
 *
 * @param {{self:{eastM:number,northM:number}, waypoints:Array<{eastM:number,northM:number}>,
 *   contacts:Array<{id?:string, eastM:number, northM:number}>}} input
 * @returns {{minDistanceM:number, worst:{contactId:string|null, legIndex:number}|null}}
 */
export function planClearance({ self, waypoints, contacts }) {
  if (!Array.isArray(waypoints) || waypoints.length === 0 || !contacts?.length) {
    return { minDistanceM: Infinity, worst: null };
  }
  let best = Infinity;
  let worst = null;
  const points = [self, ...waypoints];
  for (let leg = 0; leg < points.length - 1; leg++) {
    const a = points[leg];
    const b = points[leg + 1];
    const dx = b.eastM - a.eastM;
    const dy = b.northM - a.northM;
    const len2 = dx * dx + dy * dy;
    for (const c of contacts) {
      let t = len2 < 1e-9 ? 0 : ((c.eastM - a.eastM) * dx + (c.northM - a.northM) * dy) / len2;
      t = clamp(t, 0, 1);
      const px = a.eastM + dx * t;
      const py = a.northM + dy * t;
      const d = Math.hypot(c.eastM - px, c.northM - py);
      if (d < best) {
        best = d;
        worst = { contactId: c.id ?? null, legIndex: leg };
      }
    }
  }
  return { minDistanceM: best, worst };
}
