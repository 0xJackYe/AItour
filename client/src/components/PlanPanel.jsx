import PlanHealthDrawer from './PlanHealthDrawer.jsx';
import {
  externalDirectionsReference,
  googleRouteCompliance,
  isActualIntercityTransition,
  routeAdvisoryText,
} from '../services/planModel.js';
import { formatSegmentTime, formatTimeValue } from '../services/timeFormat.js';

const TYPE_EMOJI = {
  attraction: '🏛️', restaurant: '🍜', transport: '🚇', hotel: '🏨',
  shopping: '🛍️', rest: '☕', free_time: '🌿', airport: '✈️', station: '🚉',
};

const MODE_LABELS = {
  WALK: '步行', TRANSIT: '公共交通', DRIVE: '驾车 / 打车', BICYCLE: '骑行',
  RAIL: '铁路', FLIGHT: '飞机', TAXI: '出租车', FERRY: '轮渡', UNKNOWN: '交通待确认',
  BUS: '公交车', COACH: '长途巴士', SUBWAY: '地铁', TRAIN: '火车',
  LIGHT_RAIL: '轻轨', HIGH_SPEED_RAIL: '新干线 / 高铁',
};

function stablePart(value) {
  return String(value || 'item').trim().toLowerCase().replace(/[^a-z0-9\u3400-\u9fff]+/g, '-').replace(/^-|-$/g, '') || 'item';
}

function formatDistance(meters) {
  if (meters === null || meters === undefined || meters === '') return null;
  const value = Number(meters);
  if (!Number.isFinite(value) || value < 0) return null;
  return value >= 1000 ? `${(value / 1000).toFixed(1)} km` : `${Math.round(value)} m`;
}

function formatDuration(seconds) {
  if (seconds === null || seconds === undefined || seconds === '') return null;
  const value = Number(seconds);
  if (!Number.isFinite(value) || value < 0) return null;
  const totalMinutes = Math.round(value / 60);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return hours ? `${hours}小时${minutes ? `${minutes}分钟` : ''}` : `${minutes}分钟`;
}

function formatClock(value) {
  return formatTimeValue(value);
}

function segmentMode(segment = {}) {
  const value = String(segment.transit_vehicle_type || segment.mode || segment.travel_mode || 'UNKNOWN').toUpperCase();
  return ({
    HIGH_SPEED_TRAIN: 'HIGH_SPEED_RAIL',
    LONG_DISTANCE_TRAIN: 'TRAIN',
    HEAVY_RAIL: 'TRAIN',
    COMMUTER_TRAIN: 'TRAIN',
    INTERCITY_BUS: 'COACH',
    TRAM: 'LIGHT_RAIL',
    METRO_RAIL: 'SUBWAY',
    OTHER: 'TRANSIT',
  })[value] || value;
}

function segmentLineName(segment = {}) {
  return segment.line?.name || segment.line?.name_short || MODE_LABELS[segmentMode(segment)] || '交通待确认';
}

function readableSegments(leg = {}) {
  if (Array.isArray(leg.segments) && leg.segments.length) {
    return [...leg.segments].sort((left, right) => Number(left.sequence || 0) - Number(right.sequence || 0));
  }
  return [{
    ...leg,
    id: `${leg.id || leg.leg_id || 'leg'}-aggregate`,
    transit_vehicle_type: leg.primary_vehicle || leg.mode || leg.travel_mode,
  }];
}

function connectionSummary(leg) {
  if (!leg) return '跨城交通待确认';
  if (leg.summary) return leg.summary;
  const names = readableSegments(leg).map(segmentLineName).filter(Boolean);
  return [...new Set(names)].join(' → ') || MODE_LABELS[String(leg.mode || leg.travel_mode || 'UNKNOWN').toUpperCase()];
}

function stopName(stop) {
  return stop?.name || stop?.stop_name || '';
}

