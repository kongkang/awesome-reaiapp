---
title: Plugin development
description: English reading guide to the ReAI plugin development specification.
---

# Plugin development

> English reading guide. The [complete Chinese specification](/plugin-development-v1) remains the authoritative source for exact fields, examples, implementation status, and historical details. This page is a concise guide, not a full translation.

## Build an independent ReAI plugin

- Use a stable appId and declare your actual Host API range. A local source capability or candidate version does not establish that the deployed Host supports it.

- Register contributions during activate. Every mounted Surface must report ready or fail; dispose subscriptions and other resources on unmount.

- Use the public SDK, declare the minimum permissions and capabilities, and handle refusal or revocation. Do not construct private Bridge requests or inject Host DOM.

- Build and validate the plugin in its own directory. Verify the final Manifest, package identity, resources, and target Host before preparing a review submission.

## Continue reading

- [Complete Chinese specification](/plugin-development-v1)
- [Documentation overview](/en/)
- [Plugin development](/en/plugin-development-v1)
- [API reference](/en/plugin-api-reference-v1)
- [Packaging and submission](/en/plugin-submission-v1)

Source: `docs/plugin-development-v1.md`.

## Capability reuse {#capability-reuse}

Reuse platform services through versioned public SDK capabilities. Check supported contracts and actual permissions before calling a service. Candidate source support is separate from a deployed release.
