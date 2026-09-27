import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { z } from "zod";
import { connectionStatusSchema } from "./functions.js";
import { forgejoOperationFailure } from "./forgejo-failure.js";

const errorBodySchema = z.object({ error: z.string().optional() });

it("keeps provider readiness separate from connection inventory", () => {
  const status = connectionStatusSchema.parse({
    canManage: true,
    github: { status: "connected" },
    discord: { status: "connected" },
    slack: { status: "disconnected" },
    linear: { status: "disconnected" },
    forgejo: { status: "notConfigured" },
  });
  assert.deepEqual(status, {
    canManage: true,
    github: { status: "connected" },
    discord: { status: "connected" },
    slack: { status: "disconnected" },
    linear: { status: "disconnected" },
    forgejo: { status: "notConfigured" },
  });
});

const REPORT = { organizationSlug: "acme", provider: "forgejo" as const };

describe("forgejoOperationFailure", () => {
  it("gives a missing-scope refusal its own message instead of the generic instance-unreachable one", async () => {
    const response = Response.json({ error: "insufficient_token_scopes" }, { status: 422 });

    const failure = await forgejoOperationFailure("create", response, REPORT, {
      permissionMessage: "no permission",
      fallbackMessage: "generic fallback",
      cases: [
        {
          status: 422,
          resolve: async (r) => {
            const code = errorBodySchema.parse(await r.json()).error;
            return code === "insufficient_token_scopes"
              ? "That token can't read its own account. Forgejo's read:user scope is missing; generate a token with it and try again."
              : undefined;
          },
        },
      ],
    });

    assert.match(failure.error.message, /read:user/u);
    assert.doesNotMatch(failure.error.message, /generic fallback/u);
  });

  it("falls back to the generic message when the body doesn't carry the case's expected code", async () => {
    const response = Response.json({ error: "something_else" }, { status: 422 });

    const failure = await forgejoOperationFailure("create", response, REPORT, {
      permissionMessage: "no permission",
      fallbackMessage: "generic fallback",
      cases: [
        {
          status: 422,
          resolve: async (r) =>
            errorBodySchema.parse(await r.json()).error === "x" ? "x" : undefined,
        },
      ],
    });

    assert.match(failure.error.message, /generic fallback/u);
  });

  it("gives 403 its own permission message instead of the generic fallback", async () => {
    const response = new Response("nope", { status: 403 });

    const failure = await forgejoOperationFailure("orgs", response, REPORT, {
      permissionMessage: "you can't manage this connection",
      fallbackMessage: "generic fallback",
    });

    assert.match(failure.error.message, /you can't manage this connection/u);
  });

  it("matches a case keyed only on status, with no body to inspect", async () => {
    const response = new Response(null, { status: 409 });

    const failure = await forgejoOperationFailure("subscribe", response, REPORT, {
      permissionMessage: "no permission",
      fallbackMessage: "generic fallback",
      cases: [{ status: 409, resolve: () => "another change is already running" }],
    });

    assert.match(failure.error.message, /another change is already running/u);
  });
});

const subscribeHookErrorSchema = z.object({ error: z.string(), reason: z.string().optional() });

describe("subscribeForgejoWebhook's own 404/422 case resolution", () => {
  it("gives a permission refusal its own message", async () => {
    const response = Response.json({ error: "hook_permission_denied" }, { status: 422 });

    const failure = await forgejoOperationFailure("subscribe", response, REPORT, {
      permissionMessage: "no permission",
      fallbackMessage: "generic fallback",
      cases: [
        {
          status: 422,
          resolve: async (r) => {
            const body = subscribeHookErrorSchema.safeParse(await r.json());
            if (!body.success) return undefined;
            if (body.data.error === "hook_permission_denied") return "needs a scope";
            if (body.data.error === "hook_rejected")
              return body.data.reason === undefined ? "rejected" : `rejected: ${body.data.reason}`;
            return undefined;
          },
        },
      ],
    });

    assert.match(failure.error.message, /needs a scope/u);
  });

  it("carries the instance's own reason for a rejected hook", async () => {
    const response = Response.json(
      { error: "hook_rejected", reason: "Invalid url" },
      { status: 422 },
    );

    const failure = await forgejoOperationFailure("subscribe", response, REPORT, {
      permissionMessage: "no permission",
      fallbackMessage: "generic fallback",
      cases: [
        {
          status: 422,
          resolve: async (r) => {
            const body = subscribeHookErrorSchema.safeParse(await r.json());
            if (!body.success) return undefined;
            if (body.data.error === "hook_permission_denied") return "needs a scope";
            if (body.data.error === "hook_rejected")
              return body.data.reason === undefined ? "rejected" : `rejected: ${body.data.reason}`;
            return undefined;
          },
        },
      ],
    });

    assert.match(failure.error.message, /rejected: Invalid url/u);
  });

  it("gives an org-not-found 404 its own message instead of the generic fallback", async () => {
    const response = Response.json({ error: "hook_target_not_found" }, { status: 404 });

    const failure = await forgejoOperationFailure("subscribe", response, REPORT, {
      permissionMessage: "no permission",
      fallbackMessage: "generic fallback",
      cases: [
        {
          status: 404,
          resolve: async (r) => {
            const body = subscribeHookErrorSchema.safeParse(await r.json());
            return body.success && body.data.error === "hook_target_not_found"
              ? "org not found"
              : undefined;
          },
        },
      ],
    });

    assert.match(failure.error.message, /org not found/u);
  });
});
