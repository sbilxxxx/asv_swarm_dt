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
