/**
 * serve_vlm.js — 静的配信 ＋ 推論サーバへの中継（VLM航行ビュアーをリモートで見るための開発サーバ）
 *
 * 【想定する使い方】GPUクラスタのターミナルでこれを起動し、SSH接続元の手元のマシン
 * （Mac 等）のブラウザで見る。設計の全体像・接続手順・失敗モードは
 * [`docs/remote-viewer-connectivity.md`](../docs/remote-viewer-connectivity.md) が正典。
 *
 * 【役割分担の要点】3D の描画は**見ている側のブラウザ**で走る（Three.js はクライアント側）。
 * クラスタが持つのは「静的ファイルを配る」と「推論を中継する」の2つだけである。
 * したがって画面転送（VNC・X11・映像ストリーム）は要らず、SSHトンネルを1本通せば足りる。
 *
 *   手元のブラウザ  ──HTTP（SSHトンネル）──▶  このサーバ ──▶ Ollama / vLLM（GPU）
 *     3D描画・撮影                              静的配信・中継        推論
 *
 * 【なぜ中継を挟むか】ブラウザから推論サーバを直接叩くと
 *   1. CORS（OLLAMA_ORIGINS）の設定に依存する
 *   2. 推論サーバのURL・モデル名・認証情報がページ側に残る
 *   3. そもそも Ollama は 127.0.0.1 にしか listen していないことが多く（本機もそう）、
 *      ブラウザからは到達できない
 * の3点が問題になる。同一オリジンの薄い中継を1本置くだけで全部消える。
 * これは「APIキーが要る実LLM呼び出しをブラウザ側に埋めない」という CLAUDE.md の方針の延長でもある。
 *
 * 【既定で 127.0.0.1 に bind する】共有クラスタで 0.0.0.0 に bind すると、同一ネットワークの
 * 誰でもこの中継（＝GPUの推論）を叩けてしまう。SSHトンネル経由なら公開は要らないので、
 * 既定を loopback にしてある。`--host 0.0.0.0` は明示的に選んだときだけ有効になり、警告を出す。
 *
 * 使い方（クラスタ側）:
 *   node scripts/serve_vlm.js
 *   node scripts/serve_vlm.js --port 8080 --upstream http://localhost:11434
 *   node scripts/serve_vlm.js --vendor-three     # 手元のブラウザが unpkg.com へ到達できない場合
 *
 *   --port N          既定 8080。使用中なら空くまで +1 する（最大10回）
 *   --host ADDR       bind するアドレス。既定 127.0.0.1（SSHトンネル前提）
 *   --upstream URL    推論サーバ。既定 http://localhost:11434
 *                     （OpenAI互換は <upstream>/v1/chat/completions に居る前提）
 *   --token STR       上流へ付ける Authorization: Bearer。既定は環境変数 VLM_TOKEN
 *   --vendor-three    Three.js を同一オリジン（/vendor/three.module.js）から配る。
 *                     配信するHTMLの importmap だけを書き換える（リポジトリのファイルは無変更なので
 *                     GitHub Pages 配置は壊れない）。クラスタ側に一度だけ CDN 到達性が要る
 *   --proxy-timeout-ms N  中継の締切。既定 300000（コールドスタート＋32B級を飲み込める桁）
 *   --no-check        起動時の上流チェック（モデル一覧の取得）を省く
 */
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

const ROOT = path.resolve(__dirname, '..');
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.jsonl': 'application/x-ndjson; charset=utf-8',
};

/** 中継の入口。ページ側の既定 baseUrl（nav_mode.js の NAV_DEFAULTS.baseUrl）と対になる */
const PROXY_PREFIX = '/vlm/';
/** 画像1枚ぶんの body は 640×360 PNG で約41KB。上限を切らないと無制限に飲み込む */
const MAX_BODY_BYTES = 32 * 1024 * 1024;

/** 同一オリジンから配る Three.js の場所と、置き換える対象のCDN URL */
const VENDOR_THREE_URL = '/vendor/three.module.js';
const THREE_CDN_RE = /https:\/\/unpkg\.com\/three@([0-9.]+)\/build\/three\.module\.js/g;
/**
 * すでにリポジトリへ同梱されている Three.js を探す順番。
 * `replay-viewer/` は同じネットワーク事情（Mac から unpkg.com へ到達できない）への対処として
 * 先に同梱を済ませているので、**二重に持たずそれを使う**。見つからなければ下の
 * キャッシュディレクトリへ取得する（そちらは .gitignore 済みでリポジトリを太らせない）。
 */
