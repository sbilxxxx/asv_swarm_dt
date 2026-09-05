/**
 * boat_agent.js — 艇レベルのエージェント（Phase 2 の最小実装）
 *
 * これまで艇は「上から来た指示へ毎ステップ舵を切るだけの機械」だった
 * （boat_controller.js）。ここで艇自身に判断を持たせる。
 *
 * 【設計の一点】艇の出力を指揮官の指示と同じ形にする。
 * そうすると applyOrders / BoatController / 座標変換 / 追従制御が無変更で効き、
 * さらに DecisionScheduler から見て艇と指揮官が同型の decider になる
 * （＝時間の扱い・推論待ち・ログが全部そのまま乗る）。
 * 艇に固有なのは「何を見せるか」だけで、そこがこのファイルの中身である。
 *
 * 【艇に何を決めさせるか】指揮官の指示に「従う」か「自分で上書きする」か。
 * 艇は指揮官より狭く・新しい情報を持つ（自分のレーダーは今この瞬間のもので、
 * 指揮官の統合図は最大 intervalS + latencyS 古い）。その差が判断として現れる場所を
 * 一つに絞る。全権を与えて {throttle, steering} を吐かせないのは、
 *   1. 連続量の操舵は 7B 級には安定せず、毎ステップ推論は原理的に回らない
 *   2. 上書きが起きた瞬間を「指揮官の指示に従わなかった」と名指しで数えられなくなる
 * の 2 点による。obey を第一級にしてあるのは L0 の教訓（死んだ waypoint の再送が
 * 80.9%）への対策でもある——変えないなら座標を書き直させない。
 *
 * 【指揮官との競合】両者とも world.orders へ書き、後から発効したほうが勝つ。
 * 調停規則は置かない（roadmap の「設計する必要があるもの」のまま）。艇の上書きが
 * 次の指揮サイクルで塗り潰されること自体が観察対象なので、隠さず overrides で数える。
 */

import { postChatCompletion, LlmHttpError, LLM_HTTP_FAILURES } from './llm_http.js';
import { extractFirstJsonObject } from '../command/parse_orders.js';
import { toCompassDeg } from '../command/fused_picture.js';
import { INTERCEPT_RANGE_M, ASSET_BREACH_RANGE_M, episodeTimeLimitOf } from '../mission.js';
import { describeOrder } from '../command/orders.js';

const DEFAULT_TEMPERATURE = 0.7;
const DEFAULT_MAX_TOKENS = 200; // 指揮官(300)より小さい。1艇1指示ぶんしか返させない
const DEFAULT_TIMEOUT_MS = 30000;

/** 1判断の結末。'ok' 以外はすべて「現指示を維持」に落ちる */
export const BOAT_OUTCOMES = Object.freeze({
  /** 艇が指示を上書きした */
  OVERRIDE: 'override',
  /** 艇が指揮官の指示に従うと決めた（正常。失敗ではない） */
  OBEY: 'obey',
  PARSE: 'parse',
  TIMEOUT: LLM_HTTP_FAILURES.TIMEOUT,
  CONNECTION: LLM_HTTP_FAILURES.CONNECTION,
  HTTP_STATUS: LLM_HTTP_FAILURES.HTTP_STATUS,
  MALFORMED_BODY: LLM_HTTP_FAILURES.MALFORMED_BODY,
  EMPTY_CONTENT: LLM_HTTP_FAILURES.EMPTY_CONTENT,
  /** thinking が予算を使い切って本文が空。EMPTY_CONTENT と分けると原因の所在が判別できる */
  THINKING_OVERRUN: LLM_HTTP_FAILURES.THINKING_OVERRUN,
  UNKNOWN: 'unknown',
});

const RESPONSE_SCHEMA = [
  'Reply with ONLY one JSON object:',
  '{"decision": "obey"}',
  '  — follow the order you were given, or',
  '{"decision": "override", "action": "move_to", "waypoint": {"east_m": <num>, "north_m": <num>},',
  '  "reason": "<why, at most 10 words>"}',
  '  — action may also be "intercept" with "target": "<contact id you can see>",',
  '    or "patrol" with "center": "asset" | {"east_m": <num>, "north_m": <num>} and "radius_m": <num>.',
  'Prefer "obey". Override only when what you see now changes what you should do.',
].join('\n');

/**
 * 艇1隻ぶんのシステムプロンプト。
 * @param {string} faction - 'defender' | 'intruder'
 * @param {{intervalS:number, latencyS:number}} timing - register() へ渡すものと同一
 */
