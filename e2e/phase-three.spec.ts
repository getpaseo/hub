import { test } from "./app.js";

const alice = {
  name: "Alice",
  email: "alice@example.com",
  password: "alice-phase-three-password",
};

const bob = {
  name: "Bob",
  email: "bob@example.com",
  password: "bob-phase-three-password",
};

test("connects verified providers per organization and disconnects through confirmation", async ({
  hub,
}) => {
  await hub.signUpAs("alice", alice);
  await hub.createOrganization("alice", "Acme");
  await hub.expectConnections("alice");
  await hub.connectGitHub("alice");
  await hub.connectDiscord("alice");
  await hub.expectConnectedProviders("alice", {
    github: "acme-inc",
    installationId: "42",
    discord: "acme-guild-discord",
    guildId: "100",
  });

  await hub.addNewMember("alice", "bob", bob);
  await hub.expectMemberConnectedProviders("bob", {
    github: "acme-inc",
    installationId: "42",
    discord: "acme-guild-discord",
    guildId: "100",
  });
  await hub.expectMemberConnectionMutationDenied("bob");

  await hub.createAnotherOrganization("alice", "Orbit");
  await hub.chooseOrganization("alice", "Orbit");
  await hub.connectGitHub("alice", "orbit-inc");
  await hub.connectDiscord("alice");
  await hub.expectConnectedProviders("alice", {
    github: "orbit-inc",
    installationId: "84",
    discord: "orbit-guild-discord",
    guildId: "200",
  });
  await hub.proveTenantProviderDispatch("alice");

  await hub.chooseOrganization("alice", "Acme");
  await hub.expectConnectedProviders("alice", {
    github: "acme-inc",
    installationId: "42",
    discord: "acme-guild-discord",
    guildId: "100",
  });
  await hub.disconnectProviders("alice");
  await hub.proveDisconnectedProvidersDrop();
});

test("connects through GitHub's install page when the App is installed nowhere", async ({
  hub,
}) => {
  await hub.signUpAs("alice", alice);
  await hub.createOrganization("alice", "Acme");
  const github = await hub.startGitHubConnection("alice");
  await github.installOn("acme-inc");
  await hub.expectGitHubConnected("alice");
  await hub.expectGitHubConnection("alice", { account: "acme-inc", installationId: "42" });
});

test("connects an account that already has the App without GitHub's install page, again after a disconnect", async ({
  hub,
}) => {
  await hub.signUpAs("alice", alice);
  await hub.createOrganization("alice", "Acme");
  await hub.onGitHub({ op: "install", account: "acme-inc" });
  await hub.connectFromGitHubChooser("alice", "acme-inc", [
    { account: "acme-inc", explanation: "Organization", connectable: true },
  ]);
  await hub.expectGitHubConnection("alice", { account: "acme-inc", installationId: "42" });

  await hub.disconnectGitHub("alice");
  await hub.connectFromGitHubChooser("alice", "acme-inc", [
    { account: "acme-inc", explanation: "Organization", connectable: true },
  ]);
  await hub.expectGitHubConnection("alice", { account: "acme-inc", installationId: "42" });
});

test("adds the App to another account from the chooser and stops offering a connected one", async ({
  hub,
}) => {
  await hub.signUpAs("alice", alice);
  await hub.createOrganization("alice", "Acme");
  await hub.onGitHub({ op: "install", account: "octo" });

  const github = await hub.startGitHubConnection("alice");
  await github.expectChooser([
    { account: "octo", explanation: "Personal account", connectable: true },
  ]);
  await github.addAnotherAccount();
  await github.installOn("acme-inc");
  await hub.expectGitHubConnected("alice");
  await hub.expectGitHubConnection("alice", { account: "acme-inc", installationId: "42" });

  const again = await hub.startGitHubConnection("alice");
  await again.expectChooser([
    {
      account: "acme-inc",
      explanation: "Connected",
      connectable: false,
    },
    { account: "octo", explanation: "Personal account", connectable: true },
  ]);
  await again.cancelChooser();
  await hub.expectGitHubConnection("alice", { account: "acme-inc", installationId: "42" });
});

test("lists an organization a member does not own without offering to connect it", async ({
  hub,
}) => {
  await hub.signUpAs("alice", alice);
  await hub.createOrganization("alice", "Acme");
  await hub.onGitHub({ op: "install", account: "acme-inc" });
  await hub.onGitHub({ op: "signIn", login: "mona" });

  const github = await hub.startGitHubConnection("alice");
  await github.expectChooser([
    {
      account: "acme-inc",
      explanation: "Only an owner of acme-inc can connect it.",
      connectable: false,
    },
  ]);
  await github.cancelChooser();
  await hub.expectNoConnections("alice");
});

