/**
 * main.js — swarm-sim View のエントリポイント（v2: 指揮官階層＋時間モデル）
 *
 * 意思決定は艇単位の LLM ではなく、陣営ごとの指揮官（scripted | LLM）が
 * DecisionScheduler のライフサイクル（t_issue → t_apply）で行う。
 * 艇はエージェントオブジェクトを持たず、毎ステップ現在の指示への追従制御
 * （core/sim/command/boat_controller.js）で動く。
 *
 * 【時間モデル（ブラウザ側）】docs/time-model.md v2.0 §8（1ステップの処理順序）・§9（実行器の違い）。
 * 物理はアキュムレータ方式の固定ステップ（既存 A-5 対応）のまま。1ステップは
 *   1. dueToApply  → takeResult → applyOrders（発効）
 *   2. missedAt    → takeMissed → onMiss（不成立。deadlineS 有限時のみ）
 *   3. dueToIssue  → markIssued → **fire-and-forget** で推論を発行（headless はここで await する）
 *   4. blockedAt が非空なら 5・6 を実行せずシムを止める（「推論待ち」）
 *   5. computeBoatActions（追従制御）
 *   6. env.step（物理を dt 進める）
 * の順に行う。headless（scripts/headless_run.js）との違いは 3 と 4 だけで、
 * 発効時刻 t_apply = t_issue + latencyS は両者で同一＝采配の内容も同一に決まる。
 *
 * 【推論待ちで止まること】結果が t_apply までに届かなければシムは止まる。これは
 * 仕様であって不具合ではないので、止まっている間は必ず画面が「誰の推論を何秒待っているか」を
 * 言う（#wait-overlay と HUD の実行状態）。止まったまま何も言わない画面は、
 * 見ている側から「固まった／落ちた」と区別が付かない。
 * なお DecisionScheduler.blockedAt() が待つのは deadlineS=Infinity（既定）のときだけである。
 * 有限の締切を付けるとシムは止まらずに進み、その判断は missedAt() で不成立として報告される
 * （§12.5）。両方の経路をこのファイルで扱い、両方をログと HUD に出す。
 *
 * 【エピソード跨ぎ】発行トークン（markIssued の戻り値）を .then() のクロージャが持ち、
 * provideResult へ渡す。エピソードが終わって scheduler.reset() が世代を進めたあとに
 * 遅れて届いた旧エピソードの結果は、ここで黙って捨てられる（§12・§12.5）。
 *
 * 【LLM モード】?blue=llm&model=qwen2.5:7b&llm=http://localhost:11434/v1
 * 既定（パラメータ無し）は両陣営 scripted で、推論サーバーが無くてもそのまま動く
 * （GitHub Pages 上でもサーバー不要のまま）。ローカル Ollama を使う場合は
 * OLLAMA_ORIGINS=* で CORS を許可しておくこと。
 */

import { loadSceneFromScenario } from '../core/data/adapters/index.js';
import { World } from '../core/sim/world.js';
import { EnvApi } from '../core/env/env_api.js';
import { DecisionScheduler } from '../core/sim/command/decision_scheduler.js';
import { applyOrders, applyDefaultOrders } from '../core/sim/command/orders.js';
import { computeBoatActions } from '../core/sim/command/boat_controller.js';
import { buildFusedPicture } from '../core/sim/command/fused_picture.js';
import { scriptedDefenderCommander, scriptedIntruderCommander } from '../core/sim/command/scripted_commanders.js';
import { createLlmCommanderFn } from '../core/sim/command/llm_commander.js';
import { buildBoatPicture, createLlmBoatAgentFn } from '../core/sim/agents/boat_agent.js';
import { createProjection, drawMap, drawProtectedAsset, drawOrders } from './map_view.js';
import { drawAgents } from './agent_view.js';
import { CommsPulses } from './comms_view.js';
import {
  appendCommsEntry,
  appendMissionEntry,
  appendOrdersEntry,
  appendMissEntry,
  appendSystemEntry,
} from './log_panel.js';
import {
  updateHud,
  showOutcomeBanner,
  hideOutcomeBanner,
  wireDownloadButton,
  showWaiting,
  hideWaiting,
} from './hud_panel.js';

