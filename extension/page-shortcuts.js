(() => {
  'use strict';

  const installationKey = '__withoutMikePageShortcuts';
  if (globalThis[installationKey]) return;

  let pendingKey = null;
  let stopAfterStart = false;
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
    if (globalThis[installationKey] === installation) delete globalThis[installationKey];
  }

  async function onKeydown(event) {
    if (!event.isTrusted || event.defaultPrevented || event.repeat || event.isComposing
      || event.keyCode === 229 || event.ctrlKey || event.altKey || event.metaKey || event.shiftKey
      || !['1', '2'].includes(event.key) || isEditing(event)) return;

    const reconnectHint = '확장 프로그램을 다시 연결하려면 페이지를 새로고침한 뒤 확장 아이콘을 눌러 주세요.';
    if (!runtimeAvailable()) {
      disconnect();
      showToast(reconnectHint);
      return;
    }

    // Once enabled, these two keys control the recorder instead of the player's
    // numeric seek shortcuts. Native play controls remain usable and focused.
    event.preventDefault();
    event.stopImmediatePropagation();
    if (pendingKey !== null) {
      // Capture permission and media setup may outlast a short key sequence.
      // Remember one stop so pressing 1 then 2 cannot leave recording running.
      if (pendingKey === '1' && event.key === '2') stopAfterStart = true;
      return;
    }
    pendingKey = event.key;

    try {
      const reply = await chrome.runtime.sendMessage({
        target: 'background', type: 'PAGE_SHORTCUT', key: event.key,
      });
      if (!reply?.ok) throw new Error(reply?.error || reconnectHint);
      if (pendingKey === '1' && stopAfterStart) {
        stopAfterStart = false;
        pendingKey = '2';
        const stopped = await chrome.runtime.sendMessage({
          target: 'background', type: 'PAGE_SHORTCUT', key: '2',
        });
        if (!stopped?.ok) throw new Error(stopped?.error || reconnectHint);
      }
      showToast(pendingKey === '1'
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
    }
  }

  window.addEventListener('keydown', onKeydown, true);
})();
