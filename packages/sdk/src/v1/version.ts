/**
 * SDK 版本锚点。
 *
 * 三个版本锚点必须始终相等：`platform/sdk/package.json` 的 version、
 * `platform/contract/host-support-matrix.json` 的 hostApi、这里的常量。此前只有前两者且纯靠人肉
 * 巧合对齐——没有任何代码能在运行期回答「我是哪个版本的 SDK」。
 * 相等性由 `platform/sdk/tests/contract-constants.test.ts` 锁死。
 *
 * 注意：插件构建时 SDK 被 external，运行时用的是 Host 内置的同版本 runtime
 * （import map 接管），所以这两个常量描述的是「Host 内置 SDK」的版本，
 * 不是插件 node_modules 里那份的版本——两者在同一台 Host 上恒等。
 */

/** SDK 自身版本（与 package.json version 同步）。 */
export const SDK_VERSION = "1.24.0";

/** 本版 SDK 对应的 Host API 版本（与矩阵 hostApi 同步）。 */
export const HOST_API_VERSION = "1.24.0";
