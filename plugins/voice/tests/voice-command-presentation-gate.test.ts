import { expect, test } from 'bun:test';
import { createCommandPresentationGate } from '../src/voice-command-presentation';

test('未启动的写回流程不限时退到后台', async () => {
  let scheduled = 0;
  const gate = createCommandPresentationGate({ autoStart: false, schedule: () => { scheduled++; return 1; }, cancel: () => {}, onBackgrounded: () => {} });
  expect(scheduled).toBe(0);
  expect(await gate.complete()).toBe('foreground');
});
test('Agent实际开始后仅计时一次且精确3000ms', async () => {
  let scheduled = 0;
  let callback!: () => void;
  const gate = createCommandPresentationGate({ autoStart: false, schedule: (fn, delay) => { scheduled++; callback = fn; expect(delay).toBe(3000); return 1; }, cancel: () => {}, onBackgrounded: () => {} });
  gate.start(); gate.start();
  expect(scheduled).toBe(1);
  callback();
  expect(await gate.complete()).toBe('background');
});
