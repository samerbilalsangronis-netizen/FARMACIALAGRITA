import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/e2e",
  use: {
    ...devices["Desktop Chrome"],
    baseURL: "http://127.0.0.1:3417",
    launchOptions: process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {},
    reducedMotion: "reduce",
  },
  webServer: {
    command: "npm run build && npm run start -- --hostname 127.0.0.1 --port 3417",
    env: {
      NEXT_PUBLIC_SUPABASE_URL: "https://supabase-fixture.example.com",
      NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "sb_publishable_browser_fixture",
      SUPABASE_LOGIN_DOMAIN: "accounts.example.com",
    },
    url: "http://127.0.0.1:3417",
    timeout: 120_000,
    reuseExistingServer: false,
  },
});
