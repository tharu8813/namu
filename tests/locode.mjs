import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { locodeInit, locodeSend, locodeStop, locodeRunning, hasPendingApproval, resolveApproval,
  decodeToolResponse, salvageToolCalls, parseLocodeAction, actionSchema, resumeState } from "../src/locode.js";

const call = (name, args) => ({ function: { name, arguments: args } });
const text = (name, args) => ({ content: JSON.stringify({ name, arguments: args }) });
const native = (name, args) => ({ content: "", tool_calls: [call(name, args)] });
const finish = () => text("finish", { summary: "완료" });
const userFixture = '{"name": "list_dir", "arguments": {"path": ""}}';
assert.deepEqual(salvageToolCalls(userFixture), [call("list_dir", { path: "" })]);
assert.equal(parseLocodeAction('{"action":"read_file","path":"README.md"}').path, "README.md");
assert.equal(salvageToolCalls('<tool_call>' + userFixture + '</tool_call>').length, 1);
assert.equal(salvageToolCalls('```json\n' + userFixture + '\n```').length, 1);
for (const content of ["설명 " + userFixture, "파일 내용:\n```json\n" + userFixture + "\n```", userFixture + " 설명",
  '{"content":' + JSON.stringify(userFixture) + '}', '<tool_call>' + userFixture + '</tool_call>\n추가 설명', "null"]) {
  assert.equal(salvageToolCalls(content).length, 0, content);
}
assert.equal(decodeToolResponse({ content: '{"name":' }).category, "json");
assert.equal(decodeToolResponse({ content: "" }).category, "no_call");
assert.equal(decodeToolResponse({ content: "설명만 합니다" }).category, "natural_language");
assert.equal(decodeToolResponse({ content: "예시: " + userFixture }).category, "format");
assert.match(decodeToolResponse(text("bogus", {})).calls[0].error, /알 수 없는 도구/);
assert.match(decodeToolResponse(text("list_dir", { path: 42 })).calls[0].error, /타입/);
assert.equal(decodeToolResponse({ toolCalls: [call("read_file", { path: "a" })], content: userFixture }).calls[0].function.name, "read_file");
assert.equal(salvageToolCalls(JSON.stringify([{ name: "list_dir", arguments: { path: "" } }, { action: "list_dir", path: "" }])).length, 1);
assert.equal(salvageToolCalls(JSON.stringify([{ name: "delete_path", arguments: { path: "a", summary: "one" } }, { action: "delete_path", path: "a", summary: "two" }])).length, 1);
assert.equal(salvageToolCalls('{"name":"list_dir","arguments":{"path":""},"content":"example"}').length, 0);
assert.ok(actionSchema(true).oneOf.some(s => s.properties.action.const === "write_file"));
assert.ok(!actionSchema(false).oneOf.some(s => s.properties.action.const === "run_command"));
assert.ok(actionSchema(true, true).oneOf.some(s => s.properties.action.const === "web_search"));

let serial = 0;
// Exercise the real frontend loop/validation/approval functions. RPC simulates Rust,
// including an independent native rejection; it does not assert real dialog behavior.
export async function fixture(responses, options = {}) {
  const calls = [], requests = [], files = options.files || new Map([["README.md", "Java project"]]);
  let round = 0, approvals = 0, nativeApprovals = 0;
  const project = options.project || "fixture-" + (++serial);
  const convo = options.convo || { model: "qwen2.5-coder:7b", project: { path: project, name: project }, messages: [] };
  if (options.mode) convo.locodeToolMode = options.mode;
  globalThis.window = { __TAURI__: { core: { Channel: class {}, invoke: async (cmd, args = {}) => {
    calls.push({ cmd, args });
    if (cmd === "locode_reopen") return { path: project, name: project, session_id: project };
    if (cmd === "locode_git_status") return { is_git: false };
    if (cmd === "ollama_request") {
      const body = JSON.parse(args.body); requests.push(body);
      const response = typeof responses === "function" ? await responses(round++, body) : responses[round++];
      assert.ok(response, "Unexpected model retry at round " + round);
      return { status: 200, body: JSON.stringify({ message: response.message || response, prompt_eval_count: 10,
        eval_count: options.tokens || 10, done: true }) };
    }
    if (cmd === "locode_list_dir") return [...files.keys()].map(name => ({ name, kind: "file", size: files.get(name).length }));
    if (cmd === "locode_read_file") {
      if (options.stopDuringRead) locodeStop();
      if (!files.has(args.rel)) throw new Error("not found");
      return { content: files.get(args.rel), revision: "rev:" + files.get(args.rel) };
    }
    if (cmd === "locode_command_policy") return { level: "safe", reason: "fixture" };
    if (["locode_write_file", "locode_edit_file", "locode_run", "locode_move", "locode_delete"].includes(cmd)) {
      nativeApprovals++;
      if (options.nativeReject) throw new Error("사용자가 작업을 거부했습니다");
    }
    if (cmd === "locode_write_file" || cmd === "locode_edit_file") {
      const before = files.get(args.rel) ?? null;
      let after = args.content;
      if (cmd === "locode_edit_file") {
        after = before;
        for (const edit of args.edits) {
          assert.ok(after.includes(edit.old)); after = after.replace(edit.old, edit.new);
        }
      }
      files.set(args.rel, after);
      return { created: before === null, revision: "rev:" + after, change_id: "change", preview_before: before, preview_after: after };
    }
    if (cmd === "locode_run") {
      if (options.runFail) return { exit_code: 1 };
      args.onLine.onmessage("LOCODE TEST SUCCESS"); return { exit_code: 0 };
    }
    if (cmd === "locode_move") { files.set(args.to, files.get(args.from)); files.delete(args.from); return { change_id: "move" }; }
    if (cmd === "locode_delete") { files.delete(args.rel); return { change_id: "delete" }; }
    if (cmd === "locode_search") return [];
    return null;
  } } } };
  let approvalQueued = false;
  locodeInit({ modelCaps: new Map([[convo.model, options.noTools ? ["completion"] : ["completion", "tools"]]]),
    getSettings: () => ({ ollamaUrl: "http://localhost:11434", contextLimit: 16384 }), modelCtxLen: () => options.context || 16384,
    uid: () => "id-" + (++serial), save: () => {}, toast: () => {}, rerender: () => {
      if (hasPendingApproval() && !approvalQueued) {
        approvalQueued = true; approvals++;
        queueMicrotask(() => {
          approvalQueued = false;
          if (options.stopAtApproval) locodeStop();
          else resolveApproval(options.reject ? "reject" : "approve");
        });
      }
    } });
  await locodeSend(convo, options.prompt || "Java 프로젝트를 확인하고 LocodeHello.java를 생성하고 검증해줘");
  assert.equal(locodeRunning(), false);
  return { convo, calls, requests, files, approvals, nativeApprovals };
}

