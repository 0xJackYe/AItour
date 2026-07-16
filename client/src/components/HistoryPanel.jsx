export default function HistoryPanel({ history, onLoad, onDelete, onClose }) {
  if (!history || history.length === 0) {
    return (
      <div className="history-panel">
        <div className="history-header">
          <h3>📋 历史记录</h3>
          <button className="close-btn" onClick={onClose}>×</button>
        </div>
        <p className="empty-history">暂无历史记录</p>
      </div>
    );
  }

  return (
    <div className="history-panel">
      <div className="history-header">
        <h3>📋 历史记录</h3>
        <button className="close-btn" onClick={onClose}>×</button>
      </div>
      <div className="history-list">
        {history.map((item) => (
          <div key={item.id} className="history-item">
            <div className="history-info" onClick={() => onLoad(item)}>
              <strong>{item.plan?.city} {item.plan?.days}日游</strong>
              <p className="history-query">{item.query}</p>
              <span className="history-date">
                {new Date(item.createdAt).toLocaleDateString('zh-CN')}
              </span>
            </div>
            <button
              className="delete-btn"
              onClick={(e) => { e.stopPropagation(); onDelete(item.id); }}
              title="删除"
            >
              🗑️
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
