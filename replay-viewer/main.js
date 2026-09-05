/**
 * main.js — 記録済みエピソード再生ビュアーのエントリポイント
 *
 * 目的: headless_run.js が書き出したJSONLログ（位置・指令・艇LLM生ログ）を読み込み、
 * 1エピソードを 2D俯瞰マップ・3Dデジタルツイン・指揮官/艇AIの判断ログの3画面に同期再生する。
 *
 * 設計方針: 新しい可視化ロジックを増やさず、既存の2画面（swarm-sim/digital-twin）が
 * 使っているモジュールをそのまま再利用する。ライブ物理演算（World）は使わず、
 * 記録済みの位置(x,y,heading,speed)を毎フレーム entitiesAt() で取り出して
 * updateShips()/drawAgents() へそのまま渡すだけ（両モジュールの入力形式が
 * ちょうどログの1行と同じ形をしているため、変換はほぼ不要）。
 */

import { loadSceneFromScenario } from '../core/data/adapters/index.js';
import { createProjection, drawMap, drawProtectedAsset } from '../swarm-sim/map_view.js';
import { drawAgents } from '../swarm-sim/agent_view.js';
import { loadPositionLog, loadDecisionLog, loadCallLog, entitiesAt, buildConversationEvents } from './log_loader.js';
import { renderConversation } from './conversation_panel.js';

const el = (id) => document.getElementById(id);
const fileInputs = { positions: el('file-positions'), decisions: el('file-decisions'), calls: el('file-calls') };
const episodeSelect = el('episode-select');
const btnLoadDefault = el('btn-load-default');
const btnPlayPause = el('btn-playpause');
const speedSelect = el('speed-select');
const seek = el('seek');
const timeReadout = el('time-readout');
const outcomeBadge = el('outcome-badge');
const statusEl = el('status');
const emptyHint = el('empty-hint');
const canvas2d = el('canvas-2d');
const canvas3d = el('canvas-3d');
const convEntries = el('conv-entries');

/** 既定で試すログ一式（submission/measurements配下。サーバー経由で開いた場合だけfetchできる） */
const DEFAULT_LOG_BASE = '../submission/measurements/qwen2.5-32b/';
const DEFAULT_LOGS = {
  positions: DEFAULT_LOG_BASE + 'qwen2.5-32b-20ep.jsonl',
  decisions: DEFAULT_LOG_BASE + 'qwen2.5-32b-20ep-decisions.jsonl',
  calls: DEFAULT_LOG_BASE + 'qwen2.5-32b-20ep-calls.jsonl',
};

let positionEpisodes = [];
let decisionsByEpisode = new Map();
let callsByEpisode = new Map();

/**
 * digital-twin/scene_builder.js は外部CDN（unpkg.com）からThree.jsを読み込む前提の
 * importmapに依存している。到達できないネットワーク環境（学内プロキシ・GPUクラスタの
 * アウトバウンド制限など）では読み込み自体が失敗するため、2D俯瞰マップ・会話ログを
 * 道連れにしないよう動的importで切り離して読み込む。
 */
let threeModulePromise = null;
function loadThreeSceneBuilder() {
  if (!threeModulePromise) {
    threeModulePromise = import('../digital-twin/scene_builder.js')
      .then((mod) => mod.buildThreeScene)
      .catch((err) => {
        console.error('3Dシーンビルダーの読み込みに失敗:', err);
        return null;
      });
  }
  return threeModulePromise;
}

function show3dMessage(message) {
  const pane = document.getElementById('pane-3d');
  let overlay = document.getElementById('pane-3d-error');
  if (!overlay) {
    overlay = document.createElement('div');
    overlay.id = 'pane-3d-error';
    overlay.style.cssText =
      'position:absolute;inset:0;display:flex;align-items:center;justify-content:center;' +
      'text-align:center;padding:28px;color:#ff9d5c;font-size:13px;line-height:1.8;background:#0e1b1f;z-index:1;';
    pane.appendChild(overlay);
  }
  overlay.textContent = message ?? '';
  overlay.style.display = message ? 'flex' : 'none';
}

/** 現在再生中のエピソードの状態一式（切り替えるたびに作り直す） */
let current = null; // { ep, scene, three, project, shipClassById, events, t, tEnd, playing, lastFrameMs }

function setStatus(text) {
  statusEl.textContent = text;
}

function resizeCanvases() {
  for (const c of [canvas2d, canvas3d]) {
    const w = c.clientWidth;
    const h = c.clientHeight;
    if (c.width !== w) c.width = w;
    if (c.height !== h) c.height = h;
  }
  if (current?.three) current.three.resize();
}
window.addEventListener('resize', resizeCanvases);

async function readFile(input) {
  const f = input.files?.[0];
  if (!f) return null;
  return f.text();
}

