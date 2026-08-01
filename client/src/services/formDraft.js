import { cloneProfile, EMPTY_PROFILE } from './planModel.js';

export const FORM_DRAFT_STORAGE_KEY = 'aitour:form-draft:v1';
const FORM_DRAFT_VERSION = 1;
const MAX_QUERY_LENGTH = 12000;

export function emptyFormDraft() {
  return { query: '', profile: cloneProfile(EMPTY_PROFILE) };
}

export function normalizeFormDraft(value) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const sourceProfile = source.profile && typeof source.profile === 'object' && !Array.isArray(source.profile)
    ? source.profile
    : EMPTY_PROFILE;
  const profile = cloneProfile(sourceProfile);
  profile.transport.allowedModes = Array.isArray(profile.transport.allowedModes)
    ? profile.transport.allowedModes.filter(mode => typeof mode === 'string')
    : [...EMPTY_PROFILE.transport.allowedModes];
  profile.transport.avoidModes = Array.isArray(profile.transport.avoidModes)
    ? profile.transport.avoidModes.filter(mode => typeof mode === 'string')
    : [...EMPTY_PROFILE.transport.avoidModes];
  return {
    query: typeof source.query === 'string' ? source.query.slice(0, MAX_QUERY_LENGTH) : '',
    profile,
  };
}

export function isEmptyFormDraft(value) {
  const draft = normalizeFormDraft(value);
  const empty = emptyFormDraft();
  return !draft.query && JSON.stringify(draft.profile) === JSON.stringify(empty.profile);
}

function browserStorage(storage) {
  return storage === undefined ? globalThis.localStorage : storage;
}

export function loadFormDraft(storage) {
  try {
    const raw = browserStorage(storage)?.getItem(FORM_DRAFT_STORAGE_KEY);
    if (!raw) return emptyFormDraft();
    const payload = JSON.parse(raw);
    if (payload?.version !== FORM_DRAFT_VERSION) return emptyFormDraft();
    return normalizeFormDraft(payload.draft);
  } catch {
    return emptyFormDraft();
  }
}

export function saveFormDraft(value, storage) {
  try {
    const target = browserStorage(storage);
    if (!target) return false;
    const draft = normalizeFormDraft(value);
    if (isEmptyFormDraft(draft)) {
      target.removeItem(FORM_DRAFT_STORAGE_KEY);
      return true;
    }
    target.setItem(FORM_DRAFT_STORAGE_KEY, JSON.stringify({
      version: FORM_DRAFT_VERSION,
      updatedAt: Date.now(),
      draft,
    }));
    return true;
  } catch {
    return false;
  }
}

export function clearFormDraft(storage) {
  try {
    const target = browserStorage(storage);
    if (!target) return false;
    target.removeItem(FORM_DRAFT_STORAGE_KEY);
    return true;
  } catch {
    return false;
  }
}
