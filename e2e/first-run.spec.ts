import { test } from "./app.js";

// Both journeys start a second, genuinely pristine application alongside the fixture's own.
test.describe.configure({ timeout: 90_000 });

test("an unclaimed Hub sets up its first operator and signs them in", async ({ hub }) => {
  await hub.proveFirstRunOperatorClaim(
    {
      name: "First Operator",
      email: "first-operator@example.com",
      password: "first-operator-password",
    },
    "First Organization",
  );
});

test("a second browser cannot claim a Hub that was set up while it waited", async ({ hub }) => {
  await hub.proveFirstRunClaimIsSingleUse(
    {
      name: "Winning Operator",
      email: "winning-operator@example.com",
      password: "winning-operator-password",
    },
    {
      name: "Losing Operator",
      email: "losing-operator@example.com",
      password: "losing-operator-password",
    },
  );
});
