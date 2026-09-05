/**
 * navigator_picture.js — VLM航海士に見せる状況図（単艦・視覚航行）
 *
 * 位置づけ: docs/l1-vlm-navigator-plan.md §4「入出力契約」の入力側。指揮官の統合図
 * （command/fused_picture.js）が「陣営の目を融合した数秒古い図」なのに対し、こちらは
 * **1隻ぶんの、今この瞬間の知覚**である。融合もトラック化も陣営もない。
 *
 * 【座標の正典はシーン原点基準の east/north (m)】（計画 §4）
 * 自船相対にすると船が動いた瞬間にプランが腐る。ただし自船位置は EntityState を直読みせず
 * **GNSS の読み値 lat/lon を projection.latLonToLocal で戻して**使う——センサー由来である
 * ことを保つためで、将来 GNSS に誤差モデルを入れたときここが自動的にその影響を受ける。
 *
 * 【針路の向きは数学系（0=東・反時計回り）】
 * fused_picture.js の統合図は方位角（0=北・時計回り）を使うが、こちらは数学系のままにする。
 * 2026-08-30 の閉ループ実測（l1-vlm-closed-loop-smoke）が通ったプロンプトがこの系で書かれており、
 * 表記を変えることは「プロンプトの変更」そのものだからである。L0 で善意の1行追加が
 * 死んだ waypoint 率を 80.9%→98.3% に悪化させた実績がある以上、移植では表記を変えない
 * （変えるなら §6 の挙動指標つきで1回に1つ）。
 */

/** 到達半径の既定。この距離まで詰めたら「その waypoint は通過した」とみなす */
export const DEFAULT_ARRIVAL_RADIUS_M = 40;

/** [-180, 180) へ畳む */
export function wrapDeg(deg) {
  return ((((deg + 180) % 360) + 360) % 360) - 180;
}

/**
 * 相対方位を船乗りの言い方へ。VLM が画像で見ているもの（左舷/右舷/正面）と
 * レーダーのテキストを突き合わせられるようにするための語彙で、これが無いと
 * 「画像の右に見える船」と「相対方位 -40 度の点」が同じものだと分からない。
 */
export function relativeSide(relBearingDeg) {
  const b = wrapDeg(relBearingDeg);
  if (Math.abs(b) <= 15) return 'dead ahead';
  if (b > 15 && b <= 112.5) return 'on the port bow / port side';
  if (b < -15 && b >= -112.5) return 'on the starboard bow / starboard side';
  return 'astern';
}

function fmt(n) {
  return String(Math.round(n));
}

/**
 * 単艦の状況図を作る。**発行時刻のスナップショット**であり、以後世界が進んでも更新しない
 * （docs/time-model.md I3）。
 *
 * @param {import('../world.js').World} world
 * @param {string} boatId
 * @param {{destination:{eastM:number, northM:number}, plan?:Array<{eastM:number,northM:number}>,
 *   arrivalM?:number, image?:string|null, episode?:number|null}} options
 *   image: ブリッジ一人称の PNG data URL。null なら画像なし（blind アーム／画像が撮れなかったとき）
 * @returns {object} 状況図（純データ。World への参照を持たない＝発行後に世界が動いても図は変わらない）
 */
export function buildNavigatorPicture(
  world,
  boatId,
  { destination, plan = [], arrivalM = DEFAULT_ARRIVAL_RADIUS_M, image = null, episode = null } = {}
) {
  const i = world.state.indexOf(boatId);
  if (i < 0) throw new Error(`buildNavigatorPicture: unknown boat "${boatId}"`);
  if (!destination || !Number.isFinite(destination.eastM) || !Number.isFinite(destination.northM)) {
    throw new Error('buildNavigatorPicture: destination {eastM, northM} is required');
  }

  // 自船は GNSS 経由。EntityState の x/y を直読みしない（上のコメント参照）
  const gnss = world.observe(boatId, 'gnss');
  const local = world.scene.projection.latLonToLocal(gnss.lat, gnss.lon);
  const self = {
    eastM: local.x,
    northM: local.y,
    headingDeg: gnss.headingDeg,
    speedMps: gnss.speedMps,
  };

  const dx = destination.eastM - self.eastM;
  const dy = destination.northM - self.northM;
  const destBearingDeg = (Math.atan2(dy, dx) * 180) / Math.PI;

  const radar = world.observe(boatId, 'radar');
  const contacts = (radar?.contacts ?? []).map((c) => {
    const bearingDeg = (c.bearingRad * 180) / Math.PI;
    const rel = wrapDeg(bearingDeg - self.headingDeg);
    return {
      id: c.id,
      rangeM: c.rangeM,
      relBearingDeg: rel,
      relative: relativeSide(rel),
      eastM: self.eastM + Math.cos(c.bearingRad) * c.rangeM,
      northM: self.northM + Math.sin(c.bearingRad) * c.rangeM,
    };
  });

  return {
    boatId,
    t: world.clock,
    episode,
    self,
    destination: {
      eastM: destination.eastM,
      northM: destination.northM,
      rangeM: Math.hypot(dx, dy),
      bearingDeg: destBearingDeg,
      relative: relativeSide(destBearingDeg - self.headingDeg),
    },
    arrivalM,
    plan: plan.map((w) => ({ eastM: w.eastM, northM: w.northM })),
    radar: { rangeM: radar?.rangeM ?? null, contacts },
    imageDataUrl: image,
    bounds: world.scene.bounds
      ? {
          minX: world.scene.bounds.minX,
          maxX: world.scene.bounds.maxX,
          minY: world.scene.bounds.minY,
          maxY: world.scene.bounds.maxY,
        }
      : null,
  };
}

