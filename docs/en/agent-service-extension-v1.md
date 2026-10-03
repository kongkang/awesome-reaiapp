---
title: Plugin services and agents
description: English reading guide to the ReAI plugin services and agents specification.
---

# Plugin services and agents

> English reading guide. The [complete Chinese specification](/agent-service-extension-v1) remains the authoritative source for exact fields, examples, implementation status, and historical details. This page is a concise guide, not a full translation.

## Distinguish implemented services from planned extensions

- A service declaration does not automatically provide a callable or authorized runtime. Match the actual supported SDK and capability contract.

- Use scoped authorization and explicit inputs. Handle cancellation, failure, and unavailable dependencies without presenting simulated success.

- Keep sessions and stored data isolated to the proper plugin and account. Clean up instance-owned subscriptions and asynchronous work.

- The original document separates implementation and planning. Consult it for exact service fields and current availability.

## Continue reading

- [Complete Chinese specification](/agent-service-extension-v1)
- [Documentation overview](/en/)
- [Plugin development](/en/plugin-development-v1)
- [API reference](/en/plugin-api-reference-v1)
- [Packaging and submission](/en/plugin-submission-v1)

Source: `docs/agent-service-extension-v1.md`.
