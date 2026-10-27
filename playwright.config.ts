import { defineConfig } from "@playwright/test";
const origin = `http://127.0.0.1:${process.env.VFLOW_TEST_PORT ?? 4179}`;
export default defineConfig({
  testDir: "tests/browser",
  fullyParallel: false,
  workers: 1,
  use: {
    baseURL: origin,
    viewport: { width: 1440, height: 900 },
    trace: "retain-on-failure",
  },
  webServer: {
    command: "node scripts/ui-test-server.ts",
    url: origin,
    reuseExistingServer: !process.env.CI,
    timeout: 30000,
  },
  reporter: [["list"]],
});
