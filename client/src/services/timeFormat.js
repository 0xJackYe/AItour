function localizedText(value) {
  if (typeof value === 'string') return value.trim();
  if (!value || typeof value !== 'object') return '';
  return String(
    value.text
      || value.localized_text
      || value.localizedText
      || value.value?.text
      || value.time?.text
      || '',
  ).trim();
}

function timeZoneOf(source, field) {
  return source?.[`${field}_time_zone`]
    || source?.[`${field}TimeZone`]
    || source?.time_zone
    || source?.timeZone
    || source?.from_stop?.time_zone
    || source?.fromStop?.timeZone
    || null;
}

function appendTimeZoneHint(text, timeZone) {
  if (!text || !timeZone || text.includes(timeZone)) return text;
  return `${text} · ${timeZone}`;
}

export function formatTimeValue(value, { timeZone = null, locale = 'zh-CN' } = {}) {
  if (value === null || value === undefined || value === '') return '';
  const raw = String(value).trim();
  if (!raw) return '';

  const hasExplicitOffset = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(raw);
  if (hasExplicitOffset) {
    const instant = new Date(raw);
    if (!Number.isNaN(instant.getTime())) {
      const resolvedTimeZone = timeZone || Intl.DateTimeFormat().resolvedOptions().timeZone;
      try {
        return new Intl.DateTimeFormat(locale, {
          hour: '2-digit',
          minute: '2-digit',
          hourCycle: 'h23',
          timeZone: resolvedTimeZone,
          timeZoneName: 'short',
        }).format(instant);
      } catch {
        return new Intl.DateTimeFormat(locale, {
          hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZoneName: 'short',
        }).format(instant);
      }
    }
  }

  const clock = raw.match(/(?:T|^)(\d{2}:\d{2})(?::\d{2})?/i)?.[1];
  if (clock) return appendTimeZoneHint(clock, timeZone);
  return appendTimeZoneHint(raw, timeZone);
}

export function formatSegmentTime(segment = {}, field, options = {}) {
  const camelField = field.replace(/_([a-z])/g, (_, letter) => letter.toUpperCase());
  const pascalField = camelField[0].toUpperCase() + camelField.slice(1);
  const localized = segment[`localized_${field}`]
    ?? segment[`localized${pascalField}`]
    ?? segment.localized_values?.transit?.[camelField]
    ?? segment.localizedValues?.transit?.[camelField]
    ?? segment.localized_values?.[field]
    ?? segment.localizedValues?.[camelField]
    ?? null;
  const text = localizedText(localized);
  const timeZone = localized?.time_zone || localized?.timeZone || timeZoneOf(segment, field);
  if (text) return appendTimeZoneHint(text, timeZone);
  return formatTimeValue(segment[field] ?? segment[camelField], { ...options, timeZone });
}
