import { getVideoQuality } from './video-quality.js';

export const GIF_MAX_DIMENSION = 640;
export const GIF_MAX_FRAMES = 600;
export const GIF_MAX_FPS = 10;
export const GIF_MAX_DURATION_SECONDS = 2 * 60 * 60;
export const GIF_MAX_COMBINED_BYTES = 128 * 1024 * 1024;
const GIF_MAX_OUTPUT_BYTES = 64 * 1024 * 1024;
const MEDIA_TIMEOUT_MS = 30_000;

function abortError() {
  return new DOMException('GIF 변환을 취소했어요.', 'AbortError');
}

function checkAbort(signal) {
  if (signal?.aborted) throw abortError();
}

function validateRange(startSeconds, endSeconds, durationSeconds) {
  if (!Number.isFinite(startSeconds) || startSeconds < 0
      || (endSeconds !== undefined && (!Number.isFinite(endSeconds) || endSeconds <= startSeconds))) {
    throw new Error('GIF 시작과 끝을 영상 길이 안에서 입력해 주세요. 끝은 시작보다 뒤여야 해요.');
  }
  if (durationSeconds === undefined) return;
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
    throw new Error('GIF로 변환할 영상의 길이를 확인할 수 없습니다.');
  }
  if (startSeconds >= durationSeconds || (endSeconds !== undefined && endSeconds > durationSeconds)) {
    throw new Error('GIF 시작과 끝을 영상 길이 안에서 입력해 주세요. 끝은 시작보다 뒤여야 해요.');
  }
}

/** All frames span the complete recording; long recordings use a lower fps. */
export function createGifPlan(sourceWidth, sourceHeight, durationSeconds, quality = 'original') {
  const profile = getVideoQuality(quality);
  if (!Number.isFinite(sourceWidth) || !Number.isFinite(sourceHeight)
      || sourceWidth < 1 || sourceHeight < 1) {
    throw new Error('녹화 영상의 크기를 확인할 수 없습니다.');
  }
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0
      || durationSeconds > GIF_MAX_DURATION_SECONDS) {
    throw new Error('GIF로 변환할 영상의 길이를 확인할 수 없거나 2시간을 넘었습니다.');
  }
  const scale = Math.min(1, profile.gifMaxDimension / Math.max(sourceWidth, sourceHeight));
  const width = Math.max(1, Math.round(sourceWidth * scale));
  const height = Math.max(1, Math.round(sourceHeight * scale));
  const frameCount = Math.min(GIF_MAX_FRAMES, Math.ceil(durationSeconds * profile.gifFrameRate));
  // GIF delay units are hundredths of a second. Distribute rounding so the
  // total animation duration differs from the source by at most 0.005 seconds.
  const totalCentiseconds = Math.max(1, Math.round(durationSeconds * 100));
  const frames = Array.from({ length: frameCount }, (_, index) => ({
    timeSeconds: index * durationSeconds / frameCount,
    delayMs: (Math.round((index + 1) * totalCentiseconds / frameCount)
      - Math.round(index * totalCentiseconds / frameCount)) * 10,
  }));
  return { width, height, frameCount, durationSeconds, frames };
}

function mediaEvent(video, event, trigger, signal) {
  return new Promise((resolve, reject) => {
    let timeout;
    let settled = false;
    const cleanup = () => {
      clearTimeout(timeout);
      video.removeEventListener(event, success);
      video.removeEventListener('error', failure);
      signal?.removeEventListener('abort', cancelled);
    };
    const finish = (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) reject(error); else resolve();
    };
    const success = () => finish();
    const failure = () => finish(new Error('녹화 영상을 읽을 수 없습니다. MP4 원본으로 저장해 주세요.'));
    const cancelled = () => finish(abortError());
    if (signal?.aborted) { cancelled(); return; }
    video.addEventListener(event, success, { once: true });
    video.addEventListener('error', failure, { once: true });
    signal?.addEventListener('abort', cancelled, { once: true });
    timeout = setTimeout(() => finish(new Error('GIF 변환 중 영상을 읽는 시간이 초과되었습니다. 다시 시도해 주세요.')), MEDIA_TIMEOUT_MS);
    try { trigger?.(); } catch (error) { finish(error); }
  });
}

