/* oxlint-disable eslint-plugin-react-perf/jsx-no-new-function-as-prop, eslint-plugin-react-perf/jsx-no-new-array-as-prop, eslint-plugin-react-perf/jsx-no-new-object-as-prop -- organization connection forms bind submit per panel snapshot */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useActiveAccount } from "../../../auth/active-account.js";
import { FORGEJO_PAT_MASK } from "../instances.js";
import {
  createForgejoConnection,
  enrollForgejoRepositories,
  listForgejoConnections,
} from "../functions.js";
import { ForgejoConnectionPanel } from "./connection-panel.js";
import { resultError } from "./result-error.js";

export function ForgejoOrganizationConnectionSection() {
  const { membership } = useActiveAccount();
  const queryClient = useQueryClient();
  const load = useServerFn(listForgejoConnections);
  const connect = useMutation({
    mutationFn: useServerFn(createForgejoConnection),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["forgejo", "connections"] });
    },
  });
  const enroll = useMutation({
    mutationFn: useServerFn(enrollForgejoRepositories),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["forgejo", "connections"] });
    },
  });
  const query = useQuery({
    queryKey: ["forgejo", "connections"],
    queryFn: () => load(),
  });
  const error = resultError(query.data, connect.data, enroll.data, query.error);
  const data = query.data?.status === "ok" ? query.data.data : undefined;
  return (
    <ForgejoConnectionPanel
      approvedInstances={(data?.approvedInstances ?? []).map((instance) => ({
        id: instance.id,
        canonicalOrigin: instance.canonicalOrigin,
        reportedVersion: instance.reportedVersion,
      }))}
      connections={(data?.connections ?? []).map((connection) => ({
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
      }))}
      error={error}
      canConnect={membership.role === "owner"}
      onConnect={(input) => connect.mutate({ data: input })}
      onEnroll={(input) =>
        enroll.mutate({
          data: { connectionId: input.connectionId, repositoryIds: [...input.repositoryIds] },
        })
      }
    />
  );
}
