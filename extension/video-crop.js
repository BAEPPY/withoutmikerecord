const MAX_WIDTH = 1920;
const MAX_HEIGHT = 1080;
const FRAME_RATE = 30;
const READY_TIMEOUT_MS = 10000;

/** Region coordinates are fractions of the tab viewport, not physical pixels. */
export function validateVideoRegion(region) {
  if (!region || !['x', 'y', 'width', 'height', 'viewportWidth', 'viewportHeight']
    .every((key) => Number.isFinite(region[key]))) {
    throw new Error('녹화할 화면 영역을 다시 선택해 주세요.');
  }
  const { x, y, width, height, viewportWidth, viewportHeight } = region;
  if (x < 0 || y < 0 || width <= 0 || height <= 0 || x + width > 1 + 1e-6 || y + height > 1 + 1e-6
    || viewportWidth < 1 || viewportHeight < 1 || width * viewportWidth < 16 || height * viewportHeight < 16) {
    throw new Error('화면 안에서 가로와 세로가 각각 16픽셀 이상인 영역을 선택해 주세요.');
  }
  return { x, y, width, height, viewportWidth, viewportHeight };
}

export function videoCropDimensions(region, sourceWidth, sourceHeight) {
  validateVideoRegion(region);
  if (!Number.isFinite(sourceWidth) || !Number.isFinite(sourceHeight) || sourceWidth < 2 || sourceHeight < 2) {
    throw new Error('탭의 화면 크기를 읽지 못했습니다.');
  }
  const expectedAspect = region.viewportWidth / region.viewportHeight;
  if (Math.abs((sourceWidth / sourceHeight) / expectedAspect - 1) > 0.02) {
    throw new Error('영역을 선택한 뒤 화면 크기가 바뀌었어요. 다시 선택해 주세요.');
  }
  const cropWidth = Math.min(sourceWidth - region.x * sourceWidth, region.width * sourceWidth);
  const cropHeight = Math.min(sourceHeight - region.y * sourceHeight, region.height * sourceHeight);
  const scale = Math.min(1, MAX_WIDTH / cropWidth, MAX_HEIGHT / cropHeight);
  return {
    x: region.x * sourceWidth,
    y: region.y * sourceHeight,
    cropWidth,
    cropHeight,
    width: Math.max(2, Math.floor(cropWidth * scale / 2) * 2),
    height: Math.max(2, Math.floor(cropHeight * scale / 2) * 2),
  };
}

/** Converts the selected part of a live tab video into a bounded canvas stream. */
export async function createVideoCropper(stream, requestedRegion, options = {}) {
  const region = validateVideoRegion(requestedRegion);
  const document = options.document ?? globalThis.document;
  const setTimeout = options.setTimeout ?? globalThis.setTimeout.bind(globalThis);
  const clearTimeout = options.clearTimeout ?? globalThis.clearTimeout.bind(globalThis);
  const setInterval = options.setInterval ?? globalThis.setInterval.bind(globalThis);
  const clearInterval = options.clearInterval ?? globalThis.clearInterval.bind(globalThis);
  const onGeometryChanged = options.onGeometryChanged ?? (() => {});
  const now = options.now ?? (() => performance.now());
  if (!document?.createElement) throw new Error('이 브라우저에서 화면 녹화를 시작할 수 없습니다.');
  const video = document.createElement('video');
  const canvas = document.createElement('canvas');
  video.muted = true;
  video.playsInline = true;
  video.srcObject = stream;
  let output = null;
  let frameId = null;
  let timer = null;
  let disposed = false;
  let invalid = false;
  let removeReadyListeners = () => {};
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    removeReadyListeners();
    if (frameId !== null) video.cancelVideoFrameCallback?.(frameId);
    if (timer !== null) clearInterval(timer);
    for (const track of output?.getTracks() ?? []) track.stop();
    try { video.pause(); } catch { /* The source may already have ended. */ }
    video.srcObject = null;
    canvas.width = 0;
    canvas.height = 0;
  };
  try {
    await new Promise((resolve, reject) => {
      let timeout;
      let settled = false;
      const cleanup = () => {
        clearTimeout(timeout);
        video.removeEventListener('loadeddata', ready);
        video.removeEventListener('resize', ready);
        video.removeEventListener('error', failed);
      };
      removeReadyListeners = cleanup;
      const finish = (error) => {
        if (settled) return;
        settled = true;
        cleanup();
        if (error) reject(error); else resolve();
      };
      const ready = () => {
        if (video.readyState >= 2 && video.videoWidth > 0 && video.videoHeight > 0) finish();
      };
      const failed = () => finish(new Error('탭 화면을 읽지 못했습니다. 다시 시작해 주세요.'));
      video.addEventListener('loadeddata', ready);
      video.addEventListener('resize', ready);
      video.addEventListener('error', failed);
      timeout = setTimeout(() => finish(new Error('탭 화면을 기다리는 시간이 초과됐어요. 다시 시작해 주세요.')), READY_TIMEOUT_MS);
      Promise.resolve(video.play()).then(ready, (error) => finish(error));
      ready();
    });
    const sourceWidth = video.videoWidth;
    const sourceHeight = video.videoHeight;
    const dimensions = videoCropDimensions(region, sourceWidth, sourceHeight);
    canvas.width = dimensions.width;
    canvas.height = dimensions.height;
    const context = canvas.getContext('2d', { alpha: false });
    if (!context || !canvas.captureStream) throw new Error('이 브라우저는 선택 영역의 화면 녹화를 지원하지 않습니다.');
    let lastDraw = -Infinity;
    const frameInterval = 1000 / FRAME_RATE;
    const draw = () => {
      if (disposed || invalid) return;
      if (video.videoWidth !== sourceWidth || video.videoHeight !== sourceHeight) {
        invalid = true;
        onGeometryChanged();
        return;
      }
      const timestamp = now();
      // A frame callback and the fallback timer may arrive together. Render at
      // most once per frame interval while keeping geometry checks immediate.
      if (video.readyState >= 2 && timestamp - lastDraw >= frameInterval * 0.9) {
        context.drawImage(video, dimensions.x, dimensions.y, dimensions.cropWidth, dimensions.cropHeight,
          0, 0, dimensions.width, dimensions.height);
        lastDraw = timestamp;
      }
    };
    draw();
    output = canvas.captureStream(FRAME_RATE);
    if (!output.getVideoTracks().length) throw new Error('선택 영역의 영상 스트림을 만들지 못했습니다.');
    if (video.requestVideoFrameCallback) {
      const nextFrame = () => {
        draw();
        if (!disposed && !invalid) frameId = video.requestVideoFrameCallback(nextFrame);
      };
      frameId = video.requestVideoFrameCallback(nextFrame);
    }
    // Offscreen documents may receive no compositor-driven frame callbacks.
    // This timer continues drawing the live video there; recent frame callbacks
    // make its draw call a cheap no-op instead of copying the same frame twice.
    timer = setInterval(draw, frameInterval);
    return { stream: output, width: dimensions.width, height: dimensions.height, dispose };
  } catch (error) {
    dispose();
    throw error;
  }
}
