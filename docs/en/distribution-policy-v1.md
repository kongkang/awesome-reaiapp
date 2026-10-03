---
title: Distribution, Host, and Extension
description: English reading guide to the ReAI distribution, host, and extension specification.
---

# Distribution, Host, and Extension

> English reading guide. The [complete Chinese specification](/distribution-policy-v1) remains the authoritative source for exact fields, examples, implementation status, and historical details. This page is a concise guide, not a full translation.

## Treat distribution channels as separate contracts

- A plugin package, its Host, and an Extension have different distribution and runtime boundaries. A locally built artifact does not establish public availability.

- Use the approved channel and resource contracts for the target platform. Do not silently download executable dependencies from plugin lifecycle hooks.

- Keep source review, signing, platform approval, user installation consent, and runtime authorization as distinct evidence gates.

- Consult the source for precise platform, channel, packaging, and permission restrictions before public distribution.

## Continue reading

- [Complete Chinese specification](/distribution-policy-v1)
- [Documentation overview](/en/)
- [Plugin development](/en/plugin-development-v1)
- [API reference](/en/plugin-api-reference-v1)
- [Packaging and submission](/en/plugin-submission-v1)

Source: `docs/distribution-policy-v1.md`.
