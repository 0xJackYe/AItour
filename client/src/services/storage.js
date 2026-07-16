// IndexedDB 本地存储封装
import { openDB } from 'idb';

const DB_NAME = 'aitour';
const DB_VERSION = 1;
const STORE_NAME = 'plans';

async function getDB() {
  return openDB(DB_NAME, DB_VERSION, {
    upgrade(db) {
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        const store = db.createObjectStore(STORE_NAME, {
          keyPath: 'id',
          autoIncrement: true,
        });
        store.createIndex('createdAt', 'createdAt');
      }
    },
  });
}

export async function savePlan(query, plan, routes) {
  const db = await getDB();
  return db.add(STORE_NAME, {
    query,
    plan,
    routes,
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
