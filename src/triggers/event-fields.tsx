/* oxlint-disable eslint-plugin-react-perf/jsx-no-new-function-as-prop -- event controls bind their own configuration */
import { FormField } from "../components/app/form-field.js";
import { browserConfiguration } from "../providers/browser.js";
import type { QualifierKey } from "../providers/configuration.js";
import type { TriggerFieldErrors, TriggerFormValue } from "./configuration/editor.js";
import { ScheduleFields } from "./schedule/fields.js";

/** Source-specific controls live behind the event form boundary. */
export function EventFields({
  value,
  errors,
  onChange,
}: {
  value: TriggerFormValue;
  errors: TriggerFieldErrors;
  onChange: (value: TriggerFormValue) => void;
}) {
  const updateQualifier = (key: QualifierKey, next: string) =>
    onChange({ ...value, qualifiers: { ...value.qualifiers, [key]: next } });
  return (
    <>
      <ScheduleFields
        event={value.event}
        value={value.recurrence}
        error={errors.recurrence}
        onChange={(recurrence) => onChange({ ...value, recurrence })}
      />
      {browserConfiguration.definition(value.event).qualifiers.map((qualifier) => {
        const error = errors[`qualifiers.${qualifier.key}`];
        return (
          <FormField
            key={qualifier.key}
            id={`trigger-qualifier-${qualifier.key}`}
            name={qualifier.key}
            label={qualifier.label}
            description={qualifier.description}
            kind="text"
            value={value.qualifiers[qualifier.key] ?? ""}
            onChange={(next) => updateQualifier(qualifier.key, next)}
            required={qualifier.required}
            {...(error === undefined ? {} : { error })}
          />
        );
      })}
    </>
  );
}