test("refuses an installation GitHub did not confirm and says so", async ({ hub }) => {
  await hub.signUpAs("alice", alice);
  await hub.createOrganization("alice", "Acme");
  await hub.onGitHub({ op: "install", account: "orbit-inc" });
  await hub.onGitHub({ op: "signIn", login: "mona" });

  const github = await hub.startGitHubConnection("alice");
  await github.forgeSetupReturn(84);
  await hub.expectGitHubNotConnected(
    "alice",
    "GitHub didn't confirm that you can connect that account. Nothing was connected. Connect GitHub again, and pick an account you own.",
  );
});

test("says Hub couldn't finish when GitHub cannot confirm an owner, then connects on the next try", async ({
  hub,
}) => {
  await hub.signUpAs("alice", alice);
  await hub.createOrganization("alice", "Acme");
  await hub.onGitHub({ op: "install", account: "acme-inc" });
  await hub.onGitHub({ op: "graphqlOutage", down: true });

  await hub.startGitHubConnection("alice");
  await hub.expectGitHubNotConnected(
    "alice",
    "Hub couldn't finish the GitHub connection. Nothing was connected. Start the connection again from this page.",
  );

  await hub.onGitHub({ op: "graphqlOutage", down: false });
  await hub.connectFromGitHubChooser("alice", "acme-inc", [
    { account: "acme-inc", explanation: "Organization", connectable: true },
  ]);
  await hub.expectGitHubConnection("alice", { account: "acme-inc", installationId: "42" });
});

test("connects GitHub again after a cancelled authorization or an expired return", async ({
  hub,
}) => {
  await hub.signUpAs("alice", alice);
  await hub.createOrganization("alice", "Acme");

  const cancelled = await hub.pressConnectGitHub("alice");
  await cancelled.cancelAuthorization();
  await hub.expectGitHubNotice(
    "alice",
    "Authorization cancelled at GitHub. Nothing changed. Start again when you're ready.",
  );

  await hub.proveExpiredGitHubReturnRecovers("alice");
  await hub.expectGitHubConnection("alice", { account: "acme-inc", installationId: "42" });
});

test("locks organization switching while a provider disconnect is pending", async ({ hub }) => {
  await hub.signUpAs("alice", alice);
  await hub.createOrganization("alice", "Acme");
  await hub.connectGitHub("alice");
  await hub.createAnotherOrganization("alice", "Orbit");
  await hub.connectGitHub("alice", "orbit-inc");
  await hub.chooseOrganization("alice", "Acme");
  await hub.proveConnectionDisconnectLocksOrganizationSwitch("alice", "Orbit");
});

test("shows provider readiness as not configured without credentials", async ({ hub }) => {
  await hub.proveProviderNotConfigured({
    name: "Unconfigured Owner",
    email: "unconfigured@example.com",
    password: "unconfigured-phase-three-password",
  });
});

test("keeps GitHub owner approval terminal and retryable", async ({ hub }) => {
  await hub.proveGitHubApprovalRequired(alice);
});

test("fails closed for forged, expired, and replayed connection state", async ({ hub }) => {
  await hub.proveConnectionStateBoundaries({
    name: "State Alice",
    email: "state-alice@example.com",
    password: "state-boundaries-phase-three-password",
  });
});

test("returns a callback without a session to Connections", async ({ hub }) => {
  await hub.proveSignedOutConnectionReturn({
    name: "Signed-out Alice",
    email: "signed-out-alice@example.com",
    password: "signed-out-return-phase-three-password",
  });
});

test("keeps provider installation and guild conflicts unavailable", async ({ hub }) => {
  await hub.proveProviderConnectionConflicts({
    name: "Conflict Alice",
    email: "conflict-alice@example.com",
    password: "conflict-phase-three-password",
  });
});

test("keeps URL scope across organization switches and rejects replaced accounts", async ({
  hub,
}) => {
  await hub.proveStaleConnectionScopeReplacement(
    {
      name: "Stale Alice",
      email: "stale-alice@example.com",
      password: "stale-phase-three-password",
    },
    {
      name: "Replacement Alice",
      email: "replacement-alice@example.com",
      password: "replacement-phase-three-password",
    },
  );
});

test("locks account context while provider starts are pending", async ({ hub }) => {
  await hub.proveProviderStartLocksAccountContext({
    name: "Redirect Alice",
    email: "redirect-alice@example.com",
    password: "redirect-phase-three-password",
  });
});

test("shows a suspended GitHub connection", async ({ hub }) => {
  await hub.signUpAs("alice", alice);
  await hub.createOrganization("alice", "Connection states");
  await hub.seedSuspendedGitHubConnection("Connection states");
  await hub.expectSuspendedGitHubConnection("alice");
});
