// 逐段路线规划：每两个相邻地点之间单独选择交通方式。
//  - 1.5km 内步行；更远优先公共交通（自驾偏好时优先驾车），失败依次回退；
//  - Routes API 的 TRANSIT 不支持途经点，所以按段请求而不是整天一次请求；
//  - 公共交通出发时间固定为“目的地次日上午 10 点”，避免深夜请求时因停运而无结果；
//  - 全部方式失败时用直线兜底并标记 fallback，地图与统计不会缺段。

import { mapWithConcurrency } from '../lib/async.js';
import { currentSignal } from '../lib/context.js';
import { isAbortError } from '../lib/errors.js';
import { decodePolyline, haversineKm } from '../lib/geo.js';
import { log } from '../lib/log.js';
import { computeRoute } from './google.js';

export const WALK_MAX_KM = 1.5;
const WALK_PREFERRED_MAX_KM = 2.5;
const WALK_FALLBACK_MAX_KM = 4;
const BASE_FIELDS = 'routes.distanceMeters,routes.duration,routes.polyline.encodedPolyline';
const TRANSIT_FIELDS = [
  BASE_FIELDS,
  'routes.legs.steps.travelMode',
  'routes.legs.steps.transitDetails.transitLine.name',
  'routes.legs.steps.transitDetails.transitLine.nameShort',
  'routes.legs.steps.transitDetails.transitLine.vehicle.type',
].join(',');

export function chooseTravelModes(distanceKm, preference = 'public_transit') {
  const walkLimit = preference === 'walk' ? WALK_PREFERRED_MAX_KM : WALK_MAX_KM;
  if (distanceKm <= walkLimit) return ['WALK', preference === 'drive' ? 'DRIVE' : 'TRANSIT'];
  if (preference === 'drive') return distanceKm <= WALK_FALLBACK_MAX_KM ? ['DRIVE', 'TRANSIT', 'WALK'] : ['DRIVE', 'TRANSIT'];
  // 公共交通没有结果时，30 分钟以内的步行比打车更自然。
  if (distanceKm <= WALK_PREFERRED_MAX_KM) return ['TRANSIT', 'WALK', 'DRIVE'];
  return distanceKm <= WALK_FALLBACK_MAX_KM ? ['TRANSIT', 'DRIVE', 'WALK'] : ['TRANSIT', 'DRIVE'];
}

/** 目的地当地“次日上午 10 点”（按经度近似时区），返回 RFC3339 时间。 */
export function nextLocalMorning(lng, now = new Date()) {
  const offsetHours = Math.round(Number(lng || 0) / 15);
  let target = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1, 10 - offsetHours, 0, 0);
  while (target <= now.getTime() + 60 * 60 * 1000) target += 24 * 60 * 60 * 1000;
  return new Date(target).toISOString();
}

function waypoint({ lat, lng }) {
  return { location: { latLng: { latitude: Number(lat.toFixed(6)), longitude: Number(lng.toFixed(6)) } } };
}

function parseDuration(duration) {
  if (!duration) return null;
  const seconds = Number(String(duration).replace(/s$/, ''));
  return Number.isFinite(seconds) ? seconds : null;
}

function transitLines(route) {
  const seen = new Set();
  const lines = [];
  for (const leg of route.legs || []) {
    for (const step of leg.steps || []) {
      const line = step.transitDetails?.transitLine;
      if (!line) continue;
      const name = line.nameShort || line.name;
      if (!name || seen.has(name)) continue;
      seen.add(name);
      lines.push({ name, vehicle: line.vehicle?.type || null });
    }
  }
  return lines.slice(0, 4);
}

function requestBody(from, to, mode) {
  const body = {
    origin: waypoint(from),
    destination: waypoint(to),
    travelMode: mode,
    computeAlternativeRoutes: false,
    // 地图总览只需要简化折线，HIGH_QUALITY 会显著增加前端缩放时的重绘压力。
    polylineQuality: 'OVERVIEW',
    polylineEncoding: 'ENCODED_POLYLINE',
    languageCode: 'zh-CN',
    units: 'METRIC',
  };
  if (mode === 'TRANSIT') body.departureTime = nextLocalMorning(from.lng);
  return body;
}

function straightLeg(base, from, to, distanceKm) {
  return {
    ...base,
    mode: 'STRAIGHT',
    distance_meters: Math.round(distanceKm * 1000),
    duration_seconds: null,
    geometry: [[from.lat, from.lng], [to.lat, to.lng]],
    fallback: true,
  };
}

