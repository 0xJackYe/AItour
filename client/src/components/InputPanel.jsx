import { useMemo, useState } from 'react';
import TripProfileForm from './TripProfileForm.jsx';
import { cloneProfile } from '../services/planModel.js';

const EXAMPLES = [
  {
    label: '京都轻松三日',
    query: '京都三日游，想去清水寺、伏见稻荷和岚山，住宿靠近地铁。',
    profile: { days: 3, budget: { level: 'moderate', amount: 1800, currency: 'CNY', basis: 'per_day', hardLimit: false }, pace: 'relaxed', transport: { priority: 'transfers', allowedModes: ['WALK', 'TRANSIT'], avoidModes: [] }, interests: ['文化', '美食'] },
  },
  {
    label: '东京亲子五日',
    query: '东京五日亲子游，想去迪士尼、浅草寺、秋叶原和台场。',
    profile: { days: 5, budget: { level: 'moderate', amount: 2500, currency: 'CNY', basis: 'per_day', hardLimit: false }, pace: 'moderate', transport: { priority: 'walking', allowedModes: ['TRANSIT', 'DRIVE'], avoidModes: ['BICYCLE'] }, travelers: { adults: 2, children: 1, seniors: 0 }, maxWalkingKm: 5, interests: ['亲子', '动漫'] },
  },
  {
    label: '巴黎文化四日',
    query: '巴黎四天三夜，安排埃菲尔铁塔、卢浮宫和凡尔赛宫，也想体验咖啡馆。',
    profile: { days: 4, budget: { level: 'luxury', amount: 900, currency: 'EUR', basis: 'per_person_total', hardLimit: false }, pace: 'moderate', transport: { priority: 'time', allowedModes: ['WALK', 'TRANSIT'], avoidModes: [] }, interests: ['艺术', '咖啡'] },
  },
];

export default function InputPanel({
  draft,
  onDraftChange,
  onClear,
  onSubmit,
  loading,
  draftStorageAvailable,
}) {
  const [confirmingClear, setConfirmingClear] = useState(false);
  const query = draft?.query || '';
  const profile = useMemo(() => cloneProfile(draft?.profile), [draft?.profile]);

  const setProfile = (update) => {
    onDraftChange(current => {
      const currentProfile = cloneProfile(current.profile);
      const nextProfile = typeof update === 'function' ? update(currentProfile) : update;
      return { ...current, profile: cloneProfile(nextProfile) };
    });
  };

  const requiredChecks = useMemo(() => ([
    Boolean(query.trim()),
    Number(profile.days) > 0,
    Boolean(profile.budget?.level),
    Boolean(profile.pace),
    Boolean(profile.transport?.priority),
  ]), [profile, query]);
  const completedRequired = requiredChecks.filter(Boolean).length;
  const completion = Math.round((completedRequired / requiredChecks.length) * 100);
  const distancePolicy = profile.transport?.distancePolicy || {};
  const distancePolicyValid = Number(distancePolicy.walkMaxKm) >= 0
    && Number(distancePolicy.localTransitMaxKm) >= Number(distancePolicy.walkMaxKm)
    && Number(distancePolicy.flightMinKm) > Number(distancePolicy.localTransitMaxKm);
  const canSubmit = completedRequired === requiredChecks.length && distancePolicyValid && !loading;

  const handleSubmit = (e) => {
    e.preventDefault();
    if (canSubmit) {
      onSubmit({ query: query.trim(), profile: cloneProfile(profile) });
    }
  };

  const applyExample = (example) => {
    setConfirmingClear(false);
    onDraftChange({ query: example.query, profile: cloneProfile(example.profile) });
  };

  return (
    <div className="input-panel">
      <form onSubmit={handleSubmit}>
        <div className="form-toolbar">
          <div>
            <strong>旅行需求</strong>
            <span>
              {draftStorageAvailable === false
                ? '浏览器阻止了本地保存，刷新后内容可能丢失'
                : '输入内容会自动保存在此设备'}
            </span>
          </div>
          {confirmingClear ? (
            <div className="clear-confirmation" role="group" aria-label="确认清空表单">
              <span>确定清空？</span>
              <button
                type="button"
                className="clear-confirm-button"
                onClick={() => {
                  onClear();
                  setConfirmingClear(false);
                }}
                disabled={loading}
              >确认</button>
              <button type="button" onClick={() => setConfirmingClear(false)}>取消</button>
            </div>
          ) : (
            <button
              type="button"
              className="clear-form-button"
              onClick={() => setConfirmingClear(true)}
              disabled={loading}
            >清空表单</button>
          )}
        </div>
        <textarea
          value={query}
          onChange={(event) => onDraftChange(current => ({ ...current, query: event.target.value }))}
          placeholder="描述你的旅行计划，比如：我想去京都玩三天，想去清水寺、伏见稻荷..."
          rows={3}
          disabled={loading}
          aria-label="描述旅行需求"
        />
        <TripProfileForm profile={profile} onChange={setProfile} disabled={loading} />
        <div className="profile-completeness" aria-live="polite">
          <div className="completeness-copy">
            <span>关键信息完整度</span>
            <strong>{completion}%</strong>
          </div>
          <div className="completeness-track" aria-hidden="true">
            <span style={{ width: `${completion}%` }} />
          </div>
          {completion < 100 && <p>请补全旅行天数、预算、节奏和交通优先级。</p>}
        </div>
        <button type="submit" disabled={!canSubmit}>
          {loading ? (
            <span className="loading-text" role="status">
              <span className="spinner" aria-hidden="true" />
              AI 规划中...
            </span>
          ) : '生成旅行计划'}
        </button>
      </form>
      <div className="examples">
        <span className="examples-label">试试看：</span>
        {EXAMPLES.map((example) => (
          <button
            key={example.label}
            type="button"
            className="example-btn"
            onClick={() => applyExample(example)}
            disabled={loading}
          >
            {example.label}
          </button>
        ))}
      </div>
    </div>
  );
}
