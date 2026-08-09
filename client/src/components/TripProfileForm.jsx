const MODE_OPTIONS = [
  ['WALK', '步行'],
  ['TRANSIT', '公共交通'],
  ['DRIVE', '驾车 / 打车'],
  ['BICYCLE', '骑行'],
  ['RAIL', '城际铁路'],
  ['FLIGHT', '飞机'],
];

const TRANSIT_OPTIONS = [
  ['BUS', '公交车 / 巴士'],
  ['SUBWAY', '地铁'],
  ['TRAIN', '普通火车'],
  ['LIGHT_RAIL', '轻轨 / 有轨电车'],
  ['RAIL', '城际铁路 / 新干线'],
];

function NumberField({ label, value, min = 0, max, step = 1, onChange, disabled }) {
  return (
    <label className="profile-field">
      <span>{label}</span>
      <input
        type="number"
        min={min}
        max={max}
        step={step}
        value={value ?? ''}
        onChange={(event) => onChange(event.target.value === '' ? '' : Number(event.target.value))}
        disabled={disabled}
      />
    </label>
  );
}

function ModeChecks({ title, values = [], onToggle, disabled, options = MODE_OPTIONS, description }) {
  return (
    <fieldset className="profile-fieldset">
      <legend>{title}</legend>
      {description && <p className="fieldset-description">{description}</p>}
      <div className="check-chip-list">
        {options.map(([value, label]) => (
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
  const updateTransportPreference = (key, field, value) => onChange(current => ({
    ...current,
    transport: {
      ...(current.transport || {}),
      [key]: {
        ...(current.transport?.[key] || {}),
        [field]: value,
      },
    },
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
  const distancePolicy = profile.transport?.distancePolicy || {};
  const invalidDistancePolicy = Number(distancePolicy.localTransitMaxKm) < Number(distancePolicy.walkMaxKm)
    || Number(distancePolicy.flightMinKm) <= Number(distancePolicy.localTransitMaxKm);

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

          <section className="profile-subsection transport-policy-section" aria-labelledby="distance-policy-title">
            <div className="profile-subsection-heading">
              <h4 id="distance-policy-title">按距离选择交通</h4>
              <span>后端会结合实际路线和你的总体优先级选择最优方案</span>
            </div>
            <div className="profile-grid distance-policy-grid">
              <NumberField
                label="这个距离以内优先步行（km）"
                value={distancePolicy.walkMaxKm}
                min={0}
                max={20}
                step={0.1}
                onChange={value => updateTransportPreference('distancePolicy', 'walkMaxKm', value)}
                disabled={disabled}
              />
              <NumberField
                label="这个距离以内优先市内公交（km）"
                value={distancePolicy.localTransitMaxKm}
                min={0.1}
                max={500}
                step={0.1}
                onChange={value => updateTransportPreference('distancePolicy', 'localTransitMaxKm', value)}
                disabled={disabled}
              />
              <NumberField
                label="超过这个距离可优先考虑飞机（km）"
                value={distancePolicy.flightMinKm}
                min={50}
                max={20000}
                step={10}
                onChange={value => updateTransportPreference('distancePolicy', 'flightMinKm', value)}
                disabled={disabled}
              />
            </div>
            {invalidDistancePolicy && (
              <p className="field-validation" role="alert">距离阈值应按“步行 → 市内公交 → 飞机”递增。</p>
            )}
          </section>

          <ModeChecks
            title="公共交通工具偏好"
            description="可多选；计划会显示实际公交、地铁、火车或轻轨线路。"
            options={TRANSIT_OPTIONS}
            values={profile.transport?.transitPreferences?.allowedModes || []}
            onToggle={mode => {
              const values = profile.transport?.transitPreferences?.allowedModes || [];
              updateTransportPreference(
                'transitPreferences',
                'allowedModes',
                values.includes(mode) ? values.filter(item => item !== mode) : [...values, mode],
              );
            }}
            disabled={disabled}
          />
          <label className="profile-field routing-preference-field">
            <span>公共交通路线偏好</span>
            <select
              value={profile.transport?.transitPreferences?.routingPreference || ''}
              onChange={event => updateTransportPreference('transitPreferences', 'routingPreference', event.target.value)}
              disabled={disabled}
            >
              <option value="">综合平衡</option>
              <option value="LESS_WALKING">少步行</option>
              <option value="FEWER_TRANSFERS">少换乘</option>
            </select>
          </label>

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
