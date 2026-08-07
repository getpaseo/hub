# Paseo Hub

Paseo Hub is the self-hosted open-source automation layer that works obove your existings Paseo (getpaseo/paseo) daemons.

This repository contains the self-hosted codebase and the Fly configuration that deploys the hosted multi-tenant Paseo Hub service. Billing (`src/billing/`) is part of that hosted deployment only — it is inert without `STRIPE_SECRET_KEY`, and self-hosted instances run with no billing surface at all. See docs/entitlements.md (core, self-hosted included) and docs/billing.md (hosted only).

The public docs (served at https://paseo.sh/docs/hub) live in the main Paseo repository under `public-docs/`, keep it up to date with any relevant externallly observable changes. Update via PR.

# Project Status

This is a project in early-development, take advantage of not needing to implement back compat shims, do clear cuts and hard refactors.
