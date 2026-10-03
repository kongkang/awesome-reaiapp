---
title: Skin development
description: English reading guide to the ReAI skin development specification.
---

# Skin development

> English reading guide. The [complete Chinese specification](/skin-development-v1) remains the authoritative source for exact fields, examples, implementation status, and historical details. This page is a concise guide, not a full translation.

## Use the skin contract to change appearance safely

- Treat skins as independently declared packages with stable identity and compatible versions. Use supported theme tokens rather than manipulating Host DOM.

- Keep structural behavior, interaction boundaries, and accessibility intact when changing visual appearance.

- Check both light and dark modes, narrow layouts, focus visibility, status contrast, and resource loading.

- Consult the source for the exact Manifest fields, permitted resources, and packaging and review requirements.

## Continue reading

- [Complete Chinese specification](/skin-development-v1)
- [Documentation overview](/en/)
- [Plugin development](/en/plugin-development-v1)
- [API reference](/en/plugin-api-reference-v1)
- [Packaging and submission](/en/plugin-submission-v1)

Source: `docs/skin-development-v1.md`.