// 実時間の何倍でシムを進めるか。EPISODE_TIME_LIMIT_S=240sを等倍で見せると決着まで最大4分かかり、
// 10倍速では操船・回避行動が目で追えない。3倍速なら最長でも実時間80秒で1エピソードが決着する。
const TIME_SCALE = 3;
// 1フレームで加算する実経過時間の上限。バックグラウンドタブから復帰した際に巨大なdtが
// 一度に積まれ、step()が暴走的に大量発行されるのを防ぐ。
const MAX_FRAME_DT_S = 0.25;
// 結果バナーを表示しておく実時間（ミリ秒）。この間はstep()を呼ばず、wall timeで待つ。
const BANNER_DURATION_MS = 3000;
// 不成立（miss）をHUDに出しておく実時間（ミリ秒）。不成立ではシムが止まらないので、
// これが無いと「1サイクル采配が飛んだ」ことがログを読まない限り画面から分からない。
const MISS_NOTICE_MS = 4000;
// 同じ相手・同じ種別の通信をログへ書く最小間隔（シム秒）。contact_report は毎ステップ
// （＝シム秒あたり10行×ペア数）出るため、間引かないと指揮官の ORDERS 行が数秒で
// 200行の上限から押し出される。地図上のパルス（comms_view.js）は間引かないので、
// 「通信が飛び交っている」という絵は失わずにログの可読性だけを取る。
const COMM_LOG_MIN_INTERVAL_S = 2;
/** 指揮サイクル・発効遅延の既定（?interval= / ?latency= で上書き可。headless の既定と同一） */
const DEFAULT_COMMAND_INTERVAL_S = 10;
const DEFAULT_COMMAND_LATENCY_S = 3;
/**
 * 艇の判断サイクル・発効遅延の既定（?boatinterval= / ?boatlatency= で上書き可）。
 * 指揮官より速く・短く決める: 艇は自分のレーダーだけを見ており、指揮官の統合図より
 * 新しい情報を持つ。その差が判断に現れるためには、指揮官より高い頻度で決められなければ
 * ならない。一方で艇の数だけ推論が増えるので、間隔を詰めすぎると 3060 級では
 * 「推論待ち」で画面が止まり続ける（docs/development-roadmap.md §5 の処理能力の話）。
 */
const DEFAULT_BOAT_INTERVAL_S = 6;
const DEFAULT_BOAT_LATENCY_S = 1;
/** LLM モードの既定ベースURL（OpenAI 互換。開発は Ollama、GPU サーバーでは vLLM） */
const DEFAULT_LLM_BASE_URL = 'http://localhost:11434/v1';

/** 既定は艦種入りの攻防シナリオ。?scenario=tokyo_bay_minimal で旧・3隻シナリオに戻せる */
const DEFAULT_SCENARIO = 'flag_defence_squadrons';

async function loadScenario(params) {
  const name = (params.get('scenario') ?? DEFAULT_SCENARIO).replace(/[^a-z0-9_]/gi, '');
  const res = await fetch(`../core/scenarios/${name}.json`);
  if (!res.ok) throw new Error(`シナリオ読み込み失敗: ${name} (${res.status})`);
  return res.json();
}

/** ?name= を正の数として読む。壊れた指定は既定値へ落として警告する（デモを止めない） */
function positiveNumberParam(params, name, fallback) {
  const raw = params.get(name);
  if (raw === null || raw.trim() === '') return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    console.warn(`swarm-sim: ?${name}=${raw} は正の数ではないため既定値 ${fallback} を使います`);
    return fallback;
  }
  return value;
}

/**
 * ?name= を有限の数として読む（0 も許す。temperature=0 は正当な指定）。
 * 未指定・壊れた指定なら null を返し、呼び出し側はモジュール既定へ委ねる。
 */
function finiteNumberParam(params, name) {
  const raw = params.get(name);
  if (raw === null || raw.trim() === '') return null;
  const value = Number(raw);
  if (!Number.isFinite(value)) {
    console.warn(`swarm-sim: ?${name}=${raw} は数値ではないため無視します`);
    return null;
  }
  return value;
}

/** 締切だけは「無限」を書けるようにする（既定＝待ち続ける＝docs/time-model.md §12.5 のA案） */
function deadlineParam(params) {
  const raw = params.get('deadline');
  if (raw === null || raw.trim() === '') return Infinity;
  if (['inf', 'infinity', 'none'].includes(raw.trim().toLowerCase())) return Infinity;
  return positiveNumberParam(params, 'deadline', Infinity);
}

