import { useEffect, useMemo, useRef, useState } from 'react';
import { loadGoogleMaps } from '../services/googleMaps.js';
import { findDay, modeLabel, validCoordinates } from '../services/planModel.js';

const DEFAULT_CENTER = { lat: 34.3416, lng: 108.9398 };
const MODE_COLORS = {
  WALK: '#16a34a',
  TRANSIT: '#2563eb',
  DRIVE: '#7c3aed',
  TAXI: '#d97706',
  BICYCLE: '#0891b2',
  RAIL: '#1d4ed8',
  FLIGHT: '#64748b',
  FERRY: '#0e7490',
  UNKNOWN: '#94a3b8',
};

function limitGeometry(points, maxPoints = 360) {
  if (!Array.isArray(points) || points.length <= maxPoints) return points || [];
  return Array.from({ length: maxPoints }, (_, index) => {
    const sourceIndex = Math.round((index * (points.length - 1)) / (maxPoints - 1));
    return points[sourceIndex];
  });
}

function pin(PinElement, label, color, selected = false) {
  return new PinElement({
    background: selected ? '#0f172a' : color,
    borderColor: '#ffffff',
    glyphColor: '#ffffff',
    glyphText: label,
    scale: selected ? 1.22 : 1,
  });
}

function infoContent(node, dayNumber) {
  const root = document.createElement('div');
  root.className = 'google-info-window';
  const heading = document.createElement('strong');
  heading.textContent = `Day ${dayNumber} · ${node.name}`;
  root.append(heading);
  [
    node.start_time && `时间：${node.start_time}${node.end_time ? `–${node.end_time}` : ''}`,
    node.description,
    node.tips && `提示：${node.tips}`,
    node.coordinates?.display_name,
  ].filter(Boolean).forEach(value => {
    const line = document.createElement('div');
    line.textContent = value;
    root.append(line);
  });
  if (node.coordinates?.google_maps_uri) {
    const link = document.createElement('a');
    link.href = node.coordinates.google_maps_uri;
    link.target = '_blank';
    link.rel = 'noreferrer';
    link.textContent = '在 Google 地图中查看';
    root.append(link);
  }
  return root;
}

function supportsWebGL() {
  try {
    const canvas = document.createElement('canvas');
    const options = { failIfMajorPerformanceCaveat: true };
    return Boolean(canvas.getContext('webgl2', options) || canvas.getContext('webgl', options));
  } catch {
    return false;
  }
}

function cleanupOverlays(overlays, maps) {
  overlays.listeners.forEach(listener => {
    if (typeof listener === 'function') listener();
    else if (listener) maps.event.removeListener(listener);
  });
  overlays.markers.forEach(({ marker }) => { marker.map = null; });
  overlays.polylines.forEach(({ polyline }) => polyline.setMap(null));
  overlays.infoWindow?.close();
}

