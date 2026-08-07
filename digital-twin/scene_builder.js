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

/**
 * 波の合成パラメータ（単一の情報源）。
 * 水面の頂点シェーダーと、船を波に追従させるJS側の計算の両方がこの定義を使う。
 * どちらか片方だけ変更すると「水面と船の波が食い違う」ため、必ずここだけを編集する。
 * 各項: 振幅 * sin(kx*x + ky*y + speed*t)
 */
const WAVE_TERMS = [
  { amp: 0.35, kx: 0.045, ky: 0.0, speed: 1.3 },
  { amp: 0.22, kx: 0.0, ky: 0.07, speed: -0.9 },
  { amp: 0.3, kx: 0.02, ky: 0.02, speed: 0.55 },
];

/**
 * 水面高さ（ワールドXZ平面上の点における波の変位）。
 * 引数は水面メッシュのローカル座標系（回転前のXY）に合わせる。
 */
function waveHeightAt(x, y, t) {
  let sum = 0;
  for (const w of WAVE_TERMS) {
    sum += w.amp * Math.sin(w.kx * x + w.ky * y + w.speed * t);
  }
  return sum;
}

/** GLSLはintとfloatの暗黙変換をしないため、必ず小数点付きのリテラルとして埋め込む */
function glslFloat(n) {
  return Number.isInteger(n) ? `${n}.0` : `${n}`;
}

