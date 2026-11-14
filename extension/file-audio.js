import { selectMp4Tracks } from './mp4-tracks.js';
import { inspectMp4 } from './mp4-trim.js';

export const FILE_AUDIO_MAX_BYTES = 128 * 1024 * 1024;
export const FILE_AUDIO_MAX_SECONDS = 2 * 60 * 60;
const TIMEOUT_MS = 30_000;
const AUDIO_TYPES = ['audio/mp4;codecs=mp4a.40.2', 'audio/mp4;codecs=opus', 'audio/mp4'];
const NO_AUDIO = '이 파일에는 소리 트랙이 없어요. 소리가 포함된 파일을 선택해 주세요.';
const UNREADABLE = '이 파일의 미디어 형식이나 코덱을 브라우저에서 읽을 수 없어요. 재생 가능한 MP4, MOV, WebM 파일을 선택해 주세요.';

function abortError() {
  const error = new Error('소리 추출을 취소했어요. 원본 파일은 그대로 남아 있어요.');
  error.name = 'AbortError';
  return error;
}

function checkAbort(signal) { if (signal?.aborted) throw abortError(); }

function validateDuration(duration) {
  if (!Number.isFinite(duration) || duration <= 0) throw new Error('파일의 재생 시간을 읽지 못했어요. 다른 파일을 선택해 주세요.');
  if (duration > FILE_AUDIO_MAX_SECONDS) throw new Error('소리는 최대 2시간 길이의 파일에서 추출할 수 있어요. 더 짧은 파일을 선택해 주세요.');
}

function waitMedia(video, event, trigger, env, signal) {
  checkAbort(signal);
  return new Promise((resolve, reject) => {
    let timer;
    let settled = false;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      env.clearTimeout(timer);
      video.removeEventListener(event, success);
      video.removeEventListener('error', failure);
      signal?.removeEventListener('abort', aborted);
      if (error) reject(error); else resolve();
    };
    const success = () => finish();
    const failure = () => finish(new Error(UNREADABLE));
    const aborted = () => finish(abortError());
    video.addEventListener(event, success);
    video.addEventListener('error', failure);
    signal?.addEventListener('abort', aborted, { once: true });
    timer = env.setTimeout(() => finish(new Error('파일을 읽는 시간이 초과됐어요. 재생 가능한 다른 파일로 다시 시도해 주세요.')), TIMEOUT_MS);
    try { trigger?.(); } catch { finish(new Error(UNREADABLE)); }
  });
}

function waitPromise(promise, env, signal) {
  return new Promise((resolve, reject) => {
    let timer;
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      env.clearTimeout(timer);
      signal?.removeEventListener('abort', aborted);
      if (error) reject(error); else resolve(value);
    };
    const aborted = () => finish(abortError());
    // Observe the underlying promise even if starting it synchronously aborted
    // the caller (for example, a copy progress callback cancelling the job).
    // Its later rejection must not become an unhandled rejection.
    Promise.resolve(promise).then((value) => finish(null, value), (error) => finish(error));
    if (signal?.aborted) { aborted(); return; }
    signal?.addEventListener('abort', aborted, { once: true });
    timer = env.setTimeout(() => finish(new Error('소리 변환을 준비하는 시간이 초과됐어요. 이 탭에서 다시 시도해 주세요.')), TIMEOUT_MS);
  });
}

