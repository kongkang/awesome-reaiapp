import type { AgentAttachmentPart, AgentAttachmentTurnInput, AgentAttachmentTurnAdmission } from "@reai/app-sdk/v1";
import { VoiceAttachmentContentError, type VoiceTextAttachment } from "./voice-attachment-content";
import { confirmedVoiceAttachmentFormats, type VoiceAttachmentFormat } from "./voice-attachment-admission";
import { parseVoiceModelAttachmentSnapshot, parseVoiceAttachmentReaders } from "./voice-model-attachment-policy";
export interface VoiceAttachmentTarget {
  sessionId: string; ownerKey: string; admission: AgentAttachmentTurnAdmission;
  formats: readonly VoiceAttachmentFormat[];
}
export type PreparedVoiceAttachment = (VoiceTextAttachment & { kind?: "text"; mode?: "text" | "pdf-text" | "spreadsheet-text"; target?: VoiceAttachmentTarget })
  | {kind:"image";name:string;mimeType:"image/png"|"image/jpeg";byteLength:number;part:Extract<AgentAttachmentPart,{kind:"image"}>;target:VoiceAttachmentTarget};
const encoder=new TextEncoder();
const object=(value:unknown):value is Record<string,unknown>=>typeof value==="object" && value!==null && !Array.isArray(value);
const exact=(value:Record<string,unknown>,keys:string[])=>Object.keys(value).length===keys.length && keys.every(key=>Object.prototype.hasOwnProperty.call(value,key));
const hex=(value:unknown):value is string=>typeof value==="string" && /^[a-f0-9]{64}$/.test(value);
const name=(value:unknown):value is string=>typeof value==="string" && value.length>0 && encoder.encode(value).length<=512 && !/[\/\\\x00-\x1f\x7f]/.test(value);
/** Strict validation for the private lost-receipt journal; never accepts URLs or raw handles. */
export function parseVoiceAttachmentTurnInput(value:unknown):AgentAttachmentTurnInput|undefined {
 if(!object(value)||!exact(value,["schemaVersion","admission","parts"])||value.schemaVersion!==1||!object(value.admission)||!exact(value.admission,["schemaVersion","opaqueBinding","revision","modes"]))return;
 const a=value.admission;
 if(a.schemaVersion!==1||!hex(a.opaqueBinding)||!Number.isSafeInteger(a.revision)||(a.revision as number)<=0||!Array.isArray(a.modes)||!Array.isArray(value.parts)||value.parts.length<1||value.parts.length>4)return;
 let textBytes=0,textChars=0,imageBytes=0;const modes=new Set<string>();
 for(const p of value.parts){
  if(!object(p)||!name(p.name)||typeof p.mimeType!=="string"||!p.mimeType||encoder.encode(p.mimeType).length>128||/[\x00-\x1f\x7f]/.test(p.mimeType))return;
  if(p.kind==="text"){
   if(!exact(p,["kind","mode","name","mimeType","text"])||!['text','pdf-text','spreadsheet-text'].includes(p.mode as string)||typeof p.text!=="string"||!p.text||/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(p.text))return;
   modes.add(p.mode as string);textBytes+=encoder.encode(p.text).length;textChars+=p.text.length;
  }else if(p.kind==="image"){
   if(!exact(p,["kind","name","mimeType","leaseId","sha256","byteLength"])||!['image/png','image/jpeg'].includes(p.mimeType)||!hex(p.leaseId)||!hex(p.sha256)||!Number.isSafeInteger(p.byteLength)||(p.byteLength as number)<=0||(p.byteLength as number)>5*1024*1024)return;
   modes.add('image');imageBytes+=p.byteLength as number;
  }else return;
 }
 if(textBytes>64*1024||textChars>24000||imageBytes>10*1024*1024||a.modes.length!==modes.size||a.modes.some(mode=>!modes.has(mode as string))||new Set(a.modes).size!==a.modes.length)return;
 return structuredClone(value) as unknown as AgentAttachmentTurnInput;
}
export function parseVoiceAttachmentTarget(sessionId:string,ownerKey:string,value:unknown):VoiceAttachmentTarget|undefined {
 if(!sessionId.startsWith('agent2-')||!object(value)||value.schemaVersion!==1||value.state!=="ready")return;
 const snapshot=parseVoiceModelAttachmentSnapshot(value.snapshot);
 if(!snapshot||!object(value.readers)||!exact(value.readers,["text","extractedPdfText","extractedSpreadsheetText","images","nativePdf"])||Object.values(value.readers).some(flag=>typeof flag!=="boolean")||value.readers.nativePdf!==false||!object(value.transports)||!exact(value.transports,["textEnvelope","imageInput","nativePdfInput"])||Object.values(value.transports).some(flag=>typeof flag!=="boolean")||value.transports.nativePdfInput!==false)return;
 const formats=confirmedVoiceAttachmentFormats({snapshot,expected:snapshot,readers:parseVoiceAttachmentReaders(value.readers),transports:value.transports as unknown as {textEnvelope:boolean;imageInput:boolean;nativePdfInput:boolean}});
 return {sessionId,ownerKey,admission:{schemaVersion:1,opaqueBinding:snapshot.opaqueBinding,revision:snapshot.revision,modes:[]},formats};
}
export function buildVoiceTypedAttachments(files:readonly PreparedVoiceAttachment[],target:VoiceAttachmentTarget):AgentAttachmentTurnInput {
 const parts:AgentAttachmentPart[]=files.map(file=>{
  if(!file.target||file.target.ownerKey!==target.ownerKey||file.target.sessionId!==target.sessionId||file.target.admission.opaqueBinding!==target.admission.opaqueBinding||file.target.admission.revision!==target.admission.revision)throw new VoiceAttachmentContentError('VOICE_ATTACHMENT_MODEL_UNCONFIRMED');
  return file.kind==='image'?file.part:{kind:'text',mode:file.mode??'text',name:file.name,mimeType:file.mimeType,text:file.content};
 });
 const modes=Array.from(new Set(parts.map(part=>part.kind==='image'?'image':part.mode))).sort();
 const parsed=parseVoiceAttachmentTurnInput({schemaVersion:1,admission:{...target.admission,modes},parts});
 if(!parsed)throw new VoiceAttachmentContentError('VOICE_ATTACHMENT_TURN_TOO_LARGE');
 return parsed;
}
/** Sequential caller queue keeps the Host's one incomplete upload per plugin invariant. */
export async function uploadVoiceImage(file:File,target:VoiceAttachmentTarget,uploads:NonNullable<import('@reai/app-sdk/v1').AgentServiceClient['attachmentUploads']>,signal:AbortSignal):Promise<PreparedVoiceAttachment> {
 const abort=()=>{if(signal.aborted)throw new DOMException('Attachment cancelled','AbortError');};abort();
 if(!name(file.name))throw new VoiceAttachmentContentError('VOICE_ATTACHMENT_NAME_INVALID');
 if(!file.size)throw new VoiceAttachmentContentError('VOICE_ATTACHMENT_EMPTY');
 if(file.size>5*1024*1024)throw new VoiceAttachmentContentError('VOICE_ATTACHMENT_TOO_LARGE');
 const mime=file.type.toLowerCase().split(';',1)[0]!.trim()||(/\.png$/i.test(file.name)?'image/png':/\.jpe?g$/i.test(file.name)?'image/jpeg':'');
 if(mime!=='image/png'&&mime!=='image/jpeg')throw new VoiceAttachmentContentError('VOICE_ATTACHMENT_BINARY_UNSUPPORTED');
 const bytes=new Uint8Array(await file.arrayBuffer());abort();if(bytes.length!==file.size)throw new VoiceAttachmentContentError('VOICE_ATTACHMENT_READ_FAILED');
 const sha256=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),byte=>byte.toString(16).padStart(2,'0')).join('');abort();
 const owner={schemaVersion:1 as const,sessionId:target.sessionId,admission:{...target.admission,modes:['image' as const]}};
 let leaseId:string|undefined;
 try {
  const started=await uploads.start({...owner,name:file.name,mimeType:mime,byteLength:bytes.length,sha256});leaseId=started.leaseId;abort();
  if(started.schemaVersion!==1||!hex(leaseId)||started.chunkBytes!==262144)throw new VoiceAttachmentContentError('VOICE_ATTACHMENT_READ_FAILED');
  for(let offset=0,index=0;offset<bytes.length;offset+=started.chunkBytes,index++){
   abort();const chunk=bytes.subarray(offset,offset+started.chunkBytes);let binary='';for(const byte of chunk)binary+=String.fromCharCode(byte);
   await uploads.chunk({...owner,leaseId,index,base64:btoa(binary)});abort();
  }
  const finished=await uploads.finish({...owner,leaseId});abort();
  const part=finished.part;
  if(finished.schemaVersion!==1||!parseVoiceAttachmentTurnInput({schemaVersion:1,admission:owner.admission,parts:[part]})||part.name!==file.name||part.mimeType!==mime||part.leaseId!==leaseId||part.sha256!==sha256||part.byteLength!==bytes.length)throw new VoiceAttachmentContentError('VOICE_ATTACHMENT_READ_FAILED');
  return {kind:'image',name:file.name,mimeType:mime,byteLength:bytes.length,part,target};
 }catch(error){if(leaseId)await uploads.cancel({...owner,leaseId}).catch(()=>undefined);throw error;}
}
