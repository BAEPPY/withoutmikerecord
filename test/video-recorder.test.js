import test from 'node:test';
import assert from 'node:assert/strict';
import { TabAudioRecorder } from '../extension/recorder.js';
import { validateVideoRegion, videoCaptureSize, videoCropDimensions, createVideoCropper } from '../extension/video-crop.js';

const region = { x: 0.25, y: 0.25, width: 0.5, height: 0.5, viewportWidth: 1280, viewportHeight: 720 };
const tab = { id: 41, title: '영상 탭', url: 'https://example.com/video' };

function harness(options = {}) {
  const captures = [];
  const recorders = [];
  const crops = [];
  const urls = [];
  const revoked = [];
  const exports = [];
  let elapsed = 0;
  class Track extends EventTarget {
    constructor(kind) { super(); this.kind = kind; this.stopped = false; }
    stop() { this.stopped = true; }
  }
  class Stream {
    constructor(tracks) { this.tracks = tracks; }
    getTracks() { return this.tracks; }
    getAudioTracks() { return this.tracks.filter((track) => track.kind === 'audio'); }
    getVideoTracks() { return this.tracks.filter((track) => track.kind === 'video'); }
  }
  const audio = new Track('audio');
  const video = new Track('video');
  const cropped = new Track('video');
  const stream = new Stream(options.noVideo ? [audio] : options.noAudio ? [video] : [audio, video]);
  class Recorder {
    static isTypeSupported(type) { return (options.types ?? ['video/mp4;codecs=avc1.420028,mp4a.40.2']).includes(type); }
    constructor(input, settings) {
      this.stream = input;
      this.settings = settings;
      this.mimeType = options.actualMimeType ?? settings.mimeType;
      this.state = 'inactive';
      recorders.push(this);
    }
    start() { this.state = 'recording'; }
    pause() { this.state = 'paused'; }
    resume() { this.state = 'recording'; }
    stop() {
      this.state = 'inactive';
      queueMicrotask(() => {
        this.ondataavailable?.({ data: new Blob(['native-video'], { type: this.mimeType }) });
        this.onstop?.();
      });
    }
  }
  class Context {
    state = 'running';
    destination = {};
    createMediaStreamSource(input) {
      assert.equal(input, stream, 'monitor uses the captured tab audio');
      return { connect() {}, disconnect() {} };
    }
    createAnalyser() { return { fftSize: 16, connect() {}, disconnect() {}, getFloatTimeDomainData(a) { a.fill(0); } }; }
    async close() {}
  }
  const engine = new TabAudioRecorder({
    mediaDevices: { getUserMedia: async (constraints) => {
      captures.push(constraints);
      options.onCapture?.();
      if (options.capturePromise) await options.capturePromise;
      return stream;
    } },
    MediaRecorder: Recorder, MediaStream: Stream, AudioContext: Context,
    createVideoCropper: async (input, selection, settings) => {
      assert.equal(input, stream);
      if (options.cropError) throw new Error('crop failed');
      const crop = { stream: new Stream([cropped]), width: 640, height: 360,
        dispose() { cropped.stop(); this.disposed = true; }, ...settings, selection };
      crops.push(crop);
      if (options.changeDuringStart) settings.onGeometryChanged();
      return crop;
    },
    inspectMp4: () => { throw new Error('video must not use the audio-only parser'); },
    trimMp4: () => { throw new Error('video must not use the audio-only trimmer'); },
    exportGif: async (blob, settings) => {
      exports.push(blob);
      if (options.exportGif) return options.exportGif(blob, settings);
      settings.onProgress(1);
      return { blob: new Blob(['GIF89a-frames'], { type: 'image/gif' }),
        width: 320, height: 180, frameCount: 15, durationSeconds: 1.5 };
    },
    now: () => elapsed,
    setInterval: () => 1, clearInterval() {},
    url: { createObjectURL: (blob) => { urls.push(blob); return `blob:test-${urls.length}`; }, revokeObjectURL: (url) => revoked.push(url) },
  });
  return { engine, audio, video, cropped, captures, crops, recorders, urls, revoked, exports,
    advance: (ms) => { elapsed += ms; },
    select: () => engine.handle({ type: 'SELECT_VIDEO', tab, selectionToken: 'fresh-token' }),
    start: (overrides = {}) => engine.handle({ type: 'START', mode: 'video', tab, region,
      selectionToken: 'fresh-token', streamId: 'tab-stream', ...overrides }),
  };
}

