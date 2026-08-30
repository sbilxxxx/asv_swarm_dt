/**
 * world.js — WorldState全体を束ねるクラス
 *
 * scene（地物・②）+ entities（機体・③state.js）+ platforms + sensors + environment を保持する。
 * digital-twin・swarm-simは、それぞれ別々にWorldインスタンスを生成して使う
 * （今回はランタイムを共有しない。詳細は docs/system-design.md §2.2）。
 */

import { EntityState } from './state.js';
import { platforms as platformRegistry } from './platforms/index.js';
import { GnssSensor } from './sensors/gnss.js';
import { RadarSensor } from './sensors/radar.js';
import { UnimplementedCameraSensor } from './sensors/camera.js';
import { CalmSeaEnvironment } from './environment/calm_sea.js';
import { MessageBus } from './comms.js';
import { FactionTracks } from './command/tracks.js';
import { applyDefaultOrders } from './command/orders.js';
import { BoatController } from './command/boat_controller.js';

export class World {
  /**
   * @param {object} config
   * @param {import('../scene/scene_format.js').SceneGeometry} config.scene
   * @param {number} [config.capacity]
   * @param {import('./sensors/sensor_base.js').SensorBase} [config.cameraSensor] - 未指定時はUnimplementedCameraSensor
   * @param {import('./environment/environment_base.js').EnvironmentBase} [config.environment]
   * @param {number} [config.radarRangeM] - レーダー探知距離。シナリオの sensors.radarRangeM から渡す
   */
  constructor(config) {
    this.scene = config.scene;
    this.state = new EntityState(config.capacity ?? 32);
    this.clock = 0;

    this.platformInstances = new Map(); // entityId -> platform instance
    this.sensors = {
      gnss: new GnssSensor(),
      // 探知距離はシナリオ（scenario.sensors.radarRangeM）から渡す。未指定なら従来既定値。
      // perShipClass を立てると艇ごとに艦種の探知距離を使う（艦種入りシナリオ）。
      radar: new RadarSensor({
        ...(config.radarRangeM ? { rangeM: config.radarRangeM } : {}),
        ...(config.radarPerShipClass ? { perShipClass: true } : {}),
      }),
      camera: config.cameraSensor ?? new UnimplementedCameraSensor(),
    };
    this.environment = config.environment ?? new CalmSeaEnvironment();
    this.agents = new Map(); // entityId -> AgentBase
    this.comms = new MessageBus();
    /** 陣営別の敵トラックストア（味方レーダーの統合。指揮官の視界の材料） */
    this.tracks = {
      defender: new FactionTracks('defender'),
      intruder: new FactionTracks('intruder'),
    };
    /** @type {Map<string, object>} boatId -> 現在の指示（command/orders.js が正規化して格納） */
    this.orders = new Map();
    /** 指示→操舵の追従制御（毎ステップ・LLMなし）。targetHistory を持つため World が reset を管理 */
    this.boatController = new BoatController();

    /** 防護対象（侵入側の到達目標）。シナリオの protectedAsset から設定される。 */
    this.protectedAsset = config.protectedAsset ?? null;
    /** spawn仕様の控え。reset()でエピソードを初期状態へ戻すために必要。 */
    this.spawnSpecs = [];
  }

  /**
   * @param {{id: string, faction: string, platform?: string, x: number, y: number, heading?: number, agent?: import('./agents/agent_base.js').AgentBase}} spec
   */
  spawn(spec) {
    const index = this.state.add(spec);
    const PlatformClass = platformRegistry[spec.platform ?? 'asv'];
    // 運動性能は艦種から決まる。艦種は EntityState にも入っているので、
    // Platform 側とセンサー側（radar.js）が同じ1つの出所を読む。
    this.platformInstances.set(spec.id, new PlatformClass({ shipClass: spec.shipClass }));
    if (spec.agent) this.agents.set(spec.id, spec.agent);
    // 位置・針路のみ控える（agentインスタンスはreset後も再利用する）
    this.spawnSpecs.push({ id: spec.id, x: spec.x, y: spec.y, heading: spec.heading ?? 0 });
    // spawn直後から指示を持たせる（resetEntities前にstepする使い方への保険）
    applyDefaultOrders(this);
    return index;
  }

  /**
   * 全エンティティをspawn時の位置・針路へ戻し、通信・エージェント記憶を初期化する。
   * EnvApi.reset() から呼ばれ、エピソードを反復実行できるようにする。
   */
  resetEntities() {
    for (const spec of this.spawnSpecs) {
      const i = this.state.indexOf(spec.id);
      if (i < 0) continue;
      this.state.x[i] = spec.x;
      this.state.y[i] = spec.y;
      this.state.heading[i] = spec.heading;
      this.state.speed[i] = 0;
      this.state.alive[i] = 1;
    }
    this.clock = 0;
    this.comms = new MessageBus();
    this.tracks.defender.reset();
    this.tracks.intruder.reset();
    this.boatController.reset();
    applyDefaultOrders(this);
    for (const agent of this.agents.values()) {
      agent.memory = [];
      agent.lastAction = null;
    }
  }

  observe(entityId, sensorType) {
    const sensor = this.sensors[sensorType];
    if (!sensor) throw new Error(`Unknown sensor type: ${sensorType}`);
    return sensor.observe(this, entityId);
  }
}
