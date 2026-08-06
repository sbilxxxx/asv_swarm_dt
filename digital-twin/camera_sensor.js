/**
 * camera_sensor.js — カメラSensorの実装（digital-twin View側が提供）
 *
 * core/sim/sensors/sensor_base.js の SensorBase を継承し、
 * core/sim/sensors/camera.js の UnimplementedCameraSensor の代わりに
 * World へ渡す（World の cameraSensor オプション、main.js参照）。
 *
 * L1で swarm-sim 側と接続する際は、このクラスのインスタンスを
 * swarm-sim が動かす World の camera Sensor として登録する
 * （docs/system-design.md §2.3 参照）。
 */

import { SensorBase } from '../core/sim/sensors/sensor_base.js';

const CAM_HEIGHT_M = 6;
const CAM_BEHIND_M = 8;
const CAM_LOOK_AHEAD_M = 40;

export class ThreeCameraSensor extends SensorBase {
  /** @param {ReturnType<typeof import('./scene_builder.js').buildThreeScene>} three */
  constructor(three) {
    super();
    this.three = three;
  }

  observe(world, entityId) {
    const i = world.state.indexOf(entityId);
    if (i < 0) return null;

    const { camera, renderer, scene3d } = this.three;
    const x = world.state.x[i];
    const y = world.state.y[i];
    const heading = world.state.heading[i];

    camera.position.set(
      x - Math.cos(heading) * CAM_BEHIND_M,
      CAM_HEIGHT_M,
      -(y - Math.sin(heading) * CAM_BEHIND_M)
    );
    const lookX = x + Math.cos(heading) * CAM_LOOK_AHEAD_M;
    const lookY = y + Math.sin(heading) * CAM_LOOK_AHEAD_M;
    camera.lookAt(lookX, 1.5, -lookY);

    renderer.render(scene3d, camera);
    const imageDataUrl = renderer.domElement.toDataURL('image/png');

    return { type: 'camera', imageDataUrl, timestamp: world.clock };
  }
}
