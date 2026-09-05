/**
 * headless_run.js — coreをNode上でheadless実行するランナー v2（スケジューラ駆動）
 *
 * 出自（v1）: docs/review-findings-2026-08-07.md E-5 / §C「headlessランナーが同梱されていない」対応。
 * 「core/はDOM非依存でNodeで無改造実行できる」を、リポジトリ同梱の再現可能な形で実測するための
 * スクリプト。スループット計測（steps/s）の役割は v2 でもそのまま残している。
 *
 * v2（docs/l0-llm-agent-plan.md Task 8）で変わったのは意思決定の駆動方法である。
 * v1 は「6ステップに1回、各艇のエージェントが decide する」間引きループだった。
 * v2 は指揮官階層＋時間モデル（docs/time-model.md v2.0）に置き換わり、
 *   - 艇はエージェントオブジェクトを持たない。毎ステップ boat_controller.js が現在の指示へ追従する
 *   - 意思決定は指揮官2体（blue=defender / red=intruder）だけが行い、DecisionScheduler が
 *     発行（t_issue）と発効（t_apply = t_issue + latencyS）を管理する
 * となる。1ステップの処理順序は §8 のとおり:
 *
 *   1. dueToApply(t) → takeResult → applyOrders（発効。適用してから発行するので、
 *      同じステップの統合図は「今まさに効いた指示」を映す）
 *   2. missedAt(t) → takeMissed → onMiss（不成立。既定 deadlineS=∞ では起きない。§12.5）
 *   3. dueToIssue(t) → markIssued → **await** 推論 → provideResult（§9: headless は待つ）
 *   4. computeBoatActions(world, observation)（追従制御。毎ステップ・瞬時）
 *   5. env.step(actions)（物理を dt=0.1s 進める）
 *
 * なぜ 3 で await してよいか（§9）: t_issue から t_apply までの物理は現行指示だけで決まり、
 * 発行中の推論結果に一切依存しない。したがって実時間で何秒待とうとシムの結果は変わらず、
 * 変わるのは「このスクリプトの実行が何秒かかるか」だけである。逆に言えば、発行を待たずに
 * 物理を進める実装にすると、結果が届いた刻みで発効することになり、マシン速度が実験結果に
 * 混入する。ブラウザ（swarm-sim）はそちら側で、blockedAt() で止まる（Task 9）。
 *
 * 実測時間（t_wall）の扱い: ステージ別の実測値を記録するが（roadmap D-3）、記録側に閉じており
 * ルール側の変数へは一切書き戻さない（§2.5 I1・§12.5 I4）。発効遅延の唯一の出所は設定値
 * --command-latency である。
 *
 * tests/core_smoke.test.js と同じ理由（リポジトリルートにpackage.jsonが無く
 * "type":"module"指定も無い）で、このファイル自体はCommonJSのままにし、
 * core/配下のESMは `await import()` で動的ロードする。runEpisode() が core の部品を
 * import せず引数で受け取るのはそのため（テストからも同じ形で呼べる副作用がある）。
 *
 * 使い方: node scripts/headless_run.js [options]   （--help で下の一覧を表示）
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_SCENARIO = 'tokyo_bay_minimal';

/** --scenario は名前（core/scenarios/<name>.json）とパスの両方を受ける */
function resolveScenarioPath(nameOrPath) {
  const v = nameOrPath ?? DEFAULT_SCENARIO;
  if (v.includes('/') || v.endsWith('.json')) return path.resolve(v);
  return path.join(__dirname, `../core/scenarios/${v}.json`);
}

/**
 * シム時刻は dt=0.1 の累積で誤差が乗る（t=240 で約 9.4e-12）。時刻の比較は
 * DecisionScheduler と同じく epsilon 付きで行う（同じ理由・同じ桁の定数）。
 */
const T_EPS = 1e-6;

const HELP_TEXT = `node scripts/headless_run.js [options]

  --episodes N          実行するエピソード数（既定 5）
  --scenario NAME|path  シナリオ（既定 tokyo_bay_minimal）。名前なら core/scenarios/<NAME>.json を読む
  --boats N             隻数（既定: シナリオ既定の spawn 数=3）。超える分は決定論的に合成する
  --blue scripted|llm   防御側指揮官の腕（既定 scripted）
  --red scripted|llm    侵入側指揮官の腕（既定 scripted）
  --model NAME          LLM 腕のモデル名（--blue/--red llm では必須。本機の実測では qwen2.5:7b が既定候補）
  --llm-url URL         OpenAI 互換のベースURL（既定 http://localhost:11434/v1）
  --temperature T       生成温度（既定 0.7）
  --max-tokens N        1応答の上限トークン（既定はモジュール既定の 300。thinking 系モデルは
                        推論だけで使い切って空応答になるので上げること）
  --command-interval S  指揮官の発行間隔 intervalS（既定 10 シム秒）
  --command-latency S   指示の発効遅延 latencyS（既定 3 シム秒。設定値であって実測値ではない）
  --command-deadline S  締切 deadlineS（既定 inf ＝ L0 の全停止モデル。有限値で「不成立」が有効になる）
  --on-miss MODE        不成立時の挙動 keep-current（既定）| default-order
  --boat-mode scripted|llm  艇レベルの判断（既定 scripted＝追従制御のみ）。llm で
                        docs/decision-architecture.md §1 の艇（def-runner-1/2, def-scout。
                        シナリオに無い id は警告して無視）を指揮官と同じスケジューラに register する
  --boat-interval S     艇の発行間隔（既定 3 シム秒。decision-architecture.md §1）
  --boat-latency S      艇の指示の発効遅延（既定 1 シム秒）
  --boat-model NAME     艇だけ別モデル（既定 --model と同じ）。呼び出しが多い艇を軽量モデルにし、
                        指揮官にだけ大きい/thinking モデルを割り当てる用（thinking-model-plan.md §3.5）
  --boat-max-tokens N   艇だけ別の上限トークン（既定 --max-tokens と同じ）
  --llm-transport T     openai（既定・vLLM/Ollama 共通の /chat/completions）| ollama（/api/chat）。
                        **Ollama で thinking を切るには ollama が必須**（/v1 は think を無視する）
  --thinking MODE       auto（既定・モデル任せ）| on | off。指揮官に適用
  --boat-thinking MODE  艇だけ別指定（既定 --thinking と同じ）
  --reasoning-effort E  low|medium|high（qwen3.8 等）。指揮官に適用
  --boat-reasoning-effort E  艇だけ別指定
  --timeout-ms N        1呼び出しの締切（既定 30000）。大規模モデル・4並列では要調整
  --out path            env.logger の JSONL を書き出す
  --llm-log path        LLM 指揮官・艇の全呼び出し（プロンプト・生応答・失敗）を JSONL で書き出す
  --decision-log path   全判断サイクル（発行/発効時刻・ステージ別実測 t_wall）を JSONL で書き出す
  --no-warmup           LLM 腕のウォームアップ呼び出しを省く（既定は実施。実測のコールドスタートは 8.7s）
  --verbose             指示が発効するたびに1行表示する（LLM 腕の采配を追うとき用）
  --quiet               エピソードごとの進捗行を省略し、最終サマリのみ出力
  --help                この一覧

  例（統制群・GPU 不要・完全に決定論）:
    node scripts/headless_run.js --blue scripted --red scripted --boats 6 --episodes 20 --quiet
  例（LLM 指揮官を1エピソード）:
    node scripts/headless_run.js --blue llm --model qwen2.5:7b --episodes 1 --llm-log probe-commander.jsonl
  例（マルチLLM: 指揮官＋艇が同じスケジューラで相互に判断）:
    node scripts/headless_run.js --scenario flag_defence_squadrons --blue llm --boat-mode llm \
      --model qwen2.5:7b --episodes 1 --llm-log multi-llm.jsonl --verbose`;

