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
 * レーダー接触に匿名の表示名（TRK-01, TRK-02 …）を割り当てる。
 *
 * 【なぜ必要か】シナリオのエンティティ id はそのままでは**答えを漏らす**。
 * 2026-09-06 の実測プロンプトには `- traffic-cross: range 36 m, ...` と出ており、
 * モデルは名前を読むだけで「横切る船」だと分かってしまう——画像もレーダーの幾何も見ずに
 * 正解できるので、「VLM が何を根拠に判断したか」を測れなくなる。
 * `vlm-multi-agent-plan.md` §3 が指揮官側のトラック id について同じ穴を指摘しており
 * （「トラック名を読むだけで艦種が分かる」）、単艦側にも同じ穴が空いていた。
 *
 * 【初出順に振る】距離順にすると、同じ船の名前が接近・離脱で入れ替わってしまい、
 * サイクルを跨いだ参照（「さっき言った TRK-01」）が成立しない。
 * 状態を持つのはこのためで、エピソード開始時に reset() する
 * （`SplineTraffic` / `BoatController` と同じ作法）。
 *
 * 真の id は picture の `trueId` に残す——**プロンプトには出さないが、
 * 実験ログでは真値と照合できる**必要があるため（消してしまうと正解率が測れない）。
 */
export class TrackNamer {
  constructor({ prefix = 'TRK' } = {}) {
    this.prefix = prefix;
    /** @type {Map<string, string>} 真の id -> 表示名 */
    this.names = new Map();
  }

  /** エピソード開始時。跨いだ対応を残さない（前エピソードの TRK-01 と混ざる） */
  reset() {
    this.names.clear();
  }

  /** @param {string} trueId @returns {string} 表示名（初出なら発番する） */
  nameFor(trueId) {
    const existing = this.names.get(trueId);
    if (existing) return existing;
    const label = `${this.prefix}-${String(this.names.size + 1).padStart(2, '0')}`;
    this.names.set(trueId, label);
    return label;
  }

