// 多城市行程的视图模型（纯函数）：城市分组、城市间交通的文案与导航链接、
// 以及“总览 / 城市 / 某一天”三级视图的筛选。

import { formatDistance, formatDuration, transferModeMeta } from './format.js';

/** 城市间交通在地图上统一使用深灰色，与每天的颜色区分开。 */
export const TRANSFER_COLOR = '#3c4043';

/** 与服务端一致的城市名比较键：去掉“市 / 都 / 府”等后缀（“京都”“成都”保持原样）。 */
export function cityKey(value) {
  const base = String(value || '').normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
  const stripped = base.replace(/(?:特别行政区|自治区|自治州|地区|市|都|府|县|州|省)$/u, '');
  return [...stripped].length >= 2 ? stripped : base;
}

export function sameCity(left, right) {
  const a = cityKey(left);
  const b = cityKey(right);
  return Boolean(a && b && a === b);
}

function dayCityName(plan, day) {
  return day?.city || plan?.city || '';
}

/** 按城市分组（按第一次出现的顺序），每组含该城市所有的天。 */
export function cityGroups(plan) {
  const groups = [];
  for (const day of plan?.daily_plans || []) {
    const name = dayCityName(plan, day);
    const key = cityKey(name) || 'trip';
    let group = groups.find(item => item.key === key);
    if (!group) {
      group = { key, name: name || '行程', days: [] };
      groups.push(group);
    }
    group.days.push(day.day);
  }
  return groups;
}

export function isMultiCity(plan) {
  return cityGroups(plan).length > 1;
}

/** 连续停留的城市段（同一城市不连续时会出现多段）。 */
export function cityRuns(plan) {
  const runs = [];
  for (const day of plan?.daily_plans || []) {
    const name = dayCityName(plan, day);
    const key = cityKey(name) || 'trip';
    const last = runs[runs.length - 1];
    if (last && last.key === key) last.days.push(day.day);
    else runs.push({ key, name: name || '行程', days: [day.day] });
  }
  return runs;
}

export function dayRangeLabel(days) {
  if (!days?.length) return '';
  const first = days[0];
  const last = days[days.length - 1];
  return first === last ? `第 ${first} 天` : `第 ${first}–${last} 天`;
}

/** “路线”卡片的条目：城市段与城市间交通按时间顺序交替排列。 */
export function routeOutline(plan, transfers = []) {
  const runs = cityRuns(plan);
  const runStarts = new Set(runs.slice(1).map(run => run.days[0]));
  const items = runs.map(run => ({ type: 'city', run, position: run.days[0] }));
  for (const transfer of transfers) {
    // 换城市当天的交通排在到达城市之前；其余的排在当天所在城市之后。
    const position = runStarts.has(transfer.day) ? transfer.day - 0.5 : transfer.day + 0.5;
    items.push({ type: 'transfer', transfer, position });
  }
  return items.sort((a, b) => a.position - b.position || (a.type === 'transfer' ? -1 : 1));
}

function point(endpoint) {
  const coordinates = endpoint?.coordinates;
  return coordinates && Number.isFinite(coordinates.lat) && Number.isFinite(coordinates.lng) ? coordinates : null;
}

/** Google 地图路线链接：有坐标用坐标，没有坐标用车站或城市名搜索。 */
export function transferDirectionsUrl(transfer) {
  if (!transfer) return null;
  const from = point(transfer.from);
  const to = point(transfer.to);
  const origin = from ? `${from.lat},${from.lng}` : transfer.from_place || transfer.from_city;
  const destination = to ? `${to.lat},${to.lng}` : transfer.to_place || transfer.to_city;
  if (!origin || !destination) return null;
  const params = new URLSearchParams({ api: '1', origin, destination });
  const travelmode = { train: 'transit', bus: 'transit', ferry: 'transit', drive: 'driving' }[transfer.mode];
  if (travelmode) params.set('travelmode', travelmode);
  return `https://www.google.com/maps/dir/?${params}`;
}

