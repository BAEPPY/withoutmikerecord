import test from 'node:test';
import assert from 'node:assert/strict';
import { createFileAudioExtractor } from '../extension/file-audio.js';

const MAX_BYTES = 128 * 1024 * 1024;

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function mp4Blob(type = 'video/mp4') {
  return new Blob([Uint8Array.from([0, 0, 0, 12, 102, 116, 121, 112, 105, 115, 111, 109])], { type });
}

class OversizedBlob extends Blob {
  get size() { return MAX_BYTES + 1; }
}

function harness(options = {}) {
  const original = options.original ?? new Blob(['webm-source-with-audio'], { type: 'video/webm' });
  const videos = [], contexts = [], recorders = [], tracks = [], copies = [], inspections = [];
  const urls = new Map(), revoked = [], intervals = new Set(), timeouts = new Set();
  const started = deferred(), metadataEntered = deferred(), dataEntered = deferred(), stopped = deferred();
  const inspectionEntered = deferred(), contextEntered = deferred();
  let now = 0;

  class Track {
    constructor(kind, purpose) { this.kind = kind; this.purpose = purpose; this.stopped = false; tracks.push(this); }
    stop() { this.stopped = true; }
  }
  class Stream {
    constructor(items) { this.tracks = items; }
    getTracks() { return this.tracks; }
    getAudioTracks() { return this.tracks.filter((track) => track.kind === 'audio'); }
  }
  class Video extends EventTarget {
    duration = options.duration ?? 4;
    readyState = options.dataHang ? 1 : 2;
    _time = 0;
    ended = false;
    src = '';
    listeners = new Map();
    seeks = [];
    constructor() {
      super();
      if (options.noCaptureStream) this.captureStream = undefined;
      videos.push(this);
    }
    addEventListener(type, listener, settings) {
      if (!this.listeners.has(type)) this.listeners.set(type, new Set());
      this.listeners.get(type).add(listener);
      if (type === 'loadeddata') dataEntered.resolve();
      return super.addEventListener(type, listener, settings);
    }
    removeEventListener(type, listener, settings) {
      this.listeners.get(type)?.delete(listener);
      return super.removeEventListener(type, listener, settings);
    }
    get currentTime() { return this._time; }
    set currentTime(value) {
      this.seeks.push(value);
      if (value > 1e6 && options.infiniteDuration) this.duration = options.duration ?? 4;
      this._time = Math.min(value, this.duration);
      if (!options.seekHang) queueMicrotask(() => this.dispatchEvent(new Event('seeked')));
    }
    load() {
      if (!this.src) return;
      metadataEntered.resolve();
      if (options.infiniteDuration) this.duration = Infinity;
      if (options.metadataHang) return;
      queueMicrotask(() => this.dispatchEvent(new Event(options.metadataError ? 'error' : 'loadedmetadata')));
    }
    captureStream() {
      return new Stream([
        new Track('video', 'probe'), ...(options.noAudio ? [] : [new Track('audio', 'probe')]),
      ]);
    }
    play() {
      this.played = true;
      if (options.playError) return Promise.reject(new Error('play failed'));
      if (options.playHang) return new Promise(() => {});
      return Promise.resolve();
    }
    pause() { this.paused = true; }
    removeAttribute(name) { if (name === 'src') this.src = ''; }
  }
  class Context {
    state = options.suspended ? 'suspended' : 'running';
    destination = { speakers: true };
    closed = false;
    connections = [];
    sources = [];
    constructor() { contexts.push(this); contextEntered.resolve(); }
    createMediaElementSource(video) {
      const source = {
        video, disconnected: false,
        connect: (target) => {
          assert.notEqual(target, this.destination, 'imported sound must never be routed to speakers');
          this.connections.push(target);
        },
        disconnect() { this.disconnected = true; },
      };
      this.sources.push(source);
      return source;
    }
    createMediaStreamDestination() {
      const destination = { stream: new Stream(options.noDestinationAudio ? [] : [new Track('audio', 'output')]),
        disconnect() { this.disconnected = true; } };
      this.output = destination;
      return destination;
    }
    async resume() {
      if (options.resumeError) throw new Error('context resume failed');
      if (options.resumeHang) return new Promise(() => {});
      this.state = 'running';
    }
    async close() { this.closed = true; }
  }
  class Recorder {
    static isTypeSupported(type) {
      return !options.unsupported && (options.supportedTypes ?? ['audio/mp4;codecs=mp4a.40.2']).includes(type);
    }
    state = 'inactive';
    stopCalls = 0;
    constructor(stream, settings) {
      if (options.constructorError) throw new Error('encoder construction failed');
      this.stream = stream;
      this.settings = settings;
      this.mimeType = options.wrongMime ? 'audio/webm' : settings.mimeType;
      recorders.push(this);
    }
    start(timeslice) {
      if (options.startError) throw new Error('encoder start failed');
      this.timeslice = timeslice;
      this.state = 'recording';
      started.resolve();
    }
    chunk(data = new Blob(['audio-chunk'], { type: this.mimeType })) { this.ondataavailable?.({ data }); }
    stop() {
      this.stopCalls++;
      this.state = 'inactive';
      stopped.resolve();
      if (options.stopHang) return;
      queueMicrotask(() => {
        this.chunk(new Blob(options.emptyOutput ? [] : ['final-audio'], { type: this.mimeType }));
        this.onstop?.();
      });
    }
    fail() { this.onerror?.({ error: new Error('encoder failed') }); }
  }
  const api = createFileAudioExtractor({
    document: { createElement: (tag) => { assert.equal(tag, 'video'); return new Video(); } },
    MediaRecorder: Recorder, AudioContext: Context,
    url: {
      createObjectURL: (blob) => { const url = `blob:file-audio-${urls.size + 1}`; urls.set(url, blob); return url; },
      revokeObjectURL: (url) => revoked.push(url),
    },
    now: () => now,
    setInterval: (callback) => { intervals.add(callback); return callback; },
    clearInterval: (callback) => intervals.delete(callback),
    setTimeout: (callback) => { timeouts.add(callback); return callback; },
    clearTimeout: (callback) => timeouts.delete(callback),
    selectMp4Tracks: async (blob, content, settings) => {
      copies.push({ blob, content, settings });
      if (options.selectMp4Tracks) return options.selectMp4Tracks(blob, content, settings);
      settings.onProgress?.(0.5);
      return { blob: new Blob(['copied-audio'], { type: 'audio/mp4' }), mimeType: 'audio/mp4',
        kind: 'audio', content: 'audio', durationSeconds: options.duration ?? 4 };
    },
    inspectMp4: async (blob, settings) => {
      inspections.push({ blob, settings });
      inspectionEntered.resolve();
      if (options.inspectMp4) return options.inspectMp4(blob, settings);
      return { durationSeconds: options.outputDuration ?? 4.08 };
    },
  });
  return {
    ...api, original, videos, contexts, recorders, tracks, copies, inspections, urls, revoked, intervals, timeouts,
    started: started.promise, metadataEntered: metadataEntered.promise, dataEntered: dataEntered.promise,
    stopped: stopped.promise, inspectionEntered: inspectionEntered.promise, contextEntered: contextEntered.promise,
    advance: (seconds, wallMs = seconds * 1000) => {
      now += wallMs;
      if (videos[0]) videos[0]._time += seconds;
      for (const callback of [...intervals]) callback();
    },
    end: () => {
      const video = videos[0];
      video._time = video.duration;
      video.ended = true;
      video.dispatchEvent(new Event('ended'));
    },
    timeout: () => { for (const callback of [...timeouts]) callback(); },
  };
}

