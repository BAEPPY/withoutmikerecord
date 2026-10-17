import test from 'node:test';
import assert from 'node:assert/strict';
import { TabAudioRecorder } from '../extension/recorder.js';

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function harness(options = {}) {
  let time = 0;
  const captures = [];
  const recorders = [];
  const contexts = [];
  const states = [];
  const timers = new Set();
  const blobs = [];
  const revoked = [];
  const inspections = [];
  const trims = [];
  const stateWaiters = [];

  class Track extends EventTarget {
    stopped = false;
    stop() { this.stopped = true; }
    end() { this.dispatchEvent(new Event('ended')); }
  }
  const track = new Track();
  const stream = { getTracks: () => [track], getAudioTracks: () => [track] };

  class Context {
    state = options.suspended ? 'suspended' : 'running';
    destination = {};
    connections = [];
    closed = false;
    constructor() { contexts.push(this); }
    createMediaStreamSource(input) {
      assert.equal(input, stream);
      return { connect: (target) => this.connections.push(['source', target]), disconnect() {} };
    }
    createAnalyser() {
      return {
        fftSize: 2048,
        connect: (target) => this.connections.push(['analyser', target]),
        disconnect() {},
        getFloatTimeDomainData: (samples) => samples.fill(0.2),
      };
    }
    async resume() {
      if (options.resumeError) throw options.resumeError;
      this.state = 'running';
    }
    async close() { this.closed = true; }
  }

  class Recorder {
    static isTypeSupported(type) {
      return (options.supportedTypes ?? ['audio/mp4;codecs=mp4a.40.2']).includes(type);
    }
    state = 'inactive';
    stopCalls = 0;
    constructor(input, settings) {
      if (options.constructorError) throw options.constructorError;
      assert.equal(input, stream);
      this.settings = settings;
      this.mimeType = options.actualMimeType ?? settings.mimeType;
      recorders.push(this);
    }
    start(timeslice) {
      if (options.startError) throw options.startError;
      this.timeslice = timeslice;
      this.state = 'recording';
    }
    pause() { this.state = 'paused'; }
    resume() { this.state = 'recording'; }
    chunk(text) { this.ondataavailable?.({ data: new Blob([text], { type: this.mimeType }) }); }
    stop() {
      this.stopCalls += 1;
      this.state = 'inactive';
      if (!options.manualFinish) queueMicrotask(() => this.finish());
    }
    finish() {
      this.chunk(options.finalChunk ?? 'tail');
      this.onstop?.();
    }
    error(error) {
      this.state = 'inactive';
      this.onerror?.({ error });
      queueMicrotask(() => this.finish());
    }
  }

  const engine = new TabAudioRecorder({
    mediaDevices: { getUserMedia: async (constraints) => {
      captures.push(constraints);
      if (options.captureError) throw options.captureError;
      if (options.capturePromise) await options.capturePromise;
      return stream;
    } },
    MediaRecorder: Recorder,
    AudioContext: Context,
    now: () => time,
    wallNow: () => new Date('2026-10-13T10:20:30Z'),
    setInterval: (callback) => { timers.add(callback); return callback; },
    clearInterval: (timer) => timers.delete(timer),
    url: {
      createObjectURL: (blob) => { blobs.push(blob); return `blob:test-${blobs.length}`; },
      revokeObjectURL: (url) => revoked.push(url),
    },
    maxBytes: options.maxBytes,
    maxDurationMs: options.maxDurationMs,
    inspectMp4: async (blob) => {
      inspections.push(blob);
      return options.inspectMp4 ? options.inspectMp4(blob) : { durationSeconds: 12 };
    },
    trimMp4: async (blob, startSeconds, endSeconds) => {
      trims.push({ blob, startSeconds, endSeconds });
      if (options.trimMp4) return options.trimMp4(blob, startSeconds, endSeconds);
      return {
        blob: new Blob(['trimmed-audio'], { type: blob.type }),
        durationSeconds: endSeconds - startSeconds, startSeconds, endSeconds,
      };
    },
    onStateChange: (state) => {
      states.push(state);
      for (const waiter of stateWaiters) {
        if (waiter.status === state.status) waiter.resolve(state);
      }
    },
  });
  return {
    engine, captures, recorders, contexts, states, track, blobs, revoked, timers, inspections, trims,
    waitForStatus: (status) => engine.getState().status === status
      ? Promise.resolve(engine.getState())
      : new Promise((resolve) => stateWaiters.push({ status, resolve })),
    advance: (ms) => { time += ms; },
    tick: () => { for (const callback of timers) callback(); },
    start: () => engine.handle({ type: 'START', streamId: 'tab-stream-token', tab: { id: 41, title: 'A/B: live?' } }),
    command: (type, rest = {}) => engine.handle({ type, ...rest }),
  };
}

