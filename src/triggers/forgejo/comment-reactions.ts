import { rejectRedirectStatus } from "../../http/approved-origin.js";
import {
  decryptSecret,
  type SecretEncryptionKeySource,
} from "../../secrets/authenticated-envelope.js";
import {
  ForgejoContractError,
  dispatchForgejoHttp,
  originFromInstance,
  type ForgejoDirectory,
  type ForgejoHttp,
} from "../../providers/forgejo/instances.js";

export type ForgejoCommentReactionContent = "eyes" | "+1" | "-1";

export interface ForgejoCommentReactionSubject {
  kind: "comment";
  id: number;
}

export interface ForgejoCommentReactionClient {
  create(input: {
    connectionId: string;
    owner: string;
    repo: string;
    subject: ForgejoCommentReactionSubject;
    content: ForgejoCommentReactionContent;
  }): Promise<void>;
}

export function createForgejoCommentReactionClient(options: {
  directory: ForgejoDirectory;
  http: ForgejoHttp;
  secrets: SecretEncryptionKeySource;
}): ForgejoCommentReactionClient {
  return {
    async create(input) {
      const resolved = await connectionContext(options, input.connectionId);
      const path = `/api/v1/repos/${encodeURIComponent(input.owner)}/${encodeURIComponent(input.repo)}/issues/comments/${String(input.subject.id)}/reactions`;
      const headers = new Headers({
        accept: "application/json",
        authorization: `token ${resolved.token}`,
        "content-type": "application/json",
      });
      const response = await dispatchForgejoHttp(
        options.http,
        resolved.origin,
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
