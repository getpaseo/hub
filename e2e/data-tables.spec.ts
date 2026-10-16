import { expect, type Locator, type Page } from "@playwright/test";
import { test } from "./app.js";
import { projectApp } from "./helpers/projects/index.js";
import { OrganizationTriggers } from "./helpers/triggers.js";

const WORKSPACES = "/srv/workspaces/acme/projects";

const owner = {
  name: "Table Owner",
  email: "table-owner@example.com",
  password: "table-owner-password",
};

interface SeededTrigger {
  name: string;
  on: string;
  /** The event kind the row leads with. */
  kind: string;
  cwd: string;
  /** What narrows a schedule: any length, so it may be cut. */
  recurrence?: true;
  lastRun?: { minutesAgo: number; status: "running" | "succeeded" | "failed" };
}

const TRIGGERS: readonly SeededTrigger[] = [
  {
    name: "issue-comment-triage",
    on: "github.issue_comment_created:\n    connection: acme-inc\n    filters:\n      from_users: [maintainer]",
    kind: "GitHub issue comment created",
    cwd: `${WORKSPACES}/widgets`,
    lastRun: { minutesAgo: 8, status: "running" },
  },
  {
    name: "pull-request-review-followup",
    on: "github.pull_request_comment_created:\n    connection: acme-inc\n    filters:\n      from_users: [maintainer]",
    kind: "GitHub pull request comment created",
    cwd: `${WORKSPACES}/widgets-review`,
    lastRun: { minutesAgo: 23, status: "succeeded" },
  },
  {
    name: "discord-support-mention",
    on: "discord.mention:\n    connection: community-discord\n    filters:\n      from_users: [maintainer]",
    kind: "Discord mention",
    cwd: `${WORKSPACES}/community-bot`,
  },
  {
    name: "slack-help",
    on: "slack.mention:\n    connection: company-slack\n    filters:\n      from_users: [maintainer]",
    kind: "Slack mention",
    cwd: `${WORKSPACES}/platform/infrastructure-runbooks`,
    lastRun: { minutesAgo: 53, status: "failed" },
  },
  {
    name: "nightly-dependency-audit",
    on: 'schedule.tick:\n    recurrence:\n      start: "2026-01-01T08:15:00"\n      rule: FREQ=DAILY;BYHOUR=8,16;BYMINUTE=15\n      timezone: Europe/Berlin',
    kind: "Schedule",
    recurrence: true,
    cwd: `${WORKSPACES}/widgets`,
    lastRun: { minutesAgo: 125, status: "succeeded" },
  },
  {
    name: "manual-incident-review",
    on: "manual.run: {}",
    kind: "Manual run",
    cwd: `${WORKSPACES}/platform/incident-postmortems`,
    lastRun: { minutesAgo: 60 * 26, status: "succeeded" },
  },
  {
    // Two events is a document the form cannot represent, so the row has no form target.
    name: "schedule-healthcheck-20260910",
    on: 'schedule.tick:\n    recurrence:\n      start: "2026-01-01T06:00:00"\n      rule: FREQ=DAILY\n      timezone: UTC\n  manual.run: {}',
    kind: "Schedule",
    cwd: `${WORKSPACES}/widgets`,
    lastRun: { minutesAgo: 11, status: "running" },
  },
];

