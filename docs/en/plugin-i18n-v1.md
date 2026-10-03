---
title: Plugin language packs
description: English reading guide to the ReAI plugin language packs specification.
---

# Plugin language packs

> English reading guide. The [complete Chinese specification](/plugin-i18n-v1) remains the authoritative source for exact fields, examples, implementation status, and historical details. This page is a concise guide, not a full translation.

## Use one resource source for Chinese and English

- Maintain zh and en resources with matching keys and interpolation placeholders. Keep stable app and contribution IDs independent of translated display names.

- Connect plugin language to the Host language through the supported contract. Switching language must preserve user input, focus, and business state.

- Cover navigation, settings, errors, empty states, status labels, metadata, and accessibility text. Do not silently change historical content, ASR language, or generated output.

- Package language resources with the plugin and validate the final package. Read the original specification for exact metadata declarations and compatibility requirements.

## Continue reading

- [Complete Chinese specification](/plugin-i18n-v1)
- [Documentation overview](/en/)
- [Plugin development](/en/plugin-development-v1)
- [API reference](/en/plugin-api-reference-v1)
- [Packaging and submission](/en/plugin-submission-v1)

Source: `docs/plugin-i18n-v1.md`.
