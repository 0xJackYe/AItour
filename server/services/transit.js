// 推荐住宿附近的公共交通站点。多城市行程会为每个城市的住宿分别查询，
// 而不是只查第一个城市。

import { mapWithConcurrency } from '../lib/async.js';
import { currentSignal } from '../lib/context.js';
import { isAbortError } from '../lib/errors.js';
import { haversineKm } from '../lib/geo.js';
import { log } from '../lib/log.js';
import { placeToCoordinates, searchNearbyTransit } from './google.js';

const SEARCH_RADIUS_M = 1500;
const PER_CENTER = 3;
const DUPLICATE_DISTANCE_KM = 0.12;

function searchCenters(plan) {
  const centers = [];
  for (const [index, item] of (plan.accommodations || []).entries()) {
    if (!item.coordinates) continue;
    if (centers.some(center => haversineKm(center.coordinates, item.coordinates) < 1)) continue;
    centers.push({ coordinates: item.coordinates, city: item.city || '', accommodation_index: index });
  }
  if (centers.length === 0) {
    const firstSpot = (plan.daily_plans || []).flatMap(day => day.spots || []).find(spot => spot.coordinates);
    if (firstSpot) centers.push({ coordinates: firstSpot.coordinates, city: firstSpot.city || '', accommodation_index: null });
  }
  return centers.slice(0, 8);
}

export async function findNearbyTransit(plan) {
  const centers = searchCenters(plan);
  const groups = await mapWithConcurrency(centers, 4, async (center) => {
    try {
      const places = await searchNearbyTransit(center.coordinates, SEARCH_RADIUS_M, PER_CENTER);
      return places
        .map(place => ({
          name: place.displayName?.text || place.formattedAddress || '公共交通站',
          type: 'transport',
          city: center.city,
          accommodation_index: center.accommodation_index,
          place_id: place.id || null,
          google_maps_uri: place.googleMapsUri || null,
          coordinates: placeToCoordinates(place),
        }))
        .filter(item => item.coordinates);
    } catch (error) {
      if (isAbortError(error) || currentSignal()?.aborted) throw error;
      log.warn('transit.search_failed', { city: center.city, message: error.message });
      return [];
    }
  });

  const markers = [];
  for (const item of groups.flat()) {
    const duplicate = markers.some(other =>
      (item.place_id && other.place_id === item.place_id)
      || haversineKm(other.coordinates, item.coordinates) < DUPLICATE_DISTANCE_KM);
    if (!duplicate) markers.push(item);
  }
  return markers;
}
