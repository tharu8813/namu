import assert from "node:assert/strict";
import { parseNDJSON, pullPercent, shouldCompress, humanBytes, humanTime, pullRate, ollamaError, renderMarkdown, renderTeX, highlightCode, checkAttachments, ATT_LIMITS, modelRefKey, isInstalledModel } from "./src/lib.js";
import { locodeTier, salvageToolCalls, normalizePlan, commandPurpose, parseLocodeAction } from "./src/locode.js";
import { lineDiff, diffStat } from "./src/lib.js";

// parseNDJSON: 잘린 마지막 줄 보존
{
  const { objects, rest } = parseNDJSON('{"a":1}\n{"b":2}\n{"c":');
  assert.deepEqual(objects, [{ a: 1 }, { b: 2 }]);
  assert.equal(rest, '{"c":');
}
// parseNDJSON: 빈 줄 / 깨진 줄 무시
{
  const { objects } = parseNDJSON('\n{"ok":1}\nnot json\n');
  assert.deepEqual(objects, [{ ok: 1 }]);
}
// pullPercent
assert.equal(pullPercent({ total: 200, completed: 50 }), 25);
assert.equal(pullPercent({ status: "x" }), null);
assert.equal(pullPercent({ total: 0, completed: 0 }), null);
assert.equal(pullPercent({ total: 10, completed: 999 }), 100);

// shouldCompress
assert.equal(shouldCompress([], { enabled: true, threshold: 10 }), false);
assert.equal(shouldCompress(Array(11).fill({ role: "user" }), { enabled: true, threshold: 10 }), true);
assert.equal(shouldCompress(Array(11).fill({ role: "user" }), { enabled: false, threshold: 10 }), false);
assert.equal(shouldCompress(Array(11).fill({ role: "system" }), { enabled: true, threshold: 10 }), false);

// humanBytes
assert.equal(humanBytes(0), "0 B");
assert.equal(humanBytes(512), "512 B");
assert.equal(humanBytes(1536), "1.5 KB");
assert.equal(humanBytes(5 * 1024 * 1024 * 1024), "5.0 GB");
assert.equal(humanBytes(120 * 1024 * 1024), "120 MB");

// humanTime
assert.equal(humanTime(45), "45초");
assert.equal(humanTime(80), "1분 20초");
assert.equal(humanTime(120), "2분");
assert.equal(humanTime(3900), "1시간 5분");
assert.equal(humanTime(Infinity), "—");
assert.equal(humanTime(-1), "—");

// pullRate
{
  const r = pullRate({ completed: 0, total: 1000, t: 0 }, { completed: 100, total: 1000, t: 1000 });
  assert.equal(r.bytesPerSec, 100);
  assert.equal(r.etaSec, 9); // (1000-100)/100
}
assert.deepEqual(pullRate(null, { completed: 1, total: 2, t: 1 }), { bytesPerSec: null, etaSec: null });
assert.deepEqual(pullRate({ completed: 5, total: 9, t: 5 }, { completed: 5, total: 9, t: 5 }), { bytesPerSec: null, etaSec: null });

// ollamaError — Ollama 의 이중 중첩 JSON 오류
assert.equal(
  ollamaError('{"error":"{\\"error\\":{\\"code\\":400,\\"message\\":\\"Multimodal data provided, but model does not support multimodal requests.\\",\\"type\\":\\"invalid_request_error\\"}}"}', "fb"),
  "Multimodal data provided, but model does not support multimodal requests."
);
assert.equal(ollamaError('{"error":"model \'foo\' not found"}', "fb"), "model 'foo' not found");
assert.equal(ollamaError("not json at all", "fb"), "fb");
assert.equal(ollamaError("", "요청 실패 500"), "요청 실패 500");

// 삭제된 모델 대화 판별: :latest 표기는 설치 목록과 같은 모델로 본다.
assert.equal(modelRefKey(" Qwen2.5:latest "), "qwen2.5");
assert.equal(isInstalledModel("qwen2.5", [{ name: "qwen2.5:latest" }]), true);
assert.equal(isInstalledModel("qwen2.5:7b", [{ name: "qwen2.5:latest" }]), false);
assert.equal(isInstalledModel("", [{ name: "qwen2.5:latest" }]), false);