/** 締切だけは「無限」を書けるようにする（L0 の既定＝待ち続ける） */
function parseDeadline(raw) {
  if (raw === 'inf' || raw === 'infinity' || raw === 'none') return Infinity;
  const v = Number(raw);
  if (!Number.isFinite(v) || v <= 0) {
    throw new Error(`--command-deadline must be a positive number or "inf", got: ${raw}`);
  }
  return v;
}

function parseArgs(argv) {
  const opts = {
    episodes: 5,
    scenario: null,
    boats: null,
    out: null,
    quiet: false,
    verbose: false,
    help: false,
    blue: 'scripted',
    red: 'scripted',
    llmUrl: 'http://localhost:11434/v1',
    model: null,
    temperature: 0.7,
    maxTokens: null,
    commandIntervalS: 10,
    commandLatencyS: 3,
    // L0 の既定は締切なし（§12.5 の A案 = 全停止）。headless は発行を await するので、
    // この既定では不成立は原理的に起きない。
    deadlineS: Infinity,
    onMiss: 'keep-current',
    warmup: true,
    llmLog: null,
    decisionLog: null,
    boatMode: 'scripted',
    boatIntervalS: 3,
    boatLatencyS: 1,
    // 指揮官と艇で別々に持てる設定。未指定なら指揮官側の値へフォールバックする
    // （docs/thinking-model-plan.md §3.5 設計1「非対称な認知」: 熟慮は呼び出し回数の少ない
    //  指揮官に置き、呼び出しが多い艇は軽く速いモデルで反射的に動かす）。
    boatModel: null,
    boatMaxTokens: null,
    transport: 'openai',
    thinking: 'auto',
    reasoningEffort: null,
    boatThinking: null,
    boatReasoningEffort: null,
    timeoutMs: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--episodes') opts.episodes = Number(argv[++i]);
    else if (arg === '--scenario') opts.scenario = argv[++i];
    else if (arg === '--boats') opts.boats = Number(argv[++i]);
    else if (arg === '--out') opts.out = argv[++i];
    else if (arg === '--quiet') opts.quiet = true;
    else if (arg === '--verbose') opts.verbose = true;
    else if (arg === '--help' || arg === '-h') opts.help = true;
    else if (arg === '--blue') opts.blue = argv[++i];
    else if (arg === '--red') opts.red = argv[++i];
    else if (arg === '--llm-url') opts.llmUrl = argv[++i];
    else if (arg === '--model') opts.model = argv[++i];
    else if (arg === '--temperature') opts.temperature = Number(argv[++i]);
    else if (arg === '--max-tokens') opts.maxTokens = Number(argv[++i]);
    else if (arg === '--command-interval') opts.commandIntervalS = Number(argv[++i]);
    else if (arg === '--command-latency') opts.commandLatencyS = Number(argv[++i]);
    else if (arg === '--command-deadline') opts.deadlineS = parseDeadline(argv[++i]);
    else if (arg === '--on-miss') opts.onMiss = argv[++i];
    else if (arg === '--no-warmup') opts.warmup = false;
    else if (arg === '--llm-log') opts.llmLog = argv[++i];
    else if (arg === '--decision-log') opts.decisionLog = argv[++i];
    else if (arg === '--boat-mode') opts.boatMode = argv[++i];
    else if (arg === '--boat-interval') opts.boatIntervalS = Number(argv[++i]);
    else if (arg === '--boat-latency') opts.boatLatencyS = Number(argv[++i]);
    else if (arg === '--boat-model') opts.boatModel = argv[++i];
    else if (arg === '--boat-max-tokens') opts.boatMaxTokens = Number(argv[++i]);
    else if (arg === '--llm-transport') opts.transport = argv[++i];
    else if (arg === '--thinking') opts.thinking = argv[++i];
    else if (arg === '--reasoning-effort') opts.reasoningEffort = argv[++i];
    else if (arg === '--boat-thinking') opts.boatThinking = argv[++i];
    else if (arg === '--boat-reasoning-effort') opts.boatReasoningEffort = argv[++i];
    else if (arg === '--timeout-ms') opts.timeoutMs = Number(argv[++i]);
    else {
      throw new Error(
        `unknown argument: ${arg} (known: --episodes N, --scenario NAME|path, --boats N, --out path, --quiet, --verbose, ` +
          '--blue scripted|llm, --red scripted|llm, --boat-mode scripted|llm, --boat-interval S, --boat-latency S, ' +
          '--llm-url URL, --model NAME, --temperature T, ' +
          '--max-tokens N, --command-interval S, --command-latency S, --command-deadline S|inf, ' +
          '--on-miss keep-current|default-order, --no-warmup, --llm-log path, --decision-log path, --help)'
      );
    }
  }
  if (opts.help) return opts;
  if (!Number.isInteger(opts.episodes) || opts.episodes < 1) {
    throw new Error(`--episodes must be a positive integer, got: ${opts.episodes}`);
  }
  if (opts.boats !== null && (!Number.isInteger(opts.boats) || opts.boats < 1)) {
    throw new Error(`--boats must be a positive integer, got: ${opts.boats}`);
  }
  for (const side of ['blue', 'red']) {
    if (opts[side] !== 'scripted' && opts[side] !== 'llm') {
      throw new Error(`--${side} must be "scripted" or "llm", got: ${opts[side]}`);
    }
  }
  if ((opts.blue === 'llm' || opts.red === 'llm') && !opts.model) {
    throw new Error('--blue/--red llm requires --model (e.g. --model qwen2.5:7b)');
  }
  if (!Number.isFinite(opts.temperature) || opts.temperature < 0) {
    throw new Error(`--temperature must be a number >= 0, got: ${opts.temperature}`);
  }
  if (!['openai', 'ollama'].includes(opts.transport)) {
    throw new Error(`--llm-transport must be openai|ollama, got: ${opts.transport}`);
  }
  for (const [flag, v] of [['--thinking', opts.thinking], ['--boat-thinking', opts.boatThinking]]) {
    if (v !== null && !['auto', 'on', 'off'].includes(v)) {
      throw new Error(`${flag} must be auto|on|off, got: ${v}`);
    }
  }
  for (const [flag, v] of [['--reasoning-effort', opts.reasoningEffort], ['--boat-reasoning-effort', opts.boatReasoningEffort]]) {
    if (v !== null && !['low', 'medium', 'high'].includes(v)) {
      throw new Error(`${flag} must be low|medium|high, got: ${v}`);
    }
  }
  // thinking:'off' は OpenAI 互換経路では **Ollama に無視される**ことを実測済み
  // （docs/thinking-model-plan.md §2）。黙って効かないまま「thinking を切って測った」ことに
  // なるのが最悪なので、Ollama 既定URLに対する off 指定は設定ミスとして落とす。
  const wantsOff = opts.thinking === 'off' || opts.boatThinking === 'off';
  if (wantsOff && opts.transport === 'openai' && /:11434/.test(opts.llmUrl ?? '')) {
    throw new Error(
      'thinking=off を Ollama(:11434) の OpenAI 互換経路へ指定している。Ollama は ' +
        'chat_template_kwargs.enable_thinking も think も /v1 では無視する（実測済み）。' +
        '--llm-transport ollama を付け、--llm-url は /v1 を外したベースURLにすること。'
    );
  }
  if (opts.timeoutMs !== null && (!Number.isFinite(opts.timeoutMs) || opts.timeoutMs <= 0)) {
    throw new Error(`--timeout-ms must be a positive number, got: ${opts.timeoutMs}`);
  }
  if (opts.boatMaxTokens !== null && (!Number.isInteger(opts.boatMaxTokens) || opts.boatMaxTokens < 1)) {
    throw new Error(`--boat-max-tokens must be a positive integer, got: ${opts.boatMaxTokens}`);
  }
  if (opts.maxTokens !== null && (!Number.isInteger(opts.maxTokens) || opts.maxTokens < 1)) {
    throw new Error(`--max-tokens must be a positive integer, got: ${opts.maxTokens}`);
  }
  if (!Number.isFinite(opts.commandIntervalS) || opts.commandIntervalS <= 0) {
    throw new Error(`--command-interval must be a positive number of seconds, got: ${opts.commandIntervalS}`);
  }
  if (!Number.isFinite(opts.commandLatencyS) || opts.commandLatencyS < 0) {
    throw new Error(`--command-latency must be a number of seconds >= 0, got: ${opts.commandLatencyS}`);
  }
  if (opts.onMiss !== 'keep-current' && opts.onMiss !== 'default-order') {
    throw new Error(`--on-miss must be "keep-current" or "default-order", got: ${opts.onMiss}`);
  }
  if (opts.boatMode !== 'scripted' && opts.boatMode !== 'llm') {
    throw new Error(`--boat-mode must be "scripted" or "llm", got: ${opts.boatMode}`);
  }
  if (opts.boatMode === 'llm' && !opts.model) {
    throw new Error('--boat-mode llm requires --model (e.g. --model qwen2.5:7b)');
  }
  if (!Number.isFinite(opts.boatIntervalS) || opts.boatIntervalS <= 0) {
    throw new Error(`--boat-interval must be a positive number of seconds, got: ${opts.boatIntervalS}`);
  }
  if (!Number.isFinite(opts.boatLatencyS) || opts.boatLatencyS < 0) {
    throw new Error(`--boat-latency must be a number of seconds >= 0, got: ${opts.boatLatencyS}`);
  }
  return opts;
}

