import { geocodeAddress, searchPlacesText, placeToCoordinates } from './google.js';

const FALLBACK_MAX_DISTANCE_KM = 35;
const VIEWPORT_PADDING_RATIO = 0.03;
const ADMINISTRATIVE_GEOCODER_TYPES = new Set(['locality', 'postal_town']);

console.log('[Geocode] 模块加载: Google Places + Geocoding 严格城市消歧');

async function mapWithConcurrency(items, concurrency, worker) {
  const results = new Array(items.length);
  let nextIndex = 0;
  async function run() {
    while (nextIndex < items.length) {
      const index = nextIndex++;
      results[index] = await worker(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, run));
  return results;
}

function haversineKm(lat1, lng1, lat2, lng2) {
  const R = 6371;
  const toRad = value => (value * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

function normalizeViewport(geometry) {
  const viewport = geometry?.bounds || geometry?.viewport;
  if (!viewport?.southwest || !viewport?.northeast) return null;
  return {
    low: {
      latitude: viewport.southwest.lat,
      longitude: viewport.southwest.lng,
    },
    high: {
      latitude: viewport.northeast.lat,
      longitude: viewport.northeast.lng,
    },
  };
}

function isAdministrativeGeocoderResult(result) {
  return (result?.types || []).some(type =>
    ADMINISTRATIVE_GEOCODER_TYPES.has(type) || String(type).startsWith('administrative_area_level_'),
  );
}

function radiusSearchViewport(lat, lng, radiusKm = FALLBACK_MAX_DISTANCE_KM) {
  const latitudeDelta = radiusKm / 111.32;
  const longitudeScale = Math.max(0.05, Math.cos((lat * Math.PI) / 180));
  const longitudeDelta = radiusKm / (111.32 * longitudeScale);
  return {
    low: {
      latitude: Math.max(-90, lat - latitudeDelta),
      longitude: Math.max(-180, lng - longitudeDelta),
    },
    high: {
      latitude: Math.min(90, lat + latitudeDelta),
      longitude: Math.min(180, lng + longitudeDelta),
    },
  };
}

export function isInsideViewport(location, viewport) {
  if (!location || !viewport) return false;
  const latSpan = Math.abs(viewport.high.latitude - viewport.low.latitude);
  const lngSpan = Math.abs(viewport.high.longitude - viewport.low.longitude);
  const latPadding = Math.max(latSpan * VIEWPORT_PADDING_RATIO, 0.005);
  const lngPadding = Math.max(lngSpan * VIEWPORT_PADDING_RATIO, 0.005);
  const minLat = viewport.low.latitude - latPadding;
  const maxLat = viewport.high.latitude + latPadding;
  const minLng = viewport.low.longitude - lngPadding;
  const maxLng = viewport.high.longitude + lngPadding;
  const longitudeMatches = minLng <= maxLng
    ? location.longitude >= minLng && location.longitude <= maxLng
    : location.longitude >= minLng || location.longitude <= maxLng;
  return location.latitude >= minLat
    && location.latitude <= maxLat
    && longitudeMatches;
}

function geocoderCountryCode(result) {
  return result?.address_components
    ?.find(component => component.types?.includes('country'))
    ?.short_name?.toUpperCase() || null;
}

function normalizeAdministrativeName(value = '') {
  return String(value)
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/(?:city|prefecture|province|county|district)$/g, '')
    .replace(/(?:特别行政区|自治区|自治州|省|市|区|县|都|府|州)$/g, '')
    .replace(/[^\p{L}\p{N}]/gu, '');
}

function targetAdministrativeNames(city, result) {
  const firstAdministrative = result?.address_components?.find(component =>
    component.types?.some(type =>
      type === 'locality'
      || type === 'postal_town'
      || type.startsWith('administrative_area_level_'),
    ),
  );
  return [...new Set([
    city,
    firstAdministrative?.long_name,
    firstAdministrative?.short_name,
  ].map(normalizeAdministrativeName).filter(Boolean))];
}

function placeCountryCode(place) {
  return place?.addressComponents
    ?.find(component => component.types?.includes('country'))
    ?.shortText?.toUpperCase() || null;
}

function placeCountryNames(place) {
  const component = place?.addressComponents?.find(item => item.types?.includes('country'));
  return [component?.longText, component?.shortText]
    .map(normalizeAdministrativeName)
    .filter(Boolean);
}

export function cityContextFromGeocoderResult(city, country, result) {
  if (!result?.geometry?.location) return null;
  const lat = Number(result.geometry.location.lat);
  const lng = Number(result.geometry.location.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  const administrative = isAdministrativeGeocoderResult(result);
  return {
    lat,
    lng,
    display_name: result.formatted_address,
    viewport: administrative ? normalizeViewport(result.geometry) : null,
    searchViewport: administrative
      ? normalizeViewport(result.geometry)
      : radiusSearchViewport(lat, lng, FALLBACK_MAX_DISTANCE_KM),
    boundaryMode: administrative ? 'administrative' : 'region_radius',
    regionRadiusKm: administrative ? null : FALLBACK_MAX_DISTANCE_KM,
    geocoderTypes: Array.isArray(result.types) ? [...result.types] : [],
    place_id: result.place_id || null,
    cityName: city,
    countryName: country,
    countryCode: geocoderCountryCode(result),
    targetAdministrativeNames: administrative ? targetAdministrativeNames(city, result) : [],
  };
}

function viewportDiagonalKm(viewport) {
  if (!viewport) return Infinity;
  return haversineKm(
    viewport.low.latitude,
    viewport.low.longitude,
    viewport.high.latitude,
    viewport.high.longitude,
  );
}

const GENERIC_PLACE_WORDS = new Set([
  'the', 'of', 'and', 'in', 'at', 'old', 'new', 'saint', 'st',
  'museum', 'church', 'cathedral', 'basilica', 'palace', 'castle', 'fortress',
  'bridge', 'square', 'street', 'park', 'garden', 'station', 'center', 'centre',
  'mount', 'mountain', 'lake', 'river', 'island', 'tower', 'temple', 'shrine',
  'city', 'town', 'historic', 'historical',
]);

function nameTokens(value = '') {
  return String(value)
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .match(/[\p{L}\p{N}]+/gu) || [];
}

function compactPlaceName(value = '') {
  return nameTokens(value).join('');
}

function tokenMatches(left, right) {
  return left === right
    || (Math.min(left.length, right.length) >= 4 && (left.startsWith(right) || right.startsWith(left)));
}

export function placeNameMatches(place, expectedName, city = '', country = '') {
  const candidateName = place?.displayName?.text || '';
  if (!candidateName || !expectedName) return true;
  const expectedCompact = compactPlaceName(expectedName);
  const candidateCompact = compactPlaceName(candidateName);
  if (expectedCompact.length >= 4 && candidateCompact.length >= 4
    && (expectedCompact.includes(candidateCompact) || candidateCompact.includes(expectedCompact))) {
    return true;
  }

  const locationWords = new Set([...nameTokens(city), ...nameTokens(country)]);
  const expectedTokens = nameTokens(expectedName)
    .filter(token => token.length >= 3 && !GENERIC_PLACE_WORDS.has(token) && !locationWords.has(token));
  const candidateTokens = nameTokens(candidateName)
    .filter(token => token.length >= 3 && !GENERIC_PLACE_WORDS.has(token));
  if (expectedTokens.length === 0 || candidateTokens.length === 0) return true;

  const matches = expectedTokens.filter(expected =>
    candidateTokens.some(candidate => tokenMatches(expected, candidate)),
  );
  if (matches.length / expectedTokens.length >= 0.5) return true;
  return expectedTokens.length <= 3 && matches.some(token => token.length >= 5);
}

function strictRegionAnchorNameMatches(place, expectedName, country = '') {
  const candidateName = place?.displayName?.text || '';
  if (!candidateName || !expectedName) return false;
  const expectedCompact = compactPlaceName(expectedName);
  const candidateCompact = compactPlaceName(candidateName);
  if (Math.min(expectedCompact.length, candidateCompact.length) >= 3
    && (expectedCompact.includes(candidateCompact) || candidateCompact.includes(expectedCompact))) {
    return true;
  }
  const countryWords = new Set(nameTokens(country));
  const expectedTokens = nameTokens(expectedName)
    .filter(token => token.length >= 2 && !GENERIC_PLACE_WORDS.has(token) && !countryWords.has(token));
  const candidateTokens = nameTokens(candidateName)
    .filter(token => token.length >= 2 && !GENERIC_PLACE_WORDS.has(token));
  if (!expectedTokens.length || !candidateTokens.length) return false;
  const matches = expectedTokens.filter(expected =>
    candidateTokens.some(candidate => tokenMatches(expected, candidate)),
  );
  return matches.length / expectedTokens.length >= 0.5;
}

function regionAnchorCountryMatches(place, country, preliminaryContext) {
  const candidateCode = placeCountryCode(place);
  const candidateNames = placeCountryNames(place);
  const requestedCountry = normalizeAdministrativeName(country);
  if (requestedCountry && candidateNames.includes(requestedCountry)) return true;
  return Boolean(preliminaryContext?.countryCode && candidateCode === preliminaryContext.countryCode);
}

function regionContextFromPlace(city, country, place, preliminaryContext) {
  const lat = Number(place?.location?.latitude);
  const lng = Number(place?.location?.longitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  return {
    lat,
    lng,
    display_name: place.formattedAddress || place.displayName?.text || city,
    viewport: null,
    searchViewport: radiusSearchViewport(lat, lng, FALLBACK_MAX_DISTANCE_KM),
    anchorViewport: place.viewport || null,
    boundaryMode: 'region_radius',
    regionRadiusKm: FALLBACK_MAX_DISTANCE_KM,
    geocoderTypes: Array.isArray(place.types) ? [...place.types] : [],
    place_id: place.id || null,
    cityName: city,
    countryName: country,
    countryCode: placeCountryCode(place) || preliminaryContext?.countryCode || null,
    targetAdministrativeNames: [],
    anchorSource: 'places_text',
  };
}

export async function geocodeCity(city, country = '') {
  if (!city) return null;
  try {
    // Places 的地址组件经常使用英文或当地罗马字；城市锚点也用英文返回，
    // 才能稳定比较 Tokyo/Shizuoka、Roma/Firenze 等行政区名称。
    const results = await geocodeAddress([city, country].filter(Boolean).join(', '), 'en');
    const result = results[0];
    if (!result?.geometry?.location) return null;
    const preliminaryContext = cityContextFromGeocoderResult(city, country, result);
    if (!preliminaryContext || preliminaryContext.boundaryMode === 'administrative') {
      return preliminaryContext;
    }

    // A non-administrative geocoder hit may be a same-name sublocality far from
    // the requested natural region. Re-anchor only from a strict Places match;
    // never use the potentially wrong geocoder point as a fallback.
    const query = [city, country].filter(Boolean).join(', ');
    const languageCode = /[\u3400-\u9fff]/u.test(city) ? 'zh-CN' : 'en';
    const candidates = await searchPlacesText(query, {
      pageSize: 5,
      regionCode: preliminaryContext.countryCode,
      languageCode,
    });
    const safeAnchors = candidates.filter(place =>
      place?.location
      && strictRegionAnchorNameMatches(place, city, country)
      && regionAnchorCountryMatches(place, country, preliminaryContext),
    );
    const expectedCompact = compactPlaceName(city);
    const anchor = safeAnchors.find(place => compactPlaceName(place.displayName?.text) === expectedCompact)
      || safeAnchors[0];
    return anchor ? regionContextFromPlace(city, country, anchor, preliminaryContext) : null;
  } catch (error) {
    console.warn(`[Geocode] 城市定位失败 (${city}, ${country}): ${error.message}`);
    return null;
  }
}

export function isInTargetCity(place, cityContext) {
  // 有城市硬约束时，无法建立城市锚点必须 fail-closed。
  // 否则 Places 的全球同名候选会被错当成目标城市地点。
  if (!cityContext || !place?.location) return false;
  const candidateCountry = placeCountryCode(place);
  if (cityContext.boundaryMode === 'region_radius') {
    if (cityContext.countryCode) {
      if (!candidateCountry || candidateCountry !== cityContext.countryCode) return false;
    } else {
      const contextCountryNames = [cityContext.countryName]
        .map(normalizeAdministrativeName)
        .filter(Boolean);
      const candidateCountryNames = placeCountryNames(place);
      if (!candidateCountryNames.length
        || !contextCountryNames.some(expected => candidateCountryNames.includes(expected))) {
        return false;
      }
    }
    return haversineKm(
      place.location.latitude,
      place.location.longitude,
      cityContext.lat,
      cityContext.lng,
    ) <= (Number(cityContext.regionRadiusKm) || FALLBACK_MAX_DISTANCE_KM);
  }
  if (cityContext.countryCode && candidateCountry && candidateCountry !== cityContext.countryCode) {
    return false;
  }
  const candidateAdministrativeNames = (place.addressComponents || [])
    .filter(component => component.types?.some(type =>
      type === 'locality'
      || type === 'postal_town'
      || type === 'sublocality'
      || type.startsWith('sublocality_level_')
      || type.startsWith('administrative_area_level_'),
    ))
    .flatMap(component => [component.longText, component.shortText])
    .map(normalizeAdministrativeName)
    .filter(Boolean);
  const targetNames = cityContext.targetAdministrativeNames || [];
  let administrativeMatch = null;
  if (targetNames.length > 0 && candidateAdministrativeNames.length > 0) {
    administrativeMatch = targetNames.some(target =>
      candidateAdministrativeNames.some(candidate =>
        candidate === target
        || (Math.min(candidate.length, target.length) >= 4
          && (candidate.includes(target) || target.includes(candidate))),
      ),
    );
  }
  if (cityContext.viewport) {
    if (!isInsideViewport(place.location, cityContext.viewport)) return false;
    // 普通城市的小视口本身足够严格；东京等包含远海属地的超大矩形必须再通过
    // 行政区名称校验，防止视口覆盖到其他城市。
    if (administrativeMatch === false && viewportDiagonalKm(cityContext.viewport) > 120) return false;
    return true;
  }
  if (administrativeMatch === false) return false;
  return haversineKm(
    place.location.latitude,
    place.location.longitude,
    cityContext.lat,
    cityContext.lng,
  ) <= FALLBACK_MAX_DISTANCE_KM;
}

async function searchRestricted(fullQuery, cityContext, languageCode) {
  const searchViewport = cityContext?.searchViewport || cityContext?.viewport;
  if (!searchViewport) {
    return searchPlacesText(fullQuery, { pageSize: 5, languageCode });
  }
  try {
    return await searchPlacesText(fullQuery, {
      locationRestriction: searchViewport,
      pageSize: 5,
      regionCode: cityContext.countryCode,
      languageCode,
    });
  } catch (error) {
    console.warn(`[Geocode] Places 区域限制搜索失败，改用偏好搜索: ${error.message}`);
    return searchPlacesText(fullQuery, {
      locationBias: searchViewport,
      pageSize: 5,
      regionCode: cityContext.countryCode,
      languageCode,
    });
  }
}

async function findPlace(query, city, country, cityContext) {
  const fullQuery = [query, city, country].filter(Boolean).join(', ');
  const languageCode = /[\u3400-\u9fff]/u.test(query) ? 'zh-CN' : 'en';
  const restrictedPlaces = await searchRestricted(fullQuery, cityContext, languageCode);
  const belongsToTarget = place => city ? isInTargetCity(place, cityContext) : Boolean(place?.location);
  const restrictedMatch = restrictedPlaces.find(place =>
    belongsToTarget(place) && placeNameMatches(place, query, city, country),
  );
  if (restrictedMatch) {
    return { coordinates: placeToCoordinates(restrictedMatch), place: restrictedMatch, status: 'verified' };
  }

  // 区域限制无结果时再做一次软搜索，仅用于判断 Google 是否命中了外地同名地点。
  // 软搜索的结果仍必须经过硬边界校验，绝不会直接作为坐标返回。
  let diagnosticPlaces = restrictedPlaces;
  const searchViewport = cityContext?.searchViewport || cityContext?.viewport;
  if (searchViewport && restrictedPlaces.length === 0) {
    diagnosticPlaces = await searchPlacesText(fullQuery, {
      locationBias: searchViewport,
      pageSize: 5,
      regionCode: cityContext.countryCode,
      languageCode,
    });
    const diagnosticMatch = diagnosticPlaces.find(place =>
      belongsToTarget(place) && placeNameMatches(place, query, city, country),
    );
    if (diagnosticMatch) {
      return { coordinates: placeToCoordinates(diagnosticMatch), place: diagnosticMatch, status: 'verified' };
    }
  }

  if (diagnosticPlaces.length === 0) {
    return {
      coordinates: null,
      status: 'not_found',
      reason: `Google Places 未在 ${city || '目标区域'} 找到该地点`,
    };
  }

  const sameCityWrongName = diagnosticPlaces.find(place => belongsToTarget(place));
  if (sameCityWrongName) {
    return {
      coordinates: null,
      place: sameCityWrongName,
      status: 'name_mismatch',
      reason: `Google Places 候选“${sameCityWrongName.displayName?.text || '未知地点'}”与计划地点名称不一致，已从计划中剔除`,
    };
  }

  const top = diagnosticPlaces[0];
  const distance = top.location && cityContext
    ? Math.round(haversineKm(top.location.latitude, top.location.longitude, cityContext.lat, cityContext.lng))
    : null;
  return {
    coordinates: null,
    place: top,
    status: 'outside_target',
    reason: distance === null
      ? `Google Places 候选不属于 ${city}`
      : `Google Places 候选距 ${city} 中心约 ${distance}km，属于其他城市，已从计划中剔除`,
  };
}

export async function geocode(query, city = '', country = '') {
  const cityContext = city ? await geocodeCity(city, country) : null;
  const result = await findPlace(query, city, country, cityContext);
  return result.coordinates;
}

async function locateSpot(spot, city, country, cityContext) {
  const primary = spot.name_en || spot.name;
  let result = await findPlace(primary, city, country, cityContext);
  if (!result.coordinates && spot.name_en && spot.name_en !== spot.name) {
    const fallback = await findPlace(spot.name, city, country, cityContext);
    if (fallback.coordinates || (result.status === 'not_found' && fallback.status !== 'not_found')) {
      result = fallback;
    }
  }
  return result;
}

export function spotLocationKey(dayIndex, spotIndex) {
  return `day:${dayIndex}:spot:${spotIndex}`;
}

function accommodationLocationKey(index) {
  return `accommodation:${index}`;
}

function dayLocation(day, plan) {
  return {
    city: day.city || (plan.city === '多城市' ? '' : plan.city) || '',
    country: day.country || (String(plan.country || '').includes('、') ? '' : plan.country) || '',
  };
}

export async function geocodeAllSpots(plan) {
  const warnings = [];
  const rejectedSpots = [];
  const sourceAccommodations = Array.isArray(plan.accommodations) && plan.accommodations.length
    ? plan.accommodations
    : plan.accommodation
      ? [{
          city: plan.city === '多城市' ? '' : plan.city,
          country: String(plan.country || '').includes('、') ? '' : plan.country,
          ...plan.accommodation,
        }]
      : [];

  const locationPairs = new Map();
  for (const day of plan.daily_plans || []) {
    const { city, country } = dayLocation(day, plan);
    if (city) locationPairs.set(`${city}\u0000${country}`, { city, country });
    for (const spot of day.spots || []) {
      const spotCity = spot.city || city;
      const spotCountry = spot.country || country;
      if (spotCity) locationPairs.set(`${spotCity}\u0000${spotCountry}`, { city: spotCity, country: spotCountry });
    }
  }
  for (const accommodation of sourceAccommodations) {
    if (accommodation.city) {
      locationPairs.set(`${accommodation.city}\u0000${accommodation.country || ''}`, {
        city: accommodation.city,
        country: accommodation.country || '',
      });
    }
  }

  const contexts = new Map();
  await Promise.all([...locationPairs.entries()].map(async ([key, value]) => {
    const context = await geocodeCity(value.city, value.country);
    contexts.set(key, context);
    if (context) {
      console.log(`[Geocode] Google 城市锚定: ${value.city}, ${value.country} → ${context.display_name}`);
    } else {
      warnings.push({
        name: `${value.city}${value.country ? `, ${value.country}` : ''}`,
        reason: '未能建立城市范围，该城市的地点不会接受未经验证的外地坐标',
        code: 'city_context_missing',
      });
    }
  }));

  const spotJobs = (plan.daily_plans || []).flatMap((day, dayIndex) => {
    const dayTarget = dayLocation(day, plan);
    return (day.spots || []).map((spot, spotIndex) => {
      const city = spot.city || dayTarget.city;
      const country = spot.country || dayTarget.country;
      const cityContext = contexts.get(`${city}\u0000${country}`) || null;
      return {
        key: spotLocationKey(dayIndex, spotIndex),
        day,
        dayIndex,
        spot,
        spotIndex,
        city,
        country,
        cityContext,
      };
    });
  });

  const accommodationJobs = sourceAccommodations.map((accommodation, index) => {
    const city = accommodation.city || '';
    const country = accommodation.country || '';
    const context = contexts.get(`${city}\u0000${country}`) || null;
    return {
      key: accommodationLocationKey(index),
      index,
      accommodation,
      city,
      country,
      context,
    };
  });

  const [spotResults, accommodationResults] = await Promise.all([
    mapWithConcurrency(spotJobs, 8, job => locateSpot(
      job.spot,
      job.city,
      job.country,
      job.cityContext,
    )),
    mapWithConcurrency(accommodationJobs, 4, job => job.accommodation.landmark
      ? findPlace(job.accommodation.landmark, job.city, job.country, job.context)
      : Promise.resolve({ coordinates: null, status: 'not_found', reason: '没有住宿地标' })),
  ]);
  const spotResultByKey = new Map();
  let geocodedCount = 0;

  spotJobs.forEach((job, index) => {
    const result = spotResults[index];
    spotResultByKey.set(job.key, result);
    if (result?.coordinates) {
      geocodedCount++;
      console.log(`[Geocode] Google ✓ Day ${job.day.day} ${job.city} · ${job.spot.name} → ${result.coordinates.display_name}`);
      return;
    }
    const removed = result?.status === 'outside_target' || result?.status === 'name_mismatch';
    const warning = {
      name: `Day ${job.day.day} · ${job.spot.name}`,
      city: job.city,
      country: job.country,
      reason: result?.reason || 'Google Places 未找到坐标',
      code: result?.status || 'not_found',
      removed,
    };
    warnings.push(warning);
    if (removed) rejectedSpots.push({ ...warning, spot: job.spot, day: job.day.day });
  });

  const enrichedAccommodations = sourceAccommodations.map((accommodation, index) => {
    const result = accommodationResults[index];
    if (result?.coordinates) {
      geocodedCount++;
      const placeId = result.place?.id || result.coordinates?.place_id || null;
      return { ...accommodation, place_id: placeId, placeId, coordinates: result.coordinates };
    }
    if (accommodation.landmark) {
      warnings.push({
        name: `住宿 · ${accommodation.city || ''} ${accommodation.landmark}`.trim(),
        city: accommodation.city || '',
        country: accommodation.country || '',
        reason: result?.reason || 'Google Places 未找到住宿地标',
        code: result?.status || 'not_found',
        removed: false,
      });
    }
    return { ...accommodation, coordinates: null };
  });

  const enrichedDailyPlans = (plan.daily_plans || []).map((day, dayIndex) => ({
    ...day,
    spots: (day.spots || []).map((spot, spotIndex) => {
      const result = spotResultByKey.get(spotLocationKey(dayIndex, spotIndex));
      const rejected = result?.status === 'outside_target' || result?.status === 'name_mismatch';
      const placeId = rejected
        ? null
        : result?.place?.id || result?.coordinates?.place_id || spot.place_id || spot.placeId || null;
      return {
        ...spot,
        place_id: placeId,
        placeId,
        location_id: spotLocationKey(dayIndex, spotIndex),
        coordinates: rejected ? null : result?.coordinates || null,
        location_status: rejected ? 'rejected' : result?.coordinates ? 'verified' : 'unverified',
        location_issue: rejected ? result?.reason || '地点未通过城市与名称校验' : null,
      };
    }),
  }));

  return {
    plan: {
      ...plan,
      accommodations: enrichedAccommodations,
      accommodation: enrichedAccommodations[0] || plan.accommodation || null,
      daily_plans: enrichedDailyPlans,
    },
    warnings,
    rejectedSpots,
    geocodedCount,
  };
}
