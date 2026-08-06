/**
 * scene_builder.js — SceneGeometry（②） → Three.jsシーン構築
 *
 * core側は3D描画の詳細を一切知らない。ここが唯一Three.jsに依存する境界。
 *
 * 重要な設計判断: 「見た目を確認するための俯瞰カメラ（overviewCamera）」と
 * 「船体センサーとして画像を取得するためのカメラ（sensorCamera）」を別インスタンスにしている。
 * 同一カメラを使い回すと、センサー取得時にカメラが船のすぐ後ろへ移動し、
 * その後の通常描画までその位置のまま残ってしまう（＝画面全体が船で埋まる不具合の原因だった）。
 */

import * as THREE from 'three';
import { buildLandmarks } from './landmarks.js';

const WATER_VERTEX_SHADER = `
  uniform float uTime;
  varying vec3 vWorldPos;
  varying float vWave;

  void main() {
    vec3 pos = position;
    float wave =
      sin(pos.x * 0.045 + uTime * 1.3) * 0.55 +
      sin(pos.y * 0.07 - uTime * 0.9) * 0.35 +
      sin((pos.x + pos.y) * 0.02 + uTime * 0.55) * 0.5;
    pos.z += wave;
    vWave = wave;
    vec4 worldPos = modelMatrix * vec4(pos, 1.0);
    vWorldPos = worldPos.xyz;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(pos, 1.0);
  }
`;

const WATER_FRAGMENT_SHADER = `
  uniform vec3 uDeepColor;
  uniform vec3 uShallowColor;
  uniform vec3 uSunDir;
  uniform vec3 uCameraPos;
  varying vec3 vWorldPos;
  varying float vWave;

  void main() {
    vec3 dx = dFdx(vWorldPos);
    vec3 dy = dFdy(vWorldPos);
    vec3 normal = normalize(cross(dx, dy));

    float crest = clamp(vWave * 0.5 + 0.5, 0.0, 1.0);
    vec3 base = mix(uDeepColor, uShallowColor, crest * 0.45);

    vec3 viewDir = normalize(uCameraPos - vWorldPos);
    vec3 halfDir = normalize(uSunDir + viewDir);
    float spec = pow(max(dot(normal, halfDir), 0.0), 70.0);
    float fresnel = pow(1.0 - clamp(dot(normal, viewDir), 0.0, 1.0), 3.0);

    vec3 color = base + vec3(1.0, 0.96, 0.85) * spec * 1.1;
    color = mix(color, uShallowColor * 1.4, fresnel * 0.4);

    gl_FragColor = vec4(color, 1.0);
  }
`;

function createSkyTexture() {
  const canvas = document.createElement('canvas');
  canvas.width = 2;
  canvas.height = 256;
  const ctx = canvas.getContext('2d');
  const grad = ctx.createLinearGradient(0, 0, 0, 256);
  grad.addColorStop(0, '#2f7fd6');
  grad.addColorStop(0.55, '#7ec2ea');
  grad.addColorStop(0.8, '#cfeaf5');
  grad.addColorStop(1, '#eef8fa');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, 2, 256);
  const tex = new THREE.CanvasTexture(canvas);
  return tex;
}

