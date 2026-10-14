(() => {
  'use strict';
  const MAX_COPY_BYTES = 16 * 1024 * 1024;
  const READ_TIMEOUT_MS = 30_000;
  const UNSUPPORTED = '이 브라우저는 움직이는 GIF 복사를 지원하지 않아요. GIF 파일로 저장한 뒤 첨부해 주세요.';

  function supported(type) {
    try { return globalThis.ClipboardItem.supports?.(type) === true; }
    catch { return false; }
  }

  function asDataUrl(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      let timeout;
      let settled = false;
      const finish = (error, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        reader.onload = null;
        reader.onerror = null;
        reader.onabort = null;
        if (error) reject(error); else resolve(value);
      };
      reader.onload = () => {
        const value = reader.result;
        if (typeof value !== 'string' || !/^data:image\/gif;base64,[A-Za-z0-9+/]*={0,2}$/.test(value)) {
          finish(new Error('GIF 데이터를 읽지 못했어요. 파일로 저장한 뒤 첨부해 주세요.'));
        } else finish(null, value);
      };
      reader.onerror = () => finish(new Error('GIF 파일을 읽지 못했어요. 다시 시도해 주세요.'));
      reader.onabort = () => finish(new Error('GIF 복사가 취소됐어요. 다시 눌러 주세요.'));
      timeout = setTimeout(() => {
        finish(new Error('GIF 복사를 준비하는 시간이 초과됐어요. 더 짧은 구간을 선택해 주세요.'));
        try { if (reader.readyState === FileReader.LOADING) reader.abort(); } catch { /* Already finished. */ }
      }, READ_TIMEOUT_MS);
      try { reader.readAsDataURL(blob); }
      catch { finish(new Error('GIF 파일을 읽지 못했어요. 다시 시도해 주세요.')); }
    });
  }

  /** Preserve the GIF animation; never substitute a static screenshot. */
  globalThis.__withoutMikeCopyGif = async (blob) => {
    if (!(blob instanceof Blob) || blob.type !== 'image/gif' || blob.size < 13) {
      throw new Error('복사할 GIF 파일이 없거나 GIF 형식이 아니에요. 먼저 GIF를 만들어 주세요.');
    }
    if (blob.size > MAX_COPY_BYTES) {
      throw new Error('GIF 복사는 16 MiB까지 가능해요. 더 짧은 구간을 선택하거나 GIF 파일로 저장해 첨부해 주세요.');
    }
    const header = new Uint8Array(await blob.slice(0, 6).arrayBuffer());
    const signature = String.fromCharCode(...header);
    if (signature !== 'GIF87a' && signature !== 'GIF89a') {
      throw new Error('올바른 GIF 파일이 아니에요. GIF를 다시 만들어 주세요.');
    }
    if (!navigator.clipboard?.write || typeof globalThis.ClipboardItem !== 'function') throw new Error(UNSUPPORTED);
    if (globalThis.document?.hasFocus && !document.hasFocus()) {
      throw new Error('확장 프로그램 창에 초점을 맞춘 뒤 GIF 복사를 다시 눌러 주세요.');
    }
    const nativeGif = supported('image/gif');
    let values;
    if (nativeGif) {
      values = { 'image/gif': blob };
    } else {
      if ((typeof ClipboardItem.supports === 'function' && !supported('text/html'))
        || typeof globalThis.FileReader !== 'function') throw new Error(UNSUPPORTED);
      const url = await asDataUrl(blob);
      values = { 'text/html': new Blob([`<img src="${url}" alt="GIF">`], { type: 'text/html' }) };
      // Web custom formats preserve the original GIF bytes between supporting
      // browsers/apps; HTML remains the interoperable animated-image fallback.
      if (supported('web image/gif')) values['web image/gif'] = blob;
    }
    try {
      await navigator.clipboard.write([new ClipboardItem(values)]);
    } catch (error) {
      if (error?.name === 'NotAllowedError' || error?.name === 'SecurityError') {
        throw new Error('클립보드 복사가 허용되지 않았어요. 확장 프로그램 창을 열어둔 상태에서 다시 눌러 주세요.');
      }
      if (error?.name === 'NotSupportedError' || error?.name === 'TypeError') throw new Error(UNSUPPORTED);
      throw new Error('GIF를 복사하지 못했어요. 다시 시도하거나 GIF 파일로 저장해 첨부해 주세요.');
    }
    return { mode: nativeGif ? 'native-gif' : 'html-gif' };
  };
})();
