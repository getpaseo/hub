/* oxlint-disable eslint-plugin-react-perf/jsx-no-new-function-as-prop, eslint-plugin-react-perf/jsx-no-new-array-as-prop, eslint-plugin-react-perf/jsx-no-new-object-as-prop -- organization connection forms bind submit per panel snapshot */
import { useMutation, useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useActiveAccount } from "../../../auth/active-account.js";
import { FORGEJO_PAT_MASK } from "../instances.js";
import {
  configureForgejoExecutionCredential,
  createForgejoConnection,
  disconnectForgejoConnection,
  enrollForgejoRepositories,
  listForgejoConnections,
  listForgejoHooks,
  previewForgejoDisconnect,
  revokeForgejoConnectionCredential,
  revokeForgejoExecutionCredential,
  rotateForgejoConnectionCredential,
  rotateForgejoWebhookSecret,
  recoverForgejoRemoteCleanup,
  setupForgejoHooks,
  type ForgejoHookSetup,
} from "../functions.js";
import {
  ForgejoConnectionPanel,
  type ForgejoConnectionView,
  type ForgejoDisconnectImpactView,
} from "./connection-panel.js";
import { resultError } from "./result-error.js";

export function ForgejoOrganizationConnectionSection() {
  const { membership } = useActiveAccount();
  const queryClient = useQueryClient();
  const load = useServerFn(listForgejoConnections);
  const loadHooks = useServerFn(listForgejoHooks);
  const connect = useMutation({
    mutationFn: useServerFn(createForgejoConnection),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["forgejo", "connections"] });
    },
  });
  const enroll = useMutation({
    mutationFn: useServerFn(enrollForgejoRepositories),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["forgejo"] });
    },
  });
  const setupHooks = useMutation({
    mutationFn: useServerFn(setupForgejoHooks),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["forgejo"] });
    },
  });
  const rotateConnectionCredential = useMutation({
    mutationFn: useServerFn(rotateForgejoConnectionCredential),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["forgejo"] });
    },
  });
  const revokeConnectionCredential = useMutation({
    mutationFn: useServerFn(revokeForgejoConnectionCredential),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["forgejo"] });
    },
  });
  const configureExecutionCredential = useMutation({
    mutationFn: useServerFn(configureForgejoExecutionCredential),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["forgejo"] });
    },
  });
  const revokeExecutionCredential = useMutation({
    mutationFn: useServerFn(revokeForgejoExecutionCredential),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["forgejo"] });
    },
  });
  const rotateWebhookSecret = useMutation({
    mutationFn: useServerFn(rotateForgejoWebhookSecret),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["forgejo"] });
    },
  });
  const previewDisconnect = useMutation({ mutationFn: useServerFn(previewForgejoDisconnect) });
  const disconnect = useMutation({
    mutationFn: useServerFn(disconnectForgejoConnection),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["forgejo"] });
    },
  });
  const recoverCleanup = useMutation({
    mutationFn: useServerFn(recoverForgejoRemoteCleanup),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["forgejo"] });
    },
  });
  const query = useQuery({
    queryKey: ["forgejo", "connections"],
    queryFn: () => load(),
  });
  const connections = query.data?.status === "ok" ? query.data.data.connections : [];
  const hookQueries = useQueries({
    queries: connections.map((connection) => ({
      queryKey: ["forgejo", "hooks", connection.id],
      queryFn: () => loadHooks({ data: { connectionId: connection.id } }),
    })),
  });
  const hookByConnection = new Map<string, ForgejoHookSetup>();
  for (const [index, connection] of connections.entries()) {
    const result = hookQueries[index]?.data;
    if (result?.status === "ok") hookByConnection.set(connection.id, result.data);
  }
  const error = resultError(
    query.data,
    connect.data,
    enroll.data,
    setupHooks.data,
    rotateConnectionCredential.data,
    revokeConnectionCredential.data,
    configureExecutionCredential.data,
    revokeExecutionCredential.data,
    rotateWebhookSecret.data,
    previewDisconnect.data,
    disconnect.data,
    recoverCleanup.data,
    query.error,
    rotateConnectionCredential.error,
    revokeConnectionCredential.error,
    configureExecutionCredential.error,
    revokeExecutionCredential.error,
    rotateWebhookSecret.error,
    previewDisconnect.error,
    disconnect.error,
    recoverCleanup.error,
    ...hookQueries.map((entry) => entry.data),
    ...hookQueries.map((entry) => entry.error),
  );
  const data = query.data?.status === "ok" ? query.data.data : undefined;
  const disconnectImpact: ForgejoDisconnectImpactView | null =
    previewDisconnect.data?.status === "ok" ? previewDisconnect.data.data : null;
  const disconnectResult = disconnect.data?.status === "ok" ? disconnect.data.data : null;
  return (
    <ForgejoConnectionPanel
      approvedInstances={(data?.approvedInstances ?? []).map((instance) => ({
        id: instance.id,
        canonicalOrigin: instance.canonicalOrigin,
        reportedVersion: instance.reportedVersion,
      }))}
      connections={(data?.connections ?? []).map((connection) => {
        const webhook = hookByConnection.get(connection.id);
        const view: ForgejoConnectionView = {
          id: connection.id,
          slug: connection.slug,
          instanceId: connection.instanceId,
          forgejoUserLogin: connection.forgejoUserLogin,
          status: connection.status,
          credentialMask: FORGEJO_PAT_MASK,
          repositories: connection.repositories.map((repository) => ({
            repositoryId: repository.repositoryId,
            fullName: repository.fullName,
            htmlUrl: repository.htmlUrl,
            enrolled: repository.enrolled,
          })),
        };
        if (webhook !== undefined) {
          view.webhook = {
            callbackUrl: webhook.callbackUrl,
            events: webhook.events,
            secret: webhook.credential.secret,
            hooks: webhook.hooks,
          };
        }
        return view;
      })}
      error={error}
      canConnect={membership.role === "owner"}
      onConnect={(input) => connect.mutate({ data: input })}
      onEnroll={(input) =>
        enroll.mutate({
          data: { connectionId: input.connectionId, repositoryIds: [...input.repositoryIds] },
        })
      }
      onSetupHooks={(input) =>
        setupHooks.mutate({
          data:
            input.mode === "automatic"
              ? {
                  connectionId: input.connectionId,
                  mode: "automatic",
                  adminPat: input.adminPat ?? "",
                }
              : { connectionId: input.connectionId, mode: "manual" },
        })
      }
      onRotateConnectionCredential={(input) =>
        rotateConnectionCredential.mutate({
          data: {
            connectionId: input.connectionId,
            pat: input.pat,
            scopes: ["read:issue", "write:issue", "read:repository", "write:repository"],
            repositoryIds: [...input.repositoryIds],
          },
        })
      }
      onRevokeConnectionCredential={(input) =>
        revokeConnectionCredential.mutate({ data: { connectionId: input.connectionId } })
      }
      onConfigureExecutionCredential={(input) =>
        configureExecutionCredential.mutate({
          data: {
            connectionId: input.connectionId,
            pat: input.pat,
            scopes: [...input.scopes],
            repositories: [...input.repositories],
          },
        })
      }
      onRevokeExecutionCredential={(input) =>
        revokeExecutionCredential.mutate({ data: { connectionId: input.connectionId } })
      }
      onRotateWebhookSecret={(input) => rotateWebhookSecret.mutate({ data: input })}
      onPreviewDisconnect={(input) => previewDisconnect.mutate({ data: input })}
      onDisconnect={(input) => disconnect.mutate({ data: input })}
      onRecoverCleanup={(input) => recoverCleanup.mutate({ data: input })}
      disconnectImpact={disconnectImpact}
      disconnectResult={disconnectResult}
    />
  );
}
