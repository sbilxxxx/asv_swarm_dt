/**
 * camera.js — カメラセンサーのインターフェースのみ（core側は未実装）
 *
 * レンダリング（Three.js）が必要なため、実装は digital-twin/camera_sensor.js が提供する。
 * core単体（例: swarm-simがcoreだけ使う場合）でカメラを呼ぶと明示的にエラーになる。
 */

import { SensorBase } from './sensor_base.js';

export class UnimplementedCameraSensor extends SensorBase {
  observe(world, entityId) {
    throw new Error(
      'Camera sensor has no implementation in core. ' +
        'Register a rendering-backed implementation (see digital-twin/camera_sensor.js) instead.'
    );
  }
}
