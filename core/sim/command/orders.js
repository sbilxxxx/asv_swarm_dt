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
