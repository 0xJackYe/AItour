import { Fragment, memo } from 'react';
import { SPOT_TYPE_LABELS, describeLeg, formatDistance, formatDuration, formatHours } from '../lib/format.js';
import { dayColor, directionsModeFor, googleMapsDirectionsUrl, legsByOrigin, numberStops } from '../lib/plan.js';
import { describeTransfer } from '../lib/trip.js';
import Icon from './Icon.jsx';

// 城市间交通：车次 / 航班、出发与到达、时长票价、建议，以及地图与 Google 地图入口。
function TransferRow({ transfer, onFocusTransfer, as: Tag = 'li' }) {
  const info = describeTransfer(transfer);
  const located = Boolean(transfer.geometry?.length);
  return (
    <Tag className="transfer" aria-label={`城市间交通：${info.title}，${info.service}`}>
      <span className="transfer-icon" aria-hidden="true"><Icon name={info.icon} size={18} /></span>
      <div className="transfer-body">
        <p className="transfer-title">
          {info.title}
          <span className="transfer-mode">{info.roundTrip ? `${info.modeLabel} · 当天往返` : info.modeLabel}</span>
        </p>
        <p className="transfer-service">{[info.service, ...info.facts].join(' · ')}</p>
        {info.times && <p className="transfer-line">{info.times}</p>}
        {info.route && <p className="transfer-line">{info.route}</p>}
        {!info.times && !info.route && info.notes && <p className="transfer-line">{info.notes}</p>}
        {info.tips && (
          <p className="stop-tip">
            <Icon name="tip" size={14} />
            {info.tips}
          </p>
        )}
        <p className="transfer-actions">
          {located && (
            <button type="button" className="link-btn" onClick={() => onFocusTransfer(transfer)}>在地图上查看</button>
          )}
          {info.mapsUrl && <a href={info.mapsUrl} target="_blank" rel="noreferrer">Google 地图路线</a>}
          {info.schematic && <span className="transfer-hint">地图上为示意直线</span>}
        </p>
      </div>
    </Tag>
  );
}

const sum = values => values.filter(Number.isFinite).reduce((total, value) => total + value, 0);

// 换城市的日子把城际交通和市内路程分开写：示意线的直线距离不计入里程。
function dayMeta(route) {
  const legs = route?.legs || [];
  const intercity = legs.filter(leg => leg.mode === 'TRANSFER');
  const optimized = route?.optimized && route.saved_meters > 0 ? `已优化顺序，少走 ${formatDistance(route.saved_meters)}` : '';
  if (intercity.length === 0) {
    return [
      formatDistance(route?.distance_meters),
      route?.duration_seconds ? `交通约 ${formatDuration(route.duration_seconds)}` : '',
      optimized,
    ].filter(Boolean);
  }
  const local = legs.filter(leg => leg.mode !== 'TRANSFER');
  const localDistance = formatDistance(sum(local.map(leg => leg.distance_meters)));
  const localDuration = formatDuration(sum(local.map(leg => leg.duration_seconds)));
  const intercityDuration = formatDuration(sum(intercity.map(leg => leg.duration_seconds)));
  return [
    intercityDuration ? `城际交通约 ${intercityDuration}` : '城际交通',
    localDistance || localDuration ? `市内 ${[localDistance, localDuration ? `约 ${localDuration}` : ''].filter(Boolean).join('，')}` : '',
    optimized,
  ].filter(Boolean);
}

function DaySection({
  day,
  route,
  transfers = [],
  preference,
  onFocusSpot,
  onFocusTransfer = () => {},
  focusedId,
  groundingAvailable = true,
}) {
  const color = dayColor(day.day);
  const stops = numberStops(day.spots || [], day.day, { numberAll: !groundingAvailable });
  const legs = legsByOrigin(route);
  // 出发站与到达站相邻的城际交通显示在两站之间；其余（从住宿出发、一日游往返）显示在当天开头。
  const attached = new Map(transfers.filter(item => item.attached_leg).map(item => [item.attached_leg.from_id, item]));
  const leading = transfers.filter(item => !item.attached_leg);
  const navigationUrl = googleMapsDirectionsUrl(day.spots || [], { travelMode: directionsModeFor(route, preference) });
  const meta = dayMeta(route);

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
        {leading.map(transfer => (
          <TransferRow key={transfer.id || `${transfer.from_city}-${transfer.to_city}`} transfer={transfer} onFocusTransfer={onFocusTransfer} />
        ))}
        {stops.map(({ spot, key, order }) => {
          const leg = spot.location_id ? legs.get(spot.location_id) : null;
          const transfer = spot.location_id ? attached.get(spot.location_id) : null;
          const legInfo = transfer ? null : describeLeg(leg);
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
                      <button type="button" className="stop-name" onClick={() => onFocusSpot(key, day.day)}>
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
              {transfer && <TransferRow transfer={transfer} onFocusTransfer={onFocusTransfer} />}
              {legInfo && (
                <li className={`leg ${legInfo.transfer ? 'is-transfer' : ''}`} aria-label={`前往下一站：${legInfo.label}`}>
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

// 视图切换时其他天的属性不变，跳过重新渲染。
export default memo(DaySection);
