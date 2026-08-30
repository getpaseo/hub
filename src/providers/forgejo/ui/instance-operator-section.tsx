/* oxlint-disable eslint-plugin-react-perf/jsx-no-new-function-as-prop, eslint-plugin-react-perf/jsx-no-new-array-as-prop, eslint-plugin-react-perf/jsx-no-new-object-as-prop -- operator instance forms bind submit per panel snapshot */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Section } from "../../../components/app/section.js";
import { approveForgejoInstance, listForgejoInstances } from "../functions.js";
import { ForgejoInstancePanel } from "./instance-panel.js";
import { resultError } from "./result-error.js";

export function ForgejoInstanceOperatorSection() {
  const queryClient = useQueryClient();
  const load = useServerFn(listForgejoInstances);
  const approve = useMutation({
    mutationFn: useServerFn(approveForgejoInstance),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["forgejo", "instances"] });
    },
  });
  const query = useQuery({
    queryKey: ["forgejo", "instances"],
    queryFn: () => load(),
  });
  const error = resultError(query.data, approve.data, query.error);
  const instances = query.data?.status === "ok" ? query.data.data.instances : [];
  return (
    <Section
      title="Forgejo instances"
      description="Approve a canonical HTTPS origin. Organization owners connect only by this ID."
    >
      <ForgejoInstancePanel
        instances={instances.map((instance) => ({
          id: instance.id,
          canonicalOrigin: instance.canonicalOrigin,
          reportedVersion: instance.reportedVersion,
          status: instance.status,
          lastHealthError: instance.lastHealthError ?? null,
        }))}
        error={error}
        canApprove
        onApprove={(input) => approve.mutate({ data: input })}
      />
    </Section>
  );
}
