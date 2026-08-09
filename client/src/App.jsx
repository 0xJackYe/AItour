import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import MapView from './components/MapView.jsx';
import InputPanel from './components/InputPanel.jsx';
import PlanPanel from './components/PlanPanel.jsx';
import HistoryPanel from './components/HistoryPanel.jsx';
import PanelResizer from './components/PanelResizer.jsx';
import { generatePlan, recalculatePlan } from './services/api.js';
import { deletePlan, getHistory, saveSnapshot } from './services/storage.js';
import {
  clearFormDraft,
  emptyFormDraft,
  loadFormDraft,
  normalizeFormDraft,
  saveFormDraft,
} from './services/formDraft.js';
import {
  cloneProfile,
  findDay,
  normalizeSnapshot,
  snapshotFromHistory,
} from './services/planModel.js';
import { initialTripState, tripReducer } from './services/tripReducer.js';
import { clampSplitPercent, DEFAULT_SPLIT_PERCENT } from './services/splitPane.js';

const GENERATION_STAGES = [
  ['understanding', 1200],
  ['skeleton', 4500],
  ['places', 9000],
  ['routes', 15000],
  ['validating', 22000],
];

const STAGE_LABELS = {
  preparing: '正在整理你的旅行资料',
  understanding: '正在理解预算、同行人和交通偏好',
  skeleton: '正在搭建连续的城市与住宿骨架',
  places: '正在核验地点和城市范围',
  routes: '正在计算每一段交通路线',
  validating: '正在检查时间、预算和跨日衔接',
  recalculating: '正在重新计算受影响的路线和时间',
};

function deepClone(value) {
  return typeof structuredClone === 'function'
    ? structuredClone(value)
    : JSON.parse(JSON.stringify(value));
}

function syncSpots(day) {
  if (!Array.isArray(day.nodes)) return;
  day.spots = day.nodes.filter(node => !['hotel', 'stay', 'start', 'end'].includes(node.type));
}

