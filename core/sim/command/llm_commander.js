/**
 * llm_commander.js — LLM 指揮官
 *
 * 統合図（fused_picture）をテキスト化して OpenAI 互換サーバへ投げ、
 * orders へパースして返す。失敗（不達・パース不能・有効指示ゼロ）時は null を返し、
 * 「現在の指示を維持」として扱う。失敗は黙って通さない: stats に数え、
 * 実行後にランナーが必ず表示する。
 *
 * 【なぜ指揮官にはルールベースのフォールバックが無いのか】
 * 艇レベルの LlmAgent（agents/llm_agent.js）は decideFn 未指定なら
 * simpleRuleBasedDecision（agents/rule_based_fallback.js）へ落ちる。艇は毎tick
 * {throttle, steering} を出す義務があり、「何も返さない」が存在しないからである。
 * 指揮官にはその義務が無い。指示は latencyS 後に発効する離散イベントで、艇は
 * 発効までもとの指示を実行し続ける（boat_controller.js が毎ステップ追従する）。
 * つまり指揮官の失敗は「新しい指示が来ない」という自然な形で世界に現れるので、
 * ここで scripted 指揮官へ差し替えてはならない——差し替えると
 * 「LLM 指揮官の腕」として集計した結果に、実はルールベースの采配が混ざる。
 * 統制群が要るなら scripted_commanders.js を別の腕として走らせるのが正しい
 * （ランナーの --blue/--red がまさにそれ）。
 * 代わりに keptOrders（維持に落ちた回数）を必ず数える。L0 の完了条件はこの率が
 * 20% 未満であることなので、数えられなければ実験そのものが判定できない。
 *
 * 【陣営インターロック】
 * systemPrompt は生成時に1度だけ作り、picture は判断ごとに受け取る。両者は離れた場所で
 * 決まるので、renderPictureText に expectFaction を渡して突き合わせる（commander_prompt.js）。
 * 取り違えた統合図は相手陣営の全艇の真位置をそのまま渡す全面漏洩であり、しかも文面は
 * well-formed で正しいものと見分けが付かない。これは推論の失敗ではなく配線の誤りなので、
 * keptOrders に数えて飲み込まず、そのまま投げてエピソードを止める。
 *
 * 【実時間の扱い】
 * Date.now() を使うのは latencyMs の記録のためだけで、シムのルール側へは書き戻さない
 * （docs/time-model.md §2.5 I1・§12.5 I4）。発効遅延は DecisionScheduler の設定値
 * latencyS が唯一の出所であり、この計測値は決して発効時刻に影響しない。
 */

import { postChatCompletion, LlmHttpError, LLM_HTTP_FAILURES } from '../agents/llm_http.js';
import { buildCommanderSystemPrompt, renderPictureText } from './commander_prompt.js';
import { parseOrders } from './parse_orders.js';

const DEFAULT_TEMPERATURE = 0.7;
const DEFAULT_MAX_TOKENS = 300;
const DEFAULT_TIMEOUT_MS = 30000;

/**
 * 1判断の結末の名前。stats.byOutcome のキーであり、onCall 記録の outcome でもある。
 * 'ok' 以外はすべて「現在の指示を維持」に落ちる（＝keptOrders が1つ増える）。
 */
export const COMMANDER_OUTCOMES = Object.freeze({
  /** orders を1件以上受理した */
  OK: 'ok',
  /** 応答は届いたが有効な指示が取れなかった（JSON なし・全行が名簿外 等）＝プロンプト側の問題 */
  PARSE: 'parse',
  TIMEOUT: LLM_HTTP_FAILURES.TIMEOUT,
  CONNECTION: LLM_HTTP_FAILURES.CONNECTION,
  HTTP_STATUS: LLM_HTTP_FAILURES.HTTP_STATUS,
  MALFORMED_BODY: LLM_HTTP_FAILURES.MALFORMED_BODY,
  EMPTY_CONTENT: LLM_HTTP_FAILURES.EMPTY_CONTENT,
  /** llm_http が名前を付け損ねた想定外の例外。0 でないなら HTTP 層のバグ */
  UNKNOWN: 'unknown',
});

/**
 * @param {{faction:string, intervalS:number, latencyS:number, baseUrl:string, model:string,
 *   temperature?:number, maxTokens?:number, timeoutMs?:number, fetchImpl?:typeof fetch,
 *   onCall?:(record:object)=>void}} options
 * @returns {Function & {stats: object}} decide(picture) → {orders, intent} | null
 */
