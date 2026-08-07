# コードレビュー指摘事項と対応状況（2026-08-07）

- レビュー実施: 2026-08-07、別モデル（Fable）によるコードベース全体の独立レビュー
- レビュー方法: 全27ソースファイル精読、headless Chromeでのスクリーンショット4枚、ページ内シーングラフの実測ダンプ（船体姿勢・レーダー方位）、Nodeでのcore単体実行（スループット・reset挙動・座標系singleton）
- **本ドキュメントの目的**: 指摘を別セッションからも参照できるようにし、対応漏れを防ぐ。対応済み項目は「状態」欄を更新すること。

---

## 総評（レビュー原文の要約）

骨格は本物。core/がDOM・Three.js非依存で書かれていることをNodeで無改造実行して確認（3隻で38,000 steps/s）。カメラセンサーの注入設計も実際に機能しており、「描画とロジックの分離」はスローガンではなく実装されている。

**しかし、GPU申請の4主張（多数体・並列実験・headless・学習データログ）のうち、実測で立つのは「headlessで速い」の一点だけ。** reset()がエピソードを再初期化できない、ログが30隻でクラッシュする、coord.jsのグローバルoriginが並列ワールドを壊す、という形で残り3つはコードが自ら反証してしまう。

見た目も「3D主画面に船が映らない」「2Dは30シム秒で3艇が団子になり永久回転」という状態。ただし致命傷はなく、指摘の大半は数行〜半日で直る。

---

## A. 正確性バグ（実測で確認済み）

| # | 指摘 | 実測根拠 | 状態 |
|---|------|---------|------|
| A-1 | **3D船体の艏首が進行方向から常に90°ズレている**。`scene_builder.js` の `group.rotation.x = π/2` と `rotation.z = -heading` の組合せ。Three.jsのEuler 'XYZ'は R = Rx·Ry·Rz なので、船体ローカル+Yはワールドで `(sin h, -cos h)` を向く。進行方向は `(cos h, sin h)` | ページ内実測で全3隻 bowVsVelocityDeg = -90.0（船は常に左横滑りで進む） | **対応済** — ジオメトリ側で +X=船首 / +Y=上 に正規化し、`rotation.y = heading` へ変更 |
| A-2 | 同じ回転の巻き添えで**子メッシュ配置が崩壊**。デッキ・マスト・ドーム・航海灯が全て高さ+1.76m固定で水平に散らばり、マスト円柱は水平に寝ている | childWorldYOffsets が全て +1.76 | **対応済** — 新座標系で全子メッシュを再定義（デッキ・窓・マスト・ドーム・陣営ストライプ・航海灯） |
| A-3 | **航跡スプライトが船の18.7m上空に浮いている**。`wake.position.set(0, 0.05*s, -8.5*s)` の local -Z が回転後に world +Y になる | 実測 dy=+18.7m | **対応済** — 新座標系で水面に寝かせて配置 |
| A-4 | **レーダーPPIが左右鏡像**。`hud.js` の `px = cx + sin(rel)*r` は方位が「北から時計回り」の場合のみ正しい。本リポジトリは数学規約（東0°・CCW正）なので右舷の目標が画面左に出る | intruder-1（相対方位-76.3°=右舷正横）が screen-LEFT に描画 | **対応済** — `px = cx - sin(rel)*r` に修正 |
| A-5 | **swarm-simのシミュレーション速度がモニタのリフレッシュレート依存**。`env_api.js` の `dt = 0.5` 固定 × requestAnimationFrame毎に1 step。60Hzで30倍速。また0.5s刻みは最大回頭28.6°/stepと粗い。`digital-twin/main.js` は同じASV運動学を可変dt（≤0.1s）で積分するため、**同一coreを謳いながら2つのViewで物理の刻みが異なる**（FR3の精神に反する） | 待機1.5秒でt=29.5（約20倍）、6秒でt=156 | **対応済（swarm-sim側）** — `swarm-sim/main.js` を実時間アキュムレータ方式へ変更。`env.dt`(既定0.1s)刻みで固定ステップ実行し、`TIME_SCALE=3`倍速のみを掛ける（等倍だと1エピソード最大240秒待たされるため）。1フレームの加算実時間は`MAX_FRAME_DT_S=0.25s`でクランプしバックグラウンドタブ復帰時の暴走加算を防止。意思決定間隔もフレームではなくシムステップ数基準（`DECISION_INTERVAL_STEPS=6` ≒0.6シム秒毎）に変更。**digital-twin側は本タスクの対象外のため未対応のまま**（`digital-twin/main.js`は引き続き`Math.min((nowMs-lastT)/1000, 0.1)`の可変dtで積分しており、swarm-simとdigital-twinで物理の刻み方が異なる状態はまだ残っている） |
| A-6 | **`reset()` がエピソードを再初期化しない**。clockとログの初期化のみ。Gym風APIと言いながら2エピソード目が回せない | 200 step走行後に`reset()`しても位置は(260.6,-264.9)のまま（スポーン位置(-150,-100)に戻らない） | **対応済** — `EnvApi.reset(meta)` が `World.resetEntities()` を呼んでから新しいログエピソードを開始するよう接続。`tests/core_smoke.test.js` の `testResetReturnsToSpawn` / `testBreachedOutcomeAndSecondEpisode` で2エピソード連続実行を回帰確認 |
| A-7 | **`coord.js` のモジュールグローバルorigin**。別originのシナリオで`createSceneGeometry()`を呼ぶと既存ワールドのGNSSが化ける。「グローバル変数非依存・並列実行を妨げない」という自らの設計原則に違反 | 実測: (35.45,139.75)→(34.00,133.50)に変化 | **未対応** |
| A-8 | **`EntityState.indexOf` がaliveを見ない、そもそも死亡経路が無い**。alive=0にするAPIがリポジトリ全体に存在しない。snapshot/radar/commsの`!alive[j]`スキップは現状デッドコード | 手動でalive=0にしても`indexOf`は生きたインデックスを返す | **対応済** — `indexOf`自体はaliveを見ない仕様のまま維持（`resetEntities()`が死亡エンティティを見つけて復活させる必要があるため）。ガードは適用箇所である`EnvApi.step()`のaction適用ループに追加し、`alive[i]===0`の艇へはplatform.step()を呼ばないようにした。`mission.js`の撃破経路と合わせて、死亡エンティティが実際に停止することを`tests/core_smoke.test.js`で確認 |
| A-9 | **boundsの定義と実データの矛盾**。`scene_format.js` はboundsを「coastline＋運用エリア」と定義し警告まで書いているが、シナリオJSONに `spawnsAreaLatLon` が無く、全スポーン（y≈-100〜-300m）がbounds（minY≈+250m）の外。さらに `manual_coastline.js` は `spawnsAreaLatLon` を`createSceneGeometry`に渡し忘れ | 2D表示は横長スケールのため偶然救われているだけ | **未対応** |