  /** 表示名 → 真の id（実験ログで真値と照合するため） */
  trueIdOf(label) {
    for (const [trueId, name] of this.names) if (name === label) return trueId;
    return null;
  }
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
  {
    destination,
    plan = [],
    arrivalM = DEFAULT_ARRIVAL_RADIUS_M,
    image = null,
    episode = null,
    /**
     * 接触の表示名を発番する TrackNamer。省略すると真の id がそのままプロンプトへ出る
     * （＝答えが漏れる）。実験では必ず渡すこと。省略を許してあるのは、
     * 既存の呼び出し・テストを壊さないためだけである。
     */
    trackNamer = null,
    /**
     * トラックストア（`fuse_tracks.js`）。渡すと匿名化に加えて**相手の針路・速力の推定**が
     * picture に載る。`avoidance.js` は相手が動くことを知らないと避けられない
     * （実測: 静止扱いのままだと生成プランの離隔不足が6エピソードで21件）。
     * `trackNamer` より優先される。
     */
    trackStore = null,
  } = {}
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
  const rawContacts = radar?.contacts ?? [];
  // トラック化（匿名化＋速度推定）。渡されていなければ従来どおり
  const fused = trackStore
    ? trackStore.observe(
        rawContacts.map((c) => ({
          id: c.id,
          eastM: self.eastM + Math.cos(c.bearingRad) * c.rangeM,
          northM: self.northM + Math.sin(c.bearingRad) * c.rangeM,
        })),
        world.clock
      )
    : null;
  const contacts = rawContacts.map((c, idx) => {
    const bearingDeg = (c.bearingRad * 180) / Math.PI;
    const rel = wrapDeg(bearingDeg - self.headingDeg);
    const track = fused ? fused[idx] : null;
    return {
      // プロンプトに出るのはこちら（匿名）。ストア/namer 無しのときだけ真の id が出る
      id: track ? track.id : trackNamer ? trackNamer.nameFor(c.id) : c.id,
      /** 真の id。**プロンプトには出さない**が、実験ログで真値と照合するために残す */
      trueId: c.id,
      /** 推定した相手の針路・速力（レーダーは点しか返さないので有限差分の推定値。null もある） */
      courseDeg: track ? track.courseDeg : null,
      speedMps: track ? track.speedMps : null,
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
 * 機動選択アーム（`vlm-watch`）のシステムプロンプト。
 *
 * **座標を作らせない。** VLM には「どの相手を・どちら側に見て・どれだけ離して通るか」だけを
 * 選ばせ、waypoint は `avoidance.js` が CPA から生成する。
 * 2026-09-06 の実測で、座標を出力させると**危険と報告した相手の座標をそのまま waypoint に
 * 書き写す**（採用24点中6点）ことが分かったため、その作業自体を取り上げる
 * （docs/perception-to-waypoint-flow.md §4 の H2）。
 *
 * 語彙は船乗りのもの（相手がどちらに見えるか）にしてある。幾何の解釈は avoidance.js が持つ。
 */
export function buildWatchSystemPrompt({ intervalS, latencyS, offsetRange, arrivalAware = true }) {
  if (!Number.isFinite(intervalS) || !Number.isFinite(latencyS)) {
    throw new TypeError('buildWatchSystemPrompt: intervalS and latencyS are required numbers');
  }
  const { min, max, dflt } = offsetRange;
  return [
    'You are the lookout of an uncrewed surface vessel (ASV) in coastal water.',
    'Each cycle you get own-ship state, radar contacts, the destination, the current route plan,',
    'and (unless stated otherwise) the forward bridge camera image.',
    'Heading is degrees, 0 = east, counter-clockwise (90 = north).',
    `You decide every ${intervalS} s, and your decision takes ${latencyS} s to take effect.`,
    'You do NOT plan coordinates. You only say what to do about what you see;',
    'the ship computes the route itself.',
    'Reply with ONE JSON object and nothing else:',
    '{"watch": "<one line: the hazard you see, or none>",',
    ' "maneuver": "hold" | "pass_port" | "pass_starboard" | "slow" | "stop",',
    ' "targetTrack": "<the track id this is about, or empty>",',
    ` "offsetM": <how far to keep clear, ${min}-${max}, default ${dflt}>,`,
    ' "speed": "stop" | "slow" | "cruise"}',
    '"pass_port" means you keep the contact on your PORT side as you pass it;',
    '"pass_starboard" means you keep it on your STARBOARD side.',
    'Use "hold" when nothing needs avoiding — that is the normal answer in open water.',
    // A1-(3): 到達と離隔のトレードオフを明示する。2026-09-06 の実測で、避けることだけを
    // 求めた結果 6エピソード中2本が経路長比 1.84 で目的地へ着かなかった（避けすぎて着かない）。
    // 距離の情報は状況図に既にあるが、それが**コストである**ことは言っていなかった。
    ...(arrivalAware
      ? [
          'You must also arrive. A detour costs distance, so choose the SMALLEST offset that',
          'keeps you clear, and choose "hold" when the contact will pass clear on its own.',
        ]
      : []),
  ].join('\n');
}

/**
 * 状況図をプロンプト本文へ。
 *
 * @param {ReturnType<typeof buildNavigatorPicture>} picture
 * @param {{expectBoatId?:string|null, withContactCoordinates?:boolean}} [options]
 *   expectBoatId: 艇の取り違えを推論より前に止める（他艇の視界で判断させると、
 *     返る指示は well-formed なまま別の艇のものになる。boat_agent.js と同じ守り）
 *   withContactCoordinates: 接触の絶対座標を書くか。既定 true（実測済みの `vlm-plan` アームの
 *     プロンプトを1文字も変えないため）。`vlm-watch` アームは座標を必要としないので false にする
 *     ——**渡さなければ書き写せない**（H1 の仮説をアームの設計として内包する）
 */
export function renderNavigatorPictureText(
  picture,
  { expectBoatId = null, withContactCoordinates = true } = {}
) {
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
        `  - ${c.id}: range ${fmt(c.rangeM)} m, relative bearing ${fmt(c.relBearingDeg)} deg (${c.relative})` +
          (withContactCoordinates ? `, at east=${fmt(c.eastM)}, north=${fmt(c.northM)}` : '')
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
