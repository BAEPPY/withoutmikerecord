import test from 'node:test';
import assert from 'node:assert/strict';
import { createGifPlan, exportGif, GIF_MAX_COMBINED_BYTES } from '../extension/gif-export.js';

function fakeBrowser(t, options = {}) {
  const originalDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
  const originalWorker = Object.getOwnPropertyDescriptor(globalThis, 'Worker');
  const createObjectURL = URL.createObjectURL;
  const revokeObjectURL = URL.revokeObjectURL;
  const env = { created: [], revoked: [], workers: [], messages: [], draws: [], seeks: [] };
  class Video extends EventTarget {
    constructor() {
      super();
      this.duration = options.duration ?? 2;
      this.videoWidth = options.width ?? 64;
      this.videoHeight = options.height ?? 32;
      this.readyState = 0;
      this.position = 0;
      this.src = '';
      this.listeners = new Map();
    }
    addEventListener(type, listener, settings) {
      if (!this.listeners.has(type)) this.listeners.set(type, new Set());
      this.listeners.get(type).add(listener);
      super.addEventListener(type, listener, settings);
    }
    removeEventListener(type, listener, settings) {
      this.listeners.get(type)?.delete(listener);
      super.removeEventListener(type, listener, settings);
    }
    get currentTime() { return this.position; }
    set currentTime(value) {
      this.position = value;
      env.seeks.push(value);
      options.onStage?.('seek');
      if (options.stall !== 'seek') queueMicrotask(() => this.dispatchEvent(new Event('seeked')));
    }
    load() {
      if (!this.src) return;
      options.onStage?.('metadata');
      if (options.stall === 'metadata') return;
      queueMicrotask(() => {
        this.readyState = options.stall === 'data' ? 1 : 2;
        this.dispatchEvent(new Event('loadedmetadata'));
      });
    }
    pause() { this.paused = true; }
    removeAttribute(name) { if (name === 'src') this.src = ''; }
  }
  env.video = new Video();
  env.canvas = {
    width: 0, height: 0,
    getContext: () => ({
      drawImage(video) { env.draws.push(video.currentTime); },
      getImageData: () => ({ data: new Uint8ClampedArray(env.canvas.width * env.canvas.height * 4) }),
    }),
  };
  class Worker {
    constructor() { this.terminated = 0; env.workers.push(this); }
    postMessage(message) {
      env.messages.push(message);
      options.onStage?.(message.type);
      if (options.stall === message.type) return;
      queueMicrotask(() => {
        const data = { id: message.id };
        if (message.type === 'FINISH') {
          const bytes = new TextEncoder().encode('GIF89a');
          data.buffer = bytes.buffer;
          data.byteLength = bytes.byteLength;
        }
        this.onmessage?.({ data });
      });
    }
    terminate() { this.terminated += 1; }
  }
  Object.defineProperty(globalThis, 'document', { configurable: true, writable: true,
    value: { createElement: name => name === 'video' ? env.video : env.canvas } });
  Object.defineProperty(globalThis, 'Worker', { configurable: true, writable: true, value: Worker });
  URL.createObjectURL = (blob) => { env.created.push(blob); return 'blob:gif-test'; };
  URL.revokeObjectURL = url => env.revoked.push(url);
  t.after(() => {
    if (originalDocument) Object.defineProperty(globalThis, 'document', originalDocument);
    else delete globalThis.document;
    if (originalWorker) Object.defineProperty(globalThis, 'Worker', originalWorker);
    else delete globalThis.Worker;
    URL.createObjectURL = createObjectURL;
    URL.revokeObjectURL = revokeObjectURL;
  });
  env.assertReleased = () => {
    assert.deepEqual(env.revoked, ['blob:gif-test']);
    assert.equal(env.video.paused, true);
    assert.equal(env.video.src, '');
    assert.equal(env.canvas.width, 0);
    assert.equal(env.canvas.height, 0);
    assert.ok([...env.video.listeners.values()].every(listeners => listeners.size === 0));
    assert.ok(env.workers.every(worker => worker.terminated === 1));
  };
  return env;
}

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