const VENDOR_CANDIDATES = [
  path.join(ROOT, 'replay-viewer', 'vendor', 'three.module.js'),
  path.join(ROOT, 'vendor', 'three.module.js'),
];
const VENDOR_CACHE_DIR = path.join(ROOT, '.devtools', 'tmp', 'vendor');

function parseArgs(argv) {
  const o = {
    port: 8080,
    host: '127.0.0.1',
    upstream: 'http://localhost:11434',
    token: process.env.VLM_TOKEN ?? null,
    vendorThree: false,
    proxyTimeoutMs: 300000,
    check: true,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--port') o.port = Number(argv[++i]);
    else if (a === '--host') o.host = argv[++i];
    else if (a === '--upstream') o.upstream = argv[++i];
    else if (a === '--token') o.token = argv[++i];
    else if (a === '--vendor-three') o.vendorThree = true;
    else if (a === '--proxy-timeout-ms') o.proxyTimeoutMs = Number(argv[++i]);
    else if (a === '--no-check') o.check = false;
    else if (a === '--help') {
      console.log(fs.readFileSync(__filename, 'utf8').split('*/')[0]);
      process.exit(0);
    } else throw new Error(`unknown option: ${a}`);
  }
  if (!Number.isInteger(o.port) || o.port <= 0) throw new Error(`--port は正の整数: ${o.port}`);
  if (!Number.isFinite(o.proxyTimeoutMs) || o.proxyTimeoutMs <= 0) {
    throw new Error(`--proxy-timeout-ms は正の数: ${o.proxyTimeoutMs}`);
  }
  return o;
}

// ---------------------------------------------------------------------------
// Three.js の同一オリジン配信（手元のブラウザが CDN へ到達できない場合の逃げ道）
//
// この経路が要るのは実測に基づく: replay-viewer/main.js が既に
// 「unpkg.com へ到達できないネットワーク環境（学内プロキシ・GPUクラスタのアウトバウンド制限）」
// を想定した退避処理を持っている。3D を諦めるのではなく、クラスタ側が代わりに取ってきて
// 同一オリジンから配れば、手元のブラウザに外向き到達性が無くても3Dが出る。
// ---------------------------------------------------------------------------

/** digital-twin/index.html の importmap に書いてあるバージョンを正とする（2箇所で食い違わないように） */
function detectThreeVersion() {
  const html = fs.readFileSync(path.join(ROOT, 'digital-twin', 'index.html'), 'utf8');
  const m = /unpkg\.com\/three@([0-9.]+)\/build\/three\.module\.js/.exec(html);
  if (!m) throw new Error('digital-twin/index.html に three の importmap が見つからない');
  return m[1];
}

async function ensureVendoredThree() {
  const version = detectThreeVersion();
  // 1. リポジトリに同梱済みのものがあればそれを使う（コピーを増やさない）
  for (const candidate of VENDOR_CANDIDATES) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).size > 0) {
      return { file: candidate, version, source: path.relative(ROOT, candidate) };
    }
  }
  // 2. 次にこのサーバ用のキャッシュ
  const file = path.join(VENDOR_CACHE_DIR, `three-${version}.module.js`);
  if (fs.existsSync(file) && fs.statSync(file).size > 0) {
    return { file, version, source: `${path.relative(ROOT, file)}（キャッシュ）` };
  }
  // 3. 無ければクラスタ側が取得する（手元のブラウザには外向き到達性が要らない）
  fs.mkdirSync(VENDOR_CACHE_DIR, { recursive: true });
  const url = `https://unpkg.com/three@${version}/build/three.module.js`;
  process.stdout.write(`[serve] Three.js ${version} を取得中 ... `);
  const res = await fetch(url, { signal: AbortSignal.timeout(60000) });
  if (!res.ok) throw new Error(`Three.js の取得に失敗: HTTP ${res.status} (${url})`);
  const body = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync(file, body);
  console.log(`ok ${(body.length / 1024).toFixed(0)}KB -> ${path.relative(ROOT, file)}`);
  return { file, version, source: path.relative(ROOT, file) };
}

// ---------------------------------------------------------------------------
// 上流チェック
// ---------------------------------------------------------------------------

