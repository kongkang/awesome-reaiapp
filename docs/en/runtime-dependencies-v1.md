---
title: Runtime dependencies
description: English reading guide to the ReAI runtime dependencies specification.
---

# Runtime dependencies

> English reading guide. The [complete Chinese specification](/runtime-dependencies-v1) remains the authoritative source for exact fields, examples, implementation status, and historical details. This page is a concise guide, not a full translation.

## Use declared, controlled runtime resources

- Declare actual dependencies using the supported Manifest and requirement contract. A local workspace or private runtime is not a public distribution mechanism.

- For managed resources, use stable identifiers registered by the Host. Do not substitute arbitrary URLs, filesystem paths, commands, digests, or signers.

- Handle missing resources, incompatible versions, permissions, and unavailable distribution channels without silently installing executables.

- The source distinguishes implemented requirement types and candidate contracts from planned resource categories and formal release assets.

## Continue reading

- [Complete Chinese specification](/runtime-dependencies-v1)
- [Documentation overview](/en/)
- [Plugin development](/en/plugin-development-v1)
- [API reference](/en/plugin-api-reference-v1)
- [Packaging and submission](/en/plugin-submission-v1)

Source: `docs/runtime-dependencies-v1.md`.
