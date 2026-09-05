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
  /**
   * reasoning（thinking）は返ってきたのに本文が空。EMPTY_CONTENT の特殊形だが分けて数える。
   * これが出るときの直し方は「プロンプトを直す」ではなく「maxTokens を上げる」か
   * 「thinking を切る」か「非 thinking モデルにする」で、原因の所在がまるで違うため
   * （本モジュールの契約2: 失敗に名前を付けて原因の所在を判別可能にする）。
   * 実測: qwen3:32b は艇1体の判断で reasoning に 3,925 トークン・2分超を要した
   * （docs/thinking-model-plan.md §1）。
   */
  THINKING_OVERRUN: 'thinking_overrun',
});

/**
 * 推論サーバへの経路。thinking の制御方法がバックエンドで違うため、その差をここで吸収する。
 *   'openai' — POST {baseUrl}/chat/completions。vLLM・Ollama 共通。
 *              thinking:'off' は chat_template_kwargs.enable_thinking で送る（vLLM で効く）。
 *              **Ollama はこれを無視する**ことを実測済み（同 §2）。
 *   'ollama' — POST {baseUrl}/api/chat。Ollama ネイティブ。thinking:'off' は think:false で送る。
 *              これが Ollama で thinking を切れる唯一の手段。
 */
export const LLM_TRANSPORTS = Object.freeze({ OPENAI: 'openai', OLLAMA: 'ollama' });

/**
 * 画像は経路ごとに載せ方が違う。差はここだけに閉じ込める（transport と同じ方針）。
 *   'openai' — messages[].content を配列にし、{type:'image_url', image_url:{url:<data URL>}} を足す
 *   'ollama' — messages[].images に **接頭辞を外した生の base64** を並べる（data URL を渡すと 400 になる）
 * 呼び出し側はどちらの経路でも data URL（`data:image/png;base64,...`）を渡してよい。
 */
const DATA_URL_RE = /^data:([a-z]+\/[a-z0-9.+-]+);base64,/i;

/** data URL なら本体だけを取り出す。生の base64 はそのまま通す（Ollama ネイティブ用） */
function toBareBase64(image) {
  const m = DATA_URL_RE.exec(image);
  return m ? image.slice(m[0].length) : image;
}

/** 生の base64 なら PNG の data URL に包む。OpenAI 互換は data URL しか受けない */
function toDataUrl(image) {
  return DATA_URL_RE.test(image) ? image : `data:image/png;base64,${image}`;
}

/**
 * images の検証。設定の誤りは失敗モードではなく呼び出し側のバグなので素直に投げる
 * （postChatCompletion 冒頭の baseUrl/model と同じ扱い）。
 * @returns {string[]|null} 正規化済み（空配列・null はどちらも「画像なし」）
 */
