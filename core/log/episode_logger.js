/**
 * episode_logger.js — FR8: 学習データ互換のエピソードログ
 *
 * 旧実装は「1step = {t, actions, observation全文}」をネストしたオブジェクトとして
 * 保持し、最後に toJson() で1本の巨大文字列に固めていた。30隻×2000stepでは
 * observation（radar contacts・gnss・messages全件）がstepごとに約213KBあり、
 * JSON.stringify(this.episodes, null, 2) が単一文字列の長さ上限を超えて
 * RangeError: Invalid string length で落ちていた。
 *
 * 対策: 保持形式をフラット化する。
 *   - 1行 = 1エピソードのヘッダ / 1step×1生存エージェント分の状態 / 1エピソードの終了、
 *     のいずれか（JSON Lines形式）。
 *   - 各行はスカラー値のみで、observationの全文（radar contacts等）は含めない
 *     （学習データとして意味を持つのは位置・行動・報酬であり、センサー生データは
 *     再現性が必要ならreplay側でworld状態から再計算する想定）。
 *   - toJsonl() は行ごとにJSON.stringifyした文字列を配列で保持し、最後に join('\n') する
 *     だけなので、ネスト・pretty-printによるサイズ増幅が起きない。
 *
 * reward/done/outcome はstep単位の値だが、後続処理（pandas等での読み込み）を
 * 単純にするため、そのstepの生存エージェント全行に同じ値を複製して持たせる
 * （最終行だけに持たせる設計より冗長だが、1行だけ見れば完結するほうが扱いやすい）。
 *
 * 学習パイプライン本体は実装しない（docs/system-design.md 参照）。
 * 公開デモの「リプレイ再生」入力としても使う想定（ライブLLM呼び出し不要にするため）。
 * UIのダウンロードボタン・Node側のファイル書き出しは本ファイルの責務外
 * （core/はfs・DOM非依存を維持するため、文字列を返すところまでが役割）。
 */

export class EpisodeLogger {
  constructor() {
    /** @type {string[]} JSON文字列化済みの行。toJsonl()はこれをjoinするだけ */
    this.rows = [];
    this.episodeCount = 0;
    this.currentEpisode = null;
  }

  /**
   * 新しいエピソードを開始し、ヘッダ行を1行記録する。
   * @param {{scenario?: string, seed?: number|string, [key: string]: any}} [meta]
   */
  startEpisode(meta = {}) {
    this.episodeCount += 1;
    this.currentEpisode = this.episodeCount;
    this._push({
      type: 'episode_start',
      episode: this.currentEpisode,
      startedAt: Date.now(),
      ...meta,
    });
  }

  /**
   * 1エージェント・1step分の行を記録する。
   * @param {{t:number, id:string, faction:string, x:number, y:number, heading:number, speed:number,
   *   action:{throttle:number, steering:number}|null, reward:number, done:boolean, outcome:string|null}} row
   */
  logStep(row) {
    if (this.currentEpisode === null) this.startEpisode();
    this._push({ type: 'step', episode: this.currentEpisode, ...row });
  }

  /**
   * エピソード終了行を記録する（done===trueになったstepの後にEnvApiから呼ばれる）。
   * @param {{t:number, outcome:string|null}} info
   */
  endEpisode(info) {
    this._push({
      type: 'episode_end',
      episode: this.currentEpisode,
      endedAt: Date.now(),
      ...info,
    });
  }

  _push(obj) {
    this.rows.push(JSON.stringify(obj));
  }

  /** @returns {string} JSON Lines文字列（ダウンロード・保存用。1行1JSON） */
  toJsonl() {
    return this.rows.join('\n');
  }
}