async function main() {
  const params = new URLSearchParams(location.search);
  const scenario = await loadScenario(params);
  const scene = await loadSceneFromScenario(scenario);
  const world = new World({
    scene,
    capacity: scenario.spawns.length,
    protectedAsset: scenario.protectedAssetLatLon
      ? scene.projection.latLonToLocal(scenario.protectedAssetLatLon.lat, scenario.protectedAssetLatLon.lon)
      : null,
    radarRangeM: scenario.sensors?.radarRangeM,
    // perShipClass=true のシナリオ（艦種3種入り）は艦種ごとの探知距離を使う。headless側と同じ条件。
    radarPerShipClass: scenario.sensors?.perShipClass === true,
    radarRangeScale: scenario.sensors?.radarScale,
    episodeTimeLimitS: scenario.episodeTimeLimitS,
  });

  for (const spawn of scenario.spawns) {
    const { x, y } = scene.projection.latLonToLocal(spawn.lat, spawn.lon);
    // v2 では艇はエージェントオブジェクトを持たない。操舵は computeBoatActions が
    // 毎ステップ現在の指示から計算し、指示を出すのは指揮官だけである。
    world.spawn({
      id: spawn.id,
      faction: spawn.faction,
      shipClass: spawn.shipClass,
      platform: spawn.platform,
      x,
      y,
      heading: (spawn.headingDeg * Math.PI) / 180,
    });
  }

  const env = new EnvApi(world);

  // --- 指揮官とスケジューラ ---
  // 時間設定は1か所から作り、スケジューラ・LLM プロンプト・ログがすべて同じ値を見る。
  const timing = {
    intervalS: positiveNumberParam(params, 'interval', DEFAULT_COMMAND_INTERVAL_S),
    latencyS: positiveNumberParam(params, 'latency', DEFAULT_COMMAND_LATENCY_S),
    deadlineS: deadlineParam(params),
    onMiss: params.get('onmiss') === 'default-order' ? 'default-order' : 'keep-current',
  };
  const baseUrl = params.get('llm') ?? DEFAULT_LLM_BASE_URL;
  const model = params.get('model');
  const temperature = finiteNumberParam(params, 'temp');
  const maxTokens = finiteNumberParam(params, 'maxtokens');
  /** 接続失敗のヒントは1回だけ出す（毎サイクル出すとログが埋まる） */
  let connectionHintShown = false;

  /** LLM 指揮官の1判断ごとの結末をログパネルへ出す（失敗が黙って「現指示維持」に化けないように） */
  function llmOnCall(commanderId) {
    return (record) => {
      const seconds = (record.latencyMs / 1000).toFixed(1);
      appendSystemEntry({
        t: record.t,
        text: `LLM ${commanderId}: ${record.outcome} (${seconds}s 実時間)${record.failure ? ` — ${record.failure}` : ''}`,
        tone: record.outcome === 'ok' ? 'info' : 'warn',
      });
      if (record.outcome === 'connection' && !connectionHintShown) {
        connectionHintShown = true;
        appendSystemEntry({
          text: `${baseUrl} へ接続できません。サーバーの起動と CORS 許可（Ollama なら OLLAMA_ORIGINS=*）を確認してください`,
          tone: 'error',
        });
      }
    };
  }

  /** 艇エージェントの1判断ごとの結末をログパネルへ出す（obey も override も見えるようにする） */
  function boatOnCall(boatId) {
    return (record) => {
      const seconds = (record.latencyMs / 1000).toFixed(1);
      const tail = record.reason ? ` — ${record.reason}` : record.failure ? ` — ${record.failure}` : '';
      appendSystemEntry({
        t: record.t,
        text: `BOAT ${boatId}: ${record.outcome} (${seconds}s 実時間)${tail}`,
        tone: record.outcome === 'override' ? 'info' : record.outcome === 'obey' ? 'muted' : 'warn',
      });
    };
  }

  /**
   * @returns {{faction:string, side:string, timing:object, kind:string,
   *   buildPicture:(t:number)=>object, decide:(picture:object)=>Promise<object|null>}}
   */
  function makeCommander(id, side, faction) {
    if (side === 'llm') {
      if (!model) {
        console.warn(`swarm-sim: ${faction} に llm を指定していますが ?model= が無いため scripted で動かします`);
        appendSystemEntry({
          text: `?${id === 'blue-commander' ? 'blue' : 'red'}=llm には ?model= が必要です。scripted で継続します`,
          tone: 'warn',
        });
      } else {
        return {
          faction,
          side,
          timing,
          kind: 'commander',
          buildPicture: () => buildFusedPicture(world, faction, { episode: env.logger.currentEpisode }),
          decide: createLlmCommanderFn({
            faction,
            intervalS: timing.intervalS,
            latencyS: timing.latencyS,
            baseUrl,
            model,
            ...(temperature !== null ? { temperature } : {}),
            ...(maxTokens !== null ? { maxTokens } : {}),
            onCall: llmOnCall(id),
          }),
        };
      }
    } else if (side !== 'scripted') {
      console.warn(`swarm-sim: 未知の指揮官指定 "${side}" のため scripted で動かします`);
    }
    // scripted は同期関数。LLM 腕と同じ「統合図→{orders,intent}」の型に合わせて async で包むだけで、
    // 発効遅延（latencyS）は同じくスケジューラが与える＝速度差という交絡因子は入らない（§9）。
    const fn = faction === 'defender' ? scriptedDefenderCommander : scriptedIntruderCommander;
    return {
      faction,
      side: 'scripted',
      timing,
      kind: 'commander',
      buildPicture: () => buildFusedPicture(world, faction, { episode: env.logger.currentEpisode }),
      decide: async (picture) => fn(picture),
    };
  }

  const commanders = new Map([
    ['blue-commander', makeCommander('blue-commander', params.get('blue') ?? 'scripted', 'defender')],
    ['red-commander', makeCommander('red-commander', params.get('red') ?? 'scripted', 'intruder')],
  ]);

  /**
   * 艇エージェント（Phase 2）。指揮官とまったく同じ型で作るので、スケジューラから見て
   * 両者は区別されない＝時間の扱い・推論待ち・発効・ログが同じ経路を通る。
   * 艇に固有なのは buildPicture（自分のレーダーだけの視界）と decide の中身だけ。
   */
  const boatTiming = {
    intervalS: positiveNumberParam(params, 'boatinterval', DEFAULT_BOAT_INTERVAL_S),
    latencyS: positiveNumberParam(params, 'boatlatency', DEFAULT_BOAT_LATENCY_S),
    deadlineS: timing.deadlineS,
    onMiss: timing.onMiss,
  };
  function makeBoatAgent(boatId, faction) {
    const llmDecide = createLlmBoatAgentFn({
      boatId,
      faction,
      intervalS: boatTiming.intervalS,
      latencyS: boatTiming.latencyS,
      baseUrl,
      model,
      ...(temperature !== null ? { temperature } : {}),
      onCall: boatOnCall(boatId),
    });
    // 相討ちで消えた艇は判断しない＝推論を焚かない（headless 側と同じ扱い）
    const decide = async (picture) => (picture?.dead ? null : llmDecide(picture));
    decide.stats = llmDecide.stats;
    return {
      faction,
      side: 'llm',
      timing: boatTiming,
      kind: 'boat',
      buildPicture: () => {
        const bi = world.state.indexOf(boatId);
        if (bi < 0 || !world.state.alive[bi]) return { boatId, dead: true };
        return buildBoatPicture(world, boatId, { episode: env.logger.currentEpisode });
      },
      decide,
    };
  }

  // ?boats=llm で艇に判断を持たせる。既定（無指定）は従来どおり艇は追従制御だけの機械。
  const boatsMode = params.get('boats') ?? 'scripted';
  const boatAgents = new Map();
  if (boatsMode === 'llm') {
    if (!model) {
      console.warn('swarm-sim: ?boats=llm には ?model= が必要です。艇の判断は無効のまま継続します');
      appendSystemEntry({ text: '?boats=llm には ?model= が必要です。艇は追従制御のみで継続します', tone: 'warn' });
    } else {
      for (let i = 0; i < world.state.count; i++) {
        boatAgents.set(world.state.id[i], makeBoatAgent(world.state.id[i], world.state.faction[i]));
      }
    }
  } else if (boatsMode !== 'scripted') {
    console.warn(`swarm-sim: 未知の艇指定 "${boatsMode}" のため艇の判断は無効のまま継続します`);
  }

  /** 指揮官と艇を同じ台帳に載せる。以降のループは両者を区別しない */
  const deciders = new Map([...commanders, ...boatAgents]);
  const scheduler = new DecisionScheduler();
  for (const [id, decider] of deciders) scheduler.register(id, decider.timing);

  const usesLlm = [...deciders.values()].some((c) => c.side === 'llm');
  function sideLabel(id) {
    const side = commanders.get(id).side;
    return side === 'llm' ? `llm(${model})` : side;
  }
  const boatsLabel = boatAgents.size > 0 ? ` boats=llm×${boatAgents.size}` : '';
  const modeText = `blue=${sideLabel('blue-commander')} red=${sideLabel('red-commander')}${boatsLabel}`;

  // --- 描画まわり ---
  const canvas = document.getElementById('map-canvas');
  const ctx = canvas.getContext('2d');
  const commsPulses = new CommsPulses();

  wireDownloadButton(() => env.logger.toJsonl());

  function resizeCanvas() {
    canvas.width = canvas.clientWidth;
    canvas.height = canvas.clientHeight;
  }
  resizeCanvas();
  window.addEventListener('resize', resizeCanvas);

  /** ログのエピソードヘッダに残すメタデータ（headless と同じ項目にして突き合わせられるようにする） */
  function episodeMeta(episodeIndex) {
    return {
      scenario: scenario.name,
      episodeIndex,
      blue: commanders.get('blue-commander').side,
      red: commanders.get('red-commander').side,
      model: usesLlm ? model : null,
      commandIntervalS: timing.intervalS,
      commandLatencyS: timing.latencyS,
    };
  }

  // エピソード番号は env.logger.currentEpisode（EpisodeLogger.startEpisode() が発番）を単一の情報源とし、
  // ここでは重複カウンタを持たない。episodeIndex は RNG の種ではなく reset() 呼び出し回数の記録用メタデータ。
  let observation = env.reset(episodeMeta(1));
  scheduler.reset();
  const tally = { defended: 0, breached: 0, timeout: 0 };

  let accumulatorS = 0;
  let lastFrameMs = performance.now();
  /** @type {{outcome:string, untilMs:number}|null} エピソード終了バナーの表示状態 */
  let banner = null;
  /** @type {{ids:string[], atT:number, startedMs:number}|null} 推論待ちで停止している状態 */
  let stall = null;
  /** @type {{text:string, untilMs:number}|null} 直近の不成立を HUD に出しておく状態 */
  let missNotice = null;
  /** @type {Map<string, number>} "from->to:type" -> 最後にログへ書いたシム時刻（通信ログの間引き用） */
  const lastCommLogT = new Map();

  appendSystemEntry({
    text:
      `指揮官: ${modeText} / interval=${timing.intervalS}s latency=${timing.latencyS}s ` +
      `deadline=${timing.deadlineS === Infinity ? 'inf' : `${timing.deadlineS}s`} onMiss=${timing.onMiss}`,
  });
  if (usesLlm) {
    appendSystemEntry({
      text: '初回の推論はモデルのロードで数秒〜10秒かかります（実測 8.7s）。その間シムは停止し「推論待ち」と表示されます',
      tone: 'warn',
    });
  }
  // 艦種が複数混在するシナリオでは、地図上の形の違い（agent_view.js）の読み方を最初に1行出しておく。
  // この俯瞰図は神の視点で艦種を隠さない一方、レーダー越しの視界（radar.js）は艦種を返さない――
  // 両者が同じ「点」に見えて混同されないよう、ここで明示する。
  if (new Set(scenario.spawns.map((s) => s.shipClass ?? 'runner')).size > 1) {
    appendSystemEntry({
      text: '艦種: ▲小=快速(爆破半径50m) ◇枠のみ=索敵(非武装・爆破半径0) ▲大+点線の輪=重装(爆破半径100m)。輪は爆破半径そのもの（対艦・対旗判定と同じ数値。索敵艇は非武装なので輪が無い）。艦種はこの俯瞰図だけの表示で、レーダー越しの視界には出ない',
      tone: 'muted',
    });
  }

  /** 1. 発効（§8-1）。適用してから発行するので、同ステップの統合図は最新の指示を映す */
  function applyDueOrders(t) {
    for (const id of scheduler.dueToApply(t)) {
      const decider = deciders.get(id);
      const decision = scheduler.takeResult(id);
      if (decision?.orders?.length > 0) {
        const { applied, ignored } = applyOrders(world, decider.faction, decision.orders);
        appendOrdersEntry({ t, commander: id, count: applied, ignored, intent: decision.intent });
        // 艇の上書きが指揮官の指示を塗り替えた瞬間を名指しで残す。調停規則は置いていないので
        // （後から発効したほうが勝つ）、どちらが最後に書いたかはログでしか追えない。
        if (decider.kind === 'boat' && applied > 0) overrideTally.total += 1;
      } else if (decider.kind === 'boat') {
        // 艇の null は「指揮官の指示に従う」＝正常な判断であり、失敗ではない。
        // 指揮官の null（＝推論の失敗）と同じ調子で警告を出すと、両者の区別が付かなくなる。
        continue;
      } else {
        // decision が null ＝ 推論の失敗（llm_commander は失敗を null で表す）。
        // 新しい指示は無く、艇は現指示のまま動き続ける＝画面上は何も起きないので、行だけ残す。
        appendSystemEntry({ t, text: `ORDERS ${id}: 現指示を維持（有効な指示なし）`, tone: 'warn' });
      }
    }
  }

  /** 2. 不成立（§12.5）。既定 deadlineS=∞ では常に空。有限の締切ではシムが止まらずここへ出る */
  function settleMisses(t, nowMs) {
    for (const entry of scheduler.missedAt(t)) {
      const miss = scheduler.takeMissed(entry.id) ?? entry;
      const decider = deciders.get(entry.id);
      if (miss.onMiss === 'default-order') applyDefaultOrders(world, { faction: decider.faction });
      appendMissEntry({ t, commander: entry.id, reason: miss.reason, onMiss: miss.onMiss });
      missNotice = { text: `不成立 ${entry.id} (${miss.reason})`, untilMs: nowMs + MISS_NOTICE_MS };
    }
  }

  /**
   * 3. 発行（§8-2）。ブラウザは fire-and-forget（§9）。結果は resolve 時にスケジューラへ入る。
   * トークンを .then() のクロージャが持つので、エピソードを跨いだ結果・前サイクルの結果は
   * provideResult 側で捨てられる（§12）。
   */
  function fireDueInferences(t) {
    for (const id of scheduler.dueToIssue(t)) {
      const decider = deciders.get(id);
      // 死んだ艇には判断させない（撃破後も推論を投げ続けると、動かない艇のために
      // シムが「推論待ち」で止まる）。指揮官は艇ではないので常に生きている。
      if (decider.kind === 'boat') {
        const i = world.state.indexOf(id);
        if (i < 0 || !world.state.alive[i]) {
          scheduler.provideResult(id, null, scheduler.markIssued(id, t));
          continue;
        }
      }
      // 観測スナップショットは発行時刻のもの。ここから先、世界が進んでもこの図は更新しない（I3）
      const picture = decider.buildPicture(t);
      const token = scheduler.markIssued(id, t);
      Promise.resolve(decider.decide(picture)).then(
        (decision) => scheduler.provideResult(id, decision, token),
        (err) => {
          // 失敗しても必ず結果を返す。返さないと pending が解消されず、
          // deadlineS=∞ の既定ではシムが永久に「推論待ち」で止まる。
          console.error(`swarm-sim: ${id} の decide が失敗しました`, err);
          appendSystemEntry({ text: `${id} の推論が例外で失敗: ${err?.message ?? err}（現指示を維持）`, tone: 'error' });
          scheduler.provideResult(id, null, token); // null = 現指示維持
        }
      );
    }
  }

  /**
   * 1ステップ進める。blockedAt が非空なら物理を進めずに false を返す（＝推論待ちで停止）。
   * @param {number} nowMs - このフレームの実時刻（停止時間の計測・通知の期限に使うだけで、シムには入らない）
   * @returns {boolean} 物理を進めたら true
   */
  function simulateOneStep(nowMs) {
    const t = world.clock;
    applyDueOrders(t);
    settleMisses(t, nowMs);
    fireDueInferences(t);

    const blocked = scheduler.blockedAt(t);
    if (blocked.length > 0) {
      if (!stall) {
        stall = { ids: blocked, atT: t, startedMs: nowMs };
        appendSystemEntry({ t, text: `推論待ちでシムを停止: ${blocked.join(', ')}`, tone: 'warn' });
      } else {
        stall.ids = blocked; // 片方が先に届けば表示も減る
      }
      return false;
    }
    if (stall) {
      appendSystemEntry({ t, text: `推論が到着、再開（${((nowMs - stall.startedMs) / 1000).toFixed(1)}s 停止）` });
      stall = null;
    }

    const result = env.step(computeBoatActions(world, observation));
    observation = result.observation;

    for (const ev of env.lastCommsEvents) {
      const key = `${ev.from}->${ev.to}:${ev.type}`;
      const last = lastCommLogT.get(key);
      if (last !== undefined && world.clock - last < COMM_LOG_MIN_INTERVAL_S) continue;
      lastCommLogT.set(key, world.clock);
      appendCommsEntry({ t: world.clock, ...ev });
    }
    commsPulses.addEvents(env.lastCommsEvents);
    for (const ev of result.info.events) appendMissionEntry(ev);

    if (result.done) {
      tally[result.info.outcome] = (tally[result.info.outcome] ?? 0) + 1;
      banner = { outcome: result.info.outcome, untilMs: nowMs + BANNER_DURATION_MS };
    }
    return true;
  }

  function startNextEpisode() {
    banner = null;
    stall = null;
    missNotice = null;
    accumulatorS = 0;
    lastCommLogT.clear(); // シム時刻が0へ戻るので、前エピソードの時刻と比べない
    observation = env.reset(episodeMeta(env.logger.currentEpisode + 1));
    // 世代が進み、前エピソードで in-flight のまま残った推論結果は二度と書き込めなくなる（§12）
    scheduler.reset();
  }

  /** HUD の実行状態。シム時刻が止まったとき、それが仕様なのか異常なのかをここで名指しする */
  function hudStatus(nowMs) {
    if (stall) return { state: 'waiting', text: `推論待ち ${((nowMs - stall.startedMs) / 1000).toFixed(1)}s` };
    if (missNotice && nowMs < missNotice.untilMs) return { state: 'missed', text: missNotice.text };
    if (banner) return { state: 'running', text: 'エピソード終了' };
    return { state: 'running', text: '進行中' };
  }

  function render(nowMs) {
    const project = createProjection(canvas, scene);

    drawMap(ctx, canvas, scene, project);
    drawProtectedAsset(ctx, canvas, scene, project, world.protectedAsset);
    drawOrders(ctx, world, project);

    const entities = world.state.snapshot();
    const entityById = new Map(entities.map((e) => [e.id, e]));
    drawAgents(ctx, entities, project);
    commsPulses.draw(ctx, entityById, project);

    updateHud({
      episode: env.logger.currentEpisode,
      clock: world.clock,
      tally,
      mode: modeText,
      status: hudStatus(nowMs),
    });
    if (stall) showWaiting({ deciders: stall.ids, elapsedS: (nowMs - stall.startedMs) / 1000, clock: world.clock });
    else hideWaiting();
    if (banner) showOutcomeBanner(banner.outcome);
    else hideOutcomeBanner();
  }

  function tick(nowMs) {
    const rawDt = Math.min((nowMs - lastFrameMs) / 1000, MAX_FRAME_DT_S);
    lastFrameMs = nowMs;
    commsPulses.update(rawDt);

    if (banner) {
      // 結果バナー表示中はstep()を呼ばず、wall timeの経過だけで次エピソードへ遷移する
      if (nowMs >= banner.untilMs) startNextEpisode();
    } else {
      accumulatorS += rawDt * TIME_SCALE;
      while (accumulatorS >= env.dt) {
        if (!simulateOneStep(nowMs)) {
          // 推論待ち: 溜まった時間は捨てる。残しておくと結果が届いた瞬間に待った分をまとめて
          // 消化して早送りになり、latencyS で表現している「指示が効くまでの間」が見えなくなる。
          accumulatorS = 0;
          break;
        }
        accumulatorS -= env.dt;
        if (banner) {
          accumulatorS = 0; // 次エピソード開始時に古い蓄積時間が一気に消化されないようにする
          break;
        }
      }
    }

    render(nowMs);
    requestAnimationFrame(tick);
  }

  requestAnimationFrame(tick);
}

main().catch((err) => {
  console.error(err);
  const pre = document.createElement('pre');
  pre.style.cssText =
    'position:absolute;top:0;left:0;background:#200;color:#e0708e;padding:8px;max-width:90%;white-space:pre-wrap;z-index:9;';
  pre.textContent = String(err?.stack ?? err);
  document.body.appendChild(pre);
});
