import test from 'node:test';
import assert from 'node:assert/strict';
import { createVideoTrimmer, validateVideoTrimRange } from '../extension/video-trim.js';

function deferred() {
  let resolve;
  const promise = new Promise((yes) => { resolve = yes; });
  return { promise, resolve };
}

function harness(options = {}) {
  const original = new Blob(['original-video'], { type: 'video/mp4' });
  const videos = [], canvases = [], recorders = [], contexts = [], tracks = [];
  const blobs = new Map(), revoked = [], intervals = new Set(), timeouts = new Set();
  const started = deferred(), metadataEntered = deferred();
  let now = 0, urlIndex = 0;
  class Track {
    constructor(kind) { this.kind = kind; this.stopped = false; tracks.push(this); }
    stop() { this.stopped = true; }
  }
  class Stream {
    constructor(items) { this.tracks = items; }
    getTracks() { return this.tracks; }
    getAudioTracks() { return this.tracks.filter((track) => track.kind === 'audio'); }
    getVideoTracks() { return this.tracks.filter((track) => track.kind === 'video'); }
  }
  class Video extends EventTarget {
    duration = 4;
    videoWidth = 640;
    videoHeight = 360;
    readyState = 2;
    _time = 0;
    frames = new Map();
    src = '';
    constructor() { super(); videos.push(this); }
    get currentTime() { return this._time; }
    set currentTime(value) {
      if (value > 1e6 && options.infiniteDuration) this.duration = 4;
      this._time = Math.min(value, this.duration);
      queueMicrotask(() => this.dispatchEvent(new Event('seeked')));
    }
    load() {
      if (!this.src) return;
      metadataEntered.resolve();
      this.duration = blobs.get(this.src) === original ? (options.infiniteDuration ? Infinity : 4) : 1.04;
      if (options.metadataHang) return;
      queueMicrotask(() => this.dispatchEvent(new Event('loadedmetadata')));
    }
    play() {
      this.played = true;
      if (options.playError) return Promise.reject(new Error('play failed'));
      return Promise.resolve();
    }
    pause() { this.paused = true; }
    removeAttribute(name) { if (name === 'src') this.src = ''; }
    requestVideoFrameCallback(callback) { const id = Symbol(); this.frames.set(id, callback); return id; }
    cancelVideoFrameCallback(id) { this.frames.delete(id); }
  }
  class Context {
    state = 'running';
    destination = { speakers: true };
    closed = false;
    connections = [];
    constructor() { contexts.push(this); }
    createMediaElementSource(video) {
      this.video = video;
      return { connect: (target) => {
        assert.notEqual(target, this.destination, 'conversion must not play through speakers');
        this.connections.push(target);
      }, disconnect() {} };
    }
    createMediaStreamDestination() { return { stream: new Stream([new Track('audio')]) }; }
    async close() { this.closed = true; }
  }
  class Recorder {
    static isTypeSupported(type) { return !options.unsupported && type === 'video/mp4;codecs=avc1.420028,mp4a.40.2'; }
    state = 'inactive';
    constructor(stream, settings) {
      this.stream = stream;
      this.mimeType = options.wrongMime ? 'video/webm' : settings.mimeType;
      recorders.push(this);
    }
    start() { this.state = 'recording'; started.resolve(); }
    stop() {
      this.state = 'inactive';
      if (options.stopHang) return;
      queueMicrotask(() => {
        this.ondataavailable?.({ data: new Blob(options.empty ? [] : ['clipped-video'], { type: this.mimeType }) });
        this.onstop?.();
      });
    }
  }
  const api = createVideoTrimmer({
    document: { createElement: (tag) => {
      if (tag === 'video') return new Video();
      const canvas = {
        draws: [],
        getContext() { return { drawImage: (...args) => this.draws.push(args) }; },
        captureStream(fps) { assert.equal(fps, 30); return new Stream([new Track('video')]); },
      };
      canvases.push(canvas);
      return canvas;
    } },
    MediaRecorder: Recorder, MediaStream: Stream, AudioContext: Context,
    url: { createObjectURL: (blob) => { const url = `blob:trim-${++urlIndex}`; blobs.set(url, blob); return url; },
      revokeObjectURL: (url) => revoked.push(url) },
    now: () => now,
    setInterval: (callback) => { intervals.add(callback); return callback; },
    clearInterval: (callback) => intervals.delete(callback),
    setTimeout: (callback) => { timeouts.add(callback); return callback; },
    clearTimeout: (callback) => timeouts.delete(callback),
  });
  return { ...api, original, videos, canvases, recorders, contexts, tracks, blobs, revoked, intervals, timeouts,
    started: started.promise, metadataEntered: metadataEntered.promise,
    advance: (seconds, wallMs = seconds * 1000) => {
      now += wallMs;
      videos[0]._time += seconds;
      for (const callback of [...intervals]) callback();
    },
    timeout: () => { for (const callback of [...timeouts]) callback(); },
  };
}

