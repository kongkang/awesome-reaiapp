import type { VoiceRecordingSegment, VoiceRecordingSentence } from "@reai/app-sdk/v1";

/** Deliberately narrow: ambiguous punctuation (?!, quotes, operators) is preserved. */
export function isEmptyContextText(text: string): boolean {
  return /^[\s.,，。、;；:：…]*$/u.test(text);
}

/** Display-only count, never a replacement for the stored transcript. */
export function contextCharacterCount(text: string): number {
  return Array.from(text).filter((char) => !/[\p{P}\p{Z}\s]/u.test(char)).length;
}

export function hasUnfinishedContextStatus(item: VoiceRecordingSegment): boolean {
  const status = (item as VoiceRecordingSegment & { transcriptionStatus?: string }).transcriptionStatus;
  return status !== undefined && status !== "complete";
}

export function isEmptyContextRecording(item: VoiceRecordingSegment): boolean {
  return !hasUnfinishedContextStatus(item)
    && typeof item.transcriptText === "string"
    && isEmptyContextText(item.transcriptText)
    && (item.sentences ?? []).every((sentence) => isEmptyContextText(sentence.text));
}

export interface ContextDisplayBlock {
  empty: boolean;
  indices: number[];
  sentences: VoiceRecordingSentence[];
  startMs?: number;
  endMs?: number;
}

function validWallTime(value: number): boolean {
  return Number.isSafeInteger(value) && Number.isFinite(new Date(value).getTime());
}
function sameDay(start: number, end: number): boolean {
  return new Date(start).toDateString() === new Date(end).toDateString();
}

/** Only existing, exactly touching completed sentence intervals can join. No gap filling. */
export function projectContextSentences(item: VoiceRecordingSegment): ContextDisplayBlock[] {
  const sentences = item.sentences ?? [];
  const valid = (sentence: VoiceRecordingSentence) => validWallTime(item.wallStartMs)
    && Number.isSafeInteger(sentence.startMs) && Number.isSafeInteger(sentence.endMs)
    && sentence.endMs > sentence.startMs
    && validWallTime(item.wallStartMs + sentence.startMs)
    && validWallTime(item.wallStartMs + sentence.endMs);
  const blocks: ContextDisplayBlock[] = [];
  sentences.forEach((sentence, index) => {
    const empty = !hasUnfinishedContextStatus(item) && isEmptyContextText(sentence.text);
    const startMs = valid(sentence) ? item.wallStartMs + sentence.startMs : undefined;
    const endMs = valid(sentence) ? item.wallStartMs + sentence.endMs : undefined;
    const previous = blocks.at(-1);
    const intersectsOther = previous?.startMs !== undefined && endMs !== undefined
      && sentences.some((other, otherIndex) => !previous.indices.includes(otherIndex) && otherIndex !== index
        && (!valid(other) || (item.wallStartMs + other.startMs < endMs
          && item.wallStartMs + other.endMs > previous.startMs!)));
    if (empty && previous?.empty && startMs !== undefined && endMs !== undefined
      && previous.startMs !== undefined && previous.endMs === startMs
      && sameDay(previous.startMs, endMs) && !intersectsOther) {
      previous.indices.push(index);
      previous.sentences.push(sentence);
      previous.endMs = endMs;
    } else {
      blocks.push({ empty, indices: [index], sentences: [sentence], startMs, endMs });
    }
  });
  return blocks;
}

/** Main UI stops at seconds; expanded audit retains exact milliseconds. */
export function contextTime(value: number, precise = false): string {
  if (!validWallTime(value)) return "";
  const date = new Date(value);
  const clock = [date.getHours(), date.getMinutes(), date.getSeconds()].map((n) => String(n).padStart(2, "0")).join(":");
  return clock + (precise ? `.${String(date.getMilliseconds()).padStart(3, "0")}` : "");
}
