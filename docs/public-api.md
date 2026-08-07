# Public API

Hub exposes three organization-scoped machine operations under `/api/v1`:

| Operation                                   | Scope                   | Endpoint                                 |
| ------------------------------------------- | ----------------------- | ---------------------------------------- |
| Install and activate configuration          | `configuration:install` | `POST /api/v1/configurations/install`    |
| Dispatch a durable manual run               | `runs:dispatch`         | `POST /api/v1/manual-runs`               |
| Issue a short-lived daemon enrollment token | `daemons:enroll`        | `POST /api/v1/daemons/enrollment-tokens` |

Create a scoped API key in the Hub dashboard and send it as `Authorization: Bearer <key>`. The canonical, executable operation and schema reference is served by each Hub instance at `/api/reference`; its OpenAPI 3.1 document is `/api/openapi.json`.

The earlier `/api/configurations/install`, `/api/manual-runs`, and `/api/daemons/enrollment-tokens` paths are compatibility aliases. Thin edge adapters preserve their legacy `application/json` error envelopes while both route families execute the same application operations. New clients should use `/api/v1`.

Every canonical `/api/v1` response, including unknown paths and wrong methods, uses RFC 9457 `application/problem+json` on failure and includes `X-Request-ID`; callers may supply that header to correlate a request. Wrong methods return `405` with `Allow`, while unknown paths return `404`. Every `401` response also includes `WWW-Authenticate: Bearer`.

Configuration YAML may include an optional non-empty top-level string `project` as deployment metadata. The authenticated request's `projectSlug` is always authoritative, so an explicit CLI `--project` can override the file. Hub validates and removes the metadata before strict workflow compilation without resolving or comparing it, while preserving the original YAML as revision evidence.

The configuration install body may also include an optional `partials` array. Each item is `{ "path": "docs/safety.md", "content": "..." }`, where `path` is a normalized relative path under `.paseo/partials/`. When YAML prompt blocks use `include`, the bundle must contain exactly those referenced files; missing, duplicate, unsafe, unexpected, or oversized files are rejected before a revision is recorded. Hub resolves the submitted content into the compiled revision and preserves it in source evidence, so changing only a partial creates a new revision. Requests without partial includes remain compatible with the YAML-only body.

## Workflow prompt capability inventory

Each workflow step's agent prompt includes a factual inventory of the Hub capabilities available to that execution by default. The inventory uses stable semantic names: `hub.finalize` records the current agent execution as complete and returns its result to the workflow, while `hub.reply` sends a message to the conversation that triggered the execution when that output is allowed and available. Finalizing an execution does not necessarily complete the whole workflow.

Authors may opt out for an individual step with `inject_tool_inventory: false`:

```yaml
steps:
  - id: classify
    inject_tool_inventory: false
    # ...the remaining step fields
```

The setting affects prompt discoverability only; server-side capability permissions and completion rules remain enforced.

`deliveryKey` is caller-supplied request identity for the existing durable manual-event path. Hub namespaces it by the authenticated organization and resolved project before persistence, so the same caller key can be used independently in different tenants or projects. Existing receipt/run de-duplication applies, but this API does not promise exactly-once execution or guaranteed response replay; retries can still fail or conflict during restart and timing races. A successful representation contains `deliveryKey`, `providerEventReceiptId`, `triggerRunId`, `configuredTriggerName`, and the durable `workflowStatus`.

The self-hosted Scalar reference is served with a restrictive Content Security Policy and does not require external fonts, scripts, telemetry, registries, or proxies.

## Plan catalog

`GET /api/billing/plans` is unauthenticated and read-only. It returns the plan catalog mirrored
from Stripe (see docs/billing.md) as marketing copy and pricing only. It never includes the
entitlement template (`granted` caps/flags/meters); that stays internal to `src/billing/` and
`src/entitlements/`. This is the shape the marketing site (paseo.sh) fetches to render pricing;
Hub itself has no pricing page.

```json
{
  "plans": [
    {
      "slug": "solo",
      "name": "Solo",
      "marketingFeatures": ["Unlimited seats", "2,000 executions / month", "Email support"],
      "prices": {
        "monthly": { "unitAmount": 2900, "currency": "usd" },
        "annual": { "unitAmount": 29000, "currency": "usd" }
      }
    }
  ]
}
```

`unitAmount` is in the smallest currency unit (cents for `usd`), matching Stripe's own `Price`
convention. An interval is `null` when the plan has no active price at that interval. A
self-hosted instance without `STRIPE_SECRET_KEY` 404s this route rather than serving an empty
catalog — the billing boundary means the route is never registered on an unconfigured instance.
See docs/billing.md.

## Public documentation follow-up

The public Hub docs live in the separate `getpaseo/paseo` repository under `public-docs/`. Update its Hub API guide in a separate PR to:

1. Make `/api/v1/**` canonical and label the three unversioned paths temporary aliases.
2. Link self-hosted `/api/reference` and `/api/openapi.json` as the canonical operation/schema source.
3. Document bearer scopes, the Bearer challenge, and the `401`/`403`/`500`/`503` distinction.
4. Replace the manual-run success example with the five durable fields listed above.
5. Describe RFC 9457 errors, structured `issues`, `requestId`, `X-Request-ID`, and narrow delivery-key semantics.
6. Document `GET /api/billing/plans` (unauthenticated, no scopes) — this is what paseo.sh's pricing page will fetch.
7. Document workflow-step `inject_tool_inventory` and the semantic `hub.finalize` / `hub.reply` inventory names.
