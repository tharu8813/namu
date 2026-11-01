// Ollama transport shared by CHAT and LOCODE.
function tauriCore() { return globalThis.window?.__TAURI__?.core || null; }
export function isTauri() { return !!tauriCore()?.invoke; }
export async function invoke(cmd, args) {
  if (!isTauri()) throw new Error("데스크톱 앱에서 사용할 수 있습니다");
  return tauriCore().invoke(cmd, args);
}
export function throwIfAborted(signal) { if (signal?.aborted) throw new DOMException("취소됨", "AbortError"); }
const asBody = b => b == null ? null : typeof b === "string" ? b : JSON.stringify(b);
export async function cancelableInvoke(cmd, args, signal, idKey = "requestId") {
  throwIfAborted(signal);
  const id = globalThis.crypto.randomUUID();
  const abort = () => invoke("ollama_cancel", { streamId: id }).catch(() => {});
  signal?.addEventListener("abort", abort, { once: true });
  try {
    throwIfAborted(signal);
    const result = await invoke(cmd, { ...args, [idKey]: id });
    throwIfAborted(signal);
    return result;
  } catch (e) { throwIfAborted(signal); throw e instanceof Error ? e : new Error(String(e)); }
  finally { signal?.removeEventListener("abort", abort); }
}
export async function ollamaFetch(base, path, { method = "GET", body, signal } = {}) {
  throwIfAborted(signal);
  if (isTauri()) {
    const r = await cancelableInvoke("ollama_request", { base, method, path, body: asBody(body) }, signal);
    return { ok: r.status >= 200 && r.status < 300, status: r.status, text: async () => r.body, json: async () => JSON.parse(r.body) };
  }
  return fetch(base.replace(/\/$/, "") + path, { method, headers: body != null ? { "Content-Type": "application/json" } : {}, body: asBody(body) ?? undefined, signal });
}
export async function ollamaStream(base, path, body, onObj, signal) {
  throwIfAborted(signal);
  let completed = false;
  const consume = line => {
    throwIfAborted(signal);
    if (!line.trim()) return;
    let o;
    try { o = JSON.parse(line); } catch { throw new Error("Ollama 스트림 JSON이 손상되었습니다"); }
    if (o.error) throw new Error(String(o.error));
    completed ||= o.done === true || o.status === "success";
    onObj(o);
  };
  if (isTauri()) {
    const ch = new (tauriCore().Channel)();
    let channelError;
    ch.onmessage = line => { if (signal?.aborted || channelError) return; try { consume(String(line)); } catch (e) { channelError = e; } };
    await cancelableInvoke("ollama_stream", { base, path, body: asBody(body), onLine: ch }, signal, "streamId");
    if (channelError) throw channelError;
  } else {
    const r = await ollamaFetch(base, path, { method: "POST", body, signal });
    if (!r.ok) { const e = new Error("Ollama HTTP " + r.status); e.status = r.status; throw e; }
    const reader = r.body.getReader(), dec = new TextDecoder();
    let buf = "", total = 0;
    try {
      while (true) {
        throwIfAborted(signal);
        const { value, done } = await reader.read();
        if (done) break;
        total += value.length;
        if (total > 40 * 1024 * 1024) throw new Error("응답 크기 초과");
        buf += dec.decode(value, { stream: true });
        const lines = buf.split("\n"); buf = lines.pop() ?? "";
        for (const line of lines) consume(line);
        if (buf.length > 1024 * 1024) throw new Error("스트림 줄 크기 초과");
      }
      consume(buf + dec.decode());
    } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
  }
  throwIfAborted(signal);
  if (!completed) throw new Error("완료 신호 없이 종료된 부분 응답입니다");
}
