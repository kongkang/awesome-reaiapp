---
title: Subscriptions, credits, and cloud services
description: English reading guide to the ReAI subscriptions, credits, and cloud services specification.
---

# Subscriptions, credits, and cloud services

> English reading guide. The [complete Chinese specification](/driver-cloud-billing) remains the authoritative source for exact fields, examples, implementation status, and historical details. This page is a concise guide, not a full translation.

## Separate account state from service availability

- Subscription state, credit balance, capabilities, and actual cloud calls must be checked against the current account and supported API contract.

- Explain the actual cost and authorization boundary in the relevant flow. Do not infer service access solely from a subscription badge.

- Handle denied access, provider errors, and unknown usage results explicitly. Keep real billing evidence separate from local fixtures.

- The source contains the exact cloud billing and subscription rules and links to the authoritative service contracts.

## Continue reading

- [Complete Chinese specification](/driver-cloud-billing)
- [Documentation overview](/en/)
- [Plugin development](/en/plugin-development-v1)
- [API reference](/en/plugin-api-reference-v1)
- [Packaging and submission](/en/plugin-submission-v1)

Source: `docs/driver-cloud-billing.md`.
