import { useCallback, useRef, useState } from 'react';
import {
  DEFAULT_SPLIT_PERCENT,
  splitPaneBounds,
  splitPercentFromKey,
  splitPercentFromPointer,
} from '../services/splitPane.js';

export default function PanelResizer({ containerRef, containerWidth, value, onChange }) {
  const activePointerIdRef = useRef(null);
  const [dragging, setDragging] = useState(false);
  const bounds = splitPaneBounds(containerWidth || 0);

  const updateFromPointer = useCallback((clientX) => {
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect) return;
    onChange(splitPercentFromPointer(clientX, rect.left, rect.width));
  }, [containerRef, onChange]);

  const finishDragging = useCallback((event) => {
    if (activePointerIdRef.current !== event.pointerId) return;
    activePointerIdRef.current = null;
    setDragging(false);
    if (event.currentTarget.hasPointerCapture?.(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  }, []);

  return (
    <div
      className={`panel-resizer${dragging ? ' is-dragging' : ''}`}
      role="separator"
      aria-label="调整旅行计划和地图的宽度"
      aria-orientation="vertical"
      aria-controls="trip-planning-panel trip-map-panel"
      aria-valuemin={Math.round(bounds.min)}
      aria-valuemax={Math.round(bounds.max)}
      aria-valuenow={Math.round(value)}
      aria-valuetext={`左侧旅行计划占 ${Math.round(value)}%`}
      tabIndex={0}
      onPointerDown={(event) => {
        if (event.button !== 0 || event.isPrimary === false || activePointerIdRef.current !== null) return;
        activePointerIdRef.current = event.pointerId;
        setDragging(true);
        event.currentTarget.setPointerCapture?.(event.pointerId);
        updateFromPointer(event.clientX);
      }}
      onPointerMove={(event) => {
        if (activePointerIdRef.current === event.pointerId) updateFromPointer(event.clientX);
      }}
      onPointerUp={finishDragging}
      onPointerCancel={finishDragging}
      onLostPointerCapture={(event) => {
        if (activePointerIdRef.current !== null && activePointerIdRef.current !== event.pointerId) return;
        activePointerIdRef.current = null;
        setDragging(false);
      }}
      onKeyDown={(event) => {
        if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
        event.preventDefault();
        const width = containerWidth || containerRef.current?.getBoundingClientRect().width || 0;
        onChange(splitPercentFromKey(value, event.key, width, { shiftKey: event.shiftKey }));
      }}
      onDoubleClick={() => onChange(DEFAULT_SPLIT_PERCENT)}
      title="拖动调整宽度；方向键微调；双击恢复默认"
    />
  );
}
