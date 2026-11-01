import assert from "node:assert/strict";
import {ollamaStream,ollamaFetch,cancelableInvoke} from "../src/net.js";
const originalFetch=globalThis.fetch, originalWindow=globalThis.window;
const response=(text,status=200)=>new Response(text,{status,headers:{"content-type":"application/x-ndjson"}});
try {
  globalThis.fetch=async()=>response('{"message":{"content":"첫"}}\n{"message":{"content":"끝"},"done":true}');
  const parts=[];await ollamaStream("http://localhost","/api/chat",{},o=>{if(o.message)parts.push(o.message.content)});
  assert.deepEqual(parts,["첫","끝"]);
  globalThis.fetch=async()=>response('{"message":{"content":"partial"}}\n');
  await assert.rejects(ollamaStream("http://localhost","/api/chat",{},()=>{}),/부분 응답/);
  globalThis.fetch=async()=>response('{"message":bad}\n{"done":true}');
  await assert.rejects(ollamaStream("http://localhost","/api/chat",{},()=>{}),/JSON/);
  globalThis.fetch=async()=>response('{"done":true}');
  await assert.rejects(ollamaStream("http://localhost","/api/chat",{},()=>{throw Error("callback failure")}),/callback failure/);
  globalThis.fetch=async()=>response("unavailable",503);
  await assert.rejects(ollamaStream("http://localhost","/api/chat",{},()=>{}),/503/);
  let calls=0;
  globalThis.fetch=async()=>{calls++;return response('{"done":true}')};
  const pre=new AbortController();pre.abort();
  await assert.rejects(ollamaFetch("http://localhost","/api/chat",{signal:pre.signal}),e=>e.name==="AbortError");
  assert.equal(calls,0);
  let finish, canceledId;
  globalThis.window={__TAURI__:{core:{invoke:(cmd,args)=>{
    if(cmd==="ollama_cancel"){canceledId=args.streamId;finish?.({status:200,body:"late"});return Promise.resolve()}
    return new Promise(resolve=>{finish=resolve;assert.ok(args.requestId)});
  }}}};
  const ctrl=new AbortController();
  const pending=ollamaFetch("http://localhost","/api/chat",{signal:ctrl.signal});
  ctrl.abort();
  await assert.rejects(pending,e=>e.name==="AbortError");
  assert.ok(canceledId);
  let channel;
  class Channel {constructor(){channel=this}}
  globalThis.window={__TAURI__:{core:{Channel,invoke:async(cmd,args)=>{
    if(cmd==="ollama_stream"){channel.onmessage('{"message":{"content":"ok"}}');channel.onmessage('{"done":true}');}
  }}}};
  const native=[];await ollamaStream("http://localhost","/api/chat",{},o=>native.push(o));
  assert.equal(native.length,2);
} finally {globalThis.fetch=originalFetch;if(originalWindow===undefined)delete globalThis.window;else globalThis.window=originalWindow}
console.log("transport: partial JSON/EOF, HTTP errors, callbacks, early/during cancellation, IPC channels");
