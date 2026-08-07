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
 * landmarkSet名 → ランドマーク群のビルダー関数。
 * レビューB-8対応: 以前はscene_builder.jsが無条件にbuildLandmarks()（東京タワー・
 * レインボーブリッジ・富士山・お台場をハードコード）を呼んでおり、シナリオを別海域に
 * 差し替えても東京の景観が描かれてしまい「海域を固定しない」という原則に反していた。
 * 既知のlandmarkSetが指定されたときだけ、対応するビルダーを描画する。landmarks.js自体は
 * 東京湾セット専用のままでよい（buildLandmarksという名前のまま、tokyo_bayキーで登録する）。
 */
const LANDMARK_BUILDERS = {
  tokyo_bay: buildLandmarks,
};

/**
 * 波の合成パラメータ（単一の情報源）。
 * 水面の頂点シェーダーと、船を波に追従させるJS側の計算の両方がこの定義を使う。
 * どちらか片方だけ変更すると「水面と船の波が食い違う」ため、必ずここだけを編集する。
 * 各項: 振幅 * sin(kx*x + ky*y + speed*t)
 */
// 品質向上計画 優先度4: 振幅を実測で約1.7倍に引き上げた（0.35/0.22/0.3 → 0.55/0.4/0.5）。
// 海面LOD導入（近傍600m四方・128分割＝1マス4.7m）でサンプリング解像度は足りていたが、
// それでも実際のゲーム視点（オービット半径46）に近い距離のスクリーンショットで波がほぼ見えなかった
// （元の振幅は最大でも±0.87、傾き1〜2度程度と非常に緩やかなため）。波長・伝播速度は変えていない
// （「やらないこと」＝波の物理的忠実性の追求とは別軸の調整。見た目の可視性はこの計画の目的そのもの）。
const WAVE_TERMS = [
  { amp: 0.55, kx: 0.045, ky: 0.0, speed: 1.3 },
  { amp: 0.4, kx: 0.0, ky: 0.07, speed: -0.9 },
  { amp: 0.5, kx: 0.02, ky: 0.02, speed: 0.55 },
];

