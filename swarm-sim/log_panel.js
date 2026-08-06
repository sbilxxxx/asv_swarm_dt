/**
 * log_panel.js — エージェントの意思決定ログをテキストで表示
 */

const MAX_ENTRIES = 200;

export function appendLogEntry({ t, id, action }) {
  const container = document.getElementById('log-entries');
  if (!container) return;
  const line = document.createElement('div');
  line.textContent = `[t=${t.toFixed(1)}] ${id}: throttle=${action.throttle.toFixed(2)} steering=${action.steering.toFixed(2)}`;
  container.prepend(line);
  while (container.children.length > MAX_ENTRIES) {
    container.removeChild(container.lastChild);
  }
}
