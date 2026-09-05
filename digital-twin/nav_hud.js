/**
 * nav_hud.js — 航行モードのHUD（?nav= のときだけ出る）
 *
 * 出すものを選ぶ基準は「誤った判断を後から追えるか」の一点である。画面で船が動くのを
 * 見せるだけなら軌跡で足りるが、それでは VLM が**何を見て何と言ったか**が残らない。
 * 2026-08-30 のスモークで実際に起きたのは「入力画像に写り込んだ灰色の板を VLM が
 * barriers と誤認する」という故障で、これは送信画像と watch 文を並べて初めて分かる。
 * したがってこのパネルは次の3つを必ず同時に出す:
 *
 *   1. **VLM へ実際に送った画像**（表示用の絵ではなく、送信したその1枚）
 *   2. VLM が返した watch / action / waypoints と、サニタイズが落としたものの理由
 *   3. 挙動の統計（keep率・同一プラン再送・パース失敗・失敗の kind 別）
 *
 * 加えて、宣言値（設定）と実測 t_wall（記録）を並べて出すが、**別の行に分けて**出す。
 * 混ぜて出すと「遅延の出所は設定値だけ」という不変条件（time-model.md §2.5）が
 * 画面の上で崩れて見える。
 */

const STATE_LABEL = {
  running: { text: '進行中', color: '#6fe0a8' },
  waiting: { text: '推論待ち', color: '#e0c46f' },
  arrived: { text: '到達', color: '#6fb3c7' },
  idle: { text: '待機', color: '#7a8f97' },
};

function el(id) {
  return document.getElementById(id);
}

/** パネルの土台を1回だけ作る。?nav= が無ければ呼ばれない */
export function mountNavPanel() {
  const host = el('panel-nav');
  if (!host) return null;
  host.hidden = false;
  host.innerHTML = `
    <h3>VLM Navigator</h3>
    <div id="nav-mode" class="nav-line"></div>
    <div id="nav-state" class="nav-line"></div>
    <canvas id="nav-plot" width="200" height="140"></canvas>
    <div class="nav-line nav-dim" style="font-size:10px">
      <span style="color:#3a6b7d">━</span> 航跡（通った道）
      <span style="color:#6fb3c7">━</span> プラン
      <span style="color:#e0c46f">○</span> 目的地
      <span style="color:#6fe0a8">▲</span> 自艇
    </div>
    <div id="nav-progress" class="nav-line"></div>
    <div id="nav-traffic" class="nav-line"></div>
    <div class="nav-label">送信画像（VLMが見たもの）</div>
    <img id="nav-image" alt="VLM へ送ったブリッジ一人称画像" />
    <div class="nav-label">watch</div>
    <div id="nav-watch" class="nav-quote">—</div>
    <div id="nav-plan" class="nav-line"></div>
    <div id="nav-notes" class="nav-line nav-warn"></div>
    <div class="nav-label">時間（宣言値 / 実測）</div>
    <div id="nav-timing" class="nav-line"></div>
    <div class="nav-label">挙動</div>
    <div id="nav-stats" class="nav-line"></div>
    <div id="nav-error" class="nav-line nav-error"></div>
  `;
  return host;
}

/**
 * 上から見たプラン図。3Dの絵だけでは「どこへ向かっているか」が分からないので、
 * 目的地・waypoint・自船を1枚に並べる（真値の俯瞰であって VLM の入力ではない）。
 */
function drawPlot(canvas, { bounds, pose, plan, destination, trail }) {
  const ctx = canvas.getContext('2d');
  const w = canvas.width;
  const h = canvas.height;
  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = '#04121a';
  ctx.fillRect(0, 0, w, h);
  if (!bounds) return;

  const pad = 8;
  const sx = (w - pad * 2) / Math.max(bounds.maxX - bounds.minX, 1);
  const sy = (h - pad * 2) / Math.max(bounds.maxY - bounds.minY, 1);
  const s = Math.min(sx, sy);
  const toPx = (eastM, northM) => ({
    x: pad + (eastM - bounds.minX) * s,
    y: h - pad - (northM - bounds.minY) * s, // north を上に
  });

  // 航跡（実際に通った道）。これが無いと「プランどおりに走ったのか」が図から読めない
  if (trail?.length > 1) {
    ctx.strokeStyle = '#3a6b7d';
    ctx.lineWidth = 1;
    ctx.beginPath();
    const first = toPx(trail[0].eastM, trail[0].northM);
    ctx.moveTo(first.x, first.y);
    for (let i = 1; i < trail.length; i++) {
      const p = toPx(trail[i].eastM, trail[i].northM);
      ctx.lineTo(p.x, p.y);
    }
    ctx.stroke();
  }

  // 航路（これから通る予定）
  if (plan?.length && pose) {
    ctx.strokeStyle = '#6fb3c7';
    ctx.lineWidth = 1;
    ctx.beginPath();
    const start = toPx(pose.eastM, pose.northM);
    ctx.moveTo(start.x, start.y);
    for (const wp of plan) {
      const p = toPx(wp.eastM, wp.northM);
      ctx.lineTo(p.x, p.y);
    }
    ctx.stroke();
    ctx.fillStyle = '#6fb3c7';
    for (const wp of plan) {
      const p = toPx(wp.eastM, wp.northM);
      ctx.fillRect(p.x - 1.5, p.y - 1.5, 3, 3);
    }
  }

  // 目的地
  if (destination) {
    const d = toPx(destination.eastM, destination.northM);
    ctx.strokeStyle = '#e0c46f';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(d.x, d.y, 5, 0, Math.PI * 2);
    ctx.stroke();
  }

  // 自船（船首方向つき）
  if (pose) {
    const p = toPx(pose.eastM, pose.northM);
    const rad = (pose.headingDeg * Math.PI) / 180;
    ctx.fillStyle = '#6fe0a8';
    ctx.beginPath();
    ctx.moveTo(p.x + Math.cos(rad) * 6, p.y - Math.sin(rad) * 6);
    ctx.lineTo(p.x + Math.cos(rad + 2.5) * 4, p.y - Math.sin(rad + 2.5) * 4);
    ctx.lineTo(p.x + Math.cos(rad - 2.5) * 4, p.y - Math.sin(rad - 2.5) * 4);
    ctx.closePath();
    ctx.fill();
  }
}