test('video selection is cancellable and cannot reuse another tab or stale token', async () => {
  const h = harness();
  assert.equal((await h.start()).ok, false);
  const selected = await h.select();
  assert.equal(selected.state.status, 'selecting');
  assert.equal(selected.state.selectionUrl, tab.url);
  assert.equal((await h.start({ selectionToken: 'old-token' })).ok, false);
  assert.equal((await h.start({ tab: { ...tab, id: 42 } })).ok, false);
  assert.equal(h.captures.length, 0);
  assert.equal((await h.engine.handle({ type: 'CANCEL_VIDEO', selectionToken: 'old-token' })).ok, false);
  assert.equal(h.engine.getState().status, 'selecting');
  const cancelled = await h.engine.handle({ type: 'CANCEL_VIDEO', selectionToken: 'fresh-token' });
  assert.equal(cancelled.state.status, 'idle');
  assert.equal(cancelled.state.selectionToken, null);
  assert.equal(cancelled.state.mode, 'audio');
});

test('records cropped video plus captured tab audio into native MP4 and releases every stream', async () => {
  const h = harness();
  await h.select();
  const started = await h.start();
  assert.equal(started.ok, true);
  assert.equal(started.state.selectionToken, null);
  assert.equal(started.state.selectionUrl, null);
  assert.deepEqual(h.captures, [{
    audio: { mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: 'tab-stream' } },
    video: { mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: 'tab-stream',
      minWidth: 1280, maxWidth: 1280, minHeight: 720, maxHeight: 720, maxFrameRate: 30 } },
  }]);
  assert.deepEqual(h.recorders[0].stream.getTracks(), [h.cropped, h.audio]);
  assert.match(h.recorders[0].mimeType, /^video\/mp4/);
  h.advance(2350);
  const stopped = await h.engine.handle({ type: 'STOP' });
  assert.equal(stopped.ok, true);
  assert.equal(stopped.state.result.kind, 'video');
  assert.equal(stopped.state.result.width, 640);
  assert.equal(stopped.state.result.height, 360);
  assert.equal(stopped.state.result.durationSeconds, 2.35);
  assert.equal(stopped.state.selection, null);
  assert.equal(h.audio.stopped, true);
  assert.equal(h.video.stopped, true);
  assert.equal(h.cropped.stopped, true);
  assert.equal(h.crops[0].disposed, true);
  assert.equal((await h.engine.handle({ type: 'PREPARE_EXPORT', startSeconds: 0, endSeconds: 1 })).ok, false);
  assert.equal(stopped.state.result.url, h.engine.getState().result.url, 'rejected audio trim preserves video');
  await h.engine.handle({ type: 'DISCARD' });
  assert.deepEqual(h.revoked, ['blob:test-1']);
});

test('video rejects malformed regions before requesting capture', async () => {
  const h = harness();
  await h.select();
  for (const bad of [{ ...region, x: -1 }, { ...region, width: Infinity }, { ...region, width: 0.001 }, { ...region, height: 2 }]) {
    assert.equal((await h.start({ region: bad })).ok, false);
  }
  assert.equal(h.captures.length, 0);
  assert.equal(h.engine.getState().status, 'selecting');
});

test('missing tracks, crop failures, and invalid encoder types release source capture', async () => {
  for (const options of [{ noVideo: true }, { noAudio: true }, { cropError: true }, { actualMimeType: 'video/webm' }, { changeDuringStart: true }]) {
    const h = harness(options);
    await h.select();
    assert.equal((await h.start()).ok, false);
    assert.equal(h.engine.getState().status, 'error');
    for (const track of options.noVideo ? [h.audio] : options.noAudio ? [h.video] : [h.audio, h.video]) assert.equal(track.stopped, true);
    if (h.crops.length) assert.equal(h.cropped.stopped, true);
  }
});