export default function App() {
  const [state, dispatch] = useReducer(tripReducer, initialTripState);
  const [history, setHistory] = useState([]);
  const [draft, setDraft] = useState(loadFormDraft);
  const [draftStorageAvailable, setDraftStorageAvailable] = useState(null);
  const [splitPercent, setSplitPercent] = useState(DEFAULT_SPLIT_PERCENT);
  const [containerWidth, setContainerWidth] = useState(0);
  const [clarificationAnswers, setClarificationAnswers] = useState({});
  const activeRequest = useRef({ id: 0, controller: null, timers: [] });
  const appBodyRef = useRef(null);

  const clearRequestTimers = useCallback(() => {
    activeRequest.current.timers.forEach(clearTimeout);
    activeRequest.current.timers = [];
  }, []);

  const cancelActiveRequest = useCallback(() => {
    activeRequest.current.controller?.abort();
    clearRequestTimers();
  }, [clearRequestTimers]);

  const loadHistory = useCallback(async () => {
    try {
      const records = await getHistory();
      setHistory(records.map(item => item.snapshot
        ? { ...item, plan: item.snapshot.plan, routes: item.snapshot.routes }
        : item));
    } catch (error) {
      dispatch({ type: 'NOTICE', notice: `历史记录暂时无法读取：${error.message}` });
    }
  }, []);

  useEffect(() => {
    loadHistory();
    return cancelActiveRequest;
  }, [cancelActiveRequest, loadHistory]);

  useEffect(() => {
    setDraftStorageAvailable(saveFormDraft(draft));
  }, [draft]);

  useEffect(() => {
    const container = appBodyRef.current;
    if (!container || typeof ResizeObserver === 'undefined') return undefined;
    const clampToContainer = () => {
      const width = container.getBoundingClientRect().width;
      setContainerWidth(width);
      if (width > 768) setSplitPercent(current => clampSplitPercent(current, width));
    };
    clampToContainer();
    const observer = new ResizeObserver(clampToContainer);
    observer.observe(container);
    return () => observer.disconnect();
  }, []);

  const handleDraftChange = useCallback((update) => {
    setDraft(current => normalizeFormDraft(
      typeof update === 'function' ? update(current) : update,
    ));
    dispatch({ type: 'FORM_DRAFT_CHANGED' });
  }, []);

  const handleClearForm = useCallback(() => {
    const storageCleared = clearFormDraft();
    setDraftStorageAvailable(storageCleared);
    setDraft(emptyFormDraft());
    setClarificationAnswers({});
    dispatch({ type: 'FORM_CLEARED', storageCleared });
  }, []);

  const handleSplitChange = useCallback((value) => {
    const width = containerWidth || appBodyRef.current?.getBoundingClientRect().width || 0;
    setSplitPercent(clampSplitPercent(value, width));
  }, [containerWidth]);

  const startRequest = useCallback((type = 'GENERATE_START') => {
    cancelActiveRequest();
    const requestId = activeRequest.current.id + 1;
    const controller = new AbortController();
    activeRequest.current = { id: requestId, controller, timers: [] };
    dispatch({ type, requestId });
    if (type === 'GENERATE_START') {
      activeRequest.current.timers = GENERATION_STAGES.map(([stage, delay]) => setTimeout(() => {
        dispatch({ type: 'GENERATE_STAGE', requestId, stage });
      }, delay));
    }
    return { requestId, controller };
  }, [cancelActiveRequest]);

  const handleSubmit = useCallback(async (payload) => {
    const normalizedPayload = typeof payload === 'string'
      ? { query: payload, profile: draft.profile }
      : payload;
    const profile = cloneProfile(normalizedPayload.profile);
    const query = normalizedPayload.query.trim();
    setDraft({ query, profile });
    setClarificationAnswers({});
    const { requestId, controller } = startRequest('GENERATE_START');

    try {
      const result = await generatePlan({ query, profile }, { signal: controller.signal });
      clearRequestTimers();
      if (result.status === 'need_clarification') {
        dispatch({ type: 'GENERATE_CLARIFICATION', requestId, payload: result });
        return;
      }
      const snapshot = normalizeSnapshot(result, { query, profile });
      dispatch({ type: 'COMMIT', requestId, snapshot });
      try {
        await saveSnapshot(snapshot);
        await loadHistory();
      } catch (storageError) {
        dispatch({ type: 'NOTICE', notice: `计划已生成，但本地保存失败：${storageError.message}` });
      }
    } catch (error) {
      clearRequestTimers();
      if (error.name !== 'AbortError') {
        dispatch({ type: 'GENERATE_ERROR', requestId, error: error.message || '生成失败' });
      }
    }
  }, [clearRequestTimers, draft.profile, loadHistory, startRequest]);

  const continueAfterClarification = useCallback((event) => {
    event.preventDefault();
    const nextProfile = cloneProfile(draft.profile);
    const additions = [];
    Object.entries(clarificationAnswers)
      .filter(([, value]) => String(value).trim())
      .forEach(([key, value]) => {
        if (key === 'days') nextProfile.days = Number(value);
        else if (key === 'budget') nextProfile.budget.level = value;
        else if (key === 'pace') nextProfile.pace = value;
        else if (key === 'transportPriority') nextProfile.transport.priority = value;
        else additions.push(`${key}：${value}`);
      });
    if (!Object.keys(clarificationAnswers).length) return;
    handleSubmit({
      query: additions.length ? `${draft.query}\n补充信息：${additions.join('；')}` : draft.query,
      profile: nextProfile,
    });
  }, [clarificationAnswers, draft, handleSubmit]);

  const handleLoadHistory = useCallback((item) => {
    cancelActiveRequest();
    try {
      const snapshot = snapshotFromHistory(item);
      dispatch({ type: 'COMMIT', snapshot });
      dispatch({ type: 'TOGGLE_HISTORY', open: false });
      setDraft({ query: snapshot.query || item.query || '', profile: cloneProfile(snapshot.profile) });
    } catch (error) {
      dispatch({ type: 'GENERATE_ERROR', error: `历史记录无法加载：${error.message}` });
    }
  }, [cancelActiveRequest]);

  const handleDeleteHistory = useCallback(async (id) => {
    try {
      await deletePlan(id);
      await loadHistory();
    } catch (error) {
      dispatch({ type: 'NOTICE', notice: `删除失败：${error.message}` });
    }
  }, [loadHistory]);

  const commitLocalSnapshot = useCallback(async (snapshot, requestId) => {
    dispatch({ type: 'EDIT_COMMIT', requestId, snapshot });
    try {
      await saveSnapshot(snapshot);
      await loadHistory();
    } catch (error) {
      dispatch({ type: 'NOTICE', notice: `修改已应用，但版本保存失败：${error.message}` });
    }
  }, [loadHistory]);

  const handleEdit = useCallback(async (command) => {
    const current = state.committed;
    if (!current || state.pending) return;
    const draftPlan = deepClone(current.plan);
    const day = findDay(draftPlan, command.dayId ?? command.day);
    if (!day) return;
    const nodes = Array.isArray(day.nodes) ? day.nodes : day.spots || [];
    const index = nodes.findIndex(node => node.id === command.nodeId);
    if (index < 0) return;
    const node = nodes[index];

    if (command.type === 'toggle_lock') {
      node.locked = !node.locked;
    } else if (node.locked) {
      dispatch({ type: 'NOTICE', notice: '该地点已锁定，请先解锁后再修改。' });
      return;
    } else if (command.type === 'delete_node') {
      nodes.splice(index, 1);
    } else if (command.type === 'move_node') {
      const offset = command.direction === 'up' ? -1 : 1;
      const target = index + offset;
      if (target < 0 || target >= nodes.length || nodes[target]?.locked) return;
      if (['hotel', 'stay', 'start', 'end'].includes(nodes[target]?.type)) return;
      [nodes[index], nodes[target]] = [nodes[target], nodes[index]];
    } else {
      return;
    }
    day.nodes = nodes;
    syncSpots(day);

    const { requestId, controller } = startRequest('EDIT_START');
    if (command.type === 'toggle_lock') {
      const snapshot = { ...current, id: `revision_${Date.now()}`, plan: draftPlan, createdAt: Date.now() };
      await commitLocalSnapshot(snapshot, requestId);
      return;
    }

    try {
      const result = await recalculatePlan({ plan: draftPlan, profile: current.profile }, { signal: controller.signal });
      const recalculated = normalizeSnapshot(result, { query: current.query, profile: current.profile });
      const snapshot = {
        ...recalculated,
        transitMarkers: recalculated.transitMarkers.length ? recalculated.transitMarkers : current.transitMarkers,
      };
      await commitLocalSnapshot(snapshot, requestId);
    } catch (error) {
      if (error.name !== 'AbortError') {
        dispatch({ type: 'GENERATE_ERROR', requestId, error: `修改未应用：${error.message}` });
      }
    }
  }, [commitLocalSnapshot, startRequest, state.committed, state.pending]);

  const snapshot = state.committed;
  const questions = state.clarification?.questions || [];
  const selectDay = useCallback(day => dispatch({ type: 'SELECT_DAY', day }), []);
  const selectNode = useCallback((nodeId, day) => {
    dispatch({ type: 'SELECT_NODE', nodeId, day });
    requestAnimationFrame(() => {
      document.getElementById(`timeline-${nodeId}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    });
  }, []);
  const selectLeg = useCallback((legId, day) => dispatch({ type: 'SELECT_LEG', legId, day }), []);

  return (
    <div className="app">
      <header className="app-header">
        <div className="brand-block">
          <span className="brand-mark" aria-hidden="true">A</span>
          <div>
            <h1>AItour</h1>
            <span className="subtitle">把每一天连成真正可执行的旅程</span>
          </div>
        </div>
        <div className="header-actions">
          <button
            type="button"
            className="header-action"
            onClick={() => dispatch({ type: 'UNDO' })}
            disabled={!state.undoStack.length || Boolean(state.pending)}
            aria-label="撤销上一次行程修改"
          >撤销</button>
          <button
            type="button"
            className="header-action"
            onClick={() => dispatch({ type: 'REDO' })}
            disabled={!state.redoStack.length || Boolean(state.pending)}
            aria-label="重做行程修改"
          >重做</button>
          <button
            type="button"
            className="history-toggle"
            onClick={() => dispatch({ type: 'TOGGLE_HISTORY' })}
            aria-expanded={state.showHistory}
          >历史版本 <span>{history.length}</span></button>
        </div>
      </header>

      <main
        ref={appBodyRef}
        className="app-body"
        style={{ '--left-pane-width': `${splitPercent}%` }}
      >
        <section id="trip-planning-panel" className="left-panel" aria-label="旅行计划">
          <InputPanel
            draft={draft}
            onDraftChange={handleDraftChange}
            onClear={handleClearForm}
            onSubmit={handleSubmit}
            loading={Boolean(state.pending)}
            draftStorageAvailable={draftStorageAvailable}
          />

          {state.pending && (
            <div className="generation-progress" role="status" aria-live="polite">
              <span className="progress-orbit" aria-hidden="true" />
              <div>
                <strong>{STAGE_LABELS[state.pending.stage] || STAGE_LABELS.preparing}</strong>
                {snapshot && <p>当前方案会保留，直到新方案完整通过检查。</p>}
              </div>
            </div>
          )}

          {state.error && (
            <div className="error-box" role="alert">
              <div><strong>这次操作没有完成</strong><p>{state.error}</p></div>
              <button type="button" onClick={() => handleSubmit(draft)} disabled={Boolean(state.pending)}>重试</button>
            </div>
          )}

          {state.notice && <div className="notice-box" role="status">{state.notice}</div>}

          {state.clarification && (
            <form className="clarification-box" onSubmit={continueAfterClarification}>
              <div className="section-kicker">补全后继续</div>
              <h2>还需要确认 {questions.length || 1} 项信息</h2>
              {questions.length ? questions.map((question, index) => {
                const id = question.id || question.field || `question_${index}`;
                const options = question.options || [];
                return (
                  <label key={id} className="clarification-field">
                    <span>{question.question || question.label || String(question)}</span>
                    {options.length ? (
                      <select
                        value={clarificationAnswers[id] || ''}
                        onChange={event => setClarificationAnswers(values => ({ ...values, [id]: event.target.value }))}
                        required={question.required !== false}
                      >
                        <option value="">请选择</option>
                        {options.map(option => {
                          const value = typeof option === 'string' ? option : option.value;
                          const label = typeof option === 'string' ? option : option.label;
                          return <option key={value} value={value}>{label}</option>;
                        })}
                      </select>
                    ) : (
                      <input
                        value={clarificationAnswers[id] || ''}
                        onChange={event => setClarificationAnswers(values => ({ ...values, [id]: event.target.value }))}
                        required={question.required !== false}
                      />
                    )}
                    {question.reason && <small>{question.reason}</small>}
                  </label>
                );
              }) : (
                <label className="clarification-field">
                  <span>{state.clarification.message || '请补充目的地或行程要求'}</span>
                  <input
                    value={clarificationAnswers.details || ''}
                    onChange={event => setClarificationAnswers({ details: event.target.value })}
                    required
                  />
                </label>
              )}
              <button type="submit" className="primary-button">继续生成</button>
            </form>
          )}

          <PlanPanel
            plan={snapshot?.plan || null}
            routes={snapshot?.routes || []}
            health={snapshot?.health || null}
            profile={snapshot?.profile || null}
            parsedRequest={snapshot?.parsedRequest || null}
            verification={snapshot?.verification || null}
            geocodingWarnings={snapshot?.geocodingWarnings || []}
            transitMarkers={snapshot?.transitMarkers || []}
            selectedDay={state.selection.day}
            onSelectDay={selectDay}
            selectedNodeId={state.selection.nodeId}
            onSelectNode={selectNode}
            selectedLegId={state.selection.legId}
            onSelectLeg={selectLeg}
            onEdit={handleEdit}
            editing={state.pending?.stage === 'recalculating'}
          />
        </section>

        <PanelResizer
          containerRef={appBodyRef}
          containerWidth={containerWidth}
          value={splitPercent}
          onChange={handleSplitChange}
        />

        <section id="trip-map-panel" className="map-container" aria-label="行程地图">
          <MapView
            plan={snapshot?.plan || null}
            routes={snapshot?.routes || []}
            selectedDay={state.selection.day}
            selectedNodeId={state.selection.nodeId}
            selectedLegId={state.selection.legId}
            onSelectNode={selectNode}
            onSelectLeg={selectLeg}
            transitMarkers={snapshot?.transitMarkers || []}
          />
        </section>

        {state.showHistory && (
          <>
            <button
              type="button"
              className="history-backdrop"
              aria-label="关闭历史版本"
              onClick={() => dispatch({ type: 'TOGGLE_HISTORY', open: false })}
            />
            <HistoryPanel
              history={history}
              onLoad={handleLoadHistory}
              onDelete={handleDeleteHistory}
              onClose={() => dispatch({ type: 'TOGGLE_HISTORY', open: false })}
            />
          </>
        )}
      </main>
    </div>
  );
}
