---
title: Agent controlled run tools
description: English reading guide to the ReAI agent controlled run tools specification.
---

# Agent controlled run tools

> English reading guide. The [complete Chinese specification](/agent-controlled-run) remains the authoritative source for exact fields, examples, implementation status, and historical details. This page is a concise guide, not a full translation.

## Keep automated execution within authorized boundaries

- A tool call must operate through supported capabilities and the permissions of its current context. Do not infer access from a UI label or source declaration alone.

- Validate the actual request identity and payload before starting work, and preserve clear cancellation and completion states.

- Use scoped data and resources. Avoid exposing internal bridge details or silently expanding account access.

- The source defines exact controlled-run tool contracts and constraints. Use those fields rather than constructing a private parallel API.

## Continue reading

- [Complete Chinese specification](/agent-controlled-run)
- [Documentation overview](/en/)
- [Plugin development](/en/plugin-development-v1)
- [API reference](/en/plugin-api-reference-v1)
- [Packaging and submission](/en/plugin-submission-v1)

Source: `docs/agent-controlled-run.md`.
