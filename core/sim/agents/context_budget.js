/**
 * context_budget.js — コンテキスト長（num_ctx）を実測から決め、実行時に検証する
 *
 * 【なぜ仕組みが要るか】num_ctx は「大きめにしておけば安全」な値ではない。両側に事故がある。
 *
 *   小さすぎる → **無警告でプロンプトが切り捨てられる。** 推論サーバはエラーを返さず、
 *                 画像や状況図の一部が落ちた入力に対して普通に答える。
 *                 「VLM の判断が悪い」ように見えるが、実際には見せた情報が届いていない
 *                 ——実験ログからは絶対に判別できない、最悪の種類の故障である。
 *   大きすぎる → **VRAM を KV キャッシュで食い潰す。** 実測（2026-09-06・A5000×8）:
 *                 `qwen2.5vl:7b`（重み約6GB）が **85.9 GB** の VRAM を掴んでいた。
 *                 内訳は KV キャッシュが支配的で、num_ctx=128,000 × 8 並列スロット
 *                 × 56 KB/token ≈ 58.7 GB。num_ctx を 4,096 に落とせば 1.9 GB になる。
 *                 マルチエージェントで同時に何体走らせられるかを直接決めるのはこの値である。
 *
 * 【方針は time-model.md と同じ】値は**人間が実測を見て選ぶ設定値**で、実測値を自動で
 * 書き戻すことはしない。ここが提供するのは
 *   1. 見積り（recommendNumCtx）— 何を根拠にその値なのかを再現できる形で計算する
 *   2. 検証（describeContextUsage）— 実際に使われたトークン数が宣言値に収まっていたかを確かめる
 * の2つだけで、実行中に num_ctx を勝手に変えることはしない（変えると推論サーバが
 * スロットを作り直し、ランの途中で VRAM 使用量と速度が変わってしまう）。
 */

/**
 * 画像1枚のトークン数（画素あたり）。
 * 実測: 640×360 の PNG が約 1,040 トークン（2026-08-14 / 08-30 の2回とも同じ桁）。
 * 230,400 px / 1,040 tok ≈ 222 px/token。モデル系列で変わるので安全側に見積もる。
 */
const PIXELS_PER_IMAGE_TOKEN = 222;
/** 英文のトークン概算（1トークンあたりの文字数）。安全側に小さめを取る */
const CHARS_PER_TEXT_TOKEN = 3;
/**
 * 見積りに掛ける余裕と下限。**方針の出所は `scripts/suggest_num_ctx.js`**（実測ツール側）で、
 * ここはその値に合わせてある——2箇所で違う推奨値が出ると、どちらを信じるかが分からなくなる。
 * 片方を変えるときは必ず両方を変えること。
 */
const DEFAULT_MARGIN = 1.5;
const MIN_NUM_CTX = 2048;

/** 1024 の倍数へ切り上げる（suggest_num_ctx.js と同じ粒度） */
function ceilToBlock(n) {
  return Math.max(MIN_NUM_CTX, Math.ceil(n / 1024) * 1024);
}

/**
 * プロンプトのトークン数を見積もる。**実測が取れているならそちらを使うこと**——
 * これは「初回の呼び出しの前に num_ctx を決める」ためだけの見積りである。
 *
 * @param {{systemPrompt?:string, userPrompt?:string, images?:Array<{widthPx:number,heightPx:number}>}} input
 * @returns {{textTokens:number, imageTokens:number, total:number}}
 */
export function estimatePromptTokens({ systemPrompt = '', userPrompt = '', images = [] } = {}) {
  const chars = String(systemPrompt).length + String(userPrompt).length;
  const textTokens = Math.ceil(chars / CHARS_PER_TEXT_TOKEN);
  let imageTokens = 0;
  for (const img of images) {
    const px = (img?.widthPx ?? 0) * (img?.heightPx ?? 0);
    imageTokens += Math.ceil(px / PIXELS_PER_IMAGE_TOKEN);
  }
  return { textTokens, imageTokens, total: textTokens + imageTokens };
}

/**
 * num_ctx の推奨値。**入力＋出力の両方が同じ窓に入る**必要がある点に注意
 * （出力を忘れると、長い応答の途中で入力側が押し出される）。
 *
 * @param {{promptTokens:number, maxOutputTokens:number, margin?:number}} input
 *   promptTokens: 実測（推奨）または estimatePromptTokens の見積り
 * @returns {{numCtx:number, need:number, margin:number, reason:string}}
 */
export function recommendNumCtx({ promptTokens, maxOutputTokens, margin = DEFAULT_MARGIN }) {
  if (!Number.isFinite(promptTokens) || promptTokens <= 0) {
    throw new TypeError(`recommendNumCtx: promptTokens must be a positive number, got ${promptTokens}`);
  }
  if (!Number.isFinite(maxOutputTokens) || maxOutputTokens <= 0) {
    throw new TypeError(`recommendNumCtx: maxOutputTokens must be a positive number, got ${maxOutputTokens}`);
  }
  const need = Math.ceil((promptTokens + maxOutputTokens) * margin);
  const numCtx = ceilToBlock(need);
  return {
    numCtx,
    need,
    margin,
    reason:
      `prompt ${promptTokens} + output ${maxOutputTokens} = ${promptTokens + maxOutputTokens} tok, ` +
      `× margin ${margin} = ${need} → 1024の倍数へ切り上げて ${numCtx}`,
  };
}

