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
or diagnostics. This works for manual, Discord, Slack, GitHub, Linear, and Forgejo trigger events.

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

## Forgejo credentials

Forgejo and Gitea have no authority block. A Forgejo connection holds an ordinary access
token belonging to an operator-chosen account on the instance. Forgejo has no GitHub-App
analogue: no installation, no app-owned bot identity, no endpoint that mints a
short-lived token scoped to named repositories and permissions.

|                | GitHub                             | Forgejo                                       |
| -------------- | ---------------------------------- | --------------------------------------------- |
| Token lifetime | minted per step, `1h` or less      | as long as the operator's token lives         |
| Scope          | named repositories and permissions | whatever the token already carries            |
| Revocation     | Hub revokes at the lease deadline  | only the operator can revoke, on the instance |

Hub cannot revoke a Forgejo token, so it never registers one as a credential lease: a
lease promises both an expiry and a working revoke, and this token has neither.

A Forgejo token reaches a step only when the author asks for it by name, through the
generic connection value above:

```yaml
env:
  FORGEJO_TOKEN: "${{ paseo.connections.acme-forge.token }}"
```

Nothing else is injected: no `GH_TOKEN` equivalent, no Git credential helper, no commit
identity. A step that clones from Forgejo configures Git itself from that variable, so
the weaker guarantee stays visible in the workflow instead of hidden in Hub.

The same connection also publishes `url` (the instance base URL) and `login` (the
connected account) as plain, non-secret values:

```yaml
env:
  FORGEJO_URL: "${{ paseo.connections.acme-forge.url }}"
  FORGEJO_LOGIN: "${{ paseo.connections.acme-forge.login }}"
```

### What connecting costs the operator

Forgejo has no app installation, so Hub asks the instance to create one webhook covering
every repository instead of one per repository:

- **One webhook per user or organization.** "Repositories owned by
  &lt;accountLogin&gt;" registers a user-level hook (`POST /user/hooks`), covering only
  repositories that account owns directly. Choosing an organization instead registers an
  org-level hook (`POST /orgs/{org}/hooks`) for that org's own repositories. Subscribing
  again for the same target replaces the old hook instead of adding a second one:
  Forgejo has no way to tell Hub a hook it finds already carries the right secret, so the
  new hook is created first and the old one deleted after, which can briefly deliver to
  both.
- **CI run events need Forgejo 12 or later.** Hub only asks for
  `forgejo.action_run_failure` and `forgejo.action_run_success` on such instances. A hook
  created before the instance was upgraded does not have them, so subscribe again (safe to
  repeat). Gitea is never asked for them, since nobody tested it.
- **Scopes needed to subscribe.** Repository and issue read/write cover the events
  themselves. Subscribing to the account's own repositories also needs `write:user`;
  subscribing to an organization needs `write:organization` plus the operator owning that
  org on the instance. A token missing the scope gets a clear refusal, not a hook that
  silently never arrives.
- **Disconnecting deletes what Hub created, best effort.** A delete that fails, because
  the instance is unreachable or the token was already rotated, is logged and does not
  block the disconnect.
- **A connection never triggers on its own writes.** A workflow's own comments, labels, or
  reactions come back to Hub as deliveries sent by that same account. Hub drops them
  before they reach a trigger. It also drops deliveries sent by any other Forgejo account
  the organization connected on the same instance, so two bots can't feed each other.
  Use a dedicated bot account if a human needs to keep triggering workflows.
- **Two connections on one instance need a `connection` filter.** When more than one
  connection could route a trigger, Hub refuses to save it until the trigger names one.
  Otherwise one real event would fire it once per connection.
- **The manual per-repository path still works.** An operator who does not want to grant
  the wider scope adds the target URL and secret Hub shows to the repository's own
  Settings, Webhooks. Both paths can be used side by side.
- **The token otherwise carries whatever it carried.** Forgejo has no way to narrow a
  token beyond the scopes above; the rest is whatever the operator granted it on the
  instance.
- **Plain http instance addresses are accepted.** A LAN-only instance reached over http is
  not turned away.
- **Private or internal addresses need the operator's say-so.** Hub refuses to dial a
  loopback, RFC1918, link-local, or otherwise non-routable host by default, whether typed
  literally or reached by DNS. The operator opts a host or network back in with
  `FORGEJO_ALLOWED_PRIVATE_HOSTS`, a comma-separated list of hostnames and/or IPv4/IPv6
  CIDRs (see `.env.example`). A blocked address fails with a message naming the variable,
  on connect and on every later request.
- **Gogs is refused at connect.** Gogs has no version endpoint to tell it apart from an
  unrecognized instance, so Hub refuses the connection instead of guessing.

Public workflow-authority guidance lives in the Paseo repository under `public-docs/`.
