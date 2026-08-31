# Public API

Hub exposes organization-scoped operator operations under `/api/v1`:

| Operation                                   | Scope                    | Endpoint                                 |
| ------------------------------------------- | ------------------------ | ---------------------------------------- |
| List active projects                        | `projects:read`          | `GET /api/v1/projects`                   |
| Validate configuration without writing      | `configuration:validate` | `POST /api/v1/configurations/validate`   |
| List resolvable configuration resources     | `configuration:validate` | `GET /api/v1/configuration-resources`    |
| Install and activate configuration          | `configuration:install`  | `POST /api/v1/configurations/install`    |
| Dispatch a durable manual run               | `runs:dispatch`          | `POST /api/v1/manual-runs`               |
| Issue a short-lived daemon enrollment token | `daemons:enroll`         | `POST /api/v1/daemons/enrollment-tokens` |

Create a scoped API key in the Hub dashboard or approve `paseo hub login` in the browser, then send the resulting organization credential as `Authorization: Bearer <credential>`. CLI credentials carry all current operator scopes, are stored server-side only as verifiers, and can be revoked under Settings → API keys → CLI logins. They are not daemon credentials.

CLI login starts anonymously at `POST /api/v1/cli-authorizations` and polls at `POST /api/v1/cli-authorizations/poll`. An authenticated owner or admin explicitly approves the active organization at `/cli-login`. The expiring grant is poll-throttled and discloses its durable credential exactly once. Daemons enroll only through the short-lived, single-use token issued by the authenticated enrollment-token operation. A daemon may connect with no permissions and remain available for identity and presence only; only daemons that explicitly grant `hub.execute` are eligible workflow targets.

The canonical, executable operation and schema reference is served by each Hub instance at `/api/reference`; its OpenAPI 3.1 document is `/api/openapi.json`. There are no unversioned operator aliases.

Every canonical `/api/v1` response, including unknown paths and wrong methods, uses RFC 9457 `application/problem+json` on failure and includes `X-Request-ID`; callers may supply that header to correlate a request. Wrong methods return `405` with `Allow`, while unknown paths return `404`. Every `401` response also includes `WWW-Authenticate: Bearer`.

