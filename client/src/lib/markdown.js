// 把行程渲染成一份人可以直接阅读、打印或分享的文档（纯函数）。
// 评测脚本用它输出可读样例；前端“复制行程”也复用同一份逻辑。

import {
  BUDGET_LABELS,
  PACE_LABELS,
  SPOT_TYPE_LABELS,
  TRANSPORT_LABELS,
  describeBudget,
  describeLeg,
  formatDistance,
  formatDuration,
  formatHours,
} from './format.js';
import { accommodationsOf, isGroundingAvailable, legsByOrigin, planTitle, summarizeQuality } from './plan.js';
import { describeTransfer, transfersOnDay } from './trip.js';

function transferLine(transfer) {
  const info = describeTransfer(transfer);
  const details = [info.times, info.route].filter(Boolean).join('；');
  return `${info.title}：${[info.service, ...info.facts].join(' · ')}${details ? `（${details}）` : ''}`;
}

function factsLine(plan, parsedRequest) {
  const preferences = plan.preferences || {};
  const route = [...new Set((plan.destinations || []).map(item => item.city).filter(Boolean))];
  const transport = parsedRequest?.constraints?.transport || preferences.transport;
  return [
    route.length > 1 ? route.join(' → ') : plan.city || route[0],
    plan.days ? `${plan.days} 天` : '',
    PACE_LABELS[preferences.pace] ? `节奏${PACE_LABELS[preferences.pace]}` : '',
    BUDGET_LABELS[preferences.budget] || '',
    TRANSPORT_LABELS[transport] || '',
    (preferences.interests || []).join('、'),
  ].filter(Boolean).join(' · ');
}

function stopLine(number, spot, { flagUnlocated }) {
  const facts = [
    SPOT_TYPE_LABELS[spot.type] || '',
    formatHours(spot.duration_hours) ? `约 ${formatHours(spot.duration_hours)}` : '',
    spot.cost || '',
  ].filter(Boolean);
  const time = spot.start_time ? `${spot.start_time} ` : '';
  const flag = flagUnlocated && !spot.coordinates ? '（地图上未能核实）' : '';
  return `${number}. ${time}**${spot.name}**${facts.length ? `（${facts.join(' · ')}）` : ''}${flag}`;
}

export function planToMarkdown(result) {
  if (!result?.plan) return '';
  const { plan, routes = [], transitMarkers = [], parsedRequest } = result;
  const groundingAvailable = isGroundingAvailable(result);
  const out = [`# ${planTitle(plan)}`, ''];
  if (plan.summary) out.push(`> ${plan.summary}`, '');
  const facts = factsLine(plan, parsedRequest);
  if (facts) out.push(`**${facts}**`, '');

  const quality = summarizeQuality(result);
  if (quality.headline) out.push(`质量检查：${quality.headline}${quality.issueCount ? `（${quality.issueCount} 条提示）` : ''}`, '');

  const budget = describeBudget(plan.budget_estimate);
  if (budget || plan.booking_tips?.length) {
    out.push('## 出发前准备', '');
    if (budget) {
      out.push(`- 预算：${budget.total}${budget.note ? `（${budget.note}）` : ''}`);
      if (budget.items.length) out.push(`  ${budget.items.join(' · ')}`);
    }
    for (const tip of plan.booking_tips || []) out.push(`- 预订：${tip}`);
    out.push('');
  }

  const accommodations = accommodationsOf(plan);
  if (accommodations.length) {
    out.push('## 住宿建议', '');
    accommodations.forEach((item, index) => {
      const stations = transitMarkers
        .filter(marker => marker.accommodation_index === index || (marker.accommodation_index === undefined && index === 0))
        .map(marker => marker.name);
      out.push([
        `- **${[item.city, item.area].filter(Boolean).join(' · ')}**`,
        item.price_hint ? `（${item.price_hint}）` : '',
        item.reason ? `：${item.reason}` : '',
        stations.length ? `；附近站点：${stations.join('、')}` : '',
      ].join(''));
    });
    out.push('');
  }

  const transfers = result.transfers || plan.transfers || [];
  if (transfers.length) {
    out.push('## 城市间交通', '');
    for (const transfer of transfers) {
      out.push(`- 第 ${transfer.day} 天 · ${transferLine(transfer)}`);
      if (transfer.tips) out.push(`  提示：${transfer.tips}`);
    }
    out.push('');
  }

  for (const day of plan.daily_plans || []) {
    const route = routes.find(item => item.day === day.day);
    out.push(`## 第 ${day.day} 天 · ${day.theme || day.city || ''}`.trimEnd(), '');
    const meta = [
      day.city,
      formatDistance(route?.distance_meters) ? `全程约 ${formatDistance(route.distance_meters)}` : '',
      route?.duration_seconds ? `路上约 ${formatDuration(route.duration_seconds)}` : '',
    ].filter(Boolean);
    if (meta.length) out.push(`*${meta.join(' · ')}*`, '');

    const legs = legsByOrigin(route);
    // 从住宿出发或一日游往返的城际交通放在当天开头。
    for (const transfer of transfersOnDay(transfers, day.day).filter(item => !item.attached_leg)) {
      out.push(`城际交通：${transferLine(transfer)}`, '');
    }
    (day.spots || []).forEach((spot, index) => {
      out.push(stopLine(index + 1, spot, { flagUnlocated: groundingAvailable }));
      if (spot.description) out.push(`   ${spot.description}`);
      if (spot.tips) out.push(`   提示：${spot.tips}`);
      const leg = spot.location_id ? describeLeg(legs.get(spot.location_id)) : null;
      if (leg) out.push(`   ↓ ${leg.label}`);
    });
    if (day.transport_notes) out.push('', `交通：${day.transport_notes}`);
    out.push('');
  }

  if (plan.route_reasoning) out.push('## 路线思路', '', plan.route_reasoning, '');
  if (plan.practical_tips?.length) {
    out.push('## 实用贴士', '', ...plan.practical_tips.map(tip => `- ${tip}`), '');
  }
  out.push('---', '', '行程由 AI 生成，出行前请再次确认开放时间、票务与交通班次。', '');
  return out.join('\n');
}

/** Markdown → 适合粘贴到微信、备忘录的纯文本。 */
export function markdownToPlainText(markdown) {
  return String(markdown || '')
    .replace(/^#{1,6}\s+(.*)$/gm, (_, title) => `【${title}】`)
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/^\*(.+)\*$/gm, '$1')
    .replace(/^>\s?/gm, '')
    .replace(/^---$/gm, '────────');
}