/**
 * シナリオのspawnsを目標隻数まで決定論的に増やす。既存spawnを起点に、渦巻き状
 * （角度は合成順nに単調増加、半径は同じ基点を再訪するたび60m刻みで広がる）へ
 * オフセットした位置を追加する。角度がn全体（0〜targetCount-1）にわたって単調に
 * 増えていくため、実際の軌跡はリング（同心円）ではなく外向きのスパイラルになる。
 * 陣営はdefender/intruderを交互に割り当てる（3隻のシナリオ既定は2防御:1侵入だが、
 * 大量隻数のスループット計測ではバランスより「決定論的に再現できること」を優先する）。
 * scene.projection（loadSceneFromScenario()の戻り値が持つ、このシナリオ専用のorigin変換）が
 * 生成済みであること前提（呼び出し順に注意。A-7/E-6対応でcoord.jsのモジュールグローバルorigin
 * は廃止されたため、synthesizeSpawns()にはscene.projectionの変換関数を明示的に渡す）。
 *
 * 戻り値の陣営構成は呼び出し側（main()）で検証する。targetCountが1〜2隻など
 * 小さい場合、元のspawnsをslice()するだけでは片方の陣営が消え（例:
 * --boats 2 → defender-1, defender-2のみでintruderが0隻）、evaluateMission()が
 * 初手で'defended'/'timeout'と誤判定して意味の無いsteps/sを出してしまう。
 */
/**
 * 渦巻きの半径刻み。迎撃圏（INTERCEPT_RANGE_M=60m）・突破圏（ASSET_BREACH_RANGE_M=80m）より
 * 十分大きく取る。60m 刻みだった頃は、合成された侵入艇が既存の防御艇のちょうど迎撃圏上に
 * 生まれ、--boats 6 が1ステップで defended になっていた（エピソードとして成立しない）。
 */
const RING_STEP_M = 150;

/**
 * 合成された侵入艇を防護対象からこの距離まで押し出す下限。突破圏（80m）のすぐ外側に
 * 生まれると、攻防が始まる前に breached になる（--boats 30 が実際にそうなっていた）。
 *
 * ただしこの固定値だけでは足りない。**実際に使う値はシナリオ既存の侵入艇の最短距離**で、
 * この定数はそれが取れなかった場合の保険である（下の effectiveClearance）。
 * 固定 250m のままだと、盤面を広げた（既存の侵入艇が 550m や 1,100m から出る）ときに
 * 合成艇だけがアセット至近から湧き、隻数を増やすほど侵入側が一方的に有利になる。
 * 2026-08-31 の掃引で --boats 16 の防御側勝率が 0〜20% に張り付いたのはこれが原因。
 */
const MIN_ASSET_CLEARANCE_M = 250;

function synthesizeSpawns(baseSpawns, targetCount, { latLonToLocal, localToLatLon, protectedAssetLocal = null }) {
  if (targetCount <= baseSpawns.length) return baseSpawns.slice(0, targetCount);
  const spawns = baseSpawns.slice();
  // 既存の侵入艇がアセットからどれだけ離れて出るかを基準にする。合成艇だけが内側に
  // 湧くと隻数の比較が「開始位置の比較」に化けるので、既存艇より内側には出さない。
  let effectiveClearance = MIN_ASSET_CLEARANCE_M;
  if (protectedAssetLocal) {
    const dists = baseSpawns
      .filter((s) => s.faction === 'intruder')
      .map((s) => {
        const l = latLonToLocal(s.lat, s.lon);
        return Math.hypot(l.x - protectedAssetLocal.x, l.y - protectedAssetLocal.y);
      });
    if (dists.length > 0) effectiveClearance = Math.max(effectiveClearance, Math.min(...dists));
  }
  let n = 0;
  while (spawns.length < targetCount) {
    // 陣営を交互に増やしつつ、**艦種はその陣営の既存艇から取る**。
    // かつて base を陣営と無関係に baseSpawns から順に拾っていたため、艦種が陣営間でねじれ、
    // 防御側に低速の重装艇（4 m/s）が、侵入側に高速の快速艇（9 m/s・爆破半径50mで旗を壊せる）が
    // 偏って増えていた。2026-08-31 の掃引で --boats 16 の防御側勝率が 0〜17% に張り付いた真因。
    // 同じ陣営の艇を複製すれば、戦力構成は両陣営で相似に伸びる。
    const faction = n % 2 === 0 ? 'defender' : 'intruder';
    const pool = baseSpawns.filter((s) => s.faction === faction);
    if (pool.length === 0) {
      throw new Error(`synthesizeSpawns: シナリオに ${faction} の spawn が無いので隻数を増やせない`);
    }
    const idx = Math.floor(n / 2);
    const base = pool[idx % pool.length];
    const ring = Math.floor(idx / pool.length) + 1;
    const angle = (2 * Math.PI * n) / targetCount;
    const radiusM = RING_STEP_M * ring;
    const baseLocal = latLonToLocal(base.lat, base.lon);
    let px = baseLocal.x + radiusM * Math.cos(angle);
    let py = baseLocal.y + radiusM * Math.sin(angle);
    // 侵入艇が防護対象の目前に湧くと、指揮官が最初の指示を出す前に決着してしまう。
    // 決定論を保つため乱数で振り直さず、アセットから見た同じ方位のまま外側へ押し出す。
    if (faction === 'intruder' && protectedAssetLocal) {
      const dx = px - protectedAssetLocal.x;
      const dy = py - protectedAssetLocal.y;
      const d = Math.hypot(dx, dy);
      if (d < effectiveClearance) {
        const dir = d > 1e-9 ? { x: dx / d, y: dy / d } : { x: Math.cos(angle), y: Math.sin(angle) };
        px = protectedAssetLocal.x + dir.x * effectiveClearance;
        py = protectedAssetLocal.y + dir.y * effectiveClearance;
      }
    }
    const { lat, lon } = localToLatLon(px, py);
    spawns.push({
      id: `${faction}-synth-${n + 1}`,
      faction,
      platform: base.platform ?? 'asv',
      lat,
      lon,
      headingDeg: (base.headingDeg + n * 13) % 360,
    });
    n++;
  }
  return spawns;
}

