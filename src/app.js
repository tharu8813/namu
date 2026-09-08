import { pullPercent, shouldCompress, humanBytes, humanTime, pullRate, ollamaError, renderMarkdown, ATT_LIMITS, checkAttachments, isInstalledModel, modelRefKey } from "./lib.js";
import { idbGetAll, idbGet, idbPut, idbDelete, idbBulkPut, migrateFromLocalStorage, storageAvailable } from "./store.js";
import * as locode from "./locode.js";
import { ollamaFetch, ollamaStream, isTauri, invoke as tauriInvokeRaw } from "./net.js";

const VISION_RE = /llava|vision|moondream|bakllava|minicpm-v|gemma3|qwen2\.?5?-?vl|internvl|pixtral/i;
const isVisionModel = (n) => VISION_RE.test(n || "");
let pending = []; // 다음 메시지에 첨부할 파일들

const DEFAULTS = {
  ollamaUrl: "http://localhost:11434",
  theme: "auto",
  systemPrompt: "",
  temperature: 0.7,
  compress: { enabled: false, threshold: 20, keepRecent: 6 },
};
const KEEP_RECENT = 6;

const $ = (id) => document.getElementById(id);
const escapeHtml = (s) => String(s).replace(/[&<>"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[ch]));

let settings = { ...DEFAULTS };
let convos = [];
let activeId = null;
let models = [];
let streaming = false;
let abortCtrl = null; // 진행 중인 스트리밍 취소용
let useIDB = true;    // IndexedDB 사용 가능 여부

// localStorage 폴백 (IndexedDB 불가 환경)
const ls = {
  load(k, fb) { try { return JSON.parse(localStorage.getItem(k)) ?? fb; } catch { return fb; } },
  save(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
};

async function initStore() {
  useIDB = await storageAvailable();
  if (useIDB) {
    await migrateFromLocalStorage();
    const list = await idbGetAll("convos");
    convos = Array.isArray(list) ? list : [];
    settings = { ...DEFAULTS, ...((await idbGet("kv", "settings")) || {}) };
    activeId = (await idbGet("kv", "activeId")) ?? null;
  } else {
    convos = ls.load("convos", []);
    settings = { ...DEFAULTS, ...ls.load("settings", {}) };
    activeId = ls.load("activeId", null);
  }
  // 손상되었거나 오래된 저장 데이터가 앱 전체를 멈추게 하지 않도록 최소 형태로 복구한다.
  settings = { ...DEFAULTS, ...(settings && typeof settings === "object" && !Array.isArray(settings) ? settings : {}) };
  settings.compress = { ...DEFAULTS.compress, ...(settings.compress && typeof settings.compress === "object" ? settings.compress : {}) };
  convos = Array.isArray(convos) ? convos : [];
  convos = convos.filter((c) => c && typeof c === "object").map((c) => {
    if (!c.id) c.id = uid();
    if (!c.created) c.created = Date.now();
    if (!c.updated) c.updated = c.created;
    c.title = typeof c.title === "string" ? c.title.slice(0, 80) : "새 채팅";
    c.mode = c.mode === "locode" ? "locode" : "chat";
    c.model = typeof c.model === "string" ? c.model.trim() : "";
    c.messages = Array.isArray(c.messages) ? c.messages.filter((m) => m && typeof m === "object") : [];
    for (const m of c.messages) {
      if (!m.id) m.id = uid();
      if (typeof m.content !== "string") m.content = m.content == null ? "" : String(m.content);
      if (!["user", "assistant", "system"].includes(m.role)) m.role = "system";
    }
    return c;
  });
  convos.sort((a, b) => (b.updated || 0) - (a.updated || 0));
  if (!convos.some((c) => c.id === activeId)) activeId = convos[0]?.id || null;
}

let _saveTimer = null;
const _deleted = new Set(); // 커밋 대기 중 삭제된 대화 id
// id → 마지막으로 저장에 성공한 시점의 JSON 스냅샷. 매 저장마다 전체 대화를
// 다시 쓰지 않고 실제로 바뀐 것만 idbBulkPut 한다. (대화가 수십~수백 개로
// 늘어도 한 메시지 추가에 IndexedDB 쓰기가 1건으로 유지된다.)
let _savedConvos = new Map();

function saveAll() {
  clearTimeout(_saveTimer);
  _saveTimer = setTimeout(persist, 120);
}
async function persist() {
  if (useIDB) {
    try {
      await idbPut("kv", settings, "settings");
      await idbPut("kv", activeId, "activeId");
      const present = new Set();
      const changed = [];
      for (const c of convos) {
        present.add(c.id);
        const snap = JSON.stringify(c);
        if (_savedConvos.get(c.id) !== snap) changed.push([c, snap]);
      }
      if (changed.length) {
        await idbBulkPut("convos", changed.map(([c]) => c));
        for (const [c, snap] of changed) _savedConvos.set(c.id, snap); // 쓰기 성공 후에만 확정
      }
      for (const id of _deleted) { await idbDelete("convos", id); _savedConvos.delete(id); }
      _deleted.clear();
      // 목록에서 사라진(되돌리기 창 만료 등) 대화의 스냅샷은 정리해 Map 이 무한정 커지지 않게 한다.
      for (const id of [..._savedConvos.keys()]) if (!present.has(id)) _savedConvos.delete(id);
    } catch (e) {
      console.warn("저장 실패", e);
      toast("저장 실패 — 디스크 공간을 확인하세요");
    }
  } else {
    ls.save("settings", settings);
    ls.save("activeId", activeId);
    ls.save("convos", convos);
  }
}
function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }
function active() { return convos.find((c) => c.id === activeId); }

// toast(msg) 또는 toast(msg, { action, onAction, onExpire, duration })
function toast(msg, opts = {}) {
  const t = $("toast");
  clearTimeout(toast._t);
  // 이전 토스트에 만료 콜백이 걸려 있으면 먼저 처리(대기 중이던 삭제 확정 등)
  if (toast._onExpire) { const f = toast._onExpire; toast._onExpire = null; f(); }
  t.innerHTML = "";
  const span = document.createElement("span");
  span.textContent = msg;
  t.appendChild(span);
  const hide = () => {
    t.classList.remove("show");
    if (toast._onExpire) { const f = toast._onExpire; toast._onExpire = null; f(); }
  };
  if (opts.action) {
    const b = document.createElement("button");
    b.className = "toast-act";
    b.type = "button";
    b.textContent = opts.action;
    b.onclick = () => { toast._onExpire = null; clearTimeout(toast._t); t.classList.remove("show"); opts.onAction?.(); };
    t.appendChild(b);
  }
  toast._onExpire = opts.onExpire || null;
  t.classList.add("show");
  toast._t = setTimeout(hide, opts.duration || (opts.action ? 5200 : 2400));
}

/* ---------- 파일 첨부 ---------- */
const readAs = (file, how) => new Promise((res, rej) => {
  const r = new FileReader();
  r.onload = () => res(r.result);
  r.onerror = () => rej(new Error("읽기 실패"));
  how === "text" ? r.readAsText(file) : r.readAsDataURL(file);
});

async function addFiles(files) {
  for (const f of files) {
    const isImg = f.type.startsWith("image/");
    const cap = isImg ? ATT_LIMITS.perImageBytes : ATT_LIMITS.perTextBytes;
    if (f.size > cap) { toast(`${f.name}: ${humanBytes(f.size)} — ${isImg ? "이미지" : "텍스트 파일"} 한도 ${humanBytes(cap)} 초과`); continue; }
    try {
      if (isImg) {
        const dataUrl = await readAs(f, "dataurl");
        pending.push({ kind: "image", name: f.name, dataUrl, b64: dataUrl.split(",")[1] });
      } else {
        pending.push({ kind: "text", name: f.name, text: await readAs(f, "text") });
      }
    } catch { toast(`${f.name}: 첨부 실패`); }
  }
  const chk = checkAttachments(pending);
  if (!chk.ok) toast(chk.errors[0]);
  renderAttachStrip();
  updateSendState();
}

function renderAttachStrip() {
  const el = $("attachStrip");
  el.innerHTML = "";
  if (!pending.length) return;
  const chk = checkAttachments(pending);
  const info = document.createElement("div");
  info.className = "att-info" + (chk.ok ? "" : " over");
  info.textContent = `첨부 ${pending.length}개 · ${humanBytes(chk.bytes)} / ${humanBytes(ATT_LIMITS.totalBytes)}` +
    (chk.chars ? ` · 텍스트 ${chk.chars.toLocaleString()}자` : "");
  el.appendChild(info);
  pending.forEach((a, i) => {
    const chip = document.createElement("div");
    chip.className = "att-chip";
    if (a.kind === "image") {
      const im = document.createElement("img"); im.src = a.dataUrl; im.alt = "";
      chip.appendChild(im);
    }
    const nm = document.createElement("span");
    nm.className = "nm";
    nm.textContent = a.kind === "image" ? a.name : "📄 " + a.name;
    const x = document.createElement("button");
    x.className = "x"; x.type = "button"; x.textContent = "✕";
    x.setAttribute("aria-label", `${a.name} 제거`);
    x.onclick = () => { pending.splice(i, 1); renderAttachStrip(); updateSendState(); };
    chip.append(nm, x);
    el.appendChild(chip);
  });
}

function updateSendState() {
  $("send").disabled = (!$("input").value.trim() && !pending.length) || streaming;
}

/* ---------- Ollama API ---------- */
const api = (p) => settings.ollamaUrl.replace(/\/$/, "") + p;

// 모델별 /api/show 정보 캐시 (capabilities · parameter_size · context_length)
const modelCaps = new Map();
const modelParams = new Map();
const modelCtxLen = new Map();

function installedModel(name) {
  return models.find((m) => modelRefKey(m.name) === modelRefKey(name));
}
function modelState(name) {
  if (!name) return "none";
  if (ollamaReachable === false) return "offline";
  if (ollamaReachable == null) return "checking";
  return installedModel(name) ? "ready" : "missing";
}
function defaultModel() {
  const candidates = [active()?.model, settings.lastModel, models[0]?.name];
  return candidates.find((name) => isInstalledModel(name, models)) || "";
}

async function loadModelInfo(name) {
  if (!name || modelCaps.has(name)) return;
  try {
    const r = await ollamaFetch(settings.ollamaUrl, "/api/show", { method: "POST", body: { model: name } });
    const j = await r.json();
    modelCaps.set(name, Array.isArray(j.capabilities) ? j.capabilities : []);
    modelParams.set(name, j.details?.parameter_size || "");
    const ck = Object.keys(j.model_info || {}).find((k) => k.endsWith("context_length"));
    modelCtxLen.set(name, ck ? j.model_info[ck] : 0);
  } catch { modelCaps.set(name, []); }
}
async function modelHasVision(name) {
  if (!name) return false;
  await loadModelInfo(name);
  return (modelCaps.get(name) || []).includes("vision") || isVisionModel(name);
}


let ollamaReachable = null; // null=미확인, true/false

async function refreshModels() {
  const prevReach = ollamaReachable;
  const prevSignature = models.map((m) => `${m.name}:${m.size || ""}`).sort().join("|");
  try {
    const r = await ollamaFetch(settings.ollamaUrl, "/api/tags");
    if (!r.ok) throw new Error(r.status);
    const j = await r.json();
    models = (Array.isArray(j.models) ? j.models : []).filter((m) => m && typeof m.name === "string").map((m) => ({ name: m.name, size: m.size }));
    const nextSignature = models.map((m) => `${m.name}:${m.size || ""}`).sort().join("|");
    if (nextSignature !== prevSignature) {
      modelCaps.clear(); modelParams.clear(); modelCtxLen.clear();
    }
    ollamaReachable = true;
    $("banner").style.display = "none";
  } catch {
    models = [];
    ollamaReachable = false;
    // 배너는 채팅 중 재확인 실패 시에만 (온보딩 화면이 이미 안내함)
    if (convos.length) {
      $("banner").style.display = "block";
      $("banner").textContent = `Ollama 에 연결할 수 없습니다 — 설정에서 주소를 확인하거나 ollama serve 를 실행하세요.`;
    } else {
      $("banner").style.display = "none";
    }
  }
  renderModelPill();
  renderInstalled();
  // 연결 상태·모델 유무가 바뀌면 온보딩/채팅 화면 갱신
  if (prevReach !== ollamaReachable || prevSignature !== models.map((m) => `${m.name}:${m.size || ""}`).sort().join("|")) renderMessages();
}

async function chatStream(convo, onChunk, signal) {
  const body = {
    model: convo.model,
    messages: buildApiMessages(convo),
    stream: true,
    options: { temperature: settings.temperature },
  };
  let streamErr = null;
  await ollamaStream(settings.ollamaUrl, "/api/chat", body, (o) => {
    if (o.error) { streamErr = o.error; return; }
    if (o.message?.content) onChunk(o.message.content);
  }, signal);
  if (streamErr) throw new Error(String(ollamaError(streamErr, streamErr)));
}

async function complete(model, prompt) {
  const r = await ollamaFetch(settings.ollamaUrl, "/api/generate", {
    method: "POST", body: { model, prompt, stream: false },
  });
  if (!r.ok) throw new Error("요약 실패: " + r.status);
  return (await r.json()).response || "";
}

/* ---------- context compression ---------- */
function buildApiMessages(convo) {
  const msgs = [];
  if (settings.systemPrompt.trim()) msgs.push({ role: "system", content: settings.systemPrompt.trim() });
  if (convo.summary) msgs.push({ role: "system", content: "이전 대화 요약:\n" + convo.summary });
  const start = convo.summarizedUpTo || 0;
  for (const m of convo.messages.slice(start)) {
    if (m.role !== "user" && m.role !== "assistant") continue;
    const mm = { role: m.role, content: m.content + (m.fileText ? "\n\n" + m.fileText : "") };
    if (m.images && m.images.length) mm.images = m.images;
    msgs.push(mm);
  }
  return msgs;
}

async function maybeCompress(convo) {
  const start = convo.summarizedUpTo || 0;
  const live = convo.messages.slice(start).filter((m) => m.role === "user" || m.role === "assistant");
  if (!shouldCompress(live, settings.compress)) return;
  const keep = settings.compress.keepRecent || KEEP_RECENT;
  if (live.length <= keep) return;
  const toSummarize = live.slice(0, live.length - keep);
  const prompt =
    (convo.summary ? "기존 요약:\n" + convo.summary + "\n\n" : "") +
    "다음 대화를 사실·결정·이름·미해결 질문을 보존하며 간결하게 요약하라:\n\n" +
    toSummarize.map((m) => (m.role === "user" ? "사용자" : "AI") + ": " + m.content).join("\n");
  if (modelState(convo.model) !== "ready") return;
  try {
    const summary = await complete(convo.model, prompt);
    convo.summary = summary.trim();
    convo.summarizedUpTo = start + toSummarize.length;
    convo.messages.splice(start + toSummarize.length, 0, {
      role: "system", content: `⋯ 이전 ${toSummarize.length}개 메시지를 요약으로 접었습니다 ⋯`, folded: true,
    });
    convo.summarizedUpTo += 1;
    saveAll();
    renderMessages();
  } catch (e) { console.warn("압축 실패", e); }
}

/* ---------- rendering ---------- */
const MORE_ICON = `<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><circle cx="5" cy="12" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="19" cy="12" r="1.6"/></svg>`;

function renderConvoList() {
  const el = $("convoList");
  el.innerHTML = "";
  if (!convos.length) {
    el.innerHTML = `<p class="convo-empty">채팅이 없습니다.<br>＋ 버튼으로 새 채팅을 시작하세요.</p>`;
    return;
  }
  for (const c of convos) {
    const d = document.createElement("div");
    d.className = "convo" + (c.id === activeId ? " active" : "");
    const last = [...c.messages].reverse().find((m) => m.role !== "system" && (m.content || m.error || m.attachments?.length));
    d.innerHTML = `<div class="convo-main"><span class="title"></span><span class="preview"></span></div>
      <button class="convo-more" aria-label="대화 메뉴">${MORE_ICON}</button>`;
    d.querySelector(".title").textContent = c.title || "새 채팅";
    const preview = last
      ? (last.content || (last.error ? "⚠️ 오류" : last.attachments?.length ? "📎 첨부" : "")).slice(0, 60)
      : (c.model || "");
    d.querySelector(".preview").textContent = modelState(c.model) === "missing"
      ? `⚠️ 설치되지 않은 모델 · ${preview || c.model}` : preview;
    d.querySelector(".convo-main").onclick = () => {
      activeId = c.id; saveAll(); renderAll(); closeSidebar();
    };
    d.querySelector(".convo-more").onclick = (ev) => {
      ev.stopPropagation();
      openConvoMenu(ev.currentTarget, c);
    };
    el.appendChild(d);
  }
}

function openConvoMenu(anchor, c) {
  closeConvoMenu();
  const menu = document.createElement("div");
  menu.className = "popmenu";
  menu.id = "convoMenu";
  menu.innerHTML = `
    <button data-act="rename">이름 변경</button>
    <button data-act="delete" class="danger">삭제</button>`;
  document.body.appendChild(menu);
  const r = anchor.getBoundingClientRect();
  menu.style.top = `${Math.min(r.bottom + 4, innerHeight - menu.offsetHeight - 8)}px`;
  menu.style.left = `${Math.min(r.left, innerWidth - menu.offsetWidth - 8)}px`;
  menu.querySelector('[data-act="rename"]').onclick = () => { closeConvoMenu(); renameConvo(c.id); };
  menu.querySelector('[data-act="delete"]').onclick = () => { closeConvoMenu(); deleteConvo(c.id); };
  setTimeout(() => document.addEventListener("click", closeConvoMenu, { once: true }), 0);
}
function closeConvoMenu() { $("convoMenu")?.remove(); }

function renameConvo(id) {
  const c = convos.find((x) => x.id === id);
  if (!c) return;
  const idx = convos.indexOf(c);
  const titleEl = [...$("convoList").querySelectorAll(".convo")][idx]?.querySelector(".title");
  if (!titleEl) return;

  const input = document.createElement("input");
  input.type = "text";
  input.className = "convo-rename";
  input.value = c.title || "새 채팅";
  input.maxLength = 80;
  input.setAttribute("aria-label", "대화 이름");
  titleEl.replaceWith(input);
  input.focus();
  input.select();

  let done = false;
  const finish = (save) => {
    if (done) return;
    done = true;
    if (save) { c.title = input.value.trim().slice(0, 80) || c.title || "새 채팅"; saveAll(); }
    renderConvoList();
  };
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); finish(true); }
    if (e.key === "Escape") { e.preventDefault(); finish(false); }
  });
  input.addEventListener("blur", () => finish(true));
  // 사이드바 다른 곳을 눌러 닫히는 경우
}

