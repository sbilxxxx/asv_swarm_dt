/**
 * calm_sea.js — 今回実装する唯一のEnvironment: 波・海流なしの静水面
 *
 * 将来、簡易解析式の波モデル → 学習済みサロゲートモデルへ差し替える場合は
 * EnvironmentBase を継承した新しいクラスを追加する。
 */

import { EnvironmentBase } from './environment_base.js';

export class CalmSeaEnvironment extends EnvironmentBase {
  sample(x, y, t) {
    return { waveHeightM: 0, currentX: 0, currentY: 0 };
  }
}