function assertReleased(h) {
  assert.equal(h.intervals.size, 0, 'conversion interval is removed');
  assert.equal(h.timeouts.size, 0, 'every preparation/finalization timeout is removed');
  assert.ok(h.tracks.every((track) => track.stopped), 'probe and destination tracks stop');
  assert.ok(h.contexts.every((context) => context.closed), 'audio contexts close');
  assert.ok(h.contexts.every((context) => context.sources.every((source) => source.disconnected)), 'audio graph disconnects');
  assert.ok(h.videos.every((video) => video.src === '' && video.paused), 'media element is detached and paused');
  assert.ok(h.videos.every((video) => [...video.listeners.values()].every((listeners) => !listeners.size)), 'media listeners are removed');
  assert.deepEqual([...h.revoked].sort(), [...h.urls.keys()].sort(), 'every temporary object URL is released exactly once');
  assert.ok(h.recorders.every((recorder) => recorder.state === 'inactive'), 'encoders stop');
}

test('MP4 and MOV files copy the audio track without creating decoders or capture devices', async () => {
  for (const original of [mp4Blob(), mp4Blob('video/quicktime'), mp4Blob(''), new Blob(['mime-only'], { type: 'video/mp4' })]) {
    const h = harness({ original });
    const progress = [], stages = [];
    const result = await h.extractFileAudio(original, { onProgress: (value) => progress.push(value), onStage: (value) => stages.push(value) });
    assert.equal(result.method, 'copy');
    assert.equal(result.mimeType, 'audio/mp4');
    assert.equal(await result.blob.text(), 'copied-audio');
    assert.ok(result.durationSeconds > 0);
    assert.equal(h.copies.length, 1);
    assert.equal(h.copies[0].blob, original);
    assert.equal(h.copies[0].content, 'audio');
    assert.equal(h.videos.length, 0);
    assert.equal(h.recorders.length, 0);
    assert.equal(h.contexts.length, 0);
    assert.ok(stages.includes('copying'));
    assert.equal(progress.at(-1), 1);
    assertReleased(h);
  }
});

