import { useEffect, useRef, useState } from 'react';
import { accommodationsOf, dayColor, spotKey } from '../lib/plan.js';
import {
  TRANSFER_COLOR,
  cityGroups,
  cityPosition,
  dayRangeLabel,
  describeTransfer,
  sameCity,
  viewLevel,
  visibleDays,
} from '../lib/trip.js';
import { loadGoogleMaps } from '../services/googleMaps.js';
import Icon, { iconSvg } from './Icon.jsx';

const DEFAULT_CENTER = { lat: 30, lng: 120 };
const DEFAULT_ZOOM = 3;

// 旧历史记录可能保存了 HIGH_QUALITY 折线，前端限制顶点数，避免缩放卡顿。
function limitGeometry(points, maxPoints = 320) {
  if (!Array.isArray(points) || points.length <= maxPoints) return points || [];
  return Array.from({ length: maxPoints }, (_, index) => points[Math.round((index * (points.length - 1)) / (maxPoints - 1))]);
}

function infoContent(title, rows = [], link = null, linkText = '在 Google 地图中查看') {
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
    anchor.textContent = linkText;
    root.append(anchor);
  }
  return root;
}

function transferInfo(transfer) {
  const info = describeTransfer(transfer);
  return infoContent(
    `${info.title} · ${info.modeLabel}`,
    [
      [info.service, ...info.facts].join(' · '),
      info.times,
      info.route,
      info.tips,
      info.schematic ? '示意直线：Google 暂无这段的铁路 / 航线数据，实际线路请看 Google 地图' : '',
    ],
    info.mapsUrl,
    '在 Google 地图中查看路线',
  );
}

// 总览地图上的城市标记：序号 + 城市名 + 天数。
function cityMarkerElement(index, group) {
  const element = document.createElement('div');
  element.className = 'city-pin';
  const order = document.createElement('span');
  order.className = 'city-pin-index';
  order.textContent = String(index + 1);
  const name = document.createElement('span');
  name.className = 'city-pin-name';
  name.textContent = group.name;
  const days = document.createElement('span');
  days.className = 'city-pin-days';
  days.textContent = dayRangeLabel(group.days);
  element.append(order, name, days);
  return element;
}

// 城市间交通线中点的方式标记（火车 / 航班 / 自驾…）。
function transferMarkerElement(transfer) {
  const info = describeTransfer(transfer);
  const element = document.createElement('div');
  element.className = `transfer-pin ${info.schematic ? 'is-schematic' : ''}`;
  element.innerHTML = iconSvg(info.icon, 16);
  element.title = `${info.title} · ${info.service}`;
  return element;
}