Configuration YAML may include an optional top-level `name` slug as deployment metadata. An explicit request `projectSlug` (including the CLI's `--project`/`-p` option) is authoritative. Otherwise Hub resolves or creates the named project in the authenticated organization; without either field, it resolves or restores that organization's `default` project. Changing `name` targets a different project and leaves the old project's history intact.

Configuration validation and installation accept the same YAML, optional `projectSlug`, and prompt-partial bundle. Both use the same parser, compiler, project selection, daemon/provider resolution, and business validation. Validation returns the resolved `projectSlug` and `wouldCreateProject` without creating a project, recording a revision, or changing active configuration. Installation silently creates a missing bundle-named or default project, then records and activates the revision.

## Workflow MCP tools

Hub sends each daemon the authored rendered prompt unchanged. Execution tools are exposed through the provider-native Hub MCP server and its exact tool policy; Hub does not prepend a tool inventory or otherwise rewrite the prompt. Completion is exposed as `finish_execution`; allowed and materialized output tools use their registered names, such as `reply`. For structured-output steps, `finish_execution` accepts the configured result under `output`. Completing an execution does not necessarily complete the whole workflow.

## Trigger prompt and optional context

`${{ paseo.prompt }}` is exactly the complete text received by any textual trigger, including provider mentions, command markers, typed-input headers, and whitespace. Parsing those elements can select a trigger or populate `${{ paseo.inputs }}`, but never rewrites the prompt. Structured manual input without a textual prompt produces an empty string. `${{ paseo.context }}` is a separate opt-in merge value containing safe ambient provider data. Each workflow step opts in independently: a step that does not author `${{ paseo.context }}` receives no ambient context, no automatic attachment list, and no prompt mutation. Context history and attachment descriptors are fetched and materialized only when an opting step launches; attachment descriptors are Hub URLs scoped to that execution. Provider credentials, raw tokens, private provider download URLs, and unrelated webhook fields are not exposed. There is no alias or fallback for the removed automatic prompt behavior.

Daemon environments may author `worktree.newBranch: "trigger-${{ paseo.execution.id }}"` for a stable branch name unique to each agent execution. Hub materializes the execution UUID before persisting or dispatching the launch intent; recovery reuses that fully rendered intent. This is independent of whether a manual, Slack, Discord, GitHub, or Linear trigger selected the reusable environment. No prompt, context, input, value, step output, or provider event namespace is available in environment configuration, and unsupported expressions fail bundle activation at the authored `newBranch` field.

## Workspace affinity

Workspace affinity is an explicit, step-scoped opt-in for a daemon workspace shared by related
trigger arrivals. For example, an agent that replies to Slack threads can retain one workspace per
thread:

```yaml
triggers:
  - name: respond-to-slack
    on: slack.mention
    max_runtime: 2h
    steps:
      - id: respond
        environment: runner
        max_runtime: 30m
        idle_timeout: 5m
        auto_archive: true
        workspace_affinity:
          key: "slack-thread:${{ paseo.trigger.conversation_key }}"
        agent: { provider: codex }
        prompt: [{ text: "Respond to the thread." }]
```

`paseo.trigger.conversation_key` is a provider-authenticated identifier, not prompt text. Slack
keys identify the connection, workspace, channel, and root thread; Discord keys identify the
connection, guild, channel, and thread (or its starter message); GitHub keys identify the
connection, repository, issue or pull request, and number. A key may also be a literal custom key,
or be composed from finite declared inputs, values, and outputs. Prompt text, ambient context, the
execution ID, and unbounded values are rejected so an untrusted event cannot select an existing
workspace.

Hub sends only the opaque key and the triggering workflow's `max_runtime` deadline. Daemons that
support workspace affinity acknowledge the request, hash and persist their key-to-workspace
mapping, and reuse an active workspace or restore it if it was archived. Each matching arrival
extends retention to the later workflow deadline. With `auto_archive: true`, a supporting daemon
archives the workspace at that retained deadline—not at `idle_timeout`. `idle_timeout` remains an
in-execution liveness deadline. With `auto_archive: false`, Hub does not request affinity-driven
workspace archiving.

Workspace affinity is a progressive daemon capability. Older daemons safely ignore the optional
request and continue creating and archiving fresh workspaces with their existing behavior; Hub does
not reject those executions or require an immediate daemon upgrade. Exact reuse, retention, and
archived-workspace restoration begin after the daemon is updated to a version that acknowledges
workspace affinity.

Affinity does not serialize matching executions: each gets its own agent in the shared workspace.
All uses of a key must keep the same daemon target, cwd, worktree target, and auto-archive policy;
the daemon rejects a mismatch rather than mixing state. In particular, an execution-ID-derived
worktree branch is incompatible with reuse and is rejected during configuration compilation.

`deliveryKey` is caller-supplied request identity for the existing durable manual-event path. Hub namespaces it by the authenticated organization and resolved project before persistence, so the same caller key can be used independently in different tenants or projects. Existing receipt/run de-duplication applies, but this API does not promise exactly-once execution or guaranteed response replay; retries can still fail or conflict during restart and timing races. A successful representation contains `deliveryKey`, `providerEventReceiptId`, `triggerRunId`, `configuredTriggerName`, and the durable `workflowStatus`.

The self-hosted Scalar reference is served with a restrictive Content Security Policy and does not require external fonts, scripts, telemetry, registries, or proxies.

## Plan catalog

`GET /api/billing/plans` is unauthenticated and read-only. It returns the plan catalog mirrored
from Stripe (see docs/billing.md) as marketing copy and pricing only. It never includes the
entitlement template (`granted` caps/flags/meters); that stays internal to `src/billing/` and
`src/entitlements/`. This is the shape the marketing site (paseo.sh) fetches to render pricing;
Hub itself has no pricing page.

It returns the plans that are for sale. The catalog also carries the internal record that
authors the no-subscription entitlement floor; that one is withheld here and everywhere else a
customer can see. Today the hosted offer is one plan:

```json
{
  "plans": [
    {
      "slug": "hosted",
      "name": "Paseo Hub",
      "marketingFeatures": [
        "Unlimited daemons",
        "GitHub, Linear, Slack, and Discord triggers",
        "Versioned workflows and activity",
        "Bring your own agents and inference"
      ],
      "prices": {
        "monthly": { "unitAmount": 1500, "currency": "eur" },
        "annual": null
      }
    }
  ]
}
```

`unitAmount` is in the smallest currency unit (cents for `eur`), matching Stripe's own `Price`
convention. An interval is `null` when the plan has no active price at that interval. A
self-hosted instance without `STRIPE_SECRET_KEY` 404s this route rather than serving an empty
catalog — the billing boundary means the route is never registered on an unconfigured instance.
See docs/billing.md.
