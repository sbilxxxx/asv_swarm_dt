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
  renderNavigatorPictureText,
} from './navigator_picture.js';
import { parseNavigatorPlan, samePlan } from './parse_plan.js';
import { describeContextUsage, CONTEXT_VERDICTS } from '../agents/context_budget.js';

/** 2026-08-30 の閉ループ実測と同じ既定値。移植で条件を変えないための固定 */
const DEFAULT_TEMPERATURE = 0.2;
const DEFAULT_MAX_TOKENS = 400;
/** 画像1枚ぶんの推論はテキストのみより長い（実測 1.4s → 2.7s）。コールドは20s超 */
const DEFAULT_TIMEOUT_MS = 60000;

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
    /**
     * このモデルに宣言してある num_ctx。**判定にしか使わない**（リクエストでは送らない——
     * 派生モデルの Modelfire 側で宣言する運用。docs/multi-vlm-gpu-budget.md §2.3）。
     * 渡すと、応答が返した実測 prompt_tokens と突き合わせて切り捨てを検出する。
     */
    onCall = null,
  } = options ?? {};
  /** @type {number|null} 宣言 num_ctx。setNumCtx() で後から入る（判定専用） */
  let numCtx = Number.isFinite(options?.numCtx) ? options.numCtx : null;
  if (!boatId) throw new Error('createVlmNavigatorFn: boatId is required');
  if (!baseUrl) throw new Error('createVlmNavigatorFn: baseUrl is required');
  if (!model) throw new Error('createVlmNavigatorFn: model is required');
  if (onCall !== null && typeof onCall !== 'function') {
    throw new Error('createVlmNavigatorFn: onCall must be a function or null');
  }

  const systemPrompt = buildNavigatorSystemPrompt({ intervalS, latencyS });

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
    totalLatencyMs: 0,
    totalOutputTokens: 0,
    onCallErrors: 0,
    byOutcome: Object.fromEntries(Object.values(NAVIGATOR_OUTCOMES).map((name) => [name, 0])),
  };

  /** 直前に採用したプラン。同一プラン再送を数えるためだけに持つ（シムのルールには入らない） */
  let lastAcceptedPlan = null;

  /** @param {object} picture buildNavigatorPicture の出力 */
  async function decide(picture) {
    const userPrompt = renderNavigatorPictureText(picture, { expectBoatId: boatId });
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
    if (raw !== null) {
      plan = parseNavigatorPlan(raw, { picture });
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
