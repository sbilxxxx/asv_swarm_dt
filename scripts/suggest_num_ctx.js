/**
 * suggest_num_ctx.js — 実測に基づいて num_ctx を決める。
 *
 * 【なぜ要るか】
 * Ollama は num_ctx で宣言した長さの KV キャッシュを**先に丸ごと確保する**。
 * 実際に使う長さとは無関係なので、既定のまま（最近のモデルは 128K〜256K）載せると
 * 7B のモデルでも 85GB を占有する。2026-09-05 に実測した差:
 *   qwen2.5:7b  num_ctx=128,000 → 85 GB / num_ctx=8,192 → 8.7 GB（約10倍）
 * これが原因で GPU が溢れ、実験が 86% CPU へ退避して7時間空回りした。
 *
 * 【やり方】
 * num_predict=1 の呼び出しを1回投げ、応答の prompt_eval_count を読む。
 * これがそのプロンプトの**正確な**トークン数である（推定ではない）。
 * Ollama には /api/tokenize が無いので（0.33.2 で 404 を確認）、この方法が最も確実。
 *
 * 【VLM の注意】
 * 画像はテキストよりはるかに高い。実測（qwen2.5vl:7b・1280x720 PNG 1枚）:
 *   テキストのみ 24 トークン / 同じ文言＋画像1枚 1,222 トークン → **画像1枚で 1,198 トークン**
 * したがって「プロンプトは数百トークンだから 8192 で十分」という text 側の勘は
 * VLM にそのまま持ち込めない。枚数と解像度を込みで実測すること。
 *
 * 使い方:
 *   node scripts/suggest_num_ctx.js --model qwen2.5:7b --prompt-file p.txt --max-tokens 300
 *   node scripts/suggest_num_ctx.js --model qwen2.5vl:7b --url http://127.0.0.1:11434 \
 *        --image frame.png --image frame2.png --max-tokens 400
 *   ... --create qwen2.5-7b-ctx8k     # 推奨値で派生モデルまで作る
 */
'use strict';

const fs = require('node:fs');
const { execFileSync } = require('node:child_process');

/** 余裕率。プロンプトは実行時に少し伸びる（トラック数・接触数が増える）ので見込んでおく */
const SAFETY = 1.5;
/** 下限。これを下回るとモデル側の最小要求に触れることがある */
const MIN_CTX = 2048;

function parseArgs(argv) {
  const o = {
    url: 'http://127.0.0.1:11434',
    model: null,
    prompt: 'Describe the situation and reply with a short JSON object.',
    system: null,
    images: [],
    maxTokens: 300,
    create: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--url') o.url = argv[++i];
    else if (a === '--model') o.model = argv[++i];
    else if (a === '--prompt') o.prompt = argv[++i];
    else if (a === '--prompt-file') o.prompt = fs.readFileSync(argv[++i], 'utf8');
    else if (a === '--system-file') o.system = fs.readFileSync(argv[++i], 'utf8');
    else if (a === '--image') o.images.push(argv[++i]);
    else if (a === '--max-tokens') o.maxTokens = Number(argv[++i]);
    else if (a === '--create') o.create = argv[++i];
    else if (a === '--help' || a === '-h') {
      console.log(
        'usage: node scripts/suggest_num_ctx.js --model NAME [--url URL] [--prompt-file F]\n' +
          '       [--system-file F] [--image PATH]... [--max-tokens N] [--create DERIVED_NAME]'
      );
      process.exit(0);
    } else throw new Error(`unknown argument: ${a}`);
  }
  if (!o.model) throw new Error('--model is required');
  return o;
}

/** num_predict=1 で1回叩き、prompt_eval_count を読む */
async function measurePromptTokens(o) {
  const messages = [];
  if (o.system) messages.push({ role: 'system', content: o.system });
  const user = { role: 'user', content: o.prompt };
  if (o.images.length > 0) {
    user.images = o.images.map((p) => fs.readFileSync(p).toString('base64'));
  }
  messages.push(user);
  const res = await fetch(`${o.url.replace(/\/+$/, '')}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: o.model, messages, stream: false, options: { num_predict: 1 } }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const json = await res.json();
  const n = json?.prompt_eval_count;
  if (!Number.isFinite(n)) throw new Error(`prompt_eval_count が取れない: ${JSON.stringify(json).slice(0, 200)}`);
  return n;
}

/** 1024 の倍数へ切り上げる（KV の確保単位に合わせておくと無駄が出にくい） */
function roundUp1024(n) {
  return Math.max(MIN_CTX, Math.ceil(n / 1024) * 1024);
}

async function main() {
  const o = parseArgs(process.argv.slice(2));

  // 画像ありの場合、画像なしでも測って「画像1枚あたりの費用」を出す。
  // VLM で num_ctx を決めるとき、枚数が増えたらいくら要るかがこの数から分かる。
  let textOnly = null;
  if (o.images.length > 0) {
    textOnly = await measurePromptTokens({ ...o, images: [] });
  }
  const withAll = await measurePromptTokens(o);

  console.log(`model      : ${o.model}`);
  console.log(`prompt     : ${withAll} tok（実測 prompt_eval_count）`);
  if (textOnly !== null) {
    const perImage = (withAll - textOnly) / o.images.length;
    console.log(`  内訳     : テキスト ${textOnly} tok + 画像 ${o.images.length} 枚 ${withAll - textOnly} tok`);
    console.log(`  画像1枚  : ${perImage.toFixed(0)} tok  ← 枚数・解像度を変えるとここが動く`);
  }
  console.log(`max_tokens : ${o.maxTokens}（応答ぶん。thinking 系は reasoning もここから出る）`);

  const need = withAll + o.maxTokens;
  const recommended = roundUp1024(need * SAFETY);
  console.log(`\n必要量     : ${need} tok（プロンプト + 応答）`);
  console.log(`推奨 num_ctx: ${recommended}（余裕率 ${SAFETY}x を掛けて 1024 の倍数へ切り上げ）`);

  const defaults = [32768, 128000, 262144];
  console.log('\n既定値のままだと何倍無駄か:');
  for (const d of defaults) {
    console.log(`  num_ctx=${String(d).padStart(6)} → 推奨の ${(d / recommended).toFixed(0)}倍のKVキャッシュを確保する`);
  }

  if (o.create) {
    const mf = `/tmp/Modelfile.${o.create.replace(/[^\w.-]/g, '_')}`;
    fs.writeFileSync(mf, `FROM ${o.model}\nPARAMETER num_ctx ${recommended}\n`);
    const env = { ...process.env, OLLAMA_HOST: o.url.replace(/^https?:\/\//, '') };
    execFileSync(`${process.env.HOME}/.local/ollama/bin/ollama`, ['create', o.create, '-f', mf], { env, stdio: 'inherit' });
    console.log(`\n作成: ${o.create}（FROM ${o.model} / num_ctx ${recommended}）`);
  }
}

main().catch((err) => {
  console.error(`suggest_num_ctx failed: ${err.message}`);
  process.exit(1);
});
