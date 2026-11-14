(() => {
  'use strict';

  const installationKey = '__withoutMikeYouTubeControls';
  const previous = globalThis[installationKey];
  try {
    if (previous?.version === 1 && previous.isAlive?.()) {
      previous.refresh();
      return;
    }
    previous?.dispose?.();
  } catch { /* Replaced extension context. */ }

  // Opacity leaves YouTube's existing playback, focus and keyboard handlers
  // intact. In particular, clicking Play or pressing Space/K still works.
  // Never hide the player, video, caption window, or caption text itself.
  const selectors = [
    '.ytp-chrome-top', '.ytp-chrome-bottom', '.ytp-gradient-top', '.ytp-gradient-bottom',
    '.ytp-large-play-button', '.ytp-bezel', '.ytp-bezel-text-wrapper',
    '.ytp-tooltip', '.ytp-popup', '.ytp-contextmenu',
  ];
  const css = `${selectors.map((selector) => `.html5-video-player ${selector}`).join(',\n')} {
    opacity: 0 !important;
    transition: none !important;
  }`;
  const styles = new Map();
  let sessionToken = null;
  let generation = 0;
  let ready = null;
  let aliveTimer = null;
  let disposed = false;

  function isYouTube(targetDocument, parentAllowed) {
    try {
      const url = new URL(targetDocument.URL || targetDocument.location.href);
      const hostname = url.hostname.toLowerCase();
      if (['youtube.com', 'youtube-nocookie.com'].some((domain) => hostname === domain || hostname.endsWith(`.${domain}`))) {
        return ['https:', 'http:'].includes(url.protocol);
      }
      return parentAllowed && ['about:blank', 'about:srcdoc'].includes(url.href);
    } catch { return false; }
  }

  function refresh() {
    if (disposed || !sessionToken) return;
    const seen = new Set();
    const visit = (target, targetDocument, parentAllowed = false) => {
      try {
        targetDocument ||= target.document;
        if (!targetDocument || seen.has(targetDocument)) return;
        const allowed = isYouTube(targetDocument, parentAllowed);
        seen.add(targetDocument);
        if (allowed) {
          let style = styles.get(targetDocument);
          if (!style?.isConnected) {
            style?.remove();
            style = targetDocument.createElement('style');
            style.setAttribute('data-withoutmike-youtube-controls', '');
            style.textContent = css;
            (targetDocument.head || targetDocument.documentElement).append(style);
            styles.set(targetDocument, style);
          }
        } else if (styles.has(targetDocument)) {
          styles.get(targetDocument).remove();
          styles.delete(targetDocument);
        }
        for (const frame of targetDocument.querySelectorAll?.('iframe, frame') || []) {
          if (frame.contentWindow) visit(frame.contentWindow, null, allowed);
        }
      } catch { /* Cross-origin embeds require their own tab and permission. */ }
    };
    visit(window, document);
    for (const [targetDocument, style] of styles) {
      if (seen.has(targetDocument)) continue;
      style.remove();
      styles.delete(targetDocument);
    }
  }

  function runtimeAlive() {
    try {
      if (!globalThis.chrome?.runtime?.id) return false;
      globalThis.chrome.runtime.getManifest?.();
      return true;
    } catch { return false; }
  }

  function restore(expectedToken) {
    if (expectedToken !== undefined && expectedToken !== sessionToken) return false;
    const restored = sessionToken !== null;
    sessionToken = null;
    generation += 1;
    ready = null;
    for (const style of styles.values()) style.remove();
    styles.clear();
    if (aliveTimer !== null) window.clearInterval(aliveTimer);
    aliveTimer = null;
    window.removeEventListener('pagehide', onPageHide, true);
    return restored;
  }

  function onPageHide() { restore(); }

  function hide(token) {
    if (disposed || typeof token !== 'string' || !token) return Promise.resolve(false);
    if (sessionToken === token) return ready;
    restore();
    sessionToken = token;
    const currentGeneration = generation;
    refresh();
    if (!styles.size) {
      restore(token);
      return Promise.resolve(false);
    }
    window.addEventListener('pagehide', onPageHide, true);
    // Extension reload/disable does not send a content-script unload event.
    // Check only while controls are hidden so they cannot remain stuck hidden.
    aliveTimer = window.setInterval(() => {
      if (!runtimeAlive()) restore(token);
    }, 1000);
    ready = new Promise((resolve) => {
      window.requestAnimationFrame(() => window.requestAnimationFrame(() => {
        resolve(!disposed && generation === currentGeneration && sessionToken === token);
      }));
    });
    return ready;
  }

  function dispose() {
    restore();
    disposed = true;
    if (globalThis[installationKey] === installation) delete globalThis[installationKey];
  }

  const installation = { version: 1, isAlive: () => !disposed && runtimeAlive(), hide, restore, refresh, dispose };
  globalThis[installationKey] = installation;
})();
