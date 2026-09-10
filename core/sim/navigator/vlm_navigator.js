/**
 * vlm_navigator.js — VLM航海士（単艦・視覚航行の decider）
 *
 * DecisionScheduler から見て指揮官・艇 LLM と同型の decider である:
 *   decide(picture) → 判断  （register(id, {intervalS, stages}) で時間の扱いが乗る）
 *
 * 【この decider だけの特徴】入力に画像が1枚入る。したがって発効までの時間が
 * 「撮る」＋「考える」の2段になり、time-model.md §12.5 のパイプライン宣言
 * `stages: [{name:'render', seconds}, {name:'infer', seconds}]` の**最初の実使用者**になる
 * （L0 では受け口だけ実装されていた）。
 *
 * 【返り値は常にオブジェクト】boat_agent.js は「新しい指示なし」を null で表すが、
 * 航海士は keep のときも watch（見えている危険の1行）を返すので、それを捨てないために
 * 常に判断オブジェクトを返す。プランを差し替えるのは action==='replace' のときだけ。
 *
 * 【失敗してもルールベースへ落とさない】指揮官・艇と同じ理由による。推論が来なければ
 * 「プランが変わらなかった」だけで、船は現行プランのまま目的地へ走り続ける。ここで
 * 回避アルゴリズムを挟むと「VLM の腕」の成績にコード側の航法が混ざる。
 */

import { postChatCompletion, LlmHttpError, LLM_HTTP_FAILURES } from '../agents/llm_http.js';
import {
  buildNavigatorSystemPrompt,
  buildWatchSystemPrompt,
  renderNavigatorPictureText,
} from './navigator_picture.js';
import { parseNavigatorPlan, parseNavigatorManeuver, samePlan, PLAN_NOTES } from './parse_plan.js';
import {
  planAvoidance,
  planClearance,
  closestPointOfApproach,
  MANEUVERS,
  DEFAULT_OFFSET_M,
  MIN_OFFSET_M,
  MAX_OFFSET_M,
} from './avoidance.js';
import { describeContextUsage, CONTEXT_VERDICTS } from '../agents/context_budget.js';

/** 2026-08-30 の閉ループ実測と同じ既定値。移植で条件を変えないための固定 */
const DEFAULT_TEMPERATURE = 0.2;
const DEFAULT_MAX_TOKENS = 400;
/** 画像1枚ぶんの推論はテキストのみより長い（実測 1.4s → 2.7s）。コールドは20s超 */
const DEFAULT_TIMEOUT_MS = 60000;

/** 判断の責務の切り方（アーム）。docs/perception-to-waypoint-flow.md §3.3 の構成A */
export const NAVIGATOR_MODES = Object.freeze({
  /** VLM が waypoint 座標そのものを作る（現行・実測済み） */
  PLAN: 'plan',
  /** VLM は機動を選ぶだけ。waypoint は avoidance.js が CPA から生成する（H2） */
  WATCH: 'watch',
});

const OFFSET_RANGE = Object.freeze({ min: MIN_OFFSET_M, max: MAX_OFFSET_M, dflt: DEFAULT_OFFSET_M });

/** 1判断の結末。'replace' 以外はすべて「現行プランを維持」に落ちる */
export const NAVIGATOR_OUTCOMES = Object.freeze({
  /** 航路を差し替えた */
  REPLACE: 'replace',
  /** 現行プランで良いと判断した（正常。失敗ではない） */
  KEEP: 'keep',
  /** JSON として読めなかった／使える waypoint が1点も残らなかった */
  PARSE: 'parse',
  TIMEOUT: LLM_HTTP_FAILURES.TIMEOUT,
  CONNECTION: LLM_HTTP_FAILURES.CONNECTION,
  HTTP_STATUS: LLM_HTTP_FAILURES.HTTP_STATUS,
  MALFORMED_BODY: LLM_HTTP_FAILURES.MALFORMED_BODY,
  EMPTY_CONTENT: LLM_HTTP_FAILURES.EMPTY_CONTENT,
  THINKING_OVERRUN: LLM_HTTP_FAILURES.THINKING_OVERRUN,
  UNKNOWN: 'unknown',
});