// renderMarkdown
assert.equal(renderMarkdown("**굵게** 그리고 `코드`"), "<p><strong>굵게</strong> 그리고 <code>코드</code></p>");
assert.equal(renderMarkdown("# 제목"), "<h3>제목</h3>");
assert.equal(renderMarkdown("- a\n- b"), "<ul><li>a</li><li>b</li></ul>");
assert.equal(renderMarkdown("1. a\n2. b"), "<ol><li>a</li><li>b</li></ol>");
{
  const code = renderMarkdown("```js\nconst x=1;\n```");
  assert.ok(code.startsWith('<pre data-code-lang="js"><code class="language-js">'));
  assert.ok(code.includes('<span class="tok-keyword">const</span>'));
  assert.ok(code.includes('<span class="tok-variable">x</span>'));
}
assert.ok(renderMarkdown("[네이버](https://naver.com)").includes('<a href="https://naver.com" target="_blank"'));
// XSS: 원본 태그는 이스케이프돼야 함
assert.ok(!renderMarkdown("<script>alert(1)</script>").includes("<script>"));
assert.ok(renderMarkdown("<img src=x onerror=y>").includes("&lt;img"));
// 코드 블록 안의 <> 도 이스케이프
{
  const code = renderMarkdown("```\n<b>hi</b>\n```");
  assert.ok(!code.includes("<b>hi</b>"));
  assert.ok(code.includes("&lt;"));
}
// 코드 펜스 언어 정보는 안전한 속성으로 보존되어 UI 도구막대에 전달된다.
assert.ok(renderMarkdown("```PowerShell\nGet-ChildItem\n```").includes('data-code-lang="powershell"'));
// 문법 색상과 이스케이프는 함께 동작해야 한다.
assert.ok(highlightCode('def greet(name):\n  return "hi"', "python").includes('tok-keyword'));
assert.ok(highlightCode('const html = "<script>"', "js").includes('&lt;script&gt;'));
assert.ok(!highlightCode('const html = "<script>"', "js").includes("<script>"));
// 두 문단
assert.equal(renderMarkdown("첫째\n\n둘째"), "<p>첫째</p><p>둘째</p>");

// --- LaTeX (초간단 치환) ---
assert.equal(renderTeX("x^2 + y_1", false), '<span class="tex">x<sup>2</sup> + y<sub>1</sub></span>');
assert.ok(renderTeX("\\frac{1}{2}", true).includes('class="tex-frac"'));
assert.ok(renderTeX("\\alpha \\times \\beta \\leq \\pi", false).includes("α × β ≤ π"));
assert.ok(renderTeX("\\left( a \\right)", false).includes("( a )"));
// 인라인/디스플레이 수식이 마크다운 파서를 안 거치고 렌더된다
assert.ok(renderMarkdown("속도는 \\(v = a t\\) 이다").includes('<span class="tex">'));
assert.ok(renderMarkdown("\\[ E = m c^2 \\]").includes('tex-block'));
assert.ok(renderMarkdown("$$ \\sum_{n=1}^{\\infty} $$").includes("∑"));
// 수식 안의 _ * 가 이탤릭으로 깨지지 않는다
assert.ok(!renderMarkdown("\\( a_1 * b_2 \\)").includes("<em>"));
// 수식은 HTML 이스케이프된다
assert.ok(!renderTeX("a < b > c", false).includes("<b>"));

// --- 세부 문법 ---
// 표
{
  const t = renderMarkdown("| 이름 | 값 |\n|---|---:|\n| a | 1 |\n| b | 2 |");
  assert.ok(t.startsWith("<table>"), t);
  assert.ok(t.includes("<th>이름</th>"));
  assert.ok(t.includes('<td style="text-align:right">1</td>'));
  assert.ok(t.includes("<td>b</td>"));
}
// 중첩 리스트
{
  const t = renderMarkdown("- 상위\n  - 하위1\n  - 하위2\n- 상위2");
  assert.equal(t, "<ul><li>상위<ul><li>하위1</li><li>하위2</li></ul></li><li>상위2</li></ul>");
}
// 체크박스 목록
{
  const t = renderMarkdown("- [ ] 할 일\n- [x] 완료");
  assert.ok(t.includes('<input type="checkbox" disabled> 할 일'));
  assert.ok(t.includes('<input type="checkbox" disabled checked> 완료'));
}
// 블록쿼트 (esc 이후에도 인식돼야 함)
assert.equal(renderMarkdown("> 인용문\n> 둘째 줄"), "<blockquote><p>인용문<br>둘째 줄</p></blockquote>");
// __굵게__
assert.equal(renderMarkdown("__굵게__"), "<p><strong>굵게</strong></p>");
// 문단 바로 뒤 목록 (빈 줄 없이)
assert.equal(renderMarkdown("설명:\n- 항목"), "<p>설명:</p><ul><li>항목</li></ul>");
// 자동 링크
assert.ok(renderMarkdown("참고 https://ollama.com 사이트").includes('<a href="https://ollama.com"'));
// 이어지는 목록 줄
assert.ok(renderMarkdown("- 첫 줄이 길어서\n  다음 줄로 이어짐").includes("<li>첫 줄이 길어서 다음 줄로 이어짐</li>"));

// checkAttachments
{
  assert.equal(checkAttachments([]).ok, true);
  assert.equal(checkAttachments(null).ok, true);
  // 텍스트 글자수 초과
  const big = { kind: "text", text: "x".repeat(ATT_LIMITS.totalTextChars + 1) };
  const r1 = checkAttachments([big]);
  assert.equal(r1.ok, false);
  assert.ok(r1.errors[0].includes("자"));
  // 이미지 용량 초과 (b64 길이로 근사)
  const hugeB64 = "A".repeat(Math.ceil((ATT_LIMITS.totalBytes + 1) / 0.75));
  const r2 = checkAttachments([{ kind: "image", b64: hugeB64 }]);
  assert.equal(r2.ok, false);
  assert.ok(r2.errors[0].includes("용량"));
  // 정상 범위
  assert.equal(checkAttachments([{ kind: "text", text: "짧은 파일" }]).ok, true);
}

