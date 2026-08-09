export const DEFAULT_SPLIT_PERCENT = 44;
export const SPLITTER_WIDTH_PX = 10;
export const MIN_PANE_WIDTH_PX = 360;

const FALLBACK_MIN_PERCENT = 30;
const FALLBACK_MAX_PERCENT = 70;

function finiteNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function splitPaneBounds(containerWidth, {
  minPaneWidth = MIN_PANE_WIDTH_PX,
  splitterWidth = SPLITTER_WIDTH_PX,
  minPercent = FALLBACK_MIN_PERCENT,
  maxPercent = FALLBACK_MAX_PERCENT,
} = {}) {
  const width = finiteNumber(containerWidth, 0);
  if (width <= 0) return { min: minPercent, max: maxPercent };

  const usableWidth = Math.max(0, width - splitterWidth);
  const constrainedMinimum = Math.min(minPaneWidth, usableWidth / 2);
  const lower = Math.max(minPercent, (constrainedMinimum / width) * 100);
  const upper = Math.min(maxPercent, ((usableWidth - constrainedMinimum) / width) * 100);
  const middle = (usableWidth / width) * 50;

  return lower <= upper
    ? { min: lower, max: upper }
    : { min: middle, max: middle };
}

export function clampSplitPercent(value, containerWidth, options) {
  const { min, max } = splitPaneBounds(containerWidth, options);
  return Math.min(max, Math.max(min, finiteNumber(value, DEFAULT_SPLIT_PERCENT)));
}

export function splitPercentFromPointer(clientX, containerLeft, containerWidth, options) {
  const width = finiteNumber(containerWidth, 0);
  if (width <= 0) return DEFAULT_SPLIT_PERCENT;
  const raw = ((finiteNumber(clientX, 0) - finiteNumber(containerLeft, 0)) / width) * 100;
  return clampSplitPercent(raw, width, options);
}

export function splitPercentFromKey(current, key, containerWidth, { shiftKey = false } = {}) {
  const { min, max } = splitPaneBounds(containerWidth);
  const step = shiftKey ? 6 : 2;
  if (key === 'Home') return min;
  if (key === 'End') return max;
  if (key === 'ArrowLeft') return clampSplitPercent(current - step, containerWidth);
  if (key === 'ArrowRight') return clampSplitPercent(current + step, containerWidth);
  return clampSplitPercent(current, containerWidth);
}