function TransportChain({ leg, compact = false }) {
  if (!leg) return <span className="transport-unconfirmed">具体线路待确认</span>;
  const externalReference = externalDirectionsReference(leg);
  if (externalReference) {
    return (
      <div className={`transport-reference ${compact ? 'compact' : ''}`} role="note">
        <strong>参考交通建议</strong>
        <p>{externalReference.advisory}</p>
        <small>该段未在站内绘制轨迹，请以 Google Maps 的实时公共交通结果为准。</small>
        <small className="google-inline-attribution">Powered by Google, ©{new Date().getFullYear()} Google</small>
        {externalReference.url && (
          <a href={externalReference.url} target="_blank" rel="noopener noreferrer">
            在 Google Maps 查看实时公共交通
          </a>
        )}
      </div>
    );
  }
  const segments = readableSegments(leg);
  const advisory = routeAdvisoryText(leg);
  return (
    <div className={`transport-chain ${compact ? 'compact' : ''}`}>
      {segments.map((segment, index) => {
        const from = stopName(segment.from_stop || segment.fromStop);
        const to = stopName(segment.to_stop || segment.toStop);
        const timing = [
          formatSegmentTime(segment, 'departure_time'),
          formatSegmentTime(segment, 'arrival_time'),
        ].filter(Boolean).join('–');
        return (
          <div className="transport-chain-step" key={segment.id || `${leg.id || 'leg'}-${index}`}>
            <span className={`vehicle-badge vehicle-${segmentMode(segment).toLowerCase()}`}>
              {MODE_LABELS[segmentMode(segment)] || segmentMode(segment)}
            </span>
            <div>
              <strong>{segmentLineName(segment)}</strong>
              {(from || to) && <span>{from || '起点'} → {to || '终点'}</span>}
              <small>{[
                segment.headsign && `开往 ${segment.headsign}`,
                timing,
                formatDuration(segment.duration_seconds),
                segment.stop_count != null ? `${segment.stop_count} 站` : null,
              ].filter(Boolean).join(' · ')}</small>
            </div>
          </div>
        );
      })}
      {Number(leg.transfers) > 0 && <span className="transfer-count">换乘 {leg.transfers} 次</span>}
      {advisory && (
        <p className="transport-advisory"><strong>衔接建议：</strong>{advisory}</p>
      )}
    </div>
  );
}

function RouteComplianceNotice({ compliance }) {
  if (!compliance.usesGoogle) return null;
  const betaLabels = compliance.betaModes.map(mode => MODE_LABELS[mode] || mode);
  return (
    <aside className="route-compliance-notice" aria-label="Google 路线数据说明">
      <span>Powered by Google, ©{new Date().getFullYear()} Google</span>
      {betaLabels.length > 0 && (
        <small>
          {betaLabels.join('、')} Beta 路线在部分地区可能缺少清晰的人行道或骑行路径信息。
        </small>
      )}
    </aside>
  );
}

function formatBudget(budget) {
  if (!budget) return null;
  const levels = { budget: '经济型', moderate: '适中', luxury: '舒适 / 高端' };
  const basis = {
    per_person: '每人全程', daily: '全体每天', per_day: '全体每天',
    total: '全程', per_person_total: '每人全程', per_person_day: '每人每天',
  };
  const parts = [levels[budget.level] || budget.level];
  if (budget.amount) parts.push(`${basis[budget.basis] || ''} ${budget.amount} ${budget.currency || ''}`.trim());
  return parts.filter(Boolean).join(' · ');
}

function formatBudgetSummary(summary, fallback) {
  if (!summary) return formatBudget(fallback);
  const currency = summary.currency || fallback?.currency || '';
  const total = Number(summary.estimated_total ?? summary.known_total);
  const limit = Number(summary.limit);
  if (Number.isFinite(total) && total > 0) {
    return `已估 ${total.toLocaleString('zh-CN')} ${currency}${Number.isFinite(limit) && limit > 0 ? ` / 上限 ${limit.toLocaleString('zh-CN')} ${currency}` : ''}`;
  }
  return formatBudget(fallback) || '费用信息待补充';
}

