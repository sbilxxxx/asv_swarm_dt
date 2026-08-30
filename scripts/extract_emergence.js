// extract_emergence.js — マルチLLM（指揮官1体＋艇3体）の相互作用ログから、
// 「プロンプトに書いていないのに現れた振る舞い」を証拠つきで拾い出す。
//
// 何を創発と呼ぶかは自明ではないので、ここでは「観測できる形に落とせるもの」だけを
// 4つに限定して数える。いずれも system prompt に指示が無いことを前提に選んである
// （commander_prompt.js / boat_agent.js の buildBoatSystemPrompt を参照）:
//
//   E-1 標的の重複解消 — 指揮官が1回の采配で自艦それぞれに「別々の」敵を割り当てたか。
//       プロンプトは「重複を避けろ」と言っていない。全員が最寄り1隻に殺到しても文法上は妥当。
//   E-2 艦種の対応づけ — その割り当てが艦種同士（heavy↔heavy, scout↔scout）で揃ったか。
//       プロンプトは艦種名を含む id を渡すだけで、対応させろとは書いていない。
//   E-3 階層の不一致 — 艇が override したとき、指揮官の指定と違う標的を選んだか（真の反抗）、
//       同じ標的のまま override したか（＝標的は同意、鮮度だけ自前で取り直す再確認）。
//   E-4 役割の分化 — 艇ごと・艦種ごとの override 率の差。同じ system prompt・同じモデルで
//       置かれた位置だけが違う3体が、違う頻度で指揮官に逆らうなら、それは入力から生じた分化。
//
// 使い方:
//   node scripts/extract_emergence.js <calls.jsonl> [--out report.md] [--samples N]
'use strict';

const fs = require('node:fs');

const DEFAULT_SAMPLES = 6;

function readJsonl(file) {
  const rows = [];
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const s = line.trim();
    if (!s) continue;
    try {
      rows.push(JSON.parse(s));
    } catch {
      /* 実行中のファイルは最終行が切れていることがある。捨てる */
    }
  }
  return rows;
}

/** id から艦種を取る。scenario の命名規約 <side>-<class>[-n] に依存する */
function shipClassOf(id) {
  if (!id) return null;
  const m = String(id).match(/^(?:def|int)-([a-z]+)/);
  return m ? m[1] : null;
}

/** 艇プロンプトの "ORDER FROM COMMANDER: intercept int-heavy" から標的だけ抜く */
function orderedTargetOf(userPrompt) {
  const m = String(userPrompt || '').match(/ORDER FROM COMMANDER:\s*(.+)/);
  if (!m) return null;
  const line = m[1].trim();
  const t = line.match(/\b((?:def|int)-[a-z]+(?:-\d+)?)\b/);
  return { text: line, target: t ? t[1] : null };
}

/** 艇の応答 JSON から decision/target/reason を取る。raw が壊れていれば null */
function boatDecisionOf(row) {
  try {
    const d = JSON.parse(row.raw);
    return { decision: d.decision ?? null, action: d.action ?? null, target: d.target ?? null, reason: d.reason ?? '' };
  } catch {
    return null;
  }
}

// ================================================================ 集計

