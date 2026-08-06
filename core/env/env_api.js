/**
 * env_api.js — ④インターフェース層（Gym風API）
 *
 * reset() / step(actions) / observation という最小限の形にしておくことで、
 * 将来RLライブラリや自己対戦ループに差し替えても core/sim 以下を変更せずに済む。
 * 詳細は docs/system-design.md を参照。
 */

import { EpisodeLogger } from '../log/episode_logger.js';

export class EnvApi {
  /** @param {import('../sim/world.js').World} world */
  constructor(world) {
    this.world = world;
    this.logger = new EpisodeLogger();
    this.dt = 0.5; // 秒/ステップ
  }

  reset() {
    this.world.clock = 0;
    this.logger.startEpisode();
    return this._observationForAll();
  }

  /**
   * @param {Record<string, {throttle:number, steering:number}>} actions - entityId -> action
   */
  step(actions) {
    for (const [entityId, action] of Object.entries(actions)) {
      const i = this.world.state.indexOf(entityId);
      if (i < 0) continue;
      const platform = this.world.platformInstances.get(entityId);
      platform.step(this.world.state, i, action, this.dt);
    }
    this.world.clock += this.dt;

    const observation = this._observationForAll();
    const done = false; // TODO: 任務成否・損害等の終了条件（FR2関連）
    this.logger.logStep({ t: this.world.clock, actions, observation });

    return { observation, done, info: {} };
  }

  _observationForAll() {
    const obs = {};
    for (const id of this.world.agents.keys()) {
      obs[id] = {
        gnss: this.world.observe(id, 'gnss'),
        radar: this.world.observe(id, 'radar'),
        timestamp: this.world.clock,
      };
    }
    return obs;
  }
}
