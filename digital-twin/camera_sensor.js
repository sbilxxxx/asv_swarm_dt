/**
 * camera_sensor.js — カメラSensorの実装（digital-twin View側が提供）
 *
 * core/sim/sensors/sensor_base.js の SensorBase を継承し、
 * core/sim/sensors/camera.js の UnimplementedCameraSensor の代わりに
 * World へ渡す（World の cameraSensor オプション、main.js参照）。
 *
 * 描画用に俯瞰カメラ（three.overviewCamera）とは別の専用カメラ（three.sensorCamera）を使う。
 * 同じcanvas/rendererを使い回すため、キャプチャ後は必ず俯瞰カメラで再描画し、
 * 画面表示がセンサー視点のまま残らないようにする（過去に発生した不具合の再発防止）。
 *
 * L1で swarm-sim 側と接続する際は、このクラスのインスタンスを
 * swarm-sim が動かす World の camera Sensor として登録する
 * （docs/system-design.md §2.3 参照）。
 */

import { SensorBase } from '../core/sim/sensors/sensor_base.js';
import { SHIP_VISUAL_SCALE } from './scene_builder.js';

// 船体の表示スケール（SHIP_VISUAL_SCALE）に合わせてカメラ距離も拡大する。
// ここだけ実寸のままだと、拡大された船体にカメラがめり込んでしまう。
const CAM_HEIGHT_M = 3.2 * SHIP_VISUAL_SCALE;
const CAM_BEHIND_M = 6 * SHIP_VISUAL_SCALE;
const CAM_LOOK_AHEAD_M = 45;

export class ThreeCameraSensor extends SensorBase {
  /** @param {ReturnType<typeof import('./scene_builder.js').buildThreeScene>} three */
  constructor(three) {
    super();
    this.three = three;
  }

  observe(world, entityId) {
    const i = world.state.indexOf(entityId);
    if (i < 0) return null;

    const { sensorCamera, renderer, scene3d, overviewCamera, render } = this.three;
    const x = world.state.x[i];
    const y = world.state.y[i];
    const heading = world.state.heading[i];

    sensorCamera.position.set(
      x - Math.cos(heading) * CAM_BEHIND_M,
      CAM_HEIGHT_M,
      -(y - Math.sin(heading) * CAM_BEHIND_M)
    );
    const lookX = x + Math.cos(heading) * CAM_LOOK_AHEAD_M;
    const lookY = y + Math.sin(heading) * CAM_LOOK_AHEAD_M;
    sensorCamera.lookAt(lookX, 1.0, -lookY);

    renderer.render(scene3d, sensorCamera);
    const imageDataUrl = renderer.domElement.toDataURL('image/png');

    // 表示用canvasを俯瞰カメラの絵に戻す（センサー視点のまま残さない）
    renderer.render(scene3d, overviewCamera);

    return { type: 'camera', imageDataUrl, timestamp: world.clock };
  }
}
