---
title: Agent Service v2
description: English reading guide to the ReAI agent service v2 specification.
---

# Agent Service v2

> English reading guide. The [complete Chinese specification](/agent-service-v2) remains the authoritative source for exact fields, examples, implementation status, and historical details. This page is a concise guide, not a full translation.

## Make engine selection and sessions explicit

- Engine selection, session identity, lifecycle, and capability availability must follow the declared service contract.

- Preserve the relationship between an actual request and its session. Do not treat a selected engine name as proof that execution succeeded.

- Handle unavailable engines, required authorization, cancellation, and terminal states using the actual runtime response.

- Refer to the source for the precise v2 fields, compatibility boundaries, and implementation status.

## Voice attachment candidate

- Text attachments accept strictly decoded UTF-8 and UTF-16 with a BOM. The original text-file limit remains 64 KiB; decoding failures are rejected.

- Incompatible PDF Worker caches or handshake errors return `VOICE_ATTACHMENT_DOCUMENT_UNAVAILABLE`. Cancellation returns `AbortError`; an unresponsive handshake uses the existing 20-second document deadline and returns `VOICE_ATTACHMENT_DOCUMENT_TIMEOUT`.

- These details describe the existing Voice source candidate. Platform approval, signing, and real Host verification remain separate.

## Continue reading

- [Complete Chinese specification](/agent-service-v2)
- [Documentation overview](/en/)
- [Plugin development](/en/plugin-development-v1)
- [API reference](/en/plugin-api-reference-v1)
- [Packaging and submission](/en/plugin-submission-v1)

Source: `docs/agent-service-v2.md`.
