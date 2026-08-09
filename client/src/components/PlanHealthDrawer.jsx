function asIssue(item, severity, index) {
  if (typeof item === 'string') return { id: `${severity}-${index}-${item}`, severity, message: item };
  return {
    id: item?.id || `${severity}-${index}-${item?.code || item?.message || 'issue'}`,
    severity: item?.severity || severity,
    message: item?.message || item?.reason || item?.issue || '待确认项目',
    scope: item?.scope || item?.scopeLabel || item?.name || '',
  };
}

function normalizeIssues(health, verification, geocodingWarnings) {
  const issues = [];
  (health?.issues || []).forEach((item, index) => issues.push(asIssue(item, item?.severity || 'warning', index)));
  (health?.blocking_issues || health?.blocking || health?.blockers || []).forEach((item, index) => issues.push(asIssue(item, 'blocking', index)));
  (health?.warnings || []).forEach((item, index) => issues.push(asIssue(item, 'warning', index)));
  (health?.info || []).forEach((item, index) => issues.push(asIssue(item, 'info', index)));
  (verification?.missing_spots || []).forEach((item, index) => issues.push(asIssue(`需求中的“${item}”尚未覆盖`, 'blocking', index)));
  (verification?.incorrect_spots || []).forEach((item, index) => issues.push(asIssue(item, 'warning', index)));
  (verification?.warnings || []).forEach((item, index) => issues.push(asIssue(item, 'warning', index)));
  if ((verification?.skipped || verification?.status === 'unknown') && !(verification?.warnings || []).length) {
    issues.push(asIssue('AI 内容复核暂不可用；确定性路线与连续性检查仍已执行。', 'warning', issues.length));
  }
  (geocodingWarnings || []).forEach((item, index) => issues.push(asIssue(item, 'warning', index)));
  const seen = new Set();
  return issues.filter(issue => {
    const canonicalScope = String(issue.scope || '').replace(/^Day\s*\d+\s*[·-]\s*/i, '').trim();
    const canonicalMessage = String(issue.message || '')
      .replace(/（目标：[^）]+）/g, '')
      .replace(/^Day\s*\d+\s*[·-]\s*/i, '')
      .trim();
    const key = `${issue.severity}|${canonicalScope}|${canonicalMessage}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function adoptedRequestSummary(parsedRequest) {
  const constraints = parsedRequest?.constraints || {};
  const paceLabels = { relaxed: '轻松', balanced: '适中', packed: '紧凑' };
  return [
    parsedRequest?.days || constraints.days ? `${parsedRequest?.days || constraints.days} 天` : null,
    constraints.budget ? `预算 ${formatBudgetPreference(constraints.budget) || '待补充'}` : null,
    constraints.pace ? `节奏 ${paceLabels[constraints.pace] || constraints.pace}` : null,
  ].filter(Boolean).join(' · ') || '已解析目的地与旅行要求';
}

export default function PlanHealthDrawer({
  health,
  parsedRequest,
  verification,
  geocodingWarnings = [],
  transitMarkers = [],
}) {
  const issues = normalizeIssues(health, verification, geocodingWarnings);
  const blockingCount = issues.filter(issue => ['blocking', 'blocker', 'error'].includes(issue.severity)).length;
  const warningCount = issues.filter(issue => issue.severity === 'warning').length;
  const hasDetails = issues.length > 0 || parsedRequest || transitMarkers.length > 0;

  if (!health && !verification && !parsedRequest && !geocodingWarnings.length && !transitMarkers.length) return null;

  return (
    <details className={`plan-health ${blockingCount ? 'has-blocking' : warningCount ? 'has-warning' : 'is-ready'}`}>
      <summary>
        <span className="health-icon" aria-hidden="true">{blockingCount ? '!' : warningCount ? '△' : '✓'}</span>
        <span className="health-summary-copy">
          <strong>计划健康</strong>
          <small>{blockingCount} 个阻断问题 · {warningCount} 项待确认</small>
        </span>
        <span className="health-expand">查看详情</span>
      </summary>

      {hasDetails && (
        <div className="health-content">
          {issues.length > 0 ? (
            <ul className="health-issue-list">
              {issues.map(issue => (
                <li className={`health-issue ${issue.severity}`} key={issue.id}>
                  <span aria-hidden="true">{['blocking', 'blocker', 'error'].includes(issue.severity) ? '●' : issue.severity === 'warning' ? '▲' : '●'}</span>
                  <div>
                    {issue.scope && <strong>{issue.scope}</strong>}
                    <p>{issue.message}</p>
                  </div>
                </li>
              ))}
            </ul>
          ) : (
            <p className="health-ready-copy">当前没有发现阻断问题。营业时间、预约和实时交通仍建议出发前复核。</p>
          )}

          {parsedRequest && (
            <section className="health-technical-section">
              <h4>已采用的需求</h4>
              <p>{adoptedRequestSummary(parsedRequest)}</p>
            </section>
          )}

          {transitMarkers.length > 0 && (
            <section className="health-technical-section">
              <h4>已识别交通点</h4>
              <p>{transitMarkers.map(item => item.name).filter(Boolean).join('、')}</p>
            </section>
          )}
        </div>
      )}
    </details>
  );
}
import { formatBudgetPreference } from '../services/planModel.js';
