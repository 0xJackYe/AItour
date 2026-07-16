export default function ParsedRequestPanel({ parsedRequest }) {
  if (!parsedRequest) return null;

  const interests = parsedRequest.preferences?.interests || [];
  const destinationLabel = (parsedRequest.destinations || [])
    .map(item => item.city)
    .filter(Boolean)
    .join(' → ');

  return (
    <div className="parsed-panel">
      <h3>🧠 解析结果</h3>
      <div className="parsed-grid">
        <div><span>城市</span><strong>{parsedRequest.city || '未识别'}</strong></div>
        <div><span>国家</span><strong>{parsedRequest.country || '未识别'}</strong></div>
        <div><span>天数</span><strong>{parsedRequest.days || '未识别'}</strong></div>
        <div><span>节奏</span><strong>{parsedRequest.constraints?.pace || '未识别'}</strong></div>
        <div><span>预算</span><strong>{parsedRequest.constraints?.budget || '未识别'}</strong></div>
        <div><span>兴趣</span><strong>{interests.length ? interests.join('、') : '未识别'}</strong></div>
        {destinationLabel && <div><span>路线</span><strong>{destinationLabel}</strong></div>}
      </div>
    </div>
  );
}