test('browser-decodable video encodes only audio silently and reports measured output duration', async () => {
  const h = harness();
  const progress = [], stages = [];
  const pending = h.extractFileAudio(h.original, { onProgress: (value) => progress.push(value), onStage: (value) => stages.push(value) });
  await h.started;
  assert.equal(h.copies.length, 0);
  assert.equal(h.videos[0].muted, false, 'muting the source element would erase real audio');
  assert.equal(h.videos[0].volume, 1);
  assert.deepEqual(h.recorders[0].stream.getTracks().map((track) => track.kind), ['audio']);
  assert.equal(h.recorders[0].stream, h.contexts[0].output.stream);
  assert.deepEqual(h.contexts[0].connections, [h.contexts[0].output]);
  assert.ok(h.tracks.filter((track) => track.purpose === 'probe').every((track) => track.stopped));
  h.recorders[0].chunk(new Blob(['first-audio'], { type: 'audio/mp4' }));
  h.advance(2);
  assert.ok(progress.some((value) => value > 0 && value < 1));
  h.end();
  const result = await pending;
  assert.equal(result.method, 'encode');
  assert.match(result.mimeType, /^audio\/mp4/);
  assert.equal(result.durationSeconds, 4.08);
  assert.equal(await result.blob.text(), 'first-audiofinal-audio', 'final recorder data is included');
  assert.equal(await h.original.text(), 'webm-source-with-audio');
  assert.ok(stages.includes('encoding'));
  assert.ok(stages.includes('finishing'));
  assert.equal(progress.at(-1), 1);
  assertReleased(h);
});

test('a failed MP4 copy can fall back to decoding but an absent audio track cannot become silent output', async () => {
  const fallback = harness({ original: mp4Blob(), selectMp4Tracks: async () => { throw new Error('unsupported source codec'); } });
  const pending = fallback.extractFileAudio(fallback.original);
  await fallback.started;
  fallback.end();
  assert.equal((await pending).method, 'encode');
  assert.equal(fallback.copies.length, 1);
  assertReleased(fallback);

  const missing = harness({ original: mp4Blob(), selectMp4Tracks: async () => { throw new Error('이 파일에는 소리 트랙이 없어요.'); } });
  await assert.rejects(missing.extractFileAudio(missing.original), /소리 트랙이 없/);
  assert.equal(missing.videos.length, 0, 'copy-proven absence of audio must not use a generated silent track');
  assert.equal(missing.recorders.length, 0);
  assertReleased(missing);
});

test('decoded sources without audio fail before encoding, while a present silent audio track remains valid', async () => {
  const absent = harness({ noAudio: true });
  await assert.rejects(absent.extractFileAudio(absent.original), /소리|오디오/);
  assert.equal(absent.recorders.length, 0);
  assertReleased(absent);
  const silent = harness();
  const pending = silent.extractFileAudio(silent.original);
  await silent.started;
  silent.end();
  assert.equal((await pending).method, 'encode', 'track presence, not audio amplitude, determines whether audio exists');
  assertReleased(silent);
});

test('fragmented media with initially infinite duration seeks to discover its end and rewinds before encoding', async () => {
  const h = harness({ infiniteDuration: true });
  const pending = h.extractFileAudio(h.original);
  await h.started;
  assert.ok(h.videos[0].seeks.some((time) => time > 1e6));
  assert.equal(h.videos[0].currentTime, 0);
  h.end();
  assert.equal((await pending).method, 'encode');
  assertReleased(h);
});

