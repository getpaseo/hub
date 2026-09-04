/* oxlint-disable eslint-plugin-react-perf/jsx-no-new-function-as-prop -- qualifier controls bind the definition and value rendered beside them */
import { FormField } from "../components/app/form-field.js";
import {
  eventDefinition,
  type EditorEvent,
  type QualifierKey,
  type QualifierValues,
} from "./configuration/events.js";
import type { TriggerFieldErrors } from "./configuration/editor.js";

/** Event definitions provide the fields; this component only renders their controls. */
export function EventFields({
  event,
  values,
  errors,
  onChange,
}: {
  event: EditorEvent;
  values: QualifierValues;
  errors: TriggerFieldErrors;
  onChange: (values: QualifierValues) => void;
}) {
  const update = (key: QualifierKey, value: string) => onChange({ ...values, [key]: value });
  return eventDefinition(event).qualifiers.map((qualifier) => {
    const error = errors[`qualifiers.${qualifier.key}`];
    return (
      <FormField
        key={qualifier.key}
        id={`trigger-qualifier-${qualifier.key}`}
        name={qualifier.key}
        label={qualifier.label}
        description={qualifier.description}
        kind="text"
        value={values[qualifier.key] ?? ""}
        onChange={(next) => update(qualifier.key, next)}
        required={qualifier.required}
        {...(error === undefined ? {} : { error })}
      />
    );
  });
}
