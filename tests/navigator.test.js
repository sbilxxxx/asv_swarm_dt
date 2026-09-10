/**
 * navigator.test.js — 単艦VLM航海士（core/sim/navigator/）の回帰テスト
 *
 * tests/command.test.js と同じ理由で CommonJS のまま書き、core/ の ESM は
 * await import() で動的ロードする。実行: node tests/navigator.test.js
 *
 * ここで固定しているのは「実測で実際に踏んだ穴」である:
 *   - llm_http.js に images を足しても、画像なしの body が1バイトも変わらないこと
 *     （変わると L0 の 1,554 コールの実測と比較できなくなる）
 *   - 2026-08-14 / 08-30 の VLM が返した退化（自船位置の混入・同一点の3連・順序の崩れ）を
 *     サニタイズが落とし、**落としたことを数えている**こと
 *   - 推論が落ちてもプランが維持され、船が走り続けること
 *   - stages:[render, infer] の合成値どおりに発効すること（time-model.md §12.5 の初の実使用者）
 *
 * ネットワークは一切使わない（fetchImpl を差し替える）。
 */
'use strict';

const assert = require('node:assert');

async function loadCore() {
  const { World } = await import('../core/sim/world.js');
  const { createOriginProjection } = await import('../core/coord.js');
  const { DecisionScheduler } = await import('../core/sim/command/decision_scheduler.js');
  const llmHttp = await import('../core/sim/agents/llm_http.js');
  const picture = await import('../core/sim/navigator/navigator_picture.js');
  const parsePlan = await import('../core/sim/navigator/parse_plan.js');
  const follower = await import('../core/sim/navigator/plan_follower.js');
  const navigator = await import('../core/sim/navigator/vlm_navigator.js');
  const spline = await import('../core/sim/spline_path.js');
  const traffic = await import('../core/sim/traffic.js');
  const ctxBudget = await import('../core/sim/agents/context_budget.js');
  const avoid = await import('../core/sim/navigator/avoidance.js');
  const fuse = await import('../core/sim/navigator/fuse_tracks.js');
  return { avoid, fuse, parsePlan, ctxBudget, World, createOriginProjection, DecisionScheduler, llmHttp, picture, parsePlan, follower, navigator, spline, traffic };
}

/** projection と bounds だけを持つ最小シーン（command.test.js の minimalScene と同型） */
function minimalScene({ createOriginProjection }) {
  return {
    projection: createOriginProjection({ lat: 35.45, lon: 139.75 }),
    bounds: { minX: -600, maxX: 600, minY: -600, maxY: 600 },
  };
}

/** 応答を固定で返す fetch。送った body を requests に貯める */
function fixtureFetch(replies, requests) {
  let i = 0;
  return async (url, init) => {
    requests.push({ url, body: JSON.parse(init.body), init });
    const reply = replies[Math.min(i, replies.length - 1)];
    i += 1;
    if (typeof reply === 'function') return reply();
    return {
      ok: true,
      status: 200,
      json: async () => ({
        choices: [{ message: { content: reply }, finish_reason: 'stop' }],
        usage: { completion_tokens: 42 },
      }),
    };
  };
}

const TINY_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const TINY_PNG_DATA_URL = `data:image/png;base64,${TINY_PNG_BASE64}`;

// ---------------------------------------------------------------------------

async function testLlmHttpImagesAreBackwardCompatible(core) {
  const { postChatCompletion, LLM_TRANSPORTS } = core.llmHttp;

  const bodies = [];
  const capture = async (url, init) => {
    bodies.push(init.body);
    // OpenAI 互換と Ollama ネイティブの両方の読み口を満たす形（transport を切り替えても読める）
    return {
      ok: true,
      status: 200,
      json: async () => ({ choices: [{ message: { content: 'ok' } }], message: { content: 'ok' } }),
    };
  };
  const base = {
    baseUrl: 'http://x/v1',
    model: 'm',
    systemPrompt: 'S',
    userPrompt: 'U',
    fetchImpl: capture,
  };

  await postChatCompletion({ ...base });
  await postChatCompletion({ ...base, images: null });
  await postChatCompletion({ ...base, images: [] });
  assert.strictEqual(bodies[0], bodies[1], 'images:null must produce a byte-identical body');
  assert.strictEqual(bodies[0], bodies[2], 'images:[] must produce a byte-identical body');
  assert.ok(!bodies[0].includes('image'), 'no image key at all when there is no image');

  // OpenAI 互換: content が配列になり image_url が入る
  await postChatCompletion({ ...base, images: [TINY_PNG_DATA_URL] });
  const openai = JSON.parse(bodies[3]);
  assert.strictEqual(openai.messages[0].content, 'S', 'system message stays a plain string');
  assert.ok(Array.isArray(openai.messages[1].content), 'user content becomes an array');
  assert.deepStrictEqual(openai.messages[1].content[0], { type: 'text', text: 'U' });
  assert.strictEqual(openai.messages[1].content[1].type, 'image_url');
  assert.strictEqual(openai.messages[1].content[1].image_url.url, TINY_PNG_DATA_URL);

  // Ollama ネイティブ: messages[].images に接頭辞を外した base64
  await postChatCompletion({
    ...base,
    baseUrl: 'http://x',
    transport: LLM_TRANSPORTS.OLLAMA,
    images: [TINY_PNG_DATA_URL],
  });
  const ollama = JSON.parse(bodies[4]);
  assert.strictEqual(ollama.messages[1].content, 'U', 'ollama keeps content a string');
  assert.deepStrictEqual(ollama.messages[1].images, [TINY_PNG_BASE64], 'ollama gets bare base64, not a data URL');

  // 生の base64 を渡しても OpenAI 側では data URL に包まれる
  await postChatCompletion({ ...base, images: [TINY_PNG_BASE64] });
  assert.strictEqual(JSON.parse(bodies[5]).messages[1].content[1].image_url.url, TINY_PNG_DATA_URL);

  // 設定ミスは失敗モードではなく呼び出し側のバグ＝素直に throw（llm_http.js の契約）
  await assert.rejects(() => postChatCompletion({ ...base, images: 'not-an-array' }), TypeError);
  await assert.rejects(() => postChatCompletion({ ...base, images: [''] }), TypeError);

  console.log('OK: llm_http images are opt-in and byte-compatible when absent');
}

async function testNavigatorPictureIsSensorDerivedAndInterlocked(core) {
  const scene = minimalScene(core);
  const world = new core.World({ scene, capacity: 3, radarRangeM: 600 });
  world.spawn({ id: 'nav-1', faction: 'defender', platform: 'asv', x: 100, y: -50, heading: 0 }); // 東を向く
  world.spawn({ id: 'traffic', faction: 'neutral', platform: 'asv', x: 100, y: 150, heading: 0 }); // 真北 200m
  world.clock = 12.5;

  const destination = { eastM: 400, northM: -50 };
  const pic = core.picture.buildNavigatorPicture(world, 'nav-1', {
    destination,
    plan: [{ eastM: 250, northM: -50 }, destination],
    arrivalM: 40,
    image: TINY_PNG_DATA_URL,
  });

  // 自船は GNSS 経由（lat/lon → local）なので厳密一致ではなく近似で見る
  assert.ok(Math.abs(pic.self.eastM - 100) < 0.5, `self east ${pic.self.eastM}`);
  assert.ok(Math.abs(pic.self.northM - -50) < 0.5, `self north ${pic.self.northM}`);
  assert.ok(Math.abs(pic.self.headingDeg - 0) < 1e-6, 'heading is math degrees, 0 = east');
  assert.ok(Math.abs(pic.destination.rangeM - 300) < 1, `destination range ${pic.destination.rangeM}`);
  assert.strictEqual(pic.destination.relative, 'dead ahead', '真東の目的地は正面');

  assert.strictEqual(pic.radar.contacts.length, 1);
  const c = pic.radar.contacts[0];
  assert.ok(Math.abs(c.rangeM - 200) < 1, `contact range ${c.rangeM}`);
  assert.ok(Math.abs(c.relBearingDeg - 90) < 1, `relative bearing ${c.relBearingDeg}`);
  assert.strictEqual(c.relative, 'on the port bow / port side', '東を向いた船から見た真北は左舷');

  const text = core.picture.renderNavigatorPictureText(pic, { expectBoatId: 'nav-1' });
  // namer 無しでは真の id がそのまま出る（既存呼び出しの後方互換）
  assert.strictEqual(pic.radar.contacts[0].id, 'traffic');
  assert.strictEqual(pic.radar.contacts[0].trueId, 'traffic');
  assert.match(text, /Own ship \(GNSS\): east=100 m, north=-50 m/);
  assert.match(text, /Destination: east=400 m, north=-50 m \(range 300 m, dead ahead\), arrival radius 40 m/);
  assert.match(text, /- traffic: range 200 m, relative bearing 90 deg/);
  assert.match(text, /Current plan: \(250,-50\) -> \(400,-50\)/);
  assert.match(text, /The attached image is the bridge camera/);

  // 画像なしのときは1行だけ変わる。統制群（blind）の公平性はこの1行差が全て
  const blind = core.picture.buildNavigatorPicture(world, 'nav-1', { destination, plan: [destination] });
  const blindText = core.picture.renderNavigatorPictureText(blind);
  assert.match(blindText, /No camera image is available this cycle\./);
  // 「画像について述べた1行」と「プランの行（テスト側で別に与えている）」を除くと完全一致するはず
  const withoutImageLine = (t) =>
    t.split('\n').filter((l) => !l.startsWith('Current plan') && !/camera/.test(l)).join('\n');
  assert.strictEqual(
    withoutImageLine(text),
    withoutImageLine(blindText),
    'vlm と blind のプロンプトは画像の1行以外は同一でなければならない'
  );
  assert.strictEqual(text.split('\n').length, blindText.split('\n').length, '行数も同じ（差は1行の中身だけ）');

  // 艇の取り違えは推論より前に止める
  assert.throws(() => core.picture.renderNavigatorPictureText(pic, { expectBoatId: 'someone-else' }), /not "someone-else"/);

  console.log('OK: navigator picture is GNSS/radar derived and boat-interlocked');
}

