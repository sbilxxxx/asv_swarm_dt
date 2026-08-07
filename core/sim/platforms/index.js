/**
 * index.js — Platform登録レジストリ
 *
 * AUV（6自由度・浮力ダイナミクス）を追加する場合、ここへの登録自体は1行で済むが、
 * それだけでは動かない（B-5対応・正直化）。`EntityState`（core/sim/state.js）に
 * 深度(z)フィールドが無く、GNSS/レーダー/通信（gnss.js・radar.js・comms.js）は
 * いずれも2D平面（x, y）前提で実装されている。AUV追加には
 * EntityStateへの深度(z)フィールド追加とセンサーの3D対応が必要（現状は2D専用）。
 */

import { AsvPlatform } from './asv.js';

export const platforms = {
  asv: AsvPlatform,

  // 将来の拡張予約（未実装）:
  // auv: null,
};