/**
 * 宣言された latencyS（＝発効時刻の検算に使える1本の値）。
 * 分布（latencyModel）を使う decider は発行ごとに引くので、外から発効時刻を予言できない。
 * その場合は null を返し、検算そのものを飛ばす（嘘の期待値で落とさない）。
 */
function declaredLatencyS(timing) {
  if ((timing?.latencyModel ?? 'constant') !== 'constant') return null;
  return Number.isFinite(timing?.latencyS) ? timing.latencyS : null;
}

/**
 * 実測 t_wall を積むステージ名（roadmap D-3）。L0 のパイプラインは [infer] 1段なので、
 * 1回の await をそのステージの実測値として記録できる。多段宣言（L1 の render→infer 等）を
 * 1回の await から分解することはできないので、その場合は 'pipeline' に丸めて記録する
 * （分解が要るようになったら、指揮官側がステージ別の実測値を返す形にする）。
 */
function stageKeyOf(timing) {
  const stages = timing?.stages;
  if (Array.isArray(stages) && stages.length === 1 && typeof stages[0]?.name === 'string') return stages[0].name;
  return 'pipeline';
}

/**
 * 発効時刻の検算。headless は発行を await するので、指示は必ず
 * 「t_issue + latencyS を過ぎた最初の刻み」で発効する。
 *   - 早い（lag < 0）: 発効前の物理が推論結果に依存した ＝ 時間モデルが壊れている
 *   - 1刻み以上遅い（lag >= dt）: 発行を待たずに物理を進めた ＝ §9 の前提が壊れている
 * どちらも実験データを黙って汚すより、その場で止めるほうがよい。
 */
function assertAppliedOnTime(cycle, dt) {
  if (cycle.applyLagS === null) return;
  if (cycle.applyLagS < -T_EPS || cycle.applyLagS > dt + T_EPS) {
    throw new Error(
      `"${cycle.decider}" issued at t=${cycle.tIssueS} took effect at t=${cycle.tAppliedS} ` +
        `(expected t=${cycle.tApplyScheduledS}, lag=${cycle.applyLagS}s, dt=${dt}s) — ` +
        'docs/time-model.md §8/§9 の発効時刻が守られていない'
    );
  }
}

/**
 * 1エピソードを done まで走らせる（毎ステップの順序はファイル冒頭の 1〜5）。
 *
 * core/ の部品はすべて引数で受け取る（このファイルは CJS、core/ は ESM のため。
 * 副産物として、テストが実物の World と差し替えた applyOrders を渡してループだけを検証できる）。
 *
 * @param {object} deps
 * @param {import('../core/sim/world.js').World} deps.world
 * @param {import('../core/env/env_api.js').EnvApi} deps.env
 * @param {import('../core/sim/command/decision_scheduler.js').DecisionScheduler} deps.scheduler
 * @param {Map<string, {faction:string, timing:object, decide:(picture:object)=>Promise<object|null>}>} deps.commanders
 *   scheduler へ register() 済みの decider id をキーにする。timing は register() へ渡したものと同一の設定
 * @param {Function} deps.buildPicture - buildFusedPicture(world, faction, {episode})
 * @param {Function} deps.applyOrders - applyOrders(world, faction, orders)
 * @param {Function} deps.applyDefaultOrders - applyDefaultOrders(world, {faction})（onMiss:'default-order' 用）
 * @param {Function} deps.computeBoatActions - computeBoatActions(world, observation)
 * @param {object} deps.meta - env.reset() に渡すログ用メタデータ
 * @param {number} deps.maxSteps
 * @param {boolean} [deps.quiet]
 * @param {boolean} [deps.verbose] - 発効ごとに1行表示する
 * @returns {Promise<{result:object, stepCount:number, wallS:number, cycles:object[], counts:object}>}
 */
