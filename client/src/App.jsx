import { startTransition, useCallback, useEffect, useRef, useState } from 'react';
import Composer from './components/Composer.jsx';
import HistoryDrawer from './components/HistoryDrawer.jsx';
import Icon from './components/Icon.jsx';
import MapView from './components/MapView.jsx';
import PlanView from './components/PlanView.jsx';
import Progress from './components/Progress.jsx';
import { normalizeResult } from './lib/plan.js';
import { cityOfDay, isMultiCity } from './lib/trip.js';
import { generatePlan } from './services/api.js';
import { deletePlan, getHistory, getPlanById, historyToResult, savePlan } from './services/storage.js';

const OVERVIEW = { city: null, day: null };

// 浏览器地址与前进 / 后退：打开一份行程时地址变为 ?trip=<本地历史 id>，
// 后退回到输入页，刷新时从本地历史恢复这份行程。
function tripIdFromUrl() {
  try {
    const id = new URLSearchParams(window.location.search).get('trip');
    return id && /^\d+$/.test(id) ? Number(id) : null;
  } catch {
    return null;
  }
}

function writeHistory(state, url, { replace = false } = {}) {
  try {
    window.history[replace ? 'replaceState' : 'pushState'](state, '', url);
  } catch {
    // 某些嵌入环境禁止修改地址；不影响使用。
  }
}

const tripUrl = id => (id ? `?trip=${id}` : window.location.pathname);
const homeUrl = () => window.location.pathname;

function ErrorCard({ error, onRetry }) {
  return (
    <section className="alert alert-error" role="alert">
      <Icon name="error" />
      <div className="alert-body">
        <p className="alert-title">{error.message}</p>
        {error.requestId && <p className="alert-meta">请求编号 {String(error.requestId).slice(0, 8)}</p>}
      </div>
      {error.retryable && <button type="button" className="btn btn-text" onClick={onRetry}>重试</button>}
    </section>
  );
}

function Clarification({ questions }) {
  return (
    <section className="alert alert-info" aria-live="polite">
      <Icon name="info" />
      <div className="alert-body">
        <p className="alert-title">再补充一点信息</p>
        <ul>
          {questions.map(question => <li key={question}>{question}</li>)}
        </ul>
        <p className="alert-meta">在上方补充后重新生成即可。</p>
      </div>
    </section>
  );
}

