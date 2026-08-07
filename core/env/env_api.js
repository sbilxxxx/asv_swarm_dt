/**
 * env_api.js — ④インターフェース層（Gym風API）
 *
 * reset() / step(actions) / observation という最小限の形にしておくことで、
 * 将来RLライブラリや自己対戦ループに差し替えても core/sim 以下を変更せずに済む。
 * 詳細は docs/system-design.md を参照。
 *
 * step()はevaluateMission()（core/sim/mission.js）を毎step呼び、
 * reward/done/outcomeをGym風の戻り値として返す。これにより「攻防のゲーム」として
 * 終了条件・報酬・エピソード反復が揃う（docs/review-findings-2026-08-07.md 優先度4）。
 */

import { EpisodeLogger } from '../log/episode_logger.js';
import { evaluateMission } from '../sim/mission.js';

const DEFAULT_DT_S = 0.1; // 秒/ステップ。旧0.5は最大回頭28.6°/stepと粗く、Viewの固定タイムステップ化にも耐えない

export class EnvApi {
  /**
   * @param {import('../sim/world.js').World} world
   * @param {{dt?: number}} [options]
   */
  constructor(world, { dt = DEFAULT_DT_S } = {}) {
    this.world = world;
    this.logger = new EpisodeLogger();
    this.dt = dt;
    /** @type {Array<{from:string,to:string,type:string,confidence:number}>} 直近ステップで配信されたメッセージ（表示用） */
    this.lastCommsEvents = [];
  }

  /**
   * エピソードをspawn時の状態へ戻し、新しいログエピソードを開始する。
   * 2エピソード目以降も同じWorldインスタンスで反復できることがGym風APIの前提
   * （docs/review-findings-2026-08-07.md A-6）。
   * @param {{scenario?: string, seed?: number|string}} [meta] - ログのエピソードヘッダに残すメタデータ
   */
  reset(meta = {}) {
    this.world.resetEntities();
    this.logger.startEpisode(meta);
    return this._observationForAll();
  }

  /**
   * @param {Record<string, {throttle:number, steering:number}>} actions - entityId -> action
   */
  step(actions) {
    for (const [entityId, action] of Object.entries(actions)) {
      const i = this.world.state.indexOf(entityId);
      if (i < 0) continue;
      // 撃破済み（alive=0）の侵入艇は行動を与えられても動かさない（A-8）。
      // indexOfそのものはalive非依存のまま（resetEntities()が死亡エンティティを
      // 見つけて復活させる必要があるため）にし、ガードはここ・適用箇所に置く。
      if (!this.world.state.alive[i]) continue;
      const platform = this.world.platformInstances.get(entityId);
      platform.step(this.world.state, i, action, this.dt);
    }
    this.world.clock += this.dt;

    const observation = this._observationForAll();
    const mission = evaluateMission(this.world);

    this._logStep(actions, mission);
    if (mission.done) {
      this.logger.endEpisode({ t: this.world.clock, outcome: mission.outcome });
    }

    return {
      observation,
      reward: mission.reward,
      done: mission.done,
      info: { outcome: mission.outcome, events: mission.events },
    };
  }

  /** 生存エンティティごとに1行、フラットなstep行をロガーへ渡す（core/log/episode_logger.js参照）。 */
  _logStep(actions, mission) {
    const state = this.world.state;
    for (let i = 0; i < state.count; i++) {
      if (!state.alive[i]) continue;
      const id = state.id[i];
      this.logger.logStep({
        t: this.world.clock,
        id,
        faction: state.faction[i],
        x: state.x[i],
        y: state.y[i],
        heading: state.heading[i],
        speed: state.speed[i],
        action: actions[id] ?? null,
        reward: mission.reward,
        done: mission.done,
        outcome: mission.outcome,
      });
    }
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
