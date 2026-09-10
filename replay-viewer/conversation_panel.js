/**
 * conversation_panel.js — 指揮官・艇AIの判断イベントを再生時刻に合わせて表示する
 *
 * swarm-sim/log_panel.js はライブ実行向け（新しい行をprependし続ける）だが、
 * こちらは再生時刻を前後に動かす（シークバー操作）前提のため、表示中の時刻までの
 * イベントを毎回まるごと再構築する。色使いはlog_panel.jsに合わせ、見た目の一貫性を保つ。
 */

const COLOR = {
  orders: '#9fc3ff',
  miss: '#ff9d5c',
  boatOverride: '#7be08a',
  boatObey: '#8fa8a4',
  boatWarn: '#ffd678',
  system: '#8fa8a4',
  mission: { defended: '#7be08a', breached: '#e0708e', timeout: '#ffd678' },
};

function line(text, color, opts = {}) {
  const el = document.createElement('div');
  el.textContent = text;
  el.style.color = color;
  if (opts.bold) el.style.fontWeight = '700';
  if (typeof opts.t === 'number') {
    el.style.cursor = 'pointer';
    el.title = 'クリックでこの時刻へ移動';
    el.dataset.seekT = String(opts.t);
  }
  return el;
}

function renderEvent(ev) {
  const t = ev.t.toFixed(1);
  if (ev.kind === 'orders') {
    const tail = `${ev.ignored > 0 ? `（+${ev.ignored}件無効）` : ''}${ev.intent ? ` 「${ev.intent}」` : ''}`;
    return line(`[t=${t}] ORDERS ${ev.decider}: ${ev.count}件${tail}`, COLOR.orders, { bold: true, t: ev.t });
  }
  if (ev.kind === 'miss') {
    return line(`[t=${t}] MISS ${ev.decider}: ${ev.reason} → ${ev.onMiss}`, COLOR.miss, { bold: true, t: ev.t });
  }
  if (ev.kind === 'boatcall') {
    const sec = (ev.latencyMs / 1000).toFixed(1);
    const tail = ev.reason ? ` — ${ev.reason}` : ev.failure ? ` — ${ev.failure}` : '';
    const color = ev.outcome === 'override' ? COLOR.boatOverride : ev.outcome === 'obey' ? COLOR.boatObey : COLOR.boatWarn;
    return line(`[t=${t}] BOAT ${ev.boatId}: ${ev.outcome} (${sec}s 推論)${tail}`, color, { t: ev.t });
  }
  if (ev.kind === 'commandercall') {
    const sec = (ev.latencyMs / 1000).toFixed(1);
    const tail = ev.reason ? ` — ${ev.reason}` : ev.failure ? ` — ${ev.failure}` : '';
    const color = ev.outcome === 'ok' ? COLOR.orders : COLOR.boatWarn;
    return line(`[t=${t}] LLM ${ev.faction}-commander: ${ev.outcome} (${sec}s 推論)${tail}`, color, { t: ev.t });
  }
  if (ev.kind === 'system') {
    return line(`[t=${t}] ${ev.text}`, COLOR.system, { t: ev.t });
  }
  if (ev.kind === 'mission') {
    const label = { defended: '防御成功', breached: '突破', timeout: '時間切れ' }[ev.outcome] ?? ev.outcome;
    return line(`[t=${t}] MISSION 決着: ${label}`, COLOR.mission[ev.outcome] ?? '#e8f0f7', { bold: true, t: ev.t });
  }
  return line(`[t=${t}] ${JSON.stringify(ev)}`, '#666');
}

/**
 * @param {HTMLElement} container
 * @param {Array<{t:number,kind:string}>} events 時刻昇順ソート済み
 * @param {number} untilT この時刻までのイベントを表示する
 * @param {(t:number)=>void} [onSeek] 行クリックでこの時刻へ移動したい場合のコールバック
 */
export function renderConversation(container, events, untilT, onSeek) {
  container.textContent = '';
  const visible = events.filter((ev) => ev.t <= untilT);
  // 新しい行を上に（ライブ表示のlog_panel.jsと同じ並び）
  for (let i = visible.length - 1; i >= 0; i--) {
    const el = renderEvent(visible[i]);
    container.appendChild(el);
  }
  if (onSeek) {
    container.onclick = (e) => {
      const t = e.target?.dataset?.seekT;
      if (t !== undefined) onSeek(Number(t));
    };
  }
}

const FACTION_LABEL = { defender: '守備側', intruder: '攻撃側' };
const FACTION_ICON = { defender: '🔵', intruder: '🔴' };

function renderWindow(w) {
  const box = document.createElement('div');
  box.className = 'conv-window';

  const head = line(
    `[t=${w.t.toFixed(1)}] ${FACTION_ICON[w.faction] ?? ''} ${FACTION_LABEL[w.faction] ?? w.faction}指揮官「${w.intent ?? '(意図なし)'}」`,
    COLOR.orders,
    { bold: true, t: w.t }
  );
  box.appendChild(head);

  for (const o of w.overrides) {
    const el = line(`└ ${o.boatId} が独自判断: 「${o.reason ?? '(理由なし)'}」`, COLOR.boatOverride, { t: o.t });
    el.className = 'conv-override';
    box.appendChild(el);
  }

  if (w.obeyCount > 0) {
    const el = line(`（他 ${w.obeyCount}隻は指揮官の指示に従った）`, COLOR.boatObey);
    el.className = 'conv-obey-summary';
    box.appendChild(el);
  }

  return box;
}

/**
 * 「指揮官の意図単位」に構造化した表示（既定表示）。buildConversationWindows()の出力を使う。
 * @param {HTMLElement} container
 * @param {Array} windows buildConversationWindows()の戻り値
 * @param {Array<{t:number,kind:string}>} extraEvents episode開始/決着など、ウィンドウ化しない単発イベント
 * @param {number} untilT
 * @param {(t:number)=>void} [onSeek]
 */
export function renderStructuredConversation(container, windows, extraEvents, untilT, onSeek) {
  container.textContent = '';
  const items = [
    ...windows.map((w) => ({ t: w.t, render: () => renderWindow(w) })),
    ...extraEvents.map((ev) => ({ t: ev.t, render: () => renderEvent(ev) })),
  ]
    .filter((it) => it.t <= untilT)
    .sort((a, b) => b.t - a.t); // 新しいものを上に

  for (const it of items) container.appendChild(it.render());

  if (onSeek) {
    container.onclick = (e) => {
      const t = e.target?.dataset?.seekT;
      if (t !== undefined) onSeek(Number(t));
    };
  }
}
