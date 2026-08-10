# Changelog

## 0.3.0 - 2026-08-10

### Added

- Multi-file configuration bundles with named environments, named agents, reusable prompt partials, and independently routed workflows.
- Explicit `${{ paseo.context }}` access for provider context without rewriting `${{ paseo.prompt }}`.
- Step-scoped GitHub credentials with repository, permission, and duration controls.
- Safe routing reasons for known events that no workflow accepted.

### Fixed

- Self-hosted sign-in works over explicitly configured remote HTTP origins.
- GitHub App identity lookup uses scoped authentication and avoids public API rate limits.
- Daemon enrollment names are derived consistently from hostnames.

## 0.2.0 - 2026-08-09

### Added

- Browser-based project configuration editing, including prompt partials and GitHub-backed configuration.
- Durable Hub login support for the Paseo CLI.
- Provider-specific passthrough options with provider-owned validation.
- Scoped preapproval for the exact Hub MCP tools authorized by each workflow step.

### Changed

- Project selection and configuration flows are clearer in the dashboard.

### Fixed

- Prompt partials remain available when configuration authority changes.
- Long configuration files and GitHub source controls remain usable in the configuration editor.
- Hosted deployments wait for a green `main` build before deploying to Fly.

## 0.1.0 - 2026-08-07

### Added

- Self-hosted automation for Paseo daemons with durable PostgreSQL-backed workflows.
- Discord, Slack, GitHub, and manual triggers for multi-step agent workflows.
- Project configuration through the dashboard, GitHub synchronization, prompt partials, and `paseo hub deploy`.
- Organization authentication, daemon enrollment, API keys, and scoped access controls.
- Stripe billing, organization usage visibility, and operator-managed plan limits.
- A versioned public API with an OpenAPI 3.1 specification and interactive reference.