const WATER_VERTEX_SHADER = `
  uniform float uTime;
  varying vec3 vWorldPos;
  varying float vWave;

  void main() {
    vec3 pos = position;
    float wave =
${WAVE_TERMS.map(
  (w) =>
    `      ${glslFloat(w.amp)} * sin(pos.x * ${glslFloat(w.kx)} + pos.y * ${glslFloat(w.ky)} + uTime * ${glslFloat(w.speed)})`
).join(' +\n')};
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
/**
 * 船の基準点（グループ原点）の水面からの高さ。ブリッジカメラの基準にも使う。
 * 船体ジオメトリは原点まわり ±0.5*SHIP_VISUAL_SCALE に広がるため、この値が大きすぎると
 * 船が水面から浮いて見える（実測で判明）。喫水線が船体下部に来る高さにする。
 */
export const SHIP_DECK_HEIGHT = 0.3 * SHIP_VISUAL_SCALE;

/**
 * 船体形状。ジオメトリ側で向きを正規化し、船グループは
 * 「+X が船首、+Y が上、±Z が舷側」という素直な座標系で扱えるようにする。
 *
 * 以前はグループに rotation.x = π/2 を掛けたまま子要素を配置していたため、
 * 上下と前後の軸が入れ替わり、航跡が垂直の光柱になる不具合を生んでいた。
 * ここで正規化しておけば、rotation.y = 針路 / rotation.x = ピッチ / rotation.z = ロール
 * がそのまま使える。
 */
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
  geo.translate(0, 0, -0.5 * s); // 押し出し方向の中心を原点へ
  // 押し出し直後は「+Y=船首 / +Z=船体厚み」。これを「+X=船首 / +Y=上」へ正規化する
  geo.rotateX(-Math.PI / 2);
  geo.rotateY(-Math.PI / 2);
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
  // 水面は視界いっぱいに広げる。狭いと船上のブリッジカメラから水面の縁が見えてしまう
  // （海が「板」に見え、デジタルツインとしての説得力を損なう）。
  const waterExtent = Math.max(span * 4, 9000);
  const waterGeo = new THREE.PlaneGeometry(waterExtent, waterExtent, 160, 160);
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
    // 座標系: +X が船首、+Y が上、±Z が舷側（ジオメトリ側で正規化済み）
    const group = new THREE.Group();
    group.rotation.order = 'YXZ'; // ヨー(針路) → ピッチ → ロール の順で適用する

    const hull = new THREE.Mesh(hullGeometry, new THREE.MeshStandardMaterial({ color: hullColor, roughness: 0.4, metalness: 0.1 }));
    hull.castShadow = true;
    hull.receiveShadow = true;
    group.add(hull);

    // 操舵室（ブリッジ）。カメラの搭載位置に対応する
    const deck = new THREE.Mesh(new THREE.BoxGeometry(1.0 * s, 0.9 * s, 1.1 * s), deckMaterial);
    deck.position.set(-0.55 * s, 0.85 * s, 0);
    deck.castShadow = true;
    group.add(deck);

    // 窓（前面）。単色の箱に一本入れるだけで「船らしさ」が出る
    const windshield = new THREE.Mesh(
      new THREE.BoxGeometry(0.08 * s, 0.32 * s, 0.95 * s),
      new THREE.MeshStandardMaterial({ color: 0x17323f, roughness: 0.25, metalness: 0.4 })
    );
    windshield.position.set(-0.12 * s, 0.95 * s, 0);
    group.add(windshield);

    // センサーマスト＋ドーム: ASVが観測機器を積んでいることを示す装飾（レーダー/カメラの実体ではない）
    const mastMat = new THREE.MeshStandardMaterial({ color: 0xd7dede, roughness: 0.5 });
    const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.06 * s, 0.08 * s, 1.1 * s, 6), mastMat);
    mast.position.set(-0.75 * s, 1.75 * s, 0);
    group.add(mast);
    const sensorDome = new THREE.Mesh(
      new THREE.SphereGeometry(0.24 * s, 10, 6, 0, Math.PI * 2, 0, Math.PI / 1.7),
      new THREE.MeshStandardMaterial({ color: 0xf2f5f5, roughness: 0.3 })
    );
    sensorDome.position.set(-0.75 * s, 2.3 * s, 0);
    group.add(sensorDome);

    // 陣営識別ストライプ（青=防御 / 赤=侵入）。船体側面に入れて遠目でも所属が分かるようにする
    const stripe = new THREE.Mesh(
      new THREE.BoxGeometry(5.2 * s, 0.22 * s, 2.62 * s),
      new THREE.MeshStandardMaterial({ color: lightColor, roughness: 0.5 })
    );
    stripe.position.set(0.1 * s, 0.42 * s, 0);
    group.add(stripe);

    // 航海灯: 遠距離でも視認できる小さな発光点（実際の航海灯の役割も兼ねる）
    const navLight = new THREE.Mesh(
      new THREE.SphereGeometry(0.28 * s, 8, 8),
      new THREE.MeshStandardMaterial({ color: lightColor, emissive: lightColor, emissiveIntensity: 2.4 })
    );
    navLight.position.set(-0.75 * s, 2.75 * s, 0);
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
    // 航跡は水面に寝かせる。PlaneGeometryは既定でXY平面（＝立った状態）なので、
    // rotation.x = -π/2 でXZ平面（水平）へ倒す。長辺(14*s)は回転後に船首尾方向へ向くよう
    // rotation.z で90°回す。ここを間違えると垂直の光柱になる（実測で確認済み）。
    const wake = new THREE.Mesh(new THREE.PlaneGeometry(3.2 * s, 14 * s), wakeMat);
    wake.rotation.x = -Math.PI / 2;
    wake.rotation.z = Math.PI / 2;
    wake.position.set(-8.5 * s, -SHIP_DECK_HEIGHT + 0.25, 0);
    group.add(wake);

    scene3d.add(group);
    const entry = { group, wakeMat };
    ships.set(id, entry);
    return entry;
  }

  // 俯瞰カメラが注視する点。
  // 艇は互いに数百m離れて散開するため、船団の重心を注視すると全艇が画角外に出てしまう
  // （実測: 3艇が約650m散開、オービット半径85mでは1艇も画角に収まらなかった）。
  // このビューの目的はセンサー実証なので、HUDに表示している主役艇（focusEntityId）を追う。
  // スウォーム全体の俯瞰は swarm-sim（2Dビュー）の役割。
  const orbitTarget = new THREE.Vector2(center.x, center.y);
  const focusEntityId = options.focusEntityId ?? null;

  /**
   * 船の位置・姿勢を更新する。
   *
   * 向きの規約: シミュレーション座標は x=東 / y=北、heading は東を0とする反時計回り。
   * Three.js側は x=東 / z=-北。進行方向 (cos h, sin h)[sim] は (cos h, -sin h)[world XZ] に対応する。
   * rotation.y は +X を (cos φ, -sin φ) へ向けるので、φ = heading をそのまま使えばよい
   * （船体ジオメトリを +X=船首 に正規化してあるため）。
   *
   * 併せて波の高さ・勾配から上下動とピッチ・ロールを与え、水面に浮かんでいるように見せる。
   * 波の式は水面シェーダーと同じ WAVE_TERMS を使うので、水面と船の動きが食い違わない。
   */
  function updateShips(entities, elapsedSeconds = 0) {
    let target = null;
    for (const e of entities) {
      const { group, wakeMat } = ensureShip(e.id, e.faction);

      // 波の局所形状。水面メッシュのローカル座標（原点=center）に合わせて評価する
      const wx = e.x - center.x;
      const wy = e.y - center.y;
      const h = waveHeightAt(wx, wy, elapsedSeconds);
      const probe = 3.0; // 前後左右この距離の波高差から傾きを求める
      const hFwd = waveHeightAt(wx + Math.cos(e.heading) * probe, wy + Math.sin(e.heading) * probe, elapsedSeconds);
      const hAft = waveHeightAt(wx - Math.cos(e.heading) * probe, wy - Math.sin(e.heading) * probe, elapsedSeconds);
      const hPort = waveHeightAt(wx - Math.sin(e.heading) * probe, wy + Math.cos(e.heading) * probe, elapsedSeconds);
      const hStbd = waveHeightAt(wx + Math.sin(e.heading) * probe, wy - Math.cos(e.heading) * probe, elapsedSeconds);

      group.position.set(e.x, SHIP_DECK_HEIGHT + h, -e.y);
      group.rotation.y = e.heading;
      group.rotation.x = Math.atan2(hStbd - hPort, 2 * probe) * 0.7; // ロール（'YXZ'順のため2番目がX）
      group.rotation.z = -Math.atan2(hFwd - hAft, 2 * probe) * 0.7; // ピッチ（船首が波を上る）

      wakeMat.opacity = THREE.MathUtils.clamp((e.speed ?? 0) / 6, 0, 1) * 0.85;
      if (e.id === focusEntityId) target = e;
    }
    if (!target && entities.length > 0) target = entities[0];
    if (target) {
      // 急なカメラ移動を避けるため補間で寄せる
      orbitTarget.lerp(new THREE.Vector2(target.x, target.y), 0.08);
    }
  }

  let orbitAngle = 0;
  // 主役艇が画面内で十分な大きさに見える距離。遠すぎると数ピクセルになり、
  // 近すぎると背景（湾・ランドマーク）が入らずデジタルツインらしさが伝わらない。
  const orbitRadius = 46;
  function updateOverviewCamera(dt) {
    orbitAngle += dt * 0.12;
    const radius = orbitRadius;
    overviewCamera.position.set(
      orbitTarget.x + Math.cos(orbitAngle) * radius,
      radius * 0.34,
      -orbitTarget.y + Math.sin(orbitAngle) * radius
    );
    // HUDパネルが画面上部を占めるため、注視点をやや上に置いて艇を画面下寄りに収める
    overviewCamera.lookAt(orbitTarget.x, 9, -orbitTarget.y);
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
