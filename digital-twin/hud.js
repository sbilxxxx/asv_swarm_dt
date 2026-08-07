/**
 * hud.js — カメラ／レーダー／GNSSの読み取り値を画面に表示するだけの薄い層
 *
 * センサー実証（FR1）の「見せ方」を担当する。シミュレーションロジックは持たない。
 */

export function renderCameraPanel(reading) {
  const el = document.getElementById('camera-readout');
  if (!el) return;
  if (reading?.imageDataUrl) {
    el.innerHTML = `<img src="${reading.imageDataUrl}" alt="bridge camera" />`;
  } else {
    el.textContent = '(取得待ち)';
  }
}

let sweepAngle = 0;

/**
 * 円形のレーダースコープを描画する（ヘディングアップ表示: 画面上＝自艇の船首方向）。
 * @param {{rangeM:number, contacts:Array<{id:string,faction:string,rangeM:number,bearingRad:number}>}} reading
 * @param {number} selfHeadingRad - 自艇の現在針路（相対方位の計算に使う）
 */
export function renderRadarPanel(reading, selfHeadingRad = 0) {
  const canvas = document.getElementById('radar-readout');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const w = canvas.width;
  const h = canvas.height;
  const cx = w / 2;
  const cy = h / 2;
  const radius = Math.min(w, h) / 2 - 8;
  const maxRangeM = reading?.rangeM ?? 1500;

  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = '#04140c';
  ctx.fillRect(0, 0, w, h);

  // レンジリング（3段階）
  ctx.strokeStyle = 'rgba(90, 220, 150, 0.35)';
  ctx.lineWidth = 1;
  for (const frac of [1 / 3, 2 / 3, 1]) {
    ctx.beginPath();
    ctx.arc(cx, cy, radius * frac, 0, Math.PI * 2);
    ctx.stroke();
  }
  // 十字線
  ctx.beginPath();
  ctx.moveTo(cx, cy - radius);
  ctx.lineTo(cx, cy + radius);
  ctx.moveTo(cx - radius, cy);
  ctx.lineTo(cx + radius, cy);
  ctx.stroke();

  // レンジ目盛り（外周のリングに一箇所だけ表示）
  ctx.fillStyle = 'rgba(150, 230, 190, 0.7)';
  ctx.font = '9px monospace';
  ctx.fillText(`${Math.round(maxRangeM)}m`, cx + 3, cy - radius + 9);

  // 回転するスイープ（演出。実データの有無に関わらず動かす）
  sweepAngle += 0.08;
  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate(sweepAngle);
  const grad = ctx.createLinearGradient(0, 0, radius, 0);
  grad.addColorStop(0, 'rgba(90, 240, 160, 0.35)');
  grad.addColorStop(1, 'rgba(90, 240, 160, 0)');
  ctx.fillStyle = grad;
  ctx.beginPath();
  ctx.moveTo(0, 0);
  ctx.arc(0, 0, radius, -0.18, 0.18);
  ctx.closePath();
  ctx.fill();
  ctx.restore();

  // 自艇（中心のマーカー、常に画面上向き＝ヘディングアップ）
  ctx.fillStyle = '#eafff0';
  ctx.beginPath();
  ctx.moveTo(cx, cy - 5);
  ctx.lineTo(cx - 3, cy + 4);
  ctx.lineTo(cx + 3, cy + 4);
  ctx.closePath();
  ctx.fill();

  if (!reading?.contacts) return;

  for (const c of reading.contacts) {
    const relBearing = normalizeAngle(c.bearingRad - selfHeadingRad);
    // ヘディングアップ表示。方位は数学規約（東=0・反時計回り正）なので、
    // relBearing>0 は左舷（ポート）side になる。画面左が左舷なので sin は減算する。
    // ここを加算にすると右舷の目標が画面左に出る左右反転バグになる。
    const px = cx - Math.sin(relBearing) * (c.rangeM / maxRangeM) * radius;
    const py = cy - Math.cos(relBearing) * (c.rangeM / maxRangeM) * radius;

    ctx.fillStyle = c.faction === 'defender' ? '#4fd6ff' : '#ff5a5a';
    ctx.beginPath();
    ctx.arc(px, py, 3, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = 'rgba(220, 240, 230, 0.85)';
    ctx.font = '8px monospace';
    ctx.fillText(c.id, px + 5, py - 5);
  }
}

function normalizeAngle(rad) {
  return Math.atan2(Math.sin(rad), Math.cos(rad));
}

/**
 * E-3対応: GNSSセンサーの生値（gnss.jsの数学規約＝東0°・反時計回り正）を、
 * 表示専用のコンパス規約（北0°・時計回り正・[0,360)）へ変換する。
 * gnss.js自体のセンサー出力（steering/物理側が依存する数学規約）は変更しない。
 * 変換式: compassDeg = (90 - mathDeg + 360) % 360
 * @param {number} mathDeg - GnssSensor.observe()が返すheadingDeg（数学規約、範囲不定）
 * @returns {number} 北基準・時計回り・[0,360)のコンパス方位（度）
 */
function toCompassHeadingDeg(mathDeg) {
  return ((90 - mathDeg) % 360 + 360) % 360;
}

export function renderGnssPanel(reading) {
  const el = document.getElementById('gnss-readout');
  if (!el) return;
  if (!reading) {
    el.textContent = '—';
    return;
  }
  const compassDeg = toCompassHeadingDeg(reading.headingDeg);
  el.innerHTML = `${reading.lat.toFixed(5)}, ${reading.lon.toFixed(5)}<br>heading ${compassDeg.toFixed(0)}°`;
}