/** 城市间交通的展示文案。 */
export function describeTransfer(transfer) {
  const meta = transferModeMeta(transfer.mode);
  const seconds = Number.isFinite(transfer.duration_seconds)
    ? transfer.duration_seconds
    : transfer.duration_minutes ? transfer.duration_minutes * 60 : null;
  const duration = formatDuration(seconds);
  const schematic = transfer.route_source === 'schematic';
  const lines = (transfer.transit_lines || []).map(line => line.name).filter(Boolean).join(' / ');
  const fromPlace = transfer.from_place || transfer.from?.name || '';
  const toPlace = transfer.to_place || transfer.to?.name || '';
  const departs = [transfer.depart_time, fromPlace].filter(Boolean).join(' ');
  const arrives = [transfer.arrive_time, toPlace].filter(Boolean).join(' ');
  return {
    icon: meta.icon,
    modeLabel: meta.label,
    title: `${transfer.from_city} ${transfer.round_trip ? '⇄' : '→'} ${transfer.to_city}`,
    service: transfer.service || lines || meta.label,
    duration: duration ? `约 ${duration}` : '',
    times: departs && arrives ? `${departs} → ${arrives}` : '',
    facts: [
      duration ? `约 ${duration}` : '',
      // 示意线的直线距离不代表实际里程，不展示。
      schematic ? '' : formatDistance(transfer.distance_meters),
      transfer.cost || '',
    ].filter(Boolean),
    route: transfer.road ? `经${transfer.road}` : transfer.via ? `途经${transfer.via}` : '',
    tips: transfer.tips || '',
    notes: transfer.notes || '',
    schematic,
    roundTrip: Boolean(transfer.round_trip),
    mapsUrl: transferDirectionsUrl(transfer),
  };
}

export function transfersOnDay(transfers, day) {
  return (transfers || []).filter(transfer => transfer.day === day);
}

/** 当前视图层级：多城市行程的总览（trip）、某个城市（city）、某一天（day）。 */
export function viewLevel(view, multiCity) {
  if (view?.day != null) return 'day';
  if (view?.city != null) return 'city';
  return multiCity ? 'trip' : 'city';
}

/** 当前视图下列表中显示的天。 */
export function visibleDays(plan, view) {
  const days = plan?.daily_plans || [];
  if (view?.day != null) return days.filter(day => day.day === view.day);
  if (view?.city != null) return days.filter(day => (cityKey(dayCityName(plan, day)) || 'trip') === view.city);
  return days;
}

/** 某一天所属的城市键。 */
export function cityOfDay(plan, dayNumber) {
  const day = (plan?.daily_plans || []).find(item => item.day === dayNumber);
  return day ? cityKey(dayCityName(plan, day)) || 'trip' : null;
}

function average(points) {
  if (!points.length) return null;
  return {
    lat: points.reduce((sum, item) => sum + item.lat, 0) / points.length,
    lng: points.reduce((sum, item) => sum + item.lng, 0) / points.length,
  };
}

/** 总览地图上城市标记的位置：住宿 → 该城市已定位地点的中心 → 城市间交通的端点。 */
export function cityPosition(result, group) {
  const plan = result?.plan;
  const stay = (plan?.accommodations || []).find(item => item.coordinates && sameCity(item.city, group.name));
  if (stay) return { lat: stay.coordinates.lat, lng: stay.coordinates.lng };
  const spots = (plan?.daily_plans || [])
    .filter(day => group.days.includes(day.day))
    .flatMap(day => day.spots || [])
    .filter(spot => spot.coordinates && (!spot.city || sameCity(spot.city, group.name)));
  const center = average(spots.map(spot => spot.coordinates));
  if (center) return center;
  for (const transfer of result?.transfers || []) {
    if (sameCity(transfer.to_city, group.name) && point(transfer.to)) return point(transfer.to);
    if (sameCity(transfer.from_city, group.name) && point(transfer.from)) return point(transfer.from);
  }
  return null;
}
