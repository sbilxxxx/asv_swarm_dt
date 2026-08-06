/**
 * episode_logger.js — FR8: 学習データ互換のエピソードログ
 *
 * env_api.step() の入出力をそのまま記録するだけの薄い層。
 * 学習パイプライン本体は実装しない（docs/system-design.md 参照）。
 * 将来的には usv-physical-ai ラボと同じ LeRobot 形式に寄せることを想定。
 * 公開デモの「リプレイ再生」入力としても使う想定（ライブLLM呼び出し不要にするため）。
 */

export class EpisodeLogger {
  constructor() {
    this.episodes = [];
    this.current = null;
  }

  startEpisode() {
    this.current = { startedAt: Date.now(), steps: [] };
    this.episodes.push(this.current);
  }

  logStep({ t, actions, observation }) {
    if (!this.current) this.startEpisode();
    this.current.steps.push({ t, actions, observation });
  }

  /** @returns {string} JSON文字列（ダウンロード・保存用） */
  toJson() {
    return JSON.stringify(this.episodes, null, 2);
  }
}