for (const [quality, width, height, frameCount] of [
  ['balanced', 480, 270, 19], ['small', 320, 180, 15],
]) {
  test(`${quality} GIF reduces resolution and frame count while preserving duration`, () => {
    const plan = createGifPlan(1920, 1080, 2.345, quality);
    assert.equal(plan.width, width);
    assert.equal(plan.height, height);
    assert.equal(plan.frameCount, frameCount);
    assert.equal(plan.frames[0].timeSeconds, 0);
    assert.ok(plan.frames.at(-1).timeSeconds < 2.345);
    assert.equal(plan.frames.reduce((sum, frame) => sum + frame.delayMs, 0), 2350);
    assert.ok(plan.frames.every(frame => frame.delayMs > 0 && frame.delayMs % 10 === 0));
    const portrait = createGifPlan(1080, 1920, 7200, quality);
    assert.equal(portrait.width, height);
    assert.equal(portrait.height, width);
    assert.equal(portrait.frameCount, 600);
    assert.equal(portrait.frames.reduce((sum, frame) => sum + frame.delayMs, 0), 7200000);
    const tiny = createGifPlan(17, 9, 0.007, quality);
    assert.equal(tiny.width, 17);
    assert.equal(tiny.height, 9);
    assert.equal(tiny.frameCount, 1);
  });
}

test('unknown GIF quality is rejected before allocating browser resources', async () => {
  for (const quality of ['high', null, 0, {}, false]) {
    assert.throws(() => createGifPlan(320, 240, 1, quality), /화질/);
    await assert.rejects(exportGif(new Blob(['source']), { quality }), /화질/);
  }
});

