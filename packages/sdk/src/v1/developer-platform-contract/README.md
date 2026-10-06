# Developer Platform contract v1.0

`v1.ts` defines the frozen Developer Platform contract. The matching fixture is `packages/sdk/tests/fixtures/developer-platform-v1.json`. The generated request and response schema is `workflow-schema.json`.

These DTOs do not add Bridge methods or confirm deployment. SDK and Host methods must enforce official plugin, scope and actor gates.

Delist preserves the public revision pointer. Recovery requires both the release status and the selected client's current pointer. Pointer equality alone does not confirm a successful publish.
