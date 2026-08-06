/**
 * gnss.js — GNSSセンサー（純粋計算、core内で完結）
 */

import { SensorBase } from './sensor_base.js';
import { localToLatLon } from '../../coord.js';

export class GnssSensor extends SensorBase {
  observe(world, entityId) {
    const i = world.state.indexOf(entityId);
    if (i < 0) return null;
    const { lat, lon } = localToLatLon(world.state.x[i], world.state.y[i]);
    return {
      type: 'gnss',
      lat,
      lon,
      headingDeg: (world.state.heading[i] * 180) / Math.PI,
      speedMps: world.state.speed[i],
      timestamp: world.clock,
    };
  }

  /** NMEA GGA風の文字列表現（デモ用の見せ方） */
  toNmeaLike(reading) {
    if (!reading) return '';
    const t = reading.timestamp.toFixed(1);
    return `$GPGGA,${t},${reading.lat.toFixed(6)},${reading.lon.toFixed(6)},SIM`;
  }
}