export async function computeLeg(fromSpot, toSpot, { preference = 'public_transit' } = {}) {
  const from = fromSpot.coordinates;
  const to = toSpot.coordinates;
  const base = { from_id: fromSpot.location_id || null, to_id: toSpot.location_id || null };
  const distanceKm = haversineKm(from, to);
  if (distanceKm < 0.05) {
    return { ...base, mode: 'WALK', distance_meters: Math.round(distanceKm * 1000), duration_seconds: 60, geometry: [[from.lat, from.lng], [to.lat, to.lng]] };
  }
  // Routes API 在部分地区（例如日本）不提供公共交通数据。此时驾车结果只作为
  // 距离 / 时长参考，并标记 transit_unavailable，前端提示到 Google 地图查看公交线路。
  let transitMissing = false;
  for (const mode of chooseTravelModes(distanceKm, preference)) {
    try {
      const route = await computeRoute(requestBody(from, to, mode), mode === 'TRANSIT' ? TRANSIT_FIELDS : BASE_FIELDS);
      if (!route?.polyline?.encodedPolyline) {
        if (mode === 'TRANSIT') transitMissing = true;
        continue;
      }
      const lines = mode === 'TRANSIT' ? transitLines(route) : [];
      return {
        ...base,
        // 公共交通方案里一段公交都没有时，本质是步行。
        mode: mode === 'TRANSIT' && lines.length === 0 ? 'WALK' : mode,
        distance_meters: route.distanceMeters ?? Math.round(distanceKm * 1000),
        duration_seconds: parseDuration(route.duration),
        geometry: decodePolyline(route.polyline.encodedPolyline),
        ...(lines.length ? { transit_lines: lines } : {}),
        ...(mode === 'DRIVE' && transitMissing && preference !== 'drive' ? { transit_unavailable: true } : {}),
      };
    } catch (error) {
      if (isAbortError(error) || currentSignal()?.aborted) throw error;
      if (mode === 'TRANSIT') transitMissing = true;
      log.warn('route.leg_failed', { mode, message: error.message });
    }
  }
  return straightLeg(base, from, to, distanceKm);
}

function joinGeometry(legs) {
  const geometry = [];
  for (const leg of legs) {
    for (const point of leg.geometry || []) {
      const last = geometry[geometry.length - 1];
      if (!last || last[0] !== point[0] || last[1] !== point[1]) geometry.push(point);
    }
  }
  return geometry;
}

function sumOrNull(values) {
  const known = values.filter(value => Number.isFinite(value));
  return known.length ? known.reduce((sum, value) => sum + value, 0) : null;
}

/** 为每天计算逐段路线。optimizations 来自 optimizePlanOrder。 */
export async function computeRoutes(plan, { preference = 'public_transit', optimizations = new Map() } = {}) {
  const days = plan.daily_plans || [];
  const legJobs = days.flatMap((day) => {
    const located = (day.spots || []).filter(spot => spot.coordinates);
    return located.slice(1).map((spot, index) => ({ day: day.day, from: located[index], to: spot }));
  });
  const legs = await mapWithConcurrency(legJobs, 6, job => computeLeg(job.from, job.to, { preference }));
  const legsByDay = new Map();
  legJobs.forEach((job, index) => {
    if (!legsByDay.has(job.day)) legsByDay.set(job.day, []);
    legsByDay.get(job.day).push(legs[index]);
  });

  return days.map((day) => {
    const dayLegs = legsByDay.get(day.day) || [];
    const points = (day.spots || []).filter(spot => spot.coordinates).map(spot => [spot.coordinates.lat, spot.coordinates.lng]);
    const modes = new Set(dayLegs.map(leg => leg.mode));
    const optimization = optimizations.get(day.day);
    return {
      day: day.day,
      provider: 'google',
      travel_mode: modes.size === 0 ? null : modes.size === 1 ? [...modes][0] : 'MIXED',
      points,
      geometry: dayLegs.length ? joinGeometry(dayLegs) : points,
      distance_meters: sumOrNull(dayLegs.map(leg => leg.distance_meters)),
      duration_seconds: sumOrNull(dayLegs.map(leg => leg.duration_seconds)),
      legs: dayLegs,
      partial: dayLegs.some(leg => leg.fallback),
      optimized: Boolean(optimization?.optimized),
      saved_meters: optimization?.optimized ? Math.round(optimization.savedKm * 1000) : 0,
    };
  });
}
