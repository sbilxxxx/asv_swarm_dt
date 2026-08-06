/**
 * landmarks.js — 遠景の背景装飾（東京湾らしさを出すためのスタイライズされたランドマーク群）
 *
 * シミュレーション・センサーロジックには一切関与しない、純粋な見た目の背景。
 * 低ポリゴンの原始形状のみで構成し、外部アセット・テクスチャへの依存を持たない
 * （NFR2: サーバー不要・ビルド不要の方針を維持するため）。
 * 舞台を東京湾以外に差し替える場合は、このファイルごと入れ替える／呼び出しを外せばよい。
 */

import * as THREE from 'three';

function mulberry32(seed) {
  let a = seed;
  return function rng() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function buildSkyline(rng) {
  const group = new THREE.Group();
  const mat = new THREE.MeshStandardMaterial({ color: 0x2f3d4d, roughness: 0.85 });
  const litMat = new THREE.MeshStandardMaterial({
    color: 0x3a4a5c,
    roughness: 0.6,
    emissive: 0x1c2636,
    emissiveIntensity: 0.5,
  });
  for (let i = 0; i < 30; i++) {
    const w = 14 + rng() * 22;
    const d = 14 + rng() * 22;
    const h = 30 + rng() * 150;
    const box = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), i % 3 === 0 ? litMat : mat);
    box.position.set((rng() - 0.5) * 1700, h / 2, -1150 - rng() * 220);
    box.castShadow = false;
    group.add(box);
  }
  return group;
}

function buildTokyoTower() {
  const group = new THREE.Group();
  const orange = new THREE.MeshStandardMaterial({ color: 0xe8552f, roughness: 0.6 });
  const white = new THREE.MeshStandardMaterial({ color: 0xf5f0e8, roughness: 0.6 });
  const base = new THREE.Mesh(new THREE.CylinderGeometry(10, 52, 150, 4), orange);
  base.position.y = 75;
  const mid = new THREE.Mesh(new THREE.CylinderGeometry(4, 12, 120, 4), orange);
  mid.position.y = 205;
  const deck1 = new THREE.Mesh(new THREE.BoxGeometry(26, 10, 26), white);
  deck1.position.y = 150;
  const deck2 = new THREE.Mesh(new THREE.BoxGeometry(14, 8, 14), white);
  deck2.position.y = 255;
  const antenna = new THREE.Mesh(new THREE.CylinderGeometry(0.8, 0.8, 70, 6), white);
  antenna.position.y = 300;
  group.add(base, mid, deck1, deck2, antenna);
  group.position.set(260, 0, -1180);
  return group;
}

/** レインボーブリッジ: 主塔＋桁に加え、吊りケーブルを放物線（CatmullRomCurve3+TubeGeometry）で表現する */
function buildRainbowBridge() {
  const group = new THREE.Group();
  const white = new THREE.MeshStandardMaterial({ color: 0xecebe4, roughness: 0.5 });
  const towerGeo = new THREE.BoxGeometry(6, 92, 6);
  [-150, 150].forEach((tx) => {
    const tower = new THREE.Mesh(towerGeo, white);
    tower.position.set(tx, 46, 0);
    group.add(tower);
  });
  const deck = new THREE.Mesh(new THREE.BoxGeometry(370, 5, 9), white);
  deck.position.set(0, 24, 0);
  group.add(deck);

  const cableMat = new THREE.MeshStandardMaterial({ color: 0xe8ecef, roughness: 0.4 });
  [-4.5, 4.5].forEach((tz) => {
    const pts = [];
    for (let i = 0; i <= 40; i++) {
      const x = -185 + i * (370 / 40);
      const ax = Math.abs(x);
      const y = ax > 150 ? 30 + 28 * ((ax - 150) / 35) ** 2 : 30 + 28 * (x / 150) ** 2;
      pts.push(new THREE.Vector3(x, y, tz));
    }
    const curve = new THREE.CatmullRomCurve3(pts);
    const tube = new THREE.Mesh(new THREE.TubeGeometry(curve, 50, 0.5, 6, false), cableMat);
    group.add(tube);
  });

  group.position.set(1500, 0, -250);
  group.rotation.y = Math.PI / 2;
  return group;
}