test('unsupported MP4 video fails before capture and never uses WebM fallback', async () => {
  const h = harness({ types: ['video/webm;codecs=vp9,opus'] });
  await h.select();
  const result = await h.start();
  assert.equal(result.ok, false);
  assert.match(result.error, /MP4/);
  assert.equal(h.captures.length, 0);
});

test('source video ending or geometry change stops recording with a saveable result', async () => {
  for (const reason of ['ended', 'geometry']) {
    const h = harness();
    await h.select();
    await h.start();
    h.advance(1500);
    if (reason === 'ended') h.video.dispatchEvent(new Event('ended'));
    else h.crops[0].onGeometryChanged();
    await h.engine.stopPromise;
    assert.equal(h.engine.getState().status, 'ready');
    assert.ok(h.engine.getState().result.url);
    assert.match(h.engine.getState().notice, reason === 'ended' ? /연결/ : /크기/);
  }
});


test('viewport changes stop only the matching active video session and preserve the recorded file', async () => {
  for (const paused of [false, true]) {
    const h = harness();
    await h.select();
    await h.start();
    h.advance(1500);
    if (paused) await h.engine.handle({ type: 'PAUSE' });
    assert.equal(h.engine.getState().videoSessionToken, 'fresh-token');
    for (const wrong of [{ tabId: 42, selectionToken: 'fresh-token' }, { tabId: tab.id, selectionToken: 'old-token' }, { tabId: tab.id }]) {
      const reply = await h.engine.handle({ type: 'VIDEO_VIEWPORT_CHANGED', ...wrong });
      assert.equal(reply.ok, true);
      assert.equal(h.engine.getState().status, paused ? 'paused' : 'recording');
    }
    await h.engine.handle({ type: 'VIDEO_VIEWPORT_CHANGED', tabId: tab.id, selectionToken: 'fresh-token' });
    await h.engine.stopPromise;
    const state = h.engine.getState();
    assert.equal(state.status, 'ready');
    assert.equal(state.result.kind, 'video');
    assert.ok(state.result.url);
    assert.match(state.notice, /페이지의 화면 크기/);
    assert.equal(h.audio.stopped, true);
    assert.equal(h.video.stopped, true);
    assert.equal(h.cropped.stopped, true);
  }
});

test('viewport changes interrupt pending capture setup before an encoder can start', async () => {
  let releaseCapture;
  let enteredCapture;
  const capturePromise = new Promise((resolve) => { releaseCapture = resolve; });
  const entered = new Promise((resolve) => { enteredCapture = resolve; });
  const h = harness({ capturePromise, onCapture: enteredCapture });
  await h.select();
  const starting = h.start();
  await entered;
  assert.equal(h.engine.getState().status, 'starting');
  await h.engine.handle({ type: 'VIDEO_VIEWPORT_CHANGED', tabId: tab.id, selectionToken: 'old-token' });
  assert.equal(h.engine.startingVideoError, null);
  const changed = await h.engine.handle({ type: 'VIDEO_VIEWPORT_CHANGED', tabId: tab.id, selectionToken: 'fresh-token' });
  assert.equal(changed.ok, true, 'resize notification must return while START is waiting');
  assert.equal(changed.state.status, 'starting');
  assert.equal(h.recorders.length, 0);
  releaseCapture();
  const result = await starting;
  assert.equal(result.ok, false);
  assert.equal(result.state.status, 'error');
  assert.match(result.error, /페이지의 화면 크기/);
  assert.equal(h.recorders.length, 0, 'resized content never reaches a running recorder');
  assert.equal(h.crops.length, 0);
  assert.equal(h.audio.stopped, true);
  assert.equal(h.video.stopped, true);
});

