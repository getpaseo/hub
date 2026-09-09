# Scheduled trigger browser evidence

Captured from the production build by `e2e/schedules.spec.ts`, using a synthetic organization
and a daemon socket fixture. The journey creates a twice-daily schedule, edits it to Monday/Friday,
checks duplicate-time validation and weekly reselection, saves, reloads, and verifies the YAML and
execution settings. At 390px it checks for horizontal overflow.

The fixture moves the persisted next occurrence into the past. The actual Hub clock accepts it,
the ordinary workflow worker dispatches over the socket, and the test waits for one execution to
reach Running before checking Activity. Runtime integration tests separately verify completion,
restart recovery, and two Hub processes with the daemon connection owned by only one process.

- [Daily configuration](daily.png)
- [Weekly configuration after save and reload](weekly.png)
- [Mobile recurrence controls](mobile.png)
- [Scheduled execution in Activity](activity.png)