function uniqueById(items) {
  const seen = new Set();
  return items.filter((item, index) => {
    const id = item.id || item.leg_id || `${item.day}-${index}`;
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}

export default function MapView({
  plan,
  routes = [],
  selectedDay,
  selectedNodeId,
  selectedLegId,
  onSelectNode,
  onSelectLeg,
  transitMarkers = [],
}) {
  const containerRef = useRef(null);
  const mapRef = useRef(null);
  const apiRef = useRef(null);
  const overlaysRef = useRef({ markers: [], polylines: [], listeners: [], infoWindow: null });
  const [ready, setReady] = useState(false);
  const [error, setError] = useState(null);

  const activeDay = useMemo(() => {
    if (selectedDay === null) return null;
    return findDay(plan, selectedDay) || plan?.daily_plans?.[0] || null;
  }, [plan, selectedDay]);

  useEffect(() => {
    let cancelled = false;
    loadGoogleMaps().then(api => {
      if (cancelled || !containerRef.current) return;
      apiRef.current = api;
      const vector = supportsWebGL();
      const options = {
        center: DEFAULT_CENTER,
        zoom: 4,
        mapId: import.meta.env.VITE_GOOGLE_MAP_ID || 'DEMO_MAP_ID',
        renderingType: vector ? api.maps.RenderingType.VECTOR : api.maps.RenderingType.RASTER,
        isFractionalZoomEnabled: true,
        tilt: 0,
        mapTypeControl: true,
        streetViewControl: true,
        fullscreenControl: true,
        zoomControl: true,
        scaleControl: true,
        gestureHandling: 'greedy',
        clickableIcons: true,
        backgroundColor: '#e8edf4',
      };
      mapRef.current = new api.maps.Map(containerRef.current, options);
      setReady(true);
    }).catch(loadError => {
      if (!cancelled) setError(loadError.message || 'Google 地图加载失败');
    });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const container = containerRef.current;
    const map = mapRef.current;
    const maps = apiRef.current?.maps;
    if (!ready || !container || !map || !maps || typeof ResizeObserver === 'undefined') {
      return undefined;
    }

    let frame = 0;
    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const center = map.getCenter?.();
        maps.event.trigger(map, 'resize');
        if (center) map.setCenter(center);
      });
    });
    observer.observe(container);
    return () => {
      observer.disconnect();
      cancelAnimationFrame(frame);
    };
  }, [ready]);

  useEffect(() => {
    if (!ready || !mapRef.current || !apiRef.current) return undefined;
    const map = mapRef.current;
    const { maps, AdvancedMarkerElement, PinElement } = apiRef.current;
    cleanupOverlays(overlaysRef.current, maps);
    const overlays = {
      markers: [],
      polylines: [],
      listeners: [],
      infoWindow: new maps.InfoWindow(),
    };
    overlaysRef.current = overlays;

    if (!plan) {
      map.setCenter(DEFAULT_CENTER);
      map.setZoom(4);
      return undefined;
    }

    const overview = selectedDay === null;
    const dayNumber = overview ? null : Number(activeDay?.day);
    const bounds = new maps.LatLngBounds();
    let pointCount = 0;
    const extend = coordinates => {
      if (!validCoordinates(coordinates)) return;
      bounds.extend({ lat: Number(coordinates.lat), lng: Number(coordinates.lng) });
      pointCount++;
    };

    const nodes = overview ? [] : Array.isArray(activeDay?.nodes) && activeDay.nodes.length
      ? activeDay.nodes
      : (activeDay?.spots || []);
    const markerCoordinates = new Set();
    nodes.forEach((node, index) => {
      if (!validCoordinates(node.coordinates)) return;
      const id = node.id || node.node_id || `day-${dayNumber}-node-${index}`;
      const position = { lat: Number(node.coordinates.lat), lng: Number(node.coordinates.lng) };
      const label = `${dayNumber}.${index + 1}`;
      const color = ['hotel', 'stay'].includes(node.type) ? '#7c3aed' : '#ef4444';
      const marker = new AdvancedMarkerElement({
        map,
        position,
        title: `Day ${dayNumber} · ${node.name}`,
        content: pin(PinElement, label, color, id === selectedNodeId),
        gmpClickable: true,
      });
      const popup = infoContent(node, dayNumber);
      const click = () => {
        overlays.infoWindow.setContent(popup);
        overlays.infoWindow.open({ map, anchor: marker });
        onSelectNode?.(id, dayNumber);
      };
      marker.addEventListener('gmp-click', click);
      overlays.listeners.push(() => marker.removeEventListener('gmp-click', click));
      overlays.markers.push({ marker, id, label, color, position, popup });
      markerCoordinates.add(`${position.lat.toFixed(6)},${position.lng.toFixed(6)}`);
      extend(position);
    });

    const accommodations = plan.accommodations?.length
      ? plan.accommodations
      : plan.accommodation ? [plan.accommodation] : [];
    accommodations
      .filter(item => overview || !item.city || !activeDay?.city || item.city === activeDay.city)
      .forEach((item, index) => {
        if (!validCoordinates(item.coordinates)) return;
        const position = { lat: Number(item.coordinates.lat), lng: Number(item.coordinates.lng) };
        if (markerCoordinates.has(`${position.lat.toFixed(6)},${position.lng.toFixed(6)}`)) return;
        const id = item.id || `stay-${item.city || activeDay?.city || dayNumber}-${index}`;
        const accommodationDay = overview
          ? plan.daily_plans?.find(day => !item.city || day.city === item.city)?.day
          : dayNumber;
        const marker = new AdvancedMarkerElement({
          map,
          position,
          title: `住宿 · ${item.area || item.city || ''}`,
          content: pin(PinElement, 'H', '#7c3aed', id === selectedNodeId),
          gmpClickable: true,
        });
        const popup = infoContent({ ...item, name: `住宿 · ${item.area || item.city || ''}` }, accommodationDay);
        const click = () => {
          overlays.infoWindow.setContent(popup);
          overlays.infoWindow.open({ map, anchor: marker });
          onSelectNode?.(id, accommodationDay);
        };
        marker.addEventListener('gmp-click', click);
        overlays.listeners.push(() => marker.removeEventListener('gmp-click', click));
        overlays.markers.push({ marker, id, label: 'H', color: '#7c3aed', position, popup });
        extend(position);
      });

    transitMarkers
      .filter(item => !overview && (item.day == null || Number(item.day) === dayNumber)
        && (!item.city || !activeDay?.city || item.city === activeDay.city))
      .forEach((item, index) => {
        if (!validCoordinates(item.coordinates)) return;
        const position = { lat: Number(item.coordinates.lat), lng: Number(item.coordinates.lng) };
        const id = item.id || item.place_id || `transit-${dayNumber}-${index}`;
        const marker = new AdvancedMarkerElement({
          map,
          position,
          title: item.name,
          content: pin(PinElement, 'M', '#2563eb', id === selectedNodeId),
          gmpClickable: true,
        });
        const popup = infoContent({ ...item, name: item.name || '公共交通站' }, dayNumber);
        const click = () => {
          overlays.infoWindow.setContent(popup);
          overlays.infoWindow.open({ map, anchor: marker });
          onSelectNode?.(id, dayNumber);
        };
        marker.addEventListener('gmp-click', click);
        overlays.listeners.push(() => marker.removeEventListener('gmp-click', click));
        overlays.markers.push({ marker, id, label: 'M', color: '#2563eb', position, popup });
        extend(position);
      });

    const dayLegs = Array.isArray(activeDay?.legs) ? activeDay.legs : [];
    const visibleRoutes = overview
      ? routes.filter(route => route.connection_to_day != null)
      : routes.filter(route => Number(route.day) === dayNumber && route.connection_to_day == null);
    uniqueById([...dayLegs, ...visibleRoutes])
      .forEach((leg, index) => {
        const id = leg.id || leg.leg_id || `leg-${dayNumber}-${index}`;
        const geometry = limitGeometry(leg.geometry)
          .filter(point => Array.isArray(point) && point.length === 2
            && Number.isFinite(Number(point[0])) && Number.isFinite(Number(point[1])));
        if (geometry.length < 2) return;
        const status = leg.status || leg.route_status;
        if (!['success', 'planned', 'available', 'estimated', 'needs_confirmation'].includes(status)) return;
        const mode = String(leg.mode || leg.selected_mode || leg.travel_mode || 'UNKNOWN').toUpperCase();
        const verified = status === 'success' || status === 'planned' || status === 'available';
        const polyline = new maps.Polyline({
          map,
          path: geometry.map(([lat, lng]) => ({ lat: Number(lat), lng: Number(lng) })),
          strokeColor: verified ? (MODE_COLORS[mode] || MODE_COLORS.UNKNOWN) : '#94a3b8',
          strokeOpacity: verified ? 0.9 : 0,
          strokeWeight: id === selectedLegId ? 7 : 4,
          geodesic: !verified,
          clickable: true,
          icons: verified ? undefined : [{
            icon: { path: 'M 0,-1 0,1', strokeOpacity: 0.8, scale: 3 },
            offset: '0',
            repeat: '14px',
          }],
        });
        const click = () => onSelectLeg?.(id, dayNumber);
        const listener = polyline.addListener('click', click);
        overlays.listeners.push(listener);
        overlays.polylines.push({ polyline, id, verified, mode, geometry });
        geometry.forEach(([lat, lng]) => extend({ lat: Number(lat), lng: Number(lng) }));
      });

    if (pointCount > 1) map.fitBounds(bounds, { top: 88, right: 64, bottom: 88, left: 64 });
    else if (pointCount === 1) {
      map.setCenter(bounds.getCenter());
      map.setZoom(14);
    }

    return () => cleanupOverlays(overlays, maps);
  }, [activeDay, onSelectLeg, onSelectNode, plan, ready, routes, selectedDay, transitMarkers]);

  useEffect(() => {
    if (!ready || !apiRef.current || !mapRef.current) return;
    const { PinElement } = apiRef.current;
    const overlays = overlaysRef.current;
    overlays.markers.forEach(item => {
      item.marker.content = pin(PinElement, item.label, item.color, item.id === selectedNodeId);
      if (item.id === selectedNodeId) {
        mapRef.current.panTo(item.position);
        if ((mapRef.current.getZoom?.() || 0) < 13) mapRef.current.setZoom(13);
        overlays.infoWindow.setContent(item.popup);
        overlays.infoWindow.open({ map: mapRef.current, anchor: item.marker });
      }
    });
    overlays.polylines.forEach(item => {
      item.polyline.setOptions({ strokeWeight: item.id === selectedLegId ? 7 : 4 });
      if (item.id === selectedLegId && item.geometry.length) {
        const bounds = new apiRef.current.maps.LatLngBounds();
        item.geometry.forEach(([lat, lng]) => bounds.extend({ lat, lng }));
        mapRef.current.fitBounds(bounds, { top: 100, right: 80, bottom: 100, left: 80 });
      }
    });
  }, [ready, selectedLegId, selectedNodeId]);

  return (
    <div className="google-map-root">
      <div ref={containerRef} className="google-map-canvas" />
      {!ready && !error && <div className="map-loading" role="status">正在加载地图…</div>}
      {error && (
        <div className="map-error" role="alert">
          <strong>地图暂不可用</strong>
          <span>{error}</span>
          <small>行程时间轴仍可正常查看和编辑。</small>
        </div>
      )}
      {!plan && ready && (
        <div className="map-empty-state">
          <span aria-hidden="true">⌁</span>
          <strong>你的旅程会在这里展开</strong>
          <p>完善左侧资料后，地图将按天展示地点与真实交通段。</p>
        </div>
      )}
      {ready && plan && (
        <div className="map-day-badge">
          <strong>{selectedDay === null ? '全程概览' : `Day ${activeDay?.day}`}</strong>
          <span>{selectedDay === null ? `${plan.stages?.length || plan.destinations?.length || 1} 个城市阶段` : activeDay?.city || activeDay?.theme}</span>
        </div>
      )}
      {selectedLegId && (
        <div className="map-legend" aria-live="polite">
          已选择交通段 · {modeLabel(
            activeDay?.legs?.find(leg => (leg.id || leg.leg_id) === selectedLegId)?.mode,
          )}
        </div>
      )}
    </div>
  );
}
