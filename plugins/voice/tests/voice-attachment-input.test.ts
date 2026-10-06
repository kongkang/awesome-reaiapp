import { expect, test } from "bun:test";
import { parseVoiceAttachmentTurnInput, parseVoiceAttachmentTarget, buildVoiceTypedAttachments } from "../src/voice-attachment-input";
const snapshot={schemaVersion:1,opaqueBinding:"a".repeat(64),revision:2,inputs:{text:true,image:true,nativePdf:false}};
const ready={schemaVersion:1,state:"ready",snapshot,readers:{text:true,extractedPdfText:true,extractedSpreadsheetText:true,images:true,nativePdf:false},transports:{textEnvelope:true,imageInput:true,nativePdfInput:false}};
test("only ready strict local own-session admission enables formats",()=>{
 const target=parseVoiceAttachmentTarget("agent2-own","choice-a",ready);
 expect(target?.formats).toEqual(["text","pdf","xlsx","xls","image"]);
 expect(parseVoiceAttachmentTarget("old-session","choice-a",ready)).toBeUndefined();
 expect(parseVoiceAttachmentTarget("agent2-own","choice-a",{...ready,readers:undefined})).toBeUndefined();
 expect(parseVoiceAttachmentTarget("agent2-own","choice-a",{...ready,snapshot:{...snapshot,revision:NaN}})).toBeUndefined();
});
test("typed parts keep formats and identity; foreign owner and malformed journals close",()=>{
 const target=parseVoiceAttachmentTarget("agent2-own","choice-a",ready)!;
 const file={name:"synthetic.pdf",mimeType:"application/pdf",byteLength:400,content:"PDF_MARKER",mode:"pdf-text" as const,target};
 const input=buildVoiceTypedAttachments([file],target);
 expect(input.parts).toEqual([{kind:"text",mode:"pdf-text",name:"synthetic.pdf",mimeType:"application/pdf",text:"PDF_MARKER"}]);
 expect(parseVoiceAttachmentTurnInput(input)).toEqual(input);
 expect(()=>buildVoiceTypedAttachments([file],{...target,ownerKey:"choice-b"})).toThrow();
 expect(parseVoiceAttachmentTurnInput({...input,url:"https://unused.invalid"})).toBeUndefined();
 expect(parseVoiceAttachmentTurnInput({...input,admission:{...input.admission,modes:["image"]}})).toBeUndefined();
 expect(parseVoiceAttachmentTurnInput({...input,parts:[{...input.parts[0],text:"\0"}]})).toBeUndefined();
});
