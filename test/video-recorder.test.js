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
  const exportSettings = [];
  const inspections = [];
  const trims = [];
  const audioTrims = [];
  const trackSelections = [];
  const states = [];
  const metadata = new WeakMap();
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
    inspectMp4: (blob) => {
      if (options.inspectMp4) return options.inspectMp4(blob);
      throw new Error('video must not use the audio-only parser');
    },
    trimMp4: (blob, start, end) => {
      audioTrims.push({ blob, startSeconds: start, endSeconds: end });
      if (options.trimMp4) return options.trimMp4(blob, start, end);
      assert.match(blob.type, /^audio\/mp4/, 'audio trimming must only receive the separated audio track');
      return { blob: new Blob(['trimmed-audio'], { type: blob.type }),
        durationSeconds: end - start, startSeconds: start, endSeconds: end };
    },
    inspectVideo: async (blob) => {
      inspections.push(blob);
      const output = options.inspectVideo ? await options.inspectVideo(blob)
        : { durationSeconds: elapsed / 1000, width: 640, height: 360 };
      metadata.set(blob, output);
      return output;
    },
    trimVideo: async (blob, startSeconds, endSeconds, settings) => {
      trims.push({ blob, startSeconds, endSeconds, settings });
      const actualEnd = endSeconds ?? metadata.get(blob)?.durationSeconds ?? elapsed / 1000;
      const output = options.trimVideo ? await options.trimVideo(blob, startSeconds, endSeconds, settings)
        : { blob: new Blob(['trimmed-video'], { type: 'video/mp4;codecs=vp9,opus' }),
        startSeconds, endSeconds: actualEnd, durationSeconds: actualEnd - startSeconds, width: 640, height: 360 };
      if (!options.trimVideo) settings.onProgress(1);
      if (output.blob) metadata.set(output.blob, output);
      return output;
    },
    selectMp4Tracks: async (blob, content, settings) => {
      trackSelections.push({ blob, content, settings });
      if (options.selectMp4Tracks) return options.selectMp4Tracks(blob, content, settings);
      settings.onProgress(1);
      return { blob: new Blob([`selected-${content}`], { type: `${content}/mp4` }),
        mimeType: `${content}/mp4`, kind: content, content,
        durationSeconds: metadata.get(blob)?.durationSeconds ?? elapsed / 1000,
        ...(content === 'video' ? { width: 640, height: 360 } : {}),
      };
    },
    exportGif: async (blob, settings) => {
      exports.push(blob);
      exportSettings.push(settings);
      if (options.exportGif) return options.exportGif(blob, settings);
      settings.onProgress(1);
      return { blob: new Blob(['GIF89a-frames'], { type: 'image/gif' }),
        width: 320, height: 180, frameCount: 15, durationSeconds: 1.5 };
    },
    now: () => elapsed,
    onStateChange: (state) => states.push(state),
    setInterval: () => 1, clearInterval() {},
    url: { createObjectURL: (blob) => { urls.push(blob); return `blob:test-${urls.length}`; }, revokeObjectURL: (url) => revoked.push(url) },
  });
  return { engine, audio, video, cropped, captures, crops, recorders, urls, revoked, exports, exportSettings, inspections, trims,
    audioTrims, trackSelections, states,
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
  assert.deepEqual(stopped.state.selection, { startSeconds: 0, endSeconds: 2.35 });
  assert.equal(h.audio.stopped, true);
  assert.equal(h.video.stopped, true);
  assert.equal(h.cropped.stopped, true);
  assert.equal(h.crops[0].disposed, true);
  assert.equal((await h.engine.handle({ type: 'PREPARE_EXPORT', startSeconds: 0, endSeconds: 1 })).ok, true);
  assert.equal(stopped.state.result.url, h.engine.getState().result.url, 'video trim preserves the full source');
  await h.engine.handle({ type: 'DISCARD' });
  assert.deepEqual(h.revoked, ['blob:test-1', 'blob:test-2']);
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

test('video selection uses decoded duration and dimensions instead of the recording stopwatch', async () => {
  const h = await recordedVideo({ inspectVideo: async () => ({ durationSeconds: 1.417, width: 638, height: 358 }) });
  const state = h.engine.getState();
  assert.equal(state.elapsedMs, 1500);
  assert.equal(state.result.durationSeconds, 1.417);
  assert.equal(state.result.width, 638);
  assert.equal(state.result.height, 358);
  assert.equal(state.result.trimError, null);
  assert.deepEqual(state.selection, { startSeconds: 0, endSeconds: 1.417 });
  assert.equal(h.inspections[0], h.urls[0]);
});

test('unreadable video metadata preserves the original for full saving without an invented trim range', async () => {
  for (const inspectVideo of [
    async () => { throw new Error('metadata failed'); },
    async () => ({ durationSeconds: Infinity, width: 640, height: 360 }),
    async () => ({ durationSeconds: 1.5, width: 0, height: 360 }),
  ]) {
    const h = await recordedVideo({ inspectVideo });
    const state = h.engine.getState();
    assert.equal(state.status, 'ready');
    assert.equal(state.result.durationSeconds, null);
    assert.ok(state.result.trimError);
    assert.equal(state.selection, null);
    assert.equal(await h.urls[0].text(), 'native-video');
    for (const type of ['SET_SELECTION', 'PREPARE_EXPORT', 'PREPARE_GIF']) {
      const rejected = await h.engine.handle({ type, startSeconds: 0, endSeconds: 1 });
      assert.equal(rejected.ok, false);
      assert.deepEqual(rejected.state.result, state.result);
    }
    assert.equal(h.trims.length, 0);
    assert.equal(h.exports.length, 0);
    assert.equal((await h.engine.handle({ type: 'PREPARE_GIF' })).ok, true,
      'whole-file GIF decoding may still succeed independently');
  }
});

test('video MP4 and GIF selection reject malformed, reversed, and out-of-bounds intervals', async () => {
  const h = await recordedVideo();
  const original = h.engine.getState();
  for (const range of [
    { startSeconds: '0', endSeconds: 1 }, { startSeconds: 0 }, { endSeconds: 1 },
    { startSeconds: NaN, endSeconds: 1 }, { startSeconds: 0, endSeconds: Infinity },
    { startSeconds: -0.1, endSeconds: 1 }, { startSeconds: 1, endSeconds: 1 },
    { startSeconds: 1, endSeconds: 0 }, { startSeconds: 0, endSeconds: 1.501 },
  ]) {
    for (const type of ['SET_SELECTION', 'PREPARE_EXPORT', 'PREPARE_GIF']) {
      const rejected = await h.engine.handle({ type, ...range });
      assert.equal(rejected.ok, false, `${type} must reject ${JSON.stringify(range)}`);
      assert.deepEqual(rejected.state.selection, original.selection);
      assert.deepEqual(rejected.state.result, original.result);
    }
  }
  assert.equal(h.trims.length, 0);
  assert.equal(h.exports.length, 0);
});

test('video MP4 clips preserve the source, cache exact requested ranges, and replace only the prior clip', async () => {
  const h = await recordedVideo();
  const original = h.engine.getState().result;
  const selection = { startSeconds: 0.25, endSeconds: 1.25 };
  const first = await h.engine.handle({ type: 'PREPARE_EXPORT', ...selection });
  assert.equal(first.ok, true);
  assert.deepEqual(first.state.result, original);
  assert.deepEqual(first.state.selection, selection);
  assert.equal(first.state.exportResult.kind, 'video');
  assert.equal(first.state.exportResult.mimeType, 'video/mp4;codecs=vp9,opus');
  assert.equal(first.state.exportResult.width, 640);
  assert.equal(first.state.exportResult.height, 360);
  assert.equal(first.state.exportResult.durationSeconds, 1);
  assert.equal(first.state.exportProgress, 1);
  assert.equal(h.trims[0].blob, h.urls[0], 'video trimming always starts with the retained original');
  assert.equal(h.trims[0].settings.signal.aborted, false);
  const cached = await h.engine.handle({ type: 'PREPARE_EXPORT', ...selection });
  assert.deepEqual(cached.state.exportResult, first.state.exportResult);
  assert.equal(h.trims.length, 1);
  first.state.exportResult.width = 1;
  assert.equal(h.engine.getState().exportResult.width, 640);
  const changed = await h.engine.handle({ type: 'PREPARE_EXPORT', startSeconds: 0.5, endSeconds: 1.5 });
  assert.equal(changed.ok, true);
  assert.equal(h.trims.length, 2);
  assert.deepEqual(h.revoked, [cached.state.exportResult.url]);
  assert.deepEqual(changed.state.result, original);
});

test('whole GIF, range GIF, video clip and original stay independent and all URLs are released once', async () => {
  const h = await recordedVideo();
  const original = h.engine.getState().result;
  const selection = { startSeconds: 0.2, endSeconds: 1.2 };
  const mp4 = await h.engine.handle({ type: 'PREPARE_EXPORT', ...selection });
  const full = await h.engine.handle({ type: 'PREPARE_GIF' });
  const range = await h.engine.handle({ type: 'PREPARE_GIF', ...selection });
  assert.equal(range.ok, true);
  assert.deepEqual(range.state.result, original);
  assert.deepEqual(range.state.exportResult, mp4.state.exportResult);
  assert.deepEqual(range.state.gifResult, full.state.gifResult);
  assert.equal(range.state.rangeGifResult.mimeType, 'image/gif');
  assert.equal(range.state.rangeGifResult.startSeconds, 0.2);
  assert.equal(range.state.rangeGifResult.endSeconds, 1.2);
  assert.notEqual(range.state.rangeGifResult.filename, full.state.gifResult.filename);
  assert.deepEqual(h.exports, [h.urls[0], h.urls[0]], 'GIF ranges decode the original, never a previously encoded clip');
  assert.equal(h.exportSettings[0].startSeconds, undefined);
  assert.equal(h.exportSettings[1].startSeconds, 0.2);
  assert.equal(h.exportSettings[1].endSeconds, 1.2);
  assert.equal(h.exportSettings[1].signal.aborted, false);
  const rangeUrl = range.state.rangeGifResult.url;
  range.state.rangeGifResult.url = 'tampered';
  assert.equal(h.engine.getState().rangeGifResult.url, rangeUrl);
  assert.equal((await h.engine.handle({ type: 'PREPARE_GIF', ...selection })).state.rangeGifResult.url, rangeUrl);
  assert.equal((await h.engine.handle({ type: 'PREPARE_GIF' })).state.gifResult.url, full.state.gifResult.url);
  assert.equal(h.exports.length, 2);
  const replaced = await h.engine.handle({ type: 'PREPARE_GIF', startSeconds: 0.4, endSeconds: 1.4 });
  assert.equal(replaced.ok, true);
  assert.deepEqual(h.revoked, [rangeUrl]);
  assert.deepEqual(replaced.state.gifResult, full.state.gifResult);
  const discarded = await h.engine.handle({ type: 'DISCARD' });
  assert.equal(discarded.state.rangeGifResult, null);
  assert.equal(discarded.state.exportResult, null);
  assert.equal(discarded.state.gifResult, null);
  assert.equal(discarded.state.result, null);
  assert.equal(h.revoked.length, 5);
  assert.equal(new Set(h.revoked).size, 5);
  await h.select();
  await h.start();
  h.advance(1000);
  await h.engine.handle({ type: 'STOP' });
  await h.engine.handle({ type: 'PREPARE_GIF', ...selection });
  assert.equal(h.exports.length, 4, 'a new recording cannot reuse the earlier range cache');
  assert.notEqual(h.exports.at(-1), h.exports[0]);
});

test('video clip failures keep the prior usable clip and full original for retry', async () => {
  for (const invalid of ['throw', 'wrong-container', 'empty', 'dimensions']) {
    let attempts = 0;
    const h = await recordedVideo({ trimVideo: async (_blob, startSeconds, endSeconds) => {
      attempts++;
      if (attempts === 2 && invalid === 'throw') throw new Error('encoder failed');
      return {
        blob: new Blob(attempts === 2 && invalid === 'empty' ? [] : ['clip'], {
          type: attempts === 2 && invalid === 'wrong-container' ? 'video/webm' : 'video/mp4',
        }),
        durationSeconds: endSeconds - startSeconds, startSeconds, endSeconds,
        width: attempts === 2 && invalid === 'dimensions' ? 0 : 640, height: 360,
      };
    } });
    const first = await h.engine.handle({ type: 'PREPARE_EXPORT', startSeconds: 0, endSeconds: 1 });
    const failed = await h.engine.handle({ type: 'PREPARE_EXPORT', startSeconds: 0.3, endSeconds: 1.3 });
    assert.equal(failed.ok, false, invalid);
    assert.equal(failed.state.status, 'ready');
    assert.equal(failed.state.exportProgress, 0);
    assert.deepEqual(failed.state.result, first.state.result);
    assert.deepEqual(failed.state.exportResult, first.state.exportResult);
    assert.equal(h.revoked.length, 0);
    assert.equal(h.urls.length, 2);
    assert.equal((await h.engine.handle({ type: 'PREPARE_EXPORT', startSeconds: 0.3, endSeconds: 1.3 })).ok, true);
    assert.deepEqual(h.revoked, [first.state.exportResult.url]);
  }
});

test('cancelling MP4 or GIF aborts immediately but waits for cleanup before allowing more work', async () => {
  for (const type of ['PREPARE_EXPORT', 'PREPARE_GIF']) {
    for (const lateResult of ['reject', 'resolve']) {
      let enter;
      let finish;
      let activeSettings;
      const entered = new Promise((resolve) => { enter = resolve; });
      const cleanup = new Promise((resolve) => { finish = resolve; });
      const createOutput = () => type === 'PREPARE_EXPORT'
        ? { blob: new Blob(['clip'], { type: 'video/mp4' }), width: 640, height: 360,
          durationSeconds: 1, startSeconds: 0, endSeconds: 1 }
        : { blob: new Blob(['GIF89a'], { type: 'image/gif' }), width: 320, height: 180,
          durationSeconds: 1, frameCount: 10 };
      let attempt = 0;
      const encode = async (settings) => {
        if (++attempt > 1) return createOutput();
        activeSettings = settings;
        settings.onProgress(0.4);
        enter();
        await cleanup;
        if (lateResult === 'reject') throw Object.assign(new Error('aborted'), { name: 'AbortError' });
        return createOutput();
      };
      const h = await recordedVideo({
        trimVideo: (_blob, _start, _end, settings) => encode(settings),
        exportGif: (_blob, settings) => encode(settings),
      });
      const original = h.engine.getState().result;
      const pending = h.engine.handle({ type, startSeconds: 0, endSeconds: 1 });
      await entered;
      const cancel = await h.engine.handle({ type: 'CANCEL_EXPORT' });
      assert.equal(cancel.ok, true);
      assert.equal(activeSettings.signal.aborted, true);
      assert.equal(cancel.state.status, type === 'PREPARE_EXPORT' ? 'trimming' : 'exporting');
      activeSettings.onProgress(0.9);
      assert.equal(h.engine.getState().exportProgress, 0.4, 'progress after cancellation is ignored');
      assert.equal((await h.engine.handle({ type: 'DISCARD' })).ok, false, 'cleanup still owns the recording');
      assert.equal((await h.engine.handle({ type, startSeconds: 0, endSeconds: 1 })).ok, false);
      finish();
      const cancelled = await pending;
      assert.equal(cancelled.ok, false);
      assert.equal(cancelled.cancelled, true);
      assert.equal(cancelled.state.status, 'ready');
      assert.equal(cancelled.state.exportProgress, 0);
      assert.equal(cancelled.state.error, null);
      assert.match(cancelled.state.notice, /취소/);
      assert.deepEqual(cancelled.state.result, original);
      assert.equal(cancelled.state.exportResult, null);
      assert.equal(cancelled.state.rangeGifResult, null);
      assert.equal(h.urls.length, 1, 'a late export result must never create a URL after cancellation');
      assert.equal(h.revoked.length, 0);
      assert.equal((await h.engine.handle({ type, startSeconds: 0, endSeconds: 1 })).ok, true);
      assert.equal(h.urls.length, 2);
    }
  }
});

test('whole video exports extract only the chosen track, reuse exact content, and leave both-track original untouched', async () => {
  const h = await recordedVideo();
  const original = h.engine.getState().result;
  const both = await h.engine.handle({ type: 'PREPARE_VIDEO_EXPORT', content: 'both' });
  assert.equal(both.ok, true);
  assert.deepEqual(both.state.result, original);
  assert.equal(both.state.videoExportResult, null);
  assert.equal(h.trackSelections.length, 0);
  assert.equal(h.trims.length, 0);

  const video = await h.engine.handle({ type: 'PREPARE_VIDEO_EXPORT', content: 'video' });
  assert.equal(video.ok, true);
  assert.equal(video.state.videoExportResult.kind, 'video');
  assert.equal(video.state.videoExportResult.content, 'video');
  assert.equal(video.state.videoExportResult.mimeType, 'video/mp4');
  assert.equal(video.state.videoExportResult.width, 640);
  assert.equal(video.state.videoExportResult.durationSeconds, 1.5);
  assert.match(video.state.videoExportResult.filename, /-video-only\.mp4$/);
  assert.equal(h.trackSelections[0].blob, h.urls[0]);
  assert.equal(h.trackSelections[0].settings.signal.aborted, false);
  const reused = await h.engine.handle({ type: 'PREPARE_VIDEO_EXPORT', content: 'video' });
  assert.deepEqual(reused.state.videoExportResult, video.state.videoExportResult);
  assert.equal(h.trackSelections.length, 1);
  video.state.videoExportResult.url = 'tampered';
  assert.equal(h.engine.getState().videoExportResult.url, reused.state.videoExportResult.url);

  const audio = await h.engine.handle({ type: 'PREPARE_VIDEO_EXPORT', content: 'audio' });
  assert.equal(audio.ok, true);
  assert.equal(audio.state.videoExportResult.kind, 'audio');
  assert.equal(audio.state.videoExportResult.content, 'audio');
  assert.equal(audio.state.videoExportResult.mimeType, 'audio/mp4');
  assert.equal(audio.state.videoExportResult.width, undefined);
  assert.equal(audio.state.videoExportResult.height, undefined);
  assert.match(audio.state.videoExportResult.filename, /-audio-only\.mp4$/);
  assert.notEqual(audio.state.videoExportResult.filename, reused.state.videoExportResult.filename);
  assert.deepEqual(audio.state.result, original);
  assert.deepEqual(h.revoked, [reused.state.videoExportResult.url]);
  assert.equal(h.trims.length, 0, 'whole-track extraction does not trim or re-encode first');
  assert.equal(h.urls.length, 3);
});

test('range exports use the selected timeline and copy original audio without video encoding', async () => {
  const h = await recordedVideo();
  const selection = { startSeconds: 0.25, endSeconds: 1.25 };
  const files = [];
  for (const content of ['both', 'video', 'audio']) {
    const result = await h.engine.handle({ type: 'PREPARE_EXPORT', ...selection, content });
    assert.equal(result.ok, true);
    const output = result.state.exportResult;
    assert.equal(output.content, content);
    assert.equal(output.kind, content === 'audio' ? 'audio' : 'video');
    assert.equal(output.startSeconds, selection.startSeconds);
    assert.equal(output.endSeconds, selection.endSeconds);
    assert.equal(output.durationSeconds, 1);
    assert.equal(output.width, content === 'audio' ? undefined : 640);
    assert.match(output.filename, /-clip-0\.25-1\.25s/);
    files.push(output.filename);
    const cached = await h.engine.handle({ type: 'PREPARE_EXPORT', ...selection, content });
    assert.deepEqual(cached.state.exportResult, output);
  }
  assert.equal(new Set(files).size, 3);
  assert.equal(h.trims.length, 2, 'audio-only clips never decode or re-encode the video');
  assert.equal(h.audioTrims.length, 1);
  assert.equal(h.trackSelections.length, 2, 'both tracks need no extraction');
  for (const trim of h.trims) {
    assert.equal(trim.blob, h.urls[0]);
    assert.equal(trim.startSeconds, selection.startSeconds);
    assert.equal(trim.endSeconds, selection.endSeconds);
  }
  assert.notEqual(h.trackSelections[0].blob, h.urls[0]);
  assert.equal(await h.trackSelections[0].blob.text(), 'trimmed-video');
  assert.equal(h.trackSelections[1].blob, h.urls[0], 'audio packets come directly from the original recording');
  assert.equal(await h.audioTrims[0].blob.text(), 'selected-audio');
  assert.equal(h.audioTrims[0].startSeconds, selection.startSeconds);
  assert.equal(h.audioTrims[0].endSeconds, selection.endSeconds);
  assert.equal(h.trackSelections[0].settings.signal, h.trims[1].settings.signal);
  assert.equal(h.engine.getState().result.kind, 'video');
});

test('range progress stays monotonic through trimming and track extraction with one cancellation signal', async () => {
  let trimSignal;
  const h = await recordedVideo({
    trimVideo: async (_blob, startSeconds, endSeconds, { signal, onProgress }) => {
      trimSignal = signal;
      for (const value of [0, 0.5, 0.25, 1]) onProgress(value);
      return { blob: new Blob(['clip'], { type: 'video/mp4' }), width: 640, height: 360,
        startSeconds, endSeconds, durationSeconds: endSeconds - startSeconds };
    },
    selectMp4Tracks: async (_blob, content, { signal, onProgress }) => {
      assert.equal(signal, trimSignal);
      assert.equal(h.engine.getState().exportProgress, 0.85, 'trim completion reserves progress for extraction');
      for (const value of [0, 0.5, 0.1, 1]) onProgress(value);
      return { blob: new Blob(['video'], { type: 'video/mp4' }), kind: 'video', content,
        mimeType: 'video/mp4', durationSeconds: 1, width: 640, height: 360 };
    },
  });
  const firstState = h.states.length;
  const result = await h.engine.handle({ type: 'PREPARE_EXPORT', content: 'video', startSeconds: 0, endSeconds: 1 });
  assert.equal(result.ok, true);
  const progress = h.states.slice(firstState).map((state) => state.exportProgress);
  assert.equal(progress[0], 0);
  assert.equal(progress.at(-1), 1);
  assert.ok(progress.some((value) => value > 0.85 && value < 1));
  assert.deepEqual([...progress].sort((a, b) => a - b), progress);
});

test('audio-only ranges clamp to the audio endpoint and keep actual packet bounds separate from the UI selection', async () => {
  const audio = new Blob(['original-aac-packets'], { type: 'audio/mp4;codecs=mp4a.40.2' });
  const h = await recordedVideo({
    trimVideo: () => { throw new Error('audio-only saving must not re-encode video or audio'); },
    selectMp4Tracks: async (blob, content, { signal, onProgress }) => {
      assert.equal(blob, h.urls[0]);
      assert.equal(content, 'audio');
      assert.equal(signal.aborted, false);
      for (const value of [0, 0.5, 0.25, 1]) onProgress(value);
      return { blob: audio, kind: 'audio', content, mimeType: audio.type, durationSeconds: 1.4 };
    },
    trimMp4: async (blob, startSeconds, endSeconds) => {
      assert.equal(blob, audio, 'trim only the copied original audio');
      assert.equal(startSeconds, 0.2);
      assert.equal(endSeconds, 1.4, 'video ending after the audio must not invalidate a full-end range');
      assert.equal(h.engine.getState().exportProgress, 0.85);
      return { blob: new Blob(['copied-packets'], { type: audio.type }),
        startSeconds: 0.192, endSeconds: 1.4, durationSeconds: 1.208 };
    },
  });
  const original = h.engine.getState().result;
  const selection = { startSeconds: 0.2, endSeconds: 1.5 };
  const firstState = h.states.length;
  const result = await h.engine.handle({ type: 'PREPARE_EXPORT', content: 'audio', quality: 'small', ...selection });
  assert.equal(result.ok, true);
  assert.deepEqual(result.state.selection, selection);
  assert.equal(result.state.exportResult.startSeconds, 0.192);
  assert.equal(result.state.exportResult.endSeconds, 1.4);
  assert.equal(result.state.exportResult.durationSeconds, 1.208);
  assert.equal(result.state.exportResult.mimeType, audio.type);
  assert.equal(result.state.exportResult.quality, 'original');
  assert.match(result.state.exportResult.filename, /-clip-0\.20-1\.50s-audio-only\.mp4$/);
  assert.deepEqual(result.state.result, original);
  assert.equal(h.trims.length, 0);
  assert.equal(h.recorders.length, 1, 'saving audio never starts another recorder');
  assert.equal(h.urls.length, 2, 'the separated intermediate audio needs no Blob URL');
  const progress = h.states.slice(firstState).map((state) => state.exportProgress);
  assert.deepEqual([...progress].sort((a, b) => a - b), progress);
  assert.equal(progress[0], 0);
  assert.equal(progress.at(-1), 1);
  const cached = await h.engine.handle({ type: 'PREPARE_EXPORT', content: 'audio', quality: 'balanced', ...selection });
  assert.deepEqual(cached.state.exportResult, result.state.exportResult);
  assert.equal(h.audioTrims.length, 1, 'cache keys use the requested bounds and ignore visual quality');
});

test('a range after the audio endpoint fails without replacing the prior playable export', async () => {
  const h = await recordedVideo({ selectMp4Tracks: async (_blob, content) => ({
    blob: new Blob(['audio'], { type: 'audio/mp4' }), kind: 'audio', content,
    mimeType: 'audio/mp4', durationSeconds: 1.4,
  }) });
  const first = await h.engine.handle({ type: 'PREPARE_EXPORT', content: 'audio', startSeconds: 0, endSeconds: 1 });
  assert.equal(first.ok, true);
  const failed = await h.engine.handle({ type: 'PREPARE_EXPORT', content: 'audio', startSeconds: 1.4, endSeconds: 1.5 });
  assert.equal(failed.ok, false);
  assert.match(failed.error, /선택한 구간에 저장할 소리가 없습니다/);
  assert.deepEqual(failed.state.exportResult, first.state.exportResult);
  assert.deepEqual(failed.state.result, first.state.result);
  assert.deepEqual(failed.state.selection, { startSeconds: 1.4, endSeconds: 1.5 });
  assert.equal(failed.state.status, 'ready');
  assert.equal(failed.state.exportProgress, 0);
  assert.equal(h.audioTrims.length, 1, 'a non-overlapping audio selection never reaches the trimmer');
  assert.equal(h.trims.length, 0);
  assert.equal(h.urls.length, 2);
  assert.equal(h.revoked.length, 0);
});

test('failed audio packet trimming leaves the original and previous export intact', async () => {
  for (const failure of ['throw', 'empty', 'wrong-type', 'zero-duration']) {
    let fail = false;
    const h = await recordedVideo({ trimMp4: async (_blob, startSeconds, endSeconds) => {
      if (fail && failure === 'throw') throw new Error('audio packet trim failed');
      return { blob: new Blob(fail && failure === 'empty' ? [] : ['audio'], {
        type: fail && failure === 'wrong-type' ? 'video/mp4' : 'audio/mp4',
      }), startSeconds, endSeconds, durationSeconds: fail && failure === 'zero-duration' ? 0 : endSeconds - startSeconds };
    } });
    const first = await h.engine.handle({ type: 'PREPARE_EXPORT', content: 'audio', startSeconds: 0, endSeconds: 1 });
    fail = true;
    const failed = await h.engine.handle({ type: 'PREPARE_EXPORT', content: 'audio', startSeconds: 0.25, endSeconds: 1.25 });
    assert.equal(failed.ok, false, failure);
    assert.equal(failed.state.status, 'ready');
    assert.equal(failed.state.exportProgress, 0);
    assert.deepEqual(failed.state.exportResult, first.state.exportResult);
    assert.deepEqual(failed.state.result, first.state.result);
    assert.equal(h.urls.length, 2);
    assert.equal(h.revoked.length, 0);
    assert.equal(h.trims.length, 0);
    fail = false;
    assert.equal((await h.engine.handle({ type: 'PREPARE_EXPORT', content: 'audio', startSeconds: 0.25, endSeconds: 1.25 })).ok, true);
    assert.equal(h.revoked.length, 1);
  }
});

test('cancelling audio packet trimming discards late results and preserves the prior export', async () => {
  for (const outcome of ['resolve', 'reject']) {
    let finish;
    let enter;
    let calls = 0;
    const entered = new Promise((resolve) => { enter = resolve; });
    const cleanup = new Promise((resolve) => { finish = resolve; });
    const h = await recordedVideo({ trimMp4: async (_blob, startSeconds, endSeconds) => {
      if (++calls === 2) {
        enter();
        await cleanup;
        if (outcome === 'reject') throw new Error('late audio trim failure');
      }
      return { blob: new Blob(['audio'], { type: 'audio/mp4' }), startSeconds, endSeconds,
        durationSeconds: endSeconds - startSeconds };
    } });
    const first = await h.engine.handle({ type: 'PREPARE_EXPORT', content: 'audio', startSeconds: 0, endSeconds: 1 });
    const pending = h.engine.handle({ type: 'PREPARE_EXPORT', content: 'audio', startSeconds: 0.25, endSeconds: 1.25 });
    await entered;
    const cancelled = await h.engine.handle({ type: 'CANCEL_EXPORT' });
    assert.equal(cancelled.state.status, 'trimming', 'keep the job busy until its temporary data is released');
    assert.equal(h.trackSelections.at(-1).settings.signal.aborted, true);
    finish();
    const result = await pending;
    assert.equal(result.cancelled, true);
    assert.equal(result.state.status, 'ready');
    assert.equal(result.state.exportProgress, 0);
    assert.deepEqual(result.state.result, first.state.result);
    assert.deepEqual(result.state.exportResult, first.state.exportResult);
    assert.equal(h.urls.length, 2);
    assert.equal(h.revoked.length, 0);
    assert.equal(h.trims.length, 0);
  }
});

test('invalid content is rejected without changing selection and GIF cannot accept audio-only output', async () => {
  const h = await recordedVideo();
  const original = h.engine.getState();
  for (const content of [null, '', 'sound', 1, {}, ['video']]) {
    for (const type of ['PREPARE_VIDEO_EXPORT', 'PREPARE_EXPORT', 'PREPARE_GIF']) {
      const reply = await h.engine.handle({ type, content, startSeconds: 0.2, endSeconds: 1.2 });
      assert.equal(reply.ok, false);
      assert.deepEqual(reply.state.result, original.result);
      assert.deepEqual(reply.state.selection, original.selection);
    }
  }
  assert.equal((await h.engine.handle({ type: 'PREPARE_GIF', content: 'audio' })).ok, false);
  assert.equal(h.trackSelections.length, 0);
  assert.equal(h.trims.length, 0);
  assert.equal(h.exports.length, 0);
  assert.equal((await h.engine.handle({ type: 'PREPARE_GIF', content: 'video' })).ok, true);
  assert.equal(h.exports[0], h.urls[0]);
  assert.equal(h.trackSelections.length, 0, 'GIF stays independent of MP4 track selection');
});

test('pending downloads block new and cached whole-track exports', async () => {
  const h = await recordedVideo();
  const cached = await h.engine.handle({ type: 'PREPARE_VIDEO_EXPORT', content: 'audio' });
  await h.engine.handle({ type: 'DOWNLOAD_UPDATE', download: { id: 42, status: 'pending' } });
  for (const content of ['both', 'video', 'audio']) {
    assert.equal((await h.engine.handle({ type: 'PREPARE_VIDEO_EXPORT', content })).ok, false);
  }
  assert.equal(h.trackSelections.length, 1);
  assert.deepEqual(h.engine.getState().videoExportResult, cached.state.videoExportResult);
  assert.equal(h.revoked.length, 0);
});

test('failed whole or ranged track extraction keeps prior exports and creates no intermediate URL', async () => {
  for (const type of ['PREPARE_VIDEO_EXPORT', 'PREPARE_EXPORT']) {
    for (const failure of ['throw', 'wrong-type', 'wrong-kind', 'wrong-content', 'empty']) {
      let fail = false;
      const h = await recordedVideo({ selectMp4Tracks: async (_blob, content) => {
        if (fail && failure === 'throw') throw new Error('track extraction failed');
        const mimeType = fail && failure === 'wrong-type' ? 'video/webm' : `${content}/mp4`;
        return { blob: new Blob(fail && failure === 'empty' ? [] : ['selected'], { type: mimeType }), mimeType,
          kind: fail && failure === 'wrong-kind' ? 'wrong' : content,
          content: fail && failure === 'wrong-content' ? 'both' : content, durationSeconds: 1,
          ...(content === 'video' ? { width: 640, height: 360 } : {}) };
      } });
      const args = { type, startSeconds: 0, endSeconds: 1 };
      const first = await h.engine.handle({ ...args, content: 'video' });
      assert.equal(first.ok, true);
      fail = true;
      const failed = await h.engine.handle({ ...args, content: 'audio' });
      assert.equal(failed.ok, false, `${type}:${failure}`);
      assert.equal(failed.state.status, 'ready');
      assert.equal(failed.state.exportProgress, 0);
      assert.deepEqual(failed.state.result, first.state.result);
      assert.deepEqual(failed.state.exportResult, first.state.exportResult);
      assert.deepEqual(failed.state.videoExportResult, first.state.videoExportResult);
      assert.equal(h.urls.length, 2, 'only original and previous successful output have URLs');
      assert.equal(h.revoked.length, 0);
      fail = false;
      assert.equal((await h.engine.handle({ ...args, content: 'audio' })).ok, true);
      assert.equal(h.revoked.length, 1);
    }
  }
});

test('track extraction cancellation keeps original and previous output until cleanup completes', async () => {
  for (const type of ['PREPARE_VIDEO_EXPORT', 'PREPARE_EXPORT']) {
    for (const settles of ['reject', 'resolve']) {
      let finish;
      let enter;
      let activeSignal;
      let calls = 0;
      const entered = new Promise((resolve) => { enter = resolve; });
      const cleanup = new Promise((resolve) => { finish = resolve; });
      const h = await recordedVideo({ selectMp4Tracks: async (_blob, content, { signal, onProgress }) => {
        calls++;
        if (calls === 2) {
          activeSignal = signal;
          onProgress(0.4);
          enter();
          await cleanup;
          if (settles === 'reject') throw Object.assign(new Error('cancelled'), { name: 'AbortError' });
        }
        return { blob: new Blob(['selected'], { type: `${content}/mp4` }), mimeType: `${content}/mp4`,
          kind: content, content, durationSeconds: 1, ...(content === 'video' ? { width: 640, height: 360 } : {}) };
      } });
      const args = { type, startSeconds: 0, endSeconds: 1 };
      const previous = await h.engine.handle({ ...args, content: 'video' });
      const pending = h.engine.handle({ ...args, content: 'audio' });
      await entered;
      const cancel = await h.engine.handle({ type: 'CANCEL_EXPORT' });
      assert.equal(activeSignal.aborted, true);
      assert.equal(cancel.state.status, 'trimming');
      assert.equal((await h.engine.handle({ type: 'DISCARD' })).ok, false);
      finish();
      const cancelled = await pending;
      assert.equal(cancelled.cancelled, true);
      assert.equal(cancelled.state.status, 'ready');
      assert.equal(cancelled.state.exportProgress, 0);
      assert.deepEqual(cancelled.state.result, previous.state.result);
      assert.deepEqual(cancelled.state.exportResult, previous.state.exportResult);
      assert.deepEqual(cancelled.state.videoExportResult, previous.state.videoExportResult);
      assert.equal(h.urls.length, 2);
      assert.equal(h.revoked.length, 0);
      assert.equal(h.audioTrims.length, 0, 'cancelling extraction prevents the audio packet-trimming phase');
    }
  }
});

test('cancelling range trim prevents the track-extraction phase from starting', async () => {
  let finish;
  let enter;
  const entered = new Promise((resolve) => { enter = resolve; });
  const gate = new Promise((resolve) => { finish = resolve; });
  const h = await recordedVideo({ trimVideo: async (_blob, startSeconds, endSeconds, { signal }) => {
    enter();
    await gate;
    assert.equal(signal.aborted, true);
    return { blob: new Blob(['late-video'], { type: 'video/mp4' }), width: 640, height: 360,
      durationSeconds: 1, startSeconds, endSeconds };
  } });
  const pending = h.engine.handle({ type: 'PREPARE_EXPORT', content: 'video', startSeconds: 0, endSeconds: 1 });
  await entered;
  await h.engine.handle({ type: 'CANCEL_EXPORT' });
  finish();
  assert.equal((await pending).cancelled, true);
  assert.equal(h.trackSelections.length, 0);
  assert.equal(h.urls.length, 1);
});

test('whole-track, range, and GIF caches clean up together and never cross recording sessions', async () => {
  const h = await recordedVideo();
  await h.engine.handle({ type: 'PREPARE_VIDEO_EXPORT', content: 'audio' });
  await h.engine.handle({ type: 'PREPARE_EXPORT', content: 'video', startSeconds: 0, endSeconds: 1 });
  await h.engine.handle({ type: 'PREPARE_GIF' });
  await h.engine.handle({ type: 'PREPARE_GIF', startSeconds: 0, endSeconds: 1 });
  assert.equal(h.urls.length, 5);
  const discarded = await h.engine.handle({ type: 'DISCARD' });
  for (const key of ['result', 'videoExportResult', 'exportResult', 'gifResult', 'rangeGifResult']) {
    assert.equal(discarded.state[key], null);
  }
  assert.equal(h.revoked.length, 5);
  assert.equal(new Set(h.revoked).size, 5);
  const oldSource = h.trackSelections[0].blob;
  await h.select();
  await h.start();
  h.advance(1000);
  await h.engine.handle({ type: 'STOP' });
  await h.engine.handle({ type: 'PREPARE_VIDEO_EXPORT', content: 'audio' });
  assert.equal(h.trackSelections.length, 3);
  assert.notEqual(h.trackSelections.at(-1).blob, oldSource);
});

test('popup status restores the active export choice and clears it only after job cleanup', async () => {
  const jobs = [
    { command: { type: 'PREPARE_VIDEO_EXPORT', content: 'audio' }, format: 'mp4', content: 'audio' },
    { command: { type: 'PREPARE_VIDEO_EXPORT', content: 'video' }, format: 'mp4', content: 'video' },
    ...['both', 'video', 'audio'].map((content) => ({
      command: { type: 'PREPARE_EXPORT', content, startSeconds: 0, endSeconds: 1 }, format: 'mp4', content,
    })),
    { command: { type: 'PREPARE_GIF' }, format: 'gif', content: 'video' },
    { command: { type: 'PREPARE_GIF', startSeconds: 0, endSeconds: 1 }, format: 'gif', content: 'video' },
  ];
  for (const { command, format, content } of jobs) {
    for (const outcome of ['success', 'error', 'cancel']) {
      let enter;
      let finish;
      const entered = new Promise((resolve) => { enter = resolve; });
      const cleanup = new Promise((resolve) => { finish = resolve; });
      const wait = async () => {
        enter();
        await cleanup;
        if (outcome === 'error') throw new Error('export failed');
      };
      const h = await recordedVideo({
        trimVideo: async (_blob, startSeconds, endSeconds) => {
          await wait();
          return { blob: new Blob(['clip'], { type: 'video/mp4' }), width: 640, height: 360,
            durationSeconds: 1, startSeconds, endSeconds };
        },
        selectMp4Tracks: async (_blob, selectedContent) => {
          await wait();
          return { blob: new Blob(['track'], { type: `${selectedContent}/mp4` }),
            kind: selectedContent, content: selectedContent, mimeType: `${selectedContent}/mp4`, durationSeconds: 1,
            ...(selectedContent === 'video' ? { width: 640, height: 360 } : {}) };
        },
        exportGif: async () => {
          await wait();
          return { blob: new Blob(['GIF89a'], { type: 'image/gif' }),
            width: 320, height: 180, durationSeconds: 1, frameCount: 10 };
        },
      });
      assert.equal(h.engine.getState().exportFormat, null);
      assert.equal(h.engine.getState().exportContent, null);
      const pending = h.engine.handle(command);
      await entered;
      const reopened = await h.engine.handle({ type: 'STATUS' });
      assert.equal(reopened.state.exportFormat, format);
      assert.equal(reopened.state.exportContent, content);
      if (outcome === 'cancel') {
        const cancelling = await h.engine.handle({ type: 'CANCEL_EXPORT' });
        assert.equal(cancelling.state.exportFormat, format, 'reopening during cancellation still shows the actual busy job');
        assert.equal(cancelling.state.exportContent, content);
      }
      finish();
      const completed = await pending;
      assert.equal(completed.ok, outcome === 'success');
      if (outcome === 'cancel') assert.equal(completed.cancelled, true);
      assert.equal(completed.state.status, 'ready');
      assert.equal(completed.state.exportFormat, null);
      assert.equal(completed.state.exportContent, null);
      assert.equal(h.states.at(-1).exportFormat, null);
      assert.equal(h.states.at(-1).exportContent, null);
      await h.engine.handle({ type: 'DISCARD' });
      assert.equal(h.engine.getState().exportFormat, null);
      assert.equal(h.engine.getState().exportContent, null);
    }
  }
});

test('whole MP4 quality changes happen only at save time and use the decoder full duration', async () => {
  const h = await recordedVideo();
  const original = h.engine.getState().result;
  assert.equal(original.quality, 'original');
  assert.equal(h.recorders[0].settings.videoBitsPerSecond, 5_000_000);
  const unchanged = await h.engine.handle({ type: 'PREPARE_VIDEO_EXPORT' });
  assert.equal(unchanged.ok, true);
  assert.equal(unchanged.state.videoExportResult, null);
  assert.equal(h.trims.length, 0);

  const balanced = await h.engine.handle({ type: 'PREPARE_VIDEO_EXPORT', content: 'both', quality: 'balanced' });
  assert.equal(balanced.ok, true);
  assert.equal(balanced.state.videoExportResult.quality, 'balanced');
  assert.equal(balanced.state.videoExportResult.content, 'both');
  assert.match(balanced.state.videoExportResult.filename, /-720p\.mp4$/);
  assert.equal(h.trims[0].blob, h.urls[0]);
  assert.equal(h.trims[0].startSeconds, 0);
  assert.equal(h.trims[0].endSeconds, undefined, 'whole export must use actual decoded duration, not a state estimate');
  assert.equal(h.trims[0].settings.quality, 'balanced');
  assert.equal(h.trackSelections.length, 0);
  assert.deepEqual(balanced.state.result, original);
  const cached = await h.engine.handle({ type: 'PREPARE_VIDEO_EXPORT', content: 'both', quality: 'balanced' });
  assert.deepEqual(cached.state.videoExportResult, balanced.state.videoExportResult);
  assert.equal(h.trims.length, 1);

  const silent = await h.engine.handle({ type: 'PREPARE_VIDEO_EXPORT', content: 'video', quality: 'balanced' });
  assert.equal(silent.ok, true);
  assert.equal(silent.state.videoExportResult.kind, 'video');
  assert.match(silent.state.videoExportResult.filename, /-video-only-720p\.mp4$/);
  assert.equal(h.trims.length, 2, 'different content must not reuse the both-track cached result');
  assert.equal(await h.trackSelections[0].blob.text(), 'trimmed-video');
  assert.notEqual(h.trackSelections[0].blob, h.urls[0]);
  assert.equal(h.trackSelections[0].settings.signal, h.trims[1].settings.signal);
  const small = await h.engine.handle({ type: 'PREPARE_VIDEO_EXPORT', content: 'video', quality: 'small' });
  assert.equal(small.state.videoExportResult.quality, 'small');
  assert.match(small.state.videoExportResult.filename, /-video-only-480p\.mp4$/);
  assert.equal(h.trims.length, 3);
  assert.equal(h.trims[2].settings.quality, 'small');
  assert.equal(h.captures.length, 1, 'saving another quality never recaptures the tab');
  assert.equal(h.recorders.length, 1);
  const fullOriginal = await h.engine.handle({ type: 'PREPARE_VIDEO_EXPORT', content: 'both', quality: 'original' });
  assert.equal(fullOriginal.ok, true);
  assert.deepEqual(fullOriginal.state.result, original);
  assert.equal(h.trims.length, 3, 'saving the original still bypasses conversion');
});

test('reduced whole-file quality still uses decoder duration when initial trim metadata was unavailable', async () => {
  const h = await recordedVideo({ inspectVideo: async () => { throw new Error('initial metadata unavailable'); } });
  assert.equal(h.engine.getState().result.durationSeconds, null);
  const result = await h.engine.handle({ type: 'PREPARE_VIDEO_EXPORT', quality: 'small' });
  assert.equal(result.ok, true);
  assert.equal(result.state.videoExportResult.quality, 'small');
  assert.equal(result.state.videoExportResult.durationSeconds, 1.5);
  assert.equal(h.trims[0].endSeconds, undefined);
  assert.equal(result.state.result.durationSeconds, null, 'the retained original metadata is not replaced');
});

test('MP4 range caches and filenames distinguish quality while preserving the requested timeline', async () => {
  const h = await recordedVideo();
  const selection = { startSeconds: 0.25, endSeconds: 1.25 };
  const filenames = [];
  for (const quality of ['original', 'balanced', 'small']) {
    const result = await h.engine.handle({ type: 'PREPARE_EXPORT', content: 'video', quality, ...selection });
    assert.equal(result.ok, true);
    assert.equal(result.state.exportResult.quality, quality);
    assert.equal(result.state.exportResult.startSeconds, 0.25);
    assert.equal(result.state.exportResult.endSeconds, 1.25);
    assert.equal(h.trims.at(-1).settings.quality, quality);
    filenames.push(result.state.exportResult.filename);
    const cached = await h.engine.handle({ type: 'PREPARE_EXPORT', content: 'video', quality, ...selection });
    assert.deepEqual(cached.state.exportResult, result.state.exportResult);
  }
  assert.equal(h.trims.length, 3);
  assert.equal(h.trackSelections.length, 3);
  assert.equal(new Set(filenames).size, 3);
  assert.match(filenames[0], /-clip-0\.25-1\.25s-video-only\.mp4$/);
  assert.match(filenames[1], /-720p\.mp4$/);
  assert.match(filenames[2], /-480p\.mp4$/);
  assert.equal(h.revoked.length, 2);
  assert.equal(h.engine.getState().result.quality, 'original');
});

test('audio-only MP4 exports ignore visual quality and reuse the unchanged audio output', async () => {
  const h = await recordedVideo();
  const fullOutputs = [];
  for (const quality of ['small', 'balanced', 'original']) {
    const full = await h.engine.handle({ type: 'PREPARE_VIDEO_EXPORT', content: 'audio', quality });
    assert.equal(full.ok, true);
    assert.equal(full.state.videoExportResult.quality, 'original');
    assert.match(full.state.videoExportResult.filename, /-audio-only\.mp4$/);
    fullOutputs.push(full.state.videoExportResult.url);
  }
  assert.equal(new Set(fullOutputs).size, 1);
  assert.equal(h.trackSelections.length, 1);
  assert.equal(h.trims.length, 0, 'whole audio remains lossless extraction of the original');
  const selection = { startSeconds: 0, endSeconds: 1 };
  const rangeOutputs = [];
  for (const quality of ['small', 'balanced', 'original']) {
    const range = await h.engine.handle({ type: 'PREPARE_EXPORT', content: 'audio', quality, ...selection });
    assert.equal(range.ok, true);
    assert.equal(range.state.exportResult.quality, 'original');
    assert.match(range.state.exportResult.filename, /-audio-only\.mp4$/);
    rangeOutputs.push(range.state.exportResult.url);
  }
  assert.equal(new Set(rangeOutputs).size, 1);
  assert.equal(h.trims.length, 0, 'audio-only ranges also bypass the video decoder and encoder');
  assert.equal(h.audioTrims.length, 1);
  assert.equal(h.trackSelections.length, 2);
});

test('audio-only recordings keep their audio trimmer and do not use visual quality settings', async () => {
  const audioTrims = [];
  const h = harness({ types: ['audio/mp4;codecs=mp4a.40.2'],
    inspectMp4: async () => ({ durationSeconds: 1.5 }),
    trimMp4: async (blob, startSeconds, endSeconds) => {
      audioTrims.push({ blob, startSeconds, endSeconds });
      return { blob: new Blob(['audio-clip'], { type: 'audio/mp4' }),
        durationSeconds: endSeconds - startSeconds, startSeconds, endSeconds };
    },
  });
  await h.engine.handle({ type: 'START', tab, streamId: 'audio-stream' });
  h.advance(1500);
  await h.engine.handle({ type: 'STOP' });
  const small = await h.engine.handle({ type: 'PREPARE_EXPORT', quality: 'small', startSeconds: 0, endSeconds: 1 });
  const normal = await h.engine.handle({ type: 'PREPARE_EXPORT', startSeconds: 0, endSeconds: 1 });
  assert.equal(small.ok, true);
  assert.equal(small.state.exportResult.quality, 'original');
  assert.deepEqual(normal.state.exportResult, small.state.exportResult);
  assert.equal(audioTrims.length, 1);
  assert.equal(h.trims.length, 0);
  assert.equal(h.trackSelections.length, 0);
  assert.equal(h.exports.length, 0);
  assert.equal(h.states.filter((state) => state.status === 'trimming')[0].exportQuality, 'original');
});

test('whole and range GIF quality caches remain separate and always encode the original source', async () => {
  const h = await recordedVideo();
  const selection = { startSeconds: 0.2, endSeconds: 1.2 };
  const original = h.engine.getState().result;
  for (const ranged of [false, true]) {
    const key = ranged ? 'rangeGifResult' : 'gifResult';
    const args = ranged ? selection : {};
    for (const quality of ['original', 'balanced', 'small']) {
      const result = await h.engine.handle({ type: 'PREPARE_GIF', quality, ...args });
      assert.equal(result.ok, true);
      assert.equal(result.state[key].quality, quality);
      assert.equal(h.exportSettings.at(-1).quality, quality);
      assert.equal(h.exports.at(-1), h.urls[0]);
      assert.match(result.state[key].filename,
        quality === 'original' ? /(?:s|Z)\.gif$/ : quality === 'balanced' ? /-480px\.gif$/ : /-320px\.gif$/);
      const cached = await h.engine.handle({ type: 'PREPARE_GIF', quality, ...args });
      assert.deepEqual(cached.state[key], result.state[key]);
      assert.deepEqual(cached.state.result, original);
    }
  }
  assert.equal(h.exports.length, 6);
  assert.equal(h.engine.getState().gifResult.quality, 'small');
  assert.equal(h.engine.getState().rangeGifResult.quality, 'small');
  const rangeUrl = h.engine.getState().rangeGifResult.url;
  const changedWhole = await h.engine.handle({ type: 'PREPARE_GIF', quality: 'balanced' });
  assert.equal(changedWhole.state.gifResult.quality, 'balanced');
  assert.equal(changedWhole.state.rangeGifResult.url, rangeUrl);
  assert.equal(h.trims.length, 0);
  assert.equal(h.trackSelections.length, 0);
});

test('quality omission remains original and explicitly invalid quality cannot change selections or caches', async () => {
  const h = await recordedVideo();
  const commands = [
    { type: 'PREPARE_VIDEO_EXPORT', content: 'both' },
    { type: 'PREPARE_VIDEO_EXPORT', content: 'audio' },
    { type: 'PREPARE_EXPORT', startSeconds: 0, endSeconds: 1 },
    { type: 'PREPARE_GIF' },
  ];
  for (const command of commands) {
    const first = await h.engine.handle(command);
    const again = await h.engine.handle({ ...command, quality: 'original' });
    assert.equal(first.ok, true);
    assert.deepEqual(again.state.result, first.state.result);
    assert.deepEqual(again.state.exportResult, first.state.exportResult);
    assert.deepEqual(again.state.videoExportResult, first.state.videoExportResult);
    assert.deepEqual(again.state.gifResult, first.state.gifResult);
  }
  const ready = h.engine.getState();
  const calls = [h.trims.length, h.trackSelections.length, h.exports.length];
  for (const quality of [null, '', 'low', 720, {}, ['small']]) {
    for (const command of commands) {
      const result = await h.engine.handle({ ...command, quality });
      assert.equal(result.ok, false);
      assert.deepEqual(result.state.selection, ready.selection);
      assert.deepEqual(result.state.result, ready.result);
      assert.deepEqual(result.state.exportResult, ready.exportResult);
      assert.deepEqual(result.state.videoExportResult, ready.videoExportResult);
      assert.deepEqual(result.state.gifResult, ready.gifResult);
    }
  }
  assert.deepEqual([h.trims.length, h.trackSelections.length, h.exports.length], calls);
});

test('failed or cancelled quality changes retain the previous output and expose the active quality until cleanup', async () => {
  const cases = [
    { command: { type: 'PREPARE_VIDEO_EXPORT', content: 'both' }, key: 'videoExportResult' },
    { command: { type: 'PREPARE_EXPORT', startSeconds: 0, endSeconds: 1 }, key: 'exportResult' },
    { command: { type: 'PREPARE_GIF' }, key: 'gifResult' },
    { command: { type: 'PREPARE_GIF', startSeconds: 0, endSeconds: 1 }, key: 'rangeGifResult' },
  ];
  for (const { command, key } of cases) {
    for (const outcome of ['error', 'cancel']) {
      let enter;
      let finish;
      let block = true;
      const entered = new Promise((resolve) => { enter = resolve; });
      const cleanup = new Promise((resolve) => { finish = resolve; });
      const wait = async ({ quality, onProgress }) => {
        if (quality !== 'balanced' || !block) return;
        onProgress(0.4);
        enter();
        await cleanup;
        if (outcome === 'error') throw new Error('quality conversion failed');
      };
      const h = await recordedVideo({
        trimVideo: async (_blob, startSeconds, endSeconds, settings) => {
          await wait(settings);
          endSeconds ??= 1.5;
          return { blob: new Blob(['reduced-video'], { type: 'video/mp4' }), width: 640, height: 360,
            durationSeconds: endSeconds - startSeconds, startSeconds, endSeconds };
        },
        exportGif: async (_blob, settings) => {
          await wait(settings);
          return { blob: new Blob(['GIF89a'], { type: 'image/gif' }),
            width: 320, height: 180, durationSeconds: 1, frameCount: 6 };
        },
      });
      const previous = await h.engine.handle({ ...command, quality: 'small' });
      assert.equal(previous.ok, true);
      const pending = h.engine.handle({ ...command, quality: 'balanced' });
      await entered;
      const busy = await h.engine.handle({ type: 'STATUS' });
      assert.equal(busy.state.exportQuality, 'balanced');
      assert.deepEqual(busy.state[key], previous.state[key]);
      if (outcome === 'cancel') {
        const cancelling = await h.engine.handle({ type: 'CANCEL_EXPORT' });
        assert.equal(cancelling.state.exportQuality, 'balanced');
      }
      finish();
      const failed = await pending;
      assert.equal(failed.ok, false);
      assert.equal(failed.state.exportQuality, null);
      assert.equal(failed.state.status, 'ready');
      assert.deepEqual(failed.state[key], previous.state[key]);
      assert.deepEqual(failed.state.result, previous.state.result);
      assert.equal(h.urls.length, 2);
      assert.equal(h.revoked.length, 0);
      if (outcome === 'cancel') assert.equal(failed.cancelled, true);
      const cached = await h.engine.handle({ ...command, quality: 'small' });
      assert.deepEqual(cached.state[key], previous.state[key]);
      block = false;
      const retried = await h.engine.handle({ ...command, quality: 'balanced' });
      assert.equal(retried.ok, true);
      assert.equal(retried.state[key].quality, 'balanced');
      assert.equal(retried.state.exportQuality, null);
      assert.deepEqual(h.revoked, [previous.state[key].url]);
    }
  }
});

test('discard clears quality caches and releases every source and derived URL exactly once', async () => {
  const h = await recordedVideo();
  await h.engine.handle({ type: 'PREPARE_VIDEO_EXPORT', quality: 'small' });
  await h.engine.handle({ type: 'PREPARE_EXPORT', quality: 'balanced', startSeconds: 0, endSeconds: 1 });
  await h.engine.handle({ type: 'PREPARE_GIF', quality: 'small' });
  await h.engine.handle({ type: 'PREPARE_GIF', quality: 'balanced', startSeconds: 0, endSeconds: 1 });
  const originalBlob = h.urls[0];
  const oldGif = h.engine.getState().gifResult.url;
  const discarded = await h.engine.handle({ type: 'DISCARD' });
  assert.equal(discarded.state.exportQuality, null);
  assert.equal(h.revoked.length, 5);
  assert.equal(new Set(h.revoked).size, 5);
  await h.select();
  await h.start();
  h.advance(1000);
  await h.engine.handle({ type: 'STOP' });
  const next = await h.engine.handle({ type: 'PREPARE_GIF', quality: 'small' });
  assert.equal(next.ok, true);
  assert.notEqual(next.state.gifResult.url, oldGif);
  assert.notEqual(h.exports.at(-1), originalBlob);
  assert.equal(h.exports.length, 3);
});