test('empty, invalid, oversized and overlong inputs fail before an encoder starts', async () => {
  for (const original of [null, {}, new Blob([]), new OversizedBlob(['small-physical-data'])]) {
    const h = harness();
    await assert.rejects(h.extractFileAudio(original));
    assert.equal(h.recorders.length, 0);
    assert.equal(h.copies.length, 0);
    assertReleased(h);
  }
  for (const duration of [0, NaN, 7200.01]) {
    const h = harness({ duration });
    await assert.rejects(h.extractFileAudio(h.original));
    assert.equal(h.recorders.length, 0);
    assertReleased(h);
  }
});

test('abort before starting never reads or allocates media resources', async () => {
  const h = harness();
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(h.extractFileAudio(h.original, { signal: controller.signal }), { name: 'AbortError' });
  assert.equal(h.copies.length, 0);
  assert.equal(h.videos.length, 0);
  assertReleased(h);
});

test('abort while reading metadata or waiting for decoded data cleans every pending listener and URL', async () => {
  for (const options of [{ metadataHang: true }, { dataHang: true }]) {
    const h = harness(options);
    const controller = new AbortController();
    const pending = h.extractFileAudio(h.original, { signal: controller.signal });
    await (options.metadataHang ? h.metadataEntered : h.dataEntered);
    controller.abort();
    await assert.rejects(pending, { name: 'AbortError' });
    assert.equal(h.recorders.length, 0);
    assertReleased(h);
  }
});

test('abort during encoding and while awaiting the final recorder chunk releases all resources', async () => {
  for (const stopHang of [false, true]) {
    const h = harness({ stopHang });
    const controller = new AbortController();
    const pending = h.extractFileAudio(h.original, { signal: controller.signal });
    await h.started;
    if (stopHang) { h.end(); await h.stopped; }
    controller.abort();
    await assert.rejects(pending, { name: 'AbortError' });
    assert.equal(await h.original.text(), 'webm-source-with-audio');
    assertReleased(h);
  }
});

test('unsupported MP4 encoders, wrong MIME and startup errors cannot leave resources active', async () => {
  for (const options of [
    { unsupported: true }, { wrongMime: true }, { constructorError: true }, { startError: true },
    { noDestinationAudio: true }, { noCaptureStream: true }, { suspended: true, resumeError: true },
  ]) {
    const h = harness(options);
    await assert.rejects(h.extractFileAudio(h.original));
    assertReleased(h);
  }
});

test('playback and recorder errors, empty data, and over-limit output cannot return a bogus MP4', async () => {
  const playback = harness({ playError: true });
  await assert.rejects(playback.extractFileAudio(playback.original), /재생을 시작/);
  assertReleased(playback);
  for (const kind of ['recorder', 'empty', 'oversized']) {
    const h = harness({ emptyOutput: kind === 'empty' });
    const pending = h.extractFileAudio(h.original);
    await h.started;
    if (kind === 'recorder') h.recorders[0].fail();
    else if (kind === 'oversized') h.recorders[0].chunk(new OversizedBlob(['large-output'], { type: 'audio/mp4' }));
    else h.end();
    await assert.rejects(pending);
    assertReleased(h);
  }
});

test('metadata, stalled playback and finalization timeouts cannot hang file extraction', async () => {
  const loading = harness({ metadataHang: true });
  const loadJob = loading.extractFileAudio(loading.original);
  await loading.metadataEntered;
  loading.timeout();
  await assert.rejects(loadJob, /시간|초과/);
  assertReleased(loading);
  const stalled = harness();
  const stalledJob = stalled.extractFileAudio(stalled.original);
  await stalled.started;
  stalled.advance(0, 31_000);
  await assert.rejects(stalledJob, /멈|시간|초과/);
  assertReleased(stalled);
  const finishing = harness({ stopHang: true });
  const finishJob = finishing.extractFileAudio(finishing.original);
  await finishing.started;
  finishing.end();
  await finishing.stopped;
  finishing.timeout();
  await assert.rejects(finishJob, /마무리|시간|초과/);
  assertReleased(finishing);
});

test('cancelling a pending file-header read releases its timer without constructing any media element', async () => {
  const read = deferred(), entered = deferred();
  class PendingHeaderBlob extends Blob {
    slice() { return { arrayBuffer: () => { entered.resolve(); return read.promise; } }; }
  }
  const h = harness({ original: new PendingHeaderBlob(['pending-header'], { type: 'video/webm' }) });
  const controller = new AbortController();
  const pending = h.extractFileAudio(h.original, { signal: controller.signal });
  await entered.promise;
  controller.abort(new Error('custom cancellation reason'));
  await assert.rejects(pending, { name: 'AbortError' });
  assert.equal(h.videos.length, 0);
  assert.equal(h.copies.length, 0);
  assertReleased(h);
  read.resolve(new ArrayBuffer(12));
  await Promise.resolve();
  assert.equal(h.videos.length, 0, 'late file reads cannot begin decoding after cancellation');
});

