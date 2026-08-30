/**
 * decision_scheduler.js — 意思決定ライフサイクル（時間モデル）の実装
 *
 * LLM が絡む判断はシム時間上で瞬時ではない。各 decider（今は指揮官2体、
 * Phase 2 では各艇も）について
 *   t_issue: 観測スナップショット・推論発行
 *   t_apply = t_issue + latencyS: 出力が世界に効き始める
 * を管理する。latencyS は実測値ではなく設定値（決定論・ハードウェア非依存）。
 * 設計の正典は docs/time-model.md v2.0（§4 ライフサイクル・§8 処理順序・
 * §10 状態と操作・§12 エピソード跨ぎのリスク・§12.5 パイプライン/締切/発行トークン）。
 *
 * 推論の「実行」はここではしない。呼び出し側（headless / ブラウザ）が
 * dueToIssue() で発行対象を取り、結果を provideResult() で返し、
 * dueToApply() で発効時刻に達した結果を takeResult() で取り出して適用する。
 * headless は発行を await する（t_issue〜t_apply の物理は現行指示のみで決まり
 * 推論結果に依存しないため、待ってから進めても決定論が保たれる）。
 * ブラウザは fire-and-forget し、blockedAt() が真ならシムを止めて「推論待ち」にする。
 *
 * 呼び出し側の1ステップの順序（§8＋v2 の不成立処理。この順序が前提）:
 *   dueToApply → takeResult ／ missedAt → takeMissed（onMiss 適用＋ログ）
 *   → dueToIssue → markIssued ／ blockedAt の判定 → 艇の追従制御 → env.step
 * blockedAt() は不成立の decider を最初から外すので、順序を誤ってもシムが
 * 永久に止まることはない。
 *
 * 状態と責務の境界:
 *   - 本モジュールが持つのは deciders（登録内容＋pending）と generation だけ。
 *     World も陣営も orders も知らない（decider id → 陣営の対応は呼び出し側が持つ）。
 *     Phase 2 の艇 LLM は register(boatId, {...}) を足すだけで乗る（§13）。
 *   - エピソード開始時の reset() は呼び出し側が env.reset() の隣で明示的に呼ぶ。
 *     World.resetEntities() / EnvApi.reset() はスケジューラに触れない。
 *   - 実時間（t_wall）はここに一切登場しない。実時刻 API も擬似乱数 API も呼ばず、
 *     実測値をルール側の変数へ書き戻す口も設けない（§2.5 I1・§12.5 I4、roadmap D-3）。
 *     ステージ別の実測ログは実行器（Task 8/9）が decider id ＋発行トークン＋ステージ名で残す。
 *
 * v2.0 差分（roadmap §4）:
 *   D-1 発行トークン: markIssued が {generation, seq} を返し、provideResult は一致時のみ書き込む。
 *   D-2 register の拡張: ステージ宣言・deadlineS・onMiss・latencyModel・missArbiter。
 *       既定値のままなら挙動は v1.1（L0 の計画）と完全に同一で、差分は発行トークンだけ。
 *
 * 不成立（miss）の判定は2経路ある。毛色が違うので、ここで役割を固定しておく。
 *   1. 発行時に確定する不成立（model モード＝ルール側で決まる決定論的な判定。§12.5）
 *      markIssued で引いた drawn が deadlineS を超えていれば、その判断は発行の瞬間に
 *      不成立が確定する（§12.5「この判断はタイムアウトする」という事実さえ、実行前から確定している）。
 *      t_issue+deadlineS で missedAt() に現れ、結果が手元に届いても捨てる
 *      （provideResult が受け取らず、dueToApply には決して現れない）。設定値とシードだけで
 *      決まるのでハードウェア非依存＝実験データの決定論はこの経路だけで保たれる。
 *   2. 締切までに結果が届かなかった不成立（到着依存。§9「待ち続けることをやめる」）
 *      drawn <= deadlineS でも、実行器が t_issue+deadlineS までに provideResult を呼べなければ
 *      不成立にする。判定材料が「実物が届いたか」である以上マシン速度に依存する＝
 *      §12.5 I4 を意図的に破る例外であり、missArbiter:'wallclock' と同じ毛色のものである。
 *      headless は発行を await してから物理を進めるので、この経路には原理的に入れない
 *      （＝実験は経路1だけで動き、決定論のまま）。効くのはブラウザデモだけ。同じ理由で、
 *      有限の締切のもとで t_apply を過ぎてから届いた結果は、ブラウザでは「届いた刻み」で
 *      発効する（シムを止めて待たないため。headless では起こらない）。
 *      missedAt() が返す項目に reason:'unarrived' / deterministic:false を立てるので、
 *      実行器はログへ非決定論の刻印を残し、実験データから機械的に弾ける。
 * missArbiter は保持するだけで挙動を分岐させない。'wallclock' の本来の実装（表示時間換算での
 * 判定・シムを止めない）はシムの外側（実行器）の責務であり、ここでは設定値を保持して
 * missedAt() の項目で呼び出し側へ伝えるに留める。
 *
 * pending 中は再発行しない（1 decider につき同時1推論＝§12.5 I2）。したがって
 * 実効的な発行間隔は max(intervalS, 発効までの待ち) になる（§11 の安全弁）。
 */

