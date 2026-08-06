import { test } from "./app.js";

test.describe.configure({ timeout: 120_000 });

const alice = {
  name: "Alice",
  email: "alice@example.com",
  password: "alice-phase-two-password",
};

const bob = {
  name: "Bob",
  email: "bob@example.com",
  password: "bob-phase-two-password",
};

const carol = {
  name: "Carol",
  email: "carol@example.com",
  password: "carol-phase-two-password",
};

const dana = {
  name: "Dana",
  email: "dana@example.com",
  password: "dana-phase-two-password",
};

test("registers and manages a source-built Paseo daemon", async ({ hub }) => {
  await hub.signUpAs("alice", alice);
  await hub.createOrganization("alice", "Acme");
  await hub.startDaemonRegistration("alice");
  const daemonId = await hub.approveDaemon("alice", "Build Studio");
  hub.expectRegistrationResponseRecovery();
  await hub.expectDaemon("alice", "build-studio", daemonId, "Connected");
  await hub.proveDaemonAccessBoundaries("alice", "bob", bob, "build-studio");
  await hub.renameDaemon("alice", "build-studio", "release-studio");
  await hub.revokeDaemon("alice", "release-studio");
});

test("keeps denied and expired registrations terminal", async ({ hub }) => {
  await hub.signUpAs("alice", alice);
  await hub.createOrganization("alice", "Acme");
  await hub.denyRegistration("alice", "Denied Mac");
  await hub.expireRegistration("alice", "Expired Mac");
});

test("keeps daemon browser state inside the current identity", async ({ hub }) => {
  await hub.signUpAs("alice", alice);
  await hub.createOrganization("alice", "Acme");

  await hub.proveDaemonBrowserIdentityBoundary("alice", carol, dana, "private-studio");
});

test("locks tenant controls while browser daemon commands are pending", async ({ hub }) => {
  await hub.signUpAs("alice", alice);
  await hub.createOrganization("alice", "Acme");
  await hub.createAnotherOrganization("alice", "Orbit");
  await hub.chooseOrganization("alice", "Acme");

  await hub.proveDaemonCommandLocksAccountContext("alice");
});

test("keeps a conflicting daemon rename recoverable", async ({ hub }) => {
  await hub.signUpAs("alice", alice);
  await hub.createOrganization("alice", "Acme");

  await hub.proveDaemonRenameConflict("alice");
});
