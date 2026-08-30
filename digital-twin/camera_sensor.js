/**
 * camera_sensor.js — カメラSensorの実装（digital-twin View側が提供）
 *
 * core/sim/sensors/sensor_base.js の SensorBase を継承し、
 * core/sim/sensors/camera.js の UnimplementedCameraSensor の代わりに
 * World へ渡す（World の cameraSensor オプション、main.js参照）。
 *
 * 船を外から映す第三者視点（チェイスカム）ではなく、船体のブリッジに搭載された
 * カメラの一人称視点にする。船の位置そのものにカメラを置き、ブリッジの高さから
 * 船首方向を見る。自船の船体はほぼ映らず、船首の先端がわずかに画面下に入る程度になる。
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
import { SHIP_VISUAL_SCALE, SHIP_DECK_HEIGHT, shipVisualScaleFor } from './scene_builder.js';

// ブリッジ（操舵室）の位置・高さ。船体の表示スケール（SHIP_VISUAL_SCALE）に合わせる。
const BRIDGE_HEIGHT_ABOVE_DECK_M = 1.2 * SHIP_VISUAL_SCALE; // 操舵室の窓の高さ
const BRIDGE_FORWARD_OFFSET_M = 0.6 * SHIP_VISUAL_SCALE; // 船体中心よりわずかに船首側
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

    const { sensorCamera, renderer, scene3d, overviewCamera } = this.three;
    const x = world.state.x[i];
    const y = world.state.y[i];
    const heading = world.state.heading[i];
    // 艦種ごとにscene_builder.jsが船体をGroup.scaleで拡大縮小するため（艦種の見た目差・最小実装）、
    // ブリッジ位置もここで同じ倍率を掛けないと、拡大された船体にカメラがめり込む・浮くバグになる
    // （docs/quality-assurance-method.mdが警告する「カメラ位置バグ」と同じ形。既定艦種runnerは1.0で無変化）。
    const classScale = shipVisualScaleFor(world.state.shipClass[i]);
    const bridgeHeight = SHIP_DECK_HEIGHT + BRIDGE_HEIGHT_ABOVE_DECK_M * classScale;
    const forwardOffset = BRIDGE_FORWARD_OFFSET_M * classScale;

    // 船体そのものの位置（＋わずかに船首側）にカメラを置く。第三者視点（船の後方から見る）にはしない。
    sensorCamera.position.set(
      x + Math.cos(heading) * forwardOffset,
      bridgeHeight,
      -(y + Math.sin(heading) * forwardOffset)
    );
    const lookX = x + Math.cos(heading) * (forwardOffset + CAM_LOOK_AHEAD_M);
    const lookY = y + Math.sin(heading) * (forwardOffset + CAM_LOOK_AHEAD_M);
    sensorCamera.lookAt(lookX, bridgeHeight * 0.55, -lookY);

    renderer.render(scene3d, sensorCamera);
    const imageDataUrl = renderer.domElement.toDataURL('image/png');

    // 表示用canvasを俯瞰カメラの絵に戻す（センサー視点のまま残さない）
    renderer.render(scene3d, overviewCamera);

    return { type: 'camera', imageDataUrl, timestamp: world.clock };
  }
}