function renderModelPill() {
  const c = active();
  const name = c?.model || defaultModel();
  $("modelName").textContent = name || "모델 없음";
  if (c && !c.model && name) { c.model = name; c.updated = Date.now(); saveAll(); }

  const installed = installedModel(name);
  const state = modelState(name);
  const dot = $("modelDot");
  if (state === "offline") { dot.style.background = "var(--text-secondary)"; dot.title = "Ollama 연결 안 됨"; }
  else if (state === "ready") { dot.style.background = "var(--ok)"; dot.title = "연결됨"; }
  else if (name) { dot.style.background = "#e0932f"; dot.title = "이 모델은 설치되어 있지 않습니다"; }
  else { dot.style.background = "var(--text-secondary)"; dot.title = ""; }

  const parts = [];
  if (installed?.size) parts.push((installed.size / 1e9).toFixed(1) + "GB");
  const caps = name ? modelCaps.get(name) : null;
  if ((caps && caps.includes("vision")) || isVisionModel(name)) parts.push("👁 비전");
  if (state === "missing") parts.push("설치되지 않음");
  else if (state === "checking") parts.push("확인 중");
  $("modelMeta").textContent = parts.join(" · ");

  if (name && installed && !modelCaps.has(name)) modelHasVision(name).then(renderModelPill);
}

