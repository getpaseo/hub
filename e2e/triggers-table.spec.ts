import { expect, type Locator } from "@playwright/test";
import { test } from "./app.js";
import type { BuiltApplication } from "./helpers/hub.js";
import { OrganizationTriggers } from "./helpers/triggers.js";

const SHOTS = "e2e/screenshots/triggers-table";
const WORKSPACES = "/srv/workspaces/acme/projects";

const owner = {
  name: "Table Owner",
  email: "table-owner@example.com",
  password: "table-owner-password",
};

interface SeededTrigger {
  name: string;
  on: string;
  cwd: string;
  /** A schedule's recurrence: any length, so it may be cut, with the whole of it in its title. */
  summary?: string;
  lastRun?: { minutesAgo: number; status: "running" | "succeeded" | "failed" };
}

const TRIGGERS: readonly SeededTrigger[] = [
  {
    name: "issue-comment-triage",
    on: "github.issue_comment_created:\n    connection: acme-inc\n    filters:\n      from_users: [maintainer]",
    cwd: `${WORKSPACES}/widgets`,
    lastRun: { minutesAgo: 8, status: "running" },
  },
  {
    name: "pull-request-review-followup",
    on: "github.pull_request_comment_created:\n    connection: acme-inc\n    filters:\n      from_users: [maintainer]",
    cwd: `${WORKSPACES}/widgets-review`,
    lastRun: { minutesAgo: 23, status: "succeeded" },
  },
  {
    name: "discord-support-mention",
    on: "discord.mention:\n    connection: community-discord\n    filters:\n      from_users: [maintainer]",
    cwd: `${WORKSPACES}/community-bot`,
  },
  {
    name: "slack-help",
    on: "slack.mention:\n    connection: company-slack\n    filters:\n      from_users: [maintainer]",
    cwd: `${WORKSPACES}/platform/infrastructure-runbooks`,
    lastRun: { minutesAgo: 53, status: "failed" },
  },
  {
    name: "nightly-dependency-audit",
    on: 'schedule.tick:\n    recurrence:\n      start: "2026-01-01T08:15:00"\n      rule: FREQ=DAILY;BYHOUR=8,16;BYMINUTE=15\n      timezone: Europe/Berlin',
    summary: "Every day at 08:15 and 16:15 (Europe/Berlin)",
    cwd: `${WORKSPACES}/widgets`,
    lastRun: { minutesAgo: 125, status: "succeeded" },
  },
  {
    name: "weekly-release-notes",
    on: 'schedule.tick:\n    recurrence:\n      start: "2026-01-02T09:00:00"\n      rule: FREQ=WEEKLY;BYDAY=FR;BYHOUR=9;BYMINUTE=0\n      timezone: UTC',
    cwd: `${WORKSPACES}/docs-site`,
  },
  {
    name: "manual-incident-review",
    on: "manual.run: {}",
    cwd: `${WORKSPACES}/platform/incident-postmortems`,
    lastRun: { minutesAgo: 60 * 26, status: "succeeded" },
  },
  {
    // Two events is a document the form cannot represent, so the row has no form target.
    name: "schedule-healthcheck-20260910",
    on: 'schedule.tick:\n    recurrence:\n      start: "2026-01-01T06:00:00"\n      rule: FREQ=DAILY\n      timezone: UTC\n  manual.run: {}',
    cwd: `${WORKSPACES}/widgets`,
    lastRun: { minutesAgo: 11, status: "running" },
  },
];

const WIDTHS = [
  { name: "wide", width: 1680 },
  { name: "laptop", width: 1280 },
  { name: "small-laptop", width: 1100 },
  { name: "tablet", width: 768 },
  { name: "phone", width: 390 },
] as const;

test.use({ deviceScaleFactor: 2 });

test("the trigger list shows each column's value whole at laptop width", async ({ hub, page }) => {
  test.setTimeout(120_000);
  await hub.signUpAs("owner", owner);
  await hub.createOrganization("owner", "Acme");
  const daemon = await hub.connectProviderDaemon("owner", "Acme");
  await hub.seedSlackConnection("owner", "company-slack", "Acme Slack");
  const application = hub.primaryApplication();
  await seedConnections(application, "Acme");
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
      if (trigger.lastRun !== undefined) await seedRun(application, trigger.name, trigger.lastRun);
    }
    await triggers.open();
  });

  for (const { name, width } of WIDTHS) {
    await test.step(`capture at ${String(width)}px`, async () => {
      await page.setViewportSize({ width, height: 900 });
      await page.reload();
      await expect(table.getByRole("row")).toHaveCount(TRIGGERS.length + 1);
      await table.screenshot({ path: `${SHOTS}/${name}.png` });
    });
  }

  await test.step("at 1280px no name, event kind, or time is cut, and a path keeps its tail", async () => {
    // Every column was shown at the width of its header: "Git…", "8 minutes …", while the
    // name column kept half the table for itself.
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.reload();
    await expect(table.getByRole("row")).toHaveCount(TRIGGERS.length + 1);
    for (const trigger of TRIGGERS) {
      const cells = table.getByRole("row").filter({ hasText: trigger.name }).getByRole("cell");
      await expectWhole(cells.nth(0), trigger.name);
      if (trigger.summary === undefined) {
        await expectWhole(cells.nth(1));
      } else {
        await expectWhole(cells.nth(1), "Schedule");
        await expect(cells.nth(1).getByTitle(trigger.summary)).toBeVisible();
      }
      await expectWhole(cells.nth(3));
    }
    const path = table
      .getByRole("row")
      .filter({ hasText: "slack-help" })
      .getByRole("cell")
      .nth(2)
      .getByTitle(`${WORKSPACES}/platform/infrastructure-runbooks`);
    expect(await endsInView(path)).toBe(true);
  });
});

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

async function seedConnections(application: BuiltApplication, organizationName: string) {
  await application.query(
    `insert into github_connections
       (organization_id, installation_id, slug, account_id, account_login, account_type, status)
     select id, 4242, 'acme-inc', '4242', 'acme-inc', 'Organization', 'active'
     from organization where name = $1`,
    [organizationName],
  );
  await application.query(
    `insert into discord_connections (organization_id, guild_id, slug, guild_name)
     select id, 'browser-guild', 'community-discord', 'Acme Community'
     from organization where name = $1`,
    [organizationName],
  );
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

async function seedRun(
  application: BuiltApplication,
  name: string,
  run: NonNullable<SeededTrigger["lastRun"]>,
) {
  const receivedAt = `now() - interval '${String(run.minutesAgo)} minutes'`;
  await application.query(
    `with trigger as (
       select t.organization_id, t.runtime_project_id as project_id,
              (select r.id from project_configuration_revisions r
               where r.project_id = t.runtime_project_id
               order by r.created_at desc limit 1) as revision_id
       from organization_triggers t where t.name = $1
     ), receipt as (
       insert into provider_event_receipts
         (organization_id, provider, delivery_id, source, payload, received_at)
       select organization_id, 'manual', gen_random_uuid()::text, 'manual.run', '{}'::jsonb,
              ${receivedAt}
       from trigger
       returning id, organization_id
     )
     insert into trigger_runs
       (organization_id, project_id, configuration_revision_id, provider_event_receipt_id,
        configured_trigger_name, status, prompt, deadline_at, created_at)
     select receipt.organization_id, trigger.project_id, trigger.revision_id, receipt.id, $1, $2,
            'Handle the event.', now() + interval '1 hour', ${receivedAt}
     from receipt, trigger`,
    [name, run.status],
  );
}
