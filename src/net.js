// net.js — Ollama 호출 추상화.
// Tauri 앱에서는 웹뷰 origin(http://tauri.localhost)이 Ollama CORS 허용 목록에 없어
// 브라우저 fetch 가 403 을 받는다 → Rust 프록시(ollama_request / ollama_stream)를 경유한다.
// 웹 미리보기(python http.server 등)에서는 기존처럼 직접 fetch 한다.

function tauriCore() {
  return window.__TAURI__?.core || null;
}
export function isTauri() {
  return !!tauriCore()?.invoke;
}
export async function invoke(cmd, args) {
  const c = tauriCore();
  if (!c?.invoke) throw new Error("Tauri 아님");
  return c.invoke(cmd, args);
}

const trim = (b) => b.replace(/\/$/, "");
const asBody = (b) => (b == null ? null : typeof b === "string" ? b : JSON.stringify(b));

// 단발성 요청. fetch 유사 객체 { ok, status, text(), json() } 반환.
export async function ollamaFetch(base, path, { method = "GET", body } = {}) {
  if (isTauri()) {
    const r = await invoke("ollama_request", { base, method, path, body: asBody(body) });
    return {
      ok: r.status >= 200 && r.status < 400,
      status: r.status,
      text: async () => r.body,
      json: async () => JSON.parse(r.body),
    };
  }
  return fetch(trim(base) + path, {
    method,
    headers: body != null ? { "Content-Type": "application/json" } : {},
    body: asBody(body) ?? undefined,
  });
}

// 스트리밍 요청. onObj(파싱된 JSON 객체) 콜백. signal 로 취소.
export async function ollamaStream(base, path, body, onObj, signal) {
  if (isTauri()) {
    const core = tauriCore();
    const id = Math.random().toString(36).slice(2);
    const ch = new core.Channel();
    ch.onmessage = (line) => {
      const s = String(line).trim();
      if (!s) return;
      try { onObj(JSON.parse(s)); } catch { /* 부분 줄 무시 */ }
    };
    if (signal) {
      signal.addEventListener("abort", () => { invoke("ollama_cancel", { streamId: id }).catch(() => {}); });
    }
    await invoke("ollama_stream", { base, path, body: asBody(body), streamId: id, onLine: ch });
    return;
  }
  // 웹: fetch + reader 로 NDJSON 파싱
  const r = await fetch(trim(base) + path, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: asBody(body), signal,
  });
  if (!r.ok) {
    const txt = await r.text().catch(() => "");
    const err = new Error(txt || "HTTP " + r.status);
    err.status = r.status;
    throw err;
  }
  const reader = r.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const lines = buf.split("\n");
    buf = lines.pop() ?? "";
    for (const l of lines) {
      const s = l.trim();
      if (s) { try { onObj(JSON.parse(s)); } catch { /* skip */ } }
    }
  }
  // 마지막 줄이 개행 없이 끝나는 Ollama/프록시 응답도 버리지 않는다.
  const last = (buf + dec.decode()).trim();
  if (last) { try { onObj(JSON.parse(last)); } catch { /* 불완전 응답은 무시 */ } }
}
