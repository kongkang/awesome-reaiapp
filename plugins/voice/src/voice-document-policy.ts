export const VOICE_DOCUMENT_LIMITS = { maxFileBytes: 5 * 1024 * 1024, maxInflatedBytes: 16 * 1024 * 1024, maxPdfDecodedBytes: 16 * 1024 * 1024, maxZipEntries: 512, maxSheets: 20, maxRows: 1000, maxColumns: 256, maxCells: 10000, maxHyperlinkRangeVisits: 10000, maxPages: 100, timeoutMs: 20000 } as const;
/** Match PDF.js's bounded header search, including transfer prefixes; no active content is evaluated. */
export const hasVoicePdfHeader = (bytes: Uint8Array): boolean => /%PDF-(?:1\.[0-7]|2\.0)/.test(new TextDecoder().decode(bytes.subarray(0, 1024)));
