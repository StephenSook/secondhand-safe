import { defineConfig, devices } from "@playwright/test";

/** E2E against BASE_URL (a deployment) or a local server started here. */
const base = process.env.BASE_URL ?? "http://localhost:3107";

export default defineConfig({
  testDir: "tests/e2e",
  timeout: 240_000,
  retries: process.env.CI ? 1 : 0,
  use: { baseURL: base, trace: "retain-on-failure" },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: process.env.BASE_URL
    ? undefined
    : { command: "npm run start -- --port 3107", url: `${base}/api/health`, reuseExistingServer: true, timeout: 120_000 },
});
