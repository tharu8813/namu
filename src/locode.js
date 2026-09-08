// locode.js — LOCODE 모드 (Phase 2: 읽기 + 승인제 파일 쓰기)
// 프로젝트 열기 / 파일 트리 / 읽기·검색·수정 에이전트 루프 + diff 승인 + 변경 원장.
import { ollamaError, renderMarkdown, lineDiff, diffStat } from "./lib.js";
import { ollamaFetch, invoke, isTauri } from "./net.js";

let ctx = null;
let stopFlag = false;
let running = false;
const mtimeCache = new Map(); // rel path -> mtime (외부 변경 감지)
let pendingApproval = null;   // { resolve, convo, action }
let activeRun = null;         // { id, convo, record } — Rust가 실제 프로세스를 소유한다

export function locodeInit(c) { ctx = c; }

export function hasTauri() {
  return isTauri();
}

let activeRoot = null; // Rust 가 현재 잡고 있는 프로젝트 경로

// LOCODE 대화의 프로젝트를 Rust 쪽에도 연결한다(앱 재시작 후 복구 포함).
// 반환: "ok" | "need-reopen" | "no-project"
async function ensureProjectOpen(convo) {
  if (!convo.project) return "no-project";
  if (activeRoot === convo.project.path) return "ok";
  try {
    const info = await invoke("locode_reopen", { path: convo.project.path });
    convo.project = { path: info.path, name: info.name, isGit: info.is_git };
    activeRoot = info.path;
    loadGitStatus(convo);
    return "ok";
  } catch {
    return "need-reopen";
  }
}

// ---------- 프로젝트 ----------
export async function locodeOpenProject(convo) {
  try {
    const info = await invoke("locode_open_project");
    if (!info) return false; // 취소
    convo.project = { path: info.path, name: info.name, isGit: info.is_git };
    convo.locodeSteps = [];
    activeRoot = info.path;
    if (convo.title === "새 작업" || convo.title === "새 채팅") convo.title = "📁 " + info.name;
    audit(convo, { action: "open_project", params: { path: info.path }, tier: 0, decision: "auto" });
    ctx.save();
    ctx.rerender();
    // 프로젝트 개요 미리 로드
    loadGitStatus(convo);
    return true;
  } catch (e) {
    ctx.toast("프로젝트 열기 실패: " + e);
    return false;
  }
}
export async function locodeCloseProject(convo) {
  try { await invoke("locode_close_project"); } catch {}
  convo.project = null;
  convo.git = null;
  activeRoot = null;
  ctx.save();
  ctx.rerender();
}
async function loadGitStatus(convo) {
  try {
    convo.git = await invoke("locode_git_status");
    ctx.rerender();
  } catch { convo.git = null; }
}

async function loadAuditLog(convo) {
  if (convo.auditLog?.loading) return;
  convo.auditLog = { loading: true, entries: convo.auditLog?.entries || [] };
  ctx.rerender();
  try {
    const rows = await invoke("locode_read_audit");
    const entries = (rows || []).map((row) => {
      try { return JSON.parse(row); } catch { return { raw: String(row) }; }
    });
    convo.auditLog = { loading: false, entries, loaded: Date.now() };
  } catch (e) {
    convo.auditLog = { loading: false, entries: [], error: String(e) };
  }
  ctx.rerender();
}

// ---------- 감사 로그 ----------
function audit(convo, entry) {
  const rec = { ...entry, model: convo.model, ts: Date.now() };
  (convo.audit ||= []).push(rec);
  invoke("locode_audit", { entry: JSON.stringify(rec) }).catch(() => {});
}

// ---------- 모델 능력 ----------
// 도구 호출을 지원하는 것으로 알려진 모델 계열. 일부 Ollama 버전은 /api/show 에
// capabilities 를 안 넘겨줘서 caps 가 비는데, 그때 이름으로 추정한다.
const TOOLS_BY_NAME = /qwen[23]|qwq|llama-?3\.[123]|llama-?4|mistral|mixtral|ministral|command-?r|firefunction|hermes-?3|nemotron|granite-?3|deepseek-v3|deepseek-r1|exaone3\.5|cogito|codestral|devstral|coder|codegemma|codellama|starcoder|granite-code/i;
function caps(model) { return ctx.modelCaps.get(model) || []; }
function knownToolModel(model) { return TOOLS_BY_NAME.test(model || ""); }
function isToolCapable(model) {
  const cl = caps(model);
  if (cl.includes("tools")) return true;
  return cl.length === 0 && knownToolModel(model); // caps 미보고 시 이름으로 추정
}

// LOCODE 적합도 등급
export function locodeTier(model, capList, paramSize) {
  const cl = capList || [];
  const name = (model || "").toLowerCase();
  const gb = parseFloat(String(paramSize || "").replace(/[^\d.]/g, "")) || 0;
  const isCoder = /coder|codestral|devstral|deepseek-coder|starcoder|codellama|codegemma|granite-code/.test(name);
  const toolsOk = cl.includes("tools") || (cl.length === 0 && TOOLS_BY_NAME.test(name));
  const visionOnly = cl.includes("vision") && !cl.includes("tools");
  if (cl.includes("embedding")) return { tier: "chat", label: "임베딩 전용", locode: false };
  if (gb && gb < 3) return { tier: "chat", label: "소형 — 코드 작업 부적합", locode: false };
  if (visionOnly) return { tier: "chat", label: "비전 전용", locode: false };
  if (isCoder) return { tier: "code", label: "코드 작업 권장", locode: true };
  if (toolsOk && gb >= 7 && !cl.includes("vision")) return { tier: "code", label: "코드 작업 권장", locode: true };
  if (toolsOk) return { tier: "tools", label: cl.includes("vision") ? "LOCODE 가능 (코드 전용 모델 권장)" : "LOCODE 가능", locode: true };
  return { tier: "structured", label: "읽기·제안만 (도구 호출 미지원)", locode: true };
}

// ---------- 에이전트 루프 (읽기 + 승인제 쓰기 + 명령) ----------
const LOCODE_TOOLS = [
  { type: "function", function: { name: "list_dir", description: "프로젝트 내 폴더의 항목 목록. path 는 프로젝트 루트 기준 상대 경로(루트는 \"\").", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } } },
  { type: "function", function: { name: "read_file", description: "프로젝트 내 텍스트 파일 읽기.", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } } },
  { type: "function", function: { name: "search", description: "프로젝트 내 텍스트(kind=text) 또는 파일명(kind=filename) 검색.", parameters: { type: "object", properties: { query: { type: "string" }, kind: { type: "string", enum: ["text", "filename"] } }, required: ["query"] } } },
  { type: "function", function: { name: "propose_plan", description: "작업을 시작하기 전 2~8개의 짧은 한국어 단계로 계획을 제안한다. 파일을 변경하거나 명령을 실행하지 않는다.", parameters: { type: "object", properties: { steps: { type: "array", items: { type: "object", properties: { title: { type: "string" }, detail: { type: "string" } }, required: ["title"] } } }, required: ["steps"] } } },
  { type: "function", function: { name: "write_file", description: "새 파일 생성 또는 파일 전체 재작성. 기존 파일을 부분 수정할 땐 edit_file 을 쓰세요. 사용자 승인 후에만 반영된다. content 는 파일 전체.", parameters: { type: "object", properties: { path: { type: "string" }, content: { type: "string" }, summary: { type: "string", description: "이 변경이 무엇을 하는지 한 문장" } }, required: ["path", "content", "summary"] } } },
  { type: "function", function: { name: "edit_file", description: "기존 파일의 일부만 교체(부분 패치, 권장). edits 는 [{old,new}] 배열 — old 는 파일에 지금 있는 정확한 텍스트(들여쓰기·공백 포함), new 는 바꿀 텍스트. old 는 파일에서 유일해야 하니 앞뒤 줄을 충분히 포함하세요. 수정 전 반드시 read_file 하세요. 사용자 승인 후에만 반영된다.", parameters: { type: "object", properties: { path: { type: "string" }, edits: { type: "array", items: { type: "object", properties: { old: { type: "string" }, new: { type: "string" } }, required: ["old", "new"] } }, summary: { type: "string", description: "이 변경이 무엇을 하는지 한 문장" } }, required: ["path", "edits", "summary"] } } },
  { type: "function", function: { name: "move_path", description: "파일/폴더 이름 변경 또는 이동. 사용자 확인 필요.", parameters: { type: "object", properties: { from: { type: "string" }, to: { type: "string" }, summary: { type: "string" } }, required: ["from", "to", "summary"] } } },
  { type: "function", function: { name: "delete_path", description: "파일 삭제(폴더는 비어있을 때만). 사용자 확인 필요.", parameters: { type: "object", properties: { path: { type: "string" }, summary: { type: "string" } }, required: ["path", "summary"] } } },
  { type: "function", function: { name: "run_command", description: "프로젝트 루트에서 터미널 명령 실행. 반드시 왜 필요한지 why를 설명한다. 사용자 승인 후에만 실행된다.", parameters: { type: "object", properties: { command: { type: "string" }, why: { type: "string" } }, required: ["command", "why"] } } },
  { type: "function", function: { name: "finish", description: "작업을 마치고 사용자에게 결과를 한국어로 보고.", parameters: { type: "object", properties: { summary: { type: "string" } }, required: ["summary"] } } },
];

