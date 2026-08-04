import { test } from "./app.js";

const alice = {
  name: "Alice",
  email: "alice@example.com",
  password: "alice-phase-two-mobile-password",
};

test("reviews registration and reaches Daemons on mobile", async ({ hub }) => {
  await hub.signUpAs("alice", alice);
  await hub.createOrganization("alice", "Acme");
  await hub.denyRegistration("alice", "Mobile Mac");
  await hub.navigateToDaemonsFromMobileSidebar("alice");
});
