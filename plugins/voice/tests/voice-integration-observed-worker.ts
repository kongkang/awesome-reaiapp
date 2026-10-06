import { observeHyperlinkStubs } from "./voice-integration-observer";
const observer = observeHyperlinkStubs();
let networkAttempts = 0;
globalThis.fetch = (async () => { networkAttempts++; throw new Error("Hyperlink fixture network access is disabled"); }) as unknown as typeof fetch;
const scope = globalThis as unknown as { postMessage(value: unknown): void };
const send = scope.postMessage.bind(scope);
scope.postMessage = (value: unknown) => {
  const stubAssignments = observer.assignments;
  observer.cleanup();
  send({ ...(value as object), stubAssignments, networkAttempts });
};
// This imports the unmodified, formally generated product artifact.
await import(new URL("../assets/document-extraction/spreadsheet.worker.mjs", import.meta.url).href);
send({ ready: true });
