---
title: Settings, versions, and About links
description: English reading guide to the ReAI settings, versions, and about links specification.
---

# Settings, versions, and About links

> English reading guide. The [complete Chinese specification](/plugin-settings-and-release-notes-v1) remains the authoritative source for exact fields, examples, implementation status, and historical details. This page is a concise guide, not a full translation.

## Make plugin identity and release history easy to find

- Every plugin settings page must show a clickable version and an About entry at the bottom. Read the version from the installed package Manifest.

- The version link opens the release notes for that exact version. About opens the ReAI Open app page identified by its stable appId.

- For every prepared review submission, automatically write the user-facing version introduction from the actual change and validation evidence. Users should not have to supply this prose separately.

- This is a developer workflow requirement. It does not establish that the server already generates or publishes release notes automatically.

## Continue reading

- [Complete Chinese specification](/plugin-settings-and-release-notes-v1)
- [Documentation overview](/en/)
- [Plugin development](/en/plugin-development-v1)
- [API reference](/en/plugin-api-reference-v1)
- [Packaging and submission](/en/plugin-submission-v1)

Source: `docs/plugin-settings-and-release-notes-v1.md`.