/**
 * VLM航海士を作る。
 *
 * アーム（計画 §6）は**呼び出し側が picture に画像を入れるかどうか**で決まり、この関数は
 * 分岐を持たない。そうしてある理由は統制群の公平性で、`vlm` と `blind` のプロンプトは
 * 「The attached image is ...」「No camera image is available this cycle.」の1行しか違わない
 * （renderNavigatorPictureText が picture.imageDataUrl から自動で切り替える）。
 * 分岐をここに置くと、両アームのプロンプトが別々に育って比較が壊れる。
 *
 * @param {{boatId:string, intervalS:number, latencyS:number, baseUrl:string, model:string,
 *   temperature?:number, maxTokens?:number, timeoutMs?:number, transport?:string,
 *   thinking?:string, reasoningEffort?:string|null, fetchImpl?:typeof fetch,
 *   jsonMode?:boolean, onCall?:((record:object)=>void)|null}} options
 *   latencyS: プロンプトに書く発効遅延。**スケジューラへ渡す宣言値と同じ数**を渡すこと
 *     （stages を使う場合は合成値。食い違うとモデルに嘘を教えることになる）
 *   jsonMode: 既定 false。2026-08-30 の実測（パース失敗 0/15）と同じ条件を保つための既定で、
 *     崩れるモデルに当たったら true にする（艇 LLM は既定 true）
 * @returns {((picture:object)=>Promise<object>) & {stats:object, systemPrompt:string}}
 */
