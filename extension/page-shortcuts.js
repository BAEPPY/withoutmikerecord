(() => {
  'use strict';

  const installationKey = '__withoutMikePageShortcuts';
  const installationVersion = 3;
  const previous = globalThis[installationKey];
  try {
    if (previous?.version === installationVersion && previous.isAlive?.()) {
      previous.refresh?.();
      return;
    }
    previous?.dispose?.();
  } catch { /* An older extension context may already be invalidated. */ }

  let pendingKey = null;
  let stopAfterStart = false;
  let cancelVideoRequested = false;
  let scheduledVideoStart = null;
  let videoRecording = false;
  let videoViewportWatch = null;
  let videoControlsToken = null;
  const finishedVideoTokens = new Set();
  let toastHost = null;
  let toastMessage = null;
  let toastTimer = null;
  const connectedWindows = new Map();
  const connectedFrames = new Map();
  let frameRefreshPending = false;
  const installation = {
    version: installationVersion,
    active: true,
    isAlive: () => installation.active && runtimeAvailable(),
    dispose: disconnect,
    refresh: refreshFrames,
  };
  globalThis[installationKey] = installation;

  function runtimeAvailable() {
    try {
      // runtime.id alone can outlive an extension reload in an old isolated
      // world. A callable API checks whether that world's connection survives.
      globalThis.chrome?.runtime?.getManifest?.();
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

  function showToast(message, reconnect = false) {
    if (!installation.active && (!reconnect || globalThis[installationKey])) return;
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
      if (['textarea', 'select'].includes(tagName) || node.isContentEditable) return true;
      if (tagName === 'input') {
        const inputType = String(node.type || node.getAttribute?.('type') || 'text').toLowerCase();
        if (!['range', 'button', 'submit', 'reset', 'checkbox', 'radio', 'image', 'color', 'file', 'hidden']
          .includes(inputType)) return true;
      }
      const roles = (node.getAttribute?.('role') || '').toLowerCase().split(/\s+/);
      return roles.some((role) => ['textbox', 'spinbutton', 'combobox'].includes(role));
    });
  }

  function disconnect() {
    installation.active = false;
    for (const [target, entry] of connectedWindows) {
      try { target.removeEventListener('keydown', onKeydown, true); } catch { /* Navigated frame. */ }
      entry.observer?.disconnect();
    }
    connectedWindows.clear();
    for (const frame of connectedFrames.keys()) frame.removeEventListener('load', scheduleFrameRefresh);
    connectedFrames.clear();
    try { globalThis.chrome?.runtime?.onMessage?.removeListener?.(onBackgroundMessage); }
    catch { /* An extension update can invalidate this API before cleanup. */ }
    removeVideoViewportWatch();
    restoreVideoControls();
    cancelVideoSelection();
    removeToast();
    if (globalThis[installationKey] === installation) delete globalThis[installationKey];
  }

  function cancelVideoSelection() {
    const cancelled = scheduledVideoStart !== null || pendingKey === '3';
    if (scheduledVideoStart !== null) window.clearTimeout(scheduledVideoStart);
    scheduledVideoStart = null;
    if (pendingKey === '3') {
      cancelVideoRequested = true;
      if (videoViewportWatch?.starting) removeVideoViewportWatch();
    }
    globalThis.__withoutMikeCancelRegion?.();
    return cancelled;
  }

  function scheduleFrameRefresh() {
    if (!installation.active || frameRefreshPending) return;
    frameRefreshPending = true;
    void Promise.resolve().then(() => {
      frameRefreshPending = false;
      if (installation.active) refreshFrames();
    });
  }

  function onFrameMutation(records) {
    const containsFrame = (node) => ['iframe', 'frame'].includes(String(node.tagName || '').toLowerCase())
      || Boolean(node.querySelector?.('iframe, frame'));
    if (records.some((record) => [...record.addedNodes, ...record.removedNodes].some(containsFrame))) {
      scheduleFrameRefresh();
    }
  }

  function refreshFrames() {
    if (!installation.active) return;
    const seenWindows = new Set();
    const seenFrames = new Set();
    const visit = (target, targetDocument) => {
      if (seenWindows.has(target)) return;
      try {
        targetDocument ||= target.document;
        if (!targetDocument) return;
        seenWindows.add(target);
        let entry = connectedWindows.get(target);
        if (entry?.document !== targetDocument) {
          if (entry) {
            target.removeEventListener('keydown', onKeydown, true);
            entry.observer?.disconnect();
          }
          target.addEventListener('keydown', onKeydown, true);
          entry = { document: targetDocument, observer: null };
          connectedWindows.set(target, entry);
          if (typeof MutationObserver === 'function' && targetDocument.documentElement) {
            entry.observer = new MutationObserver(onFrameMutation);
            entry.observer.observe(targetDocument.documentElement, { childList: true, subtree: true });
          }
        }
        for (const frame of targetDocument.querySelectorAll?.('iframe, frame') || []) {
          seenFrames.add(frame);
          if (!connectedFrames.has(frame)) {
            frame.addEventListener('load', scheduleFrameRefresh);
            connectedFrames.set(frame, true);
          }
          if (frame.contentWindow) visit(frame.contentWindow);
        }
      } catch { /* Cross-origin player frames use the browser shortcuts. */ }
    };
    // All listeners retain this top-frame closure: messages and region geometry
    // always belong to the top viewport, including a focused embedded player.
    visit(window, document);
    for (const [target, entry] of connectedWindows) {
      if (seenWindows.has(target)) continue;
      try { target.removeEventListener('keydown', onKeydown, true); } catch { /* Navigated frame. */ }
      entry.observer?.disconnect();
      connectedWindows.delete(target);
    }
    for (const frame of connectedFrames.keys()) {
      if (seenFrames.has(frame)) continue;
      frame.removeEventListener('load', scheduleFrameRefresh);
      connectedFrames.delete(frame);
    }
    globalThis.__withoutMikeYouTubeControls?.refresh?.();
  }

  async function hideVideoControls(selectionToken) {
    if (!installation.active || finishedVideoTokens.has(selectionToken)) return;
    videoControlsToken = selectionToken;
    await globalThis.__withoutMikeYouTubeControls?.hide?.(selectionToken);
  }

  function restoreVideoControls(expectedToken = videoControlsToken) {
    if (!expectedToken && !videoControlsToken) return;
    if (expectedToken && videoControlsToken && expectedToken !== videoControlsToken) return;
    globalThis.__withoutMikeYouTubeControls?.restore?.(expectedToken || undefined);
    if (expectedToken) {
      finishedVideoTokens.add(expectedToken);
      if (finishedVideoTokens.size > 100) finishedVideoTokens.delete(finishedVideoTokens.values().next().value);
    }
    videoControlsToken = null;
  }

  function applyRecordingState(state, sessionToken) {
    const token = state.videoSessionToken || state.selectionToken || sessionToken;
    if (token && finishedVideoTokens.has(token)) return;
    if (token && videoViewportWatch && token !== videoViewportWatch.selectionToken) return;
    if (token && videoControlsToken && token !== videoControlsToken) return;
    videoRecording = state.mode === 'video' && ['starting', 'recording', 'paused', 'stopping'].includes(state.status);
    if (videoRecording) {
      removeToast();
      if (token) void hideVideoControls(token).catch(() => {});
    } else if (state.status !== 'selecting') {
      removeVideoViewportWatch();
      restoreVideoControls(token);
    }
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
      restoreVideoControls(selectionToken);
    };
    videoViewportWatch = watch;
    window.addEventListener('resize', watch.onResize, true);
    window.addEventListener('pagehide', watch.onPageHide, true);
    return watch;
  }

  async function send(message) {
    const watchAtRequest = videoViewportWatch;
    const reply = await chrome.runtime.sendMessage(message);
    if (!installation.active) return reply;
    if (reply?.state) {
      // A delayed resize/stop reply from an earlier recording must not remove
      // the new recording's watcher or make its page notifications visible.
      if (watchAtRequest !== videoViewportWatch && (watchAtRequest || videoViewportWatch)) return reply;
      applyRecordingState(reply.state);
    }
    return reply;
  }

  function onBackgroundMessage(message, sender, respond) {
    if (sender.id !== chrome.runtime.id || sender.tab) return;
    if (message.type === 'RECORDING_STATE' && message.state) {
      applyRecordingState(message.state, message.sessionToken);
      respond({ ok: true });
    } else if (message.type === 'CANCEL_VIDEO_SELECTOR') {
      const cancelled = cancelVideoSelection();
      respond({ ok: true, cancelled });
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
    if (!reply?.ok && cancelVideoRequested && reply?.state?.mode === 'video'
      && ['starting', 'recording', 'paused'].includes(reply.state.status)) {
      // A second start can be rejected because a recording already exists.
      // Its immediately following stop must still reach that recording.
      const stopped = await send({ target: 'background', type: 'PAGE_SHORTCUT', key: '4' });
      if (!stopped?.ok) throw new Error(stopped?.error || '녹화를 중지하지 못했어요. 4를 다시 눌러 주세요.');
      removeVideoViewportWatch();
      restoreVideoControls();
      videoRecording = false;
      showToast('화면 녹화를 마쳤어요. 확장 아이콘을 눌러 파일을 저장해 주세요.');
      return;
    }
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
      // Apply the YouTube control stylesheet before capture starts, then let it
      // paint. The frozen selection screenshot itself stays unchanged.
      await hideVideoControls(selectionToken);
      if (cancelVideoRequested || selectionWatch.signalled) {
        removeVideoViewportWatch(selectionWatch);
        restoreVideoControls(selectionToken);
        await cancel();
        return;
      }
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
        restoreVideoControls(selectionToken);
        videoRecording = false;
        showToast('화면 녹화를 마쳤어요. 확장 아이콘을 눌러 파일을 저장해 주세요.');
      }
    } catch (error) {
      if (!submitted) {
        removeVideoViewportWatch(selectionWatch);
        restoreVideoControls(selectionToken);
        await cancel().catch(() => {});
      }
      throw error;
    }
  }

  async function onKeydown(event) {
    const key = shortcutKey(event);
    if (!installation.active || !event.isTrusted || event.repeat || event.isComposing
      || event.keyCode === 229 || event.ctrlKey || event.altKey || event.metaKey || event.shiftKey
      || !key || isEditing(event)) return;

    const reconnectHint = '확장 프로그램을 다시 연결하려면 페이지를 새로고침한 뒤 확장 아이콘을 눌러 주세요.';
    if (!runtimeAvailable()) {
      disconnect();
      showToast(reconnectHint, true);
      return;
    }

    // Once enabled, these four keys control the recorder instead of the player's
    // numeric seek shortcuts. Native play controls remain usable and focused.
    event.preventDefault();
    event.stopImmediatePropagation();
    await performShortcut(key);
  }

  function shortcutKey(event) {
    if (/^[1-4]$/.test(event.key || '')) return event.key;
    const digit = /^Digit([1-4])$/.exec(event.code || '');
    if (digit) return digit[1];
    // With Num Lock off, Numpad1/2/3/4 are navigation keys, not recorder keys.
    if (!event.key || event.key === 'Unidentified') return /^Numpad([1-4])$/.exec(event.code || '')?.[1];
    return null;
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
      const stopExistingAudio = key === '1' && stopAfterStart && reply?.state?.mode === 'audio'
        && ['starting', 'recording', 'paused'].includes(reply.state.status);
      if (!reply?.ok && !stopExistingAudio) throw new Error(reply?.error || reconnectHint);
      if (key === '1' || key === '4') {
        videoRecording = false;
        removeVideoViewportWatch();
        restoreVideoControls();
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
        showToast(reconnectHint, true);
      } else {
        showToast(error?.message || reconnectHint);
      }
    } finally {
      pendingKey = null;
      stopAfterStart = false;
      cancelVideoRequested = false;
    }
  }

  refreshFrames();
  chrome.runtime.onMessage?.addListener(onBackgroundMessage);
})();
