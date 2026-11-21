/* oxlint-disable eslint-plugin-react-perf/jsx-no-new-function-as-prop -- the audience controls bind the trigger they belong to */
import { useMemo, useState } from "react";

import { Disclosure } from "../components/app/disclosure.js";
import { FormField } from "../components/app/form-field.js";
import { SegmentedControl, type SegmentedOption } from "../components/app/segmented-control.js";
import type { TriggerFieldErrors, TriggerFormValue } from "./configuration/editor.js";
import { eventDefinition, type TriggerAudience } from "./configuration/events.js";

const AUDIENCES: Record<TriggerAudience, { label: string; hint?: string }> = {
  members: {
    label: "Members",
    hint: "Repository owners, organization members, and collaborators",
  },
  contributors: {
    label: "Contributors",
    hint: "Members, and anyone with a commit already merged into the repository",
  },
  everyone: { label: "Everyone", hint: "Anyone the connection receives this event from" },
  specific: { label: "Specific people" },
};

/**
 * Who may invoke the trigger. Every event starts on an audience that is safe to leave alone, so
 * the choice sits closed under the event and its header reads the current answer.
 *
 * An event Hub raises itself has no outside sender and renders nothing.
 */
export function AudienceFields({
  value,
  errors,
  onChange,
}: {
  value: TriggerFormValue;
  errors: TriggerFieldErrors;
  onChange: (value: TriggerFormValue) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const { audiences } = eventDefinition(value.event);
  const options = useMemo<SegmentedOption[]>(
    () =>
      audiences.map((audience) => ({
        value: audience,
        ...AUDIENCES[audience],
      })),
    [audiences],
  );
  if (audiences.length === 0) return null;
  const error = errors.allowedUsers;
  return (
    <Disclosure
      id="trigger-audience"
      title="Advanced"
      description={`Audience: ${AUDIENCES[value.audience].label}`}
      // A field that is in the way of saving is never left behind a closed header.
      open={expanded || error !== undefined}
      onOpenChange={setExpanded}
    >
      <div className="grid gap-4">
        <SegmentedControl
          label="Audience"
          description="Who can run this trigger"
          value={value.audience}
          options={options}
          onChange={(next) => {
            const audience = audiences.find((candidate) => candidate === next);
            if (audience !== undefined) onChange({ ...value, audience, allowedUsers: "" });
          }}
        />
        {value.audience === "specific" ? (
          <FormField
            id="trigger-allowed-users"
            label="User IDs"
            description="Comma-separated provider user IDs"
            kind="text"
            name="allowedUsers"
            value={value.allowedUsers}
            onChange={(allowedUsers) => onChange({ ...value, allowedUsers })}
            required
            {...(error === undefined ? {} : { error })}
          />
        ) : null}
      </div>
    </Disclosure>
  );
}
