// IndexedDB 本地存储封装
import { openDB } from 'idb';

const DB_NAME = 'aitour';
const DB_VERSION = 2;
const STORE_NAME = 'plans';

async function getDB() {
  return openDB(DB_NAME, DB_VERSION, {
    upgrade(db, oldVersion, _newVersion, transaction) {
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        const store = db.createObjectStore(STORE_NAME, {
          keyPath: 'id',
          autoIncrement: true,
        });
        store.createIndex('createdAt', 'createdAt');
        store.createIndex('tripId', 'tripId');
      } else if (oldVersion < 2) {
        const store = transaction.objectStore(STORE_NAME);
        if (!store.indexNames.contains('tripId')) store.createIndex('tripId', 'tripId');
      }
    },
  });
}

export async function saveSnapshot(snapshot) {
  const db = await getDB();
  return db.add(STORE_NAME, {
    schemaVersion: 2,
    tripId: snapshot.plan?.id || null,
    revisionId: snapshot.id || null,
    query: snapshot.query || '',
    profile: snapshot.profile || null,
    snapshot,
    createdAt: snapshot.createdAt || Date.now(),
  });
}

// 兼容旧调用方和已保存的 v1 历史记录。
export async function savePlan(query, plan, routes, metadata = {}) {
  return saveSnapshot({
    id: metadata.revisionId || null,
    query,
    profile: metadata.profile || null,
    plan,
    routes,
    health: metadata.health || null,
    createdAt: Date.now(),
  });
}

export async function getHistory(limit = 20) {
  const db = await getDB();
  const all = await db.getAllFromIndex(STORE_NAME, 'createdAt');
  return all.reverse().slice(0, limit);
}

export async function deletePlan(id) {
  const db = await getDB();
  return db.delete(STORE_NAME, id);
}
