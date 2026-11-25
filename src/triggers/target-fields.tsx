/* oxlint-disable eslint-plugin-react-perf/jsx-no-new-function-as-prop -- the target controls bind the trigger they belong to */
import { useServerFn } from "@tanstack/react-start";
import { useMemo, useState } from "react";

import { Combobox, type ComboboxOption } from "../components/app/combobox.js";
import { Disclosure } from "../components/app/disclosure.js";
import { FormField } from "../components/app/form-field.js";
import { daemonProjects } from "../daemons/functions.js";
import { useSnapshotQuery } from "../queries/index.js";
import type { TriggerFieldErrors, TriggerFormValue } from "./configuration/editor.js";
import type { TriggerSnapshot } from "./functions.js";

const NO_PROJECTS: readonly ComboboxOption[] = [];

/**
 * Where the trigger runs: the daemon, then the directory on it. The directory is one of the
 * projects the daemon has open or any absolute path, so a daemon that reports no projects only
 * loses the suggestions. Changing the daemon clears the agent, whose choices are the daemon's own.
 */
export function TargetFields({
  form,
  errors,
  snapshot,
  onChange,
}: {
  form: TriggerFormValue;
  errors: TriggerFieldErrors;
  snapshot: TriggerSnapshot;
  onChange: (value: TriggerFormValue) => void;
}) {
  const daemonOptions = useMemo(
    () =>
      snapshot.daemons.map((daemon) => ({
        value: daemon.slug,
        label: daemon.slug,
        detail: daemon.presence,
      })),
    [snapshot.daemons],
  );
  const daemon = snapshot.daemons.find(({ slug }) => slug === form.daemon);
  const projects = useDaemonProjects(snapshot.organization.slug, daemon?.id);
  const project = projects.options.find(({ value }) => value === form.cwd);
  const [limitsExpanded, setLimitsExpanded] = useState(false);
  const limitsRefused = errors.maxRuntime !== undefined || errors.idleTimeout !== undefined;
  return (
    <>
      <div className="grid gap-4 sm:grid-cols-2">
        <FormField
          id="trigger-daemon"
          label="Daemon"
          required
          {...(errors.daemon === undefined ? {} : { error: errors.daemon })}
        >
          {(control) => (
            <Combobox
              {...control}
              required
              value={form.daemon}
              options={daemonOptions}
              placeholder="Select a daemon"
              empty="No daemons found"
              onChange={(option) =>
                onChange({
                  ...form,
                  daemon: option.value,
                  cwd: option.value === form.daemon ? form.cwd : "",
                  agent: "",
                  mode: "",
                  thinkingOptionId: "",
                  providerOptions: "",
                })
              }
            />
          )}
        </FormField>
        {daemon === undefined ? null : (
          <FormField
            id="trigger-cwd"
            label="Working directory"
            // A project is chosen by name, so its path is said here; the stored value is the path.
            description={project?.detail ?? "A project on this daemon, or any absolute path"}
            required
            {...(errors.cwd === undefined ? {} : { error: errors.cwd })}
          >
            {(control) => (
              <Combobox
                {...control}
                required
                loading={projects.loading}
                value={form.cwd}
                options={projects.options}
                placeholder="Select a project or type a path"
                searchPlaceholder="Search projects or type a path…"
                empty="Type an absolute path, like /home/you/repo"
                custom={typedPath}
                onChange={(option) => onChange({ ...form, cwd: option.value })}
              />
            )}
          </FormField>
        )}
      </div>
      {daemon === undefined ? null : (
        <Disclosure
          id="trigger-limits"
          title="Advanced"
          description={`Limits: ${form.maxRuntime} runtime, ${form.idleTimeout} idle`}
          // A field that is in the way of saving is never left behind a closed header.
          open={limitsExpanded || limitsRefused}
          onOpenChange={setLimitsExpanded}
        >
          <div className="grid gap-4 sm:grid-cols-2">
            <FormField
              id="trigger-max-runtime"
              label="Maximum runtime"
              description="Hard deadline for the agent, like 2h"
              kind="text"
              name="maxRuntime"
              value={form.maxRuntime}
              onChange={(maxRuntime) => onChange({ ...form, maxRuntime })}
              required
              {...(errors.maxRuntime === undefined ? {} : { error: errors.maxRuntime })}
            />
            <FormField
              id="trigger-idle-timeout"
              label="Idle timeout"
              description="Stops an unresponsive agent, like 10m"
              kind="text"
              name="idleTimeout"
              value={form.idleTimeout}
              onChange={(idleTimeout) => onChange({ ...form, idleTimeout })}
              required
              {...(errors.idleTimeout === undefined ? {} : { error: errors.idleTimeout })}
            />
          </div>
        </Disclosure>
      )}
    </>
  );
}

/** What the reader typed, offered as the directory once it is an absolute path. */
function typedPath(typed: string): ComboboxOption | undefined {
  return typed.startsWith("/")
    ? { value: typed, label: typed, detail: "Use this path" }
    : undefined;
}

/**
 * The projects open on a daemon, as directory suggestions. A daemon that cannot be asked — an
 * older Paseo, a dropped connection — suggests nothing and the reader types the path, so a failed
 * read is not an error anyone has to dismiss.
 */
function useDaemonProjects(organizationSlug: string, daemonId: string | undefined) {
  const load = useServerFn(daemonProjects);
  const query = useSnapshotQuery({
    queryKey: ["daemon-projects", organizationSlug, daemonId],
    enabled: daemonId !== undefined,
    queryFn: () => load({ data: { organizationSlug, daemonId: daemonId! } }),
  });
  const projects = query.data?.projects;
  const options = useMemo<readonly ComboboxOption[]>(
    () =>
      projects?.map((project) => ({
        value: project.rootPath,
        label: project.name,
        detail: project.rootPath,
        keywords: [project.name, project.rootPath],
      })) ?? NO_PROJECTS,
    [projects],
  );
  return { options, loading: daemonId !== undefined && query.status === "pending" };
}
