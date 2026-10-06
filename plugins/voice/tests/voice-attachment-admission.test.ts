import { expect, test } from 'bun:test';
import { confirmedVoiceAttachmentFormats, requireVoiceAttachmentAdmission, voiceAttachmentFormat } from '../src/voice-attachment-admission';
test('production admission stays closed without a verified selected-model capability snapshot',()=>{
 expect(confirmedVoiceAttachmentFormats()).toEqual([]);
 for(const name of ['a.txt','a.html','a.pdf','a.xlsx','a.xls','a.png']) expect(()=>requireVoiceAttachmentAdmission({name,type:''},confirmedVoiceAttachmentFormats())).toThrow('VOICE_ATTACHMENT_MODEL_UNCONFIRMED');
});
test('synthetic parser format admission never substitutes text for PDF, Excel or images',()=>{
 for(const [name,type,format] of [['a.pdf','text/plain','pdf'],['a.xlsx','application/pdf','xlsx'],['a.xls','application/pdf','xls']] as const){expect(voiceAttachmentFormat({name,type})).toBe(format);expect(()=>requireVoiceAttachmentAdmission({name,type},['text'])).toThrow();expect(()=>requireVoiceAttachmentAdmission({name,type},[format])).not.toThrow();}
 for(const [name,type] of [['a.png','text/plain'],['a.txt','image/png'],['a.docx',''],['a.xlsm','']]) expect(()=>requireVoiceAttachmentAdmission({name:name!,type:type!},['text','pdf','xlsx','xls'])).toThrow();
 expect(()=>requireVoiceAttachmentAdmission({name:'a.html',type:'text/html'},['text'])).not.toThrow();
});
test('real admission function intersects session snapshot, reader toggles and existing text transport',()=>{
 const snapshot={schemaVersion:1 as const,opaqueBinding:'a'.repeat(64),revision:2,inputs:{text:true,image:true,nativePdf:false}};
 const readers={text:true,extractedPdfText:true,extractedSpreadsheetText:true,images:true,nativePdf:true};
 const context={snapshot,expected:snapshot,readers};
 expect(confirmedVoiceAttachmentFormats(context)).toEqual(['text','pdf','xlsx','xls']);
 expect(()=>requireVoiceAttachmentAdmission({name:'a.png',type:'image/png'},confirmedVoiceAttachmentFormats(context))).toThrow();
 expect(confirmedVoiceAttachmentFormats({...context,readers:{...readers,extractedPdfText:false}})).toEqual(['text','xlsx','xls']);
 expect(confirmedVoiceAttachmentFormats({...context,expected:{opaqueBinding:snapshot.opaqueBinding,revision:3}})).toEqual([]);
 expect(confirmedVoiceAttachmentFormats({...context,snapshot:{...snapshot,inputs:{text:false,image:true,nativePdf:true}}})).toEqual([]);
});
test('image transport cannot admit a model that rejects the mandatory text question',()=>{
 const snapshot={schemaVersion:1 as const,opaqueBinding:'a'.repeat(64),revision:2,inputs:{text:false,image:true,nativePdf:false}};
 const readers={text:false,extractedPdfText:false,extractedSpreadsheetText:false,images:true,nativePdf:false};
 expect(confirmedVoiceAttachmentFormats({snapshot,expected:snapshot,readers,transports:{textEnvelope:true,imageInput:true,nativePdfInput:false}})).toEqual([]);
});