function scrollMessages() {
  const el = $("messages");
  el.scrollTop = el.scrollHeight;
}

// 헤더 모드 세그먼트를 현재 대화에 맞춘다
function syncModeSeg() {
  const mode = active()?.mode || "chat";
  for (const b of $("modeSeg").children) {
    b.classList.toggle("sel", b.dataset.mode === mode);
    if (b.dataset.mode === "locode") {
      b.disabled = !locode.hasTauri();
      b.title = locode.hasTauri() ? "" : "데스크톱 앱에서만 사용 가능합니다";
    }
  }
  // 작성창 placeholder
  $("input").placeholder = mode === "locode" ? "프로젝트에 대해 물어보세요…" : "메시지를 입력하세요…";
}

function switchMode(mode) {
  const c = active();
  if (c && c.mode !== mode && !c.messages.length) {
    // 빈 대화면 그 자리에서 전환
    c.mode = mode;
    c.title = mode === "locode" ? "새 작업" : "새 채팅";
    saveAll(); renderAll();
  } else if (!c || c.mode !== mode) {
    newConvo(mode);
  }
}

const ICON = {
  copy: `<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/></svg>`,
  regen: `<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M23 4v6h-6M1 20v-6h6"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/></svg>`,
  edit: `<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.12 2.12 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>`,
  check: `<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6L9 17l-5-5"/></svg>`,
};

function actionBtn(icon, label, onClick) {
  const btn = document.createElement("button");
  btn.className = "act-btn";
  btn.type = "button";
  btn.innerHTML = icon;
  btn.setAttribute("aria-label", label);
  btn.title = label;
  btn.addEventListener("click", onClick);
  return btn;
}

async function copyToClipboard(text, btn) {
  try {
    await navigator.clipboard.writeText(text);
    if (btn) {
      const old = btn.dataset.copyLabel || btn.innerHTML;
      const isTextButton = btn.dataset.copyLabel != null;
      if (isTextButton) btn.textContent = "복사됨";
      else btn.innerHTML = ICON.check;
      btn.classList.add("ok");
      setTimeout(() => {
        if (isTextButton) btn.textContent = old;
        else btn.innerHTML = old;
        btn.classList.remove("ok");
      }, 1400);
    } else toast("복사됨");
  } catch { toast("복사 실패 — 브라우저가 클립보드를 막았습니다"); }
}

const CODE_LANGUAGE_NAMES = {
  js: "JavaScript", javascript: "JavaScript", ts: "TypeScript", typescript: "TypeScript",
  jsx: "JSX", tsx: "TSX", html: "HTML", css: "CSS", json: "JSON", md: "Markdown",
  markdown: "Markdown", py: "Python", python: "Python", rs: "Rust", rust: "Rust",
  sh: "Shell", bash: "Bash", shell: "Shell", powershell: "PowerShell", ps1: "PowerShell",
  sql: "SQL", yaml: "YAML", yml: "YAML", xml: "XML", java: "Java", c: "C", cpp: "C++",
};

// 렌더된 마크다운의 코드블록에 언어·복사·줄바꿈 도구막대를 만든다.
function enhanceCodeBlocks(container) {
  for (const pre of container.querySelectorAll("pre")) {
    if (pre.querySelector(".code-toolbar")) continue;
    const code = pre.querySelector("code");
    if (!code) continue;
    const lang = (pre.dataset.codeLang || "").toLowerCase();
    const toolbar = document.createElement("div");
    toolbar.className = "code-toolbar";
    const label = document.createElement("span");
    label.className = "code-lang";
    label.textContent = CODE_LANGUAGE_NAMES[lang] || (lang ? lang.toUpperCase() : "코드");
    toolbar.appendChild(label);

    const wrap = document.createElement("button");
    wrap.className = "code-tool code-wrap";
    wrap.type = "button";
    wrap.textContent = "줄바꿈";
    wrap.setAttribute("aria-pressed", "false");
    wrap.setAttribute("aria-label", "긴 코드 줄 바꿈 켜기");
    wrap.onclick = () => {
      const on = pre.classList.toggle("code-wrapped");
      wrap.setAttribute("aria-pressed", String(on));
      wrap.setAttribute("aria-label", on ? "긴 코드 줄 바꿈 끄기" : "긴 코드 줄 바꿈 켜기");
    };
    toolbar.appendChild(wrap);

    const btn = document.createElement("button");
    btn.className = "code-tool code-copy";
    btn.type = "button";
    btn.textContent = "복사";
    btn.dataset.copyLabel = "복사";
    btn.setAttribute("aria-label", "코드 복사");
    btn.addEventListener("click", () => copyToClipboard(code.textContent ?? "", btn));
    toolbar.appendChild(btn);
    pre.prepend(toolbar);
  }
}

