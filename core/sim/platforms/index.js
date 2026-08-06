/**
 * index.js — Platform登録レジストリ
 *
 * AUV（6自由度・浮力ダイナミクス）を追加する場合はここに登録するだけで済む。
 */

import { AsvPlatform } from './asv.js';

export const platforms = {
  asv: AsvPlatform,

  // 将来の拡張予約（未実装）:
  // auv: null,
};
