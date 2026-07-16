import { useState, useEffect, useCallback } from 'react';
import MapView from './components/MapView.jsx';
import InputPanel from './components/InputPanel.jsx';
import PlanPanel from './components/PlanPanel.jsx';
import HistoryPanel from './components/HistoryPanel.jsx';
import ParsedRequestPanel from './components/ParsedRequestPanel.jsx';
import TransitPanel from './components/TransitPanel.jsx';
import VerificationPanel from './components/VerificationPanel.jsx';
import { generatePlan } from './services/api.js';
import { savePlan, getHistory, deletePlan } from './services/storage.js';

export default function App() {
  const [plan, setPlan] = useState(null);
  const [routes, setRoutes] = useState([]);
  const [parsedRequest, setParsedRequest] = useState(null);
  const [transitMarkers, setTransitMarkers] = useState([]);
  const [verification, setVerification] = useState(null);
  const [geocodingWarnings, setGeocodingWarnings] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [clarification, setClarification] = useState(null);
  const [selectedDay, setSelectedDay] = useState(null);
  const [history, setHistory] = useState([]);
  const [showHistory, setShowHistory] = useState(false);
  const [currentQuery, setCurrentQuery] = useState('');

  const loadHistory = useCallback(async () => {
    try {
      const h = await getHistory();
      setHistory(h);
    } catch (e) {
      console.error('加载历史失败:', e);
    }
  }, []);

  useEffect(() => { loadHistory(); }, [loadHistory]);

  const handleSubmit = async (query) => {
    setLoading(true);
    setError(null);
    setClarification(null);
    setPlan(null);
    setRoutes([]);
    setParsedRequest(null);
    setTransitMarkers([]);
    setVerification(null);
    setGeocodingWarnings([]);
    setSelectedDay(null);
    setCurrentQuery(query);

    try {
      const result = await generatePlan(query);

      if (result.status === 'need_clarification') {
        setClarification(result.questions);
        return;
      }

      setPlan(result.plan);
      setRoutes(result.routes || []);
      setParsedRequest(result.parsed_request || null);
      setTransitMarkers(result.transit_markers || []);
      setVerification(result.verification || null);
      setGeocodingWarnings(result.geocoding_warnings || []);

      await savePlan(query, {
        ...result.plan,
        __parsed_request: result.parsed_request || null,
        __transit_markers: result.transit_markers || [],
        __verification: result.verification || null,
        __geocoding_warnings: result.geocoding_warnings || [],
      }, result.routes);
      await loadHistory();
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  };

  const handleLoadHistory = (item) => {
    setPlan(item.plan);
    setRoutes(item.routes || []);
    setParsedRequest(item.plan?.__parsed_request || null);
    setTransitMarkers(item.plan?.__transit_markers || []);
    setVerification(item.plan?.__verification || null);
    setGeocodingWarnings(item.plan?.__geocoding_warnings || []);
    setSelectedDay(null);
    setClarification(null);
    setError(null);
    setShowHistory(false);
    setCurrentQuery(item.query);
  };

  const handleDeleteHistory = async (id) => {
    await deletePlan(id);
    await loadHistory();
  };

  return (
    <div className="app">
      <header className="app-header">
        <h1>🗺️ AItour</h1>
        <span className="subtitle">AI 旅行规划 · 自然语言生成地图行程</span>
        <button className="history-toggle" onClick={() => setShowHistory(!showHistory)}>
          📋 历史 ({history.length})
        </button>
      </header>

      <div className="app-body">
        <div className="left-panel">
          <InputPanel onSubmit={handleSubmit} loading={loading} initialQuery={currentQuery} />

          {error && (
            <div className="error-box">
              ❌ {error}
              <button onClick={() => handleSubmit(currentQuery)}>重试</button>
            </div>
          )}

          {clarification && (
            <div className="clarification-box">
              <h3>🤔 需要更多信息</h3>
              <ul>
                {clarification.map((q, i) => <li key={i}>{q}</li>)}
              </ul>
              <p>请补充以上信息后重新提交。</p>
            </div>
          )}

          <ParsedRequestPanel parsedRequest={parsedRequest} />
          <VerificationPanel verification={verification} geocodingWarnings={geocodingWarnings} />
          <TransitPanel markers={transitMarkers} />
          <PlanPanel plan={plan} selectedDay={selectedDay} onSelectDay={setSelectedDay} routes={routes} />
        </div>

        <div className="map-container">
          <MapView plan={plan} routes={routes} selectedDay={selectedDay} transitMarkers={transitMarkers} />
        </div>

        {showHistory && (
          <HistoryPanel
            history={history}
            onLoad={handleLoadHistory}
            onDelete={handleDeleteHistory}
            onClose={() => setShowHistory(false)}
          />
        )}
      </div>
    </div>
  );
}