const ACTION_SCHEMA = {
  type: "object",
  properties: {
    thought: { type: "string" },
    action: { type: "string", enum: ["list_dir", "read_file", "search", "propose_plan", "write_file", "edit_file", "move_path", "delete_path", "run_command", "finish"] },
    path: { type: "string" },
    from: { type: "string" },
    to: { type: "string" },
    query: { type: "string" },
    kind: { type: "string", enum: ["text", "filename"] },
    content: { type: "string" },
    edits: { type: "array", items: { type: "object" } },
    summary: { type: "string" },
    command: { type: "string" },
    why: { type: "string" },
    steps: { type: "array", items: { type: "object" } },
    message: { type: "string" },
  },
  required: ["action", "message"],
};

function systemPrompt(convo) {
  return [
    "당신은 로컬 프로젝트를 다루는 코딩 어시스턴트입니다.",
    `프로젝트: ${convo.project?.name} (${convo.project?.path})`,
    convo.git?.is_git ? `Git 브랜치: ${convo.git.branch}, 변경 파일 ${convo.git.files?.length ?? 0}개` : "Git 저장소 아님",
    "",
    "사용 가능한 동작: list_dir · read_file · search · propose_plan · write_file · edit_file · move_path · delete_path · run_command · finish",
    "",
    "규칙:",
    "- 수정·명령 실행이 포함된 작업은 먼저 propose_plan 으로 2~8단계 계획을 제시하세요.",
    "- 어떤 파일이 있는지 모르면 먼저 search(kind=filename) 로 파일명을, search(kind=text) 로 코드 내용을 찾으세요. 짐작으로 read_file 하지 말고, list_dir·search 로 확인된 경로만 읽으세요.",
    "- 폴더가 비어 있거나 새로 만들 파일이 분명하면, 읽기를 건너뛰고 곧바로 write_file 로 파일을 생성하세요. 없는 파일을 반복해서 읽으려 하지 마세요.",
    "- 새 프로그램·문서를 만드는 요청이면 필요한 파일을 write_file 로 하나씩 생성하는 데 집중하세요. 기존 파일·폴더를 지우거나 정리하려 들지 마세요.",
    "- 기존 파일을 고칠 땐 edit_file 을 쓰세요: edits:[{old,new}] 로 바뀌는 부분만 넘깁니다. old 는 파일에 지금 있는 정확한 텍스트를 앞뒤 줄까지 충분히 포함해 파일에서 유일하게 만드세요. 수정 전 반드시 read_file 로 현재 내용을 확인하세요.",
    "- write_file 은 새 파일을 만들거나 파일 전체를 다시 쓸 때만 씁니다(content 에 파일 전체).",
    "- 모든 write_file · edit_file · move_path · delete_path 는 사용자 승인을 거쳐야 실제 반영됩니다. 승인 결과(applied/rejected)를 받은 뒤 다음 동작을 정하세요.",
    "- run_command 는 사용자 승인 후 프로젝트 루트에서만 실행됩니다. 테스트·빌드처럼 필요한 경우에만 사용하고, command와 why를 정확히 작성하세요. 패키지 설치·네트워크·Git 변경 명령은 추가 확인이 필요할 수 있습니다.",
    "- 요청받지 않은 커밋·푸시·브랜치 변경은 하지 마세요.",
    "- 경로는 항상 프로젝트 루트 기준 상대 경로입니다.",
    "- 한 번에 한 가지 동작만. 작업이 끝났으면 finish 로 무엇을 바꿨는지 요약하세요.",
    "- 도구 호출을 지원하지 않는 모델에서는 반드시 다른 설명 없이 JSON 객체 하나만 출력하세요. 예: {\"action\":\"list_dir\",\"path\":\"\",\"message\":\"프로젝트 구조를 확인합니다\"}.",
    "- 사용자가 프로젝트에 대해 물으면 '정보가 없다'거나 사과하지 말고, 즉시 list_dir 로 루트를 보고 README·주요 파일을 read_file 하여 직접 조사한 뒤 답하세요. 설명만 하고 끝내지 마세요.",
  ].join("\n");
}

function buildMessages(convo) {
  const msgs = [{ role: "system", content: systemPrompt(convo) }];
  for (const m of convo.messages) {
    if (m.role === "user") msgs.push({ role: "user", content: m.content });
    else if (m.role === "assistant" && m.content) msgs.push({ role: "assistant", content: m.content });
  }
  return msgs;
}

// 에이전트 루프가 길어지면 messages 가 모델 컨텍스트를 넘겨 앞부분(도구 규칙이
// 담긴 시스템 프롬프트)이 잘리고, 그러면 모델이 도구를 안 부르고 잡담하기 시작한다.
// 시스템 프롬프트 + 이번 턴의 요청(keep) + 최근 HISTORY_TAIL 개만 보낸다.
const HISTORY_TAIL = 14;
export function windowMessages(messages, keep) {
  if (messages.length <= HISTORY_TAIL + 2) return messages;
  let tail = messages.slice(-HISTORY_TAIL);
  // 잘린 지점이 tool 응답으로 시작하면 짝(assistant tool_calls)이 없어 API 가 거부한다.
  while (tail.length && tail[0].role === "tool") tail = tail.slice(1);
  const head = [messages[0]];
  if (keep && !tail.includes(keep)) head.push(keep);
  return [...head, ...tail];
}

// 모델이 보고한 컨텍스트 길이에 맞춰 num_ctx 를 정한다(상한 16384). 알 수 없으면 8192.
function ctxSize(model) {
  const limit = ctx.modelCtxLen?.(model) || 0;
  return limit ? Math.min(limit, 16384) : 8192;
}

async function callModel(model, messages, useTools, signal) {
  const body = {
    model, messages, stream: false,
    options: { temperature: 0.2, num_ctx: ctxSize(model) },
  };
  if (useTools) body.tools = LOCODE_TOOLS;
  else body.format = ACTION_SCHEMA;
  const r = await ollamaFetch(ctx.getSettings().ollamaUrl, "/api/chat", { method: "POST", body });
  if (!r.ok) throw new Error(ollamaError(await r.text().catch(() => ""), "요청 실패 " + r.status));
  const j = await r.json();
  return { content: j.message?.content || "", toolCalls: j.message?.tool_calls || [] };
}

const WRITE_ACTIONS = new Set(["write_file", "edit_file", "move_path", "delete_path"]);