test('selected low-quality GIF sends smaller frames to its worker with the exact selected duration', async (t) => {
  const env = fakeBrowser(t, { width: 1920, height: 1080 });
  const source = new Blob(['original MP4']);
  const result = await exportGif(source, { startSeconds: 0.25, endSeconds: 1.5, quality: 'small' });
  assert.equal(result.width, 320);
  assert.equal(result.height, 180);
  assert.equal(result.frameCount, 8);
  const init = env.messages.find(message => message.type === 'INIT');
  assert.equal(init.width, 320);
  assert.equal(init.height, 180);
  const frames = env.messages.filter(message => message.type === 'FRAME');
  assert.equal(frames.length, 8);
  assert.ok(frames.every(frame => frame.pixels.byteLength === 320 * 180 * 4));
  assert.equal(frames.reduce((sum, frame) => sum + frame.delayMs, 0), 1250);
  assert.equal(env.draws[0], 0.25);
  assert.ok(env.draws.at(-1) < 1.5);
  assert.equal(await source.text(), 'original MP4');
  env.assertReleased();
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

test('selected GIF samples use source offsets and retain only the selected duration', async (t) => {
  const env = fakeBrowser(t);
  const source = new Blob(['original MP4']);
  const progress = [];
  const result = await exportGif(source, { startSeconds: 1.25, endSeconds: 1.55, onProgress: value => progress.push(value) });
  assert.equal(result.blob.type, 'image/gif');
  assert.equal(result.startSeconds, 1.25);
  assert.equal(result.endSeconds, 1.55);
  assert.ok(Math.abs(result.durationSeconds - 0.3) < 1e-10);
  assert.equal(env.draws[0], 1.25);
  assert.ok(env.draws.every(time => time >= 1.25 && time < 1.55));
  assert.equal(env.messages.filter(message => message.type === 'FRAME').reduce((sum, frame) => sum + frame.delayMs, 0), 300);
  assert.equal(progress[0], 0);
  assert.equal(progress.at(-1), 1);
  assert.deepEqual(progress, progress.toSorted((a, b) => a - b));
  assert.equal(await source.text(), 'original MP4');
  env.assertReleased();
});

test('omitting the end exports from the selected start through decoded media end', async (t) => {
  const env = fakeBrowser(t, { duration: 1.5 });
  const result = await exportGif(new Blob(['source']), { startSeconds: 1 });
  assert.equal(result.startSeconds, 1);
  assert.equal(result.endSeconds, 1.5);
  assert.equal(result.durationSeconds, 0.5);
  assert.equal(env.draws[0], 1);
  assert.ok(env.draws.at(-1) < 1.5);
  env.assertReleased();
});

test('default export still covers the complete source', async (t) => {
  const env = fakeBrowser(t, { duration: 0.3 });
  const result = await exportGif(new Blob(['source']));
  assert.equal(result.startSeconds, 0);
  assert.equal(result.endSeconds, 0.3);
  assert.equal(result.durationSeconds, 0.3);
  assert.equal(env.draws[0], 0);
  env.assertReleased();
});

test('invalid range values reject without allocating browser resources', async () => {
  for (const range of [
    { startSeconds: -1 }, { startSeconds: Infinity }, { startSeconds: NaN },
    { startSeconds: '1' }, { endSeconds: 0 }, { endSeconds: NaN },
    { endSeconds: Infinity }, { endSeconds: null }, { startSeconds: 1, endSeconds: 1 },
    { startSeconds: 2, endSeconds: 1 },
  ]) {
    await assert.rejects(exportGif(new Blob(['source']), range), /시작과 끝/, JSON.stringify(range));
  }
});

for (const range of [{ startSeconds: 2 }, { startSeconds: 2.1 }, { endSeconds: 2.01 }]) {
  test(`range outside decoded duration is rejected and its media is released: ${JSON.stringify(range)}`, async (t) => {
    const env = fakeBrowser(t, { duration: 2 });
    await assert.rejects(exportGif(new Blob(['source']), range), /시작과 끝/);
    assert.equal(env.workers.length, 0);
    env.assertReleased();
  });
}

test('an already aborted export rejects before allocating resources', async () => {
  const controller = new AbortController();
  controller.abort('user cancelled');
  await assert.rejects(exportGif(new Blob(['source']), { signal: controller.signal }), { name: 'AbortError' });
});

for (const stage of ['metadata', 'seek', 'INIT', 'FRAME', 'FINISH']) {
  test(`abort immediately releases resources while waiting for ${stage}`, async (t) => {
    let reached;
    const entered = new Promise(resolve => { reached = resolve; });
    const env = fakeBrowser(t, { stall: stage, onStage: value => { if (value === stage) reached(); } });
    const controller = new AbortController();
    const progress = [];
    const exporting = exportGif(new Blob(['source']), {
      startSeconds: 0.5, endSeconds: 0.7, signal: controller.signal,
      onProgress: value => progress.push(value),
    });
    await entered;
    controller.abort();
    await assert.rejects(exporting, { name: 'AbortError' });
    assert.ok(!progress.includes(1));
    env.assertReleased();
  });
}

test('abort while the decoder has metadata but no frame releases all listeners', async (t) => {
  let initialized;
  const entered = new Promise(resolve => { initialized = resolve; });
  const env = fakeBrowser(t, { stall: 'data', onStage: stage => { if (stage === 'INIT') initialized(); } });
  const controller = new AbortController();
  const exporting = exportGif(new Blob(['source']), { signal: controller.signal });
  await entered;
  // Let INIT resolve so export waits for loadeddata before aborting it.
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(env.video.listeners.get('loadeddata')?.size, 1);
  controller.abort();
  await assert.rejects(exporting, { name: 'AbortError' });
  env.assertReleased();
});

test('cancellation from a progress callback stops before another frame is submitted', async (t) => {
  const env = fakeBrowser(t);
  const controller = new AbortController();
  await assert.rejects(exportGif(new Blob(['source']), {
    signal: controller.signal,
    onProgress: value => { if (value > 0) controller.abort(); },
  }), { name: 'AbortError' });
  assert.equal(env.messages.filter(message => message.type === 'FRAME').length, 1);
  assert.equal(env.messages.some(message => message.type === 'FINISH'), false);
  env.assertReleased();
});
