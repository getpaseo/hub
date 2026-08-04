# Phase 0 verification record

`src/db/schema.ts` declares every active Phase 0 table and invariant. The legacy
`paseo_hub_migrations` table is intentionally retained only as historical upgrade evidence;
Drizzle is the sole migration runner and does not use that journal.

## Clean baseline

On 2026-07-17, before implementation, `npm ci` installed 357 packages with a clean Git worktree. The unchanged branch then passed 34 Vitest files: 205 tests passed and 4 were skipped. Its Node typecheck, type-aware lint, format check, and production build also passed.

## Gate commands

The Phase 0 gate is represented by these required commands and matching CI jobs:

- `npm run typecheck` — strict NodeNext, Start/TSX bundler, and Playwright compiler contexts.
- `npm run lint` — Oxlint type-aware analysis and TypeScript diagnostics, including authored TSX rules.
- `npm run format:check`.
- `npm test` — unit, PostgreSQL migration/auth integration, organization/deployment, HTTP, and Hub runtime coverage.
- `npm run db:check` — Drizzle snapshot validity, generation, and committed migration drift.
- `npm run build` — Node host plus client/SSR Start production artifacts.
- `npm run test:e2e:browser` — production build, isolated PostgreSQL per test, browser isolation, rendered shell, and email/password session.
- `npm run docker:smoke` — production image build/start and `/health` readiness.
- `npm run test:e2e:hub:source` — source-built `getpaseo/paseo` compatibility, with the external source checkout supplied by CI.

The migration integration suite starts both an empty PostgreSQL database and a production-shaped historical snapshot. It preserves stable machine, daemon, execution, configuration-version and credential-verifier values, retains the historical journal, and proves that a second migration run is a no-op. Migration behavior is corrected forward; obsolete application binaries are not compatibility authorities.

Real PostgreSQL also supplies the deployment and tenant adversarial proofs. Concurrent promotion is serialized by the production organization/name lock, leaves the final deployment pointing at the immediately previous version, and successfully rolls back. Dashboard resource access resolves active membership before obtaining a reader, and machine, daemon, deployment, and execution lookups include organization ownership in their SQL predicate or join; existing and missing IDs therefore have the same unauthorized behavior.

The browser suite exposes one `PaseoHub` system handle. Test bodies use composable domain actions and ARIA-role assertions; protocol calls, server readiness, process cleanup, and PostgreSQL lifecycle stay inside the fixture/helper boundary. Each test gets a new PostgreSQL container, built server, and browser context, so database and cookie isolation are both explicit. The built-server matrix asserts hostile-origin Better Auth rejection and verifies that the same origin cannot disable a valid legacy bearer route.

## Fresh correction evidence

The independent-review and final reshape correction passes on 2026-07-18 produced the following local evidence:

- `npm ci` and `npm ls --depth=0` passed with the declared dependency tree installed.
- `npm run format:check` passed 164 files.
- `npm run typecheck` passed the NodeNext, Start/TSX, and Playwright contexts.
- `npm run lint` passed the Node and Start contexts with 237 rules and zero warnings or errors.
- `npm run db:check` passed with 14 tables, two migrations, and no generated drift.
- The final focused deployment/PostgreSQL run passed eight tests. It proves different-target concurrency and same-target concurrent/retry activation preserve immediate rollback lineage through the production store.
- `npm test` passed 38 files and 218 tests; two source/credential-gated files and four tests were skipped.
- `npm run test:e2e:browser` rebuilt the production application and passed all three isolated Playwright journeys.
- `npm run docker:smoke` built the production image and served its health contract.
- `npm run test:e2e:hub:source` passed all three source-built Hub journeys; every shutdown report contained zero leaked processes.
- `git diff --check` passed, and the external `getpaseo/paseo` checkout remained clean.
