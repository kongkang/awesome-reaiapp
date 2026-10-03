---
title: Plugin API reference
description: English reading guide to the ReAI plugin api reference specification.
---

# Plugin API reference

> English reading guide. The [complete Chinese specification](/plugin-api-reference-v1) remains the authoritative source for exact fields, examples, implementation status, and historical details. This page is a concise guide, not a full translation.

## Treat API contracts as versioned boundaries

- Match the declared capability, Host API range, SDK exports, and machine-readable contract. An exported low-level type does not grant permission to use an internal bridge.

- Keep stable contribution IDs. Validate intent source, action ID, and payload before handling actions, and unregister handlers during cleanup.

- Handle unavailable capabilities, permissions, account changes, and stale asynchronous results explicitly. Avoid reporting success until the actual operation is confirmed.

- Consult the Chinese reference for exact request and response fields, error codes, support matrices, and candidate versus released capabilities.

## Continue reading

- [Complete Chinese specification](/plugin-api-reference-v1)
- [Documentation overview](/en/)
- [Plugin development](/en/plugin-development-v1)
- [API reference](/en/plugin-api-reference-v1)
- [Packaging and submission](/en/plugin-submission-v1)

Source: `docs/plugin-api-reference-v1.md`.
