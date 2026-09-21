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

`deliveryKey` is caller-supplied request identity for the existing durable manual-event path. Hub namespaces it by the authenticated organization and resolved project before persistence, so the same caller key can be used independently in different tenants or projects. Existing receipt/run de-duplication applies, but this API does not promise exactly-once execution or guaranteed response replay; retries can still fail or conflict during restart and timing races. A successful representation contains `deliveryKey`, `providerEventReceiptId`, `triggerRunId`, `configuredTriggerName`, and the durable `workflowStatus`.

The self-hosted Scalar reference is served with a restrictive Content Security Policy and does not require external fonts, scripts, telemetry, registries, or proxies.

## Plan catalog

`GET /api/billing/plans` is unauthenticated and read-only. It returns the plan catalog mirrored
from Stripe (see docs/billing.md) as marketing copy, pricing, and the figures each plan includes.
It never includes the entitlement document itself (`granted` caps/flags/meters); that stays
internal to `src/billing/` and `src/entitlements/`. This is the shape the marketing site
(paseo.sh) fetches to render pricing; Hub itself has no pricing page.

It returns every plan the instance offers, the free one included, in catalog order. Today that is
two:

```json
{
  "plans": [
    {
      "slug": "free",
      "name": "Free",
      "billing": {
        "model": "per_unit",
        "unit": {
          "key": "seat",
          "label": "seat"
        }
      },
      "included": {
        "seats": 1,
        "executionsPerMonth": 50
      },
      "features": [
        {
          "key": "daemon-location",
          "label": "Daemons run on your machines",
          "tooltip": null
        }
      ],
      "prices": [
        {
          "interval": "monthly",
          "intervalCount": 1,
          "unitAmount": 0,
          "currency": "eur",
          "tooltip": null
        }
      ]
    },
    {
      "slug": "hosted",
      "name": "Pro",
      "billing": {
        "model": "per_unit",
        "unit": {
          "key": "seat",
          "label": "seat"
        }
      },
      "included": {
        "seats": null,
        "executionsPerMonth": null
      },
      "features": [
        {
          "key": "hub-operation",
          "label": "Paseo operates Hub",
          "tooltip": null
        }
      ],
      "prices": [
        {
          "interval": "monthly",
          "intervalCount": 1,
          "unitAmount": 1500,
          "currency": "eur",
          "tooltip": "Seats are Hub members and pending invitations. People who only trigger agents through GitHub, Slack, or Discord do not count as seats."
        }
      ]
    }
  ]
}
```

`included` is what the plan gives, as figures: `seats` is the seat cap and `executionsPerMonth`
the monthly agent-run allowance, each `null` for unlimited. They are derived from the same
validated template the instance enforces, so a plan's advertised numbers and its stamped limits
cannot disagree. Render these rather than writing the numbers into your own copy; `features` is
prose that no template can contradict.

`unitAmount` is the amount per billing unit in the smallest currency unit (cents for `eur`),
matching Stripe's own `Price` convention; a free plan prices at `0`. An interval is absent when the
plan has no active price at that interval. `slug` is catalog identity and does not change with the
displayed `name`. A self-hosted instance without `STRIPE_SECRET_KEY` 404s this route rather than
serving an empty catalog — the billing boundary means the route is never registered on an
unconfigured instance. See docs/billing.md.
