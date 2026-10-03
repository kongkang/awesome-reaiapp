---
title: Cloud capabilities and workflows
description: English reading guide to the ReAI cloud capabilities and workflows specification.
---

# Cloud capabilities and workflows

> English reading guide. The [complete Chinese specification](/wainao-cloud-workflow-distribution-v1) remains the authoritative source for exact fields, examples, implementation status, and historical details. This page is a concise guide, not a full translation.

## Keep cloud distribution and execution contracts separate

- Cloud capability discovery and workflow distribution do not automatically grant execution rights or raw internal values.

- Use supported identifiers, scoped authorization, explicit input and output contracts, and the actual deployed API capabilities.

- Track real execution outcomes and preserve request identity through failures and cancellation. Do not claim production behavior from a prototype or declaration.

- Read the full source for workflow packaging, capability contracts, distribution rules, and the implementation versus planning boundary.

## Continue reading

- [Complete Chinese specification](/wainao-cloud-workflow-distribution-v1)
- [Documentation overview](/en/)
- [Plugin development](/en/plugin-development-v1)
- [API reference](/en/plugin-api-reference-v1)
- [Packaging and submission](/en/plugin-submission-v1)

Source: `docs/wainao-cloud-workflow-distribution-v1.md`.
