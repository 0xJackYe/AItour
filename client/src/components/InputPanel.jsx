import { useEffect, useMemo, useState } from 'react';
import TripProfileForm from './TripProfileForm.jsx';

export const DEFAULT_PROFILE = {
  days: '',
  startDate: '',
  budget: { level: '', amount: '', currency: 'CNY', basis: 'total', hardLimit: false },
  pace: '',
  transport: { priority: '', allowedModes: ['WALK', 'TRANSIT'], avoidModes: [] },
  travelers: { adults: 1, children: 0, seniors: 0 },
  maxWalkingKm: 6,
  dailyStartTime: '09:00',
  dailyEndTime: '20:00',
  interests: [],
  accommodation: { style: 'hotel', locationPriority: '公共交通方便' },
  dietaryNeeds: '',
  accessibilityNeeds: '',
  notes: '',
};

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

function mergeProfile(profile) {
  return {
    ...DEFAULT_PROFILE,
    ...(profile || {}),
    budget: { ...DEFAULT_PROFILE.budget, ...(profile?.budget || {}) },
    transport: { ...DEFAULT_PROFILE.transport, ...(profile?.transport || {}) },
    travelers: { ...DEFAULT_PROFILE.travelers, ...(profile?.travelers || {}) },
    accommodation: { ...DEFAULT_PROFILE.accommodation, ...(profile?.accommodation || {}) },
    interests: Array.isArray(profile?.interests) ? profile.interests : [],
  };
}

export default function InputPanel({ onSubmit, loading, initialQuery = '', initialProfile }) {
  const [query, setQuery] = useState(initialQuery);
  const [profile, setProfile] = useState(() => mergeProfile(initialProfile));

  useEffect(() => {
    setQuery(initialQuery || '');
  }, [initialQuery]);

  useEffect(() => {
    setProfile(mergeProfile(initialProfile));
  }, [initialProfile]);

  const requiredChecks = useMemo(() => ([
    Boolean(query.trim()),
    Number(profile.days) > 0,
    Boolean(profile.budget?.level),
    Boolean(profile.pace),
    Boolean(profile.transport?.priority),
  ]), [profile, query]);
  const completedRequired = requiredChecks.filter(Boolean).length;
  const completion = Math.round((completedRequired / requiredChecks.length) * 100);
  const canSubmit = completedRequired === requiredChecks.length && !loading;

  const handleSubmit = (e) => {
    e.preventDefault();
    if (canSubmit) {
      onSubmit({ query: query.trim(), profile: mergeProfile(profile) });
    }
  };

  const applyExample = (example) => {
    setQuery(example.query);
    setProfile(mergeProfile(example.profile));
  };

  return (
    <div className="input-panel">
      <form onSubmit={handleSubmit}>
        <textarea
          value={query}
          onChange={(e) => setQuery(e.target.value)}
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
