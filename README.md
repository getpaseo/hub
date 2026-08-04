# Paseo Hub

## Local development

### Toolchain

Paseo Hub uses the same foundation as the Paseo monorepo: `tsgo` for
typechecking, OXC for linting and formatting, Vitest for tests, and Lefthook
for pre-commit checks.

```sh
npm run typecheck
npm run lint
npm run format:check
npm test
```

TypeScript is intentionally strict for new hub code, including indexed access,
optional property, override, return-path, catch-variable, and index-signature
checks. OXC treats explicit `any` as an error.

Required env for Hub dispatch:

```sh
export PASEO_HUB_PUBLIC_URL=https://hub.example.com
export PASEO_HUB_COMPLETION_TOKEN_SECRET="$(openssl rand -base64 32)"
export CODEX_AUTH_JSON_PATH=~/.codex/auth.json
# or: export CLAUDE_CODE_OAUTH_TOKEN=...
```

Persist `PASEO_HUB_COMPLETION_TOKEN_SECRET` in the deployment secret store. Hub refuses
GitHub, Discord, Slack, and manual agent dispatch when it is absent; changing it while executions are
nonterminal invalidates their restart recovery callbacks. It is intentionally separate from
organization-scoped API keys used by machine-facing routes.

The account and organization dashboard also requires a stable Better Auth secret and its public
origin:

```sh
export BETTER_AUTH_URL=https://hub.example.com
export BETTER_AUTH_SECRET="$(openssl rand -base64 32)"
```

For a fresh or migrated deployment, set `PASEO_BOOTSTRAP_ORGANIZATION`,
`PASEO_BOOTSTRAP_OWNER_EMAIL`, and `PASEO_BOOTSTRAP_OWNER_PASSWORD` together. Startup creates (or
attaches to the organization preserved by the forward migration) one owner with a temporary
password and requires its replacement at first sign-in. Bootstrap is durable and idempotent;
changing or removing the settings after completion never resets the owner. Keep
`PASEO_REGISTRATION_MODE=invite_only` and `PASEO_ORGANIZATION_CREATION=disabled` for the hosted
single-customer deployment. After replacing the temporary password, remove
`PASEO_BOOTSTRAP_OWNER_PASSWORD` from the deployment secret store; the organization and owner
email settings may remain. Machine automation uses organization-scoped API keys from the API keys
dashboard; the scopes are configuration installation, manual runs, and daemon enrollment.

For Fly, install the value as a secret rather than adding it to `fly.toml`:

```sh
fly secrets set -a paseo-hub \
  PASEO_HUB_COMPLETION_TOKEN_SECRET="$(openssl rand -base64 32)"
```

For Docker, pass the same persisted runtime secret and public Hub origin:

```sh
docker run --env-file .env -p 3000:3000 paseo-hub
```

Optional env:

```sh
export DATABASE_URL=postgres://postgres:postgres@localhost:5432/paseo_hub
export PASEO_TEST_DATABASE_URL=postgres://postgres:postgres@localhost:5432/paseo_hub_test
export PASEO_HUB_BIND=127.0.0.1
export PORT=3000
```

Bind defaults to `0.0.0.0`, overrideable with `PASEO_HUB_BIND`.

Persisted organization bindings select the tenant for GitHub, Discord, and Slack events. Configure
the GitHub App, Discord application, and Slack app credentials shown in `.env.example` to make those providers
ready. The Connections dashboard keeps provider readiness separate from an organization's
verified binding state.

### Execution timeouts

Each hub trigger has an absolute execution timeout and an inactivity timeout. The absolute
`timeout` defaults to `1h`. The `idle_timeout` starts only when the daemon reports the agent idle,
resets on another idle report, and clears when the agent reports running or initializing; it
defaults to `5m`. Authenticated agent completion remains authoritative. Both fields accept a
positive duration with `ms`, `s`, `m`, or `h`, up to `24h`.

```yaml
triggers:
  - name: faro-mention
    on: github.issue_comment
    environment: faro
    timeout: 1h
    idle_timeout: 5m
    filters:
      from_users: [boudra]
    agent:
      provider: codex
      mode: full-access
    prompt: Handle the request.
```

Start the hub:

```sh
npm install
npm run db:migrate
PORT=3001 npm run dev
```

### Dispatch

Hub persists matching triggers and executions, then dispatches agents to the connected
daemon selected by the configured daemon environment. Enroll the daemon with Hub and
connect it with `paseo hub connect`; Hub owns create, reconnect recovery, output observation, and
completion for that daemon.

Dispatch can start from a named manual run at `POST /api/manual-runs`, a signed GitHub webhook,
a Discord mention received by the configured bot gateway, or a signed Slack Events API mention.
Test-only fixture routes remain
closed in production; the functional harness enables them explicitly.

### Trigger merge data

Trigger data is read-only interpolation context under `paseo.event.<provider>`. Providers expose
their native concepts instead of shared, unnamespaced aliases. Merge values can be used in trigger
prompts and `env`, and in daemon worktree branch fields. They enter an agent's environment only when
configuration explicitly maps them in `env`.

- GitHub webhook payload fields live directly under `paseo.event.github`, for example
  `comment.body`, `issue.number`, `repository.full_name`, and `sender.login`. The envelope also
  provides `delivery_id`, `event_name`, `repository_full_name`, `installation_id`, `received_at`,
  and `trigger_url` when the webhook has a canonical URL.
