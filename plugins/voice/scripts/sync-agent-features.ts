/**
 * 把 src/agent-features.ts 的功能声明同步进 app.manifest.json 的
 * contributes.agentFeatures（单一事实源 → manifest 投影）。
 *
 * 用法：bun scripts/sync-agent-features.ts
 * 改了 src/agent-features.ts 之后跑一次；tests/agent-features.test.ts 会锁
 * 两侧一致，忘了跑会被测试抓住。
 */
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { voiceAgentFeaturesManifestProjection } from "../src/agent-features";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const manifestPath = join(root, "app.manifest.json");

const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
  contributes: Record<string, unknown>;
};
const features = voiceAgentFeaturesManifestProjection();
manifest.contributes.agentFeatures = features;

writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n", "utf8");
console.log(`app.manifest.json: contributes.agentFeatures 已同步（${features.length} 项）`);
