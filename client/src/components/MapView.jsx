import { useEffect, useRef, useState } from 'react';
import { loadGoogleMaps } from '../services/googleMaps.js';

const DAY_COLORS = ['#ea4335', '#4285f4', '#34a853', '#f9ab00', '#a142f4', '#00acc1', '#fa7b17'];
const DEFAULT_CENTER = { lat: 35.6762, lng: 139.6503 };

function markerElement(PinElement, label, color, scale = 1) {
  return new PinElement({
    background: color,
    borderColor: '#ffffff',
    glyphColor: '#ffffff',
    glyphText: label,
    scale,
  });
}

// 老历史记录可能保存了 HIGH_QUALITY 路线。即使服务端已改为 OVERVIEW，
// 前端仍要给旧数据设置复杂度上限，避免缩放时重绘上千个折线顶点。
function limitGeometry(points, maxPoints = 320) {
  if (!Array.isArray(points) || points.length <= maxPoints) return points || [];
  const limited = [];
  for (let index = 0; index < maxPoints; index++) {
    const sourceIndex = Math.round((index * (points.length - 1)) / (maxPoints - 1));
    limited.push(points[sourceIndex]);
  }
  return limited;
}

function infoContent(title, rows = [], googleMapsUri = null) {
  const root = document.createElement('div');
  root.className = 'google-info-window';
  const heading = document.createElement('strong');
  heading.textContent = title;
  root.append(heading);

  rows.filter(Boolean).forEach(row => {
    const line = document.createElement('div');
    line.textContent = row;
    root.append(line);
  });

  if (googleMapsUri) {
    const link = document.createElement('a');
    link.href = googleMapsUri;
    link.target = '_blank';
    link.rel = 'noreferrer';
    link.textContent = '在 Google 地图中查看';
    root.append(link);
  }
  return root;
}

function clearListeners(listeners, maps) {
  listeners.forEach(listener => {
    if (typeof listener === 'function') listener();
    else if (listener) maps.event.removeListener(listener);
  });
}

function supportsAcceleratedWebGL() {
  try {
    const canvas = document.createElement('canvas');
    const options = { failIfMajorPerformanceCaveat: true };
    return Boolean(
      canvas.getContext('webgl2', options)
      || canvas.getContext('webgl', options)
      || canvas.getContext('experimental-webgl', options),
    );
  } catch {
    return false;
  }
}