test("the trigger list cuts paths and details before names, event kinds, and times", async ({
  hub,
  page,
}) => {
  test.setTimeout(120_000);
  await hub.signUpAs("owner", owner);
  await hub.createOrganization("owner", "Acme");
  const daemon = await hub.connectProviderDaemon("owner", "Acme");
  await hub.seedSlackConnection("owner", "company-slack", "Acme Slack");
  await hub.seedGitHubConnection("Acme", "acme-inc");
  await hub.seedDiscordConnection("Acme", "community-discord");
  const triggers = new OrganizationTriggers(page);
  const table = page.getByRole("table", { name: "Triggers" });

  await test.step("seed triggers of every kind", async () => {
    await triggers.open();
    for (const trigger of TRIGGERS) {
      await triggers.startNew();
      // The YAML editor opens from a valid form; the document then replaces it wholesale.
      await triggers.configureManual({
        name: trigger.name,
        daemon,
        cwd: trigger.cwd,
        agent: "opencode/gateway/vendor/model-v1",
        mode: "full-access",
        thinking: "low",
        prompt: "Handle the event.",
      });
      await triggers.switchToYaml();
      await triggers.replaceYaml(triggerYaml(trigger, daemon));
      await triggers.save(trigger.name);
    }
    for (const trigger of TRIGGERS) {
      if (trigger.lastRun !== undefined) await hub.seedTriggerRun(trigger.name, trigger.lastRun);
    }
  });

  // The first column used to keep every spare pixel, so the rest were cut to their headers:
  // "Git…", "8 minutes …", a path missing its tail.
  await test.step("at 1100px names and event kinds are whole", async () => {
    await showAt(page, 1100, table);
    for (const trigger of TRIGGERS) {
      const cells = rowCells(table, trigger.name);
      await expectWhole(cells.nth(0), trigger.name);
      await expectWhole(cells.nth(1), trigger.kind);
    }
  });

  await test.step("at 1280px times and connections are whole too, and a path keeps its tail", async () => {
    await showAt(page, 1280, table);
    for (const trigger of TRIGGERS) {
      const cells = rowCells(table, trigger.name);
      await expectWhole(cells.nth(0), trigger.name);
      if (trigger.recurrence === true) await expectWhole(cells.nth(1), trigger.kind);
      else await expectWhole(cells.nth(1));
      await expectWhole(cells.nth(3));
    }
    const path = rowCells(table, "slack-help")
      .nth(2)
      .getByTitle(`${WORKSPACES}/platform/infrastructure-runbooks`);
    expect(await endsInView(path)).toBe(true);
  });
});

test("a connected-only daemon's grant command gives way before the daemons table scrolls", async ({
  hub,
  page,
}) => {
  await hub.signUpAs("owner", owner);
  await hub.createOrganization("owner", "Acme");
  await hub.seedConnectedOnlyDaemon("owner", "build-runner-eu-west-primary");
  await page.setViewportSize({ width: 1100, height: 900 });
  await projectApp(page).navigation.openOrganizationSection("Daemons");

  const table = page.getByRole("table", { name: "Daemons" });
  await expect(table.getByTitle("paseo hub permissions grant hub.execute")).toBeAttached();
  await expect(
    table.getByRole("button", { name: "Actions for build-runner-eu-west-primary" }),
  ).toBeInViewport({ ratio: 1 });
  expect(await scrollsSideways(table)).toBe(false);
});

async function showAt(page: Page, width: number, table: Locator) {
  await page.setViewportSize({ width, height: 900 });
  await page.reload();
  await expect(table.getByRole("row")).toHaveCount(TRIGGERS.length + 1);
  expect(await scrollsSideways(table)).toBe(false);
}

function rowCells(table: Locator, name: string): Locator {
  return table.getByRole("row").filter({ hasText: name }).getByRole("cell");
}

/** The cell, and every truncating line in it or only the one reading `text`, shows all its text. */
async function expectWhole(cell: Locator, text?: string) {
  await expect(cell).toBeVisible();
  const lines = cell.locator(".truncate").filter(text === undefined ? {} : { hasText: text });
  if (text !== undefined) await expect(lines).not.toHaveCount(0);
  const cut = await lines.evaluateAll((elements) =>
    elements
      .filter((element) => element.scrollWidth > element.clientWidth)
      .map((element) => element.textContent),
  );
  expect(cut).toEqual([]);
  expect(await cell.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
}

async function scrollsSideways(table: Locator): Promise<boolean> {
  return table.evaluate((element) => {
    const container = element.parentElement;
    return container !== null && container.scrollWidth > container.clientWidth;
  });
}

/** Whether the last character of the line is inside the line's box. */
async function endsInView(line: Locator): Promise<boolean> {
  return line.evaluate((element) => {
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    let last: Text | null = null;
    while (walker.nextNode()) last = walker.currentNode as Text;
    if (last === null || last.length === 0) return false;
    const range = document.createRange();
    range.setStart(last, last.length - 1);
    range.setEnd(last, last.length);
    const box = element.getBoundingClientRect();
    const character = range.getBoundingClientRect();
    return character.left >= box.left && character.right <= box.right + 0.5;
  });
}

function triggerYaml(trigger: SeededTrigger, daemon: string) {
  return `name: ${trigger.name}
enabled: true
on:
  ${trigger.on}
run:
  target:
    daemon: ${daemon}
    cwd: ${trigger.cwd}
  agent:
    provider: opencode
    model: gateway/vendor/model-v1
    mode: full-access
  prompt: Handle the event.
`;
}
