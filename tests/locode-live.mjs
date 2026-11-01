// Optional live-model check. Application RPCs/approvals are simulated; commands
// are deliberately rejected and are never executed outside Rust approval.
// Run explicitly: node tests/locode-live.mjs
import assert from "node:assert/strict";
import { fixture } from "./locode.mjs";
const base = "http://127.0.0.1:11434";
const prompt = '현재 Java 프로젝트 구조를 확인한 뒤, 기존 코드를 불필요하게 수정하지 말고 LocodeHello.java를 생성해줘. 실행하면 "LOCODE TEST SUCCESS"를 출력하도록 구현하고, 가능한 경우 실제로 컴파일 및 실행하여 검증해줘.';
const shapes = [];
const result = await fixture(async (round, body) => {
  const response = await fetch(base + "/api/chat", { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body), signal: AbortSignal.timeout(90000) });
  assert.equal(response.ok, true, "Ollama HTTP " + response.status);
  const data = await response.json();
  shapes.push({ round, mode: body.tools ? "native" : "structured", nativeCalls: data.message?.tool_calls?.length || 0,
    textCall: /^[{[<`]/.test(data.message?.content?.trim() || "") });
  return data.message;
}, { context: 8192, prompt, nativeReject: true });
// A live model is not deterministic. Report observed behavior without inventing success.
console.log(JSON.stringify({ model: "qwen2.5-coder:7b", shapes,
  proposed: result.calls.filter(c => ["locode_write_file", "locode_edit_file", "locode_run"].includes(c.cmd)).map(c => c.cmd),
  steps: result.convo.locodeExecution?.map(r => ({ name: r.name, ok: r.ok, category: r.category })),
  filesApplied: result.convo.changes?.length || 0, backend: "simulated; native approval rejected; no real compilation" }, null, 2));
