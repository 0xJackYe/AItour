import { useEffect, useState } from 'react';
import { BUDGET_LABELS, PACE_LABELS, TRANSPORT_LABELS, describeBudget } from '../lib/format.js';
import { markdownToPlainText, planToMarkdown } from '../lib/markdown.js';
import { accommodationsOf, dayColor, isGroundingAvailable, planTitle } from '../lib/plan.js';
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
    // 打印完整行程：取消按天筛选并展开折叠内容。
    onSelectDay(null);
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

      <TripPrep plan={plan} accommodations={accommodations} transitMarkers={transitMarkers || []} />

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
            groundingAvailable={groundingAvailable}
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
