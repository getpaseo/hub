# Scheduled triggers

Choose **Schedule** under **When this happens** in a new organization trigger. Choose **Every
minute**, **Every hour**, **Every day**, or **Every week**. Each preset means exactly that frequency;
there is no second interval setting. Daily and weekly schedules accept one or more times. Weekly
schedules also select days of the week. Choose a timezone for those times.

Author custom intervals and calendar rules in YAML. When a rule has no matching preset, the form
shows a **Custom schedule** rule field with its start and timezone. You can edit the rule there;
changes to other execution settings preserve it exactly.

Then choose the daemon, working directory, provider/model, execution mode, thinking, and instructions
as usual. GitHub access uses the same connection, repository, permission, and duration controls as
other triggers. Hub mints the existing scoped installation token for each execution; a schedule
requires no stored bot token. Save the trigger to enable its next future occurrence. The form and
trigger list summarize the selected recurrence, and the YAML view preserves it when you edit/save.
Choose **New agent** continuity when using temporary GitHub access, as with other triggers.

## YAML and API

Scheduling uses the existing standalone trigger validation, installation and listing APIs. For
example, submit this document as the `yaml` field to `POST /api/v1/triggers/validate` and
`POST /api/v1/triggers/install`. Installing again replaces the trigger with the same name:

```yaml
name: periodic-review
enabled: true
on:
  schedule.tick:
    recurrence:
      start: "2026-09-09T09:00:00"
      rule: "FREQ=DAILY;BYHOUR=9,17"
      timezone: Europe/Berlin
run:
  target:
    daemon: your-daemon
    cwd: /workspace/project
  agent:
    provider: codex
    mode: full-access
  prompt: |
    Review new reports and summarize items that need attention.
    Scheduling context: ${{ paseo.context }}
  max_runtime: 2h
  idle_timeout: 10m
```

The persisted recurrence has three fields: `start` is a quoted local date-time with seconds and
no offset; `timezone` gives that clock's IANA timezone; `rule` is one RFC 5545 RRULE value, without
the `RRULE:` prefix. The anchor determines interval alignment and omitted calendar/time fields.
It is a lower bound, not an extra occurrence inserted outside the rule.

These rules all use the same representation:

| Recurrence                    | `rule`                                | Example `start`       |
| ----------------------------- | ------------------------------------- | --------------------- |
| Every hour                    | `FREQ=HOURLY`                         | `2026-09-09T09:00:00` |
| Every 90 minutes              | `FREQ=MINUTELY;INTERVAL=90`           | `2026-09-09T09:00:00` |
| Daily at 09:00 and 17:00      | `FREQ=DAILY;BYHOUR=9,17`              | `2026-09-09T09:00:00` |
| Every other Monday and Friday | `FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,FR`  | `2026-09-07T09:00:00` |
| Last Friday at 17:00          | `FREQ=MONTHLY;BYDAY=-1FR`             | `2026-09-25T17:00:00` |
| Last day of each month        | `FREQ=MONTHLY;BYMONTHDAY=-1`          | `2026-09-30T09:00:00` |
| February 29                   | `FREQ=YEARLY;BYMONTH=2;BYMONTHDAY=29` | `2028-02-29T09:00:00` |
| Ten hourly occurrences        | `FREQ=HOURLY;COUNT=10`                | `2026-09-09T09:00:00` |

The simple controls generate standard RRULE fields, including `BYSETPOS` when necessary to preserve exact
pairs such as 08:15 and 16:45 without adding 08:45 and 16:15. No form layout or preset identifier is
stored. Rules beyond the simple presets appear in the **Custom schedule** field, including when
other execution settings change. Custom intervals, monthly/yearly patterns, and finite rules
remain fully supported by YAML/API; they are not expanded into extra form controls.

A schedule is the document's sole event and has no connection, filters or invocation inputs.
Other execution settings work normally, including GitHub authority, provider options, worktrees,
continuation and outputs.

`${{ paseo.context }}` contains a `schedule` object with `trigger_id`, `scheduled_at` (the intended
UTC occurrence), and `timezone`. History identifies the source as `schedule.tick`. Each occurrence
has its own durable identity; it is never represented as an external user's manual action.

## Timing and recovery

- Creation, re-enabling, and recurrence changes start at the next future occurrence. Changing only
  execution settings preserves the next occurrence. Accepted runs retain their original revision.
- The Hub clock checks once per second. Dispatch can happen later, depending on load and daemon
  connectivity. These are calendar times, not precise execution deadlines.
- After downtime, one catch-up run represents the earliest missed occurrence, then the clock advances
  beyond the current time. Hub does not replay every missed scan.
- While a scheduled run remains active, including while it waits for a daemon, Hub skips due
  occurrences. It does not queue a parallel run or accumulate a backlog. Failed and completed runs
  release this exclusion. A disabled trigger stops future occurrences and leaves accepted runs alone.
  Disabling/re-enabling or editing a trigger preserves exclusion for its accepted run.
- Times follow the selected timezone's local calendar. A local time missing during a daylight-saving
  jump is skipped. A local time repeated when clocks turn back runs only at its earlier instant.
  Minute/hour intervals follow this local clock too; use UTC for elapsed-time intervals across DST.
  Missing dates, such as February 31, are skipped. `COUNT` counts valid recurrence occurrences
  since the anchor, including occurrences before enablement or skipped because a run was active;
  it does not count successful executions. Missing DST times do not consume it. `UNTIL` is an
  inclusive UTC date-time, such as `UNTIL=20261231T235959Z`. Exhausted rules have no next occurrence.
  An already-persisted overdue final occurrence still receives the normal one catch-up run.
- If the daemon is offline or connected to another Hub process, workflow work remains queued until
  the process with that connection can dispatch it. The existing maximum runtime still bounds that
  wait. This dispatch behavior applies to all trigger sources.

The feature accepts a single RRULE, without exception calendars, multiple-rule unions or custom
backlog/overlap policies. `COUNT` and `INTERVAL` are limited to 10,000 and rules to 2,048 characters;
recurrence evaluation is bounded. Invalid fields, combinations and rules with no reachable
occurrence are rejected. Exclusion is per trigger; separately authored triggers can execute
simultaneously on the same daemon. The earlier daily/weekly YAML shape in this unreleased PR is
replaced by the three-field representation above.

## Ownership and storage

`src/triggers/schedule/` owns recurrence, its controls, clock, context, and `trigger_schedules` state.
The recurrence document is independent of the form. `rrule-temporal` expands calendar candidates;
a small adapter resolves wall times through Temporal, skips gaps, chooses the earlier fold and
applies finite limits to valid occurrences. RFC month/year anchor defaults are explicit so invalid
month dates are skipped instead of constrained. The operational table stores the recurrence,
next occurrence and active run; exhausted schedules use a null next occurrence.

Trigger save synchronizes this state within its existing transaction. A clock tick locks the owning
trigger and scheduling state, then atomically writes the provider receipt, ordinary workflow run,
steps, wakeup, next occurrence, and active-run link. Workflow intake is shared with other sources.
Any failure rolls back the entire occurrence; another Hub instance cannot accept it concurrently.

Occurrence generation is separate from execution ownership. The ordinary workflow worker checks
whether its process has the resolved daemon connection before creating an execution or consuming
its execution allowance. It releases unavailable work for another worker while preserving lease
recovery information. Scheduling adds no transport, credentials path, or external infrastructure.
Both PostgreSQL and the supported single-process embedded runtime use the same scheduling repository.

Daemon-native schedules remain independent. Hub never creates, edits, or synchronizes them.