export function createLlmCommanderFn(options) {
  const {
    faction,
    intervalS,
    latencyS,
    baseUrl,
    model,
    temperature = DEFAULT_TEMPERATURE,
    maxTokens = DEFAULT_MAX_TOKENS,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    fetchImpl = undefined, // 既定は llm_http 側（globalThis.fetch を包んだもの）に任せる
    onCall = null,
    jsonMode = true, // agent-io-design.md §4 の⑤（JSON強制）。既定でオン
  } = options ?? {};
  if (!faction) throw new Error('createLlmCommanderFn: faction is required');
  if (!baseUrl) throw new Error('createLlmCommanderFn: baseUrl is required');
  if (!model) throw new Error('createLlmCommanderFn: model is required');
  if (onCall !== null && typeof onCall !== 'function') {
    throw new Error('createLlmCommanderFn: onCall must be a function or null');
  }

  // 陣営が不正ならここで落ちる（判断1回目まで持ち越さない）。intervalS/latencyS は
  // DecisionScheduler.register() へ渡すものと同一の設定を使うこと。
  const systemPrompt = buildCommanderSystemPrompt(faction, { intervalS, latencyS });

  const stats = {
    calls: 0,
    ok: 0,
    parseFailures: 0,
    transportFailures: 0,
    keptOrders: 0, // 失敗により「現指示維持」になった回数（完了条件: calls の 20% 未満）
    droppedOrders: 0, // 部分受理で落ちた指示行の数
    totalLatencyMs: 0,
    totalOutputTokens: 0,
    onCallErrors: 0, // 記録フック自身の失敗回数（采配は続行する。無言で消さないために数える）
    /** 結末の内訳。keptOrders の内訳でもある: 直すべきがプロンプトかサーバかを分ける */
    byOutcome: Object.fromEntries(Object.values(COMMANDER_OUTCOMES).map((name) => [name, 0])),
  };

  /** @param {ReturnType<import('./fused_picture.js').buildFusedPicture>} picture */
  async function decide(picture) {
    // 陣営の突き合わせは推論より前・stats より前。取り違えは失敗ではなく配線の誤りなので
    // ここで throw し、統計にも載せない（載せると「サーバ不調」として集計されてしまう）。
    const userPrompt = renderPictureText(picture, { expectFaction: faction });

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
        fetchImpl,
        systemPrompt,
        userPrompt,
        jsonMode,
      });
      raw = res.text;
      if (res.outputTokens != null) stats.totalOutputTokens += res.outputTokens;
    } catch (err) {
      // ここへ来る例外はすべて名前を持つ（llm_http の契約）。名無しで来たら HTTP 層のバグなので
      // 握り潰さず 'unknown' として数える。どちらにせよエピソードは止めない。
      outcome = err instanceof LlmHttpError ? err.kind : COMMANDER_OUTCOMES.UNKNOWN;
      failure = `${outcome}: ${err?.message ?? err}`;
      if (err instanceof LlmHttpError && err.outputTokens != null) stats.totalOutputTokens += err.outputTokens;
      stats.transportFailures += 1;
    }
    const latencyMs = Date.now() - startedAt;
    stats.totalLatencyMs += latencyMs;

    let result = null;
    let dropped = [];
    if (raw !== null) {
      // 名簿は「提示した統合図」から作る。自分が指揮しない艇・自軍が探知していない
      // トラックへの指示はここで落ちる（parse_orders.js の第一の防壁）。
      const parsed = parseOrders(raw, {
        ownBoatIds: picture.ownForce.map((b) => b.id),
        trackIds: picture.tracks.map((t) => t.id),
      });
      dropped = parsed.dropped;
      stats.droppedOrders += dropped.length;
      if (parsed.ok) {
        result = { orders: parsed.orders, intent: parsed.intent };
        outcome = COMMANDER_OUTCOMES.OK;
        stats.ok += 1;
      } else {
        outcome = COMMANDER_OUTCOMES.PARSE;
        failure = `parse: ${parsed.error}${dropped.length > 0 ? ` (dropped ${dropped.length})` : ''}`;
        stats.parseFailures += 1;
      }
    }
    stats.byOutcome[outcome] = (stats.byOutcome[outcome] ?? 0) + 1;
    if (result === null) stats.keptOrders += 1;

    if (onCall) {
      // 記録フックの失敗で采配が止まってはならない（ログはあくまで観察側）。
      // ただし黙って消すと「記録が無い＝呼ばれていない」と読めてしまうので数える。
      // フックは非同期でもよい（JSONL や fs へ書くロガーは自然にその形になる）。その場合
      // 失敗は throw ではなく reject として遅れて届くので、try/catch だけでは取り逃がす。
      // 取り逃がすと未処理 rejection で無人実行そのものが exit 1 で死に、しかも
      // onCallErrors は 0 のまま＝「フックの失敗を見えるようにする」というこのカウンタの
      // 目的が裏返る。await はしない: 記録の完了を待つと、記録側の都合（ディスクの遅さ）が
      // 実測レイテンシへ混ざる（docs/time-model.md §2.5 の一方通行）。
      try {
        const returned = onCall({
          t: picture.t,
          episode: picture.episode,
          faction,
          model,
          outcome,
          userPrompt,
          raw,
          result,
          dropped, // 落とした指示行と理由。プロンプト調整の一次資料になる
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