export function createVlmNavigatorFn(options) {
  const {
    boatId,
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
    jsonMode = false,
    /** 'plan'（VLMが座標を作る・既定）か 'watch'（VLMは機動を選ぶだけ）。NAVIGATOR_MODES */
    mode = NAVIGATOR_MODES.PLAN,
    /**
     * A1: 到達と離隔のトレードオフを制御する3つのつまみ。既定値は 2026-09-06 の実測
     * （離隔は達成したが到達が 6/6→4/6 に退行）を受けて選んだ。**それぞれ独立に切れる**
     * ようにしてあるのは、どれが効いたのかを1つずつ測れるようにするため。
     *   widenFactor / widenMax  離隔不足のときに offset を広げる倍率と回数（0回で無効）
     *   roomFraction            目的地までの残距離に対する offset の上限比（0 で無効）
     *   arrivalAware            プロンプトに「迂回は距離のコスト」の1行を入れるか
     */
    /**
     * 既定値は**実測で最良だった構成**に置く（2026-09-06 の最終測定）。
     *
     * | 構成 | median | 最悪 | 経路比 | 到達 |
     * |---|---:|---:|---:|---:|
     * | 直行（統制群） | 28.6 m | 10 m | 0.95 | 6/6 |
     * | watch ＋ CPA veto | 67.9 m | 15 m | 1.23 | 4/6 |
     * | **watch ＋ CPA veto ＋ roomFraction 0.35** | **83.0 m** | **55 m** | **1.07** | **6/6** |
     *
     * `roomFraction` は一度「離隔を損なう」と判定して 0 に戻したが、**その測定は
     * 永久に航路を塞ぐシナリオ上のもので、天井が「周回する相手のすぐ横をすり抜ける」ために
     * 使われていた**。シナリオを横断へ直したあとは、本来の役割
     * （残距離に不釣り合いな迂回を止める）で効いた——離隔不足の広げ直しが
     * 1.6²=307m まで拡大し、残り98mの地点で307mの迂回を打って復帰できなくなる事象を防ぐ。
     *
     * `arrivalAware` は**入れない**。プロンプトに「迂回は距離のコスト」の1行を足した版は
     * 経路をむしろ長くし（1.26→1.57）、離隔も到達も落とした（ablation 実測）。
     */
    widenFactor = 1.6,
    widenMax = 2,
    roomFraction = 0.35,
    arrivalAware = false,
    onCall = null,
  } = options ?? {};
  /**
   * このモデルに宣言してある num_ctx。**判定にしか使わない**（リクエストでは送らない——
   * 派生モデルの Modelfile 側で宣言する運用。docs/multi-vlm-gpu-budget.md §2.3）。
   * `setNumCtx()` で後から入る。応答が返した実測 prompt_tokens と突き合わせて切り捨てを検出する。
   * @type {number|null}
   */
  let numCtx = Number.isFinite(options?.numCtx) ? options.numCtx : null;
  if (!Object.values(NAVIGATOR_MODES).includes(mode)) {
    throw new Error(`createVlmNavigatorFn: mode must be 'plan' or 'watch', got ${mode}`);
  }
  if (!boatId) throw new Error('createVlmNavigatorFn: boatId is required');
  if (!baseUrl) throw new Error('createVlmNavigatorFn: baseUrl is required');
  if (!model) throw new Error('createVlmNavigatorFn: model is required');
  if (onCall !== null && typeof onCall !== 'function') {
    throw new Error('createVlmNavigatorFn: onCall must be a function or null');
  }

  const isWatch = mode === NAVIGATOR_MODES.WATCH;
  const systemPrompt = isWatch
    ? buildWatchSystemPrompt({ intervalS, latencyS, offsetRange: OFFSET_RANGE, arrivalAware })
    : buildNavigatorSystemPrompt({ intervalS, latencyS });

  const stats = {
    calls: 0,
    replaces: 0,
    keeps: 0,
    /** replace と言いながら中身が前回と同じだった回数＝死んだ waypoint の航海士版（L0 の主要指標） */
    resentSamePlan: 0,
    /** サニタイズで落とした waypoint の理由別内訳。ここが増えるなら直すのは幾何の責務分担 */
    droppedByReason: {},
    parseFailures: 0,
    transportFailures: 0,
    /** 入力トークン数の実測（num_ctx が足りているかの唯一の材料） */
    maxPromptTokens: 0,
    /** num_ctx に収まらなかった回数。**1回でも出たらその判断は信用できない** */
    contextOverflows: 0,
    contextTight: 0,
    /** 新しいプランを出さなかった回数（keep ＋ 全失敗） */
    keptPlans: 0,
    withImage: 0,
    withoutImage: 0,
    /** watch アームのみ: 選んだ機動の内訳。「何を選んだか」の分布がそのまま挙動指標になる */
    byManeuver: isWatch ? Object.fromEntries(MANEUVERS.map((m) => [m, 0])) : null,
    /** watch アームのみ: 生成したプランの離隔が offset を満たさなかった回数（H6） */
    clearanceShort: 0,
    /** watch アームのみ: モデルが回避したがったが CPA 的に不要だった回数（A2） */
    avoidanceUnneeded: 0,
    totalLatencyMs: 0,
    totalOutputTokens: 0,
    onCallErrors: 0,
    byOutcome: Object.fromEntries(Object.values(NAVIGATOR_OUTCOMES).map((name) => [name, 0])),
  };

  /** 直前に採用したプラン。同一プラン再送を数えるためだけに持つ（シムのルールには入らない） */
  let lastAcceptedPlan = null;

  /** @param {object} picture buildNavigatorPicture の出力 */
  async function decide(picture) {
    // watch アームでは接触の絶対座標を渡さない（渡さなければ書き写せない）
    const userPrompt = renderNavigatorPictureText(picture, {
      expectBoatId: boatId,
      withContactCoordinates: !isWatch,
    });
    const images = picture.imageDataUrl ? [picture.imageDataUrl] : null;

    stats.calls += 1;
    if (images) stats.withImage += 1;
    else stats.withoutImage += 1;

    const startedAt = Date.now();
    let raw = null;
    let outcome = null;
    let failure = null;
    let promptTokens = null;
    let context = null;

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
        images,
      });
      raw = res.text;
      if (res.outputTokens != null) stats.totalOutputTokens += res.outputTokens;
      if (res.promptTokens != null) {
        promptTokens = res.promptTokens;
        stats.maxPromptTokens = Math.max(stats.maxPromptTokens, res.promptTokens);
        context = describeContextUsage({ numCtx, promptTokens: res.promptTokens, maxOutputTokens: maxTokens });
        if (context.verdict === CONTEXT_VERDICTS.OVERFLOW) stats.contextOverflows += 1;
        else if (context.verdict === CONTEXT_VERDICTS.TIGHT) stats.contextTight += 1;
      }
    } catch (err) {
      outcome = err instanceof LlmHttpError ? err.kind : NAVIGATOR_OUTCOMES.UNKNOWN;
      failure = `${outcome}: ${err?.message ?? err}`;
      if (err instanceof LlmHttpError && err.outputTokens != null) stats.totalOutputTokens += err.outputTokens;
      stats.transportFailures += 1;
    }
    const latencyMs = Date.now() - startedAt;
    stats.totalLatencyMs += latencyMs;

    let plan = { action: 'keep', waypoints: null, watch: null, speed: null, notes: [], parsed: null };
    let resent = false;
    let maneuver = null;
    if (raw !== null) {
      plan = isWatch
        ? interpretWatch(raw, picture, {
            horizonS: intervalS + latencyS,
            widenFactor,
            widenMax,
            roomFraction,
          })
        : parseNavigatorPlan(raw, { picture });
      if (isWatch) maneuver = plan.maneuver;
      for (const note of plan.notes) {
        stats.droppedByReason[note] = (stats.droppedByReason[note] ?? 0) + 1;
      }
      if (plan.parsed === null) {
        outcome = NAVIGATOR_OUTCOMES.PARSE;
        failure = 'parse: no JSON object in the reply';
        stats.parseFailures += 1;
      } else if (plan.action === 'replace') {
        outcome = NAVIGATOR_OUTCOMES.REPLACE;
        stats.replaces += 1;
        resent = samePlan(lastAcceptedPlan, plan.waypoints);
        if (resent) stats.resentSamePlan += 1;
        lastAcceptedPlan = plan.waypoints;
      } else {
        outcome = NAVIGATOR_OUTCOMES.KEEP;
        stats.keeps += 1;
      }
    }
    stats.byOutcome[outcome] = (stats.byOutcome[outcome] ?? 0) + 1;
    if (plan.action !== 'replace') stats.keptPlans += 1;
    if (isWatch && maneuver) {
      stats.byManeuver[maneuver.name] = (stats.byManeuver[maneuver.name] ?? 0) + 1;
      if (plan.notes.includes(PLAN_NOTES.CLEARANCE_SHORT)) stats.clearanceShort += 1;
      if (plan.notes.includes(PLAN_NOTES.CPA_ALREADY_CLEAR)) stats.avoidanceUnneeded += 1;
    }

    const decision = {
      boatId,
      t: picture.t,
      action: plan.action,
      waypoints: plan.waypoints,
      watch: plan.watch,
      speed: plan.speed,
      notes: plan.notes,
      resentSamePlan: resent,
      outcome,
      failure,
      latencyMs,
      hadImage: Boolean(images),
      mode,
      /** watch アームで選ばれた機動と相手・離隔（plan アームでは null） */
      maneuver,
      promptTokens,
      /** num_ctx の妥当性判定（ok / tight / overflow）。overflow はプロンプトの切り捨て＝判断が信用できない */
      context,
    };

    if (onCall) {
      try {
        const returned = onCall({
          ...decision,
          episode: picture.episode,
          model,
          userPrompt,
          raw,
          picture,
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
    return decision;
  }

  decide.stats = stats;
  decide.systemPrompt = systemPrompt;
  /**
   * 宣言 num_ctx を後から差し込む（サーバへの問い合わせは非同期なので、
   * decider の生成時にはまだ分からない）。判定にしか使わない。
   */
  decide.setNumCtx = (value) => {
    numCtx = Number.isFinite(value) ? value : null;
  };
  return decide;
}

/**
 * watch アームの解釈: 機動の選択 → waypoint の生成 → 事後の離隔検査。
 *
 * `parseNavigatorPlan` と同じ形（`{action, waypoints, watch, speed, notes, parsed}`）で返すので、
 * 呼び出し側（`decide` の統計・`RoutePlan`）は plan アームと区別しなくてよい。
 * **座標を作るのはここ（コード側）だけ**で、VLM の応答には座標が1つも含まれない。
 */
function interpretWatch(raw, picture, { horizonS, widenFactor, widenMax, roomFraction }) {
  const m = parseNavigatorManeuver(raw, { picture, maneuvers: MANEUVERS, offsetRange: OFFSET_RANGE });
  const base = {
    watch: m.watch,
    speed: m.speed,
    notes: [...m.notes],
    parsed: m.parsed,
    maneuver: { name: m.maneuver, targetTrack: m.targetTrack, offsetM: m.offsetM },
  };
  if (m.maneuver === 'hold' || m.maneuver === 'slow' || m.maneuver === 'stop') {
    return { ...base, action: 'keep', waypoints: null };
  }

  const target = (picture.radar?.contacts ?? []).find((c) => c.id === m.targetTrack) ?? null;
  /**
   * 離隔が足りなければ **offset を広げて作り直す**。
   *
   * 2026-09-06 の実測: `planClearance` が「生成プランが offset より近い」と3サイクル連続で
   * 鳴っていたのに、そのプランをそのまま適用していた（ep2 で最接近 3m）。
   * VLM の出力なら「落として数える」で正しいが、**これはコード側が作ったプラン**なので、
   * 検出した幾何の失敗は情報ではなく自分のバグである。決定論的に作り直すのが正しい。
   * 回数を切ってあるのは、広げ続けても収束しない幾何（両側を挟まれている等）で止めるため。
   */
  /**
   * A1-(1): 目的地までの残距離に対する迂回の上限。
   * 「離隔だけ」を最大化すると避けすぎて着かない（実測: 到達 6/6→4/6・経路長比 1.84）。
   * 残り 200m の地点で 300m 横へ出るのは幾何的に到達を捨てているのと同じなので、
   * **残距離に比例した天井**を掛ける。避けるか進むかの重みづけそのものは
   * プロンプト側（arrivalAware）とモデルの選択に任せ、ここは幾何の上限だけを守る。
   */
  const roomLimitM =
    roomFraction > 0 && Number.isFinite(picture.destination?.rangeM)
      ? Math.max(MIN_OFFSET_M, picture.destination.rangeM * roomFraction)
      : Infinity;

  /**
   * A2: **そもそも避ける必要があるか**をコード側で判定する。
   *
   * 実測（2026-09-06・横断シナリオ）: モデルは 75 回の判断のうち `hold` を **3 回**しか選ばず、
   * 回避を 66 回選んだ——レーダー範囲（600m）に点が見えれば距離に関係なく避けようとする。
   * 結果として経路長比 1.77 まで迷走し、到達が 3/6 に落ちた。
   *
   * 「その接触は放っておいても離隔を満たすか」は CPA の算術で決まる。
   * モデルが苦手な算術をコード側が引き取るのは、座標生成を取り上げたのと同じ判断である
   * （docs/perception-to-waypoint-flow.md §3.2）。**モデルの意図は記録に残す**ので、
   * 「避けたがったが不要だった」回数は `CPA_ALREADY_CLEAR` として数えられる。
   */
  if (target) {
    const forecast = closestPointOfApproach(
      picture.self,
      {
        eastM: target.eastM,
        northM: target.northM,
        ...(Number.isFinite(target.courseDeg) ? { headingDeg: target.courseDeg } : {}),
        ...(Number.isFinite(target.speedMps) ? { speedMps: target.speedMps } : {}),
      },
      { horizonS }
    );
    if (forecast.rangeM >= m.offsetM) {
      base.notes.push(PLAN_NOTES.CPA_ALREADY_CLEAR);
      return { ...base, action: 'keep', waypoints: null, forecastCpaM: forecast.rangeM };
    }
  }

  let generated = null;
  let usedOffsetM = Math.min(m.offsetM, roomLimitM);
  if (usedOffsetM < m.offsetM) base.notes.push(PLAN_NOTES.OFFSET_ROOM_CAPPED);
  for (let attempt = 0; attempt <= widenMax; attempt++) {
    generated = planAvoidanceOnce(picture, m, target, usedOffsetM, horizonS);
    if (generated.waypoints.length === 0) break;
    const c = planClearance({
      self: picture.self,
      waypoints: generated.waypoints,
      contacts: picture.radar?.contacts ?? [],
    });
    generated.clearanceM = c.minDistanceM;
    if (!Number.isFinite(c.minDistanceM) || c.minDistanceM >= usedOffsetM * 0.5) break;
    if (attempt === widenMax) break;
    const widened = Math.min(usedOffsetM * widenFactor, MAX_OFFSET_M, roomLimitM);
    if (widened <= usedOffsetM + 1e-9) break; // 天井に当たっている。これ以上広げても変わらない
    usedOffsetM = widened;
    generated.notes.push(PLAN_NOTES.OFFSET_WIDENED);
  }
  if (usedOffsetM !== m.offsetM) base.maneuver.offsetM = usedOffsetM;
  base.notes.push(...generated.notes);
  if (generated.waypoints.length === 0) return { ...base, action: 'keep', waypoints: null };
  if (Number.isFinite(generated.clearanceM) && generated.clearanceM < usedOffsetM * 0.5) {
    base.notes.push(PLAN_NOTES.CLEARANCE_SHORT);
  }
  return { ...base, action: 'replace', waypoints: generated.waypoints, clearanceM: generated.clearanceM };
}

/** 1回ぶんの生成（作り直しループから呼ばれる） */
function planAvoidanceOnce(picture, m, target, offsetM, horizonS) {
  const out = planAvoidance({
    self: picture.self,
    destination: picture.destination,
    // レーダーは点しか返さないので相手の針路・速力は不明。avoidance.js が静止として扱う
    // 相手の針路・速力は fuse_tracks.js の有限差分推定（無ければ null＝静止扱い）。
    // ここを渡さないと CPA が「相手は止まっている」前提になり、生成した通過点が
    // 実際には離隔を満たさない（実測: 6エピソードで21件の離隔不足）
    target: target
      ? {
          eastM: target.eastM,
          northM: target.northM,
          ...(Number.isFinite(target.courseDeg) ? { headingDeg: target.courseDeg } : {}),
          ...(Number.isFinite(target.speedMps) ? { speedMps: target.speedMps } : {}),
        }
      : null,
    maneuver: m.maneuver,
    offsetM,
    bounds: picture.bounds,
    // 等速直線の仮定が持つ時間＝このプランが実際に支配する時間だけ先を見る
    horizonS,
  });
  return { ...out, clearanceM: Infinity };
}

/**
 * 統制群の航海士。推論せず、常に現行プラン（＝目的地への直行）を維持する。
 * VLM 腕と同型（同じ入力・同じ出力・同じ発効遅延）なので、
 * 「視覚と推論を足したこと」だけを差として読める。推論サーバ不要で必ず完走する。
 */
export function scriptedNavigator({ boatId = null } = {}) {
  const stats = { calls: 0, replaces: 0, keeps: 0, keptPlans: 0 };
  async function decide(picture) {
    stats.calls += 1;
    stats.keeps += 1;
    stats.keptPlans += 1;
    return {
      boatId: boatId ?? picture.boatId,
      t: picture.t,
      action: 'keep',
      waypoints: null,
      watch: null,
      speed: null,
      notes: [],
      resentSamePlan: false,
      outcome: NAVIGATOR_OUTCOMES.KEEP,
      failure: null,
      latencyMs: 0,
      hadImage: false,
    };
  }
  decide.stats = stats;
  decide.systemPrompt = null;
  return decide;
}