/** ガントリークレーン: 末広がりのA型脚＋逆側の短いカウンターブーム＋トロリーを付け、実機に近いシルエットにする */
function buildGantryCrane() {
  const group = new THREE.Group();
  const mat = new THREE.MeshStandardMaterial({ color: 0x3f6f9a, roughness: 0.7 });
  const legGeo = new THREE.BoxGeometry(2, 34, 2);
  [
    [-17, 6, -0.12],
    [17, 6, -0.12],
    [-17, -6, 0.12],
    [17, -6, 0.12],
  ].forEach(([lx, lz, rotX]) => {
    const leg = new THREE.Mesh(legGeo, mat);
    leg.position.set(lx, 17, lz);
    leg.rotation.x = rotX;
    group.add(leg);
  });
  const beam = new THREE.Mesh(new THREE.BoxGeometry(40, 2, 2), mat);
  beam.position.set(0, 34, 0);
  const boom = new THREE.Mesh(new THREE.BoxGeometry(58, 1.6, 1.6), mat);
  boom.position.set(9, 34, 0);
  const counterBoom = new THREE.Mesh(new THREE.BoxGeometry(16, 1.6, 1.6), mat);
  counterBoom.position.set(-24, 34, 0);
  const trolleyMat = new THREE.MeshStandardMaterial({ color: 0xd9b23a, roughness: 0.6 });
  const trolley = new THREE.Mesh(new THREE.BoxGeometry(3, 2, 3), trolleyMat);
  trolley.position.set(20, 32.5, 0);
  group.add(beam, boom, counterBoom, trolley);
  return group;
}

/** コンテナ船（バース係留）。二トーンの船体＋色付きコンテナ＋船橋の組み合わせで、単純形状でも「らしく」見せる */
function buildContainerShip() {
  const group = new THREE.Group();
  const hullMat = new THREE.MeshStandardMaterial({ color: 0x5a3a30, roughness: 0.8 });
  const deckMat = new THREE.MeshStandardMaterial({ color: 0x8a8f92, roughness: 0.8 });
  const bridgeMat = new THREE.MeshStandardMaterial({ color: 0xe8e3da, roughness: 0.6 });
  const containerColors = [0x3a6fb0, 0xc25b3f, 0x4aa06a, 0xd9b23a, 0x3a6fb0, 0xc25b3f];

  const hull = new THREE.Mesh(new THREE.BoxGeometry(100, 9, 16), hullMat);
  hull.position.y = 4.5;
  group.add(hull);

  const deck = new THREE.Mesh(new THREE.BoxGeometry(99, 1, 15), deckMat);
  deck.position.y = 9.5;
  group.add(deck);

  containerColors.forEach((color, i) => {
    const mat = new THREE.MeshStandardMaterial({ color, roughness: 0.7 });
    const c = new THREE.Mesh(new THREE.BoxGeometry(9, 7, 11), mat);
    c.position.set(-37 + i * 14, 13.5, 0);
    group.add(c);
  });

  const bridge = new THREE.Mesh(new THREE.BoxGeometry(13, 14, 13), bridgeMat);
  bridge.position.set(40, 17, 0);
  group.add(bridge);

  const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.5, 0.5, 10, 6), deckMat);
  mast.position.set(40, 29, 0);
  group.add(mast);

  return group;
}

function buildWarehouse(length) {
  const mat = new THREE.MeshStandardMaterial({ color: 0x8a8f92, roughness: 0.9 });
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(length, 11, 20), mat);
  mesh.position.y = 5.5;
  return mesh;
}

function buildQuayWall(length) {
  const mat = new THREE.MeshStandardMaterial({ color: 0x9a9a92, roughness: 1 });
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(length, 3, 7), mat);
  mesh.position.y = 1.5;
  return mesh;
}

function buildPort(rng) {
  const group = new THREE.Group();
  const shoreZ = -330; // 陸地南端付近の岸壁ライン
  const quay = buildQuayWall(1500);
  quay.position.set(0, 1.5, shoreZ);
  group.add(quay);

  for (let i = 0; i < 4; i++) {
    const crane = buildGantryCrane();
    crane.position.set(-650 + i * 220 + rng() * 20, 0, shoreZ - 14);
    group.add(crane);
  }
  for (let i = 0; i < 5; i++) {
    const wh = buildWarehouse(70 + rng() * 30);
    wh.position.set(-500 + i * 260 + rng() * 30, 0, shoreZ - 60 - rng() * 20);
    group.add(wh);
  }

  const ship = buildContainerShip();
  ship.position.set(280, 0, shoreZ - 18);
  group.add(ship);

  return group;
}