const ONBOARDING_PICKS = [
  { cat: "일반 대화", name: "qwen2.5:3b", size: "1.9 GB", ram: "8 GB", desc: "한국어·다국어가 좋은 균형형" },
  { cat: "코딩", name: "qwen2.5-coder:7b", size: "4.7 GB", ram: "16 GB", desc: "코드 생성·설명에 강함" },
  { cat: "저사양 PC", name: "llama3.2:1b", size: "1.3 GB", ram: "4 GB", desc: "가장 가볍고 빠름" },
  { cat: "이미지 이해", name: "llava:7b", size: "4.7 GB", ram: "16 GB", desc: "사진·도표를 보고 답변" },
];

function openExternal(url) {
  // Tauri: OS 기본 브라우저로 연다. 웹: 새 탭. (이전엔 Tauri 성공 시에도 window.open 이
  // 한 번 더 불려 빈 웹뷰 창이 뜰 수 있었다 — open_url 성공은 null 을 반환하므로.)
  if (isTauri()) tauriInvoke("open_url", { url });
  else window.open(url, "_blank", "noopener");
}

function renderOnboarding(el) {
  const box = document.createElement("section");
  box.className = "onboard";

  if (ollamaReachable === null) {
    box.innerHTML = `<div class="ob-step"><div class="spinner" role="status" aria-label="확인 중"></div><p>Ollama 연결 확인 중…</p></div>`;
    el.appendChild(box);
    return;
  }

  if (ollamaReachable === false) {
    box.innerHTML = `
      <div class="ob-step">
        <span class="ob-badge">1단계</span>
        <h2>Ollama 연결 확인</h2>
        <p>이 앱은 로컬 AI 엔진 <b>Ollama</b>가 실행 중이어야 합니다.</p>
        <p class="ob-sub">현재 주소 <code></code></p>
        <div class="ob-actions">
          <button class="btn" id="obRetry" type="button">다시 확인</button>
          <button class="btn secondary" id="obSettings" type="button">주소 변경</button>
        </div>
        <p class="ob-hint">Ollama가 없다면 <a id="obGet" href="https://ollama.com/download" target="_blank" rel="noopener">ollama.com</a> 에서 설치 후 실행하세요.</p>
      </div>`;
    el.appendChild(box);
    box.querySelector(".ob-sub code").textContent = settings.ollamaUrl;
    $("obRetry").onclick = async (e) => { e.currentTarget.textContent = "확인 중…"; e.currentTarget.disabled = true; await refreshModels(); };
    $("obSettings").onclick = () => openSheet("settingsSheet");
    $("obGet").onclick = (e) => { e.preventDefault(); openExternal("https://ollama.com/download"); };
    return;
  }

  // 연결됨 + 모델 0개 → 추천 모델
  box.innerHTML = `
    <div class="ob-step">
      <span class="ob-badge">2단계</span>
      <h2>첫 모델 받기</h2>
      <p>용도에 맞는 모델을 하나 고르세요. 나중에 <b>모델</b> 메뉴에서 더 추가할 수 있어요.</p>
      <div class="ob-picks"></div>
      <div class="ob-progress" id="obProgress" hidden>
        <div class="track"><div class="fill" id="obFill"></div></div>
        <div class="ob-pstatus"><span id="obStatus">준비 중…</span><span id="obPct"></span></div>
        <div class="ob-pdetail" id="obDetail"></div>
        <button class="btn secondary" id="obCancel" type="button">취소</button>
      </div>
    </div>`;
  el.appendChild(box);
  const picksEl = box.querySelector(".ob-picks");
  for (const p of ONBOARDING_PICKS) {
    const card = document.createElement("button");
    card.className = "ob-card";
    card.type = "button";
    card.innerHTML =
      `<span class="obc-cat"></span><span class="obc-name"></span><span class="obc-desc"></span><span class="obc-meta"></span>`;
    card.children[0].textContent = p.cat;
    card.children[1].textContent = p.name;
    card.children[2].textContent = p.desc;
    card.children[3].textContent = `${p.size} · 권장 RAM ${p.ram}`;
    card.onclick = () => obStartPull(p.name);
    picksEl.appendChild(card);
  }
}

function obStartPull(name) {
  const prog = $("obProgress");
  if (!prog) return;
  prog.hidden = false;
  $("obStatus").classList.remove("err");
  $("obCancel").textContent = "취소";
  document.querySelectorAll(".ob-card").forEach((c) => (c.disabled = true));
  onPullProgress = (info) => {
    if (info.name !== name) return;
    if (info.phase === "downloading") {
      $("obFill").style.width = (info.pct || 0) + "%";
      $("obPct").textContent = info.pct ? Math.round(info.pct) + "%" : "";
      $("obStatus").textContent = info.status;
      $("obDetail").textContent = info.detail || "";
    } else if (info.phase === "done") {
      onPullProgress = null;
    } else if (info.phase === "error") {
      $("obStatus").textContent = info.text;
      $("obStatus").classList.add("err");
      $("obCancel").textContent = "다시 시도";
      document.querySelectorAll(".ob-card").forEach((c) => (c.disabled = false));
    } else if (info.phase === "canceled") {
      onPullProgress = null;
      prog.hidden = true;
      document.querySelectorAll(".ob-card").forEach((c) => (c.disabled = false));
    }
  };
  $("obCancel").onclick = () => { pullModel._busy ? stopPull() : obStartPull(name); };
  pullModel(name);
}

function renderMessages() {
  const el = $("messages");
  const c = active();
  el.innerHTML = "";
  syncModeSeg();

  // LOCODE 모드 대화는 별도 화면
  if (c?.mode === "locode") {
    document.body.classList.add("locode-active");
    locode.renderLocode(el, c);
    appendModelNotice(el, c);
    return;
  }
  document.body.classList.remove("locode-active");

  // 설치된 모델이 없거나 Ollama 미연결이면 온보딩 화면
  if (!models.length && (!c || (!c.messages.length && !c.model))) {
    renderOnboarding(el);
    return;
  }

  if (!c) {
    el.innerHTML = `<div class="empty"><h2>로컬 AI 채팅</h2><p>새 채팅을 시작하거나 왼쪽에서 대화를 선택하세요.</p></div>`;
    return;
  }
  appendModelNotice(el, c);
  if (!c.messages.length) {
    el.innerHTML = `<div class="empty"><h2>${escapeHtml(c.model || "모델을 선택하세요")}</h2><p>메시지를 입력해 대화를 시작하세요.</p></div>`;
    return;
  }
  const lastUserId = [...c.messages].reverse().find((m) => m.role === "user")?.id;
  for (const m of c.messages) {
    if (m.role === "system") {
      const row = document.createElement("div");
      row.className = "msg-row system";
      row.innerHTML = `<div class="bubble"></div>`;
      row.querySelector(".bubble").textContent = m.content;
      el.appendChild(row);
      continue;
    }
    const row = document.createElement("div");
    row.className = "msg-row " + m.role;
    row.dataset.mid = m.id;
    const b = document.createElement("div");
    b.className = "bubble";

    if (m.attachments && m.attachments.length) {
      const att = document.createElement("div");
      att.className = "bubble-att";
      for (const a of m.attachments) {
        if (a.kind === "image") {
          const im = document.createElement("img");
          im.src = a.dataUrl; im.alt = "";
          att.appendChild(im);
        } else {
          const s = document.createElement("span");
          s.className = "att-file";
          s.textContent = "📄 " + a.name;
          att.appendChild(s);
        }
      }
      b.appendChild(att);
    }

    const tx = document.createElement("div");
    if (m.role === "assistant") {
      tx.className = "md";
      if (m.content) { tx.innerHTML = renderMarkdown(m.content); enhanceCodeBlocks(tx); }
      else if (streaming && m === c.messages[c.messages.length - 1]) tx.innerHTML = `<span class="typing"><i></i><i></i><i></i></span>`;
      b.appendChild(tx);
    } else if (m.content) {
      tx.textContent = m.content;
      b.appendChild(tx);
    }

    if (m.interrupted) {
      const note = document.createElement("div");
      note.className = "msg-note";
      note.textContent = "⏹ 생성 중단됨";
      b.appendChild(note);
    }
    if (m.error) {
      const note = document.createElement("div");
      note.className = "msg-note err";
      note.textContent = "⚠️ " + m.error;
      b.appendChild(note);
      if (m.errorRaw) {
        const det = document.createElement("details");
        det.className = "err-detail";
        det.innerHTML = `<summary>자세히</summary><pre></pre>`;
        det.querySelector("pre").textContent = m.errorRaw;
        b.appendChild(det);
      }
      const retry = document.createElement("button");
      retry.className = "btn secondary err-retry";
      retry.type = "button";
      const unavailable = modelState(c.model) !== "ready";
      retry.textContent = unavailable ? "모델 선택" : "다시 시도";
      retry.onclick = unavailable ? () => openSheet("modelSheet") : () => regenerateFrom(m.id);
      b.appendChild(retry);
    }

    row.appendChild(b);

    // 액션 버튼: 스트리밍 중이 아닐 때만
    if (!streaming) {
      const acts = document.createElement("div");
      acts.className = "msg-actions";
      if (m.role === "assistant" && m.content) {
        acts.appendChild(actionBtn(ICON.copy, "복사", (e) => copyToClipboard(m.content, e.currentTarget)));
        acts.appendChild(actionBtn(ICON.regen, "다시 생성", () => regenerateFrom(m.id)));
      }
      if (m.role === "user") {
        acts.appendChild(actionBtn(ICON.copy, "복사", (e) => copyToClipboard(m.content, e.currentTarget)));
        acts.appendChild(actionBtn(ICON.edit, "수정 후 다시 전송", () => editUserMessage(m.id)));
      }
      if (acts.children.length) row.appendChild(acts);
    }

    el.appendChild(row);
  }
  scrollMessages();
}

