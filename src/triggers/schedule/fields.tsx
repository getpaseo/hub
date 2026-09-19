/* oxlint-disable eslint-plugin-react-perf/jsx-no-new-function-as-prop, eslint-plugin-react-perf/jsx-no-new-object-as-prop -- controls bind recurrence input values */
import { useState } from "react";
import { WarningAlert } from "../../components/app/failure-alert.js";
import { FormField } from "../../components/app/form-field.js";
import { CheckboxField } from "../../components/app/checkbox-field.js";
import { Combobox } from "../../components/app/combobox.js";
import { Button } from "../../components/ui/button.js";
import { Input } from "../../components/ui/input.js";
import {
  DEFAULT_RECURRENCE,
  RecurrenceSchema,
  recurrenceSummary,
  type Recurrence,
} from "./recurrence.js";
import {
  DAY_CODES,
  WEEKDAYS,
  FREQUENCIES,
  projectRecurrence,
  ruleFromDraft,
  type RecurrenceDraft,
} from "./form.js";

const TIMEZONES = [...new Set(["UTC", ...Intl.supportedValuesOf("timeZone")])].map((value) => ({
  value,
  label: value,
  keywords: [value.replaceAll("_", " ")],
}));
const DAY_OPTIONS = WEEKDAYS.map((day, index) => ({
  value: DAY_CODES.at(index)!,
  label: day.charAt(0).toUpperCase() + day.slice(1),
}));

export function ScheduleFields(props: {
  event: string;
  value: Recurrence | undefined;
  error: string | undefined;
  onChange: (value: Recurrence) => void;
}) {
  return props.event === "schedule.tick" ? (
    <RecurrenceFields
      value={props.value ?? DEFAULT_RECURRENCE}
      error={props.error}
      onChange={props.onChange}
    />
  ) : null;
}

function RecurrenceFields({
  value,
  error,
  onChange,
}: {
  value: Recurrence;
  error: string | undefined;
  onChange: (value: Recurrence) => void;
}) {
  const [draft, setDraft] = useState(() => projectRecurrence(value));
  const [inputError, setInputError] = useState<string>();
  function changeDraft(next: RecurrenceDraft) {
    setDraft(next);
    try {
      const rule = ruleFromDraft(next);
      setInputError(undefined);
      onChange({ ...value, rule });
    } catch (failure) {
      setInputError(failure instanceof Error ? failure.message : "Check recurrence inputs.");
      onChange({ ...value, rule: "" });
    }
  }
  const validation = RecurrenceSchema.safeParse(value);
  const interval = draft !== null && ["MINUTELY", "HOURLY"].includes(draft.frequency);
  return (
    <div className="grid gap-4">
      {draft === null ? (
        <FormField
          id="schedule-rule"
          label="Custom schedule"
          description="This YAML rule has no matching preset. You can edit it here; other changes preserve it."
        >
          {(control) => (
            <Input
              {...control}
              value={value.rule}
              onChange={(event) => onChange({ ...value, rule: event.target.value })}
            />
          )}
        </FormField>
      ) : (
        <>
          <div className="grid gap-4">
            <FormField id="schedule-frequency" label="Repeat">
              {(control) => (
                <Combobox
                  {...control}
                  value={draft.frequency}
                  options={FREQUENCIES}
                  placeholder="Choose frequency"
                  empty="No frequencies found."
                  onChange={(option) => changeDraft({ ...draft, frequency: option.value })}
                />
              )}
            </FormField>
          </div>
          {draft.frequency === "WEEKLY" ? (
            <FormField id="schedule-days" label="Days of the week">
              {() => (
                <div className="flex flex-wrap gap-4">
                  {DAY_OPTIONS.map(({ value: day, label }) => (
                    <CheckboxField
                      key={day}
                      id={`schedule-${day}`}
                      label={label}
                      checked={draft.days.includes(day)}
                      onChange={(checked) =>
                        changeDraft({
                          ...draft,
                          days: checked
                            ? [...draft.days, day]
                            : draft.days.filter((selected) => selected !== day),
                        })
                      }
                    />
                  ))}
                </div>
              )}
            </FormField>
          ) : null}
          {!interval ? (
            <>
              {draft.times.map((time, index) => (
                // oxlint-disable-next-line eslint-plugin-react/no-array-index-key -- controlled time slots have no child state or reorder operation
                <div key={String(index)} className="flex items-end gap-2">
                  <FormField
                    id={`schedule-time-${String(index)}`}
                    label={`Time ${String(index + 1)}`}
                  >
                    {(control) => (
                      <Input
                        {...control}
                        type="time"
                        required
                        value={time}
                        onChange={(event) =>
                          changeDraft({
                            ...draft,
                            times: draft.times.map((old, ordinal) =>
                              ordinal === index ? event.target.value : old,
                            ),
                          })
                        }
                      />
                    )}
                  </FormField>
                  {draft.times.length > 1 ? (
                    <Button
                      type="button"
                      variant="ghost"
                      aria-label={`Remove time ${String(index + 1)}`}
                      onClick={() =>
                        changeDraft({
                          ...draft,
                          times: draft.times.filter((_, ordinal) => ordinal !== index),
                        })
                      }
                    >
                      Remove
                    </Button>
                  ) : null}
                </div>
              ))}
              <div>
                <Button
                  type="button"
                  variant="outline"
                  disabled={draft.times.length >= 24}
                  onClick={() => changeDraft({ ...draft, times: [...draft.times, "17:00"] })}
                >
                  Add time
                </Button>
              </div>
            </>
          ) : null}
        </>
      )}
      <div className={draft === null ? "grid gap-4 sm:grid-cols-2" : "grid gap-4"}>
        {draft === null ? (
          <FormField
            id="schedule-start"
            label="Starting"
            description="Local date and time used by the custom rule."
          >
            {(control) => (
              <Input
                {...control}
                type="datetime-local"
                step={1}
                value={value.start}
                onChange={(event) =>
                  onChange({
                    ...value,
                    start:
                      event.target.value.length === 16
                        ? `${event.target.value}:00`
                        : event.target.value,
                  })
                }
              />
            )}
          </FormField>
        ) : null}
        <FormField
          id="schedule-timezone"
          label="Timezone"
          description="Repeats follow the local clock in this timezone."
        >
          {(control) => (
            <Combobox
              {...control}
              value={value.timezone}
              options={TIMEZONES}
              placeholder="Choose timezone"
              empty="No timezones found."
              onChange={(option) => onChange({ ...value, timezone: option.value })}
            />
          )}
        </FormField>
      </div>
      {draft === null ? null : (
        <p className="text-sm text-muted-foreground" role="status">
          {validation.success
            ? recurrenceSummary(validation.data)
            : "Complete the recurrence settings."}
        </p>
      )}
      {(inputError ?? error) ? (
        <WarningAlert title="Check the recurrence">{inputError ?? error}</WarningAlert>
      ) : null}
    </div>
  );
}