function validateImages(images) {
  if (images === null || images === undefined) return null;
  if (!Array.isArray(images)) {
    throw new TypeError(`postChatCompletion: images must be an array of data URLs, got ${typeof images}`);
  }
  if (images.length === 0) return null;
  for (const img of images) {
    if (typeof img !== 'string' || img.trim() === '') {
      throw new TypeError(`postChatCompletion: images must contain non-empty strings, got ${JSON.stringify(img)}`);
    }
  }
  return images;
}

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
 *   images: data URL（または生の base64）の配列。省略・空配列なら body は画像対応前とバイト同一で、
 *     既存の呼び出し（指揮官・艇 LLM）は一切影響を受けない。指定すると VLM への画像入力になる
 *     （L1 単艦 VLM 航海士・vlm-multi-agent-plan.md §6.1）。
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
  images = null,
  transport = LLM_TRANSPORTS.OPENAI,
  thinking = 'auto',
  reasoningEffort = null,
}) {
  // 設定の誤りは失敗モードではなく呼び出し側のバグ。LlmHttpError にせず素直に投げる
  // （kind を付けて返すと「サーバが不調」として集計され、設定ミスが実験結果に化ける）。
  if (!baseUrl) throw new TypeError('postChatCompletion: baseUrl is required');
  if (!model) throw new TypeError('postChatCompletion: model is required');
  if (typeof fetchImpl !== 'function') throw new TypeError('postChatCompletion: fetchImpl must be a function');
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new TypeError(`postChatCompletion: timeoutMs must be a positive number, got ${timeoutMs}`);
  }
  if (transport !== LLM_TRANSPORTS.OPENAI && transport !== LLM_TRANSPORTS.OLLAMA) {
    throw new TypeError(`postChatCompletion: transport must be 'openai' or 'ollama', got ${transport}`);
  }
  const imageList = validateImages(images);
  if (!['auto', 'on', 'off'].includes(thinking)) {
    throw new TypeError(`postChatCompletion: thinking must be 'auto'|'on'|'off', got ${thinking}`);
  }

  const isOllama = transport === LLM_TRANSPORTS.OLLAMA;
  const base = String(baseUrl).replace(/\/+$/, '');
  const url = isOllama ? `${base}/api/chat` : `${base}/chat/completions`;
  // 画像なしのときは content を文字列のままにする（＝画像対応前と body がバイト同一）。
  // 既存の実測（L0 の 1,554 コール）と比較可能であり続けるための後方互換で、テストで固定してある。
  const userMessage =
    imageList && !isOllama
      ? {
          role: 'user',
          content: [
            { type: 'text', text: userPrompt },
            ...imageList.map((img) => ({ type: 'image_url', image_url: { url: toDataUrl(img) } })),
          ],
        }
      : imageList
        ? { role: 'user', content: userPrompt, images: imageList.map(toBareBase64) }
        : { role: 'user', content: userPrompt };
  const messages = [{ role: 'system', content: systemPrompt }, userMessage];
  // 経路ごとに body の形も thinking の指定方法も違う。差はここだけに閉じ込め、
  // 戻り値（{text, outputTokens, finishReason}）は同一にする。
  const body = isOllama
    ? {
        model,
        messages,
        stream: false,
        ...(thinking === 'off' ? { think: false } : thinking === 'on' ? { think: true } : {}),
        ...(jsonMode ? { format: 'json' } : {}),
        options: {
          temperature,
          num_predict: maxTokens,
          ...(reasoningEffort ? { reasoning_effort: reasoningEffort } : {}),
        },
      }
    : {
        model,
        temperature,
        max_tokens: maxTokens,
        stream: false,
        // vLLM はこれを解釈する。Ollama は無視することを実測済み（thinking-model-plan.md §2）ので、
        // Ollama で thinking を切りたいなら transport:'ollama' を選ぶこと。
        ...(thinking === 'off' ? { chat_template_kwargs: { enable_thinking: false } } : {}),
        ...(reasoningEffort ? { reasoning_effort: reasoningEffort } : {}),
        ...(jsonMode ? { response_format: { type: 'json_object' } } : {}),
        messages,
      };
  const controller = new AbortController();
  let timer = null;

  async function request() {
    let res;
    try {
      res = await fetchImpl(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: controller.signal,
        body: JSON.stringify(body),
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

    // Ollama ネイティブは {message:{content, thinking}, done_reason, eval_count}、
    // OpenAI 互換は {choices:[{message:{content, reasoning}, finish_reason}], usage}
    const msg = isOllama ? json?.message : json?.choices?.[0]?.message;
    const text = typeof msg?.content === 'string' ? msg.content : '';
    const finishReason = isOllama
      ? (typeof json?.done_reason === 'string' ? json.done_reason : null)
      : (typeof json?.choices?.[0]?.finish_reason === 'string' ? json.choices[0].finish_reason : null);
    const outputTokens = isOllama
      ? (Number.isFinite(json?.eval_count) ? json.eval_count : null)
      : (Number.isFinite(json?.usage?.completion_tokens) ? json.usage.completion_tokens : null);

    if (text.trim() === '') {
      // 実測の landmine（docs/llm-probe-measurements-2026-08-13.md）: gpt-oss:20b は
      // thinking 系で、max_tokens=300 では推論だけで予算を使い切り content:"" を返す。
      // 200 で返る＝黙って「指示なし」になるので、ここで名前を付けて止める。
      const reasoning = msg?.thinking ?? msg?.reasoning ?? msg?.reasoning_content;
      const reasoningChars = typeof reasoning === 'string' ? reasoning.length : 0;
      // reasoning が出ているなら原因は明確に thinking の予算超過。プロンプトの問題と混ぜない
      const kind = reasoningChars > 0 ? LLM_HTTP_FAILURES.THINKING_OVERRUN : LLM_HTTP_FAILURES.EMPTY_CONTENT;
      throw new LlmHttpError(
        kind,
        `empty content from ${model} (finish_reason=${finishReason ?? 'unknown'}, ` +
          `completion_tokens=${outputTokens ?? 'unknown'}, reasoning=${reasoningChars} chars) — ` +
          (reasoningChars > 0
            ? 'thinking が maxTokens を使い切った。maxTokens を上げるか、thinking:"off"（Ollama は transport:"ollama" が必要）にするか、非 thinking モデルを使う'
            : 'thinking 系モデルは maxTokens (max_tokens) を推論で使い切る。maxTokens を上げるか非 thinking モデルを使う'),
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
