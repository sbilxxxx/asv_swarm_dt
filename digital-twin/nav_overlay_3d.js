/**
 * nav_overlay_3d.js — VLM が予測した waypoint を3Dシーンの中に描く
 *
 * HUD の小さなプロット図（nav_hud.js）だけでは「船から見てその点がどこか」が分からない。
 * 3D の中に立てて初めて、**VLM が置いた点が障害物のどちら側を通るのか**が目で読める。
 *
 * 【何を描くか / 描かないか】
 *   描く: VLM のプラン（waypoint 列と、それを結ぶ航路線）・目的地と到達半径・自艇の航跡
 *   描く: 交通船の spline 経路（**真値**。VLM への入力ではなく、こちらが仕込んだ設定値）
 *   描かない: VLM に見えていない情報を「VLM が知っている」ように見せる表示
 * 3D の絵はカメラセンサー（＝VLM への入力画像）と同じシーンをレンダリングしているので、
 * ここに足したものは**ブリッジカメラの画像にも写る**。したがって
 * オーバーレイは俯瞰カメラだけが見えるレイヤーへ入れ、センサーカメラからは外す
 * （さもないと「VLM が自分の引いた線を見て判断する」という循環が生まれる）。
 *
 * レイヤーの使い方: THREE のレイヤー機構で overviewCamera だけがこのレイヤーを見る。
 * camera_sensor.js は sensorCamera でレンダリングするので、既定レイヤー0しか写らない。
 */

import * as THREE from 'three';

/** 俯瞰カメラ専用のレイヤー番号。センサーカメラ（＝VLMの入力画像）には写らせない */
export const OVERLAY_LAYER = 1;

/** waypoint の柱の高さ・太さ。波（振幅±1.45m）に埋もれず、船（全長20m級）を隠さない大きさ */
const POLE_HEIGHT = 9;
const POLE_RADIUS = 0.45;
const MAX_WAYPOINTS = 8;
const MAX_TRAIL_POINTS = 600;

const COLOR_PLAN = 0x6fb3c7;
const COLOR_DEST = 0xe0c46f;
const COLOR_TRAIL = 0x3a6b7d;
const COLOR_TRAFFIC_PATH = 0xe0708e;

function applyLayer(object) {
  object.layers.set(OVERLAY_LAYER);
  object.traverse((child) => child.layers.set(OVERLAY_LAYER));
  return object;
}

/** 折れ線を1本。点数が変わっても再確保しないよう、最大点数ぶんを先に取っておく */
function makePolyline(maxPoints, color, opacity = 0.9) {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(maxPoints * 3), 3));
  geometry.setDrawRange(0, 0);
  const line = new THREE.Line(
    geometry,
    new THREE.LineBasicMaterial({ color, transparent: true, opacity, depthWrite: false })
  );
  line.frustumCulled = false; // 頂点を毎フレーム書き換えるので境界球が古くなる
  return line;
}

function setPolyline(line, points, y) {
  const attr = line.geometry.getAttribute('position');
  const max = attr.count;
  const n = Math.min(points.length, max);
  for (let i = 0; i < n; i++) {
    attr.setXYZ(i, points[i].eastM ?? points[i].x, y, -(points[i].northM ?? points[i].y));
  }
  attr.needsUpdate = true;
  line.geometry.setDrawRange(0, n);
  line.visible = n >= 2;
}

/**
 * @param {THREE.Scene} scene3d
 * @param {THREE.Camera} overviewCamera - このカメラにだけオーバーレイを見せる
 */
