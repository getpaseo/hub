# Changelog

## 0.12.0 - 2026-11-26

Upgrade your Paseo daemons to v0.17.5 before you upgrade Hub. Hub 0.12.0 applies five additive database migrations (0050 to 0054) on start. No environment variable is required.

### Highlights

- **Inbound webhooks.** Any external service can start a run by posting to a trigger's webhook URL with a Bearer secret. Choose **Webhook received** in the editor, or use `on: { webhook.received: {} }` in trigger YAML. A new webhook trigger shows its secret and a ready-to-run `curl` example, and the first request returns `202 Accepted`. An optional `Idempotency-Key` returns the same run on retry. ([#223](https://github.com/getpaseo/hub/pull/223), [#241](https://github.com/getpaseo/hub/pull/241))
- **Scoped Slack and Discord tools for any trigger.** A trigger can give its agent read or post access to specific Slack or Discord channels, in the editor or under `run.tools` in YAML. Hub checks the connection, action, and channel on every call and keeps provider credentials on the server. ([#224](https://github.com/getpaseo/hub/pull/224), [#226](https://github.com/getpaseo/hub/pull/226))
- **Sign in with Google and GitHub.** Set `PASEO_AUTH_GOOGLE_CLIENT_ID` and `PASEO_AUTH_GOOGLE_CLIENT_SECRET`, or `PASEO_AUTH_GITHUB_CLIENT_ID` and `PASEO_AUTH_GITHUB_CLIENT_SECRET`, to show that provider's button. A Hub with neither pair set behaves as before. ([#242](https://github.com/getpaseo/hub/pull/242))
- **Open runs in Paseo.** Hub replies and Activity runs have an **Open in Paseo** link that opens the agent in the Paseo app. ([#225](https://github.com/getpaseo/hub/pull/225), [#243](https://github.com/getpaseo/hub/pull/243))
- **New GitHub events.** `github.pull_request_ready_for_review` runs when a draft is marked ready, and `github.pull_request_synchronized` runs on new pushes to a pull request. The `exclude_contains` filter lets a general mention trigger skip a command that another trigger owns, such as `@bot review`. ([#182](https://github.com/getpaseo/hub/pull/182), [#184](https://github.com/getpaseo/hub/pull/184))
- **Filterable Activity.** Activity lists every run and every event that no trigger matched. You can filter it by range, provider, status, trigger, daemon, and text, and share a link to the filtered view. Home shows exact run counts that open Activity already filtered. ([#238](https://github.com/getpaseo/hub/pull/238))
- **Triggers use the daemon's providers and models.** The trigger form lists the providers, models, and modes the daemon reports for the chosen working directory, including plugin and ACP providers. Hub validates a saved agent against that same list. ([#185](https://github.com/getpaseo/hub/pull/185), [#234](https://github.com/getpaseo/hub/pull/234))

### Improved

- New organizations get a three-step Get started list: connect a daemon, create a trigger, run it. Connecting GitHub, Slack, Discord, or Linear is optional. The Connections page is now **Integrations**. ([#213](https://github.com/getpaseo/hub/pull/213), [#240](https://github.com/getpaseo/hub/pull/240))
- The trigger editor walks clearer steps, keeps the agent and access steps closed until you pick a working directory, and puts **Run in background** and **Auto-archive after completion** under Advanced. ([#228](https://github.com/getpaseo/hub/pull/228), [#239](https://github.com/getpaseo/hub/pull/239), [#243](https://github.com/getpaseo/hub/pull/243))
- Connecting GitHub works for an account that already has the App installed. Disconnecting and connecting again no longer requires uninstalling the App. A non-owner who tries to connect is told to ask an owner. ([#212](https://github.com/getpaseo/hub/pull/212), [#230](https://github.com/getpaseo/hub/pull/230))
- Slack agent context includes `slack.trigger_message`: the mention's channel, `ts`, thread `ts`, and attached files. ([#190](https://github.com/getpaseo/hub/pull/190))
- Discord `${{ paseo.context }}` keeps the embeds of referenced messages and thread messages, so an embed-only bot notification no longer reaches the agent as an empty message. ([#236](https://github.com/getpaseo/hub/pull/236))
- The Daemons page shows a new daemon without a reload, and CLI login shows the verification code before you approve. ([#240](https://github.com/getpaseo/hub/pull/240))
- Instance operators can find an organization by name, ID, or slug and see its details and members. ([#214](https://github.com/getpaseo/hub/pull/214))
- Unhandled provider event receipts expire after seven days. Receipts used by a trigger, run, or attachment are kept.
- New Paseo Hub logo and favicon. ([#221](https://github.com/getpaseo/hub/pull/221))

### Fixed

- **Shutdown:** Hub exits promptly on `SIGTERM` or `SIGINT` while daemons are connected, and shuts the database down cleanly. Before, it hung until the supervisor killed it, and embedded mode had to recover its database on the next start. ([#233](https://github.com/getpaseo/hub/pull/233))
- **Startup:** a stalled Discord Gateway no longer keeps Hub from serving HTTP. Discord stays unavailable and other integrations start. ([#227](https://github.com/getpaseo/hub/pull/227))
- **Database stalls:** when Postgres stops answering, Hub fails only the requests in flight. It no longer returns broken connections to the pool or crashes when a leaked connection closes later. ([#249](https://github.com/getpaseo/hub/pull/249), [#180](https://github.com/getpaseo/hub/pull/180))
- **Idle CPU:** the workflow worker does little work when nothing is due, and a run waiting for an offline daemon no longer loops four times a second. ([#250](https://github.com/getpaseo/hub/pull/250))
- **Continuations:** a reply in a thread reaches the same agent after the daemon closed it for being idle. Before, the follow-up failed with `agent_interrupted`. ([#231](https://github.com/getpaseo/hub/pull/231))
- **Stuck dispatches:** a dispatch no longer stays in `spawning` when the daemon answers slowly but stays connected. ([#235](https://github.com/getpaseo/hub/pull/235))
- **Background runs:** Hub receives idle updates for background agents and archives their workspaces. ([#229](https://github.com/getpaseo/hub/pull/229))
- **Plugin providers:** runs on plugin providers that do not support tool policy start instead of failing at agent creation. ([#248](https://github.com/getpaseo/hub/pull/248))
- **Claude Code:** Hub MCP accepts the MCP 2026-07-28 protocol, so Claude Code runs no longer lose 6 to 22 seconds on a fallback handshake. ([#232](https://github.com/getpaseo/hub/pull/232))
- **OpenCode:** Hub recognizes the `hub_finish_execution` tool name that OpenCode uses. ([#129](https://github.com/getpaseo/hub/pull/129))
- **Slack:** Hub reconnects a Socket Mode connection that stopped receiving data without closing. Before, mentions were lost until a restart. ([#186](https://github.com/getpaseo/hub/pull/186))
- **Slack:** attachment and user lookups work again. ([#188](https://github.com/getpaseo/hub/pull/188))
- **Slack:** Hub adds the 👀 reaction when a run is accepted, and reactions Slack reports as already done no longer retry forever. ([#172](https://github.com/getpaseo/hub/pull/172), [#187](https://github.com/getpaseo/hub/pull/187))
- **Discord and Slack filters:** `filters.guild` and the Slack workspace filter match by ID. ([#87](https://github.com/getpaseo/hub/pull/87))
- **Linear:** triggers saved with the **Everyone** audience fire, and comment threads load their earlier comments. ([#218](https://github.com/getpaseo/hub/pull/218), [#105](https://github.com/getpaseo/hub/pull/105))
- **Packaging:** the lockfile no longer lists an invalid optional dependency, which broke Nix packaging. ([#149](https://github.com/getpaseo/hub/pull/149))
- **Completion reactions:** failed Slack, Discord, and GitHub completion reactions now back off (respecting `Retry-After`) and stop retrying after 8 attempts or immediately on permanent errors instead of looping every 30 seconds. ([#252](https://github.com/getpaseo/hub/pull/252))
- **Embedded mode containers:** embedded mode now uses an OS advisory file lock instead of a PID check, so container restarts, recreates, and backup restores recover cleanly after a crash while still refusing a second Hub on the same data directory. ([#253](https://github.com/getpaseo/hub/pull/253))

### Self-hosting and upgrade notes

- **Upgrade daemons first.** Daemons on Paseo v0.17.4 or later validate trigger models against the working directory. Older daemons validate against their global model list, so a project-only model is rejected on save.
- **Migrations 0050 to 0054** add a `trigger_webhooks` table, columns, and indexes. They run on start. On a very large `provider_event_receipts`, `trigger_runs`, or `agent_executions` table, you can build the 0052 and 0053 indexes first with `CREATE INDEX CONCURRENTLY IF NOT EXISTS` under the same names to avoid a write lock.
- **New optional variables:** `PASEO_AUTH_GOOGLE_CLIENT_ID`, `PASEO_AUTH_GOOGLE_CLIENT_SECRET`, `PASEO_AUTH_GITHUB_CLIENT_ID`, `PASEO_AUTH_GITHUB_CLIENT_SECRET`. Hub refuses to start when only one variable of a pair is set. Register `<PASEO_HUB_APP_URL>/api/auth/callback/google` or `/api/auth/callback/github` as the callback. GitHub sign-in needs its own OAuth App, separate from the GitHub App.
- **GitHub App permissions:** connecting an installation no longer needs the Members organization permission that 0.11.0 asked for.
- **Embedded mode upgrades from 0.11.0:** stop the old Hub container before starting 0.12.0 (for example using `Recreate`), because the old PID lock and the new kernel lock do not see each other. Embedded mode requires glibc Linux (amd64/arm64), macOS, or Windows (not musl/Alpine or FreeBSD).
- **Reverse / auth proxies:** if you run Hub behind an auth proxy such as Cloudflare Access, bypass machine-auth paths `/api/*`, `/webhook*`, `/agent-executions/*`, and `/agent-sessions/*`.
- **Fly:** the repository no longer contains a production `fly.toml`. Copy `fly.example.toml` to `fly.toml` and set `app`, `primary_region`, and `PASEO_HUB_APP_URL` before your first deploy.

## 0.11.0 - 2026-10-25

### Added

- One trigger can run on a schedule and on demand: `schedule.tick` may share a document with other events such as `manual.run`, so a prompt no longer needs two files. A tick runs with each input's default, so a document with a schedule cannot declare a required input.
- `run.background: true` creates a Paseo background workspace for a run, keeping automated runs out of ordinary workspace listings. It defaults to `false`; daemons without background workspace support ignore it and run visibly.
- An unverified user who signs in with the correct password receives a verification email immediately, and the link signs them in.

### Changed

- CLI logins authorize only while their creator is still an owner or admin of the organization; removing or demoting a member revokes their CLI credentials. Organization API keys and enrolled daemons are unaffected.
- Connecting a GitHub installation now requires the GitHub account owner, or an active admin of the organization that owns the installation. The GitHub App needs the Members read-only organization permission; an existing App must have it approved on the installation before reconnecting.
- Connecting a GitHub App discovers its complete repository catalog before reporting success, and installation webhooks keep the catalog current, so a trigger with `filters.repo` resolves repositories on a newly connected installation.
- Tables size each column by its widest value; only columns whose values can be cut share the remaining width.

### Fixed

- Every run of a trigger with several events carries the trigger's name, instead of an internal event name, in workspace titles and on the home page.
- Background runs receive agent status updates, so Hub observes completion, enforces the idle timeout, and archives the workspace instead of leaving cleanup pending.
- A run with `auto_archive: true` whose agent went idle during a Hub restart, reconnect, or deploy is archived after recovery instead of staying open indefinitely.
- GitHub notifications for a deleted comment or an uninstalled App settle instead of retrying every 30 seconds.
- When a background refresh of a loaded Hub screen fails, the screen keeps its last loaded content and retries instead of replacing it with an error.

## 0.10.0 - 2026-09-29

### Added

- Scheduled triggers that run on a calendar recurrence, with time zones.
- Conversation continuity: a new arrival in the same issue, pull request, or thread continues the agent already working there instead of starting another, with explicit keys and an opt-out.
- A new arrival for a running agent steers it, including agents that run with scoped execution credentials.
- A Home page for new organizations with a setup checklist, a notice when provider events arrive with no trigger listening, and a seven-day overview.
- Saving a trigger validates its agent against the target daemon, so a model, mode, or provider the daemon cannot run is refused at save instead of failing the first run.
- A `startup_timeout` setting for machines that need longer than the default two minutes to start an agent.

### Changed

- Upgrade Paseo daemons before upgrading Hub: conversation continuity needs the current daemon.
- One consistent interface across sign-in, organization administration, projects, connections, triggers, and instance settings.
- The trigger editor walks four numbered steps: what arrives, who may send it, where it lands, and what runs there.
- Trigger forms list only the events Hub handles, and label events require the label they match.
- Alerts say what happened, and empty pages no longer draw empty tables and panels.
- Paseo shows Hub executions under their trigger's name instead of an execution id.

### Fixed

- Active agents keep their execution credentials across Hub restarts and reconnect to the same daemon agent.
- Long rendered prompts reach the agent in full.
- New GitHub agents receive their reply tool, and preserved legacy workflows dispatch again.
- The sidebar and breadcrumb stay on the page that is visible while the next one loads.
- Unsupported methods on the execution MCP route return 405 instead of an HTML page or a 500, and a daemon sending an invalid WebSocket close code no longer crashes Hub.

## 0.9.0 - 2026-09-04

### Added

- Linear connections and signed issue, assignment, and comment triggers, with scoped context and workflow replies.
- Optional invitation email delivery, account email verification, and password recovery for configured deployments.
- Cardless seven-day Hosted trials, live plan presentation, open signup, and initial organization creation.
- Daemon-backed model, execution mode, and thinking-option selection in trigger setup.
- Dashboard help links, trial countdowns, and guided daemon setup from empty states.

### Changed

- Hosted configuration now centers on organization-level, single-agent triggers with an equivalent visual editor and YAML document. Existing project workflows migrate at startup, while advanced multi-step workflows remain runnable as YAML.
- Trigger setup requires explicit daemon, agent, model, execution mode, and thinking choices when those capabilities are available.
- Daemon enrollment separates presence from workflow execution through explicit permissions while remaining compatible with legacy scope-based daemons.
- Dashboard navigation, copy hierarchy, and loading states now preserve the current scope and page shape.

### Fixed

- Self-hosted Hub login and browser mutations honor the configured public origin behind TLS-terminating proxies.
- Discord and Slack thread context retains the conversation's root message after pagination and truncation.
- Daemon event-processing failures no longer escape their observer boundary and terminate Hub.
- Project-to-organization trigger migration preserves provider routing and repairs previously omitted implicit routes.
- Existing managed PostgreSQL databases start without requiring access to the `postgres` maintenance database.
- Failed provider connections return to Connections with the relevant recovery guidance.

## 0.8.0 - 2026-08-25

### Added

- Pull-request-created and pull-request-label-added workflows now receive GitHub webhook deliveries.
- GitHub issue and pull-request triggers now react on the item with `eyes` when accepted, then `+1` on success or `-1` on failure.

### Fixed

- Workflows triggered by Discord, Slack, GitHub, or manual input can use capabilities owned by another provider without losing valid authority.
- Workflow preparation failures retain their actual safe reason instead of being reported as `daemon_unreachable`.
- Deleting a Discord trigger message no longer leaves Hub retrying an impossible terminal reaction.

## 0.7.0 - 2026-08-23

### Added

- A post-app onboarding step that gives operators the exact `paseo hub login` command, watches for their daemon to connect, and lands them in the Default project.
- An authenticated setup-resources API for guided clients to discover usable GitHub repositories, Slack workspaces, and Discord servers.

### Changed

- Textual triggers now preserve the complete message as `${{ paseo.prompt }}` while exposing parsed typed inputs separately.
- Startup logs print the complete browser URL for the running Hub.

### Fixed

- Legacy project Activity URLs redirect to the active organization's canonical Activity page.
- Trigger prompts no longer lose mentions, typed-input headers, surrounding whitespace, or text before a suffix mention.

## 0.6.0 - 2026-08-21

### Added

- Explicit GitHub triggers for created issues, pull requests, issue comments, pull request comments, and labels added to issues or pull requests.
- Case-insensitive GitHub label filters for the label changed by an event and the labels currently present on an issue or pull request.

### Changed

- GitHub App onboarding now includes pull request events. Existing GitHub trigger names remain compatible with their previous behavior.

## 0.5.1 - 2026-08-20

### Fixed

- Production startup ignores `.env` files, so zero-configuration launches use embedded storage even when run from a directory containing unrelated database settings.

## 0.5.0 - 2026-08-20

### Added

- A zero-configuration local start with an embedded PGlite database, generated durable authentication secret, and first-run operator account setup.
- Browser-guided GitHub, Slack, and Discord app onboarding.
- Slack Socket Mode for local bots that do not have a public URL.
- A published `@getpaseo/hub` package that runs with `npx @getpaseo/hub`.

### Changed

- Embedded Hub data now lives under `$XDG_DATA_HOME/paseo-hub`, falling back to `~/.local/share/paseo-hub`.
- Configuration deployment can create or restore its implicit target project.

### Fixed

- Slack username allowlists resolve consistently during provider setup.

## 0.4.0 - 2026-08-12

### Added

- Execution-scoped worktree branch templates with `${{ paseo.execution.id }}` for unique branches that remain stable through retries and recovery.
- Structured server logs for connection callbacks, provider event intake and routing, and workflow failures without recording event payloads or credentials.
- A ready-to-adapt single-repository team bot example.

### Changed

- Provider reactions now follow the workflow run instead of each step, preventing duplicate reactions in multi-step workflows.

### Fixed

- Discord replies create or reuse one conversation thread, and explicitly requested context includes the directly referenced message.
- Terminal workflow notifications are not lost when recovery and completion overlap.

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

## 0.1.0 - 2026-08-07

### Added

- Self-hosted automation for Paseo daemons with durable PostgreSQL-backed workflows.
- Discord, Slack, GitHub, and manual triggers for multi-step agent workflows.
- Project configuration through the dashboard, GitHub synchronization, prompt partials, and `paseo hub deploy`.
- Organization authentication, daemon enrollment, API keys, and scoped access controls.
- Stripe billing, organization usage visibility, and operator-managed plan limits.
- A versioned public API with an OpenAPI 3.1 specification and interactive reference.
