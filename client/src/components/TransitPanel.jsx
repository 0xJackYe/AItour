export default function TransitPanel({ markers = [] }) {
  if (!markers.length) return null;

  return (
    <div className="transit-panel">
      <h3>🚇 交通点位</h3>
      <div className="transit-list">
        {markers.map((item, index) => (
          <div key={`${item.name}-${index}`} className="transit-item">
            <strong>{item.name}</strong>
            <span>{item.coordinates?.display_name || '已定位'}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