/**
 * H0: 接触idの匿名化。2026-09-06 の実測プロンプトに `traffic-cross` という名前が出ており、
 * **モデルは名前を読むだけで「横切る船」だと分かってしまう**——画像もレーダーの幾何も見ずに
 * 正解できるので、何を根拠に判断したかが測れなくなる。名前が漏らす情報を塞ぐ。
 */
async function testTrackNamerAnonymisesContactIds(core) {
  const { TrackNamer, buildNavigatorPicture, renderNavigatorPictureText } = core.picture;
  const scene = minimalScene(core);
  const world = new core.World({ scene, capacity: 4, radarRangeM: 600 });
  world.spawn({ id: 'pilot-1', faction: 'defender', platform: 'asv', x: 0, y: 0, heading: 0 });
  world.spawn({ id: 'traffic-cross', faction: 'traffic', platform: 'asv', x: 200, y: 0, heading: 0 });
  world.spawn({ id: 'traffic-slow', faction: 'traffic', platform: 'asv', x: 0, y: 150, heading: 0 });

  const namer = new TrackNamer();
  const destination = { eastM: 400, northM: 0 };
  const pic = buildNavigatorPicture(world, 'pilot-1', { destination, plan: [destination], trackNamer: namer });
  const text = renderNavigatorPictureText(pic);

  // **プロンプトに意味を持つ名前が出ない**（これが受入条件）
  assert.ok(!text.includes('traffic-cross'), 'シナリオの id がプロンプトへ漏れてはいけない');
  assert.ok(!text.includes('traffic-slow'), 'シナリオの id がプロンプトへ漏れてはいけない');
  assert.match(text, /TRK-01/);
  assert.match(text, /TRK-02/);

  // 真値との照合はできる（消すと正解率が測れない）
  const byLabel = new Map(pic.radar.contacts.map((c) => [c.id, c.trueId]));
  assert.strictEqual(byLabel.get('TRK-01'), 'traffic-cross', '初出順に振る');
  assert.strictEqual(byLabel.get('TRK-02'), 'traffic-slow');
  assert.strictEqual(namer.trueIdOf('TRK-02'), 'traffic-slow');

  // 同じ船はサイクルを跨いでも同じ名前（距離順だと接近・離脱で入れ替わり、参照が壊れる）
  world.state.x[world.state.indexOf('traffic-cross')] = 500; // 遠ざかる＝距離順なら2番目になる
  const later = buildNavigatorPicture(world, 'pilot-1', { destination, plan: [destination], trackNamer: namer });
  const stable = new Map(later.radar.contacts.map((c) => [c.trueId, c.id]));
  assert.strictEqual(stable.get('traffic-cross'), 'TRK-01', '名前は初出時のまま固定される');

  // エピソードを跨いだ対応は残さない
  namer.reset();
  assert.strictEqual(namer.nameFor('whatever'), 'TRK-01');

  console.log('OK: track ids are anonymised in the prompt while the truth stays for scoring');
}

async function testParsePlanSanitizesTheMeasuredDegenerations(core) {
  const { parseNavigatorPlan, PLAN_NOTES } = core.parsePlan;
  const pic = {
    self: { eastM: 0, northM: 0 },
    destination: { eastM: 400, northM: 0 },
    bounds: { minX: -600, maxX: 600, minY: -600, maxY: 600 },
  };

  // keep が既定。```json フェンスも剥がす
  const keep = parseNavigatorPlan('```json\n{"watch":"none","action":"keep","waypoints":[],"speed":"cruise"}\n```', {
    picture: pic,
  });
  assert.strictEqual(keep.action, 'keep');
  assert.strictEqual(keep.waypoints, null);
  assert.strictEqual(keep.watch, 'none');
  assert.strictEqual(keep.speed, 'cruise');

  // 2026-08-14 の退化: 自船位置(0,0)の混入
  const withSelf = parseNavigatorPlan(
    '{"action":"replace","waypoints":[{"eastM":0,"northM":0},{"eastM":200,"northM":120},{"eastM":400,"northM":0}]}',
    { picture: pic }
  );
  assert.strictEqual(withSelf.action, 'replace');
  assert.deepStrictEqual(withSelf.waypoints, [
    { eastM: 200, northM: 120 },
    { eastM: 400, northM: 0 },
  ]);
  assert.ok(withSelf.notes.includes(PLAN_NOTES.OWN_POSITION), '落としたことが notes に残る');

  // 2026-08-30 の退化: 目的地と同じ点を3つ並べる
  const tripled = parseNavigatorPlan(
    '{"action":"replace","waypoints":[{"eastM":400,"northM":0},{"eastM":400,"northM":0},{"eastM":400,"northM":0}]}',
    { picture: pic }
  );
  assert.deepStrictEqual(tripled.waypoints, [{ eastM: 400, northM: 0 }]);
  assert.strictEqual(tripled.notes.filter((n) => n === PLAN_NOTES.DUPLICATE).length, 2, '畳んだ回数まで数える');

  // 運用領域の外はクランプし、目的地で終わらないプランには目的地を足す
  const wild = parseNavigatorPlan('{"action":"replace","waypoints":[{"eastM":99999,"northM":-99999}]}', {
    picture: pic,
  });
  assert.deepStrictEqual(wild.waypoints, [
    { eastM: 600, northM: -600 },
    { eastM: 400, northM: 0 },
  ]);
  assert.ok(wild.notes.includes(PLAN_NOTES.CLAMPED));
  assert.ok(wild.notes.includes(PLAN_NOTES.DESTINATION_APPENDED));

  // 使える点が1つも残らなければ keep。プランは壊さない
  const empty = parseNavigatorPlan('{"action":"replace","waypoints":[{"eastM":"あ","northM":null}]}', { picture: pic });
  assert.strictEqual(empty.action, 'keep');
  assert.ok(empty.notes.includes(PLAN_NOTES.NON_NUMERIC));
  assert.ok(empty.notes.includes(PLAN_NOTES.NO_USABLE));

  // JSON が無ければ keep（例外にしない）
  const junk = parseNavigatorPlan('I think we should probably head east.', { picture: pic });
  assert.strictEqual(junk.action, 'keep');
  assert.deepStrictEqual(junk.notes, [PLAN_NOTES.UNPARSABLE]);
  assert.strictEqual(junk.parsed, null);

  // 2026-09-06 実測: レーダー接触の座標をそのまま waypoint にしてくる（危険へ舵を向ける）
  const withContacts = {
    self: { eastM: 0, northM: 0 },
    destination: { eastM: 400, northM: 0 },
    bounds: { minX: -600, maxX: 600, minY: -600, maxY: 600 },
    radar: { rangeM: 600, contacts: [{ id: 'traffic-cross', eastM: 200, northM: 10, rangeM: 200 }] },
  };
  const ontoContact = parseNavigatorPlan(
    '{"action":"replace","waypoints":[{"eastM":200,"northM":10},{"eastM":400,"northM":0}]}',
    { picture: withContacts }
  );
  assert.deepStrictEqual(ontoContact.waypoints, [{ eastM: 400, northM: 0 }], '接触の上の点は落ちる');
  assert.ok(ontoContact.notes.includes(PLAN_NOTES.ON_CONTACT));
  // 接触から十分離れていれば通す（迂回点はコード側で作らない＝落とすだけ）
  const beside = parseNavigatorPlan(
    '{"action":"replace","waypoints":[{"eastM":200,"northM":-90},{"eastM":400,"northM":0}]}',
    { picture: withContacts }
  );
  assert.strictEqual(beside.waypoints.length, 2);
  assert.ok(!beside.notes.includes(PLAN_NOTES.ON_CONTACT));

  // 引き返すプランは「数えるが落とさない」。2026-09-05 のブラウザ実測で
  // (dest) -> (中間点) -> (dest) の形が実際に出た（08-14 の「順序逆転」の再現）
  const doublesBack = parseNavigatorPlan(
    '{"action":"replace","waypoints":[{"eastM":400,"northM":0},{"eastM":150,"northM":-100}]}',
    { picture: pic }
  );
  assert.strictEqual(doublesBack.action, 'replace');
  assert.strictEqual(doublesBack.waypoints.length, 3, '点は1つも落とさない（目的地の追加で3点）');
  assert.ok(doublesBack.notes.includes(PLAN_NOTES.DOUBLES_BACK));
  // 手前から順に並んだプランには付かない
  const ordered = parseNavigatorPlan(
    '{"action":"replace","waypoints":[{"eastM":150,"northM":-100},{"eastM":400,"northM":0}]}',
    { picture: pic }
  );
  assert.ok(!ordered.notes.includes(PLAN_NOTES.DOUBLES_BACK));

  // 引用符付き数値（モデルがよくやる）は受ける
  const quoted = parseNavigatorPlan('{"action":"replace","waypoints":[{"eastM":"200","northM":"120"}]}', {
    picture: pic,
  });
  assert.strictEqual(quoted.waypoints[0].eastM, 200);

  console.log('OK: parse_plan drops the measured degenerations and counts what it dropped');
}

