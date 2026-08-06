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