- Discord exposes `paseo.event.discord.trigger_message` with `id`, `content`, mention-stripped
  `body`, `url`, `author`, `channel`, nullable `thread`, `created_at`, typed `attachments`, and
  nullable `referenced_message` identity. Each attachment has `id`, `filename`, `url`,
  `content_type`, and `size`; referenced-message identity has `id`, `channel_id`, and `guild_id`.
  In a thread,
  `paseo.event.discord.trigger_thread_context.messages` contains typed preceding messages in
  oldest-first order and never includes the triggering message. Context messages expose the same
  identity, content, author, channel, creation time, attachment, and reference fields.
- Slack exposes `event_type`, `event_id`, `event_ts`, `event_time`, `team`, and `app` under
  `paseo.event.slack`, plus a typed `trigger_message` with `ts`, `content`, mention-stripped `body`,
  `author`, `channel`, nullable `thread`, and `created_at`. A root message has `thread: null`; reply
  routing separately falls back to its message `ts`. `created_at` is derived from the native
  message `ts`, while `event_time` retains the Events API envelope time.
- Manual runs expose `actor`, `input`, `config`, `trigger`, `delivery_id`, and optional
  `expected_version_id` under `paseo.event.manual`.

For example:

```yaml
prompt: Handle ${{ paseo.event.github.comment.body }}
env:
  SOURCE_URL: ${{ paseo.event.github.trigger_url }}
```

Hub does not inject Discord, Slack, or GitHub trigger context environment variables. Execution
capabilities remain system-owned: agents receive the Hub execution capability, and GitHub-triggered
executions receive their scoped `GH_TOKEN`.

### Slack Events API

Slack uses HTTP Event Subscriptions only; Socket Mode is not used. Create the app from
[`slack-app-manifest.yml`](./slack-app-manifest.yml) after replacing `hub.example.com` with the
public Paseo Hub hostname, or configure the same values manually:

1. Add the bot scopes `app_mentions:read`, `chat:write`, and `reactions:write`.
2. Set the OAuth redirect URL to
   `<PASEO_HUB_PUBLIC_URL>/api/integrations/slack/callback`.
3. Enable Event Subscriptions with request URL
   `<PASEO_HUB_PUBLIC_URL>/api/integrations/slack/events` and subscribe to `app_mention`.
4. Copy the App ID, Client ID, Client Secret, and Signing Secret into the corresponding
   `SLACK_*` environment variables, restart Hub, and connect the workspace from Connections.
5. Invite the installed bot to each channel where mentions should run.

Configure Slack triggers with Slack IDs, not display names:

```yaml
triggers:
  - name: slack-mention
    on: slack.mention
    environment: production
    filters:
      workspace: T01234567
      channels: [C01234567]
      from_users: [U01234567]
    agent:
      provider: provider/model
      mode: full-access
    prompt: Handle ${{ paseo.event.slack.trigger_message.body }}
    allow_outputs:
      - type: slack.reply
```

Replies are plain-text thread replies. Direct messages, slash commands, interactive components,
and Enterprise Grid organization-wide installs are outside this first Slack trigger slice.

Hub owns the Hub wire schemas it validates and has no build or runtime dependency on Paseo npm
packages. The cross-repository compatibility E2E packages a source checkout of Paseo separately;
set `PASEO_E2E_WORKTREE` to that checkout before running `npm run test:e2e:hub:source`.
With a locally authenticated Codex CLI, `npm run test:e2e:hub:real-agent` runs an opt-in smoke that
uses the production manual trigger and proves from the daemon's canonical timeline that Codex called
`hub.finish_execution` successfully. The smoke never starts the deterministic completion helper and
uses Codex full-access mode so the unattended MCP call cannot pause for local approval.

Every dispatched agent receives a per-execution MCP server authenticated by a bearer derived from
`PASEO_HUB_COMPLETION_TOKEN_SECRET`. The server exposes `finish_execution` and, when authorized by
`allow_outputs`, one server-context reply tool for Slack or Discord. The bearer and endpoint are
passed in the Hub create request rather than exposed as agent environment variables. Hub fails
dispatch closed when the secret is absent, and the secret must remain stable across Hub process
restarts.

Hub recovers both a lost create response and a reconnect by resending the original create intent
with the same durable execution ID. The daemon returns the existing agent and its current snapshot
without running the prompt again. A closed or errored agent is failed as `agent_interrupted`;
Hub does not create a second agent or accept a replacement completion.

### Database

Local development uses Postgres at `postgres://postgres:postgres@localhost:5432/paseo_hub` by default. Tests use the separate database `paseo_hub_test`, overrideable with `PASEO_TEST_DATABASE_URL`.

The DB module uses Drizzle with the `pg` node-postgres driver. It keeps pooling and migrations simple for the local Docker Postgres path.

Run migrations:

```sh
npm run db:migrate
```

Current migrations live under `drizzle/` and are applied by `npm run db:migrate`. Migrations are
forward-only: retain durable account and organization identities and correct schema changes
forward rather than maintaining old-application compatibility or down migrations.

Inspect recent triggers and runs:

```sh
psql postgres://postgres:postgres@localhost:5432/paseo_hub \
  -c "select t.delivery_id, t.dropped_reason, r.id as run_id, r.status from triggers t left join runs r on r.trigger_id = t.id order by t.received_at desc limit 10;"
```

Run the database lifecycle suite:

```sh
PASEO_TEST_DATABASE_URL=postgres://postgres:postgres@localhost:5432/paseo_hub_test npm test
```

Source map:

- Composition root: `src/index.ts`
- Authentication and instance policy: `src/auth/`
- Database schema and typed query module: `src/db/`
- Dispatcher trigger persistence and Hub dispatch: `src/dispatcher/index.ts`
- Daemon enrollment, execution, and reconnect recovery: `src/daemons/`
- Trigger provider contract: `src/triggers/index.ts`
- Organization connection authority and provider clients: `src/connections/`
- Logger redaction: `src/logger.ts`