async function testRoutePlanFollowsWaypointsAndArrives(core) {
  const { RoutePlan, applyPlanOrder } = core.follower;
  const destination = { eastM: 400, northM: 0 };

  // 既定は目的地への直行＝推論が1度も来なくても成立するプラン
  const direct = new RoutePlan({ destination, arrivalM: 40 });
  assert.deepStrictEqual(direct.snapshot(), [destination]);
  assert.deepStrictEqual(direct.currentOrder(), { action: 'move_to', waypointWorld: { x: 400, y: 0 } });

  const plan = new RoutePlan({
    destination,
    arrivalM: 40,
    waypoints: [{ eastM: 100, northM: 0 }, { eastM: 250, northM: 0 }, destination],
  });
  assert.strictEqual(plan.advance({ eastM: 0, northM: 0 }), 0, '遠いうちは進まない');
  assert.strictEqual(plan.advance({ eastM: 110, northM: 0 }), 1, '到達半径に入った点を落とす');
  assert.strictEqual(plan.currentTarget().eastM, 250);
  assert.strictEqual(plan.advance({ eastM: 260, northM: 0 }), 1, '次の点も到達半径に入れば続けて落ちる');
  assert.deepStrictEqual(plan.snapshot(), [destination], '最後の1点（目的地）は残る');
  // 通過判定は距離だけ。行き過ぎた点は落ちない（実測プロトタイプと同じ意味論。plan_follower.js の注記参照）
  const overshot = new RoutePlan({ destination, arrivalM: 40, waypoints: [{ eastM: 250, northM: 0 }, destination] });
  assert.strictEqual(overshot.advance({ eastM: 400, northM: 0 }), 0, '大きく行き過ぎた waypoint は落とさない');
  assert.ok(plan.hasArrived({ eastM: 380, northM: 0 }));
  assert.ok(!plan.hasArrived({ eastM: 300, northM: 0 }));

  // 空・不正な差し替えは現行プランを維持する（黙って直行へ戻さない）
  assert.strictEqual(plan.setWaypoints([]), false);
  assert.strictEqual(plan.setWaypoints(null), false);
  assert.strictEqual(plan.setWaypoints([{ eastM: NaN, northM: 3 }]), false);
  assert.deepStrictEqual(plan.snapshot(), [destination]);

  // World への書き込みは指揮官の指示と同じ形（BoatController が無変更で追従する）
  const scene = minimalScene(core);
  const world = new core.World({ scene, capacity: 2 });
  world.spawn({ id: 'nav-1', faction: 'defender', platform: 'asv', x: 0, y: 0, heading: 0 });
  const fresh = new RoutePlan({ destination, arrivalM: 40, waypoints: [{ eastM: 200, northM: 100 }, destination] });
  const applied = applyPlanOrder(world, 'nav-1', fresh);
  assert.deepStrictEqual(world.orders.get('nav-1'), { action: 'move_to', waypointWorld: { x: 200, y: 100 } });
  assert.strictEqual(applied.arrived, false);
  const action = world.boatController.decide(
    world.orders.get('nav-1'),
    { position: { x: 0, y: 0, heading: 0 }, radar: { contacts: [] }, timestamp: 0 },
    'nav-1',
    'defender'
  );
  assert.ok(action.throttle > 0, '既存の追従制御がそのまま指示を消化する');

  console.log('OK: route plan advances, survives bad replacements, and drives BoatController');
}

async function testVlmNavigatorSendsImageAndRecordsStats(core) {
  const requests = [];
  const decide = core.navigator.createVlmNavigatorFn({
    boatId: 'nav-1',
    intervalS: 10,
    latencyS: 2.1,
    baseUrl: 'http://x/v1',
    model: 'qwen3-vl:8b',
    fetchImpl: fixtureFetch(
      [
        '{"watch":"buoy on the port bow","action":"replace","waypoints":[{"eastM":200,"northM":-120}],"speed":"slow"}',
        '{"watch":"none","action":"keep","waypoints":[],"speed":"cruise"}',
      ],
      requests
    ),
  });
  assert.match(decide.systemPrompt, /takes 2\.1 s to take effect/);

  const pic = {
    boatId: 'nav-1',
    t: 10,
    episode: 1,
    self: { eastM: 0, northM: 0, headingDeg: 0, speedMps: 5 },
    destination: { eastM: 400, northM: 0, rangeM: 400, bearingDeg: 0, relative: 'dead ahead' },
    arrivalM: 40,
    plan: [{ eastM: 400, northM: 0 }],
    radar: { rangeM: 600, contacts: [] },
    imageDataUrl: TINY_PNG_DATA_URL,
    bounds: { minX: -600, maxX: 600, minY: -600, maxY: 600 },
  };

  const first = await decide(pic);
  assert.strictEqual(first.action, 'replace');
  assert.strictEqual(first.watch, 'buoy on the port bow');
  assert.strictEqual(first.hadImage, true);
  assert.deepStrictEqual(first.waypoints, [
    { eastM: 200, northM: -120 },
    { eastM: 400, northM: 0 }, // 目的地が足される
  ]);
  const sent = requests[0].body;
  assert.strictEqual(sent.messages[1].content[1].image_url.url, TINY_PNG_DATA_URL, '画像が実際に送られている');

  const second = await decide({ ...pic, t: 20 });
  assert.strictEqual(second.action, 'keep');
  assert.strictEqual(second.waypoints, null);

  assert.strictEqual(decide.stats.calls, 2);
  assert.strictEqual(decide.stats.replaces, 1);
  assert.strictEqual(decide.stats.keeps, 1);
  assert.strictEqual(decide.stats.keptPlans, 1);
  assert.strictEqual(decide.stats.withImage, 2);
  assert.strictEqual(decide.stats.byOutcome.replace, 1);
  assert.strictEqual(decide.stats.byOutcome.keep, 1);
  assert.strictEqual(decide.stats.totalOutputTokens, 84);

  // 画像なしなら body に画像が入らない（blind アーム）
  const blindRequests = [];
  const blind = core.navigator.createVlmNavigatorFn({
    boatId: 'nav-1',
    intervalS: 10,
    latencyS: 2.1,
    baseUrl: 'http://x/v1',
    model: 'qwen3-vl:8b',
    fetchImpl: fixtureFetch(['{"watch":"none","action":"keep","waypoints":[]}'], blindRequests),
  });
  const blindDecision = await blind({ ...pic, imageDataUrl: null });
  assert.strictEqual(blindDecision.hadImage, false);
  assert.strictEqual(typeof blindRequests[0].body.messages[1].content, 'string');
  assert.strictEqual(blind.stats.withoutImage, 1);

  console.log('OK: vlm navigator sends the image, parses the plan, and records the behaviour stats');
}

async function testVlmNavigatorKeepsThePlanOnFailure(core) {
  const pic = {
    boatId: 'nav-1',
    t: 10,
    self: { eastM: 0, northM: 0, headingDeg: 0, speedMps: 5 },
    destination: { eastM: 400, northM: 0, rangeM: 400, bearingDeg: 0, relative: 'dead ahead' },
    arrivalM: 40,
    plan: [{ eastM: 400, northM: 0 }],
    radar: { rangeM: 600, contacts: [] },
    imageDataUrl: null,
    bounds: null,
  };
  const make = (fetchImpl) =>
    core.navigator.createVlmNavigatorFn({
      boatId: 'nav-1',
      intervalS: 10,
      latencyS: 2,
      baseUrl: 'http://x/v1',
      model: 'm',
      fetchImpl,
    });

  const dead = make(async () => {
    throw new Error('ECONNREFUSED');
  });
  const onDead = await dead(pic);
  assert.strictEqual(onDead.action, 'keep', '推論が落ちてもプランは維持される');
  assert.strictEqual(onDead.outcome, 'connection');
  assert.match(onDead.failure, /ECONNREFUSED/);
  assert.strictEqual(dead.stats.transportFailures, 1);
  assert.strictEqual(dead.stats.keptPlans, 1);

  const broken = make(async () => ({
    ok: true,
    status: 200,
    json: async () => ({ choices: [{ message: { content: 'no json here' } }] }),
  }));
  const onBroken = await broken(pic);
  assert.strictEqual(onBroken.action, 'keep');
  assert.strictEqual(onBroken.outcome, 'parse');
  assert.strictEqual(broken.stats.parseFailures, 1);

  // 統制群は推論サーバ無しで必ず keep を返す
  const scripted = core.navigator.scriptedNavigator();
  const s = await scripted(pic);
  assert.strictEqual(s.action, 'keep');
  assert.strictEqual(s.outcome, 'keep');

  console.log('OK: navigator failures all fall back to keep, with a named outcome');
}