function dayId(day) {
  return day.id || `day-${Number(day.day ?? day.dayNumber) || stablePart(day.date)}`;
}

function normalizeNodes(day) {
  const source = Array.isArray(day.nodes) ? day.nodes : Array.isArray(day.spots) ? day.spots : [];
  const seen = new Map();
  return source.map((node) => {
    const base = stablePart(node.name || node.type);
    const occurrence = (seen.get(base) || 0) + 1;
    seen.set(base, occurrence);
    return {
      ...node,
      id: node.id || `${dayId(day)}-node-${base}-${occurrence}`,
      durationMinutes: node.durationMinutes ?? node.duration_minutes ?? (Number(node.duration_hours) ? Number(node.duration_hours) * 60 : null),
      startTime: formatClock(node.startTime || node.start_time || node.arrivalTime || node.arrival_time),
      endTime: formatClock(node.endTime || node.end_time || node.departureTime || node.departure_time),
    };
  });
}

function normalizeLegs(day, nodes, routes) {
  const route = (routes || []).find(item => Number(item.day) === Number(day.day ?? day.dayNumber));
  const provided = Array.isArray(day.legs) ? day.legs : Array.isArray(route?.legs) ? route.legs : [];
  const byPair = new Map(provided.map((leg, index) => [
    `${leg.fromNodeId || leg.from_node_id || nodes[index]?.id}|${leg.toNodeId || leg.to_node_id || nodes[index + 1]?.id}`,
    leg,
  ]));

  return nodes.slice(0, -1).map((node, index) => {
    const next = nodes[index + 1];
    const leg = byPair.get(`${node.id}|${next.id}`) || provided[index] || {};
    return {
      ...leg,
      id: leg.id || `${dayId(day)}-leg-${stablePart(node.id)}-${stablePart(next.id)}`,
      fromNodeId: node.id,
      toNodeId: next.id,
      mode: String(leg.mode || leg.travel_mode || 'UNKNOWN').toUpperCase(),
      status: leg.status || (provided.length ? 'success' : 'unknown'),
      distanceMeters: leg.distanceMeters ?? leg.distance_meters,
      durationSeconds: leg.durationSeconds ?? leg.duration_seconds,
    };
  });
}

function deriveStages(plan, days, accommodations) {
  if (Array.isArray(plan.stages) && plan.stages.length) {
    return plan.stages.map((stage, index) => ({
      ...stage,
      id: stage.id || `stage-${index + 1}-${stablePart(stage.city)}`,
      accommodation: stage.accommodation || accommodations.find(item => item.city === stage.city),
    }));
  }
  if (Array.isArray(plan.destinations) && plan.destinations.length) {
    return plan.destinations.map((destination, index) => ({
      ...destination,
      id: destination.id || `stage-${index + 1}-${stablePart(destination.city)}`,
      startDay: Number(destination.startDay ?? destination.start_day),
      endDay: Number(destination.endDay ?? destination.end_day),
      accommodation: accommodations.find(item => item.city === destination.city),
    }));
  }

  const stages = [];
  days.forEach((day) => {
    const last = stages.at(-1);
    const number = Number(day.day ?? day.dayNumber);
    if (last?.city === day.city && last?.country === day.country) last.endDay = number;
    else stages.push({
      id: `stage-${stages.length + 1}-${stablePart(day.city)}`,
      city: day.city || plan.city || '目的地', country: day.country || plan.country || '',
      startDay: number, endDay: number,
      accommodation: accommodations.find(item => item.city === day.city) || accommodations[stages.length],
    });
  });
  return stages;
}

function stageDays(stage, days) {
  const start = Number(stage.startDay ?? stage.start_day);
  const end = Number(stage.endDay ?? stage.end_day);
  return days.filter(day => {
    if (day.stageId && stage.id) return day.stageId === stage.id;
    const number = Number(day.day ?? day.dayNumber);
    return Number.isFinite(start) && Number.isFinite(end)
      ? number >= start && number <= end
      : day.city === stage.city;
  });
}

