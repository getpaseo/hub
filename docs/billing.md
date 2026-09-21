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
billing dashboard route (`src/routes/_shell/o/$organizationSlug/settings/billing.tsx`). Enforced by the
`no-restricted-imports` rule in `oxlint.json:90` — CI fails on a violation, so the rule doesn't
depend on anyone remembering it. The billing UI lives under `src/billing/ui/` for the same
reason: one directory is what makes "delete `src/billing/`, the app still runs" a real test.

The coupling runs one direction: `billing` calls
`entitlements.stamp(organizationId, template, provenance)`. `src/entitlements/` never imports
`src/billing/`.

A surface that needs one billing-derived fact but is not the billing surface asks for that fact
alone, through `src/server/capabilities.ts`. The probe there answers a boolean resolved by the
composition root — never a subscription, a status, or a plan — and the self-hosted answer is a
truthful "no" rather than an error. That is what lets the dashboard shell gate the Billing nav
entry, and the sidebar's execution meter offer an upgrade, while still deleting cleanly with
`src/billing/`. Widening it into a view is how the boundary gets lost — a surface that needs the
subscription needs the billing page.

## Plan catalog

Stripe is the source of truth for prices and entitlement inputs. Hub owns the customer-facing
plan name, features, and tooltips in `src/billing/plan-presentation.ts`. Catalog sync combines the
two into `billing_plans`/`billing_plan_prices` rather than making either UI fetch Stripe live. It
runs on boot and on `product.created`/`product.updated`/`price.created`/`price.updated` webhooks.

Entitlement values live in product metadata as flat scalar keys (`ent_seats_max`,
`ent_can_invite`, `ent_executions_monthly_limit`), not one JSON blob — Stripe's metadata limits
(50 keys / 40-char keys / 500-char values) give flat keys far more headroom and keep the
dashboard directly editable. `parsePlanMetadata` (`src/billing/plan-template.ts:49`) is the zod
ingest gate: a dashboard typo rejects only that product's sync and keeps the last known good row,
logged loudly — nothing ever stamps from an unvalidated template. `plan_version` is
`hashTemplate()` (`src/entitlements/catalog.ts:260`) of the validated template, because Stripe
carries no version counter of its own; an off-template organization is a hash mismatch.

Catalog sync stores Hub's presentation with the mirrored price data in `billing_plans.marketing`.
The public endpoint and Hub billing UI both read that combined record.

Catalog sync uses Stripe's List API, not Search. Search has indexing lag, which would make the
boot sync racy right after a dashboard edit.

`GET /api/billing/plans` is documented in docs/public-api.md — marketing copy and pricing only,
never the entitlement template.

## Two plans, one of them free

The Stripe catalog carries two products. `free` is the plan every hosted organization is
provisioned on and returns to after cancellation: one seat, no invitations, and a monthly
execution allowance, all authored in the product's metadata. `hosted` is the one plan a customer
pays for — per seat, per month, unlimited executions, invitations on. Its slug and lookup key stay
`hosted`; the customer-facing name is Hub's, in `plan-presentation.ts`, which is why it reads
"Pro" everywhere without a Stripe rename.

Free is a plan, not a floor with a name. `publicCatalog` publishes it, `subscriptionSnapshot`
reports it as the organization's plan, and the billing page names it, lists what it includes, and
shows how much of its allowance is left. What Free lacks is a subscription: no Stripe customer, no
card, nothing to manage, and nothing dated. There is no trial — `plan-presentation.ts` has no copy
for one, `createCheckout` never asks Stripe for one, and an organization that stops paying lands
back on Free rather than on zero.

`purchasablePlans` (`src/billing/ui/presentation.ts`) is the distinction the UI needs: the plans
with a paid price. The page offers **Upgrade** when there is a purchasable plan the organization is
not on and no subscription to manage, **Change plan** when there is one and there is, and nothing
otherwise — so the single-paid-plan catalog shows Upgrade on Free and only "Manage billing" on Pro,
with no slug hardcoded anywhere.