// 모델이 edits 항목을 {old,new} 대신 {search,replace}/{from,to} 등으로 줄 수도 있어 흡수한다.
export function normalizeEdits(raw) {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((e) => ({
      old: String((e && (e.old ?? e.search ?? e.from ?? e.original)) ?? ""),
      new: String((e && (e.new ?? e.replace ?? e.replacement ?? e.to ?? e.updated)) ?? ""),
    }))
    .filter((e) => e.old);
}

// 모델 출력은 불완전할 수 있으므로 표시·저장 전 계획을 작고 안전한 형태로 정규화한다.
export function normalizePlan(steps) {
  if (!Array.isArray(steps)) return [];
  return steps.slice(0, 8).map((step, i) => {
    const raw = typeof step === "string" ? { title: step } : (step || {});
    const title = String(raw.title || raw.name || raw.detail || "").replace(/\s+/g, " ").trim().slice(0, 140);
    const detail = String(raw.detail || "").replace(/\s+/g, " ").trim().slice(0, 240);
    return title ? { id: `plan-${Date.now().toString(36)}-${i}`, title, detail, status: i === 0 ? "active" : "pending" } : null;
  }).filter(Boolean);
}

function setPlan(convo, steps) {
  const plan = normalizePlan(steps);
  if (!plan.length) return false;
  convo.locodePlan = { created: Date.now(), steps: plan };
  return true;
}

function advancePlan(convo, ok, note = "") {
  const plan = convo.locodePlan?.steps;
  if (!plan?.length) return;
  const current = plan.find((p) => p.status === "active");
  if (!current) return;
  current.status = ok ? "done" : "blocked";
  if (note) current.note = note.slice(0, 180);
  if (ok) {
    const next = plan.find((p) => p.status === "pending");
    if (next) next.status = "active";
  }
}

function completePlan(convo) {
  // finish 시 현재 진행 중이던 단계만 완료로 표시한다. 손대지 않은 단계를
  // 완료로 칠하면 실제로 아무것도 안 했는데 5/5 로 보이는 착시가 생긴다.
  const cur = convo.locodePlan?.steps?.find((p) => p.status === "active");
  if (cur) cur.status = "done";
}

// 최근 명령을 테스트·빌드·린트 결과 패널로 묶기 위한 읽기 전용 분류.
export function commandPurpose(command) {
  const c = String(command || "").toLowerCase();
  if (/\b(test|vitest|jest|pytest|cargo test|go test)\b/.test(c)) return "test";
  if (/\b(build|compile|cargo build|tauri build)\b/.test(c)) return "build";
  if (/\b(lint|eslint|clippy|check)\b/.test(c)) return "lint";
  return "other";
}

async function execAction(convo, name, args) {
  const a = typeof args === "string" ? safeParse(args) : args || {};
  const step = { kind: name, path: a.path || a.from, ok: true, ts: Date.now() };

  // 파라미터 검증
  if ((name === "read_file" || name === "delete_path") && !a.path)
    return badParam(convo, step, `${name} 에는 path(경로)가 필요합니다`);
  if (name === "search" && !a.query)
    return badParam(convo, step, "search 에는 query(검색어)가 필요합니다");
  if (name === "write_file" && (!a.path || typeof a.content !== "string"))
    return badParam(convo, step, "write_file 에는 path 와 content(파일 전체 내용)가 필요합니다");
  if (name === "edit_file" && (!a.path || !normalizeEdits(a.edits).length))
    return badParam(convo, step, "edit_file 에는 path 와 edits([{old,new}], old 는 파일에 있는 정확한 텍스트)가 필요합니다");
  if (name === "move_path" && (!a.from || !a.to))
    return badParam(convo, step, "move_path 에는 from 과 to 가 필요합니다");
  if (name === "run_command" && (!a.command || typeof a.command !== "string"))
    return badParam(convo, step, "run_command 에는 command(명령)가 필요합니다");

  if (name === "propose_plan") {
    // 계획은 선택 사항이다. 형식이 틀려도 오류로 막지 말고 건너뛰게 한다(무한 재시도 방지).
    if (!setPlan(convo, a.steps)) return { ok: true, note: "계획을 건너뜁니다. 바로 파일 작업이나 명령을 실행하세요." };
    step.label = `☑ 작업 계획 ${convo.locodePlan.steps.length}단계 설정`;
    convo.locodeSteps.push(step);
    audit(convo, { action: name, params: { count: convo.locodePlan.steps.length }, tier: 0, decision: "auto" });
    return { plan: convo.locodePlan.steps.map((p) => p.title) };
  }

  // ── 명령 실행 (Tier 3 / 외부 상태 변경은 Tier 4 재확인) ──
  if (name === "run_command") {
    let policy;
    try { policy = await invoke("locode_command_policy", { cmd: a.command }); }
    catch (e) { return badParam(convo, step, "명령 안전성 확인 실패: " + e); }
    if (policy.level === "blocked") {
      audit(convo, { action: name, params: { command: a.command }, tier: 4, decision: "blocked", note: policy.reason });
      step.ok = false; step.label = `🛑 명령 차단: ${policy.reason}`; convo.locodeSteps.push(step);
      return { blocked: true, reason: policy.reason };
    }
    const tier = policy.level === "reconfirm" ? 4 : 3;
    const auto = autoApprove(convo, name, policy.level);
    const decision = auto || await requestApproval(convo, {
      kind: name, tier, command: a.command, why: a.why || "명령 실행", policy: policy.reason,
      cwd: convo.project?.path || "", reconfirm: policy.level === "reconfirm",
    });
    if (decision.verdict === "reject") {
      audit(convo, { action: name, params: { command: a.command }, tier, decision: "denied" });
      step.ok = false; step.label = "🚫 명령 실행 거부됨"; convo.locodeSteps.push(step);
      return { rejected: true, note: "사용자가 거부했습니다" };
    }
    return runCommand(convo, a.command, a.why || "명령 실행", policy, step, !!decision.confirmed);
  }

  // ── 읽기 계열 (Tier 0, 자동) ──
  if (!WRITE_ACTIONS.has(name)) {
    audit(convo, { action: name, params: a, tier: 0, decision: "auto" });
    try {
      if (name === "list_dir") {
        const entries = await invoke("locode_list_dir", { rel: a.path || "" });
        step.label = `📂 ${a.path || "/"} — ${entries.length}개 항목`;
        convo.locodeSteps.push(step);
        return { entries };
      }
      if (name === "read_file") {
        const f = await invoke("locode_read_file", { rel: a.path });
        mtimeCache.set(a.path, f.mtime);
        step.label = `📄 ${a.path} 읽음${f.masked ? ` (비밀 ${f.masked}건 마스킹)` : ""}${f.truncated ? " (일부만)" : ""}`;
        convo.locodeSteps.push(step);
        return { path: a.path, content: f.content, truncated: f.truncated };
      }
      if (name === "search") {
        const hits = await invoke("locode_search", { query: a.query, kind: a.kind || "text" });
        step.label = `🔍 "${a.query}" — ${hits.length}건`;
        convo.locodeSteps.push(step);
        return { hits };
      }
      if (name === "finish") {
        completePlan(convo);
        return { ok: true };
      }
    } catch (e) {
      step.ok = false;
      step.label = `⚠️ ${name} 실패: ${e}`;
      convo.locodeSteps.push(step);
      if (name === "read_file" && /찾을 수 없|not found|os error 2/i.test(String(e)))
        return { error: String(e), hint: "이 파일은 존재하지 않습니다. 같은 파일을 다시 읽지 말고, 필요하면 write_file 로 새로 만드세요." };
      return { error: String(e) };
    }
    return { error: "알 수 없는 동작: " + name };
  }

  // ── 쓰기 계열 (Tier 1~2, 승인 필요) ──
  let before = null;
  let diff = null;
  let edits = null;
  if (name === "write_file" || name === "edit_file") {
    try {
      const f = await invoke("locode_read_file", { rel: a.path });
      before = f.content;
      mtimeCache.set(a.path, f.mtime);
    } catch {
      before = null; // 새 파일
    }
  }
  if (name === "write_file") {
    diff = lineDiff(before, a.content);
  } else if (name === "edit_file") {
    edits = normalizeEdits(a.edits);
    // 승인 카드용 미리보기: 각 블록의 old→삭제, new→추가. (실제 적용은 Rust 가
    // 마스킹되지 않은 원본에 대해 수행하므로 여기서는 블록만 보여준다.)
    diff = [];
    for (const e of edits) {
      for (const l of e.old.split("\n")) diff.push({ type: "del", text: l });
      for (const l of e.new.split("\n")) diff.push({ type: "add", text: l });
    }
  }
  const tier = name === "write_file" || name === "edit_file" ? 1 : 2;
  const decision = autoApprove(convo, name, null) || await requestApproval(convo, {
    kind: name, tier, path: a.path, from: a.from, to: a.to,
    content: a.content, summary: a.summary || "", before, diff,
  });
  if (decision.verdict === "reject") {
    audit(convo, { action: name, params: { path: a.path || a.from }, tier, decision: "denied" });
    step.ok = false;
    step.label = `🚫 ${name} 거부됨`;
    convo.locodeSteps.push(step);
    return { rejected: true, note: decision.note || "사용자가 거부했습니다" };
  }

  const content = decision.content ?? a.content;
  try {
    if (name === "write_file") {
      const r = await invoke("locode_write_file", { rel: a.path, content, expectedMtime: mtimeCache.get(a.path) ?? null });
      mtimeCache.set(a.path, r.mtime);
      recordChange(convo, { path: a.path, type: r.created ? "create" : "modify", before: r.before ?? null, after: content });
      step.label = `✅ ${a.path} ${r.created ? "생성" : "수정"}`;
    } else if (name === "edit_file") {
      const r = await invoke("locode_edit_file", { rel: a.path, edits, expectedMtime: mtimeCache.get(a.path) ?? null });
      mtimeCache.set(a.path, r.mtime);
      // 원장 diff 용 after 는 원본(r.before)에 같은 순서로 치환해 재현한다(Rust 와 동일: 첫 일치만).
      let after = r.before ?? "";
      for (const e of edits) after = after.replace(e.old, e.new);
      recordChange(convo, { path: a.path, type: "modify", before: r.before ?? null, after });
      step.label = `✅ ${a.path} 수정 (${edits.length}곳)`;
    } else if (name === "move_path") {
      await invoke("locode_move", { from: a.from, to: a.to });
      recordChange(convo, { path: `${a.from} → ${a.to}`, type: "rename", from: a.from, to: a.to });
      step.label = `✅ ${a.from} → ${a.to}`;
    } else if (name === "delete_path") {
      const removed = await invoke("locode_delete", { rel: a.path });
      recordChange(convo, { path: a.path, type: "delete", before: removed ?? null, after: null });
      step.label = `✅ ${a.path} 삭제`;
    }
    audit(convo, { action: name, params: { path: a.path || a.from, to: a.to }, tier, decision: "approved" });
    convo.locodeSteps.push(step);
    advancePlan(convo, true, step.label);
    loadGitStatus(convo);
    return { applied: true, path: a.path || `${a.from}→${a.to}` };
  } catch (e) {
    step.ok = false;
    step.label = `⚠️ ${name} 실패: ${e}`;
    convo.locodeSteps.push(step);
    advancePlan(convo, false, step.label);
    return { error: String(e) };
  }
}