export function createPlanOverlay(scene3d, overviewCamera) {
  // 俯瞰カメラはレイヤー0（通常のシーン）とオーバーレイの両方を見る
  overviewCamera.layers.enable(OVERLAY_LAYER);

  const root = new THREE.Group();
  root.name = 'nav-overlay';
  scene3d.add(root);

  // --- VLM のプラン（航路線 ＋ waypoint の柱）---
  const planLine = makePolyline(MAX_WAYPOINTS + 2, COLOR_PLAN, 0.95);
  root.add(applyLayer(planLine));

  const poleGeometry = new THREE.CylinderGeometry(POLE_RADIUS, POLE_RADIUS, POLE_HEIGHT, 8);
  const poleMaterial = new THREE.MeshBasicMaterial({ color: COLOR_PLAN, transparent: true, opacity: 0.85 });
  const knobGeometry = new THREE.SphereGeometry(POLE_RADIUS * 2.4, 10, 8);
  /** @type {THREE.Group[]} 使い回すマーカー。プランの点数が変わっても生成し直さない */
  const poles = [];
  for (let i = 0; i < MAX_WAYPOINTS; i++) {
    const g = new THREE.Group();
    const pole = new THREE.Mesh(poleGeometry, poleMaterial);
    pole.position.y = POLE_HEIGHT / 2;
    g.add(pole);
    const knob = new THREE.Mesh(knobGeometry, poleMaterial);
    knob.position.y = POLE_HEIGHT;
    g.add(knob);
    g.visible = false;
    root.add(applyLayer(g));
    poles.push(g);
  }

  // --- 目的地（到達半径のリング ＋ 縦のビーコン）---
  const destGroup = new THREE.Group();
  const destRing = new THREE.Mesh(
    new THREE.RingGeometry(1, 1.06, 64),
    new THREE.MeshBasicMaterial({ color: COLOR_DEST, transparent: true, opacity: 0.8, side: THREE.DoubleSide })
  );
  destRing.rotation.x = -Math.PI / 2; // 水平に寝かせる
  destRing.position.y = 0.4;
  destGroup.add(destRing);
  const destBeacon = new THREE.Mesh(
    new THREE.CylinderGeometry(POLE_RADIUS * 0.8, POLE_RADIUS * 0.8, POLE_HEIGHT * 1.8, 8),
    new THREE.MeshBasicMaterial({ color: COLOR_DEST, transparent: true, opacity: 0.7 })
  );
  destBeacon.position.y = POLE_HEIGHT * 0.9;
  destGroup.add(destBeacon);
  destGroup.visible = false;
  root.add(applyLayer(destGroup));

  // --- 自艇の航跡 ---
  const trailLine = makePolyline(MAX_TRAIL_POINTS, COLOR_TRAIL, 0.7);
  root.add(applyLayer(trailLine));

  // --- 交通船の spline 経路（真値。仕込んだ側の設定値なので出しても情報漏れにならない）---
  /** @type {THREE.Line[]} */
  const trafficLines = [];
  function ensureTrafficLines(count) {
    while (trafficLines.length < count) {
      const line = makePolyline(512, COLOR_TRAFFIC_PATH, 0.45);
      root.add(applyLayer(line));
      trafficLines.push(line);
    }
  }

  return {
    root,
    /**
     * 毎フレーム呼ぶ。
     * @param {{selfPose:{eastM:number,northM:number}|null,
     *   waypoints:Array<{eastM:number,northM:number}>,
     *   destination:{eastM:number,northM:number}, arrivalM:number,
     *   trail?:Array<{eastM:number,northM:number}>,
     *   trafficPaths?:Array<{points:Array<{x:number,y:number}>}>}} view
     */
    update({ selfPose, waypoints, destination, arrivalM, trail = [], trafficPaths = null }) {
      // 航路線は「自艇 → 各 waypoint」。自艇から始めないと、次の点までの区間が抜けて見える
      const linePoints = selfPose ? [selfPose, ...waypoints] : waypoints;
      setPolyline(planLine, linePoints, 1.6);

      for (let i = 0; i < poles.length; i++) {
        const wp = waypoints[i];
        if (!wp) {
          poles[i].visible = false;
          continue;
        }
        poles[i].position.set(wp.eastM, 0, -wp.northM);
        poles[i].visible = true;
      }

      if (destination) {
        destGroup.position.set(destination.eastM, 0, -destination.northM);
        destRing.scale.set(arrivalM, arrivalM, 1);
        destGroup.visible = true;
      } else {
        destGroup.visible = false;
      }

      setPolyline(trailLine, trail, 0.9);

      if (trafficPaths) {
        ensureTrafficLines(trafficPaths.length);
        for (let i = 0; i < trafficLines.length; i++) {
          if (i < trafficPaths.length) setPolyline(trafficLines[i], trafficPaths[i].points, 0.7);
          else trafficLines[i].visible = false;
        }
      }
    },
    setVisible(visible) {
      root.visible = visible;
    },
  };
}
