function issue(severity, code, message, path = null) {
  return { severity, code, message, path };
}

function clockMinutes(value) {
  const match = String(value || '').match(/T?(\d{2}):(\d{2})/);
  return match ? Number(match[1]) * 60 + Number(match[2]) : null;
}

function clockLabel(value) {
  return String(value || '').match(/(?:T|^)(\d{2}:\d{2})/)?.[1] || String(value || '');
}

export function validatePlanHealth(plan, profile = plan?.profile || {}) {
  const blockers = [];
  const warnings = [];
  const days = Array.isArray(plan?.daily_plans) ? plan.daily_plans : [];
  const expectedDays = Number(profile.days || plan?.days);

  if (!days.length) blockers.push(issue('blocking', 'PLAN_EMPTY', '计划不包含任何日程', 'daily_plans'));
  if (expectedDays && days.length !== expectedDays) {
    blockers.push(issue('blocking', 'DAY_COUNT_MISMATCH', `期望 ${expectedDays} 天，实际生成 ${days.length} 天`, 'daily_plans'));
  }

  const expectedNumbers = Array.from({ length: days.length }, (_, index) => index + 1);
  if (days.some((day, index) => Number(day.day) !== expectedNumbers[index])) {
    blockers.push(issue('blocking', 'DAY_SEQUENCE_INVALID', '日程必须从 Day 1 连续且不重复', 'daily_plans'));
  }

  const allNodeIds = new Set();
  const allLegIds = new Set();
  let availableLegs = 0;
  let totalLegs = 0;
  let routeDistance = 0;
  let routeDuration = 0;
  const allowedModes = new Set((profile.transport?.allowedModes || []).map(mode => String(mode).toUpperCase()));
  const avoidedModes = new Set((profile.transport?.avoidModes || []).map(mode => String(mode).toUpperCase()));

  if (!profile.startDate) {
    warnings.push(issue('warning', 'START_DATE_MISSING', '未提供开始日期；公共交通仅能按近期时刻测算，出发前需按实际日期复核', 'profile.startDate'));
  }

  days.forEach((day, dayIndex) => {
    const path = `daily_plans[${dayIndex}]`;
    const nodes = Array.isArray(day.nodes) ? day.nodes : [];
    const legs = Array.isArray(day.legs) ? day.legs : [];
    const nodeIds = new Set(nodes.map(node => node.id));
    let walkingDistance = 0;

    if (!day.id) blockers.push(issue('blocking', 'DAY_ID_MISSING', `Day ${day.day} 缺少稳定 ID`, `${path}.id`));
    if (!day.start_anchor || !nodeIds.has(day.start_anchor)) {
      blockers.push(issue('blocking', 'START_ANCHOR_MISSING', `Day ${day.day} 缺少有效起点`, `${path}.start_anchor`));
    }
    if (!day.end_anchor || !nodeIds.has(day.end_anchor)) {
      blockers.push(issue('blocking', 'END_ANCHOR_MISSING', `Day ${day.day} 缺少有效终点`, `${path}.end_anchor`));
    }
    if (legs.length !== Math.max(0, nodes.length - 1)) {
      blockers.push(issue('blocking', 'LEG_COUNT_MISMATCH', `Day ${day.day} 节点与交通段数量不连续`, `${path}.legs`));
    }

    nodes.forEach((node, nodeIndex) => {
      if (!node.id || allNodeIds.has(node.id)) {
        blockers.push(issue('blocking', 'NODE_ID_DUPLICATE', `Day ${day.day} 存在缺失或重复的节点 ID`, `${path}.nodes[${nodeIndex}].id`));
      }
      if (node.id) allNodeIds.add(node.id);
      if (!node.coordinates) {
        warnings.push(issue('warning', 'NODE_LOCATION_UNVERIFIED', `Day ${day.day} · ${node.name || '未命名节点'} 缺少已验证坐标`, `${path}.nodes[${nodeIndex}].coordinates`));
      }
      if (!node.start_time || !node.end_time) {
        blockers.push(issue('blocking', 'NODE_TIME_MISSING', `Day ${day.day} · ${node.name || '节点'} 缺少时间轴`, `${path}.nodes[${nodeIndex}]`));
      }
    });

    legs.forEach((leg, legIndex) => {
      totalLegs++;
      const mode = String(leg.mode || '').toUpperCase();
      if (avoidedModes.has(mode) || (allowedModes.size && !allowedModes.has(mode))) {
        blockers.push(issue('blocking', 'TRANSPORT_PREFERENCE_VIOLATED', `Day ${day.day} 使用了未获允许的 ${mode || '未知'} 交通方式`, `${path}.legs[${legIndex}].mode`));
      }
      if (!leg.id || allLegIds.has(leg.id)) {
        blockers.push(issue('blocking', 'LEG_ID_DUPLICATE', `Day ${day.day} 存在缺失或重复的交通段 ID`, `${path}.legs[${legIndex}].id`));
      }
      if (leg.id) allLegIds.add(leg.id);
      const expectedFrom = nodes[legIndex]?.id;
      const expectedTo = nodes[legIndex + 1]?.id;
      if (!nodeIds.has(leg.from_node_id) || !nodeIds.has(leg.to_node_id)
        || leg.from_node_id !== expectedFrom || leg.to_node_id !== expectedTo) {
        blockers.push(issue('blocking', 'LEG_ENDPOINT_INVALID', `Day ${day.day} 的交通段端点与节点顺序不匹配`, `${path}.legs[${legIndex}]`));
      }
      if (leg.status === 'available') {
        availableLegs++;
        routeDistance += Number(leg.distance_meters) || 0;
        routeDuration += Number(leg.duration_seconds) || 0;
        if (mode === 'WALK') walkingDistance += Number(leg.distance_meters) || 0;
        if (!Array.isArray(leg.geometry) || leg.geometry.length < 2) {
          blockers.push(issue('blocking', 'ROUTE_GEOMETRY_MISSING', `Day ${day.day} 的已可用路线缺少真实几何`, `${path}.legs[${legIndex}].geometry`));
        }
      } else if (leg.status === 'unavailable') {
        blockers.push(issue('blocking', 'ROUTE_UNAVAILABLE', `Day ${day.day} 的 ${leg.mode || '未知'} 交通段无可用真实路线`, `${path}.legs[${legIndex}]`));
      } else {
        warnings.push(issue('warning', 'ROUTE_NOT_CALCULATED', `Day ${day.day} 存在尚未计算的交通段`, `${path}.legs[${legIndex}]`));
      }
    });

    const walkingLimit = Number(profile.maxWalkingKm);
    if (Number.isFinite(walkingLimit) && walkingLimit >= 0 && walkingDistance > walkingLimit * 1000) {
      blockers.push(issue(
        'blocking',
        'WALKING_LIMIT_EXCEEDED',
        `Day ${day.day} 已验证步行约 ${(walkingDistance / 1000).toFixed(1)} km，超过偏好上限 ${walkingLimit} km`,
        `${path}.legs`,
      ));
    }

    if (dayIndex < days.length - 1 && !day.connection_to_next) {
      blockers.push(issue('blocking', 'DAY_CONNECTION_MISSING', `Day ${day.day} 与 Day ${days[dayIndex + 1].day} 之间没有连接`, `${path}.connection_to_next`));
    }
    if (day.connection_to_next) {
      const next = days[dayIndex + 1];
      if (!next || day.connection_to_next.from_day_id !== day.id || day.connection_to_next.to_day_id !== next.id) {
        blockers.push(issue('blocking', 'DAY_CONNECTION_INVALID', `Day ${day.day} 的跨日连接引用无效`, `${path}.connection_to_next`));
      }
      if (day.connection_to_next.type === 'intercity') {
        if (day.connection_to_next.status === 'needs_confirmation') {
          warnings.push(issue('warning', 'INTERCITY_CONFIRMATION_REQUIRED', `Day ${day.day} 到 Day ${next?.day || '?'} 的 ${day.connection_to_next.mode} 跨城段需确认具体班次`, `${path}.connection_to_next`));
        } else if (day.connection_to_next.status !== 'available') {
          blockers.push(issue('blocking', 'INTERCITY_CONNECTION_UNAVAILABLE', `Day ${day.day} 到 Day ${next?.day || '?'} 的跨城交通尚未获得可执行路线`, `${path}.connection_to_next`));
        } else if (!Array.isArray(day.connection_to_next.geometry) || day.connection_to_next.geometry.length < 2) {
          blockers.push(issue('blocking', 'INTERCITY_GEOMETRY_MISSING', `Day ${day.day} 的跨城路线缺少真实几何`, `${path}.connection_to_next.geometry`));
        }
      }
    }

    const endNode = nodes.find(node => node.id === day.end_anchor);
    const endMinutes = clockMinutes(endNode?.end_time);
    const preferredEnd = clockMinutes(profile.dailyEndTime);
    if (endMinutes !== null && preferredEnd !== null && endMinutes > preferredEnd) {
      warnings.push(issue('warning', 'DAY_ENDS_LATE', `Day ${day.day} 预计 ${clockLabel(endNode.end_time)} 结束，晚于偏好时间 ${profile.dailyEndTime}`, path));
    }
  });

  const budget = plan?.budget_summary;
  if (budget?.status === 'over_budget') {
    const target = profile.budget?.hardLimit ? blockers : warnings;
    target.push(issue(profile.budget?.hardLimit ? 'blocking' : 'warning', 'BUDGET_EXCEEDED', `已知费用 ${budget.known_total} ${budget.currency} 超出预算 ${budget.limit} ${budget.currency}`, 'budget_summary'));
  }
  if (!budget || budget.coverage < 0.5) {
    warnings.push(issue('warning', 'BUDGET_COVERAGE_LOW', '多数项目缺少可验证价格，预算仅可作为选择偏好', 'budget_summary'));
  }
  if (budget?.currency_mismatch_items > 0) {
    warnings.push(issue('warning', 'BUDGET_CURRENCY_MISMATCH', `${budget.currency_mismatch_items} 项费用币种与预算币种不一致，已排除出汇总`, 'budget_summary'));
  }
  if (budget?.invalid_cost_items > 0) {
    warnings.push(issue('warning', 'BUDGET_COST_INVALID', `${budget.invalid_cost_items} 项费用缺少有效金额或计价口径，已排除出汇总`, 'budget_summary'));
  }

  const status = blockers.length ? 'failed' : warnings.length ? 'warning' : 'passed';
  return {
    status,
    passed: blockers.length === 0,
    blocking_issues: blockers,
    warnings,
    metrics: {
      days: days.length,
      nodes: allNodeIds.size,
      legs: totalLegs,
      available_legs: availableLegs,
      route_coverage: totalLegs ? availableLegs / totalLegs : 1,
      distance_meters: routeDistance,
      duration_seconds: routeDuration,
      budget_coverage: budget?.coverage ?? 0,
    },
  };
}