function badParam(convo, step, msg) {
  step.ok = false;
  step.label = `⚠️ ${msg}`;
  convo.locodeSteps.push(step);
  return { error: msg };
}

async function runCommand(convo, command, why, policy, step, confirmed) {
  const id = "run_" + ctx.uid();
  const record = { id, command, why, output: [], started: Date.now(), status: "running", policy: policy.level };
  (convo.commandRuns ||= []).push(record);
  activeRun = { id, convo, record };
  let repaintTimer = null;
  const repaint = () => {
    if (repaintTimer) return;
    repaintTimer = setTimeout(() => { repaintTimer = null; ctx.rerender(); }, 120);
  };
  try {
    const Channel = window.__TAURI__?.core?.Channel;
    if (!Channel) throw new Error("데스크톱 명령 채널을 사용할 수 없습니다");
    const channel = new Channel();
    channel.onmessage = (line) => { record.output.push(String(line)); repaint(); };
    const result = await invoke("locode_run", {
      cmd: command, timeout: 120, streamId: id, confirmed: policy.level !== "reconfirm" || confirmed, onLine: channel,
    });
    record.finished = Date.now();
    record.exitCode = result.exit_code;
    record.truncated = result.truncated;
    record.status = result.timed_out ? "timeout" : result.stopped ? "stopped" : result.exit_code === 0 ? "success" : "failed";
    step.ok = record.status === "success";
    step.label = step.ok ? `✅ ${command} 완료` : `⚠️ ${command} ${record.status === "timeout" ? "시간 초과" : record.status === "stopped" ? "중지됨" : "실패"}`;
    audit(convo, { action: "run_command", params: { command }, tier: policy.level === "reconfirm" ? 4 : 3, decision: "approved", result: step.ok ? "ok" : "error" });
    convo.locodeSteps.push(step);
    advancePlan(convo, step.ok, step.label);
    loadGitStatus(convo);
    return { exitCode: result.exit_code, status: record.status, output: record.output.slice(-80).join("\n") };
  } catch (e) {
    record.finished = Date.now(); record.status = "failed"; record.error = String(e);
    step.ok = false; step.label = `⚠️ 명령 실행 실패: ${e}`; convo.locodeSteps.push(step);
    advancePlan(convo, false, step.label);
    audit(convo, { action: "run_command", params: { command }, tier: 3, decision: "approved", result: "error", note: String(e) });
    return { error: String(e) };
  } finally {
    if (repaintTimer) clearTimeout(repaintTimer);
    if (activeRun?.id === id) activeRun = null;
    ctx.save(); ctx.rerender();
  }
}

// ---------- 승인 흐름 ----------
function requestApproval(convo, action) {
  return new Promise((resolve) => {
    pendingApproval = { resolve, convo, action };
    ctx.rerender();
  });
}
export function resolveApproval(verdict, editedContent, confirmed = false) {
  if (!pendingApproval) return;
  const p = pendingApproval;
  pendingApproval = null;
  p.resolve({ verdict, content: editedContent, confirmed });
  ctx.rerender();
}
export function hasPendingApproval() { return !!pendingApproval; }

// ---------- 변경 원장 ----------
function recordChange(convo, ch) {
  convo.changes = convo.changes || [];
  convo.changes.push({ id: ctx.uid(), ts: Date.now(), reverted: false, ...ch });
}

export async function revertChange(convo, changeId) {
  const ch = (convo.changes || []).find((c) => c.id === changeId);
  if (!ch || ch.reverted) return;
  try {
    if (ch.type === "create") {
      await invoke("locode_delete", { rel: ch.path });
    } else if (ch.type === "delete") {
      await invoke("locode_write_file", { rel: ch.path, content: ch.before ?? "", expectedMtime: null });
    } else if (ch.type === "modify") {
      await invoke("locode_write_file", { rel: ch.path, content: ch.before ?? "", expectedMtime: null });
    } else if (ch.type === "rename") {
      await invoke("locode_move", { from: ch.to, to: ch.from });
    }
    ch.reverted = true;
    audit(convo, { action: "revert", params: { path: ch.path }, tier: 2, decision: "approved" });
    ctx.toast("되돌렸습니다: " + ch.path);
    ctx.save();
    ctx.rerender();
  } catch (e) {
    ctx.toast("되돌리기 실패: " + e);
  }
}
const safeParse = (s) => { try { return JSON.parse(s); } catch { return {}; } };

