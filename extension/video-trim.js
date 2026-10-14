export const VIDEO_TRIM_MIN_SECONDS = 0.04;
export const VIDEO_TRIM_MAX_SECONDS = 2 * 60 * 60;
export const VIDEO_TRIM_MAX_COMBINED_BYTES = 128 * 1024 * 1024;
const MEDIA_TIMEOUT_MS = 30_000;
const FRAME_RATE = 30;
const VIDEO_MIME_TYPES = [
  'video/mp4;codecs=avc1.420028,mp4a.40.2', 'video/mp4;codecs=avc1,mp4a.40.2',
  'video/mp4;codecs=vp9,opus', 'video/mp4;codecs=avc1,opus', 'video/mp4',
];

function abortError() {
  const error = new Error('선택 구간 저장을 취소했어요. 원본 영상은 그대로 남아 있어요.');
  error.name = 'AbortError';
  return error;
}

function checkAbort(signal) {
  if (signal?.aborted) throw abortError();
}

export function validateVideoTrimRange(startSeconds, endSeconds, durationSeconds) {
  if (!Number.isFinite(startSeconds) || !Number.isFinite(endSeconds)
    || !Number.isFinite(durationSeconds) || durationSeconds <= 0 || durationSeconds > VIDEO_TRIM_MAX_SECONDS
    || startSeconds < 0 || endSeconds <= startSeconds || endSeconds > durationSeconds + 0.001) {
    throw new Error('시작과 끝을 영상 길이 안에서 입력해 주세요. 끝은 시작보다 뒤여야 해요.');
  }
  endSeconds = Math.min(endSeconds, durationSeconds);
  if (endSeconds - startSeconds < VIDEO_TRIM_MIN_SECONDS - 1e-8) {
    throw new Error('영상 구간은 0.04초 이상으로 선택해 주세요. 너무 짧으면 영상 프레임을 저장할 수 없어요.');
  }
  return { startSeconds, endSeconds };
}

function waitForMedia(video, event, trigger, env, signal) {
  checkAbort(signal);
  return new Promise((resolve, reject) => {
    let timeout;
    let settled = false;
    const cleanup = () => {
      env.clearTimeout(timeout);
      video.removeEventListener(event, success);
      video.removeEventListener('error', failure);
      signal?.removeEventListener('abort', aborted);
    };
    const finish = (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) reject(error); else resolve();
    };
    const success = () => finish();
    const failure = () => finish(new Error('영상을 읽지 못했어요. 전체 MP4 원본은 저장할 수 있어요.'));
    const aborted = () => finish(abortError());
    video.addEventListener(event, success);
    video.addEventListener('error', failure);
    signal?.addEventListener('abort', aborted, { once: true });
    timeout = env.setTimeout(() => finish(new Error('영상을 읽는 시간이 초과됐어요. 다시 시도해 주세요.')), MEDIA_TIMEOUT_MS);
    try { trigger?.(); } catch (error) { finish(error); }
  });
}

function waitForPromise(promise, env, signal) {
  checkAbort(signal);
  return new Promise((resolve, reject) => {
    let timeout;
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      env.clearTimeout(timeout);
      signal?.removeEventListener('abort', aborted);
      if (error) reject(error); else resolve(value);
    };
    const aborted = () => finish(abortError());
    signal?.addEventListener('abort', aborted, { once: true });
    timeout = env.setTimeout(() => finish(new Error('영상 변환을 준비하는 시간이 초과됐어요.')), MEDIA_TIMEOUT_MS);
    Promise.resolve(promise).then((value) => finish(null, value), (error) => finish(error));
  });
}

