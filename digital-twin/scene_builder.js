/**
 * scene_builder.js — SceneGeometry（②） → Three.jsシーン構築
 *
 * core側は3D描画の詳細を一切知らない。ここが唯一Three.jsに依存する境界。
 */

import * as THREE from 'three';

/**
 * @param {HTMLCanvasElement} canvas
 * @param {import('../core/scene/scene_format.js').SceneGeometry} scene
 */
export function buildThreeScene(canvas, scene) {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(canvas.clientWidth, canvas.clientHeight, false);

  const scene3d = new THREE.Scene();
  scene3d.background = new THREE.Color(0x06121a);
  scene3d.fog = new THREE.Fog(0x06121a, 200, 1400);

  const camera = new THREE.PerspectiveCamera(
    60,
    canvas.clientWidth / Math.max(canvas.clientHeight, 1),
    0.5,
    5000
  );
  camera.position.set(0, 120, 220);
  camera.lookAt(0, 0, 0);

  scene3d.add(new THREE.HemisphereLight(0xbfe3ff, 0x1a2a1a, 1.1));
  const sun = new THREE.DirectionalLight(0xffffff, 0.7);
  sun.position.set(300, 400, 150);
  scene3d.add(sun);

  const { minX, maxX, minY, maxY } = scene.bounds;
  const width = Math.max(maxX - minX, 100) * 1.6;
  const depth = Math.max(maxY - minY, 100) * 1.6;

  const water = new THREE.Mesh(
    new THREE.PlaneGeometry(width, depth, 1, 1),
    new THREE.MeshStandardMaterial({ color: 0x0a3d52, roughness: 0.85, metalness: 0.1 })
  );
  water.rotation.x = -Math.PI / 2;
  scene3d.add(water);

  // 海岸線（ローカル座標 x,y）を Three.js の x,z 平面へ投影して押し出す
  const shape = new THREE.Shape();
  scene.coastline.forEach((p, i) => {
    if (i === 0) shape.moveTo(p.x, -p.y);
    else shape.lineTo(p.x, -p.y);
  });
  const land = new THREE.Mesh(
    new THREE.ExtrudeGeometry(shape, { depth: 6, bevelEnabled: false }),
    new THREE.MeshStandardMaterial({ color: 0x2f3a2a, roughness: 1 })
  );
  land.rotation.x = -Math.PI / 2;
  land.position.y = -6;
  scene3d.add(land);

  const shipMeshes = new Map();

  function ensureShip(id, faction) {
    if (shipMeshes.has(id)) return shipMeshes.get(id);
    const color = faction === 'defender' ? 0x4fb8d6 : 0xe0708e;
    const mesh = new THREE.Mesh(
      new THREE.ConeGeometry(2.2, 7, 8),
      new THREE.MeshStandardMaterial({ color })
    );
    mesh.rotation.x = Math.PI / 2;
    scene3d.add(mesh);
    shipMeshes.set(id, mesh);
    return mesh;
  }

  /** @param {Array<{id:string, faction:string, x:number, y:number, heading:number}>} entities */
  function updateShips(entities) {
    for (const e of entities) {
      const mesh = ensureShip(e.id, e.faction);
      mesh.position.set(e.x, 2, -e.y);
      mesh.rotation.z = -e.heading;
    }
  }

  function render() {
    renderer.render(scene3d, camera);
  }

  function resize() {
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    renderer.setSize(w, h, false);
    camera.aspect = w / Math.max(h, 1);
    camera.updateProjectionMatrix();
  }

  return { renderer, camera, scene3d, updateShips, ensureShip, render, resize };
}
