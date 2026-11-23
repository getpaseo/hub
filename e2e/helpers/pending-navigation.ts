import { expect, type Page } from "@playwright/test";

/** Hold real responses; the built route code and application services remain unchanged. */
export async function holdPageScripts(page: Page) {
  const pausedAt = new Date();
  // Install before the pause target so browser RPC latency cannot put that target in the past.
  await page.clock.install({ time: new Date(pausedAt.getTime() - 60_000) });
  await page.clock.pauseAt(pausedAt);
  const requests = await holdRequests(page, /\/assets\/.*\.js(?:\?.*)?$/u);
  return {
    requested: requests.requested,
    showPendingPage: async () => {
      // Advance Router's pending threshold without a wall-clock race.
      await page.clock.runFor(1000);
      await expect(page.getByRole("region", { name: "Loading page", exact: true })).toBeVisible();
    },
    release: async () => {
      await page.clock.resume();
      await requests.release();
    },
  };
}

export function holdPageData(page: Page) {
  return holdRequests(page, /\/_serverFn\//u);
}

async function holdRequests(page: Page, pattern: RegExp) {
  let requestReceived = () => {};
  const requested = new Promise<void>((resolve) => {
    requestReceived = resolve;
  });
  let releaseRequests = () => {};
  const released = new Promise<void>((resolve) => {
    releaseRequests = resolve;
  });
  await page.route(pattern, async (route) => {
    requestReceived();
    await released;
    await route.continue();
  });
  return {
    requested,
    release: async () => {
      releaseRequests();
      await page.unrouteAll({ behavior: "wait" });
      // Observe the result after the held downloads arrive, including a superseded route's code.
      await page.waitForLoadState("networkidle");
    },
  };
}