async function runEpisode({
  world,
  env,
  scheduler,
  commanders,
  buildPicture,
  applyOrders,
  applyDefaultOrders,
  computeBoatActions,
  meta,
  maxSteps,
  quiet = false,
  verbose = false,
}) {
  // 登録（スケジューラ）と指揮官（decide の実体）の対応がずれると、片方の腕が一度も判断しないまま
  // 「その腕の結果」として集計される＝黙って統制群にすり替わる。物理を1歩でも進める前に突き合わせる。
  const registered = new Set(scheduler.deciders?.keys?.() ?? commanders.keys());
  for (const id of commanders.keys()) {
    if (!registered.has(id)) throw new Error(`runEpisode: commander "${id}" is not registered with the scheduler`);
  }
  for (const id of registered) {
    if (!commanders.has(id)) throw new Error(`runEpisode: scheduler decider "${id}" has no commander to decide for it`);
  }

  let observation = env.reset(meta); // resetEntities が orders/tracks/controller も初期化する
  scheduler.reset(); // 発行トークンの世代が進み、前エピソードの in-flight な結果は二度と書き込めない
  const episode = env.logger.currentEpisode;
  const showOrders = verbose && !quiet;

  /** @type {Map<string, object>} decider id -> 発行中サイクルの記録行（発効・不成立で完成する） */
  const inFlight = new Map();
  /** 1判断 = 1行。記録側の変数だけを持つ（roadmap D-3 / §2.5 I1） */
  const cycles = [];
  const counts = {
    issued: 0,
    applied: 0, // 新しい指示が発効したサイクル数
    kept: 0, // 推論が失敗し「現指示維持」になったサイクル数（LLM 腕の完了条件に使う）
    missed: 0, // 締切に間に合わず不成立になったサイクル数
    missedNonDeterministic: 0, // そのうち reason='unarrived'（headless では 0 のはず）
    blocked: 0, // 発効時刻に結果が未着だったステップ数（headless では 0 のはず。§9）
    discardedResults: 0, // provideResult がトークン不一致・不成立確定で捨てた結果の数
    appliedOrders: 0,
    ignoredOrders: 0,
    // 発効時刻の検算は「発効時刻に達したサイクル」全体（= applied + kept）で行うが、
    // 数は結末ごとに分けて持つ。まとめて1つに数えると分母（applied）と母集団が食い違い、
    // 推論が失敗しがちな腕（kept>0）で exactApplies/applied が 22/15 のような
    // 成立しない比になる——完了条件を担う行がいちばん必要な場面で壊れる。
    exactApplies: 0, // 新しい指示が t_issue+latencyS ちょうどに発効した数（分母は applied）
    exactKeeps: 0, // 指示無しのまま同じ時刻ちょうどに解放された数（分母は kept）
    maxApplyLagS: 0, // 上記どちらも含めた最大ずれ（母集団を持たない最悪値なので合算でよい）
  };

  let stepCount = 0;
  let result;
  const wall0 = process.hrtime.bigint();

  for (let i = 0; i < maxSteps; i++) {
    const t = world.clock;

    // --- 1. 発効（§8-1）。適用してから発行するので、同ステップの統合図は最新の指示を映す ---
    for (const id of scheduler.dueToApply(t)) {
      const commander = commanders.get(id);
      const cycle = inFlight.get(id);
      inFlight.delete(id);
      const decision = scheduler.takeResult(id);
      // 時刻ちょうどか否かは結末より先に決まる（スケジューラの仕事）。結末が applied か kept かは
      // この下で分かるので、判定だけ先に取って、加算はそれぞれの枝で行う。
      let onExactTime = false;
      if (cycle) {
        cycle.tAppliedS = t;
        cycle.applyLagS = cycle.tApplyScheduledS === null ? null : t - cycle.tApplyScheduledS;
        assertAppliedOnTime(cycle, env.dt);
        if (cycle.applyLagS !== null) {
          onExactTime = Math.abs(cycle.applyLagS) <= T_EPS;
          counts.maxApplyLagS = Math.max(counts.maxApplyLagS, Math.abs(cycle.applyLagS));
        }
      }
      if (decision?.orders?.length > 0) {
        if (onExactTime) counts.exactApplies += 1;
        const { applied, ignored } = applyOrders(world, commander.faction, decision.orders);
        counts.applied += 1;
        counts.appliedOrders += applied;
        counts.ignoredOrders += ignored;
        if (cycle) {
          cycle.outcome = 'applied';
          cycle.orders = applied;
          cycle.ignored = ignored;
          cycle.intent = decision.intent ?? null;
        }
        if (showOrders) {
          console.log(
            `  t=${t.toFixed(1)} ${id}: ${applied} order(s)${ignored > 0 ? ` (+${ignored} ignored)` : ''}` +
              `${decision.intent ? ` 「${decision.intent}」` : ''}`
          );
        }
      } else {
        // decision が null ＝ 推論の失敗（llm_commander は失敗を null で表す）。
        // 新しい指示は無く、艇は現指示のまま。これが LLM 腕の keptOrders の実体。
        counts.kept += 1;
        if (onExactTime) counts.exactKeeps += 1;
        if (cycle) cycle.outcome = 'kept';
        if (showOrders) console.log(`  t=${t.toFixed(1)} ${id}: kept current orders (no usable decision)`);
      }
    }

    // --- 2. 不成立（§12.5）。既定 deadlineS=∞ では常に空 ---
    for (const entry of scheduler.missedAt(t)) {
      const miss = scheduler.takeMissed(entry.id) ?? entry;
      const commander = commanders.get(entry.id);
      const cycle = inFlight.get(entry.id);
      inFlight.delete(entry.id);
      counts.missed += 1;
      if (!miss.deterministic) counts.missedNonDeterministic += 1;
      if (miss.onMiss === 'default-order') applyDefaultOrders(world, { faction: commander.faction });
      if (cycle) {
        cycle.outcome = 'missed';
        cycle.missReason = miss.reason;
        cycle.deterministic = miss.deterministic;
        cycle.onMiss = miss.onMiss;
      }
      if (showOrders) {
        console.log(`  t=${t.toFixed(1)} ${entry.id}: MISSED (${miss.reason}) -> ${miss.onMiss}`);
      }
    }

    // --- 3. 発行（§8-2）。headless は結果を await してから物理を進める（§9） ---
    const due = scheduler.dueToIssue(t);
    if (due.length > 0) {
      await Promise.all(
        due.map(async (id) => {
          const commander = commanders.get(id);
          const timing = commander.timing ?? {};
          // 観測スナップショットは発行時刻のもの。ここから先、世界が進んでもこの図は更新しない（I3）
          // 指揮官は共通の buildPicture（統合図）。艇はそれぞれ自分の視界を持つビルダーを
          // decider ごとに携える（マルチLLM: commander.buildPicture があればそちらを使う）。
          const picture = commander.buildPicture
            ? commander.buildPicture(world, { episode })
            : buildPicture(world, commander.faction, { episode });
          const token = scheduler.markIssued(id, t);
          const latencyS = declaredLatencyS(timing);
          const cycle = {
            episode,
            decider: id,
            faction: commander.faction,
            token,
            tIssueS: t,
            tApplyScheduledS: latencyS === null ? null : t + latencyS,
            tAppliedS: null,
            applyLagS: null,
            outcome: null, // 'applied' | 'kept' | 'missed' | 'in-flight'
            orders: 0,
            ignored: 0,
            intent: null,
            missReason: null,
            deterministic: null,
            onMiss: timing.onMiss ?? 'keep-current',
            stagesDeclared: timing.stages ?? null,
            // 実測 t_wall（記録側のみ。ルール側の latencyS には決して混ぜない。§2.5 I1）
            stageWallMs: {},
          };
          cycles.push(cycle);
          inFlight.set(id, cycle);
          counts.issued += 1;

          const stageWall0 = process.hrtime.bigint();
          const decision = await commander.decide(picture);
          cycle.stageWallMs[stageKeyOf(timing)] = Number(process.hrtime.bigint() - stageWall0) / 1e6;

          // トークン不一致・不成立確定なら捨てられる（§12.5）。headless で起きるのは
          // 「発行時に doomed が確定していた」場合だけで、それは仕様どおりの破棄である。
          if (!scheduler.provideResult(id, decision, token)) counts.discardedResults += 1;
        })
      );
    }

    // 発行を await した以上、発効時刻に結果が未着ということは起こらない（§9）。
    // 0 でなければ配線バグなので、黙って進まずサマリに出す。
    counts.blocked += scheduler.blockedAt(t).length;

    // --- 4. 艇の追従制御 → 5. 物理 ---
    result = env.step(computeBoatActions(world, observation));
    observation = result.observation;
    stepCount++;
    if (result.done) break;
  }

  const wallS = Number(process.hrtime.bigint() - wall0) / 1e9;
  // エピソードの終了が発効を追い越したサイクル（発行済み・未発効のまま決着）。
  // 捨てずに記録へ残す: 「発行したのに効かなかった」は采配の評価に効く事実である。
  for (const cycle of inFlight.values()) if (cycle.outcome === null) cycle.outcome = 'in-flight';

  if (!result || !result.done) {
    throw new Error(`episode did not reach done within ${maxSteps} steps (meta=${JSON.stringify(meta)})`);
  }
  return { result, stepCount, wallS, cycles, counts };
}

/** 判断サイクルの記録を decider ごとに集計する（腕ごとの勝ち負け以外の指標はここから出す） */
function summarizeCycles(cycles) {
  const byDecider = new Map();
  for (const c of cycles) {
    let s = byDecider.get(c.decider);
    if (!s) {
      s = {
        faction: c.faction,
        issued: 0,
        applied: 0,
        kept: 0,
        missed: 0,
        inFlight: 0,
        appliedOrders: 0,
        ignoredOrders: 0,
        exactApplies: 0,
        maxApplyLagS: 0,
        stageWallMs: new Map(),
      };
      byDecider.set(c.decider, s);
    }
    s.issued += 1;
    if (c.outcome === 'applied') {
      s.applied += 1;
      s.appliedOrders += c.orders;
      s.ignoredOrders += c.ignored;
      if (c.applyLagS !== null) {
        if (Math.abs(c.applyLagS) <= T_EPS) s.exactApplies += 1;
        s.maxApplyLagS = Math.max(s.maxApplyLagS, Math.abs(c.applyLagS));
      }
    } else if (c.outcome === 'kept') s.kept += 1;
    else if (c.outcome === 'missed') s.missed += 1;
    else s.inFlight += 1;
    for (const [stage, ms] of Object.entries(c.stageWallMs)) {
      const w = s.stageWallMs.get(stage) ?? { n: 0, totalMs: 0, maxMs: 0 };
      w.n += 1;
      w.totalMs += ms;
      w.maxMs = Math.max(w.maxMs, ms);
      s.stageWallMs.set(stage, w);
    }
  }
  return byDecider;
}

