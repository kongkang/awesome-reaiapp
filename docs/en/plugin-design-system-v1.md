---
title: Plugin design system
description: English reading guide to the ReAI plugin design system specification.
---

# Plugin design system

> English reading guide. The [complete Chinese specification](/plugin-design-system-v1) remains the authoritative source for exact fields, examples, implementation status, and historical details. This page is a concise guide, not a full translation.

## Build a consistent and restrained interface

- Reuse Host theme tokens and consume the title-bar safe area exactly once. The Host owns its title bar and navigation; do not copy or cover it with plugin controls.

- Use clear groups, consistent spacing, appropriate hit targets, and visible keyboard focus. Keep loading, empty, error, and permission states understandable.

- Keep long tables and code inside their own scrollable regions. Check narrow layouts and both light and dark themes in the actual Host.

- Use the original specification for exact icon, button, drawer, and title-bar rules. Local screenshots and tests do not establish native Host integration.

## Continue reading

- [Complete Chinese specification](/plugin-design-system-v1)
- [Documentation overview](/en/)
- [Plugin development](/en/plugin-development-v1)
- [API reference](/en/plugin-api-reference-v1)
- [Packaging and submission](/en/plugin-submission-v1)

Source: `docs/plugin-design-system-v1.md`.