/**
 * 水面高さ（シミュレーション座標 x, y の点における波の変位）。
 * 水面シェーダー側もワールド座標＝シミュレーション座標基準で位相を評価するため
 * （海面LODで近傍・遠方の2パッチが波の位相を共有するために必要。scene_builder.js内WATER_VERTEX_SHADER参照）、
 * ここも center 等でオフセットせず、シミュレーション座標をそのまま渡す。
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

// 波高の理論上の最大絶対値（全項の振幅を単純合計＝実際にはほぼ起こらない上限値）。
// フラグメントシェーダーの crest（0..1正規化）がこれを基準に正規化するため、WAVE_TERMSと必ず連動させる。
// これが無いと「crestは vWave が ±1 に収まる前提」のまま振幅だけ増やすことになり、
// 大きい波高がclampで頭打ちになって、大きくした意味の分だけ逆に見た目の階調が潰れてしまう
// （実測で発生: 振幅を上げたのにcrestの実効レンジが0.8〜1.0付近に潰れ、波がむしろ見えにくくなった）。
const WAVE_AMPLITUDE_SUM = WAVE_TERMS.reduce((sum, w) => sum + w.amp, 0);

// 品質向上計画 優先度2: 水面に船の影を落とす。
// 別メッシュの「影受け板」を水面のどこかの高さに置く案は試したが、水面と船体（喫水線をまたいで
// 上下に伸びる立体）の間に必ず干渉（受け面が船体の内部を通る）が生じ、
// その干渉域で深度比較が破綻して影が消えるバグを実測で確認した
// （page.evaluate()でshadow map実テクセル・シーングラフを直接ダンプして特定。詳細はdocs/3d-quality-plan.md参照）。
// 正しい直し方は「水面自身に影を受けさせる」こと＝Three.jsの組み込みShaderChunkを
// #include して、通常のMeshStandardMaterialが暗黙にやっている影サンプリングを
// このカスタムシェーダーにも足す。ジオメトリ・波の計算（唯一の情報源）には一切触れていない。
const WATER_VERTEX_SHADER = `
  #include <common>
  #include <shadowmap_pars_vertex>

  uniform float uTime;
  varying vec3 vWorldPos;
  varying float vWave;

  void main() {
    vec3 pos = position;

    // 品質向上計画 優先度4（海面LOD）: 波の位相はメッシュのローカル座標ではなく、
    // ワールド座標（＝シミュレーション座標 x, y と同じ基準）で評価する。
    // 近傍パッチ（船を追従して動く）と遠方パッチ（固定）の2枚が同じ水面シェーダーを共有するため、
    // ローカル座標基準のままだと2枚のメッシュ原点のズレがそのまま波の位相ズレになり、
    // パッチの継ぎ目で波がガクッと食い違う（＝見た目にひび割れて見える）。
    // ワールド座標基準にしておけば、パッチが何枚あっても・どこにあっても同じ波面を評価する。
    vec4 worldPosFlat = modelMatrix * vec4(pos.x, pos.y, 0.0, 1.0);
    float wx = worldPosFlat.x;
    float wy = -worldPosFlat.z; // シミュレーション座標のyはワールドZの符号反転（scene_builder.js全体の規約）
    float wave =
${WAVE_TERMS.map(
  (w) =>
    `      ${glslFloat(w.amp)} * sin(wx * ${glslFloat(w.kx)} + wy * ${glslFloat(w.ky)} + uTime * ${glslFloat(w.speed)})`
).join(' +\n')};
    pos.z += wave;
    vWave = wave;

    // 影サンプリング用の座標を計算するため、Three.js組み込みチャンクが要求する変数名
    // （transformedNormal / worldPosition）をこの規約に合わせて用意する。
    // 波の傾き自体は正規化された法線に反映していない（フラグメント側でdFdx/dFdyから求める）ため、
    // ここでの法線はジオメトリの平面法線（ほぼ真上）で十分（影の自己遮蔽バイアス計算にのみ使う）。
    vec3 objectNormal = vec3(normal);
    vec3 transformedNormal = normalMatrix * objectNormal;

    vec4 worldPosition = modelMatrix * vec4(pos, 1.0);
    vWorldPos = worldPosition.xyz;

    #include <shadowmap_vertex>

    gl_Position = projectionMatrix * modelViewMatrix * vec4(pos, 1.0);
  }
`;

const WATER_FRAGMENT_SHADER = `
  #include <common>
  #include <packing>

  // レンダラーがオブジェクト単位で毎フレーム書き込む特殊uniform（mesh.receiveShadowの値）。
  // material.uniformsのマージでは供給されず、コンパイル済みプログラムのuniformとして
  // 直接 setValue() されるため、シェーダー側で明示的に宣言しておく必要がある
  // （宣言しないと getShadowMask() 内の参照が「undeclared identifier」でコンパイル不能になる。
  //   参照する #include <shadowmask_pars_fragment> より前に置くこと＝GLSLは前方参照不可）。
  uniform bool receiveShadow;

  #include <shadowmap_pars_fragment>
  #include <shadowmask_pars_fragment>

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

    // vWaveの理論最大振幅（WAVE_AMPLITUDE_SUM、JS側と共有）で正規化してから0..1にマップする。
    // 単純に*0.5+0.5だけだと、振幅の合計が1を超えるとクランプで階調が潰れてしまう（実測で発見）。
    float crest = clamp(vWave / ${glslFloat(WAVE_AMPLITUDE_SUM)} * 0.5 + 0.5, 0.0, 1.0);
    vec3 base = mix(uDeepColor, uShallowColor, crest * 0.45);

    vec3 viewDir = normalize(uCameraPos - vWorldPos);
    vec3 halfDir = normalize(uSunDir + viewDir);
    float spec = pow(max(dot(normal, halfDir), 0.0), 70.0);
    float fresnel = pow(1.0 - clamp(dot(normal, viewDir), 0.0, 1.0), 3.0);

    vec3 color = base + vec3(1.0, 0.96, 0.85) * spec * 1.1;
    color = mix(color, uShallowColor * 1.4, fresnel * 0.4);

    // 品質向上計画 優先度4: 近傍パッチで波の起伏を実際に見えるようにする。
    // WAVE_TERMSの実振幅は±1m弱・傾きは1〜2度程度と非常に緩やかで、
    // 鏡面反射（specular, exponent=70）だけでは波の形がほぼ見えなかった（実測でグレージング角のスクショを確認）。
    // 波高そのもの（vWave）で明度を直接変調し、波の稜線・谷を強調する
    // （物理的な陰影ではなく見た目のための誇張。「やらないこと」節の対象は波の物理忠実性であり、
    // 見た目の可視性はこの計画の目的そのものなので範囲外ではない）。
    color *= 0.82 + 0.36 * crest;

    // 船の影を落とす。完全な黒にはせず海色に沈める程度（実際の水面の影は真っ黒にならない）
    float shadow = getShadowMask();
    color *= mix(0.55, 1.0, shadow);

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
 * 船体形状（品質向上計画 優先度3・本命）。
 *
 * 以前は単一の平面形状（Shape）をExtrudeGeometryで一様に押し出すだけだったため、
 * 断面が船首から船尾まで変化せず「箱」にしか見えなかった（1隻437頂点）。
 * ここでは船首〜船尾を9つの制御断面（CONTROL）で定義し、断面を滑らかに補間しながら
 * STATION_COUNT個の輪切りをロフト（積層）して船体を組み立てる。
 *
 * 座標系はここで直接「+X が船首、+Y が上、±Z が舷側」で組み立てる
 * （以前のようにY-Z平面で作ってから rotateX/rotateY で正規化する手順は踏まない）。
 * rotation.y = 針路 / rotation.x = ピッチ / rotation.z = ロール がそのまま使える点は従来通り。
 *
 * 喫水線の塗り分け: 各断面の「チャイン」（ビルジが最も張り出す点）の高さを
 * 喫水線（SHIP_DECK_HEIGHTの符号反転＝水面が来る高さ）に固定してあるため、
 * チャインを境に「下半分＝防汚色」「上半分＝船体色」で完全に継ぎ目なく2メッシュに分割できる
 * （高さの補間が要らない＝ズレようがない）。
 *
 * @returns {{ above: THREE.BufferGeometry, below: THREE.BufferGeometry }}
 */
