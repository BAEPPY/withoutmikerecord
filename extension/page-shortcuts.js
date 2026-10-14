(() => {
  'use strict';

  const installationKey = '__withoutMikePageShortcuts';
  if (globalThis[installationKey]) return;

  let pendingKey = null;
  let stopAfterStart = false;
  let cancelVideoRequested = false;
  let scheduledVideoStart = null;
  let videoRecording = false;
  let videoViewportWatch = null;
  let toastHost = null;
  let toastMessage = null;
  let toastTimer = null;
  const installation = {};
  globalThis[installationKey] = installation;

  function runtimeAvailable() {
    try {
      return Boolean(globalThis.chrome?.runtime?.id
        && typeof globalThis.chrome.runtime.sendMessage === 'function');
    } catch {
      return false;
    }
  }

  function removeToast() {
    if (toastTimer !== null) window.clearTimeout(toastTimer);
    toastTimer = null;
    toastHost?.remove();
    toastHost = null;
    toastMessage = null;
  }

  function showToast(message) {
    if (videoRecording) {
      removeToast();
      return;
    }
    if (toastTimer !== null) window.clearTimeout(toastTimer);
    if (!toastHost?.isConnected) {
      toastHost = document.createElement('div');
      // The shadow root keeps the page's styles from changing the message.
      // The host never intercepts clicks on the underlying player or page.
      toastHost.style.cssText = [
        'all: initial !important',
        'position: fixed !important',
        'top: 20px !important',
        'left: 50% !important',
        'transform: translateX(-50%) !important',
        'width: max-content !important',
        'max-width: calc(100vw - 32px) !important',
        'z-index: 2147483647 !important',
        'pointer-events: none !important',
      ].join(';');
      const shadow = toastHost.attachShadow({ mode: 'closed' });
      const style = document.createElement('style');
      style.textContent = `
        :host { color-scheme: dark; }
        div {
          box-sizing: border-box;
          max-width: 440px;
          padding: 12px 16px;
          border: 1px solid #3b6565;
          border-radius: 12px;
          background: #10212a;
          color: #edf4f8;
          box-shadow: 0 4px 24px #0005;
          font: 14px/1.55 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
          overflow-wrap: anywhere;
          white-space: normal;
          pointer-events: none;
        }
      `;
      toastMessage = document.createElement('div');
      toastMessage.setAttribute('role', 'status');
      toastMessage.setAttribute('aria-live', 'polite');
      toastMessage.setAttribute('aria-atomic', 'true');
      shadow.append(style, toastMessage);
      (document.body || document.documentElement).append(toastHost);
    }
    toastMessage.textContent = message;
    toastTimer = window.setTimeout(removeToast, 5000);
  }

  function isEditing(event) {
    const path = typeof event.composedPath === 'function'
      ? event.composedPath() : [event.target];
    return path.some((node) => {
      if (!node) return false;
      const tagName = String(node.tagName || '').toLowerCase();
      if (['input', 'textarea', 'select'].includes(tagName) || node.isContentEditable) return true;
      const roles = (node.getAttribute?.('role') || '').toLowerCase().split(/\s+/);
      return roles.some((role) => ['textbox', 'spinbutton', 'combobox'].includes(role));
    });
  }

  function disconnect() {
    window.removeEventListener('keydown', onKeydown, true);
    try { globalThis.chrome?.runtime?.onMessage?.removeListener?.(onBackgroundMessage); }
    catch { /* An extension update can invalidate this API before cleanup. */ }
    removeVideoViewportWatch();
    cancelVideoSelection();
    if (globalThis[installationKey] === installation) delete globalThis[installationKey];
  }

  function cancelVideoSelection() {
    if (scheduledVideoStart !== null) window.clearTimeout(scheduledVideoStart);
    scheduledVideoStart = null;
    if (pendingKey === '3') {
      cancelVideoRequested = true;
      if (videoViewportWatch?.starting) removeVideoViewportWatch();
    }
    globalThis.__withoutMikeCancelRegion?.();
  }

  function removeVideoViewportWatch(expected = videoViewportWatch) {
    if (!expected || videoViewportWatch !== expected) return;
    window.removeEventListener('resize', expected.onResize, true);
    window.removeEventListener('pagehide', expected.onPageHide, true);
    videoViewportWatch = null;
  }

  function watchVideoViewport(selectionToken, region) {
    removeVideoViewportWatch();
    const watch = {
      selectionToken, width: region.viewportWidth, height: region.viewportHeight,
      signalled: false, starting: true, onResize: null, onPageHide: null,
    };
    const signalGeometryChange = () => {
      if (videoViewportWatch !== watch || watch.signalled) return;
      watch.signalled = true;
      if (pendingKey === '3') cancelVideoRequested = true;
      // Tab capture may keep a fixed output resolution while the source page
      // changes size. Only the source viewport can detect that layout change.
      void send({
        target: 'background', type: 'VIDEO_VIEWPORT_CHANGED', selectionToken,
      }).catch((error) => {
        if (!runtimeAvailable() || /extension context invalidated/i.test(error?.message || '')) disconnect();
      });
    };
    watch.onResize = () => {
      if (window.innerWidth !== watch.width || window.innerHeight !== watch.height) signalGeometryChange();
    };
    watch.onPageHide = () => {
      if (videoViewportWatch !== watch) return;
      // Navigating away destroys this guard even when the capture frame keeps
      // the same dimensions, so stop the scoped recording before detaching.
      signalGeometryChange();
      removeVideoViewportWatch(watch);
    };
    videoViewportWatch = watch;
    window.addEventListener('resize', watch.onResize, true);
    window.addEventListener('pagehide', watch.onPageHide, true);
    return watch;
  }

  async function send(message) {
    const watchAtRequest = videoViewportWatch;
    const reply = await chrome.runtime.sendMessage(message);
    if (reply?.state) {
      // A delayed resize/stop reply from an earlier recording must not remove
      // the new recording's watcher or make its page notifications visible.
      if (watchAtRequest !== videoViewportWatch && (watchAtRequest || videoViewportWatch)) return reply;
      const replyToken = reply.state.videoSessionToken || reply.state.selectionToken;
      if (videoViewportWatch && replyToken && replyToken !== videoViewportWatch.selectionToken) return reply;
      videoRecording = reply.state.mode === 'video'
        && ['starting', 'recording', 'paused', 'stopping'].includes(reply.state.status);
      if (videoRecording) removeToast();
      else removeVideoViewportWatch(watchAtRequest);
    }
    return reply;
  }

  function onBackgroundMessage(message, sender, respond) {
    if (sender.id !== chrome.runtime.id || sender.tab) return;
    if (message.type === 'CANCEL_VIDEO_SELECTOR') {
      cancelVideoSelection();
      respond({ ok: true });
    } else if (message.type === 'SHOW_VIDEO_SELECTOR') {
      if (pendingKey !== null || scheduledVideoStart !== null) {
        respond({ ok: false, error: '진행 중인 요청이 끝난 뒤 다시 시도해 주세요.' });
        return;
      }
      // OPEN_VIDEO_SELECTOR in the worker is itself a queued command. Return
      // its ACK before asking that same queue to begin the video selection.
      respond({ ok: true });
      scheduledVideoStart = window.setTimeout(() => {
        scheduledVideoStart = null;
        void performShortcut('3');
      }, 50);
    }
  }

  async function selectVideoRegion() {
    removeToast();
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;
    const reply = await send({ target: 'background', type: 'PAGE_SHORTCUT', key: '3' });
    if (!reply?.ok) throw new Error(reply?.error || '영역 선택을 시작하지 못했어요. 다시 시도해 주세요.');
    const selectionToken = reply.selectionToken;
    let submitted = false;
    let selectionWatch = null;
    const cancel = () => send({
      target: 'background', type: 'CANCEL_VIDEO_SELECTION', selectionToken,
    });
    try {
      if (cancelVideoRequested || window.innerWidth !== viewportWidth || window.innerHeight !== viewportHeight) {
        await cancel();
        return;
      }
      if (typeof globalThis.__withoutMikeSelectRegion !== 'function') {
        throw new Error('영역 선택기를 연결하지 못했어요. 확장 아이콘을 다시 눌러 주세요.');
      }
      const region = await globalThis.__withoutMikeSelectRegion({
        imageDataUrl: reply.imageDataUrl, selectionToken,
      });
      if (!region || cancelVideoRequested) {
        await cancel();
        return;
      }
      // The selector removes its dialog and waits two animation frames before
      // resolving. A success toast here would itself appear in the new video.
      selectionWatch = watchVideoViewport(selectionToken, region);
      const started = await send({
        target: 'background', type: 'VIDEO_REGION_SELECTED', selectionToken, region,
      });
      if (!started?.ok) throw new Error(started?.error || '화면 녹화를 시작하지 못했어요. 다시 시도해 주세요.');
      submitted = true;
      selectionWatch.starting = false;
      if (!started.state) videoRecording = true;
      if (cancelVideoRequested) {
        const stopped = await send({ target: 'background', type: 'PAGE_SHORTCUT', key: '4' });
        if (!stopped?.ok) {
          const alreadyStopping = stopped?.state?.mode === 'video'
            && stopped.state.videoSessionToken === selectionToken
            && ['stopping', 'ready', 'error'].includes(stopped.state.status);
          if (!alreadyStopping) throw new Error(stopped?.error || '녹화를 중지하지 못했어요. 4를 다시 눌러 주세요.');
          // The direct viewport signal can beat this queued stop. Its matching
          // session has already ended (or is ending), so no error toast belongs
          // on the page, particularly while the final video frames drain.
          removeVideoViewportWatch(selectionWatch);
          videoRecording = stopped.state.status === 'stopping';
          return;
        }
        removeVideoViewportWatch(selectionWatch);
        videoRecording = false;
        showToast('화면 녹화를 마쳤어요. 확장 아이콘을 눌러 파일을 저장해 주세요.');
      }
    } catch (error) {
      if (!submitted) {
        removeVideoViewportWatch(selectionWatch);
        await cancel().catch(() => {});
      }
      throw error;
    }
  }

  async function onKeydown(event) {
    if (!event.isTrusted || event.defaultPrevented || event.repeat || event.isComposing
      || event.keyCode === 229 || event.ctrlKey || event.altKey || event.metaKey || event.shiftKey
      || !['1', '2', '3', '4'].includes(event.key) || isEditing(event)) return;

    const reconnectHint = '확장 프로그램을 다시 연결하려면 페이지를 새로고침한 뒤 확장 아이콘을 눌러 주세요.';
    if (!runtimeAvailable()) {
      disconnect();
      showToast(reconnectHint);
      return;
    }

    // Once enabled, these four keys control the recorder instead of the player's
    // numeric seek shortcuts. Native play controls remain usable and focused.
    event.preventDefault();
    event.stopImmediatePropagation();
    await performShortcut(event.key);
  }

  async function performShortcut(key) {
    const reconnectHint = '확장 프로그램을 다시 연결하려면 페이지를 새로고침한 뒤 확장 아이콘을 눌러 주세요.';
    if (scheduledVideoStart !== null && (key === '3' || key === '4')) {
      window.clearTimeout(scheduledVideoStart);
      scheduledVideoStart = null;
      if (key === '4') return;
    }
    if (pendingKey !== null) {
      // Capture permission and media setup may outlast a short key sequence.
      // Remember one stop so pressing 1 then 2 cannot leave recording running.
      if (pendingKey === '1' && key === '2') stopAfterStart = true;
      if (pendingKey === '3' && key === '4') cancelVideoSelection();
      return;
    }
    pendingKey = key;

    try {
      if (key === '3') {
        await selectVideoRegion();
        return;
      }
      const reply = await send({
        target: 'background', type: 'PAGE_SHORTCUT', key,
      });
      if (!reply?.ok) throw new Error(reply?.error || reconnectHint);
      if (key === '1' || key === '4') {
        videoRecording = false;
        removeVideoViewportWatch();
      }
      if (pendingKey === '1' && stopAfterStart) {
        stopAfterStart = false;
        pendingKey = '2';
        const stopped = await send({
          target: 'background', type: 'PAGE_SHORTCUT', key: '2',
        });
        if (!stopped?.ok) throw new Error(stopped?.error || reconnectHint);
      }
      showToast(pendingKey === '4'
        ? '화면 녹화를 마쳤어요. 확장 아이콘을 눌러 파일을 저장해 주세요.'
        : pendingKey === '1'
        ? '녹음을 시작했어요. 2를 누르면 중지합니다.'
        : '녹음을 마쳤어요. 확장 아이콘을 눌러 파일을 저장해 주세요.');
    } catch (error) {
      if (!runtimeAvailable() || /extension context invalidated/i.test(error?.message || '')) {
        disconnect();
        showToast(reconnectHint);
      } else {
        showToast(error?.message || reconnectHint);
      }
    } finally {
      pendingKey = null;
      stopAfterStart = false;
      cancelVideoRequested = false;
    }
  }

  window.addEventListener('keydown', onKeydown, true);
  chrome.runtime.onMessage?.addListener(onBackgroundMessage);
})();