function analyze(rows) {
  const commanderRows = rows.filter((r) => !r.boatId && r.result && Array.isArray(r.result.orders));
  const boatRows = rows.filter((r) => r.boatId);

  // --- E-1 / E-2: 指揮官の1采配ごとに、標的の重複と艦種の対応を見る ---
  const assignments = [];
  for (const r of commanderRows) {
    const orders = r.result.orders.filter((o) => o.target);
    if (orders.length === 0) continue;
    const targets = orders.map((o) => o.target);
    const distinct = new Set(targets).size;
    const classMatched = orders.filter((o) => shipClassOf(o.boat) && shipClassOf(o.boat) === shipClassOf(o.target)).length;
    assignments.push({
      t: r.t,
      episode: r.episode,
      orders,
      intent: r.result.intent ?? '',
      n: orders.length,
      distinct,
      deconflicted: distinct === orders.length,
      classMatched,
      allClassMatched: classMatched === orders.length,
    });
  }

  // --- E-3 / E-4: 艇の override が「反抗」か「再確認」か ---
  const boatStats = new Map(); // id -> {obey, override, defiance, reaffirm}
  const defiances = [];
  const reaffirms = [];
  for (const r of boatRows) {
    const id = r.boatId;
    if (!boatStats.has(id)) boatStats.set(id, { id, obey: 0, override: 0, defiance: 0, reaffirm: 0, other: 0 });
    const s = boatStats.get(id);
    const d = boatDecisionOf(r);
    const ordered = orderedTargetOf(r.userPrompt);
    if (r.outcome === 'obey') {
      s.obey += 1;
      continue;
    }
    if (r.outcome !== 'override') {
      s.other += 1;
      continue;
    }
    s.override += 1;
    const chosen = d?.target ?? null;
    const assigned = ordered?.target ?? null;
    const rec = {
      t: r.t,
      episode: r.episode,
      boatId: id,
      assignedText: ordered?.text ?? '(none)',
      assigned,
      chosen,
      reason: d?.reason ?? '',
      radar: (String(r.userPrompt).match(/YOUR RADAR right now:\n([\s\S]*?)\nTIME/) || [, ''])[1].trim(),
    };
    // 指揮官が特定の標的を指していて、艇が別の標的を選んだときだけ「反抗」と数える。
    // 指揮官が patrol など標的を持たない命令のときは比較対象が無いので反抗には数えない。
    if (assigned && chosen && assigned !== chosen) {
      s.defiance += 1;
      defiances.push(rec);
    } else if (assigned && chosen && assigned === chosen) {
      s.reaffirm += 1;
      reaffirms.push(rec);
    }
  }

  return { commanderRows, boatRows, assignments, boatStats: [...boatStats.values()], defiances, reaffirms };
}

// ================================================================ 出力

function pct(a, b) {
  return b === 0 ? '—' : `${((a / b) * 100).toFixed(1)}%`;
}

