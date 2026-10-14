import { GIFEncoder, quantize, applyPalette } from './vendor/gifenc/gifenc.esm.js';

let encoder;
let width;
let height;
let maxBytes;

self.onmessage = ({ data }) => {
  const { id, type } = data;
  try {
    if (type === 'INIT') {
      ({ width, height, maxBytes } = data);
      encoder = GIFEncoder();
    } else if (type === 'FRAME' && encoder) {
      const pixels = new Uint8ClampedArray(data.pixels);
      if (pixels.length !== width * height * 4) throw new Error('GIF 프레임 크기가 올바르지 않습니다.');
      const palette = quantize(pixels, 256, { format: 'rgb565' });
      const indexed = applyPalette(pixels, palette, 'rgb565');
      encoder.writeFrame(indexed, width, height, { palette, delay: data.delayMs, repeat: 0 });
      if (encoder.bytesView().byteLength + 1 > maxBytes) {
        throw new Error('GIF 파일이 메모리 한도를 넘었습니다. 더 짧게 녹화하거나 MP4로 저장해 주세요.');
      }
    } else if (type === 'FINISH' && encoder) {
      encoder.finish();
      const bytes = encoder.bytesView();
      self.postMessage({ id, buffer: bytes.buffer, byteLength: bytes.byteLength }, [bytes.buffer]);
      encoder = null;
      return;
    } else {
      throw new Error('GIF 변환 요청이 올바르지 않습니다.');
    }
    self.postMessage({ id });
  } catch (error) {
    encoder = null;
    self.postMessage({ id, error: error.message || String(error) });
  }
};
