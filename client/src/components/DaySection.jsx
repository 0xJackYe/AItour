import { Fragment } from 'react';
import { SPOT_TYPE_LABELS, describeLeg, formatDistance, formatDuration, formatHours } from '../lib/format.js';
import { dayColor, directionsModeFor, googleMapsDirectionsUrl, legsByOrigin, numberStops } from '../lib/plan.js';
import Icon from './Icon.jsx';

export default function DaySection({ day, route, preference, onFocusSpot, focusedId, groundingAvailable = true }) {
  const color = dayColor(day.day);
  const stops = numberStops(day.spots || [], day.day, { numberAll: !groundingAvailable });
  const legs = legsByOrigin(route);
  const navigationUrl = googleMapsDirectionsUrl(day.spots || [], { travelMode: directionsModeFor(route, preference) });
  const meta = [
    formatDistance(route?.distance_meters),
    route?.duration_seconds ? `交通约 ${formatDuration(route.duration_seconds)}` : '',
    route?.optimized && route.saved_meters > 0 ? `已优化顺序，少走 ${formatDistance(route.saved_meters)}` : '',
  ].filter(Boolean);

  return (
    <article className="day" style={{ '--day-color': color }} aria-labelledby={`day-${day.day}-title`}>
      <header className="day-head">
        <div className="day-heading">
          <p className="day-overline">
            第 {day.day} 天{day.city ? ` · ${day.city}` : ''}
          </p>
          <h3 id={`day-${day.day}-title`}>{day.theme || `第 ${day.day} 天`}</h3>
          {meta.length > 0 && <p className="day-meta">{meta.join(' · ')}</p>}
        </div>
        {navigationUrl && (
          <a className="icon-btn" href={navigationUrl} target="_blank" rel="noreferrer" title="在 Google 地图中打开当天路线">
            <Icon name="open" size={18} />
            <span className="visually-hidden">在 Google 地图中打开第 {day.day} 天路线</span>
          </a>
        )}
      </header>

      <ol className="timeline">
        {stops.map(({ spot, key, order }) => {
          const leg = spot.location_id ? legs.get(spot.location_id) : null;
          const legInfo = describeLeg(leg);
          const typeLabel = SPOT_TYPE_LABELS[spot.type];
          const facts = [
            typeLabel && typeLabel !== '景点' ? typeLabel : '',
            formatHours(spot.duration_hours) ? `约 ${formatHours(spot.duration_hours)}` : '',
            spot.cost || '',
          ].filter(Boolean);
          const unlocated = groundingAvailable && !spot.coordinates;
          return (
            <Fragment key={key}>
              <li className={`stop ${unlocated ? 'is-unlocated' : ''} ${focusedId === key ? 'is-focused' : ''}`}>
                <span className="stop-marker" aria-hidden="true">{order ?? '·'}</span>
                <div className="stop-body">
                  <div className="stop-title">
                    {spot.start_time && <time className="stop-time">{spot.start_time}</time>}
                    {spot.coordinates ? (
                      <button type="button" className="stop-name" onClick={() => onFocusSpot(key)}>
                        {spot.name}
                      </button>
                    ) : (
                      <span className="stop-name">{spot.name}</span>
                    )}
                    {unlocated && <span className="tag tag-warn" title="Google 地图上未能确认该地点">未定位</span>}
                  </div>
                  {facts.length > 0 && <p className="stop-facts">{facts.join(' · ')}</p>}
                  {spot.description && <p className="stop-desc">{spot.description}</p>}
                  {spot.tips && (
                    <p className="stop-tip">
                      <Icon name="tip" size={14} />
                      {spot.tips}
                    </p>
                  )}
                </div>
              </li>
              {legInfo && (
                <li className="leg" aria-label={`前往下一站：${legInfo.label}`}>
                  <Icon name={legInfo.icon} size={16} />
                  <span>{legInfo.label}</span>
                </li>
              )}
            </Fragment>
          );
        })}
      </ol>

      {day.transport_notes && (
        <p className="day-note">
          <Icon name="transit" size={16} />
          {day.transport_notes}
        </p>
      )}
    </article>
  );
}
