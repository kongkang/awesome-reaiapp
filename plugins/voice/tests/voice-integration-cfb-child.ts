import { readVoiceDocumentAttachment } from "../src/voice-document-extraction";
import { invalidCfbFixtures } from "./fixtures/voice-integration-cfb-controls";
const fixture = invalidCfbFixtures().find(item => item.name === "uncached interior self-cycle")!;
console.log(JSON.stringify({ ready: true, inputBytes: fixture.bytes.length }));
try { const result = await readVoiceDocumentAttachment(new File([fixture.bytes], "cycle.xls")); console.log(JSON.stringify({ content: result.content, code: null })); }
catch (cause) { console.log(JSON.stringify({ code: (cause as { code?: string }).code, message: (cause as Error).message })); }