/** シム時刻は 0.1 の蓄積で誤差が乗る（t=10 で約 2e-14、t=240 で約 9.4e-12）ため、時刻比較は全てこの epsilon 付きで行う */
const T_EPS = 1e-6;

/** 不成立時の艇の挙動。適用するのは呼び出し側で、スケジューラは値を伝えるだけ（§12.5） */
const ON_MISS_MODES = ['keep-current', 'default-order'];

/** 不成立の判定者。model はルール側（決定論）、wallclock はデモ専用の実時間判定（§12.5 I4） */
const MISS_ARBITERS = ['model', 'wallclock'];

/**
 * @typedef {{generation:number, seq:number}} IssueToken 発行トークン（凍結済み・値で比較する）
 * @typedef {{token:IssueToken, issuedAtT:number, drawnLatencyS:number, applyAtT:number,
 *   deadlineAtT:number, doomed:boolean, resolved:boolean, missed:boolean,
 *   missReason:null|'doomed'|'unarrived', result:any}} Pending
 * @typedef {{id:string, onMiss:string, missArbiter:string, token:IssueToken, issuedAtT:number,
 *   drawnLatencyS:number, applyAtT:number, deadlineAtT:number, resolved:boolean,
 *   reason:'doomed'|'unarrived', deterministic:boolean}} MissEntry
 */

/** ステージ宣言を1本の latencyS へ合成する（直列＝和・並列＝max・入れ子可。§12.5 パイプライン宣言） */
function composeStages(node, id) {
  if (Array.isArray(node)) {
    // 配列は直列（和）
    let sum = 0;
    for (const child of node) sum += composeStages(child, id);
    return sum;
  }
  if (node && typeof node === 'object') {
    if (Array.isArray(node.parallel)) {
      let max = 0;
      for (const child of node.parallel) max = Math.max(max, composeStages(child, id));
      return max;
    }
    if (Array.isArray(node.serial)) return composeStages(node.serial, id);
    if (Number.isFinite(node.seconds) && node.seconds >= 0) return node.seconds;
  }
  throw new TypeError(
    `DecisionScheduler.register: invalid stage declaration for "${id}" ` +
      `(expected {name, seconds>=0} / {parallel:[...]} / {serial:[...]}, got ${JSON.stringify(node)})`
  );
}

