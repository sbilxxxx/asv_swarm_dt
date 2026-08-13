# L0（指揮官LLMによる2Dマルチエージェント攻防）実装計画 v2

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> 作成: 2026-08-12 / 版: **v2**（v1 を全面改訂）
> 背景: [`review-findings-2026-08-07.md`](review-findings-2026-08-07.md) B-7「LLM/VLM/VLAのコードが1行も無い」の解消。
>
> **⚠️ 実装前に必読 — 2026-08-13 の時間モデル v2.0 による差分**: [`time-model.md`](time-model.md) が v2.0 になり、本計画のコード例に対して3点の追加要件が生じている（[`development-roadmap.md`](development-roadmap.md) §4 の D-1/D-2/D-3）。要点は **Task 5 の `DecisionScheduler` に発行トークンを必須実装すること**、`register()` に `deadlineS`/`onMiss`/`latencyModel`/ステージ宣言を受け付けさせること、Task 8/9 で実測 t_wall をステージ別に記録すること。既定値のままなら本計画に書かれた挙動は変わらない。該当箇所は Task 5 Step 3 に注記した。

**v1 からの変更（レビュー指摘による）:**

1. **時間モデルの導入（最重要）**: v1 は「推論はシム時間上で瞬時」という理想化のままだった。シム時間・実時間（推論レイテンシ／観測レンダリング）・表示時間を分離し、意思決定に `t_obs → t_issue → t_apply` のライフサイクルを与える（§時間モデル）。
2. **指揮官エージェントの導入**: 各艇に LLM を持たせる代わりに、攻防それぞれに1体の指揮官 LLM を置く。視界は**味方センサー統合図**（味方全艇の真位置＋味方レーダーが捉えた敵トラックのみ。完全俯瞰ではない）。
3. **LLM の出力を throttle/steering から指示（intercept / move_to / patrol）へ変更**: 追従制御は LLM ではない純関数モジュールが毎ステップ実行する。抽象度の高い出力ほど遅延に強く、推論回数も 2,400→48回/エピソードに減る。
4. **創発の観察は主目的から外す**: 統制群スイッチは軽いので残すが、実験タスクは「勝率と采配の質の確認」に縮小。

**Goal:** 攻防それぞれの指揮官エージェント（スクリプテッド or ローカルLLM）が味方センサー統合図を見て各艇へ指示を出し、艇は追従制御で動く階層型攻防を、明示的な時間モデルの上で RTX 3060 (12GB) だけで反復実行・計測できるようにする。

**Architecture:** `core/sim/command/` を新設し、トラック統合（FactionTracks）→ 統合図（fused_picture）→ 指揮官（scripted / LLM）→ 指示（orders）→ 艇追従制御（boat_controller）の流れを作る。意思決定の発行・発効タイミングは汎用の DecisionScheduler が管理し、**Phase 2（艇レベルLLM）でも同じスケジューラに艇を decider として登録するだけで済む**構造にする。`core/` は fs・DOM 非依存を維持。推論サーバは OpenAI 互換 API（Ollama → 将来 vLLM）。

**Tech Stack:** 素の ES Modules ／ Node v22 ／ `node:assert` のみのプレーンテスト ／ Ollama（`/v1/chat/completions`）

---

## 時間モデル（この計画の核）

> 設計の根拠・図解・具体例・既知のリスクは独立文書 [`time-model.md`](time-model.md) にまとめた。以下は実装に必要な要点のみの再掲であり、詳細はそちらを参照する。

### 3つの時間

| 時間軸 | 何が刻むか |
|---|---|
| **シム時間 t_sim** | 物理 dt=0.1s の固定ステップ。世界の因果はすべてこの軸上で定義する |
| **実時間 t_wall** | 推論レイテンシ（0.5〜10s）、観測レンダリング（L1）、物理計算（無視可）が消費する現実の時間 |
| **表示時間** | ブラウザの描画フレーム。TIME_SCALE でシム時間を実時間へマップ（既存アキュムレータ） |

### 意思決定ライフサイクル

LLM が絡む判断（指揮官、Phase 2 の艇 LLM）は、すべて次の3つの**シム時刻**で管理する:

```
t_obs = t_issue: 観測スナップショット取得・推論発行
t_apply = t_issue + latencyS: 出力が世界に効き始める
[t_issue, t_apply) の間: 世界は動き続け、各艇は「現在の指示」を実行し続ける
```

- **latencyS は実測値ではなく設定値**。同じ設定なら毎回同じ展開（決定論）で、ハードウェアに依存しない。実測（Task 1）は設定値の根拠に使う。
- 艇の追従制御（純関数）は毎ステップ・シム上瞬時扱い。実機でも追従制御は 100Hz 級で回る層なので、理想化として妥当。遅延モデルは LLM 層にだけかかる。
- **L1 の先取り**: VLM 化で観測レンダ＋推論が計8秒になっても latencyS=8 にするだけで同じ枠組み。遅延スイープが実験軸になる。

### 実行器ごとの扱い

| 実行器 | 方式 |
|---|---|
| **headless（実験）** | t_issue で発行した推論を await してから物理を進める。t_issue〜t_apply の物理は現行指示だけで決まり推論結果に依存しないため、**待ってから進めても結果は同一＝決定論**。複数 decider の発行は Promise.all で並行 |
| **ブラウザ（デモ）** | 非同期発行（fire → `.then()` で結果格納）。t_apply 到来時に未着ならアキュムレータを止めて「推論待ち」表示。物理・表示の同期は既存アキュムレータの上に乗る |

注意: 決定論はあくまで「推論の実時間に対して」の話。LLM 自体は temperature>0 でサンプルごとに揺れる。スクリプテッド同士のアームは完全決定論、LLM アームは「遅延の意味が固定された非決定論」になる。

---

## アーキテクチャ

```
Blue Commander（scripted | LLM）──┐ 発行: intervalS ごと / 発効: latencyS 後
  視界: 味方統合図（味方真位置＋味方レーダーの敵トラック）│
                                  ▼
             orders: {boat, intercept target | move_to wp | patrol center}
                                  ▼
防御艇×N: BoatController（純関数・毎ステップ・LLMなし）→ {throttle, steering}
Red Commander ── 同 ──→ 侵入艇×M: 同

DecisionScheduler が全 decider の t_issue / t_apply を一元管理
（Phase 2: 各艇も decider として登録 → 艇LLMが order＋ローカル観測で判断）
```

### Phase 2（艇レベルLLM）への接続仕様 — 本計画では実装しない

ハッカソンの主題がマルチエージェントである以上、艇 LLM は確定の次段。ここでは**壊してはいけない契約**だけ定める:

- DecisionScheduler は decider を id で汎用管理する（指揮官専用にしない）。艇を `register(boatId, {intervalS: 3, latencyS: 1})` で足せること。
- 艇 LLM の入力は「現在の order ＋ ローカル観測（レーダー・自艇状態）」、出力は order の受諾/局所修正。BoatController は艇 LLM の下位層として残る。
- プロンプト・出力スキーマの設計は Phase 2 の計画（別ファイル）で行う。

## 意図的な保留（L1 以降の判断）

| 保留する判断 | L0 での扱い |
|---|---|
| VLM への画像入力設計（解像度・視野・間引き） | 扱わない。latencyS の枠組みだけ先に用意 |
| digital-twin（3D）と swarm-sim のランタイム接続 | 接続しない（現状どおり別 World） |
| 艇 LLM のプロンプト・出力スキーマ | Phase 2 計画で設計（上記契約のみ遵守） |
| 通信内容を LLM に生成させるか | させない。統合図は艦隊データリンク（範囲無制限）を仮定。通信範囲による統合の劣化は L2 のスイープ候補としてメモに留める |
| トラックの匿名化（敵IDが見える問題） | 今回は真IDのまま（レーダーが `contact.id` を返す既存仕様を踏襲）。匿名トラック番号化は将来課題 |

---

## 前提: 実行環境のセットアップ

Task 1 の前に一度だけ実施する。

```powershell
ollama --version
# 12GB VRAM に収まる 8B 級（4bit 量子化・約5GB）。実際のタグは `ollama list` で確認
ollama pull qwen3:8b

# 同時実行数（指揮官2体の並行発行に必要）と、ブラウザからの CORS 許可
$env:OLLAMA_NUM_PARALLEL = "4"
$env:OLLAMA_ORIGINS = "*"
ollama serve
```

別ターミナルで疎通確認:

```powershell
curl.exe -s http://localhost:11434/v1/chat/completions -H "Content-Type: application/json" -d '{\"model\":\"qwen3:8b\",\"messages\":[{\"role\":\"user\",\"content\":\"reply with the single word: ok\"}],\"max_tokens\":10}'
```

## ファイル構成

| ファイル | 責務 |
|---|---|
| `core/sim/steering.js` | **新規** 操舵の共通数学（rule_based_fallback から抽出） |
| `core/sim/command/tracks.js` | **新規** 陣営別の敵トラックストア（統合図の材料） |
| `core/sim/command/orders.js` | **新規** 指示の正規化・適用・既定指示 |
| `core/sim/command/boat_controller.js` | **新規** order → {throttle, steering} の追従制御 |
| `core/sim/command/decision_scheduler.js` | **新規** t_issue/t_apply の汎用スケジューラ（時間モデルの実装） |
| `core/sim/command/fused_picture.js` | **新規** 味方センサー統合図（構造化データ） |
| `core/sim/command/commander_prompt.js` | **新規** 統合図→テキスト、指揮官システムプロンプト |
| `core/sim/command/parse_orders.js` | **新規** LLM 出力→orders（JSON 抽出・検証・部分受理） |
| `core/sim/command/scripted_commanders.js` | **新規** スクリプテッド指揮官（統制群） |
| `core/sim/command/llm_commander.js` | **新規** LLM 指揮官（HTTP・失敗時は現指示維持・統計) |
| `core/sim/agents/llm_http.js` | **新規** OpenAI 互換 POST（Phase 2 の艇 LLM と共用） |
| `core/sim/agents/rule_based_fallback.js` | 変更 steering.js から import（挙動不変） |
| `core/env/env_api.js` | 変更 観測をエージェント登録ではなく生存エンティティ基準に／`position.speed` 追加／トラック更新 |
| `core/sim/world.js` | 変更 tracks・orders・boatController の保持と reset、`radarRangeM` |
| `core/sim/sensors/radar.js` | 変更 探知距離をコンストラクタ引数化 |
| `core/scenarios/tokyo_bay_minimal.json` | 変更 `sensors.radarRangeM` 追加 |
| `scripts/llm_probe.js` | **新規** 推論サーバの単体計測 |
| `scripts/headless_run.js` | 変更 スケジューラ駆動ループ・`--blue/--red` フラグ・集計 |
| `swarm-sim/main.js` | 変更 スケジューラ非同期駆動・推論待ち表示・クエリパラメータ |
| `swarm-sim/map_view.js` | 変更 指示（WP・目標線）の描画 |
| `swarm-sim/log_panel.js` | 変更 orders 行の表示 |
| `docs/system-design.md` | 変更 時間モデルの節を追記 |
| `tests/command.test.js` | **新規** command 系の回帰テスト |

テストは既存方式（`node:assert` のみの CommonJS、core の ESM は `await import()`）に合わせる。

---

## Task 1: 推論サーバの実測ツール

**なぜ最初か:** latencyS（設定値）の根拠になる実測（1判断のレイテンシ・出力トークン数・同時実行スループット）を、実装前に押さえる。

**Files:**
- Create: `scripts/llm_probe.js`

- [ ] **Step 1: 計測スクリプトを書く**

```javascript
/**
 * llm_probe.js — OpenAI互換の推論サーバを単体で計測する（シミュレータ非依存）
 *
 * docs/l0-llm-agent-plan.md Task 1。latencyS（時間モデルの設定値）の根拠となる
 * 実測値（レイテンシ・出力トークン・同時実行時のスループット）を得る。
 * プロンプトは実際の指揮官プロンプトと同じ体裁・同程度の長さにそろえる。
 *
 * 使い方:
 *   node scripts/llm_probe.js --model qwen3:8b [--url http://localhost:11434/v1]
 *                             [--concurrency 1,2,4] [--requests 8]
 */
'use strict';

const DEFAULT_URL = 'http://localhost:11434/v1';

const SYSTEM_PROMPT = [
  'You are the BLUE force commander of uncrewed surface vessels (ASVs).',
  'Your force protects the asset at (0, 0). You lose if any intruder gets within 80 m of it.',
  'A defender neutralises an intruder by closing within 60 m.',
  "You see only your own force's fused sensor picture. Enemy tracks may be stale or missing.",
  'Coordinates are meters east/north of the asset.',
  'Reply with ONLY one JSON object:',
  '{"orders":[{"boat":"<id>","action":"intercept","target":"<track id>"}',
  ' or {"boat":"<id>","action":"move_to","waypoint":{"east_m":0,"north_m":0}}',
  ' or {"boat":"<id>","action":"patrol","center":"asset","radius_m":200}],"intent":"<max 12 words>"}',
].join('\n');

const USER_PROMPT = [
  'FORCE PICTURE t=42.0s — you command: defender-1, defender-2, defender-3',
  'ASSET at (0, 0)',
  'OWN FORCE (truth):',
  '  defender-1 at (-120, 80) heading 045 speed 5.2 m/s — order: patrol asset r=200',
  '  defender-2 at (200, -50) heading 310 speed 4.1 m/s — order: patrol asset r=200',
  '  defender-3 at (40, 260) heading 180 speed 5.8 m/s — order: patrol asset r=200',
  'ENEMY TRACKS (fused from own radars; may be stale):',
  '  intruder-1 at (450, 320) — last seen 1.2s ago by defender-3',
  '  intruder-2 at (610, -90) — last seen 14.8s ago',
  'TIME 42.0 / 240 s',
].join('\n');

function parseArgs(argv) {
  const opts = { url: DEFAULT_URL, model: null, concurrency: [1, 2, 4], requests: 8 };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--url') opts.url = argv[++i];
    else if (arg === '--model') opts.model = argv[++i];
    else if (arg === '--concurrency') opts.concurrency = argv[++i].split(',').map(Number);
    else if (arg === '--requests') opts.requests = Number(argv[++i]);
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (!opts.model) throw new Error('--model is required (e.g. --model qwen3:8b)');
  return opts;
}

async function oneRequest(url, model) {
  const startedAt = Date.now();
  const res = await fetch(`${url.replace(/\/+$/, '')}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      temperature: 0.7,
      max_tokens: 300,
      stream: false,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: USER_PROMPT },
      ],
    }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
  const json = await res.json();
  return {
    latencyMs: Date.now() - startedAt,
    outputTokens: json?.usage?.completion_tokens ?? null,
    text: json?.choices?.[0]?.message?.content ?? '',
  };
}

async function runBatch(url, model, concurrency, requests) {
  const results = [];
  const t0 = Date.now();
  let issued = 0;
  async function worker() {
    while (issued < requests) {
      issued++;
      results.push(await oneRequest(url, model));
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker));
  const wallS = (Date.now() - t0) / 1000;
  const tokens = results.map((r) => r.outputTokens).filter((n) => n != null);
  return {
    concurrency,
    requests: results.length,
    decisionsPerSec: results.length / wallS,
    meanLatencyMs: results.reduce((a, r) => a + r.latencyMs, 0) / results.length,
    meanOutputTokens: tokens.length ? tokens.reduce((a, n) => a + n, 0) / tokens.length : null,
  };
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  console.log(`model=${opts.model} url=${opts.url} requests=${opts.requests} per setting\n`);

  const sample = await oneRequest(opts.url, opts.model);
  console.log('--- sample response ---');
  console.log(sample.text);
  console.log(`(latency ${sample.latencyMs}ms, output tokens ${sample.outputTokens})\n`);

  console.log('concurrency | decisions/s | mean latency ms | mean output tokens');
  for (const c of opts.concurrency) {
    const r = await runBatch(opts.url, opts.model, c, opts.requests);
    console.log(
      `${String(r.concurrency).padStart(11)} | ${r.decisionsPerSec.toFixed(2).padStart(11)} | ` +
        `${r.meanLatencyMs.toFixed(0).padStart(15)} | ${String(r.meanOutputTokens?.toFixed(1) ?? 'n/a').padStart(18)}`
    );
  }
}

