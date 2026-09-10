/**
 * nav_mode.js — 3D海域デジタルツインの上で1隻をVLMに自動航行させる（View側の駆動部）
 *
 * `digital-twin/?nav=vlm` で有効になる。既定（?nav= 無指定）では読み込まれても何もせず、
 * ページは従来どおりサーバー不要の静的サイトとして動く（CLAUDE.md の構成方針）。
 *
 * 【このファイルの責務は「駆動」だけ】
 * 状況図の作り方・プロンプト・パース・サニタイズ・プランの持ち方は全て core/sim/navigator/ にあり、
 * ここには1行も無い。同じコアを scripts/vlm_navigator_run.js（ヘッドレス実験ランナー）も使うので、
 * 「画面で見えているもの」と「実験ログの数字」が同じコードから出ることが保証される。
 *
 * 【1ステップの順序は time-model.md §8 のとおり】swarm-sim/main.js と同一:
 *   1. dueToApply → takeResult → プラン差し替え（発効。適用してから発行する）
 *   2. missedAt → takeMissed（不成立。既定 deadlineS=∞ では起きない）
 *   3. dueToIssue → **撮影** → markIssued → fire-and-forget 推論 → provideResult
 *   4. blockedAt が非空ならシムを止める（＝「推論待ち」。ブラウザは待つ側。§9）
 *   5. applyPlanOrder（プラン→指示）→ BoatController → AsvPlatform（毎ステップ）
 *
 * 【時間モデル】register に `stages: [{name:'render'}, {name:'infer'}]` を宣言する。
 * これが複数ステージ宣言の最初の実使用者で、発効は t_issue + renderS + inferS になる。
 * 宣言値はルール側の設定値であり、HUD に出る実測 ms（t_wall）は**記録**でしかない。
 * 実測を宣言値へ書き戻す口はどこにも無い（time-model.md §2.5 I1）。
 */

import { DecisionScheduler } from '../core/sim/command/decision_scheduler.js';
import { buildNavigatorPicture, DEFAULT_ARRIVAL_RADIUS_M } from '../core/sim/navigator/navigator_picture.js';
import { TrackStore } from '../core/sim/navigator/fuse_tracks.js';
import { RoutePlan, applyPlanOrder } from '../core/sim/navigator/plan_follower.js';
import { createVlmNavigatorFn, scriptedNavigator } from '../core/sim/navigator/vlm_navigator.js';

/** 物理ステップ。headless_run.js / vlm_navigator_run.js と同じ 0.1 s */
export const DT_S = 0.1;

/**
 * 既定値。時間の宣言値は 2026-08-30 の実測から選んである
 * （撮影 p50 84〜115 ms、推論 p50 1.78 s / max 2.91 s）。実測そのものではなく、
 * 実測を見て人間が選んだ設定値である点が要（time-model.md §2.5）。
 */
export const NAV_DEFAULTS = Object.freeze({
  intervalS: 10,
  renderS: 0.1,
  inferS: 2.0,
  arrivalM: DEFAULT_ARRIVAL_RADIUS_M,
  resW: 640,
  resH: 360,
  /** 同一オリジンのプロキシ。scripts/serve_vlm.js が /vlm/v1 を推論サーバへ中継する
   *  （ブラウザから Ollama を直接叩くと CORS 設定に依存する。推論URLをページに埋めない方針とも整合） */
  baseUrl: '/vlm/v1',
  /**
   * 既定モデル。**非thinking の VLM を選ぶこと。** thinking 系（qwen3-vl:8b 等）は
   * 画像1枚の判断で reasoning に 1,100〜1,600 文字を費やし、maxTokens を 1,400 まで上げても
   * 本文が空のまま返る（kind='thinking_overrun'）。Ollama 0.33.2 では think:false を送っても
   * このモデルのテンプレートでは thinking が止まらないことを実測した（2026-09-05）。
   *
   * **num_ctx を絞った派生モデルを既定にしている。** Ollama は num_ctx で宣言した長さの
   * KV キャッシュを先に丸ごと確保するので、素の `qwen2.5vl:7b`（num_ctx=128,000）は
   * 重み約6GBに対して **85.9GB** の VRAM を占有する（2026-09-06 実測）。
   * このビュアーの実測プロンプトは 1,520 tok（テキスト486＋画像1,034）で、応答400を足して
   * 1,920 tok——`num_ctx=3072` で足りる。派生モデルは
   *   node scripts/suggest_num_ctx.js --model qwen2.5vl:7b --system-file ... --image ... --create <名前>
   * で作る（`prompt_eval_count` の実測から決める。推定ではない）。
   * 共有マシンの取り決めは /tmp/GPU-USAGE-CONVENTION.md。
   */
  model: 'qwen2.5vl-7b-ctx3k',
  maxTokens: 400,
  timeoutMs: 60000,
  /** 表示の早送り倍率。1 なら実時間1秒＝シム1秒 */
  timeScale: 1,
});

