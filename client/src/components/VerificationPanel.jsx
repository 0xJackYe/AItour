export default function VerificationPanel({ verification, geocodingWarnings = [] }) {
  if (!verification && (!geocodingWarnings || geocodingWarnings.length === 0)) return null;

  const v = verification || {};
  const hasMissing = v.missing_spots?.length > 0;
  const hasIncorrect = v.incorrect_spots?.length > 0;
  const hasWarnings = v.warnings?.length > 0;
  const hasGeocodingWarnings = geocodingWarnings.length > 0;
  const cleanPass = v.passed && !hasMissing && !hasIncorrect && !hasWarnings && !hasGeocodingWarnings;

  return (
    <div className={`verify-panel ${cleanPass ? 'pass' : 'warn'}`}>
      <h3>
        {cleanPass ? '✅ 计划自审通过' : '🔎 计划自审'}
        {v.regenerated && <span className="regen-badge">已自动修正</span>}
        {v.skipped && <span className="regen-badge">已跳过</span>}
      </h3>

      {cleanPass && <p className="pass-text">已对照原始需求复核，景点覆盖与准确性无明显问题。</p>}

      {hasMissing && (
        <div className="verify-block">
          <strong>❌ 缺失景点</strong>
          <ul>
            {v.missing_spots.map((s, i) => <li key={i}>{s}</li>)}
          </ul>
        </div>
      )}

      {hasIncorrect && (
        <div className="verify-block">
          <strong>⚠️ 准确性问题</strong>
          <ul>
            {v.incorrect_spots.map((s, i) => (
              <li key={i}><b>{s.name}</b>：{s.issue}</li>
            ))}
          </ul>
        </div>
      )}

      {hasWarnings && (
        <div className="verify-block">
          <strong>💡 提示</strong>
          <ul>
            {v.warnings.map((w, i) => <li key={i}>{w}</li>)}
          </ul>
        </div>
      )}

      {hasGeocodingWarnings && (
        <div className="verify-block">
          <strong>📍 地理编码警告</strong>
          <ul>
            {geocodingWarnings.map((w, i) => (
              <li key={i}><b>{w.name}</b>：{w.reason}</li>
            ))}
          </ul>
          <p className="hint">外地同名候选会被自动剔除；无法确认的地点不会上图，并会保留警告供检查。</p>
        </div>
      )}
    </div>
  );
}
