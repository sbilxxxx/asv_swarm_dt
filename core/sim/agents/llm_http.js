/**
 * llm_http.js — OpenAI 互換 /chat/completions への POST（共通部品）
 *
 * 開発は Ollama、GPU サーバでは vLLM。どちらも同じエンドポイント形式なので、
 * ベースURLの差し替えだけで移行できる。指揮官（command/llm_commander.js）と
 * Phase 2 の艇 LLM の両方がここを使う。core/ は fs・DOM 非依存のまま。
 *
 * このモジュールの契約は2つだけ:
 *   1. 必ず有界時間で返る。詰まったサーバー1台で無人実行が永久に止まってはならない。
 *   2. 失敗は必ず「名前の付いた LlmHttpError」で返る。素の TypeError や
 *      undefined を漏らさない。呼び出し側（llm_commander.js）は kind ごとに数え、
 *      実行後に必ず表示する。どの失敗も名前が無いと、直すべきなのがプロンプトなのか
 *      サーバなのかモデル選定なのかを実験ログから判別できない。
 *
 * 有界性は AbortSignal **と** 締切レースの二重で担保する。signal だけでは
 * 「signal を尊重しない fetch 実装」「本体は届いたが body の読み出しが返らない」
 * ケースを取りこぼす。signal も併せて渡すのは、本物の fetch に転送そのものを
 * 止めさせるため（レースだけでは待つのをやめるだけで、通信は裏で続く）。
 *
 * 実時間 API（setTimeout / Date）をここで使うが、これは安全弁と計測のためだけで、
 * シムのルール側へは一切書き戻さない（docs/time-model.md §2.5 I1・§12.5 I4）。
 * 発効遅延は DecisionScheduler の設定値 latencyS が唯一の出所で、実測レイテンシは
 * 記録にしか使わない。
 */

/** 失敗モードの名前。llm_commander.js の stats.byOutcome のキーと同一（呼び出し側で読み替えない） */
export const LLM_HTTP_FAILURES = Object.freeze({
  /** 締切超過。サーバが返さない・遅すぎる */
  TIMEOUT: 'timeout',
  /** 接続そのものが成立しない（プロセス停止・URL 誤り・DNS・CORS 等） */
  CONNECTION: 'connection',
  /** 接続はできたが 2xx ではない（モデル名の誤り・VRAM 不足・過負荷） */
  HTTP_STATUS: 'http_status',
  /** 2xx だが JSON として読めない（プロキシの HTML エラーページ等） */
  MALFORMED_BODY: 'malformed_body',
  /** JSON は読めたが本文が空。thinking 系モデルが max_tokens を推論で使い切った場合など */
  EMPTY_CONTENT: 'empty_content',
});

/** 名前付きの失敗。kind は LLM_HTTP_FAILURES のいずれか */
export class LlmHttpError extends Error {
  /**
   * @param {string} kind - LLM_HTTP_FAILURES のいずれか
   * @param {string} message
   * @param {{status?: number|null, outputTokens?: number|null, cause?: unknown}} [detail]
   */
  constructor(kind, message, { status = null, outputTokens = null, cause = undefined } = {}) {
    super(message, cause !== undefined ? { cause } : undefined);
    this.name = 'LlmHttpError';
    this.kind = kind;
    /** HTTP ステータス（http_status 以外では null） */
    this.status = status;
    /** 失敗しても消費されたトークン数が分かることがある（空応答の診断に使う） */
    this.outputTokens = outputTokens;
  }
}

const DEFAULT_TEMPERATURE = 0.7;
const DEFAULT_MAX_TOKENS = 300;
/**
 * 既定のタイムアウト。本機実測（docs/llm-probe-measurements-2026-08-13.md）は
 * qwen2.5:7b ウォーム p95 2.3s・コールドスタート 8.7s・OLLAMA_NUM_PARALLEL=1 で
 * 指揮官2体が直列化して平均 3.8s。最悪でもコールド＋直列を飲み込める桁にしておく
 * （短すぎるタイムアウトは「サーバは生きているのに全判断が維持になる」実験になる）。
 */
const DEFAULT_TIMEOUT_MS = 30000;
/** エラー本文はログに載る。原因が分かる長さだけ残し、それ以上は切る */
const ERROR_BODY_MAX_CHARS = 200;

/** 既定の fetch。束縛を外して渡すとブラウザで Illegal invocation になるので包む */
function defaultFetch(url, init) {
  if (typeof globalThis.fetch !== 'function') {
    throw new LlmHttpError(
      LLM_HTTP_FAILURES.CONNECTION,
      'no fetch available in this runtime; pass fetchImpl explicitly'
    );
  }
  return globalThis.fetch(url, init);
}

/** 失敗応答の本文を診断用に少しだけ読む。読めなければ諦める（診断のために止まらない） */
async function readBodySnippet(res) {
  if (typeof res?.text !== 'function') return null;
  try {
    const body = await res.text();
    if (typeof body !== 'string' || body.trim() === '') return null;
    return body.slice(0, ERROR_BODY_MAX_CHARS).replace(/\s+/g, ' ').trim();
  } catch {
    return null;
  }
}

/**
 * OpenAI 互換 `POST {baseUrl}/chat/completions` を1回。
 *
 * @param {{baseUrl:string, model:string, temperature?:number, maxTokens?:number, timeoutMs?:number,
 *   fetchImpl?:typeof fetch, systemPrompt:string, userPrompt:string, jsonMode?:boolean}} options
 *   jsonMode: true なら OpenAI 互換の `response_format:{type:"json_object"}` を付ける
 *     （agent-io-design.md §4 の⑤。Ollama/vLLM どちらも対応。プロンプトのスキーマ説明は
 *     引き続き要る——強制されるのは「構文として妥当な JSON」までで、キー名までは強制しない）。
 * @returns {Promise<{text:string, outputTokens:number|null, finishReason:string|null}>}
 * @throws {LlmHttpError} 通信・応答のあらゆる失敗（kind で分類済み）
 */
