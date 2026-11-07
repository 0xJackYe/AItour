import Icon from './Icon.jsx';

const STEPS = [
  { id: 'parse', label: '理解需求' },
  { id: 'generate', label: '生成行程' },
  { id: 'verify', label: '校验地点' },
  { id: 'route', label: '规划路线' },
];

// “根据校验结果修正”属于校验阶段的一部分，避免步骤条倒退。
const STAGE_TO_STEP = { parse: 0, generate: 1, verify: 2, regenerate: 2, route: 3 };

export default function Progress({ progress, onCancel }) {
  const activeIndex = STAGE_TO_STEP[progress?.stage] ?? 0;
  const percent = Math.round((progress?.progress ?? 0) * 100);
  return (
    <section className="card progress-card" aria-live="polite" aria-busy="true">
      <ol className="steps">
        {STEPS.map((step, index) => {
          const state = index < activeIndex ? 'done' : index === activeIndex ? 'active' : 'todo';
          return (
            <li key={step.id} className={`step is-${state}`}>
              <span className="step-dot" aria-hidden="true">
                {state === 'done' ? <Icon name="check" size={18} /> : state === 'active' ? <span className="spinner" /> : null}
              </span>
              <span className="step-label">{step.label}</span>
            </li>
          );
        })}
      </ol>
      <div className="progress-bar" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent}>
        <span style={{ width: `${Math.max(4, percent)}%` }} />
      </div>
      <div className="progress-footer">
        <p className="progress-message">{progress?.message || '正在连接…'}</p>
        <button type="button" className="btn btn-text" onClick={onCancel}>取消</button>
      </div>
    </section>
  );
}
