import assert from "node:assert/strict";
import {indexedDB,IDBObjectStore} from "fake-indexeddb";
globalThis.indexedDB=indexedDB;
const legacy=new Map();
globalThis.localStorage={getItem:k=>legacy.get(k)??null};
const {idbClear,idbGet,idbGetAll,idbPut,idbSaveState,migrateFromLocalStorage,storageAvailable}=await import("../src/store.js");
assert.equal(await storageAvailable(),true);
await idbClear("kv");await idbClear("convos");
legacy.set("convos",JSON.stringify([{id:"c1",messages:[{role:"user",content:"원본"}]}]));
legacy.set("settings",'{"theme":"dark"}');legacy.set("activeId",'"c1"');
assert.equal((await migrateFromLocalStorage()).migrated,true);
assert.equal((await idbGet("convos","c1")).messages[0].content,"원본");
assert.equal((await idbGet("kv","settings")).theme,"dark");
assert.equal((await idbGet("kv","migrated")).version,2);
assert.ok(legacy.has("convos"));
assert.equal((await migrateFromLocalStorage()).migrated,false);
await idbClear("kv");
legacy.set("settings","{broken");
await assert.rejects(migrateFromLocalStorage(),SyntaxError);
assert.equal(await idbGet("kv","migrated"),undefined);
assert.equal((await idbGetAll("convos")).length,1);
legacy.set("settings",'{"theme":"light"}');
await idbPut("convos",{id:"c1",messages:[{content:"newer data"}]});
await migrateFromLocalStorage();
assert.equal((await idbGet("convos","c1")).messages[0].content,"newer data");
// Any failure in a multi-store transaction must roll back settings and conversations together.
await idbSaveState({settings:{theme:"safe"},activeId:"c1",convos:[],deleted:[]});
await assert.rejects(idbSaveState({settings:{theme:"must rollback"},activeId:"lost",convos:[{messages:[]}],deleted:["c1"]}));
assert.equal((await idbGet("kv","settings")).theme,"safe");
assert.equal((await idbGet("convos","c1")).messages[0].content,"newer data");
await Promise.all([
  idbSaveState({settings:{},activeId:null,convos:[],deleted:["c1"]}),
  idbSaveState({settings:{theme:"restored"},activeId:"c1",convos:[{id:"c1",messages:[{content:"undo"}]}],deleted:[]})
]);
assert.equal((await idbGet("convos","c1")).messages[0].content,"undo");
// Simulated quota/write failure leaves no successful migration marker and is retryable.
await idbClear("kv");await idbClear("convos");
const put=IDBObjectStore.prototype.put;
IDBObjectStore.prototype.put=function(...args){if(this.name==="kv"&&args[1]==="settings")throw new DOMException("full","QuotaExceededError");return put.apply(this,args)};
await assert.rejects(migrateFromLocalStorage(),e=>e.name==="QuotaExceededError");
IDBObjectStore.prototype.put=put;
assert.equal(await idbGet("kv","migrated"),undefined);assert.deepEqual(await idbGetAll("convos"),[]);
await migrateFromLocalStorage();assert.ok(await idbGet("kv","migrated"));
console.log("storage: atomic migration, preserved originals/newer data, rollback, retry, serialized delete/undo");
