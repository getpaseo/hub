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

## Inbound webhooks

Choose **Webhook received** in the trigger editor, or save this trigger in `.paseo/triggers/alert-handler.yml` and run `paseo hub deploy`.

```yaml
name: alert-handler
on:
  webhook.received: {}
run:
  target: { daemon: devbox, cwd: /absolute/path/to/workspace }
  agent: { provider: codex, mode: full-access }
  prompt: Summarize the alert and call finish_execution with the summary.
```

Hub assigns a random endpoint path of the form `/webhooks/wh_<random-id>` and a bearer secret. Only the secret's hash is stored. A trigger created in the editor opens on its endpoint and shows the secret once, with an example request that already carries it. Store the secret in the sender's secret store before you leave the page. A trigger created with `paseo hub deploy` gets a secret that is never shown, so open the trigger and choose **Rotate secret**, or send `POST /api/v1/triggers/webhook-secret` with `{"triggerId":"<trigger-id>"}` and an organization credential with `configuration:install`. The API returns `{ path, secret }`. Each rotation replaces the previous secret. An endpoint created before Hub generated secrets shows **Secret required** and **Create secret**. Redeploying the same trigger name with `webhook.received` preserves the endpoint and its secret.

```sh
curl -X POST "$WEBHOOK_URL" \
  -H "Authorization: Bearer $WEBHOOK_SECRET" \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: alert-123' \
  -d '{"alert":"Disk usage over 95%"}'
```

Hub accepts UTF-8 bodies up to 32 KiB and validates JSON media types. A literal NUL character returns HTTP 400. A successful delivery returns HTTP 202 with `{ "runId": "...", "status": "accepted" }` after saving the receipt and queuing the run. Reuse the same optional `Idempotency-Key` on delivery retries to get the original run ID. Keys are scoped to the endpoint and accept up to 200 printable ASCII characters without spaces. The run appears in Activity as `webhook.received`.

| Status | Meaning                                                                          |
| ------ | -------------------------------------------------------------------------------- |
| 400    | Invalid body, content type, or idempotency key                                   |
| 401    | Invalid endpoint or missing or invalid secret                                    |
| 403    | The organization has used its monthly execution allowance                        |
| 409    | The trigger is disabled                                                          |
| 413    | The body exceeds 32 KiB                                                          |
| 429    | The endpoint has already accepted 60 new deliveries in its current minute window |

Hub appends the body and limited delivery metadata to the agent prompt as untrusted external data. To choose where it appears, insert the standalone `${{ paseo.prompt }}` expression in the instructions. Execution uses the same monthly meter as other Hub runs. If another run consumes the remaining allowance after a delivery is accepted, the execution meter records the denial in run history.

## Workflow MCP tools

Hub sends each daemon the rendered prompt. Execution tools are exposed through the injected Hub MCP server. Hub passes the selected provider settings and its MCP server without imposing a provider-side tool policy; missing MCP support does not exclude a provider. Hub requires authenticated completion and authorizes output calls at its own endpoint. Completion is exposed as `finish_execution`; allowed and materialized output tools use their registered names, such as `reply`. For structured-output steps, `finish_execution` accepts the configured result under `output`. Completing an execution does not necessarily complete the whole workflow.

## Trigger prompt and optional context

For conversation triggers, `${{ paseo.prompt }}` contains the complete received text, including provider mentions, command markers, typed-input headers, and whitespace. Parsing those elements can select a trigger or populate `${{ paseo.inputs }}`, but never rewrites the prompt. Structured manual input without a textual prompt produces an empty string. `${{ paseo.context }}` is a separate opt-in merge value containing safe ambient provider data. Each workflow step opts in independently. Hub includes provider context and attachment descriptors only when the step uses `${{ paseo.context }}`. Context history and attachment descriptors are fetched and materialized only when an opting step launches; attachment descriptors are Hub URLs scoped to that execution. Provider credentials, raw tokens, private provider download URLs, and unrelated webhook fields are not exposed.

When a step grants Slack or Discord `post` access, Hub adds the Open in Paseo URL to the agent prompt. The link requires a configured HTTPS Hub URL and a recorded daemon agent. Organization members can use that link to open the session or view the execution in Hub.

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
          "currency": "usd",
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
          "currency": "usd",
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

`unitAmount` is the amount per billing unit in the smallest currency unit (cents for `usd`),
matching Stripe's own `Price` convention; a free plan prices at `0`. An interval is absent when the
plan has no active price at that interval. `slug` is catalog identity and does not change with the
displayed `name`. A self-hosted instance without `STRIPE_SECRET_KEY` 404s this route rather than
serving an empty catalog — the billing boundary means the route is never registered on an
unconfigured instance. See docs/billing.md.
