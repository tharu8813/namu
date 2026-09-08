// store.js — IndexedDB 영속 계층. 대화는 용량이 큰 base64 이미지를 담을 수 있어
// localStorage(약 5MB) 대신 IndexedDB 에 저장한다. 설정·기타 값은 kv 스토어에.

const DB_NAME = "localai";
const DB_VER = 1;
let _dbPromise = null;

function openDB() {
  return new Promise((resolve, reject) => {
    const rq = indexedDB.open(DB_NAME, DB_VER);
    rq.onupgradeneeded = () => {
      const db = rq.result;
      if (!db.objectStoreNames.contains("convos")) db.createObjectStore("convos", { keyPath: "id" });
      if (!db.objectStoreNames.contains("kv")) db.createObjectStore("kv");
    };
    rq.onsuccess = () => resolve(rq.result);
    rq.onerror = () => reject(rq.error);
  });
}
function db() {
  return (_dbPromise ||= openDB());
}

function req(store, mode, fn) {
  return db().then(
    (d) =>
      new Promise((resolve, reject) => {
        const tx = d.transaction(store, mode);
        const result = fn(tx.objectStore(store));
        tx.oncomplete = () => resolve(result && "result" in result ? result.result : result);
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error || new Error("tx aborted"));
      })
  );
}

export const idbGetAll = (store) => req(store, "readonly", (s) => s.getAll());
export const idbGet = (store, key) => req(store, "readonly", (s) => s.get(key));
export const idbPut = (store, val, key) => req(store, "readwrite", (s) => (key === undefined ? s.put(val) : s.put(val, key)));
export const idbDelete = (store, key) => req(store, "readwrite", (s) => s.delete(key));
export const idbClear = (store) => req(store, "readwrite", (s) => s.clear());

export function idbBulkPut(store, items) {
  return db().then(
    (d) =>
      new Promise((resolve, reject) => {
        const tx = d.transaction(store, "readwrite");
        const os = tx.objectStore(store);
        for (const it of items) os.put(it);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      })
  );
}

// 첫 실행 시 기존 localStorage 데이터를 IndexedDB 로 옮긴다. 한 번만 수행하고
// localStorage 원본은 안전을 위해 삭제하지 않고 남겨둔다(수동 롤백 대비).
export async function migrateFromLocalStorage() {
  if (await idbGet("kv", "migrated")) return { migrated: false };
  let moved = 0;
  try {
    const rawConvos = localStorage.getItem("convos");
    if (rawConvos) {
      const list = JSON.parse(rawConvos);
      if (Array.isArray(list) && list.length) {
        for (const c of list) if (c && c.id) { await idbPut("convos", c); moved++; }
      }
    }
    const rawSettings = localStorage.getItem("settings");
    if (rawSettings) await idbPut("kv", JSON.parse(rawSettings), "settings");
    const rawActive = localStorage.getItem("activeId");
    if (rawActive) await idbPut("kv", JSON.parse(rawActive), "activeId");
  } catch (e) {
    console.warn("마이그레이션 일부 실패", e);
  }
  await idbPut("kv", Date.now(), "migrated");
  return { migrated: true, moved };
}

// IndexedDB 자체를 못 쓰는 환경(사생활 보호 모드 등) 감지
export async function storageAvailable() {
  try { await db(); return true; } catch { return false; }
}
