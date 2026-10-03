# Host 1.20 网关校验样例

这些反例同时由 `platform/i18n-cli/tests/gateway.test.ts` 与 Host 的
`driver-v2/src-tauri/tests/manifest_fixtures.rs` 读取并核对相同错误码。
现代 wrapper 同时验证旧 `manifest-fixtures` 全集，包含合法网关样例。

旧 `@reai/app-cli` 1.2 的源码被已批准产物锁定，不新增网关语义规则；
声明 `apps.gateway@1` 的插件必须用 `reai-app-i18n validate/build/pack`。
该 wrapper 在语言校验之外承担现代 Manifest 校验，并在打包后复核实际字节。
Host 安装仍独立拒绝缺失同名用户权限、平台能力或 `apps.service@1` 的包。