// 制御断面: x=船首尾方向位置, hbC=喫水線(チャイン)での半幅, hbD=甲板端での半幅,
// deckY=甲板高さ, keelY=キール高さ（すべてSHIP_VISUAL_SCALE単位、原点は船体中心付近）。
// buildHullGeometries()（ロフト生成）と hullProfileAtX()（デッキ部品を船体に密着させる位置決め）の
// 両方から参照する単一の情報源。
const HULL_CONTROL = [
  { x: -3.1, hbC: 1.1, hbD: 1.1, deckY: 0.35, keelY: -0.72 }, // 船尾（角型トランサム＝甲板幅とチャイン幅が同じ＝側面が垂直）
  { x: -2.3, hbC: 1.28, hbD: 1.05, deckY: 0.42, keelY: -0.9 },
  { x: -1.1, hbC: 1.36, hbD: 1.12, deckY: 0.48, keelY: -0.98 },
  { x: 0.0, hbC: 1.38, hbD: 1.14, deckY: 0.5, keelY: -1.0 }, // 中央（最大幅・最深）
  { x: 1.2, hbC: 1.26, hbD: 1.06, deckY: 0.58, keelY: -0.82 },
  { x: 2.15, hbC: 0.92, hbD: 0.78, deckY: 0.68, keelY: -0.55 },
  { x: 2.9, hbC: 0.48, hbD: 0.4, deckY: 0.8, keelY: -0.3 }, // 鋭く浅い船首の肩
  { x: 3.4, hbC: 0.13, hbD: 0.11, deckY: 0.9, keelY: -0.12 },
  { x: 3.6, hbC: 0.0, hbD: 0.0, deckY: 0.96, keelY: -0.02 }, // 船首材（幅0＝先端）
];

/**
 * 船体中心線上のX位置（s単位）における甲板・キール高さ等を補間して返す。
 * デッキハウス・マスト等の部品を、新しい船体形状の甲板ラインにきちんと密着させるために使う
 * （旧・単一断面のExtrudeGeometryと違い、断面が船首尾で変化するため固定値では合わなくなった）。
 */
function hullProfileAtX(xInS) {
  const clamped = Math.max(HULL_CONTROL[0].x, Math.min(HULL_CONTROL[HULL_CONTROL.length - 1].x, xInS));
  let i0 = 0;
  while (i0 < HULL_CONTROL.length - 2 && HULL_CONTROL[i0 + 1].x < clamped) i0++;
  const a = HULL_CONTROL[i0];
  const b = HULL_CONTROL[i0 + 1];
  const f = (clamped - a.x) / (b.x - a.x || 1);
  const lerp = (k) => a[k] + (b[k] - a[k]) * f;
  return { hbC: lerp('hbC'), hbD: lerp('hbD'), deckY: lerp('deckY'), keelY: lerp('keelY') };
}