test('captures only the selected tab, restores playback, and records native MP4', async () => {
  const h = harness();
  assert.equal((await h.start()).ok, true);
  assert.deepEqual(h.captures, [{
    audio: { mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: 'tab-stream-token' } },
    video: false,
  }]);
  assert.equal(h.contexts[0].connections[0][0], 'source');
  assert.deepEqual(h.contexts[0].connections[1], ['analyser', h.contexts[0].destination]);
  assert.equal(h.recorders[0].settings.mimeType, 'audio/mp4;codecs=mp4a.40.2');
  assert.equal(h.recorders[0].timeslice, 1000);
  assert.ok((await h.command('STATUS')).state.level > 0);
  const saved = await h.command('STOP');
  assert.equal(saved.state.result.mimeType, 'audio/mp4;codecs=mp4a.40.2');
  assert.match(saved.state.result.filename, /\.mp4$/);
  assert.doesNotMatch(saved.state.result.filename, /[/:?]/);
  assert.equal(h.blobs[0].type, 'audio/mp4;codecs=mp4a.40.2');
  assert.equal(h.track.stopped, true);
  assert.equal(h.contexts[0].closed, true);
  assert.equal(h.timers.size, 0);
});

test('prefers Opus in MP4 when AAC is unavailable and never falls back to WebM', async () => {
  const opus = harness({ supportedTypes: ['audio/mp4;codecs=opus', 'audio/mp4'] });
  assert.equal((await opus.start()).ok, true);
  assert.equal(opus.recorders[0].mimeType, 'audio/mp4;codecs=opus');
  await opus.command('STOP');

  const unsupported = harness({ supportedTypes: ['audio/webm;codecs=opus'] });
  const result = await unsupported.start();
  assert.equal(result.ok, false);
  assert.match(result.error, /MP4/);
  assert.equal(result.state.status, 'error');
  assert.equal(unsupported.captures.length, 0, 'unsupported MP4 fails before requesting any stream');
});

test('long Korean and emoji titles produce portable filenames without broken Unicode', async () => {
  for (const title of ['긴한글제목'.repeat(40), '🎵😀'.repeat(80)]) {
    const h = harness();
    await h.command('START', { streamId: 'tab-stream-token', tab: { id: 41, title } });
    const result = await h.command('STOP');
    const filename = result.state.result.filename;
    assert.ok(Buffer.byteLength(filename, 'utf8') <= 255);
    assert.equal(filename.isWellFormed(), true);
    assert.match(filename, /\.mp4$/);
  }
});

test('rejects a browser returning another container and releases captured media', async () => {
  const h = harness({ actualMimeType: 'audio/webm;codecs=opus' });
  assert.equal((await h.start()).ok, false);
  assert.equal(h.track.stopped, true);
  assert.equal(h.contexts[0].closed, true);
  assert.equal(h.blobs.length, 0);
});

test('pause excludes paused time, keeps playback connected, and resumes the same recording', async () => {
  const h = harness();
  await h.start();
  h.advance(1500);
  assert.equal((await h.command('PAUSE')).state.elapsedMs, 1500);
  h.advance(8000);
  assert.equal((await h.command('STATUS')).state.elapsedMs, 1500);
  assert.equal(h.track.stopped, false);
  assert.equal(h.contexts[0].closed, false);
  assert.equal((await h.command('STATUS')).state.level, 0);
  await h.command('RESUME');
  h.advance(500);
  const result = await h.command('STOP');
  assert.equal(result.state.elapsedMs, 2000);
  assert.equal(h.captures.length, 1);
  assert.equal(h.recorders.length, 1);
});

test('STOP waits for the last dataavailable and includes it in exact file bytes', async () => {
  const h = harness({ manualFinish: true, finalChunk: 'final-data' });
  await h.start();
  h.recorders[0].chunk('first-data');
  const stopping = h.command('STOP');
  await Promise.resolve();
  assert.equal((await h.command('STATUS')).state.status, 'stopping');
  assert.equal(h.blobs.length, 0);
  h.recorders[0].finish();
  const result = await stopping;
  assert.equal(result.state.status, 'ready');
  assert.equal(result.state.bytes, 20);
  assert.equal(result.state.result.bytes, 20);
  assert.equal(await h.blobs[0].text(), 'first-datafinal-data');
});

