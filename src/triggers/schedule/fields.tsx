/* oxlint-disable eslint-plugin-react-perf/jsx-no-new-function-as-prop, eslint-plugin-react-perf/jsx-no-new-object-as-prop -- recurrence controls bind the selected day and time */
import { WarningAlert } from "../../components/app/failure-alert.js";
import { FormField } from "../../components/app/form-field.js";
import { CheckboxField } from "../../components/app/checkbox-field.js";
import { Combobox } from "../../components/app/combobox.js";
import { Button } from "../../components/ui/button.js";
import { Input } from "../../components/ui/input.js";
import {
  DEFAULT_RECURRENCE,
  WEEKDAYS,
  RecurrenceSchema,
  recurrenceSummary,
  type Recurrence,
} from "./recurrence.js";

const FREQUENCIES = [
  { value: "daily", label: "Every day" },
  { value: "weekly", label: "Every week" },
];
const TIMEZONES = [...new Set(["UTC", ...Intl.supportedValuesOf("timeZone")])].map((value) => ({
  value,
  label: value,
  keywords: [value.replaceAll("_", " ")],
}));

export function ScheduleFields({
  event,
  value = DEFAULT_RECURRENCE,
  error,
  onChange,
}: {
  event: string;
  value: Recurrence | undefined;
  error: string | undefined;
  onChange: (value: Recurrence) => void;
}) {
  if (event !== "schedule.tick") return null;
  const validation = RecurrenceSchema.safeParse(value);
  return (
    <div className="grid gap-4">
      <div className="grid gap-4 sm:grid-cols-2">
        <FormField id="schedule-frequency" label="Repeat">
          {(control) => (
            <Combobox
              {...control}
              value={value.frequency}
              options={FREQUENCIES}
              placeholder="Choose frequency"
              empty="No frequencies found."
              onChange={(option) => {
                if (option.value === value.frequency) return;
                onChange(
                  option.value === "weekly"
                    ? { ...value, frequency: "weekly", days: ["monday"] }
                    : { frequency: "daily", times: value.times, timezone: value.timezone },
                );
              }}
            />
          )}
        </FormField>
        <FormField
          id="schedule-timezone"
          label="Timezone"
          description="Times follow the local clock in this timezone."
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
      {value.frequency === "weekly" ? (
        <FormField id="schedule-days" label="Days of the week">
          {() => (
            <div className="flex flex-wrap gap-4">
              {WEEKDAYS.map((day) => (
                <CheckboxField
                  key={day}
                  id={`schedule-${day}`}
                  label={day.charAt(0).toUpperCase() + day.slice(1)}
                  checked={value.days.includes(day)}
                  onChange={(checked) =>
                    onChange({
                      ...value,
                      days: checked
                        ? [...value.days, day]
                        : value.days.filter((selected) => selected !== day),
                    })
                  }
                />
              ))}
            </div>
          )}
        </FormField>
      ) : null}
      {value.times.map((time, index) => (
        // oxlint-disable-next-line eslint-plugin-react/no-array-index-key -- controlled time slots have no child state or reorder operation
        <div key={index} className="flex items-end gap-2">
          <FormField id={`schedule-time-${String(index)}`} label={`Time ${String(index + 1)}`}>
            {(control) => (
              <Input
                {...control}
                type="time"
                required
                value={time}
                onChange={(change) =>
                  onChange({
                    ...value,
                    times: value.times.map((old, ordinal) =>
                      ordinal === index ? change.target.value : old,
                    ),
                  })
                }
              />
            )}
          </FormField>
          {value.times.length > 1 ? (
            <Button
              type="button"
              variant="ghost"
              aria-label={`Remove time ${String(index + 1)}`}
              onClick={() =>
                onChange({ ...value, times: value.times.filter((_, ordinal) => ordinal !== index) })
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
          disabled={value.times.length >= 24}
          onClick={() => onChange({ ...value, times: [...value.times, "17:00"] })}
        >
          Add time
        </Button>
      </div>
      <p className="text-sm text-muted-foreground" role="status">
        {validation.success
          ? recurrenceSummary(validation.data)
          : "Choose days, distinct times, and a timezone."}
      </p>
      {error === undefined ? null : (
        <WarningAlert title="Check the recurrence">{error}</WarningAlert>
      )}
      <p className="text-xs text-muted-foreground">
        After downtime, one catch-up run. Occurrences during an active run are skipped. Missing
        daylight-saving times are skipped; repeated times run once.
      </p>
    </div>
  );
}