function createWakeTexture() {
  const size = 64;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  const grad = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  grad.addColorStop(0, 'rgba(255,255,255,0.9)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, size, size);
  return new THREE.CanvasTexture(canvas);
}

/**
 * 表示用の船体スケール。実寸のASV（数m級）のまま描くと、確立ショットのカメラ距離では
 * 数ピクセルしか無く視認できないため、見せ方として誇張する。
 * センサーカメラ（camera_sensor.js）の距離定数もこの値に揃えて調整すること。
 */
export const SHIP_VISUAL_SCALE = 2.2;
/** 船の基準点（グループ原点）の水面からの高さ。ブリッジカメラの基準にも使う。 */
export const SHIP_DECK_HEIGHT = 1.1 * SHIP_VISUAL_SCALE;

/** 船体形状（Yを船首方向とするローカル座標）。cone時代の外部回転規約（rotation.x=90°→rotation.zで艏首方位）を踏襲する。 */
function buildHullGeometry() {
  const s = SHIP_VISUAL_SCALE;
  const shape = new THREE.Shape();
  shape.moveTo(0, 3.6 * s);
  shape.lineTo(1.05 * s, 1.9 * s);
  shape.lineTo(1.25 * s, -1.9 * s);
  shape.lineTo(0.85 * s, -3.1 * s);
  shape.lineTo(-0.85 * s, -3.1 * s);
  shape.lineTo(-1.25 * s, -1.9 * s);
  shape.lineTo(-1.05 * s, 1.9 * s);
  shape.closePath();
  const geo = new THREE.ExtrudeGeometry(shape, {
    depth: 1.0 * s,
    bevelEnabled: true,
    bevelThickness: 0.18 * s,
    bevelSize: 0.18 * s,
    bevelSegments: 1,
  });
  geo.translate(0, 0, -0.5 * s);
  return geo;
}

/**
 * @param {HTMLCanvasElement} canvas
 * @param {import('../core/scene/scene_format.js').SceneGeometry} scene
 */
export function buildThreeScene(canvas, scene, options = {}) {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(canvas.clientWidth, canvas.clientHeight, false);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.15;
  renderer.outputColorSpace = THREE.SRGBColorSpace;

  const scene3d = new THREE.Scene();
  scene3d.background = createSkyTexture();
  // 遠景ランドマーク（富士山など）を霞ませて見せるため、fogの終端を遠くまで延ばす。晴天の明るい霞色にする
  scene3d.fog = new THREE.Fog(0xcfe9f5, 700, 7200);

  // 遠景の背景装飾（東京湾らしさを出す任意の見た目要素）。
  // シミュレーション・センサーロジックには関与しない、純粋な装飾なので、
  // 問題が出た場合はこの1行を削るだけで安全に無効化できる。
  scene3d.add(buildLandmarks());

  const { minX, maxX, minY, maxY } = scene.bounds;
  // 俯瞰カメラのオービット中心は「陸地＋運用エリアの中間点」ではなく、
  // 実際に船が動く場所（focus、通常はspawnsの重心）に合わせる。
  // bounds中心のままだと、陸地と海の間の中途半端な点を向いてしまい、船が画角に入らないことがあった。
  const center = options.focus ?? { x: (minX + maxX) / 2, y: (minY + maxY) / 2 };
  const span = Math.max(maxX - minX, maxY - minY, 200);

  const overviewCamera = new THREE.PerspectiveCamera(
    52,
    canvas.clientWidth / Math.max(canvas.clientHeight, 1),
    1,
    9000
  );
  const sensorCamera = new THREE.PerspectiveCamera(
    70,
    canvas.clientWidth / Math.max(canvas.clientHeight, 1),
    0.3,
    3000
  );

  const sunDir = new THREE.Vector3(0.5, 0.8, 0.35).normalize();
  const hemi = new THREE.HemisphereLight(0xdcf0ff, 0x4a6a4a, 1.5);
  scene3d.add(hemi);
  const sun = new THREE.DirectionalLight(0xfff8e6, 2.0);
  sun.position.copy(sunDir).multiplyScalar(1200).add(new THREE.Vector3(center.x, 0, -center.y));
  sun.castShadow = true;
  sun.shadow.mapSize.set(1024, 1024);
  sun.shadow.camera.left = -span;
  sun.shadow.camera.right = span;
  sun.shadow.camera.top = span;
  sun.shadow.camera.bottom = -span;
  sun.shadow.camera.far = 3000;
  scene3d.add(sun);
  scene3d.add(sun.target);

  const waterUniforms = {
    uTime: { value: 0 },
    uDeepColor: { value: new THREE.Color(0x0f6788) },
    uShallowColor: { value: new THREE.Color(0x59c2d6) },
    uSunDir: { value: sunDir },
    uCameraPos: { value: new THREE.Vector3() },
  };
  const waterMaterial = new THREE.ShaderMaterial({
    uniforms: waterUniforms,
    vertexShader: WATER_VERTEX_SHADER,
    fragmentShader: WATER_FRAGMENT_SHADER,
  });
  const waterGeo = new THREE.PlaneGeometry(span * 1.8, span * 1.8, 120, 120);
  const water = new THREE.Mesh(waterGeo, waterMaterial);
  water.rotation.x = -Math.PI / 2;
  water.position.set(center.x, 0, -center.y);
  scene3d.add(water);

  // 海岸線（ローカル座標 x,y）を Three.js の x,z 平面へ投影して押し出す
  const shape = new THREE.Shape();
  scene.coastline.forEach((p, i) => {
    if (i === 0) shape.moveTo(p.x, -p.y);
    else shape.lineTo(p.x, -p.y);
  });
  // 水面（y=0付近、波の振幅は約±1.4）と陸地が同一平面で重なるとZファイティングを起こすため、
  // 陸地の底面ははっきり下（-15）、頂面ははっきり上（+3）まで突き出す
  const land = new THREE.Mesh(
    new THREE.ExtrudeGeometry(shape, { depth: 18, bevelEnabled: false }),
    new THREE.MeshStandardMaterial({ color: 0x5a7a3e, roughness: 1 })
  );
  land.rotation.x = -Math.PI / 2;
  land.position.y = -15;
  land.receiveShadow = true;
  scene3d.add(land);

  const hullGeometry = buildHullGeometry();
  const deckMaterial = new THREE.MeshStandardMaterial({ color: 0xe7ecec, roughness: 0.6 });
  const wakeTexture = createWakeTexture();

  const ships = new Map(); // id -> { group, hull, wake, wakeMat }

  function ensureShip(id, faction) {
    if (ships.has(id)) return ships.get(id);
    // 遠目・逆光でも水面から識別できるよう、はっきりした高彩度色にする
    const hullColor = faction === 'defender' ? 0x1f9fe0 : 0xe6394f;
    const lightColor = faction === 'defender' ? 0x4fd6ff : 0xff5a5a;

    const s = SHIP_VISUAL_SCALE;
    const group = new THREE.Group();
    group.rotation.x = Math.PI / 2; // cone時代と同じ外部回転規約。以後は毎フレーム rotation.z のみ更新する

    const hull = new THREE.Mesh(hullGeometry, new THREE.MeshStandardMaterial({ color: hullColor, roughness: 0.4, metalness: 0.1 }));
    hull.castShadow = true;
    hull.receiveShadow = true;
    group.add(hull);

    const deck = new THREE.Mesh(new THREE.BoxGeometry(1.1 * s, 0.9 * s, 1.0 * s), deckMaterial);
    deck.position.set(0, 0.55 * s, -0.8 * s);
    deck.castShadow = true;
    group.add(deck);

    // センサーマスト＋ドーム: ASVが観測機器を積んでいることを示す装飾（レーダー/カメラの実体ではない）
    const mastMat = new THREE.MeshStandardMaterial({ color: 0xd7dede, roughness: 0.5 });
    const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.06 * s, 0.08 * s, 1.0 * s, 6), mastMat);
    mast.position.set(0, 1.5 * s, -0.8 * s);
    group.add(mast);
    const sensorDome = new THREE.Mesh(
      new THREE.SphereGeometry(0.22 * s, 10, 6, 0, Math.PI * 2, 0, Math.PI / 1.7),
      new THREE.MeshStandardMaterial({ color: 0xf2f5f5, roughness: 0.3 })
    );
    sensorDome.position.set(0, 2.0 * s, -0.8 * s);
    group.add(sensorDome);

    // 航海灯: 遠距離でも視認できる小さな発光点（実際の航海灯の役割も兼ねる）
    const navLight = new THREE.Mesh(
      new THREE.SphereGeometry(0.35 * s, 8, 8),
      new THREE.MeshStandardMaterial({ color: lightColor, emissive: lightColor, emissiveIntensity: 2.2 })
    );
    navLight.position.set(0, 1.3 * s, -0.8 * s);
    group.add(navLight);

    // 加算合成で「光る航跡」にする（参考にした操船シミュレータのwakeスプライトと同じ狙い）
    const wakeMat = new THREE.MeshBasicMaterial({
      map: wakeTexture,
      color: 0xeaffff,
      transparent: true,
      opacity: 0,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    const wake = new THREE.Mesh(new THREE.PlaneGeometry(3.2 * s, 14 * s), wakeMat);
    wake.rotation.x = -Math.PI / 2;
    wake.position.set(0, 0.05 * s, -8.5 * s);
    group.add(wake);

    scene3d.add(group);
    const entry = { group, wakeMat };
    ships.set(id, entry);
    return entry;
  }

  /** @param {Array<{id:string, faction:string, x:number, y:number, heading:number, speed:number}>} entities */
  function updateShips(entities) {
    for (const e of entities) {
      const { group, wakeMat } = ensureShip(e.id, e.faction);
      group.position.set(e.x, 1.1 * SHIP_VISUAL_SCALE, -e.y);
      group.rotation.z = -e.heading;
      wakeMat.opacity = THREE.MathUtils.clamp((e.speed ?? 0) / 6, 0, 1) * 0.85;
    }
  }

  let orbitAngle = 0;
  // オービット半径は海岸線全体のspanではなく、focus（船団の重心）まわりの
  // 一定の観覧距離にする。spanに比例させると陸地込みの広い範囲を回ってしまい、
  // 肝心の船から離れすぎる時間帯ができてしまうため。
  const orbitRadius = 85;
  function updateOverviewCamera(dt) {
    orbitAngle += dt * 0.05;
    const radius = orbitRadius;
    overviewCamera.position.set(
      center.x + Math.cos(orbitAngle) * radius,
      radius * 0.32,
      -center.y + Math.sin(orbitAngle) * radius
    );
    overviewCamera.lookAt(center.x, 4, -center.y);
  }

  function render(elapsedSeconds) {
    waterUniforms.uTime.value = elapsedSeconds;
    waterUniforms.uCameraPos.value.copy(overviewCamera.position);
    renderer.render(scene3d, overviewCamera);
  }

  function resize() {
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    renderer.setSize(w, h, false);
    for (const cam of [overviewCamera, sensorCamera]) {
      cam.aspect = w / Math.max(h, 1);
      cam.updateProjectionMatrix();
    }
  }

  return {
    renderer,
    overviewCamera,
    sensorCamera,
    scene3d,
    updateShips,
    updateOverviewCamera,
    render,
    resize,
    center,
  };
}