---

## B. 「宣言はあるが配線されていない」箇所（全て確定）

| # | 指摘 | 状態 |
|---|------|------|
| B-1 | **アダプターレジストリ未使用**。`staticGeometryAdapters` を参照するコードはゼロ。両main.jsは `createSceneGeometry(scenario)` 直呼び。シナリオJSONにadapter指定フィールドも無く、選択メカニズム自体が存在しない。「差し込み口はすでに設計済み」は現状成立しない（アダプターを追加しても誰も呼ばない） | **未対応** |
| B-2 | **`DynamicObservationAdapter.stream()`（AIS/ドローン）の消費者ゼロ**。streamをWorldに流し込む取込経路が無い | **未対応** |
| B-3 | **`environment.sample()` 呼び出しゼロ**。`world.js` で保持するだけで `asv.js` の運動学は環境力を参照しない。**波サロゲートモデルへの「差し替え口」は、差し替えても何も変わらない口** | **未対応** |
| B-4 | **`obstacles` はスキーマのみ**。型定義以外に参照ゼロ。3D/2Dとも描画されず、衝突判定も無く、シナリオJSONにデータも無い | **未対応** |
| B-5 | **AUV「登録するだけで済む」は不成立**。`EntityState` に深度(z)が無く、radar/gnss/commsも2D前提。実際はstate・センサーの改修が必要 | **未対応**（ドキュメントの記述を正直にするだけでも可） |
| B-6 | **FR8ログの実質未達**。`{t, actions, observation}` のみで、FR8が明記する報酬相当の評価値・エピソード終了(doneは常にfalse)・シード・シナリオメタデータが無い。`toJson()` の呼び出し元もゼロで、記録は取り出す手段のないままメモリに溜まり捨てられる。**3隻2000 stepで9.7MB、30隻2000 stepで `RangeError: Invalid string length` でクラッシュ**（1 step≈213KB） | **対応済（coreの記録形式・reward/done/outcome側）** — `episode_logger.js` をネスト保存からper-agentフラット行のJSON Lines（`episode_start`/`step`/`episode_end`）へ再設計し、`toJson()`は廃止して`toJsonl()`に置換。`EnvApi.step()`が`evaluateMission()`のreward/done/outcomeを各stepの生存エージェント行へ書き込み、`reset(meta)`が`scenario`/`episodeIndex`等をエピソードヘッダ行へ渡す（`episodeIndex`はRNGのシードではなく呼び出し側管理の通し番号。当初`seed`という名前だったが、JSONL消費者を誤解させるため後日リネームした）。`tests/core_smoke.test.js`の`testLoggerStress`で30隻×2000 stepを実行し、`toJsonl()`がクラッシュせず全60,001行が`JSON.parse`できることを確認（約15.4MB）。**UIのダウンロードボタンは本タスクで対応済** — `swarm-sim/hud_panel.js`の`wireDownloadButton()`が`env.logger.toJsonl()`をBlob化し、「ログDL (.jsonl)」ボタンから`.jsonl`としてダウンロードできる（core側はfs/DOM非依存のまま、Blob化・aタグ操作はView側に隔離）。Node側のファイル書き出し（headlessランナーからの保存）は未対応のまま |
| B-7 | **LLM/VLM/VLAのコードが1行も無い**。`decideFn` の注入口は良い設計だが、プロンプト生成・出力パース・Ollama呼び出しの実装例が皆無。GPU申請の「VLM推論を回す」との距離は認識しておくべき（**現状、GPUで回す推論対象が存在しない**） | **未対応** |
| B-8 | **「海域を固定しない」原則と `landmarks.js` の矛盾**。`scene_builder.js` が無条件に `buildLandmarks()`（東京タワー・レインボーブリッジ・富士山・お台場を絶対座標でハードコード）を追加。シナリオを別海域に差し替えても東京の景観が描かれる | **未対応** |
| B-9 | **運用リスク: 未コミット改善がGitHub未反映**。審査員がURLで見る公開デモは旧版 | **要注意** — 作業のたびに push すること |

