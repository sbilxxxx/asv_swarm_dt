/**
 * comms.js — エージェント間の構造化メッセージング
 *
 * lunar_agents（前回ハッカソン作品）で実証した形式
 * （message_type / location / value / confidence / requested_action）を踏襲する。
 * グローバルな完全情報共有はせず、近傍の同陣営エージェントにのみ届く
 * 範囲限定のブロードキャストとして実装する。
 *
 * この「会話」がswarm-simのログパネル・2Dマップで可視化される（agent_view.js / log_panel.js）。
 */

const COMMS_RANGE_M = 900;

export class MessageBus {
  constructor() {
    /** @type {Map<string, Array<object>>} agentId -> このtickで届いた未読メッセージ */
    this.inbox = new Map();
    /** @type {Array<object>} 表示・ログ用の全履歴 */
    this.log = [];
  }

  /**
   * @param {string} fromId
   * @param {{type: string, location: {x:number,y:number}, value?: any, confidence: number, requestedAction?: string}} message
   * @param {import('./world.js').World} world
   * @returns {string[]} 実際にメッセージが届いた宛先ID一覧（可視化用）
   */
  broadcast(fromId, message, world) {
    const i = world.state.indexOf(fromId);
    if (i < 0) return [];
    const faction = world.state.faction[i];
    const fx = world.state.x[i];
    const fy = world.state.y[i];

    const entry = { from: fromId, ...message, timestamp: world.clock };
    this.log.push(entry);
    if (this.log.length > 500) this.log.shift();

    const delivered = [];
    for (let j = 0; j < world.state.count; j++) {
      if (j === i || !world.state.alive[j]) continue;
      if (world.state.faction[j] !== faction) continue; // 同陣営のみ（敵の通信は傍受しない前提）
      const dx = world.state.x[j] - fx;
      const dy = world.state.y[j] - fy;
      if (Math.hypot(dx, dy) > COMMS_RANGE_M) continue;
      const toId = world.state.id[j];
      if (!this.inbox.has(toId)) this.inbox.set(toId, []);
      this.inbox.get(toId).push(entry);
      delivered.push(toId);
    }
    return delivered;
  }

  /** @returns {Array<object>} 宛先エージェントの未読メッセージ（取り出すと空になる） */
  receive(agentId) {
    const msgs = this.inbox.get(agentId) ?? [];
    this.inbox.set(agentId, []);
    return msgs;
  }
}
