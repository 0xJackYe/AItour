import { searchNearbyTransit, placeToCoordinates } from './google.js';

function distanceMeters(a, b) {
  const R = 6371000;
  const toRad = value => (value * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const x = Math.sin(dLat / 2) ** 2
    + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(x));
}

function firstSpotCoordinates(plan) {
  for (const day of plan.daily_plans || []) {
    const match = (day.spots || []).find(spot => spot.coordinates);
    if (match) return match.coordinates;
  }
  return null;
}

export async function findNearbyTransit(plan, accommodationCoordinates) {
  const accommodationCenters = (plan.accommodations || [])
    .filter(item => item?.coordinates)
    .map(item => ({ coordinates: item.coordinates, city: item.city || null, country: item.country || null }));
  const centers = accommodationCenters.length
    ? accommodationCenters
    : [{ coordinates: accommodationCoordinates || firstSpotCoordinates(plan), city: plan.city || null, country: plan.country || null }]
        .filter(item => item.coordinates);
  if (!centers.length) return [];

  const groups = await Promise.all(centers.map(async center => {
    try {
      const places = await searchNearbyTransit(center.coordinates, 2500);
      return places.map(place => ({
        name: place.displayName?.text || place.formattedAddress || '公共交通站',
        type: 'transport',
        city: center.city,
        country: center.country,
        place_id: place.id || null,
        google_maps_uri: place.googleMapsUri || null,
        coordinates: placeToCoordinates(place),
      })).filter(item => item.coordinates);
    } catch (error) {
      console.warn(`[Transit] ${center.city || '目的地'}附近交通点查询失败: ${error.message}`);
      return [];
    }
  }));
  const candidates = groups.flat();
  return candidates.filter((item, index, all) =>
    all.findIndex(other => (item.place_id && other.place_id === item.place_id)
      || distanceMeters(item.coordinates, other.coordinates) < 120) === index,
  );
}
