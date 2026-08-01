const MODE_OPTIONS = [
  ['WALK', '步行'],
  ['TRANSIT', '公共交通'],
  ['DRIVE', '驾车 / 打车'],
  ['BICYCLE', '骑行'],
  ['RAIL', '城际铁路'],
  ['FLIGHT', '飞机'],
];

function NumberField({ label, value, min = 0, onChange, disabled }) {
  return (
    <label className="profile-field">
      <span>{label}</span>
      <input
        type="number"
        min={min}
        value={value ?? ''}
        onChange={(event) => onChange(event.target.value === '' ? '' : Number(event.target.value))}
        disabled={disabled}
      />
    </label>
  );
}

function ModeChecks({ title, values = [], onToggle, disabled }) {
  return (
    <fieldset className="profile-fieldset">
      <legend>{title}</legend>
      <div className="check-chip-list">
        {MODE_OPTIONS.map(([value, label]) => (
          <label className={`check-chip ${values.includes(value) ? 'checked' : ''}`} key={value}>
            <input
              type="checkbox"
              checked={values.includes(value)}
              onChange={() => onToggle(value)}
              disabled={disabled}
            />
            {label}
          </label>
        ))}
      </div>
    </fieldset>
  );
}

export default function TripProfileForm({ profile, onChange, disabled = false }) {
  const update = (key, value) => onChange(current => ({ ...current, [key]: value }));
  const updateNested = (key, field, value) => onChange(current => ({
    ...current,
    [key]: { ...(current[key] || {}), [field]: value },
  }));
  const updateModes = (field, mode) => {
    onChange(current => {
      const otherField = field === 'allowedModes' ? 'avoidModes' : 'allowedModes';
      const currentValues = current.transport?.[field] || [];
      const values = currentValues.includes(mode)
        ? currentValues.filter(item => item !== mode)
        : [...currentValues, mode];
      const otherValues = (current.transport?.[otherField] || []).filter(item => !values.includes(item));
      return {
        ...current,
        transport: {
          ...(current.transport || {}),
          [field]: values,
          [otherField]: otherValues,
        },
      };
    });
  };
  const interestsText = (profile.interests || []).join('、');

  return (
    <div className="trip-profile-form">
      <div className="profile-section-title">
        <div>
          <strong>规划偏好</strong>
          <span>先确认关键条件，路线和交通会更可靠</span>
        </div>
        <span className="required-note">* 必填</span>
      </div>

      <div className="profile-grid essentials-grid">
        <label className="profile-field">
          <span>旅行天数 *</span>
          <input
            type="number"
            min="1"
            max="180"
            value={profile.days ?? ''}
            onChange={(event) => update('days', event.target.value === '' ? '' : Number(event.target.value))}
            disabled={disabled}
            required
          />
        </label>
        <label className="profile-field">
          <span>开始日期（影响公交班次）</span>
          <input
            type="date"
            value={profile.startDate || ''}
            onChange={(event) => update('startDate', event.target.value)}
            disabled={disabled}
          />
        </label>
        <label className="profile-field">
          <span>预算档位 *</span>
          <select
            value={profile.budget?.level || ''}
            onChange={(event) => updateNested('budget', 'level', event.target.value)}
            disabled={disabled}
            required
          >
            <option value="">请选择</option>
            <option value="budget">经济</option>
            <option value="moderate">适中</option>
            <option value="luxury">舒适 / 高端</option>
          </select>
        </label>
        <label className="profile-field">
          <span>行程节奏 *</span>
          <select value={profile.pace || ''} onChange={(event) => update('pace', event.target.value)} disabled={disabled} required>
            <option value="">请选择</option>
            <option value="relaxed">轻松</option>
            <option value="moderate">适中</option>
            <option value="intensive">紧凑</option>
          </select>
        </label>
        <label className="profile-field profile-field-wide">
          <span>交通优先级 *</span>
          <select
            value={profile.transport?.priority || ''}
            onChange={(event) => updateNested('transport', 'priority', event.target.value)}
            disabled={disabled}
            required
          >
            <option value="">请选择</option>
            <option value="time">省时间</option>
            <option value="cost">省费用</option>
            <option value="walking">少步行</option>
            <option value="transfers">少换乘</option>
            <option value="comfort">舒适优先</option>
            <option value="balanced">综合平衡</option>
          </select>
        </label>
      </div>

      <details className="profile-details">
        <summary>补充同行人、交通、住宿和特殊需求</summary>
        <div className="profile-details-content">
          <div className="profile-grid budget-grid">
            <NumberField label="预算金额" value={profile.budget?.amount} onChange={value => updateNested('budget', 'amount', value)} disabled={disabled} />
            <label className="profile-field">
              <span>币种</span>
              <select value={profile.budget?.currency || 'CNY'} onChange={event => updateNested('budget', 'currency', event.target.value)} disabled={disabled}>
                <option value="CNY">CNY 人民币</option>
                <option value="USD">USD 美元</option>
                <option value="EUR">EUR 欧元</option>
                <option value="JPY">JPY 日元</option>
                <option value="GBP">GBP 英镑</option>
              </select>
            </label>
            <label className="profile-field">
              <span>预算口径</span>
              <select value={profile.budget?.basis || 'total'} onChange={event => updateNested('budget', 'basis', event.target.value)} disabled={disabled}>
                <option value="total">全程总预算</option>
                <option value="per_day">全体每天</option>
                <option value="per_person_total">每人全程</option>
                <option value="per_person_day">每人每天</option>
              </select>
            </label>
            <label className="budget-hard-limit">
              <input
                type="checkbox"
                checked={profile.budget?.hardLimit === true}
                onChange={event => updateNested('budget', 'hardLimit', event.target.checked)}
                disabled={disabled}
              />
              <span>预算不可超支（作为硬约束）</span>
            </label>
          </div>

          <div className="profile-subsection">
            <h4>同行人</h4>
            <div className="profile-grid travelers-grid">
              <NumberField label="成人" min={1} value={profile.travelers?.adults} onChange={value => updateNested('travelers', 'adults', value)} disabled={disabled} />
              <NumberField label="儿童" value={profile.travelers?.children} onChange={value => updateNested('travelers', 'children', value)} disabled={disabled} />
              <NumberField label="长者" value={profile.travelers?.seniors} onChange={value => updateNested('travelers', 'seniors', value)} disabled={disabled} />
            </div>
          </div>

          <ModeChecks
            title="可用交通方式"
            values={profile.transport?.allowedModes || []}
            onToggle={mode => updateModes('allowedModes', mode)}
            disabled={disabled}
          />
          <ModeChecks
            title="希望避免"
            values={profile.transport?.avoidModes || []}
            onToggle={mode => updateModes('avoidModes', mode)}
            disabled={disabled}
          />

          <div className="profile-grid">
            <NumberField label="每天最多步行（km）" value={profile.maxWalkingKm} onChange={value => update('maxWalkingKm', value)} disabled={disabled} />
            <label className="profile-field">
              <span>每天最早开始</span>
              <input type="time" value={profile.dailyStartTime || ''} onChange={event => update('dailyStartTime', event.target.value)} disabled={disabled} />
            </label>
            <label className="profile-field">
              <span>每天最晚结束</span>
              <input type="time" value={profile.dailyEndTime || ''} onChange={event => update('dailyEndTime', event.target.value)} disabled={disabled} />
            </label>
            <label className="profile-field">
              <span>住宿类型</span>
              <select value={profile.accommodation?.style || ''} onChange={event => updateNested('accommodation', 'style', event.target.value)} disabled={disabled}>
                <option value="">不限</option>
                <option value="hotel">酒店</option>
                <option value="hostel">青旅</option>
                <option value="apartment">公寓</option>
                <option value="resort">度假村</option>
                <option value="ryokan">特色旅馆</option>
              </select>
            </label>
            <label className="profile-field profile-field-wide">
              <span>住宿位置偏好</span>
              <input
                value={profile.accommodation?.locationPriority || ''}
                onChange={event => updateNested('accommodation', 'locationPriority', event.target.value)}
                placeholder="例如：地铁站附近、景区步行范围"
                disabled={disabled}
              />
            </label>
            <label className="profile-field profile-field-wide">
              <span>兴趣</span>
              <input
                value={interestsText}
                onChange={event => update('interests', event.target.value.split(/[、,，]/).map(item => item.trim()).filter(Boolean))}
                placeholder="文化、美食、自然、亲子"
                disabled={disabled}
              />
            </label>
            <label className="profile-field profile-field-wide">
              <span>饮食需求</span>
              <input value={profile.dietaryNeeds || ''} onChange={event => update('dietaryNeeds', event.target.value)} placeholder="例如：素食、清真、过敏原" disabled={disabled} />
            </label>
            <label className="profile-field profile-field-wide">
              <span>无障碍 / 体力需求</span>
              <input value={profile.accessibilityNeeds || ''} onChange={event => update('accessibilityNeeds', event.target.value)} placeholder="例如：需轮椅通道、避免台阶" disabled={disabled} />
            </label>
            <label className="profile-field profile-field-wide">
              <span>其它备注</span>
              <textarea value={profile.notes || ''} onChange={event => update('notes', event.target.value)} rows="2" placeholder="固定预约、必须保留的活动等" disabled={disabled} />
            </label>
          </div>
        </div>
      </details>
    </div>
  );
}
