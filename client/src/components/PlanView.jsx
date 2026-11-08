import { useEffect, useMemo, useState } from 'react';
import { BUDGET_LABELS, PACE_LABELS, TRANSPORT_LABELS, describeBudget } from '../lib/format.js';
import { markdownToPlainText, planToMarkdown } from '../lib/markdown.js';
import { accommodationsOf, dayColor, isGroundingAvailable, planTitle } from '../lib/plan.js';
import { cityGroups, dayRangeLabel, describeTransfer, routeOutline, visibleDays as daysInView } from '../lib/trip.js';
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

// 出发前要知道的三件事合并成一张卡片：住哪里、花多少、要提前订什么。
function TripPrep({ plan, accommodations, transitMarkers }) {
  const budget = describeBudget(plan.budget_estimate);
  const bookings = plan.booking_tips || [];
  if (accommodations.length === 0 && !budget && bookings.length === 0) return null;
  const showCity = new Set(accommodations.map(item => item.city)).size > 1;
  return (
    <section className="prep" aria-label="出发前准备">
      <h3><Icon name="wallet" size={18} />出发前准备</h3>
      <dl className="prep-rows">
        {accommodations.length > 0 && (
          <>
            <dt>住宿</dt>
            <dd>
              {accommodations.map((item, index) => {
                const stations = transitMarkers.filter(marker =>
                  marker.accommodation_index === index || (marker.accommodation_index === undefined && index === 0));
                return (
                  <div key={`${item.city}-${item.area}-${index}`} className="stay-item">
                    <p className="stay-area">
                      {showCity && item.city && <span className="tag">{item.city}</span>}
                      {item.area}
                      {item.price_hint && <span className="stay-price">{item.price_hint}</span>}
                    </p>
                    {(item.reason || stations.length > 0) && (
                      <p className="stay-reason">
                        {[item.reason, stations.length ? `附近：${stations.map(station => station.name).join('、')}` : ''].filter(Boolean).join(' · ')}
                      </p>
                    )}
                  </div>
                );
              })}
            </dd>
          </>
        )}
        {budget && (
          <>
            <dt>预算</dt>
            <dd>
              <p>
                <strong>{budget.total}</strong>
                {budget.note && <span className="prep-note">（{budget.note}）</span>}
              </p>
              {budget.items.length > 0 && <p className="prep-breakdown">{budget.items.join(' · ')}</p>}
            </dd>
          </>
        )}
        {bookings.length > 0 && (
          <>
            <dt>预订</dt>
            <dd>
              <ul className="prep-list">
                {bookings.map(item => <li key={item}>{item}</li>)}
              </ul>
            </dd>
          </>
        )}
      </dl>
    </section>
  );
}

async function copyText(value) {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(value);
      return true;
    }
  } catch {
    // 回退到 execCommand（非安全上下文或权限被拒绝时）。
  }
  const area = document.createElement('textarea');
  area.value = value;
  area.setAttribute('readonly', '');
  area.style.position = 'fixed';
  area.style.opacity = '0';
  document.body.append(area);
  area.select();
  const copied = document.execCommand('copy');
  area.remove();
  return copied;
}