function appendModelNotice(el, c) {
  const state = modelState(c?.model);
  if (state === "ready" || state === "none" || state === "checking") return;
  const notice = document.createElement("section");
  notice.className = "model-notice " + state;
  const text = document.createElement("div");
  text.className = "model-notice-text";
  if (state === "offline") {
    text.innerHTML = `<strong>Ollama에 연결할 수 없습니다.</strong><span>대화 내용은 안전하게 보존되어 있습니다. 연결을 다시 확인한 뒤 계속할 수 있어요.</span>`;
  } else {
    text.innerHTML = `<strong>이 대화의 모델(${escapeHtml(c.model)})이 설치되어 있지 않습니다.</strong><span>대화 내용은 유지됩니다. 설치된 모델을 선택하거나 같은 모델을 다시 다운로드한 뒤 계속하세요.</span>`;
  }
  const action = document.createElement("button");
  action.type = "button";
  action.className = "btn secondary";
  action.textContent = state === "offline" ? "다시 확인" : "모델 선택";
  action.onclick = async () => {
    if (state === "offline") { await refreshModels(); return; }
    openSheet("modelSheet");
  };
  notice.append(text, action);
  el.prepend(notice);
}

function renderInstalled() {
  const el = $("installedList");
  const c = active();
  $("instSearch").style.display = models.length > 1 ? "block" : "none";
  if (!models.length) { el.innerHTML = `<div class="model-item"><span class="mi-name" style="font-weight:400;color:var(--text-secondary)">설치된 모델이 없습니다. 아래에서 다운로드하세요.</span></div>`; return; }
  const q = $("instSearch").value.trim().toLowerCase();
  const list = q ? models.filter((m) => m.name.toLowerCase().includes(q)) : models;
  if (!list.length) { el.innerHTML = `<div class="model-item"><span class="mi-name" style="font-weight:400;color:var(--text-secondary)">일치하는 모델이 없습니다.</span></div>`; return; }
  el.innerHTML = "";
  for (const m of list) {
    const gb = m.size ? (m.size / 1e9).toFixed(1) + " GB" : "";
    const item = document.createElement("div");
    item.className = "model-item" + (c && modelRefKey(c.model) === modelRefKey(m.name) ? " sel" : "");
    const TRASH = `<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M4 7h16M9 7V5a1 1 0 011-1h4a1 1 0 011 1v2M7 7l1 12a1 1 0 001 1h6a1 1 0 001-1l1-12"/></svg>`;
    item.innerHTML = `<span class="mi-name"></span><span class="mi-size">${gb}</span>
      <button class="mi-del" aria-label="삭제">${TRASH}</button>`;
    item.querySelector(".mi-name").textContent = m.name;
    item.querySelector(".mi-name").onclick = () => { pickModel(m.name); };
    const del = item.querySelector(".mi-del");
    let armed = 0, timer;
    del.onclick = () => {
      // 실수로 더블클릭해 바로 삭제되는 걸 막는다: 확인 클릭은 0.4초~5초 사이여야 유효.
      if (armed && Date.now() - armed > 400) { clearTimeout(timer); deleteModel(m.name); return; }
      if (armed) return;
      const refs = convos.filter((x) => modelRefKey(x.model) === modelRefKey(m.name)).length;
      armed = Date.now(); del.classList.add("armed"); del.textContent = refs ? `대화 ${refs}개 영향 · 삭제?` : "삭제?";
      timer = setTimeout(() => { armed = 0; del.classList.remove("armed"); del.innerHTML = TRASH; }, 5000);
    };
    el.appendChild(item);
  }
}

let catalog = null;
async function loadCatalog() {
  if (catalog) return catalog;
  try { catalog = await (await fetch("models.json")).json(); }
  catch { catalog = []; }
  return catalog;
}

// 설치된 모델 태그 집합 (":latest" 유무 차이를 흡수)
function installedSet() {
  const s = new Set();
  for (const m of models) { s.add(m.name); s.add(m.name.replace(/:latest$/, "")); }
  return s;
}

function renderCatalog() {
  const el = $("catalog");
  if (!catalog) { el.innerHTML = `<div class="cat-model" style="color:var(--text-secondary)">불러오는 중…</div>`; return; }
  const q = $("catSearch").value.trim().toLowerCase();
  const have = installedSet();
  const list = catalog.filter((m) => {
    if (!q) return true;
    const hay = [m.name, m.desc, m.category, ...(m.pros || [])].join(" ").toLowerCase();
    return hay.includes(q);
  });
  if (!list.length) { el.innerHTML = `<div class="cat-model" style="color:var(--text-secondary)">일치하는 모델이 없습니다. 이름을 직접 입력해 보세요.</div>`; return; }
  const groups = {};
  for (const m of list) (groups[m.category || "기타"] ||= []).push(m);
  el.innerHTML = "";
  for (const [cat, ms] of Object.entries(groups)) {
    const h = document.createElement("div"); h.className = "cat-group"; h.textContent = cat;
    el.appendChild(h);
    for (const m of ms) {
      const box = document.createElement("div"); box.className = "cat-model";
      const name = document.createElement("div"); name.className = "cm-name"; name.textContent = m.name;
      const desc = document.createElement("div"); desc.className = "cm-desc"; desc.textContent = m.desc || "";
      box.append(name, desc);
      if (m.pros && m.pros.length) {
        const p = document.createElement("div"); p.className = "cm-pros";
        p.innerHTML = `<span class="tag-ico">👍</span>` + m.pros.map((x) => `<span></span>`).join("<i>·</i>");
        [...p.querySelectorAll("span:not(.tag-ico)")].forEach((s, i) => (s.textContent = m.pros[i]));
        box.append(p);
      }
      if (m.cons && m.cons.length) {
        const c = document.createElement("div"); c.className = "cm-cons";
        c.innerHTML = `<span class="tag-ico">⚠️</span>` + m.cons.map(() => `<span></span>`).join("<i>·</i>");
        [...c.querySelectorAll("span:not(.tag-ico)")].forEach((s, i) => (s.textContent = m.cons[i]));
        box.append(c);
      }
      const vs = document.createElement("div"); vs.className = "cat-variants";
      for (const v of m.variants) {
        const full = v.tag ? `${m.name}:${v.tag}` : m.name;
        const isIn = have.has(full) || have.has(full.replace(/:latest$/, "")) || (!v.tag && have.has(m.name));
        const b = document.createElement("button");
        b.className = "variant" + (isIn ? " installed" : "");
        b.innerHTML = `<span></span><span class="vsize"></span>`;
        b.children[0].textContent = v.tag || "기본";
        b.children[1].textContent = isIn ? "설치됨" : (v.size || "");
        if (isIn) b.disabled = true;
        else b.onclick = () => pullModel(full);
        vs.appendChild(b);
      }
      box.append(vs);
      el.appendChild(box);
    }
  }
}

