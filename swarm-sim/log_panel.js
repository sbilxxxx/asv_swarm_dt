/**
 * log_panel.js — エージェントの意思決定ログ・通信ログをテキストで表示
 */

const MAX_ENTRIES = 200;

function append(line) {
  const container = document.getElementById('log-entries');
  if (!container) return;
  container.prepend(line);
  while (container.children.length > MAX_ENTRIES) {
    container.removeChild(container.lastChild);
  }
}

export function appendLogEntry({ t, id, action }) {
  const line = document.createElement('div');
  line.textContent = `[t=${t.toFixed(1)}] ${id}: throttle=${action.throttle.toFixed(2)} steering=${action.steering.toFixed(2)}`;
  append(line);
}

/** エージェント間の通信（構造化メッセージ）をログに表示する。決定ログと区別できる見た目にする。 */
export function appendCommsEntry({ t, from, to, type, confidence }) {
  const line = document.createElement('div');
  line.style.color = '#ffd678';
  line.textContent = `[t=${t.toFixed(1)}] COMM ${from} -> ${to}: ${type} (confidence=${confidence.toFixed(2)})`;
  append(line);
}

/**
 * ミッションイベント（core/sim/mission.jsのevaluateMission()が返すevents）をログに表示する。
 * 「攻防のゲーム」の節目（捕捉・突破）は決定ログ・通信ログの中に埋もれず分かるように、
 * 太字＋独自の色で目立たせる。
 * @param {{t:number, type:'intercepted'|'asset_breached', intruder:string, by?:string}} ev
 */
export function appendMissionEntry(ev) {
  const line = document.createElement('div');
  line.style.fontWeight = '700';
  if (ev.type === 'intercepted') {
    line.style.color = '#7be08a';
    line.textContent = `[t=${ev.t.toFixed(1)}] MISSION 捕捉: ${ev.by} が ${ev.intruder} を無力化`;
  } else if (ev.type === 'asset_breached') {
    line.style.color = '#e0708e';
    line.textContent = `[t=${ev.t.toFixed(1)}] MISSION 突破: ${ev.intruder} が防護対象へ到達`;
  } else {
    line.style.color = '#ffd678';
    line.textContent = `[t=${ev.t.toFixed(1)}] MISSION ${ev.type}`;
  }
  append(line);
}

/**
 * 指揮官の指示発効をログに表示する（采配の変化点が分かるように独自色・太字）。
 * 発行（t_issue）ではなく発効（t_apply）の時刻で出す。艇の動きが変わる瞬間と
 * 行が一致しないと、破線の描画と読み合わせられない（docs/time-model.md §8）。
 * @param {{t:number, commander:string, count:number, intent?:string|null, ignored?:number}} entry
 */
export function appendOrdersEntry({ t, commander, count, intent, ignored = 0 }) {
  const line = document.createElement('div');
  line.style.color = '#9fc3ff';
  line.style.fontWeight = '700';
  line.textContent =
    `[t=${t.toFixed(1)}] ORDERS ${commander}: ${count}件` +
    `${ignored > 0 ? `(+${ignored}件 無効)` : ''}${intent ? ` 「${intent}」` : ''}`;
  append(line);
}

/**
 * 指示の不成立（締切超過）をログに表示する（docs/time-model.md §12.5）。
 * 既定の deadlineS=∞ では起きない。有限の締切を指定した場合、シムは止まらず
 * 進み続けるので、この行だけが「采配が1サイクル飛んだ」ことの証拠になる。
 * @param {{t:number, commander:string, reason:string, onMiss:string}} entry
 */
export function appendMissEntry({ t, commander, reason, onMiss }) {
  const line = document.createElement('div');
  line.style.color = '#ff9d5c';
  line.style.fontWeight = '700';
  line.textContent = `[t=${t.toFixed(1)}] MISS ${commander}: ${reason} -> ${onMiss}`;
  append(line);
}

/**
 * 実行系（推論待ちで停止・再開、LLM 呼び出しの結末、設定の警告）の1行。
 * ミッションの出来事ではないので色で区別する。
 * @param {{t?:number|null, text:string, tone?:'info'|'warn'|'error'}} entry
 */
export function appendSystemEntry({ t = null, text, tone = 'info' }) {
  const line = document.createElement('div');
  line.style.color = tone === 'error' ? '#e0708e' : tone === 'warn' ? '#ffd678' : '#8fa8a4';
  line.textContent = `${t === null ? '' : `[t=${t.toFixed(1)}] `}${text}`;
  append(line);
}
