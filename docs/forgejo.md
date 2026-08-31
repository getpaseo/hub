# Forgejo provider operations

Forgejo is a first-class Hub provider for self-hosted Forgejo instances running version
`16.0.3` or later. Hub preserves Forgejo's own origin, token, repository, and webhook
boundaries. It does not treat a Forgejo connection as a GitHub installation or substitute a
GitHub token, API, or webhook format.

## Roles and instance approval

Forgejo setup is intentionally split between two roles:

- An instance operator approves one canonical HTTPS Forgejo origin and can check its health.
- An organization owner creates a connection by choosing the approved `instanceId`, then enrolls
  only the repositories that connection may use.

Organization owners cannot enter an arbitrary Forgejo URL as part of a connection. The instance
operator approval is the boundary that verifies the origin and supported version before it becomes
selectable. Approve a private-network origin only when the Hub deployment is intentionally allowed
to reach it; do not expose a private Forgejo instance merely to make it reachable.

The public configuration and setup resource for a connection is limited to `slug`, `instanceId`,
`accountLogin`, and enrolled `repositories`. It does not disclose the approved origin or any
credential.

## Connect and enroll repositories

Create a Forgejo personal access token that is restricted to the repositories the connection will
use. Hub accepts `read:issue` or `write:issue` together with `read:repository` or
`write:repository`; it rejects OAuth2 credentials, passwords, unscoped tokens, and unrelated
scopes. Start with read scopes and add write scopes only when the configured workflows need to
write issues, comments, reactions, or repository contents.

In Hub, an organization owner selects the approved instance, chooses a connection slug, supplies
the claimed Forgejo username and repository-limited PAT, then enrolls the explicit repository
subset. A connection is not an organization-wide or instance-wide grant. Rotate the connection
PAT when its upstream scope, repository limit, or identity changes, and revoke it when the
connection must no longer receive provider events.

## Webhooks

After repositories are enrolled, choose one webhook setup mode for the connection:

- **Automatic:** supply a one-time webhook-admin PAT with permission to manage webhooks in the
  enrolled repositories. Hub creates or reconciles the managed hooks, verifies them, and discards
  the supplied admin PAT after the operation.
- **Manual:** Hub returns a callback URL and webhook secret. Configure a webhook in each enrolled
  Forgejo repository with those exact values, then retain the secret in the repository's webhook
  configuration rather than in source control.

Both modes use the required Forgejo webhook families: `push`, `issues`, `issue_comment`,
`pull_request`, `pull_request_review`, and `pull_request_review_comment`. Hub verifies the
Forgejo delivery signature before accepting an event. A successful delivery can also confirm a
manual hook that was waiting for its first signed event.

Rotate the webhook secret when it is exposed or when the webhook configuration changes. Rotation
requires a one-time webhook-admin PAT so Hub can update managed hooks. Manual hooks remain under
the operator's control and must be updated with the replacement secret.

## Configuration source

Select **Forgejo** in a project's configuration source controls, then choose one enrolled
repository. Hub records the source as kind `forgejo`, reads the Hub bundle from the selected
repository's default branch, and records the exact commit used for each synchronization. A push to
that source branch can trigger a synchronization; the project also offers an explicit sync action.

The selected repository becomes the configuration authority until the project is switched to a
different source. Do not put a Forgejo origin, PAT, or webhook secret into the bundle. The source
connection and repository selection establish that boundary.

## Triggers and reactions

Forgejo accepts the following raw trigger families:

- `forgejo.issues`
- `forgejo.issue_comment`
- `forgejo.pull_request`
- `forgejo.pull_request_review`
- `forgejo.pull_request_review_comment`
- `forgejo.push`

The trigger editor also exposes semantic events for newly created issues, pull requests, issue
comments, pull-request comments, and labels: `forgejo.issue_created`,
`forgejo.pull_request_created`, `forgejo.issue_comment_created`,
`forgejo.pull_request_comment_created`, `forgejo.issue_label_added`, and
`forgejo.pull_request_label_added`. Use the semantic event when the workflow should react to that
specific action; use a raw family only when the workflow intentionally handles the wider Forgejo
event family.

Hub can reflect run progress with `eyes`, `+1`, and `-1` reactions where the Forgejo event subject
accepts reactions. Reactions require the connection PAT to retain `write:issue` for the enrolled
repository. A missing or unsupported reaction target does not grant extra provider authority and
does not change the workflow's recorded result.

## Step authority

Use a `forgejo:` block on a workflow step when that step needs to read or change Forgejo state.
The block names an active connection, an enrolled repository list, and `contents`/`issues` levels.
It is not inherited by other steps. For a Forgejo-triggered step, omitting `repositories` means
only the event repository; every other trigger must name repositories explicitly. See
[workflow authority](workflow-authority.md#forgejo-authority) for the complete contract.

The execution PAT is separate from the connection PAT and is configured explicitly through the
connection lifecycle controls. Hub checks its scopes and repository boundary before materializing
the authority for a step. This prevents a workflow from broadening access beyond the PAT that its
organization owner supplied.

## Health, rotation, and cleanup

Instance, connection, repository, and hook health are visible in the Forgejo settings panels.
Use an instance health check after an origin, certificate, DNS, or Forgejo upgrade change. A
connection can become degraded when its repository-limited PAT no longer works; rotate or replace
that PAT, then recheck health. An identity-drifted or incompatible instance requires operator
review before organizations continue using it.

Before disconnecting, inspect the impact preview. Hub blocks future Forgejo execution and tries to
remove managed webhooks. Manual webhooks are preserved. If remote removal cannot finish, the
disconnect result reports `REMOTE_CLEANUP_PENDING`. Supply a one-time webhook-admin PAT through
**Resume remote cleanup** to remove the remaining managed hook. That PAT is used for the recovery
operation only; it is not a replacement connection credential.

## Troubleshooting

| Symptom                                                   | Check and remediation                                                                                                                                    |
| --------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| No approved instance is selectable                        | Ask an instance operator to approve the canonical HTTPS origin and confirm Forgejo `16.0.3` or later.                                                    |
| The PAT is rejected                                       | Use a repository-limited PAT with an issue scope and a repository scope. OAuth2, passwords, unscoped tokens, and unrelated scopes are rejected.          |
| A repository is missing from setup or configuration       | Confirm that the connection PAT can see it, then enroll that repository explicitly before selecting it.                                                  |
| Webhooks are not receiving events                         | Confirm the selected repositories, callback URL, secret, and required event families. For automatic mode, rerun setup with a one-time webhook-admin PAT. |
| Reactions do not appear                                   | Check that the event subject supports reactions and that the connection PAT has `write:issue` for that enrolled repository.                              |
| Health shows `degraded`, `unreachable`, or identity drift | Check the approved origin's reachability and identity as the instance operator; rotate a changed or revoked connection PAT.                              |
| Disconnect reports `REMOTE_CLEANUP_PENDING`               | Use **Resume remote cleanup** with a one-time webhook-admin PAT. Do not create a broader permanent connection just to remove a managed webhook.          |
