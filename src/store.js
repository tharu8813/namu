// IndexedDB schema v2. Atomic migration and conversation/settings snapshots.
const DB_NAME = "localai";
const DB_VER = 2;
let _dbPromise = null;
function openDB() {
  return new Promise((resolve, reject) => {
    const rq = indexedDB.open(DB_NAME, DB_VER);
    rq.onupgradeneeded = () => {
      const d = rq.result;
      if (!d.objectStoreNames.contains("convos")) d.createObjectStore("convos", { keyPath: "id" });
      if (!d.objectStoreNames.contains("kv")) d.createObjectStore("kv");
    };
    rq.onblocked = () => reject(new Error("다른 Namu 창이 저장소 업데이트를 막고 있습니다"));
    rq.onerror = () => reject(rq.error);
    rq.onsuccess = () => {
      const d = rq.result;
      d.onversionchange = () => { d.close(); _dbPromise = null; };
      resolve(d);
    };
  });
}
function db() { return _dbPromise ||= openDB().catch(e => { _dbPromise = null; throw e; }); }
async function transaction(stores, mode, fn) {
  const d = await db();
  return new Promise((resolve, reject) => {
    const tx = d.transaction(stores, mode);
    let result;
    tx.oncomplete = () => resolve(result && "result" in result ? result.result : result);
    tx.onerror = () => reject(tx.error || new Error("저장 오류"));
    tx.onabort = () => reject(tx.error || new Error("저장이 취소되었습니다"));
    const fail = e => { tx.abort(); reject(e); };
    try { result = fn(tx, fail); } catch (e) { fail(e); }
  });
}
let writeQueue = Promise.resolve();
function write(fn) {
  const result = writeQueue.then(fn);
  writeQueue = result.catch(() => {});
  return result;
}
const req = (store, mode, fn) => mode === "readwrite"
  ? write(() => transaction(store, mode, tx => fn(tx.objectStore(store))))
  : writeQueue.then(() => transaction(store, mode, tx => fn(tx.objectStore(store))));
export const idbGetAll = store => req(store, "readonly", s => s.getAll());
export const idbGet = (store, key) => req(store, "readonly", s => s.get(key));
export const idbPut = (store, val, key) => {
  const copy = structuredClone(val);
  return req(store, "readwrite", s => key === undefined ? s.put(copy) : s.put(copy, key));
};
export const idbDelete = (store, key) => req(store, "readwrite", s => s.delete(key));
export const idbClear = store => req(store, "readwrite", s => s.clear());
export function idbBulkPut(store, items) {
  const copy = structuredClone(items);
  return write(() => transaction(store, "readwrite", tx => { for (const it of copy) tx.objectStore(store).put(it); }));
}
export function idbSaveState(snapshot) {
  const copy = structuredClone(snapshot);
  return write(() => transaction(["convos", "kv"], "readwrite", tx => {
    const kv = tx.objectStore("kv"), convos = tx.objectStore("convos");
    kv.put(copy.settings, "settings"); kv.put(copy.activeId, "activeId");
    for (const c of copy.convos) convos.put(c);
    for (const id of copy.deleted) convos.delete(id);
  }));
}
export async function migrateFromLocalStorage() {
  if (await idbGet("kv", "migrated")) return { migrated: false };
  // Parsing failures leave both originals and the migration marker untouched.
  const parse = key => { const raw = localStorage.getItem(key); return raw == null ? undefined : JSON.parse(raw); };
  const list = parse("convos"), settings = parse("settings"), active = parse("activeId");
  if (list !== undefined && !Array.isArray(list)) throw new Error("이전 대화 목록 형식 오류");
  if (list?.some(c => !c || typeof c.id !== "string" || !Array.isArray(c.messages))) throw new Error("이전 대화 데이터 형식 오류");
  if (settings !== undefined && (!settings || typeof settings !== "object" || Array.isArray(settings))) throw new Error("이전 설정 형식 오류");
  await write(() => transaction(["convos", "kv"], "readwrite", (tx, fail) => {
    const kv = tx.objectStore("kv"), convos = tx.objectStore("convos");
    const putIfMissing = (store, key, value) => {
      const get = store.get(key);
      get.onsuccess = () => { try { if (get.result === undefined) store.keyPath ? store.put(value) : store.put(value, key); } catch (e) { fail(e); } };
    };
    for (const c of list || []) putIfMissing(convos, c.id, c);
    if (settings !== undefined) putIfMissing(kv, "settings", settings);
    if (active !== undefined) putIfMissing(kv, "activeId", active);
    kv.put({ version: DB_VER, completed: Date.now() }, "migrated");
  }));
  return { migrated: true, moved: list?.length || 0 };
}
export async function storageAvailable() {
  try { await idbPut("kv", Date.now(), "storage-probe"); return true; } catch { return false; }
}