function populateEpisodeSelect() {
  episodeSelect.innerHTML = '';
  for (const ep of positionEpisodes) {
    const opt = document.createElement('option');
    const outcomeLabel = { defended: '防御成功', breached: '突破', timeout: '時間切れ' }[ep.outcome] ?? (ep.outcome ?? '未決着');
    opt.value = String(ep.episode);
    opt.textContent = `episode ${ep.episode}（${outcomeLabel}, t_end=${ep.tEnd.toFixed(1)}s）`;
    episodeSelect.appendChild(opt);
  }
  episodeSelect.disabled = positionEpisodes.length === 0;
}

async function loadScenarioForEpisode(ep) {
  const name = (ep.meta?.scenario ?? 'flag_defence_squadrons').replace(/[^a-z0-9_]/gi, '');
  const res = await fetch(`../core/scenarios/${name}.json`);
  if (!res.ok) throw new Error(`シナリオ読み込み失敗: ${name} (${res.status})`);
  return res.json();
}

async function selectEpisode(episodeIndex) {
  const ep = positionEpisodes.find((e) => e.episode === episodeIndex);
  if (!ep) return;

  setStatus(`シナリオ読み込み中… (${ep.meta?.scenario ?? '不明'})`);
  let scenario;
  try {
    scenario = await loadScenarioForEpisode(ep);
  } catch (err) {
    setStatus(String(err.message ?? err));
    return;
  }
  const scene = await loadSceneFromScenario(scenario);
  const shipClassById = new Map(scenario.spawns.map((s) => [s.id, s.shipClass]));

  resizeCanvases();
  const project = createProjection(canvas2d, scene);

  const spawnLocal = scenario.spawns.map((s) => scene.projection.latLonToLocal(s.lat, s.lon));
  const focus = {
    x: spawnLocal.reduce((sum, p) => sum + p.x, 0) / spawnLocal.length,
    y: spawnLocal.reduce((sum, p) => sum + p.y, 0) / spawnLocal.length,
  };
  const protectedAsset = scenario.protectedAssetLatLon
    ? scene.projection.latLonToLocal(scenario.protectedAssetLatLon.lat, scenario.protectedAssetLatLon.lon)
    : null;

  let three = null;
  const buildThreeScene = await loadThreeSceneBuilder();
  if (!buildThreeScene) {
    show3dMessage(
      '3D表示は利用できません。Three.jsの読み込み元（unpkg.com）にブラウザから到達できないネットワーク環境のようです。\n' +
      '2D俯瞰マップ・判断ログはそのまま利用できます。'
    );
  } else {
    try {
      three = buildThreeScene(canvas3d, scene, { focus, focusEntityId: scenario.spawns[0]?.id ?? null });
      show3dMessage(null);
    } catch (err) {
      console.error('3Dシーンの構築に失敗:', err);
      show3dMessage('3D表示の初期化に失敗しました（詳細はブラウザのコンソール参照）。2D俯瞰マップ・判断ログは利用できます。');
    }
  }

  const decisions = decisionsByEpisode.get(episodeIndex) ?? [];
  const calls = callsByEpisode.get(episodeIndex) ?? [];
  const events = buildConversationEvents(decisions, calls);
  events.unshift({ t: 0, kind: 'system', text: `episode ${ep.episode} 開始 — scenario=${scenario.name}, blue=${ep.meta?.blue ?? '?'} (${ep.meta?.model ?? ''}), red=${ep.meta?.red ?? '?'}` });
  if (ep.outcome) events.push({ t: ep.tEnd, kind: 'mission', outcome: ep.outcome });

  current = {
    ep, scene, three, project, shipClassById, protectedAsset, events,
    t: 0, tEnd: Math.max(ep.tEnd, 0.1), playing: false, lastFrameMs: null,
  };

  seek.min = '0';
  seek.max = String(current.tEnd);
  seek.step = '0.1';
  seek.value = '0';
  seek.disabled = false;
  btnPlayPause.disabled = false;
  btnPlayPause.textContent = '▶ 再生';
  emptyHint.style.display = 'none';
  outcomeBadge.className = '';
  outcomeBadge.textContent = '';

  renderFrame(0);
  setStatus(`episode ${ep.episode} 読み込み完了（${ep.byBoat?.size ?? current.ep.byBoat.size}隻・t_end=${current.tEnd.toFixed(1)}s）`);
}

function entitiesForCurrent(T) {
  const raw = entitiesAt(current.ep.byBoat, T);
  return raw.map((r) => ({ ...r, shipClass: current.shipClassById.get(r.id) ?? r.shipClass }));
}

