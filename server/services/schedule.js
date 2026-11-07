// 当日时间安排：保证时间线连贯、可执行。
//
//  - 模型给出的时间完整且递增 → 保留（它包含了“清晨避开人群”“傍晚看夜景”等意图）；
//  - 缺失或乱序（例如顺序优化后） → 从当天第一个有效时间（或按节奏的默认出发时间）起，
//    按“停留时长 + 路上时间”重新推算；
//  - 有 Google 真实路程时再校验一遍：来不及赶到下一站（差 20 分钟以上）就整体顺延。

const DAY_START = { relaxed: 9 * 60 + 30, moderate: 9 * 60, intensive: 8 * 60 + 30 };
const DEFAULT_STAY_HOURS = 1.5;
const DEFAULT_TRANSFER_MINUTES = 25;
const FEASIBILITY_TOLERANCE_MINUTES = 20;
const LATE_END_MINUTES = 22 * 60 + 30;

export function toMinutes(clock) {
  const match = /^(\d{2}):(\d{2})$/.exec(clock || '');
  return match ? Number(match[1]) * 60 + Number(match[2]) : null;
}

export function toClock(minutes) {
  const rounded = Math.max(0, Math.min(23 * 60 + 55, Math.round(minutes / 5) * 5));
  return `${String(Math.floor(rounded / 60)).padStart(2, '0')}:${String(rounded % 60).padStart(2, '0')}`;
}

const roundUp5 = minutes => Math.ceil(minutes / 5) * 5;
const stayMinutes = spot => Math.round((spot?.duration_hours || DEFAULT_STAY_HOURS) * 60);

function legBetween(from, to, legs) {
  const leg = from?.location_id ? legs?.get(from.location_id) : null;
  return leg && leg.to_id === to?.location_id ? leg : null;
}

function transferMinutes(leg) {
  if (!leg || !Number.isFinite(leg.duration_seconds)) return DEFAULT_TRANSFER_MINUTES;
  return Math.max(5, roundUp5(leg.duration_seconds / 60));
}

/**
 * @param spots  当天地点（顺序已确定）
 * @param legs   Map<from_id, leg>，来自逐段路线（可为空）
 * @returns { spots, rebuilt, shifted, endsAt }
 */
export function scheduleDay(spots = [], { pace = 'moderate', legs = null } = {}) {
  if (spots.length === 0) return { spots, rebuilt: false, shifted: 0, endsAt: null };
  const parsed = spots.map(spot => toMinutes(spot.start_time));
  const usable = parsed.every((value, index) => value !== null && (index === 0 || value > parsed[index - 1]));

  let times;
  if (usable) {
    times = parsed.slice();
  } else {
    let cursor = parsed.find(value => value !== null) ?? DAY_START[pace] ?? DAY_START.moderate;
    times = spots.map((spot, index) => {
      if (index > 0) {
        cursor += stayMinutes(spots[index - 1]) + transferMinutes(legBetween(spots[index - 1], spot, legs));
        cursor = roundUp5(cursor);
      }
      return cursor;
    });
  }

  // 逐站检查：只把来不及的那一站顺延到最早可达时间；后面的站有余量就不受影响。
  let shifted = 0;
  if (legs?.size) {
    for (let index = 1; index < spots.length; index++) {
      const leg = legBetween(spots[index - 1], spots[index], legs);
      if (leg && Number.isFinite(leg.duration_seconds)) {
        const earliest = times[index - 1] + stayMinutes(spots[index - 1]) + Math.ceil(leg.duration_seconds / 60);
        if (times[index] < earliest - FEASIBILITY_TOLERANCE_MINUTES) {
          times[index] = roundUp5(earliest);
          shifted++;
        }
      }
      // 前一站被顺延后仍要保持先后顺序。
      if (times[index] <= times[index - 1]) times[index] = roundUp5(times[index - 1] + stayMinutes(spots[index - 1]));
    }
  }

  return {
    spots: spots.map((spot, index) => ({ ...spot, start_time: toClock(times[index]) })),
    rebuilt: !usable,
    shifted,
    endsAt: times[times.length - 1] + stayMinutes(spots[spots.length - 1]),
  };
}

/** 对整份计划逐日排程，返回新计划与需要提示的问题。 */
export function applySchedules(plan, routes = []) {
  const warnings = [];
  const pace = plan.preferences?.pace || 'moderate';
  const daily_plans = (plan.daily_plans || []).map((day) => {
    const route = routes.find(item => item.day === day.day);
    const legs = new Map((route?.legs || []).filter(leg => leg.from_id).map(leg => [leg.from_id, leg]));
    const result = scheduleDay(day.spots || [], { pace, legs });
    if (result.endsAt !== null && result.endsAt > LATE_END_MINUTES) {
      warnings.push(`Day ${day.day} 预计 ${toClock(result.endsAt)} 才结束，安排偏满`);
    }
    return { ...day, spots: result.spots };
  });
  return { plan: { ...plan, daily_plans }, warnings };
}
