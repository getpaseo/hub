# Billing

Hosted concern. `src/billing/` is inert on a self-hosted instance — no routes, no navigation, no
UI, nothing stamps — until `readBillingConfig()` (`src/billing/config.ts:25`) finds both
`STRIPE_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET` in the environment. Mirrors
`readInstanceAuthPolicy()`'s gate pattern. Everything below assumes that config is present.

Read docs/entitlements.md first. Billing's only job is producing the templates that get stamped
there; it enforces nothing of its own.

## Boundary

Nothing outside `src/billing/` may import it, except the composition root (`src/index.ts`,
`src/application-runtime.ts`, `src/server/runtime.ts`, `src/e2e/harness/browser-child.ts`) and the
billing dashboard route (`src/routes/_shell/o/$organizationSlug/billing.tsx`). Enforced by the
`no-restricted-imports` rule in `oxlint.json:90` — CI fails on a violation, so the rule doesn't
depend on anyone remembering it. The billing UI lives under `src/billing/ui/` for the same
reason: one directory is what makes "delete `src/billing/`, the app still runs" a real test.

The coupling runs one direction: `billing` calls
`entitlements.stamp(organizationId, template, provenance)`. `src/entitlements/` never imports
`src/billing/`.

## Plan catalog

Stripe is the source of truth for plan data; Hub mirrors it into
`billing_plans`/`billing_plan_prices` (`src/db/schema.ts:1098`) rather than fetching live. Sync
runs on boot and on `product.created`/`product.updated`/`price.created`/`price.updated` webhooks
(`syncBillingCatalog`, `src/billing/catalog-sync.ts:23`), always a full resync of every plan
product — one code path to keep correct instead of an incremental one plus a full one.

Entitlement values live in product metadata as flat scalar keys (`ent_seats_max`,
`ent_can_invite`, `ent_executions_monthly_limit`), not one JSON blob — Stripe's metadata limits
(50 keys / 40-char keys / 500-char values) give flat keys far more headroom and keep the
dashboard directly editable. `parsePlanMetadata` (`src/billing/plan-template.ts:49`) is the zod
ingest gate: a dashboard typo rejects only that product's sync and keeps the last known good row,
logged loudly — nothing ever stamps from an unvalidated template. `plan_version` is
`hashTemplate()` (`src/entitlements/catalog.ts:260`) of the validated template, because Stripe
carries no version counter of its own; an off-template organization is a hash mismatch.

Catalog sync uses Stripe's List API, not Search. Search has indexing lag, which would make the
boot sync racy right after a dashboard edit.

`GET /api/billing/plans` is documented in docs/public-api.md — marketing copy and pricing only,
never the entitlement template.

## Free-tier provisioning

A hosted organization is provisioned with the Free plan's template resolved from the mirror
(`BillingRuntime.provisioningEntitlement`, `src/billing/index.ts:150`), not the unlimited default
self-hosted gets. If the mirror has no active Free plan yet — first boot before sync, or a Stripe
account missing the product — provisioning falls back to `FREE_TIER_FALLBACK`
(`src/billing/index.ts:64`). The fallback fails closed rather than open to unlimited and logs
loudly so the gap gets noticed; every organization stamped from it re-stamps to the real Free
plan the moment it subscribes.

## Checkout, portal, subscriptions

`StripeBillingClient` and `StripeCatalogSource` (`src/billing/stripe-billing-client.ts`,
`src/billing/stripe-catalog-source.ts`) are narrow ports: production wires the real Stripe SDK
(`src/billing/stripe-client.ts`), the E2E harness wires a fixture, and a caller never learns
which. Checkout and the billing portal are Stripe-hosted; Hub's own dashboard surface is a
plan-picker dialog and a "Manage billing" link — payment methods, invoices, and cancellation stay
in the Stripe portal.

The subscription webhook (`BillingRuntime.handleWebhook`, `src/billing/index.ts:216`) re-reads
the referenced subscription's live state and stamps from that, never from the event payload.
That's what makes it idempotent under replay: a retried or reordered webhook converges on the
same stamp instead of ping-ponging with the seat-usage echo entitlements reports back to Stripe.

`organization_subscriptions` (`src/db/schema.ts:1133`) is a table this repo owns and keys
directly by `organization_id`, deliberately not part of Better Auth's schema.

### Why not `@better-auth/stripe`

Earlier design rounds called for `@better-auth/stripe` to own checkout, portal, customer
creation, and the subscription table. Dropped:

1. Its checkout reaches `stripe.checkout.sessions.create` with no seam narrower than the whole
   `Stripe` SDK client. Faking that to test the upgrade flow means mocking a large third-party
   surface — the dependency shape the standards skill's mocking rule forbids. The money test (a
   denied invite → upgrade → webhook stamp → the same invite succeeds → replaying the webhook is
   a no-op) is the proof the decoupled design works; a dependency that makes it untestable is
   disqualifying.
2. It mounts its webhook under `/api/auth/stripe/webhook`, colliding with the `/api/billing/*`
   paths the billing boundary already established.
3. Better Auth still owns auth, organizations, sessions, and permissions — billing authorizes
   every reference through the existing `OrganizationAccess` role capabilities, so the plugin's
   remaining value was small.

Not the reason: this isn't a Stripe SDK version conflict. The plugin's peer range covers the
repo's pinned `stripe@18.5.0` fine. Don't re-add it on the assumption this was a version problem
— the untestable money test is the actual reason it can't come back.

## Downgrade and over-limit

A downgrade stamps the lower template but deletes nothing to fit it — existing resources are
grandfathered, only growth past the new cap is blocked. The over-limit banner and the
`overages()` query behind it are core entitlements concerns
(`EntitlementsService.overages`, `src/entitlements/service.ts:188`, rendered in
`src/entitlements/panel.tsx`), not billing. Billing only triggers the re-stamp that can produce
the over-limit state in the first place.

## Testing

No Stripe account, no network calls, in tests — fixtures only. `stripe-mock` isn't used: it's
stateless, so `products.create` then `products.list` doesn't round-trip, which can't test a
catalog mirror. Webhook signature verification is tested for real by HMAC-signing payloads with a
known secret, the same pattern `e2e/helpers/hub.ts` already uses for GitHub and Slack. Specs live
in `e2e/billing-boundary.spec.ts`, `e2e/billing-catalog.spec.ts`, `e2e/billing-subscription.spec.ts`
(the money test), and `e2e/billing-downgrade.spec.ts`.

Running the E2E suite locally requires `PASEO_E2E_WORKTREE` pointed at a checkout of
`getpaseo/paseo` — the harness npm-packs the server packages from it. Without it, entitlements'
metered-usage E2E fails with a worktree-mismatch error that reads like a code regression but is
an environment gap.

## Explicitly out of scope

Proration UI, invoices, tax, dunning, coupons, multi-currency, a second payment provider, and a
Hub-hosted marketing pricing page — paseo.sh fetches `/api/billing/plans` and renders its own.
