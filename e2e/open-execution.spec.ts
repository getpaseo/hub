import { test } from "./app.js";

const owner = {
  name: "Studio Owner",
  email: "studio-owner@example.com",
  password: "studio-owner-password",
};

test("a shared execution link returns an organization member to the Paseo launcher after sign-in", async ({
  hub,
}) => {
  await hub.signUpAs("owner", owner);
  await hub.createOrganization("owner", "Studio Owner");
  const execution = await hub.seedExecutionLink("owner");
  await hub.signOut("owner");
  await hub.signUpAs("outsider", {
    name: "Outsider",
    email: "outsider@example.com",
    password: "outsider-password",
  });
  await hub.createOrganization("outsider", "Outsider Studio");

  await test.step("signed-out and non-member visitors receive no run data", async () => {
    await hub.expectExecutionLinkDenied("outsider", execution);
    await hub.expectExecutionLinkRequiresSignIn(execution);
  });

  await test.step("the owner signs in and reaches the exact agent and run details", async () => {
    await hub.signInFromExecutionLink(owner);
    await hub.expectExecutionLauncher(execution);
    await hub.viewExecutionInHub(execution);
  });
});