export function buildBoatSystemPrompt(faction, { intervalS, latencyS }) {
  const shared = [
    'Coordinates are meters east/north of the protected asset at (0, 0).',
    'You see only your own radar, right now. Your commander sees a fused picture that is',
    'seconds old — when your radar disagrees with your order, you are the fresher source.',
    `You may decide every ${intervalS} s, and your decision takes ${latencyS} s to take effect.`,
    RESPONSE_SCHEMA,
  ];
  if (faction === 'defender') {
    return [
      'You are the helm of a single DEFENDER uncrewed surface vessel (ASV).',
      `Your force loses if any intruder gets within ${ASSET_BREACH_RANGE_M} m of the asset.`,
      `You neutralise an intruder by closing within ${INTERCEPT_RANGE_M} m of it.`,
      ...shared,
    ].join('\n');
  }
  if (faction === 'intruder') {
    return [
      'You are the helm of a single INTRUDER uncrewed surface vessel (ASV).',
      `You win by getting within ${ASSET_BREACH_RANGE_M} m of the asset at (0, 0).`,
      `Defenders neutralise you by closing within ${INTERCEPT_RANGE_M} m, so keep your distance from them.`,
      ...shared,
    ].join('\n');
  }
  throw new Error(`buildBoatSystemPrompt: unknown faction "${faction}"`);
}

function fmt(n) {
  return String(Math.round(n));
}

/**
 * 艇1隻の視界。指揮官の統合図（fused_picture.js）と違い、融合もトラック化もしない
 * ——この艇のレーダーが今この瞬間に映しているものだけを、そのまま渡す。
 *
 * @param {import('../world.js').World} world
 * @param {string} boatId
 * @param {{episode?: number|null}} [options]
 * @returns {{boatId, faction, t, episode, eastM, northM, compassHeadingDeg, speedMps,
 *   orderSummary, contacts: Array<{id, faction, eastM, northM, rangeM}>}}
 */
export function buildBoatPicture(world, boatId, { episode = null } = {}) {
  const i = world.state.indexOf(boatId);
  if (i < 0) throw new Error(`buildBoatPicture: unknown boat "${boatId}"`);
  const asset = world.protectedAsset ?? { x: 0, y: 0 };
  const selfX = world.state.x[i];
  const selfY = world.state.y[i];
  const radar = world.observe(boatId, 'radar');

  const contacts = (radar?.contacts ?? []).map((c) => {
    const x = selfX + Math.cos(c.bearingRad) * c.rangeM;
    const y = selfY + Math.sin(c.bearingRad) * c.rangeM;
    return {
      id: c.id,
      faction: c.faction,
      eastM: x - asset.x,
      northM: y - asset.y,
      rangeM: c.rangeM,
    };
  });

  return {
    boatId,
    faction: world.state.faction[i],
    t: world.clock,
    timeLimitS: episodeTimeLimitOf(world),
    episode,
    eastM: selfX - asset.x,
    northM: selfY - asset.y,
    compassHeadingDeg: toCompassDeg(world.state.heading[i]),
    speedMps: world.state.speed[i],
    orderSummary: describeOrder(world.orders.get(boatId), asset),
    contacts,
  };
}

/**
 * 艇の視界をプロンプト本文へ描く。
 * @param {ReturnType<typeof buildBoatPicture>} picture
 * @param {{expectBoatId?: string|null}} [options] - 渡すと取り違えで throw
 */
export function renderBoatPictureText(picture, { expectBoatId = null } = {}) {
  if (expectBoatId !== null && expectBoatId !== picture?.boatId) {
    throw new Error(
      `renderBoatPictureText: boat mismatch — agent is "${expectBoatId}" but the picture is "${picture?.boatId}"`
    );
  }
  const lines = [];
  lines.push(`OWN SHIP ${picture.boatId} (${picture.faction}) t=${picture.t.toFixed(1)}s`);
  lines.push(
    `  at (${fmt(picture.eastM)}, ${fmt(picture.northM)}) heading ` +
      `${String(picture.compassHeadingDeg).padStart(3, '0')} speed ${picture.speedMps.toFixed(1)} m/s`
  );
  lines.push(`  range to asset ${fmt(Math.hypot(picture.eastM, picture.northM))} m`);
  lines.push(`ORDER FROM COMMANDER: ${picture.orderSummary}`);
  lines.push('YOUR RADAR right now:');
  if (picture.contacts.length === 0) {
    lines.push('  (nothing in range)');
  } else {
    for (const c of [...picture.contacts].sort((a, b) => a.rangeM - b.rangeM)) {
      lines.push(
        `  ${c.id} (${c.faction}) at (${fmt(c.eastM)}, ${fmt(c.northM)}) — ${fmt(c.rangeM)} m away`
      );
    }
  }
  lines.push(`TIME ${picture.t.toFixed(1)} / ${picture.timeLimitS ?? episodeTimeLimitOf(null)} s`);
  return lines.join('\n');
}