function assertReleased(h) {
  assert.equal(h.intervals.size, 0);
  assert.equal(h.timeouts.size, 0);
  assert.ok(h.tracks.every((track) => track.stopped));
  assert.ok(h.contexts.every((context) => context.closed));
  assert.ok(h.videos.every((video) => video.src === '' && video.paused && video.frames.size === 0));
  assert.ok(h.canvases.every((canvas) => canvas.width === 0 && canvas.height === 0));
  assert.deepEqual([...h.revoked].sort(), [...h.blobs.keys()].sort());
}

test('trim ranges reject invalid and sub-frame intervals while accepting hundredth boundaries', () => {
  for (const values of [[NaN, 2, 4], [0, Infinity, 4], [-1, 1, 4], [2, 1, 4], [0, 5, 4], [0, 0.01, 4]]) {
    assert.throws(() => validateVideoTrimRange(...values));
  }
  assert.deepEqual(validateVideoTrimRange(1.25, 2.37, 4), { startSeconds: 1.25, endSeconds: 2.37 });
  assert.deepEqual(validateVideoTrimRange(3.96, 4, 4), { startSeconds: 3.96, endSeconds: 4 });
});

test('metadata discovery handles fragmented infinite duration without playing audio', async () => {
  const h = harness({ infiniteDuration: true });
  assert.deepEqual(await h.inspectVideo(h.original), { durationSeconds: 4, width: 640, height: 360 });
  assert.equal(h.videos[0].played, undefined);
  assert.equal(h.videos[0].muted, true);
  assertReleased(h);
});

test('full-range export reuses the original and creates no encoder or audio graph', async () => {
  const h = harness();
  const result = await h.trimVideo(h.original, 0, 4);
  assert.equal(result.blob, h.original);
  assert.equal(h.recorders.length, 0);
  assert.equal(h.contexts.length, 0);
  assertReleased(h);
});

test('selected MP4 contains video and original audio with progress and actual output duration', async () => {
  const h = harness();
  const progress = [];
  const job = h.trimVideo(h.original, 1.25, 2.25, { onProgress: (value) => progress.push(value) });
  await h.started;
  assert.equal(h.videos[0].currentTime, 1.25);
  assert.equal(h.videos[0].muted, false);
  assert.equal(h.videos[0].volume, 1);
  assert.deepEqual(h.recorders[0].stream.getTracks().map((track) => track.kind), ['video', 'audio']);
  h.advance(0.5);
  assert.ok(progress.some((value) => value > 0 && value < 1));
  h.advance(0.5);
  const result = await job;
  assert.equal(result.durationSeconds, 1.04, 'the returned duration is measured from the encoded output');
  assert.equal(result.startSeconds, 1.25);
  assert.equal(result.endSeconds, 2.25);
  assert.equal(result.width, 640);
  assert.match(result.mimeType, /^video\/mp4/);
  assert.equal(await result.blob.text(), 'clipped-video');
  assert.equal(await h.original.text(), 'original-video');
  assert.equal(progress.at(-1), 1);
  assertReleased(h);
});

test('aborting active conversion frees every browser resource and preserves the original', async () => {
  const h = harness();
  const controller = new AbortController();
  const job = h.trimVideo(h.original, 1, 2, { signal: controller.signal });
  await h.started;
  controller.abort();
  await assert.rejects(job, { name: 'AbortError' });
  assert.equal(await h.original.text(), 'original-video');
  assertReleased(h);
});

test('aborting metadata loading removes listeners, timer and object URL without starting capture', async () => {
  const h = harness({ metadataHang: true });
  const controller = new AbortController();
  const job = h.trimVideo(h.original, 1, 2, { signal: controller.signal });
  await h.metadataEntered;
  controller.abort();
  await assert.rejects(job, { name: 'AbortError' });
  assert.equal(h.recorders.length, 0);
  assertReleased(h);
});

test('unsupported output and unexpected encoder types fail cleanly without WebM fallback', async () => {
  for (const options of [{ unsupported: true }, { wrongMime: true }]) {
    const h = harness(options);
    await assert.rejects(h.trimVideo(h.original, 1, 2), /MP4/);
    assertReleased(h);
  }
});

test('playback errors and empty encoder output preserve the original and release resources', async () => {
  const failedPlay = harness({ playError: true });
  await assert.rejects(failedPlay.trimVideo(failedPlay.original, 1, 2), /play failed/);
  assertReleased(failedPlay);
  const empty = harness({ empty: true });
  const job = empty.trimVideo(empty.original, 1, 2);
  await empty.started;
  empty.advance(1);
  await assert.rejects(job, /프레임/);
  assertReleased(empty);
});

test('a stalled media clock or a recorder that never finishes cannot hang conversion', async () => {
  const stalled = harness();
  const stalledJob = stalled.trimVideo(stalled.original, 1, 2);
  await stalled.started;
  stalled.advance(0, 31_000);
  await assert.rejects(stalledJob, /재생이 멈춰/);
  assertReleased(stalled);
  const stopping = harness({ stopHang: true });
  const stopJob = stopping.trimVideo(stopping.original, 1, 2);
  await stopping.started;
  stopping.advance(1);
  stopping.timeout();
  await assert.rejects(stopJob, /마무리/);
  assertReleased(stopping);
});