test('viewport changes cancel a matching selection and ignore stale selection messages', async () => {
  const h = harness();
  await h.select();
  await h.engine.handle({ type: 'VIDEO_VIEWPORT_CHANGED', tabId: tab.id, selectionToken: 'old-token' });
  assert.equal(h.engine.getState().status, 'selecting');
  await h.engine.handle({ type: 'VIDEO_VIEWPORT_CHANGED', tabId: 42, selectionToken: 'fresh-token' });
  assert.equal(h.engine.getState().status, 'selecting');
  const cancelled = await h.engine.handle({ type: 'VIDEO_VIEWPORT_CHANGED', tabId: tab.id, selectionToken: 'fresh-token' });
  assert.equal(cancelled.state.status, 'idle');
  assert.equal(cancelled.state.selectionToken, null);
  assert.equal((await h.start()).ok, false);
  assert.equal(h.captures.length, 0);
});

test('crop uses normalized source coordinates, even output dimensions, and a 1080p bound', () => {
  const crop = videoCropDimensions(region, 3840, 2160);
  assert.deepEqual(crop, { x: 960, y: 540, cropWidth: 1920, cropHeight: 1080, width: 1920, height: 1080 });
  const full = videoCropDimensions({ ...region, x: 0, y: 0, width: 1, height: 1 }, 3840, 2160);
  assert.equal(full.width, 1920);
  assert.equal(full.height, 1080);
  const odd = videoCropDimensions({ ...region, width: 0.51, height: 0.51 }, 1280, 720);
  assert.equal(odd.width % 2, 0);
  assert.equal(odd.height % 2, 0);
  assert.doesNotThrow(() => videoCropDimensions(region, 800, 800), 'letterboxed frames are valid capture input');
  assert.throws(() => validateVideoRegion({ ...region, viewportWidth: NaN }));
});


test('capture constraints follow the CSS viewport aspect with even sizes bounded by 1080p', () => {
  assert.deepEqual(videoCaptureSize(region), { width: 1280, height: 720 });
  assert.deepEqual(videoCaptureSize({ ...region, viewportWidth: 3840, viewportHeight: 2160 }), { width: 1920, height: 1080 });
  assert.deepEqual(videoCaptureSize({ ...region, viewportWidth: 1000, viewportHeight: 1000 }), { width: 1000, height: 1000 });
  assert.deepEqual(videoCaptureSize({ ...region, viewportWidth: 900, viewportHeight: 1600 }), { width: 606, height: 1080 });
  assert.deepEqual(videoCaptureSize({ ...region, viewportWidth: 1281, viewportHeight: 721 }), { width: 1280, height: 720 });
  assert.throws(() => videoCaptureSize({ ...region, viewportHeight: NaN }));
});

test('crop coordinates exclude pillarboxes and letterboxes around a captured viewport', () => {
  const square = { ...region, viewportWidth: 1000, viewportHeight: 1000 };
  assert.deepEqual(videoCropDimensions(square, 1280, 720), {
    x: 460, y: 180, cropWidth: 360, cropHeight: 360, width: 360, height: 360,
  });
  const wide = { ...region, viewportWidth: 1920, viewportHeight: 900 };
  assert.deepEqual(videoCropDimensions(wide, 1280, 720), {
    x: 320, y: 210, cropWidth: 640, cropHeight: 300, width: 640, height: 300,
  });
  const full = { ...square, x: 0, y: 0, width: 1, height: 1 };
  assert.deepEqual(videoCropDimensions(full, 1280, 720), {
    x: 280, y: 0, cropWidth: 720, cropHeight: 720, width: 720, height: 720,
  });
  const bounded = videoCropDimensions(full, 3840, 2160);
  assert.deepEqual(bounded, { x: 840, y: 0, cropWidth: 2160, cropHeight: 2160, width: 1080, height: 1080 });
});

