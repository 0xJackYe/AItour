import { useCallback, useEffect, useRef, useState } from 'react';
import Composer from './components/Composer.jsx';
import HistoryDrawer from './components/HistoryDrawer.jsx';
import Icon from './components/Icon.jsx';
import MapView from './components/MapView.jsx';
import PlanView from './components/PlanView.jsx';
import Progress from './components/Progress.jsx';
import { normalizeResult } from './lib/plan.js';
import { generatePlan } from './services/api.js';
import { deletePlan, getHistory, historyToResult, savePlan } from './services/storage.js';

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
  const [selectedDay, setSelectedDay] = useState(null);
  const [focus, setFocus] = useState(null);
  const [history, setHistory] = useState([]);
  const [historyOpen, setHistoryOpen] = useState(false);
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
      setResult(next);
      setSelectedDay(null);
      setFocus(null);
      setStatus('done');
      try {
        await savePlan(text, next);
        await refreshHistory();
      } catch (storageError) {
        console.warn('保存历史失败', storageError);
      }
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
  }, [refreshHistory]);

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
    setResult(restored);
    setQuery(item.query || '');
    setSelectedDay(null);
    setFocus(null);
    setError(null);
    setQuestions([]);
    setStatus('done');
    setHistoryOpen(false);
  }, []);

  const removeHistory = useCallback(async (id) => {
    try {
      await deletePlan(id);
    } finally {
      await refreshHistory();
    }
  }, [refreshHistory]);

  const goHome = () => {
    abortRef.current?.abort();
    setResult(null);
    setQuery('');
    setError(null);
    setQuestions([]);
    setSelectedDay(null);
    setFocus(null);
    setStatus('idle');
  };

  const view = status === 'idle' && result ? 'done' : status;
  const showPlan = Boolean(result) && (view === 'done' || view === 'error');

  return (
    <div className="app">
      <header className="topbar">
        <a className="brand" href="/" onClick={(event) => { event.preventDefault(); goHome(); }}>
          <span className="brand-mark" aria-hidden="true"><Icon name="place" size={18} /></span>
          AItour
        </a>
        <button type="button" className="icon-btn" onClick={() => setHistoryOpen(true)} title="历史行程" aria-label={`历史行程，共 ${history.length} 条`}>
          <Icon name="history" />
          {history.length > 0 && <span className="badge" aria-hidden="true">{history.length}</span>}
        </button>
      </header>

      <aside className="panel">
        {view === 'idle' && (
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
          busy={view === 'loading'}
          hasResult={Boolean(result)}
        />

        {view === 'loading' && <Progress progress={progress} onCancel={cancel} />}
        {view === 'clarify' && <Clarification questions={questions} />}
        {view === 'error' && error && <ErrorCard error={error} onRetry={() => runPlan(lastQueryRef.current)} />}
        {showPlan && (
          <PlanView
            result={result}
            selectedDay={selectedDay}
            onSelectDay={setSelectedDay}
            onFocusSpot={id => setFocus({ id, at: Date.now() })}
            focusedId={focus?.id}
          />
        )}
      </aside>

      <main className="map-pane" aria-label="地图">
        <MapView result={view === 'loading' ? null : result} selectedDay={selectedDay} focus={focus} />
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
