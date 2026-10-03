/** `@reai/app-cli` 的程序化入口（`reai-app` 命令行在 `cli.ts`）。 */

export { loadSchema, loadSupportMatrix, MATRIX_PATH, SCHEMA_PATH } from "./assets";
export type { SupportMatrix } from "./assets";
export { validateManifest, validateManifestFile } from "./validate";
export type { Finding, StableErrorCode } from "./validate";
export { validateAgainstSchema } from "./json-schema";
export type { SchemaViolation } from "./json-schema";
export {
  APP_MANIFEST_NAME,
  BUILD_MANIFEST_NAME,
  BuildError,
  buildApp,
  collectPackagedFiles,
  mimeFor,
} from "./build";
export type { BuildManifestEntry, BuildManifestV1, BuildResult } from "./build";
export { PackError, crc32, packApp, writeZip } from "./pack";
export type { PackResult } from "./pack";
export { ContractTestError, runContractTest } from "./contract-test";
export type { ContractTestOptions } from "./contract-test";