/** Dependencies are injectable; extraction never requests capture permissions. */
export function createFileAudioExtractor(overrides = {}) {
  const env = {
    document: globalThis.document,
    MediaRecorder: globalThis.MediaRecorder,
    AudioContext: globalThis.AudioContext,
    Blob: globalThis.Blob,
    url: globalThis.URL,
    now: () => performance.now(),
    setTimeout: globalThis.setTimeout.bind(globalThis),
    clearTimeout: globalThis.clearTimeout.bind(globalThis),
    setInterval: globalThis.setInterval.bind(globalThis),
    clearInterval: globalThis.clearInterval.bind(globalThis),
    selectMp4Tracks,
    inspectMp4,
    ...overrides,
  };

  async function extract(blob, { signal, onProgress = () => {}, onStage = () => {} } = {}) {
    checkAbort(signal);
    if (!(blob instanceof env.Blob) || !blob.size) throw new Error('소리를 추출할 파일을 선택해 주세요. 빈 파일은 사용할 수 없어요.');
    if (blob.size > FILE_AUDIO_MAX_BYTES) throw new Error('파일은 128 MiB 이하로 선택해 주세요. 더 큰 파일은 먼저 짧게 나눠 주세요.');
    let progress = 0;
    const report = (value) => {
      progress = Math.max(progress, Math.min(1, value));
      onProgress(progress);
      checkAbort(signal);
    };
    const stage = (value) => { onStage(value); checkAbort(signal); };
    stage('reading');
    report(0);
    // Use container bytes as well as MIME: Files from a file picker can have an
    // empty type, and QuickTime MOV may start with wide/free/mdat before moov.
    const header = new Uint8Array(await waitPromise(blob.slice(0, 64).arrayBuffer(), env, signal));
    const box = String.fromCharCode(...header.subarray(4, 8));
    const mp4 = ['ftyp', 'moov', 'mdat', 'wide', 'free', 'skip'].includes(box)
      || /^(?:audio|video)\/(?:mp4|quicktime)(?:;|$)/i.test(blob.type);
    if (mp4) {
      stage('copying');
      let copied;
      let copying = true;
      const copyController = new AbortController();
      const cancelCopy = () => copyController.abort();
      signal?.addEventListener('abort', cancelCopy, { once: true });
      try {
        checkAbort(signal);
        copied = await waitPromise(env.selectMp4Tracks(blob, 'audio', {
          signal: copyController.signal,
          onProgress: (value) => {
            if (copying && !copyController.signal.aborted) report(0.02 + value * 0.88);
          },
        }), env, signal);
      } catch (error) {
        checkAbort(signal);
        if (error?.name === 'AbortError') throw error;
        if (/소리 트랙이 없/.test(error?.message || '')) throw new Error(NO_AUDIO);
        // Unusual MP4 layouts/codecs may still be playable. The bounded browser
        // decoder fallback also supports WebM and ordinary audio-only files.
      } finally {
        copying = false;
        // Blob.arrayBuffer itself cannot be aborted. If its read finishes after
        // cancellation/timeout, the copier's signal prevents parsing/remuxing
        // and its late callbacks cannot update a fallback or a subsequent job.
        cancelCopy();
        signal?.removeEventListener('abort', cancelCopy);
      }
      if (copied) {
        checkAbort(signal);
        validateDuration(copied.durationSeconds);
        if (!(copied.blob instanceof env.Blob) || !copied.blob.size || copied.blob.size > FILE_AUDIO_MAX_BYTES
          || !/^audio\/mp4(?:;|$)/i.test(copied.mimeType)) throw new Error('소리를 MP4 파일로 추출하지 못했어요.');
        stage('finishing');
        report(1);
        return { blob: copied.blob, mimeType: copied.mimeType, durationSeconds: copied.durationSeconds, method: 'copy' };
      }
    }

    let video, url, context, source, destination, probe, recorder;
    let interval = null;
    let removeListeners = () => {};
    let chunks = [];
    try {
      if (!env.document?.createElement || !env.AudioContext) throw new Error('이 브라우저에서는 파일의 소리를 변환할 수 없어요. Chrome 또는 Edge를 업데이트해 주세요.');
      video = env.document.createElement('video');
      video.muted = true;
      video.playsInline = true;
      video.preload = 'auto';
      url = env.url.createObjectURL(blob);
      await waitMedia(video, 'loadedmetadata', () => { video.src = url; video.load(); }, env, signal);
      // Fragmented WebM/MP4 can expose Infinity until a seek discovers its end.
      if (!Number.isFinite(video.duration)) {
        await waitMedia(video, 'seeked', () => { video.currentTime = 1e10; }, env, signal);
      }
      validateDuration(video.duration);
      if (video.currentTime > 0) await waitMedia(video, 'seeked', () => { video.currentTime = 0; }, env, signal);
      if (video.readyState < 2) await waitMedia(video, 'loadeddata', undefined, env, signal);
      checkAbort(signal);
      if (!video.captureStream) throw new Error('이 브라우저에서는 파일의 소리 트랙을 확인할 수 없어요. Chrome 또는 Edge를 업데이트해 주세요.');
      probe = video.captureStream();
      const hasAudio = probe.getAudioTracks().length > 0;
      for (const track of probe.getTracks()) track.stop();
      probe = null;
      if (!hasAudio) throw new Error(NO_AUDIO);
      const mimeType = AUDIO_TYPES.find((type) => env.MediaRecorder?.isTypeSupported?.(type));
      if (!mimeType) throw new Error('이 브라우저는 MP4 소리 저장을 지원하지 않아요. Chrome 또는 Edge를 업데이트해 주세요.');
      context = new env.AudioContext();
      source = context.createMediaElementSource(video);
      destination = context.createMediaStreamDestination();
      source.connect(destination);
      // Route audio only to the recorder, never context.destination (speakers).
      // Muting the element would also mute MediaElementAudioSource output.
      video.muted = false;
      video.volume = 1;
      if (context.state === 'suspended') await waitPromise(context.resume(), env, signal);
      checkAbort(signal);
      if (!destination.stream.getAudioTracks().length) throw new Error('소리 변환용 오디오 트랙을 준비하지 못했어요.');
      recorder = new env.MediaRecorder(destination.stream, { mimeType, audioBitsPerSecond: 128000 });
      if (recorder.mimeType && !/^audio\/mp4(?:;|$)/i.test(recorder.mimeType)) throw new Error('브라우저가 소리를 MP4 형식으로 만들지 못했어요.');
      stage('encoding');
      report(0.05);
      await new Promise((resolve, reject) => {
        let settled = false, stopping = false, stopTimer = null, bytes = 0;
        let lastTime = video.currentTime;
        let lastAdvance = env.now();
        const began = lastAdvance;
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
          try { source.disconnect(); } catch { /* Already closed. */ }
          try {
            stage('finishing');
            if (recorder.state === 'inactive') throw new Error('소리 변환이 예기치 않게 종료됐어요. 다시 시도해 주세요.');
            stopTimer = env.setTimeout(() => finish(new Error('MP4 소리 파일을 마무리하는 시간이 초과됐어요. 다시 시도해 주세요.')), TIMEOUT_MS);
            recorder.stop();
          } catch (error) { finish(error); }
        };
        const ended = () => {
          if (video.currentTime < video.duration - 0.1) {
            finish(new Error('파일 재생이 끝나기 전에 멈춰 소리를 모두 추출하지 못했어요. 파일이 손상되지 않았는지 확인해 주세요.'));
          } else stop();
        };
        const tick = () => {
          if (settled || stopping) return;
          try {
            const current = video.currentTime, now = env.now();
            if (current > lastTime + 0.00001) { lastTime = current; lastAdvance = now; }
            if (video.ended) { ended(); return; }
            if (current >= video.duration) { stop(); return; }
            if (now - lastAdvance > TIMEOUT_MS || now - began > video.duration * 1000 + TIMEOUT_MS) {
              throw new Error('파일 재생이 멈춰 소리 변환을 끝내지 못했어요. 다시 시도해 주세요.');
            }
            report(0.05 + Math.min(1, current / video.duration) * 0.9);
          } catch (error) { finish(error); }
        };
        const aborted = () => finish(abortError());
        const failed = () => finish(new Error(UNREADABLE));
        removeListeners = () => {
          if (stopTimer !== null) env.clearTimeout(stopTimer);
          stopTimer = null;
          if (interval !== null) env.clearInterval(interval);
          interval = null;
          signal?.removeEventListener('abort', aborted);
          video.removeEventListener('error', failed);
          video.removeEventListener('ended', ended);
        };
        signal?.addEventListener('abort', aborted, { once: true });
        video.addEventListener('error', failed);
        video.addEventListener('ended', ended);
        recorder.ondataavailable = ({ data }) => {
          if (settled || !data?.size) return;
          bytes += data.size;
          if (bytes > FILE_AUDIO_MAX_BYTES) { finish(new Error('추출한 소리가 128 MiB를 넘었어요. 더 짧은 파일을 선택해 주세요.')); return; }
          chunks.push(data);
        };
        recorder.onstop = () => finish(stopping ? undefined : new Error('소리 변환이 예기치 않게 종료됐어요. 다시 시도해 주세요.'));
        recorder.onerror = () => finish(new Error('MP4 소리 파일을 만들지 못했어요. 브라우저를 업데이트하거나 다른 파일을 선택해 주세요.'));
        try {
          checkAbort(signal);
          recorder.start(250);
          interval = env.setInterval(tick, 50);
          Promise.resolve(video.play()).catch(() => finish(new Error('파일 재생을 시작하지 못했어요. 이 탭에서 다시 시도해 주세요.')));
        } catch (error) { finish(error); }
      });
      checkAbort(signal);
      const result = new env.Blob(chunks, { type: recorder.mimeType || mimeType });
      chunks = [];
      if (!result.size) throw new Error('파일에서 저장할 소리를 만들지 못했어요. 다른 파일로 다시 시도해 주세요.');
      const measured = await waitPromise(env.inspectMp4(result), env, signal);
      validateDuration(measured.durationSeconds);
      report(1);
      return { blob: result, mimeType: result.type, durationSeconds: measured.durationSeconds, method: 'encode' };
    } catch (error) {
      if (error?.name === 'NotSupportedError' || error?.name === 'EncodingError') throw new Error(UNREADABLE);
      if (error?.name === 'NotAllowedError' || error?.name === 'SecurityError') {
        throw new Error('브라우저에서 파일 재생을 허용하지 않았어요. 이 탭에서 다시 시도해 주세요.');
      }
      throw error;
    } finally {
      removeListeners();
      if (recorder) {
        recorder.ondataavailable = null;
        recorder.onstop = null;
        recorder.onerror = null;
        try { if (recorder.state !== 'inactive') recorder.stop(); } catch { /* Failed encoder. */ }
      }
      try { video?.pause(); } catch { /* Failed decoder. */ }
      try { source?.disconnect(); } catch { /* Already disconnected. */ }
      for (const track of probe?.getTracks() ?? []) track.stop();
      for (const track of destination?.stream.getTracks() ?? []) track.stop();
      if (context) { try { await context.close(); } catch { /* Already closed. */ } }
      if (video) {
        video.muted = true;
        video.removeAttribute('src');
        try { video.load(); } catch { /* Already closed. */ }
      }
      if (url) env.url.revokeObjectURL(url);
      chunks = [];
    }
  }

  return { extractFileAudio: extract };
}

/** Extract a local file's audio without microphone, tab capture, or uploads. */
export function extractFileAudio(blob, options) {
  return createFileAudioExtractor().extractFileAudio(blob, options);
}
