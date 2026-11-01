import {test,expect} from "@playwright/test";
async function desktopMock(page,{mode="off",failure=false,delay=false}={}) {
  await page.addInitScript(({mode,failure,delay})=>{
    window.testCalls=[];window.mockModelRound=0;
    let config={mode,provider:"brave",server:"",allow_private_searx:false};
    let canceled=false;
    class Channel{}
    window.__TAURI__={core:{Channel,invoke:async(cmd,args={})=>{
      window.testCalls.push({cmd,args:cmd==="web_save_settings"?{config:args.config}:args});
      if(cmd==="web_settings")return {config,has_key:true};
      if(cmd==="web_save_settings"){config=args.config;return {config,has_key:true}}
      if(cmd==="web_begin")return "research-fixture";
      if(cmd==="web_end")return null;
      if(cmd==="open_url")return null;
      if(cmd==="ollama_cancel"){canceled=true;return null}
      if(cmd==="web_search"){
        if(delay)await new Promise(resolve=>setTimeout(resolve,250));
        if(canceled)throw "취소됨";
        if(failure)throw "검색 인증 실패 (401)";
        return {provider:"brave",query:args.query,results:[{id:"S1",title:"공식 문서",url:"https://example.org/docs",snippet:"공식 문서 발췌",date:"2026-11-01"}]};
      }
      if(cmd==="ollama_request"){
        if(args.path==="/api/tags")return {status:200,body:JSON.stringify({models:[{name:"test:7b",size:4000000000}]})};
        if(args.path==="/api/show")return {status:200,body:JSON.stringify({capabilities:["completion","tools"],details:{parameter_size:"7B"},model_info:{"test.context_length":8192}})};
        if(args.path==="/api/chat"){
          const body=JSON.parse(args.body);
          const tool=body.messages.find(m=>m.role==="tool");
          if(!tool)return {status:200,body:JSON.stringify({message:{content:"",tool_calls:[{function:{name:"web_search",arguments:{query:"Ollama official docs"}}}]},done:true})};
          return {status:200,body:JSON.stringify({message:{content:failure?"검색에 실패해 확인할 수 없습니다.":"공식 문서에 따르면 기능을 지원합니다 [1]."},done:true})};
        }
      }
      if(cmd==="ollama_stream"){args.onLine.onmessage(JSON.stringify({message:{content:"로컬 스트리밍 응답"},done:false}));args.onLine.onmessage('{"done":true}');return null}
      return null;
    }}};
  },{mode,failure,delay});
}
test("default off preserves local streaming and accessible settings",async({page})=>{
  const errors=[];page.on("pageerror",e=>errors.push(e.message));
  await desktopMock(page);await page.goto("/");
  await page.locator("#input").fill("안녕하세요");await page.locator("#send").click();
  await expect(page.locator(".md")).toContainText("로컬 스트리밍 응답");
  expect(await page.evaluate(()=>window.testCalls.filter(c=>c.cmd==="web_search").length)).toBe(0);
  await page.locator("#openSettings").click();
  await expect(page.locator("#webMode")).toHaveValue("off");
  await expect(page.locator("#webKey")).toHaveValue("");
  await expect(page.locator("#webKey")).toHaveAttribute("type","password");
  await page.locator("#webMode").selectOption("ask");await page.locator("#saveWeb").click();
  await expect(page.locator("#webStatus")).toContainText("검색 설정을 저장했습니다");
  expect(errors).toEqual([]);
});
test("search tool result reaches answer with actual source and external browser click",async({page})=>{
  const errors=[];page.on("pageerror",e=>errors.push(e.message));
  await desktopMock(page,{mode:"ask"});await page.goto("/");
  await page.locator("#input").fill("최신 공식 문서를 확인해줘");await page.locator("#send").click();
  await expect(page.locator(".md")).toContainText("기능을 지원합니다");
  await expect(page.locator(".md a")).toHaveAttribute("href","https://example.org/docs");
  await page.locator(".web-sources summary").click();
  await expect(page.locator(".web-sources")).toContainText("Ollama official docs");
  await expect(page.locator(".web-sources")).toContainText("brave");
  await page.locator(".md a").click();
  expect(await page.evaluate(()=>window.testCalls.filter(c=>c.cmd==="open_url").map(c=>c.args.url))).toEqual(["https://example.org/docs"]);
  expect(errors).toEqual([]);
  await page.locator("#openSettings").click();
  await page.waitForTimeout(400);
  await page.screenshot({path:"test-results/settings-light.png",fullPage:true});
  await page.locator('#themeSeg [data-theme="dark"]').click();
  await page.waitForTimeout(100);await page.screenshot({path:"test-results/settings-dark.png",fullPage:true});
  await page.locator("#saveWeb").scrollIntoViewIfNeeded();
  await page.screenshot({path:"test-results/settings-search-dark.png",fullPage:true});
});
test("failed search has no invented sources",async({page})=>{
  await desktopMock(page,{mode:"ask",failure:true});await page.goto("/");
  await page.locator("#input").fill("공식 문서 확인");await page.locator("#send").click();
  await expect(page.locator(".web-sources summary")).toContainText("검색 실패");
  await expect(page.locator(".web-sources a")).toHaveCount(0);
  await expect(page.locator(".md")).toContainText("검색에 실패");
});
test("cancellation stops pending search and discards late answer",async({page})=>{
  await desktopMock(page,{mode:"ask",delay:true});await page.goto("/");
  await page.locator("#input").fill("공식 문서 확인");await page.locator("#send").click();
  await expect.poll(()=>page.evaluate(()=>window.testCalls.some(c=>c.cmd==="web_search"))).toBe(true);
  await page.locator('#send[aria-label="생성 중지"]').click();
  await expect(page.locator('#send')).toHaveAttribute("aria-label","보내기");
  await expect(page.locator(".md")).toHaveCount(0);
  expect(await page.evaluate(()=>window.testCalls.some(c=>c.cmd==="ollama_cancel"))).toBe(true);
});
test("chat delete undo restores persisted conversation after reload",async({page})=>{
  await desktopMock(page);await page.goto("/");
  await page.locator("#input").fill("저장 테스트");await page.locator("#send").click();
  await expect(page.locator(".md")).toContainText("로컬 스트리밍 응답");
  await page.waitForTimeout(200);
  await page.locator(".convo-more").click();await page.locator('[data-act="delete"]').click();
  await expect(page.locator(".convo")).toHaveCount(0);
  await page.waitForTimeout(200);
  await page.getByRole("button",{name:"실행 취소",exact:true}).click();
  await expect(page.locator(".md")).toContainText("로컬 스트리밍 응답");
  await page.waitForTimeout(200);await page.reload();
  await expect(page.locator(".md")).toContainText("로컬 스트리밍 응답");
});
