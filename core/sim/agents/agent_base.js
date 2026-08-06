/**
 * agent_base.js — ③エージェントの共通インターフェース
 *
 * persona・memory を保持し、observation から action を決定する。
 * LLM/VLM/VLAへの置き換えも、ルールベースへの置き換えも同じ形で扱える。
 */

export class AgentBase {
  /**
   * @param {{id: string, faction: string, persona?: object}} config
   */
  constructor(config) {
    this.id = config.id;
    this.faction = config.faction;
    this.persona = config.persona ?? {};
    this.memory = [];
  }

  /**
   * @param {object} observation - センサー観測・近傍通信等
   * @returns {Promise<{throttle: number, steering: number}>} action
   */
  async decide(observation) {
    throw new Error('AgentBase.decide() must be implemented by subclass');
  }

  remember(entry) {
    this.memory.push(entry);
  }
}