test('content bounds follow Chromium even-pixel letterboxing and tolerate odd video frame sizes', () => {
  const full = { ...region, x: 0, y: 0, width: 1, height: 1, viewportWidth: 640, viewportHeight: 480 };
  const pillarbox = videoCropDimensions(full, 1000, 500);
  assert.deepEqual([pillarbox.x, pillarbox.y, pillarbox.cropWidth, pillarbox.cropHeight], [166, 0, 666, 500]);
  const letterbox = videoCropDimensions(full, 500, 1000);
  assert.deepEqual([letterbox.x, letterbox.y, letterbox.cropWidth, letterbox.cropHeight], [0, 312, 500, 374]);
  const wide = videoCropDimensions({ ...full, viewportWidth: 1920, viewportHeight: 1080 }, 1000, 500);
  assert.deepEqual([wide.x, wide.y, wide.cropWidth, wide.cropHeight], [54, 0, 890, 500]);
  const odd = videoCropDimensions(full, 1001, 501);
  assert.deepEqual([odd.x, odd.y, odd.cropWidth, odd.cropHeight], [166, 0, 668, 501]);
  assert.equal(odd.width % 2, 0);
  assert.equal(odd.height % 2, 0);
  assert.ok(odd.x + odd.cropWidth <= 1001);
  assert.ok(odd.y + odd.cropHeight <= 501);
});

function cropHarness(options = {}) {
  const draws = [];
  const frames = new Map();
  const intervals = new Set();
  let time = 0;
  let nextFrame = 0;
  const outputTrack = { stopped: false, stop() { this.stopped = true; } };
  class Video extends EventTarget {
    readyState = options.pending ? 0 : 2;
    videoWidth = 1280;
    videoHeight = 720;
    play() { return options.pending ? new Promise(() => {}) : Promise.resolve(); }
    pause() { this.paused = true; }
    requestVideoFrameCallback(callback) { frames.set(++nextFrame, callback); return nextFrame; }
    cancelVideoFrameCallback(id) { frames.delete(id); }
  }
  const video = new Video();
  const canvas = {
    getContext: () => ({ drawImage: (...args) => draws.push(args) }),
    captureStream: (fps) => { assert.equal(fps, 30); return { getTracks: () => [outputTrack], getVideoTracks: () => [outputTrack] }; },
  };
  return { video, canvas, outputTrack, draws, frames, intervals,
    options: { document: { createElement: (tag) => tag === 'video' ? video : canvas },
      now: () => time,
      setInterval: (callback) => { intervals.add(callback); return callback; },
      clearInterval: (callback) => intervals.delete(callback),
    },
    tick: (elapsed = 34) => { time += elapsed; for (const callback of intervals) callback(); },
    frame: (elapsed = 34) => {
      time += elapsed;
      const callbacks = [...frames.values()]; frames.clear();
      for (const callback of callbacks) callback();
    },
  };
}

test('live cropper remaps changed encoder resolution and keeps the output dimensions fixed', async () => {
  const h = cropHarness();
  const crop = await createVideoCropper({}, region, h.options);
  assert.deepEqual(h.draws[0].slice(1), [320, 180, 640, 360, 0, 0, 640, 360]);
  assert.equal(crop.width, 640);
  assert.equal(crop.height, 360);
  h.frame();
  assert.equal(h.draws.length, 2);
  h.video.videoWidth = 1920;
  h.video.videoHeight = 1080;
  h.frame();
  assert.deepEqual(h.draws.at(-1).slice(1), [480, 270, 960, 540, 0, 0, 640, 360]);
  h.video.videoHeight = 1200;
  h.frame();
  assert.deepEqual(h.draws.at(-1).slice(1), [480, 330, 960, 540, 0, 0, 640, 360]);
  assert.equal(h.frames.size, 1, 'encoder resolution changes do not cancel frame callbacks');
  assert.equal(h.canvas.width, 640);
  assert.equal(h.canvas.height, 360);
  crop.dispose();
  assert.equal(h.outputTrack.stopped, true);
  assert.equal(h.video.srcObject, null);
  assert.equal(h.video.paused, true);
  assert.equal(h.canvas.width, 0);
  crop.dispose();
});

test('live cropper disposal cancels its next frame and cleans up a stalled video', async () => {
  const h = cropHarness();
  const crop = await createVideoCropper({}, region, h.options);
  assert.equal(h.frames.size, 1);
  crop.dispose();
  assert.equal(h.frames.size, 0);
  assert.equal(h.intervals.size, 0);
  const pending = cropHarness({ pending: true });
  await assert.rejects(createVideoCropper({}, region, { ...pending.options,
    setTimeout: (callback) => { queueMicrotask(callback); return 1; }, clearTimeout() {},
  }), /초과/);
  assert.equal(pending.video.srcObject, null);
  assert.equal(pending.video.paused, true);
});


