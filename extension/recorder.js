import { inspectMp4, trimMp4 } from './mp4-trim.js';
import { createVideoCropper, validateVideoRegion } from './video-crop.js';
import { exportGif } from './gif-export.js';

export const MAX_RECORDING_BYTES = 128 * 1024 * 1024;
export const MAX_RECORDING_MS = 2 * 60 * 60 * 1000;

const ACTIVE_STATUSES = new Set(['recording', 'paused', 'stopping']);
const DOWNLOAD_STATUSES = new Set(['idle', 'pending', 'complete', 'interrupted']);

function initialState() {
  return {
    status: 'idle',
    mode: 'audio',
    selectionToken: null,
    selectionUrl: null,
    gifResult: null,
    exportProgress: 0,
    tab: null,
    elapsedMs: 0,
    bytes: 0,
    level: 0,
    error: null,
    notice: null,
    result: null,
    selection: null,
    exportResult: null,
    download: { id: null, status: 'idle', error: null },
  };
}

function errorMessage(error) {
  const detail = error?.message || String(error || '알 수 없는 오류');
  if (error?.name === 'NotAllowedError' || error?.name === 'PermissionDeniedError') {
    return '이 탭의 소리를 가져올 수 없습니다. 일반 웹페이지에서 확장 프로그램을 다시 열고 녹음을 시작해 주세요.';
  }
  if (error?.name === 'NotFoundError') {
    return '녹음할 탭의 오디오를 찾지 못했습니다. 탭을 열고 다시 시도해 주세요.';
  }
  return detail;
}

