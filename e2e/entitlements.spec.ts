import { test } from "./app.js";

const owner = {
  name: "Amara",
  email: "amara-entitlements@example.com",
  password: "amara-entitlements-password",
};
const secondMember = "bela-entitlements@example.com";
const thirdMember = "cyrus-entitlements@example.com";

const SLICE_1_DIR = "e2e/screenshots/slice-1";
const SLICE_2_DIR = "e2e/screenshots/slice-2";

test("shows the unlimited default entitlements for a newly provisioned organization", async ({
  hub,
  page,
}) => {
  await test.step("sign up and land in a new organization", async () => {
    await hub.signUpAs("owner", owner);
    await hub.createOrganization("owner", "Acme");
    await page.screenshot({
      path: `${SLICE_1_DIR}/01-new-organization.png`,
      fullPage: true,
    });
  });

  await test.step("open the entitlements page and see the unlimited defaults", async () => {
    await hub.expectEntitlements("owner");
    await page.screenshot({
      path: `${SLICE_1_DIR}/02-entitlements-unlimited-defaults.png`,
      fullPage: true,
    });
  });
});

test("an owner caps seats, a blocked invite explains itself, and the audit trail records who and why", async ({
  hub,
  page,
}) => {
  const reason = "Founding-team seat cap for the private beta";

  await test.step("sign up and create an organization", async () => {
    await hub.signUpAs("owner", owner);
    await hub.createOrganization("owner", "Acme");
  });

  await test.step("cap seats at 2 with a required reason", async () => {
    await hub.openSeatOverrideEditor("owner", { max: 2, reason });
    await page.screenshot({ path: `${SLICE_2_DIR}/01-override-editor.png`, fullPage: true });
    await hub.saveSeatOverride("owner", 2);
  });

  await test.step("invite the second member, filling the two-seat cap", async () => {
    await hub.inviteMember("owner", secondMember, "member");
  });

  await test.step("a third invite is refused with a message that names the limit", async () => {
    await hub.expectInviteRefusedBySeatLimit("owner", thirdMember, { limit: 2, current: 2 });
    await page.screenshot({ path: `${SLICE_2_DIR}/02-invite-refused.png`, fullPage: true });
  });

  await test.step("the audit trail records who capped seats and why", async () => {
    await hub.expectEntitlementsAudit("owner", { actor: owner.name, reason });
    await page.screenshot({ path: `${SLICE_2_DIR}/03-audit-trail.png`, fullPage: true });
  });
});
