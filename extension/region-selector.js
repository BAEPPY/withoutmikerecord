(() => {
  'use strict';
  if (globalThis.__withoutMikeSelectRegion) return;

  let currentSelection = null;

  globalThis.__withoutMikeCancelRegion = () => currentSelection?.cancel();

  globalThis.__withoutMikeSelectRegion = ({ imageDataUrl, selectionToken }) => {
    currentSelection?.cancel();
    if (!/^data:image\/(?:png|jpeg|webp);base64,/i.test(imageDataUrl || '')) {
      return Promise.reject(new Error('화면 이미지를 가져오지 못했어요. 다시 시도해 주세요.'));
    }

    return new Promise((resolve, reject) => {
      const viewportWidth = window.innerWidth;
      const viewportHeight = window.innerHeight;
      const savedFocus = document.activeElement;
      const savedScroll = { x: window.scrollX, y: window.scrollY };
      let finished = false;
      let origin = null;
      let pointerId = null;
      let dialog;
      const subscriptions = [];
      const session = { selectionToken, cancel: () => finish(null) };
      currentSelection = session;

      function listen(type, listener, options = true) {
        window.addEventListener(type, listener, options);
        subscriptions.push([type, listener, options]);
      }

      function cleanup() {
        for (const [type, listener, options] of subscriptions) {
          window.removeEventListener(type, listener, options);
        }
        try { if (dialog?.open) dialog.close(); } catch { /* Already closed. */ }
        dialog?.remove();
        if (currentSelection === session) currentSelection = null;
        try { savedFocus?.focus?.({ preventScroll: true }); } catch { /* The page may have navigated. */ }
        try {
          if (window.scrollX !== savedScroll.x || window.scrollY !== savedScroll.y) {
            window.scrollTo(savedScroll.x, savedScroll.y);
          }
        } catch { /* A navigation can destroy the old frame. */ }
      }

      function finish(region) {
        if (finished) return;
        finished = true;
        cleanup();
        if (!region) {
          resolve(null);
          return;
        }
        // The caller starts capture only after this promise resolves. Waiting
        // for two paints prevents the frozen selector from entering the video.
        window.requestAnimationFrame(() => window.requestAnimationFrame(() => {
          if (window.innerWidth !== viewportWidth || window.innerHeight !== viewportHeight
            || document.visibilityState === 'hidden') resolve(null);
          else resolve(region);
        }));
      }

      function consume(event) {
        if (event.cancelable !== false) event.preventDefault();
        event.stopImmediatePropagation();
      }

      function point(event) {
        return {
          x: Math.max(0, Math.min(viewportWidth, event.clientX)),
          y: Math.max(0, Math.min(viewportHeight, event.clientY)),
        };
      }

      function rectangle(end) {
        return {
          x: Math.min(origin.x, end.x), y: Math.min(origin.y, end.y),
          width: Math.abs(end.x - origin.x), height: Math.abs(end.y - origin.y),
        };
      }

      try {
        dialog = document.createElement('dialog');
        dialog.setAttribute('aria-label', '녹화할 화면 영역 선택');
        dialog.setAttribute('aria-modal', 'true');
        dialog.tabIndex = -1;
        dialog.style.cssText = [
          'all: initial !important', 'position: fixed !important', 'inset: 0 !important',
          'width: 100vw !important', 'height: 100vh !important',
          'max-width: none !important', 'max-height: none !important',
          'margin: 0 !important', 'padding: 0 !important', 'border: 0 !important',
          'overflow: hidden !important', 'background: #000 !important',
          'z-index: 2147483647 !important', 'touch-action: none !important',
          'overscroll-behavior: none !important', 'cursor: crosshair !important',
        ].join(';');
        const surface = document.createElement('div');
        surface.style.cssText = 'position:absolute;inset:0;overflow:hidden;';
        dialog.append(surface);
        const shadow = surface.attachShadow({ mode: 'closed' });
        const style = document.createElement('style');
        style.textContent = `
          :host { color-scheme: dark; }
          * { box-sizing: border-box; pointer-events: none; user-select: none; }
          .frame { position: absolute; inset: 0; overflow: hidden; }
          img { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: fill; }
          .shade { position: absolute; inset: 0; background: #0008; }
          .selection { position: absolute; border: 2px solid #6de5cc;
            background: transparent; box-shadow: 0 0 0 200vmax #0008; }
          .hint { position: absolute; top: 20px; left: 50%; transform: translateX(-50%);
            max-width: calc(100% - 32px); padding: 12px 18px; border: 1px solid #52716d;
            border-radius: 12px; background: #10212af2; color: #edf4f8;
            text-align: center; font: 14px/1.55 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
          [hidden] { display: none !important; }
        `;
        const frame = document.createElement('div');
        frame.className = 'frame';
        const screenshot = document.createElement('img');
        screenshot.alt = '';
        screenshot.draggable = false;
        screenshot.src = imageDataUrl;
        const shade = document.createElement('div');
        shade.className = 'shade';
        const selection = document.createElement('div');
        selection.className = 'selection';
        selection.hidden = true;
        const hint = document.createElement('div');
        hint.className = 'hint';
        hint.setAttribute('role', 'status');
        hint.textContent = '드래그하여 녹화할 영역을 선택하세요. 놓으면 시작 · Esc 또는 4로 취소';
        frame.append(screenshot, shade, selection, hint);
        shadow.append(style, frame);

        function draw(end) {
          const rect = rectangle(end);
          Object.assign(selection.style, {
            left: `${rect.x}px`, top: `${rect.y}px`,
            width: `${rect.width}px`, height: `${rect.height}px`,
          });
          selection.hidden = false;
          shade.hidden = true;
          hint.textContent = `${Math.round(rect.width)} × ${Math.round(rect.height)} px · 놓으면 시작 · Esc 또는 4로 취소`;
          return rect;
        }

        listen('pointerdown', (event) => {
          consume(event);
          if (event.isTrusted === false || event.button !== 0 || event.isPrimary === false) return;
          origin = point(event);
          pointerId = event.pointerId;
          try { dialog.setPointerCapture(pointerId); } catch { /* Window listeners also track dragging. */ }
          draw(origin);
        });
        listen('pointermove', (event) => {
          consume(event);
          if (origin && event.pointerId === pointerId && event.isTrusted !== false) draw(point(event));
        });
        listen('pointerup', (event) => {
          consume(event);
          if (!origin || event.pointerId !== pointerId || event.isTrusted === false) return;
          const rect = draw(point(event));
          origin = null;
          try { dialog.releasePointerCapture(pointerId); } catch { /* Capture may already be released. */ }
          pointerId = null;
          if (rect.width < 16 || rect.height < 16) {
            hint.textContent = '가로와 세로가 각각 16px 이상이 되도록 다시 드래그해 주세요. Esc 또는 4로 취소';
            return;
          }
          finish({
            x: rect.x / viewportWidth, y: rect.y / viewportHeight,
            width: rect.width / viewportWidth, height: rect.height / viewportHeight,
            viewportWidth, viewportHeight,
          });
        });
        listen('pointercancel', (event) => { consume(event); finish(null); });
        listen('keydown', (event) => {
          consume(event);
          if (event.isTrusted !== false && (event.key === 'Escape' || event.key === '4')) finish(null);
        });
        for (const type of ['keyup', 'keypress', 'click', 'dblclick', 'contextmenu', 'mousedown', 'mouseup']) {
          listen(type, consume);
        }
        for (const type of ['wheel', 'touchmove']) listen(type, consume, { capture: true, passive: false });
        for (const type of ['resize', 'scroll', 'pagehide', 'popstate', 'hashchange']) {
          listen(type, () => finish(null));
        }
        listen('visibilitychange', () => {
          if (document.visibilityState === 'hidden') finish(null);
        });
        dialog.addEventListener('cancel', (event) => { event.preventDefault(); finish(null); });
        screenshot.addEventListener('error', () => {
          if (finished) return;
          finished = true;
          cleanup();
          reject(new Error('선택할 화면 이미지를 표시하지 못했어요. 다시 시도해 주세요.'));
        });
        (document.body || document.documentElement).append(dialog);
        dialog.showModal();
        dialog.focus({ preventScroll: true });
      } catch (error) {
        finished = true;
        cleanup();
        reject(error);
      }
    });
  };
})();