test('timer fallback records frames without compositor callbacks and avoids duplicate draws', async () => {
  const h = cropHarness();
  const crop = await createVideoCropper({}, region, h.options);
  assert.equal(h.draws.length, 1);
  assert.equal(h.intervals.size, 1, 'fallback runs even when frame callbacks are supported');
  h.tick();
  h.tick();
  assert.equal(h.draws.length, 3, 'timer keeps frames moving when no compositor callback arrives');
  h.frame(0);
  assert.equal(h.draws.length, 3, 'the callback does not redraw a just-rendered timer frame');
  h.frame();
  h.tick(0);
  assert.equal(h.draws.length, 4, 'timer does not redraw a just-rendered callback frame');
  h.video.videoHeight = 0;
  h.tick();
  assert.equal(h.draws.length, 4, 'temporarily unavailable frame dimensions are skipped');
  h.video.videoHeight = 720;
  h.video.readyState = 0;
  h.frame();
  assert.equal(h.draws.length, 4, 'frames that are not ready are skipped');
  h.video.readyState = 2;
  h.tick();
  assert.equal(h.draws.length, 5, 'drawing resumes once a valid frame returns');
  crop.dispose();
  assert.equal(h.intervals.size, 0);
  assert.equal(h.frames.size, 0);
});

async function recordedVideo(options = {}) {
  const h = harness(options);
  assert.equal((await h.select()).ok, true);
  assert.equal((await h.start()).ok, true);
  h.advance(1500);
  assert.equal((await h.engine.handle({ type: 'STOP' })).ok, true);
  return h;
}

test('GIF progress leaves STATUS responsive and rejects changes until export finishes', async () => {
  let finishExport;
  let enteredExport;
  const gate = new Promise((resolve) => { finishExport = resolve; });
  const entered = new Promise((resolve) => { enteredExport = resolve; });
  const h = await recordedVideo({ exportGif: async (_blob, { onProgress }) => {
    onProgress(0.25);
    enteredExport();
    await gate;
    onProgress(1);
    return { blob: new Blob(['GIF89a'], { type: 'image/gif' }), width: 320, height: 180, frameCount: 15, durationSeconds: 1.5 };
  } });
  const original = h.engine.getState().result;
  const pending = h.engine.handle({ type: 'PREPARE_GIF' });
  await entered;
  const status = await h.engine.handle({ type: 'STATUS' });
  assert.equal(status.ok, true);
  assert.equal(status.state.status, 'exporting');
  assert.equal(status.state.exportProgress, 0.25);
  assert.deepEqual(status.state.result, original);
  for (const type of ['PREPARE_GIF', 'DISCARD', 'START', 'SET_SELECTION', 'DOWNLOAD_UPDATE']) {
    assert.equal((await h.engine.handle({ type })).ok, false, `${type} cannot mutate an exporting recording`);
  }
  finishExport();
  const result = await pending;
  assert.equal(result.ok, true);
  assert.equal(result.state.status, 'ready');
  assert.equal(result.state.exportProgress, 1);
  assert.equal(result.state.gifResult.mimeType, 'image/gif');
  assert.deepEqual(result.state.result, original);
});

test('GIF export is cached across cancelled saves and state snapshots cannot alter it', async () => {
  const h = await recordedVideo();
  const converted = await h.engine.handle({ type: 'PREPARE_GIF' });
  assert.equal(converted.ok, true);
  assert.equal(converted.state.gifResult.width, 320);
  assert.equal(converted.state.gifResult.height, 180);
  assert.equal(converted.state.gifResult.frameCount, 15);
  assert.match(converted.state.gifResult.filename, /\.gif$/);
  assert.equal(h.exports[0], h.urls[0], 'GIF conversion reads the retained MP4 blob');
  const gifUrl = converted.state.gifResult.url;
  converted.state.gifResult.url = 'mutated-url';
  assert.equal(h.engine.getState().gifResult.url, gifUrl);
  await h.engine.handle({ type: 'DOWNLOAD_UPDATE', download: { id: 17, status: 'pending' } });
  await h.engine.handle({ type: 'DOWNLOAD_UPDATE', download: { id: 17, status: 'interrupted', error: 'USER_CANCELED' } });
  const retry = await h.engine.handle({ type: 'PREPARE_GIF' });
  assert.equal(retry.ok, true);
  assert.equal(retry.state.gifResult.url, gifUrl);
  assert.equal(h.exports.length, 1, 'cancelled saves reuse the same GIF');
  assert.equal(h.urls.length, 2);
});