/**
 * 起動時に上流を1回だけ叩き、使えるモデルを表示する。
 * thinking 系の VLM を選ぶと画像判断で本文が空になる（2026-09-05 実測。
 * docs/l1-vlm-navigator-implementation-2026-09-05.md §3.3）ので、ここで名指しで警告する
 * ——モデル名を間違えたまま10サイクル回して全部 thinking_overrun になるのが一番高い。
 */
async function checkUpstream(upstream) {
  const base = upstream.replace(/\/+$/, '');
  try {
    const res = await fetch(`${base}/api/tags`, { signal: AbortSignal.timeout(8000) });
    if (res.ok) {
      const json = await res.json();
      const models = (json.models ?? []).map((m) => ({
        name: m.name,
        caps: m.details?.capabilities ?? m.capabilities ?? [],
      }));
      // 候補VLMの宣言 num_ctx を並べて出す。**絞っていないモデルは VRAM を数十GB掴む**
      // （実測: qwen2.5vl:7b が num_ctx=128,000 で 85.9GB。docs/multi-vlm-gpu-budget.md）。
      const vision = models.filter((m) => m.caps.includes('vision') && !m.caps.includes('thinking'));
      await Promise.all(
        vision.map(async (m) => {
          try {
            const r = await fetch(`${base}/api/show`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ model: m.name }),
              signal: AbortSignal.timeout(8000),
            });
            if (!r.ok) return;
            const info = await r.json();
            const mm = /^\s*num_ctx\s+(\d+)\s*$/m.exec(info?.parameters ?? '');
            m.numCtx = mm ? Number(mm[1]) : null;
            m.contextLength = info?.model_info?.[`${info?.details?.family ?? ''}.context_length`] ?? null;
          } catch {
            /* 取れなくても一覧は出す */
          }
        })
      );
      return { kind: 'ollama', models };
    }
  } catch {
    /* Ollama ネイティブではないだけ。次を試す */
  }
  try {
    const res = await fetch(`${base}/v1/models`, { signal: AbortSignal.timeout(8000) });
    if (res.ok) {
      const json = await res.json();
      return { kind: 'openai', models: (json.data ?? []).map((m) => ({ name: m.id, caps: [] })) };
    }
    return { kind: 'unreachable', error: `HTTP ${res.status}` };
  } catch (err) {
    return { kind: 'unreachable', error: String(err?.message ?? err) };
  }
}

function reportUpstream(info, upstream) {
  if (info.kind === 'unreachable') {
    console.log(`[serve] 上流チェック: **到達できない** (${upstream}) — ${info.error}`);
    console.log('        推論は kind="connection" として失敗し、航路は維持されます（船は走り続けます）。');
    console.log('        Ollama なら `ollama serve`、vLLM なら --upstream を確認してください。');
    return;
  }
  const vision = info.models.filter((m) => m.caps.includes('vision'));
  const safe = vision.filter((m) => !m.caps.includes('thinking'));
  const risky = vision.filter((m) => m.caps.includes('thinking'));
  console.log(`[serve] 上流チェック: ok (${info.kind}) — ${info.models.length} モデル`);
  if (info.kind === 'ollama') {
    console.log('        使えるVLM（非thinking）:');
    for (const m of safe) {
      const ctx = m.numCtx ? `num_ctx=${m.numCtx}` : '**num_ctx 未宣言**（既定＝非常に大きい／VRAMを数十GB掴む）';
      console.log(`          ${m.name.padEnd(28)} ${ctx}`);
    }
    if (safe.length === 0) console.log('          (無し)');
    if (safe.some((m) => !m.numCtx)) {
      console.log('          → 絞るには: node scripts/suggest_num_ctx.js --model <名前> --image <実画像> --create <新名>');
    }
    if (risky.length) {
      console.log(`        避けるVLM（thinking系）: ${risky.map((m) => m.name).join(', ')}`);
      console.log('          → 画像1枚の判断で reasoning が予算を食い切り、本文が空のまま返ります');
      console.log('             （kind=thinking_overrun。think:false でも止まらないモデルがある）');
    }
  } else {
    // OpenAI互換は capabilities を返さないので、こちらでは選別できない
    console.log(`        モデル: ${info.models.map((m) => m.name).slice(0, 8).join(', ')}`);
    console.log('        （OpenAI互換の /v1/models は vision/thinking を申告しないため選別できません）');
  }
}