const ARMS = ['vlm', 'vlm-watch', 'blind', 'scripted'];

/**
 * URL クエリから航行モードの設定を読む。`?nav=` が無ければ null（＝従来どおりの表示のみ）。
 *
 * ?nav=vlm|vlm-watch|blind|scripted
 *                           アーム。vlm-watch は VLM に機動だけ選ばせ waypoint はコードが生成（H2）。
 *                           blind は同じプロンプトで画像だけ無し（統制群）
 * ?model=NAME              モデル名
 * ?vlmurl=URL              推論サーバ（既定 /vlm/v1 ＝同一オリジンのプロキシ）
 * ?transport=openai|ollama 推論サーバへの経路。既定 openai。thinking 系VLM（qwen3-vl 等）で
 *                          thinking を切るには ollama が要る（Ollama は OpenAI互換の
 *                          enable_thinking を無視することを実測済み）。この場合 ?vlmurl=/vlm
 * ?thinking=auto|on|off    既定 auto
 * ?interval=S ?render=S ?infer=S   時間の宣言値（シム秒）
 * ?res=640x360 ?arrival=M ?speed=N ?dest=east,north
 * ?cam=chase|north|orbit    俯瞰カメラ。既定 chase（**進行方向と同じ向きの第三者視点**）。
 *                           north は方位をワールドに固定、orbit は従来のデモ表示（回り続ける）
 * ?plan3d=1|0               3Dシーン上への waypoint 表示。既定 1
 */
export function parseNavOptions(params) {
  const arm = params.get('nav');
  if (!arm) return null;
  if (!ARMS.includes(arm)) {
    throw new Error(`?nav= は ${ARMS.join('|')} のいずれか（got "${arm}"）`);
  }
  const num = (key, fallback) => {
    const raw = params.get(key);
    if (raw === null) return fallback;
    const v = Number(raw);
    if (!Number.isFinite(v) || v <= 0) throw new Error(`?${key}= は正の数（got "${raw}"）`);
    return v;
  };
  let resW = NAV_DEFAULTS.resW;
  let resH = NAV_DEFAULTS.resH;
  const res = params.get('res');
  if (res) {
    const m = /^(\d+)x(\d+)$/.exec(res);
    if (!m) throw new Error(`?res= の形式は 640x360（got "${res}"）`);
    resW = Number(m[1]);
    resH = Number(m[2]);
  }
  let destination = null;
  const dest = params.get('dest');
  if (dest) {
    const parts = dest.split(',').map(Number);
    if (parts.length !== 2 || !parts.every(Number.isFinite)) {
      throw new Error(`?dest= の形式は east,north（メートル。got "${dest}"）`);
    }
    destination = { eastM: parts[0], northM: parts[1] };
  }
  const transport = params.get('transport') ?? 'openai';
  if (!['openai', 'ollama'].includes(transport)) throw new Error(`?transport= は openai|ollama（got "${transport}"）`);
  const thinking = params.get('thinking') ?? 'auto';
  if (!['auto', 'on', 'off'].includes(thinking)) throw new Error(`?thinking= は auto|on|off（got "${thinking}"）`);
  const cam = params.get('cam') ?? 'chase';
  if (!['chase', 'north', 'orbit'].includes(cam)) throw new Error(`?cam= は chase|north|orbit（got "${cam}"）`);
  return {
    arm,
    cameraMode: cam,
    plan3d: params.get('plan3d') !== '0',
    model: params.get('model') ?? NAV_DEFAULTS.model,
    baseUrl: params.get('vlmurl') ?? (transport === 'ollama' ? '/vlm' : NAV_DEFAULTS.baseUrl),
    transport,
    thinking,
    intervalS: num('interval', NAV_DEFAULTS.intervalS),
    renderS: num('render', NAV_DEFAULTS.renderS),
    inferS: num('infer', NAV_DEFAULTS.inferS),
    arrivalM: num('arrival', NAV_DEFAULTS.arrivalM),
    timeScale: num('speed', NAV_DEFAULTS.timeScale),
    maxTokens: num('maxtokens', NAV_DEFAULTS.maxTokens),
    timeoutMs: num('timeout', NAV_DEFAULTS.timeoutMs),
    resW,
    resH,
    destination,
  };
}

