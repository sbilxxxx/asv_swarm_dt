/**
 * llm_agent.js — LLM/VLM/VLAエージェント（今回はLLM = テキストのみ）
 *
 * 呼び出し先は差し替え可能にする（decideFn）。デフォルトはAPIキー不要の
 * ルールベース関数とし、GitHub Pages上でもセットアップなしに動くようにする。
 * 実際のLLM呼び出し（Ollama等）はローカル開発時に decideFn を差し替えて使う想定
 * （ブラウザから直接APIキーを扱わないための設計判断。README参照）。
 *
 * VLM/VLA化（画像入力）はL1でobservationにカメラ画像を加える形で拡張する。
 */

import { AgentBase } from './agent_base.js';
import { simpleRuleBasedDecision } from './rule_based_fallback.js';

export class LlmAgent extends AgentBase {
  /**
   * @param {object} config
   * @param {(observation: object, self: {faction: string, persona: object}, memory: array) => Promise<{throttle:number, steering:number}>} [config.decideFn]
   *   未指定時はAPIキー不要のルールベース関数にフォールバックする
   */
  constructor(config) {
    super(config);
    this.decideFn = config.decideFn ?? simpleRuleBasedDecision;
  }

  async decide(observation) {
    const self = { faction: this.faction, persona: this.persona };
    const action = await this.decideFn(observation, self, this.memory);
    this.remember({ t: observation?.timestamp, observation, action });
    return action;
  }
}
