---
title: App, plugin, and device lifecycle
description: English reading guide to the ReAI app, plugin, and device lifecycle specification.
---

# App, plugin, and device lifecycle

> English reading guide. The [complete Chinese specification](/lifecycle-hooks-v1) remains the authoritative source for exact fields, examples, implementation status, and historical details. This page is a concise guide, not a full translation.

## Make resource ownership and cleanup explicit

- Register work at the correct lifecycle boundary and keep repeated activation, mounting, and cleanup safe. Every mounted Surface must reach a ready or fail outcome.

- Unregister events and subscriptions and dispose instance-owned resources when the corresponding scope ends. Do not let stale asynchronous callbacks update a new instance.

- Handle account changes, permission revocation, cancellation, and device disconnection as actual runtime events.

- Lifecycle hooks must not silently complete authorization or download executable dependencies. Consult the source for supported hook names and exact contracts.

## Continue reading

- [Complete Chinese specification](/lifecycle-hooks-v1)
- [Documentation overview](/en/)
- [Plugin development](/en/plugin-development-v1)
- [API reference](/en/plugin-api-reference-v1)
- [Packaging and submission](/en/plugin-submission-v1)

Source: `docs/lifecycle-hooks-v1.md`.
