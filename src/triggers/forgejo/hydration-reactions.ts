import {
  rejectRedirectStatus,
  assertResolvedAddressesAllowed,
} from "../../http/approved-origin.js";
import {
  decryptSecret,
  type SecretEncryptionKeySource,
} from "../../secrets/authenticated-envelope.js";
import {
  ForgejoContractError,
  originFromInstance,
  type ForgejoDirectory,
  type ForgejoHttp,
} from "../../providers/forgejo/instances.js";

export type ForgejoHydrationReactionContent = "eyes" | "+1" | "-1";

export interface ForgejoHydrationReactionSubject {
  kind: "issue" | "pull_request" | "review_comment";
  id: number;
}

export interface ForgejoHydrationReactionClient {
  create(input: {
    connectionId: string;
    owner: string;
    repo: string;
    subject: ForgejoHydrationReactionSubject;
    content: ForgejoHydrationReactionContent;
  }): Promise<void>;
}

export function createForgejoHydrationReactionClient(options: {
  directory: ForgejoDirectory;
  http: ForgejoHttp;
  secrets: SecretEncryptionKeySource;
}): ForgejoHydrationReactionClient {
  return {
    async create(input) {
      const resolved = await connectionContext(options, input.connectionId);
      await assertResolvedAddressesAllowed(resolved.origin, options.http.resolver);
      const path = reactionPath(input.owner, input.repo, input.subject);
      const headers = new Headers({
        accept: "application/json",
        authorization: `token ${resolved.token}`,
        "content-type": "application/json",
      });
      const response = await options.http.fetch(
        new URL(path, `${resolved.origin.origin}/`).toString(),
        {
          method: "POST",
          headers,
          body: JSON.stringify({ content: input.content }),
          redirect: "manual",
        },
      );
      rejectRedirectStatus(response.status);
      if (response.status !== 200 && response.status !== 201) {
        throw new Error(`Forgejo reaction request failed (${String(response.status)})`);
      }
    },
  };
}

function reactionPath(
  owner: string,
  repo: string,
  subject: ForgejoHydrationReactionSubject,
): string {
  if (subject.kind === "review_comment") {
    return `/api/v1/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/comments/${String(subject.id)}/reactions`;
  }
  return `/api/v1/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/${String(subject.id)}/reactions`;
}

async function connectionContext(
  options: { directory: ForgejoDirectory; secrets: SecretEncryptionKeySource },
  connectionId: string,
) {
  const connection = await options.directory.findConnectionById(connectionId);
  if (connection === undefined) {
    throw new ForgejoContractError("not_found", 404, "Forgejo connection is unavailable");
  }
  const instance = await options.directory.findInstanceById(connection.instanceId);
  if (instance === undefined) {
    throw new ForgejoContractError("not_found", 404, "Forgejo instance is unavailable");
  }
  const credential = await options.directory.findActiveConnectionCredential(connectionId);
  if (credential === undefined) {
    throw new ForgejoContractError(
      "forgejo_credential_unavailable",
      409,
      "Forgejo connection credential is unavailable",
    );
  }
  return {
    origin: originFromInstance(instance),
    token: decryptSecret(
      options.secrets,
      {
        alg: "aes-256-gcm",
        keyId: credential.keyId,
        nonce: credential.nonce,
        ciphertext: credential.ciphertext,
        aadVersion: 1,
      },
      {
        organizationId: credential.organizationId,
        credentialId: credential.id,
        kind: "connection",
      },
    ),
  };
}