test('GIF failures preserve the MP4 original and allow another export attempt', async () => {
  for (const failure of ['throw', 'empty', 'wrong-type']) {
    let attempts = 0;
    const h = await recordedVideo({ exportGif: async () => {
      attempts++;
      if (attempts === 1) {
        if (failure === 'throw') throw new Error('conversion failed');
        return { blob: new Blob(failure === 'empty' ? [] : ['not-a-gif'], { type: failure === 'empty' ? 'image/gif' : 'video/mp4' }) };
      }
      return { blob: new Blob(['GIF89a'], { type: 'image/gif' }), width: 320, height: 180, frameCount: 15, durationSeconds: 1.5 };
    } });
    const original = h.engine.getState().result;
    const result = await h.engine.handle({ type: 'PREPARE_GIF' });
    assert.equal(result.ok, false);
    assert.equal(result.state.status, 'ready');
    assert.deepEqual(result.state.result, original);
    assert.equal(result.state.gifResult, null);
    assert.equal(h.revoked.length, 0);
    assert.equal((await h.engine.handle({ type: 'PREPARE_GIF' })).ok, true);
    assert.equal(h.exports.length, 2);
  }
});

test('pending downloads block GIF creation and discard, then discard releases MP4 and GIF URLs', async () => {
  const h = await recordedVideo();
  await h.engine.handle({ type: 'DOWNLOAD_UPDATE', download: { id: 17, status: 'pending' } });
  assert.equal((await h.engine.handle({ type: 'PREPARE_GIF' })).ok, false);
  assert.equal(h.exports.length, 0);
  assert.equal((await h.engine.handle({ type: 'DISCARD' })).ok, false);
  await h.engine.handle({ type: 'DOWNLOAD_UPDATE', download: { id: 17, status: 'complete' } });
  assert.equal((await h.engine.handle({ type: 'PREPARE_GIF' })).ok, true);
  await h.engine.handle({ type: 'DOWNLOAD_UPDATE', download: { id: 18, status: 'pending' } });
  assert.equal((await h.engine.handle({ type: 'PREPARE_GIF' })).ok, false, 'even cached output waits for an existing save');
  assert.equal((await h.engine.handle({ type: 'DISCARD' })).ok, false);
  assert.equal(h.revoked.length, 0);
  await h.engine.handle({ type: 'DOWNLOAD_UPDATE', download: { id: 18, status: 'interrupted' } });
  const discarded = await h.engine.handle({ type: 'DISCARD' });
  assert.equal(discarded.ok, true);
  assert.equal(discarded.state.status, 'idle');
  assert.equal(discarded.state.result, null);
  assert.equal(discarded.state.gifResult, null);
  assert.equal(discarded.state.exportProgress, 0);
  assert.deepEqual(h.revoked, ['blob:test-1', 'blob:test-2']);
});

test('audio recordings cannot be converted to GIF', async () => {
  const h = harness({ types: ['audio/mp4;codecs=mp4a.40.2'] });
  assert.equal((await h.engine.handle({ type: 'START', tab, streamId: 'audio-stream' })).ok, true);
  h.advance(1500);
  const stopped = await h.engine.handle({ type: 'STOP' });
  assert.equal(stopped.state.result.kind, 'audio');
  const result = await h.engine.handle({ type: 'PREPARE_GIF' });
  assert.equal(result.ok, false);
  assert.equal(result.state.status, 'ready');
  assert.equal(h.exports.length, 0);
  assert.deepEqual(result.state.result, stopped.state.result);
});
