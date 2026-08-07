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
