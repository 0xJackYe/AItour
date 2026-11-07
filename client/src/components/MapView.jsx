import { useEffect, useRef, useState } from 'react';
import { accommodationsOf, dayColor, spotKey } from '../lib/plan.js';
import { loadGoogleMaps } from '../services/googleMaps.js';
import Icon from './Icon.jsx';

const DEFAULT_CENTER = { lat: 30, lng: 120 };
const DEFAULT_ZOOM = 3;

// 旧历史记录可能保存了 HIGH_QUALITY 折线，前端限制顶点数，避免缩放卡顿。
function limitGeometry(points, maxPoints = 320) {
  if (!Array.isArray(points) || points.length <= maxPoints) return points || [];
  return Array.from({ length: maxPoints }, (_, index) => points[Math.round((index * (points.length - 1)) / (maxPoints - 1))]);
}

function infoContent(title, rows = [], link = null) {
  const root = document.createElement('div');
  root.className = 'map-info';
  const heading = document.createElement('strong');
  heading.textContent = title;
  root.append(heading);
  rows.filter(Boolean).forEach((row) => {
    const line = document.createElement('p');
    line.textContent = row;
    root.append(line);
  });
  if (link) {
    const anchor = document.createElement('a');
    anchor.href = link;
    anchor.target = '_blank';
    anchor.rel = 'noreferrer';
    anchor.textContent = '在 Google 地图中查看';
    root.append(anchor);
  }
  return root;
}

function supportsAcceleratedWebGL() {
  try {
    const canvas = document.createElement('canvas');
    const options = { failIfMajorPerformanceCaveat: true };
    return Boolean(canvas.getContext('webgl2', options) || canvas.getContext('webgl', options));
  } catch {
    return false;
  }
}

