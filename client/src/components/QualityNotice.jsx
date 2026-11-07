import { summarizeQuality } from '../lib/plan.js';
import Icon from './Icon.jsx';

// 把“AI 自审 + 地图校验”压缩成一行结论；有问题时才可展开查看明细。
export default function QualityNotice({ result }) {
  const summary = summarizeQuality(result);
  const icon = summary.tone === 'ok' ? 'check' : 'info';

  if (summary.issueCount === 0) {
    return (
      <p className={`quality is-${summary.tone}`}>
        <Icon name={icon} size={18} />
        <span>{summary.headline}{summary.skipped ? '（AI 自审暂不可用）' : ''}</span>
      </p>
    );
  }

  return (
    <details className={`quality is-${summary.tone}`}>
      <summary>
        <Icon name={icon} size={18} />
        <span>{summary.headline}</span>
        <span className="quality-count">{summary.issueCount} 条提示</span>
        <Icon name="expand" size={18} className="chevron" />
      </summary>
      <div className="quality-body">
        {summary.groups.map(group => (
          <div key={group.title} className="quality-group">
            <h4>{group.title}</h4>
            <ul>
              {group.items.map((item, index) => (
                <li key={`${item.name}-${index}`}>
                  {item.name && <strong>{item.name}</strong>}
                  {item.name && item.text ? '：' : ''}
                  {item.text}
                </li>
              ))}
            </ul>
          </div>
        ))}
        <p className="quality-note">外地同名地点会被自动移除；无法确认的地点保留在行程中，但不会显示在地图上。</p>
      </div>
    </details>
  );
}