function recordingFilename(title, date) {
  const safeTitle = Array.from(String(title || 'tab')
    .replace(/[<>:"/\\|?*\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/g, '')).slice(0, 40).join('') || 'tab';
  const timestamp = date.toISOString().replace(/[:.]/g, '-');
  return `withoutmic-${safeTitle}-${timestamp}.mp4`;
}

/**
 * Owns browser media resources. All dependencies are injectable so lifecycle
 * behavior can be tested without requesting any device or browser permission.
 */
export class TabAudioRecorder {
  constructor(options = {}) {
    this.mediaDevices = options.mediaDevices ?? globalThis.navigator?.mediaDevices;
    this.MediaRecorder = options.MediaRecorder ?? globalThis.MediaRecorder;
    this.AudioContext = options.AudioContext ?? globalThis.AudioContext;
    this.MediaStream = options.MediaStream ?? globalThis.MediaStream;
    this.createVideoCropper = options.createVideoCropper ?? createVideoCropper;
    this.url = options.url ?? globalThis.URL;
    this.Blob = options.Blob ?? globalThis.Blob;
    this.now = options.now ?? (() => performance.now());
    this.wallNow = options.wallNow ?? (() => new Date());
    this.setInterval = options.setInterval ?? globalThis.setInterval.bind(globalThis);
    this.clearInterval = options.clearInterval ?? globalThis.clearInterval.bind(globalThis);
    this.maxBytes = options.maxBytes ?? MAX_RECORDING_BYTES;
    this.maxDurationMs = options.maxDurationMs ?? MAX_RECORDING_MS;
    this.onStateChange = options.onStateChange ?? (() => {});
    this.inspectMp4 = options.inspectMp4 ?? inspectMp4;
    this.trimMp4 = options.trimMp4 ?? trimMp4;
    this.exportGif = options.exportGif ?? exportGif;
    this.originalBlob = null;
    this.exportRange = null;

    this.state = initialState();
    this.operations = Promise.resolve();
    this.stream = null;
    this.cropper = null;
    this.videoDimensions = null;
    this.startingVideoError = null;
    this.context = null;
    this.source = null;
    this.analyser = null;
    this.samples = null;
    this.mediaRecorder = null;
    this.recordingMimeType = null;
    this.trackListeners = [];
    this.chunks = [];
    this.recordedMs = 0;
    this.activeSince = null;
    this.limitTimer = null;
    this.stopPromise = null;
    this.resolveStop = null;
    this.finalizing = false;
  }

  getState() {
    let level = 0;
    if (this.state.status === 'recording' && this.analyser && this.samples) {
      try {
        this.analyser.getFloatTimeDomainData(this.samples);
        const meanSquare = this.samples.reduce((sum, sample) => sum + sample * sample, 0)
          / this.samples.length;
        level = Math.min(1, Math.sqrt(meanSquare) * 3);
      } catch {
        // A closing AudioContext must not prevent status requests.
      }
    }
    return {
      ...this.state,
      tab: this.state.tab ? { ...this.state.tab } : null,
      elapsedMs: this.elapsedMs(),
      level,
      result: this.state.result ? { ...this.state.result } : null,
      gifResult: this.state.gifResult ? { ...this.state.gifResult } : null,
      selection: this.state.selection ? { ...this.state.selection } : null,
      exportResult: this.state.exportResult ? { ...this.state.exportResult } : null,
      download: { ...this.state.download },
    };
  }

  handle(message = {}) {
    // Status polling must remain responsive while capture or finalization waits.
    if (message.type === 'STATUS') {
      return Promise.resolve({ ok: true, state: this.getState() });
    }
    if (['trimming', 'exporting'].includes(this.state.status)) {
      return Promise.resolve({ ok: false, error: '저장할 파일을 만드는 중이에요. 잠시 기다려 주세요.', state: this.getState() });
    }
    const operation = this.operations.then(async () => {
      try {
        switch (message.type) {
          case 'SELECT_VIDEO':
            this.selectVideo(message);
            break;
          case 'CANCEL_VIDEO':
            this.cancelVideo(message);
            break;
          case 'START':
            await this.start(message);
            break;
          case 'PAUSE':
            this.pause();
            break;
          case 'RESUME':
            this.resume();
            break;
          case 'STOP':
            await this.stop();
            if (this.state.status === 'error') throw new Error(this.state.error);
            break;
          case 'DISCARD':
            this.discard();
            break;
          case 'DOWNLOAD_UPDATE':
            this.updateDownload(message.download);
            break;
          case 'SET_SELECTION':
            this.setSelection(message);
            break;
          case 'PREPARE_EXPORT':
            await this.prepareExport(message);
            break;
          case 'PREPARE_GIF':
            await this.prepareGif();
            break;
          default:
            throw new Error('지원하지 않는 녹음 요청입니다.');
        }
        return { ok: true, state: this.getState() };
      } catch (error) {
        return { ok: false, error: errorMessage(error), state: this.getState() };
      }
    });
    this.operations = operation.then(() => undefined, () => undefined);
    return operation;
  }

  elapsedMs() {
    return Math.max(0, Math.round(this.recordedMs
      + (this.activeSince === null ? 0 : this.now() - this.activeSince)));
  }

  freezeElapsed() {
    if (this.activeSince !== null) {
      this.recordedMs += Math.max(0, this.now() - this.activeSince);
      this.activeSince = null;
    }
    this.state.elapsedMs = this.elapsedMs();
  }

  emit() {
    try {
      Promise.resolve(this.onStateChange(this.getState())).catch(() => {});
    } catch {
      // Losing a popup or service worker receiver does not end the recording.
    }
  }

  selectVideo({ tab, selectionToken }) {
    if (!['idle', 'error'].includes(this.state.status)) {
      throw new Error('현재 녹음을 끝내고 저장하거나 지운 뒤 화면 영역을 선택해 주세요.');
    }
    if (!Number.isInteger(tab?.id) || typeof selectionToken !== 'string' || !selectionToken) {
      throw new Error('화면을 선택할 탭 정보를 가져오지 못했습니다.');
    }
    this.disposeMedia();
    this.recordedMs = 0;
    this.activeSince = null;
    this.state = {
      ...initialState(), status: 'selecting', mode: 'video', selectionToken, selectionUrl: tab.url || null,
      tab: { id: tab.id, title: String(tab.title || '제목 없는 탭') },
    };
    this.emit();
  }

  cancelVideo({ selectionToken } = {}) {
    if (this.state.status !== 'selecting') return;
    if (selectionToken !== undefined && selectionToken !== this.state.selectionToken) {
      throw new Error('이전 화면 선택 요청은 취소할 수 없습니다.');
    }
    this.state = initialState();
    this.emit();
  }

  async start({ streamId, tab, mode = 'audio', region, selectionToken }) {
    if (mode !== 'audio' && mode !== 'video') throw new Error('지원하지 않는 녹화 모드입니다.');
    const isVideo = mode === 'video';
    if (isVideo) {
      if (this.state.status !== 'selecting' || !selectionToken || selectionToken !== this.state.selectionToken
        || tab?.id !== this.state.tab?.id) {
        throw new Error('화면 영역을 새로 선택한 뒤 녹화를 시작해 주세요.');
      }
      validateVideoRegion(region);
    } else if (!['idle', 'error'].includes(this.state.status)) {
      throw new Error('현재 녹음을 끝내고 저장하거나 지운 뒤 새 녹음을 시작해 주세요.');
    }
    if (typeof streamId !== 'string' || !streamId) {
      throw new Error('탭 오디오 권한을 가져오지 못했습니다. 다시 시작해 주세요.');
    }
    this.disposeMedia();
    this.state = { ...initialState(), status: 'starting', mode, tab: tab ? { id: tab.id, title: String(tab.title || '제목 없는 탭') } : null };
    this.chunks = [];
    this.recordedMs = 0;
    this.activeSince = null;
    this.finalizing = false;
    this.stopPromise = null;
    this.resolveStop = null;
    this.videoDimensions = null;
    this.startingVideoError = null;
    this.emit();

    try {
      if (!this.mediaDevices?.getUserMedia || !this.MediaRecorder || !this.AudioContext) {
        throw new Error('이 브라우저는 탭 오디오 녹음을 지원하지 않습니다. 최신 Chrome 또는 Edge를 사용해 주세요.');
      }
      const supportedTypes = isVideo
        ? ['video/mp4;codecs=avc1.420028,mp4a.40.2', 'video/mp4;codecs=avc1,mp4a.40.2',
          'video/mp4;codecs=vp9,opus', 'video/mp4;codecs=avc1,opus', 'video/mp4']
        : ['audio/mp4;codecs=mp4a.40.2', 'audio/mp4;codecs=opus', 'audio/mp4'];
      const mimeType = supportedTypes.find((type) => this.MediaRecorder.isTypeSupported?.(type));
      if (!mimeType) {
        throw new Error(isVideo
          ? '이 브라우저는 MP4 화면 녹화를 지원하지 않습니다. Chrome 또는 Edge를 최신 버전으로 업데이트해 주세요.'
          : '이 브라우저는 MP4 오디오 녹음을 지원하지 않습니다. Chrome 또는 Edge를 최신 버전으로 업데이트해 주세요.');
      }
      this.recordingMimeType = mimeType;
      // These mandatory constraints request ONLY the tab stream obtained by
      // chrome.tabCapture. There is deliberately no microphone fallback.
      this.stream = await this.mediaDevices.getUserMedia({
        audio: {
          mandatory: {
            chromeMediaSource: 'tab',
            chromeMediaSourceId: streamId,
          },
        },
        video: isVideo ? { mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: streamId } } : false,
      });
      if (!this.stream.getAudioTracks().length) {
        throw new Error('탭에서 오디오 스트림을 가져오지 못했습니다.');
      }

      let recordingStream = this.stream;
      if (isVideo) {
        if (!this.stream.getVideoTracks?.().length) throw new Error('탭에서 영상 스트림을 가져오지 못했습니다.');
        if (!this.MediaStream) throw new Error('이 브라우저에서 화면 녹화를 시작할 수 없습니다.');
        this.cropper = await this.createVideoCropper(this.stream, region, {
          onGeometryChanged: () => {
            const notice = '탭의 화면 크기가 바뀌어 녹화를 마쳤어요. 새 영역을 선택해 다시 녹화해 주세요.';
            if (this.state.status === 'starting') this.startingVideoError = new Error(notice);
            else this.stopAfterNotice(notice);
          },
        });
        if (this.startingVideoError) throw this.startingVideoError;
        this.videoDimensions = { width: this.cropper.width, height: this.cropper.height };
        recordingStream = new this.MediaStream([
          ...this.cropper.stream.getVideoTracks(), ...this.stream.getAudioTracks(),
        ]);
      }

      // Tab capture otherwise silences playback. This single connection restores
      // the sound to the user's speakers without recording another audio input.
      this.context = new this.AudioContext();
      this.source = this.context.createMediaStreamSource(this.stream);
      this.analyser = this.context.createAnalyser();
      this.analyser.fftSize = 2048;
      this.samples = new Float32Array(this.analyser.fftSize);
      this.source.connect(this.analyser);
      this.analyser.connect(this.context.destination);
      if (this.context.state === 'suspended') await this.context.resume();

      if (this.startingVideoError) throw this.startingVideoError;
      const options = { audioBitsPerSecond: 128000, mimeType, ...(isVideo ? { videoBitsPerSecond: 5000000 } : {}) };
      const recorder = new this.MediaRecorder(recordingStream, options);
      this.mediaRecorder = recorder;
      if (recorder.mimeType && !(isVideo ? /^video\/mp4(?:;|$)/i : /^audio\/mp4(?:;|$)/i).test(recorder.mimeType)) {
        throw new Error('브라우저가 MP4 대신 다른 녹음 형식을 반환했습니다. 최신 Chrome 또는 Edge에서 다시 시도해 주세요.');
      }
      this.stopPromise = new Promise((resolve) => { this.resolveStop = resolve; });

      recorder.ondataavailable = ({ data }) => {
        if (this.mediaRecorder !== recorder || !data?.size) return;
        this.chunks.push(data);
        this.state.bytes += data.size;
        this.checkLimits();
        this.emit();
      };
      recorder.onstop = () => {
        if (this.mediaRecorder === recorder) this.finalize();
      };
      recorder.onerror = (event) => {
        if (this.mediaRecorder !== recorder) return;
        this.state.error = errorMessage(event.error || new Error('녹음 중 오류가 발생했습니다.'));
        this.stopAfterNotice('녹음 중 오류가 발생해 중지했습니다. 생성된 파일이 있으면 저장해 주세요.');
      };
      for (const track of isVideo ? this.stream.getTracks() : this.stream.getAudioTracks()) {
        const onEnded = () => {
          if (this.mediaRecorder === recorder) {
            this.stopAfterNotice(isVideo ? '탭의 화면 또는 오디오 연결이 종료되어 녹화를 마쳤습니다.' : '탭의 오디오 연결이 종료되어 녹음을 마쳤습니다.');
          }
        };
        track.addEventListener('ended', onEnded);
        this.trackListeners.push({ track, onEnded });
      }
      recorder.start(1000);
      this.activeSince = this.now();
      this.state.status = 'recording';
      this.limitTimer = this.setInterval(() => this.checkLimits(), 1000);
      this.emit();
    } catch (error) {
      this.fail(error);
      throw error;
    }
  }

  pause() {
    if (this.state.status !== 'recording') throw new Error('녹음 중일 때만 일시정지할 수 있습니다.');
    this.mediaRecorder.pause();
    this.freezeElapsed();
    this.state.status = 'paused';
    this.emit();
  }

  resume() {
    if (this.state.status !== 'paused') throw new Error('일시정지한 녹음만 이어서 녹음할 수 있습니다.');
    this.mediaRecorder.resume();
    this.activeSince = this.now();
    this.state.status = 'recording';
    this.emit();
  }

  stop() {
    if (!ACTIVE_STATUSES.has(this.state.status)) throw new Error('현재 진행 중인 녹음이 없습니다.');
    if (this.state.status === 'stopping') return this.stopPromise;
    this.freezeElapsed();
    this.state.status = 'stopping';
    this.emit();
    const completion = this.stopPromise;
    try {
      // If a stream ended or the recorder failed, its stop event may already be
      // queued. Only that event runs finalize, after the final dataavailable.
      if (this.mediaRecorder.state !== 'inactive') this.mediaRecorder.stop();
    } catch (error) {
      this.fail(error);
    }
    return completion;
  }

  stopAfterNotice(notice) {
    if (!ACTIVE_STATUSES.has(this.state.status) || this.state.status === 'stopping') return;
    this.state.notice = notice;
    try {
      Promise.resolve(this.stop()).catch((error) => this.fail(error));
    } catch (error) {
      this.fail(error);
    }
  }

  checkLimits() {
    if (!['recording', 'paused'].includes(this.state.status)) return;
    if (this.state.bytes >= this.maxBytes) {
      this.stopAfterNotice('메모리 사용을 제한하기 위해 128 MiB에 도달하면 자동으로 녹음을 마칩니다. 파일을 저장해 주세요.');
    } else if (this.elapsedMs() >= this.maxDurationMs) {
      this.stopAfterNotice('최대 녹음 시간인 2시간에 도달해 자동으로 녹음을 마쳤습니다. 파일을 저장해 주세요.');
    }
  }

  async finalize() {
    if (this.finalizing) return;
    this.finalizing = true;
    this.freezeElapsed();
    const mimeType = this.mediaRecorder?.mimeType || this.recordingMimeType;
    this.disposeMedia();
    this.state.status = 'stopping';
    this.emit();
    try {
      const blob = new this.Blob(this.chunks, { type: mimeType });
      this.chunks = [];
      if (!blob.size) throw new Error('녹음된 데이터가 없습니다. 페이지에서 소리를 재생한 뒤 다시 녹음해 주세요.');
      let durationSeconds = null;
      let trimError = null;
      if (this.state.mode === 'video') {
        durationSeconds = this.elapsedMs() / 1000;
        trimError = '화면 녹화는 전체 영상만 저장할 수 있어요.';
      } else try {
        const metadata = await this.inspectMp4(blob);
        if (!Number.isFinite(metadata.durationSeconds) || metadata.durationSeconds <= 0) throw new Error('Invalid duration');
        durationSeconds = metadata.durationSeconds;
      } catch {
        trimError = '이 파일의 구간 정보를 읽지 못했어요. 전체 녹음은 그대로 저장할 수 있어요.';
      }
      const filename = recordingFilename(this.state.tab?.title, this.wallNow());
      const url = this.url.createObjectURL(blob);
      this.originalBlob = blob;
      this.state.result = { url, filename, mimeType, bytes: blob.size, durationSeconds, trimError,
        kind: this.state.mode, ...(this.state.mode === 'video' ? this.videoDimensions : {}) };
      this.state.selection = this.state.mode !== 'video' && durationSeconds ? { startSeconds: 0, endSeconds: durationSeconds } : null;
      this.state.bytes = blob.size;
      this.state.status = 'ready';
      this.chunks = [];
      this.resolveStop?.();
      this.resolveStop = null;
      this.emit();
    } catch (error) {
      this.fail(error);
    }
  }

  validateSelection({ startSeconds, endSeconds }) {
    if (this.state.status !== 'ready' || !this.state.result || !this.originalBlob) {
      throw new Error('녹음을 끝낸 뒤 구간을 선택해 주세요.');
    }
    if (this.state.mode === 'video') throw new Error('화면 녹화는 전체 영상만 저장할 수 있어요.');
    if (this.state.download.status === 'pending') throw new Error('파일 저장이 끝난 뒤 구간을 변경해 주세요.');
    const duration = this.state.result.durationSeconds;
    if (!Number.isFinite(duration) || duration <= 0) throw new Error('구간 정보를 읽지 못했어요. 전체 저장을 사용해 주세요.');
    if (!Number.isFinite(startSeconds) || !Number.isFinite(endSeconds) || startSeconds < 0 ||
        endSeconds <= startSeconds || endSeconds > duration) {
      throw new Error('시작과 끝을 녹음 길이 안에서 입력해 주세요. 끝은 시작보다 뒤여야 해요.');
    }
    return { startSeconds, endSeconds };
  }

  setSelection(message) {
    this.state.selection = this.validateSelection(message);
    this.emit();
  }

  async prepareExport(message) {
    const selection = this.validateSelection(message);
    this.state.selection = selection;
    if (this.state.exportResult && this.exportRange?.startSeconds === selection.startSeconds &&
        this.exportRange?.endSeconds === selection.endSeconds) {
      this.emit();
      return;
    }
    this.state.status = 'trimming';
    this.emit();
    try {
      const clip = await this.trimMp4(this.originalBlob, selection.startSeconds, selection.endSeconds);
      if (!clip.blob?.size || !Number.isFinite(clip.durationSeconds) || clip.durationSeconds <= 0) {
        throw new Error('선택한 구간의 파일을 만들지 못했어요. 다른 구간으로 다시 시도해 주세요.');
      }
      const url = this.url.createObjectURL(clip.blob);
      const suffix = `${selection.startSeconds.toFixed(2)}-${selection.endSeconds.toFixed(2)}s`;
      const previousUrl = this.state.exportResult?.url;
      this.state.exportResult = {
        url, filename: this.state.result.filename.replace(/\.mp4$/i, `-clip-${suffix}.mp4`),
        mimeType: clip.blob.type || this.state.result.mimeType, bytes: clip.blob.size,
        durationSeconds: clip.durationSeconds, startSeconds: clip.startSeconds, endSeconds: clip.endSeconds,
      };
      this.exportRange = { ...selection };
      if (previousUrl) this.url.revokeObjectURL(previousUrl);
    } finally {
      // A trim failure leaves the original and the previous export available.
      this.state.status = 'ready';
      this.emit();
    }
  }

  async prepareGif() {
    if (this.state.status !== 'ready' || this.state.result?.kind !== 'video' || !this.originalBlob) {
      throw new Error('화면 녹화를 마친 뒤 GIF로 저장할 수 있어요.');
    }
    if (this.state.download.status === 'pending') throw new Error('진행 중인 저장을 먼저 마쳐 주세요.');
    if (this.state.gifResult) return;
    this.state.status = 'exporting';
    this.state.exportProgress = 0;
    this.emit();
    try {
      const output = await this.exportGif(this.originalBlob, { onProgress: (value) => {
        this.state.exportProgress = Math.max(0, Math.min(1, Number(value) || 0));
        this.emit();
      } });
      if (!output.blob?.size || output.blob.type !== 'image/gif') throw new Error('GIF 파일을 만들지 못했어요. MP4 원본은 저장할 수 있어요.');
      this.state.gifResult = {
        url: this.url.createObjectURL(output.blob), filename: this.state.result.filename.replace(/\.mp4$/i, '.gif'),
        mimeType: 'image/gif', bytes: output.blob.size, width: output.width, height: output.height,
        frameCount: output.frameCount, durationSeconds: output.durationSeconds,
      };
    } finally {
      this.state.status = 'ready';
      this.emit();
    }
  }

  updateDownload(download) {
    if (this.state.status !== 'ready' || !this.state.result) {
      throw new Error('저장할 녹음 파일이 없습니다.');
    }
    if (!download || !DOWNLOAD_STATUSES.has(download.status)
      || (download.id !== null && (!Number.isInteger(download.id) || download.id < 0))) {
      throw new Error('잘못된 다운로드 상태입니다.');
    }
    if (['complete', 'interrupted'].includes(download.status)
      && (download.id !== this.state.download.id
        || (this.state.download.status !== 'pending' && this.state.download.status !== download.status))) {
      throw new Error('이 녹음의 진행 중인 다운로드가 아닙니다.');
    }
    this.state.download = { id: download.id, status: download.status, error: download.error || null };
    // Keep the Blob URL for retries after a cancelled or failed download.
    this.emit();
  }

  discard() {
    if (this.state.status === 'selecting') {
      this.cancelVideo();
      return;
    }
    if (!['ready', 'error'].includes(this.state.status)) {
      throw new Error('진행 중인 녹음을 먼저 중지해 주세요.');
    }
    if (this.state.download.status === 'pending') {
      throw new Error('파일 저장이 끝난 뒤 녹음을 지울 수 있습니다.');
    }
    if (this.state.result?.url) this.url.revokeObjectURL(this.state.result.url);
    if (this.state.exportResult?.url) this.url.revokeObjectURL(this.state.exportResult.url);
    if (this.state.gifResult?.url) this.url.revokeObjectURL(this.state.gifResult.url);
    this.originalBlob = null;
    this.exportRange = null;
    this.disposeMedia();
    this.chunks = [];
    this.recordedMs = 0;
    this.activeSince = null;
    this.state = initialState();
    this.emit();
  }

  fail(error) {
    this.freezeElapsed();
    this.disposeMedia();
    this.chunks = [];
    this.state.status = 'error';
    this.state.error = errorMessage(error);
    this.state.result = null;
    this.resolveStop?.();
    this.resolveStop = null;
    this.emit();
  }

  disposeMedia() {
    if (this.limitTimer !== null) this.clearInterval(this.limitTimer);
    this.limitTimer = null;
    for (const { track, onEnded } of this.trackListeners) {
      track.removeEventListener('ended', onEnded);
    }
    this.trackListeners = [];
    if (this.mediaRecorder) {
      this.mediaRecorder.ondataavailable = null;
      this.mediaRecorder.onstop = null;
      this.mediaRecorder.onerror = null;
      try {
        if (this.mediaRecorder.state !== 'inactive') this.mediaRecorder.stop();
      } catch { /* An already failed recorder still needs stream cleanup. */ }
      this.mediaRecorder = null;
    }
    try { this.cropper?.dispose(); } catch { /* Other media still needs cleanup. */ }
    this.cropper = null;
    try { this.source?.disconnect(); } catch { /* Already disconnected. */ }
    try { this.analyser?.disconnect(); } catch { /* Already disconnected. */ }
    this.source = null;
    this.analyser = null;
    this.samples = null;
    if (this.stream) {
      for (const track of this.stream.getTracks()) track.stop();
      this.stream = null;
    }
    if (this.context) {
      try { Promise.resolve(this.context.close()).catch(() => {}); } catch { /* Already closed. */ }
      this.context = null;
    }
  }
}
