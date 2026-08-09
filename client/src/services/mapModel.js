import {
  modeLabel,
  stableId,
  validCoordinates,
  validGeometryPoint,
} from './planModel.js';

export const SEGMENT_COLORS = Object.freeze({
  WALK: '#16a34a',
  BUS: '#f59e0b',
  COACH: '#d97706',
  SUBWAY: '#2563eb',
  TRAIN: '#7c3aed',
  LIGHT_RAIL: '#0891b2',
  RAIL: '#dc2626',
  HIGH_SPEED_RAIL: '#dc2626',
  TRANSIT: '#2563eb',
  DRIVE: '#64748b',
  TAXI: '#d97706',
  BICYCLE: '#0d9488',
  FLIGHT: '#475569',
  FERRY: '#0e7490',
  UNKNOWN: '#94a3b8',
});

const MODE_ALIASES = Object.freeze({
  HIGH_SPEED_TRAIN: 'HIGH_SPEED_RAIL',
  LONG_DISTANCE_TRAIN: 'TRAIN',
  HEAVY_RAIL: 'TRAIN',
  COMMUTER_TRAIN: 'TRAIN',
  INTERCITY_BUS: 'COACH',
  TRAM: 'LIGHT_RAIL',
  METRO_RAIL: 'SUBWAY',
  OTHER: 'TRANSIT',
});

function normalizedGeometry(value) {
  if (!Array.isArray(value)) return [];
  return value.filter(validGeometryPoint)
    .map(([lat, lng]) => [Number(lat), Number(lng)]);
}

export function segmentMode(segment = {}) {
  const raw = String(
    segment.transit_vehicle_type
      || segment.primary_vehicle
      || segment.mode
      || segment.travel_mode
      || 'UNKNOWN',
  ).toUpperCase();
  return MODE_ALIASES[raw] || raw;
}

export function segmentColor(segment = {}) {
  const providerColor = segment.line?.color;
  if (/^#[0-9a-f]{6}$/i.test(String(providerColor || ''))) return providerColor;
  return SEGMENT_COLORS[segmentMode(segment)] || SEGMENT_COLORS.UNKNOWN;
}

export function segmentTitle(segment = {}) {
  const lineName = segment.line?.name || segment.line?.name_short;
  const vehicle = modeLabel(segmentMode(segment));
  if (lineName && !String(lineName).includes(vehicle)) return `${vehicle} · ${lineName}`;
  return lineName || vehicle;
}

export function routeSegments(route = {}) {
  const sourceSegments = Array.isArray(route.segments) ? route.segments : [];
  const detailed = sourceSegments.map((segment, index) => ({
    ...segment,
    id: segment.id || stableId('segment', route.id || route.leg_id, index),
    sequence: segment.sequence !== null && segment.sequence !== undefined && segment.sequence !== ''
      && Number.isFinite(Number(segment.sequence)) ? Number(segment.sequence) : index,
    routeId: route.id || route.leg_id,
    day: route.day,
    connection_to_day: route.connection_to_day,
    geometry: normalizedGeometry(segment.geometry),
    displayMode: segmentMode(segment),
    color: segmentColor(segment),
    title: segmentTitle(segment),
  })).filter(segment => segment.geometry.length >= 2)
    .sort((left, right) => left.sequence - right.sequence);
  if (detailed.length) return detailed;

  const geometry = normalizedGeometry(route.geometry);
  if (geometry.length < 2) return [];
  const fallback = {
    ...route,
    id: `${route.id || route.leg_id || 'route'}-aggregate`,
    routeId: route.id || route.leg_id,
    sequence: 0,
    geometry,
    transit_vehicle_type: route.primary_vehicle || route.mode || route.travel_mode,
  };
  return [{
    ...fallback,
    displayMode: segmentMode(fallback),
    color: segmentColor(fallback),
    title: route.summary || segmentTitle(fallback),
  }];
}

export function collectOverviewNodes(plan) {
  return (plan?.daily_plans || []).flatMap(day => {
    const nodes = Array.isArray(day.nodes) && day.nodes.length ? day.nodes : (day.spots || []);
    return nodes
      .filter(node => !node.role && !['start', 'end'].includes(String(node.type || '').toLowerCase()))
      .map((node, index) => ({ ...node, overviewDay: Number(day.day), overviewIndex: index }));
  });
}

export function collectMappableOverviewNodes(plan) {
  return collectOverviewNodes(plan).filter(node => validCoordinates(node.coordinates));
}

export function visibleRoutesForSelection(plan, routes = [], selectedDay = null) {
  const planRoutes = (plan?.daily_plans || []).flatMap((day, index, days) => [
    ...(day.legs || []).map(leg => ({ ...leg, day: day.day })),
    ...(day.connection_to_next?.type === 'intercity' ? [{
      ...day.connection_to_next,
      day: day.day,
      connection_to_day: days[index + 1]?.day,
    }] : []),
  ]);
  const candidates = selectedDay === null
    ? [...routes, ...planRoutes]
    : [
        ...routes.filter(route => Number(route.day) === Number(selectedDay) && route.connection_to_day == null),
        ...((plan?.daily_plans || []).find(day => Number(day.day) === Number(selectedDay))?.legs || [])
          .map(leg => ({ ...leg, day: selectedDay })),
      ];
  const seen = new Set();
  return candidates.filter((route, index) => {
    const id = route.id || route.leg_id || `${route.day}-${route.connection_to_day || 'local'}-${index}`;
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}

function coordinatesFromStop(stop) {
  const coordinates = stop?.coordinates || stop?.location;
  return validCoordinates(coordinates)
    ? { lat: Number(coordinates.lat), lng: Number(coordinates.lng) }
    : null;
}

export function transferPoints(segments = []) {
  const points = [];
  for (let index = 1; index < segments.length; index++) {
    const previous = segments[index - 1];
    const current = segments[index];
    if (previous.routeId !== current.routeId) continue;
    if (String(previous.travel_mode || '').toUpperCase() !== 'TRANSIT'
      || String(current.travel_mode || '').toUpperCase() !== 'TRANSIT') continue;
    const previousLine = String(previous.line?.name || previous.line?.name_short || '').trim().toLocaleLowerCase();
    const currentLine = String(current.line?.name || current.line?.name_short || '').trim().toLocaleLowerCase();
    if (previousLine && currentLine && previousLine === currentLine) continue;
    const stop = current.from_stop || previous.to_stop;
    const coordinates = coordinatesFromStop(stop);
    if (!coordinates) continue;
    points.push({
      id: stableId('transfer', current.routeId, index, stop?.name),
      routeId: current.routeId,
      name: stop?.name || '换乘站',
      coordinates,
      from: previous.title || segmentTitle(previous),
      to: current.title || segmentTitle(current),
      day: current.day,
      connection_to_day: current.connection_to_day,
    });
  }
  return points;
}

export function legendForSegments(segments = []) {
  const seen = new Set();
  return segments.reduce((items, segment) => {
    const mode = segmentMode(segment);
    const color = segment.color || segmentColor(segment);
    const key = `${mode}|${color}`;
    if (seen.has(key)) return items;
    seen.add(key);
    items.push({ mode, color, label: modeLabel(mode) });
    return items;
  }, []);
}

export function markerIsSelected(marker, selectedNodeId, selectedLegId) {
  return marker?.selectionType === 'leg'
    ? marker.id === selectedLegId
    : marker?.id === selectedNodeId;
}
