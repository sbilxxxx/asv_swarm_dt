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
    /** @type {Array<{from:string,to:string,type:string,confidence:number}>} 直近ステップで配信されたメッセージ（表示用） */
    this.lastCommsEvents = [];
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

  /**
   * センサーで検知したコンタクトを、同陣営エージェントへ構造化メッセージとして共有する。
   * message_type/location/value/confidence/requested_action の形式は lunar_agents を踏襲。
   * エージェント本体（decide側）は「見る」役、ここ（環境側）は「無線で報告する」役、と役割を分ける。
   */
  _reportContacts() {
    this.lastCommsEvents = [];
    for (const id of this.world.agents.keys()) {
      const radar = this.world.observe(id, 'radar');
      if (!radar || radar.contacts.length === 0) continue;
      const nearest = [...radar.contacts].sort((a, b) => a.rangeM - b.rangeM)[0];
      const i = this.world.state.indexOf(id);
      // radar.bearingRad は RadarSensor 側で atan2(dy,dx) として計算済みの絶対方位（ワールド座標系）。
      // 自艇の針路を足し込む必要はない（以前ここで heading を加算していたのは二重計上のバグだった）。
      const location = {
        x: this.world.state.x[i] + Math.cos(nearest.bearingRad) * nearest.rangeM,
        y: this.world.state.y[i] + Math.sin(nearest.bearingRad) * nearest.rangeM,
      };
      const message = {
        type: 'contact_report',
        location,
        value: { contactFaction: nearest.faction, rangeM: Math.round(nearest.rangeM) },
        confidence: Math.max(0.3, 1 - nearest.rangeM / (radar.rangeM || 1500)),
        requestedAction: 'converge',
      };
      const delivered = this.world.comms.broadcast(id, message, this.world);
      for (const toId of delivered) {
        this.lastCommsEvents.push({ from: id, to: toId, type: message.type, confidence: message.confidence });
      }
    }
  }

  _observationForAll() {
    this._reportContacts();
    const obs = {};
    for (const id of this.world.agents.keys()) {
      const i = this.world.state.indexOf(id);
      obs[id] = {
        gnss: this.world.observe(id, 'gnss'),
        radar: this.world.observe(id, 'radar'),
        messages: this.world.comms.receive(id),
        // 自艇の位置・針路（ローカル座標）。相対方位から操舵量を計算するために必要。
        position: { x: this.world.state.x[i], y: this.world.state.y[i], heading: this.world.state.heading[i] },
        timestamp: this.world.clock,
      };
    }
    return obs;
  }
}
