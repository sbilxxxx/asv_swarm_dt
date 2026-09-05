/**
 * log_loader.js — 記録済みJSONLログ（headless_run.js出力）をパースし、エピソード単位に整理する
 *
 * 対象ファイル3種（scripts/headless_run.jsの --out / --decision-log / --llm-log と同じ形式）:
 *   - 位置ログ（必須）: {type:'episode_start'|'step'|'episode_end', episode, ...}
 *   - 指令ログ（任意）: DecisionSchedulerの判定1件ずつ（decider, tAppliedS, outcome, orders, intent, ...）
 *   - 艇LLM生ログ（任意）: 艇エージェントのLLM呼び出し1件ずつ（boatId, outcome, reason, latencyMs, ...）
 *
 * 位置ログだけでも2D/3D再生はできる。指令・LLMログが無ければ会話パネルは空になる。
 */

/** 1行1JSONのテキストを安全にパースする（壊れた行はスキップ） */
function parseJsonl(text) {
  const rows = [];
  for (const line of text.split('\n')) {
    const s = line.trim();
    if (!s) continue;
    try {
      rows.push(JSON.parse(s));
    } catch {
      // 壊れた行は無視する（末尾が書きかけの場合など）
    }
  }
  return rows;
}

/**
 * 位置ログ（type:'step'を含むJSONL）をエピソード単位に分解する。
 * @returns {Array<{episode:number, meta:object|null, outcome:string|null, tEnd:number, byBoat:Map<string,Array>}>}
 */
export function loadPositionLog(text) {
  const rows = parseJsonl(text);
  const episodes = new Map();

  function ep(idx) {
    if (!episodes.has(idx)) {
      episodes.set(idx, { episode: idx, meta: null, outcome: null, tEnd: 0, byBoat: new Map() });
    }
    return episodes.get(idx);
  }

  for (const d of rows) {
    if (d.episode == null) continue;
    const e = ep(d.episode);
    if (d.type === 'episode_start') {
      e.meta = d;
    } else if (d.type === 'step') {
      if (!e.byBoat.has(d.id)) e.byBoat.set(d.id, []);
      e.byBoat.get(d.id).push(d);
      if (d.t > e.tEnd) e.tEnd = d.t;
    } else if (d.type === 'episode_end') {
      e.outcome = d.outcome;
      if (typeof d.t === 'number') e.tEnd = Math.max(e.tEnd, d.t);
    }
  }

  for (const e of episodes.values()) {
    for (const rows2 of e.byBoat.values()) rows2.sort((a, b) => a.t - b.t);
  }

  return [...episodes.values()].sort((a, b) => a.episode - b.episode);
}

/** 指令ログ（decisions.jsonl）をエピソード番号でグルーピングする */
export function loadDecisionLog(text) {
  const rows = parseJsonl(text);
  const byEpisode = new Map();
  for (const d of rows) {
    if (d.episode == null) continue;
    if (!byEpisode.has(d.episode)) byEpisode.set(d.episode, []);
    byEpisode.get(d.episode).push(d);
  }
  return byEpisode;
}

/** 艇LLM生ログ（calls.jsonl）をエピソード番号でグルーピングする */
export function loadCallLog(text) {
  const rows = parseJsonl(text);
  const byEpisode = new Map();
  for (const d of rows) {
    if (d.episode == null) continue;
    if (!byEpisode.has(d.episode)) byEpisode.set(d.episode, []);
    byEpisode.get(d.episode).push(d);
  }
  return byEpisode;
}

/**
 * ある時刻Tにおける各艇のスナップショットを返す。記録が無い（まだ出現していない／
 * 消滅後で記録が途切れた）艇は、直近の最後の記録位置で静止して見える
 * （submission/video/replay_3d.js の frameAt() と同じ考え方）。
 * @param {Map<string, Array<{t:number,x:number,y:number,heading:number,speed:number,faction:string}>>} byBoat
 * @param {number} T
 * @returns {Array<object>}
 */
export function entitiesAt(byBoat, T) {
  const out = [];
  for (const [id, rows] of byBoat) {
    let lo = 0;
    let hi = rows.length - 1;
    let ans = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (rows[mid].t <= T) {
        ans = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    // Tより前の記録が無い（=出現直前・スポーン直後）場合は、最初の記録を代わりに使う。
    // ログはt=0ちょうどでなく最初の物理ステップ（例: t=0.1）から始まることが多く、
    // 何も出さないと再生開始直後だけ艇が消えて見える。
    if (ans < 0 && rows.length > 0) ans = 0;
    if (ans >= 0) out.push({ ...rows[ans], id });
  }
  return out;
}

/**
 * 指令ログ・艇LLM生ログを時系列イベント列へ統合する（会話パネル用）。
 * 指揮官の意図(intent)・艇のoverride理由(reason)など、自然言語の部分を優先的に拾う。
 * @param {Array<object>} decisions
 * @param {Array<object>} calls
 * @returns {Array<{t:number, kind:string, [key:string]:any}>}
 */
export function buildConversationEvents(decisions = [], calls = []) {
  const events = [];

  for (const d of decisions) {
    if (d.outcome === 'applied' && d.orders > 0) {
      events.push({
        t: d.tAppliedS,
        kind: 'orders',
        decider: d.decider,
        faction: d.faction,
        count: d.orders,
        ignored: d.ignored ?? 0,
        intent: d.intent ?? null,
      });
    } else if (d.outcome === 'missed') {
      events.push({
        t: d.tApplyScheduledS,
        kind: 'miss',
        decider: d.decider,
        reason: d.missReason ?? '(理由不明)',
        onMiss: d.onMiss,
      });
    }
  }

  for (const c of calls) {
    // 艇LLM生ログ（calls.jsonl）には艇の呼び出し（boatIdあり）と指揮官の呼び出し
    // （boatIdなし・FORCE PICTUREプロンプト）が混在している。分けて表示しないと
    // 「BOAT undefined」のような行になる。
    if (c.boatId) {
      events.push({
        t: c.t,
        kind: 'boatcall',
        boatId: c.boatId,
        faction: c.faction,
        outcome: c.outcome,
        latencyMs: c.latencyMs,
        reason: c.reason || null,
        failure: c.failure || null,
      });
    } else {
      events.push({
        t: c.t,
        kind: 'commandercall',
        faction: c.faction,
        outcome: c.outcome,
        latencyMs: c.latencyMs,
        reason: c.reason || null,
        failure: c.failure || null,
      });
    }
  }

  events.sort((a, b) => a.t - b.t);
  return events;
}