/**
 * 航海士のシステムプロンプト。
 *
 * `keep` を第一級にしてあるのが要（計画 §4）。L0 の教訓「`move_to` の 80.9% が同一座標の
 * 再送＝死んだ waypoint」への直接の対策で、**プランを変えないなら waypoints を書き直させない**。
 *
 * 【2026-08-30 実測プロンプトからの差分は1点だけ】
 * scripts/vlm_navigator_run.js の NAV_SYSTEM をそのまま移し、判断間隔と発効遅延を告げる1行
 * （boat_agent.js が指揮官・艇で既にやっているのと同じ文）だけを足した。これは移植に伴って
 * 実際に挙動が変わった箇所——旧ランナーはプランを発行と同時に適用していたが、本実装は
 * DecisionScheduler 経由で latencyS 後に発効する——を告げるもので、告げないと
 * 「モデルが知らされていない遅延」になる。それ以外の字句は動かしていない。
 * L0 で善意の1行追加が死んだ waypoint 率を 80.9%→98.3% に悪化させているので、
 * 以降の変更は必ず1回に1つ・挙動指標つきで行うこと（計画 §5）。
 *
 * @param {{intervalS:number, latencyS:number}} options
 */
export function buildNavigatorSystemPrompt({ intervalS, latencyS }) {
  if (!Number.isFinite(intervalS) || !Number.isFinite(latencyS)) {
    throw new TypeError('buildNavigatorSystemPrompt: intervalS and latencyS are required numbers');
  }
  return [
    'You are the navigator of an uncrewed surface vessel (ASV) in coastal water.',
    'Each cycle you get own-ship state, radar contacts, the destination, the current route plan,',
    'and (unless stated otherwise) the forward bridge camera image.',
    'Coordinates are metres in a fixed scene frame: east = +x, north = +y.',
    'Heading is degrees, 0 = east, counter-clockwise (90 = north).',
    `You decide every ${intervalS} s, and your decision takes ${latencyS} s to take effect.`,
    'Reply with ONE JSON object and nothing else:',
    '{"watch": "<one line: the hazard you see, or none>",',
    ' "action": "keep" | "replace",',
    ' "waypoints": [{"eastM": <number>, "northM": <number>}],',
    ' "speed": "stop" | "slow" | "cruise"}',
    'Use "keep" when the current plan is still safe; then waypoints must be [].',
    'Use "replace" only to change the route: 1-3 waypoints in order, absolute scene metres,',
    'never your own current position, and the last one at the destination.',
  ].join('\n');
}

/**
 * 状況図をプロンプト本文へ。
 *
 * @param {ReturnType<typeof buildNavigatorPicture>} picture
 * @param {{expectBoatId?:string|null}} [options] - 艇の取り違えを推論より前に止める
 *   （他艇の視界で判断させると、返る指示は well-formed なまま別の艇のものになる。boat_agent.js と同じ守り）
 */
export function renderNavigatorPictureText(picture, { expectBoatId = null } = {}) {
  if (expectBoatId !== null && picture?.boatId !== expectBoatId) {
    throw new Error(
      `renderNavigatorPictureText: picture is for "${picture?.boatId}", not "${expectBoatId}"`
    );
  }
  const { self, destination, radar } = picture;
  const lines = [];
  lines.push(`Time: t=${picture.t.toFixed(1)} s`);
  lines.push(
    `Own ship (GNSS): east=${fmt(self.eastM)} m, north=${fmt(self.northM)} m, ` +
      `heading=${fmt(self.headingDeg)} deg, speed=${self.speedMps.toFixed(1)} m/s`
  );
  lines.push(
    `Destination: east=${fmt(destination.eastM)} m, north=${fmt(destination.northM)} m ` +
      `(range ${fmt(destination.rangeM)} m, ${destination.relative}), arrival radius ${picture.arrivalM} m`
  );
  if (radar.contacts.length === 0) {
    lines.push('Radar: no contacts.');
  } else {
    lines.push(`Radar (range ${fmt(radar.rangeM)} m):`);
    for (const c of radar.contacts) {
      lines.push(
        `  - ${c.id}: range ${fmt(c.rangeM)} m, relative bearing ${fmt(c.relBearingDeg)} deg ` +
          `(${c.relative}), at east=${fmt(c.eastM)}, north=${fmt(c.northM)}`
      );
    }
  }
  lines.push('Land: the coast runs along the north side of the area. Open water is to the south.');
  lines.push(
    `Current plan: ${picture.plan.length ? picture.plan.map((p) => `(${fmt(p.eastM)},${fmt(p.northM)})`).join(' -> ') : '(none)'}`
  );
  lines.push(
    picture.imageDataUrl
      ? 'The attached image is the bridge camera looking straight ahead over the bow.'
      : 'No camera image is available this cycle.'
  );
  lines.push('Decide now.');
  return lines.join('\n');
}
