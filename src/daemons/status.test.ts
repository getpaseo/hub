import assert from "node:assert/strict";
import { QueryClient } from "@tanstack/react-query";
import { it } from "vitest";
import type { BrowserDaemon } from "./functions.js";
import { connectedDaemon, daemonsQueryKey, refreshDaemons } from "./status.js";

it("separates daemon caches for accounts in the same organization", () => {
  assert.notDeepEqual(daemonsQueryKey("alice", "acme"), daemonsQueryKey("bob", "acme"));
});

it("refreshes an inactive daemon query before mutation settlement", async () => {
  const queryClient = new QueryClient();
  const queryKey = daemonsQueryKey("alice", "acme");
  let name = "Build Studio";
  await queryClient.fetchQuery({ queryKey, queryFn: () => Promise.resolve(name) });

  name = "Release Studio";
  await refreshDaemons(queryClient, "alice", "acme");

  assert.equal(queryClient.getQueryData(queryKey), "Release Studio");
});

it("counts only an active, connected daemon as one to run on", () => {
  const daemon = (slug: string, overrides: Partial<BrowserDaemon>): BrowserDaemon => ({
    id: "00000000-0000-4000-8000-000000000000",
    slug,
    status: "active",
    presence: "connected",
    connectedAt: null,
    lastSeenAt: "2026-09-01T12:00:00.000Z",
    registeredAt: "2026-09-01T12:00:00.000Z",
    permissions: [],
    ...overrides,
  });
  const offline = daemon("laptop", { presence: "offline" });
  const revoked = daemon("old-box", { status: "revoked" });
  assert.equal(connectedDaemon([]), undefined);
  assert.equal(connectedDaemon([offline, revoked]), undefined);
  assert.equal(connectedDaemon([offline, revoked, daemon("devbox", {})])?.slug, "devbox");
});