function findIntercityLeg(plan, stage, nextStage, index) {
  return stage.intercityLegOut || stage.intercity_leg_out || nextStage?.intercityLegIn || nextStage?.intercity_leg_in
    || (plan.intercityLegs || plan.intercity_legs || [])[index]
    || (plan.daily_plans || []).find(day => Number(day.day) === Number(stage.endDay ?? stage.end_day))?.connection_to_next
    || null;
}

function JourneyRail({ plan, stages }) {
  if (!stages.length) return null;
  return (
    <section className="journey-section" aria-labelledby="journey-title">
      <div className="section-heading">
        <h3 id="journey-title">旅程主轴</h3>
        <span>{stages.length} 个城市阶段</span>
      </div>
      <div className="journey-rail" role="list">
        {stages.map((stage, index) => {
          const next = stages[index + 1];
          const connection = findIntercityLeg(plan, stage, next, index);
          const nights = stage.nights ?? Math.max(0, Number(stage.endDay ?? stage.end_day) - Number(stage.startDay ?? stage.start_day));
          return (
            <div className="journey-rail-segment" key={stage.id} role="listitem">
              <div className="journey-stage">
                <span className="stage-order">{index + 1}</span>
                <div>
                  <strong>{stage.city || '目的地待确认'}</strong>
                  <span>Day {stage.startDay ?? stage.start_day}–{stage.endDay ?? stage.end_day}{nights ? ` · ${nights} 晚` : ''}</span>
                  {(stage.accommodation?.area || stage.stay?.area) && <small>住：{stage.accommodation?.area || stage.stay?.area}</small>}
                </div>
              </div>
              {next && (
                <div className={`journey-transfer ${connection ? '' : 'unconfirmed'}`}>
                  <span aria-hidden="true">→</span>
                  <small title={connectionSummary(connection)}>{connection ? `${connectionSummary(connection)}${formatDuration(connection.durationSeconds ?? connection.duration_seconds) ? ` · ${formatDuration(connection.durationSeconds ?? connection.duration_seconds)}` : ''}` : '跨城交通待确认'}</small>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}

function DayNavigator({ stages, days, selectedDay, onSelectDay }) {
  return (
    <nav className="day-navigator" aria-label="按城市和日期选择行程">
      <div className="day-nav-stage overview-nav-stage">
        <span className="day-nav-city">概览</span>
        <div className="day-tabs">
          <button
            type="button"
            className={`day-tab ${selectedDay === null ? 'active' : ''}`}
            aria-current={selectedDay === null ? 'page' : undefined}
            onClick={() => onSelectDay?.(null)}
          >
            <strong>全程</strong>
            <span>{days.length} 天</span>
          </button>
        </div>
      </div>
      {stages.map(stage => {
        const groupedDays = stageDays(stage, days);
        if (!groupedDays.length) return null;
        return (
          <div className="day-nav-stage" key={stage.id}>
            <span className="day-nav-city">{stage.city || '行程'}</span>
            <div className="day-tabs">
              {groupedDays.map(day => {
                const number = Number(day.day ?? day.dayNumber);
                const active = Number(selectedDay) === number || selectedDay === day.id;
                return (
                  <button
                    type="button"
                    key={dayId(day)}
                    className={`day-tab ${active ? 'active' : ''}`}
                    aria-current={active ? 'date' : undefined}
                    onClick={() => onSelectDay?.(number)}
                  >
                    <strong>Day {number}</strong>
                    <span>{day.date ? new Intl.DateTimeFormat('zh-CN', { month: 'numeric', day: 'numeric' }).format(new Date(`${day.date}T00:00:00`)) : day.theme || ''}</span>
                  </button>
                );
              })}
            </div>
          </div>
        );
      })}
    </nav>
  );
}

function LegRow({ leg, day, selected, onSelect }) {
  const status = String(leg.status || 'unknown').toLowerCase();
  const needsConfirmation = status === 'needs_confirmation';
  const unavailable = ['unknown', 'unavailable', 'failed', 'pending'].includes(status);
  const verified = ['available', 'success', 'planned'].includes(status);
  const rawDetails = [formatDuration(leg.durationSeconds), formatDistance(leg.distanceMeters)].filter(Boolean).join(' · ');
  const details = verified ? rawDetails : (needsConfirmation || leg.estimated) && rawDetails ? `预计 ${rawDetails}` : '';
  const fallbackNote = leg.fallback_from_mode
    ? `原 ${MODE_LABELS[String(leg.fallback_from_mode).toUpperCase()] || leg.fallback_from_mode} 不可用，已切换`
    : null;
  const statusNote = needsConfirmation
    ? '具体班次待确认'
    : unavailable ? (leg.reason || '路线与耗时待确认') : fallbackNote;
  const description = [details, statusNote].filter(Boolean).join(' · ') || '路线与耗时待确认';
  const primaryMode = String(leg.primary_vehicle || leg.mode || 'UNKNOWN').toUpperCase();
  const summary = connectionSummary(leg);
  return (
    <div className={`timeline-leg-group ${selected ? 'selected' : ''}`}>
      <button
        type="button"
        className={`timeline-leg ${selected ? 'selected' : ''} ${unavailable || needsConfirmation ? 'unavailable' : ''}`}
        onClick={() => onSelect?.(leg.id, Number(day.day ?? day.dayNumber))}
        aria-pressed={selected}
        aria-label={`${summary}，${description}`}
      >
        <span className="leg-line" aria-hidden="true" />
        <span className="leg-mode">{MODE_LABELS[primaryMode] || MODE_LABELS[leg.mode] || leg.mode}</span>
        <strong className="leg-summary">{summary}</strong>
        <span>{description}</span>
      </button>
      {Array.isArray(leg.segments) && leg.segments.length > 0 && <TransportChain leg={leg} compact />}
    </div>
  );
}

function NodeRow({ node, day, selected, onSelect, onEdit, editing, canMoveUp, canMoveDown }) {
  const duration = node.durationMinutes ? `${node.durationMinutes} 分钟` : null;
  const editable = !node.role && !['hotel', 'stay', 'start', 'end'].includes(node.type);
  return (
    <article className={`timeline-node ${selected ? 'selected' : ''}`} id={`timeline-${node.id}`}>
      <button
        type="button"
        className="node-select"
        onClick={() => onSelect?.(node.id, Number(day.day ?? day.dayNumber))}
        aria-pressed={selected}
      >
        <span className="node-time">{node.startTime || '时间待定'}</span>
        <span className="node-marker" aria-hidden="true">{TYPE_EMOJI[node.type] || '📍'}</span>
        <span className="node-copy">
          <span className="node-name-row">
            <strong>{node.name || '未命名活动'}</strong>
            {node.locked && <span className="locked-badge">已锁定</span>}
          </span>
          <span className="node-meta">{[duration, node.endTime ? `至 ${node.endTime}` : null, node.reservation?.status === 'confirmed' ? '已预约' : null].filter(Boolean).join(' · ')}</span>
          {node.description && <span className="node-description">{node.description}</span>}
          {node.tips && <span className="node-tip">提示：{node.tips}</span>}
          {!node.coordinates && <span className="no-coord">位置待确认</span>}
        </span>
      </button>
      {onEdit && editable && (
        <div className="node-actions" aria-label={`${node.name} 编辑操作`}>
          <button type="button" disabled={editing} onClick={() => onEdit({ type: 'toggle_lock', dayId: dayId(day), nodeId: node.id })} aria-label={node.locked ? `取消锁定 ${node.name}` : `锁定 ${node.name}`}>{node.locked ? '解锁' : '锁定'}</button>
          <button type="button" disabled={editing || !canMoveUp} onClick={() => onEdit({ type: 'move_node', direction: 'up', dayId: dayId(day), nodeId: node.id })} aria-label={`上移 ${node.name}`}>上移</button>
          <button type="button" disabled={editing || !canMoveDown} onClick={() => onEdit({ type: 'move_node', direction: 'down', dayId: dayId(day), nodeId: node.id })} aria-label={`下移 ${node.name}`}>下移</button>
          <button type="button" className="danger-action" disabled={editing} onClick={() => onEdit({ type: 'delete_node', dayId: dayId(day), nodeId: node.id })} aria-label={`删除 ${node.name}`}>删除</button>
        </div>
      )}
    </article>
  );
}

function DayTimeline({ day, routes, selectedNodeId, onSelectNode, selectedLegId, onSelectLeg, onEdit, editing }) {
  const nodes = normalizeNodes(day);
  const legs = normalizeLegs(day, nodes, routes);
  const activityCount = nodes.filter(node => !node.role && !['hotel', 'stay', 'start', 'end'].includes(node.type)).length;
  const route = (routes || []).find(item => Number(item.day) === Number(day.day ?? day.dayNumber));
  const hasEstimatedLeg = legs.some(leg => leg.estimated || !['available', 'success', 'planned'].includes(String(leg.status || '').toLowerCase()));
  const totalDistance = legs.length
    ? legs.reduce((sum, leg) => sum + (Number(leg.distanceMeters) || 0), 0)
    : route?.distance_meters;
  const transitSeconds = legs.length
    ? legs.reduce((sum, leg) => sum + (Number(leg.durationSeconds) || 0), 0)
    : route?.duration_seconds;
  return (
    <article className="day-card" aria-labelledby={`${dayId(day)}-title`}>
      <header className="day-title">
        <div>
          <span className="day-badge">Day {day.day ?? day.dayNumber}</span>
          <h3 id={`${dayId(day)}-title`}>{day.theme || '当日行程'}</h3>
        </div>
        <span className="day-location">{[day.city, day.country].filter(Boolean).join(' · ')}</span>
      </header>
      <div className="day-summary-row">
        <span>{activityCount} 个活动</span>
        {formatDistance(totalDistance) && <span>{hasEstimatedLeg ? '预计路程' : '总路程'} {formatDistance(totalDistance)}</span>}
        {formatDuration(transitSeconds) && <span>{hasEstimatedLeg ? '预计交通' : '交通'} {formatDuration(transitSeconds)}</span>}
      </div>
      {nodes.length ? (
        <div className="day-timeline">
          {nodes.map((node, index) => (
            <div className="timeline-pair" key={node.id}>
              <NodeRow
                node={node}
                day={day}
                selected={selectedNodeId === node.id}
                onSelect={onSelectNode}
                onEdit={onEdit}
                editing={editing}
                canMoveUp={index > 0 && !nodes[index - 1]?.role && !['hotel', 'stay', 'start', 'end'].includes(nodes[index - 1]?.type)}
                canMoveDown={index < nodes.length - 1 && !nodes[index + 1]?.role && !['hotel', 'stay', 'start', 'end'].includes(nodes[index + 1]?.type)}
              />
              {legs[index] && <LegRow leg={legs[index]} day={day} selected={selectedLegId === legs[index].id} onSelect={onSelectLeg} />}
            </div>
          ))}
        </div>
      ) : <p className="empty-day">当天暂无活动，请补充或重新规划。</p>}
      {day.transport_notes && <p className="transport-notes">交通建议：{day.transport_notes}</p>}
    </article>
  );
}

function DayBoundaryCard({ day, nextDay, plan, stages }) {
  if (!nextDay) return null;
  const currentStage = stages.find(stage => stageDays(stage, [day]).length);
  const nextStage = stages.find(stage => stageDays(stage, [nextDay]).length);
  const stageChanged = currentStage?.id !== nextStage?.id;
  const connection = day.connection_to_next || day.connectionToNext
    || (stageChanged ? findIntercityLeg(plan, currentStage || {}, nextStage, stages.indexOf(currentStage)) : null);
  const accommodation = currentStage?.accommodation || currentStage?.stay;
  const externalReference = externalDirectionsReference(connection);
  return (
    <aside className={`day-boundary-card ${stageChanged ? 'intercity' : ''}`}>
      <span className="boundary-line" aria-hidden="true" />
      <div className="boundary-copy">
        <strong>{stageChanged ? `${currentStage?.city || ''} → ${nextStage?.city || ''}` : '当晚住宿与次日衔接'}</strong>
        <span>{stageChanged
          ? connection ? `${externalReference ? `参考交通建议：${externalReference.advisory}` : connectionSummary(connection)}${formatDuration(connection.durationSeconds ?? connection.duration_seconds) ? ` · ${formatDuration(connection.durationSeconds ?? connection.duration_seconds)}` : ''}` : '跨城方式与时间待确认'
          : accommodation?.area ? `返回 ${accommodation.area} 住宿，次日从住宿地出发` : '住宿地点待确认；次日起点将在确认后计算'}</span>
        {stageChanged && connection && <TransportChain leg={connection} compact />}
      </div>
      <span className="next-day-label">Day {nextDay.day ?? nextDay.dayNumber}</span>
    </aside>
  );
}

function overviewConnection(plan, routes, stages, index) {
  const stage = stages[index];
  const nextStage = stages[index + 1];
  const fromDay = Number(stage?.endDay ?? stage?.end_day);
  const toDay = Number(nextStage?.startDay ?? nextStage?.start_day);
  const embedded = findIntercityLeg(plan, stage || {}, nextStage, index);
  const routed = (routes || []).find(route => route.connection_to_day != null
    && Number(route.day) === fromDay
    && Number(route.connection_to_day) === toDay);
  if (!embedded) return routed || null;
  if (!routed) return embedded;
  return {
    ...embedded,
    ...routed,
    segments: routed.segments?.length ? routed.segments : embedded.segments,
    advisory_text: routeAdvisoryText(routed) || routeAdvisoryText(embedded) || null,
  };
}

function TripOverview({ plan, stages, routes, onSelectLeg }) {
  const connections = stages.slice(0, -1).map((stage, index) => {
    const nextStage = stages[index + 1];
    const connection = overviewConnection(plan, routes, stages, index);
    return { stage, nextStage, connection };
  }).filter(({ stage, nextStage, connection }) => (
    isActualIntercityTransition(stage, nextStage, connection)
  ));
  return (
    <section className="trip-overview-card" aria-labelledby="trip-overview-title">
      <div className="section-heading">
        <div>
          <strong id="trip-overview-title">全程跨城交通</strong>
          <p>地图显示全部已定位景点；有真实轨迹的跨城分段会按交通方式着色，需实时确认的线路不会绘制假轨迹。</p>
        </div>
        <span>{connections.length} 段跨城行程</span>
      </div>
      {connections.length ? (
        <div className="overview-connections">
          {connections.map(({ stage, nextStage, connection }, index) => (
            <article className="overview-connection" key={`${stage.id}-${nextStage.id}`}>
              <header>
                <div>
                  <span>跨城 {index + 1}</span>
                  <strong>{stage.city || '上一城市'} → {nextStage.city || '下一城市'}</strong>
                </div>
                {connection?.id && !externalDirectionsReference(connection) && (
                  <button type="button" onClick={() => onSelectLeg?.(connection.id, null)}>在地图查看</button>
                )}
              </header>
              <p className="overview-route-summary">
                {externalDirectionsReference(connection)
                  ? `参考交通建议：${externalDirectionsReference(connection).advisory}`
                  : connectionSummary(connection)}
              </p>
              <TransportChain leg={connection} />
            </article>
          ))}
        </div>
      ) : <p className="empty-day">当前行程只包含一个城市阶段。</p>}
    </section>
  );
}

export default function PlanPanel({
  plan,
  routes = [],
  health,
  selectedDay,
  onSelectDay,
  selectedNodeId,
  onSelectNode,
  selectedLegId,
  onSelectLeg,
  onEdit,
  editing = false,
  profile,
  parsedRequest,
  verification,
  geocodingWarnings = [],
  transitMarkers = [],
}) {
  if (!plan) return null;
  const days = Array.isArray(plan.days) ? plan.days : plan.daily_plans || [];
  if (!days.length) return <div className="plan-panel"><p className="empty-day">计划尚未包含可显示的日程。</p></div>;
  const accommodations = plan.accommodations?.length ? plan.accommodations : plan.accommodation ? [plan.accommodation] : [];
  const stages = deriveStages(plan, days, accommodations);
  const firstDayNumber = Number(days[0].day ?? days[0].dayNumber);
  const effectiveSelectedDay = selectedDay === null ? null : (selectedDay ?? firstDayNumber);
  const selectedIndex = Math.max(0, days.findIndex(day => Number(day.day ?? day.dayNumber) === Number(effectiveSelectedDay) || day.id === effectiveSelectedDay));
  const day = days[selectedIndex];
  const nextDay = days[selectedIndex + 1];
  const budget = profile?.budget || plan.profile?.budget || plan.preferences?.budget_details || (typeof plan.preferences?.budget === 'object' ? plan.preferences.budget : null);
  const budgetLabel = formatBudgetSummary(plan.budget_summary, budget);
  const healthStatus = String(health?.status || '').toLowerCase();
  const planBlocked = health?.passed === false || ['failed', 'blocked', 'blocking'].includes(healthStatus);
  const routeCompliance = googleRouteCompliance(plan, routes);

  return (
    <div className="plan-panel">
      <header className="plan-header">
        <div className="plan-title-row">
          <div>
            <span className="plan-eyebrow">{planBlocked ? '待修正行程草案' : '可执行行程'}</span>
            <h2>{plan.title || `${plan.city || '旅行'} ${plan.days || days.length} 日游`}</h2>
          </div>
          {budgetLabel && <span className="budget-summary">预算 · {budgetLabel}</span>}
        </div>
        {plan.summary && <p className="plan-summary">{plan.summary}</p>}
        {plan.route_reasoning && <p className="route-reasoning">路线逻辑：{plan.route_reasoning}</p>}
      </header>

      <PlanHealthDrawer
        health={health}
        parsedRequest={parsedRequest}
        verification={verification}
        geocodingWarnings={geocodingWarnings}
        transitMarkers={transitMarkers}
      />
      <RouteComplianceNotice compliance={routeCompliance} />
      <JourneyRail plan={plan} stages={stages} />
      <DayNavigator stages={stages} days={days} selectedDay={effectiveSelectedDay} onSelectDay={onSelectDay} />
      <div className="daily-plans">
        {effectiveSelectedDay === null ? (
          <TripOverview plan={plan} stages={stages} routes={routes} onSelectLeg={onSelectLeg} />
        ) : (
          <>
            <DayTimeline
              day={day}
              routes={routes}
              selectedNodeId={selectedNodeId}
              onSelectNode={onSelectNode}
              selectedLegId={selectedLegId}
              onSelectLeg={onSelectLeg}
              onEdit={onEdit}
              editing={editing}
            />
            <DayBoundaryCard day={day} nextDay={nextDay} plan={plan} stages={stages} />
          </>
        )}
      </div>

      {plan.practical_tips?.length > 0 && (
        <details className="tips-section">
          <summary>实用贴士（{plan.practical_tips.length}）</summary>
          <ul>{plan.practical_tips.map(tip => <li key={tip}>{tip}</li>)}</ul>
        </details>
      )}
    </div>
  );
}
