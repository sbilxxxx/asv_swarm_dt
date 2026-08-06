/**
 * hud.js — カメラ／レーダー／GNSSの読み取り値を画面に表示するだけの薄い層
 *
 * センサー実証（FR1）の「見せ方」を担当する。シミュレーションロジックは持たない。
 */

export function renderCameraPanel(reading) {
  const el = document.getElementById('camera-readout');
  if (!el) return;
  if (reading?.imageDataUrl) {
    el.innerHTML = `<img src="${reading.imageDataUrl}" alt="onboard camera" />`;
  } else {
    el.textContent = '(取得待ち)';
  }
}

export function renderRadarPanel(reading) {
  const el = document.getElementById('radar-readout');
  if (!el) return;
  if (!reading) {
    el.textContent = '—';
    return;
  }
  if (reading.contacts.length === 0) {
    el.textContent = 'contacts: 0';
    return;
  }
  el.innerHTML = reading.contacts
    .map((c) => `${c.id} (${c.faction})<br>${Math.round(c.rangeM)} m`)
    .join('<br>');
}

export function renderGnssPanel(reading) {
  const el = document.getElementById('gnss-readout');
  if (!el) return;
  if (!reading) {
    el.textContent = '—';
    return;
  }
  el.innerHTML = `${reading.lat.toFixed(5)}, ${reading.lon.toFixed(5)}<br>heading ${reading.headingDeg.toFixed(0)}°`;
}
