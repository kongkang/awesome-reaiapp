---
title: Network, data sharing, and billing
description: English reading guide to the ReAI network, data sharing, and billing specification.
---

# Network, data sharing, and billing

> English reading guide. The [complete Chinese specification](/network-billing-policy-v1) remains the authoritative source for exact fields, examples, implementation status, and historical details. This page is a concise guide, not a full translation.

## Make external access and costs explicit

- Declare the actual network and data-sharing capabilities needed by the plugin. Use the supported platform contracts rather than private request paths.

- Keep account and permission boundaries intact. Obtain the required authorization before cloud processing or external sharing.

- Represent provider failures and unknown results honestly. A timeout does not establish success, free usage, or a safe blind retry.

- Use the source for exact billing, network, and reconciliation contracts. Documentation and mocks do not prove a production billing result.

## Continue reading

- [Complete Chinese specification](/network-billing-policy-v1)
- [Documentation overview](/en/)
- [Plugin development](/en/plugin-development-v1)
- [API reference](/en/plugin-api-reference-v1)
- [Packaging and submission](/en/plugin-submission-v1)

Source: `docs/network-billing-policy-v1.md`.