function midpoint(geometry) {
  if (!geometry?.length) return null;
  const [lat, lng] = geometry[Math.floor((geometry.length - 1) / 2)];
  if (geometry.length > 2) return { lat, lng };
  const [lat2, lng2] = geometry[geometry.length - 1];
  return { lat: (lat + lat2) / 2, lng: (lng + lng2) / 2 };
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

/**
 * 三级视图：
 *  - trip（多城市总览）：城市标记 + 城市间交通线（实线为真实路线，虚线为示意）；
 *  - city：该城市每天的地点与路线（细线，按天着色）；
 *  - day：当天的地点与路线（粗线），以及当天从住宿出发的城际交通。
 */
export default function MapView({ result, view = { city: null, day: null }, focus, onSelectCity = () => {} }) {
  const containerRef = useRef(null);
  const mapRef = useRef(null);
  const apiRef = useRef(null);
  const overlaysRef = useRef({ markers: new Map(), transfers: new Map(), all: [], polylines: [], cleanups: [], infoWindow: null });
  const selectCityRef = useRef(onSelectCity);
  const [status, setStatus] = useState({ state: 'loading', message: '' });
  selectCityRef.current = onSelectCity;

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

  const viewCity = view?.city ?? null;
  const viewDay = view?.day ?? null;

  // 根据行程与当前视图绘制标记和路线。
  useEffect(() => {
    if (status.state !== 'ready') return undefined;
    const map = mapRef.current;
    const { maps, AdvancedMarkerElement, PinElement } = apiRef.current;
    const overlays = { markers: new Map(), transfers: new Map(), all: [], polylines: [], cleanups: [], infoWindow: new maps.InfoWindow() };
    overlaysRef.current = overlays;

    const plan = result?.plan;
    if (!plan) {
      map.setCenter(DEFAULT_CENTER);
      map.setZoom(DEFAULT_ZOOM);
      return () => overlays.infoWindow.close();
    }

    const groups = cityGroups(plan);
    const multiCity = groups.length > 1;
    const level = viewLevel({ city: viewCity, day: viewDay }, multiCity);
    const transfers = result.transfers || [];
    const bounds = new maps.LatLngBounds();
    let pointCount = 0;
    const extend = (position) => {
      bounds.extend(position);
      pointCount++;
    };

    const addMarker = ({ id, position, title, content, popup, zIndex = 1, onClick = null, fit = true }) => {
      const marker = new AdvancedMarkerElement({ map, position, title, content, zIndex, gmpClickable: true });
      const open = () => {
        if (!popup) return;
        overlays.infoWindow.setContent(popup);
        overlays.infoWindow.open({ map, anchor: marker });
      };
      const handleClick = () => (onClick ? onClick() : open());
      marker.addEventListener('gmp-click', handleClick);
      overlays.cleanups.push(() => marker.removeEventListener('gmp-click', handleClick));
      overlays.all.push(marker);
      if (id) overlays.markers.set(id, { marker, open, position });
      if (fit) extend(position);
      return { marker, open };
    };

    const addLine = (geometry, { color, weight, opacity, dashed = false, geodesic = false, zIndex = 1 }) => {
      const path = limitGeometry(geometry).map(([lat, lng]) => ({ lat, lng }));
      if (path.length < 2) return;
      overlays.polylines.push(new maps.Polyline({
        map,
        path,
        geodesic,
        strokeColor: color,
        strokeOpacity: dashed ? 0 : opacity,
        strokeWeight: weight,
        clickable: false,
        zIndex,
        // 虚线：示意线（没有真实路线数据）用重复的短线段绘制。
        ...(dashed
          ? { icons: [{ icon: { path: 'M 0,-1 0,1', strokeOpacity: opacity, strokeColor: color, scale: weight * 0.75 }, offset: '0', repeat: `${weight * 3.5}px` }] }
          : {}),
      }));
    };

    const drawTransfer = (transfer) => {
      if ((transfer.geometry || []).length < 2) return;
      const schematic = transfer.route_source === 'schematic';
      addLine(transfer.geometry, { color: TRANSFER_COLOR, weight: 4, opacity: 0.9, dashed: schematic, geodesic: schematic, zIndex: 2 });
      for (const endpoint of [transfer.from, transfer.to]) {
        if (endpoint?.coordinates) extend(endpoint.coordinates);
      }
      const center = midpoint(transfer.geometry);
      if (!center) return;
      const { open } = addMarker({
        position: center,
        title: `${transfer.from_city} → ${transfer.to_city}`,
        content: transferMarkerElement(transfer),
        popup: transferInfo(transfer),
        zIndex: 20,
        fit: false,
      });
      overlays.transfers.set(transfer.id, { open, geometry: transfer.geometry });
    };

    const drawAccommodations = (filter) => {
      accommodationsOf(plan).forEach((item, index) => {
        if (!item.coordinates || !filter(item)) return;
        addMarker({
          position: { lat: item.coordinates.lat, lng: item.coordinates.lng },
          title: `住宿：${item.area || ''}`,
          content: new PinElement({ background: '#3c4043', borderColor: '#ffffff', glyphColor: '#ffffff', glyphText: '住', scale: 1.05 }),
          popup: infoContent(`推荐住宿 · ${item.area || ''}`, [item.city, item.reason], item.coordinates.google_maps_uri),
        });
        (result.transitMarkers || [])
          .filter(marker => marker.accommodation_index === index || (marker.accommodation_index === undefined && index === 0))
          .forEach((marker) => {
            if (!marker.coordinates) return;
            addMarker({
              position: { lat: marker.coordinates.lat, lng: marker.coordinates.lng },
              title: marker.name,
              content: new PinElement({ background: '#ffffff', borderColor: '#5f6368', glyphColor: '#5f6368', glyphText: '站', scale: 0.85 }),
              popup: infoContent(`交通站点 · ${marker.name}`, [marker.coordinates.display_name], marker.google_maps_uri || marker.coordinates.google_maps_uri),
              fit: false,
            });
          });
      });
    };

    // skip：城市视图里不画属于其他城市的地点（例如换城市当天的出发站）及相连的路段。
    const drawDays = (days, { weight, opacity, skip = null }) => {
      for (const day of days) {
        const color = dayColor(day.day);
        const hidden = new Set();
        let order = 0;
        (day.spots || []).forEach((spot, index) => {
          if (!spot.coordinates) return;
          order++;
          if (skip?.(spot)) {
            hidden.add(spot.location_id);
            return;
          }
          addMarker({
            id: spotKey(day.day, spot, index),
            position: { lat: spot.coordinates.lat, lng: spot.coordinates.lng },
            title: `第 ${day.day} 天 · ${spot.name}`,
            content: new PinElement({ background: color, borderColor: '#ffffff', glyphColor: '#ffffff', glyphText: String(order) }),
            zIndex: 10,
            popup: infoContent(
              `第 ${day.day} 天 · ${order}. ${spot.name}`,
              [spot.description, spot.duration_hours ? `建议停留 ${spot.duration_hours} 小时` : null, spot.tips],
              spot.coordinates.google_maps_uri,
            ),
          });
        });
        const route = (result.routes || []).find(item => item.day === day.day);
        const legs = route?.legs || [];
        if (legs.length) {
          for (const leg of legs) {
            const transfer = leg.mode === 'TRANSFER';
            if (skip && (transfer || hidden.has(leg.from_id) || hidden.has(leg.to_id))) continue;
            addLine(leg.geometry, {
              color: transfer ? TRANSFER_COLOR : color,
              weight,
              opacity,
              dashed: Boolean(leg.schematic || leg.fallback || leg.mode === 'STRAIGHT'),
              geodesic: Boolean(leg.schematic),
            });
          }
        } else if ((route?.geometry || []).length >= 2) {
          addLine(route.geometry, { color, weight, opacity });
        }
      }
    };

    if (level === 'trip') {
      groups.forEach((group, index) => {
        const position = cityPosition(result, group);
        if (!position) return;
        addMarker({
          position,
          title: `${group.name}：${dayRangeLabel(group.days)}`,
          content: cityMarkerElement(index, group),
          zIndex: 30,
          onClick: () => selectCityRef.current(group.key),
        });
      });
      transfers.forEach(drawTransfer);
    } else {
      const days = visibleDays(plan, { city: viewCity, day: viewDay });
      const dayCities = days.map(day => day.city || plan.city);
      drawAccommodations(item => !multiCity || dayCities.some(city => sameCity(city, item.city)));
      const otherCities = multiCity && level === 'city' ? groups.filter(group => group.key !== viewCity).map(group => group.name) : [];
      const outsideCity = otherCities.length ? spot => Boolean(spot.city) && otherCities.some(name => sameCity(name, spot.city)) : null;
      drawDays(days, level === 'day' ? { weight: 5, opacity: 0.9 } : { weight: 3, opacity: 0.7, skip: outsideCity });
      if (level === 'day') {
        // 当天从住宿出发、或一日游往返的城际交通，单独画出来。
        transfers.filter(item => item.day === viewDay && !item.covered).forEach(drawTransfer);
      }
    }

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
  }, [status.state, result, viewCity, viewDay]);

  // 点击行程中的地点或城市间交通：移动地图并打开信息窗口。
  useEffect(() => {
    if (!focus?.id || status.state !== 'ready') return;
    const map = mapRef.current;
    if (focus.type === 'transfer') {
      const entry = overlaysRef.current.transfers.get(focus.id);
      if (!entry) return;
      const bounds = new apiRef.current.maps.LatLngBounds();
      entry.geometry.forEach(([lat, lng]) => bounds.extend({ lat, lng }));
      map.fitBounds(bounds, 72);
      entry.open();
      return;
    }
    const entry = overlaysRef.current.markers.get(focus.id);
    if (!entry) return;
    map.panTo(entry.position);
    if ((map.getZoom?.() ?? 0) < 14) map.setZoom(15);
    entry.open();
    // 视图切换与聚焦在同一次渲染中发生：绘制标记的 effect 先运行，这里再打开信息窗口。
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