/** 文字列から 32bit のシードを作る（xmur3 相当。決定論を守るため処理系の擬似乱数は使わない） */
function hashSeed(text) {
  let h = 1779033703 ^ text.length;
  for (let i = 0; i < text.length; i++) {
    h = Math.imul(h ^ text.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  h = Math.imul(h ^ (h >>> 16), 2246822507);
  h = Math.imul(h ^ (h >>> 13), 3266489909);
  return (h ^ (h >>> 16)) >>> 0;
}

/** シードから [0,1) の値を1つだけ引く（mulberry32 の1ステップ） */
function unitDraw(seed32) {
  let t = (seed32 + 0x6d2b79f5) >>> 0;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

/** 発行1回ぶんの latency を引く。constant は宣言値そのもの（L0 はこちらだけを使う） */
function drawLatencyS(d, seq) {
  if (d.latencyModel === 'constant') return d.latencyS;
  // シードは設定値。decider id と発行連番を混ぜて、並行する decider が同じ列を共有しないようにする
  const u = unitDraw(hashSeed(`${d.latencyModel.seed}|${d.id}|${seq}`));
  return d.latencyModel.minS + (d.latencyModel.maxS - d.latencyModel.minS) * u;
}

/** latencyModel の検証。'constant' か、シード付き分布オブジェクトだけを受け付ける（§12.5） */
function validateLatencyModel(model, id) {
  if (model === 'constant') return model;
  const ok =
    model &&
    typeof model === 'object' &&
    model.kind === 'uniform' &&
    Number.isFinite(model.minS) &&
    Number.isFinite(model.maxS) &&
    model.minS >= 0 &&
    model.maxS >= model.minS &&
    (typeof model.seed === 'string' || Number.isFinite(model.seed));
  if (!ok) {
    throw new TypeError(
      `DecisionScheduler.register: latencyModel must be 'constant' or ` +
        `{kind:'uniform', minS, maxS, seed} (id="${id}", got ${JSON.stringify(model)})`
    );
  }
  return model;
}

/**
 * pending が「不成立」かを判定し、確定したら pending に焼き付ける（§12.5）。
 * 一度確定した不成立は t が進んでも元に戻らない。戻ると「t_apply に達した瞬間に不成立が
 * 発効へ化ける」ため、1ステップ遅れて呼んだ呼び出し側が、モデルが不成立と言った判断を
 * 適用してしまう。判定は2経路（モジュール冒頭）:
 *   - doomed: markIssued の時点で drawn > deadlineS が確定済み。締切時刻で無条件に不成立
 *   - それ以外: 締切時刻に「発効可能（結果到着済み＋t_apply 到達）」でなければ不成立
 * 呼び出し側の t は単調に進む前提（§8 のループ）。焼き付けた確定は、過去の t で
 * 問い合わせ直しても消えない。
 * @param {Pending|null} p
 * @param {number} t
 * @returns {boolean}
 */
function settleMiss(p, t) {
  if (!p) return false;
  if (p.missed) return true;
  if (!(t + T_EPS >= p.deadlineAtT)) return false;
  if (p.doomed || !(p.resolved && t + T_EPS >= p.applyAtT)) {
    p.missed = true;
    p.missReason = p.doomed ? 'doomed' : 'unarrived';
  }
  return p.missed;
}

/** 不成立の記述子。呼び出し側はこれだけで onMiss の適用とログ行の生成ができる */
function describeMiss(d) {
  const p = d.pending;
  const reason = p.missReason ?? (p.doomed ? 'doomed' : 'unarrived');
  return {
    id: d.id,
    onMiss: d.onMiss,
    missArbiter: d.missArbiter,
    token: p.token,
    issuedAtT: p.issuedAtT,
    drawnLatencyS: p.drawnLatencyS,
    applyAtT: p.applyAtT,
    deadlineAtT: p.deadlineAtT,
    resolved: p.resolved,
    // doomed はルール側だけで決まる（決定論）。unarrived は「実物が届かなかった」＝実時間依存で
    // I4 の意図的な例外にあたるので、実行器がログに刻印して実験データから弾けるようにする
    reason,
    deterministic: reason === 'doomed',
  };
}

export class DecisionScheduler {
  constructor() {
    /** @type {Map<string, {id:string, intervalS:number, latencyS:number, firstIssueAtT:number,
     *   nextIssueAtT:number, deadlineS:number, onMiss:string, latencyModel:any, missArbiter:string,
     *   stages:any, issueSeq:number, pending:null|Pending}>} 登録順に走査する（決定論のため） */
    this.deciders = new Map();
    /** 発行トークンの世代。reset() でのみ 1 進む（§12.5 発行トークン） */
    this.generation = 0;
  }

  /**
   * decider を登録する。Phase 2 で艇を足す場合も register(boatId, {...}) を呼ぶだけでよい（§13）。
   * 同じ id を再登録すると設定を差し替えて実行状態（pending・nextIssueAtT）を初期化する。
   * ただし issueSeq は引き継ぐので、再登録前に発行済みのトークンが再び一致することはない。
   *
   * latency の出所は必ず1つだけ選ぶ（§2.5 ルール側の変数は単一の出所を持つ）:
   *   latencyS を書く ／ stages を書く（合成値が latencyS になる） ／ latencyModel に分布を書く。
   * 併記は設定ミスとして落とす。分布は発行ごとに引くので、併記された latencyS は誰も読まない
   * ＝宣言と実際の発効時刻が黙って食い違う。
   * @param {string} id - decider の識別子（現在は指揮官 id、Phase 2 では艇 id）
   * @param {{intervalS:number, latencyS?:number, firstIssueAtT?:number, stages?:any,
   *   deadlineS?:number, onMiss?:'keep-current'|'default-order',
   *   latencyModel?:'constant'|{kind:'uniform',minS:number,maxS:number,seed:string|number},
   *   missArbiter?:'model'|'wallclock'}} config - すべてルール側の設定値（§2.5）
   */
  register(
    id,
    {
      intervalS,
      latencyS,
      firstIssueAtT = 0,
      stages = null,
      deadlineS = Infinity,
      onMiss = 'keep-current',
      latencyModel = 'constant',
      missArbiter = 'model',
    } = {}
  ) {
    if (typeof id !== 'string' || id.length === 0) {
      throw new TypeError(`DecisionScheduler.register: id must be a non-empty string (got ${JSON.stringify(id)})`);
    }
    if (!Number.isFinite(intervalS) || intervalS <= 0) {
      throw new TypeError(`DecisionScheduler.register: intervalS must be a positive finite number (id="${id}", got ${intervalS})`);
    }
    validateLatencyModel(latencyModel, id);
    // 'constant' 以外は発行ごとに引く分布。宣言値1本では latency が決まらない
    const drawsPerIssue = latencyModel !== 'constant';

    // ステージ宣言があれば合成値が正。latencyS も併記されていて食い違うなら設定ミスとして落とす
    // （ルール側の変数は単一の出所を持つ。§2.5）
    let composedLatencyS = latencyS;
    if (stages != null) {
      composedLatencyS = composeStages(stages, id);
      if (latencyS !== undefined && Math.abs(latencyS - composedLatencyS) > T_EPS) {
        throw new TypeError(
          `DecisionScheduler.register: stages compose to ${composedLatencyS}s but latencyS=${latencyS}s ` +
            `was also given (id="${id}"). Declare it once.`
        );
      }
    }
    if (drawsPerIssue) {
      // 分布と latencyS/stages の併記を許すと、宣言値が黙って無視される「2つの出所を持つ
      // ルール側の変数」になる（stages↔latencyS の食い違いを落とすのと同じ理由。§2.5）
      if (latencyS !== undefined || stages != null) {
        throw new TypeError(
          `DecisionScheduler.register: latencyModel draws a latency per issue, so latencyS/stages must ` +
            `not also be given (id="${id}", latencyS=${latencyS}, stages=${JSON.stringify(stages)}). Declare it once.`
        );
      }
      // 1本の宣言値は存在しない。発行ごとの引きは pending.drawnLatencyS に残る
      composedLatencyS = null;
    } else if (!Number.isFinite(composedLatencyS) || composedLatencyS < 0) {
      throw new TypeError(
        `DecisionScheduler.register: latencyS must be a finite number >= 0, or stages, or a drawing ` +
          `latencyModel must be given (id="${id}", got ${latencyS})`
      );
    }
    if (!Number.isFinite(firstIssueAtT)) {
      throw new TypeError(`DecisionScheduler.register: firstIssueAtT must be a finite number (id="${id}", got ${firstIssueAtT})`);
    }
    // deadlineS は Infinity が既定（＝不成立が起きない＝L0 の全停止モデル）。0 以下と NaN だけを弾く
    if (typeof deadlineS !== 'number' || Number.isNaN(deadlineS) || deadlineS <= 0) {
      throw new TypeError(
        `DecisionScheduler.register: deadlineS must be a positive number or Infinity (id="${id}", got ${deadlineS})`
      );
    }
    if (!ON_MISS_MODES.includes(onMiss)) {
      throw new TypeError(
        `DecisionScheduler.register: onMiss must be one of ${ON_MISS_MODES.join(' | ')} (id="${id}", got ${JSON.stringify(onMiss)})`
      );
    }
    if (!MISS_ARBITERS.includes(missArbiter)) {
      throw new TypeError(
        `DecisionScheduler.register: missArbiter must be one of ${MISS_ARBITERS.join(' | ')} (id="${id}", got ${JSON.stringify(missArbiter)})`
      );
    }

    const previous = this.deciders.get(id);
    this.deciders.set(id, {
      id,
      intervalS,
      // latencyModel:'constant' のときだけ意味を持つ宣言値。分布のときは null（発行ごとに引く）
      latencyS: composedLatencyS,
      firstIssueAtT,
      nextIssueAtT: firstIssueAtT,
      deadlineS,
      onMiss,
      latencyModel,
      missArbiter,
      // 宣言そのものは記録側（実行器）がステージ別の実測 t_wall と対にするために保持する（roadmap D-3）。
      // スケジューラの状態機械が見るのは合成後の latencyS 1本だけ（§12.5 I2）
      stages,
      issueSeq: previous ? previous.issueSeq : 0,
      pending: null,
    });
  }

  /**
   * 全 decider を初期状態へ戻す（エピソード開始時）。登録内容と issueSeq は保持し、発行トークンの世代を進める。
   * 旧エピソードで in-flight のまま残った推論結果は、この世代更新によって二度と書き込めなくなる（§12）。
   */
  reset() {
    for (const d of this.deciders.values()) {
      d.nextIssueAtT = d.firstIssueAtT;
      d.pending = null;
    }
    this.generation += 1;
  }

  /**
   * @param {number} t - 現在のシム時刻
   * @returns {string[]} いま推論を発行すべき decider（pending 無し・発行時刻到来）。登録順
   */
  dueToIssue(t) {
    const ids = [];
    for (const [id, d] of this.deciders) {
      if (!d.pending && t + T_EPS >= d.nextIssueAtT) ids.push(id);
    }
    return ids;
  }

  /**
   * 発行済みにする。applyAtT / deadlineAtT を記録し、nextIssueAtT を実際の発行時刻から予約する
   * （nextIssueAtT += intervalS ではない。§11 の安全弁がこれで効く）。
   * latencyModel が分布ならここで drawnLatencyS を1回引き、drawn > deadlineS なら
   * **この時点で不成立を確定させる**（§12.5「この判断はタイムアウトする」という事実さえ、
   * 実行前から確定している）。確定した判断は結果が届いても発効しない。
   * @param {string} id
   * @param {number} t - 発行時刻（＝観測スナップショットの時刻 t_obs）
   * @returns {IssueToken} 発行トークン。呼び出し側は provideResult までこれを持ち回る（ブラウザは .then() のクロージャへ）
   */
  markIssued(id, t) {
    const d = this.deciders.get(id);
    if (!d) throw new Error(`DecisionScheduler.markIssued: unknown decider "${id}"`);
    if (d.pending) {
      // dueToIssue を経由していれば起こらない。起きたら呼び出し側の順序バグ（§12.5 I2）
      throw new Error(`DecisionScheduler.markIssued: "${id}" already has a pending decision issued at t=${d.pending.issuedAtT}`);
    }
    d.issueSeq += 1;
    const token = Object.freeze({ generation: this.generation, seq: d.issueSeq });
    const drawn = drawLatencyS(d, d.issueSeq);
    d.pending = {
      token,
      issuedAtT: t,
      drawnLatencyS: drawn,
      applyAtT: t + drawn,
      // deadlineS=Infinity なら deadlineAtT も Infinity になる（差で求めると Infinity-Infinity=NaN になる）
      deadlineAtT: t + d.deadlineS,
      // drawn <= deadlineS なら従来どおり t_apply で発効する。超えていれば発行の時点で不成立が
      // 確定する（§12.5）。deadlineS=Infinity では常に false なので L0 の挙動は変わらない
      doomed: drawn > d.deadlineS + T_EPS,
      resolved: false,
      missed: false,
      missReason: null,
      result: undefined,
    };
    d.nextIssueAtT = t + d.intervalS;
    return token;
  }

  /**
   * 推論結果を格納する（resolved にするだけで、適用は dueToApply/takeResult 側）。
   * トークンが現在の pending と一致しないときは黙って捨てる。捨てる対象は3種類（§12.5 発行トークン）:
   *   1. reset() を跨いだ旧エピソードの結果（generation 不一致）
   *   2. 同一エピソードの前サイクルの結果（seq 不一致）
   *   3. 不成立が確定した判断の結果（取り出し済みで pending が無い／pending は残っていても確定済み）
   * 3 は「モデルが不成立と言った判断は、手元に結果があっても捨てる」（§12.5）そのもの。
   * doomed（drawn > deadlineS）は発行の時点で確定しているので、締切時刻より前に届いた結果も捨てる。
   * ブラウザの .then() から呼ばれる（reset 後や不成立後にも発火する）ため、決して throw しない。
   * @param {string} id
   * @param {any} result - 呼び出し側の任意のペイロード（null は「推論失敗＝現指示維持」の正当な値）
   * @param {IssueToken} token - markIssued が返したトークン
   * @returns {boolean} 格納したら true、捨てたら false
   */
  provideResult(id, result, token) {
    const d = this.deciders.get(id);
    const p = d?.pending;
    if (!p || p.resolved) return false;
    // 不成立が確定した判断（発行時に確定した doomed も含む）は、結果が届いても受け取らない
    if (p.doomed || p.missed) return false;
    if (!token || typeof token !== 'object') return false;
    // 値で比較する（structuredClone / postMessage / JSON を経由してもトークンは生きる）
    if (token.generation !== p.token.generation || token.seq !== p.token.seq) return false;
    p.result = result;
    p.resolved = true;
    return true;
  }

  /**
   * @param {number} t
   * @returns {string[]} 発効時刻に達し、結果も到着している decider。t_apply より前には決して入らない。
   *   不成立が確定した判断は、手元に結果があっても決して入らない（§12.5）
   */
  dueToApply(t) {
    const ids = [];
    for (const [id, d] of this.deciders) {
      const p = d.pending;
      if (!p || !p.resolved) continue;
      if (settleMiss(p, t)) continue;
      if (t + T_EPS >= p.applyAtT) ids.push(id);
    }
    return ids;
  }

  /**
   * @param {number} t
   * @returns {string[]} 発効時刻に達したのに結果が未着で、シムを止めて待つべき decider
   *   （ブラウザの「推論待ち」判定。headless は発行を await するので常に空）。次の2つは含めない:
   *     - 不成立が確定したもの（含めるとブラウザが永久に待つ＝締切を入れた意味が消える）
   *     - **有限の締切を持つもの**。ブロック中はシム時刻が進まないので、待ってしまうと t が
   *       deadlineAtT へ永久に届かず、締切そのものが発火できなくなる（deadlineS > latencyS だと
   *       deadlineS=Infinity と完全に同じ挙動になり、締切を入れた意味が消える）。有限の締切は
   *       「待ち続けることをやめる」ための設定（§9・§12.5 の B案）であり、待つのは
   *       deadlineS=Infinity（L0 既定＝A案 全停止）のときだけ
   */
  blockedAt(t) {
    const ids = [];
    for (const [id, d] of this.deciders) {
      const p = d.pending;
      if (!p || p.resolved) continue;
      if (settleMiss(p, t)) continue;
      if (!(t + T_EPS >= p.applyAtT)) continue;
      if (Number.isFinite(p.deadlineAtT)) continue;
      ids.push(id);
    }
    return ids;
  }

  /**
   * 締切（t_issue + deadlineS）を過ぎて不成立が確定した decider を返す（v2 新規）。
   * 他の3つと違い id ではなくオブジェクトを返す。呼び出し側が onMiss を選んでログを書けるようにするため。
   * 判定はモジュール冒頭の2経路（doomed / unarrived）で、どちらだったかは entry の reason に出る。
   *   - 締切より latency が長い引き（drawn > deadlineS）は t_issue+deadlineS で必ず不成立になる
   *     （締切と t_apply が同じ dt 窓に落ちても、結果が先に届いていても発効しない）
   *   - 締切前に発効可能になった判断は、締切時刻を過ぎても不成立にならない
   *   - 締切を過ぎた pending は missedAt / dueToApply のどちらか一方に必ず現れる（取り残されない）
   *   - 一度不成立になった判断が、あとから発効へ戻ることはない
   * 既定の deadlineS=Infinity では常に空配列を返し、L0 の挙動は変わらない。
   * pending は解消しない（解消は takeMissed）。ただし不成立の確定は pending へ焼き付ける。
   * @param {number} t
   * @returns {MissEntry[]}
   */
  missedAt(t) {
    const entries = [];
    for (const d of this.deciders.values()) {
      if (settleMiss(d.pending, t)) entries.push(describeMiss(d));
    }
    return entries;
  }

  /**
   * 結果を取り出し、pending を null に戻す（＝ idle へ）。nextIssueAtT・issueSeq・generation には触れない。
   * @param {string} id
   * @returns {any} 結果。未登録・pending 無しなら undefined（throw はしない）
   */
  takeResult(id) {
    const d = this.deciders.get(id);
    if (!d || !d.pending) return undefined;
    const result = d.pending.result;
    d.pending = null;
    return result;
  }

  /**
   * 不成立を確定させて pending を解消する。missedAt(t) が返した id に対して同じステップ内で呼ぶ。
   * 発行のリズムは崩さない（nextIssueAtT は動かさない。§12.5 の例では 20 発行・26 不成立でも次は 30）。
   * @param {string} id
   * @returns {MissEntry|null} missedAt と同じ記述子。pending が無ければ null（no-op）
   */
  takeMissed(id) {
    const d = this.deciders.get(id);
    if (!d || !d.pending) return null;
    const entry = describeMiss(d);
    d.pending = null;
    return entry;
  }
}