/** Browser dependencies are injectable for lifecycle tests without any devices. */
export function createVideoTrimmer(overrides = {}) {
  const env = {
    document: globalThis.document,
    MediaRecorder: globalThis.MediaRecorder,
    MediaStream: globalThis.MediaStream,
    AudioContext: globalThis.AudioContext,
    url: globalThis.URL,
    Blob: globalThis.Blob,
    now: () => performance.now(),
    setTimeout: globalThis.setTimeout.bind(globalThis),
    clearTimeout: globalThis.clearTimeout.bind(globalThis),
    setInterval: globalThis.setInterval.bind(globalThis),
    clearInterval: globalThis.clearInterval.bind(globalThis),
    ...overrides,
  };

  async function openVideo(blob, signal) {
    checkAbort(signal);
    if (!(blob instanceof env.Blob) || !blob.size) throw new Error('저장할 녹화 파일이 없습니다.');
    if (!env.document?.createElement) throw new Error('이 브라우저에서는 영상 구간을 저장할 수 없습니다.');
    const video = env.document.createElement('video');
    video.muted = true;
    video.playsInline = true;
    video.preload = 'auto';
    const url = env.url.createObjectURL(blob);
    const dispose = () => {
      try { video.pause(); } catch { /* A failed decoder still needs cleanup. */ }
      video.removeAttribute('src');
      try { video.load(); } catch { /* Already closed. */ }
      env.url.revokeObjectURL(url);
    };
    try {
      await waitForMedia(video, 'loadedmetadata', () => { video.src = url; video.load(); }, env, signal);
      // Fragmented MediaRecorder MP4 files may report Infinity until the browser
      // has sought to the final fragment and discovered the media endpoint.
      if (!Number.isFinite(video.duration)) {
        await waitForMedia(video, 'seeked', () => { video.currentTime = 1e10; }, env, signal);
      }
      if (!Number.isFinite(video.duration) || video.duration <= 0
        || !Number.isFinite(video.videoWidth) || video.videoWidth < 2
        || !Number.isFinite(video.videoHeight) || video.videoHeight < 2) {
        throw new Error('영상 길이나 화면 크기를 읽지 못했어요. 전체 MP4 원본은 저장할 수 있어요.');
      }
      return { video, dispose, metadata: {
        durationSeconds: video.duration, width: video.videoWidth, height: video.videoHeight,
      } };
    } catch (error) {
      dispose();
      throw error;
    }
  }

  async function inspect(blob, { signal } = {}) {
    const resource = await openVideo(blob, signal);
    try { return resource.metadata; } finally { resource.dispose(); }
  }

  async function trim(blob, startSeconds, endSeconds, { onProgress = () => {}, signal } = {}) {
    checkAbort(signal);
    let resource;
    let canvas;
    let canvasStream;
    let context;
    let source;
    let destination;
    let recorder;
    let interval = null;
    let frameId = null;
    let removeListeners = () => {};
    let chunks = [];
    try {
      onProgress(0);
      resource = await openVideo(blob, signal);
      const { video, metadata } = resource;
      ({ startSeconds, endSeconds } = validateVideoTrimRange(startSeconds, endSeconds, metadata.durationSeconds));
      if (startSeconds === 0 && endSeconds === metadata.durationSeconds) {
        onProgress(1);
        return { blob, ...metadata, startSeconds, endSeconds, mimeType: blob.type || 'video/mp4' };
      }
      const maxBytes = VIDEO_TRIM_MAX_COMBINED_BYTES - blob.size;
      if (maxBytes < 1024) throw new Error('구간 변환 메모리 한도를 넘었어요. 전체 MP4를 저장하거나 더 짧게 녹화해 주세요.');
      const mimeType = VIDEO_MIME_TYPES.find((type) => env.MediaRecorder?.isTypeSupported?.(type));
      if (!mimeType || !env.MediaStream || !env.AudioContext) {
        throw new Error('이 브라우저는 MP4 영상 구간 저장을 지원하지 않습니다. Chrome 또는 Edge를 업데이트해 주세요.');
      }
      if (Math.abs(video.currentTime - startSeconds) > 0.00001) {
        await waitForMedia(video, 'seeked', () => { video.currentTime = startSeconds; }, env, signal);
      }
      if (video.readyState < 2) await waitForMedia(video, 'loadeddata', undefined, env, signal);
      canvas = env.document.createElement('canvas');
      const scale = Math.min(1, 1920 / metadata.width, 1080 / metadata.height);
      canvas.width = Math.max(2, Math.floor(metadata.width * scale / 2) * 2);
      canvas.height = Math.max(2, Math.floor(metadata.height * scale / 2) * 2);
      const drawing = canvas.getContext('2d', { alpha: false });
      if (!drawing || !canvas.captureStream) throw new Error('영상 구간을 만들 화면을 준비하지 못했어요.');
      drawing.drawImage(video, 0, 0, canvas.width, canvas.height);
      canvasStream = canvas.captureStream(FRAME_RATE);
      if (!canvasStream.getVideoTracks().length) throw new Error('영상 구간의 영상 트랙을 준비하지 못했어요.');
      context = new env.AudioContext();
      source = context.createMediaElementSource(video);
      destination = context.createMediaStreamDestination();
      source.connect(destination);
      // The element's audio goes only to the recorder destination, never to the
      // speakers. Do not mute the element: that would silence the exported audio.
      video.muted = false;
      video.volume = 1;
      if (context.state === 'suspended') await waitForPromise(context.resume(), env, signal);
      checkAbort(signal);
      if (!destination.stream.getAudioTracks().length) throw new Error('영상 구간의 오디오 트랙을 준비하지 못했어요.');
      const outputStream = new env.MediaStream([
        ...canvasStream.getVideoTracks(), ...destination.stream.getAudioTracks(),
      ]);
      recorder = new env.MediaRecorder(outputStream, {
        mimeType, audioBitsPerSecond: 128000, videoBitsPerSecond: 5000000,
      });
      if (recorder.mimeType && !/^video\/mp4(?:;|$)/i.test(recorder.mimeType)) {
        throw new Error('브라우저가 MP4 형식으로 영상을 만들지 못했어요. 전체 MP4 원본은 저장할 수 있어요.');
      }
      await new Promise((resolve, reject) => {
        let settled = false;
        let stopping = false;
        let stopTimeout = null;
        let byteLength = 0;
        let lastDraw = -Infinity;
        let lastTime = video.currentTime;
        let lastAdvance = env.now();
        const startedAt = lastAdvance;
        const finish = (error) => {
          if (settled) return;
          settled = true;
          removeListeners();
          if (error) reject(error); else resolve();
        };
        const stop = () => {
          if (settled || stopping) return;
          stopping = true;
          video.pause();
          try { source.disconnect(); } catch { /* Already disconnected. */ }
          try {
            if (recorder.state !== 'inactive') {
              stopTimeout = env.setTimeout(() => finish(new Error('MP4 구간 저장을 마무리하는 시간이 초과됐어요.')), MEDIA_TIMEOUT_MS);
              recorder.stop();
            }
            else finish(new Error('선택한 구간의 녹화가 예기치 않게 종료됐어요.'));
          } catch (error) { finish(error); }
        };
        const aborted = () => finish(abortError());
        const failed = () => finish(new Error('영상 구간을 읽는 중 오류가 발생했어요. 원본 영상은 그대로 남아 있어요.'));
        const tick = () => {
          if (settled || stopping) return;
          const now = env.now();
          const current = video.currentTime;
          if (current > lastTime + 0.00001) { lastTime = current; lastAdvance = now; }
          if (current >= endSeconds || (video.ended && current >= endSeconds - 0.1)) {
            stop();
            return;
          }
          if (video.ended || now - lastAdvance > MEDIA_TIMEOUT_MS
            || now - startedAt > (endSeconds - startSeconds) * 1000 + MEDIA_TIMEOUT_MS) {
            finish(new Error('영상 재생이 멈춰 구간 저장을 끝내지 못했어요. 다시 시도해 주세요.'));
            return;
          }
          if (video.readyState >= 2 && now - lastDraw >= 1000 / FRAME_RATE * 0.9) {
            try { drawing.drawImage(video, 0, 0, canvas.width, canvas.height); }
            catch (error) { finish(error); return; }
            lastDraw = now;
          }
          onProgress(Math.min(0.95, Math.max(0, (current - startSeconds) / (endSeconds - startSeconds)) * 0.95));
        };
        const nextFrame = () => {
          tick();
          if (!settled && !stopping) frameId = video.requestVideoFrameCallback(nextFrame);
        };
        removeListeners = () => {
          if (stopTimeout !== null) env.clearTimeout(stopTimeout);
          stopTimeout = null;
          if (interval !== null) env.clearInterval(interval);
          interval = null;
          if (frameId !== null) video.cancelVideoFrameCallback?.(frameId);
          frameId = null;
          signal?.removeEventListener('abort', aborted);
          video.removeEventListener('error', failed);
        };
        signal?.addEventListener('abort', aborted, { once: true });
        video.addEventListener('error', failed);
        recorder.ondataavailable = ({ data }) => {
          if (settled || !data?.size) return;
          byteLength += data.size;
          if (byteLength > maxBytes) {
            finish(new Error('구간 변환 메모리 한도를 넘었어요. 더 짧은 구간을 선택해 주세요.'));
            return;
          }
          chunks.push(data);
        };
        recorder.onstop = () => {
          if (!stopping && !settled) finish(new Error('선택한 구간의 녹화가 예기치 않게 종료됐어요.'));
          else finish();
        };
        recorder.onerror = (event) => finish(event.error || new Error('MP4 영상 구간을 만들지 못했어요.'));
        try {
          checkAbort(signal);
          recorder.start(250);
          interval = env.setInterval(tick, 1000 / 60);
          if (video.requestVideoFrameCallback) frameId = video.requestVideoFrameCallback(nextFrame);
          Promise.resolve(video.play()).catch((error) => { if (!stopping) finish(error); });
        } catch (error) { finish(error); }
      });
      checkAbort(signal);
      const result = new env.Blob(chunks, { type: recorder.mimeType || mimeType });
      chunks = [];
      if (!result.size) throw new Error('선택한 구간의 영상 프레임을 만들지 못했어요. 더 긴 구간을 선택해 주세요.');
      const measured = await inspect(result, { signal });
      onProgress(1);
      return { blob: result, ...measured, startSeconds, endSeconds, mimeType: result.type };
    } finally {
      removeListeners();
      if (recorder) {
        recorder.ondataavailable = null;
        recorder.onstop = null;
        recorder.onerror = null;
        try { if (recorder.state !== 'inactive') recorder.stop(); } catch { /* Failed encoder. */ }
      }
      try { source?.disconnect(); } catch { /* Already disconnected. */ }
      for (const track of canvasStream?.getTracks() ?? []) track.stop();
      for (const track of destination?.stream.getTracks() ?? []) track.stop();
      if (context) {
        try { await context.close(); } catch { /* Already closed. */ }
      }
      resource?.dispose();
      if (canvas) { canvas.width = 0; canvas.height = 0; }
      chunks = [];
    }
  }

  return { inspectVideo: inspect, trimVideo: trim };
}

/** Measure a recording using the browser's video decoder without playing it. */
export function inspectVideo(blob, options) {
  return createVideoTrimmer().inspectVideo(blob, options);
}

/** Re-encode the requested interval locally; the caller retains the original. */
export function trimVideo(blob, startSeconds, endSeconds, options) {
  return createVideoTrimmer().trimVideo(blob, startSeconds, endSeconds, options);
}
