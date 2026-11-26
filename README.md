<p align="center">
  <img src="https://paseo.sh/logo.svg" width="64" height="64" alt="Paseo logo">
</p>

<h1 align="center">Paseo Hub</h1>

<p align="center">Run coding agents from GitHub, Linear, Slack, and Discord on your own Paseo daemons.</p>

<p align="center">
  <a href="https://paseo.sh/docs/hub">Docs</a> ·
  <a href="https://github.com/getpaseo/paseo">Paseo</a> ·
  <a href="LICENSE">Apache 2.0</a>
</p>

> [!WARNING]
> Paseo Hub is in early development. Expect breaking changes and data loss. [Join the Paseo Discord](https://discord.gg/jz8T2uahpH) to learn more about the project.

Paseo Hub is the self-hosted automation layer for [Paseo](https://paseo.sh). Connect the services where work arrives and run agents on the machines where your development environments already live.

- **Your machines:** Hub dispatches to Paseo daemons on your laptop, devbox, or build server.
- **Your configuration:** Keep triggers, environments, permissions, and prompts in version control.
- **Your services:** Start agents from GitHub, Linear, Slack, Discord, or manual runs.
- **One audit trail:** See every event, configuration revision, execution, and result.

```text
 GitHub ─┐                 ┌─ laptop
 Linear ─┼─ Paseo Hub ────┼─ devbox
 Slack  ─┤                 └─ build server
 Discord ┘
```

## Quick start

You need Node.js and [Paseo installed and running](https://paseo.sh/docs).

```sh
npx @getpaseo/hub
```

Open the local URL printed by Hub. Create the operator account, then follow the browser setup to connect GitHub, Slack, or Discord. Slack Socket Mode works without a public URL.

From the repository where agents should work, run:

```sh
paseo hub init
```

Choose the local Hub URL when prompted. The guided setup connects your daemon, uses the default project created during onboarding, detects the selected app connection, writes a safe starter workflow, validates it, and offers to deploy it.

See the [Hub documentation](https://paseo.sh/docs/hub) for PostgreSQL, Docker, public URLs, environment-managed configuration, and production deployment.

## Develop locally

You need Node.js and npm. A fresh checkout runs with an embedded database and no external services:

```sh
npm install
npm run dev
```

Open <http://localhost:3000>. Hub stores the embedded database and its generated authentication secret under `$XDG_DATA_HOME/paseo-hub`, falling back to `~/.local/share/paseo-hub`, and keeps both across restarts. Set `PASEO_HUB_DATA_DIR` to use a different directory, or set `DATABASE_URL` to use PostgreSQL instead:

```sh
DATABASE_URL=postgres://postgres:postgres@localhost:5432/paseo_hub npm run dev
```

Embedded mode supports one Hub process per data directory. Docker Compose continues to run Hub with PostgreSQL.

## Run with Docker Compose

You need Docker, Docker Compose, and a public HTTPS URL when connecting external providers.

```sh
git clone https://github.com/getpaseo/hub.git
cd hub
cp .env.example .env
```

Set these values in `.env`:

```dotenv
PASEO_HUB_APP_URL=https://hub.example.com
PASEO_BOOTSTRAP_ORGANIZATION=My organization
PASEO_BOOTSTRAP_OWNER_EMAIL=me@example.com
PASEO_BOOTSTRAP_OWNER_PASSWORD=replace-with-a-temporary-password
```

Hub generates and stores its authentication secret in the database. Advanced deployments may set
`PASEO_HUB_AUTH_SECRET` to override it without replacing the stored secret.

Billing is optional: leave `STRIPE_SECRET_KEY` unset and Hub runs with no billing surface at all. See [docs/billing.md](docs/billing.md).

Email delivery is optional too: set `RESEND_API_KEY` and `RESEND_FROM` to email organization
invitations, signup verification links, and password-reset links through Resend. Configured
instances require new password accounts to verify their email before sign-in. Without delivery
configuration, managers retain the existing copy-and-share invitation workflow.

Sign-in with Google or GitHub is optional. Set `PASEO_AUTH_GOOGLE_CLIENT_ID` and
`PASEO_AUTH_GOOGLE_CLIENT_SECRET`, or `PASEO_AUTH_GITHUB_CLIENT_ID` and
`PASEO_AUTH_GITHUB_CLIENT_SECRET`, to show that provider's button. Hub refuses to start with only
half of a pair. Register `<PASEO_HUB_APP_URL>/api/auth/callback/google` or `/github` as the
callback. GitHub sign-in needs its own OAuth App, separate from the GitHub App that sends repository
events. New accounts from a provider follow `PASEO_REGISTRATION_MODE`. A provider sign-in links
to an existing account with the same email only when the provider has verified the address and
the account has verified it in Hub. Hub accepts Google's verification only for Gmail and Workspace
addresses.

Then start Hub and PostgreSQL:

```sh
docker compose up -d
```

Open `PASEO_HUB_APP_URL`, sign in with the bootstrap account, and replace its temporary password. Connect a daemon with:

```sh
paseo hub connect https://hub.example.com
```

The image is published as `ghcr.io/getpaseo/hub:latest`.

Before your first Fly deploy, copy `fly.example.toml` to `fly.toml` in your Hub checkout.
Set `app`, `primary_region`, and `PASEO_HUB_APP_URL` to match your Fly app.

See the [self-hosting guide](https://paseo.sh/docs/hub/self-hosting) for production deployment details.
For Linear setup and workflows, see the public [Linear app](https://paseo.sh/docs/hub/self-hosting/linear-app) and [Linear triggers](https://paseo.sh/docs/hub/triggers/linear) guides.

## Run on NixOS

The repository ships a Nix flake that builds the Hub and provides a NixOS module that runs it as a hardened `systemd` service under a dedicated `paseo-hub` user. With flakes enabled, add the flake as an input and enable `services.paseo-hub`:

```nix
# flake.nix
{
  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    paseo-hub.url = "github:getpaseo/hub";
  };

  outputs = { self, nixpkgs, paseo-hub, ... }: {
    nixosConfigurations.host = nixpkgs.lib.nixosSystem {
      modules = [
        paseo-hub.nixosModules.default
        {
          services.paseo-hub.enable = true;

          # Canonical external origin Hub advertises and uses for links/redirects.
          services.paseo-hub.appUrl = "https://hub.example.com";

          # Optional: bind to loopback and let a reverse proxy terminate TLS.
          # services.paseo-hub.address = "127.0.0.1";
          # services.paseo-hub.trustedClientIpHeader = "X-Forwarded-For";
          # services.paseo-hub.openFirewall = false; # true opens services.paseo-hub.port

          # Optional: use PostgreSQL instead of the embedded database.
          # services.paseo-hub.databaseUrl =
          #   "postgres://postgres:postgres@localhost:5432/paseo_hub";

          # Pass through any Hub configuration verbatim (see .env.example).
          # Prefer environmentFile for secrets so they stay out of the Nix store.
          # services.paseo-hub.environment = {
          #   PASEO_REGISTRATION_MODE = "invite_only";
          # };
          # services.paseo-hub.environmentFile = "/run/secrets/paseo-hub.env";
        }
      ];
    };
  };
}
```

```sh
nixos-rebuild switch --flake .#host
```

The module maps `services.paseo-hub` options (`port`, `address`, `appUrl`, `dataDir`, `databaseUrl`, `trustedClientIpHeader`) onto the Hub's runtime environment variables, and passes any other configuration through `environment` / `environmentFile`. State persists under `/var/lib/paseo-hub` by default; set `services.paseo-hub.dataDir` to change it. To run Hub once without a service, use the package directly:

```sh
nix run github:getpaseo/hub
```

## Provider options and Hub tools

Workflow steps may pass a JSON-compatible, provider-native `agent.options` object. Hub preserves
the names and nesting exactly; the selected Paseo provider validates and applies them:

```yaml
agent:
  provider: codex
  model: gpt-5.5
  mode: full-access
  thinkingOptionId: high
  options:
    sandbox_workspace_write:
      writable_roots:
        - /var/cache/npm
      network_access: false
```

Options and modes are specific to the selected provider and are not portable. New triggers require
an explicit `mode`; `thinkingOptionId` may be omitted to use the provider default. Hub always grants
the execution-scoped `finish_execution` tool. Conversational triggers also receive an unlimited
event-native `reply` tool for progress and final responses. Provider or machine policy still
controls every unrelated tool. A read-only provider configuration is defense in depth; Hub output
authorization remains enforced by the execution MCP server.

### Scoped Slack and Discord tools

Open **Integration tools** in the trigger editor, select an integration, enter channel IDs, and
choose **Read**, **Post**, or both. The same grants work in any trigger's `run.tools` block in
`.paseo/triggers/*.yml`:

```yaml
run:
  tools:
    slack:
      connection: engineering-slack
      actions: [post]
      channels: [C012AB3CD]
    discord:
      connection: community-discord
      actions: [read, post]
      channels: ["123456789012345678"]
```

Use the integration slug and channel IDs. Edit triggers whose grants use anchors or aliases in
YAML. Discord thread and forum post access follows the
allowlist for their parent channel. Use a message URL or provide its channel and message IDs.
To load older messages, pass the tool's returned pagination value to the next read. When a grant
changes, use **New agent** or a new continuation
key for the next run. Hub checks the connection, action, and destination on every call and keeps
provider credentials on the server.

| Grant        | Hub MCP tools                                                                                                                                                                                                                           |
| ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Slack read   | `slack_list_channels` lists granted IDs. `slack_read` reads channel or thread messages.                                                                                                                                                 |
| Slack post   | `slack_post` posts to a channel or replies using its starter's `thread_ts`.                                                                                                                                                             |
| Discord read | `discord_list_channels` lists granted channels and forums. `discord_read` reads an exact ID or URL with thread context and attachment metadata. `discord_latest` scans recent messages, including active and recently archived threads. |
| Discord post | `discord_post` posts to a channel, replies in a thread, or starts a thread on a channel message.                                                                                                                                        |

## Scheduled triggers

Choose Schedule in the trigger editor to run agents daily or on selected weekdays, at one or more
local times. See [scheduled triggers](docs/scheduled-triggers.md) for setup, YAML, timezone rules,
and recovery behavior.

## Public API

Each Hub serves a self-hosted API reference at `/api/reference` and its generated OpenAPI 3.1 contract at `/api/openapi.json`. The short [public API guide](docs/public-api.md) covers CLI login, versioning, credential scopes, and request correlation.

## License

Apache-2.0
