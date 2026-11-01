import assert from "node:assert/strict";
import {renderMarkdown,safeWebUrl,estimateRequestTokens} from "../src/lib.js";
import {validateLocodeArgs,locodeTier,serializeToolResult} from "../src/locode.js";
import {citedMarkdown,validateWebArgs} from "../src/research.js";

for (const payload of [
  '[x](https://example.org/"onmouseover="alert(1))',
  'https://example.org/"onclick="alert(1)',
  '[x](javascript:alert(1))','[x](data:text/html,evil)',
  '[x](https://user:password@example.org/path)',
  '<img src=x onerror=alert(1)>'
]) {
  const html=renderMarkdown(payload);
  assert.ok(!/<a[^>]+\s(?:on\w+|style)=/i.test(html),html);
  assert.ok(!/<(?:img|script|iframe)\b/i.test(html),html);
  assert.ok(!/href="(?:javascript|data):/i.test(html),html);
}
assert.equal((renderMarkdown("[a](https://example.org?a=1&b=2)").match(/<a /g)||[]).length,1);
assert.ok(renderMarkdown("[a](https://example.org?a=1&b=2)").includes('href="https://example.org?a=1&amp;b=2"'));
assert.equal((renderMarkdown("https://example.org/a_b?q=x_y").match(/<a /g)||[]).length,1);
assert.ok(!renderMarkdown("https://example.org/a_b?q=x_y").includes("<em>"));
assert.ok(!renderMarkdown("URL in \x60https://example.org\x60").includes("<a "));
assert.equal(safeWebUrl("javascript:alert(1)"),null);
assert.equal(safeWebUrl('https://a.org/"foo'),null);
assert.equal(safeWebUrl("https://a.org/path"),"https://a.org/path");
assert.ok(estimateRequestTokens([{content:"image",images:["a".repeat(1000000)]}])<1200);
assert.throws(()=>validateLocodeArgs("read_file",{path:{evil:1}}));
assert.throws(()=>validateLocodeArgs("edit_file",{path:"a",edits:[{old:"a",new:123}],summary:"x"}));
assert.throws(()=>validateLocodeArgs("run_command",{command:"echo x",program:"cmd",why:"x"}));
assert.throws(()=>validateLocodeArgs("run_command",{program:"cmd",args:[123],why:"x"}));
assert.throws(()=>validateLocodeArgs("unknown",{path:"a"}));
assert.throws(()=>validateLocodeArgs("write_file",{path:"a",content:"x",summary:"x",confirmed:true}));
assert.equal(validateLocodeArgs("run_command",{program:"node",args:["test.mjs"],why:"test"}).args[0],"test.mjs");
assert.equal(locodeTier("qwen2.5-coder",["completion"],"7B").tier,"structured");
const partial=serializeToolResult({content:'"\\\n'.repeat(10000)},4000);
assert.equal(JSON.parse(partial).truncated,true);assert.ok(partial.length<=4000);
assert.throws(()=>validateWebArgs("web_search",{query:"q",max_results:"five"}));
assert.throws(()=>validateWebArgs("web_search",{query:"q",freshness:"tomorrow"}));
assert.throws(()=>validateWebArgs("web_search",{query:"q",confirmed:true}));
assert.throws(()=>validateWebArgs("web_open",{url:"file:///secret"}));
const citations=citedMarkdown("문서 [1], 미확인 [99], 코드 \x60[1]\x60",{sources:[{number:1,url:"https://example.org/docs"}]});
assert.ok(citations.includes('href="https://example.org/docs"'));
assert.ok(citations.includes("미확인 [99]"));
assert.ok(citations.includes("<code>[1]</code>"));
const forged=citedMarkdown("[1](https://forged.example/) [문서](https://not-opened.example/)", {queries:[{query:"test"}], sources:[{number:1,url:"https://example.org/docs"}]});
assert.ok(!forged.includes("forged.example"));assert.ok(!forged.includes("not-opened.example"));assert.ok(forged.includes("https://example.org/docs"));
console.log("security: Markdown attributes, strict tool schemas, actual-source citations");
