import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { describe, it } from "vitest";
import {
  encryptSecret,
  type SecretEncryptionKeySource,
} from "../../secrets/authenticated-envelope.js";
import { ForgejoAuthorityError } from "../../config/forgejo-authority.js";
import {
  createForgejoAuthorityRegistration,
  injectForgejoDaemonEnvironment,
  type ForgejoAuthoritySnapshot,
  type ForgejoExecutionAuthorityStore,
} from "./execution-authority.js";

const EXECUTION_TOKEN = "fj_exec_pat_canary_7e57f916";
const CONNECTION_TOKEN = "fj_conn_pat_must_never_inject";

function keySource(): SecretEncryptionKeySource {
  const key = { keyId: 1, key: randomBytes(32) };
  return {
    current: () => key,
    byId: (id) => (id === 1 ? key : undefined),
  };
}

function snapshot(
  keys: SecretEncryptionKeySource,
  overrides: Partial<ForgejoAuthoritySnapshot> = {},
): ForgejoAuthoritySnapshot {
  const envelope = encryptSecret(keys, {
    plaintext: EXECUTION_TOKEN,
    organizationId: "org-1",
    credentialId: "cred-exec",
    kind: "execution",
  });
  const base: ForgejoAuthoritySnapshot = {
    connection: {
      id: "conn-1",
      organizationId: "org-1",
      slug: "acme-forgejo",
      status: "active",
      forgejoUserId: 2,
      forgejoUserLogin: "t00bot",
      instanceId: "inst-1",
    },
    instance: {
      id: "inst-1",
      canonicalOrigin: "https://forgejo.example.test",
      status: "active",
    },
    enrolledRepositories: ["acme/widgets"],
    executionCredential: {
      id: "cred-exec",
      organizationId: "org-1",
      kind: "execution",
      status: "active",
      envelope,
      scopeEvidence: {
        scopes: ["write:repository", "write:issue"],
        repositories: ["acme/widgets"],
      },
    },
  };
  return {
    ...base,
    ...overrides,
    connection: overrides.connection ?? base.connection,
    instance: overrides.instance ?? base.instance,
    executionCredential:
      overrides.executionCredential === undefined && !("executionCredential" in overrides)
        ? base.executionCredential
        : overrides.executionCredential,
  };
}

function storeOf(value: ForgejoAuthoritySnapshot | undefined): ForgejoExecutionAuthorityStore {
  return {
    loadSnapshot: async () => value,
  };
}

describe("Forgejo execution authority mint", () => {
  it("mints the execution PAT and daemon rewrite for an authorized grant", async () => {
    const keys = keySource();
    const granted = snapshot(keys);
    const authority = createForgejoAuthorityRegistration({
      store: storeOf(granted),
      keys,
    });
    const minted = await authority.mint({
      projectId: "project-1",
      connectionSlug: "acme-forgejo",
      repositories: ["acme/widgets"],
      contents: "write",
      issues: "read",
    });
    assert.equal(minted.token, EXECUTION_TOKEN);
    assert.equal(minted.origin, "https://forgejo.example.test");
    assert.equal(minted.login, "t00bot");
    const env = injectForgejoDaemonEnvironment(minted);
    assert.equal(env["FORGEJO_TOKEN"], EXECUTION_TOKEN);
    assert.equal(env["GH_TOKEN"], undefined);
    await authority.revoke(minted.token);
    assert.equal(
      JSON.stringify({ minted: { ...minted, token: undefined }, error: undefined }).includes(
        EXECUTION_TOKEN,
      ),
      false,
    );
  });

  it("fails closed when connection rows are empty", async () => {
    const authority = createForgejoAuthorityRegistration({
      store: storeOf(undefined),
      keys: keySource(),
    });
    await assert.rejects(
      () =>
        authority.mint({
          projectId: "project-1",
          connectionSlug: "acme-forgejo",
          repositories: ["acme/widgets"],
          contents: "read",
          issues: "read",
        }),
      (error: unknown) =>
        error instanceof ForgejoAuthorityError && error.code === "forgejo_connection_unavailable",
    );
  });

  it("never injects the connection PAT when the execution credential is missing", async () => {
    const keys = keySource();
    const granted = snapshot(keys, { executionCredential: undefined });
    const authority = createForgejoAuthorityRegistration({ store: storeOf(granted), keys });
    await assert.rejects(
      () =>
        authority.mint({
          projectId: "project-1",
          connectionSlug: "acme-forgejo",
          repositories: ["acme/widgets"],
          contents: "read",
          issues: "read",
        }),
      (error: unknown) => {
        assert.ok(error instanceof ForgejoAuthorityError);
        assert.equal(error.code, "forgejo_credential_unavailable");
        assert.equal(error.message.includes(CONNECTION_TOKEN), false);
        assert.equal(error.message.includes(EXECUTION_TOKEN), false);
        return true;
      },
    );
  });

  it("fails closed for revoked credentials, unenrolled repositories, and excessive scope", async () => {
    const keys = keySource();
    const base = snapshot(keys);
    const cases: Array<{
      snapshot: ForgejoAuthoritySnapshot;
      code: ForgejoAuthorityError["code"];
    }> = [
      {
        snapshot: snapshot(keys, {
          connection: { ...base.connection, status: "disconnected" },
        }),
        code: "forgejo_connection_unavailable",
      },
      {
        snapshot: snapshot(keys, {
          executionCredential: { ...base.executionCredential!, status: "revoked" },
        }),
        code: "forgejo_credential_unavailable",
      },
      {
        snapshot: snapshot(keys, { enrolledRepositories: ["acme/other"] }),
        code: "forgejo_repository_unenrolled",
      },
      {
        snapshot: snapshot(keys, {
          executionCredential: {
            ...base.executionCredential!,
            scopeEvidence: {
              scopes: ["read:repository", "read:issue"],
              repositories: ["acme/widgets"],
            },
          },
        }),
        code: "forgejo_scope_invalid",
      },
    ];
    for (const candidate of cases) {
      const authority = createForgejoAuthorityRegistration({
        store: storeOf(candidate.snapshot),
        keys,
      });
      await assert.rejects(
        () =>
          authority.mint({
            projectId: "project-1",
            connectionSlug: "acme-forgejo",
            repositories: ["acme/widgets"],
            contents: "write",
            issues: "write",
          }),
        (error: unknown) => error instanceof ForgejoAuthorityError && error.code === candidate.code,
      );
    }
  });

  it("rejects a repository that is enrolled but outside the execution PAT boundary", async () => {
    const keys = keySource();
    const authority = createForgejoAuthorityRegistration({
      store: storeOf(
        snapshot(keys, {
          enrolledRepositories: ["acme/widgets", "acme/extra"],
          executionCredential: {
            ...snapshot(keys).executionCredential!,
            scopeEvidence: {
              scopes: ["write:repository", "write:issue"],
              repositories: ["acme/widgets"],
            },
          },
        }),
      ),
      keys,
    });
    await assert.rejects(
      () =>
        authority.mint({
          projectId: "project-1",
          connectionSlug: "acme-forgejo",
          repositories: ["acme/extra"],
          contents: "read",
          issues: "read",
        }),
      (error: unknown) =>
        error instanceof ForgejoAuthorityError && error.code === "forgejo_scope_invalid",
    );
  });
});
