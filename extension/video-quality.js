const PRESETS = Object.freeze({
  original: Object.freeze({ id: 'original', maxWidth: 1920, maxHeight: 1080,
    frameRate: 30, videoBitsPerSecond: 5_000_000, gifMaxDimension: 640, gifFrameRate: 10 }),
  balanced: Object.freeze({ id: 'balanced', maxWidth: 1280, maxHeight: 720,
    frameRate: 24, videoBitsPerSecond: 1_800_000, gifMaxDimension: 480, gifFrameRate: 8 }),
  small: Object.freeze({ id: 'small', maxWidth: 854, maxHeight: 480,
    frameRate: 15, videoBitsPerSecond: 600_000, gifMaxDimension: 320, gifFrameRate: 6 }),
});

export function getVideoQuality(value = 'original') {
  if (typeof value !== 'string' || !Object.hasOwn(PRESETS, value)) {
    throw new Error('저장 화질을 원본·높음, 보통, 저용량 중에서 선택해 주세요.');
  }
  return PRESETS[value];
}

export function qualitySuffix(value, format = 'mp4') {
  const profile = getVideoQuality(value);
  if (profile.id === 'original') return '';
  return format === 'gif' ? `-${profile.gifMaxDimension}px` : `-${profile.maxHeight}p`;
}
