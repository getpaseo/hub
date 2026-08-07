<p align="center">
  <img src="https://paseo.sh/logo.svg" width="64" height="64" alt="Paseo logo">
</p>

<h1 align="center">Paseo Hub</h1>

<p align="center">Run coding agents from GitHub, Slack, and Discord on your own Paseo daemons.</p>

<p align="center">
  <a href="https://paseo.sh/docs/hub">Docs</a> ·
  <a href="https://github.com/getpaseo/paseo">Paseo</a> ·
  <a href="LICENSE">Apache 2.0</a>
</p>

> [!WARNING]
> Paseo Hub is in early development. Expect breaking changes and data loss. [Join the Paseo Discord](https://discord.gg/jz8T2uahpH) to learn more about the project.

Paseo Hub is the self-hosted automation layer for [Paseo](https://paseo.sh). Connect the services where work arrives, describe agents as code in `.paseo/hub.yml`, and run them on the machines where your development environments already live.

- **Your machines:** Hub dispatches to Paseo daemons on your laptop, devbox, or build server.
- **Your configuration:** Keep triggers, environments, permissions, and prompts in version control.
- **Your services:** Start agents from GitHub, Slack, Discord, or manual runs.
- **One audit trail:** See every event, configuration revision, execution, and result.

```text
 GitHub ─┐                 ┌─ laptop
 Slack  ─┼─ Paseo Hub ────┼─ devbox
 Discord ┘                 └─ build server
```

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
PASEO_HUB_AUTH_SECRET=replace-with-the-output-of-openssl-rand-hex-32
PASEO_BOOTSTRAP_ORGANIZATION=My organization
PASEO_BOOTSTRAP_OWNER_EMAIL=me@example.com
PASEO_BOOTSTRAP_OWNER_PASSWORD=replace-with-a-temporary-password
```

Billing is optional and hosted-only: leave `STRIPE_SECRET_KEY` unset and Hub runs with no billing surface at all. See [docs/billing.md](docs/billing.md).

Then start Hub and PostgreSQL:

```sh
docker compose up -d
```

Open `PASEO_HUB_APP_URL`, sign in with the bootstrap account, and replace its temporary password. Connect a daemon with:

```sh
paseo hub connect https://hub.example.com
```

The image is published as `ghcr.io/getpaseo/hub:latest`.

See the [Hub documentation](https://paseo.sh/docs/hub) for provider setup, `.paseo/hub.yml`, Docker, and Fly deployment.

## Public API

Each Hub serves a self-hosted API reference at `/api/reference` and its generated OpenAPI 3.1 contract at `/api/openapi.json`. The short [public API guide](docs/public-api.md) covers versioning, API-key scopes, compatibility aliases, and request correlation.

## License

Apache-2.0