main().catch((err) => {
  console.error('llm_probe failed:', err.message);
  process.exit(1);
});
```

- [ ] **Step 2: 実行して数字を得る**

Run: `node scripts/llm_probe.js --model qwen3:8b`
Expected: orders らしき JSON のサンプル応答＋3行の計測表。concurrency=1→2 で decisions/s が伸びなければ `OLLAMA_NUM_PARALLEL` が効いていない。

- [ ] **Step 3: 実測値を本計画へ記入**

下の「実測値」欄に記入する。**latencyS の既定値（Task 8 の `--command-latency` 既定 3s）が mean latency と大きく乖離するなら、既定値のほうを実測に合わせて変える。**

> **実測値（Task 1 で記入）**
> mean latency (concurrency=2): ____ ms ／ mean output tokens: ____ ／ decisions/s (c=2): ____

- [ ] **Step 4: コミット**

```bash
git add scripts/llm_probe.js docs/l0-llm-agent-plan.md
git commit -m "feat: add llm_probe for measuring local inference cost"
```

---

## Task 2: レーダー探知距離のシナリオ設定化

**なぜ:** 探知距離 1500m 固定に対し運用領域は約 1.0×1.3km で、全艇が常に全艇を見ている。統合図の質（見えている敵／見えていない敵）が指揮官の判断材料そのものになる本計画では、部分観測が成立していないと階層の意味が消える。

**Files:**
- Modify: `core/sim/sensors/radar.js`
- Modify: `core/sim/world.js:31-35`
- Modify: `core/scenarios/tokyo_bay_minimal.json`
- Test: `tests/command.test.js`（新規作成）

- [ ] **Step 1: 失敗するテストを書く**

`tests/command.test.js` を新規作成:

```javascript
/**
 * command.test.js — 指揮官階層・時間モデルまわりの回帰テスト
 *
 * tests/core_smoke.test.js と同じ理由で CommonJS のまま書き、core/ の ESM は
 * await import() で動的ロードする。実行: node tests/command.test.js
 */
'use strict';

const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');

async function loadCore() {
  const { World } = await import('../core/sim/world.js');
  const { EnvApi } = await import('../core/env/env_api.js');
  const { createOriginProjection } = await import('../core/coord.js');
  const { loadSceneFromScenario } = await import('../core/data/adapters/index.js');
  return { World, EnvApi, createOriginProjection, loadSceneFromScenario };
}

function minimalScene({ createOriginProjection }, originLatLon = { lat: 35.45, lon: 139.75 }) {
  return { projection: createOriginProjection(originLatLon) };
}

async function testRadarRangeIsConfigurable(core) {
  const scene = minimalScene(core);

  function worldWithRange(radarRangeM) {
    const w = new core.World({ scene, capacity: 2, radarRangeM });
    w.spawn({ id: 'a', faction: 'defender', platform: 'asv', x: 0, y: 0, heading: 0 });
    w.spawn({ id: 'b', faction: 'intruder', platform: 'asv', x: 500, y: 0, heading: 0 });
    return w;
  }

  const wide = worldWithRange(1500).observe('a', 'radar');
  assert.strictEqual(wide.contacts.length, 1, '500m away is inside a 1500m radar');
  assert.strictEqual(wide.rangeM, 1500);

  const narrow = worldWithRange(300).observe('a', 'radar');
  assert.strictEqual(narrow.contacts.length, 0, '500m away is outside a 300m radar');
  assert.strictEqual(narrow.rangeM, 300);

  console.log('OK: radar detection range is configurable per world');
}