test('source ending automatically finishes and frees capture resources', async () => {
  const h = harness();
  await h.start();
  h.recorders[0].chunk('before-close');
  h.track.end();
  await h.waitForStatus('ready');
  const result = await h.command('STATUS');
  assert.equal(result.state.status, 'ready');
  assert.match(result.state.notice, /연결이 종료/);
  assert.equal(h.track.stopped, true);
  assert.equal(h.contexts[0].closed, true);
  assert.equal(h.recorders[0].stopCalls, 1);
});

test('capture denial does not retry with a microphone and permits a clean discard', async () => {
  const denied = Object.assign(new Error('denied'), { name: 'NotAllowedError' });
  const h = harness({ captureError: denied });
  const result = await h.start();
  assert.equal(result.ok, false);
  assert.equal(result.state.status, 'error');
  assert.equal(h.captures.length, 1);
  assert.equal(h.contexts.length, 0);
  assert.equal((await h.command('DISCARD')).state.status, 'idle');
});

test('recorder construction/start and playback setup failures release every acquired resource', async (t) => {
  for (const settings of [
    { constructorError: new Error('constructor failed') },
    { startError: new Error('start failed') },
    { suspended: true, resumeError: new Error('resume failed') },
  ]) {
    await t.test(Object.values(settings).find((value) => value instanceof Error).message, async () => {
      const h = harness(settings);
      const result = await h.start();
      assert.equal(result.ok, false);
      assert.equal(result.state.status, 'error');
      assert.equal(h.track.stopped, true);
      assert.equal(h.contexts[0].closed, true);
      assert.equal(h.timers.size, 0);
    });
  }
});

test('recorder error preserves final partial data for saving and cleans up', async () => {
  const h = harness();
  await h.start();
  h.recorders[0].chunk('partial');
  h.recorders[0].error(new Error('encoder failed'));
  await h.waitForStatus('ready');
  const result = await h.command('STATUS');
  assert.equal(result.state.status, 'ready');
  assert.equal(result.state.error, 'encoder failed');
  assert.ok(result.state.notice);
  assert.equal(await h.blobs[0].text(), 'partialtail');
  assert.equal(h.track.stopped, true);
  assert.equal(h.contexts[0].closed, true);
});

test('empty failed recordings expose an error and no bogus saved file', async () => {
  const h = harness({ finalChunk: '' });
  await h.start();
  h.recorders[0].error(new Error('encoder failed'));
  await h.waitForStatus('error');
  const result = await h.command('STATUS');
  assert.equal(result.state.status, 'error');
  assert.equal(result.state.result, null);
  assert.equal(h.blobs.length, 0);
  assert.equal(h.track.stopped, true);
});

test('memory limit stops automatically and retains the recorder final chunk', async () => {
  const h = harness({ maxBytes: 8, finalChunk: 'end' });
  await h.start();
  h.recorders[0].chunk('12345678');
  await h.waitForStatus('ready');
  const result = await h.command('STATUS');
  assert.equal(result.state.status, 'ready');
  assert.equal(result.state.bytes, 11);
  assert.match(result.state.notice, /메모리/);
  assert.equal(h.recorders[0].stopCalls, 1);
});

test('duration limit excludes pauses and stops when recorded time reaches the limit', async () => {
  const h = harness({ maxDurationMs: 2000 });
  await h.start();
  h.advance(1000);
  await h.command('PAUSE');
  h.advance(60000);
  h.tick();
  assert.equal((await h.command('STATUS')).state.status, 'paused');
  await h.command('RESUME');
  h.advance(1000);
  h.tick();
  await h.waitForStatus('ready');
  const result = await h.command('STATUS');
  assert.equal(result.state.status, 'ready');
  assert.equal(result.state.elapsedMs, 2000);
  assert.match(result.state.notice, /최대 녹음 시간/);
});