// locodeTier — LOCODE 모델 적합도 등급
{
  assert.equal(locodeTier("qwen2.5-coder:7b", ["completion", "tools"], "7B").tier, "code");
  assert.equal(locodeTier("codellama:13b", ["completion"], "13B").tier, "code"); // 이름으로 코더
  assert.equal(locodeTier("llama3.1:8b", ["completion", "tools"], "8B").tier, "code");
  assert.equal(locodeTier("llama3.2-vision:11b", ["tools", "completion", "vision"], "10.7B").tier, "tools"); // 비전 → code 제외
  assert.equal(locodeTier("llama3.2:3b", ["completion", "tools"], "3B").tier, "tools");
  assert.equal(locodeTier("exaone3.5:7.8b", ["completion"], "7.8B").tier, "structured");
  assert.equal(locodeTier("exaone3.5:7.8b", ["completion"], "7.8B").locode, true);
  assert.equal(locodeTier("tinyllama", ["completion"], "1.1B").tier, "chat");
  assert.equal(locodeTier("tinyllama", ["completion"], "1.1B").locode, false);
  assert.equal(locodeTier("nomic-embed-text", ["embedding"], "137M").tier, "chat");
  assert.equal(locodeTier("moondream", ["completion", "vision"], "1.8B").tier, "chat"); // 비전 전용 소형
}

// LOCODE 계획/검증 요약용 순수 함수
{
  const plan = normalizePlan([{ title: "구조 확인", detail: "관련 파일을 읽습니다" }, "테스트 실행", { title: "" }]);
  assert.equal(plan.length, 2);
  assert.equal(plan[0].status, "active");
  assert.equal(plan[1].status, "pending");
  assert.equal(commandPurpose("npm test"), "test");
  assert.equal(commandPurpose("cargo build --release"), "build");
  assert.equal(commandPurpose("cargo clippy"), "lint");
  assert.equal(commandPurpose("git status"), "other");
}

// lineDiff / diffStat
{
  assert.deepEqual(lineDiff("a\nb\nc", "a\nb\nc"), [
    { type: "ctx", text: "a" }, { type: "ctx", text: "b" }, { type: "ctx", text: "c" },
  ]);
  const d = lineDiff("a\nb\nc", "a\nB\nc");
  assert.deepEqual(diffStat(d), { add: 1, del: 1 });
  assert.ok(d.some((x) => x.type === "del" && x.text === "b"));
  assert.ok(d.some((x) => x.type === "add" && x.text === "B"));
  // 새 파일 (before=null → 0줄)
  assert.deepEqual(diffStat(lineDiff(null, "x\ny")), { add: 2, del: 0 });
  // 삭제 (after=null → 0줄)
  assert.deepEqual(diffStat(lineDiff("x\ny", null)), { add: 0, del: 2 });
  // 삽입만
  const ins = lineDiff("a\nc", "a\nb\nc");
  assert.deepEqual(diffStat(ins), { add: 1, del: 0 });
}

// salvageToolCalls — 모델이 tool_call 을 텍스트로 뱉는 경우
{
  const a = salvageToolCalls('{"name":"read_file","arguments":{"path":"hello.py"}}');
  assert.equal(a.length, 1);
  assert.equal(a[0].function.name, "read_file");
  assert.equal(a[0].function.arguments.path, "hello.py");
  // 코드펜스 + 평면 형태
  const b = salvageToolCalls('설명...\n```json\n{"action":"write_file","path":"a.js","content":"x"}\n```');
  assert.equal(b[0].function.name, "write_file");
  assert.equal(b[0].function.arguments.content, "x");
  // 배열
  const c = salvageToolCalls('[{"name":"finish","arguments":{"summary":"done"}}]');
  assert.equal(c[0].function.name, "finish");
  // Qwen 계열이 본문으로 내보내는 XML 감싼 도구 호출도 복구한다.
  const d = salvageToolCalls('<tool_call>{"name":"read_file","arguments":{"path":"src/main.js"}}</tool_call>');
  assert.equal(d[0].function.name, "read_file");
  // 그냥 텍스트 → 빈 배열
  assert.equal(salvageToolCalls("그냥 일반 답변입니다").length, 0);
}

// 구조화 출력 대체 경로는 JSON 펜스·설명 앞뒤를 허용한다.
assert.equal(parseLocodeAction('```json\n{"action":"search","query":"TODO","message":"검색"}\n```').action, "search");
assert.equal(parseLocodeAction('먼저 확인합니다. {"action":"list_dir","path":"","message":"목록"}').action, "list_dir");

console.log("ok");