function buildMountFuji() {
  const group = new THREE.Group();
  const bodyMat = new THREE.MeshStandardMaterial({ color: 0x5f6f7a, roughness: 1 });
  const snowMat = new THREE.MeshStandardMaterial({ color: 0xf4f7f8, roughness: 0.85 });
  // 単純な円錐一つに絞る。裾野に別メッシュで広がりを足そうとすると、
  // 低い視点からはUFOのような円盤状に見えてしまうため（スクリーンショットで確認済み）。
  const body = new THREE.Mesh(new THREE.ConeGeometry(1500, 780, 44), bodyMat);
  body.position.y = 390;
  const snow = new THREE.Mesh(new THREE.ConeGeometry(400, 220, 44), snowMat);
  snow.position.y = 780 - 90;
  group.add(body, snow);
  group.position.set(-2100, 0, -5600);
  return group;
}

/** フジテレビ本社ビル風: 2本の角柱＋渡り廊下＋球体展望室 */
function buildFujiTvBuilding() {
  const group = new THREE.Group();
  const mat = new THREE.MeshStandardMaterial({ color: 0xb8bec4, roughness: 0.5 });
  const ballMat = new THREE.MeshStandardMaterial({ color: 0xc7ccd1, roughness: 0.3, metalness: 0.2 });
  [-28, 28].forEach((tx) => {
    const tower = new THREE.Mesh(new THREE.BoxGeometry(13, 60, 13), mat);
    tower.position.set(tx, 30, 0);
    group.add(tower);
  });
  for (let i = 0; i < 4; i++) {
    const beam = new THREE.Mesh(new THREE.BoxGeometry(56, 3, 9), mat);
    beam.position.set(0, 16 + i * 12, 0);
    group.add(beam);
  }
  const ball = new THREE.Mesh(new THREE.SphereGeometry(11, 18, 14), ballMat);
  ball.position.set(0, 48, 0);
  group.add(ball);
  return group;
}

/** 観覧車: 装飾のみ（アニメーションなし）。トーラス＋放射状スポーク＋支柱 */
function buildFerrisWheel() {
  const group = new THREE.Group();
  const ringMat = new THREE.MeshStandardMaterial({ color: 0xe06a8a, roughness: 0.5 });
  const ring = new THREE.Mesh(new THREE.TorusGeometry(24, 1.1, 8, 28), ringMat);
  group.add(ring);
  const spokeMat = new THREE.MeshStandardMaterial({ color: 0xd0d4d8, roughness: 0.6 });
  for (let i = 0; i < 8; i++) {
    const spoke = new THREE.Mesh(new THREE.BoxGeometry(1.2, 48, 1.2), spokeMat);
    spoke.rotation.z = (i * Math.PI) / 8;
    group.add(spoke);
  }
  [-7, 7].forEach((lx) => {
    const leg = new THREE.Mesh(new THREE.CylinderGeometry(1.2, 1.6, 28, 6), spokeMat);
    leg.position.set(lx, -14, 0.7);
    leg.rotation.x = 0.15;
    group.add(leg);
  });
  return group;
}

/** お台場: 埋立地＋フジテレビビル＋観覧車。港湾とは別の、湾内に浮かぶ小島として配置する */
function buildOdaiba() {
  const group = new THREE.Group();
  const islandMat = new THREE.MeshStandardMaterial({ color: 0x5a7a3e, roughness: 1 });
  const island = new THREE.Mesh(new THREE.CylinderGeometry(140, 155, 14, 28), islandMat);
  island.position.y = -3;
  group.add(island);

  const tv = buildFujiTvBuilding();
  tv.position.set(-25, 4, -20);
  group.add(tv);

  const wheel = buildFerrisWheel();
  wheel.position.set(55, 52, 15);
  group.add(wheel);

  group.position.set(700, 0, 700);
  return group;
}

/** @returns {THREE.Group} シーンに一度だけ追加する背景装飾一式 */
export function buildLandmarks() {
  const rng = mulberry32(20260807);
  const group = new THREE.Group();
  group.add(buildSkyline(rng));
  group.add(buildTokyoTower());
  group.add(buildRainbowBridge());
  group.add(buildPort(rng));
  group.add(buildMountFuji());
  group.add(buildOdaiba());
  return group;
}
