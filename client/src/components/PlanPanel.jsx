const DAY_COLORS = ['#e74c3c', '#3498db', '#2ecc71', '#f39c12', '#9b59b6', '#1abc9c', '#e67e22'];

const TYPE_EMOJI = {
  attraction: '🏛️',
  restaurant: '🍜',
  transport: '🚇',
  hotel: '🏨',
  shopping: '🛍️',
};

function formatDistance(meters) {
  if (!meters) return null;
  return meters >= 1000 ? `${(meters / 1000).toFixed(1)} km` : `${Math.round(meters)} m`;
}

function formatDuration(seconds) {
  if (!seconds) return null;
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.round((seconds % 3600) / 60);
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

export default function PlanPanel({ plan, selectedDay, onSelectDay, routes = [] }) {
  if (!plan) return null;
  const accommodations = plan.accommodations?.length
    ? plan.accommodations
    : plan.accommodation
      ? [plan.accommodation]
      : [];

  return (
    <div className="plan-panel">
      <div className="plan-header">
        <h2>{plan.title || `${plan.city} ${plan.days}日游`}</h2>
        <p className="plan-summary">{plan.summary}</p>
        {plan.route_reasoning && (
          <p className="route-reasoning">📍 {plan.route_reasoning}</p>
        )}
      </div>

      {accommodations.length > 0 && (
        <div className="accommodation-card">
          <h3>🏨 推荐住宿</h3>
          {accommodations.map((item, index) => (
            <div className="accommodation-entry" key={`${item.city || ''}-${item.area || ''}-${index}`}>
              <p className="area">
                {item.city && <span>{item.city} · </span>}
                {item.area}
              </p>
              <p className="reason">{item.reason}</p>
            </div>
          ))}
        </div>
      )}

      <div className="day-tabs">
        <button className={`day-tab ${selectedDay === null ? 'active' : ''}`} onClick={() => onSelectDay(null)}>
          全部
        </button>
        {(plan.daily_plans || []).map((day) => (
          <button
            key={day.day}
            className={`day-tab ${selectedDay === day.day ? 'active' : ''}`}
            style={{ '--tab-color': DAY_COLORS[(day.day - 1) % DAY_COLORS.length] }}
            onClick={() => onSelectDay(day.day)}
          >
            Day {day.day}
          </button>
        ))}
      </div>

      <div className="daily-plans">
        {(plan.daily_plans || [])
          .filter(day => selectedDay === null || selectedDay === day.day)
          .map((day) => {
            const color = DAY_COLORS[(day.day - 1) % DAY_COLORS.length];
            const route = routes.find(r => r.day === day.day);
            return (
              <div key={day.day} className="day-card">
                <div className="day-title" style={{ borderLeftColor: color }}>
                  <span className="day-badge" style={{ background: color }}>
                    Day {day.day}
                  </span>
                  <span className="day-theme">{day.theme}</span>
                  {(day.city || day.country) && (
                    <span className="day-location">📍 {[day.city, day.country].filter(Boolean).join(' · ')}</span>
                  )}
                </div>
                {(route?.distance_meters || route?.duration_seconds) && (
                  <div className="route-meta">
                    <span>Google {route.travel_mode === 'WALK' ? '步行' : '路线'}</span>
                    {route.distance_meters && <span>路线约 {formatDistance(route.distance_meters)}</span>}
                    {route.duration_seconds && <span>预计交通 {formatDuration(route.duration_seconds)}</span>}
                  </div>
                )}
                <div className="spots-list">
                  {(day.spots || []).map((spot, i) => (
                    <div key={i} className="spot-item">
                      <span className="spot-emoji">{TYPE_EMOJI[spot.type] || '📍'}</span>
                      <div className="spot-info">
                        <strong>{spot.name}</strong>
                        {spot.duration_hours && <span className="duration">{spot.duration_hours}h</span>}
                        {spot.description && <p>{spot.description}</p>}
                        {spot.tips && <p className="tip">💡 {spot.tips}</p>}
                        {!spot.coordinates && <span className="no-coord">⚠️ 未定位</span>}
                      </div>
                    </div>
                  ))}
                </div>
                {day.transport_notes && <p className="transport-notes">🚌 {day.transport_notes}</p>}
              </div>
            );
          })}
      </div>

      {plan.practical_tips?.length > 0 && (
        <div className="tips-section">
          <h3>💡 实用贴士</h3>
          <ul>
            {plan.practical_tips.map((tip, i) => (
              <li key={i}>{tip}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