test('pending download blocks discard; cancellation can retry without losing the Blob', async () => {
  const h = harness();
  await h.start();
  const ready = await h.command('STOP');
  const url = ready.state.result.url;
  const update = (download) => h.command('DOWNLOAD_UPDATE', { download });
  await update({ id: null, status: 'pending' });
  assert.equal((await h.command('DISCARD')).ok, false);
  await update({ id: 9, status: 'pending' });
  await update({ id: 9, status: 'interrupted', error: 'cancelled' });
  assert.equal((await h.command('STATUS')).state.result.url, url);
  assert.equal(h.revoked.length, 0);
  await update({ id: null, status: 'pending' });
  assert.equal((await update({ id: 9, status: 'complete' })).ok, false);
  await update({ id: 10, status: 'pending' });
  assert.equal((await update({ id: 9, status: 'complete' })).ok, false);
  assert.equal((await update({ id: 10, status: 'complete' })).state.download.status, 'complete');
  assert.equal((await h.command('DISCARD')).state.status, 'idle');
  assert.deepEqual(h.revoked, [url]);
  await h.start();
  await h.command('STOP');
  assert.equal((await update({ id: 10, status: 'complete' })).ok, false);
});

test('queued STOP during capture setup stops once and STATUS stays responsive', async () => {
  let releaseCapture;
  const capturePromise = new Promise((resolve) => { releaseCapture = resolve; });
  const h = harness({ capturePromise });
  const starting = h.start();
  await Promise.resolve();
  const stopping = h.command('STOP');
  assert.equal((await h.command('STATUS')).state.status, 'starting');
  releaseCapture();
  assert.equal((await starting).ok, true);
  assert.equal((await stopping).state.status, 'ready');
  assert.equal(h.captures.length, 1);
  assert.equal(h.recorders[0].stopCalls, 1);
  assert.equal(h.track.stopped, true);
});

test('parallel START requests cannot replace the live tab recording', async () => {
  const h = harness();
  const [first, second] = await Promise.all([h.start(), h.start()]);
  assert.equal(first.ok, true);
  assert.equal(second.ok, false);
  assert.equal(h.captures.length, 1);
  assert.equal(second.state.status, 'recording');
  await h.command('STOP');
});

test('finalization waits for MP4 inspection and selects the actual media duration', async () => {
  const entered = deferred();
  const inspection = deferred();
  const h = harness({ inspectMp4: async () => { entered.resolve(); return inspection.promise; } });
  await h.start();
  h.advance(10000);
  const stopping = h.command('STOP');
  await entered.promise;
  const waiting = await h.command('STATUS');
  assert.equal(waiting.state.status, 'stopping');
  assert.equal(h.track.stopped, true);
  assert.equal(h.contexts[0].closed, true);
  inspection.resolve({ durationSeconds: 9.875 });
  const ready = await stopping;
  assert.equal(ready.ok, true);
  assert.equal(ready.state.status, 'ready');
  assert.equal(ready.state.elapsedMs, 10000);
  assert.equal(ready.state.result.durationSeconds, 9.875);
  assert.deepEqual(ready.state.selection, { startSeconds: 0, endSeconds: 9.875 });
  assert.equal(ready.state.exportResult, null);
  assert.equal(await h.inspections[0].text(), 'tail');
});

test('an uninspectable recording stays available for full-file saving', async () => {
  const h = harness({ inspectMp4: async () => { throw new Error('invalid MP4 index'); } });
  await h.start();
  const ready = await h.command('STOP');
  assert.equal(ready.ok, true);
  assert.equal(ready.state.status, 'ready');
  assert.equal(ready.state.result.durationSeconds, null);
  assert.equal(ready.state.selection, null);
  assert.ok(ready.state.result.trimError);
  assert.equal(await h.blobs[0].text(), 'tail');
  assert.equal((await h.command('PREPARE_EXPORT', { startSeconds: 0, endSeconds: 1 })).ok, false);
  assert.equal(h.trims.length, 0);
  assert.equal(h.revoked.length, 0);
  assert.equal((await h.command('DISCARD')).ok, true);
  assert.deepEqual(h.revoked, [ready.state.result.url]);
});

test('trim boundaries reject malformed, reversed, and out-of-bounds selections', async () => {
  const h = harness();
  assert.equal((await h.command('SET_SELECTION', { startSeconds: 0, endSeconds: 1 })).ok, false);
  await h.start();
  assert.equal((await h.command('PREPARE_EXPORT', { startSeconds: 0, endSeconds: 1 })).ok, false);
  const ready = await h.command('STOP');
  for (const range of [
    {}, { startSeconds: '1', endSeconds: 2 }, { startSeconds: 1, endSeconds: '2' },
    { startSeconds: NaN, endSeconds: 2 }, { startSeconds: 1, endSeconds: Infinity },
    { startSeconds: null, endSeconds: 2 }, { startSeconds: -0.01, endSeconds: 2 },
    { startSeconds: 2, endSeconds: 2 }, { startSeconds: 3, endSeconds: 2 },
    { startSeconds: 0, endSeconds: 12.01 }, { startSeconds: 12, endSeconds: 13 },
  ]) {
    for (const type of ['SET_SELECTION', 'PREPARE_EXPORT']) {
      const reply = await h.command(type, range);
      assert.equal(reply.ok, false, `${type} must reject ${JSON.stringify(range)}`);
      assert.equal(reply.state.status, 'ready');
      assert.deepEqual(reply.state.selection, ready.state.selection);
      assert.deepEqual(reply.state.result, ready.state.result);
    }
  }
  assert.equal(h.trims.length, 0);
});

