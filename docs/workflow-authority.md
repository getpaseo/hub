# Workflow step authority

Workflow authority is authored on an individual step. It is not a trigger option,
agent option, sandbox setting, or Paseo daemon feature.

## Generic connection values

Step environment values may explicitly request a named value from a configured
connection:

```yaml
env:
  SOME_TOKEN: "${{ paseo.connections.some-connection.token }}"
```

The expression shape is exactly
`${{ paseo.connections.<connection-slug>.<named-value> }}`. Hub resolves it while
materializing the selected step, after the project and organization connection
have been verified. The authored expression, not its resolved value, is retained
in configuration and durable launch data. Resolved values are not placed in logs
or diagnostics. This works for manual, Discord, Slack, GitHub, and Linear trigger events.

## GitHub authority

GitHub authority is opt-in and step-scoped:

```yaml
github:
  connection: getpaseo-github
  repositories:
    - getpaseo/paseo
  permissions:
    contents: write
    pull_requests: write
    issues: read
  duration: 1h
```

`connection` is the configured connection slug. It must be active and belong to
the execution project's organization. `repositories` uses GitHub's repository
scope and accepts full `owner/name` values whose owner must match the selected
connection account login case-insensitively. For non-GitHub triggers it is required;
Hub never expands an omitted list to every repository in an installation. For a
GitHub event only, omitting it deterministically scopes the token to that event's
repository. An explicit list is recommended when the step is invoked by more than
one source. Hub validates the full names for the authored contract and passes the
repository names in GitHub's native installation-token request format.

`permissions` uses GitHub App installation-token permission names and levels
directly. It defaults to `{ contents: read }`. Hub validates against its explicitly
versioned copy of GitHub REST API version `2026-03-10`; unsupported names or levels
fail configuration activation with a path to the offending field. Hub forwards only
the authored repository and permission restrictions to GitHub.

`duration` defaults to `1h`, matching GitHub's fixed installation-token lifetime.
Positive shorter durations are supported; Hub revokes the token at the lease
deadline and always revokes it when the execution reaches a terminal state.
Durations above `1h` are rejected.

If the block is absent, Hub does not mint a GitHub token and does not add
`GH_TOKEN` or Git environment variables, regardless of the trigger provider.
When present, the selected step receives only ordinary environment variables:

- `GH_TOKEN` with the fresh restricted installation token;
- indexed `GIT_CONFIG_*` entries for the bot identity, HTTPS rewriting of both
  supported SSH GitHub URL forms, and `!gh auth git-credential`;
- `GIT_CONFIG_GLOBAL=/dev/null`, `GIT_CONFIG_NOSYSTEM=1`, and
  `GIT_TERMINAL_PROMPT=0`.

The bot identity is resolved from `GET /users/{app-slug}[bot]` and cached at the
application level. GitHub's returned bot user ID and login form the identity
`{bot-user-id}+{bot-login}@users.noreply.github.com`.

The reserved Git environment keys cannot be authored alongside a `github` block;
activation fails instead of making precedence order observable. Authority is
materialized independently for each running step. Classifier and skipped steps do
not receive it, and no Git-specific RPC field is sent to Paseo.

Hub persists materialized authority and credential leases before delivering credentials to
an agent. A Hub restart preserves active executions and their original credentials; recovery
reattaches the same agent and restores lease deadlines and pending revocation work. Stopping
the Hub process does not end an execution or revoke its credentials.

Completion, cancellation, and the original lease deadline still require revocation. Recovery
does not mint replacement credentials or extend deadlines. If Hub is unavailable at a shorter
lease deadline, it reconciles overdue revocation when it returns; upstream expiry remains the
maximum token lifetime. Revocation failures remain durable and retry until upstream expiry.

Resolved credentials are private runtime data in the Hub database, separate from authored
configuration. Authority records are removed at execution termination; lease records remain
only until revocation succeeds or the token expires.

When upgrading from a version with process-owned credentials, let active credentialed runs
finish before restarting Hub. That version cannot hand its in-memory leases to the replacement.

Public workflow-authority guidance lives in the Paseo repository under `public-docs/`.
