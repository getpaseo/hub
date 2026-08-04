# Phase 0 HTTP contracts

The executable contract authority is `e2e/helpers/hub.ts` and `e2e/phase-zero.spec.ts`. One
public test handle starts the production build against isolated PostgreSQL databases in both
`manual` and `webhook` event-source modes. Through that handle, the matrix exercises every
ordinary route's representative success and failure, authentication boundary, wrong method,
material response headers, and event-source availability.

The authentication boundary rejects a hostile `Origin` on Better Auth writes with its exact
`403 INVALID_ORIGIN` response. The same hostile origin does not interfere with authenticated
organization API-key routes; enrollment-token issuance remains a `201` with its public response schema.

Deterministic responses are asserted by exact status and body. Stateful success responses are
asserted by their complete public schema and persisted effect. The rendered document is asserted
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