test('selection survives status polling and state snapshots cannot mutate the recorder', async () => {
  const h = harness();
  await h.start();
  await h.command('STOP');
  const range = { startSeconds: 1.125, endSeconds: 11.75 };
  const selected = await h.command('SET_SELECTION', range);
  assert.equal(selected.ok, true);
  assert.deepEqual(selected.state.selection, range);
  selected.state.selection.startSeconds = 7;
  const reopened = await h.command('STATUS');
  assert.deepEqual(reopened.state.selection, range);
  assert.equal(h.trims.length, 0);
  assert.equal(h.blobs.length, 1);
});

test('exporting a range retains the full original, caches repeated exports, and releases replaced clips', async () => {
  const h = harness();
  await h.start();
  const ready = await h.command('STOP');
  const range = { startSeconds: 2.25, endSeconds: 8.5 };
  const clipped = await h.command('PREPARE_EXPORT', range);
  assert.equal(clipped.ok, true);
  assert.equal(clipped.state.status, 'ready');
  assert.deepEqual(clipped.state.result, ready.state.result);
  assert.deepEqual(clipped.state.selection, range);
  assert.equal(clipped.state.exportResult.durationSeconds, 6.25);
  assert.equal(clipped.state.exportResult.startSeconds, 2.25);
  assert.equal(clipped.state.exportResult.endSeconds, 8.5);
  assert.equal(clipped.state.exportResult.mimeType, ready.state.result.mimeType);
  assert.equal(clipped.state.exportResult.bytes, h.blobs[1].size);
  assert.match(clipped.state.exportResult.filename, /\.mp4$/);
  assert.notEqual(clipped.state.exportResult.filename, ready.state.result.filename);
  assert.notEqual(clipped.state.exportResult.url, ready.state.result.url);
  assert.equal(h.trims[0].blob, h.blobs[0]);
  assert.deepEqual(h.revoked, []);

  const repeated = await h.command('PREPARE_EXPORT', range);
  assert.equal(repeated.ok, true);
  assert.deepEqual(repeated.state.exportResult, clipped.state.exportResult);
  assert.equal(h.trims.length, 1);
  const replacement = await h.command('PREPARE_EXPORT', { startSeconds: 3, endSeconds: 9 });
  assert.equal(replacement.ok, true);
  assert.equal(h.trims.length, 2);
  assert.deepEqual(h.revoked, [clipped.state.exportResult.url]);
  assert.deepEqual(replacement.state.result, ready.state.result);
  await h.command('DISCARD');
  assert.deepEqual(new Set(h.revoked), new Set([
    ready.state.result.url, clipped.state.exportResult.url, replacement.state.exportResult.url,
  ]));
  assert.equal(h.revoked.length, 3, 'each object URL is released exactly once');
  assert.equal((await h.command('STATUS')).state.selection, null);
  assert.equal((await h.command('STATUS')).state.exportResult, null);
  assert.equal((await h.start()).ok, true);
  const newRecording = await h.command('STOP');
  assert.equal(newRecording.state.exportResult, null);
  assert.deepEqual(newRecording.state.selection, { startSeconds: 0, endSeconds: 12 });
});

