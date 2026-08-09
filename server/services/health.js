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

function geometryPoint(value) {
  if (!Array.isArray(value) || value.length < 2) return null;
  const parseCoordinate = (coordinate, limit) => {
    if (coordinate == null || typeof coordinate === 'boolean') return null;
    if (typeof coordinate === 'string' && !coordinate.trim()) return null;
    const numeric = Number(coordinate);
    return Number.isFinite(numeric) && Math.abs(numeric) <= limit ? numeric : null;
  };
  const lat = parseCoordinate(value[0], 90);
  const lng = parseCoordinate(value[1], 180);
  return lat !== null && lng !== null ? { lat, lng } : null;
}

function distanceMeters(left, right) {
  const a = geometryPoint(left);
  const b = geometryPoint(right);
  if (!a || !b) return null;
  const toRad = value => (value * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const value = Math.sin(dLat / 2) ** 2
    + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 6371000 * 2 * Math.asin(Math.sqrt(value));
}

function hasValidGeometry(value) {
  return Array.isArray(value) && value.length >= 2 && value.every(point => geometryPoint(point));
}

function vehicleMatchesPreference(vehicle, preferences) {
  if (!preferences.size) return true;
  const normalized = String(vehicle || '').toUpperCase();
  const groups = {
    BUS: new Set(['BUS', 'INTERCITY_BUS', 'TROLLEYBUS', 'SHARE_TAXI']),
    SUBWAY: new Set(['SUBWAY', 'METRO_RAIL']),
    TRAIN: new Set(['TRAIN', 'RAIL', 'COMMUTER_TRAIN', 'HEAVY_RAIL', 'HIGH_SPEED_TRAIN', 'LONG_DISTANCE_TRAIN']),
    LIGHT_RAIL: new Set(['LIGHT_RAIL', 'TRAM', 'MONORAIL']),
    RAIL: new Set(['SUBWAY', 'METRO_RAIL', 'TRAIN', 'RAIL', 'COMMUTER_TRAIN', 'HEAVY_RAIL', 'HIGH_SPEED_TRAIN', 'LONG_DISTANCE_TRAIN', 'LIGHT_RAIL', 'TRAM', 'MONORAIL']),
  };
  return [...preferences].some(preference => groups[preference]?.has(normalized));
}

function routeProviderBlockingIssue(route, context, path) {
  if (route?.error_code === 'ROUTE_PROVIDER_ERROR') {
    return issue(
      'blocking',
      'ROUTE_PROVIDER_ERROR',
      `${context}的路线服务调用失败，无法确认是否存在可执行路线；请检查 API、配额或网络后重试`,
      path,
    );
  }
  if (route?.error_code === 'ROUTE_PROVIDER_RESPONSE_INVALID') {
    return issue(
      'blocking',
      'ROUTE_PROVIDER_RESPONSE_INVALID',
      `${context}的路线服务返回了无效响应或损坏几何，不能当作“无路线”继续使用`,
      path,
    );
  }
  return null;
}

function validateSegments(route, path, blockers, warnings, transitModePreferences) {
  const segments = Array.isArray(route?.segments) ? route.segments : [];
  if (route?.schedule_recheck_required) {
    const representative = route.schedule_basis === 'representative';
    warnings.push(issue(
      'warning',
      'TRANSIT_SCHEDULE_RECHECK_REQUIRED',
      representative
        ? '路线形态按同星期白天代表性时刻测算，该时刻不代表实际班次；请在临近出发时复核发车时间'
        : '路线轨迹已验证；出行日期超出实时班次窗口，请在临近出发时复核发车时间',
      path,
    ));
  }
  if (!segments.length) {
    if (['TRANSIT', 'RAIL'].includes(String(route?.mode || '').toUpperCase()) && route?.status === 'available') {
      warnings.push(issue('warning', 'TRANSIT_DETAILS_MISSING', '真实路线已获取，但服务未返回可展示的线路与换乘详情', `${path}.segments`));
    }
    return 0;
  }

  let walkingDistance = 0;
  segments.forEach((segment, index) => {
    const segmentPath = `${path}.segments[${index}]`;
    if (Number(segment.sequence) !== index) {
      blockers.push(issue('blocking', 'ROUTE_SEGMENT_SEQUENCE_INVALID', '交通分段顺序不连续', `${segmentPath}.sequence`));
    }
    if (!hasValidGeometry(segment.geometry)) {
      blockers.push(issue('blocking', 'ROUTE_SEGMENT_GEOMETRY_MISSING', '交通分段缺少真实几何', `${segmentPath}.geometry`));
    }
    const travelMode = String(segment.travel_mode || '').toUpperCase();
    if (travelMode === 'WALK') walkingDistance += Number(segment.distance_meters) || 0;
    if (travelMode === 'TRANSIT') {
      if (!segment.transit_vehicle_type) {
        blockers.push(issue('blocking', 'TRANSIT_VEHICLE_MISSING', '公共交通分段缺少具体车辆类型', `${segmentPath}.transit_vehicle_type`));
      } else if (!vehicleMatchesPreference(segment.transit_vehicle_type, transitModePreferences)) {
        warnings.push(issue(
          'warning',
          'TRANSIT_SUBMODE_FALLBACK',
          `路线服务返回了偏好之外的 ${segment.transit_vehicle_type}，这是当前可执行路线的一部分`,
          segmentPath,
        ));
      }
    }
    if (index > 0) {
      const previousGeometry = segments[index - 1]?.geometry;
      const gap = distanceMeters(previousGeometry?.at(-1), segment.geometry?.[0]);
      if (gap !== null && gap > 2000) {
        blockers.push(issue('blocking', 'ROUTE_SEGMENT_DISCONNECTED', `相邻交通分段存在约 ${Math.round(gap)}m 的未解释断点`, segmentPath));
      }
    }
  });
  return walkingDistance;
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
  const transitModePreferences = new Set(
    (profile.transport?.transitPreferences?.allowedModes || []).map(mode => String(mode).toUpperCase()),
  );

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
        else walkingDistance += validateSegments(leg, `${path}.legs[${legIndex}]`, blockers, warnings, transitModePreferences);
        if (!hasValidGeometry(leg.geometry)) {
          blockers.push(issue('blocking', 'ROUTE_GEOMETRY_MISSING', `Day ${day.day} 的已可用路线缺少真实几何`, `${path}.legs[${legIndex}].geometry`));
        }
      } else if (leg.status === 'unavailable') {
        const legPath = `${path}.legs[${legIndex}]`;
        blockers.push(routeProviderBlockingIssue(leg, `Day ${day.day} 的 ${leg.mode || '未知'} 交通段`, legPath)
          || issue('blocking', 'ROUTE_UNAVAILABLE', `Day ${day.day} 的 ${leg.mode || '未知'} 交通段无可用真实路线`, legPath));
      } else if (leg.status === 'needs_confirmation' && leg.provider_limit_code === 'GOOGLE_TRANSIT_JAPAN_UNSUPPORTED') {
        warnings.push(issue(
          'warning',
          'TRANSIT_PROVIDER_LIMIT_CONFIRMATION_REQUIRED',
          `Day ${day.day} 的日本公共交通段因 Google Routes 官方覆盖限制需在 Google Maps 中实时确认；当前距离与时长仅为估算`,
          `${path}.legs[${legIndex}]`,
        ));
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
        const connectionMode = String(day.connection_to_next.mode || '').toUpperCase();
        if (avoidedModes.has(connectionMode) || (allowedModes.size && !allowedModes.has(connectionMode))) {
          blockers.push(issue(
            'blocking',
            'TRANSPORT_PREFERENCE_VIOLATED',
            `Day ${day.day} 到 Day ${next?.day || '?'} 使用了未获允许的 ${connectionMode || '未知'} 交通方式`,
            `${path}.connection_to_next.mode`,
          ));
        }
        if (day.connection_to_next.status === 'needs_confirmation') {
          const providerLimited = day.connection_to_next.provider_limit_code === 'GOOGLE_TRANSIT_JAPAN_UNSUPPORTED';
          warnings.push(issue(
            'warning',
            providerLimited ? 'TRANSIT_PROVIDER_LIMIT_CONFIRMATION_REQUIRED' : 'INTERCITY_CONFIRMATION_REQUIRED',
            providerLimited
              ? `Day ${day.day} 到 Day ${next?.day || '?'} 的日本公共交通因 Google Routes 官方覆盖限制，需通过 Google Maps 实时确认具体线路、换乘和班次；当前距离与时长仅为估算`
              : `Day ${day.day} 到 Day ${next?.day || '?'} 的 ${day.connection_to_next.mode} 跨城段需确认具体班次`,
            `${path}.connection_to_next`,
          ));
        } else if (day.connection_to_next.status !== 'available') {
          const connectionPath = `${path}.connection_to_next`;
          blockers.push(routeProviderBlockingIssue(
            day.connection_to_next,
            `Day ${day.day} 到 Day ${next?.day || '?'} 的跨城交通`,
            connectionPath,
          ) || issue('blocking', 'INTERCITY_CONNECTION_UNAVAILABLE', `Day ${day.day} 到 Day ${next?.day || '?'} 的跨城交通尚未获得可执行路线`, connectionPath));
        } else if (!hasValidGeometry(day.connection_to_next.geometry)) {
          blockers.push(issue('blocking', 'INTERCITY_GEOMETRY_MISSING', `Day ${day.day} 的跨城路线缺少真实几何`, `${path}.connection_to_next.geometry`));
        } else {
          validateSegments(
            day.connection_to_next,
            `${path}.connection_to_next`,
            blockers,
            warnings,
            transitModePreferences,
          );
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
