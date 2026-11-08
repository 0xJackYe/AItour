// IndexedDB 本地历史。沿用原数据库与表结构，旧版本记录仍可读取；
// 新记录带 version: 2，并只保留最近 MAX_HISTORY 条，避免无限增长。
import { openDB } from 'idb';
import { normalizeResult, planTitle } from '../lib/plan.js';

const DB_NAME = 'aitour';
// 旧版线上站点已经创建过 v2 数据库；版本号只能递增，回退会触发 VersionError。
const DB_VERSION = 2;
const STORE_NAME = 'plans';
const MAX_HISTORY = 30;

let dbPromise = null;

function getDB() {
  dbPromise ||= openDB(DB_NAME, DB_VERSION, {
    upgrade(db) {
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        const store = db.createObjectStore(STORE_NAME, { keyPath: 'id', autoIncrement: true });
        store.createIndex('createdAt', 'createdAt');
      }
    },
  }).catch((error) => {
    dbPromise = null;
    throw error;
  });
  return dbPromise;
}

export async function savePlan(query, result) {
  const db = await getDB();
  const { meta, ...stored } = result;
  const id = await db.add(STORE_NAME, {
    version: 2,
    query,
    title: planTitle(result.plan),
    result: stored,
    createdAt: Date.now(),
  });
  const keys = await db.getAllKeysFromIndex(STORE_NAME, 'createdAt');
  const excess = keys.length - MAX_HISTORY;
  for (let index = 0; index < excess; index++) await db.delete(STORE_NAME, keys[index]);
  return id;
}

export async function getHistory(limit = MAX_HISTORY) {
  const db = await getDB();
  const all = await db.getAllFromIndex(STORE_NAME, 'createdAt');
  return all.reverse().slice(0, limit).map(record => ({
    id: record.id,
    query: record.query || '',
    title: record.title || planTitle(record.plan || record.result?.plan),
    createdAt: record.createdAt,
    record,
  }));
}

/** 历史记录 → 视图模型（兼容 v1：plan.__parsed_request 等字段）。 */
export function historyToResult(item) {
  const record = item.record || item;
  if (record.version === 2) return normalizeResult(record.result, record.query);
  return normalizeResult({ plan: record.plan, routes: record.routes }, record.query);
}

export async function deletePlan(id) {
  const db = await getDB();
  return db.delete(STORE_NAME, id);
}
