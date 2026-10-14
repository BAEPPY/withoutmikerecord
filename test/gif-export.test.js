import test from 'node:test';
import assert from 'node:assert/strict';
import { createGifPlan, exportGif, GIF_MAX_COMBINED_BYTES } from '../extension/gif-export.js';

test('GIF sampling keeps the complete timeline and hundredth-second duration', () => {
  const plan = createGifPlan(1920, 1080, 2.345);
  assert.equal(plan.width, 640);
  assert.equal(plan.height, 360);
  assert.equal(plan.frameCount, 24);
  assert.equal(plan.frames[0].timeSeconds, 0);
  assert.ok(plan.frames.at(-1).timeSeconds < 2.345);
  assert.ok(plan.frames.at(-1).timeSeconds > 2.2);
  assert.equal(plan.frames.reduce((sum, frame) => sum + frame.delayMs, 0), 2350);
  assert.ok(plan.frames.every(frame => frame.delayMs > 0 && frame.delayMs % 10 === 0));
});

test('long GIFs lower the frame rate without truncating the recording', () => {
  const plan = createGifPlan(1080, 1920, 7200);
  assert.equal(plan.width, 360);
  assert.equal(plan.height, 640);
  assert.equal(plan.frameCount, 600);
  assert.equal(plan.frames.at(-1).timeSeconds, 7188);
  assert.equal(plan.frames.reduce((sum, frame) => sum + frame.delayMs, 0), 7_200_000);
  assert.ok(plan.frames.every(frame => frame.delayMs / 10 <= 65535));
});

test('small sources stay native size and very short sources keep a frame', () => {
  const plan = createGifPlan(17, 9, 0.007);
  assert.equal(plan.width, 17);
  assert.equal(plan.height, 9);
  assert.equal(plan.frameCount, 1);
  assert.deepEqual(plan.frames, [{ timeSeconds: 0, delayMs: 10 }]);
});

test('invalid or unsupported media is rejected before encoding', async () => {
  for (const duration of [0, -1, Infinity, NaN, 7201]) {
    assert.throws(() => createGifPlan(320, 240, duration));
  }
  assert.throws(() => createGifPlan(0, 240, 1));
  assert.throws(() => createGifPlan(320, Infinity, 1));
  await assert.rejects(exportGif(new Blob()), /녹화 파일이 없습니다/);
  await assert.rejects(exportGif(null), /녹화 파일이 없습니다/);
  class OversizeBlob extends Blob { get size() { return GIF_MAX_COMBINED_BYTES; } }
  const largeBlob = new OversizeBlob();
  await assert.rejects(exportGif(largeBlob), /변환 한도를 넘었습니다/);
});