export function locodeStop() {
  stopFlag = true;
  if (pendingApproval) resolveApproval("reject", undefined); // 승인 대기 중이면 거부로 종료
  if (activeRun) invoke("locode_stop_run", { streamId: activeRun.id }).catch(() => {});
}
export function locodeRunning() { return running; }

export async function locodeSend(convo, text) {
  if (running) return;
  // 첫 요청에서 프로젝트가 없으면 단순 오류로 끝내지 않고 폴더 선택을 자연스럽게 연결한다.
  // 사용자가 선택을 취소한 경우에는 메시지를 저장하거나 실행하지 않는다.
  if (!convo.project) {
    ctx.toast("작업할 프로젝트 폴더를 선택하세요");
    const opened = await locodeOpenProject(convo);
    if (!opened) return;
  }
  if ((await ensureProjectOpen(convo)) !== "ok") { ctx.toast("프로젝트를 다시 열어주세요"); ctx.rerender(); return; }
  convo.messages.push({ id: ctx.uid(), role: "user", content: text, ts: Date.now() });
  convo.updated = Date.now();
  running = true;
  stopFlag = false;
  ctx.rerender();

  const model = convo.model;
  // 첫 LOCODE 요청에도 모델의 실제 tools capability를 가져와, 지원 모델이 JSON 대체
  // 프로토콜로 잘못 내려가는 경쟁 상태를 없앤다.
  await ctx.ensureModelInfo?.(model);
  const useTools = isToolCapable(model);
  const messages = buildMessages(convo);
  const taskMsg = messages[messages.length - 1]; // 이번 턴의 사용자 요청 — 창을 줄여도 항상 유지
  let iter = 0;
  let nudges = 0;
  let stuck = 0; // 연속 실패/거부 횟수 — 무한 루프 방지용
  const recent = []; // 최근 동작 시그니처 — 같은 동작 반복 감지
  const MAX = 300; // 사실상 무제한. 실제 중단은 stuck·반복 감지·중지 버튼이 담당한다.
  const STUCK_LIMIT = 8;
  // 최근 6개 동작이 서로 다른 종류가 2가지 이하면 제자리걸음으로 보고 중단한다.
  const looping = (sig) => {
    recent.push(sig);
    if (recent.length > 6) recent.shift();
    return recent.length === 6 && new Set(recent).size <= 2;
  };

  try {
    while (iter++ < MAX && !stopFlag) {
      let res;
      try {
        res = await callModel(model, windowMessages(messages, taskMsg), useTools);
      } catch (e) {
        pushAssistant(convo, "⚠️ 모델 호출 실패: " + (e.message || e));
        break;
      }

      if (useTools) {
        if (!res.toolCalls.length) {
          const salvaged = salvageToolCalls(res.content);
          if (salvaged.length) res.toolCalls = salvaged;
          else if (nudges++ < 2) {
            messages.push({ role: "user", content: "[시스템] 위 답변에는 도구 호출이 없었습니다. 다음 턴에는 설명 없이 도구 하나만 호출하세요 (list_dir/read_file/search/write_file/run_command). 작업이 끝났으면 finish 를 호출하세요." });
            continue;
          } else { pushAssistant(convo, "AI가 도구를 호출하지 않아 작업을 진행하지 못했습니다. 요청을 더 구체적으로 적거나, 코드 작업에 적합한 모델(예: qwen2.5-coder:14b)로 바꿔 보세요."); break; }
        }
        let finished = false;
        for (const tc of res.toolCalls) {
          const fname = tc.function?.name;
          const fargs = tc.function?.arguments;
          if (fname === "finish") {
            completePlan(convo);
            pushAssistant(convo, (typeof fargs === "string" ? safeParse(fargs) : fargs)?.summary || "분석 완료");
            finished = true;
            break;
          }
          const loop = looping(fname + ":" + JSON.stringify(fargs || {}).slice(0, 120));
          const out = await execAction(convo, fname, fargs);
          if (out && (out.error || out.rejected)) stuck++; else stuck = 0;
          messages.push({ role: "assistant", content: "", tool_calls: [tc] });
          messages.push({ role: "tool", content: JSON.stringify(out).slice(0, 10000) });
          ctx.rerender();
          if (stuck >= STUCK_LIMIT || loop) { pushAssistant(convo, "AI가 같은 동작만 반복하고 있어 자동으로 중단했습니다. 더 구체적으로 요청하거나 다른 모델로 시도해 보세요."); finished = true; break; }
        }
        if (finished) break;
      } else {
        let action = parseLocodeAction(res.content);
        if (!action) {
          // {name, arguments} 형태로 나온 경우도 건져낸다
          const sc = salvageToolCalls(res.content)[0];
          if (sc) action = { action: sc.function.name, ...(sc.function.arguments || {}) };
        }
        if (!action || !action.action) {
          if (nudges++ < 2) {
            messages.push({ role: "user", content: "[시스템] 다른 설명 없이 JSON 객체 하나만 출력하세요. 예: {\"action\":\"list_dir\",\"path\":\"\",\"message\":\"구조 확인\"}" });
            continue;
          }
          pushAssistant(convo, "⚠️ AI 응답을 이해하지 못했습니다. 아래 원문을 확인하세요:\n\n```\n" + res.content + "\n```");
          break;
        }
        if (action.action === "finish") { completePlan(convo); pushAssistant(convo, action.summary || action.message || "작업 완료"); break; }
        const loop = looping(action.action + ":" + (action.path || action.from || action.query || ""));
        const out = await execAction(convo, action.action, action);
        if (out && (out.error || out.rejected)) stuck++; else stuck = 0;
        messages.push({ role: "assistant", content: res.content });
        messages.push({ role: "user", content: "도구 결과:\n" + JSON.stringify(out).slice(0, 10000) + "\n\n다음 동작 또는 finish 를 JSON 으로 응답하세요." });
        ctx.rerender();
        if (stuck >= STUCK_LIMIT || loop) { pushAssistant(convo, "AI가 같은 동작만 반복하고 있어 자동으로 중단했습니다. 더 구체적으로 요청하거나 다른 모델로 시도해 보세요."); break; }
      }
      ctx.save();
    }
    if (iter >= MAX) pushAssistant(convo, "작업이 매우 길어져 중단했습니다. 이어서 진행하려면 다시 요청해 주세요.");
    if (stopFlag) pushAssistant(convo, "⏹ 작업이 중단되었습니다.");
  } finally {
    running = false;
    ctx.save();
    ctx.rerender();
  }
}
export function parseLocodeAction(text) {
  const candidates = [];
  const raw = String(text || "").trim();
  if (raw) candidates.push(raw);
  const fences = raw.match(/```(?:json)?\s*([\s\S]*?)```/gi) || [];
  for (const fence of fences) candidates.push(fence.replace(/```(?:json)?/i, "").trim());
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start >= 0 && end > start) candidates.push(raw.slice(start, end + 1));
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      if (parsed && typeof parsed === "object" && typeof parsed.action === "string") return parsed;
    } catch { /* 다음 후보 */ }
  }
  return null;
}

// 일부 모델(특히 coder 계열)은 tool_call 을 구조화하지 않고 본문 텍스트 JSON 으로 뱉는다.
// {name, arguments} / {tool, args} / {function:{...}} / 그 배열 형태를 건져낸다.
export function salvageToolCalls(text) {
  if (!text || !text.includes("{")) return [];
  const cands = [];
  const fences = text.match(/```(?:json)?\s*([\s\S]*?)```/gi);
  if (fences) for (const f of fences) cands.push(f.replace(/```(?:json)?/g, "").trim());
  // Qwen/Coder 계열이 종종 사용하는 텍스트 tool-call 표기. Ollama가 구조화된
  // tool_calls로 바꾸지 못해도 이 형태는 실제 도구 호출로 복구한다.
  const xmlCalls = text.match(/<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/gi);
  if (xmlCalls) for (const call of xmlCalls) cands.push(call.replace(/<\/?tool_call>/gi, "").trim());
  cands.push(text.trim());
  const first = text.indexOf("{");
  const last = text.lastIndexOf("}");
  if (first >= 0 && last > first) cands.push(text.slice(first, last + 1));
  for (const c of cands) {
    try {
      const parsed = JSON.parse(c);
      const arr = Array.isArray(parsed) ? parsed : [parsed];
      const calls = [];
      for (const it of arr) {
        const name = it.name || it.tool || it.function?.name || it.action;
        let args = it.arguments || it.parameters || it.args || it.function?.arguments;
        if (args == null) {
          // {action, path, content...} 평면 형태
          const { name: _n, tool: _t, action: _a, arguments: _ar, ...rest } = it;
          args = rest;
        }
        if (name) calls.push({ function: { name, arguments: args } });
      }
      if (calls.length) return calls;
    } catch { /* 다음 후보 */ }
  }
  return [];
}

