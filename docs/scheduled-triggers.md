# Scheduled triggers

Choose **Schedule** under **When this happens** in a new organization trigger. Choose **Every day**
or **Every week**, select weekdays for a weekly schedule, add one or more times, and choose the
timezone. For a morning and evening scan, add two times to a daily schedule.

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
      frequency: daily
      times: ["09:00", "17:00"]
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

For weekly recurrence, set `frequency: weekly` and add `days: [monday, wednesday, friday]`.
`times` contains 1–24 distinct `HH:mm` strings in 24-hour time. `days` contains 1–7 distinct,
lowercase weekday names; it is only valid with weekly recurrence. `timezone` is an IANA timezone
name, including `UTC`. A schedule is the document's sole event and has no connection, filters,
or invocation inputs. Other execution settings work normally, including GitHub authority,
provider options, worktrees, continuation and outputs.

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
- If the daemon is offline or connected to another Hub process, workflow work remains queued until
  the process with that connection can dispatch it. The existing maximum runtime still bounds that
  wait. This dispatch behavior applies to all trigger sources.

The first slice supports daily and weekly recurrence. It does not include cron, monthly calendars,
custom intervals, holiday exceptions, or configurable backlog/overlap policies. Exclusion is per
trigger; separately authored triggers can execute simultaneously on the same daemon.

## Ownership and storage

`src/triggers/schedule/` owns recurrence, its controls, clock, context, and `trigger_schedules` state.
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
