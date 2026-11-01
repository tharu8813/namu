import { test, expect } from "@playwright/test";

for (const reject of [false, true]) test("LOCODE text JSON preview and " + (reject ? "rejection" : "approval + command"), async ({ page }) => {
  const errors = []; page.on("pageerror", e => errors.push(e.message));
  await page.addInitScript(() => {
    let round = 0, content = null;
    window.locodeCalls = [];
    const reply = (name, args) => ({ status: 200, body: JSON.stringify({ message: { content: JSON.stringify({ name, arguments: args }) }, done: true }) });
    window.__TAURI__ = { core: { Channel: class {}, invoke: async (cmd, args = {}) => {
      window.locodeCalls.push(cmd);
      if (cmd === "web_settings") return { config: { mode: "off" } };
      if (cmd === "ollama_request") {
        if (args.path === "/api/tags") return { status: 200, body: JSON.stringify({ models: [{ name: "qwen2.5-coder:7b", size: 4000000000 }] }) };
        if (args.path === "/api/show") return { status: 200, body: JSON.stringify({ capabilities: ["completion", "tools"], details: { parameter_size: "7B" } }) };
        if (args.path === "/api/chat") {
          switch (round++) {
            case 0: return reply("list_dir", { path: "" });
            case 1: return reply("propose_plan", { steps: [{ title: "Java 생성" }, { title: "컴파일 검증" }] });
            case 2: return reply("write_file", { path: "LocodeHello.java", content: 'class LocodeHello {}', summary: "Java 파일 생성" });
            case 3: return content === null ? reply("finish", { summary: "파일 변경이 거부되었습니다" }) : reply("run_command", { program: "javac", args: ["LocodeHello.java"], why: "컴파일 검증" });
            default: return reply("finish", { summary: "도구 실행 결과를 확인했습니다" });
          }
        }
      }
      if (cmd === "locode_open_project" || cmd === "locode_reopen") return { path: "C:/fixture-java", name: "fixture-java", session_id: "fixture" };
      if (cmd === "locode_git_status") return { is_git: false };
      if (cmd === "locode_list_dir") return content === null ? [] : [{ name: "LocodeHello.java", kind: "file" }];
      if (cmd === "locode_read_file") { if (content === null) throw "not found"; return { content, revision: "rev" }; }
      if (cmd === "locode_write_file") { content = args.content; return { created: true, revision: "rev", change_id: "change", preview_before: null, preview_after: content }; }
      if (cmd === "locode_command_policy") return { level: "safe", reason: "모의 정책" };
      if (cmd === "locode_run") { args.onLine.onmessage("fixture compiled"); return { exit_code: 0 }; }
      return null;
    } } };
  });
  await page.goto("/");
  await page.locator('[data-mode="locode"]').click();
  await page.locator("#lcPick").click();
  await expect(page.getByLabel("도구 호출 모드")).toHaveValue("auto");
  await page.locator("#input").fill("Java 파일 생성 후 컴파일해줘");
  await page.locator("#send").click();
  await expect(page.locator(".lc-approve")).toContainText("Java 파일 생성");
  await expect(page.locator(".lc-ap-diff")).toContainText("class LocodeHello");
  await expect(page.getByLabel("도구 호출 모드")).toBeDisabled();
  expect(await page.evaluate(() => window.locodeCalls.includes("locode_write_file"))).toBe(false);
  await page.locator(reject ? "#apNo" : "#apOk").click();
  if (reject) {
    await expect(page.locator(".lc-msgs .md")).toContainText("파일 변경이 거부");
    expect(await page.evaluate(() => window.locodeCalls.includes("locode_write_file"))).toBe(false);
  } else {
    await expect(page.locator(".lc-approve")).toContainText("javac");
    expect(await page.evaluate(() => window.locodeCalls.includes("locode_run"))).toBe(false);
    await page.locator("#apOk").click();
    await expect(page.locator(".lc-msgs .md")).toContainText("도구 실행 결과를 확인");
    expect(await page.evaluate(() => window.locodeCalls.filter(c => c === "locode_write_file").length)).toBe(1);
    expect(await page.evaluate(() => window.locodeCalls.filter(c => c === "locode_run").length)).toBe(1);
  }
  await expect(page.getByLabel("도구 호출 모드")).toBeEnabled();
  await page.waitForTimeout(200); await page.reload();
  await expect(page.locator(".lc-msgs .md")).toContainText(reject ? "파일 변경이 거부" : "도구 실행 결과를 확인");
  expect(errors).toEqual([]);
});