/** 数値を1つ拾う。モデルが数値を引用符で囲む癖を吸収する（parse_orders.js と同じ方針） */
function toFiniteNumber(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string') {
    const n = Number(v.trim());
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/** {east_m,north_m} / {eastM,northM} / [e,n] を受ける */
function validatePoint(p) {
  if (Array.isArray(p) && p.length >= 2) {
    const e = toFiniteNumber(p[0]);
    const n = toFiniteNumber(p[1]);
    return e === null || n === null ? null : { eastM: e, northM: n };
  }
  if (!p || typeof p !== 'object') return null;
  const e = toFiniteNumber(p.east_m ?? p.eastM);
  const n = toFiniteNumber(p.north_m ?? p.northM);
  return e === null || n === null ? null : { eastM: e, northM: n };
}

/**
 * 艇の応答をパースして、指揮官の指示と同じ正規化済みの形にする。
 * @param {string} text
 * @param {{boatId:string, contactIds:string[]}} roster
 * @returns {{ok:true, obey:boolean, order:object|null, reason:string}
 *   | {ok:false, error:string}}
 */
export function parseBoatDecision(text, { boatId, contactIds }) {
  const json = extractFirstJsonObject(text);
  if (json === null) return { ok: false, error: 'no JSON object in response' };
  let obj;
  try {
    obj = JSON.parse(json);
  } catch (err) {
    return { ok: false, error: `invalid JSON: ${err?.message ?? err}` };
  }
  const reason = typeof obj.reason === 'string' ? obj.reason.slice(0, 120) : '';
  const decision = typeof obj.decision === 'string' ? obj.decision.toLowerCase().trim() : null;

  // decision が無くても action だけ返すモデルがあるので、その場合は override とみなす
  if (decision === 'obey' || (decision === null && !obj.action)) {
    return { ok: true, obey: true, order: null, reason };
  }

  let action = typeof obj.action === 'string' ? obj.action.toLowerCase().trim() : null;
  // decision 欄へ直接アクション名を書く癖（{"decision":"patrol",...}）を吸収する。
  // JSON強制(jsonMode)後の実測で全パース失敗の過半がこの形だった（2026-08-30）。
  if (action === null && ['move_to', 'intercept', 'patrol'].includes(decision)) {
    action = decision;
  }
  if (action === 'move_to') {
    const wp = validatePoint(obj.waypoint ?? obj.waypoints?.[0]);
    if (!wp) return { ok: false, error: 'move_to without a usable waypoint' };
    return { ok: true, obey: false, order: { boat: boatId, action: 'move_to', waypoint: wp }, reason };
  }
  if (action === 'intercept') {
    const target = typeof obj.target === 'string' ? obj.target.trim() : null;
    // 見えていない相手は迎撃できない。名簿外は落とす（parse_orders.js と同じ第一の防壁）
    if (!target || !contactIds.includes(target)) {
      return { ok: false, error: `intercept target "${target}" is not on this boat's radar` };
    }
    return { ok: true, obey: false, order: { boat: boatId, action: 'intercept', target }, reason };
  }
  if (action === 'patrol') {
    const center = obj.center === 'asset' ? 'asset' : validatePoint(obj.center);
    if (!center) return { ok: false, error: 'patrol without a usable center' };
    const radiusM = toFiniteNumber(obj.radius_m ?? obj.radiusM);
    return {
      ok: true,
      obey: false,
      order: { boat: boatId, action: 'patrol', center, ...(radiusM !== null ? { radiusM } : {}) },
      reason,
    };
  }
  return { ok: false, error: `unknown action "${action}"` };
}

/**
 * LLM 艇エージェント。指揮官（llm_commander.js）と同じ型の decide を返す:
 *   decide(picture) → {orders, intent} | null   （null = 現指示を維持）
 *
 * 失敗時にルールベースへ落とさないのも指揮官と同じ理由による。艇の判断は
 * latencyS 後に発効する離散イベントで、来なければ「上書きが無かった」だけ——
 * 世界は指揮官の指示のまま自然に進む。ここでフォールバックを挟むと
 * 「艇 LLM の腕」の成績にルールベースの采配が混ざる。
 *
 * @param {{boatId:string, faction:string, intervalS:number, latencyS:number,
 *   baseUrl:string, model:string, temperature?:number, maxTokens?:number,
 *   timeoutMs?:number, fetchImpl?:typeof fetch, onCall?:(record:object)=>void,
 *   jsonMode?:boolean}} options
 *   jsonMode（既定 true）: agent-io-design.md §4 の⑤（JSON強制）。艇の応答は指揮官より短く
 *   スキーマも簡素なぶん、構文崩れがそのままパース失敗に直結しやすいので既定でオンにする。
 * @returns {Function & {stats: object}}
 */
export function createLlmBoatAgentFn(options) {
  const {
    boatId,
    faction,
    intervalS,
    latencyS,
    baseUrl,
    model,
    temperature = DEFAULT_TEMPERATURE,
    maxTokens = DEFAULT_MAX_TOKENS,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    transport,
    thinking,
    reasoningEffort,
    fetchImpl = undefined,
    onCall = null,
    jsonMode = true,
  } = options ?? {};
  if (!boatId) throw new Error('createLlmBoatAgentFn: boatId is required');
  if (!faction) throw new Error('createLlmBoatAgentFn: faction is required');
  if (!baseUrl) throw new Error('createLlmBoatAgentFn: baseUrl is required');
  if (!model) throw new Error('createLlmBoatAgentFn: model is required');
  if (onCall !== null && typeof onCall !== 'function') {
    throw new Error('createLlmBoatAgentFn: onCall must be a function or null');
  }

  const systemPrompt = buildBoatSystemPrompt(faction, { intervalS, latencyS });

  const stats = {
    calls: 0,
    overrides: 0, // 指揮官の指示を上書きした回数（この実装の主指標）
    obeys: 0,
    parseFailures: 0,
    transportFailures: 0,
    keptOrders: 0, // obey と失敗の合計＝新しい指示を出さなかった回数
    totalLatencyMs: 0,
    totalOutputTokens: 0,
    onCallErrors: 0,
    byOutcome: Object.fromEntries(Object.values(BOAT_OUTCOMES).map((name) => [name, 0])),
  };

  /** @param {ReturnType<typeof buildBoatPicture>} picture */
  async function decide(picture) {
    // 艇の取り違えは推論より前に止める（他艇の視界で判断させると、届く指示は
    // well-formed なまま別の艇のものになる）。
    const userPrompt = renderBoatPictureText(picture, { expectBoatId: boatId });

    stats.calls += 1;
    const startedAt = Date.now();
    let raw = null;
    let outcome = null;
    let failure = null;

    try {
      const res = await postChatCompletion({
        baseUrl,
        model,
        temperature,
        maxTokens,
        timeoutMs,
        ...(transport ? { transport } : {}),
        ...(thinking ? { thinking } : {}),
        ...(reasoningEffort ? { reasoningEffort } : {}),
        fetchImpl,
        systemPrompt,
        userPrompt,
        jsonMode,
      });
      raw = res.text;
      if (res.outputTokens != null) stats.totalOutputTokens += res.outputTokens;
    } catch (err) {
      outcome = err instanceof LlmHttpError ? err.kind : BOAT_OUTCOMES.UNKNOWN;
      failure = `${outcome}: ${err?.message ?? err}`;
      if (err instanceof LlmHttpError && err.outputTokens != null) stats.totalOutputTokens += err.outputTokens;
      stats.transportFailures += 1;
    }
    const latencyMs = Date.now() - startedAt;
    stats.totalLatencyMs += latencyMs;

    let result = null;
    let reason = '';
    if (raw !== null) {
      const parsed = parseBoatDecision(raw, {
        boatId,
        contactIds: picture.contacts.map((c) => c.id),
      });
      if (!parsed.ok) {
        outcome = BOAT_OUTCOMES.PARSE;
        failure = `parse: ${parsed.error}`;
        stats.parseFailures += 1;
      } else if (parsed.obey) {
        outcome = BOAT_OUTCOMES.OBEY;
        stats.obeys += 1;
        reason = parsed.reason;
      } else {
        outcome = BOAT_OUTCOMES.OVERRIDE;
        stats.overrides += 1;
        reason = parsed.reason;
        result = {
          orders: [parsed.order],
          intent: reason || `${boatId} overrides: ${parsed.order.action}`,
        };
      }
    }
    stats.byOutcome[outcome] = (stats.byOutcome[outcome] ?? 0) + 1;
    if (result === null) stats.keptOrders += 1;

    if (onCall) {
      try {
        const returned = onCall({
          t: picture.t,
          episode: picture.episode,
          boatId,
          faction,
          model,
          outcome,
          userPrompt,
          raw,
          result,
          reason,
          latencyMs,
          failure,
        });
        if (returned && typeof returned.then === 'function') {
          returned.then(undefined, () => {
            stats.onCallErrors += 1;
          });
        }
      } catch {
        stats.onCallErrors += 1;
      }
    }
    return result;
  }

  decide.stats = stats;
  return decide;
}

/**
 * 統制群の艇エージェント。常に指揮官の指示に従う＝現行の挙動そのもの。
 * LLM 腕と同型（同じ入力・同じ出力・同じ発効遅延）にしてあるので、
 * 「艇に判断を持たせたこと」だけを差として読める。
 */
export function scriptedBoatAgent() {
  return null; // 常に obey ＝ 新しい指示を出さない
}
