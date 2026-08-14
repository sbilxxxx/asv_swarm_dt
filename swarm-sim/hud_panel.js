/**
 * hud_panel.js — エピソードHUD（クロック・勝敗タリー）・結果バナー・ログDLボタン
 *
 * env.step()が返すdone/info.outcome（core/sim/mission.js）を人間可読な表示に変換する。
 * 「攻防のゲーム」の終了条件・勝敗が画面上で分かるようにする
 * （docs/review-findings-2026-08-07.md 優先度4の見た目側 / E-7のダウンロード導線）。
 */

const OUTCOME_LABELS = {
  defended: '防衛成功',
  breached: '突破された',
  timeout: '時間切れ',
};

/** 実行状態のラベル。シム時刻が止まったとき、それが仕様なのか異常なのかをここで名指しする */
const STATUS_CLASS = { running: '', waiting: 'status-waiting', missed: 'status-missed' };

/**
 * @param {{episode:number, clock:number, tally:{defended?:number, breached?:number, timeout?:number},
 *   mode?:string|null, status?:{state:'running'|'waiting'|'missed', text:string}|null}} state
 *   mode は指揮官の腕（blue=scripted red=llm(...) 等）、status は実行状態。
 *   どちらも省略時は既存の表示を触らない。
 */
export function updateHud({ episode, clock, tally, mode = null, status = null }) {
  const episodeEl = document.getElementById('hud-episode');
  const clockEl = document.getElementById('hud-clock');
  const tallyEl = document.getElementById('hud-tally');
  if (episodeEl) episodeEl.textContent = `Episode ${episode}`;
  if (clockEl) clockEl.textContent = `t=${clock.toFixed(1)}s`;
  if (tallyEl) {
    tallyEl.textContent = `防衛 ${tally.defended ?? 0} / 突破 ${tally.breached ?? 0} / 時間切れ ${tally.timeout ?? 0}`;
  }
  const modeEl = document.getElementById('hud-mode');
  if (modeEl && mode !== null) modeEl.textContent = mode;
  const statusEl = document.getElementById('hud-status');
  if (statusEl && status !== null) {
    statusEl.textContent = status.text;
    statusEl.className = STATUS_CLASS[status.state] ?? '';
  }
}

/**
 * 推論待ちオーバーレイを出す（docs/time-model.md §9: ブラウザは blockedAt() が非空の間シムを止める）。
 * 経過実時間を毎フレーム書き換えるので、数字が動いていること自体が「固まっていない」証拠になる。
 * @param {{deciders:string[], elapsedS:number, clock:number}} state
 */
export function showWaiting({ deciders, elapsedS, clock }) {
  const el = document.getElementById('wait-overlay');
  const detail = document.getElementById('wait-detail');
  const elapsed = document.getElementById('wait-elapsed');
  if (!el) return;
  el.className = '';
  // 「誰を」と「どれだけ」を別の行にする。1行に詰めると狭い画面で不自然に折り返す
  if (detail) detail.textContent = `${deciders.join(' / ')} の結果を待っています`;
  if (elapsed) elapsed.textContent = `経過 ${elapsedS.toFixed(1)}s（実時間） / シム時刻 t=${clock.toFixed(1)}s で停止中`;
}

export function hideWaiting() {
  const el = document.getElementById('wait-overlay');
  if (!el) return;
  el.className = 'hidden';
}

/** @param {'defended'|'breached'|'timeout'|string} outcome */
export function showOutcomeBanner(outcome) {
  const el = document.getElementById('outcome-banner');
  if (!el) return;
  el.textContent = OUTCOME_LABELS[outcome] ?? outcome ?? '';
  el.className = `outcome-${outcome ?? 'unknown'}`;
}

export function hideOutcomeBanner() {
  const el = document.getElementById('outcome-banner');
  if (!el) return;
  el.className = 'hidden';
  el.textContent = '';
}

/**
 * JSONLログのBlobダウンロードボタンを配線する（E-7の残作業）。
 * core/はfs・DOM非依存を維持する設計方針のため（core/log/episode_logger.js参照）、
 * Blob化・aタグ経由の保存はView側であるここに置く。
 * @param {() => string} getJsonl - 呼び出し時点の env.logger.toJsonl() を返す関数
 */
export function wireDownloadButton(getJsonl) {
  const btn = document.getElementById('download-log-btn');
  if (!btn) return;
  btn.addEventListener('click', () => {
    const blob = new Blob([getJsonl()], { type: 'application/x-ndjson' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `swarm-sim-episode-log-${Date.now()}.jsonl`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  });
}
