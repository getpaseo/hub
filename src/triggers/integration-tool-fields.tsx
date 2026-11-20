/* oxlint-disable eslint-plugin-react-perf/jsx-no-new-function-as-prop, eslint-plugin-react-perf/jsx-no-new-array-as-prop -- each field edits its own integration grant */
import { useState } from "react";
import { CheckboxField } from "../components/app/checkbox-field.js";
import { Combobox } from "../components/app/combobox.js";
import { Disclosure } from "../components/app/disclosure.js";
import { FormField } from "../components/app/form-field.js";
import { integrationActions, integrationProviders } from "../integration-tools/grants.js";
import type {
  IntegrationToolFormValue,
  TriggerFieldErrors,
  TriggerFormValue,
} from "./configuration/editor.js";
import type { TriggerSnapshot } from "./functions.js";

const emptyGrant: IntegrationToolFormValue = { connection: "", actions: [], channels: "" };
const providerNames = { slack: "Slack", discord: "Discord" };

export function IntegrationToolFields({
  tools,
  editReason,
  connections,
  errors,
  onChange,
}: {
  tools: TriggerFormValue["tools"];
  editReason: string | undefined;
  connections: TriggerSnapshot["connections"];
  errors: TriggerFieldErrors;
  onChange: (tools: TriggerFormValue["tools"]) => void;
}) {
  const [open, setOpen] = useState(() => Object.keys(tools).length > 0);
  return (
    <Disclosure
      id="trigger-integration-tools"
      title="Integration tools"
      open={open}
      onOpenChange={setOpen}
    >
      {editReason === undefined ? null : (
        <p className="mb-4 text-sm text-muted-foreground">{editReason}</p>
      )}
      <fieldset disabled={editReason !== undefined} className="grid gap-6 sm:grid-cols-2">
        {integrationProviders.map((provider) => {
          const label = providerNames[provider];
          const value = tools[provider] ?? emptyGrant;
          const id = `trigger-tools-${provider}`;
          const options = [
            { label: `No ${label} tools`, value: "" },
            ...connections
              .filter((connection) => connection.provider === provider)
              .map(({ label: connectionLabel, slug }) => ({ label: connectionLabel, value: slug })),
          ];
          const update = (patch: Partial<IntegrationToolFormValue>) =>
            onChange({ ...tools, [provider]: { ...value, ...patch } });
          const channelsError = errors[`tools.${provider}.channels`];
          const actionsError = errors[`tools.${provider}.actions`];
          return (
            <div key={provider} className="grid content-start gap-4">
              <FormField id={id} label={`${label} integration`}>
                {(control) => (
                  <Combobox
                    {...control}
                    value={value.connection}
                    options={options}
                    placeholder={`Select a ${label} integration`}
                    empty={`No ${label} integrations found.`}
                    onChange={(option) => update({ connection: option.value })}
                  />
                )}
              </FormField>
              {value.connection !== "" && (
                <>
                  <FormField
                    id={`${id}-channels`}
                    label={`${label} channel IDs`}
                    description={
                      provider === "discord"
                        ? "Comma-separated text channel or forum IDs. Threads inherit access from their parent."
                        : "Comma-separated channel IDs."
                    }
                    kind="text"
                    name={`${id}-channels`}
                    value={value.channels}
                    required
                    onChange={(channels) => update({ channels })}
                    {...(channelsError === undefined ? {} : { error: channelsError })}
                  />
                  <fieldset className="grid gap-2">
                    <legend className="sr-only">{label} actions</legend>
                    {integrationActions.map((action) => (
                      <CheckboxField
                        key={action}
                        id={`${id}-${action}`}
                        label={action === "read" ? `Read from ${label}` : `Post to ${label}`}
                        checked={value.actions.includes(action)}
                        onChange={(checked) =>
                          update({
                            actions: checked
                              ? [...value.actions, action]
                              : value.actions.filter((item) => item !== action),
                          })
                        }
                      />
                    ))}
                    {actionsError === undefined ? null : (
                      <p className="text-sm text-destructive">Select at least one action.</p>
                    )}
                  </fieldset>
                </>
              )}
            </div>
          );
        })}
      </fieldset>
    </Disclosure>
  );
}
