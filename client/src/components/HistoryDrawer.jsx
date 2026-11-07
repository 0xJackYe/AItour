import { useEffect } from 'react';
import { formatDate } from '../lib/format.js';
import Icon from './Icon.jsx';

export default function HistoryDrawer({ open, items, onSelect, onDelete, onClose }) {
  useEffect(() => {
    if (!open) return undefined;
    const onKeyDown = (event) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="scrim" onClick={onClose}>
      <aside className="drawer" role="dialog" aria-modal="true" aria-labelledby="history-title" onClick={event => event.stopPropagation()}>
        <header className="drawer-head">
          <h2 id="history-title">历史行程</h2>
          <button type="button" className="icon-btn" onClick={onClose} aria-label="关闭" autoFocus>
            <Icon name="close" />
          </button>
        </header>
        {items.length === 0 ? (
          <p className="empty">还没有行程。生成的行程会自动保存在这台设备的浏览器里。</p>
        ) : (
          <ul className="history-list">
            {items.map(item => (
              <li key={item.id} className="history-item">
                <button type="button" className="history-open" onClick={() => onSelect(item)}>
                  <strong>{item.title}</strong>
                  <span className="history-query">{item.query}</span>
                  <span className="history-date">{formatDate(item.createdAt)}</span>
                </button>
                <button type="button" className="icon-btn" onClick={() => onDelete(item.id)} aria-label={`删除“${item.title}”`}>
                  <Icon name="delete" size={18} />
                </button>
              </li>
            ))}
          </ul>
        )}
        <p className="drawer-foot">仅保存在当前浏览器，最多保留 30 条。</p>
      </aside>
    </div>
  );
}