function buildHullGeometries() {
  const s = SHIP_VISUAL_SCALE;
  // チャイン（＝色の境目）は物理喫水線ちょうどではなく、わずかに上に置く。
  // 実測: ちょうど水面高さに置くと、波の起伏・カメラ角度次第で防汚色が水面下に隠れきってしまい
  // 「喫水線の塗り分け」がほぼ常時見えないという結果になった。実船のボートトッピング帯と同様、
  // 常時わずかに水面上へ露出させることで塗り分けが実際に視認できるようにする。
  const waterlineY = -SHIP_DECK_HEIGHT / s + 0.16;

  // 断面数。多いほど滑らかになり頂点数も増える（目標: 3,000〜5,000頂点/隻。実測はqa-shots.jsで確認）
  const STATION_COUNT = 60;

  function sampleControl(t) {
    const idxF = t * (HULL_CONTROL.length - 1);
    const i0 = Math.min(Math.floor(idxF), HULL_CONTROL.length - 2);
    const i1 = i0 + 1;
    const f = idxF - i0;
    const a = HULL_CONTROL[i0];
    const b = HULL_CONTROL[i1];
    const lerp = (k) => a[k] + (b[k] - a[k]) * f;
    return { x: lerp('x'), hbC: lerp('hbC'), hbD: lerp('hbD'), deckY: lerp('deckY'), keelY: lerp('keelY') };
  }

  // 断面リング（9点、中心線について左右対称）。
  // p0 甲板右舷 → p1 上部フレア右舷 → p2 チャイン右舷(=喫水線) → p3 ビルジ右舷 → p4 キール
  // → p5 ビルジ左舷 → p6 チャイン左舷(=喫水線) → p7 上部フレア左舷 → p8 甲板左舷
  function ringPoints(st) {
    const { hbC, hbD, deckY, keelY } = st;
    const flareY = (deckY + waterlineY) / 2;
    const flareZ = (hbD + hbC) / 2;
    const bilgeY = (waterlineY + keelY) / 2;
    const bilgeZ = hbC / 2;
    return [
      { y: deckY, z: hbD },
      { y: flareY, z: flareZ },
      { y: waterlineY, z: hbC },
      { y: bilgeY, z: bilgeZ },
      { y: keelY, z: 0 },
      { y: bilgeY, z: -bilgeZ },
      { y: waterlineY, z: -hbC },
      { y: flareY, z: -flareZ },
      { y: deckY, z: -hbD },
    ];
  }

  const stations = [];
  for (let i = 0; i < STATION_COUNT; i++) {
    const t = i / (STATION_COUNT - 1);
    const st = sampleControl(t);
    stations.push({ x: st.x * s, ring: ringPoints(st).map((p) => ({ y: p.y * s, z: p.z * s })) });
  }

  // 非インデックス（三角形ごとに頂点を複製）で構築する。理由:
  // (a) 面ごとに正しい平面法線が付き、小型艇のハードチャイン船体らしい面取りされた質感になる
  // (b) 既存のBox/ExtrudeGeometryも同じ理由で内部的に頂点を複製しており、シーン全体のスタイルが揃う
  const belowPos = [];
  const abovePos = [];

  function pushTri(arr, p0, p1, p2) {
    arr.push(p0.x, p0.y, p0.z, p1.x, p1.y, p1.z, p2.x, p2.y, p2.z);
  }
  // a→b→c→d の順で辺を構成する四角形を三角形2枚に分割して積む
  function pushQuad(arr, a, b, c, d) {
    pushTri(arr, a, b, c);
    pushTri(arr, a, c, d);
  }
  const at = (st, idx) => ({ x: st.x, y: st.ring[idx].y, z: st.ring[idx].z });

  for (let i = 0; i < STATION_COUNT - 1; i++) {
    const s0 = stations[i];
    const s1 = stations[i + 1];
    // 船体外殻・下半分（p2〜p6＝チャインからキールを回って反対舷のチャインまで）→防汚色メッシュ
    for (let k = 2; k < 6; k++) {
      pushQuad(belowPos, at(s0, k), at(s1, k), at(s1, k + 1), at(s0, k + 1));
    }
    // 船体外殻・上半分（p0〜p2, p6〜p8＝甲板端からチャインまで）→船体色メッシュ
    for (let k = 0; k < 2; k++) {
      pushQuad(abovePos, at(s0, k), at(s1, k), at(s1, k + 1), at(s0, k + 1));
    }
    for (let k = 6; k < 8; k++) {
      pushQuad(abovePos, at(s0, k), at(s1, k), at(s1, k + 1), at(s0, k + 1));
    }
    // 甲板（p0-p8を直結する平らな蓋）→船体色メッシュ側に含める
    pushQuad(abovePos, at(s0, 0), at(s1, 0), at(s1, 8), at(s0, 8));
  }

  // 船尾トランサム（最も-Xの断面をそのまま平面で塞ぐ）。キールから扇状に三角形分割する。
  {
    const st0 = stations[0];
    const keel = at(st0, 4);
    pushTri(belowPos, keel, at(st0, 3), at(st0, 2));
    pushTri(belowPos, keel, at(st0, 6), at(st0, 5));
    pushTri(abovePos, keel, at(st0, 2), at(st0, 1));
    pushTri(abovePos, keel, at(st0, 1), at(st0, 0));
    pushTri(abovePos, keel, at(st0, 0), at(st0, 8));
    pushTri(abovePos, keel, at(st0, 8), at(st0, 7));
    pushTri(abovePos, keel, at(st0, 7), at(st0, 6));
  }

  function toGeometry(posArray) {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(posArray, 3));
    geo.computeVertexNormals();
    return geo;
  }

  return { above: toGeometry(abovePos), below: toGeometry(belowPos) };
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

  // 環境マップ（品質向上計画 優先度1）: 空のグラデーションをPMREMGeneratorで畳み込み、
  // scene.environmentに設定する。追加のテクスチャ・外部アセットは使わない
  // （既存のcreateSkyTexture()を等距円筒図法テクスチャとして再解釈するだけ）。
  // これによりMeshStandardMaterialのmetalness/roughnessが実際に何かを映り込ませるようになる
  // （船体・窓ガラス・観覧車の球体展望室など）。scene.backgroundとは別テクスチャなので独立して破棄できる。
  const pmremGenerator = new THREE.PMREMGenerator(renderer);
  const envSourceTexture = createSkyTexture();
  envSourceTexture.mapping = THREE.EquirectangularReflectionMapping;
  envSourceTexture.colorSpace = THREE.SRGBColorSpace;
  scene3d.environment = pmremGenerator.fromEquirectangular(envSourceTexture).texture;
  pmremGenerator.dispose();
  envSourceTexture.dispose();

  // 遠景の背景装飾（海域らしさを出す任意の見た目要素）。
  // シミュレーション・センサーロジックには関与しない、純粋な装飾。
  // scene.landmarkSet（シナリオJSON由来）で選択し、未指定・未知の値なら何も描画しない
  // （B-8対応: 東京湾ハードコードをやめ、シナリオ非対応の海域では景観を追加しない）。
  const landmarkBuilder = LANDMARK_BUILDERS[scene.landmarkSet];
  if (landmarkBuilder) {
    scene3d.add(landmarkBuilder());
  } else if (scene.landmarkSet) {
    console.warn(`未知のlandmarkSet: "${scene.landmarkSet}"（既知: ${Object.keys(LANDMARK_BUILDERS).join(', ')}）。ランドマークは描画しません。`);
  }

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
  sun.position.copy(sunDir).multiplyScalar(600).add(new THREE.Vector3(center.x, 0, -center.y));
  sun.castShadow = true;
  // 品質向上計画 優先度2: 影を「船の周辺だけ」に絞って実用にする。
  // 以前は3,800m四方/1024pxでテクセル3.7m（船14.7mが4px）＝ぼやけた染み。
  // 400m四方/2048pxならテクセル約0.2mになり、接地感が出る。
  // その代わり影の描画範囲が狭くなるため、毎フレーム updateShadowTarget() でヒーロー艇（船団の注視点）に
  // 追従させる。遠景の建物などの影は元から視認できないレベルだったので範囲外になっても実害がない。
  const SHADOW_BOX_HALF = 200; // 400m四方
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.camera.left = -SHADOW_BOX_HALF;
  sun.shadow.camera.right = SHADOW_BOX_HALF;
  sun.shadow.camera.top = SHADOW_BOX_HALF;
  sun.shadow.camera.bottom = -SHADOW_BOX_HALF;
  sun.shadow.camera.near = 1;
  sun.shadow.camera.far = 1400;
  sun.shadow.bias = -0.0015;
  scene3d.add(sun);
  scene3d.add(sun.target);

  /** 太陽（＝影のカメラ）を船団の注視点に追従させる。orbitTargetの更新後に毎フレーム呼ぶ。 */
  function updateShadowTarget(focusX, focusY) {
    const focusWorld = new THREE.Vector3(focusX, 0, -focusY);
    sun.target.position.copy(focusWorld);
    sun.position.copy(sunDir).multiplyScalar(600).add(focusWorld);
  }

  const waterUniforms = THREE.UniformsUtils.merge([
    // lights:trueにすると、レンダラーは "material.uniforms.directionalShadowMap.value = ..." のように
    // 自前のuniformsオブジェクトへ直接書き込みに来る。UniformsLib.lightsを取り込んでおかないと
    // その書き込み先（.value）自体が存在せず「Cannot set properties of undefined」で毎フレーム落ちる
    // （実測で確認したハマりどころ。素のShaderMaterialにlights:trueだけ付けても動かない）。
    THREE.UniformsLib.lights,
    {
      uTime: { value: 0 },
      uDeepColor: { value: new THREE.Color(0x0f6788) },
      uShallowColor: { value: new THREE.Color(0x59c2d6) },
      uSunDir: { value: sunDir },
      uCameraPos: { value: new THREE.Vector3() },
    },
  ]);
  const waterMaterial = new THREE.ShaderMaterial({
    uniforms: waterUniforms,
    vertexShader: WATER_VERTEX_SHADER,
    fragmentShader: WATER_FRAGMENT_SHADER,
    // 影のサンプリング用uniform（directionalShadowMap等）をレンダラーに供給させるためのフラグ。
    // これが無いとシェーダー中のgetShadowMask()は常にダミー値のまま（影が一切乗らない）になる。
    lights: true,
  });
  // 品質向上計画 優先度4: 海面LOD。
  // 以前は9,000m四方を一律160×160（1マス56m、船の全長14.7mの4倍）で覆っており、
  // 船の周囲では波の起伏が実質的に無いのと同じだった（頂点予算の83%を占めるのに主役の近くでは見えない）。
  // ここでは2枚に分ける: 近傍パッチ（船を追従して動く・高精細）と遠方パッチ（固定・粗い）。
  // 波はワールド座標基準の同じシェーダー・同じ WAVE_TERMS で評価するため（上のWATER_VERTEX_SHADER参照）、
  // 2枚のメッシュ間で位相がズレることはない＝継ぎ目で波の高さが食い違ってひび割れて見える心配がない。
  const waterExtent = Math.max(span * 4, 9000);
  const farGeo = new THREE.PlaneGeometry(waterExtent, waterExtent, 24, 24);
  const waterFar = new THREE.Mesh(farGeo, waterMaterial);
  waterFar.rotation.x = -Math.PI / 2;
  waterFar.position.set(center.x, 0, -center.y);
  waterFar.receiveShadow = true; // 品質向上計画 優先度2: 船の影を水面自身に受けさせる
  scene3d.add(waterFar);

  const NEAR_WATER_EXTENT = 600;
  const nearGeo = new THREE.PlaneGeometry(NEAR_WATER_EXTENT, NEAR_WATER_EXTENT, 128, 128);
  const waterNear = new THREE.Mesh(nearGeo, waterMaterial); // マテリアルを共有＝uTime等のuniformも自動的に同期する
  waterNear.rotation.x = -Math.PI / 2;
  waterNear.position.set(center.x, 0.02, -center.y); // 遠方パッチよりわずかに高くし、重なり域で確実に手前に描かれるようにする（スカート）
  waterNear.receiveShadow = true;
  scene3d.add(waterNear);

  /** 近傍パッチを船団の注視点に追従させる。影のターゲットと同じタイミング（updateShips内）で呼ぶ。 */
  function updateNearWater(focusX, focusY) {
    waterNear.position.set(focusX, 0.02, -focusY);
  }

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

  const hullGeometries = buildHullGeometries();
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
    group.name = `ship-${id}`; // devtools計測用（qa-shots.jsが船体だけの頂点数を分離するために使う）
    group.rotation.order = 'YXZ'; // ヨー(針路) → ピッチ → ロール の順で適用する

    // 船体は喫水線で2メッシュに分割（品質向上計画 優先度3）。DoubleSideなのは、
    // ロフトの三角形巻き順を手作業で毎面検証する代わりに両面描画で確実に穴を防ぐ判断
    // （小型艇1隻あたりの追加コストは無視できる）。
    const hull = new THREE.Mesh(
      hullGeometries.above,
      new THREE.MeshStandardMaterial({ color: hullColor, roughness: 0.4, metalness: 0.1, side: THREE.DoubleSide })
    );
    hull.castShadow = true;
    hull.receiveShadow = true;
    group.add(hull);

    // 喫水線下＝防汚塗料（赤茶）。実船は水線下が別色というだけで「船らしさ」が大きく上がる一手。
    // わずかなemissiveを足しているのは、この帯がチャイン直下という太陽光に対して浅い角度になりやすい
    // 場所にあり、通常のMeshStandardMaterialの陰影だけだと実測でほぼ黒つぶれして見えなかったため
    // （見た目上の可視性を優先した割り切り。物理的な正しさより「塗り分けが実際に見える」ことを取る）。
    const hullBelow = new THREE.Mesh(
      hullGeometries.below,
      new THREE.MeshStandardMaterial({
        color: 0xb3502e,
        roughness: 0.75,
        metalness: 0.0,
        emissive: 0x431408,
        emissiveIntensity: 1.0,
        side: THREE.DoubleSide,
      })
    );
    hullBelow.castShadow = true;
    hullBelow.receiveShadow = true;
    group.add(hullBelow);

    // 操舵室（ブリッジ）。カメラの搭載位置に対応する。新しい船体の甲板ラインに合わせて高さを決める
    // （旧・単一断面の船体では固定値で足りていたが、船首尾で甲板高さが変わるため位置決め計算が必要）。
    const bridgeX = -0.55 * s;
    const bridgeDeckY = hullProfileAtX(bridgeX / s).deckY * s;
    const deck = new THREE.Mesh(new THREE.BoxGeometry(1.0 * s, 0.9 * s, 1.1 * s), deckMaterial);
    deck.position.set(bridgeX, bridgeDeckY + 0.45 * s, 0);
    deck.castShadow = true;
    group.add(deck);

    // 窓（前面）。単色の箱に一本入れるだけで「船らしさ」が出る
    const windshield = new THREE.Mesh(
      new THREE.BoxGeometry(0.08 * s, 0.32 * s, 0.95 * s),
      new THREE.MeshStandardMaterial({ color: 0x17323f, roughness: 0.25, metalness: 0.4 })
    );
    windshield.position.set(-0.12 * s, bridgeDeckY + 0.55 * s, 0);
    group.add(windshield);

    // センサーマスト＋ドーム: ASVが観測機器を積んでいることを示す装飾（レーダー/カメラの実体ではない）。
    // 分割数を6→14/10→20・6→14に増やし（品質向上計画1.5節）、六角柱・多面体っぽさを解消する。
    const mastX = -0.75 * s;
    const mastBaseY = hullProfileAtX(mastX / s).deckY * s + 0.9 * s; // ブリッジ屋根の上に立てる
    const mastMat = new THREE.MeshStandardMaterial({ color: 0xd7dede, roughness: 0.5 });
    const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.06 * s, 0.08 * s, 1.1 * s, 14), mastMat);
    mast.position.set(mastX, mastBaseY, 0);
    group.add(mast);
    const sensorDome = new THREE.Mesh(
      new THREE.SphereGeometry(0.24 * s, 20, 14, 0, Math.PI * 2, 0, Math.PI / 1.7),
      new THREE.MeshStandardMaterial({ color: 0xf2f5f5, roughness: 0.3 })
    );
    sensorDome.position.set(mastX, mastBaseY + 0.55 * s, 0);
    group.add(sensorDome);

    // 陣営識別ストライプ（青=防御 / 赤=侵入）。喫水線のすぐ上、船体色帯の中央あたりに帯びさせる
    const stripeX = 0.1 * s;
    const stripeProfile = hullProfileAtX(stripeX / s);
    const stripeY = ((-SHIP_DECK_HEIGHT / s + stripeProfile.deckY) / 2) * s; // 喫水線と甲板の中間高さ
    const stripe = new THREE.Mesh(
      new THREE.BoxGeometry(5.2 * s, 0.22 * s, stripeProfile.hbC * s * 2.05),
      new THREE.MeshStandardMaterial({ color: lightColor, roughness: 0.5 })
    );
    stripe.position.set(stripeX, stripeY, 0);
    group.add(stripe);

    // 航海灯: 遠距離でも視認できる小さな発光点（実際の航海灯の役割も兼ねる）。分割数を8→16に増やす。
    const navLight = new THREE.Mesh(
      new THREE.SphereGeometry(0.28 * s, 16, 16),
      new THREE.MeshStandardMaterial({ color: lightColor, emissive: lightColor, emissiveIntensity: 2.4 })
    );
    navLight.position.set(mastX, mastBaseY + 1.0 * s, 0);
    group.add(navLight);

    // デッキ部品（品質向上計画 優先度5・ストレッチ）: 小さな部品を数個置くだけで「作られた感」を出す。
    // シミュレーション・センサーロジックには一切関与しない純粋な見た目装飾。
    const fittingMat = new THREE.MeshStandardMaterial({ color: 0xc7ccce, roughness: 0.55, metalness: 0.15 });
    // 通信用ホイップアンテナ: ブリッジ後方に細く高く
    const whipAntenna = new THREE.Mesh(new THREE.CylinderGeometry(0.02 * s, 0.03 * s, 1.6 * s, 8), fittingMat);
    const whipX = -0.95 * s;
    whipAntenna.position.set(whipX, hullProfileAtX(whipX / s).deckY * s + 0.8 * s, 0.35 * s);
    group.add(whipAntenna);
    // 船首の係船金物（クリート）2個: 甲板端に小さく張り出す直方体
    const cleatGeo = new THREE.BoxGeometry(0.22 * s, 0.1 * s, 0.36 * s);
    [-1, 1].forEach((side) => {
      const cleatX = 2.2 * s;
      const cleatProfile = hullProfileAtX(cleatX / s);
      const cleat = new THREE.Mesh(cleatGeo, fittingMat);
      cleat.position.set(cleatX, cleatProfile.deckY * s + 0.05 * s, side * cleatProfile.hbD * s * 0.85);
      group.add(cleat);
    });

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

    // 船首波（品質向上計画 優先度5・ストレッチ）: 船首が水を切る白いV字。
    // 航跡（wake）と同じ「水面に寝かせた加算合成の平面」を、船首を起点に左右へ末広がりに配置する。
    // 航跡と同じopacity制御（速度に応じて濃く）を共有するので、ここでは同じ wakeMat を使い回す。
    const bowWaveGeom = new THREE.PlaneGeometry(1.1 * s, 4.6 * s);
    const bowWaveAngle = 0.5; // ラジアン。船首から左右に開く角度
    [-1, 1].forEach((side) => {
      const bowWave = new THREE.Mesh(bowWaveGeom, wakeMat);
      bowWave.rotation.x = -Math.PI / 2;
      bowWave.rotation.z = Math.PI / 2;
      bowWave.rotation.y = side * bowWaveAngle;
      // 船首材（x=3.6*s）を平面の近い方の端（開き角方向に -half length）に一致させ、
      // 遠い方の端が船体側面に沿って後方・外側へ流れるようにする
      // （実測: 中心を船首の少し後ろに置いただけでは、平面が船体の下に隠れて見えなかった）。
      const bowTipX = 3.6 * s;
      const halfLen = 4.6 * s * 0.5;
      const centerX = bowTipX + Math.cos(side * bowWaveAngle) * halfLen;
      const centerZ = Math.sin(side * bowWaveAngle) * halfLen;
      bowWave.position.set(centerX, -SHIP_DECK_HEIGHT + 0.25, centerZ);
      group.add(bowWave);
    });

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

      // 波の局所形状。水面シェーダーと同じくシミュレーション座標をそのまま使う
      // （海面LODで近傍パッチが船を追従して動くため、center基準のオフセットは使えない。上のwaveHeightAt参照）
      const wx = e.x;
      const wy = e.y;
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
    // 影のカメラ・近傍海面パッチも同じ注視点に追従させる
    // （影は400m四方、近傍海面は600m四方に絞った分、船から外れると消えてしまうため）
    updateShadowTarget(orbitTarget.x, orbitTarget.y);
    updateNearWater(orbitTarget.x, orbitTarget.y);
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