async function testNavigatorIsAStagedSchedulerDecider(core) {
  // time-model.md §12.5 のパイプライン宣言の**最初の実使用者**。
  // stages:[render, infer] が合成されて latencyS になり、発効は t_issue + 合成値 ちょうどになる。
  const scheduler = new core.DecisionScheduler();
  scheduler.register('nav-1', {
    intervalS: 10,
    stages: [
      { name: 'render', seconds: 0.1 },
      { name: 'infer', seconds: 2.0 },
    ],
  });
  assert.strictEqual(scheduler.deciders.get('nav-1').latencyS, 2.1, 'render + infer が直列合成される');

  // latencyS を併記すると設定ミスとして落ちる（ルール側の変数は単一の出所を持つ）
  assert.throws(
    () =>
      scheduler.register('bad', {
        intervalS: 10,
        latencyS: 3,
        stages: [{ name: 'render', seconds: 0.1 }, { name: 'infer', seconds: 2.0 }],
      }),
    /Declare it once/
  );

  const dt = 0.1;
  let applied = null;
  for (let step = 0; step < 60; step++) {
    const t = Number((step * dt).toFixed(6));
    for (const id of scheduler.dueToApply(t)) applied = { t, result: scheduler.takeResult(id) };
    for (const id of scheduler.dueToIssue(t)) {
      const token = scheduler.markIssued(id, t);
      scheduler.provideResult(id, { action: 'replace', waypoints: [{ eastM: 1, northM: 2 }] }, token);
    }
  }
  assert.ok(applied, 'プランが発効した');
  assert.ok(Math.abs(applied.t - 2.1) < 1e-6, `発効は t=2.1 ちょうど（実際は ${applied.t}）`);
  assert.strictEqual(applied.result.waypoints[0].eastM, 1);

  console.log('OK: navigator declares [render, infer] stages and applies at t_issue + their sum');
}

async function testSplinePathIsArcLengthParameterised(core) {
  const { SplinePath } = core.spline;

  // 直線上の制御点なら、弧長は素直に距離になる
  const line = new SplinePath([{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 200, y: 0 }]);
  assert.ok(Math.abs(line.length - 200) < 1, `直線の全長 ${line.length}`);
  const mid = line.at(100);
  assert.ok(Math.abs(mid.x - 100) < 1 && Math.abs(mid.y) < 1e-6, `中点 ${mid.x},${mid.y}`);
  assert.ok(Math.abs(mid.headingRad) < 1e-6, '東向き（heading 0）');

  // **等速性**: 弧長を等間隔で進めたとき、実際の移動距離も等間隔になる
  // （素の t で進めると制御点の間隔で速さが変わる。これを避けるためのパラメータ化）
  const curve = new SplinePath([
    { x: 0, y: 0 },
    { x: 20, y: 120 },   // 密な区間
    { x: 300, y: 160 },  // 疎な区間
    { x: 320, y: 300 },
  ]);
  const stepM = 10;
  let prev = curve.at(0);
  const deltas = [];
  for (let d = stepM; d <= curve.length; d += stepM) {
    const p = curve.at(d);
    deltas.push(Math.hypot(p.x - prev.x, p.y - prev.y));
    prev = p;
  }
  const maxDev = Math.max(...deltas.map((v) => Math.abs(v - stepM)));
  assert.ok(maxDev < stepM * 0.06, `弧長10mごとの実移動距離のばらつき ${maxDev.toFixed(2)} m`);

  // 端では止まり、clamped が立つ（非loop）
  const past = curve.at(curve.length + 500);
  assert.strictEqual(past.clamped, true);
  const endp = curve.at(curve.length);
  assert.ok(Math.abs(past.x - endp.x) < 1e-6 && Math.abs(past.y - endp.y) < 1e-6);

  // loop は折り返す（clamped は立たない）
  const ring = new SplinePath([{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }, { x: 0, y: 100 }], { loop: true });
  const a = ring.at(10);
  const b = ring.at(10 + ring.length);
  assert.strictEqual(b.clamped, false);
  assert.ok(Math.hypot(a.x - b.x, a.y - b.y) < 1, '1周すると同じ点に戻る');

  assert.throws(() => new SplinePath([{ x: 0, y: 0 }]), TypeError);
  assert.throws(() => new SplinePath([{ x: 0, y: 0 }, { x: NaN, y: 1 }]), TypeError);

  console.log('OK: spline path is arc-length parameterised and constant-speed');
}

async function testSplineTrafficIsDeterministicAndOnTheRoute(core) {
  const scene = minimalScene(core);
  const scenario = {
    traffic: [
      {
        id: 'traffic-1',
        speedMps: 4,
        loop: false,
        startS: 0,
        pathLatLon: [
          { lat: 35.444, lon: 139.75 },
          { lat: 35.446, lon: 139.7505 },
          { lat: 35.448, lon: 139.75 },
        ],
      },
    ],
  };
  const specs = core.traffic.buildTrafficFromScenario(scenario, scene.projection);
  assert.strictEqual(specs.length, 1);

  function runWorld() {
    const world = new core.World({ scene, capacity: 4, radarRangeM: 600 });
    world.spawn({ id: 'pilot-1', faction: 'defender', platform: 'asv', x: 0, y: 0, heading: 0 });
    const t = new core.traffic.SplineTraffic(specs);
    t.spawn(world);
    for (let k = 0; k < 200; k++) t.step(world, 0.1);
    const i = world.state.indexOf('traffic-1');
    return { x: world.state.x[i], y: world.state.y[i], speed: world.state.speed[i], world, t };
  }

  // 決定論: 同じ dt 列からは必ず同じ軌跡（障害物の動きが実験のたびに変わってはならない）
  const a = runWorld();
  const b = runWorld();
  assert.strictEqual(a.x, b.x);
  assert.strictEqual(a.y, b.y);
  assert.strictEqual(a.speed, 4, '一定速力で走る');
  // 20秒 × 4m/s = 80m 進んでいる（弧長で進めているので距離がそのまま出る）
  const start = specs[0].path.at(0);
  const moved = Math.hypot(a.x - start.x, a.y - start.y);
  assert.ok(moved > 60 && moved < 85, `20秒で ${moved.toFixed(0)} m 進んだ`);

  // レーダーに点として映る（＝状況図のテキストにも出る）
  const radar = a.world.observe('pilot-1', 'radar');
  assert.strictEqual(radar.contacts.length, 1);
  assert.strictEqual(radar.contacts[0].id, 'traffic-1');
  // 艦種は返さない（radar.js の設計。交通船でも同じ）
  assert.ok(!('shipClass' in radar.contacts[0]));

  // nearestTo が最接近距離の材料を返す
  const nearest = a.t.nearestTo(a.world, 'pilot-1');
  assert.strictEqual(nearest.id, 'traffic-1');
  assert.ok(Math.abs(nearest.rangeM - Math.hypot(a.x, a.y)) < 1e-6);

  // reset で startS へ戻る（エピソードを跨いだ状態を残さない）
  a.t.reset();
  assert.strictEqual(a.t.progress.get('traffic-1'), 0);

  assert.throws(() => core.traffic.buildTrafficFromScenario({ traffic: [{ id: 'x', pathLatLon: [] }] }, scene.projection), /2点以上/);

  console.log('OK: spline traffic is deterministic, constant-speed, and visible on radar');
}

/**
 * 既定シナリオ pilotage_m3 の交通船が、実際に自艇の直行線を塞いでいることを確かめる。
 * ここが緩いと「回避しなくても着いてしまう」ので、VLM が waypoint を引き直したかを測れない
 * （M1 が測れなかったのと同じ失敗を、シナリオの数値を触った拍子に再発させないための番人）。
 */