---

## C. GPU主張の説得力（実測評価）

**立つ主張**
- coreのheadless実行（Node無改造で3隻38,525 steps/s、30隻3,108 steps/s）
- マルチレート化は実装済み（`DECISION_INTERVAL_STEPS=6`、`camTick%12`）
- SoA（`state.js`）も実在

**立たない主張**
- エピソード反復（reset欠陥 → A-6）
- 報酬・終了条件（無し → mission.js で対応中）
- 並列ワールド（coordシングルトン → A-7）
- 学習データログ（クラッシュ → B-6）

**その他**
- `env_api.js` は `_reportContacts` と `_observationForAll` で**radar観測を毎step全エージェント2回計算**しており、O(n²)センサーの無駄が多数体化で倍効く
- **最大の問題: headlessランナーがリポジトリに同梱されていない**。レビュアーが外部スクリプトを書いて初めて「回る」ことを実証できた。審査員は書いてくれない
  → **対応済（E-5）**: [`scripts/headless_run.js`](../scripts/headless_run.js)を同梱。`node scripts/headless_run.js --episodes 5 --boats 30`のようにリポジトリ内だけで実行・実測でき、外部スクリプト不要になった。実測steps/sはREADME「ヘッドレス実行」節およびE-5行を参照

---

## D. 見た目の評価（スクリーンショット実測）

**3D（digital-twin）**
- 6秒・20秒の両ショットとも**主画面に船が1隻も映らない「誰もいない海」**。orbitRadius=85m固定に対し艦隊は300〜650mに拡散
- 近接ショットでは船は上部構造の見えない素のポリゴン塊、低角度の水面は白飛び気味
- ランドマーク群（レインボーブリッジ・スカイライン・富士山）は良く出来ているが、**主役のASVが画面上最も貧弱**という逆転
- ブリッジカメラパネルも風景しか映らず「センサーで敵を見る」画になっていない
- → **対応済**: 主役艇追従カメラ（orbitRadius=46）、船体正規化、上部構造の再構成、波追従

