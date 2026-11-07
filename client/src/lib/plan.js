// 行程数据的前端视图模型（纯函数）。兼容新接口响应和旧版本地历史记录。

export const DAY_COLORS = ['#1a73e8', '#d93025', '#188038', '#e37400', '#9334e6', '#00838f', '#c2185b', '#5f6368'];

export function dayColor(day) {
  const index = Math.max(1, Number(day) || 1) - 1;
  return DAY_COLORS[index % DAY_COLORS.length];
}

export function accommodationsOf(plan) {
  if (plan?.accommodations?.length) return plan.accommodations;
  return plan?.accommodation ? [plan.accommodation] : [];
}

export function planTitle(plan) {
  if (plan?.title) return plan.title;
  const parts = [plan?.city, plan?.days ? `${plan.days} 日游` : ''].filter(Boolean);
  return parts.length ? parts.join(' ') : '旅行计划';
}

export function spotKey(day, spot, index) {
  return spot.location_id || `day:${day}:spot:${index}`;
}

/**
 * 与地图标记一致的编号与键：只有已定位的地点获得序号。
 * 地图校验未启用时没有地图标记，按顺序给所有地点编号。
 */
export function numberStops(spots = [], day = 0, { numberAll = false } = {}) {
  let order = 0;
  return spots.map((spot, index) => ({
    spot,
    key: spotKey(day, spot, index),
    order: numberAll || spot.coordinates ? ++order : null,
  }));
}

/** 本次结果是否做过 Google 地图校验（未配置 Key 时为 false）。 */
export function isGroundingAvailable(result) {
  if (result?.quality?.grounding_available === false) return false;
  return !(result?.geocodingWarnings || []).some(item => item.code === 'maps_unavailable');
}

/** 以出发地点为键的交通段映射；旧数据没有 legs 时返回空映射。 */
export function legsByOrigin(route) {
  const map = new Map();
  for (const leg of route?.legs || []) if (leg.from_id) map.set(leg.from_id, leg);
  return map;
}

/** 把接口响应或历史记录统一成前端使用的结构。 */
export function normalizeResult(data, query = '') {
  if (!data?.plan) return null;
  const plan = data.plan;
  return {
    query: data.query || query,
    plan,
    routes: data.routes || [],
    parsedRequest: data.parsedRequest || data.parsed_request || plan.__parsed_request || null,
    transitMarkers: data.transitMarkers || data.transit_markers || plan.__transit_markers || [],
    verification: data.verification || plan.__verification || null,
    geocodingWarnings: data.geocodingWarnings || data.geocoding_warnings || plan.__geocoding_warnings || [],
    quality: data.quality || null,
    meta: data.meta || null,
  };
}

/** 汇总“质量检查”提示：一句话结论 + 可展开的明细。 */
export function summarizeQuality(result) {
  const verification = result?.verification || {};
  const warnings = result?.geocodingWarnings || [];
  const spots = (result?.plan?.daily_plans || []).flatMap(day => day.spots || []);
  const located = spots.filter(spot => spot.coordinates).length;
  const removed = warnings.filter(item => item.removed);
  const groups = [
    { title: '缺少你提到的地点', items: (verification.missing_spots || []).map(name => ({ name, text: '' })) },
    {
      title: '已修正或移除的地点',
      items: (verification.incorrect_spots || []).map(item => ({ name: item.name, text: item.issue || '' })),
    },
    {
      title: '未能在地图上定位',
      items: warnings.filter(item => !item.removed).map(item => ({ name: item.name, text: item.reason || '' })),
    },
    { title: '提醒', items: (verification.warnings || []).map(text => ({ name: '', text })) },
  ].filter(group => group.items.length > 0);

  const issueCount = groups.reduce((sum, group) => sum + group.items.length, 0);
  const parts = [];
  if (!isGroundingAvailable(result)) parts.push('地图校验未启用');
  else if (spots.length) parts.push(`${located}/${spots.length} 个地点已在 Google 地图上核实`);
  if (removed.length) parts.push(`移除 ${removed.length} 个外地同名地点`);
  if (verification.regenerated) parts.push('已自动修正');
  return {
    tone: issueCount === 0 ? 'ok' : 'warn',
    headline: parts.join(' · ') || (verification.passed ? 'AI 自审通过' : '已完成检查'),
    issueCount,
    groups,
    skipped: Boolean(verification.skipped),
  };
}

/** 生成“在 Google 地图中打开当天路线”的链接（Maps URLs API）。 */
export function googleMapsDirectionsUrl(spots = [], { travelMode } = {}) {
  const located = spots.filter(spot => spot?.coordinates);
  if (located.length === 0) return null;
  const point = spot => `${spot.coordinates.lat},${spot.coordinates.lng}`;
  if (located.length === 1) {
    const params = new URLSearchParams({ api: '1', query: point(located[0]) });
    if (located[0].coordinates.place_id) params.set('query_place_id', located[0].coordinates.place_id);
    return `https://www.google.com/maps/search/?${params}`;
  }
  const first = located[0];
  const last = located[located.length - 1];
  const middle = located.slice(1, -1).slice(0, 8);
  const params = new URLSearchParams({ api: '1', origin: point(first), destination: point(last) });
  if (first.coordinates.place_id) params.set('origin_place_id', first.coordinates.place_id);
  if (last.coordinates.place_id) params.set('destination_place_id', last.coordinates.place_id);
  if (middle.length) {
    params.set('waypoints', middle.map(point).join('|'));
    if (middle.every(spot => spot.coordinates.place_id)) {
      params.set('waypoint_place_ids', middle.map(spot => spot.coordinates.place_id).join('|'));
    }
  }
  // 公共交通模式不支持途经点。
  const mode = travelMode === 'transit' && middle.length ? null : travelMode;
  if (mode) params.set('travelmode', mode);
  return `https://www.google.com/maps/dir/?${params}`;
}

export function directionsModeFor(route, preference) {
  if (preference === 'drive') return 'driving';
  if (preference === 'walk' || route?.travel_mode === 'WALK') return 'walking';
  // 即使接口没有返回公交数据（如日本），Google 地图 App 本身仍支持公交导航。
  return 'transit';
}