async function testPilotageM3ActuallyBlocksTheDirectRoute() {
  const fs = require('node:fs');
  const path = require('node:path');
  const { loadSceneFromScenario } = await import('../core/data/adapters/index.js');
  const { buildTrafficFromScenario } = await import('../core/sim/traffic.js');
  const scenario = JSON.parse(
    fs.readFileSync(path.join(__dirname, '../core/scenarios/pilotage_m3.json'), 'utf8')
  );
  const scene = await loadSceneFromScenario(scenario);
  const specs = buildTrafficFromScenario(scenario, scene.projection);
  assert.strictEqual(specs.length, 2, '交通船2隻');

  const start = scene.projection.latLonToLocal(scenario.spawns[0].lat, scenario.spawns[0].lon);
  const dest = scene.projection.latLonToLocal(scenario.destinationLatLon.lat, scenario.destinationLatLon.lon);
  const dx = dest.x - start.x;
  const dy = dest.y - start.y;
  const routeM = Math.hypot(dx, dy);

  // 自艇が 6 m/s で直行したときの、各交通船との最接近距離
  let worst = Infinity;
  for (const spec of specs) {
    let best = Infinity;
    for (let k = 0; k <= 1500; k++) {
      const time = k * 0.1;
      const p = spec.path.at(spec.startS + spec.speedMps * time);
      const d = Math.min(6 * time, routeM);
      const hx = start.x + (dx / routeM) * d;
      const hy = start.y + (dy / routeM) * d;
      best = Math.min(best, Math.hypot(p.x - hx, p.y - hy));
    }
    worst = Math.min(worst, best);
  }
  assert.ok(worst < 40, `直行すると交通船に ${worst.toFixed(0)} m まで寄る（回避が必要な配置）`);
  console.log(`OK: pilotage_m3 blocks the direct route (closest approach ${worst.toFixed(0)} m if it goes straight)`);
}

async function testContextBudgetDecidesAndVerifiesNumCtx(core) {
  const { recommendNumCtx, describeContextUsage, kvCacheBytes, parseDeclaredNumCtx, CONTEXT_VERDICTS } =
    core.ctxBudget;

  // 実測から推奨値を出す（ビュアーの実測: prompt 1,520 tok / max_tokens 400 → 3,072）
  const rec = recommendNumCtx({ promptTokens: 1520, maxOutputTokens: 400 });
  assert.strictEqual(rec.numCtx, 3072, rec.reason);
  assert.throws(() => recommendNumCtx({ promptTokens: 0, maxOutputTokens: 400 }), TypeError);

  // KV キャッシュの算術が実測と合うこと（qwen2.5vl:7b: blocks28 / kvHeads4 / headDim128）
  const kv = kvCacheBytes({ blocks: 28, kvHeads: 4, headDim: 128, numCtx: 128000, parallelSlots: 8 });
  assert.strictEqual(kv.bytesPerToken, 57344, '56 KB/token');
  assert.ok(Math.abs(kv.totalBytes / 1e9 - 58.7) < 0.5, `128k×8スロット = ${(kv.totalBytes / 1e9).toFixed(1)} GB`);
  const kvSmall = kvCacheBytes({ blocks: 28, kvHeads: 4, headDim: 128, numCtx: 3072, parallelSlots: 2 });
  assert.ok(kvSmall.totalBytes / 1e9 < 0.4, `3072×2スロット = ${(kvSmall.totalBytes / 1e9).toFixed(2)} GB`);

  // **切り捨ての検出**。ここが効かないと「見せた情報が届いていない」ことに気付けない
  const overflow = describeContextUsage({ numCtx: 2048, promptTokens: 1520, maxOutputTokens: 400 });
  // 1520 + 400 = 1920 < 2048 だが余裕は 6% しかない → tight
  assert.strictEqual(overflow.verdict, CONTEXT_VERDICTS.TIGHT, overflow.message);
  const truncated = describeContextUsage({ numCtx: 1024, promptTokens: 1520, maxOutputTokens: 400 });
  assert.strictEqual(truncated.verdict, CONTEXT_VERDICTS.OVERFLOW);
  assert.match(truncated.message, /切り捨て/);
  const pushedOut = describeContextUsage({ numCtx: 1600, promptTokens: 1520, maxOutputTokens: 400 });
  assert.strictEqual(pushedOut.verdict, CONTEXT_VERDICTS.OVERFLOW, '応答ぶんを足すと溢れるのも overflow');
  const fine = describeContextUsage({ numCtx: 3072, promptTokens: 1520, maxOutputTokens: 400 });
  assert.strictEqual(fine.verdict, CONTEXT_VERDICTS.OK, fine.message);
  // 計測できていないときは判定しない（勝手に警告を出さない）
  assert.strictEqual(
    describeContextUsage({ numCtx: null, promptTokens: null, maxOutputTokens: 400 }).verdict,
    CONTEXT_VERDICTS.OK
  );

  // モデルの宣言を読む側に徹する（コード側に num_ctx を二重に書かないための入口）
  assert.strictEqual(parseDeclaredNumCtx('num_ctx                        3072'), 3072);
  assert.strictEqual(parseDeclaredNumCtx('temperature 0.2\nnum_ctx  8192\n'), 8192);
  assert.strictEqual(parseDeclaredNumCtx('temperature 0.2'), null, '未宣言は null');
  assert.strictEqual(parseDeclaredNumCtx(null), null);

  console.log('OK: context budget recommends num_ctx from measurement and detects truncation');
}