function renderSettings() {
  $("setUrl").value = settings.ollamaUrl;
  $("setSystem").value = settings.systemPrompt;
  $("setTemp").value = settings.temperature;
  $("setTempVal").textContent = Number(settings.temperature).toFixed(1);
  $("setCompress").classList.toggle("on", settings.compress.enabled);
  $("setThreshold").value = settings.compress.threshold;
  $("setThresholdVal").textContent = settings.compress.threshold;
  for (const b of $("themeSeg").children) b.classList.toggle("sel", b.dataset.theme === settings.theme);
}

function renderAll() { renderConvoList(); renderModelPill(); renderMessages(); }

/* ---------- actions ---------- */
function applyTheme() {
  if (settings.theme === "auto") document.documentElement.removeAttribute("data-theme");
  else document.documentElement.setAttribute("data-theme", settings.theme);
}

function newConvo(mode = "chat") {
  // `$("newChat").onclick = newConvo` 로 바인딩돼 클릭 이벤트가 인자로 들어올 수 있다.
  // 이때 mode 가 PointerEvent 가 되어 c.mode 에 저장되면 IndexedDB 직렬화(구조화 복제)가
  // DataCloneError 로 실패해 세션 내내 저장이 깨진다.
  if (mode !== "chat" && mode !== "locode") mode = "chat";
  const now = Date.now();
  const c = {
    id: uid(),
    title: mode === "locode" ? "새 작업" : "새 채팅",
    mode,
    model: defaultModel(),
    messages: [], summary: "", summarizedUpTo: 0, created: now, updated: now,
  };
  convos.unshift(c); activeId = c.id; saveAll(); renderAll(); closeSidebar();
  if (mode === "chat") $("input").focus();
}

// 대화 삭제는 즉시 확정하지 않고 5초 실행취소 토스트를 띄운다
function deleteConvo(id) {
  const idx = convos.findIndex((c) => c.id === id);
  if (idx < 0) return;
  const [removed] = convos.splice(idx, 1);
  const wasActive = activeId === id;
  if (wasActive) activeId = convos[0]?.id || null;
  _deleted.add(id);
  saveAll();
  renderAll();
  toast(`"${removed.title || "새 채팅"}" 삭제됨`, {
    action: "실행 취소",
    onAction: () => {
      _deleted.delete(id);
      convos.splice(Math.min(idx, convos.length), 0, removed);
      if (wasActive) activeId = removed.id;
      saveAll();
      renderAll();
    },
  });
}
function pickModel(name) {
  if (!isInstalledModel(name, models)) {
    toast("설치된 모델 목록이 갱신되었습니다. 다시 선택해 주세요");
    refreshModels();
    return;
  }
  let c = active();
  if (!c) { newConvo(); c = active(); }
  c.model = name; settings.lastModel = name; saveAll();
  renderAll();
  closeSheet(); toast(name + " 선택됨");
}

async function deleteModel(name) {
  if (streaming || locode.locodeRunning() || pullModel._busy) {
    toast("실행 또는 다운로드가 끝난 뒤 모델을 삭제하세요");
    return;
  }
  try {
    const r = await ollamaFetch(settings.ollamaUrl, "/api/delete", { method: "DELETE", body: { name } });
    if (!r.ok) throw new Error(r.status);
    await refreshModels();
    if (modelRefKey(settings.lastModel) === modelRefKey(name)) settings.lastModel = models[0]?.name || "";
    const refs = convos.filter((c) => modelRefKey(c.model) === modelRefKey(name)).length;
    saveAll();
    toast(refs ? `${name} 삭제됨 — 대화 ${refs}개는 모델을 다시 선택해야 합니다` : name + " 삭제됨");
    renderAll();
    renderCatalog();
  } catch (e) { toast("삭제 실패: " + String(e?.message || e || "알 수 없는 오류")); }
}

let pullAbort = null;
let onPullProgress = null; // 온보딩 등 외부 구독자 (info) => void
const emitPull = (info) => { try { onPullProgress?.(info); } catch {} };

// 다운로드 오류 원인을 사람이 읽을 문구로
function pullErrorText(e) {
  const m = String(e?.message || e || "");
  if (e?.name === "AbortError") return "취소됨";
  if (/file does not exist|not found|manifest.*404|pull model manifest/i.test(m)) return "모델을 찾을 수 없습니다 — 이름을 확인하세요 (예: qwen2.5:3b)";
  if (/no space|disk|write.*fail/i.test(m)) return "디스크 공간이 부족합니다";
  if (/Failed to fetch|NetworkError|ECONNREFUSED|connect/i.test(m)) return "Ollama 에 연결할 수 없습니다";
  if (/^\d+$/.test(m)) return "서버 오류 (" + m + ")";
  return m || "알 수 없는 오류";
}

function stopPull() { if (pullAbort) pullAbort.abort(); }

async function pullModel(name) {
  name = (typeof name === "string" ? name : $("pullName").value).trim();
  if (!name || pullModel._busy) return;
  pullModel._busy = true;
  pullAbort = new AbortController();
  $("pullBtn").disabled = true;
  const prog = $("pullProgress");
  prog.classList.add("show", "active");
  prog.classList.remove("failed");
  $("pullFill").style.width = "0%"; $("pullPct").textContent = ""; $("pullStatus").textContent = "연결 중…"; $("pullDetail").textContent = "";
  $("pullCancel").textContent = "취소";
  await maybeWarnDiskSpace(name);
  let sample = null, ema = null, pullErr = null;
  try {
    await ollamaStream(settings.ollamaUrl, "/api/pull", { name, stream: true }, (o) => {
      if (o.error) { pullErr = o.error; return; }
      const status = o.status || "다운로드 중…";
      $("pullStatus").textContent = status;
      const pct = pullPercent(o);
      if (pct != null) { $("pullFill").style.width = pct + "%"; $("pullPct").textContent = pct.toFixed(0) + "%"; }
      let detail = "";
      if (typeof o.completed === "number" && typeof o.total === "number" && o.total > 0) {
        const cur = { completed: o.completed, total: o.total, t: Date.now() };
        const { bytesPerSec } = pullRate(sample, cur);
        if (bytesPerSec != null) {
          ema = ema == null ? bytesPerSec : ema * 0.7 + bytesPerSec * 0.3;
          const eta = (cur.total - cur.completed) / ema;
          detail = `${humanBytes(o.completed)} / ${humanBytes(o.total)}  ·  ${humanBytes(ema)}/s  ·  남은 시간 ${humanTime(eta)}`;
        }
        if (!sample || cur.t - sample.t > 400) sample = cur;
      }
      $("pullDetail").textContent = detail;
      emitPull({ name, phase: "downloading", status, pct: pct ?? 0, detail });
    }, pullAbort.signal);
    if (pullAbort.signal.aborted) { const e = new Error("취소됨"); e.name = "AbortError"; throw e; }
    if (pullErr) throw new Error(pullErr);
    $("pullFill").style.width = "100%"; $("pullPct").textContent = "100%"; $("pullStatus").textContent = "완료"; $("pullDetail").textContent = "";
    prog.classList.remove("active");
    emitPull({ name, phase: "done" });
    toast(name + " 다운로드 완료");
    $("pullName").value = "";
    await refreshModels();
    renderInstalled();
    renderCatalog();
    setTimeout(() => prog.classList.remove("show"), 1400);
  } catch (e) {
    const txt = pullErrorText(e);
    $("pullStatus").textContent = txt;
    $("pullDetail").textContent = "";
    prog.classList.remove("active");
    if (e.name === "AbortError") {
      prog.classList.remove("show");
      emitPull({ name, phase: "canceled" });
      toast("다운로드 취소됨");
    } else {
      prog.classList.add("failed");
      $("pullCancel").textContent = "다시 시도";
      emitPull({ name, phase: "error", text: txt });
      toast("다운로드 실패: " + txt);
    }
  } finally {
    pullModel._busy = false;
    pullAbort = null;
    $("pullBtn").disabled = false;
    pullModel._last = name;
  }
}

