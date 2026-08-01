export default function HistoryPanel({ history, onLoad, onDelete, onClose }) {
  if (!history || history.length === 0) {
    return (
      <aside className="history-panel" role="dialog" aria-modal="true" aria-labelledby="history-title">
        <div className="history-header">
          <h3 id="history-title">历史版本</h3>
          <button type="button" className="close-btn" onClick={onClose} aria-label="关闭历史版本">×</button>
        </div>
        <p className="empty-history">暂无历史记录</p>
      </aside>
    );
  }

  return (
    <aside className="history-panel" role="dialog" aria-modal="true" aria-labelledby="history-title">
      <div className="history-header">
        <h3 id="history-title">历史版本</h3>
        <button type="button" className="close-btn" onClick={onClose} aria-label="关闭历史版本">×</button>
      </div>
      <div className="history-list">
        {history.map((item) => (
          <div key={item.id} className="history-item">
            <button type="button" className="history-info" onClick={() => onLoad(item)}>
              <strong>{item.plan?.title || `${item.plan?.city || '旅行'} ${item.plan?.days || ''}日游`}</strong>
              <p className="history-query">{item.query}</p>
              <span className="history-date">
                {new Date(item.createdAt).toLocaleDateString('zh-CN')}
              </span>
            </button>
            <button
              type="button"
              className="delete-btn"
              onClick={(e) => { e.stopPropagation(); onDelete(item.id); }}
              aria-label={`删除 ${item.plan?.title || '这条旅行计划'} 版本`}
            >
              🗑️
            </button>
          </div>
        ))}
      </div>
    </aside>
  );
}
