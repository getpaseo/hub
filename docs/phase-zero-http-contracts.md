# Phase 0 HTTP contracts

The external machine API contract authority is the operation manifest and Zod-backed declarations in
`src/public-api/`. The manifest drives runtime method/path/scope/schema/result selection and OpenAPI
registration; parity tests prevent the generated document and dispatcher from drifting.
`e2e/helpers/hub.ts` and `e2e/phase-zero.spec.ts` remain the broader application HTTP authority. One
public test handle starts the production build against isolated PostgreSQL databases in both
`manual` and `webhook` event-source modes. Through that handle, the matrix exercises every
ordinary route's representative success and failure, authentication boundary, wrong method,
material response headers, and event-source availability.

The authentication boundary rejects a hostile `Origin` on Better Auth writes with its exact
`403 INVALID_ORIGIN` response. The same hostile origin does not interfere with authenticated
organization API-key routes; enrollment-token issuance remains a `201` with its public response schema.
Canonical machine paths use `/api/v1/**`; the three unversioned paths are compatibility aliases over
the same application operations with their legacy JSON envelopes preserved at the edge. Canonical
failures use RFC 9457 Problem Details and every canonical response carries `X-Request-ID`. Canonical
misses are `404`, method mismatches are `405` with `Allow`, and all public-API `401` responses carry a
Bearer challenge.

The configuration install operation accepts an optional non-empty top-level string `project` as
deployment metadata. The application boundary parses the document once and removes that field before
strict workflow compilation. The authenticated request `projectSlug` is always authoritative and may
override the file; Hub does not resolve or compare the metadata. The raw YAML remains revision
evidence.

Deterministic legacy responses are asserted by exact status and body. Canonical responses are
asserted against their executable schemas. A separately invoked built-server PostgreSQL release
proof covers all three canonical operations with colliding slugs and delivery keys in two
organizations, then checks returned ownership and persisted effects. The rendered document is asserted
by status, media type, and visible content because its Start hydration payload and asset names are
build-generated. Wrong methods on legacy routes preserve Hono's unmatched-route response exactly:
`404`, `text/plain; charset=UTF-8`, and `404 Not Found`.

TanStack Start is the sole ordinary production HTTP router. The Node host only owns process
lifecycle and the raw `/api/daemons/socket` upgrade. The source-built Hub E2E suite remains the
executable WebSocket contract authority.

Material success statuses preserved by the application edge are: enrollment token `201`, daemon
enrollment `200`, daemon revocation `204`, execution completion `200`, configuration install
`201`, and manual run `200`. The built-server matrix covers those stateful paths with a real
WebSocket daemon, and it covers Better Auth session creation plus signed webhook delivery. The
source-built Hub E2E suite remains the deeper executable WebSocket lifecycle authority.
The self-hosted Scalar page at `/api/reference` renders only the three public operation groups;
Better Auth, provider, daemon protocol, and execution-capability routes are absent from OpenAPI. Its
browser journey asserts the restrictive CSP, no policy violations, and no cross-origin requests.
