/**
 * ship_classes.js — 艦種の個体差（速力・センサー・爆破半径・積荷）
 *
 * ゲームを成立させているのは、この表の非対称性である。将棋の駒と同じで、
 * 強い駒・速い駒・見える駒が別々にあり、どれをどれに当てるかが問題になる。
 *
 * 【旗を壊せるのは武装艦（blastRadiusM > 0）だけ】
 * 資産に到達して意味があるのは爆薬を積んだ艦種（快速艇 50m・重装艇 100m）で、
 * **届く距離はその艇自身の爆破半径そのもの**である（mission.js。正典 docs/game-design.md §2「対旗」）。
 * 索敵艇は半径0＝非武装なので、資産の真上に着いても何も起きない。したがって防御側の仕事は
 * 「速い快速艇をまず止め、次に遠くから届く重装艇を待ち受ける」という二段構えになる——が、
 * **レーダーには点しか映らず、どれが重装艇かは分からない**（radar.js は艦種を返さない）。
 * 識別を視覚に担わせる余地をここで開けている（L1 で索敵艇の VLM が埋める）。
 *
 * 【迎撃＝自爆による相討ち】
 * 全艇が自爆兵器で、相手の爆破半径へ入った時点で起爆し双方が消える（mission.js）。
 * 半径が大小あることが効きの差になる:
 *   - 重装艇 100m: 迂闊に近づけない。討つには相討ちを覚悟して飛び込むしかない
 *   - 快速艇  50m: 護衛として立ち塞がり、防御艇と1対1で交換する
 *   - 索敵艇   0m: 非武装。自分からは起爆できない（相手の半径に入れば消える）
 * 単純に相討ちを続けると最後は同速の重装艇同士が残り、防御側は追いつけない。
 * だから防御側は「敵快速艇の 50m を避けながら重装艇の 100m へ飛び込む」必要がある——
 * これが艇レベルの判断（回避しつつ追跡）が要る理由である。
 *
 * 【運動性能】asv.js はここから読む。速力差が相性を作る:
 *   快速(9) は重装(4) に追いつけるが、快速(9) 同士は追いつけない。
 */

export const DEFAULT_SHIP_CLASS = 'runner';

/**
 * @typedef {object} ShipClass
 * @property {string} label - 表示名（HUD・ログ・プロンプト）
 * @property {number} maxSpeedMps
 * @property {number} maxTurnRateRadS
 * @property {number} accelMps2
 * @property {number} radarRangeM - この艇のレーダー探知距離
 * @property {number} blastRadiusM - この艇が起爆したとき巻き込む半径（0 = 非武装）
 * @property {boolean} decisiveOnAsset - 「本命の駒」の印。A-1 以降、**勝敗判定には使わない**
 *   （旗の破壊可否は blastRadiusM > 0 で決まる）。指揮官の脅威度づけなど表現側の材料として残す
 */

/** @type {Record<string, ShipClass>} */
export const SHIP_CLASSES = Object.freeze({
  /** 歩: 速いが脆い。護衛にも突撃にも使う数の駒 */
  runner: Object.freeze({
    label: 'runner',
    maxSpeedMps: 9,
    maxTurnRateRadS: 0.7,
    accelMps2: 2.0,
    radarRangeM: 300,
    blastRadiusM: 50,
    decisiveOnAsset: false,
  }),
  /** 金: 遠くまで見えるが非武装。視界を供給するのが仕事 */
  scout: Object.freeze({
    label: 'scout',
    maxSpeedMps: 6,
    maxTurnRateRadS: 0.5,
    accelMps2: 1.5,
    radarRangeM: 1200,
    blastRadiusM: 0,
    decisiveOnAsset: false,
  }),
  /** 飛車: 遅く鈍いが、爆破半径が大きく、資産へ届けば勝敗が決する */
  heavy: Object.freeze({
    label: 'heavy',
    maxSpeedMps: 4,
    maxTurnRateRadS: 0.3,
    accelMps2: 1.0,
    radarRangeM: 400,
    blastRadiusM: 100,
    decisiveOnAsset: true,
  }),
});

/**
 * 未知の艦種は既定へ落とす（シナリオの打ち間違いでデモを止めない）。
 * @param {string|null|undefined} name
 * @returns {ShipClass}
 */
export function shipClassOf(name) {
  return SHIP_CLASSES[name] ?? SHIP_CLASSES[DEFAULT_SHIP_CLASS];
}

/** シナリオ検証用。未知の艦種名なら false */
export function isKnownShipClass(name) {
  return Object.prototype.hasOwnProperty.call(SHIP_CLASSES, name);
}