export async function postChatCompletion({
  baseUrl,
  model,
  temperature = DEFAULT_TEMPERATURE,
  maxTokens = DEFAULT_MAX_TOKENS,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  fetchImpl = defaultFetch,
  systemPrompt,
  userPrompt,
  jsonMode = false,
}) {
  // 設定の誤りは失敗モードではなく呼び出し側のバグ。LlmHttpError にせず素直に投げる
  // （kind を付けて返すと「サーバが不調」として集計され、設定ミスが実験結果に化ける）。
  if (!baseUrl) throw new TypeError('postChatCompletion: baseUrl is required');
  if (!model) throw new TypeError('postChatCompletion: model is required');
  if (typeof fetchImpl !== 'function') throw new TypeError('postChatCompletion: fetchImpl must be a function');
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new TypeError(`postChatCompletion: timeoutMs must be a positive number, got ${timeoutMs}`);
  }

  const url = `${String(baseUrl).replace(/\/+$/, '')}/chat/completions`;
  const controller = new AbortController();
  let timer = null;

  async function request() {
    let res;
    try {
      res = await fetchImpl(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: controller.signal,
        body: JSON.stringify({
          model,
          temperature,
          max_tokens: maxTokens,
          stream: false,
          ...(jsonMode ? { response_format: { type: 'json_object' } } : {}),
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt },
          ],
        }),
      });
    } catch (err) {
      if (err instanceof LlmHttpError) throw err;
      // signal を尊重する fetch は締切で AbortError を投げる。レースの敗者になる場合もあるが、
      // どちらが先でも同じ kind へ落とす。
      if (err?.name === 'AbortError') {
        throw new LlmHttpError(LLM_HTTP_FAILURES.TIMEOUT, `aborted after ${timeoutMs} ms (${model} @ ${url})`, {
          cause: err,
        });
      }
      throw new LlmHttpError(LLM_HTTP_FAILURES.CONNECTION, `cannot reach ${url}: ${err?.message ?? err}`, {
        cause: err,
      });
    }

    if (!res || typeof res !== 'object') {
      throw new LlmHttpError(LLM_HTTP_FAILURES.MALFORMED_BODY, `fetchImpl returned ${typeof res}, not a Response`);
    }
    const status = typeof res.status === 'number' ? res.status : null;
    if (res.ok === false || (status !== null && (status < 200 || status >= 300))) {
      const snippet = await readBodySnippet(res);
      throw new LlmHttpError(
        LLM_HTTP_FAILURES.HTTP_STATUS,
        `HTTP ${status ?? 'error'} from ${url}${snippet ? `: ${snippet}` : ''}`,
        { status }
      );
    }

    let json;
    try {
      json = await res.json();
    } catch (err) {
      throw new LlmHttpError(
        LLM_HTTP_FAILURES.MALFORMED_BODY,
        `response from ${url} is not JSON: ${err?.message ?? err}`,
        { status, cause: err }
      );
    }

    const choice = json?.choices?.[0];
    const text = typeof choice?.message?.content === 'string' ? choice.message.content : '';
    const finishReason = typeof choice?.finish_reason === 'string' ? choice.finish_reason : null;
    const outputTokens = Number.isFinite(json?.usage?.completion_tokens) ? json.usage.completion_tokens : null;

    if (text.trim() === '') {
      // 実測の landmine（docs/llm-probe-measurements-2026-08-13.md）: gpt-oss:20b は
      // thinking 系で、max_tokens=300 では推論だけで予算を使い切り content:"" を返す。
      // 200 で返る＝黙って「指示なし」になるので、ここで名前を付けて止める。
      const reasoning = choice?.message?.reasoning ?? choice?.message?.reasoning_content;
      const reasoningChars = typeof reasoning === 'string' ? reasoning.length : 0;
      throw new LlmHttpError(
        LLM_HTTP_FAILURES.EMPTY_CONTENT,
        `empty content from ${model} (finish_reason=${finishReason ?? 'unknown'}, ` +
          `completion_tokens=${outputTokens ?? 'unknown'}, reasoning=${reasoningChars} chars) — ` +
          'thinking 系モデルは maxTokens (max_tokens) を推論で使い切る。maxTokens を上げるか非 thinking モデルを使う',
        { status, outputTokens }
      );
    }
    return { text, outputTokens, finishReason };
  }

  // 締切レース。signal を無視する fetch 実装や、応答本体の読み出しが返らない場合でも
  // この Promise は必ず timeoutMs で決着する。敗者の rejection は race が拾うので
  // unhandled rejection にはならない。
  const deadline = new Promise((_resolve, reject) => {
    timer = setTimeout(() => {
      const err = new LlmHttpError(LLM_HTTP_FAILURES.TIMEOUT, `timeout after ${timeoutMs} ms (${model} @ ${url})`);
      try {
        controller.abort(err); // 本物の fetch には転送そのものを止めさせる
      } catch {
        /* AbortController が無い実行環境でも締切自体は成立させる */
      }
      reject(err);
    }, timeoutMs);
  });

  try {
    return await Promise.race([request(), deadline]);
  } finally {
    clearTimeout(timer);
  }
}