function workerClient(worker, signal) {
  let sequence = 0;
  let pending = null;
  let disposed = false;
  const settle = (error, value) => {
    if (!pending) return;
    const request = pending;
    pending = null;
    clearTimeout(request.timeout);
    if (error) request.reject(error); else request.resolve(value);
  };
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    signal?.removeEventListener('abort', cancelled);
    if (pending) settle(signal?.aborted ? abortError() : new Error('GIF 변환이 종료되었습니다.'));
    worker.onmessage = null;
    worker.onerror = null;
    worker.onmessageerror = null;
    worker.terminate();
  };
  const cancelled = () => {
    settle(abortError());
    dispose();
  };
  worker.onmessage = ({ data }) => {
    if (data.id !== pending?.id) return;
    settle(data.error ? new Error(data.error) : null, data);
  };
  worker.onerror = (event) => {
    event.preventDefault();
    settle(new Error('GIF 변환기를 실행할 수 없습니다. 확장 프로그램을 새로고침해 주세요.'));
  };
  worker.onmessageerror = () => settle(new Error('GIF 변환 데이터를 읽을 수 없습니다.'));
  signal?.addEventListener('abort', cancelled, { once: true });
  if (signal?.aborted) cancelled();
  return {
    request(type, data = {}, transfer = []) {
      if (signal?.aborted) return Promise.reject(abortError());
      if (disposed) return Promise.reject(new Error('GIF 변환이 종료되었습니다.'));
      return new Promise((resolve, reject) => {
        const id = ++sequence;
        const timeout = setTimeout(() => settle(new Error('GIF 변환 시간이 초과되었습니다. 다시 시도해 주세요.')), MEDIA_TIMEOUT_MS);
        pending = { id, resolve, reject, timeout };
        try { worker.postMessage({ id, type, ...data }, transfer); }
        catch (error) { settle(error); }
      });
    },
    dispose,
  };
}

/**
 * Decode locally with a muted video element, and quantize/encode in a worker.
 * At most one scaled RGBA frame is in flight. No microphone or audio playback
 * is involved, and failures leave the caller's original MP4 untouched.
 */
export async function exportGif(blob, {
  startSeconds = 0, endSeconds, onProgress = () => {}, signal, quality = 'original',
} = {}) {
  checkAbort(signal);
  getVideoQuality(quality);
  if (!(blob instanceof Blob) || !blob.size) throw new Error('GIF로 변환할 녹화 파일이 없습니다.');
  validateRange(startSeconds, endSeconds);
  const maxBytes = Math.min(GIF_MAX_OUTPUT_BYTES, GIF_MAX_COMBINED_BYTES - blob.size);
  if (maxBytes < 1024) {
    throw new Error('녹화 파일이 GIF 변환 한도를 넘었습니다. 더 짧게 녹화하거나 MP4로 저장해 주세요.');
  }
  const video = document.createElement('video');
  video.muted = true;
  video.playsInline = true;
  video.preload = 'auto';
  const url = URL.createObjectURL(blob);
  let client;
  let canvas;
  try {
    onProgress(0);
    checkAbort(signal);
    await mediaEvent(video, 'loadedmetadata', () => { video.src = url; video.load(); }, signal);
    // Some fragmented MediaRecorder files initially expose Infinity. Seeking
    // to the end lets the browser discover the final media timestamp.
    if (!Number.isFinite(video.duration)) {
      await mediaEvent(video, 'seeked', () => { video.currentTime = 1e10; }, signal);
    }
    checkAbort(signal);
    validateRange(startSeconds, endSeconds, video.duration);
    const rangeEnd = endSeconds ?? video.duration;
    const plan = createGifPlan(video.videoWidth, video.videoHeight, rangeEnd - startSeconds, quality);
    canvas = document.createElement('canvas');
    canvas.width = plan.width;
    canvas.height = plan.height;
    const context = canvas.getContext('2d', { alpha: false, willReadFrequently: true });
    if (!context) throw new Error('GIF 변환용 화면을 만들 수 없습니다.');
    client = workerClient(new Worker(new URL('./gif-worker.js', import.meta.url), { type: 'module' }), signal);
    await client.request('INIT', { width: plan.width, height: plan.height, maxBytes });
    for (let index = 0; index < plan.frames.length; index += 1) {
      checkAbort(signal);
      const frame = plan.frames[index];
      const sourceTime = startSeconds + frame.timeSeconds;
      if (Math.abs(video.currentTime - sourceTime) > 0.00001) {
        await mediaEvent(video, 'seeked', () => { video.currentTime = sourceTime; }, signal);
      }
      if (video.readyState < 2) await mediaEvent(video, 'loadeddata', undefined, signal);
      checkAbort(signal);
      context.drawImage(video, 0, 0, plan.width, plan.height);
      const pixels = context.getImageData(0, 0, plan.width, plan.height).data;
      await client.request('FRAME', { pixels: pixels.buffer, delayMs: frame.delayMs }, [pixels.buffer]);
      onProgress((index + 1) / (plan.frameCount + 1));
    }
    checkAbort(signal);
    const { buffer, byteLength } = await client.request('FINISH');
    checkAbort(signal);
    const result = new Blob([new Uint8Array(buffer, 0, byteLength)], { type: 'image/gif' });
    onProgress(1);
    checkAbort(signal);
    return {
      blob: result, width: plan.width, height: plan.height,
      frameCount: plan.frameCount, durationSeconds: plan.durationSeconds,
      startSeconds, endSeconds: rangeEnd,
    };
  } finally {
    client?.dispose();
    try { video.pause(); } catch { /* Continue releasing the remaining resources. */ }
    try { video.removeAttribute('src'); video.load(); } catch { /* A failed decoder may already be closed. */ }
    URL.revokeObjectURL(url);
    if (canvas) { canvas.width = 0; canvas.height = 0; }
  }
}
