import { firstDayNumber } from './planModel.js';

export const initialTripState = {
  committed: null,
  pending: null,
  clarification: null,
  selection: { day: null, nodeId: null, legId: null },
  undoStack: [],
  redoStack: [],
  error: null,
  notice: null,
  showHistory: false,
};

export function tripReducer(state, action) {
  switch (action.type) {
    case 'GENERATE_START':
      return {
        ...state,
        pending: { requestId: action.requestId, stage: action.stage || 'preparing' },
        clarification: null,
        error: null,
        notice: null,
      };
    case 'GENERATE_STAGE':
      if (state.pending?.requestId !== action.requestId) return state;
      return { ...state, pending: { ...state.pending, stage: action.stage } };
    case 'GENERATE_CLARIFICATION':
      if (state.pending?.requestId !== action.requestId) return state;
      return {
        ...state,
        pending: null,
        clarification: action.payload,
        error: null,
      };
    case 'COMMIT': {
      if (action.requestId && state.pending?.requestId !== action.requestId) return state;
      const day = firstDayNumber(action.snapshot);
      return {
        ...state,
        committed: action.snapshot,
        pending: null,
        clarification: null,
        selection: { day, nodeId: null, legId: null },
        undoStack: action.keepHistory && state.committed
          ? [...state.undoStack, state.committed].slice(-20)
          : [],
        redoStack: [],
        error: null,
      };
    }
    case 'GENERATE_ERROR':
      if (action.requestId && state.pending?.requestId !== action.requestId) return state;
      return {
        ...state,
        pending: null,
        error: action.error,
      };
    case 'SELECT_DAY':
      return {
        ...state,
        selection: { day: action.day, nodeId: null, legId: null },
      };
    case 'SELECT_NODE':
      return {
        ...state,
        selection: {
          day: action.day ?? state.selection.day,
          nodeId: action.nodeId,
          legId: null,
        },
      };
    case 'SELECT_LEG':
      return {
        ...state,
        selection: {
          day: action.day ?? state.selection.day,
          nodeId: null,
          legId: action.legId,
        },
      };
    case 'EDIT_START':
      return { ...state, pending: { requestId: action.requestId, stage: 'recalculating' }, error: null };
    case 'EDIT_COMMIT':
      if (state.pending?.requestId !== action.requestId) return state;
      return {
        ...state,
        committed: action.snapshot,
        pending: null,
        undoStack: state.committed ? [...state.undoStack, state.committed].slice(-20) : state.undoStack,
        redoStack: [],
        error: null,
      };
    case 'UNDO': {
      const previous = state.undoStack.at(-1);
      if (!previous || !state.committed) return state;
      return {
        ...state,
        committed: previous,
        undoStack: state.undoStack.slice(0, -1),
        redoStack: [state.committed, ...state.redoStack].slice(0, 20),
        selection: { day: firstDayNumber(previous), nodeId: null, legId: null },
        error: null,
      };
    }
    case 'REDO': {
      const next = state.redoStack[0];
      if (!next || !state.committed) return state;
      return {
        ...state,
        committed: next,
        undoStack: [...state.undoStack, state.committed].slice(-20),
        redoStack: state.redoStack.slice(1),
        selection: { day: firstDayNumber(next), nodeId: null, legId: null },
        error: null,
      };
    }
    case 'TOGGLE_HISTORY':
      return { ...state, showHistory: action.open ?? !state.showHistory };
    case 'NOTICE':
      return { ...state, notice: action.notice };
    case 'CLEAR_ERROR':
      return { ...state, error: null };
    case 'FORM_DRAFT_CHANGED':
      return { ...state, clarification: null, error: null, notice: null };
    case 'FORM_CLEARED':
      return {
        ...state,
        clarification: null,
        error: null,
        notice: action.storageCleared === false
          ? '表单已从页面清空，但浏览器阻止了本地存储；刷新后旧内容可能重新出现。'
          : '表单已清空；当前方案和历史版本仍然保留。',
      };
    default:
      return state;
  }
}
