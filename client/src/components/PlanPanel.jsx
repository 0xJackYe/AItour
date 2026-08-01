import PlanHealthDrawer from './PlanHealthDrawer.jsx';

const TYPE_EMOJI = {
  attraction: '🏛️', restaurant: '🍜', transport: '🚇', hotel: '🏨',
  shopping: '🛍️', rest: '☕', free_time: '🌿', airport: '✈️', station: '🚉',
};

const MODE_LABELS = {
  WALK: '步行', TRANSIT: '公共交通', DRIVE: '驾车 / 打车', BICYCLE: '骑行',
  RAIL: '铁路', FLIGHT: '飞机', TAXI: '出租车', FERRY: '轮渡', UNKNOWN: '交通待确认',
};

function stablePart(value) {
  return String(value || 'item').trim().toLowerCase().replace(/[^a-z0-9\u3400-\u9fff]+/g, '-').replace(/^-|-$/g, '') || 'item';
}

function formatDistance(meters) {
  const value = Number(meters);
  if (!Number.isFinite(value) || value < 0) return null;
  return value >= 1000 ? `${(value / 1000).toFixed(1)} km` : `${Math.round(value)} m`;
}

function formatDuration(seconds) {
  const value = Number(seconds);
  if (!Number.isFinite(value) || value < 0) return null;
  const totalMinutes = Math.round(value / 60);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return hours ? `${hours}小时${minutes ? `${minutes}分钟` : ''}` : `${minutes}分钟`;
}

function formatClock(value) {
  if (!value) return '';
  const match = String(value).match(/(?:T|^)(\d{2}:\d{2})/);
  return match?.[1] || String(value);
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
                  <small>{connection ? `${MODE_LABELS[String(connection.mode || connection.travel_mode || 'RAIL').toUpperCase()] || '跨城交通'}${formatDuration(connection.durationSeconds ?? connection.duration_seconds) ? ` · ${formatDuration(connection.durationSeconds ?? connection.duration_seconds)}` : ''}` : '跨城交通待确认'}</small>
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
  return (
    <button
      type="button"
      className={`timeline-leg ${selected ? 'selected' : ''} ${unavailable || needsConfirmation ? 'unavailable' : ''}`}
      onClick={() => onSelect?.(leg.id, Number(day.day ?? day.dayNumber))}
      aria-pressed={selected}
      aria-label={`${MODE_LABELS[leg.mode] || leg.mode}，${description}`}
    >
      <span className="leg-line" aria-hidden="true" />
      <span className="leg-mode">{MODE_LABELS[leg.mode] || leg.mode}</span>
      <span>{description}</span>
      {leg.transfers != null && <span>换乘 {leg.transfers} 次</span>}
    </button>
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
  return (
    <aside className={`day-boundary-card ${stageChanged ? 'intercity' : ''}`}>
      <span className="boundary-line" aria-hidden="true" />
      <div className="boundary-copy">
        <strong>{stageChanged ? `${currentStage?.city || ''} → ${nextStage?.city || ''}` : '当晚住宿与次日衔接'}</strong>
        <span>{stageChanged
          ? connection ? `${MODE_LABELS[String(connection.mode || connection.travel_mode || 'RAIL').toUpperCase()] || '跨城交通'}${formatDuration(connection.durationSeconds ?? connection.duration_seconds) ? ` · ${formatDuration(connection.durationSeconds ?? connection.duration_seconds)}` : ''}` : '跨城方式与时间待确认'
          : accommodation?.area ? `返回 ${accommodation.area} 住宿，次日从住宿地出发` : '住宿地点待确认；次日起点将在确认后计算'}</span>
      </div>
      <span className="next-day-label">Day {nextDay.day ?? nextDay.dayNumber}</span>
    </aside>
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
  const planBlocked = health?.passed === false || String(health?.status || '').toLowerCase() === 'failed';

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
      <JourneyRail plan={plan} stages={stages} />
      <DayNavigator stages={stages} days={days} selectedDay={effectiveSelectedDay} onSelectDay={onSelectDay} />
      <div className="daily-plans">
        {effectiveSelectedDay === null ? (
          <section className="trip-overview-card">
            <strong>已切换到全程概览</strong>
            <p>地图只显示住宿、城市阶段和跨城连接。选择具体日期可查看逐项活动和真实交通段。</p>
          </section>
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
