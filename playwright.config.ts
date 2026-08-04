import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  projects: [
    {
      name: "desktop-chromium",
      testIgnore:
        /(dashboard-mobile|phase-two-mobile|phase-three-mobile|projects-mobile)\.spec\.ts/u,
      use: {
        ...devices["Desktop Chrome"],
        trace: "retain-on-failure",
      },
    },
    {
      name: "mobile-chromium",
      testMatch:
        /(authentication|dashboard-mobile|phase-two-mobile|phase-three-mobile|projects-mobile)\.spec\.ts/u,
      use: {
        ...devices["Pixel 7"],
        trace: "retain-on-failure",
      },
    },
  ],
});