**2D（swarm-sim）**
- 開始直後（t≈30）は追跡・通信パルス・航跡が読み取れて良い
- しかし捕捉判定も終了条件も無いため、**約30シム秒で3艇が同一点に収束し、以後永久に団子で回転**
- ログは同一の contact_report 行（confidence=1.00）が毎秒数十行流れるスパムで、MAX 200件=視界約5秒分
- 守るべき対象も突破目標も無いため「攻防」ではなく「対称な相互追跡」に見える
- → **対応済**: `mission.js`（core側、既存コミット）＋本タスクでView・エージェント行動側を配線。
  防護対象（`protectedAssetLatLon`、防御艇スポーンより南西・外洋側の水上）を追加し、侵入側はそこへ
  向かい、防御側は迎撃→通報位置調査→（何も無ければ）防護対象を哨戒、という非対称な行動になった
  （`core/sim/agents/rule_based_fallback.js`）。swarm-simに防護対象マーカー＋突破半径円・エピソード
  HUD（episode数・シム時計・防衛/突破/時間切れタリー）・結果バナー（防衛成功/突破された/時間切れ、
  3秒表示後に自動`reset()`してエピソードを繰り返す）・ミッションイベントのログ表示・ログJSONL
  ダウンロードボタンを実装（`swarm-sim/main.js`, `map_view.js`, `hud_panel.js`, `log_panel.js`）。
  スクリーンショットで確認: 3隻は同一点へ収束せず、一定の隊列を保ったまま防護対象へ向かう動きになった
  （＝もはや「団子」ではない）
  - **限界と解消（フォローアップ済）**: 初回実装時点では、`AsvPlatform`が陣営に関係なく同一の
    `MAX_SPEED_MPS=6`で頭打ちになるため、加速後は防御側・侵入側とも巡航速度が事実上同じになり、
    防御側の迎撃ロジック（相手の現在位置をそのまま追う純追跡）は等速の純追跡では幾何学的に距離を
    ゼロへ詰め切れず（`INTERCEPT_RANGE_M=60`に対し最短でも約94〜96mで頭打ち）、既定シナリオが
    **毎回同じタイミングで`breached`に終わる決定論的な展開**になっていた。これはE-4（攻防のゲーム化）
    の趣旨に反する（「勝ったり負けたりする反復対戦→戦術学習」の物語が成立しない）ため、追加対応した:
    - **防御側にlead pursuit（見越し追跡）を追加**（`rule_based_fallback.js`の`predictInterceptBearing()`）。
      レーダーのbearing/rangeからコンタクトの絶対位置を復元し、`memory`（`AgentBase.remember()`が
      蓄積する過去observation）から同一コンタクトの前回位置を探して有限差分で速度を推定、その速度で
      `MAX_LOOKAHEAD_S=6`秒先まで進んだ見越し点を狙う。速度推定できない初回遭遇時は純追跡にフォールバック
    - **侵入側にエピソード別の迂回**を追加。乱数は使わない方針のため、`EnvApi._observationForAll()`が
      新たに`observation.episode`（`EpisodeLogger.currentEpisode`）を渡し、侵入側は
      `episode % 3`から決定論的に-1/0/+1の迂回角（`APPROACH_VARIATION_STEP_RAD=55°`）を選んで
      防護対象より450m遠方では迂回、近づいたら直進に切り替える（`decideIntruder()`）。
      同じエピソード番号なら毎回同じ経路、エピソードが変われば経路も変わる
    - **検証**: `tests/core_smoke.test.js`に`testMultiEpisodeOutcomeVariety`を追加し、実シナリオ・
      実エージェントで6エピソード連続実行して`defended`と`breached`の両方が発生することを回帰確認
      （実測シーケンス: `defended, breached, defended, defended, breached, defended`）。
      swarm-sim実画面でも`防衛成功`バナー（防衛1件目）・`突破された`側のタリー増加（突破1件目）を
      スクリーンショットで確認済み

**審査員目線の結論**: 現状は「動く骨格のデモ」であり、「計算資源を投じたくなる規模・密度の何かが起きている画」ではない。数十秒見れば飽和することが伝わってしまう。

---

## E. 改善提案（レビュー提示の優先度順）