const java = 'public class LocodeHello { public static void main(String[] args) { System.out.println("LOCODE TEST SUCCESS"); } }';
const write = () => text("write_file", { path: "LocodeHello.java", content: java, summary: "테스트 Java 생성" });
const compile = () => text("run_command", { program: "javac", args: ["LocodeHello.java"], why: "컴파일 검증" });

{
  const r = await fixture([
    { content: userFixture },
    text("read_file", { path: "README.md" }),
    text("propose_plan", { steps: [{ title: "Java 생성" }, { title: "컴파일" }, { title: "실행" }] }),
    write(), compile(), text("run_command", { program: "java", args: ["LocodeHello"], why: "실행 검증" }), finish(),
  ]);
  assert.equal(r.files.get("LocodeHello.java"), java);
  assert.equal(r.approvals, 3); assert.equal(r.nativeApprovals, 3);
  assert.equal(r.convo.locodeEffectiveMode, "structured");
  assert.ok(r.requests[0].tools); assert.ok(r.requests[1].tools);
  assert.ok(r.requests[2].format); assert.equal(r.requests[2].tools, undefined);
  assert.ok(JSON.stringify(r.requests[4].messages).includes('applied'));
  assert.ok(r.requests.every(b => b.messages[0].role === "system"));
  assert.ok(r.requests.slice(2).every(b => !b.messages.some(m => m.role === "tool" || m.tool_calls)));
  assert.equal(r.convo.commandRuns[0].status, "success");
  assert.match(r.convo.messages.at(-1).content, /javac.*success/);
  assert.equal(resumeState(r.convo).changedPaths[0], "LocodeHello.java");
  assert.equal(resumeState(r.convo).verification.length, 2);
}
{
  const w = write();
  const r = await fixture([{ content: JSON.stringify([JSON.parse(w.content), { action: "write_file", ...JSON.parse(w.content).arguments }]) }, w, finish()]);
  assert.equal(r.calls.filter(c => c.cmd === "locode_write_file").length, 1);
  assert.equal(r.approvals, 1);
}
for (const options of [{ reject: true }, { nativeReject: true }, { stopAtApproval: true }, { stopDuringRead: true }]) {
  const r = await fixture([write(), finish()], options);
  assert.equal(r.files.has("LocodeHello.java"), false);
  assert.equal(r.nativeApprovals, options.nativeReject ? 1 : 0);
  if (options.stopAtApproval) assert.ok(r.calls.some(c => c.cmd === "locode_cancel_session"));
  if (options.stopDuringRead) assert.equal(r.approvals, 0);
}
{
  const r = await fixture([text("read_file", { path: "README.md" }),
    text("edit_file", { path: "README.md", edits: [{ old: "Java", new: "Java 21" }], summary: "부분 수정" }), finish()]);
  assert.equal(r.files.get("README.md"), "Java 21 project"); assert.equal(r.approvals, 1);
}
{
  const r = await fixture([compile(), finish()], { nativeReject: true });
  assert.equal(r.approvals, 1); assert.equal(r.nativeApprovals, 1);
  assert.equal(r.convo.commandRuns[0].status, "failed");
}
{
  const r = await fixture([compile(), compile(), compile(), finish()], { runFail: true });
  assert.equal(r.calls.filter(c => c.cmd === "locode_run").length, 1);
  assert.equal(r.requests.length, 3); assert.match(r.convo.messages.at(-1).content, /중단/);
}
{
  const r = await fixture([native("list_dir", { path: "" }), native("finish", { summary: "Native 완료" })]);
  assert.ok(r.requests.every(b => b.tools));
  assert.ok(r.requests[1].messages.some(m => m.role === "tool"));
}
{
  const r = await fixture([{ ...native("write_file", JSON.parse(write().content).arguments), content: write().content }, write(), finish()]);
  assert.equal(r.calls.filter(c => c.cmd === "locode_write_file").length, 1);
}
{
  const r = await fixture([text("search", { query: "Java", kind: "text" }),
    text("move_path", { from: "README.md", to: "MOVED.md", summary: "이동" }),
    text("delete_path", { path: "MOVED.md", summary: "삭제" }), finish()]);
  assert.equal(r.approvals, 2); assert.equal(r.nativeApprovals, 2);
  assert.equal(r.files.has("README.md"), false); assert.equal(r.files.has("MOVED.md"), false);
}
{
  const r = await fixture([write(), compile(), finish()], { noTools: true, mode: "structured" });
  assert.equal(r.approvals, 0); assert.equal(r.nativeApprovals, 0);
  assert.equal(r.files.has("LocodeHello.java"), false);
}
{
  const r = await fixture([text("list_dir", { path: "" }), finish()], { noTools: true, mode: "native" });
  assert.ok(r.requests.every(b => b.format && !b.tools));
  assert.ok(r.calls.some(c => c.cmd === "locode_list_dir"));
}
{
  const r = await fixture([write(), finish()], { mode: "structured" });
  assert.ok(r.requests[0].format); assert.equal(r.nativeApprovals, 1);
}
{
  const r = await fixture([write(), write(), write()], { mode: "native" });
  assert.equal(r.nativeApprovals, 0); assert.match(r.convo.messages.at(-1).content, /공식 tool_calls/);
}
for (const content of ['{"name":', '설명만 합니다', '{"name":"unknown","arguments":{}}', '{"name":"read_file","arguments":{"path":4}}']) {
  const r = await fixture([{ content }, { content }, { content }]);
  assert.equal(r.requests.length, 3); assert.equal(r.nativeApprovals, 0);
  assert.ok(!r.convo.messages.at(-1).content.includes(content));
}
{
  const r = await fixture([{ content: '{"name":' }, text("list_dir", { path: "" }), finish()]);
  assert.equal(r.requests.length, 3);
  assert.equal(r.calls.filter(c => c.cmd === "locode_list_dir").length, 1);
}
{
  const r = await fixture([text("list_dir", { path: "" }), finish()], { tokens: 33000 });
  assert.equal(r.requests.length, 1); assert.match(r.convo.messages.at(-1).content, /예산/);
}
{
  const realNow = Date.now;
  try {
    const r = await fixture(() => {
      Date.now = () => realNow() + 180001;
      return text("list_dir", { path: "" });
    });
    assert.equal(r.requests.length, 1); assert.match(r.convo.messages.at(-1).content, /예산/);
  } finally { Date.now = realNow; }
}
{
  const r = await fixture(() => { locodeStop(); return write(); });
  assert.equal(r.nativeApprovals, 0); assert.equal(r.approvals, 0);
  assert.match(r.convo.messages.at(-1).content, /중단/);
}
{
  const r = await fixture([finish()], { prompt: "context ".repeat(10000), context: 4096 });
  assert.equal(r.requests.length, 0); assert.match(r.convo.messages.at(-1).content, /컨텍스트 한도/);
}
{
  const r = await fixture(i => text("read_file", { path: i + ".txt" }), { files: new Map(Array.from({ length: 30 }, (_, i) => [i + ".txt", "x"])) });
  assert.equal(r.calls.filter(c => c.cmd === "locode_read_file").length, 24);
  assert.match(r.convo.messages.at(-1).content, /중단/);
}
{
  const first = await fixture([write(), finish()]);
  const snapshot = JSON.parse(JSON.stringify(first.convo)); // Persistence round trip.
  const r = await fixture([write(), text("read_file", { path: "LocodeHello.java" }), write(), finish()],
    { convo: snapshot, project: snapshot.project.path, files: first.files, prompt: "이어서 진행해줘" });
  assert.equal(r.nativeApprovals, 0); assert.equal(r.approvals, 0);
  assert.ok(JSON.stringify(r.requests[0].messages).includes("lastSuccess"));
  assert.equal(r.convo.locodeExecution.at(-3).category, "resume");
  assert.ok(r.calls.some(c => c.cmd === "locode_read_file"));
}
// The production RPCs still require native grants before mutation/spawn.
const rust = readFileSync(new URL("../src-tauri/src/locode.rs", import.meta.url), "utf8");
assert.ok(rust.includes("grant.validate(&project_id, &binding)?"));
assert.ok(rust.includes("grant.validate(&project_id, &representation)?"));
console.log("locode: strict parsing, native/JSON/auto, approval/rejection, Java tool chain, replay, stop/resume and budgets");
