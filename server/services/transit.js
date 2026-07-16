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
  const center = accommodationCoordinates || firstSpotCoordinates(plan);
  if (!center) return [];

  try {
    const places = await searchNearbyTransit(center, 2500);
    const candidates = places
      .map(place => ({
        name: place.displayName?.text || place.formattedAddress || '公共交通站',
        type: 'transport',
        place_id: place.id || null,
        google_maps_uri: place.googleMapsUri || null,
        coordinates: placeToCoordinates(place),
      }))
      .filter(item => item.coordinates);
    return candidates.filter((item, index, all) =>
      all.findIndex(other => distanceMeters(item.coordinates, other.coordinates) < 120) === index,
    );
  } catch (error) {
    console.warn(`[Transit] Google Nearby Search 失败: ${error.message}`);
    return [];
  }
}
