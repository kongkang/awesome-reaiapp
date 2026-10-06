---
title: Plugin and shared-tool source delivery
description: English reading guide to the source synchronization and local verification report.
---

# Plugin and shared-tool source delivery

> English reading guide. The [complete Chinese report](/source-delivery-2026-10-06) contains the verification scope and release boundaries.

The verification date is 2026-10-06. The source update includes controlled attachments, the developer workflow contract for the designated system plugin, Mock chunked uploads, Agent feature version checks, deterministic Deflate packaging, and offline calculation of bytes for source review.

The SDK and contract versions remain `1.24.0`. Check the exact source contents before using the new interfaces. The version number alone does not identify these additions.

## Local verification

- Shared packages passed 537 unit tests, type checks, and installation contract checks. Five package tarballs passed installation and API checks outside the repository.
- The 14 ordinary plugins and 4 examples passed 695 unit tests and their installation, validation, build, type, and contract checks. All 18 repeated package pairs had identical bytes, sizes, and SHA-256 digests.
- Voice passed 1430 tests and type checks. Its 190 offline resources match the synchronization inputs, with the original third-party licenses retained.
- Voice validation, build, and pack each returned only the four expected SOURCE capability rejections. No Voice package was produced.
- The website build and its 8 tests passed.

The unit-test total is 2662. Website tests are counted separately. Repeated Skin contract tests are not counted twice.

## Voice candidate and release boundaries

Voice `2.14.5-dev.3` adds PDF, XLSX, and XLS extraction and attachment input. It remains an unsubmitted source candidate, without signing or store publication. The settings version and About links are still incomplete.

Offline calculation does not grant approval. Controlled packages still require independent SOURCE review bound to the complete inputs and final digest, followed by the normal repeated package builds. Platform approval, signing, real Host installation, user authorization, model checks, and store publication each require separate evidence.

Public source delivery excludes actual submission identities, private review evidence, migration records, production configuration, and build outputs. Check the [public version identifier](https://open.reai.com/release.json) and the live pages to determine which source version the website serves.

Continue with the [submission specification](/en/plugin-submission-v1) and the [developer workflow guide](/en/developer-platform-workflow-v1).