function pushAssistant(convo, content) {
  convo.messages.push({ id: ctx.uid(), role: "assistant", content, ts: Date.now() });
  convo.updated = Date.now();
}

// ---------- 렌더링 ----------
export function renderLocode(el, convo) {
  el.innerHTML = "";
  const wrap = document.createElement("div");
  wrap.className = "locode";

  if (!hasTauri()) {
    wrap.innerHTML = `<div class="empty"><h2>LOCODE</h2><p>파일·명령에 접근하는 LOCODE 모드는 데스크톱 앱에서만 사용할 수 있습니다.<br>웹 미리보기에서는 CHAT 모드를 사용하세요.</p></div>`;
    el.appendChild(wrap);
    return;
  }

  if (!convo.project) {
    wrap.innerHTML = `
      <div class="empty">
        <h2>LOCODE — 프로젝트 작업</h2>
        <p>로컬 프로젝트 폴더를 선택하면 AI가 코드를 읽고, <b>승인을 거쳐</b> 파일을 수정합니다.<br>
        테스트·빌드 명령도 실행 전 승인을 거쳐 안전하게 실행합니다.</p>
        <button class="btn" id="lcPick" type="button">📁 프로젝트 폴더 선택</button>
        <p class="ob-hint">선택한 폴더 안에서만 작업하며, <code>.env</code>·키 파일은 제외됩니다. 모든 변경은 diff 확인 후 승인해야 반영됩니다.</p>
      </div>`;
    el.appendChild(wrap);
    document.getElementById("lcPick").onclick = () => locodeOpenProject(convo);
    return;
  }

  // 앱 재시작 등으로 Rust 쪽 프로젝트 연결이 끊겼으면 복구
  if (activeRoot !== convo.project.path) {
    wrap.innerHTML = `<div class="empty"><div class="spinner" role="status"></div><p>프로젝트 다시 여는 중…</p></div>`;
    el.appendChild(wrap);
    ensureProjectOpen(convo).then((r) => {
      if (r === "ok") ctx.rerender();
      else {
        wrap.innerHTML = `
          <div class="empty">
            <h2>프로젝트를 다시 열어주세요</h2>
            <p><code>${escapeHtml(convo.project.path)}</code><br>폴더가 이동/삭제되었거나 앱이 재시작되었습니다.</p>
            <div class="ob-actions">
              <button class="btn" id="lcRepick" type="button">📁 폴더 선택</button>
              <button class="btn secondary" id="lcDrop" type="button">이 대화에서 프로젝트 해제</button>
            </div>
          </div>`;
        document.getElementById("lcRepick").onclick = () => locodeOpenProject(convo);
        document.getElementById("lcDrop").onclick = () => locodeCloseProject(convo);
      }
    });
    return;
  }

  // 상단 바
  const bar = document.createElement("div");
  bar.className = "lc-bar";
  const tierInfo = locodeTier(convo.model, ctx.modelCaps.get(convo.model), ctx.modelParam?.(convo.model));
  const nChanges = (convo.changes || []).filter((c) => !c.reverted).length;
  bar.innerHTML = `
    <span class="lc-proj">📁 ${escapeHtml(convo.project.name)}</span>
    <span class="lc-perm">읽기 · 쓰기 · 명령</span>
    ${convo.git?.is_git ? `<span class="lc-git">git: ${escapeHtml(convo.git.branch || "?")}${convo.git.files?.length ? ` ·${convo.git.files.length}개 변경` : ""}</span>` : ""}
    <span class="lc-tier lc-tier-${tierInfo.tier}">${tierInfo.label}</span>
    ${nChanges ? `<span class="lc-changes-badge">변경 ${nChanges}</span>` : ""}
    <span style="flex:1"></span>
    <button class="lc-close" id="lcClose" type="button">닫기</button>`;
  wrap.appendChild(bar);

  // 본문: 대화 한 칸. 상태 패널은 접이식으로 접어 채팅 영역을 가리지 않게 한다.
  const body = document.createElement("div");
  body.className = "lc-body";

  const conv = document.createElement("div");
  conv.className = "lc-conv";

  const panels = document.createElement("details");
  panels.className = "lc-panels";
  panels.open = !!convo.locodePanelsOpen;
  panels.addEventListener("toggle", () => { convo.locodePanelsOpen = panels.open; });
  const nPanel = (convo.locodePlan?.steps?.length ? 1 : 0) + (convo.git?.is_git ? 1 : 0) + (convo.changes?.length ? 1 : 0) + (convo.commandRuns?.length ? 1 : 0) + 1;
  panels.innerHTML = `<summary>작업 패널 (${nPanel}) · 계획 / Git / 기록 / 변경</summary>`;
  const pbody = document.createElement("div");
  pbody.className = "lc-panels-body";
  if (convo.locodePlan?.steps?.length) pbody.appendChild(renderPlanPanel(convo));
  if (convo.git?.is_git) pbody.appendChild(renderGitPanel(convo));
  pbody.appendChild(renderAuditPanel(convo));
  if (convo.changes?.length) pbody.appendChild(renderLedger(convo));
  if (convo.commandRuns?.length) {
    pbody.appendChild(renderCheckSummary(convo));
    pbody.appendChild(renderCommandRuns(convo));
  }
  panels.appendChild(pbody);
  conv.appendChild(panels);

  const msgs = document.createElement("div");
  msgs.className = "lc-msgs";
  // 메시지와 AI 작업 단계를 실행 순서대로 한 흐름에 표시한다.
  const timeline = [
    ...convo.messages.filter((m) => m.content).map((m) => ({ t: m.ts || 0, msg: m })),
    ...(convo.locodeSteps || []).map((s) => ({ t: s.ts || 0, step: s })),
  ].sort((a, b) => a.t - b.t);
  for (const item of timeline) {
    if (item.step) { msgs.appendChild(renderStepRow(item.step, convo)); continue; }
    const m = item.msg;
    const row = document.createElement("div");
    row.className = "msg-row " + m.role;
    const b = document.createElement("div");
    b.className = "bubble";
    if (m.role === "assistant") {
      const md = document.createElement("div");
      md.className = "md";
      md.innerHTML = renderMarkdown(m.content);
      ctx.enhanceCodeBlocks?.(md);
      b.appendChild(md);
    }
    else b.textContent = m.content;
    row.appendChild(b);
    msgs.appendChild(row);
  }
  if (running && !pendingApproval) {
    const r = document.createElement("div");
    r.className = "msg-row assistant";
    r.innerHTML = `<div class="bubble"><span class="typing"><i></i><i></i><i></i></span></div>`;
    msgs.appendChild(r);
  }
  conv.appendChild(msgs);

  // 승인 카드 (대기 중일 때)
  if (pendingApproval && pendingApproval.convo === convo) {
    conv.appendChild(renderApprovalCard(pendingApproval.action));
  }

  conv.appendChild(renderPermBar(convo));

  body.appendChild(conv);
  wrap.appendChild(body);
  el.appendChild(wrap);

  document.getElementById("lcClose").onclick = () => locodeCloseProject(convo);
  msgs.scrollTop = msgs.scrollHeight;
}

