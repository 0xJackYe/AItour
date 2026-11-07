import { BUDGET_LABELS, PACE_LABELS, TRANSPORT_LABELS } from '../lib/format.js';
import { accommodationsOf, dayColor, planTitle } from '../lib/plan.js';
import DaySection from './DaySection.jsx';
import Icon from './Icon.jsx';
import QualityNotice from './QualityNotice.jsx';

function factsFor(plan, parsedRequest) {
  const destinations = (parsedRequest?.destinations?.length ? parsedRequest.destinations : plan.destinations || [])
    .map(item => item.city)
    .filter(Boolean);
  const uniqueDestinations = destinations.filter((city, index) => destinations.indexOf(city) === index);
  const preferences = plan.preferences || parsedRequest?.preferences || {};
  const transport = parsedRequest?.constraints?.transport || preferences.transport;
  return [
    uniqueDestinations.length > 1 ? uniqueDestinations.join(' → ') : plan.city || uniqueDestinations[0],
    plan.days ? `${plan.days} 天` : '',
    PACE_LABELS[preferences.pace] ? `节奏${PACE_LABELS[preferences.pace]}` : '',
    BUDGET_LABELS[preferences.budget] || '',
    transport && transport !== 'public_transit' ? TRANSPORT_LABELS[transport] : '',
    ...(preferences.interests || []).slice(0, 3),
  ].filter(Boolean);
}

function Accommodations({ items, transitMarkers }) {
  const showCity = new Set(items.map(item => item.city)).size > 1;
  return (
    <section className="stay" aria-label="住宿建议">
      <h3><Icon name="hotel" size={18} />住宿建议</h3>
      {items.map((item, index) => {
        const stations = transitMarkers.filter(marker =>
          marker.accommodation_index === index || (marker.accommodation_index === undefined && index === 0));
        return (
          <div key={`${item.city}-${item.area}-${index}`} className="stay-item">
            <p className="stay-area">
              {showCity && item.city && <span className="tag">{item.city}</span>}
              {item.area}
            </p>
            {item.reason && <p className="stay-reason">{item.reason}</p>}
            {stations.length > 0 && (
              <p className="stay-transit">
                <Icon name="transit" size={14} />
                附近站点：{stations.map(station => station.name).join(' · ')}
              </p>
            )}
          </div>
        );
      })}
    </section>
  );
}

function DayFilter({ days, selected, onSelect }) {
  return (
    <div className="day-filter" role="group" aria-label="按天查看">
      <button type="button" className="filter-chip" aria-pressed={selected === null} onClick={() => onSelect(null)}>
        全部
      </button>
      {days.map(day => (
        <button
          key={day.day}
          type="button"
          className="filter-chip"
          aria-pressed={selected === day.day}
          style={{ '--day-color': dayColor(day.day) }}
          onClick={() => onSelect(selected === day.day ? null : day.day)}
        >
          <span className="filter-dot" aria-hidden="true" />
          第 {day.day} 天
        </button>
      ))}
    </div>
  );
}

export default function PlanView({ result, selectedDay, onSelectDay, onFocusSpot, focusedId }) {
  const { plan, routes, parsedRequest, transitMarkers } = result;
  const days = plan.daily_plans || [];
  const visibleDays = selectedDay === null ? days : days.filter(day => day.day === selectedDay);
  const preference = parsedRequest?.constraints?.transport || plan.preferences?.transport;
  const accommodations = accommodationsOf(plan);

  return (
    <section className="plan" aria-label="行程详情">
      <header className="plan-head">
        <h2>{planTitle(plan)}</h2>
        {plan.summary && <p className="plan-summary">{plan.summary}</p>}
        <ul className="facts" aria-label="行程概况">
          {factsFor(plan, parsedRequest).map(fact => <li key={fact}>{fact}</li>)}
        </ul>
      </header>

      <QualityNotice result={result} />

      {accommodations.length > 0 && <Accommodations items={accommodations} transitMarkers={transitMarkers || []} />}

      {days.length > 1 && <DayFilter days={days} selected={selectedDay} onSelect={onSelectDay} />}

      <div className="days">
        {visibleDays.map(day => (
          <DaySection
            key={day.day}
            day={day}
            route={routes.find(route => route.day === day.day)}
            preference={preference}
            onFocusSpot={onFocusSpot}
            focusedId={focusedId}
          />
        ))}
      </div>

      {plan.route_reasoning && (
        <details className="more">
          <summary>路线思路<Icon name="expand" size={18} className="chevron" /></summary>
          <p>{plan.route_reasoning}</p>
        </details>
      )}
      {plan.practical_tips?.length > 0 && (
        <details className="more">
          <summary>实用贴士<Icon name="expand" size={18} className="chevron" /></summary>
          <ul>
            {plan.practical_tips.map(tip => <li key={tip}>{tip}</li>)}
          </ul>
        </details>
      )}

      <p className="disclaimer">行程由 AI 生成并经 Google 地图校验，出行前请再次确认开放时间、票务与交通班次。</p>
    </section>
  );
}
