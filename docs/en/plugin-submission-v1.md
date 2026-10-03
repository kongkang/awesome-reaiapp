---
title: Packaging and submission
description: English reading guide to the ReAI packaging and submission specification.
---

# Packaging and submission

> English reading guide. The [complete Chinese specification](/plugin-submission-v1) remains the authoritative source for exact fields, examples, implementation status, and historical details. This page is a concise guide, not a full translation.

## Prepare a reproducible review candidate

- Keep Manifest, package.json, and submission identity versions aligned. Stable appId and contribution IDs must survive renames and localization.

- Run independent validation, tests, type checks, builds, contract tests, and packaging using the plugin's existing commands and frozen dependencies.

- Before each review submission, write user-facing release notes from real changes and verification evidence. Keep retries of the same version and payload traceable.

- Source review, signing, platform approval, public release, and Host installation are separate states. Never reuse an old approval for changed bytes or bypass a rejection.

## Continue reading

- [Complete Chinese specification](/plugin-submission-v1)
- [Documentation overview](/en/)
- [Plugin development](/en/plugin-development-v1)
- [API reference](/en/plugin-api-reference-v1)
- [Packaging and submission](/en/plugin-submission-v1)

Source: `docs/plugin-submission-v1.md`.
