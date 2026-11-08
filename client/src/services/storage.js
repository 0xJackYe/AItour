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

function toItem(record) {
  return {
    id: record.id,
    query: record.query || record.snapshot?.query || '',
    title: record.title || planTitle(record.plan || record.result?.plan || record.snapshot?.plan),
    createdAt: record.createdAt,
    record,
  };
}

export async function getHistory(limit = MAX_HISTORY) {
  const db = await getDB();
  const all = await db.getAllFromIndex(STORE_NAME, 'createdAt');
  return all.reverse().slice(0, limit).map(toItem);
}

/** 按 id 读取一条历史（用于刷新页面或浏览器前进 / 后退时恢复行程）。 */
export async function getPlanById(id) {
  const key = Number(id);
  if (!Number.isFinite(key)) return null;
  const db = await getDB();
  const record = await db.get(STORE_NAME, key);
  return record ? toItem(record) : null;
}

/**
 * 历史记录 → 视图模型。兼容三种格式：当前版本（version: 2, result）、
 * 最早的 v1（plan / routes 平铺）、以及另一分支写入的快照（schemaVersion: 2, snapshot）。
 */
export function historyToResult(item) {
  const record = item.record || item;
  if (record.version === 2) return normalizeResult(record.result, record.query);
  if (record.snapshot) {
    return normalizeResult({ plan: record.snapshot.plan, routes: record.snapshot.routes }, record.query || record.snapshot.query);
  }
  return normalizeResult({ plan: record.plan, routes: record.routes }, record.query);
}

export async function deletePlan(id) {
  const db = await getDB();
  return db.delete(STORE_NAME, id);
}
