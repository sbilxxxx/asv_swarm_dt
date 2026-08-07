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

/** @param {{episode:number, clock:number, tally:{defended?:number, breached?:number, timeout?:number}}} state */
export function updateHud({ episode, clock, tally }) {
  const episodeEl = document.getElementById('hud-episode');
  const clockEl = document.getElementById('hud-clock');
  const tallyEl = document.getElementById('hud-tally');
  if (episodeEl) episodeEl.textContent = `Episode ${episode}`;
  if (clockEl) clockEl.textContent = `t=${clock.toFixed(1)}s`;
  if (tallyEl) {
    tallyEl.textContent = `防衛 ${tally.defended ?? 0} / 突破 ${tally.breached ?? 0} / 時間切れ ${tally.timeout ?? 0}`;
  }
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