const PERM_MODES = [
  ["ask", "항상 묻기"],
  ["write", "읽기·쓰기·수정 허용"],
  ["safe", "위험 여부 확인 후 허용"],
  ["all", "전체 허용"],
];

function renderPermBar(convo) {
  const box = document.createElement("div");
  box.className = "lc-perm-bar";
  const sel = document.createElement("select");
  for (const [v, label] of PERM_MODES) {
    const o = document.createElement("option");
    o.value = v; o.textContent = label;
    sel.appendChild(o);
  }
  sel.value = convo.locodePermMode || "ask";
  sel.onchange = () => { convo.locodePermMode = sel.value; ctx.save(); };
  const lab = document.createElement("label");
  lab.textContent = "실행 권한 ";
  lab.appendChild(sel);
  box.appendChild(lab);
  return box;
}

// 권한 모드에 따라 승인을 자동 처리한다. null 이면 사용자에게 물어야 한다.
// blocked 명령은 어떤 모드에서도 자동 승인하지 않는다.
function autoApprove(convo, kind, policyLevel) {
  const mode = convo.locodePermMode || "ask";
  if (mode === "ask") return null;
  if (policyLevel === "blocked") return null;
  if (mode === "all") return { verdict: "approve", content: undefined, confirmed: true };
  if (mode === "safe") {
    if (policyLevel === "reconfirm") return null; // 위험 명령은 확인
    return { verdict: "approve", content: undefined, confirmed: true };
  }
  // write: 파일 쓰기·이동만 자동, 삭제·명령은 확인
  if (kind === "write_file" || kind === "move_path") return { verdict: "approve", content: undefined };
  return null;
}

// AI 작업 한 단계 — 한 줄로 표시하고 클릭하면 상세가 펼쳐진다.
function renderStepRow(s, convo) {
  const row = document.createElement("div");
  row.className = "lc-step-row" + (s.ok ? "" : " err");
  const head = document.createElement("button");
  head.type = "button";
  head.className = "lc-step-head";
  head.textContent = "› " + (s.label || s.kind);

  const detail = document.createElement("div");
  detail.className = "lc-step-detail";
  detail.hidden = true;
  const time = s.ts ? new Date(s.ts).toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit", second: "2-digit" }) : "";
  detail.innerHTML =
    `<div>종류: <code>${escapeHtml(s.kind || "-")}</code></div>` +
    (s.path ? `<div>경로: <code>${escapeHtml(s.path)}</code></div>` : "") +
    (time ? `<div>시간: ${time}</div>` : "") +
    `<div>결과: ${s.ok ? "성공" : "실패"}</div>`;
  if (s.path && s.ok && /read_file|write_file|edit_file/.test(s.kind || "")) {
    const open = document.createElement("button");
    open.type = "button";
    open.className = "lc-step-open";
    open.textContent = "파일 보기";
    open.onclick = (e) => { e.stopPropagation(); locodePreviewFile(convo, s.path); };
    detail.appendChild(open);
  }
  head.onclick = () => { detail.hidden = !detail.hidden; };
  row.append(head, detail);
  return row;
}

function renderPlanPanel(convo) {
  const box = document.createElement("section");
  box.className = "lc-plan";
  const steps = convo.locodePlan.steps;
  const done = steps.filter((s) => s.status === "done").length;
  box.innerHTML = `<div class="lc-panel-head"><span>작업 계획</span><span>${done}/${steps.length}</span></div>`;
  for (const item of steps) {
    const row = document.createElement("div");
    row.className = "lc-plan-row " + item.status;
    const icon = item.status === "done" ? "✓" : item.status === "active" ? "•" : item.status === "blocked" ? "!" : "○";
    row.innerHTML = `<span class="lc-plan-icon">${icon}</span><span class="lc-plan-text"></span>`;
    const text = row.querySelector(".lc-plan-text");
    text.textContent = item.title;
    if (item.detail || item.note) {
      const detail = document.createElement("small");
      detail.textContent = item.note || item.detail;
      text.appendChild(detail);
    }
    box.appendChild(row);
  }
  return box;
}

function renderGitPanel(convo) {
  const box = document.createElement("section");
  box.className = "lc-git-panel";
  const git = convo.git;
  const sync = document.createElement("button");
  sync.className = "lc-panel-action"; sync.type = "button"; sync.textContent = "새로고침";
  sync.onclick = () => loadGitStatus(convo);
  box.innerHTML = `<div class="lc-panel-head"><span>Git 상태</span><span class="lc-git-meta"></span></div>`;
  box.querySelector(".lc-panel-head").appendChild(sync);
  const meta = box.querySelector(".lc-git-meta");
  meta.textContent = `${git.branch || "detached"}${git.ahead ? ` ↑${git.ahead}` : ""}${git.behind ? ` ↓${git.behind}` : ""}`;
  if (!git.files?.length) {
    const clean = document.createElement("div"); clean.className = "lc-panel-empty"; clean.textContent = "작업 폴더가 깨끗합니다."; box.appendChild(clean);
  } else {
    for (const file of git.files.slice(0, 40)) {
      const row = document.createElement("div"); row.className = "lc-git-file";
      row.innerHTML = `<span></span><code></code>`;
      row.children[0].textContent = file.status || "?";
      row.children[1].textContent = file.path;
      box.appendChild(row);
    }
    if (git.files.length > 40) { const more = document.createElement("div"); more.className = "lc-panel-empty"; more.textContent = `… ${git.files.length - 40}개 더`; box.appendChild(more); }
  }
  return box;
}

function renderAuditPanel(convo) {
  const box = document.createElement("section");
  box.className = "lc-audit";
  const audit = convo.auditLog;
  const head = document.createElement("div");
  head.className = "lc-panel-head";
  head.innerHTML = `<span>작업 기록</span><span></span>`;
  const btn = document.createElement("button");
  btn.className = "lc-panel-action"; btn.type = "button"; btn.textContent = audit?.loading ? "불러오는 중" : audit?.entries ? "새로고침" : "보기";
  btn.disabled = !!audit?.loading;
  btn.onclick = () => loadAuditLog(convo);
  head.appendChild(btn); box.appendChild(head);
  if (audit?.error) { const err = document.createElement("div"); err.className = "lc-panel-empty err"; err.textContent = "기록을 읽을 수 없습니다: " + audit.error; box.appendChild(err); }
  else if (audit?.entries) {
    if (!audit.entries.length) { const empty = document.createElement("div"); empty.className = "lc-panel-empty"; empty.textContent = "아직 저장된 작업 기록이 없습니다."; box.appendChild(empty); }
    for (const row of audit.entries.slice(0, 30)) {
      const e = row.e || row;
      const item = document.createElement("div"); item.className = "lc-audit-row";
      const action = e.action || "기록";
      const decision = e.decision || "";
      item.innerHTML = `<span></span><span></span><time></time>`;
      item.children[0].textContent = decision === "blocked" ? "차단" : decision === "denied" ? "거부" : decision === "approved" ? "승인" : "자동";
      item.children[1].textContent = action;
      const ts = Number(row.ts || e.ts);
      item.querySelector("time").textContent = ts ? new Date(ts).toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit" }) : "";
      box.appendChild(item);
    }
  } else {
    const note = document.createElement("div"); note.className = "lc-panel-empty"; note.textContent = "승인·차단·명령 실행 기록을 확인할 수 있습니다."; box.appendChild(note);
  }
  return box;
}