export default function App() {
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState('idle'); // idle | loading | done | clarify | error
  const [progress, setProgress] = useState(null);
  const [result, setResult] = useState(null);
  const [questions, setQuestions] = useState([]);
  const [error, setError] = useState(null);
  const [view, setView] = useState(OVERVIEW);
  const [focus, setFocus] = useState(null);
  const [history, setHistory] = useState([]);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [composerFocus, setComposerFocus] = useState(0);
  const abortRef = useRef(null);
  const lastQueryRef = useRef('');

  const refreshHistory = useCallback(async () => {
    try {
      setHistory(await getHistory());
    } catch (storageError) {
      console.warn('读取历史失败', storageError);
    }
  }, []);

  useEffect(() => {
    refreshHistory();
    return () => abortRef.current?.abort();
  }, [refreshHistory]);

  const showResult = useCallback((next, { query: text = null } = {}) => {
    if (text !== null) setQuery(text);
    // 长行程一次渲染几千个节点：放进 transition，让 React 分片渲染，避免长时间卡住主线程。
    startTransition(() => {
      setResult(next);
      setView(OVERVIEW);
      setFocus(null);
      setError(null);
      setQuestions([]);
      setStatus('done');
    });
  }, []);

  const resetHome = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    setResult(null);
    setQuery('');
    setError(null);
    setQuestions([]);
    setProgress(null);
    setView(OVERVIEW);
    setFocus(null);
    setStatus('idle');
  }, []);

  // 从本地历史按 id 打开（刷新页面、浏览器前进 / 后退）。找不到时回到输入页。
  const restoreTrip = useCallback(async (id) => {
    try {
      const item = await getPlanById(id);
      const restored = item ? historyToResult(item) : null;
      if (restored) {
        abortRef.current?.abort();
        showResult(restored, { query: item.query || '' });
        return true;
      }
    } catch (storageError) {
      console.warn('读取历史失败', storageError);
    }
    resetHome();
    writeHistory(null, homeUrl(), { replace: true });
    return false;
  }, [resetHome, showResult]);

  useEffect(() => {
    const initial = tripIdFromUrl();
    if (initial) {
      writeHistory({ aitour: 'plan', id: initial }, tripUrl(initial), { replace: true });
      restoreTrip(initial);
    }
    const onPopState = (event) => {
      const id = event.state?.aitour === 'plan' ? event.state.id : tripIdFromUrl();
      if (id) restoreTrip(id);
      else resetHome();
    };
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, [resetHome, restoreTrip]);

  const runPlan = useCallback(async (text) => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    lastQueryRef.current = text;
    setStatus('loading');
    setError(null);
    setQuestions([]);
    setProgress({ stage: 'parse', message: '正在连接规划服务…', progress: 0 });
    try {
      const data = await generatePlan(text, { signal: controller.signal, onProgress: setProgress });
      if (controller.signal.aborted) return;
      if (data.status === 'need_clarification') {
        setQuestions(data.questions?.length ? data.questions : ['请补充目的地、天数或偏好。']);
        setStatus('clarify');
        return;
      }
      const next = normalizeResult(data, text);
      if (!next) throw new Error('返回的行程数据不完整，请重试');
      showResult(next);
      let savedId = null;
      try {
        savedId = await savePlan(text, next);
        await refreshHistory();
      } catch (storageError) {
        console.warn('保存历史失败', storageError);
      }
      // 新行程进入浏览器历史：后退回到输入页，刷新时从本地历史恢复。
      writeHistory({ aitour: 'plan', id: savedId }, tripUrl(savedId));
    } catch (requestError) {
      if (controller.signal.aborted || requestError?.name === 'AbortError') return;
      setError({
        message: requestError?.message || '规划失败，请重试',
        code: requestError?.code,
        requestId: requestError?.requestId,
        retryable: requestError?.retryable !== false,
      });
      setStatus('error');
    } finally {
      if (abortRef.current === controller) abortRef.current = null;
    }
  }, [refreshHistory, showResult]);

  const cancel = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    setProgress(null);
    setStatus('idle');
  }, []);

  const openHistory = useCallback((item) => {
    const restored = historyToResult(item);
    if (!restored) return;
    abortRef.current?.abort();
    showResult(restored, { query: item.query || '' });
    setHistoryOpen(false);
    writeHistory({ aitour: 'plan', id: item.id }, tripUrl(item.id));
  }, [showResult]);

  const removeHistory = useCallback(async (id) => {
    try {
      await deletePlan(id);
    } finally {
      await refreshHistory();
    }
  }, [refreshHistory]);

  // “新行程”与点击标志：回到输入页（浏览器后退可以回到刚才的行程）。
  const goHome = () => {
    // 只有当前地址指向一份行程时才新增历史记录（后退可回到这份行程）。
    const onTrip = window.history.state?.aitour === 'plan' || tripIdFromUrl() !== null;
    resetHome();
    if (onTrip) writeHistory(null, homeUrl());
    setComposerFocus(value => value + 1);
  };

  // 回调保持稳定（通过 ref 读取最新状态），每天的 DaySection 才能在切换视图时跳过重渲染。
  const latest = useRef({ result: null, view: OVERVIEW });
  latest.current = { result, view };
  const focusSpot = useCallback((id, dayNumber) => {
    const { result: current, view: currentView } = latest.current;
    // 多城市总览不显示单个地点：先切到该地点所在的城市。
    if (current && isMultiCity(current.plan) && currentView.city === null && currentView.day === null) {
      setView({ city: cityOfDay(current.plan, dayNumber), day: null });
    }
    setFocus({ type: 'spot', id, day: dayNumber, at: Date.now() });
  }, []);

  const focusTransfer = useCallback((transfer) => {
    // 城市间交通在总览地图上显示。
    setView(OVERVIEW);
    setFocus({ type: 'transfer', id: transfer.id, at: Date.now() });
  }, []);

  const changeView = useCallback((next) => {
    setView(next);
    setFocus(null);
  }, []);

  const screen = status === 'idle' && result ? 'done' : status;
  const showPlan = Boolean(result) && (screen === 'done' || screen === 'error');
  const atHome = screen === 'idle' && !result;

  return (
    <div className={`app ${showPlan ? 'has-plan' : 'no-plan'}`}>
      <header className="topbar">
        <a className="brand" href="/" onClick={(event) => { event.preventDefault(); goHome(); }} title="回到首页">
          <span className="brand-mark" aria-hidden="true"><Icon name="place" size={18} /></span>
          <span className="brand-name"><span className="brand-ai">AI</span>tour</span>
        </a>
        <div className="topbar-actions">
          {!atHome && (
            <button type="button" className="btn btn-text new-trip" onClick={goHome} title="回到输入页，规划新的行程">
              <Icon name="add" size={18} />
              新行程
            </button>
          )}
          <button type="button" className="icon-btn" onClick={() => setHistoryOpen(true)} title="历史行程" aria-label={`历史行程，共 ${history.length} 条`}>
            <Icon name="history" />
            {history.length > 0 && <span className="badge" aria-hidden="true">{history.length}</span>}
          </button>
        </div>
      </header>

      <aside className="panel">
        {screen === 'idle' && (
          <div className="hero">
            <h1>想去哪里？</h1>
            <p>一句话描述目的地、天数和偏好，AI 帮你排好每天的路线，并在地图上逐一核实。</p>
          </div>
        )}

        <Composer
          value={query}
          onChange={setQuery}
          onSubmit={runPlan}
          onCancel={cancel}
          busy={screen === 'loading'}
          hasResult={Boolean(result)}
          focusSignal={composerFocus}
        />

        {screen === 'loading' && <Progress progress={progress} onCancel={cancel} />}
        {screen === 'clarify' && <Clarification questions={questions} />}
        {screen === 'error' && error && <ErrorCard error={error} onRetry={() => runPlan(lastQueryRef.current)} />}
        {showPlan && (
          <PlanView
            result={result}
            view={view}
            onViewChange={changeView}
            onFocusSpot={focusSpot}
            onFocusTransfer={focusTransfer}
            focus={focus}
          />
        )}
      </aside>

      <main className="map-pane" aria-label="地图">
        <MapView
          result={screen === 'loading' ? null : result}
          view={view}
          focus={focus}
          onSelectCity={city => changeView({ city, day: null })}
        />
      </main>

      <HistoryDrawer
        open={historyOpen}
        items={history}
        onSelect={openHistory}
        onDelete={removeHistory}
        onClose={() => setHistoryOpen(false)}
      />
    </div>
  );
}