test('a failed trim preserves both the original and previous clip and can be retried', async () => {
  let failure = false;
  const h = harness({ trimMp4: async (blob, startSeconds, endSeconds) => {
    if (failure) throw new Error('trim failed');
    return { blob: new Blob(['clip'], { type: blob.type }), startSeconds, endSeconds, durationSeconds: endSeconds - startSeconds };
  } });
  await h.start();
  const ready = await h.command('STOP');
  const first = await h.command('PREPARE_EXPORT', { startSeconds: 1, endSeconds: 4 });
  failure = true;
  const failed = await h.command('PREPARE_EXPORT', { startSeconds: 5, endSeconds: 10 });
  assert.equal(failed.ok, false);
  assert.match(failed.error, /trim failed/);
  assert.equal(failed.state.status, 'ready');
  assert.deepEqual(failed.state.result, ready.state.result);
  assert.deepEqual(failed.state.exportResult, first.state.exportResult);
  assert.deepEqual(h.revoked, []);
  failure = false;
  const retried = await h.command('PREPARE_EXPORT', { startSeconds: 5, endSeconds: 10 });
  assert.equal(retried.ok, true);
  assert.deepEqual(retried.state.result, ready.state.result);
  assert.deepEqual(h.revoked, [first.state.exportResult.url]);
});

test('STATUS stays responsive during trimming and conflicting operations cannot alter the recording', async () => {
  const entered = deferred();
  const trimmed = deferred();
  const h = harness({ trimMp4: async () => { entered.resolve(); return trimmed.promise; } });
  await h.start();
  const ready = await h.command('STOP');
  const exporting = h.command('PREPARE_EXPORT', { startSeconds: 1, endSeconds: 5 });
  await entered.promise;
  const busy = await h.command('STATUS');
  assert.equal(busy.state.status, 'trimming');
  assert.deepEqual(busy.state.result, ready.state.result);
  for (const [type, args] of [
    ['SET_SELECTION', { startSeconds: 2, endSeconds: 6 }],
    ['PREPARE_EXPORT', { startSeconds: 2, endSeconds: 6 }],
    ['START', { streamId: 'another-tab' }], ['DISCARD', {}],
    ['DOWNLOAD_UPDATE', { download: { id: null, status: 'pending' } }],
  ]) {
    const rejected = await h.command(type, args);
    assert.equal(rejected.ok, false, `${type} must not run while trimming`);
    assert.equal(rejected.state.status, 'trimming');
  }
  trimmed.resolve({
    blob: new Blob(['clip'], { type: ready.state.result.mimeType }),
    durationSeconds: 4, startSeconds: 1, endSeconds: 5,
  });
  const finished = await exporting;
  assert.equal(finished.ok, true);
  assert.equal(finished.state.status, 'ready');
  assert.deepEqual(finished.state.result, ready.state.result);
  assert.equal(h.trims.length, 1);
  assert.equal(h.revoked.length, 0);
});

test('pending clip downloads block editing and preserve original and clip for a cancelled-save retry', async () => {
  const h = harness();
  await h.start();
  const ready = await h.command('STOP');
  const range = { startSeconds: 1, endSeconds: 7 };
  const clipped = await h.command('PREPARE_EXPORT', range);
  await h.command('DOWNLOAD_UPDATE', { download: { id: null, status: 'pending' } });
  for (const type of ['SET_SELECTION', 'PREPARE_EXPORT', 'DISCARD']) {
    assert.equal((await h.command(type, { startSeconds: 2, endSeconds: 8 })).ok, false);
  }
  await h.command('DOWNLOAD_UPDATE', { download: { id: null, status: 'interrupted', error: 'cancelled' } });
  const retried = await h.command('PREPARE_EXPORT', range);
  assert.equal(retried.ok, true);
  assert.deepEqual(retried.state.result, ready.state.result);
  assert.deepEqual(retried.state.exportResult, clipped.state.exportResult);
  assert.equal(h.trims.length, 1);
  assert.equal(h.revoked.length, 0);
});

test('packet-aligned exports cache by the requested range and keep independent state snapshots', async () => {
  const h = harness({ trimMp4: async (blob) => ({
    blob: new Blob(['aligned-clip'], { type: blob.type }),
    durationSeconds: 4.032, startSeconds: 0.981333, endSeconds: 5.013333,
  }) });
  await h.start();
  await h.command('STOP');
  const range = { startSeconds: 1, endSeconds: 5 };
  const first = await h.command('PREPARE_EXPORT', range);
  assert.equal(first.ok, true);
  assert.deepEqual(first.state.selection, range);
  assert.equal(first.state.exportResult.startSeconds, 0.981333);
  assert.equal(first.state.exportResult.endSeconds, 5.013333);
  const originalClip = { ...first.state.exportResult };
  first.state.exportResult.url = 'blob:tampered';
  const repeated = await h.command('PREPARE_EXPORT', range);
  assert.equal(repeated.ok, true);
  assert.deepEqual(repeated.state.exportResult, originalClip);
  assert.equal(h.trims.length, 1);
  assert.equal(h.revoked.length, 0);
});