Every paid plan is seat-based today: checkout and reconciliation report members plus pending
invitations as Stripe quantity. The public catalog commits that billing unit to its DTO instead of
making consumers infer it from copy.

Nothing about this is hardcoded to two plans. Publish a third product in Stripe and the picker
lays out three columns; publish an annual price and the interval switch appears.

Plan feature copy never restates a number the entitlement template carries. An allowance edited in
the Stripe dashboard would leave a hardcoded "50 executions" behind in marketing copy, and the
template never crosses the public boundary. The live figure reaches a customer through the meter
and the Usage page, which read the organization's own stamp.

## Organization provisioning

A hosted organization is provisioned with the Free plan's template resolved from the mirror
(`BillingRuntime.provisioningEntitlement`) and nothing else happens: no Stripe call, no customer,
no subscription. Organization creation has no billing hook at all — the only thing that puts an
organization onto a paid plan is a Checkout the owner completes.

If the mirror has no active Free plan yet — first boot before sync, or a Stripe account missing
the product — provisioning falls back to `FREE_TIER_FALLBACK`. It fails closed on seats and
invitations rather than open to unlimited, carries the same execution allowance the Free product
is authored with, and logs loudly so the gap gets noticed. Keep its allowance in step with
`ent_executions_monthly_limit` on the live Free product and with the E2E fixture.

The billing view derives the current plan from what the organization was last _stamped_ with, not
from a copied Stripe subscription. It reads Stripe only for the billing page, through a short,
single-flight in-memory cache; execution and workflow paths read the local entitlement stamp only.

### Re-stamping on a template change

Catalog sync does not stop at the mirror. After upserting a plan it re-stamps every organization
whose `plan_id` is that plan and whose `plan_version` is behind the plan's current template hash
(`Database.listOrganizationsOffPlanTemplate`). Editing a plan's metadata in the Stripe dashboard is
therefore the whole migration: the `product.updated` webhook resyncs, and every organization on
that plan converges. Boot does the same for anything a missed webhook left behind.

Only `granted` moves. An operator's overrides are a separate document and survive untouched (see
docs/entitlements.md), and the stamp is idempotent, so a resync with an unchanged template writes
no audit row. A stamp that throws aborts the sync, which turns the webhook into a 503 Stripe
redelivers, rather than leaving half the organizations behind quietly.

## Checkout, portal, subscriptions

`StripeBillingClient` and `StripeCatalogSource` (`src/billing/stripe-billing-client.ts`,
`src/billing/stripe-catalog-source.ts`) are narrow ports: production wires the real Stripe SDK
(`src/billing/stripe-client.ts`), the E2E harness wires a fixture, and a caller never learns
which. Checkout and the billing portal are Stripe-hosted; Hub's own dashboard surface is a
plan-picker dialog and a "Manage billing" button — payment methods, invoices, and cancellation
stay in the Stripe portal.

Inside `src/billing/ui/`, `panel.tsx` owns the page, `plan-dialog.tsx` owns the picker, and
`presentation.tsx` owns every user-facing string either of them renders. Which plans exist is
settled before the view, in `public-catalog.ts`; which of them can be bought is
`purchasablePlans`. Copy lives in one file because it is the part of the surface worth
unit-testing: a button label has to stay short enough for a narrow plan column while its
accessible name still identifies the plan.

Both surfaces render the plans and nothing around them. The picker has no heading (its dialog
title is read, not shown), no framing sentence, and no interval switch unless the catalog prices
more than one interval. Everything here is driven off the catalog, so a second paid product or an
annual price restores the controls without a redesign — but nothing that has no meaning today is
rendered today.

Checkout is the only way onto a paid plan, and it always collects payment. Customer, Checkout, and
subscription metadata carry the organization id, and idempotency keys collapse concurrent creation
attempts. A customer who already has a subscription never reaches Checkout again: a plan change
updates the existing subscription's item in place.