// 카탈로그에 명시된 대략 용량과 실제 여유 공간(Tauri) 을 비교해 경고
async function maybeWarnDiskSpace(name) {
  try {
    const base = name.split(":")[0];
    const entry = (catalog || []).find((m) => m.name === base);
    const tag = name.includes(":") ? name.split(":")[1] : "";
    const sizeStr = entry?.variants?.find((v) => (v.tag || "") === tag || (!tag && !v.tag))?.size || "";
    const gb = parseFloat((sizeStr.match(/([\d.]+)\s*GB/i) || [])[1] || "0");
    if (gb) $("pullDetail").textContent = `약 ${gb} GB 필요`;
    const free = await tauriInvoke("disk_free_gb");
    if (free != null && gb && free < gb * 1.15) {
      toast(`디스크 여유 ${free.toFixed(1)} GB — 이 모델(약 ${gb} GB)에 부족할 수 있습니다`);
    }
  } catch { /* Tauri 아님 / 정보 없음 */ }
}

// Tauri 명령 호출 헬퍼 (웹에서는 조용히 null)
async function tauriInvoke(cmd, args) {
  if (!isTauri()) return null;
  try { return await tauriInvokeRaw(cmd, args); } catch { return null; }
}

// 보내기 ↔ 중지 버튼 전환
function updateSendButton() {
  const btn = $("send");
  if (streaming || locode.locodeRunning()) {
    btn.classList.add("stop");
    btn.disabled = false;
    btn.setAttribute("aria-label", "생성 중지");
    btn.title = "생성 중지";
    btn.innerHTML = `<svg viewBox="0 0 24 24" fill="currentColor"><rect x="7" y="7" width="10" height="10" rx="2"/></svg>`;
  } else {
    btn.classList.remove("stop");
    btn.setAttribute("aria-label", "보내기");
    btn.title = "보내기";
    btn.innerHTML = `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M3.4 20.4l17.45-8.05a1 1 0 0 0 0-1.8L3.4 3.6a1 1 0 0 0-1.4 1.03l1.1 6.87L14 12 3.1 12.5 2 19.37a1 1 0 0 0 1.4 1.03z"/></svg>`;
    updateSendState();
  }
}

function stopStreaming() {
  if (abortCtrl) abortCtrl.abort();
  if (locode.locodeRunning()) locode.locodeStop();
}

// 모델 선택은 저장된 대화의 이력과 분리한다. 삭제된 모델의 대화는 절대 자동으로
// 다른 모델로 바꾸지 않으며, 사용자가 명시적으로 선택한 뒤에만 계속 실행한다.
function ensureRunnableModel(c) {
  const state = modelState(c?.model);
  if (state === "ready") return true;
  if (state === "offline" || state === "checking") {
    toast("Ollama 연결을 확인한 뒤 다시 시도하세요");
    refreshModels();
    return false;
  }
  toast(c?.model ? `"${c.model}" 모델이 설치되어 있지 않습니다` : "먼저 모델을 선택하세요");
  openSheet("modelSheet");
  return false;
}

// 채팅 스트리밍 오류 원인을 사람이 읽을 힌트로 (원문은 details 에 함께 보관)
function classifyChatError(raw) {
  const m = String(raw || "");
  let hint = "";
  if (/CUDA|cuBLAS|GPU|VRAM|shared object initialization|cudaMalloc|out of memory|OutOfMemory|0xc0000409/i.test(m))
    hint = "GPU 메모리 부족 또는 그래픽 드라이버 문제일 수 있습니다. 더 작은 모델(예: :3b, :7b)을 쓰거나, 설정에서 더 작은 컨텍스트를 시도하세요.";
  else if (/unknown model architecture|mllama|not compatible|unsupported/i.test(m))
    hint = "현재 Ollama 버전이 이 모델을 지원하지 않습니다. Ollama 를 최신 버전으로 업데이트하세요.";
  else if (/no space|disk full/i.test(m))
    hint = "디스크 공간이 부족합니다.";
  else if (/connection refused|ECONNREFUSED|Failed to fetch|NetworkError|terminated/i.test(m))
    hint = "Ollama 연결이 끊겼습니다. Ollama 가 실행 중인지 확인하세요.";
  else if (/model .*not found|no such model/i.test(m))
    hint = "모델을 찾을 수 없습니다. 모델 메뉴에서 다시 설치하세요.";
  return { hint, raw: m, missingModel: /model .*not found|no such model/i.test(m) };
}

// 한 번의 AI 응답 턴. c.messages 마지막이 사용자 메시지여야 한다.
async function runAssistantTurn(c) {
  const msg = { id: uid(), role: "assistant", content: "" };
  c.messages.push(msg);
  streaming = true;
  abortCtrl = new AbortController();
  updateSendButton();
  renderConvoList();
  renderMessages();

  let aborted = false;
  const signal = abortCtrl.signal;
  try {
    await chatStream(c, (chunk) => {
      msg.content += chunk;
      const md = document.querySelector(`[data-mid="${msg.id}"] .md`);
      if (md) { md.innerHTML = renderMarkdown(msg.content); scrollMessages(); }
    }, signal);
    if (signal.aborted) aborted = true; // Rust 프록시는 취소 시 예외 없이 끝난다
  } catch (e) {
    if (e.name === "AbortError" || signal.aborted) aborted = true;
    else {
      const { hint, raw, missingModel } = classifyChatError(e.message || e);
      msg.error = hint || raw || "응답 실패";
      msg.errorRaw = hint && raw !== hint ? raw : "";
      // 실행 중 외부에서 모델을 삭제한 경우, 다음 재시도가 같은 오류를 반복하지 않게
      // 설치 목록을 즉시 다시 읽는다.
      if (missingModel) await refreshModels();
      toast("응답 실패 — " + (hint ? hint.split(".")[0] : raw.slice(0, 60)));
    }
  } finally {
    streaming = false;
    abortCtrl = null;
    updateSendButton();
  }

  if (aborted) msg.interrupted = true;
  if (!msg.content && !msg.error && !aborted) msg.content = "(빈 응답)";
  // 내용도 없고 중단만 됐으면 자리만 차지하지 않도록 제거
  if (!msg.content && !msg.error && aborted) {
    c.messages = c.messages.filter((x) => x.id !== msg.id);
  }
  saveAll();
  renderConvoList();
  renderMessages();
  if (!aborted && !msg.error) maybeCompress(c);
}

async function send() {
  const ta = $("input");
  const text = ta.value.trim();
  if ((!text && !pending.length) || streaming || locode.locodeRunning()) return;
  let c = active();
  if (!c) { newConvo(); c = active(); }
  if (!ensureRunnableModel(c)) return;

  // LOCODE 모드는 별도 에이전트 루프로
  if (c.mode === "locode") {
    if (!text) return;
    ta.value = ""; ta.style.height = "auto";
    await locode.locodeSend(c, text);
    return;
  }

  const chk = checkAttachments(pending);
  if (!chk.ok) { toast(chk.errors[0] + " — 파일을 줄여 주세요"); return; }

  const built = buildAttachments(pending);
  if (built.images.length && !(await modelHasVision(c.model))) {
    toast("이 모델은 이미지를 지원하지 않아요. 비전 모델(llava, moondream 등)을 선택하세요.");
    return; // 첨부·입력 그대로 두고 전송만 취소
  }

  const userMsg = { id: uid(), role: "user", content: text };
  if (built.fileText) userMsg.fileText = built.fileText;
  if (built.images.length) userMsg.images = built.images;
  if (built.attachments.length) userMsg.attachments = built.attachments;
  c.messages.push(userMsg);
  c.updated = Date.now();
  if (c.title === "새 채팅") c.title = (text || built.attachments[0]?.name || "첨부").slice(0, 30);
  pending = []; renderAttachStrip();
  ta.value = ""; ta.style.height = "auto";

  await runAssistantTurn(c);
}

function buildAttachments(list) {
  const images = [];
  let fileText = "";
  const attachments = [];
  for (const a of list) {
    if (a.kind === "image") {
      images.push(a.b64);
      attachments.push({ kind: "image", dataUrl: a.dataUrl });
    } else {
      fileText += `--- 파일: ${a.name} ---\n${a.text}\n--- 파일 끝 ---\n\n`;
      attachments.push({ kind: "text", name: a.name });
    }
  }
  return { images, fileText: fileText.trim(), attachments };
}

