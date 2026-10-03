import { expect, test } from 'bun:test';
import type { VoiceModelInfo } from '@reai/app-sdk/v1';
import { LocalModelDownloads, type LocalDownloadState } from '../src/local-model-download';
const model = (state: VoiceModelInfo['state'], extra: Partial<VoiceModelInfo> = {}): VoiceModelInfo => ({ id: 'local', name: 'Local', description: '', sizeBytes: 100, state, active: state === 'active', updateAvailable: false, ...extra });
function deferred<T>() { let resolve!: (x: T) => void; const promise = new Promise<T>(r => resolve = r); return { promise, resolve }; }
function fixture(initial = model('missing')) {
 let host = initial, count = 0, cancels = 0;
 let latest: { models: VoiceModelInfo[], states: Record<string, LocalDownloadState> } = { models: [], states: {} };
 const ports = { list: async () => [host], download: async (_id: string) => { count++; host = model('downloading'); return host; }, cancel: async (_id: string) => { cancels++; host = model('missing', {resumeAvailable:true, downloadedBytes:40}); }, publish: (models: VoiceModelInfo[], states: Record<string, LocalDownloadState>) => { latest = { models, states }; }, error: String };
 const downloads = new LocalModelDownloads(ports);
 return { downloads, ports, get latest() { return latest; }, get count() { return count; }, get cancels() { return cancels; } };
}
test('preparation is immediate; duplicate starts share one request', async () => {
 const f=fixture(), pending=deferred<VoiceModelInfo>(); let calls=0;
 f.ports.download=async()=>{calls++;return pending.promise;};
 const first=f.downloads.start('local'); expect(f.latest.states.local?.phase).toBe('preparing');
 expect(f.downloads.start('local')).toBe(first); pending.resolve(model('downloading')); await first;
 expect(calls).toBe(1); expect(f.latest.models[0]?.state).toBe('downloading'); f.downloads.dispose();
});
test('installed model is not implicitly updated', async () => {
 const f=fixture(model('active',{updateAvailable:true})); await f.downloads.start('local');
 expect(f.count).toBe(0); expect(f.latest.states.local).toBeUndefined();
 await f.downloads.start('local',true); expect(f.count).toBe(1); f.downloads.dispose();
});
test('cancel retains bytes and continue restarts through Host', async () => {
 const f=fixture(model('downloading',{downloadedBytes:40})); await f.downloads.refresh(); await f.downloads.cancel('local');
 expect(f.latest.states.local?.phase).toBe('cancelled'); expect(f.latest.models[0]?.downloadedBytes).toBe(40);
 await f.downloads.start('local'); expect(f.count).toBe(1); f.downloads.dispose();
});
test('cancel during start waits for the actual task', async () => {
 const f=fixture(), pending=deferred<VoiceModelInfo>(); let started=false;
 f.ports.download=async()=>{started=true;return pending.promise;}; const start=f.downloads.start('local');
 for(let i=0;i<12&&!started;i++) await Promise.resolve(); expect(started).toBe(true);
 await f.downloads.cancel('local'); pending.resolve(model('downloading')); await start;
 expect(f.cancels).toBe(1); await f.downloads.refresh(); expect(f.latest.states.local?.phase).toBe('cancelled'); f.downloads.dispose();
});
test('request error retains selected model for retry', async () => {
 const f=fixture(); f.ports.download=async()=>{throw new Error('offline');}; await f.downloads.start('local');
 expect(f.latest.states.local?.phase).toBe('failed'); expect(f.latest.models[0]?.id).toBe('local'); f.downloads.dispose();
});

test('completion is transient; an already installed model never shows it', async () => {
 const f=fixture(model('downloading')); await f.downloads.refresh();
 f.ports.list=async()=>[model('active')]; await f.downloads.refresh();
 expect(f.latest.states.local?.phase).toBe('completed');
 await new Promise(r=>setTimeout(r,3050)); expect(f.latest.states.local).toBeUndefined();
 await f.downloads.refresh(); expect(f.latest.states.local).toBeUndefined(); f.downloads.dispose();
});

test('deactivation during model lookup does not launch a new download', async () => {
 const f=fixture(), pending=deferred<VoiceModelInfo[]>(); f.ports.list=()=>pending.promise;
 const start=f.downloads.start('local'); f.downloads.dispose(); pending.resolve([model('missing')]); await start; expect(f.count).toBe(0);
});

test('cancel during initial lookup also stops a task already running in Host', async () => {
 const f=fixture(), pending=deferred<VoiceModelInfo[]>(); f.ports.list=()=>pending.promise;
 const start=f.downloads.start('local'); await f.downloads.cancel('local');
 pending.resolve([model('downloading')]); await start;
 expect(f.count).toBe(0); expect(f.cancels).toBe(1); f.downloads.dispose();
});