test('copy cancellation reaches the copier immediately and never falls through to the decoder', async () => {
  const copying = deferred(), release = deferred();
  let copySignal;
  const h = harness({ original: mp4Blob(), selectMp4Tracks: async (_blob, _content, { signal }) => {
    copySignal = signal;
    copying.resolve();
    await release.promise;
    return { blob: new Blob(['late-copy'], { type: 'audio/mp4' }), mimeType: 'audio/mp4', durationSeconds: 4 };
  } });
  const controller = new AbortController();
  const pending = h.extractFileAudio(h.original, { signal: controller.signal });
  await copying.promise;
  assert.equal(copySignal.aborted, false);
  const rejected = assert.rejects(pending, { name: 'AbortError' });
  controller.abort();
  assert.equal(copySignal.aborted, true);
  await rejected;
  assert.equal(h.videos.length, 0);
  assertReleased(h);
  release.resolve();
  await Promise.resolve();
  assert.equal(h.videos.length, 0, 'copy completion after cancellation cannot start a decoder');
});

test('a stalled copy times out into decoding and its late progress cannot change the active job', async () => {
  const copying = deferred();
  let lateProgress;
  let copySignal;
  const h = harness({ original: mp4Blob(), selectMp4Tracks: async (_blob, _content, { signal, onProgress }) => {
    copySignal = signal;
    lateProgress = onProgress;
    onProgress(0.5);
    copying.resolve();
    return new Promise(() => {});
  } });
  const progress = [];
  const controller = new AbortController();
  const pending = h.extractFileAudio(h.original, { signal: controller.signal, onProgress: (value) => progress.push(value) });
  await copying.promise;
  h.timeout();
  await h.started;
  assert.equal(copySignal.aborted, true, 'timeout cancels abandoned parsing and remuxing');
  assert.equal(controller.signal.aborted, false, 'the decoder fallback remains independently usable');
  h.advance(2);
  const activeProgress = [...progress];
  lateProgress(1);
  assert.deepEqual(progress, activeProgress, 'the abandoned copy cannot move decoder progress');
  h.end();
  assert.equal((await pending).method, 'encode');
  const completedProgress = [...progress];
  lateProgress(1);
  assert.deepEqual(progress, completedProgress, 'the abandoned copy cannot publish after the job finishes');
  assertReleased(h);
});

test('copy result validation rejects empty, oversized, non-MP4 and overlong outputs without decoding', async () => {
  const valid = { blob: new Blob(['audio'], { type: 'audio/mp4' }), mimeType: 'audio/mp4', durationSeconds: 4 };
  for (const replacement of [
    { blob: new Blob([]) }, { blob: new OversizedBlob(['audio'], { type: 'audio/mp4' }) },
    { mimeType: 'audio/webm' }, { durationSeconds: 0 }, { durationSeconds: 7200.1 },
  ]) {
    const h = harness({ original: mp4Blob(), selectMp4Tracks: async () => ({ ...valid, ...replacement }) });
    await assert.rejects(h.extractFileAudio(h.original));
    assert.equal(h.videos.length, 0, 'invalid copy results are failures, not invitations to synthesize a replacement');
    assertReleased(h);
  }
});

test('copy fallback reports monotonic progress and preserves the original across stage changes', async () => {
  const h = harness({ original: mp4Blob(), selectMp4Tracks: async (_blob, _content, { onProgress }) => {
    onProgress(0.8);
    throw new Error('unusual MP4 structure');
  } });
  const progress = [], stages = [];
  const pending = h.extractFileAudio(h.original, { onProgress: (value) => progress.push(value), onStage: (value) => stages.push(value) });
  await h.started;
  h.advance(1);
  h.advance(2);
  h.end();
  assert.equal((await pending).method, 'encode');
  assert.deepEqual(stages, ['reading', 'copying', 'encoding', 'finishing']);
  assert.deepEqual([...progress].sort((a, b) => a - b), progress);
  assert.equal(progress.at(-1), 1);
  assert.equal(await h.original.arrayBuffer().then((buffer) => buffer.byteLength), 12);
  assertReleased(h);
});