/**
 * KV キャッシュの所要 VRAM。モデルの形（block_count・kv head 数・head_dim）から求める。
 * `ollama show`（/api/show の model_info）で取れる値をそのまま渡せる。
 *
 * 実測との突き合わせ（qwen2.5vl:7b）: blocks=28, kvHeads=4, headDim=128 → 56 KB/token。
 * num_ctx=128,000 × 8 スロット = 58.7 GB。`ollama ps` の size_vram 85.9 GB とほぼ一致する
 * （残りは重み約6GB＋vision tower＋計算バッファ）。
 *
 * @param {{blocks:number, kvHeads:number, headDim:number, bytesPerElement?:number,
 *   numCtx:number, parallelSlots?:number}} input
 * @returns {{bytesPerToken:number, bytesPerSlot:number, totalBytes:number}}
 */
export function kvCacheBytes({ blocks, kvHeads, headDim, bytesPerElement = 2, numCtx, parallelSlots = 1 }) {
  for (const [name, v] of Object.entries({ blocks, kvHeads, headDim, numCtx, parallelSlots })) {
    if (!Number.isFinite(v) || v <= 0) throw new TypeError(`kvCacheBytes: ${name} must be positive, got ${v}`);
  }
  // K と V の2本ぶん
  const bytesPerToken = 2 * blocks * kvHeads * headDim * bytesPerElement;
  const bytesPerSlot = bytesPerToken * numCtx;
  return { bytesPerToken, bytesPerSlot, totalBytes: bytesPerSlot * parallelSlots };
}

/** 実測の使用量が宣言値に収まっていたかの判定結果 */
export const CONTEXT_VERDICTS = Object.freeze({
  /** 収まっている */
  OK: 'ok',
  /** 収まってはいるが余裕が薄い。プロンプトが少し伸びると切り捨てに落ちる */
  TIGHT: 'tight',
  /** **切り捨てが起きた可能性がある。** 判断そのものを信用してはいけない */
  OVERFLOW: 'overflow',
});

/** 余裕がこの割合を下回ったら TIGHT とする */
const TIGHT_HEADROOM = 0.1;

/**
 * 実測トークン数から、宣言した num_ctx が妥当だったかを判定する。
 * **判定するだけで num_ctx は変えない**（モジュール冒頭の方針）。
 *
 * @param {{numCtx:number|null, promptTokens:number|null, maxOutputTokens:number}} input
 * @returns {{verdict:string, headroom:number|null, message:string}}
 */
export function describeContextUsage({ numCtx, promptTokens, maxOutputTokens }) {
  if (!Number.isFinite(numCtx) || !Number.isFinite(promptTokens)) {
    return { verdict: CONTEXT_VERDICTS.OK, headroom: null, message: 'num_ctx / prompt_tokens が未計測（判定なし）' };
  }
  const used = promptTokens + maxOutputTokens;
  const headroom = (numCtx - used) / numCtx;
  if (promptTokens >= numCtx) {
    return {
      verdict: CONTEXT_VERDICTS.OVERFLOW,
      headroom,
      message:
        `prompt ${promptTokens} tok が num_ctx ${numCtx} 以上。**入力が切り捨てられている** ` +
        `（画像や状況図の一部がモデルに届いていない可能性がある。この判断は信用できない）`,
    };
  }
  if (used > numCtx) {
    return {
      verdict: CONTEXT_VERDICTS.OVERFLOW,
      headroom,
      message:
        `prompt ${promptTokens} + maxTokens ${maxOutputTokens} = ${used} tok が num_ctx ${numCtx} を超える。` +
        `長い応答のときに入力側が押し出される`,
    };
  }
  if (headroom < TIGHT_HEADROOM) {
    return {
      verdict: CONTEXT_VERDICTS.TIGHT,
      headroom,
      message: `余裕 ${(headroom * 100).toFixed(1)}%（${numCtx - used} tok）。プロンプトが伸びると切り捨てに落ちる`,
    };
  }
  return {
    verdict: CONTEXT_VERDICTS.OK,
    headroom,
    message: `prompt ${promptTokens} + maxTokens ${maxOutputTokens} / num_ctx ${numCtx}（余裕 ${(headroom * 100).toFixed(0)}%）`,
  };
}

/**
 * `/api/show` が返す `parameters` 文字列から宣言 num_ctx を読む。
 *
 * **これが「適切な値を設定する仕組み」の要**である。num_ctx をコード側にも書くと
 * 「モデルの実際の窓」と「コードが思っている窓」が黙って食い違う——
 * 派生モデルを作り直した日から、検証が嘘をつき始める。
 * したがって値の出所はモデル1つだけにし、コードは**読む側**に徹する。
 *
 * @param {string} parametersText - 例: "num_ctx  3072\ntemperature  0.2"
 * @returns {number|null} 宣言が無ければ null（＝モデルの既定＝たいてい非常に大きい）
 */
export function parseDeclaredNumCtx(parametersText) {
  if (typeof parametersText !== 'string') return null;
  const m = /^\s*num_ctx\s+(\d+)\s*$/m.exec(parametersText);
  return m ? Number(m[1]) : null;
}

/**
 * 推論サーバへ問い合わせて、そのモデルの宣言 num_ctx を得る。
 * 取れなければ null を返すだけで、失敗させない（検証は「できるならやる」もの）。
 *
 * @param {{baseUrl:string, model:string, fetchImpl?:typeof fetch, timeoutMs?:number}} options
 *   baseUrl: Ollama のルート（`/v1` を含まない。含んでいれば落とす）
 */
export async function fetchDeclaredNumCtx({ baseUrl, model, fetchImpl = globalThis.fetch, timeoutMs = 8000 }) {
  try {
    const root = String(baseUrl).replace(/\/+$/, '').replace(/\/v1$/, '');
    const res = await fetchImpl(`${root}/api/show`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return null;
    const json = await res.json();
    return parseDeclaredNumCtx(json?.parameters ?? '');
  } catch {
    return null;
  }
}