export default function MapView({ plan, routes, selectedDay, transitMarkers = [] }) {
  const containerRef = useRef(null);
  const mapRef = useRef(null);
  const apiRef = useRef(null);
  const overlaysRef = useRef({ markers: [], polylines: [], listeners: [], infoWindow: null });
  const [ready, setReady] = useState(false);
  const [error, setError] = useState(null);
  const [renderingMode, setRenderingMode] = useState('uninitialized');

  useEffect(() => {
    let cancelled = false;
    let renderingTypeListener = null;
    loadGoogleMaps()
      .then((api) => {
        if (cancelled || !containerRef.current) return;
        const useVectorMap = supportsAcceleratedWebGL();
        apiRef.current = api;
        mapRef.current = new api.maps.Map(containerRef.current, {
          center: DEFAULT_CENTER,
          zoom: 3,
          mapId: 'DEMO_MAP_ID',
          // div 方式默认可能回落到 RASTER；显式使用 WebGL 矢量地图和分数级缩放，
          // 才能获得接近 Google Maps 网页端的连续缩放动画。
          renderingType: useVectorMap
            ? api.maps.RenderingType.VECTOR
            : api.maps.RenderingType.RASTER,
          isFractionalZoomEnabled: true,
          tilt: 0,
          tiltInteractionEnabled: false,
          headingInteractionEnabled: false,
          backgroundColor: '#e8eaed',
          mapTypeControl: true,
          streetViewControl: true,
          fullscreenControl: true,
          zoomControl: true,
          scaleControl: true,
          gestureHandling: 'greedy',
          clickableIcons: true,
        });
        const syncRenderingType = () => {
          const type = mapRef.current?.getRenderingType?.();
          if (containerRef.current && type) {
            const normalizedType = String(type).toLowerCase();
            containerRef.current.dataset.renderingType = normalizedType;
            setRenderingMode(normalizedType);
          }
        };
        renderingTypeListener = mapRef.current.addListener('renderingtype_changed', syncRenderingType);
        syncRenderingType();
        setReady(true);
      })
      .catch(err => {
        if (!cancelled) setError(err.message || 'Google 地图加载失败');
      });
    return () => {
      cancelled = true;
      renderingTypeListener?.remove();
    };
  }, []);

  useEffect(() => {
    if (!ready || !mapRef.current || !apiRef.current) return undefined;
    const map = mapRef.current;
    const { maps, AdvancedMarkerElement, PinElement } = apiRef.current;
    const previous = overlaysRef.current;
    clearListeners(previous.listeners, maps);
    previous.markers.forEach(marker => { marker.map = null; });
    previous.polylines.forEach(polyline => polyline.setMap(null));
    previous.infoWindow?.close();

    const overlays = { markers: [], polylines: [], listeners: [], infoWindow: new maps.InfoWindow() };
    overlaysRef.current = overlays;

    if (!plan) {
      map.setCenter(DEFAULT_CENTER);
      map.setZoom(3);
      return undefined;
    }

    const bounds = new maps.LatLngBounds();
    let visiblePointCount = 0;
    const extend = coordinates => {
      if (!coordinates) return;
      bounds.extend({ lat: coordinates.lat, lng: coordinates.lng });
      visiblePointCount++;
    };
    const addMarker = ({ position, title, content, popup }) => {
      const marker = new AdvancedMarkerElement({
        map,
        position,
        title,
        content,
        gmpClickable: true,
      });
      const handleClick = () => {
        overlays.infoWindow.setContent(popup);
        overlays.infoWindow.open({ map, anchor: marker });
      };
      marker.addEventListener('gmp-click', handleClick);
      overlays.markers.push(marker);
      overlays.listeners.push(() => marker.removeEventListener('gmp-click', handleClick));
    };

    const accommodations = plan.accommodations?.length
      ? plan.accommodations
      : plan.accommodation
        ? [plan.accommodation]
        : [];
    accommodations.forEach((accommodation) => {
      if (!accommodation?.coordinates) return;
      const coordinates = accommodation.coordinates;
      extend(coordinates);
      addMarker({
        position: coordinates,
        title: `推荐住宿：${accommodation.city ? `${accommodation.city} · ` : ''}${accommodation.area || ''}`,
        content: markerElement(PinElement, 'H', '#7e57c2', 1.12),
        popup: infoContent(
          `推荐住宿 · ${accommodation.city ? `${accommodation.city} · ` : ''}${accommodation.area || ''}`,
          [accommodation.reason, coordinates.display_name],
          coordinates.google_maps_uri,
        ),
      });
    });

    transitMarkers.forEach(item => {
      if (!item.coordinates) return;
      extend(item.coordinates);
      addMarker({
        position: item.coordinates,
        title: item.name,
        content: markerElement(PinElement, 'M', '#1a73e8', 1.05),
        popup: infoContent(
          `公共交通 · ${item.name}`,
          [item.coordinates.display_name],
          item.google_maps_uri || item.coordinates.google_maps_uri,
        ),
      });
    });

    (plan.daily_plans || []).forEach(day => {
      const show = selectedDay === null || selectedDay === day.day;
      if (!show) return;
      const color = DAY_COLORS[(day.day - 1) % DAY_COLORS.length];
      let order = 0;
      (day.spots || []).forEach(spot => {
        if (!spot.coordinates) return;
        order++;
        extend(spot.coordinates);
        addMarker({
          position: spot.coordinates,
          title: `Day ${day.day} · ${spot.name}`,
          content: markerElement(PinElement, String(order), color),
          popup: infoContent(
            `Day ${day.day} · #${order} ${spot.name}`,
            [
              spot.description,
              spot.duration_hours ? `建议停留 ${spot.duration_hours} 小时` : null,
              spot.tips ? `提示：${spot.tips}` : null,
              spot.coordinates.display_name,
            ],
            spot.coordinates.google_maps_uri,
          ),
        });
      });
    });

    (routes || [])
      .filter(route => selectedDay === null || selectedDay === route.day)
      .filter(route => (route.geometry || []).length >= 2)
      .forEach(route => {
        const polyline = new maps.Polyline({
          map,
          path: limitGeometry(route.geometry).map(([lat, lng]) => ({ lat, lng })),
          strokeColor: DAY_COLORS[(route.day - 1) % DAY_COLORS.length],
          strokeOpacity: 0.9,
          strokeWeight: 4,
          geodesic: false,
          clickable: false,
        });
        overlays.polylines.push(polyline);
      });

    if (visiblePointCount > 1) {
      map.fitBounds(bounds, { top: 64, right: 64, bottom: 64, left: 64 });
    } else if (visiblePointCount === 1) {
      map.setCenter(bounds.getCenter());
      map.setZoom(14);
    }

    return () => {
      clearListeners(overlays.listeners, maps);
      overlays.markers.forEach(marker => { marker.map = null; });
      overlays.polylines.forEach(polyline => polyline.setMap(null));
      overlays.infoWindow.close();
    };
  }, [ready, plan, routes, selectedDay, transitMarkers]);

  return (
    <div className="google-map-root">
      <div ref={containerRef} className="google-map-canvas" />
      {!ready && !error && <div className="map-loading">正在加载 Google 地图…</div>}
      {error && <div className="map-error">Google 地图加载失败：{error}</div>}
      <div className="google-provider-badge">
        Google Maps · {renderingMode === 'vector' ? '矢量加速' : renderingMode === 'raster' ? '兼容模式' : '加载中'}
      </div>
    </div>
  );
}