function pct(n, d) {
  return d > 0 ? `${Math.round((n / d) * 100)}%` : '—';
}

/**
 * 毎フレーム呼ぶ。DOM の書き換えは差分を見ずに素朴にやる（1パネルぶんなので実測上の負荷は無い）。
 * @param {ReturnType<typeof import('./nav_mode.js').createNavigatorMode>} nav
 * @param {{bounds:object, nowMs:number, clockS:number}} view
 *   nowMs は実時刻。停止時間の表示にしか使わない（シムには入らない）
 */
export function renderNavPanel(nav, { bounds, nowMs, clockS }) {
  const st = nav.status;
  const pose = nav.pose();
  const label = STATE_LABEL[st.state] ?? STATE_LABEL.idle;

  el('nav-mode').textContent =
    `arm=${st.arm}` +
    (st.model ? ` / ${st.model}` : '') +
    (st.warmup === 'pending' ? ' / ウォームアップ中' : st.warmup === 'failed' ? ' / ウォームアップ失敗' : '');

  const stall = st.stalledSinceMs !== null ? ` ${((nowMs - st.stalledSinceMs) / 1000).toFixed(1)}s` : '';
  el('nav-state').innerHTML =
    `<span style="color:${label.color}">■ ${label.text}${stall}</span>` +
    ` <span class="nav-dim">シム時刻 t=${clockS.toFixed(1)} s</span>`;

  drawPlot(el('nav-plot'), {
    bounds,
    pose,
    plan: nav.plan.snapshot(),
    destination: nav.plan.destination,
    trail: nav.trail(),
  });

  if (pose) {
    const d = Math.hypot(nav.plan.destination.eastM - pose.eastM, nav.plan.destination.northM - pose.northM);
    el('nav-progress').textContent =
      `目的地まで ${Math.round(d)} m（到達半径 ${nav.options.arrivalM} m）` +
      (st.arrivedAtT !== null ? ` — t=${st.arrivedAtT.toFixed(1)}s に到達` : '');
  }

  // 交通船との距離。M3 の主指標（最接近距離）はここに出る
  const traffic = el('nav-traffic');
  if (st.trafficCount > 0) {
    const now = st.nearestTrafficM;
    const min = st.minTrafficM;
    const warn = now !== null && now < 80;
    traffic.innerHTML =
      `交通船 ${st.trafficCount} 隻 — 最近 ` +
      `<span style="color:${warn ? '#e0708e' : '#6fe0a8'}">${now === null ? '—' : Math.round(now) + ' m'}</span>` +
      `（最接近 ${min === null ? '—' : Math.round(min) + ' m'}）`;
  } else {
    traffic.textContent = '';
  }

  const img = el('nav-image');
  if (st.lastImage) {
    img.src = st.lastImage;
    img.hidden = false;
  } else {
    img.hidden = true;
  }

  const dec = st.lastDecision;
  el('nav-watch').textContent = dec?.watch ? dec.watch : dec ? '(報告なし)' : '—';
  el('nav-plan').textContent = dec
    ? `action=${dec.action}${dec.outcome ? ` (${dec.outcome})` : ''}` +
      (dec.waypoints ? ` → ${dec.waypoints.map((w) => `(${Math.round(w.eastM)},${Math.round(w.northM)})`).join(' → ')}` : '')
    : 'まだ判断していない';
  el('nav-notes').textContent = dec?.notes?.length ? `落とした点: ${dec.notes.join(' / ')}` : '';

  const o = nav.options;
  el('nav-timing').innerHTML =
    `<span class="nav-dim">宣言</span> interval ${o.intervalS}s / render ${o.renderS}s + infer ${o.inferS}s ` +
    `= 発効 ${(o.renderS + o.inferS).toFixed(1)}s<br />` +
    `<span class="nav-dim">実測</span> render ${st.lastRenderMs ?? '—'} ms / infer ${dec?.latencyMs ?? '—'} ms ` +
    `<span class="nav-dim">（記録。宣言値には戻さない）</span>`;

  const s = nav.stats ?? {};
  const calls = s.calls ?? 0;
  el('nav-stats').textContent =
    `calls ${calls} / keep ${pct(s.keeps ?? 0, calls)} / replace ${s.replaces ?? 0}` +
    ` / 同一プラン再送 ${s.resentSamePlan ?? 0}` +
    ` / parse失敗 ${s.parseFailures ?? 0} / 通信失敗 ${s.transportFailures ?? 0}`;

  el('nav-error').textContent = st.error ? `エラー: ${st.error}` : '';
}
