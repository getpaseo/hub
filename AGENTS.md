# Paseo Hub

Paseo Hub is the self-hosted open-source automation layer that works obove your existings Paseo (getpaseo/paseo) daemons.

This repository contains the self-hosted codebase and the Fly configuration that deploys the hosted multi-tenant Paseo Hub service. Billing (`src/billing/`) is part of that hosted deployment only — it is inert without `STRIPE_SECRET_KEY`, and self-hosted instances run with no billing surface at all. See docs/entitlements.md (core, self-hosted included) and docs/billing.md (hosted only).

The public docs (served at https://paseo.sh/docs/hub) live in the main Paseo repository under `public-docs/`, keep it up to date with any relevant externallly observable changes. Update via PR.

# Product Vision

Paseo Hub is an open, self-hosted coordination layer for the agents users already run.

It connects conversations and events from services such as GitHub, Slack, and Discord to configurable, multi-step agent workflows without taking ownership of the user's code, credentials, infrastructure, or security model.

Hub provides explicit building blocks: triggers, routing, environments, provider settings, credentials, context, outputs, and completion contracts. Workflow authors decide which building blocks each step receives and how they are composed. Hub must never silently broaden permissions, inject context, rewrite prompts, or impose a particular way of working.

Provider-specific capabilities remain provider-specific. Paseo validates and passes them through faithfully, allowing users to rely on each provider's native sandboxing, permission modes, models, and documented behavior rather than learning lossy Paseo abstractions.

The goal is to make sophisticated agent workflows easy to assemble while keeping authority visible, configuration portable, and control with the operator. Defaults should make common workflows straightforward, but every consequential behavior must remain explicit and optional.

# Project Status

This is a project in early-development, take advantage of not needing to implement back compat shims, do clear cuts and hard refactors.