function renderLedger(convo) {
  const box = document.createElement("div");
  box.className = "lc-ledger";
  const head = document.createElement("div");
  head.className = "lc-ledger-head";
  head.textContent = `변경 파일 (${convo.changes.length})`;
  box.appendChild(head);
  for (const ch of convo.changes) {
    const row = document.createElement("div");
    row.className = "lc-change" + (ch.reverted ? " reverted" : "");
    const tag = { create: "A", modify: "M", delete: "D", rename: "R" }[ch.type] || "?";
    const stat = ch.type === "modify" && ch.before != null
      ? (() => { const s = diffStat(lineDiff(ch.before, ch.after)); return ` +${s.add} -${s.del}`; })()
      : ch.type === "create" ? ` +${(ch.after || "").split("\n").length}` : "";
    row.innerHTML = `<span class="lc-ch-tag lc-ch-${ch.type}">${tag}</span><span class="lc-ch-path"></span><span class="lc-ch-stat">${stat}</span>`;
    row.querySelector(".lc-ch-path").textContent = ch.path;
    if (!ch.reverted && (ch.type === "modify" || ch.type === "create" || ch.type === "delete")) {
      const dbtn = document.createElement("button");
      dbtn.className = "lc-ch-btn"; dbtn.type = "button"; dbtn.textContent = "diff";
      dbtn.onclick = () => ctx.showFilePreview?.(
        ch.path + " (변경 내역)",
        diffText(lineDiff(ch.before ?? null, ch.after ?? null)),
        { diff: true }
      );
      row.appendChild(dbtn);
    }
    if (!ch.reverted) {
      const rbtn = document.createElement("button");
      rbtn.className = "lc-ch-btn revert"; rbtn.type = "button"; rbtn.textContent = "되돌리기";
      rbtn.onclick = () => revertChange(convo, ch.id);
      row.appendChild(rbtn);
    } else {
      const s = document.createElement("span");
      s.className = "lc-ch-reverted"; s.textContent = "되돌림";
      row.appendChild(s);
    }
    box.appendChild(row);
  }
  return box;
}

function diffText(diff) {
  return diff.map((d) => (d.type === "add" ? "+ " : d.type === "del" ? "- " : "  ") + d.text).join("\n");
}

function renderCheckSummary(convo) {
  const box = document.createElement("section");
  box.className = "lc-checks";
  box.innerHTML = `<div class="lc-panel-head"><span>검증 결과</span><span>최근 실행 기준</span></div>`;
  const latest = {};
  for (const run of convo.commandRuns || []) {
    const type = commandPurpose(run.command);
    if (type !== "other") latest[type] = run;
  }
  const labels = { test: "테스트", build: "빌드", lint: "린트" };
  for (const type of ["test", "build", "lint"]) {
    const run = latest[type];
    const row = document.createElement("div"); row.className = "lc-check " + (run?.status || "idle");
    const status = !run ? "미실행" : run.status === "success" ? "통과" : run.status === "running" ? "실행 중" : "실패";
    row.innerHTML = `<span></span><span></span><span></span>`;
    row.children[0].textContent = labels[type];
    row.children[1].textContent = status;
    row.children[2].textContent = run?.command || "—";
    box.appendChild(row);
  }
  return box;
}

function renderCommandRuns(convo) {
  const box = document.createElement("div");
  box.className = "lc-runs";
  const recent = convo.commandRuns.slice(-5).reverse();
  box.innerHTML = `<div class="lc-runs-head">명령 실행 (${convo.commandRuns.length})</div>`;
  for (const run of recent) {
    const card = document.createElement("div");
    card.className = "lc-run " + run.status;
    const elapsed = Math.max(0, ((run.finished || Date.now()) - run.started) / 1000).toFixed(1);
    const label = { running: "실행 중", success: "완료", failed: "실패", stopped: "중지됨", timeout: "시간 초과" }[run.status] || run.status;
    card.innerHTML = `<div class="lc-run-title"><span class="lc-run-status">${label}</span><code></code><span class="lc-run-time">${elapsed}초</span></div><div class="lc-run-why"></div>`;
    card.querySelector("code").textContent = run.command;
    card.querySelector(".lc-run-why").textContent = run.why || "";
    const details = document.createElement("details");
    details.innerHTML = `<summary>상세 출력${run.truncated ? " (일부 생략됨)" : ""}</summary><pre></pre>`;
    details.querySelector("pre").textContent = (run.output || []).join("\n") || (run.error || "출력이 없습니다.");
    card.appendChild(details);
    if (run.status === "running") {
      const stop = document.createElement("button");
      stop.className = "lc-run-stop"; stop.type = "button"; stop.textContent = "중지";
      stop.onclick = () => locodeStop();
      card.appendChild(stop);
    }
    box.appendChild(card);
  }
  return box;
}

function renderApprovalCard(action) {
  const card = document.createElement("div");
  card.className = "lc-approve tier-" + action.tier;
  const isDanger = action.tier >= 2;
  const kindLabel = { write_file: "파일 쓰기", edit_file: "부분 수정", move_path: "이동/이름변경", delete_path: "삭제", run_command: "명령 실행" }[action.kind] || action.kind;
  const target = action.kind === "move_path" ? `${action.from} → ${action.to}` : action.kind === "run_command" ? action.command : action.path;

  const stat = action.diff ? diffStat(action.diff) : null;
  card.innerHTML = `
    <div class="lc-ap-head ${isDanger ? "danger" : ""}">
      ${isDanger ? "⚠️ " : ""}${kindLabel} 승인 필요
      ${stat ? `<span class="lc-ap-stat">+${stat.add} -${stat.del}</span>` : ""}
    </div>
    <div class="lc-ap-target"></div>
    ${action.summary ? `<div class="lc-ap-summary"></div>` : ""}
    ${action.diff ? `<pre class="lc-ap-diff"></pre>` : ""}
    ${action.kind === "delete_path" ? `<div class="lc-ap-note">이 파일이 삭제됩니다. 되돌리기로 복구할 수 있습니다.</div>` : ""}
    ${action.kind === "run_command" ? `<div class="lc-ap-note">작업 폴더: <code></code><br>${action.policy || "출력과 실행 시간이 제한됩니다."}</div>` : ""}
    ${action.reconfirm ? `<label class="lc-confirm">계속하려면 <b>실행</b>을 입력하세요 <input id="apConfirm" autocomplete="off" /></label>` : ""}
    <div class="lc-ap-actions">
      <button class="btn ${isDanger ? "danger" : ""}" id="apOk" type="button">${isDanger ? "삭제/이동 실행" : "승인"}</button>
      <button class="btn secondary" id="apNo" type="button">거부</button>
    </div>`;
  card.querySelector(".lc-ap-target").textContent = target;
  if (action.kind === "run_command") card.querySelector(".lc-ap-note code").textContent = action.cwd || "프로젝트 루트";
  if (action.summary) card.querySelector(".lc-ap-summary").textContent = action.summary;
  if (action.diff) {
    const pre = card.querySelector(".lc-ap-diff");
    for (const d of action.diff.slice(0, 400)) {
      const line = document.createElement("div");
      line.className = "dl-" + d.type;
      line.textContent = (d.type === "add" ? "+ " : d.type === "del" ? "- " : "  ") + d.text;
      pre.appendChild(line);
    }
    if (action.diff.length > 400) {
      const more = document.createElement("div");
      more.className = "dl-ctx";
      more.textContent = `… (${action.diff.length - 400}줄 더)`;
      pre.appendChild(more);
    }
  }
  card.querySelector("#apOk").onclick = () => {
    const ok = !action.reconfirm || card.querySelector("#apConfirm")?.value.trim() === "실행";
    if (!ok) { ctx.toast('확인란에 "실행"을 입력하세요'); return; }
    resolveApproval("approve", undefined, ok);
  };
  card.querySelector("#apNo").onclick = () => resolveApproval("reject");
  return card;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}

export async function locodePreviewFile(convo, rel) {
  try {
    const f = await invoke("locode_read_file", { rel });
    ctx.showFilePreview?.(rel, f.content, f);
  } catch (e) {
    ctx.toast("읽기 실패: " + e);
  }
}