test('aborting or timing out final output inspection frees the finished encoder and media graph', async () => {
  for (const outcome of ['abort', 'timeout', 'reject']) {
    const inspection = deferred();
    const h = harness({ inspectMp4: () => inspection.promise });
    const controller = new AbortController();
    const pending = h.extractFileAudio(h.original, { signal: controller.signal });
    await h.started;
    h.end();
    await h.inspectionEntered;
    if (outcome === 'abort') controller.abort();
    else if (outcome === 'timeout') h.timeout();
    else inspection.reject(new Error('unreadable output index'));
    await assert.rejects(pending, outcome === 'abort' ? { name: 'AbortError' } : undefined);
    assertReleased(h);
    if (outcome !== 'reject') inspection.resolve({ durationSeconds: 4 });
  }
});

test('audio duration is measured from the encoded file and invalid output durations are rejected', async () => {
  for (const outputDuration of [0, Infinity, 7200.1]) {
    const h = harness({ outputDuration });
    const pending = h.extractFileAudio(h.original);
    await h.started;
    h.end();
    await assert.rejects(pending);
    assert.equal(h.inspections.length, 1);
    assertReleased(h);
  }
});

test('premature source endings fail while a normal endpoint completes without truncating final data', async () => {
  for (const viaEvent of [true, false]) {
    const h = harness();
    const pending = h.extractFileAudio(h.original);
    await h.started;
    h.videos[0]._time = 1;
    h.videos[0].ended = true;
    if (viaEvent) h.videos[0].dispatchEvent(new Event('ended'));
    else h.advance(0);
    await assert.rejects(pending, /끝나기 전에|모두 추출/);
    assert.equal(h.inspections.length, 0);
    assertReleased(h);
  }
  const nearEnd = harness();
  const completed = nearEnd.extractFileAudio(nearEnd.original);
  await nearEnd.started;
  nearEnd.videos[0]._time = 3.95;
  nearEnd.videos[0].ended = true;
  nearEnd.videos[0].dispatchEvent(new Event('ended'));
  assert.equal(await (await completed).blob.text(), 'final-audio');
  assertReleased(nearEnd);
});

test('an audio-context resume that stalls remains cancellable and bounded', async () => {
  for (const outcome of ['abort', 'timeout']) {
    const h = harness({ suspended: true, resumeHang: true });
    const controller = new AbortController();
    const pending = h.extractFileAudio(h.original, { signal: controller.signal });
    await h.contextEntered;
    if (outcome === 'abort') controller.abort();
    else h.timeout();
    await assert.rejects(pending, outcome === 'abort' ? { name: 'AbortError' } : undefined);
    assert.equal(h.recorders.length, 0);
    assertReleased(h);
  }
});

test('decoder errors and unexpected encoder stops cannot publish truncated audio', async () => {
  const unreadable = harness({ metadataError: true });
  await assert.rejects(unreadable.extractFileAudio(unreadable.original), /형식|코덱|읽/);
  assert.equal(unreadable.recorders.length, 0);
  assertReleased(unreadable);
  for (const fault of ['decoder', 'unexpected-stop']) {
    const h = harness();
    const pending = h.extractFileAudio(h.original);
    await h.started;
    h.recorders[0].chunk();
    if (fault === 'decoder') h.videos[0].dispatchEvent(new Event('error'));
    else {
      h.recorders[0].state = 'inactive';
      h.recorders[0].onstop?.();
    }
    await assert.rejects(pending);
    assert.equal(h.inspections.length, 0, 'partial bytes are not offered as a completed output');
    assertReleased(h);
  }
});

test('cancelling synchronously from the first copy progress callback does not leave a rejected copier unobserved', async () => {
  const h = harness({ original: mp4Blob(), selectMp4Tracks: async (_blob, _content, { onProgress }) => {
    onProgress(0);
    return { blob: new Blob(['not-published'], { type: 'audio/mp4' }), mimeType: 'audio/mp4', durationSeconds: 4 };
  } });
  const controller = new AbortController();
  const pending = h.extractFileAudio(h.original, {
    signal: controller.signal,
    onProgress: (value) => { if (value >= 0.02) controller.abort(); },
  });
  await assert.rejects(pending, { name: 'AbortError' });
  // Node reports an unhandled copier rejection on the next turn if the wrapper
  // checks the already-aborted signal before observing that Promise.
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(h.videos.length, 0);
  assertReleased(h);
});