async function main() {
  const core = await loadCore();
  await testRadarRangeIsConfigurable(core);
  console.log('\nAll command tests passed.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
```

- [ ] **Step 2: 失敗を確認**

Run: `node tests/command.test.js`
Expected: FAIL — narrow のケースで `contacts.length` が 1（固定 1500m のため）

- [ ] **Step 3: `RadarSensor` を設定可能にする**

`core/sim/sensors/radar.js` の `const RANGE_M = 1500;` と class 冒頭を差し替え:

```javascript
/** 既定の探知距離。シナリオが sensors.radarRangeM を指定しない場合に使う */
export const DEFAULT_RADAR_RANGE_M = 1500;

export class RadarSensor extends SensorBase {
  /**
   * @param {{rangeM?: number}} [options] - 探知距離。運用領域より広い固定値のままだと
   *   全艇が全艇を常時捕捉し、部分観測（統合図の意味）が成立しない
   *   （docs/l0-llm-agent-plan.md Task 2）。
   */
  constructor({ rangeM = DEFAULT_RADAR_RANGE_M } = {}) {
    super();
    this.rangeM = rangeM;
  }

  observe(world, entityId) {
```

`observe()` 内の `RANGE_M` 参照2箇所を `this.rangeM` へ:

```javascript
      if (range > this.rangeM) continue;
```

```javascript
    return { type: 'radar', rangeM: this.rangeM, contacts, timestamp: world.clock };
```

- [ ] **Step 4: `World` から渡す**

`core/sim/world.js` の `this.sensors = {` ブロックを差し替え:

```javascript
    this.sensors = {
      gnss: new GnssSensor(),
      // 探知距離はシナリオ（scenario.sensors.radarRangeM）から渡す。未指定なら従来既定値。
      radar: new RadarSensor(config.radarRangeM ? { rangeM: config.radarRangeM } : {}),
      camera: config.cameraSensor ?? new UnimplementedCameraSensor(),
    };
```

JSDoc に追加: `@param {number} [config.radarRangeM]`

- [ ] **Step 5: テスト確認**

Run: `node tests/command.test.js`
Expected: PASS

- [ ] **Step 6: シナリオへ設定を追加し、3つの World 生成箇所へ配線**

`core/scenarios/tokyo_bay_minimal.json` の `"landmarkSet": "tokyo_bay",` の直後に追加:

```json
  "sensors": {
    "radarRangeM": 600,
    "note": "運用領域は約1.0km×1.3km。従来の1500mでは全艇が常に全艇を捕捉し部分観測が成立しなかったため、領域の半分程度に絞る。"
  },
```

`scripts/headless_run.js` の `const world = new World({ scene, capacity: spawns.length, protectedAsset });` を:

```javascript
  const world = new World({
    scene,
    capacity: spawns.length,
    protectedAsset,
    radarRangeM: scenario.sensors?.radarRangeM,
  });
```

`swarm-sim/main.js` の `new World({` ブロックへ1行追加（`protectedAsset:` の後）:

```javascript
    radarRangeM: scenario.sensors?.radarRangeM,
```

`digital-twin/main.js:43` を:

```javascript
  const world = new World({
    scene,
    cameraSensor,
    capacity: scenario.spawns.length,
    protectedAsset,
    radarRangeM: scenario.sensors?.radarRangeM,
  });
```

- [ ] **Step 7: 回帰確認（勝敗バランスの再調整込み）**

Run: `node tests/core_smoke.test.js`
Expected: PASS。ただし `testMultiEpisodeOutcomeVariety`（既定シナリオ・ルールベースで defended/breached 両方が出るか）は探知距離変更の影響を受ける。**FAIL した場合は `radarRangeM` を 800 に緩めて再実行し、両結果が出る値を採用する**（このテストは旧アーキテクチャの回帰基準として残す）。

- [ ] **Step 8: コミット**

```bash
git add core/sim/sensors/radar.js core/sim/world.js core/scenarios/tokyo_bay_minimal.json scripts/headless_run.js swarm-sim/main.js digital-twin/main.js tests/command.test.js
git commit -m "feat: make radar range scenario-configurable so observation is actually partial"
```

---

## Task 3: 観測パイプラインの整備（エンティティ基準化・速度・トラックストア）

**なぜ:** (a) 現状 `_observationForAll()` は `world.agents` 登録者だけに観測を作るが、v2 では艇がエージェントオブジェクトを持たなくなる（追従制御は World 側）。センサーは「エージェント」ではなく「艇」に付くものなので、生存エンティティ基準に直す。(b) 統合図の材料になる陣営別トラックストアを、この観測パスに載せる。

**Files:**
- Create: `core/sim/command/tracks.js`
- Modify: `core/env/env_api.js`
- Modify: `core/sim/world.js`
- Test: `tests/command.test.js`

- [ ] **Step 1: 失敗するテストを書く**

`tests/command.test.js` に追加し、`main()` から呼ぶ:

```javascript
async function testObservationIsEntityBasedAndTracksFuse(core) {
  const scene = minimalScene(core);
  // agent を一切登録しない World。v2 では艇はエージェントオブジェクトを持たない
  const world = new core.World({ scene, capacity: 3, radarRangeM: 600, protectedAsset: { x: 0, y: 0 } });
  world.spawn({ id: 'd1', faction: 'defender', platform: 'asv', x: 0, y: 0, heading: 0 });
  world.spawn({ id: 'd2', faction: 'defender', platform: 'asv', x: 2000, y: 0, heading: 0 }); // d1のレーダー外
  world.spawn({ id: 'i1', faction: 'intruder', platform: 'asv', x: 2000, y: 300, heading: Math.PI });
  const env = new core.EnvApi(world);

  const obs = env.reset({ scenario: 'test', episodeIndex: 1 });
  assert.ok(obs.d1 && obs.d2 && obs.i1, 'observations exist without any registered agent');
  assert.strictEqual(typeof obs.d1.position.speed, 'number', 'position carries speed');

  // i1 は d2 のレーダー（600m）内・d1 の外 → defender 陣営のトラックに統合される
  env.step({});
  const tracks = world.tracks.defender.list();
  assert.strictEqual(tracks.length, 1, 'enemy seen by any friendly radar becomes a faction track');
  assert.strictEqual(tracks[0].id, 'i1');
  assert.strictEqual(tracks[0].seenBy, 'd2');
  assert.ok(Math.abs(tracks[0].x - 2000) < 30 && Math.abs(tracks[0].y - 300) < 30, 'track position is world coords');

  // intruder 側のトラックにも defender が載る（対称）
  assert.ok(world.tracks.intruder.list().some((t) => t.id === 'd2'), 'intruder side tracks defenders too');

  // レーダー外へ消えてもトラックは残り、lastSeenT が古いまま止まる（stale）
  const i = world.state.indexOf('i1');
  world.state.x[i] = 5000;
  const before = world.tracks.defender.list()[0].lastSeenT;
  env.step({});
  env.step({});
  const after = world.tracks.defender.list().find((t) => t.id === 'i1');
  assert.ok(after, 'stale track is retained, not deleted');
  assert.strictEqual(after.lastSeenT, before, 'lastSeenT freezes when contact is lost');

  // reset でトラックも消える
  env.reset({ scenario: 'test', episodeIndex: 2 });
  assert.strictEqual(world.tracks.defender.list().length, 0, 'reset clears tracks');

  console.log('OK: observations are entity-based; faction tracks fuse, persist stale, and reset');
}
```

- [ ] **Step 2: 失敗を確認**

Run: `node tests/command.test.js`
Expected: FAIL — `world.tracks` が undefined／obs が空（agent 未登録のため）

- [ ] **Step 3: トラックストアを実装**

`core/sim/command/tracks.js` を新規作成:

```javascript
/**
 * tracks.js — 陣営別の敵トラックストア（指揮官の統合図の材料）
 *
 * 各艇のレーダーが捉えた敵コンタクトを、艦隊データリンク（範囲無制限）で
 * 陣営単位に統合する。指揮官の視界は「完全俯瞰」ではなくこのストア経由に限る:
 * どの味方レーダーにも映っていない敵は、最後に見えた位置のまま stale に古びる。
 *
 * 通信範囲による統合の劣化（リンク切れの艇は寄与しない等）は L2 のスイープ候補。
 * トラック id はレーダーが返す真の entityId をそのまま使う（匿名化は将来課題）。
 */

export class FactionTracks {
  /** @param {string} faction - このストアを持つ陣営（'defender' | 'intruder'） */
  constructor(faction) {
    this.faction = faction;
    /** @type {Map<string, {id:string, x:number, y:number, lastSeenT:number, seenBy:string}>} */
    this.tracks = new Map();
  }

  /**
   * 1艇分のレーダー観測を取り込む。敵陣営のコンタクトだけをワールド座標へ復元して格納する。
   * @param {string} observerId
   * @param {{x:number, y:number}} observerPos
   * @param {{contacts: Array, timestamp: number}} radarObs
   */
  updateFromRadar(observerId, observerPos, radarObs) {
    for (const c of radarObs?.contacts ?? []) {
      if (c.faction === this.faction) continue;
      this.tracks.set(c.id, {
        id: c.id,
        x: observerPos.x + Math.cos(c.bearingRad) * c.rangeM,
        y: observerPos.y + Math.sin(c.bearingRad) * c.rangeM,
        lastSeenT: radarObs.timestamp,
        seenBy: observerId,
      });
    }
  }

  /** @returns {Array<{id:string, x:number, y:number, lastSeenT:number, seenBy:string}>} */
  list() {
    return [...this.tracks.values()];
  }

  reset() {
    this.tracks.clear();
  }
}
```

- [ ] **Step 4: World に持たせる**

`core/sim/world.js` の import 群に追加:

```javascript
import { FactionTracks } from './command/tracks.js';
```

constructor の `this.comms = new MessageBus();` の直後に追加:

```javascript
    /** 陣営別の敵トラックストア（味方レーダーの統合。指揮官の視界の材料） */
    this.tracks = {
      defender: new FactionTracks('defender'),
      intruder: new FactionTracks('intruder'),
    };
```

`resetEntities()` の `this.comms = new MessageBus();` の直後に追加:

```javascript
    this.tracks.defender.reset();
    this.tracks.intruder.reset();
```

- [ ] **Step 5: EnvApi を生存エンティティ基準にし、速度とトラック更新を配線**

`core/env/env_api.js` の `_observationForAll()` を差し替え:

```javascript
  _observationForAll() {
    this._reportContacts();
    const obs = {};
    const state = this.world.state;
    // エージェント登録の有無ではなく「生存している艇」を基準にする。センサーは艇に付く
    // ものであり、v2 では追従制御の艇がエージェントオブジェクトを持たないため
    // （docs/l0-llm-agent-plan.md Task 3）。死亡艇のセンサーは観測を返さない。
    for (let i = 0; i < state.count; i++) {
      if (!state.alive[i]) continue;
      const id = state.id[i];
      const radar = this.world.observe(id, 'radar');
      // 統合図の材料: 各艇のレーダーを自陣営のトラックストアへ流し込む
      this.world.tracks[state.faction[i]]?.updateFromRadar(id, { x: state.x[i], y: state.y[i] }, radar);
      obs[id] = {
        gnss: this.world.observe(id, 'gnss'),
        radar,
        messages: this.world.comms.receive(id),
        // 自艇の位置・針路・速度（ローカル座標）
        position: { x: state.x[i], y: state.y[i], heading: state.heading[i], speed: state.speed[i] },
        protectedAsset: this.world.protectedAsset ? { ...this.world.protectedAsset } : null,
        episode: this.logger.currentEpisode,
        timestamp: this.world.clock,
      };
    }
    return obs;
  }
```

`_reportContacts()` の `for (const id of this.world.agents.keys()) {` も生存エンティティ基準へ:

```javascript
    const state = this.world.state;
    for (let k = 0; k < state.count; k++) {
      if (!state.alive[k]) continue;
      const id = state.id[k];
```

（ループ内の `const i = this.world.state.indexOf(id);` はそのまま動く。閉じ括弧の対応のみ確認する）

- [ ] **Step 6: テスト確認**

Run: `node tests/command.test.js && node tests/core_smoke.test.js`
Expected: 両方 PASS（core_smoke は従来エージェント登録済みの艇のみだったので観測対象は実質不変）

- [ ] **Step 7: コミット**

```bash
git add core/sim/command/tracks.js core/sim/world.js core/env/env_api.js tests/command.test.js
git commit -m "feat: entity-based observations with per-faction fused track stores"
```

---

## Task 4: 指示（orders）と艇の追従制御

**Files:**
- Create: `core/sim/steering.js`
- Create: `core/sim/command/orders.js`
- Create: `core/sim/command/boat_controller.js`
- Modify: `core/sim/agents/rule_based_fallback.js`（共通数学を import に差し替え）
- Modify: `core/sim/world.js`（orders・controller の保持と reset）
- Test: `tests/command.test.js`

- [ ] **Step 1: 操舵数学を共通モジュールへ抽出**

`core/sim/steering.js` を新規作成（`rule_based_fallback.js` の同名関数を移動。実装は同一）:

```javascript
/**
 * steering.js — 操舵の共通数学
 *
 * rule_based_fallback.js（旧・艇単位ルールエージェント）と
 * command/boat_controller.js（v2・指示追従制御）の両方が使う。
 */

/** レーダーの相対値（bearingRad・rangeM）から、コンタクトのワールド絶対座標を復元する */
export function contactWorldPosition(observerPosition, contact) {
  return {
    x: observerPosition.x + Math.cos(contact.bearingRad) * contact.rangeM,
    y: observerPosition.y + Math.sin(contact.bearingRad) * contact.rangeM,
  };
}

/** 2つの絶対方位を単位ベクトルの加重平均で合成する（±πをまたぐ角度平均の破綻を避ける） */
export function blendBearings(bearingA, bearingB, weightB) {
  const weightA = 1 - weightB;
  const x = Math.cos(bearingA) * weightA + Math.cos(bearingB) * weightB;
  const y = Math.sin(bearingA) * weightA + Math.sin(bearingB) * weightB;
  if (x === 0 && y === 0) return bearingA;
  return Math.atan2(y, x);
}

/**
 * @param {number} absoluteBearingRad - ワールド座標系での絶対方位
 * @param {number} selfHeadingRad - 自艇の現在針路
 * @returns {number} -1〜1 の操舵量
 */
export function relativeBearingToSteering(absoluteBearingRad, selfHeadingRad) {
  const relative = Math.atan2(
    Math.sin(absoluteBearingRad - selfHeadingRad),
    Math.cos(absoluteBearingRad - selfHeadingRad)
  );
  return Math.max(-1, Math.min(1, relative / Math.PI));
}
```

`core/sim/agents/rule_based_fallback.js` の同名3関数（`contactWorldPosition` / `blendBearings` / `relativeBearingToSteering`）の定義を削除し、ファイル冒頭の import に追加:

```javascript
import { contactWorldPosition, blendBearings, relativeBearingToSteering } from '../steering.js';
```

Run: `node tests/core_smoke.test.js`
Expected: PASS（挙動不変の抽出であること）

- [ ] **Step 2: 失敗するテストを書く（orders と controller）**

`tests/command.test.js` に追加し、`main()` から呼ぶ:

```javascript
async function testOrdersApplyAndDefaults(core) {
  const { applyOrders, applyDefaultOrders } = await import('../core/sim/command/orders.js');
  const scene = minimalScene(core);
  const world = new core.World({ scene, capacity: 3, protectedAsset: { x: 100, y: 200 } });
  world.spawn({ id: 'd1', faction: 'defender', platform: 'asv', x: 0, y: 0, heading: 0 });
  world.spawn({ id: 'd2', faction: 'defender', platform: 'asv', x: 50, y: 0, heading: 0 });
  world.spawn({ id: 'i1', faction: 'intruder', platform: 'asv', x: 500, y: 0, heading: 0 });

  applyDefaultOrders(world);
  assert.strictEqual(world.orders.get('d1').action, 'patrol', 'defenders default to patrolling the asset');
  assert.strictEqual(world.orders.get('i1').action, 'move_to', 'intruders default to heading for the asset');
  assert.ok(Math.abs(world.orders.get('i1').waypointWorld.x - 100) < 1e-9, 'default waypoint is the asset (world coords)');

  // east/north（アセット基準）→ ワールド座標への変換と、他陣営の艇・未知の艇の無視
  world.tracks.defender.tracks.set('i1', { id: 'i1', x: 500, y: 0, lastSeenT: 0, seenBy: 'd1' });
  applyOrders(world, 'defender', [
    { boat: 'd1', action: 'move_to', waypoint: { eastM: 10, northM: -20 } },
    { boat: 'd2', action: 'intercept', target: 'i1' },
    { boat: 'i1', action: 'patrol', center: 'asset', radiusM: 100 }, // 敵艇への指示 → 無視
    { boat: 'ghost', action: 'patrol', center: 'asset', radiusM: 100 }, // 存在しない艇 → 無視
  ]);
  assert.strictEqual(world.orders.get('d1').action, 'move_to');
  assert.ok(Math.abs(world.orders.get('d1').waypointWorld.x - 110) < 1e-9, 'east_m is relative to the asset');
  assert.ok(Math.abs(world.orders.get('d1').waypointWorld.y - 180) < 1e-9, 'north_m is relative to the asset');
  assert.strictEqual(world.orders.get('d2').action, 'intercept');
  assert.ok(world.orders.get('d2').lastKnown, 'intercept order carries last known target position from tracks');
  assert.strictEqual(world.orders.get('i1').action, 'move_to', 'cross-faction order is ignored');

  // reset で既定指示へ戻る
  world.resetEntities();
  assert.strictEqual(world.orders.get('d1').action, 'patrol', 'reset restores default orders');

  console.log('OK: orders normalise to world coords, guard factions, and reset to defaults');
}

async function testBoatControllerFollowsOrders(core) {
  const { BoatController } = await import('../core/sim/command/boat_controller.js');
  const ctl = new BoatController();

  const obsAt = (x, y, heading, contacts = []) => ({
    timestamp: 10,
    position: { x, y, heading, speed: 3 },
    radar: { rangeM: 600, contacts },
    protectedAsset: null,
  });

  // move_to: 真北の waypoint へは左旋回（heading 0 = 東, 数学規約で北= +π/2 = steering正）
  const north = ctl.decide(
    { action: 'move_to', waypointWorld: { x: 0, y: 1000 } },
    obsAt(0, 0, 0), 'd1', 'defender'
  );
  assert.ok(north.throttle > 0.5, 'move_to drives forward');
  assert.ok(north.steering > 0.3, `turn toward north expected positive steering, got ${north.steering}`);

  // move_to 到達後は待機周回に切り替わる（暴走して通り過ぎない）
  const arrived = ctl.decide(
    { action: 'move_to', waypointWorld: { x: 5, y: 0 } },
    obsAt(0, 0, 0), 'd1', 'defender'
  );
  assert.ok(arrived.throttle < 0.5, 'arrival switches to low-throttle loiter');

  // intercept: 見えている目標に向かう。2回目の呼び出しで速度推定つき（履歴使用）でも破綻しない
  const contact = { id: 'i1', faction: 'intruder', rangeM: 300, bearingRad: 0 };
  const first = ctl.decide({ action: 'intercept', target: 'i1' }, obsAt(0, 0, Math.PI / 2, [contact]), 'd1', 'defender');
  assert.ok(first.throttle === 1, 'intercept is full throttle');
  assert.ok(first.steering < -0.3, 'target dead east while heading north => starboard turn (negative)');
  const second = ctl.decide(
    { action: 'intercept', target: 'i1' },
    { ...obsAt(0, 0, Math.PI / 2, [{ ...contact, rangeM: 280 }]), timestamp: 11 },
    'd1', 'defender'
  );
  assert.ok(Number.isFinite(second.steering), 'lead pursuit with history stays finite');

  // intercept: 目標が見えないときは lastKnown へ向かう
  const blind = ctl.decide(
    { action: 'intercept', target: 'i1', lastKnown: { x: 0, y: 500 } },
    obsAt(0, 0, 0), 'd1', 'defender'
  );
  assert.ok(blind.steering > 0.3, 'blind intercept heads for last known position');

  // patrol: 中心の近くでは一定舵の周回
  const patrol = ctl.decide(
    { action: 'patrol', centerWorld: { x: 0, y: 0 }, radiusM: 200 },
    obsAt(50, 0, 0), 'd1', 'defender'
  );
  assert.ok(patrol.steering !== 0 && patrol.throttle < 0.5, 'patrol near center is a slow constant turn');

  // reset で追跡履歴が消える
  ctl.reset();
  assert.strictEqual(ctl.targetHistory.size, 0);

  console.log('OK: boat controller follows move_to / intercept / patrol orders');
}
```

- [ ] **Step 3: 失敗を確認**

Run: `node tests/command.test.js`
Expected: FAIL — `Cannot find module ... orders.js`

- [ ] **Step 4: orders を実装**

`core/sim/command/orders.js` を新規作成:

```javascript
/**
 * orders.js — 指揮官の指示の正規化・適用・既定指示
 *
 * 指揮官（LLM/スクリプテッド）が出す指示はアセット基準の east/north (m)。
 * 適用時にワールド座標へ変換して World.orders に保存し、艇の追従制御
 * （boat_controller.js）は毎ステップこれを参照する。
 * 指示に無い艇は現在の指示を保持する（「新しい指示が来るまで従前どおり」）。
 */

export const ORDER_ACTIONS = ['intercept', 'move_to', 'patrol'];

const DEFAULT_PATROL_RADIUS_M = 200;

/** アセット基準 east/north → ワールド座標 */
function toWorld(asset, p) {
  return { x: asset.x + p.eastM, y: asset.y + p.northM };
}

function assetOf(world) {
  return world.protectedAsset ?? { x: 0, y: 0 };
}

/**
 * 正規化済み指示（parse_orders.js / scripted_commanders.js の出力）を適用する。
 * 他陣営・未知・死亡艇への指示は黙って無視する（数は戻り値で返す）。
 * @param {import('../world.js').World} world
 * @param {string} faction - 指示を出した指揮官の陣営
 * @param {Array<{boat:string, action:string, target?:string, waypoint?:{eastM:number,northM:number},
 *   center?:'asset'|{eastM:number,northM:number}, radiusM?:number}>} orders
 * @returns {{applied: number, ignored: number}}
 */
export function applyOrders(world, faction, orders) {
  const asset = assetOf(world);
  let applied = 0;
  let ignored = 0;
  for (const o of orders ?? []) {
    const i = world.state.indexOf(o.boat);
    if (i < 0 || !world.state.alive[i] || world.state.faction[i] !== faction) {
      ignored++;
      continue;
    }
    const stored = { action: o.action, issuedT: world.clock };
    if (o.action === 'intercept') {
      stored.target = o.target;
      // 追従制御が「まだ自分のレーダーに映っていない目標」へ向かえるよう、
      // 発令時点のトラック位置を last known として同梱する
      const track = world.tracks[faction]?.tracks.get(o.target);
      stored.lastKnown = track ? { x: track.x, y: track.y } : null;
    } else if (o.action === 'move_to') {
      stored.waypointWorld = toWorld(asset, o.waypoint);
    } else if (o.action === 'patrol') {
      stored.centerWorld = o.center === 'asset' ? { ...asset } : toWorld(asset, o.center);
      stored.radiusM = o.radiusM ?? DEFAULT_PATROL_RADIUS_M;
    } else {
      ignored++;
      continue;
    }
    world.orders.set(o.boat, stored);
    applied++;
  }
  return { applied, ignored };
}

/**
 * エピソード開始時の既定指示。指揮官の最初の指示が発効する（t = latencyS）までの間、
 * 艇が無指示で漂わないようにする。防御=アセット哨戒、侵入=アセットへ直行。
 */
export function applyDefaultOrders(world) {
  const asset = assetOf(world);
  const state = world.state;
  for (let i = 0; i < state.count; i++) {
    const id = state.id[i];
    if (state.faction[i] === 'defender') {
      world.orders.set(id, {
        action: 'patrol',
        centerWorld: { ...asset },
        radiusM: DEFAULT_PATROL_RADIUS_M,
        issuedT: 0,
      });
    } else {
      world.orders.set(id, { action: 'move_to', waypointWorld: { ...asset }, issuedT: 0 });
    }
  }
}

/** 統合図・ログ表示用の1行要約 */
export function describeOrder(order) {
  if (!order) return 'none';
  if (order.action === 'intercept') return `intercept ${order.target}`;
  if (order.action === 'move_to') {
    return `move_to (${Math.round(order.waypointWorld.x)}, ${Math.round(order.waypointWorld.y)})`;
  }
  if (order.action === 'patrol') {
    return `patrol (${Math.round(order.centerWorld.x)}, ${Math.round(order.centerWorld.y)}) r=${order.radiusM}`;
  }
  return order.action;
}
```

- [ ] **Step 5: 追従制御を実装**

`core/sim/command/boat_controller.js` を新規作成:

```javascript
/**
 * boat_controller.js — 指示（order）→ {throttle, steering} の追従制御
 *
 * LLM ではない純関数的モジュール。毎物理ステップ実行され、シム上は瞬時扱い
 * （実機でも追従制御は 100Hz 級で回る層。時間モデルの遅延は LLM 層にだけかかる）。
 * 定数・lead pursuit の考え方は旧 rule_based_fallback.js を踏襲する。
 *
 * targetHistory（lead pursuit 用の直前目標位置）だけが状態。エピソードごとに reset() する。
 */

import { contactWorldPosition, blendBearings, relativeBearingToSteering } from '../steering.js';

const EVASION_RANGE_M = 200;
const EVASION_WEIGHT = 0.25;
const OWN_SPEED_ESTIMATE_MPS = 6;
const MAX_LOOKAHEAD_S = 6;
const ARRIVE_RADIUS_M = 30;
const PATROL_THROTTLE = 0.35;
const PATROL_STEERING = 0.2;
/** intercept で目標を見失ったとき、lastKnown をこの半径まで詰めたら捜索周回へ移る */
const SEARCH_RADIUS_M = 120;

export class BoatController {
  constructor() {
    /** @type {Map<string, {targetId:string, x:number, y:number, t:number}>} boatId -> 直前の目標観測 */
    this.targetHistory = new Map();
  }

  reset() {
    this.targetHistory.clear();
  }

  /**
   * @param {object|null} order - World.orders の1件（applyOrders が正規化済み）
   * @param {object} observation - EnvApi の1艇分観測
   * @param {string} selfId
   * @param {string} faction
   * @returns {{throttle:number, steering:number}}
   */
  decide(order, observation, selfId, faction) {
    const position = observation?.position;
    const heading = position?.heading ?? 0;
    if (!order || !position) return { throttle: 0.3, steering: 0 };

    if (order.action === 'intercept') return this._intercept(order, observation, selfId, position, heading);
    if (order.action === 'move_to') return this._moveTo(order, observation, faction, position, heading);
    if (order.action === 'patrol') return this._patrol(order.centerWorld, order.radiusM, position, heading);
    return { throttle: 0.3, steering: 0 };
  }

  _intercept(order, observation, selfId, position, heading) {
    const contact = observation.radar?.contacts?.find((c) => c.id === order.target);
    if (contact) {
      const world = contactWorldPosition(position, contact);
      const prev = this.targetHistory.get(selfId);
      let aim = contact.bearingRad;
      // lead pursuit: 等速の純追跡は幾何学的に間合いを詰め切れない（旧実装の実測どおり）。
      // 直前観測との有限差分で目標速度を推定し、見越し点を狙う。
      if (prev && prev.targetId === order.target && observation.timestamp > prev.t) {
        const dt = observation.timestamp - prev.t;
        const vx = (world.x - prev.x) / dt;
        const vy = (world.y - prev.y) / dt;
        const lookahead = Math.min(contact.rangeM / OWN_SPEED_ESTIMATE_MPS, MAX_LOOKAHEAD_S);
        aim = Math.atan2(world.y + vy * lookahead - position.y, world.x + vx * lookahead - position.x);
      }
      this.targetHistory.set(selfId, { targetId: order.target, x: world.x, y: world.y, t: observation.timestamp });
      return { throttle: 1.0, steering: relativeBearingToSteering(aim, heading) };
    }
    // 目標が自レーダーに映っていない: 発令時の last known へ向かい、着いたら捜索周回
    if (order.lastKnown) {
      const dx = order.lastKnown.x - position.x;
      const dy = order.lastKnown.y - position.y;
      if (Math.hypot(dx, dy) > SEARCH_RADIUS_M) {
        return { throttle: 0.9, steering: relativeBearingToSteering(Math.atan2(dy, dx), heading) };
      }
      return this._patrol(order.lastKnown, SEARCH_RADIUS_M, position, heading);
    }
    return { throttle: 0.5, steering: 0.15 }; // 手がかり無し: 緩い旋回で捜索
  }

  _moveTo(order, observation, faction, position, heading) {
    const wp = order.waypointWorld;
    const dx = wp.x - position.x;
    const dy = wp.y - position.y;
    if (Math.hypot(dx, dy) <= ARRIVE_RADIUS_M) {
      // ASV運動学に抗力が無く throttle 0 でも速度が残るため、到達後は小半径の待機周回にする
      return this._patrol(wp, 40, position, heading);
    }
    let bearing = Math.atan2(dy, dx);
    // 侵入艇の回避反射（艇レベルの反射であって戦術判断ではないので、指揮官の層ではなくここに置く）
    if (faction === 'intruder') {
      const nearest = observation.radar?.contacts
        ?.filter((c) => c.faction !== faction)
        ?.sort((a, b) => a.rangeM - b.rangeM)[0];
      if (nearest && nearest.rangeM < EVASION_RANGE_M) {
        bearing = blendBearings(bearing, nearest.bearingRad + Math.PI, EVASION_WEIGHT);
      }
    }
    return { throttle: 0.85, steering: relativeBearingToSteering(bearing, heading) };
  }

  _patrol(center, radiusM, position, heading) {
    const dx = center.x - position.x;
    const dy = center.y - position.y;
    if (Math.hypot(dx, dy) > radiusM) {
      return { throttle: 0.5, steering: relativeBearingToSteering(Math.atan2(dy, dx), heading) };
    }
    return { throttle: PATROL_THROTTLE, steering: PATROL_STEERING };
  }
}

/**
 * 全生存艇の action をまとめて計算する（headless / swarm-sim 共用のヘルパー）。
 * @param {import('../world.js').World} world
 * @param {Record<string, object>} observations - 直前 step の観測
 * @returns {Record<string, {throttle:number, steering:number}>}
 */
export function computeBoatActions(world, observations) {
  const actions = {};
  const state = world.state;
  for (let i = 0; i < state.count; i++) {
    if (!state.alive[i]) continue;
    const id = state.id[i];
    const obs = observations?.[id];
    if (!obs) continue;
    actions[id] = world.boatController.decide(world.orders.get(id), obs, id, state.faction[i]);
  }
  return actions;
}
```

- [ ] **Step 6: World に orders と controller を持たせる**

`core/sim/world.js` の import に追加:

```javascript
import { applyDefaultOrders } from './command/orders.js';
import { BoatController } from './command/boat_controller.js';
```

constructor の tracks 追加箇所の直後に:

```javascript
    /** @type {Map<string, object>} boatId -> 現在の指示（command/orders.js が正規化して格納） */
    this.orders = new Map();
    /** 指示→操舵の追従制御（毎ステップ・LLMなし）。targetHistory を持つため World が reset を管理 */
    this.boatController = new BoatController();
```

`resetEntities()` の tracks reset の直後に:

```javascript
    this.boatController.reset();
    applyDefaultOrders(this);
```

`spawn()` の末尾（`return index;` の直前）に追加（spawn 直後から指示を持たせる。resetEntities 前に step する使い方への保険）:

```javascript
    applyDefaultOrders(this);
```

- [ ] **Step 7: テスト確認**

Run: `node tests/command.test.js && node tests/core_smoke.test.js`
Expected: 両方 PASS

- [ ] **Step 8: コミット**

```bash
git add core/sim/steering.js core/sim/command/orders.js core/sim/command/boat_controller.js core/sim/agents/rule_based_fallback.js core/sim/world.js tests/command.test.js
git commit -m "feat: waypoint orders and per-step boat follow controller"
```

---

## Task 5: DecisionScheduler（時間モデルの実装）

**Files:**
- Create: `core/sim/command/decision_scheduler.js`
- Modify: `docs/system-design.md`（時間モデルの節を追記）
- Test: `tests/command.test.js`

- [ ] **Step 1: 失敗するテストを書く**

`tests/command.test.js` に追加し、`main()` から呼ぶ:

```javascript
async function testDecisionSchedulerLifecycle() {
  const { DecisionScheduler } = await import('../core/sim/command/decision_scheduler.js');
  const s = new DecisionScheduler();
  s.register('blue', { intervalS: 10, latencyS: 3 });
  s.register('red', { intervalS: 10, latencyS: 3 });

  // t=0: 両方発行対象
  assert.deepStrictEqual(s.dueToIssue(0).sort(), ['blue', 'red']);
  s.markIssued('blue', 0);
  s.markIssued('red', 0);
  assert.deepStrictEqual(s.dueToIssue(0), [], 'pending中は再発行しない');

  // 結果が来る前に applyAtT へ達したら blocked（ブラウザの推論待ちの判定に使う）
  assert.deepStrictEqual(s.dueToApply(2.9), []);
  assert.deepStrictEqual(s.blockedAt(3.0).sort(), ['blue', 'red']);

  // 結果を渡すと t_apply 以降に適用対象になる。t_apply より前には決してならない
  s.provideResult('blue', { orders: [], intent: 'hold' });
  assert.deepStrictEqual(s.dueToApply(2.9), [], '結果が来ていても t_apply 前は適用しない');
  assert.deepStrictEqual(s.dueToApply(3.0), ['blue']);
  assert.deepStrictEqual(s.blockedAt(3.0), ['red'], 'redはまだ未着');

  const result = s.takeResult('blue');
  assert.strictEqual(result.intent, 'hold');
  assert.deepStrictEqual(s.dueToApply(3.0), [], 'take後は消える');

  // 浮動小数の蓄積誤差に耐える（0.1を30回足した値は3.0と厳密一致しない）
  s.provideResult('red', { orders: [], intent: 'x' });
  let t = 0;
  for (let i = 0; i < 30; i++) t += 0.1;
  assert.deepStrictEqual(s.dueToApply(t), ['red'], `float-accumulated t=${t} must count as reaching 3.0`);
  s.takeResult('red');

  // 次の発行は nextIssueAtT（t=10）から。resetで全て初期化
  assert.deepStrictEqual(s.dueToIssue(9.9), []);
  assert.deepStrictEqual(s.dueToIssue(10.0).sort(), ['blue', 'red']);
  s.reset();
  assert.deepStrictEqual(s.dueToIssue(0).sort(), ['blue', 'red']);

  console.log('OK: DecisionScheduler issues, blocks, applies at t_apply, and resets');
}
```

- [ ] **Step 2: 失敗を確認**

Run: `node tests/command.test.js`
Expected: FAIL — `Cannot find module ... decision_scheduler.js`

- [ ] **Step 3: 実装する**

> **v2.0 差分（D-1/D-2）**: 下のコードは 2026-08-12 時点の版で、発行トークンを持たない。実装時は次の2点を足すこと。
> 1. `markIssued(id, t)` が `{generation, seq}` のトークンを返し、`provideResult(id, result, token)` がトークン一致時のみ書き込む。`reset()` は generation を進める。これは `time-model.md` §12 のエピソード跨ぎリスクと §12.5 の締切超過結果の破棄を、1つの機構でまとめて解決する。
> 2. `register()` が `deadlineS`（既定 `Infinity`）・`onMiss`（既定 `'keep-current'`）・`latencyModel`（既定 `'constant'`）・ステージ宣言を受け付ける。締切判定は `missedAt(t)` として公開する。既定値のままなら挙動は下のコードと同一なので、テスト（Step 1）はそのまま通る。
>
> 詳細は [`time-model.md`](time-model.md) §12.5、位置づけは [`development-roadmap.md`](development-roadmap.md) §4。

`core/sim/command/decision_scheduler.js` を新規作成:

```javascript
/**
 * decision_scheduler.js — 意思決定ライフサイクル（時間モデル）の実装
 *
 * LLM が絡む判断はシム時間上で瞬時ではない。各 decider（今は指揮官2体、
 * Phase 2 では各艇も）について
 *   t_issue: 観測スナップショット・推論発行
 *   t_apply = t_issue + latencyS: 出力が世界に効き始める
 * を管理する。latencyS は実測値ではなく設定値（決定論・ハードウェア非依存）。
 *
 * 推論の「実行」はここではしない。呼び出し側（headless / ブラウザ）が
 * dueToIssue() で発行対象を取り、結果を provideResult() で返し、
 * dueToApply() で発効時刻に達した結果を takeResult() で取り出して適用する。
 * headless は発行を await する（t_issue〜t_apply の物理は現行指示のみで決まり
 * 推論結果に依存しないため、待ってから進めても決定論が保たれる）。
 * ブラウザは fire-and-forget し、blockedAt() が真ならシムを止めて「推論待ち」にする。
 *
 * pending 中は再発行しない（1 decider につき同時1推論）。したがって
 * 実効的な発行間隔は max(intervalS, 発効までの待ち) になる。
 */

/** シム時刻は 0.1 の蓄積で誤差が乗るため、時刻比較は全てこの epsilon 付きで行う */
const T_EPS = 1e-6;

export class DecisionScheduler {
  constructor() {
    /** @type {Map<string, {intervalS:number, latencyS:number, firstIssueAtT:number,
     *   nextIssueAtT:number, pending: null|{applyAtT:number, resolved:boolean, result:any}}>} */
    this.deciders = new Map();
  }

  /** @param {string} id  @param {{intervalS:number, latencyS:number, firstIssueAtT?:number}} config */
  register(id, { intervalS, latencyS, firstIssueAtT = 0 }) {
    this.deciders.set(id, { intervalS, latencyS, firstIssueAtT, nextIssueAtT: firstIssueAtT, pending: null });
  }

  reset() {
    for (const d of this.deciders.values()) {
      d.nextIssueAtT = d.firstIssueAtT;
      d.pending = null;
    }
  }

  /** @returns {string[]} いま推論を発行すべき decider（pending 無し・発行時刻到来） */
  dueToIssue(t) {
    const ids = [];
    for (const [id, d] of this.deciders) {
      if (!d.pending && t + T_EPS >= d.nextIssueAtT) ids.push(id);
    }
    return ids;
  }

  markIssued(id, t) {
    const d = this.deciders.get(id);
    d.pending = { applyAtT: t + d.latencyS, resolved: false, result: undefined };
    d.nextIssueAtT = t + d.intervalS;
  }

  provideResult(id, result) {
    const d = this.deciders.get(id);
    if (d?.pending && !d.pending.resolved) {
      d.pending.result = result;
      d.pending.resolved = true;
    }
  }

  /** @returns {string[]} 発効時刻に達し、結果も到着している decider */
  dueToApply(t) {
    const ids = [];
    for (const [id, d] of this.deciders) {
      if (d.pending?.resolved && t + T_EPS >= d.pending.applyAtT) ids.push(id);
    }
    return ids;
  }

  /** @returns {string[]} 発効時刻に達したのに結果が未着の decider（ブラウザはシムを止めて待つ） */
  blockedAt(t) {
    const ids = [];
    for (const [id, d] of this.deciders) {
      if (d.pending && !d.pending.resolved && t + T_EPS >= d.pending.applyAtT) ids.push(id);
    }
    return ids;
  }

  takeResult(id) {
    const d = this.deciders.get(id);
    const result = d.pending?.result;
    d.pending = null;
    return result;
  }
}
```

- [ ] **Step 4: テスト確認**

Run: `node tests/command.test.js`
Expected: PASS

- [ ] **Step 5: system-design.md から time-model.md への導線を追加**

時間モデルの詳細設計（3つの時間軸・意思決定ライフサイクル・latencyS の考え方・実行器ごとの違い・
具体例・既知のリスク）は [`time-model.md`](time-model.md) に独立文書としてまとめてある。
`docs/system-design.md` の末尾には、内容を重複させず短い導線だけを追記する:

```markdown
## 時間モデル

推論を含む意思決定（指揮官、将来の艇LLM/VLM）は、シム時間上で瞬時には扱わない。
3つの時間軸（シム時間・実時間・表示時間）と意思決定のライフサイクル（t_issue → t_apply）の
詳細設計は [`time-model.md`](time-model.md) を参照。実装は `core/sim/command/decision_scheduler.js`。
```

**実装前に確認すること**: `time-model.md` §12 に、ブラウザ実行器でエピソードをまたぐ推論結果が
取り違えられる未解決リスク（世代タグが無い）が記録されている。Step 1〜4 のコードにこの対策
（`reset()` での世代カウンタ導入、`provideResult` での世代検証）を含めるかは、Task 9（ブラウザ配線）
着手前に判断する。

- [ ] **Step 6: コミット**

```bash
git add core/sim/command/decision_scheduler.js docs/system-design.md tests/command.test.js
git commit -m "feat: decision scheduler implementing the sim-time decision lifecycle"
```

---

## Task 6: 統合図・指示パース・スクリプテッド指揮官

**Files:**
- Create: `core/sim/command/fused_picture.js`
- Create: `core/sim/command/commander_prompt.js`
- Create: `core/sim/command/parse_orders.js`
- Create: `core/sim/command/scripted_commanders.js`
- Test: `tests/command.test.js`

- [ ] **Step 1: 失敗するテストを書く**

`tests/command.test.js` に追加し、`main()` から呼ぶ:

```javascript
async function testFusedPictureAndPromptText(core) {
  const { buildFusedPicture } = await import('../core/sim/command/fused_picture.js');
  const { renderPictureText, buildCommanderSystemPrompt } = await import('../core/sim/command/commander_prompt.js');
  const scene = minimalScene(core);
  const world = new core.World({ scene, capacity: 3, radarRangeM: 600, protectedAsset: { x: 100, y: 200 } });
  world.spawn({ id: 'd1', faction: 'defender', platform: 'asv', x: 100, y: 200, heading: Math.PI / 2 });
  world.spawn({ id: 'd2', faction: 'defender', platform: 'asv', x: 400, y: 200, heading: 0 });
  world.spawn({ id: 'i1', faction: 'intruder', platform: 'asv', x: 700, y: 200, heading: Math.PI });
  const env = new core.EnvApi(world);
  env.reset({ scenario: 'test', episodeIndex: 1 });
  env.step({}); // トラック統合を1回走らせる（i1 は d2 の 300m 東 → defender 側に track が立つ）

  const picture = buildFusedPicture(world, 'defender', { episode: 1 });
  assert.strictEqual(picture.faction, 'defender');
  assert.strictEqual(picture.ownForce.length, 2, 'own force lists only own faction');
  const d1 = picture.ownForce.find((b) => b.id === 'd1');
  assert.ok(Math.abs(d1.eastM - 0) < 1e-6 && Math.abs(d1.northM - 0) < 1e-6, 'asset-relative coords');
  assert.strictEqual(d1.compassHeadingDeg, 0, 'math π/2 (north) renders as compass 000');
  assert.strictEqual(picture.tracks.length, 1);
  assert.ok(Math.abs(picture.tracks[0].eastM - 600) < 30, 'track east of asset by ~600m');
  assert.strictEqual(typeof picture.tracks[0].ageS, 'number');

  // 敵の真位置は統合図に混入しない: intruder 側の picture に「見えていない敵」が居ないこと
  const redPicture = buildFusedPicture(world, 'intruder', { episode: 1 });
  assert.ok(
    redPicture.tracks.every((t) => t.id !== 'd1'),
    'd1 is outside every intruder radar (600m) and must not appear'
  );

  const text = renderPictureText(picture);
  assert.ok(text.includes('d1') && text.includes('ASSET at (0, 0)'), text);
  assert.ok(/last seen/.test(text), 'track staleness is rendered');
  assert.ok(!/"x"|\bx=/.test(text), 'raw world coords must not leak');

  const sys = buildCommanderSystemPrompt('defender', { intervalS: 10, latencyS: 3 });
  assert.ok(/80 m/.test(sys) && /60 m/.test(sys), 'mission radii stated');
  assert.ok(/orders/.test(sys) && /intercept/.test(sys) && /move_to/.test(sys) && /patrol/.test(sys));
  assert.ok(/3 s/.test(sys), 'latency is told to the commander (its orders arrive late)');
  assert.notStrictEqual(sys, buildCommanderSystemPrompt('intruder', { intervalS: 10, latencyS: 3 }));

  console.log('OK: fused picture is asset-relative, faction-scoped, and renders with staleness');
}

async function testParseOrdersPartialAcceptance() {
  const { parseOrders } = await import('../core/sim/command/parse_orders.js');
  const roster = { ownBoatIds: ['d1', 'd2'], trackIds: ['i1'] };

  const good = parseOrders(
    'Plan: ```json\n{"orders":[{"boat":"d1","action":"intercept","target":"i1"},' +
      '{"boat":"d2","action":"move_to","waypoint":{"east_m":100,"north_m":-50}}],"intent":"pincer"}\n```',
    roster
  );
  assert.strictEqual(good.ok, true);
  assert.strictEqual(good.orders.length, 2);
  assert.strictEqual(good.orders[1].waypoint.eastM, 100, 'east_m normalises to eastM');
  assert.strictEqual(good.intent, 'pincer');

  // 部分受理: 不正な行だけ落とし、正しい行は生かす
  const partial = parseOrders(
    '{"orders":[{"boat":"ghost","action":"patrol","center":"asset"},' +
      '{"boat":"d1","action":"intercept","target":"unknown-track"},' +
      '{"boat":"d1","action":"teleport"},' +
      '{"boat":"d2","action":"patrol","center":{"east_m":0,"north_m":0},"radius_m":150}],"intent":"x"}',
    roster
  );
  assert.strictEqual(partial.ok, true);
  assert.strictEqual(partial.orders.length, 1, 'only the valid patrol order survives');
  assert.strictEqual(partial.orders[0].boat, 'd2');
  assert.strictEqual(partial.orders[0].radiusM, 150);
  assert.strictEqual(partial.dropped.length, 3);

  // 同一艇への重複指示は後勝ち
  const dup = parseOrders(
    '{"orders":[{"boat":"d1","action":"patrol","center":"asset"},' +
      '{"boat":"d1","action":"intercept","target":"i1"}]}',
    roster
  );
  assert.strictEqual(dup.orders.length, 1);
  assert.strictEqual(dup.orders[0].action, 'intercept', 'later order for the same boat wins');

  assert.strictEqual(parseOrders('no json here', roster).ok, false);
  assert.strictEqual(parseOrders('{"orders":[]}', roster).ok, false, 'empty orders is a failure (keep current)');

  console.log('OK: parseOrders extracts fenced JSON, partially accepts, and normalises keys');
}

async function testScriptedCommanders() {
  const { scriptedDefenderCommander, scriptedIntruderCommander } =
    await import('../core/sim/command/scripted_commanders.js');

  const picture = {
    faction: 'defender',
    t: 20,
    episode: 1,
    asset: { eastM: 0, northM: 0 },
    ownForce: [
      { id: 'd1', eastM: -100, northM: 0, compassHeadingDeg: 90, speedMps: 5, orderSummary: 'patrol' },
      { id: 'd2', eastM: 300, northM: 0, compassHeadingDeg: 90, speedMps: 5, orderSummary: 'patrol' },
    ],
    tracks: [{ id: 'i1', eastM: 500, northM: 0, ageS: 1.0, seenBy: 'd2' }],
  };
  const blue = scriptedDefenderCommander(picture);
  const intercept = blue.orders.find((o) => o.action === 'intercept');
  assert.ok(intercept, 'a fresh track gets an interceptor');
  assert.strictEqual(intercept.boat, 'd2', 'the nearest defender is assigned');
  assert.strictEqual(intercept.target, 'i1');
  assert.ok(blue.orders.some((o) => o.boat === 'd1' && o.action === 'patrol'), 'the rest patrol');
  assert.ok(typeof blue.intent === 'string' && blue.intent.length > 0);

  // stale トラック（20s超）には割り当てない
  const stalePicture = { ...picture, tracks: [{ id: 'i1', eastM: 500, northM: 0, ageS: 60, seenBy: 'd2' }] };
  assert.ok(
    scriptedDefenderCommander(stalePicture).orders.every((o) => o.action !== 'intercept'),
    'stale tracks are not chased'
  );

  const redPicture = {
    faction: 'intruder',
    t: 0,
    episode: 2,
    asset: { eastM: 0, northM: 0 },
    ownForce: [{ id: 'i1', eastM: 600, northM: 0, compassHeadingDeg: 270, speedMps: 0, orderSummary: 'move_to' }],
    tracks: [],
  };
  const red = scriptedIntruderCommander(redPicture);
  assert.strictEqual(red.orders.length, 1);
  assert.strictEqual(red.orders[0].action, 'move_to');
  // 遠方（>450m）ではエピソード依存の迂回点、近傍ではアセット直行
  const nearPicture = { ...redPicture, ownForce: [{ ...redPicture.ownForce[0], eastM: 200 }] };
  const nearRed = scriptedIntruderCommander(nearPicture);
  assert.strictEqual(nearRed.orders[0].waypoint.eastM, 0);
  assert.strictEqual(nearRed.orders[0].waypoint.northM, 0);

  console.log('OK: scripted commanders assign interceptors and stage approaches');
}
```

- [ ] **Step 2: 失敗を確認**

Run: `node tests/command.test.js`
Expected: FAIL — `Cannot find module ... fused_picture.js`

- [ ] **Step 3: 統合図を実装**

`core/sim/command/fused_picture.js` を新規作成:

```javascript
/**
 * fused_picture.js — 指揮官の視界: 味方センサー統合図（構造化データ）
 *
 * 「完全俯瞰（神の視点）」ではない。含むのは
 *   - 味方全艇の真位置（艦隊データリンクで常時共有される想定）
 *   - 味方レーダーが捉えた敵トラック（tracks.js。映らなくなった敵は stale に古びる）
 * のみ。敵の真位置がここへ混入した時点で部分観測の前提が壊れるので、
 * World の EntityState から敵陣営を直接読むコードをこのファイルに書かないこと。
 *
 * 座標系はアセット基準の east/north (m)。針路は北基準・時計回りのコンパス度
 * （LLM に数学規約の heading を渡すと解釈を誤るため、表示側の規約に揃える）。
 */

import { describeOrder } from './orders.js';

/** 数学規約（+x=東・CCW正・ラジアン）→ コンパス度（北0・時計回り・0〜359） */
export function toCompassDeg(mathRad) {
  return Math.round((90 - (mathRad * 180) / Math.PI + 360) % 360);
}

/**
 * @param {import('../world.js').World} world
 * @param {string} faction
 * @param {{episode?: number}} [meta]
 */
export function buildFusedPicture(world, faction, { episode = null } = {}) {
  const asset = world.protectedAsset ?? { x: 0, y: 0 };
  const state = world.state;

  const ownForce = [];
  for (let i = 0; i < state.count; i++) {
    if (!state.alive[i] || state.faction[i] !== faction) continue;
    ownForce.push({
      id: state.id[i],
      eastM: state.x[i] - asset.x,
      northM: state.y[i] - asset.y,
      compassHeadingDeg: toCompassDeg(state.heading[i]),
      speedMps: state.speed[i],
      orderSummary: describeOrder(world.orders.get(state.id[i])),
    });
  }

  const tracks = world.tracks[faction].list().map((tr) => ({
    id: tr.id,
    eastM: tr.x - asset.x,
    northM: tr.y - asset.y,
    ageS: world.clock - tr.lastSeenT,
    seenBy: tr.seenBy,
  }));

  return { faction, t: world.clock, episode, asset: { eastM: 0, northM: 0 }, ownForce, tracks };
}
```

- [ ] **Step 4: プロンプトを実装**

`core/sim/command/commander_prompt.js` を新規作成:

```javascript
/**
 * commander_prompt.js — 統合図→テキスト、指揮官のシステムプロンプト
 *
 * 設計上の約束ごと:
 * 1. ワールド生座標を渡さない。すべてアセット基準 (east_m, north_m)。
 * 2. トラックの鮮度（last seen X s ago）を必ず示す。stale な情報に基づく采配も
 *    それ自体が観察対象なので、隠さずに古さを明示する。
 * 3. 指揮のリズム（intervalS ごと発令・latencyS 遅れて発効）をプロンプトで明示する。
 *    自分の指示が遅れて届くことを知らない指揮官は原理的に正しく采配できない。
 */

import { INTERCEPT_RANGE_M, ASSET_BREACH_RANGE_M, EPISODE_TIME_LIMIT_S } from '../mission.js';

const ORDERS_SCHEMA = [
  'Reply with ONLY one JSON object:',
  '{"orders": [',
  '  {"boat": "<own boat id>", "action": "intercept", "target": "<track id>"}',
  '  or {"boat": "<own boat id>", "action": "move_to", "waypoint": {"east_m": <num>, "north_m": <num>}}',
  '  or {"boat": "<own boat id>", "action": "patrol", "center": "asset" | {"east_m": <num>, "north_m": <num>}, "radius_m": <num>}',
  '], "intent": "<your plan in at most 12 words>"}',
  'Boats you do not mention keep their current order.',
].join('\n');

/**
 * @param {string} faction - 'defender' | 'intruder'
 * @param {{intervalS: number, latencyS: number}} timing
 */
export function buildCommanderSystemPrompt(faction, { intervalS, latencyS }) {
  const shared = [
    'Coordinates are meters east/north of the protected asset at (0, 0).',
    "You see only your own force's fused sensor picture. Enemy tracks may be stale or missing entirely.",
    `You may issue orders every ${intervalS} s. Orders take ${latencyS} s to reach your boats;`,
    'until then each boat keeps executing its current order.',
    ORDERS_SCHEMA,
  ];
  if (faction === 'defender') {
    return [
      'You are the DEFENDER commander of uncrewed surface vessels (ASVs).',
      `Protect the asset: you lose if any intruder gets within ${ASSET_BREACH_RANGE_M} m of it.`,
      `A defender neutralises an intruder by closing within ${INTERCEPT_RANGE_M} m of it.`,
      ...shared,
    ].join('\n');
  }
  if (faction === 'intruder') {
    return [
      'You are the INTRUDER commander of uncrewed surface vessels (ASVs).',
      `Win by getting any of your boats within ${ASSET_BREACH_RANGE_M} m of the asset at (0, 0).`,
      `Defenders neutralise your boats by closing within ${INTERCEPT_RANGE_M} m.`,
      ...shared,
    ].join('\n');
  }
  throw new Error(`buildCommanderSystemPrompt: unknown faction "${faction}"`);
}

function fmt(n) {
  return String(Math.round(n));
}

/** @param {ReturnType<import('./fused_picture.js').buildFusedPicture>} picture */
export function renderPictureText(picture) {
  const lines = [];
  lines.push(
    `FORCE PICTURE t=${picture.t.toFixed(1)}s — you command: ${picture.ownForce.map((b) => b.id).join(', ') || '(none)'}`
  );
  lines.push('ASSET at (0, 0)');
  lines.push('OWN FORCE (truth):');
  for (const b of picture.ownForce) {
    lines.push(
      `  ${b.id} at (${fmt(b.eastM)}, ${fmt(b.northM)}) heading ${String(b.compassHeadingDeg).padStart(3, '0')} ` +
        `speed ${b.speedMps.toFixed(1)} m/s — order: ${b.orderSummary}`
    );
  }
  lines.push('ENEMY TRACKS (fused from own radars; may be stale):');
  if (picture.tracks.length === 0) {
    lines.push('  (none detected)');
  } else {
    for (const tr of [...picture.tracks].sort((a, b) => a.ageS - b.ageS)) {
      lines.push(
        `  ${tr.id} at (${fmt(tr.eastM)}, ${fmt(tr.northM)}) — last seen ${tr.ageS.toFixed(1)}s ago by ${tr.seenBy}`
      );
    }
  }
  lines.push(`TIME ${picture.t.toFixed(1)} / ${EPISODE_TIME_LIMIT_S} s`);
  return lines.join('\n');
}
```

- [ ] **Step 5: パースを実装**

`core/sim/command/parse_orders.js` を新規作成:

```javascript
/**
 * parse_orders.js — LLM の生テキスト → 正規化済み orders
 *
 * 小さいモデルは「```json フェンス」「前後の散文」付きで返すため、まず均衡した
 * 最初の {...} を文字列走査で切り出してからパースする。
 * 検証は**部分受理**: 不正な指示行だけ落とし（dropped に理由を残す）、正しい行は生かす。
 * 全滅（ok=false）のときの意味は「現在の指示を維持」であり、呼び出し側
 * （llm_commander.js）がそのように扱う。
 */

export const ORDER_PARSE_ERRORS = {
  NO_JSON: 'no_json',
  BAD_JSON: 'bad_json',
  NO_ORDERS: 'no_orders',
};

/** 文字列リテラル内の波括弧を深さ計算から除外しつつ、最初の均衡した {...} を切り出す */
export function extractFirstJsonObject(text) {
  if (typeof text !== 'string') return null;
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === '{') {
      if (depth === 0) start = i;
      depth++;
      continue;
    }
    if (ch === '}') {
      depth--;
      if (depth === 0 && start >= 0) return text.slice(start, i + 1);
      if (depth < 0) {
        depth = 0;
        start = -1;
      }
    }
  }
  return null;
}

function toFiniteNumber(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

function validatePoint(p) {
  const eastM = toFiniteNumber(p?.east_m ?? p?.eastM);
  const northM = toFiniteNumber(p?.north_m ?? p?.northM);
  if (eastM === null || northM === null) return null;
  return { eastM, northM };
}

function validateOrder(raw, roster) {
  const boat = raw?.boat;
  if (typeof boat !== 'string' || !roster.ownBoatIds.includes(boat)) {
    return { ok: false, boat, reason: 'unknown_or_enemy_boat' };
  }
  const action = raw?.action;
  if (action === 'intercept') {
    if (typeof raw.target !== 'string' || !roster.trackIds.includes(raw.target)) {
      return { ok: false, boat, reason: 'unknown_target' };
    }
    return { ok: true, order: { boat, action, target: raw.target } };
  }
  if (action === 'move_to') {
    const waypoint = validatePoint(raw.waypoint);
    if (!waypoint) return { ok: false, boat, reason: 'bad_waypoint' };
    return { ok: true, order: { boat, action, waypoint } };
  }
  if (action === 'patrol') {
    let center;
    if (raw.center === 'asset') center = 'asset';
    else {
      center = validatePoint(raw.center);
      if (!center) return { ok: false, boat, reason: 'bad_center' };
    }
    const radiusM = toFiniteNumber(raw.radius_m ?? raw.radiusM);
    return {
      ok: true,
      order: { boat, action, center, radiusM: radiusM !== null ? Math.min(Math.max(radiusM, 50), 1000) : undefined },
    };
  }
  return { ok: false, boat, reason: 'unknown_action' };
}

/**
 * @param {string} text - LLM の生出力
 * @param {{ownBoatIds: string[], trackIds: string[]}} roster - 検証用の名簿
 * @returns {{ok: boolean, error: string|null, orders: Array, dropped: Array, intent: string|null}}
 */
export function parseOrders(text, roster) {
  const json = extractFirstJsonObject(text);
  if (json === null) return { ok: false, error: ORDER_PARSE_ERRORS.NO_JSON, orders: [], dropped: [], intent: null };
  let obj;
  try {
    obj = JSON.parse(json);
  } catch {
    return { ok: false, error: ORDER_PARSE_ERRORS.BAD_JSON, orders: [], dropped: [], intent: null };
  }
  const intent = typeof obj?.intent === 'string' ? obj.intent.slice(0, 120) : null;
  if (!obj || !Array.isArray(obj.orders)) {
    return { ok: false, error: ORDER_PARSE_ERRORS.NO_ORDERS, orders: [], dropped: [], intent };
  }
  const byBoat = new Map(); // 同一艇への重複指示は後勝ち（実際の口頭指揮の「訂正」に相当）
  const dropped = [];
  for (const raw of obj.orders) {
    const v = validateOrder(raw, roster);
    if (v.ok) byBoat.set(v.order.boat, v.order);
    else dropped.push(v);
  }
  const orders = [...byBoat.values()];
  return {
    ok: orders.length > 0,
    error: orders.length > 0 ? null : ORDER_PARSE_ERRORS.NO_ORDERS,
    orders,
    dropped,
    intent,
  };
}
```

- [ ] **Step 6: スクリプテッド指揮官を実装**

`core/sim/command/scripted_commanders.js` を新規作成:

```javascript
/**
 * scripted_commanders.js — スクリプテッド指揮官（統制群・フォールバックの基準線）
 *
 * LLM 指揮官と同じ入力（統合図）・同じ出力（正規化済み orders + intent）を持つ。
 * 采配ロジックは旧 rule_based_fallback.js の陣営別行動を指揮官レベルへ持ち上げたもの:
 *   防御: 新しいトラックに最寄りの防御艇を1隻ずつ割り当て、残りはアセット哨戒
 *   侵入: 遠方ではエピソード番号による決定論的な迂回点、近傍ではアセット直行
 * 乱数は使わない（エピソード番号だけが変化の種）。
 */

/** これより古いトラックは追わない（消えた敵を全艇で追い回さない） */
const FRESH_TRACK_MAX_AGE_S = 20;
/** 侵入側: アセットからこの距離より外では迂回点を経由する */
const APPROACH_SWITCH_RANGE_M = 450;
const APPROACH_VARIATION_STEP_RAD = (55 * Math.PI) / 180;

/** @param {ReturnType<import('./fused_picture.js').buildFusedPicture>} picture */
export function scriptedDefenderCommander(picture) {
  const fresh = picture.tracks
    .filter((tr) => tr.ageS <= FRESH_TRACK_MAX_AGE_S)
    .sort((a, b) => Math.hypot(a.eastM, a.northM) - Math.hypot(b.eastM, b.northM)); // アセットに近い脅威から
  const free = new Map(picture.ownForce.map((b) => [b.id, b]));
  const orders = [];
  for (const tr of fresh) {
    let bestId = null;
    let bestD = Infinity;
    for (const [id, b] of free) {
      const d = Math.hypot(b.eastM - tr.eastM, b.northM - tr.northM);
      if (d < bestD) {
        bestD = d;
        bestId = id;
      }
    }
    if (bestId === null) break; // 防御艇が足りない
    free.delete(bestId);
    orders.push({ boat: bestId, action: 'intercept', target: tr.id });
  }
  for (const id of free.keys()) {
    orders.push({ boat: id, action: 'patrol', center: 'asset', radiusM: 200 });
  }
  return { orders, intent: `intercept ${orders.length - free.size} track(s), ${free.size} guarding asset` };
}

/** @param {ReturnType<import('./fused_picture.js').buildFusedPicture>} picture */
export function scriptedIntruderCommander(picture) {
  const episode = picture.episode ?? 1;
  const variationRad = ((episode % 3) - 1) * APPROACH_VARIATION_STEP_RAD;
  const orders = [];
  for (const b of picture.ownForce) {
    const d = Math.hypot(b.eastM, b.northM);
    if (d > APPROACH_SWITCH_RANGE_M) {
      // 艇→アセット方向をエピソード依存の角度だけ回した先に迂回点を置く（旧・侵入側迂回の指揮官版）
      const angle = Math.atan2(-b.northM, -b.eastM) + variationRad;
      const legM = Math.max(d - 350, 100);
      orders.push({
        boat: b.id,
        action: 'move_to',
        waypoint: { eastM: b.eastM + Math.cos(angle) * legM, northM: b.northM + Math.sin(angle) * legM },
      });
    } else {
      orders.push({ boat: b.id, action: 'move_to', waypoint: { eastM: 0, northM: 0 } });
    }
  }
  return { orders, intent: `advance on asset (variation ${(episode % 3) - 1})` };
}
```

- [ ] **Step 7: テスト確認**

Run: `node tests/command.test.js`
Expected: 追加した3テスト含め全て PASS

- [ ] **Step 8: コミット**

```bash
git add core/sim/command/fused_picture.js core/sim/command/commander_prompt.js core/sim/command/parse_orders.js core/sim/command/scripted_commanders.js tests/command.test.js
git commit -m "feat: fused picture, commander prompts, order parsing, scripted commanders"
```

---

## Task 7: LLM 指揮官

**Files:**
- Create: `core/sim/agents/llm_http.js`
- Create: `core/sim/command/llm_commander.js`
- Test: `tests/command.test.js`

- [ ] **Step 1: 失敗するテストを書く**

`tests/command.test.js` に追加し、`main()` から呼ぶ:

```javascript
function fakeFetch(responder) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) });
    return responder(calls.length);
  };
  impl.calls = calls;
  return impl;
}

function jsonResponse(content, { completionTokens = 60 } = {}) {
  return {
    ok: true,
    status: 200,
    async json() {
      return { choices: [{ message: { content } }], usage: { completion_tokens: completionTokens } };
    },
  };
}

const SAMPLE_PICTURE = {
  faction: 'defender',
  t: 20,
  episode: 1,
  asset: { eastM: 0, northM: 0 },
  ownForce: [{ id: 'd1', eastM: -100, northM: 0, compassHeadingDeg: 90, speedMps: 5, orderSummary: 'patrol' }],
  tracks: [{ id: 'i1', eastM: 500, northM: 0, ageS: 1.0, seenBy: 'd1' }],
};

async function testLlmCommanderParsesAndRecordsStats() {
  const { createLlmCommanderFn } = await import('../core/sim/command/llm_commander.js');
  const fetchImpl = fakeFetch(() =>
    jsonResponse('{"orders":[{"boat":"d1","action":"intercept","target":"i1"}],"intent":"take it down"}')
  );
  const onCallRecords = [];
  const decide = createLlmCommanderFn({
    faction: 'defender',
    intervalS: 10,
    latencyS: 3,
    baseUrl: 'http://localhost:11434/v1',
    model: 'test-model',
    fetchImpl,
    onCall: (rec) => onCallRecords.push(rec),
  });

  const result = await decide(SAMPLE_PICTURE);
  assert.strictEqual(result.orders.length, 1);
  assert.strictEqual(result.orders[0].action, 'intercept');
  assert.strictEqual(result.intent, 'take it down');
  assert.strictEqual(decide.stats.calls, 1);
  assert.strictEqual(decide.stats.ok, 1);
  assert.strictEqual(decide.stats.keptOrders, 0);
  assert.strictEqual(decide.stats.totalOutputTokens, 60);

  const sent = fetchImpl.calls[0];
  assert.ok(sent.url.endsWith('/v1/chat/completions'));
  assert.strictEqual(sent.body.messages[0].role, 'system');
  assert.ok(sent.body.messages[1].content.includes('FORCE PICTURE'));
  assert.strictEqual(onCallRecords.length, 1);
  assert.ok(onCallRecords[0].raw.includes('intercept'), 'onCall carries the raw response for later analysis');

  console.log('OK: LLM commander calls the endpoint, parses orders, and records stats');
}

async function testLlmCommanderKeepsOrdersOnFailure() {
  const { createLlmCommanderFn } = await import('../core/sim/command/llm_commander.js');

  const garbage = createLlmCommanderFn({
    faction: 'defender',
    intervalS: 10,
    latencyS: 3,
    baseUrl: 'http://x/v1',
    model: 'm',
    fetchImpl: fakeFetch(() => jsonResponse('I would consider a defensive posture.')),
  });
  assert.strictEqual(await garbage(SAMPLE_PICTURE), null, 'unparseable output means: keep current orders');
  assert.strictEqual(garbage.stats.parseFailures, 1);
  assert.strictEqual(garbage.stats.keptOrders, 1);

  const dead = createLlmCommanderFn({
    faction: 'defender',
    intervalS: 10,
    latencyS: 3,
    baseUrl: 'http://x/v1',
    model: 'm',
    fetchImpl: async () => {
      throw new Error('ECONNREFUSED');
    },
  });
  assert.strictEqual(await dead(SAMPLE_PICTURE), null, 'a dead server must not crash the episode');
  assert.strictEqual(dead.stats.transportFailures, 1);

  console.log('OK: LLM commander degrades to keeping current orders on any failure');
}
```

- [ ] **Step 2: 失敗を確認**

Run: `node tests/command.test.js`
Expected: FAIL — `Cannot find module ... llm_commander.js`

- [ ] **Step 3: HTTP 層を実装**

`core/sim/agents/llm_http.js` を新規作成:

```javascript
/**
 * llm_http.js — OpenAI 互換 /chat/completions への POST（共通部品）
 *
 * 開発は Ollama、GPU サーバでは vLLM。どちらも同じエンドポイント形式なので、
 * ベースURLの差し替えだけで移行できる。指揮官（command/llm_commander.js）と
 * Phase 2 の艇 LLM の両方がここを使う。core/ は fs・DOM 非依存のまま。
 */

/**
 * @param {{baseUrl:string, model:string, temperature:number, maxTokens:number, timeoutMs:number,
 *   fetchImpl:typeof fetch, systemPrompt:string, userPrompt:string}} options
 * @returns {Promise<{text:string, outputTokens:number|null}>}
 */
export async function postChatCompletion({
  baseUrl,
  model,
  temperature,
  maxTokens,
  timeoutMs,
  fetchImpl,
  systemPrompt,
  userPrompt,
}) {
  // タイムアウト必須: 詰まったサーバー1台で無人実行が永久に止まるのを防ぐ
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(`${baseUrl.replace(/\/+$/, '')}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: controller.signal,
      body: JSON.stringify({
        model,
        temperature,
        max_tokens: maxTokens,
        stream: false,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
      }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    return {
      text: json?.choices?.[0]?.message?.content ?? '',
      outputTokens: json?.usage?.completion_tokens ?? null,
    };
  } finally {
    clearTimeout(timer);
  }
}
```

- [ ] **Step 4: LLM 指揮官を実装**

`core/sim/command/llm_commander.js` を新規作成:

```javascript
/**
 * llm_commander.js — LLM 指揮官
 *
 * 統合図（fused_picture）をテキスト化して OpenAI 互換サーバへ投げ、
 * orders へパースして返す。失敗（不達・パース不能・有効指示ゼロ）時は null を返し、
 * 「現在の指示を維持」として扱う（艇レベルにフォールバックできる v1 と違い、
 * 指揮官の失敗は"新しい指示が来ない"という自然な形で世界に現れる）。
 * 失敗は黙って通さない: stats に数え、実行後にランナーが必ず表示する。
 */

import { postChatCompletion } from '../agents/llm_http.js';
import { buildCommanderSystemPrompt, renderPictureText } from './commander_prompt.js';
import { parseOrders } from './parse_orders.js';

const DEFAULT_TEMPERATURE = 0.7;
const DEFAULT_MAX_TOKENS = 300;
const DEFAULT_TIMEOUT_MS = 30000;

/**
 * @param {{faction:string, intervalS:number, latencyS:number, baseUrl:string, model:string,
 *   temperature?:number, maxTokens?:number, timeoutMs?:number, fetchImpl?:typeof fetch,
 *   onCall?:(record:object)=>void}} options
 * @returns {Function & {stats: object}} decide(picture) → {orders, intent} | null
 */
export function createLlmCommanderFn(options) {
  const {
    faction,
    intervalS,
    latencyS,
    baseUrl,
    model,
    temperature = DEFAULT_TEMPERATURE,
    maxTokens = DEFAULT_MAX_TOKENS,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    fetchImpl = globalThis.fetch,
    onCall = null,
  } = options ?? {};
  if (!faction) throw new Error('createLlmCommanderFn: faction is required');
  if (!baseUrl) throw new Error('createLlmCommanderFn: baseUrl is required');
  if (!model) throw new Error('createLlmCommanderFn: model is required');

  const systemPrompt = buildCommanderSystemPrompt(faction, { intervalS, latencyS });
  const stats = {
    calls: 0,
    ok: 0,
    parseFailures: 0,
    transportFailures: 0,
    keptOrders: 0, // 失敗により「現指示維持」になった回数
    droppedOrders: 0, // 部分受理で落ちた指示行の数
    totalLatencyMs: 0,
    totalOutputTokens: 0,
  };

  async function decide(picture) {
    const userPrompt = renderPictureText(picture);
    stats.calls += 1;
    const startedAt = Date.now();
    let raw = null;
    let failure = null;

    try {
      const res = await postChatCompletion({
        baseUrl,
        model,
        temperature,
        maxTokens,
        timeoutMs,
        fetchImpl,
        systemPrompt,
        userPrompt,
      });
      raw = res.text;
      if (res.outputTokens != null) stats.totalOutputTokens += res.outputTokens;
    } catch (err) {
      failure = `transport: ${err?.message ?? err}`;
      stats.transportFailures += 1;
    }
    const latencyMs = Date.now() - startedAt;
    stats.totalLatencyMs += latencyMs;

    let result = null;
    if (raw !== null) {
      const parsed = parseOrders(raw, {
        ownBoatIds: picture.ownForce.map((b) => b.id),
        trackIds: picture.tracks.map((t) => t.id),
      });
      stats.droppedOrders += parsed.dropped.length;
      if (parsed.ok) {
        result = { orders: parsed.orders, intent: parsed.intent };
        stats.ok += 1;
      } else {
        failure = `parse: ${parsed.error}`;
        stats.parseFailures += 1;
      }
    }
    if (result === null) stats.keptOrders += 1;

    if (onCall) {
      onCall({
        t: picture.t,
        episode: picture.episode,
        faction,
        userPrompt,
        raw,
        result,
        latencyMs,
        failure,
      });
    }
    return result;
  }

  decide.stats = stats;
  return decide;
}
```

- [ ] **Step 5: テスト確認**

Run: `node tests/command.test.js`
Expected: 全て PASS

- [ ] **Step 6: コミット**

```bash
git add core/sim/agents/llm_http.js core/sim/command/llm_commander.js tests/command.test.js
git commit -m "feat: LLM commander with keep-orders degradation and stats"
```

---

## Task 8: headless ランナー v2（スケジューラ駆動）

**Files:**
- Modify: `scripts/headless_run.js`（意思決定まわりを全面差し替え）

- [ ] **Step 1: 引数パーサとヘルプを差し替え**

`scripts/headless_run.js` の `parseArgs()` を差し替え:

```javascript
function parseArgs(argv) {
  const opts = {
    episodes: 5,
    boats: null,
    out: null,
    quiet: false,
    blue: 'scripted',
    red: 'scripted',
    llmUrl: 'http://localhost:11434/v1',
    model: null,
    temperature: 0.7,
    commandIntervalS: 10,
    commandLatencyS: 3,
    llmLog: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--episodes') opts.episodes = Number(argv[++i]);
    else if (arg === '--boats') opts.boats = Number(argv[++i]);
    else if (arg === '--out') opts.out = argv[++i];
    else if (arg === '--quiet') opts.quiet = true;
    else if (arg === '--blue') opts.blue = argv[++i];
    else if (arg === '--red') opts.red = argv[++i];
    else if (arg === '--llm-url') opts.llmUrl = argv[++i];
    else if (arg === '--model') opts.model = argv[++i];
    else if (arg === '--temperature') opts.temperature = Number(argv[++i]);
    else if (arg === '--command-interval') opts.commandIntervalS = Number(argv[++i]);
    else if (arg === '--command-latency') opts.commandLatencyS = Number(argv[++i]);
    else if (arg === '--llm-log') opts.llmLog = argv[++i];
    else {
      throw new Error(
        `unknown argument: ${arg} (known: --episodes N, --boats N, --out path, --quiet, ` +
          '--blue scripted|llm, --red scripted|llm, --llm-url URL, --model NAME, --temperature T, ' +
          '--command-interval S, --command-latency S, --llm-log path)'
      );
    }
  }
  if (!Number.isInteger(opts.episodes) || opts.episodes < 1) {
    throw new Error(`--episodes must be a positive integer, got: ${opts.episodes}`);
  }
  if (opts.boats !== null && (!Number.isInteger(opts.boats) || opts.boats < 1)) {
    throw new Error(`--boats must be a positive integer, got: ${opts.boats}`);
  }
  for (const side of ['blue', 'red']) {
    if (opts[side] !== 'scripted' && opts[side] !== 'llm') {
      throw new Error(`--${side} must be "scripted" or "llm", got: ${opts[side]}`);
    }
  }
  if ((opts.blue === 'llm' || opts.red === 'llm') && !opts.model) {
    throw new Error('--blue/--red llm requires --model (e.g. --model qwen3:8b)');
  }
  return opts;
}
```

- [ ] **Step 2: `runEpisode` をスケジューラ駆動に差し替え**

`scripts/headless_run.js` の `runEpisode()` 全体を差し替え:

```javascript
/**
 * 1エピソードを done まで走らせる（時間モデル: docs/system-design.md 時間モデルの節）。
 * 毎ステップの順序は 適用(dueToApply) → 発行(dueToIssue, awaitで並行) → 艇制御 → env.step。
 * 発効前の物理は現行指示のみで決まるため、発行を await しても決定論は保たれる。
 */
async function runEpisode({ world, env, scheduler, commanders, applyOrders, computeBoatActions, meta, maxSteps, quiet }) {
  let observation = env.reset(meta); // resetEntities が orders/tracks/controller も初期化する
  scheduler.reset();
  let stepCount = 0;
  let result;
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < maxSteps; i++) {
    const t = world.clock;

    for (const id of scheduler.dueToApply(t)) {
      const res = scheduler.takeResult(id);
      if (res?.orders) {
        applyOrders(world, commanders.get(id).faction, res.orders);
        if (!quiet && res.intent) console.log(`  t=${t.toFixed(1)} ${id}: ${res.intent}`);
      }
      // res が null のときは「新しい指示なし」= 現指示維持
    }

    const due = scheduler.dueToIssue(t);
    if (due.length > 0) {
      await Promise.all(
        due.map(async (id) => {
          const commander = commanders.get(id);
          const picture = buildPictureFor(world, commander.faction, env);
          scheduler.markIssued(id, t);
          scheduler.provideResult(id, await commander.decide(picture));
        })
      );
    }

    result = env.step(computeBoatActions(world, observation));
    observation = result.observation;
    stepCount++;
    if (result.done) break;
  }
  const wallS = Number(process.hrtime.bigint() - t0) / 1e9;
  if (!result || !result.done) {
    throw new Error(`episode did not reach done within ${maxSteps} steps (meta=${JSON.stringify(meta)})`);
  }
  return { result, stepCount, wallS };
}

let buildFusedPictureRef = null; // main() が動的 import 後に代入する（このファイルは CJS のため）
function buildPictureFor(world, faction, env) {
  return buildFusedPictureRef(world, faction, { episode: env.logger.currentEpisode });
}
```

ファイル先頭付近の `const DECISION_INTERVAL_STEPS = 6;` は**削除する**（艇制御は毎ステップになり、意思決定間隔はスケジューラが管理する）。

- [ ] **Step 3: `main()` の配線を差し替え**

`main()` 内の動的 import 群に追加:

```javascript
  const { DecisionScheduler } = await import('../core/sim/command/decision_scheduler.js');
  const { applyOrders } = await import('../core/sim/command/orders.js');
  const { computeBoatActions } = await import('../core/sim/command/boat_controller.js');
  const { buildFusedPicture } = await import('../core/sim/command/fused_picture.js');
  const { scriptedDefenderCommander, scriptedIntruderCommander } =
    await import('../core/sim/command/scripted_commanders.js');
  const { createLlmCommanderFn } = await import('../core/sim/command/llm_commander.js');
  buildFusedPictureRef = buildFusedPicture;
```

`const { LlmAgent } = await import(...)` の行と、`world.spawn({...})` の `agent: new LlmAgent(...)` 行は削除する（艇はエージェントオブジェクトを持たない）。

`const env = new EnvApi(world);` の直後に指揮官とスケジューラの構築を追加:

```javascript
  // 指揮官の構築。scripted は統合図→orders の同期関数を async に包む。
  // llm は onCall フックで全呼び出し（プロンプト・生応答）を記録できる。
  const llmCallRecords = [];
  const timing = { intervalS: opts.commandIntervalS, latencyS: opts.commandLatencyS };
  function makeCommander(side, faction) {
    if (side === 'llm') {
      return {
        faction,
        decide: createLlmCommanderFn({
          faction,
          ...timing,
          baseUrl: opts.llmUrl,
          model: opts.model,
          temperature: opts.temperature,
          onCall: opts.llmLog ? (rec) => llmCallRecords.push(rec) : null,
        }),
      };
    }
    const fn = faction === 'defender' ? scriptedDefenderCommander : scriptedIntruderCommander;
    return { faction, decide: async (picture) => fn(picture) };
  }
  const commanders = new Map([
    ['blue-commander', makeCommander(opts.blue, 'defender')],
    ['red-commander', makeCommander(opts.red, 'intruder')],
  ]);
  const scheduler = new DecisionScheduler();
  for (const id of commanders.keys()) scheduler.register(id, timing);
```

実行ループとサマリを差し替え:

```javascript
  let totalSteps = 0;
  let totalWallS = 0;
  const tally = { defended: 0, breached: 0, timeout: 0 };
  for (let ep = 1; ep <= opts.episodes; ep++) {
    const meta = {
      scenario: scenario.name,
      episodeIndex: ep,
      blue: opts.blue,
      red: opts.red,
      model: opts.model ?? null,
      commandIntervalS: opts.commandIntervalS,
      commandLatencyS: opts.commandLatencyS,
    };
    const { result, stepCount, wallS } = await runEpisode({
      world, env, scheduler, commanders, applyOrders, computeBoatActions, meta, maxSteps, quiet: opts.quiet,
    });
    totalSteps += stepCount;
    totalWallS += wallS;
    tally[result.info.outcome] = (tally[result.info.outcome] ?? 0) + 1;
    if (!opts.quiet) {
      console.log(
        `episode ${ep}/${opts.episodes}: outcome=${result.info.outcome} ` +
          `simTime=${world.clock.toFixed(1)}s wallTime=${wallS.toFixed(3)}s steps=${stepCount}`
      );
    }
  }

  console.log('---');
  console.log(
    `blue=${opts.blue} red=${opts.red}${opts.model ? ` model=${opts.model} temp=${opts.temperature}` : ''} ` +
      `interval=${opts.commandIntervalS}s latency=${opts.commandLatencyS}s boats=${spawns.length} episodes=${opts.episodes}`
  );
  console.log(
    `outcomes: defended=${tally.defended} breached=${tally.breached} timeout=${tally.timeout} ` +
      `(defender win rate ${((tally.defended / opts.episodes) * 100).toFixed(1)}%)`
  );
  console.log(`totalSteps=${totalSteps} totalWallTime=${totalWallS.toFixed(3)}s steps/s = ${(totalSteps / totalWallS).toFixed(1)}`);

  for (const [id, commander] of commanders) {
    const s = commander.decide.stats;
    if (!s) continue; // scripted には stats が無い
    console.log('---');
    console.log(
      `${id}: calls=${s.calls} ok=${s.ok} parseFailures=${s.parseFailures} ` +
        `transportFailures=${s.transportFailures} keptOrders=${s.keptOrders} droppedOrders=${s.droppedOrders}`
    );
    console.log(
      `${id}: meanLatency=${(s.totalLatencyMs / Math.max(s.calls, 1)).toFixed(0)}ms ` +
        `meanOutputTokens=${(s.totalOutputTokens / Math.max(s.ok, 1)).toFixed(1)}`
    );
    const keptRate = s.keptOrders / Math.max(s.calls, 1);
    if (keptRate > 0.2) {
      console.log(
        `WARNING: ${id} kept current orders on ${(keptRate * 100).toFixed(1)}% of cycles (LLM failures). ` +
          'This run under-represents LLM command; fix the prompt or the server before using these outcomes.'
      );
    }
  }

  if (opts.out) {
    fs.writeFileSync(opts.out, env.logger.toJsonl());
    console.log(`log written to ${opts.out} (${env.logger.rows.length} rows)`);
  }
  if (opts.llmLog) {
    fs.writeFileSync(opts.llmLog, llmCallRecords.map((r) => JSON.stringify(r)).join('\n'));
    console.log(`llm call log written to ${opts.llmLog} (${llmCallRecords.length} rows)`);
  }
```

- [ ] **Step 4: スクリプテッド同士のベースラインを回す（GPU 不要）**

Run: `node tests/core_smoke.test.js && node tests/command.test.js && node scripts/headless_run.js --blue scripted --red scripted --boats 6 --episodes 20 --quiet`
Expected: テスト PASS。20 エピソードの勝敗が出て、defended と breached の**両方**が現れる。どちらかが 0 の場合は Task 2 Step 7 と同様に `radarRangeM`（600→800）または `--command-interval` を調整して両結果が出る条件を探し、採用値をシナリオへ反映する。**この勝率が統制群のベースライン。数字を控える。**

- [ ] **Step 5: LLM 指揮官を1エピソード試す**

Run: `node scripts/headless_run.js --blue llm --red scripted --model qwen3:8b --episodes 1 --llm-log probe-commander.jsonl`
Expected: エピソードが決着し、`blue-commander: calls=...` の統計が出る。`keptOrders` 率が 20% を超え WARNING が出る場合は `probe-commander.jsonl` の `raw` を読み、`commander_prompt.js` の ORDERS_SCHEMA を調整してから先へ進む。

- [ ] **Step 6: コミット**

```bash
git add scripts/headless_run.js
git commit -m "feat: scheduler-driven headless runner with commander arms and stats"
```

---

## Task 9: swarm-sim v2（ブラウザ側の時間モデル）

**Files:**
- Modify: `swarm-sim/main.js`
- Modify: `swarm-sim/map_view.js`（指示の描画）
- Modify: `swarm-sim/log_panel.js`（orders 行）

- [ ] **Step 1: 指示の描画を追加**

`swarm-sim/map_view.js` の末尾に追加:

```javascript
/**
 * 各艇の現在の指示（WP・哨戒中心・迎撃目標の最終確認位置）を細い破線で描画する。
 * 指揮官の采配が画面で追えるようにするためのもの。
 */
export function drawOrders(ctx, world, project) {
  ctx.save();
  ctx.setLineDash([4, 4]);
  ctx.lineWidth = 1;
  const state = world.state;
  for (let i = 0; i < state.count; i++) {
    if (!state.alive[i]) continue;
    const order = world.orders.get(state.id[i]);
    if (!order) continue;
    let dest = null;
    if (order.action === 'move_to') dest = order.waypointWorld;
    else if (order.action === 'patrol') dest = order.centerWorld;
    else if (order.action === 'intercept') dest = order.lastKnown;
    if (!dest) continue;
    const a = project(state.x[i], state.y[i]);
    const b = project(dest.x, dest.y);
    ctx.strokeStyle = state.faction[i] === 'defender' ? 'rgba(120,200,255,0.35)' : 'rgba(255,140,140,0.35)';
    ctx.beginPath();
    ctx.moveTo(a.px, a.py);
    ctx.lineTo(b.px, b.py);
    ctx.stroke();
    ctx.strokeRect(b.px - 3, b.py - 3, 6, 6);
  }
  ctx.restore();
}
```

- [ ] **Step 2: orders のログ表示を追加**

`swarm-sim/log_panel.js` の末尾に追加:

```javascript
/** 指揮官の指示発効をログに表示する（采配の変化点が分かるように独自色・太字） */
export function appendOrdersEntry({ t, commander, count, intent }) {
  const line = document.createElement('div');
  line.style.color = '#9fc3ff';
  line.style.fontWeight = '700';
  line.textContent = `[t=${t.toFixed(1)}] ORDERS ${commander}: ${count}件${intent ? ` 「${intent}」` : ''}`;
  append(line);
}
```

- [ ] **Step 3: `swarm-sim/main.js` をスケジューラ駆動へ書き換え**

`swarm-sim/main.js` 全体を差し替え:

```javascript
/**
 * main.js — swarm-sim View のエントリポイント（v2: 指揮官階層＋時間モデル）
 *
 * 意思決定は艇単位の LLM ではなく、陣営ごとの指揮官（scripted | LLM）が
 * DecisionScheduler のライフサイクル（t_issue → t_apply）で行う。
 * 艇は毎ステップ、現在の指示への追従制御（computeBoatActions）で動く。
 *
 * 【時間モデル（ブラウザ側）】docs/system-design.md 時間モデルの節を参照。
 * 物理はアキュムレータ方式の固定ステップ（既存 A-5 対応）のまま。
 * 指揮官の推論は fire-and-forget で発行し、発効時刻（t_apply）に結果が未着なら
 * アキュムレータを捨ててシムを止め、「推論待ち」を表示する（決定論は headless と同一）。
 *
 * 【LLM モード】?blue=llm&red=scripted&model=qwen3:8b&llm=http://localhost:11434/v1
 * 既定（パラメータ無し）は両陣営 scripted。GitHub Pages 上ではサーバー不要のまま。
 * ローカル Ollama を使う場合は OLLAMA_ORIGINS=* で CORS を許可しておくこと。
 */

import { loadSceneFromScenario } from '../core/data/adapters/index.js';
import { World } from '../core/sim/world.js';
import { EnvApi } from '../core/env/env_api.js';
import { DecisionScheduler } from '../core/sim/command/decision_scheduler.js';
import { applyOrders } from '../core/sim/command/orders.js';
import { computeBoatActions } from '../core/sim/command/boat_controller.js';
import { buildFusedPicture } from '../core/sim/command/fused_picture.js';
import { scriptedDefenderCommander, scriptedIntruderCommander } from '../core/sim/command/scripted_commanders.js';
import { createLlmCommanderFn } from '../core/sim/command/llm_commander.js';
import { createProjection, drawMap, drawProtectedAsset, drawOrders } from './map_view.js';
import { drawAgents } from './agent_view.js';
import { CommsPulses } from './comms_view.js';
import { appendCommsEntry, appendMissionEntry, appendOrdersEntry } from './log_panel.js';
import { updateHud, showOutcomeBanner, hideOutcomeBanner, wireDownloadButton } from './hud_panel.js';

const TIME_SCALE = 3;
const MAX_FRAME_DT_S = 0.25;
const BANNER_DURATION_MS = 3000;
/** 指揮サイクル・発効遅延の既定（?interval= / ?latency= で上書き可） */
const DEFAULT_COMMAND_INTERVAL_S = 10;
const DEFAULT_COMMAND_LATENCY_S = 3;

async function loadScenario() {
  const res = await fetch('../core/scenarios/tokyo_bay_minimal.json');
  if (!res.ok) throw new Error(`シナリオ読み込み失敗: ${res.status}`);
  return res.json();
}

function makeWaitingOverlay() {
  const el = document.createElement('div');
  el.style.cssText =
    'position:absolute;top:8px;right:8px;padding:4px 10px;background:#1a2a44cc;color:#9fc3ff;' +
    'font:12px monospace;border-radius:4px;display:none;z-index:10;';
  el.textContent = '指揮官 推論待ち…';
  document.body.appendChild(el);
  return el;
}

async function main() {
  const scenario = await loadScenario();
  const scene = await loadSceneFromScenario(scenario);
  const world = new World({
    scene,
    capacity: scenario.spawns.length,
    protectedAsset: scenario.protectedAssetLatLon
      ? scene.projection.latLonToLocal(scenario.protectedAssetLatLon.lat, scenario.protectedAssetLatLon.lon)
      : null,
    radarRangeM: scenario.sensors?.radarRangeM,
  });

  for (const spawn of scenario.spawns) {
    const { x, y } = scene.projection.latLonToLocal(spawn.lat, spawn.lon);
    world.spawn({
      id: spawn.id,
      faction: spawn.faction,
      platform: spawn.platform,
      x,
      y,
      heading: (spawn.headingDeg * Math.PI) / 180,
      // 艇はエージェントオブジェクトを持たない。追従制御は computeBoatActions が毎ステップ行う
    });
  }

  const env = new EnvApi(world);
  const params = new URLSearchParams(location.search);
  const timing = {
    intervalS: Number(params.get('interval')) || DEFAULT_COMMAND_INTERVAL_S,
    latencyS: Number(params.get('latency')) || DEFAULT_COMMAND_LATENCY_S,
  };

  function makeCommander(side, faction) {
    if (side === 'llm') {
      const baseUrl = params.get('llm') ?? 'http://localhost:11434/v1';
      const model = params.get('model');
      if (!model) {
        console.warn(`swarm-sim: ${faction} に llm 指定がありますが ?model= が無いため scripted で動かします`);
      } else {
        return { faction, decide: createLlmCommanderFn({ faction, ...timing, baseUrl, model }) };
      }
    }
    const fn = faction === 'defender' ? scriptedDefenderCommander : scriptedIntruderCommander;
    return { faction, decide: async (picture) => fn(picture) };
  }
  const commanders = new Map([
    ['blue-commander', makeCommander(params.get('blue') ?? 'scripted', 'defender')],
    ['red-commander', makeCommander(params.get('red') ?? 'scripted', 'intruder')],
  ]);
  const scheduler = new DecisionScheduler();
  for (const id of commanders.keys()) scheduler.register(id, timing);

  const canvas = document.getElementById('map-canvas');
  const ctx = canvas.getContext('2d');
  const commsPulses = new CommsPulses();
  const waitingOverlay = makeWaitingOverlay();

  wireDownloadButton(() => env.logger.toJsonl());

  function resizeCanvas() {
    canvas.width = canvas.clientWidth;
    canvas.height = canvas.clientHeight;
  }
  resizeCanvas();
  window.addEventListener('resize', resizeCanvas);

  let observation = env.reset({ scenario: scenario.name, episodeIndex: 1 });
  scheduler.reset();
  const tally = { defended: 0, breached: 0, timeout: 0 };

  let accumulatorS = 0;
  let lastFrameMs = performance.now();
  let banner = null;
  let waiting = false;

  /** 推論を fire-and-forget で発行する。結果は resolve 時にスケジューラへ渡る */
  function fireDueInferences(t) {
    for (const id of scheduler.dueToIssue(t)) {
      const commander = commanders.get(id);
      const picture = buildFusedPicture(world, commander.faction, { episode: env.logger.currentEpisode });
      scheduler.markIssued(id, t);
      Promise.resolve(commander.decide(picture)).then(
        (res) => scheduler.provideResult(id, res),
        (err) => {
          console.error(`${id} decide failed:`, err);
          scheduler.provideResult(id, null); // 失敗 = 現指示維持
        }
      );
    }
  }

  /** 1ステップ進める。発効→発行→艇制御→物理の順（headless と同じ）。blocked なら false */
  function simulateOneStep() {
    const t = world.clock;
    for (const id of scheduler.dueToApply(t)) {
      const res = scheduler.takeResult(id);
      if (res?.orders) {
        applyOrders(world, commanders.get(id).faction, res.orders);
        appendOrdersEntry({ t, commander: id, count: res.orders.length, intent: res.intent });
      }
    }
    fireDueInferences(t);
    if (scheduler.blockedAt(t).length > 0) return false; // 推論待ち: このステップは進めない

    const result = env.step(computeBoatActions(world, observation));
    observation = result.observation;

    for (const ev of env.lastCommsEvents) appendCommsEntry({ t: world.clock, ...ev });
    commsPulses.addEvents(env.lastCommsEvents);
    for (const ev of result.info.events) appendMissionEntry(ev);

    if (result.done) {
      tally[result.info.outcome] = (tally[result.info.outcome] ?? 0) + 1;
      banner = { outcome: result.info.outcome, untilMs: performance.now() + BANNER_DURATION_MS };
    }
    return true;
  }

  function render() {
    const project = createProjection(canvas, scene);
    drawMap(ctx, canvas, scene, project);
    drawProtectedAsset(ctx, canvas, scene, project, world.protectedAsset);
    drawOrders(ctx, world, project);
    const entities = world.state.snapshot();
    const entityById = new Map(entities.map((e) => [e.id, e]));
    drawAgents(ctx, entities, project);
    commsPulses.draw(ctx, entityById, project);
    updateHud({ episode: env.logger.currentEpisode, clock: world.clock, tally });
    waitingOverlay.style.display = waiting ? 'block' : 'none';
    if (banner) showOutcomeBanner(banner.outcome);
    else hideOutcomeBanner();
  }

  function tick(nowMs) {
    const rawDt = Math.min((nowMs - lastFrameMs) / 1000, MAX_FRAME_DT_S);
    lastFrameMs = nowMs;
    commsPulses.update(rawDt);

    if (banner) {
      if (nowMs >= banner.untilMs) {
        banner = null;
        accumulatorS = 0;
        observation = env.reset({ scenario: scenario.name, episodeIndex: env.logger.currentEpisode + 1 });
        scheduler.reset();
      }
    } else {
      accumulatorS += rawDt * TIME_SCALE;
      waiting = false;
      while (accumulatorS >= env.dt) {
        if (!simulateOneStep()) {
          // 推論待ち: 溜まった時間を捨てて止まる（復帰時に一気に進まないように）
          waiting = true;
          accumulatorS = 0;
          break;
        }
        accumulatorS -= env.dt;
        if (banner) {
          accumulatorS = 0;
          break;
        }
      }
    }

    render();
    requestAnimationFrame(tick);
  }

  requestAnimationFrame(tick);
}

main().catch((err) => {
  console.error(err);
  const pre = document.createElement('pre');
  pre.style.cssText =
    'position:absolute;top:0;left:0;background:#200;color:#e0708e;padding:8px;max-width:90%;white-space:pre-wrap;';
  pre.textContent = String(err?.stack ?? err);
  document.body.appendChild(pre);
});
```

（`appendLogEntry`（毎判断の throttle/steering 行）は艇制御が毎ステップになったため使用をやめる。決定の可視化は ORDERS 行と破線が担う。`log_panel.js` の関数自体は残してよい）

- [ ] **Step 4: 既定動作（scripted 同士）を目視確認**

`docs/quality-assurance-method.md` に従い `npx serve .` → `http://localhost:3000/swarm-sim/` を開く。

Expected: 艇が動き、ORDERS 行がログに出て、各艇から破線（WP・目標）が伸び、エピソードが決着して自動リセットする。コンソールにエラーが無い。

- [ ] **Step 5: LLM モードを目視確認**

`http://localhost:3000/swarm-sim/?blue=llm&model=qwen3:8b` を開く。

Expected: 青側の采配が LLM になり、推論が遅い場合は右上に「指揮官 推論待ち…」が出てシムが一時停止する。CORS エラーが出る場合は `OLLAMA_ORIGINS=*` を設定して `ollama serve` を再起動。

- [ ] **Step 6: digital-twin の非回帰を確認**

`http://localhost:3000/digital-twin/` を開き、従来どおり描画されることを確認する（digital-twin は自前の追従ロジックを持たず spawn 時 agent 未指定でも動くこと。エラーが出る場合は `digital-twin/main.js` の agent 参照箇所を確認し、`world.agents` に依存している行があれば同様に entity 基準へ直す）。

- [ ] **Step 7: コミット**

```bash
git add swarm-sim/main.js swarm-sim/map_view.js swarm-sim/log_panel.js
git commit -m "feat: scheduler-driven swarm-sim with inference-wait pause and order overlay"
```

---

## Task 10: 比較ランと記録（軽量）

**規模:** 指揮官のみの LLM 化により、1エピソードの推論は最大48回（blue+red 両方 LLM 時）。3060・8B で1エピソード1〜2分の見込み。

**Files:**
- Create: `docs/l0-experiment-log.md`
- Modify: `.gitignore`、`docs/review-findings-2026-08-07.md`、`README.md`

- [ ] **Step 1: `.gitignore` へ `logs/` を追加**

`.devtools/gif-frames-*/` の次の行に追加（`*.log` は `.jsonl` を除外しないため）:

```
logs/
```

- [ ] **Step 2: 3アームを回す**

```bash
mkdir -p logs
node scripts/headless_run.js --blue scripted --red scripted --boats 6 --episodes 10 --quiet --out logs/l0-ss.jsonl
node scripts/headless_run.js --blue llm --red scripted --model qwen3:8b --boats 6 --episodes 10 --quiet --out logs/l0-ls.jsonl --llm-log logs/l0-ls-calls.jsonl
node scripts/headless_run.js --blue llm --red llm --model qwen3:8b --boats 6 --episodes 10 --quiet --out logs/l0-ll.jsonl --llm-log logs/l0-ll-calls.jsonl
```

- [ ] **Step 3: 結果を記録**

`docs/l0-experiment-log.md` を新規作成し、実測で埋める:

```markdown
# L0 実験ログ（指揮官アーム比較）

> 実施: 2026-08-__ / 環境: RTX 3060 (12GB) / Ollama / モデル: ____
> 計画: [`l0-llm-agent-plan.md`](l0-llm-agent-plan.md) / 条件: 6隻・10エピソード/アーム・interval 10s・latency 3s・radarRangeM ___

## 勝敗

| アーム (blue vs red) | defended | breached | timeout | 防御側勝率 | 実時間 |
|---|---|---|---|---|---|
| scripted vs scripted | | | | | |
| llm vs scripted | | | | | |
| llm vs llm | | | | | |

## LLM 指揮官の実測

| 指標 | blue (ls) | blue (ll) | red (ll) |
|---|---|---|---|
| calls / ok / keptOrders | | | |
| droppedOrders | | | |
| meanLatency (ms) | | | |
| meanOutputTokens | | | |

## 采配の質（intent と orders の目視）

（`logs/*-calls.jsonl` の intent・orders を読み、統合図に対して妥当な采配だったか、
stale トラックへの反応、latency 3s を踏まえた指示になっていたかを短く書く。）

## 次段への含意

（latencyS・intervalS の妥当性、Phase 2（艇LLM）とL1（VLM化＝latency増）に向けて
時間モデル設定をどうするかの所感。）
```

- [ ] **Step 4: B-7 の状態を更新**

`docs/review-findings-2026-08-07.md` の B-7 行「**未対応**」を、他の行と同じ体裁で「**対応済**」へ更新する。内容: 指揮官LLM（`core/sim/command/llm_commander.js`、Ollama/vLLM 互換）、時間モデル（`decision_scheduler.js`、latencyS は設定値）、統制群（scripted 指揮官）、実測は `docs/l0-experiment-log.md` 参照、艇レベル LLM は Phase 2、と明記。

- [ ] **Step 5: README を更新**

「実LLM/VLM/VLAへの差し替え」節を「指揮官LLM」の実行方法（Ollama セットアップ、`--blue llm` の例、swarm-sim のクエリパラメータ）へ書き換え、「現在の実装状況」節を更新（実装済み: 指揮官階層・時間モデル・orders・追従制御／未実装: 艇レベルLLM（Phase 2）・VLM/VLA・DT接続）。「ヘッドレス実行」節のコマンド例を `--blue/--red` 形式へ更新する。

- [ ] **Step 6: 全テスト・通し実行で最終確認**

Run: `node tests/core_smoke.test.js && node tests/command.test.js && node scripts/headless_run.js --blue scripted --red scripted --episodes 3`
Expected: 全て PASS・3エピソード完走

- [ ] **Step 7: コミット**

```bash
git add docs/l0-experiment-log.md docs/review-findings-2026-08-07.md README.md .gitignore
git commit -m "docs: record commander-arm comparison and close review finding B-7"
```

---

## 完了条件

- [ ] `node tests/command.test.js` / `node tests/core_smoke.test.js` が全件 PASS
- [ ] scripted vs scripted / llm vs scripted / llm vs llm の3アームが完走し、勝率が並んで出る
- [ ] LLM 指揮官の keptOrders 率が 20% 未満（超えたまま結果を採用しない）
- [ ] 指示の発効が t_issue + latencyS に正確に一致する（scheduler テストで担保）
- [ ] ブラウザ既定動作（パラメータ無し）はサーバー不要のまま、推論待ち表示が LLM モードで機能する
- [ ] `docs/l0-experiment-log.md` が実測値で埋まり、`docs/system-design.md` に時間モデルの節がある