// ---------------------------------------------------------------------------
// 中継
// ---------------------------------------------------------------------------

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error(`request body exceeds ${MAX_BODY_BYTES} bytes`));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/**
 * `/vlm/<rest>` を `<upstream>/<rest>` へ素通しする。
 * body は触らない（画像入りの content 配列をここで組み替えると、
 * ブラウザ側とヘッドレス側で送っているものが変わってしまう）。
 */
async function proxy(req, res, opts) {
  const rest = req.url.slice(PROXY_PREFIX.length);
  const target = `${opts.upstream.replace(/\/+$/, '')}/${rest}`;
  let body;
  try {
    body = req.method === 'GET' || req.method === 'HEAD' ? undefined : await readBody(req);
  } catch (err) {
    res.writeHead(413, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: String(err.message ?? err) }));
    return;
  }

  const startedAt = Date.now();
  try {
    const upstreamRes = await fetch(target, {
      method: req.method,
      headers: {
        'Content-Type': req.headers['content-type'] ?? 'application/json',
        ...(opts.token ? { Authorization: `Bearer ${opts.token}` } : {}),
      },
      body,
      // 上流が黙り込んだときにブラウザを永久に待たせない（llm_http.js 側にも締切はあるが二重に切る）
      signal: AbortSignal.timeout(opts.proxyTimeoutMs),
    });
    const buf = Buffer.from(await upstreamRes.arrayBuffer());
    console.log(
      `[proxy] ${req.method} ${rest} -> ${upstreamRes.status} ` +
        `${(buf.length / 1024).toFixed(1)}KB in ${Date.now() - startedAt} ms` +
        (body ? ` (sent ${(body.length / 1024).toFixed(1)}KB)` : '')
    );
    res.writeHead(upstreamRes.status, {
      'Content-Type': upstreamRes.headers.get('content-type') ?? 'application/json',
    });
    res.end(buf);
  } catch (err) {
    // 上流が落ちている・締切超過。ページ側は llm_http.js の kind='connection' として数える
    console.error(`[proxy] ${req.method} ${rest} FAILED after ${Date.now() - startedAt} ms: ${err?.message ?? err}`);
    res.writeHead(502, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: `upstream ${opts.upstream}: ${err?.message ?? err}` }));
  }
}

// ---------------------------------------------------------------------------
// 静的配信
// ---------------------------------------------------------------------------

function serveStatic(req, res, opts, vendored) {
  const urlPath = decodeURIComponent(req.url.split('?')[0]);

  if (vendored && urlPath === VENDOR_THREE_URL) {
    const data = fs.readFileSync(vendored.file);
    res.writeHead(200, { 'Content-Type': MIME['.js'], 'Cache-Control': 'max-age=86400' });
    res.end(data);
    return;
  }

  // ルート外への脱出を防ぐ（開発サーバでもディレクトリトラバーサルは塞いでおく）
  const resolved = path.resolve(ROOT, `.${urlPath}`);
  if (resolved !== ROOT && !resolved.startsWith(ROOT + path.sep)) {
    res.writeHead(403);
    res.end('forbidden');
    return;
  }
  let filePath = resolved;
  if (fs.existsSync(filePath) && fs.statSync(filePath).isDirectory()) {
    filePath = path.join(filePath, 'index.html');
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(`not found: ${urlPath}`);
      return;
    }
    const ext = path.extname(filePath);
    let out = data;
    if (vendored && ext === '.html') {
      // importmap の1箇所だけを差し替える。リポジトリのファイルには書き戻さないので、
      // GitHub Pages に置いたときは従来どおり CDN から読む（静的サイトの前提を壊さない）。
      out = Buffer.from(data.toString('utf8').replace(THREE_CDN_RE, VENDOR_THREE_URL), 'utf8');
    }
    res.writeHead(200, {
      'Content-Type': MIME[ext] ?? 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    res.end(out);
  });
}

// ---------------------------------------------------------------------------

/** 使用中のポートを避けて listen する。共有クラスタでは 8080 が埋まっていることが普通にある */
function listenWithRetry(server, host, startPort, attempts = 10) {
  return new Promise((resolve, reject) => {
    let port = startPort;
    let left = attempts;
    const tryOnce = () => {
      const onError = (err) => {
        if (err.code === 'EADDRINUSE' && left > 1) {
          console.log(`[serve] ポート ${port} は使用中。${port + 1} を試します`);
          port += 1;
          left -= 1;
          setImmediate(tryOnce);
          return;
        }
        reject(err);
      };
      server.once('error', onError);
      server.listen(port, host, () => {
        server.removeListener('error', onError);
        resolve(port);
      });
    };
    tryOnce();
  });
}