function render(a, { samples, sourceFile }) {
  const L = [];
  const { assignments, boatStats, defiances, reaffirms, commanderRows, boatRows } = a;

  L.push('# マルチLLM相互作用の創発ログ抽出');
  L.push('');
  L.push(`元ログ: \`${sourceFile}\` — 指揮官の采配 ${commanderRows.length} 回 / 艇の判断 ${boatRows.length} 回`);
  L.push('');
  L.push('「創発」を主観で語らずに済むよう、**system prompt に書いていない振る舞い**だけを4種に絞って数えた。');
  L.push('プロンプト本文は `core/sim/command/commander_prompt.js` と `core/sim/agents/boat_agent.js` を参照。');
  L.push('');

  // --- E-1 / E-2 ---
  const deconflicted = assignments.filter((x) => x.deconflicted).length;
  const allClassMatched = assignments.filter((x) => x.allClassMatched).length;
  const totalOrders = assignments.reduce((s, x) => s + x.n, 0);
  const totalClassMatched = assignments.reduce((s, x) => s + x.classMatched, 0);

  L.push('## E-1 標的の重複解消 — 指揮官は言われずに敵を配分したか');
  L.push('');
  L.push('指揮官プロンプトは「1隻に1標的」「重複を避けろ」を**要求していない**。全艇を最寄りの1隻に');
  L.push('殺到させる采配も文法上は妥当に通る。それでも別々の標的へ配ったなら、配分は指示ではなく判断から出ている。');
  L.push('');
  L.push('| 指標 | 値 |');
  L.push('|---|---:|');
  L.push(`| 標的つき采配の回数 | ${assignments.length} |`);
  L.push(`| 全艇に相異なる標的を割り当てた采配 | ${deconflicted} (${pct(deconflicted, assignments.length)}) |`);
  L.push('');

  L.push('## E-2 艦種の対応づけ — heavy には heavy を当てたか');
  L.push('');
  L.push('艇の id には艦種名が入る（`def-heavy` / `int-scout` 等）が、プロンプトは**艦種を対応させろとは書いていない**。');
  L.push('それでも同種同士が噛み合ったなら、id の語からモデルが役割を読み取ったことになる。');
  L.push('');
  L.push('| 指標 | 値 |');
  L.push('|---|---:|');
  L.push(`| 個別の指示のうち艦種が一致したもの | ${totalClassMatched} / ${totalOrders} (${pct(totalClassMatched, totalOrders)}) |`);
  L.push(`| 采配まるごと艦種が揃ったもの | ${allClassMatched} / ${assignments.length} (${pct(allClassMatched, assignments.length)}) |`);
  L.push('');

  // --- E-3 ---
  L.push('## E-3 階層の不一致 — override は「反抗」か「再確認」か');
  L.push('');
  L.push('艇が override したとき、指揮官と**違う標的**を選んだのか（反抗）、**同じ標的のまま**自前の');
  L.push('新しい観測で取り直したのか（再確認）を分ける。同じ override でも意味がまるで違う。');
  L.push('');
  L.push(`- 反抗（指揮官と別の標的）: **${defiances.length}** 件`);
  L.push(`- 再確認（同じ標的を自前の鮮度で）: **${reaffirms.length}** 件`);
  L.push('');

  if (defiances.length > 0) {
    L.push('### 反抗の実例');
    L.push('');
    for (const d of defiances.slice(0, samples)) {
      L.push(`**ep${d.episode} t=${Number(d.t).toFixed(1)}s — ${d.boatId}**`);
      L.push('');
      L.push('```');
      L.push(`指揮官の命令 : ${d.assignedText}`);
      L.push(`艇の選択     : intercept ${d.chosen}`);
      L.push(`艇の言い分   : ${d.reason}`);
      L.push('自艇レーダー :');
      for (const line of String(d.radar).split('\n')) L.push(`  ${line.trim()}`);
      L.push('```');
      L.push('');
    }
  }

  if (reaffirms.length > 0) {
    L.push('### 再確認の実例（標的は同意、鮮度だけ取り直す）');
    L.push('');
    for (const d of reaffirms.slice(0, Math.min(samples, 3))) {
      L.push(`**ep${d.episode} t=${Number(d.t).toFixed(1)}s — ${d.boatId}** — 命令「${d.assignedText}」に対し ` +
        `\`${d.chosen}\` を選び直し、理由は「${d.reason}」`);
    }
    L.push('');
  }

  // --- E-4 ---
  L.push('## E-4 役割の分化 — 同じプロンプト・同じモデルで、逆らう頻度が割れたか');
  L.push('');
  L.push('3体の艇は**同一の system prompt・同一モデル**で動く。違うのは置かれた位置と、そこから見える');
  L.push('レーダーだけ。それでも override 率が割れるなら、役割は設定ではなく入力から生じている。');
  L.push('');
  L.push('| 艇 | 艦種 | obey | override | うち反抗 | うち再確認 | override率 |');
  L.push('|---|---|---:|---:|---:|---:|---:|');
  const sorted = [...boatStats].sort((x, y) => x.id.localeCompare(y.id));
  for (const s of sorted) {
    const calls = s.obey + s.override;
    L.push(`| ${s.id} | ${shipClassOf(s.id) ?? '—'} | ${s.obey} | ${s.override} | ${s.defiance} | ${s.reaffirm} | ${pct(s.override, calls)} |`);
  }
  L.push('');

  // --- 指揮官の意図の推移 ---
  L.push('## 付録 — 指揮官の意図（intent）の推移');
  L.push('');
  L.push('采配ごとに指揮官が自分で書いた一行。戦況に応じて言葉が変わるかを見る。');
  L.push('');
  for (const x of assignments.slice(0, samples * 2)) {
    L.push(`- ep${x.episode} t=${Number(x.t).toFixed(1)}s — 「${x.intent}」（${x.n}隻へ、標的 ${x.distinct} 種）`);
  }
  L.push('');

  return L.join('\n');
}

// ================================================================ main

function main() {
  const argv = process.argv.slice(2);
  if (argv.length === 0 || argv.includes('--help') || argv.includes('-h')) {
    console.log('usage: node scripts/extract_emergence.js <calls.jsonl> [--out report.md] [--samples N]');
    process.exit(argv.length === 0 ? 1 : 0);
  }
  const file = argv[0];
  let out = null;
  let samples = DEFAULT_SAMPLES;
  for (let i = 1; i < argv.length; i++) {
    if (argv[i] === '--out') out = argv[++i];
    else if (argv[i] === '--samples') samples = Number(argv[++i]);
  }
  if (!fs.existsSync(file)) throw new Error(`ログが見つからない: ${file}`);

  const rows = readJsonl(file);
  const a = analyze(rows);
  const md = render(a, { samples, sourceFile: file });

  if (out) {
    fs.writeFileSync(out, md);
    console.log(`emergence report written to ${out}`);
    console.log(
      `  采配 ${a.assignments.length} / 艇判断 ${a.boatRows.length} / 反抗 ${a.defiances.length} / 再確認 ${a.reaffirms.length}`
    );
  } else {
    console.log(md);
  }
}

main();
