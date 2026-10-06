import type { ParsingOptions, RawData, WorkBook } from "xlsx";
import type { VoiceHyperlinkGuard } from "../voice-spreadsheet-hyperlink-guard";
export { utils } from "xlsx";
export function read(data: RawData, options: ParsingOptions & { voiceHyperlinkRangeGuard: VoiceHyperlinkGuard }): WorkBook;