export default function MapView({ result, selectedDay, focus }) {
  const containerRef = useRef(null);
  const mapRef = useRef(null);
  const apiRef = useRef(null);
  const overlaysRef = useRef({ markers: new Map(), all: [], polylines: [], cleanups: [], infoWindow: null });
  const [status, setStatus] = useState({ state: 'loading', message: '' });

  useEffect(() => {
    let cancelled = false;
    let renderingListener = null;
    loadGoogleMaps()
      .then((api) => {
        if (cancelled || !containerRef.current) return;
        apiRef.current = api;
        const vector = supportsAcceleratedWebGL();
        const map = new api.maps.Map(containerRef.current, {
          center: DEFAULT_CENTER,
          zoom: DEFAULT_ZOOM,
          mapId: api.mapId,
          // 硬件 WebGL 可用时使用矢量地图 + 分数级缩放，否则回退栅格兼容模式。
          renderingType: vector ? api.maps.RenderingType.VECTOR : api.maps.RenderingType.RASTER,
          isFractionalZoomEnabled: true,
          tilt: 0,
          tiltInteractionEnabled: false,
          headingInteractionEnabled: false,
          backgroundColor: '#e8eaed',
          mapTypeControl: true,
          streetViewControl: true,
          fullscreenControl: true,
          zoomControl: true,
          gestureHandling: 'greedy',
          clickableIcons: true,
        });
        mapRef.current = map;
        const syncRenderingType = () => {
          const type = map.getRenderingType?.();
          if (containerRef.current && type) containerRef.current.dataset.renderingType = String(type).toLowerCase();
        };
        renderingListener = map.addListener('renderingtype_changed', syncRenderingType);
        syncRenderingType();
        setStatus({ state: 'ready', message: '' });
      })
      .catch((error) => {
        if (cancelled) return;
        const message = error?.code === 'MAPS_NOT_CONFIGURED'
          ? '服务端未配置 Google Maps Key'
          : 'Google 地图加载失败，请检查网络或 Key 的权限配置';
        setStatus({ state: 'error', message });
      });
    return () => {
      cancelled = true;
      renderingListener?.remove?.();
    };
  }, []);

  // 根据行程与选中的天绘制标记和路线。
  useEffect(() => {
    if (status.state !== 'ready') return undefined;
    const map = mapRef.current;
    const { maps, AdvancedMarkerElement, PinElement } = apiRef.current;
    const overlays = { markers: new Map(), all: [], polylines: [], cleanups: [], infoWindow: new maps.InfoWindow() };
    overlaysRef.current = overlays;

    const plan = result?.plan;
    if (!plan) {
      map.setCenter(DEFAULT_CENTER);
      map.setZoom(DEFAULT_ZOOM);
      return () => overlays.infoWindow.close();
    }

    const bounds = new maps.LatLngBounds();
    let pointCount = 0;
    const addMarker = ({ id, position, title, pin, popup, zIndex = 1 }) => {
      const marker = new AdvancedMarkerElement({ map, position, title, content: new PinElement(pin), zIndex, gmpClickable: true });
      const open = () => {
        overlays.infoWindow.setContent(popup);
        overlays.infoWindow.open({ map, anchor: marker });
      };
      marker.addEventListener('gmp-click', open);
      overlays.cleanups.push(() => marker.removeEventListener('gmp-click', open));
      overlays.all.push(marker);
      if (id) overlays.markers.set(id, { marker, open, position });
      bounds.extend(position);
      pointCount++;
    };

    accommodationsOf(plan).forEach((item) => {
      if (!item.coordinates) return;
      addMarker({
        position: { lat: item.coordinates.lat, lng: item.coordinates.lng },
        title: `住宿：${item.area || ''}`,
        pin: { background: '#3c4043', borderColor: '#ffffff', glyphColor: '#ffffff', glyphText: '住', scale: 1.05 },
        popup: infoContent(`推荐住宿 · ${item.area || ''}`, [item.city, item.reason], item.coordinates.google_maps_uri),
      });
    });

    (result.transitMarkers || []).forEach((item) => {
      if (!item.coordinates) return;
      addMarker({
        position: { lat: item.coordinates.lat, lng: item.coordinates.lng },
        title: item.name,
        pin: { background: '#ffffff', borderColor: '#5f6368', glyphColor: '#5f6368', glyphText: '站', scale: 0.85 },
        popup: infoContent(`交通站点 · ${item.name}`, [item.coordinates.display_name], item.google_maps_uri || item.coordinates.google_maps_uri),
      });
    });

    (plan.daily_plans || []).forEach((day) => {
      if (selectedDay !== null && selectedDay !== day.day) return;
      const color = dayColor(day.day);
      let order = 0;
      (day.spots || []).forEach((spot, index) => {
        if (!spot.coordinates) return;
        order++;
        addMarker({
          id: spotKey(day.day, spot, index),
          position: { lat: spot.coordinates.lat, lng: spot.coordinates.lng },
          title: `第 ${day.day} 天 · ${spot.name}`,
          pin: { background: color, borderColor: '#ffffff', glyphColor: '#ffffff', glyphText: String(order) },
          zIndex: 10,
          popup: infoContent(
            `第 ${day.day} 天 · ${order}. ${spot.name}`,
            [spot.description, spot.duration_hours ? `建议停留 ${spot.duration_hours} 小时` : null, spot.tips],
            spot.coordinates.google_maps_uri,
          ),
        });
      });
    });

    (result.routes || [])
      .filter(route => selectedDay === null || selectedDay === route.day)
      .filter(route => (route.geometry || []).length >= 2)
      .forEach((route) => {
        overlays.polylines.push(new maps.Polyline({
          map,
          path: limitGeometry(route.geometry).map(([lat, lng]) => ({ lat, lng })),
          strokeColor: dayColor(route.day),
          strokeOpacity: 0.85,
          strokeWeight: 4,
          clickable: false,
        }));
      });

    if (pointCount > 1) map.fitBounds(bounds, 56);
    else if (pointCount === 1) {
      map.setCenter(bounds.getCenter());
      map.setZoom(14);
    }

    return () => {
      overlays.cleanups.forEach(cleanup => cleanup());
      overlays.all.forEach((marker) => { marker.map = null; });
      overlays.polylines.forEach(polyline => polyline.setMap(null));
      overlays.infoWindow.close();
    };
  }, [status.state, result, selectedDay]);

  // 点击行程中的地点：平移地图并打开该地点的信息窗口。
  useEffect(() => {
    if (!focus?.id || status.state !== 'ready') return;
    const entry = overlaysRef.current.markers.get(focus.id);
    if (!entry) return;
    const map = mapRef.current;
    map.panTo(entry.position);
    if ((map.getZoom?.() ?? 0) < 14) map.setZoom(15);
    entry.open();
  }, [focus, status.state]);

  return (
    <div className="map-root">
      <div ref={containerRef} className="map-canvas" />
      {status.state === 'loading' && <div className="map-status">正在加载地图…</div>}
      {status.state === 'error' && (
        <div className="map-fallback">
          <Icon name="map" size={32} />
          <p className="map-fallback-title">地图暂不可用</p>
          <p className="map-fallback-text">{status.message}</p>
          <p className="map-fallback-text">行程内容不受影响。</p>
        </div>
      )}
    </div>
  );
}