/**
 * モデルを VRAM へ載せておく。実測（docs/llm-probe-measurements-2026-08-13.md）で
 * qwen2.5:7b のコールドスタートは 8.7s（うち 6.5s がロード）で、ウォーム p50 の 4 倍を超える。
 * ウォームアップ無しだと最初の1判断だけ極端に遅い実測値が混ざり、レイテンシの平均が実態から外れる。
 * 失敗しても実行は続ける（サーバが落ちているなら、その事実は各判断の失敗として統計に出る）。
 */
async function warmUpModel(postChatCompletion, { baseUrl, model, temperature, maxTokens }) {
  const t0 = process.hrtime.bigint();
  try {
    await postChatCompletion({
      baseUrl,
      model,
      temperature,
      ...(maxTokens ? { maxTokens } : {}),
      systemPrompt: 'You are a naval commander. Answer with one word.',
      userPrompt: 'Ready?',
    });
    console.log(`warmup: ${model} loaded in ${(Number(process.hrtime.bigint() - t0) / 1e9).toFixed(1)}s`);
  } catch (err) {
    console.log(
      `WARNING: warmup for ${model} failed (${err?.kind ?? 'error'}: ${err?.message ?? err}). ` +
        'Continuing — if the server is really down, every decision will be counted as a failure.'
    );
  }
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    console.log(HELP_TEXT);
    return;
  }

  const { World } = await import('../core/sim/world.js');
  const { EnvApi } = await import('../core/env/env_api.js');
  const missionMod = await import('../core/sim/mission.js');
  const { loadSceneFromScenario } = await import('../core/data/adapters/index.js');
  const { DecisionScheduler } = await import('../core/sim/command/decision_scheduler.js');
  const { applyOrders, applyDefaultOrders } = await import('../core/sim/command/orders.js');
  const { computeBoatActions } = await import('../core/sim/command/boat_controller.js');
  const { buildFusedPicture } = await import('../core/sim/command/fused_picture.js');
  const { scriptedDefenderCommander, scriptedIntruderCommander } = await import(
    '../core/sim/command/scripted_commanders.js'
  );
  const { createLlmCommanderFn } = await import('../core/sim/command/llm_commander.js');
  const { buildBoatPicture, createLlmBoatAgentFn } = await import('../core/sim/agents/boat_agent.js');

  const scenarioPath = resolveScenarioPath(opts.scenario);
  if (!fs.existsSync(scenarioPath)) {
    const dir = path.join(__dirname, '../core/scenarios');
    const known = fs.readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => f.replace(/\.json$/, ''));
    throw new Error(`scenario not found: ${scenarioPath} (known: ${known.join(', ')})`);
  }
  const scenario = JSON.parse(fs.readFileSync(scenarioPath, 'utf8'));
  const scene = await loadSceneFromScenario(scenario); // scene.projectionをspawn合成より先に用意する

  const boatsTarget = opts.boats ?? scenario.spawns.length;
  const spawns = synthesizeSpawns(scenario.spawns, boatsTarget, {
    latLonToLocal: scene.projection.latLonToLocal,
    localToLatLon: scene.projection.localToLatLon,
    protectedAssetLocal: scenario.protectedAssetLatLon
      ? scene.projection.latLonToLocal(scenario.protectedAssetLatLon.lat, scenario.protectedAssetLatLon.lon)
      : null,
  });

  // 片方の陣営が0隻だと、evaluateMission()がintruder不在=defended（またはtimeout）を
  // 初手で返してしまい、意味の無い(steps=1桁の)steps/sを出してしまう
  // （例: --boats 2 は元のdefender-1/defender-2のみが残りintruderが消える）。
  // これは「スループット計測ツールが無意味な設定を黙って受理する」バグなので、
  // 未知フラグと同じくthrow -> main().catch()経由でエラーメッセージ・非ゼロ終了にする。
  const hasDefender = spawns.some((s) => s.faction === 'defender');
  const hasIntruder = spawns.some((s) => s.faction === 'intruder');
  if (!hasDefender || !hasIntruder) {
    throw new Error(
      `--boats ${spawns.length} produces a degenerate spawn set (defender=${spawns.filter((s) => s.faction === 'defender').length}, ` +
        `intruder=${spawns.filter((s) => s.faction === 'intruder').length}); need at least 1 of each faction for a meaningful episode. ` +
        'Use --boats >= 3 (or omit --boats to keep the scenario default).'
    );
  }

  const protectedAsset = scenario.protectedAssetLatLon
    ? scene.projection.latLonToLocal(scenario.protectedAssetLatLon.lat, scenario.protectedAssetLatLon.lon)
    : null;
  const world = new World({
    scene,
    capacity: spawns.length,
    protectedAsset,
    radarRangeM: scenario.sensors?.radarRangeM,
    radarPerShipClass: scenario.sensors?.perShipClass === true,
    radarRangeScale: scenario.sensors?.radarScale,
    episodeTimeLimitS: scenario.episodeTimeLimitS,
  });
  for (const s of spawns) {
    const { x, y } = scene.projection.latLonToLocal(s.lat, s.lon);
    // v2 では艇はエージェントオブジェクトを持たない。毎ステップの操舵は boat_controller.js が
    // 現在の指示から計算し、指示を出すのは指揮官（下の commanders）だけである。
    world.spawn({ id: s.id, faction: s.faction, shipClass: s.shipClass, platform: s.platform ?? 'asv', x, y, heading: (s.headingDeg * Math.PI) / 180 });
  }

  const env = new EnvApi(world); // dt既定0.1s
  // 制限時間により全エピソードは必ずtimeoutでdoneになる。dt刻み数+余裕をハードリミットにする。
  // シナリオが episodeTimeLimitS で上書きしている場合は**そちら**を見ること。既定値で計算すると、
  // 戦場を広げて制限時間を伸ばした盤面が判定に達する前にハードリミットで落ちる。
  const maxSteps = Math.ceil(missionMod.episodeTimeLimitOf(world) / env.dt) + 50;

  // --- 指揮官とスケジューラ ---
  // 時間設定は1か所（opts）から作り、スケジューラ・プロンプト・発効時刻の検算がすべて同じ値を見る。
  // stages は L0 では [infer] の1段。宣言しておくと実測 t_wall をステージ名で残せる（roadmap D-3）。
  // latencyS も併記するが、register() が「stages の合成と食い違えば設定ミス」として弾く。
  const timing = {
    intervalS: opts.commandIntervalS,
    latencyS: opts.commandLatencyS,
    stages: [{ name: 'infer', seconds: opts.commandLatencyS }],
    deadlineS: opts.deadlineS,
    onMiss: opts.onMiss,
  };
  const llmCallRecords = [];
  function makeCommander(side, faction) {
    if (side === 'llm') {
      return {
        faction,
        timing,
        side,
        decide: createLlmCommanderFn({
          faction,
          intervalS: opts.commandIntervalS,
          latencyS: opts.commandLatencyS,
          baseUrl: opts.llmUrl,
          model: opts.model,
          temperature: opts.temperature,
          ...(opts.maxTokens ? { maxTokens: opts.maxTokens } : {}),
          ...(opts.timeoutMs ? { timeoutMs: opts.timeoutMs } : {}),
          transport: opts.transport,
          thinking: opts.thinking,
          ...(opts.reasoningEffort ? { reasoningEffort: opts.reasoningEffort } : {}),
          // 記録フックは同期。ここで待つと記録の都合が実測レイテンシへ混ざる（§2.5 I1）
          onCall: opts.llmLog ? (rec) => llmCallRecords.push(rec) : null,
        }),
      };
    }
    // scripted は同期関数。LLM 腕と同じ「統合図→{orders,intent}」の型に合わせて async で包むだけで、
    // 発効遅延（latencyS）は同じくスケジューラが与える＝速度差という交絡因子は入らない（§9）。
    const fn = faction === 'defender' ? scriptedDefenderCommander : scriptedIntruderCommander;
    return { faction, timing, side, decide: async (picture) => fn(picture) };
  }
  const commanders = new Map([
    ['blue-commander', makeCommander(opts.blue, 'defender')],
    ['red-commander', makeCommander(opts.red, 'intruder')],
  ]);

  // --- 艇レベル LLM（マルチLLM）--- docs/decision-architecture.md §1 の艇台帳。
  // 指揮官と同じ decide()→{orders,intent}|null 契約・同じ world.orders への書き込みなので、
  // commanders マップへそのまま合流させれば scheduler.register も末尾の統計表示もそのまま乗る
  // （register() は「艇を足すだけで乗る」設計。§13 / decision-architecture.md §0）。
  // def-heavy には頭脳を載せない（判断の余地が最小・推論を割かない。同 §1 の設計どおり）。
  const BOAT_LLM_IDS = ['def-runner-1', 'def-runner-2', 'def-scout'];
  if (opts.boatMode === 'llm') {
    const boatTiming = {
      intervalS: opts.boatIntervalS,
      latencyS: opts.boatLatencyS,
      stages: [{ name: 'infer', seconds: opts.boatLatencyS }],
    };
    for (const boatId of BOAT_LLM_IDS) {
      if (world.state.indexOf(boatId) < 0) {
        console.warn(`--boat-mode llm: scenario "${scenario.name}" has no boat "${boatId}"; skipping`);
        continue;
      }
      const llmDecide = createLlmBoatAgentFn({
        boatId,
        faction: 'defender',
        intervalS: opts.boatIntervalS,
        latencyS: opts.boatLatencyS,
        baseUrl: opts.llmUrl,
        // 艇は呼び出し回数が多い。別モデル（軽量）・別 thinking 設定を与えられるようにし、
        // 未指定なら指揮官側と同じ値へ落とす（thinking-model-plan.md §3.5 設計1）。
        model: opts.boatModel ?? opts.model,
        temperature: opts.temperature,
        ...(opts.boatMaxTokens ?? opts.maxTokens ? { maxTokens: opts.boatMaxTokens ?? opts.maxTokens } : {}),
        ...(opts.timeoutMs ? { timeoutMs: opts.timeoutMs } : {}),
        transport: opts.transport,
        thinking: opts.boatThinking ?? opts.thinking,
        ...(opts.boatReasoningEffort ?? opts.reasoningEffort
          ? { reasoningEffort: opts.boatReasoningEffort ?? opts.reasoningEffort }
          : {}),
        onCall: opts.llmLog ? (rec) => llmCallRecords.push(rec) : null,
      });
      // 相討ちで消えた艇は判断しない＝推論を焚かない。サイクルは kept（指示なし）として
      // 通常どおり刻まれるので、スケジューラ側の決定論には触れない。
      const decide = async (picture) => (picture?.dead ? null : llmDecide(picture));
      decide.stats = llmDecide.stats;
      commanders.set(boatId, {
        faction: 'defender',
        timing: boatTiming,
        side: 'llm',
        buildPicture: (w, o) => {
          const bi = w.state.indexOf(boatId);
          if (bi < 0 || !w.state.alive[bi]) return { boatId, dead: true };
          return buildBoatPicture(w, boatId, o);
        },
        decide,
      });
    }
    if (![...commanders.keys()].some((id) => BOAT_LLM_IDS.includes(id))) {
      throw new Error(
        `--boat-mode llm: scenario "${scenario.name}" has none of ${BOAT_LLM_IDS.join(', ')}; nothing to register`
      );
    }
  }

  const scheduler = new DecisionScheduler();
  for (const [id, commander] of commanders) scheduler.register(id, commander.timing);

  if (opts.warmup && (opts.blue === 'llm' || opts.red === 'llm' || opts.boatMode === 'llm')) {
    const { postChatCompletion } = await import('../core/sim/agents/llm_http.js');
    await warmUpModel(postChatCompletion, {
      baseUrl: opts.llmUrl,
      model: opts.model,
      temperature: opts.temperature,
      maxTokens: opts.maxTokens,
    });
  }

  // --- 実行 ---
  let totalSteps = 0;
  let totalWallS = 0;
  const tally = { defended: 0, breached: 0, timeout: 0 };
  const allCycles = [];
  const totals = {
    issued: 0,
    applied: 0,
    kept: 0,
    missed: 0,
    missedNonDeterministic: 0,
    blocked: 0,
    discardedResults: 0,
    appliedOrders: 0,
    ignoredOrders: 0,
    exactApplies: 0,
    exactKeeps: 0,
    maxApplyLagS: 0,
  };
  for (let ep = 1; ep <= opts.episodes; ep++) {
    const meta = {
      scenario: scenario.name,
      episodeIndex: ep,
      blue: opts.blue,
      red: opts.red,
      model: opts.model ?? null,
      commandIntervalS: opts.commandIntervalS,
      commandLatencyS: opts.commandLatencyS,
    };
    const { result, stepCount, wallS, cycles, counts } = await runEpisode({
      world,
      env,
      scheduler,
      commanders,
      buildPicture: buildFusedPicture,
      applyOrders,
      applyDefaultOrders,
      computeBoatActions,
      meta,
      maxSteps,
      quiet: opts.quiet,
      verbose: opts.verbose,
    });
    totalSteps += stepCount;
    totalWallS += wallS;
    allCycles.push(...cycles);
    for (const key of Object.keys(totals)) {
      totals[key] = key === 'maxApplyLagS' ? Math.max(totals[key], counts[key]) : totals[key] + counts[key];
    }
    tally[result.info.outcome] = (tally[result.info.outcome] ?? 0) + 1;
    if (!opts.quiet) {
      console.log(
        `episode ${ep}/${opts.episodes}: outcome=${result.info.outcome} ` +
          `simTime=${world.clock.toFixed(1)}s wallTime=${wallS.toFixed(3)}s steps=${stepCount} ` +
          `orders=${counts.applied}/${counts.issued}`
      );
    }
  }

  // --- サマリ ---
  const stepsPerSec = totalSteps / totalWallS;
  console.log('---');
  console.log(
    `blue=${opts.blue} red=${opts.red}${opts.model ? ` model=${opts.model} temp=${opts.temperature}` : ''} ` +
      `interval=${opts.commandIntervalS}s latency=${opts.commandLatencyS}s ` +
      `deadline=${opts.deadlineS === Infinity ? 'inf' : `${opts.deadlineS}s`} onMiss=${opts.onMiss} ` +
      `boats=${spawns.length}` +
      `${opts.boatMode === 'llm' ? ` boatMode=llm×${[...commanders.keys()].filter((id) => BOAT_LLM_IDS.includes(id)).length}(interval=${opts.boatIntervalS}s,latency=${opts.boatLatencyS}s)` : ''} ` +
      `episodes=${opts.episodes}`
  );
  console.log(
    `outcomes: defended=${tally.defended} breached=${tally.breached} timeout=${tally.timeout} ` +
      `(defender win rate ${((tally.defended / opts.episodes) * 100).toFixed(1)}%)`
  );
  console.log(
    `totalSteps=${totalSteps} totalWallTime=${totalWallS.toFixed(3)}s steps/s = ${stepsPerSec.toFixed(1)} ` +
      `(per boat ${(stepsPerSec / spawns.length).toFixed(1)})`
  );
  console.log(
    `commands: issued=${totals.issued} applied=${totals.applied} kept=${totals.kept} missed=${totals.missed} ` +
      `blocked=${totals.blocked} discarded=${totals.discardedResults} ` +
      `appliedOrders=${totals.appliedOrders} ignoredOrders=${totals.ignoredOrders}`
  );
  // 完了条件そのもの: 指示は t_issue + latencyS ちょうどに効く（§9）。数で示す。
  // 分子と分母は同じ母集団でなければ意味を成さないので、結末ごとに並べる。
  // kept 側（推論が失敗し新しい指示が無かったサイクル）も同じ時刻ちょうどに解放されている
  // ことを示す——スケジューラが失敗時に刻みをずらしていないことの証拠であり、
  // これを落とすと LLM 腕でいちばん見たい列が消える。
  console.log(
    `timing: applied exactly at t_issue+${opts.commandLatencyS}s ${totals.exactApplies}/${totals.applied}` +
      `, kept released on the same tick ${totals.exactKeeps}/${totals.kept} ` +
      `(max lag ${totals.maxApplyLagS.toExponential(1)}s, dt=${env.dt}s)`
  );
  if (totals.blocked > 0) {
    console.log(
      `WARNING: the sim waited on ${totals.blocked} step(s) for an unfinished decision. headless awaits ` +
        'issuance, so this must be 0 (docs/time-model.md §9) — the loop wiring is wrong.'
    );
  }
  if (totals.missedNonDeterministic > 0) {
    console.log(
      `WARNING: ${totals.missedNonDeterministic} miss(es) had reason='unarrived' (arrival-dependent = ` +
        'machine-speed dependent). headless must only miss deterministically (§12.5 I4); exclude this run.'
    );
  }

  const byDecider = summarizeCycles(allCycles);
  for (const [id, commander] of commanders) {
    const s = byDecider.get(id);
    if (!s) continue;
    console.log('---');
    console.log(
      `${id} (${commander.faction}, ${commander.side}): issued=${s.issued} applied=${s.applied} ` +
        `kept=${s.kept} missed=${s.missed} in-flight=${s.inFlight} ` +
        `appliedOrders=${s.appliedOrders} ignoredOrders=${s.ignoredOrders}`
    );
    // roadmap D-3: ステージ別の実測 t_wall。記録側だけの値であり、latencyS へは決して戻さない。
    for (const [stage, w] of s.stageWallMs) {
      console.log(
        `${id}: measured wall (record only) stage=${stage} n=${w.n} ` +
          `mean=${(w.totalMs / Math.max(w.n, 1)).toFixed(1)}ms max=${w.maxMs.toFixed(1)}ms ` +
          `(declared ${opts.commandLatencyS}s — the declared value is what the sim uses)`
      );
    }
    const stats = commander.decide.stats;
    if (!stats) continue; // scripted には stats が無い
    // 指揮官（llm_commander.js）と艇（boat_agent.js）で stats の形が違う: 指揮官は
    // ok/droppedOrders、艇は obeys/overrides を持つ。id が BOAT_LLM_IDS にあるかで分岐する
    // （マルチLLM: 2種類の decider が同じ commanders マップに混在するのはここだけ）。
    const isBoat = BOAT_LLM_IDS.includes(id);
    if (isBoat) {
      console.log(
        `${id}: calls=${stats.calls} obeys=${stats.obeys} overrides=${stats.overrides} ` +
          `parseFailures=${stats.parseFailures} transportFailures=${stats.transportFailures} ` +
          `keptOrders=${stats.keptOrders} onCallErrors=${stats.onCallErrors}`
      );
      console.log(
        `${id}: meanLatency=${(stats.totalLatencyMs / Math.max(stats.calls, 1)).toFixed(0)}ms ` +
          `meanOutputTokens=${(stats.totalOutputTokens / Math.max(stats.calls, 1)).toFixed(1)} ` +
          `byOutcome=${JSON.stringify(stats.byOutcome)}`
      );
    } else {
      console.log(
        `${id}: calls=${stats.calls} ok=${stats.ok} parseFailures=${stats.parseFailures} ` +
          `transportFailures=${stats.transportFailures} keptOrders=${stats.keptOrders} ` +
          `droppedOrders=${stats.droppedOrders} onCallErrors=${stats.onCallErrors}`
      );
      console.log(
        `${id}: meanLatency=${(stats.totalLatencyMs / Math.max(stats.calls, 1)).toFixed(0)}ms ` +
          `meanOutputTokens=${(stats.totalOutputTokens / Math.max(stats.ok, 1)).toFixed(1)} ` +
          `byOutcome=${JSON.stringify(stats.byOutcome)}`
      );
    }
    if (isBoat) {
      // 艇は obey が第一級の応答なので keptOrders が高くて正常（agent-io-design.md §1.2）。
      // ここで警告に値するのは失敗（parse/transport）だけ。
      const failureRate = (stats.parseFailures + stats.transportFailures) / Math.max(stats.calls, 1);
      if (failureRate > 0.2) {
        console.log(
          `WARNING: ${id} failed (parse/transport) on ${(failureRate * 100).toFixed(1)}% of cycles. ` +
            'Fix the prompt or the server before using these outcomes.'
        );
      }
    } else {
      const keptRate = stats.keptOrders / Math.max(stats.calls, 1);
      if (keptRate > 0.2) {
        console.log(
          `WARNING: ${id} kept current orders on ${(keptRate * 100).toFixed(1)}% of cycles (LLM failures). ` +
            'This run under-represents LLM command; fix the prompt or the server before using these outcomes.'
        );
      }
    }
  }

  if (opts.out) {
    fs.writeFileSync(opts.out, env.logger.toJsonl());
    console.log(`log written to ${opts.out} (${env.logger.rows.length} rows)`);
  }
  if (opts.llmLog) {
    fs.writeFileSync(opts.llmLog, llmCallRecords.map((r) => JSON.stringify(r)).join('\n'));
    console.log(`llm call log written to ${opts.llmLog} (${llmCallRecords.length} rows)`);
  }
  if (opts.decisionLog) {
    fs.writeFileSync(opts.decisionLog, allCycles.map((c) => JSON.stringify(c)).join('\n'));
    console.log(`decision log written to ${opts.decisionLog} (${allCycles.length} rows)`);
  }
}

// spawn合成・引数・意思決定ループは tests/command.test.js が単体で検証する。
// require されたときにランナー本体まで走らせない。
module.exports = { synthesizeSpawns, parseArgs, runEpisode };

if (require.main === module) {
  main().catch((err) => {
    console.error('headless_run failed:', err.message);
    process.exit(1);
  });
}
