---
title: Developer platform workflow
description: English reading guide to the system-plugin developer platform workflow candidate.
---

# Developer platform workflow

> English reading guide. The [complete Chinese specification](/developer-platform-workflow-v1) is authoritative for exact fields and limits. This is a Host API 1.21 candidate contract, not a full translation or a released capability. The SDK source now provides `developerPlatform.workflow`, its types, and validation. This does not prove support in an installed Host.

## Restricted system-plugin contract

- Only the approved `com.reai.developer-center` system plugin may use this contract. Ordinary plugins, same-name local packages, and sessions without developer mode cannot call it.
- Host checks the token's actual scopes. A build configuration does not grant new scopes; missing scopes require renewed consent. Requests reject unknown fields, and unknown response states must not be treated as success.
- Material uploads use the Host's native file picker and streaming upload. Packages are limited to 64 MiB and images to 10 MiB; account limits may be lower. The plugin never receives cloud tokens or arbitrary filesystem access.
- Review prechecks report fees and quota, not approval. A charged submission requires user confirmation of the quoted amount and fingerprint. Save the original request and idempotency key; after network failure or restart, inspect that same request before retrying with the same payload.
- Publication uses the expected public revision as a compare-and-swap condition. Confirm success only when the target is published and the current pointer matches its revision. Delisting one target does not prove other versions are delisted; superseded operations must not be replayed automatically.

## Continue reading

- [Complete Chinese specification](/developer-platform-workflow-v1)
- [Documentation overview](/en/)
- [Packaging and submission](/en/plugin-submission-v1)

Source: `docs/developer-platform-workflow-v1.md`. Documentation, toolchain delivery, platform approval, and actual Host verification are separate milestones.