// 多城市行程：第一行“总览 + 城市”，选中城市后第二行是这个城市的每一天；
// 单城市行程只有“全部 + 每一天”一行。
function ViewFilter({ groups, days, view, onViewChange }) {
  const multiCity = groups.length > 1;
  const activeGroup = multiCity ? groups.find(group => group.key === view.city) : groups[0];
  const dayList = activeGroup ? days.filter(day => activeGroup.days.includes(day.day)) : [];
  const cityKeyOf = dayNumber => groups.find(group => group.days.includes(dayNumber))?.key ?? null;
  return (
    <div className="day-filter" role="group" aria-label={multiCity ? '按城市和天查看' : '按天查看'}>
      {multiCity && (
        <div className="filter-row">
          <button type="button" className="filter-chip" aria-pressed={view.city === null && view.day === null} onClick={() => onViewChange({ city: null, day: null })}>
            <Icon name="route" size={16} />
            总览
          </button>
          {groups.map(group => (
            <button
              key={group.key}
              type="button"
              className="filter-chip"
              aria-pressed={view.city === group.key && view.day === null}
              onClick={() => onViewChange({ city: group.key, day: null })}
            >
              {group.name}
              <span className="chip-count">{group.days.length} 天</span>
            </button>
          ))}
        </div>
      )}
      {dayList.length > 1 && (
        <div className="filter-row">
          <button
            type="button"
            className="filter-chip"
            aria-pressed={view.day === null && (!multiCity || view.city !== null)}
            onClick={() => onViewChange({ city: multiCity ? activeGroup.key : null, day: null })}
          >
            {multiCity ? `${activeGroup.name}全部` : '全部'}
          </button>
          {dayList.map(day => (
            <button
              key={day.day}
              type="button"
              className="filter-chip"
              aria-pressed={view.day === day.day}
              style={{ '--day-color': dayColor(day.day) }}
              onClick={() => onViewChange(view.day === day.day
                ? { city: multiCity ? cityKeyOf(day.day) : null, day: null }
                : { city: multiCity ? cityKeyOf(day.day) : null, day: day.day })}
            >
              <span className="filter-dot" aria-hidden="true" />
              第 {day.day} 天
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// 城市之间怎么走：城市段与城市间交通按时间顺序排列，点城市看城市内路线，点交通看这段路线。
function RouteCard({ plan, transfers, onViewChange, onFocusTransfer }) {
  const items = routeOutline(plan, transfers);
  return (
    <section className="route-card" aria-label="城市间路线">
      <h3><Icon name="route" size={18} />路线</h3>
      <ol className="route-list">
        {items.map((item) => {
          if (item.type === 'city') {
            return (
              <li key={`city-${item.run.key}-${item.run.days[0]}`} className="route-city">
                <button type="button" onClick={() => onViewChange({ city: item.run.key, day: null })}>
                  <span className="route-dot" aria-hidden="true" />
                  <strong>{item.run.name}</strong>
                  <span className="route-days">{dayRangeLabel(item.run.days)}</span>
                </button>
              </li>
            );
          }
          const info = describeTransfer(item.transfer);
          return (
            <li key={item.transfer.id || `${item.transfer.day}-${item.transfer.to_city}`} className="route-transfer">
              <button type="button" onClick={() => onFocusTransfer(item.transfer)} title="在地图上查看这段路线">
                <Icon name={info.icon} size={16} />
                <span className="route-transfer-main">
                  {info.roundTrip ? `${info.title} · ` : ''}{info.service}{info.duration ? ` · ${info.duration}` : ''}
                </span>
                <span className="route-transfer-meta">
                  {[`第 ${item.transfer.day} 天`, item.transfer.cost].filter(Boolean).join(' · ')}
                </span>
              </button>
            </li>
          );
        })}
      </ol>
    </section>
  );
}

const NO_TRANSFERS = [];

export default function PlanView({ result, view, onViewChange, onFocusSpot, onFocusTransfer, focus }) {
  const { plan, routes, parsedRequest, transitMarkers } = result;
  const transfers = result.transfers || NO_TRANSFERS;
  const days = plan.daily_plans || [];
  const groups = useMemo(() => cityGroups(plan), [plan]);
  const visible = useMemo(() => new Set(daysInView(plan, view).map(day => day.day)), [plan, view]);
  // 每天的城际交通与路线按天预先分组，保证属性引用稳定，DaySection 才能跳过重渲染。
  const byDay = useMemo(() => {
    const map = new Map(days.map(day => [day.day, { route: undefined, transfers: NO_TRANSFERS }]));
    for (const route of routes || []) if (map.has(route.day)) map.get(route.day).route = route;
    for (const transfer of transfers) {
      const entry = map.get(transfer.day);
      if (entry) entry.transfers = entry.transfers === NO_TRANSFERS ? [transfer] : [...entry.transfers, transfer];
    }
    return map;
  }, [days, routes, transfers]);
  const preference = parsedRequest?.constraints?.transport || plan.preferences?.transport;
  const accommodations = accommodationsOf(plan);
  const groundingAvailable = isGroundingAvailable(result);
  const [notice, setNotice] = useState('');

  useEffect(() => {
    if (!notice) return undefined;
    const timer = setTimeout(() => setNotice(''), 2500);
    return () => clearTimeout(timer);
  }, [notice]);

  const handleCopy = async () => {
    const copied = await copyText(markdownToPlainText(planToMarkdown(result)));
    setNotice(copied ? '已复制，可以直接粘贴到微信或备忘录' : '复制失败，请改用打印存为 PDF');
  };

  const handlePrint = () => {
    // 打印完整行程：回到总览并展开折叠内容。
    onViewChange({ city: null, day: null });
    setTimeout(() => {
      document.querySelectorAll('.plan details').forEach((element) => {
        element.open = true;
      });
      window.print();
    }, 60);
  };

  return (
    <section className="plan" aria-label="行程详情">
      <header className="plan-head">
        <div className="plan-title-row">
          <h2>{planTitle(plan)}</h2>
          <div className="plan-actions">
            <button type="button" className="icon-btn" onClick={handleCopy} title="复制行程文字" aria-label="复制行程文字">
              <Icon name="copy" size={18} />
            </button>
            <button type="button" className="icon-btn" onClick={handlePrint} title="打印或存为 PDF" aria-label="打印或存为 PDF">
              <Icon name="print" size={18} />
            </button>
          </div>
        </div>
        {notice && <p className="plan-notice" role="status">{notice}</p>}
        {plan.summary && <p className="plan-summary">{plan.summary}</p>}
        <ul className="facts" aria-label="行程概况">
          {factsFor(plan, parsedRequest).map(fact => <li key={fact}>{fact}</li>)}
        </ul>
      </header>

      <QualityNotice result={result} />

      {(groups.length > 1 || transfers.length > 0) && (
        <RouteCard plan={plan} transfers={transfers} onViewChange={onViewChange} onFocusTransfer={onFocusTransfer} />
      )}

      <TripPrep plan={plan} accommodations={accommodations} transitMarkers={transitMarkers || []} />

      {days.length > 1 && <ViewFilter groups={groups} days={days} view={view} onViewChange={onViewChange} />}

      {/* 所有天都保持挂载，切换视图只改 hidden：长行程切换城市 / 天时不需要重建整段列表。 */}
      <div className="days">
        {days.map(day => (
          <div key={day.day} className="day-slot" hidden={!visible.has(day.day)}>
            <DaySection
              day={day}
              route={byDay.get(day.day)?.route}
              transfers={byDay.get(day.day)?.transfers || NO_TRANSFERS}
              preference={preference}
              onFocusSpot={onFocusSpot}
              onFocusTransfer={onFocusTransfer}
              focusedId={focus?.type === 'spot' && focus.day === day.day ? focus.id : null}
              groundingAvailable={groundingAvailable}
            />
          </div>
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