function renderFrame(T, dtSeconds = 0) {
  if (!current) return;
  const entities = entitiesForCurrent(T);

  // 2D
  const ctx2d = canvas2d.getContext('2d');
  drawMap(ctx2d, canvas2d, current.scene, current.project);
  drawProtectedAsset(ctx2d, canvas2d, current.scene, current.project, current.protectedAsset);
  drawAgents(ctx2d, entities, current.project);

  // 3D（Three.jsのCDN読み込みに失敗した環境ではcurrent.threeがnullのままなのでスキップする）
  if (current.three) {
    current.three.updateShips(entities, T);
    current.three.updateOverviewCamera(dtSeconds);
    current.three.render(T);
  }

  // トランスポート表示
  if (document.activeElement !== seek) seek.value = String(T);
  timeReadout.textContent = `t=${T.toFixed(1)} / ${current.tEnd.toFixed(1)}s`;
  if (T >= current.tEnd - 1e-6 && current.ep.outcome) {
    outcomeBadge.className = current.ep.outcome;
    outcomeBadge.textContent = { defended: '防御成功', breached: '突破', timeout: '時間切れ' }[current.ep.outcome] ?? current.ep.outcome;
  } else {
    outcomeBadge.className = '';
    outcomeBadge.textContent = '';
  }

  renderConversation(convEntries, current.events, T, (seekT) => {
    current.t = seekT;
    current.playing = false;
    btnPlayPause.textContent = '▶ 再生';
    renderFrame(seekT);
  });
}

function tick(nowMs) {
  requestAnimationFrame(tick);
  if (!current || !current.playing) return;
  if (current.lastFrameMs == null) current.lastFrameMs = nowMs;
  const dtReal = Math.min((nowMs - current.lastFrameMs) / 1000, 0.25);
  current.lastFrameMs = nowMs;
  const speed = Number(speedSelect.value) || 1;
  current.t = Math.min(current.t + dtReal * speed, current.tEnd);
  renderFrame(current.t, dtReal * speed);
  if (current.t >= current.tEnd) {
    current.playing = false;
    btnPlayPause.textContent = '▶ 再生';
  }
}
requestAnimationFrame(tick);

btnPlayPause.addEventListener('click', () => {
  if (!current) return;
  current.playing = !current.playing;
  current.lastFrameMs = null;
  if (current.playing && current.t >= current.tEnd) current.t = 0; // 末尾で再生→最初から
  btnPlayPause.textContent = current.playing ? '⏸ 一時停止' : '▶ 再生';
});

seek.addEventListener('input', () => {
  if (!current) return;
  current.playing = false;
  btnPlayPause.textContent = '▶ 再生';
  current.t = Number(seek.value);
  renderFrame(current.t);
});

episodeSelect.addEventListener('change', () => {
  const idx = Number(episodeSelect.value);
  if (Number.isFinite(idx)) selectEpisode(idx);
});

async function processLoadedText(positionsText, decisionsText, callsText) {
  if (!positionsText) return;
  positionEpisodes = loadPositionLog(positionsText);
  decisionsByEpisode = decisionsText ? loadDecisionLog(decisionsText) : new Map();
  callsByEpisode = callsText ? loadCallLog(callsText) : new Map();
  populateEpisodeSelect();
  if (positionEpisodes.length > 0) {
    episodeSelect.value = String(positionEpisodes[0].episode);
    await selectEpisode(positionEpisodes[0].episode);
  }
}

async function handleFileInputsChanged() {
  const [positionsText, decisionsText, callsText] = await Promise.all([
    readFile(fileInputs.positions),
    readFile(fileInputs.decisions),
    readFile(fileInputs.calls),
  ]);
  if (!positionsText) {
    setStatus('位置ログを選んでください');
    return;
  }
  setStatus('ログを解析中…');
  await processLoadedText(positionsText, decisionsText, callsText);
}

for (const input of Object.values(fileInputs)) {
  input.addEventListener('change', handleFileInputsChanged);
}

btnLoadDefault.addEventListener('click', async () => {
  setStatus('既定ログを取得中…（サーバー経由でこのページを開いていない場合は失敗します）');
  try {
    const [positionsText, decisionsText, callsText] = await Promise.all([
      fetch(DEFAULT_LOGS.positions).then((r) => (r.ok ? r.text() : Promise.reject(new Error(`${r.status} ${DEFAULT_LOGS.positions}`)))),
      fetch(DEFAULT_LOGS.decisions).then((r) => (r.ok ? r.text() : null)).catch(() => null),
      fetch(DEFAULT_LOGS.calls).then((r) => (r.ok ? r.text() : null)).catch(() => null),
    ]);
    setStatus('ログを解析中…');
    await processLoadedText(positionsText, decisionsText, callsText);
  } catch (err) {
    setStatus(`既定ログの取得に失敗: ${err.message ?? err}。file://直接オープンでは動きません。ローカルサーバー（npx serve等）経由で開くか、上のファイル選択から手動で読み込んでください`);
  }
});

// index.htmlの起動チェック（ここまで例外なく到達すれば、モジュールの読み込みとイベント登録は成功している）
window.__replayViewerReady = true;
setStatus('準備完了。ログを選ぶか「既定ログを読込」を押してください');