/**
 * 航行モードを組み立てる。ここから返るオブジェクトを main.js のループが回す。
 *
 * @param {{world:object, three:object, cameraSensor:object, boatId:string,
 *   destination:{eastM:number,northM:number}, options:ReturnType<typeof parseNavOptions>}} config
 */
export function createNavigatorMode({
  world,
  three,
  cameraSensor,
  boatId,
  destination,
  options,
  traffic = null,
  overlay = null,
}) {
  const { arm, intervalS, renderS, inferS, arrivalM } = options;
  const withImage = arm === 'vlm' || arm === 'vlm-watch';
  const latencyS = renderS + inferS;

  const plan = new RoutePlan({ destination, arrivalM });
  // 接触の表示名を匿名化する。シナリオの id（例 traffic-cross）をそのまま見せると、
  // モデルが名前を読むだけで正解できてしまい測定が無意味になる（H0）
  const trackStore = new TrackStore();
  const scheduler = new DecisionScheduler();
  // 複数ステージ宣言の最初の実使用者。latencyS は併記しない（併記は設定ミスとして落ちる仕様）
  scheduler.register(boatId, {
    intervalS,
    stages: [
      { name: 'render', seconds: renderS },
      { name: 'infer', seconds: inferS },
    ],
  });

  const records = [];
  const MAX_RECORDS = 60;
  /**
   * 航跡。1シム秒に1点だけ間引いて持つ（毎ステップ持つと 240s のエピソードで 2,400 点になり、
   * 毎フレームの描画で無駄に効く）。**表示のためだけの記録**で、シムのルールには一切入らない。
   */
  const trail = [];
  const TRAIL_SAMPLE_S = 1;
  const TRAIL_MAX_POINTS = 600;
  let nextTrailAtT = 0;
  const decide =
    arm === 'scripted'
      ? scriptedNavigator({ boatId })
      : createVlmNavigatorFn({
          boatId,
          intervalS,
          latencyS,
          baseUrl: options.baseUrl,
          model: options.model,
          maxTokens: options.maxTokens,
          timeoutMs: options.timeoutMs,
          transport: options.transport,
          thinking: options.thinking,
          mode: arm === 'vlm-watch' ? 'watch' : 'plan',
          onCall: (record) => {
            records.push(record);
            if (records.length > MAX_RECORDS) records.shift();
          },
        });

  // 撮影は固定解像度で。表示canvasの大きさが画像トークン数に混ざらないようにする
  if (withImage) cameraSensor.captureSize = { w: options.resW, h: options.resH };

  const status = {
    arm,
    model: arm === 'scripted' ? null : options.model,
    /** 'idle' | 'running' | 'waiting' | 'arrived' */
    state: 'running',
    /** 直近の判断（HUD 表示用） */
    lastDecision: null,
    /** 直近に VLM へ送った画像（HUD にそのまま出す。「何を見せたか」が見えないと誤判断を追えない） */
    lastImage: null,
    lastRenderMs: null,
    stalledSinceMs: null,
    arrivedAtT: null,
    warmup: arm === 'scripted' ? 'skipped' : 'pending',
    error: null,
    /** モデルが宣言している num_ctx（サーバから読む。コード側に二重に書かない） */
    numCtx: null,
    /** 交通船との現在の距離と、エピソード中の最小値（M3 の主指標「最接近距離」） */
    trafficCount: traffic ? traffic.count : 0,
    nearestTrafficM: null,
    minTrafficM: null,
  };

  /** 撮影1枚。ここだけが View に依存する処理で、返すのは data URL という純データ */
  function capture() {
    if (!withImage) return null;
    const t0 = performance.now();
    const cam = world.observe(boatId, 'camera');
    status.lastRenderMs = Math.round(performance.now() - t0);
    return cam?.imageDataUrl ?? null;
  }

  /** 1. 発効 — 届いた判断をプランへ適用する */
  function applyDue(t) {
    for (const id of scheduler.dueToApply(t)) {
      const decision = scheduler.takeResult(id);
      if (!decision) continue;
      status.lastDecision = { ...decision, appliedAtT: t };
      if (decision.action === 'replace' && decision.waypoints) {
        plan.setWaypoints(decision.waypoints);
      }
    }
  }

  /** 2. 不成立 — 既定 deadlineS=∞ では起きない。起きたらプランは現状維持のまま記録だけ残す */
  function settleMisses(t) {
    for (const entry of scheduler.missedAt(t)) {
      const miss = scheduler.takeMissed(entry.id) ?? entry;
      status.lastDecision = { action: 'miss', outcome: miss.reason, t };
    }
  }

  /** 3. 発行 — 撮って投げる。ブラウザは fire-and-forget（結果は resolve 時にスケジューラへ入る） */
  function fireDue(t) {
    for (const id of scheduler.dueToIssue(t)) {
      const image = capture();
      status.lastImage = image;
      // 観測スナップショットは発行時刻のもの。以後世界が進んでもこの図は更新しない（I3）
      const picture = buildNavigatorPicture(world, id, {
        destination: plan.destination,
        plan: plan.snapshot(),
        arrivalM,
        image,
        trackStore,
      });
      const token = scheduler.markIssued(id, t);
      Promise.resolve(decide(picture)).then(
        (decision) => scheduler.provideResult(id, decision, token),
        (err) => {
          // 返さないと pending が解消されず、deadlineS=∞ では永久に「推論待ち」で止まる
          console.error('nav: decide が例外で失敗しました', err);
          status.error = String(err?.message ?? err);
          scheduler.provideResult(id, null, token);
        }
      );
    }
  }

  /**
   * シムを1ステップ（DT_S）進める。
   * @param {number} nowMs 実時刻。停止時間の表示にしか使わない（シムには入らない）
   * @returns {boolean} 進めたら true、推論待ちで止めたら false
   */
  function stepOnce(nowMs) {
    const t = world.clock;
    applyDue(t);
    settleMisses(t);
    fireDue(t);

    const blocked = scheduler.blockedAt(t);
    if (blocked.length > 0) {
      if (status.stalledSinceMs === null) status.stalledSinceMs = nowMs;
      status.state = 'waiting';
      return false;
    }
    status.stalledSinceMs = null;

    const applied = applyPlanOrder(world, boatId, plan);
    if (t + 1e-6 >= nextTrailAtT) {
      const i = world.state.indexOf(boatId);
      if (i >= 0) trail.push({ t, eastM: world.state.x[i], northM: world.state.y[i] });
      if (trail.length > TRAIL_MAX_POINTS) trail.shift();
      nextTrailAtT = t + TRAIL_SAMPLE_S;
    }
    if (applied.arrived) {
      if (status.arrivedAtT === null) status.arrivedAtT = t;
      status.state = 'arrived';
      return false; // 着いたら止める。以降は表示だけが続く
    }
    status.state = 'running';

    // 自艇だけを追従制御＋運動学で動かす。交通船は spline 上を進めるので運動学を解かない
    // （traffic.js: 障害物の動きを決定論に保ち、観察対象を自艇の判断だけに絞るため）。
    const trafficIds = traffic ? new Set(traffic.specs.map((sp) => sp.id)) : null;
    for (let i = 0; i < world.state.count; i++) {
      if (!world.state.alive[i]) continue;
      const id = world.state.id[i];
      if (trafficIds?.has(id)) continue;
      const platform = world.platformInstances.get(id);
      let action;
      if (id === boatId) {
        const observation = {
          radar: world.observe(id, 'radar'),
          position: {
            x: world.state.x[i],
            y: world.state.y[i],
            heading: world.state.heading[i],
            speed: world.state.speed[i],
          },
          timestamp: world.clock,
        };
        action = world.boatController.decide(world.orders.get(id), observation, id, world.state.faction[i]);
      } else {
        action = { throttle: 0.3, steering: 0.04 }; // traffic 以外の随伴艇は従来どおり
      }
      platform.step(world.state, i, action, DT_S, world.environment, world.clock);
    }
    if (traffic) {
      traffic.step(world, DT_S);
      const nearest = traffic.nearestTo(world, boatId);
      status.nearestTrafficM = nearest ? nearest.rangeM : null;
      if (nearest && (status.minTrafficM === null || nearest.rangeM < status.minTrafficM)) {
        status.minTrafficM = nearest.rangeM;
      }
    }
    world.clock += DT_S;
    return true;
  }

  /** コールドスタート（実測20s超）をエピソードの外へ追い出す。失敗しても航行は始める */
  async function warmUp() {
    if (arm === 'scripted') return;
    // モデルが宣言している num_ctx を先に読む。以後の判断で「入力が切り捨てられたか」を
    // 実測 prompt_tokens と突き合わせて判定できるようになる（docs/multi-vlm-gpu-budget.md §2.4）
    try {
      const { fetchDeclaredNumCtx } = await import('../core/sim/agents/context_budget.js');
      status.numCtx = await fetchDeclaredNumCtx({ baseUrl: options.baseUrl, model: options.model });
      if (decide.setNumCtx) decide.setNumCtx(status.numCtx);
    } catch {
      /* 読めなくても航行は始める。判定が付かないだけ */
    }
    try {
      const { postChatCompletion } = await import('../core/sim/agents/llm_http.js');
      await postChatCompletion({
        baseUrl: options.baseUrl,
        model: options.model,
        maxTokens: 64,
        timeoutMs: options.timeoutMs,
        transport: options.transport,
        thinking: options.thinking,
        systemPrompt: 'reply with JSON only',
        userPrompt: 'warmup. reply {"watch":"none","action":"keep","waypoints":[],"speed":"cruise"}',
      });
      status.warmup = 'ok';
    } catch (err) {
      status.warmup = 'failed';
      status.error = String(err?.message ?? err);
    }
  }

  return {
    boatId,
    options,
    plan,
    scheduler,
    status,
    records,
    stats: decide.stats,
    systemPrompt: decide.systemPrompt,
    stepOnce,
    warmUp,
    /**
     * 3Dシーン上の waypoint 表示を更新する。毎フレーム呼ぶ（描画側の都合なのでシムには入らない）。
     * オーバーレイは俯瞰カメラ専用レイヤーに居るので、VLM へ渡る画像には写らない。
     */
    updateOverlay() {
      if (!overlay) return;
      overlay.update({
        selfPose: this.pose(),
        waypoints: plan.snapshot(),
        destination: plan.destination,
        arrivalM,
        trail,
        trafficPaths: traffic ? traffic.polylines() : null,
      });
    },
    /** 航跡の複製（表示用） */
    trail() {
      return trail.map((p) => ({ t: p.t, eastM: p.eastM, northM: p.northM }));
    },
    /** 目的地の差し替え（ページ上のクリックで使う。「外部から大まかに与えられた目的地」の実体） */
    setDestination(next) {
      plan.destination = { eastM: next.eastM, northM: next.northM };
      plan.setWaypoints([plan.destination]); // 新しい目的地への直行から引き直す
      status.arrivedAtT = null;
      status.state = 'running';
      // 航跡は消さない。「どこから来て目的地が変わったか」が読めなくなる
    },
    /** 自船の現在地（HUD・目的地マーカーの描画用） */
    pose() {
      const i = world.state.indexOf(boatId);
      if (i < 0) return null;
      return { eastM: world.state.x[i], northM: world.state.y[i], headingDeg: (world.state.heading[i] * 180) / Math.PI };
    },
  };
}
