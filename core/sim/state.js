/**
 * state.js — エージェント横断のベクトル化された状態管理
 *
 * オブジェクトの配列ではなく、フィールドごとの TypedArray（SoA: Structure of Arrays）
 * で保持し、将来の多体化・並列化・ベクトル演算に耐える形にしておく。
 */

export class EntityState {
  /** @param {number} capacity - 保持できる最大エンティティ数 */
  constructor(capacity) {
    this.capacity = capacity;
    this.count = 0;

    this.id = new Array(capacity).fill(null);
    this.faction = new Array(capacity).fill(null); // 'defender' | 'intruder' | 'neutral'
    this.x = new Float64Array(capacity);
    this.y = new Float64Array(capacity);
    this.heading = new Float64Array(capacity); // ラジアン
    this.speed = new Float64Array(capacity);
    this.alive = new Uint8Array(capacity);
  }

  /** @returns {number} 追加したエンティティのインデックス */
  add({ id, faction, x, y, heading = 0, speed = 0 }) {
    if (this.count >= this.capacity) {
      throw new Error('EntityState capacity exceeded');
    }
    const i = this.count++;
    this.id[i] = id;
    this.faction[i] = faction;
    this.x[i] = x;
    this.y[i] = y;
    this.heading[i] = heading;
    this.speed[i] = speed;
    this.alive[i] = 1;
    return i;
  }

  /** @returns {Array<object>} 現在の全エンティティのスナップショット（描画・ログ用） */
  snapshot() {
    const out = [];
    for (let i = 0; i < this.count; i++) {
      if (!this.alive[i]) continue;
      out.push({
        id: this.id[i],
        faction: this.faction[i],
        x: this.x[i],
        y: this.y[i],
        heading: this.heading[i],
        speed: this.speed[i],
      });
    }
    return out;
  }

  indexOf(id) {
    return this.id.indexOf(id);
  }
}