async function testVlmNavigatorRecordsPromptTokensAndContextVerdict(core) {
  const requests = [];
  const fetchImpl = async (url, init) => {
    requests.push(JSON.parse(init.body));
    return {
      ok: true,
      status: 200,
      json: async () => ({
        choices: [{ message: { content: '{"watch":"none","action":"keep","waypoints":[]}' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1520, completion_tokens: 30 },
      }),
    };
  };
  const decide = core.navigator.createVlmNavigatorFn({
    boatId: 'nav-1',
    intervalS: 10,
    latencyS: 2.1,
    baseUrl: 'http://x/v1',
    model: 'm',
    maxTokens: 400,
    numCtx: 3072,
    fetchImpl,
  });
  const pic = {
    boatId: 'nav-1',
    t: 10,
    self: { eastM: 0, northM: 0, headingDeg: 0, speedMps: 5 },
    destination: { eastM: 400, northM: 0, rangeM: 400, bearingDeg: 0, relative: 'dead ahead' },
    arrivalM: 40,
    plan: [{ eastM: 400, northM: 0 }],
    radar: { rangeM: 600, contacts: [] },
    imageDataUrl: null,
    bounds: null,
  };
  const ok = await decide(pic);
  assert.strictEqual(ok.promptTokens, 1520);
  assert.strictEqual(ok.context.verdict, 'ok', ok.context.message);
  assert.strictEqual(decide.stats.maxPromptTokens, 1520);
  assert.strictEqual(decide.stats.contextOverflows, 0);

  // num_ctx を後から差し込めること（サーバへの問い合わせは非同期なので生成時には分からない）
  decide.setNumCtx(1024);
  const bad = await decide({ ...pic, t: 20 });
  assert.strictEqual(bad.context.verdict, 'overflow');
  assert.strictEqual(decide.stats.contextOverflows, 1);
  // **判定しても判断は捨てない**（切り捨てを検出することが目的で、実行を止めるのはやり過ぎ）
  assert.strictEqual(bad.action, 'keep');

  console.log('OK: navigator records prompt tokens and flags context truncation');
}

/**
 * H4: 機動の選択 → waypoint の幾何生成。VLM から取り上げた作業がコード側で正しく動くこと。
 * 受入条件は「生成したプランの離隔が指定した offset を満たす」——これを固定する。
 */
async function testAvoidanceGeneratesClearWaypoints(core) {
  const { planAvoidance, planClearance, closestPointOfApproach, MANEUVERS } = core.avoid;

  // 東へ 6 m/s。真正面 300 m に、北へ 3 m/s で横切る相手
  const self = { eastM: 0, northM: 0, headingDeg: 0, speedMps: 6 };
  const destination = { eastM: 800, northM: 0 };
  const target = { eastM: 300, northM: -150, headingDeg: 90, speedMps: 3 };

  // CPA: 相手は北上、自分は東進。最接近する時刻が 0 より後になる
  const cpa = closestPointOfApproach(self, target);
  assert.ok(cpa.tS > 0 && cpa.tS < 120, `CPA 時刻 ${cpa.tS.toFixed(1)}s`);

  for (const maneuver of ['pass_port', 'pass_starboard']) {
    const offsetM = 120;
    const out = planAvoidance({ self, destination, target, maneuver, offsetM });
    assert.strictEqual(out.waypoints.length, 3, '通過点2つ＋目的地（抜けきってから舵を戻す）');
    assert.deepStrictEqual(out.waypoints[2], destination, '最後は必ず目的地');

    // **受入条件**: 生成した経路の離隔が offset を（丸め・前方確保のぶんを除いて）満たす
    const clearance = planClearance({
      self,
      waypoints: out.waypoints,
      contacts: [{ id: 't1', eastM: cpa.otherAt.eastM, northM: cpa.otherAt.northM }],
    });
    assert.ok(
      clearance.minDistanceM >= offsetM * 0.8,
      `${maneuver}: CPA位置からの離隔 ${clearance.minDistanceM.toFixed(0)}m（offset ${offsetM}m）`
    );
  }

  // 左右で反対側に出ること（同じ点を返したら機動の意味が無い）
  const port = planAvoidance({ self, destination, target, maneuver: 'pass_port', offsetM: 120 });
  const stbd = planAvoidance({ self, destination, target, maneuver: 'pass_starboard', offsetM: 120 });
  assert.ok(
    Math.hypot(port.waypoints[0].eastM - stbd.waypoints[0].eastM, port.waypoints[0].northM - stbd.waypoints[0].northM) > 150,
    '左舷通過と右舷通過は別の点になる'
  );
  // pass_port（相手を左舷に見る）＝自分は相手の右＝東進なら南側へ寄る
  assert.ok(port.waypoints[0].northM < stbd.waypoints[0].northM, 'pass_port は相手の南側（右手）を通る');

  // hold / slow / stop は航路を変えない
  for (const m of ['hold', 'slow', 'stop']) {
    assert.deepStrictEqual(planAvoidance({ self, destination, target, maneuver: m }).waypoints, []);
  }
  // 相手がいなければ航路を変えない（落として理由を残す）
  const noTarget = planAvoidance({ self, destination, target: null, maneuver: 'pass_port' });
  assert.deepStrictEqual(noTarget.waypoints, []);
  assert.ok(noTarget.notes.some((n) => /no target/.test(n)));

  // offset は範囲へクランプし、クランプしたことを残す
  const wide = planAvoidance({ self, destination, target, maneuver: 'pass_port', offsetM: 9999 });
  assert.ok(wide.notes.some((n) => /clamped/.test(n)));

  assert.throws(() => planAvoidance({ self, destination, target, maneuver: 'turn_left' }), TypeError);
  assert.deepStrictEqual(MANEUVERS.slice(0, 3), ['hold', 'pass_port', 'pass_starboard']);

  // 純関数（同じ入力→同じ出力）
  const a = planAvoidance({ self, destination, target, maneuver: 'pass_port', offsetM: 120 });
  const b = planAvoidance({ self, destination, target, maneuver: 'pass_port', offsetM: 120 });
  assert.deepStrictEqual(a.waypoints, b.waypoints);

  console.log('OK: avoidance generates waypoints that clear the CPA by the requested offset');
}

/**
 * H6: 点は接触から離れているのに、点と点を結ぶ**線が接触を貫く**ケース。
 * parse_plan.js の ON_CONTACT（点だけを見る）では捕まらない。
 */
async function testPlanClearanceCatchesLegsThroughContacts(core) {
  const { planClearance } = core.avoid;
  const self = { eastM: 0, northM: 0 };
  // 接触は (200,0)。waypoint は (150,0) でも (250,0) でもなく、その両側の遠い点に置く
  const waypoints = [{ eastM: 400, northM: 0 }];
  const contacts = [{ id: 't1', eastM: 200, northM: 0 }];
  const through = planClearance({ self, waypoints, contacts });
  assert.ok(through.minDistanceM < 1, `線が接触を貫いている（最短 ${through.minDistanceM.toFixed(1)}m）`);
  assert.strictEqual(through.worst.contactId, 't1');
  assert.strictEqual(through.worst.legIndex, 0);

  // 迂回すれば離隔が確保される
  const around = planClearance({ self, waypoints: [{ eastM: 200, northM: -150 }, { eastM: 400, northM: 0 }], contacts });
  assert.ok(around.minDistanceM > 100, `迂回後の離隔 ${around.minDistanceM.toFixed(0)}m`);

  assert.strictEqual(planClearance({ self, waypoints: [], contacts }).minDistanceM, Infinity);
  assert.strictEqual(planClearance({ self, waypoints, contacts: [] }).minDistanceM, Infinity);

  console.log('OK: plan clearance catches legs that pass through a contact');
}

/**
 * H2: watch アーム。**VLM の応答に座標が1つも含まれない**ことと、
 * waypoint がコード側で生成されることを固定する。
 */
async function testWatchArmLetsTheModelChooseAndTheCodePlan(core) {
  const picture = {
    boatId: 'nav-1',
    t: 10,
    self: { eastM: 0, northM: 0, headingDeg: 0, speedMps: 6 },
    destination: { eastM: 800, northM: 0, rangeM: 800, bearingDeg: 0, relative: 'dead ahead' },
    arrivalM: 40,
    plan: [{ eastM: 800, northM: 0 }],
    radar: {
      rangeM: 600,
      contacts: [
        // 12.1秒の予測地平の中で実際に接近する距離に置く（遠い接触は A2 の CPA 判定で
        // 「放っておいても離隔を満たす」として回避が見送られるため、脅威の試験にならない）
        { id: 'TRK-01', trueId: 'traffic-cross', rangeM: 100, relBearingDeg: 0, relative: 'dead ahead', eastM: 100, northM: 0 },
      ],
    },
    imageDataUrl: null,
    bounds: { minX: -900, maxX: 900, minY: -900, maxY: 900 },
  };
  const requests = [];
  function makeWatch(reply) {
    return core.navigator.createVlmNavigatorFn({
      boatId: 'nav-1',
      intervalS: 10,
      latencyS: 2.1,
      baseUrl: 'http://x/v1',
      model: 'm',
      mode: core.navigator.NAVIGATOR_MODES.WATCH,
      fetchImpl: fixtureFetch([reply], requests),
    });
  }

  // 座標を渡していないこと（渡さなければ書き写せない）
  const decide = makeWatch('{"watch":"contact dead ahead","maneuver":"pass_starboard","targetTrack":"TRK-01","offsetM":150,"speed":"slow"}');
  assert.match(decide.systemPrompt, /You do NOT plan coordinates/);
  const d = await decide(picture);
  const sentText = requests[0].body.messages[1].content;
  assert.ok(!/at east=/.test(sentText), 'watch アームの状況図に絶対座標を書かない');
  assert.match(sentText, /TRK-01: range 100 m/);

  // コード側が waypoint を生成している
  assert.strictEqual(d.action, 'replace');
  assert.strictEqual(d.maneuver.name, 'pass_starboard');
  assert.strictEqual(d.maneuver.targetTrack, 'TRK-01');
  assert.strictEqual(d.maneuver.offsetM, 150);
  assert.strictEqual(d.waypoints.length, 3);
  assert.deepStrictEqual(d.waypoints[2], { eastM: 800, northM: 0 }, '最後は目的地');
  // 生成された通過点は接触から offset ぶん離れている
  const clear = core.avoid.planClearance({
    self: picture.self,
    waypoints: d.waypoints,
    contacts: picture.radar.contacts,
  });
  // 近距離（100m先）では、横へ150m出る通過点へ向かう脚が斜めに切るため、離隔は offset に届かない
  // （100m先・横150m の三角形で 83m）。offset どおりの離隔が出るのは相手が十分前方にあるときで、
  // そちらは testAvoidanceGeneratesClearWaypoints が ≥0.8×offset として固定している。
  // ここで確かめたいのは「コード側が実際に迂回路を作ったか」なので、半分を下限にする。
  assert.ok(
    clear.minDistanceM > d.maneuver.offsetM * 0.5,
    `離隔 ${clear.minDistanceM.toFixed(0)}m（offset ${d.maneuver.offsetM}m の半分以上）`
  );
  assert.strictEqual(decide.stats.byManeuver.pass_starboard, 1);

  // hold は航路を変えない（開いた海面での正常な答え）
  const hold = makeWatch('{"watch":"none","maneuver":"hold","targetTrack":"","offsetM":120,"speed":"cruise"}');
  const h = await hold(picture);
  assert.strictEqual(h.action, 'keep');
  assert.strictEqual(h.waypoints, null);
  assert.strictEqual(hold.stats.byManeuver.hold, 1);

  // 選択肢の外は hold へ落として数える（勝手に近いものへ寄せない）
  const bogus = makeWatch('{"watch":"x","maneuver":"turn_hard_left","targetTrack":"TRK-01","offsetM":120}');
  const bg = await bogus(picture);
  assert.strictEqual(bg.maneuver.name, 'hold');
  assert.ok(bg.notes.includes(core.parsePlan.PLAN_NOTES.UNKNOWN_MANEUVER));

  // **実測で踏んだ形**: watch 文では TRK-01 と言いながら targetTrack には "01" と書く。
  // 厳密一致で弾くと hold に落ち、6エピソード中4本で1度も回避しなかった（2026-09-06）
  const numeric = makeWatch('{"watch":"TRK-01 is close on the port side","maneuver":"pass_starboard","targetTrack":"01","offsetM":120}');
  const nm = await numeric(picture);
  assert.strictEqual(nm.maneuver.targetTrack, 'TRK-01', '"01" を TRK-01 へ寄せる');
  assert.strictEqual(nm.maneuver.name, 'pass_starboard', 'hold へ落とさない');
  assert.ok(nm.notes.includes(core.parsePlan.PLAN_NOTES.TARGET_NORMALISED), '寄せたことを残す');
  assert.strictEqual(nm.action, 'replace');

  // 書式の揺れ（大小・区切り）も寄せる
  const { resolveTrackRef } = core.parsePlan;
  const ids = ['TRK-01', 'TRK-02'];
  for (const ref of ['TRK-01', 'trk-01', 'TRK01', 'trk 01', '01', '1']) {
    assert.strictEqual(resolveTrackRef(ref, ids).id, 'TRK-01', `"${ref}" → TRK-01`);
  }
  assert.strictEqual(resolveTrackRef('TRK-99', ids).id, null);
  assert.strictEqual(resolveTrackRef('', ids).id, null);
  assert.strictEqual(resolveTrackRef(null, ids).id, null);

  // 状況図に居ない track を指したら落とす。1隻しか居なければ推定する
  const ghost = makeWatch('{"watch":"x","maneuver":"pass_port","targetTrack":"TRK-99","offsetM":120}');
  const gh = await ghost(picture);
  assert.ok(gh.notes.includes(core.parsePlan.PLAN_NOTES.UNKNOWN_TRACK));
  assert.ok(gh.notes.includes(core.parsePlan.PLAN_NOTES.TARGET_INFERRED));
  assert.strictEqual(gh.maneuver.targetTrack, 'TRK-01');

  // 相手が2隻居て特定できなければ**最も近い接触**を採る（hold へ落として意図を捨てない）
  const two = {
    ...picture,
    radar: {
      rangeM: 600,
      contacts: [
        ...picture.radar.contacts,
        { id: 'TRK-02', trueId: 'traffic-slow', rangeM: 80, relBearingDeg: -30, relative: 'on the starboard bow / starboard side', eastM: 69, northM: -40 },
      ],
    },
  };
  const ambiguous = makeWatch('{"watch":"x","maneuver":"pass_port","targetTrack":"","offsetM":120}');
  const am = await ambiguous(two);
  assert.strictEqual(am.maneuver.name, 'pass_port', '意図は捨てない');
  assert.strictEqual(am.maneuver.targetTrack, 'TRK-02', '最も近い接触（80m）を採る');
  assert.ok(am.notes.includes(core.parsePlan.PLAN_NOTES.TARGET_NEAREST));
  // 接触が1つも無ければ回避しようがないので hold
  const empty = makeWatch('{"watch":"x","maneuver":"pass_port","targetTrack":"","offsetM":120}');
  const em = await empty({ ...picture, radar: { rangeM: 600, contacts: [] } });
  assert.strictEqual(em.maneuver.name, 'hold');
  assert.ok(em.notes.includes(core.parsePlan.PLAN_NOTES.NO_TARGET));

  // offset は範囲へクランプされ、さらに**目的地までの残距離**で天井が掛かる（A1-(1)）。
  // 目的地 800m × roomFraction 0.35 = 280m。避けすぎて着かないのを幾何側で防ぐ
  // offset は範囲へクランプされ、さらに**既定で**目的地までの残距離が天井になる
  // （残距離800m × 0.35 = 280m）。残り98mで307mの迂回を打つ事象を防ぐための既定
  const wide = makeWatch('{"watch":"x","maneuver":"pass_port","targetTrack":"TRK-01","offsetM":9999}');
  const w = await wide(picture);
  assert.strictEqual(w.maneuver.offsetM, 280, '既定で残距離の35%が天井になる');
  assert.ok(w.notes.includes(core.parsePlan.PLAN_NOTES.OFFSET_CLAMPED));
  assert.ok(w.notes.includes(core.parsePlan.PLAN_NOTES.OFFSET_ROOM_CAPPED));

  const withRoom = (reply, extra) =>
    core.navigator.createVlmNavigatorFn({
      boatId: 'nav-1', intervalS: 10, latencyS: 2.1, baseUrl: 'http://x/v1', model: 'm',
      mode: core.navigator.NAVIGATOR_MODES.WATCH, ...extra,
      fetchImpl: fixtureFetch([reply], []),
    });
  // roomFraction=0 で無効化できる（ablation のため独立に切れる）
  const uncapped = withRoom('{"watch":"x","maneuver":"pass_port","targetTrack":"TRK-01","offsetM":9999}', { roomFraction: 0 });
  const uc = await uncapped(picture);
  assert.strictEqual(uc.maneuver.offsetM, 400, 'roomFraction=0 なら MAX_OFFSET_M のまま');
  assert.ok(!uc.notes.includes(core.parsePlan.PLAN_NOTES.OFFSET_ROOM_CAPPED));
  // 目的地が近いほど天井が下がる
  const nearArm = withRoom('{"watch":"x","maneuver":"pass_port","targetTrack":"TRK-01","offsetM":300}', { roomFraction: 0.35 });
  const na = await nearArm({ ...picture, destination: { ...picture.destination, rangeM: 200 } });
  assert.strictEqual(na.maneuver.offsetM, 70, '残距離200m × 0.35 = 70m');

  // arrivalAware は既定で入れない（1行足した版は実測で悪化した）
  assert.ok(!/You must also arrive/.test(makeWatch('{"maneuver":"hold"}').systemPrompt));
  const aware = withRoom('{"maneuver":"hold"}', { arrivalAware: true });
  assert.match(aware.systemPrompt, /You must also arrive/);

  // パース不能でも航路は維持される
  const junk = makeWatch('I would slow down a bit.');
  const j = await junk(picture);
  assert.strictEqual(j.action, 'keep');
  assert.strictEqual(j.outcome, 'parse');

  // plan アームのプロンプトは従来どおり座標入り（実測との比較可能性を保つ）
  const planRequests = [];
  const planArm = core.navigator.createVlmNavigatorFn({
    boatId: 'nav-1', intervalS: 10, latencyS: 2.1, baseUrl: 'http://x/v1', model: 'm',
    fetchImpl: fixtureFetch(['{"watch":"none","action":"keep","waypoints":[]}'], planRequests),
  });
  await planArm(picture);
  assert.match(planRequests[0].body.messages[1].content, /at east=100, north=0/);

  console.log('OK: watch arm has the model choose a maneuver and the code plan the waypoints');
}

/**
 * H3: トラック化（匿名化＋速度推定）。
 * 速度推定が必要になった理由は実測——`avoidance.js` が相手を静止扱いしていたため、
 * 生成した通過点が実際には離隔を満たさなかった（6エピソードで21件）。
 */
async function testTrackStoreEstimatesTargetMotion(core) {
  const { TrackStore } = core.fuse;
  const store = new TrackStore();

  // 初出では速度が分からない（1点では差分が取れない）
  let out = store.observe([{ id: 'traffic-cross', eastM: 0, northM: 0 }], 0);
  assert.strictEqual(out[0].id, 'TRK-01');
  assert.strictEqual(out[0].trueId, 'traffic-cross');
  assert.strictEqual(out[0].speedMps, null, '1点では推定できない');
  assert.strictEqual(out[0].seen, 1);

  // 10秒後に北へ30m → 3 m/s・針路90度（数学系）
  out = store.observe([{ id: 'traffic-cross', eastM: 0, northM: 30 }], 10);
  assert.ok(Math.abs(out[0].speedMps - 3) < 1e-6, `速力 ${out[0].speedMps}`);
  assert.ok(Math.abs(out[0].courseDeg - 90) < 1e-6, `針路 ${out[0].courseDeg}`);
  assert.strictEqual(out[0].seen, 2);

  // 名前は初出順で固定。2隻目は TRK-02
  out = store.observe(
    [{ id: 'traffic-slow', eastM: 100, northM: 0 }, { id: 'traffic-cross', eastM: 0, northM: 60 }],
    20
  );
  assert.strictEqual(out[0].id, 'TRK-02', '2隻目は TRK-02');
  assert.strictEqual(out[1].id, 'TRK-01', '既知の相手は名前が変わらない');
  assert.strictEqual(store.trueIdOf('TRK-02'), 'traffic-slow');

  // 極端な値はノイズとして捨てる（20 m/s 超）
  const noisy = new TrackStore();
  noisy.observe([{ id: 'x', eastM: 0, northM: 0 }], 0);
  const jumped = noisy.observe([{ id: 'x', eastM: 5000, northM: 0 }], 1);
  assert.strictEqual(jumped[0].speedMps, null, '飛び値は推定に採らない');

  // 久しぶりの再探知では推定を捨てる（等速の仮定が崩れる）
  const gapped = new TrackStore();
  gapped.observe([{ id: 'y', eastM: 0, northM: 0 }], 0);
  gapped.observe([{ id: 'y', eastM: 0, northM: 30 }], 10);
  const late = gapped.observe([{ id: 'y', eastM: 0, northM: 200 }], 100);
  assert.strictEqual(late[0].speedMps, null, '間隔が開いたら推定を捨てる');

  // エピソードを跨いだ対応は残さない
  store.reset();
  assert.strictEqual(store.observe([{ id: 'whatever', eastM: 0, northM: 0 }], 0)[0].id, 'TRK-01');

  console.log('OK: track store anonymises ids and estimates target motion by finite difference');
}

/**
 * 相手の動きを渡すことと、**外挿の上限（horizon）**の扱い。
 *
 * 2026-09-06 の実測で学んだのは「速度を渡せば良い」ではなく
 * **「等速直線の仮定が持つ時間より先を予測してはいけない」**だった:
 *   ・速度の推定自体は正確（3.0 / 1.0 m/s ＝シナリオ値と一致）
 *   ・しかし周回する交通船の針路は 40 秒で −76°→−14°（約1.5°/s）旋回しており、
 *     それを 120 秒外挿した先に通過点を置いたため最接近が 16m→6m へ**悪化**した
 * したがってここで固定するのは「horizon を超えて予測しない」という不変条件である。
 */
async function testAvoidanceRespectsThePredictionHorizon(core) {
  const { planAvoidance, planClearance, closestPointOfApproach, DEFAULT_HORIZON_S } = core.avoid;
  const self = { eastM: 0, northM: 0, headingDeg: 0, speedMps: 6 };
  const destination = { eastM: 2000, northM: 0 };
  const offsetM = 120;
  // 遠くの相手。CPA は本来ずっと先（>120s）になる幾何
  const far = { eastM: 1500, northM: 300, headingDeg: -90, speedMps: 3 };

  // **不変条件**: CPA 時刻は horizon を超えない
  assert.ok(closestPointOfApproach(self, far, { horizonS: 20 }).tS <= 20 + 1e-9);
  assert.ok(closestPointOfApproach(self, far, { horizonS: 5 }).tS <= 5 + 1e-9);
  assert.ok(closestPointOfApproach(self, far).tS <= DEFAULT_HORIZON_S + 1e-9, '既定でも上限が効く');

  // horizon が違えば予測位置が違い、置かれる通過点も違う（＝この値が挙動を支配している）
  const short = planAvoidance({ self, destination, target: far, maneuver: 'pass_port', offsetM, horizonS: 5 });
  const long = planAvoidance({ self, destination, target: far, maneuver: 'pass_port', offsetM, horizonS: 60 });
  assert.ok(
    Math.hypot(short.waypoints[0].eastM - long.waypoints[0].eastM, short.waypoints[0].northM - long.waypoints[0].northM) > 50,
    'horizon の違いが通過点に効く'
  );

  // **構成上の保証**: 速度を渡せば、予測した CPA 位置からは必ず offset ぶん離れる
  for (const horizonS of [5, 20, 60]) {
    const out = planAvoidance({ self, destination, target: far, maneuver: 'pass_starboard', offsetM, horizonS });
    const cpa = closestPointOfApproach(self, far, { horizonS });
    const clear = planClearance({
      self,
      waypoints: out.waypoints,
      contacts: [{ id: 't1', eastM: cpa.otherAt.eastM, northM: cpa.otherAt.northM }],
    });
    assert.ok(
      clear.minDistanceM >= offsetM * 0.8,
      `horizon=${horizonS}s: 予測CPAからの離隔 ${clear.minDistanceM.toFixed(0)}m（offset ${offsetM}m）`
    );
  }

  // 相手を静止扱いすると予測位置が変わる（どちらが安全かは幾何依存で、一般には言えない）
  const asStatic = { eastM: far.eastM, northM: far.northM };
  const withMotion = planAvoidance({ self, destination, target: far, maneuver: 'pass_port', offsetM, horizonS: 20 });
  const staticOnly = planAvoidance({ self, destination, target: asStatic, maneuver: 'pass_port', offsetM, horizonS: 20 });
  assert.ok(
    Math.hypot(
      withMotion.waypoints[0].eastM - staticOnly.waypoints[0].eastM,
      withMotion.waypoints[0].northM - staticOnly.waypoints[0].northM
    ) > 10,
    '速度を渡すかどうかで通過点が変わる'
  );

  console.log('OK: avoidance never extrapolates past the prediction horizon');
}


/**
 * A2: **避ける必要があるか**をコード側で判定する（CPA veto）。
 *
 * 実測（2026-09-06）: モデルは 75 回の判断のうち `hold` を **3 回**しか選ばず、
 * レーダーに点が見えれば距離に関係なく避けようとした（経路長比 1.77・到達 3/6）。
 * 「放っておいても離隔を満たすか」は算術なので、コード側が引き取る。
 * **モデルの意図は記録に残す**（避けたがったが不要だった回数を数える）。
 */
async function testCpaVetoSkipsUnneededAvoidance(core) {
  const base = {
    boatId: 'nav-1',
    t: 10,
    self: { eastM: 0, northM: 0, headingDeg: 0, speedMps: 6 },
    destination: { eastM: 2000, northM: 0, rangeM: 2000, bearingDeg: 0, relative: 'dead ahead' },
    arrivalM: 40,
    plan: [{ eastM: 2000, northM: 0 }],
    imageDataUrl: null,
    bounds: null,
  };
  const make = (reply) =>
    core.navigator.createVlmNavigatorFn({
      boatId: 'nav-1', intervalS: 10, latencyS: 2.1, baseUrl: 'http://x/v1', model: 'm',
      mode: core.navigator.NAVIGATOR_MODES.WATCH,
      fetchImpl: fixtureFetch([reply], []),
    });
  const wantAvoid = '{"watch":"contact ahead","maneuver":"pass_port","targetTrack":"TRK-01","offsetM":120}';

  // 遠い接触: 12.1秒では 73m しか進まないので、放っておいても離隔を満たす → 見送る
  const far = make(wantAvoid);
  const farOut = await far({
    ...base,
    radar: { rangeM: 600, contacts: [{ id: 'TRK-01', rangeM: 500, relBearingDeg: 0, relative: 'dead ahead', eastM: 500, northM: 0 }] },
  });
  assert.strictEqual(farOut.action, 'keep', '遠い接触では航路を変えない');
  assert.ok(farOut.notes.includes(core.parsePlan.PLAN_NOTES.CPA_ALREADY_CLEAR));
  assert.strictEqual(far.stats.avoidanceUnneeded, 1, 'モデルが避けたがった事実は数える');
  assert.strictEqual(farOut.maneuver.name, 'pass_port', 'モデルの意図は記録に残る');

  // 近い接触: 地平の中で offset を割る → 実際に避ける
  const near = make(wantAvoid);
  const nearOut = await near({
    ...base,
    radar: { rangeM: 600, contacts: [{ id: 'TRK-01', rangeM: 90, relBearingDeg: 0, relative: 'dead ahead', eastM: 90, northM: 0 }] },
  });
  assert.strictEqual(nearOut.action, 'replace', '近い接触では避ける');
  assert.ok(!nearOut.notes.includes(core.parsePlan.PLAN_NOTES.CPA_ALREADY_CLEAR));
  assert.strictEqual(near.stats.avoidanceUnneeded, 0);

  // 離れていく接触は、距離が近くても避けない（相対運動で判定している証拠）
  const opening = make(wantAvoid);
  const openOut = await opening({
    ...base,
    radar: {
      rangeM: 600,
      // 前方150mだが自艇より速く同じ向きへ走っている＝離れていく
      contacts: [{ id: 'TRK-01', rangeM: 150, relBearingDeg: 0, relative: 'dead ahead', eastM: 150, northM: 0, courseDeg: 0, speedMps: 12 }],
    },
  });
  assert.strictEqual(openOut.action, 'keep', '離れていく接触は避けない');
  assert.ok(openOut.notes.includes(core.parsePlan.PLAN_NOTES.CPA_ALREADY_CLEAR));

  console.log('OK: CPA veto skips avoidance that is not needed, and records the intent anyway');
}

async function main() {
  const core = await loadCore();
  await testLlmHttpImagesAreBackwardCompatible(core);
  await testNavigatorPictureIsSensorDerivedAndInterlocked(core);
  await testTrackNamerAnonymisesContactIds(core);
  await testParsePlanSanitizesTheMeasuredDegenerations(core);
  await testRoutePlanFollowsWaypointsAndArrives(core);
  await testVlmNavigatorSendsImageAndRecordsStats(core);
  await testVlmNavigatorKeepsThePlanOnFailure(core);
  await testNavigatorIsAStagedSchedulerDecider(core);
  await testSplinePathIsArcLengthParameterised(core);
  await testSplineTrafficIsDeterministicAndOnTheRoute(core);
  await testPilotageM3ActuallyBlocksTheDirectRoute();
  await testTrackStoreEstimatesTargetMotion(core);
  await testAvoidanceRespectsThePredictionHorizon(core);
  await testAvoidanceGeneratesClearWaypoints(core);
  await testWatchArmLetsTheModelChooseAndTheCodePlan(core);
  await testCpaVetoSkipsUnneededAvoidance(core);
  await testPlanClearanceCatchesLegsThroughContacts(core);
  await testContextBudgetDecidesAndVerifiesNumCtx(core);
  await testVlmNavigatorRecordsPromptTokensAndContextVerdict(core);

  console.log('\nAll navigator tests passed.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
