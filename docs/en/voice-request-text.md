---
title: Voice text services
description: English reading guide to the ReAI voice text services specification.
---

# Voice text services

> English reading guide. The [complete Chinese specification](/voice-request-text) remains the authoritative source for exact fields, examples, implementation status, and historical details. This page is a concise guide, not a full translation.

## Use the supported text-service boundary

- Declare and invoke the actual versioned service capability. A text request and voice recognition have different inputs and authorization conditions.

- Preserve the user's actual request, current input scope, and selected service context. Interface language does not automatically change generated output language.

- Handle unavailable service, refusal, cancellation, and provider errors using the real contract.

- The source defines precise request and response fields and the current capability boundary; use it when implementing a consumer.

## Continue reading

- [Complete Chinese specification](/voice-request-text)
- [Documentation overview](/en/)
- [Plugin development](/en/plugin-development-v1)
- [API reference](/en/plugin-api-reference-v1)
- [Packaging and submission](/en/plugin-submission-v1)

Source: `docs/voice-request-text.md`.
