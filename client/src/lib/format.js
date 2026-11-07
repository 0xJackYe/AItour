// 展示用格式化与文案映射（纯函数，可在 Node 中直接测试）。

export const PACE_LABELS = { relaxed: '轻松', moderate: '适中', intensive: '紧凑' };
export const BUDGET_LABELS = { budget: '经济', moderate: '中等预算', luxury: '高端' };
export const TRANSPORT_LABELS = { public_transit: '公共交通', drive: '自驾', walk: '步行为主' };
export const SPOT_TYPE_LABELS = {
  attraction: '景点',
  restaurant: '餐饮',
  shopping: '购物',
  transport: '交通',
  hotel: '住宿',
};

const VEHICLE_LABELS = {
  SUBWAY: '地铁',
  METRO_RAIL: '地铁',
  HEAVY_RAIL: '火车',
  RAIL: '火车',
  COMMUTER_TRAIN: '通勤列车',
  HIGH_SPEED_TRAIN: '高铁',
  LONG_DISTANCE_TRAIN: '火车',
  TRAM: '有轨电车',
  LIGHT_RAIL: '轻轨',
  MONORAIL: '单轨',
  BUS: '公交',
  INTERCITY_BUS: '大巴',
  TROLLEYBUS: '公交',
  FERRY: '轮渡',
  CABLE_CAR: '缆车',
  FUNICULAR: '缆车',
};

export function formatDistance(meters) {
  if (!Number.isFinite(meters) || meters <= 0) return '';
  if (meters < 1000) return `${Math.round(meters / 10) * 10} m`;
  return `${(meters / 1000).toFixed(meters < 10000 ? 1 : 0)} km`;
}

export function formatDuration(seconds) {
  if (!Number.isFinite(seconds) || seconds <= 0) return '';
  const totalMinutes = Math.max(1, Math.round(seconds / 60));
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours === 0) return `${minutes} 分钟`;
  return minutes ? `${hours} 小时 ${minutes} 分钟` : `${hours} 小时`;
}

export function formatHours(hours) {
  if (!Number.isFinite(hours) || hours <= 0) return '';
  return `${Number(hours.toFixed(2))} 小时`;
}

/** 两个地点之间的交通描述，如“地铁 乌丸线 · 18 分钟”。 */
export function describeLeg(leg) {
  if (!leg) return null;
  const duration = formatDuration(leg.duration_seconds);
  const distance = formatDistance(leg.distance_meters);
  switch (leg.mode) {
    case 'WALK':
      return { icon: 'walk', label: [duration ? `步行 ${duration}` : '步行', distance].filter(Boolean).join(' · ') };
    case 'TRANSIT': {
      const line = leg.transit_lines?.[0];
      const vehicle = VEHICLE_LABELS[line?.vehicle] || '公共交通';
      const lineName = line?.name && line.name !== vehicle ? ` ${line.name}` : '';
      return { icon: 'transit', label: [`${vehicle}${lineName}`, duration].filter(Boolean).join(' · ') };
    }
    case 'DRIVE':
      return { icon: 'car', label: ['驾车', duration, distance].filter(Boolean).join(' · ') };
    default:
      return { icon: 'route', label: distance ? `约 ${distance}（直线距离）` : '交通方式待定' };
  }
}

export function formatDate(timestamp, now = Date.now()) {
  if (!timestamp) return '';
  const date = new Date(timestamp);
  const days = Math.floor((now - date.getTime()) / 86400000);
  if (days <= 0 && new Date(now).toDateString() === date.toDateString()) {
    return `今天 ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
  }
  if (days < 1) return '昨天';
  if (days < 7) return `${days} 天前`;
  return `${date.getFullYear()}/${date.getMonth() + 1}/${date.getDate()}`;
}