The subscription webhook (`BillingRuntime.handleWebhook`) reconciles rather than applies. It takes
only the subscription id from the event, then — under a per-organization advisory lock that
serializes across processes — re-reads the subscription's live state and converges the
organization onto it: resolve the price to a plan (resyncing the catalog once when a subscription
webhook beat its own price webhook), then stamp the plan's template, or stamp Free on a terminal
cancellation so paid entitlements never outlive the subscription. The subscription mirror and the
entitlement stamp commit in one transaction (`Database.reconcileOrganizationSubscription`), so the
two can never disagree across a crash. Re-reading current state under the lock is what stops an
older delivery resuming after a newer one from reverting the stamp; the idempotent stamp makes a
pure replay a no-op. When it cannot reconcile yet — a price still not in the mirror, or an
unreadable subscription — it returns a non-2xx so Stripe redelivers, rather than acknowledging a
state nothing would revisit.

`organization_billing_customers` is the sole durable Stripe identity link. It deliberately does
not copy subscription status, price, cancellation, or period timestamps; Stripe remains the owner
of that lifecycle. `active` and `trialing` stamp the subscription's plan — Hub never starts a
trial, but a subscription trialed by hand in the Stripe dashboard still grants the plan it is on;
`canceled`, `incomplete_expired`, and `unpaid` stamp Free; `past_due` retains the last stamp during
Stripe's retry window.

## Seats

Paid plans are billed post-paid on actual seat usage (members + pending invitations), not a fixed
quantity. The seat count is a core auth fact; the auth server fires an injected post-commit hook on
every membership change (invite, cancel, accept, remove), and the composition root wires that hook
to `BillingRuntime.reportSeatUsage`. The reporter reads the live count and writes it to Stripe only
when it differs from what the subscription is currently billed for — so the resulting
`customer.subscription.updated` echo carries no delta and cannot ping-pong with reconciliation.
Reconciliation re-checks the count on every subscription webhook, the durable backstop if a
post-commit report is lost. Only subscriptions report; an organization on Free has none, and its
template caps seats instead (`ent_seats_max=1`, `ent_can_invite=false`).

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
grandfathered, only growth past the new cap is blocked. The over-limit banner lives on the
customer Usage page (`src/usage/panel.tsx`), not billing, because limits are a core concern that
renders self-hosted too — its copy names the limit and stays silent on remedies. Billing only
triggers the re-stamp that can produce the over-limit state, and links to Usage; it never shows or
edits limits. See docs/entitlements.md's Surfaces section.

The execution meter in the sidebar is the same split: it belongs to entitlements
(`src/entitlements/ui/execution-meter.tsx`), reads the usage snapshot, renders only for an
organization with a finite allowance, and asks `useEntitlementRemedy` whether this deployment has
anything to sell. Billing contributes one boolean to that, through the capability probe. The
billing page shows the same sentence from the same hook.

## Testing

No Stripe account, no network calls, in tests — fixtures only. `stripe-mock` isn't used: it's
stateless, so `products.create` then `products.list` doesn't round-trip, which can't test a
catalog mirror. Webhook signature verification is tested for real by HMAC-signing payloads with a
known secret, the same pattern `e2e/helpers/hub.ts` already uses for GitHub and Slack. Specs live
in `e2e/billing-boundary.spec.ts`, `e2e/billing-catalog.spec.ts`, `e2e/billing-subscription.spec.ts`
(the money test, plus the template-change re-stamp), `e2e/billing-downgrade.spec.ts`, and
`e2e/billing-mobile.spec.ts`. The fixture catalog in `src/e2e/harness/browser-billing.ts` mirrors
the live Stripe products, allowance included: change one and change the other.

Running the E2E suite locally requires `PASEO_E2E_WORKTREE` pointed at a checkout of
`getpaseo/paseo` — the harness npm-packs the server packages from it. Without it, entitlements'
metered-usage E2E fails with a worktree-mismatch error that reads like a code regression but is
an environment gap.

## Explicitly out of scope

Proration UI, invoices, tax, dunning, coupons, multi-currency, a second payment provider, and a
Hub-hosted marketing pricing page — paseo.sh fetches `/api/billing/plans` and renders its own.
