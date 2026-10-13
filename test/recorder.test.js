import test from 'node:test';
import assert from 'node:assert/strict';
import { TabAudioRecorder } from '../extension/recorder.js';

function harness(options = {}) {
  let time = 0;
  const captures = [];
  const recorders = [];
  const contexts = [];
  const states = [];
  const timers = new Set();
  const blobs = [];
  const revoked = [];

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
    onStateChange: (state) => states.push(state),
    maxBytes: options.maxBytes,
    maxDurationMs: options.maxDurationMs,
  });
  return {
    engine, captures, recorders, contexts, states, track, blobs, revoked, timers,
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
  await Promise.resolve();
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
  await Promise.resolve();
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
  await Promise.resolve();
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
  await Promise.resolve();
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
  await Promise.resolve();
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