// 특정 메시지 지점부터 다시 생성 (그 뒤 메시지 모두 버림)
async function regenerateFrom(msgId) {
  if (streaming) return;
  const c = active();
  if (!c || !ensureRunnableModel(c)) return;
  const idx = c.messages.findIndex((m) => m.id === msgId);
  if (idx < 0) return;
  // 대상이 assistant 면 그 assistant 부터, user 면 그 다음부터 잘라낸다
  const cut = c.messages[idx].role === "assistant" ? idx : idx + 1;
  if (cut === 0) return;
  c.messages = c.messages.slice(0, cut);
  // 요약 인덱스가 잘린 범위를 넘으면 되돌린다
  if ((c.summarizedUpTo || 0) > c.messages.length) { c.summarizedUpTo = 0; c.summary = ""; }
  saveAll();
  renderMessages();
  await runAssistantTurn(c);
}

// 사용자 메시지를 입력창으로 되돌리고 그 지점 이후를 지운다
function editUserMessage(msgId) {
  if (streaming) return;
  const c = active();
  const idx = c.messages.findIndex((m) => m.id === msgId);
  if (idx < 0) return;
  const m = c.messages[idx];
  const ta = $("input");
  ta.value = m.content;
  // 첨부는 복원하지 않는다(파일 원본이 없을 수 있음) — 안내
  if (m.attachments?.length) toast("첨부는 다시 추가해야 합니다");
  c.messages = c.messages.slice(0, idx);
  if ((c.summarizedUpTo || 0) > c.messages.length) { c.summarizedUpTo = 0; c.summary = ""; }
  saveAll();
  renderConvoList();
  renderMessages();
  ta.focus();
  ta.dispatchEvent(new Event("input"));
}

/* ---------- sheet plumbing ---------- */
function openSheet(id) {
  $("scrim").classList.add("open");
  $(id).classList.add("open");
  if (id === "settingsSheet") renderSettings();
  if (id === "modelSheet") renderInstalled();
  if (id === "addModelSheet") { renderCatalog(); loadCatalog().then(renderCatalog); }
}
function closeSheet() {
  $("scrim").classList.remove("open");
  document.querySelectorAll(".sheet.open").forEach((s) => s.classList.remove("open"));
}
function openSidebar() { $("sidebar").classList.add("open"); $("scrim").classList.add("open"); }
function closeSidebar() { $("sidebar").classList.remove("open"); if (!document.querySelector(".sheet.open")) $("scrim").classList.remove("open"); }

/* ---------- events ---------- */
$("newChat").onclick = newConvo;
$("hamburger").onclick = openSidebar;
$("scrim").onclick = () => { closeSheet(); closeSidebar(); };
$("modelPill").onclick = () => openSheet("modelSheet");
$("openSettings").onclick = () => openSheet("settingsSheet");
$("openAddModel").onclick = () => openSheet("addModelSheet");
$("addModelBack").onclick = () => { $("addModelSheet").classList.remove("open"); renderInstalled(); };
document.querySelectorAll("[data-close]").forEach((b) => (b.onclick = closeSheet));
$("pullBtn").onclick = () => pullModel();
$("pullCancel").onclick = () => {
  if (pullModel._busy) stopPull();
  else if (pullModel._last) pullModel(pullModel._last); // 실패 후 다시 시도
};
$("pullName").addEventListener("keydown", (e) => { if (e.key === "Enter") pullModel(); });
$("catSearch").addEventListener("input", renderCatalog);
$("instSearch").addEventListener("input", renderInstalled);

$("send").onclick = () => { (streaming || locode.locodeRunning()) ? stopStreaming() : send(); };
const ta = $("input");
ta.addEventListener("input", () => {
  ta.style.height = "auto"; ta.style.height = Math.min(ta.scrollHeight, 160) + "px";
  updateSendState();
});
ta.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); if (!streaming) send(); }
});
ta.addEventListener("paste", (e) => {
  const files = [...(e.clipboardData?.files || [])];
  if (files.length) { e.preventDefault(); addFiles(files); }
});
$("attach").onclick = () => $("fileInput").click();
$("fileInput").addEventListener("change", (e) => { addFiles([...e.target.files]); e.target.value = ""; });

// settings bindings
$("themeSeg").addEventListener("click", (e) => {
  const b = e.target.closest("button"); if (!b) return;
  settings.theme = b.dataset.theme; saveAll(); applyTheme(); renderSettings();
});
$("setUrl").addEventListener("change", () => { settings.ollamaUrl = $("setUrl").value.trim() || DEFAULTS.ollamaUrl; saveAll(); refreshModels(); });
$("setSystem").addEventListener("change", () => { settings.systemPrompt = $("setSystem").value; saveAll(); });
$("setTemp").addEventListener("input", () => { settings.temperature = parseFloat($("setTemp").value); $("setTempVal").textContent = settings.temperature.toFixed(1); saveAll(); });
$("setCompress").addEventListener("click", () => { settings.compress.enabled = !settings.compress.enabled; saveAll(); renderSettings(); });
$("setThreshold").addEventListener("input", () => { settings.compress.threshold = parseInt($("setThreshold").value); $("setThresholdVal").textContent = settings.compress.threshold; saveAll(); });
$("resetSettings").onclick = () => { settings = JSON.parse(JSON.stringify(DEFAULTS)); saveAll(); applyTheme(); renderSettings(); refreshModels(); toast("기본값으로 되돌림"); };

window.addEventListener("keydown", (e) => { if (e.key === "Escape") { closeSheet(); closeSidebar(); closeFilePreview(); } });

$("modeSeg").addEventListener("click", (e) => {
  const b = e.target.closest("button");
  if (b && !b.disabled) switchMode(b.dataset.mode);
});

/* ---------- LOCODE 파일 미리보기 ---------- */
function openFilePreview(rel, content, meta) {
  closeFilePreview();
  const scrim = document.createElement("div");
  scrim.className = "scrim open";
  scrim.id = "fpScrim";
  scrim.onclick = closeFilePreview;
  const sheet = document.createElement("div");
  sheet.className = "sheet open file-preview";
  sheet.onclick = (ev) => ev.stopPropagation();
  sheet.innerHTML = `
    <div class="sheet-head">
      <h3></h3>
      <button class="btn secondary" type="button" id="fpClose">닫기</button>
    </div>
    <div class="sheet-body"><pre class="fp-code"></pre></div>`;
  sheet.querySelector("h3").textContent = rel + (meta?.truncated ? " (일부만)" : "") + (meta?.masked ? ` · 비밀 ${meta.masked}건 마스킹` : "");
  const pre = sheet.querySelector(".fp-code");
  if (meta?.diff) {
    pre.classList.add("fp-diff");
    for (const ln of String(content).split("\n")) {
      const d = document.createElement("div");
      d.className = ln[0] === "+" ? "dl-add" : ln[0] === "-" ? "dl-del" : "dl-ctx";
      d.textContent = ln || " ";
      pre.appendChild(d);
    }
  } else {
    pre.textContent = content;
  }
  document.body.append(scrim, sheet);
  sheet.querySelector("#fpClose").onclick = closeFilePreview;
}
function closeFilePreview() { $("fpScrim")?.remove(); document.querySelector(".file-preview")?.remove(); }

/* ---------- boot ---------- */
(async () => {
  await initStore();
  applyTheme();
  updateSendButton();
  locode.locodeInit({
    api: (p) => api(p),
    getSettings: () => settings,
    toast,
    save: saveAll,
    rerender: () => { renderConvoList(); renderMessages(); updateSendButton(); },
    uid,
    modelCaps,
    ensureModelInfo: loadModelInfo,
    modelParam: (m) => modelParams.get(m),
    modelCtxLen: (m) => modelCtxLen.get(m),
    showFilePreview: openFilePreview,
    enhanceCodeBlocks,
  });
  renderAll();
  // exe(Tauri)에서 번들 Ollama 가 뜨는 데 몇 초 걸릴 수 있어 몇 번 재시도한다.
  for (let i = 0; i < 6; i++) {
    await refreshModels();
    if (models.length) break;
    await new Promise((r) => setTimeout(r, 1500));
  }
})();