/**
 * 手元のマシンから見るための SSH コマンド。ホストは「クライアントが実際に繋いだ先のアドレス」
 * （SSH_CONNECTION の3番目）を優先する——hostname だと手元から名前解決できないことがある。
 */
function sshHintHost() {
  const conn = (process.env.SSH_CONNECTION ?? '').split(/\s+/);
  return conn[2] || os.hostname();
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));

  const vendored = opts.vendorThree ? await ensureVendoredThree() : null;
  if (vendored) {
    console.log(
      `[serve] Three.js ${vendored.version} を ${VENDOR_THREE_URL} から配信` +
        `（出所: ${vendored.source}）。配信HTMLの importmap を書き換えます`
    );
  }

  const server = http.createServer((req, res) => {
    if (req.url.startsWith(PROXY_PREFIX)) proxy(req, res, opts);
    else serveStatic(req, res, opts, vendored);
  });
  const port = await listenWithRetry(server, opts.host, opts.port);

  console.log(`[serve] ${ROOT}`);
  console.log(`[serve] listen ${opts.host}:${port}   ${PROXY_PREFIX}* -> ${opts.upstream}${opts.token ? '（Bearer トークン付き）' : ''}`);
  if (opts.host === '0.0.0.0' || opts.host === '::') {
    console.log('[serve] **警告: 全インターフェースに公開しています。** 同一ネットワークの誰でも');
    console.log('        この中継経由でGPUの推論を叩けます。共有クラスタでは --host 127.0.0.1（既定）＋');
    console.log('        SSHトンネルを使ってください。');
  }
  if (opts.check) await checkUpstream(opts.upstream).then((info) => reportUpstream(info, opts.upstream));

  const host = sshHintHost();
  const user = os.userInfo().username;
  const url = `http://localhost:${port}/digital-twin/?scenario=pilotage_m3&nav=vlm&model=qwen2.5vl-7b-ctx3k`;
  const inVsCode = Boolean(process.env.VSCODE_IPC_HOOK_CLI || process.env.TERM_PROGRAM === 'vscode');
  console.log('');
  console.log('─── 手元のマシン（Mac 等）から見る手順 ───────────────────────');
  if (inVsCode) {
    console.log('  A) この端末は VS Code の統合ターミナルです。**ポート転送は自動で行われます**:');
    console.log(`       右下の通知「ポート ${port} で実行されているアプリケーションは使用可能です」`);
    console.log('       → 「ブラウザーで開く」。通知が出なければ下部パネルの「ポート」タブで確認し、');
    console.log(`       出ていなければ「ポートの転送」から ${port} を手で追加してください。`);
    console.log('  B) 素の SSH で見る場合は、手元のターミナルでトンネルを1本張る:');
  } else {
    console.log('  A) 手元のターミナルで、SSHトンネルを1本張る:');
  }
  console.log(`       ssh -N -L ${port}:127.0.0.1:${port} ${user}@${host}`);
  console.log('     （すでに繋いでいるSSHセッションに足すなら、Enter を押してから ~C と入力し）');
  console.log(`       -L ${port}:127.0.0.1:${port}`);
  console.log('  いずれの場合も、手元のブラウザで開くURLは同じ:');
  console.log(`       ${url}`);
  console.log('');
  console.log('  3D の描画は**手元のブラウザ**で走ります（画面転送ではありません）。');
  console.log('  推論だけがこのサーバ経由でGPUへ行きます。');
  console.log('  接続方式の比較・失敗モードは docs/remote-viewer-connectivity.md');
  console.log('');
  console.log('  アーム:  ?nav=vlm（画像あり） / ?nav=blind（画像なし＝統制群） / ?nav=scripted（推論なし）');
  console.log('  シナリオ: pilotage_m3（交通船2隻を回避する。既定） / pilotage_m1（空海面の基準線）');
  console.log('  表示:    ?cam=fixed（既定・方位固定の第三者視点） / ?cam=orbit（従来の周回） / ?plan3d=0（3Dのwaypoint非表示）');
  console.log('  この端末を閉じてもサーバを残すには tmux か nohup を使ってください:');
  console.log(`       tmux new -s vlmview 'node scripts/serve_vlm.js --port ${port}'`);
  console.log('──────────────────────────────────────────────');
}

main().catch((err) => {
  console.error(err?.message ?? err);
  process.exit(1);
});
