/**
 * sweep_scenarios.js — 盤面パラメータの2段階探索
 *
 * 【なぜ2段階か】
 * scripted 腕は実測 20,000〜30,000 steps/s、LLM 腕は 11 steps/s——**約2,600倍の差**がある。
 * 全条件を LLM で回すのは無駄で、**盤面としてそもそも成立しない条件を LLM に食わせない**のが要点。
 *   Stage 1（本スクリプト・GPU不要・数分）: scripted 同士で格子を掃引し、勝率が極端でない
 *     （＝ゲームとして決着が散る）条件だけを残す。
 *   Stage 2（別途・GPU必要）: 生き残った条件にだけ LLM 腕を回す。
 *
 * 【掃引する軸と、その根拠】
 * 2026-08-31 の実測（submission/measurements/emergence/mechanism-verification.md）で、
 * 指揮官の統合図が85回の采配すべてで敵を1隻も取りこぼしていなかった。索敵艇のレーダー1200mに対し
 * 戦場が約550mしかなく、**部分観測が成立していない**のが原因である。さらに防御成功エピソードは
 * 16〜21秒しかなく、指揮官の判断は2回しか入らない。この2つが創発の律速なので:
 *   - fieldScale : 戦場の広さ（spawn のアセットからの距離を倍率で伸ばす）
 *   - radarScale : 探知距離の倍率（艦種間の比は保つ。sensors.radarScale）
 *   - boats      : 隻数（headless_run.js の --boats。リング状に合成される）
 *   - cmdInterval: 指揮官の判断間隔（--command-interval）
 * 本質的に効くのは radarScale/fieldScale の**比**なので、両方を振って比の空間を覆う。
 *
 * fieldScale を上げると移動時間が伸びるため、制限時間も一緒に伸ばす（さもないと全部 timeout になり、
 * 「広げたら決着しなくなった」という盤面の性質ではなく打ち切りの性質を測ってしまう）。
 *
 * 使い方:
 *   node scripts/sweep_scenarios.js --episodes 60 --out logs/sweep.json
 *   node scripts/sweep_scenarios.js --episodes 20 --field 1,2 --radar 1,0.5 --boats 8 --dry-run
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const BASE_SCENARIO = path.join(ROOT, 'core/scenarios/flag_defence_squadrons.json');

/** 決着が散っているとみなす勝率の帯。片側に寄り切った盤面は LLM を回す価値が無い */
const INTERESTING_MIN = 0.25;
const INTERESTING_MAX = 0.75;
/** timeout がこの割合を超えたら「決着しない盤面」として落とす */
const MAX_TIMEOUT_RATE = 0.2;

// ---------------------------------------------------------------------------
// シナリオ生成
// ---------------------------------------------------------------------------

/**
 * アセットからの相対位置を fieldScale 倍した派生シナリオを作る。
 * 緯度経度のまま相似拡大する（対象領域は数kmなので平面近似で足りる）。
 * 海岸線は動かさない——地形を一緒に伸ばすと「別の海域」になってしまい、
 * 広さだけを変えた比較にならない。
 */
function deriveScenario(base, { fieldScale, radarScale, episodeTimeLimitS }) {
  const s = JSON.parse(JSON.stringify(base));
  const asset = s.protectedAssetLatLon;
  const scalePoint = (p) => ({
    ...p,
    lat: asset.lat + (p.lat - asset.lat) * fieldScale,
    lon: asset.lon + (p.lon - asset.lon) * fieldScale,
  });
  s.spawns = s.spawns.map(scalePoint);
  if (Array.isArray(s.spawnsAreaLatLon)) s.spawnsAreaLatLon = s.spawnsAreaLatLon.map(scalePoint);
  s.sensors = { ...(s.sensors ?? {}), radarScale };
  s.episodeTimeLimitS = episodeTimeLimitS;
  s.name = `${base.name}__f${fieldScale}_r${radarScale}`;
  s.note =
    `[sweep 自動生成] fieldScale=${fieldScale} radarScale=${radarScale} ` +
    `episodeTimeLimitS=${episodeTimeLimitS}. 元: ${base.name}`;
  return s;
}

// ---------------------------------------------------------------------------
// 1条件の実行
// ---------------------------------------------------------------------------