| 優先 | 内容 | 工数感 | 状態 |
|---|------|-------|------|
| 1 | ローカル改善のcommit & push。申請URLの実体を最新化 | ~10分 | **要実施** |
| 2 | 3D船の回転規約修正＋子メッシュ座標の再定義＋規約のコメント明文化 | ~1時間 | **対応済** |
| 3 | レーダー左右反転修正と、GNSS headingの北基準CW・0〜360°正規化表示（`gnss.js`は数学規約の生値で360°超えも表示される） | ~30分 | **一部対応**（レーダーのみ。GNSS表示は未対応） |
| 4 | **[最重要]** 2Dに「攻防のゲーム」を入れる: 保護対象＋intruderの目標到達行動＋防御側の捕捉判定＋done/reward＋エピソード終了で自動リセット。**これ1つで終了条件・報酬・エピソード反復が揃い、FR8ログが学習データの体裁になり、GPU申請の物語（反復対戦→戦術学習）が画面で成立する**。費用対効果が最大 | ~半日 | **対応済（core・View双方）** — `EnvApi.step()`が`evaluateMission()`を呼び`{observation, reward, done, info:{outcome, events}}`を返す。`EnvApi.reset()`が`World.resetEntities()`を呼びエピソード反復が実際に機能。dtも0.1sへ変更（旧0.5sは粗すぎた）。**swarm-sim側の配線もこのタスクで完了**: シナリオに`protectedAssetLatLon`を追加、`observation.protectedAsset`をcore/env_api.jsに追加（`tests/core_smoke.test.js`で回帰確認）、`rule_based_fallback.js`を陣営別行動（侵入=目標到達＋軽い回避、防御=迎撃→通報調査→防護対象の哨戒）に書き換え、swarm-simにマーカー・突破半径円・エピソードHUD・結果バナー・自動`reset()`ループ・ミッションイベントログ・JSONLダウンロードボタンを実装。初回実装では防御側が構造的に追いつけず`breached`に偏る決定論的な展開になっていたが、lead pursuit＋エピソード別侵入経路のフォローアップで解消（`defended`/`breached`双方の発生を6エピソード連続実行で回帰確認）。詳細はD節参照 |
| 5 | headlessランナー同梱（60行程度のNodeスクリプト）＋READMEに実測steps/s記載。「GPUで並列に回せる」を宣言から実証に変える | ~1-2時間 | **対応済** — [`scripts/headless_run.js`](../scripts/headless_run.js)（npm依存なし、CommonJS＋`await import()`でcore/ESMを動的ロード）を追加。`--episodes N`（既定5）・`--boats N`（既定はシナリオ既定の3隻、超過分はリング状に決定論的合成）・`--out path.jsonl`（`env.logger.toJsonl()`をNode側でファイル書き出し）・`--quiet`に対応し、エピソードごとのoutcome/シム時間/壁時計時間と、最後に総steps/s（1隻あたりも）を出力する。実測値（Windowsノート、Node v22.17.0、Intel Core i5-1145G7）: 3隻で約38,400 steps/s、30隻（合成spawn）で約1,900〜2,000 steps/s。README「ヘッドレス実行」節に実行コマンドと実測値を記載。`node tests/core_smoke.test.js`は無改造で全件PASSを確認済み |
| 6 | coord.jsの脱シングルトン化。originをSceneGeometryに持たせる | ~1時間 | **未対応** |
| 7 | ログ形式の再設計。観測全文ネスト保存をやめ、per-agentフラット行のJSONL＋UIダウンロード導線 | ~2時間 | **対応済** — `episode_logger.js`のper-agentフラットJSONL化（`toJsonl()`）に加え、UIダウンロード導線（`swarm-sim/hud_panel.js`の「ログDL (.jsonl)」ボタン、Blob経由でダウンロード）を本タスクで実装 |
| 8 | レジストリの配線。シナリオJSONに `"adapter": "manual_coastline"` を持たせ、両mainが registry 経由でロード。`spawnsAreaLatLon` も通す。`obstacles` は描画するか当面スキーマから外す | ~1時間 | **未対応** |
| 9 | `environment.sample()` を `asv.js` のstepで参照し、波モデル差し込み口を「効く」状態にする。3Dカメラ演出の改善も併せて | ~2-3時間 | **未対応** |

---

## F. 良い点（維持すべき判断）

- **core/Viewの分離が本物**。Nodeで無改造実行できることを実測確認。この一点がGPU主張の土台として最も価値がある
- **カメラセンサーの注入設計**（`world.js` の cameraSensor オプション＋`digital-twin/camera_sensor.js`）が実際に機能しており、L1のVLM接続構想に実装上の裏付けがある。表示用/センサー用カメラ分離の判断も正しい
- **QAメソッドの文書化と `.devtools` の実在**。「静的チェックは動くことしか保証しない」という教訓の明文化は、ソロ開発の品質文化として審査で語れる資産。ただし今回の90°ズレ・空中wakeは「近接で見る」観点が抜けて素通りしており、**手順に「船のクローズアップ確認」を加えるべき**
- **全ファイルの「なぜ」を書くヘッダコメント文化**と、faction/platform/scenario等の命名一貫性
- **構造化メッセージング**（lunar_agents踏襲の contact_report）が、配信範囲制限→2Dパルス→ログまで一気通貫で可視化されている
- SoAの `EntityState`、マルチレート化は主張どおり実装されている数少ない「効率化の宣言」であり維持してよい

---

## 対応の進め方（メモ）

- 優先度4（攻防のゲーム化）が最も費用対効果が高い。A-6（reset）とB-6（ログ）を同時に解決する
- 優先度1（push）は毎回の作業後に必ず実施。審査員が見るのは公開されたコードのみ
- `docs/quality-assurance-method.md` のスクリーンショットPDCA手順に「船のクローズアップ確認」を追記すること（今回のバグが素通りした原因）
