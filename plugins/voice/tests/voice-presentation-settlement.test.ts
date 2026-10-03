import { expect, test } from 'bun:test';
import { waitForPresentation } from '../src/voice-presentation-settlement';
test('不回包的展示不阻塞历史；超时不是交付，迟到ACK仍有效', async () => {
  let resolve!: () => void;
  let delivered = false;
  const presentation = new Promise<void>(r => { resolve = r; }).then(() => { delivered = true; });
  await waitForPresentation(presentation, 10);
  expect(delivered).toBe(false);
  resolve();
  await presentation;
  expect(delivered).toBe(true);
});
test('展示拒绝不会伪造成功或阻塞', async () => {
  await waitForPresentation(Promise.reject(new Error('window unavailable')), 10);
});
