import { useEffect, useState } from 'react';

const EXAMPLES = [
  '我想去京都玩三天，想去清水寺、伏见稻荷、岚山，住在地铁方便的地方，行程别太赶',
  '东京五日游，带小孩，想去迪士尼、浅草寺、秋叶原、台场，预算中等',
  '巴黎四天三夜，想看埃菲尔铁塔、卢浮宫、凡尔赛宫，喜欢咖啡馆和甜品',
  '成都三天美食之旅，想吃火锅、串串，顺便看看大熊猫和武侯祠',
];

export default function InputPanel({ onSubmit, loading, initialQuery = '' }) {
  const [query, setQuery] = useState(initialQuery);

  useEffect(() => {
    setQuery(initialQuery || '');
  }, [initialQuery]);

  const handleSubmit = (e) => {
    e.preventDefault();
    if (query.trim() && !loading) {
      onSubmit(query.trim());
    }
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
        />
        <button type="submit" disabled={loading || !query.trim()}>
          {loading ? (
            <span className="loading-text">
              <span className="spinner" />
              AI 规划中...
            </span>
          ) : '生成旅行计划'}
        </button>
      </form>
      <div className="examples">
        <span className="examples-label">试试看：</span>
        {EXAMPLES.map((ex, i) => (
          <button
            key={i}
            className="example-btn"
            onClick={() => setQuery(ex)}
            disabled={loading}
          >
            {ex.length > 25 ? ex.substring(0, 25) + '...' : ex}
          </button>
        ))}
      </div>
    </div>
  );
}
