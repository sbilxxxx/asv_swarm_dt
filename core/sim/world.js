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

export class World {
  /**
   * @param {object} config
   * @param {import('../scene/scene_format.js').SceneGeometry} config.scene
   * @param {number} [config.capacity]
   * @param {import('./sensors/sensor_base.js').SensorBase} [config.cameraSensor] - 未指定時はUnimplementedCameraSensor
   * @param {import('./environment/environment_base.js').EnvironmentBase} [config.environment]
   */
  constructor(config) {
    this.scene = config.scene;
    this.state = new EntityState(config.capacity ?? 32);
    this.clock = 0;

    this.platformInstances = new Map(); // entityId -> platform instance
    this.sensors = {
      gnss: new GnssSensor(),
      radar: new RadarSensor(),
      camera: config.cameraSensor ?? new UnimplementedCameraSensor(),
    };
    this.environment = config.environment ?? new CalmSeaEnvironment();
    this.agents = new Map(); // entityId -> AgentBase
  }

  /**
   * @param {{id: string, faction: string, platform?: string, x: number, y: number, heading?: number, agent?: import('./agents/agent_base.js').AgentBase}} spec
   */
  spawn(spec) {
    const index = this.state.add(spec);
    const PlatformClass = platformRegistry[spec.platform ?? 'asv'];
    this.platformInstances.set(spec.id, new PlatformClass());
    if (spec.agent) this.agents.set(spec.id, spec.agent);
    return index;
  }

  observe(entityId, sensorType) {
    const sensor = this.sensors[sensorType];
    if (!sensor) throw new Error(`Unknown sensor type: ${sensorType}`);
    return sensor.observe(this, entityId);
  }
}
