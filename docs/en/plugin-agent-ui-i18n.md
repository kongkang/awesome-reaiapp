---
title: Instance-scoped agent UI localization
description: English reading guide to the ReAI instance-scoped agent ui localization specification.
---

# Instance-scoped agent UI localization

> English reading guide. The [complete Chinese specification](/plugin-agent-ui-i18n) remains the authoritative source for exact fields, examples, implementation status, and historical details. This page is a concise guide, not a full translation.

## Keep shared UI language scoped to an instance

- Shared agent UI should receive the language and translation context for the actual mounted instance. Do not let a global mutable locale affect another account or Surface.

- Keep instance cleanup explicit and avoid stale locale listeners after unmount or rapid plugin switching.

- Preserve draft input, focus, and conversation state when language changes. Historical messages and model output are not interface translations.

- Check the original shared-library contract and the actual consumer before assuming Host-wide language behavior.

## Continue reading

- [Complete Chinese specification](/plugin-agent-ui-i18n)
- [Documentation overview](/en/)
- [Plugin development](/en/plugin-development-v1)
- [API reference](/en/plugin-api-reference-v1)
- [Packaging and submission](/en/plugin-submission-v1)

Source: `docs/plugin-agent-ui-i18n.md`.