function runOne({ scenarioPath, episodes, boats, cmdInterval }) {
  const args = [
    path.join(ROOT, 'scripts/headless_run.js'),
    '--scenario', scenarioPath,
    '--episodes', String(episodes),
    '--command-interval', String(cmdInterval),
    '--quiet',
  ];
  if (boats != null) args.push('--boats', String(boats));
  const out = execFileSync(process.execPath, args, { encoding: 'utf8', cwd: ROOT });

  const m = out.match(/outcomes: defended=(\d+) breached=(\d+) timeout=(\d+)/);
  const steps = out.match(/totalSteps=(\d+)/);
  if (!m) throw new Error(`集計行が読めない:\n${out.slice(0, 400)}`);
  const [defended, breached, timeout] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const total = defended + breached + timeout;
  return {
    defended,
    breached,
    timeout,
    winRate: total ? defended / total : null,
    timeoutRate: total ? timeout / total : null,
    // 1エピソードあたりの平均シム秒。指揮官が何回判断できるかの目安になる
    meanEpisodeS: steps ? (Number(steps[1]) * 0.1) / total : null,
  };
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

function parseList(v) {
  return String(v)
    .split(',')
    .map((x) => Number(x.trim()))
    .filter((x) => Number.isFinite(x));
}

function main() {
  const argv = process.argv.slice(2);
  const opts = {
    episodes: 60,
    field: [1, 2, 4],
    radar: [1, 0.5, 0.25],
    boats: [8, 16],
    cmdInterval: [10, 5],
    out: null,
    dryRun: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--episodes') opts.episodes = Number(argv[++i]);
    else if (a === '--field') opts.field = parseList(argv[++i]);
    else if (a === '--radar') opts.radar = parseList(argv[++i]);
    else if (a === '--boats') opts.boats = parseList(argv[++i]);
    else if (a === '--command-interval') opts.cmdInterval = parseList(argv[++i]);
    else if (a === '--out') opts.out = argv[++i];
    else if (a === '--dry-run') opts.dryRun = true;
    else if (a === '--help' || a === '-h') {
      console.log(
        'usage: node scripts/sweep_scenarios.js [--episodes N] [--field 1,2,4] [--radar 1,0.5,0.25]\n' +
          '                                      [--boats 8,16] [--command-interval 10,5] [--out path] [--dry-run]'
      );
      process.exit(0);
    } else throw new Error(`unknown argument: ${a}`);
  }

  const base = JSON.parse(fs.readFileSync(BASE_SCENARIO, 'utf8'));
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sweep-scen-'));
  const cells = [];
  for (const f of opts.field)
    for (const r of opts.radar)
      for (const b of opts.boats) for (const c of opts.cmdInterval) cells.push({ f, r, b, c });

  console.log(
    `格子 ${cells.length} 条件 × ${opts.episodes} エピソード（scripted・GPU不要）\n` +
      `  field=${opts.field.join(',')} radar=${opts.radar.join(',')} ` +
      `boats=${opts.boats.join(',')} cmdInterval=${opts.cmdInterval.join(',')}\n`
  );
  if (opts.dryRun) return;

  const results = [];
  const t0 = Date.now();
  for (const { f, r, b, c } of cells) {
    // 制限時間は広さに比例させる（既定240sは fieldScale=1 のときの値）
    const limit = Math.round(240 * Math.max(1, f));
    const scen = deriveScenario(base, { fieldScale: f, radarScale: r, episodeTimeLimitS: limit });
    const p = path.join(tmpDir, `${scen.name}.json`);
    fs.writeFileSync(p, JSON.stringify(scen, null, 2));
    let row;
    try {
      row = { field: f, radar: r, boats: b, cmdInterval: c, limitS: limit, ...runOne({ scenarioPath: p, episodes: opts.episodes, boats: b, cmdInterval: c }) };
    } catch (err) {
      row = { field: f, radar: r, boats: b, cmdInterval: c, limitS: limit, error: String(err.message).slice(0, 160) };
    }
    row.interesting =
      row.winRate != null &&
      row.winRate >= INTERESTING_MIN &&
      row.winRate <= INTERESTING_MAX &&
      row.timeoutRate <= MAX_TIMEOUT_RATE;
    results.push(row);
    const mark = row.error ? 'ERR ' : row.interesting ? ' ** ' : '    ';
    console.log(
      `${mark}field=${String(f).padEnd(4)} radar=${String(r).padEnd(5)} boats=${String(b).padEnd(3)} ` +
        `cmd=${String(c).padEnd(3)} -> ` +
        (row.error
          ? row.error
          : `勝率 ${(row.winRate * 100).toFixed(1)}% (D${row.defended}/B${row.breached}/T${row.timeout}) ` +
            `平均 ${row.meanEpisodeS.toFixed(1)}s ≒ 指揮官 ${Math.floor(row.meanEpisodeS / c)}回`)
    );
  }

  const keep = results.filter((r) => r.interesting);
  console.log(`\n所要 ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  console.log(`Stage 2（LLM）へ送る候補: ${keep.length} / ${results.length} 条件`);
  console.log(`  判定: 勝率 ${INTERESTING_MIN * 100}〜${INTERESTING_MAX * 100}% かつ timeout ${MAX_TIMEOUT_RATE * 100}% 以下`);
  for (const r of keep) {
    console.log(
      `  field=${r.field} radar=${r.radar} boats=${r.boats} cmd=${r.cmdInterval}s ` +
        `(勝率 ${(r.winRate * 100).toFixed(1)}% / 平均 ${r.meanEpisodeS.toFixed(1)}s / 指揮官 ${Math.floor(r.meanEpisodeS / r.cmdInterval)}回)`
    );
  }

  if (opts.out) {
    fs.writeFileSync(opts.out, JSON.stringify({ generatedAt: new Date().toISOString(), opts, results }, null, 2));
    console.log(`\nwritten: ${opts.out}`);
    console.log(`生成したシナリオ: ${tmpDir}`);
  }
}

main();
