import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "./tests", testMatch: "**/*.spec.mjs", workers: 1,
  use: { baseURL: "http://127.0.0.1:8134", ...(process.platform === "win32" ? { channel: "chrome" } : {}), viewport: { width: 1040, height: 740 } },
  webServer: { command: "node scripts/dev-server.mjs 8134", url: "http://127.0.0.1:8134", reuseExistingServer: false },
});
