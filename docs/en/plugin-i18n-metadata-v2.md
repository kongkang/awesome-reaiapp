---
title: Metadata i18n v2 supplement
description: English reading guide to the ReAI metadata i18n v2 supplement specification.
---

# Metadata i18n v2 supplement

> English reading guide. The [complete Chinese specification](/plugin-i18n-metadata-v2) remains the authoritative source for exact fields, examples, implementation status, and historical details. This page is a concise guide, not a full translation.

## Separate package metadata from public catalog text

- The supplement describes versioned localization of plugin metadata. Source support does not establish that the deployed submission baseline accepts the same version.

- Keep appId and contribution IDs stable while localizing labels and descriptions. Validate keys and placeholders across both language resources.

- Public Catalog name, description, and tagline are currently independent single-language strings. Package language packs do not automatically translate public listings.

- Check the current submission contract and original supplement before choosing metadata.i18n versions or preparing a package.

## Continue reading

- [Complete Chinese specification](/plugin-i18n-metadata-v2)
- [Documentation overview](/en/)
- [Plugin development](/en/plugin-development-v1)
- [API reference](/en/plugin-api-reference-v1)
- [Packaging and submission](/en/plugin-submission-v1)

Source: `docs/plugin-i18n-metadata-v2.md`.
