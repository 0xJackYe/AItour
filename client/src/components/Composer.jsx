import { useEffect, useLayoutEffect, useRef } from 'react';
import Icon from './Icon.jsx';

const EXAMPLES = [
  '我想去京都玩三天，想去清水寺、伏见稻荷、岚山，住在地铁方便的地方，行程别太赶',
  '东京五日游，带小孩，想去迪士尼、浅草寺、秋叶原、台场，预算中等',
  '巴黎四天三夜，想看埃菲尔铁塔、卢浮宫、凡尔赛宫，喜欢咖啡馆和甜品',
  '成都三天美食之旅，想吃火锅、串串，顺便看看大熊猫和武侯祠',
];

const EXAMPLE_LABELS = ['京都 · 3 天', '东京亲子 · 5 天', '巴黎 · 4 天', '成都美食 · 3 天'];

export default function Composer({ value, onChange, onSubmit, onCancel, busy, hasResult, focusSignal = 0, maxLength = 1000 }) {
  const textareaRef = useRef(null);

  // 点“新行程”后直接可以输入。
  useLayoutEffect(() => {
    if (focusSignal) textareaRef.current?.focus();
  }, [focusSignal]);

  // 自动增高，最多约 8 行。
  useEffect(() => {
    const element = textareaRef.current;
    if (!element) return;
    element.style.height = 'auto';
    element.style.height = `${Math.min(element.scrollHeight, 200)}px`;
  }, [value]);

  const canSubmit = value.trim().length > 0 && !busy;
  const submit = (event) => {
    event?.preventDefault();
    if (canSubmit) onSubmit(value.trim());
  };

  return (
    <div className="composer-wrap">
      <form className={`composer ${busy ? 'is-busy' : ''}`} onSubmit={submit}>
        <label htmlFor="trip-query" className="visually-hidden">描述你的旅行</label>
        <textarea
          id="trip-query"
          ref={textareaRef}
          value={value}
          rows={3}
          maxLength={maxLength}
          placeholder="想去哪里、玩几天、有什么偏好？例如：京都三天，想去清水寺和岚山，行程别太赶"
          onChange={event => onChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) submit(event);
          }}
          disabled={busy}
        />
        <div className="composer-footer">
          <span className="composer-hint">
            {value.length > maxLength * 0.8 ? `${value.length}/${maxLength}` : <span className="kbd-hint">Ctrl + Enter 发送</span>}
          </span>
          {/* 两个按钮使用不同 key：避免 React 复用同一个 DOM 元素，导致点击“停止”后
              按钮在同一次点击中变成 submit 而再次提交表单。 */}
          {busy ? (
            <button
              key="stop"
              type="button"
              className="btn btn-tonal"
              onClick={(event) => {
                event.preventDefault();
                onCancel();
              }}
            >
              <Icon name="stop" size={18} />
              停止
            </button>
          ) : (
            <button key="submit" type="submit" className="btn btn-primary" disabled={!canSubmit}>
              <Icon name={hasResult ? 'refresh' : 'sparkle'} size={18} />
              {hasResult ? '重新生成' : '生成行程'}
            </button>
          )}
        </div>
      </form>

      {!hasResult && !busy && (
        <div className="examples" aria-label="示例">
          {EXAMPLES.map((example, index) => (
            <button key={example} type="button" className="chip" onClick={() => onChange(example)} title={example}>
              {EXAMPLE_LABELS[index]}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
