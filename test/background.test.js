import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

// Inject the controller boundary while executing the real background listener
// code, so sender authentication is tested separately from media operations.
const backgroundSource = await readFile(new URL('../extension/background.js', import.meta.url), 'utf8');
const controllerImport = "import { createController } from './controller.js';";
assert.ok(backgroundSource.includes(controllerImport));

const idleState = { status: 'idle', tab: null };
const settle = () => new Promise((resolve) => setImmediate(resolve));

async function harness() {
  const calls = [];
  const badges = [];
  const removedTabs = [];
  const updatedTabs = [];
  const downloads = [];
  const pageMessages = [];
  const listeners = {};
  let onStateChange = async () => {};
  const chrome = {
    runtime: {
      id: 'withoutmic-test',
      getURL: (path) => `chrome-extension://withoutmic-test/${path}`,
      onMessage: { addListener: (listener) => { listeners.message = listener; } },
    },
    downloads: { onChanged: { addListener: (listener) => { listeners.download = listener; } } },
    tabs: {
      onRemoved: { addListener: (listener) => { listeners.tabRemoved = listener; } },
      onUpdated: { addListener: (listener) => { listeners.tabUpdated = listener; } },
      async sendMessage(tabId, message, options) {
        pageMessages.push(structuredClone({ tabId, message, options }));
        return { ok: true };
      },
    },
    commands: { onCommand: { addListener: (listener) => { listeners.command = listener; } } },
  };
  const controller = {
    async handle(message) {
      calls.push(structuredClone(message));
      return { ok: true, state: structuredClone(idleState) };
    },
    async badge(state) { badges.push(structuredClone(state)); await onStateChange(state); },
    async onDownloadChanged(delta) { downloads.push(structuredClone(delta)); },
    async onTabRemoved(tabId) { removedTabs.push(tabId); },
    async onTabUpdated(tabId, change) { updatedTabs.push({ tabId, change: structuredClone(change) }); },
  };
  vm.runInNewContext(backgroundSource.replace(controllerImport, ''), {
    chrome, console, createController: (_api, options) => {
      onStateChange = options?.onStateChange || onStateChange;
      return controller;
    },
  }, { filename: 'extension/background.js' });
  await settle();
  calls.length = 0;
  badges.length = 0;
  return {
    chrome, calls, badges, removedTabs, updatedTabs, downloads, listeners, pageMessages,
    stateChange: (state) => onStateChange(state),
    popup: { id: chrome.runtime.id, url: chrome.runtime.getURL('popup.html') },
    page: { id: chrome.runtime.id, tab: { id: 17 }, frameId: 0, url: 'https://example.test/player' },
    async dispatch(message, sender) {
      const replies = [];
      const keepAlive = listeners.message(message, sender, (reply) => replies.push(structuredClone(reply)));
      await settle();
      return { keepAlive, replies };
    },
  };
}

test('top-level page keys use the sender tab, ignoring a forged capture target in the payload', async () => {
  const h = await harness();
  for (const [key, type] of [['1', 'START'], ['2', 'PAGE_STOP'], ['3', 'BEGIN_VIDEO'], ['4', 'STOP_VIDEO']]) {
    const response = await h.dispatch({
      target: 'background', type: 'PAGE_SHORTCUT', key,
      targetTabId: 88, expectedTabId: 88, streamId: 'untrusted-stream',
    }, h.page);
    assert.equal(response.keepAlive, true);
    assert.equal(response.replies.length, 1);
    assert.equal(response.replies[0].ok, true);
    assert.deepEqual(h.calls.at(-1), { type, targetTabId: 17 });
  }
});

test('content scripts cannot invoke popup-only commands or forge offscreen state updates', async () => {
  const h = await harness();
  for (const type of [
    'START', 'BROWSER_START', 'STOP', 'STOP_PENDING', 'PAUSE', 'RESUME', 'SAVE', 'SAVE_RANGE', 'DISCARD',
    'SET_SELECTION', 'ARM_SHORTCUTS', 'STATUS', 'STATE_CHANGED',
    'BEGIN_VIDEO', 'START_VIDEO', 'CANCEL_VIDEO', 'STOP_VIDEO', 'OPEN_VIDEO_SELECTOR', 'SAVE_VIDEO',
    'SAVE_VIDEO_RANGE', 'PREPARE_GIF_COPY', 'CANCEL_EXPORT',
  ]) {
    await h.dispatch({
      target: 'background', type, targetTabId: 17,
      state: { status: 'recording' }, startSeconds: 1, endSeconds: 2,
    }, h.page);
  }
  assert.deepEqual(h.calls, []);
  assert.deepEqual(h.badges, []);
});

test('page shortcuts reject other extensions, child frames, missing tabs, and unknown keys', async () => {
  const h = await harness();
  const valid = { target: 'background', type: 'PAGE_SHORTCUT', key: '1' };
  for (const sender of [
    { ...h.page, id: 'another-extension' },
    { ...h.page, frameId: 1 },
    { ...h.page, frameId: undefined },
    { id: h.chrome.runtime.id, url: h.chrome.runtime.getURL('popup.html'), frameId: 0 },
  ]) {
    await h.dispatch(valid, sender);
  }
  await h.dispatch({ ...valid, key: '5' }, h.page);
  await h.dispatch({ ...valid, key: null }, h.page);
  await h.dispatch({ ...valid, target: 'offscreen' }, h.page);
  assert.deepEqual(h.calls, []);
  assert.deepEqual(h.badges, []);
});

test('the extension popup still routes regular recording and trim commands', async () => {
  const h = await harness();
  for (const message of [
    { target: 'background', type: 'START' },
    { target: 'background', type: 'STOP' },
    { target: 'background', type: 'ARM_SHORTCUTS' },
    { target: 'background', type: 'OPEN_VIDEO_SELECTOR' },
    { target: 'background', type: 'CANCEL_VIDEO' },
    { target: 'background', type: 'SAVE_VIDEO', format: 'gif' },
    { target: 'background', type: 'SAVE_VIDEO_RANGE', format: 'mp4', startSeconds: 1, endSeconds: 4 },
    { target: 'background', type: 'PREPARE_GIF_COPY', scope: 'range', startSeconds: 1, endSeconds: 4 },
    { target: 'background', type: 'CANCEL_EXPORT' },
    { target: 'background', type: 'SET_SELECTION', startSeconds: 1.25, endSeconds: 5.75 },
    { target: 'background', type: 'SAVE_RANGE', startSeconds: 1.25, endSeconds: 5.75 },
  ]) {
    const response = await h.dispatch(message, h.popup);
    assert.equal(response.keepAlive, true);
    assert.equal(response.replies.length, 1);
    assert.equal(response.replies[0].ok, true);
    assert.deepEqual(h.calls.at(-1), message);
  }
});

test('other extension documents and page senders cannot impersonate the popup', async () => {
  const h = await harness();
  const message = { target: 'background', type: 'DISCARD' };
  for (const sender of [
    { ...h.popup, id: 'another-extension' },
    { ...h.popup, url: h.chrome.runtime.getURL('offscreen.html') },
    { ...h.popup, url: h.chrome.runtime.getURL('other.html') },
    { ...h.popup, url: `${h.chrome.runtime.getURL('popup.html')}?spoof=1` },
    { id: h.chrome.runtime.id },
    { ...h.page, url: h.chrome.runtime.getURL('popup.html') },
  ]) {
    await h.dispatch(message, sender);
  }
  assert.deepEqual(h.calls, []);
});

test('only the actual offscreen extension document may update the recording badge', async () => {
  const h = await harness();
  const message = { target: 'background', type: 'STATE_CHANGED', state: { status: 'recording', tab: { id: 17 } } };
  await h.dispatch(message, { id: h.chrome.runtime.id, url: h.chrome.runtime.getURL('offscreen.html') });
  assert.deepEqual(h.badges, [message.state]);
  assert.deepEqual(h.calls, []);
  for (const sender of [
    h.popup,
    h.page,
    { id: 'another-extension', url: h.chrome.runtime.getURL('offscreen.html') },
    { ...h.page, url: h.chrome.runtime.getURL('offscreen.html') },
  ]) {
    await h.dispatch(message, sender);
  }
  assert.deepEqual(h.badges, [message.state]);
  assert.deepEqual(h.calls, []);
});

test('browser keyboard commands use the provided source tab without falling back to another tab', async () => {
  const h = await harness();
  assert.equal(typeof h.listeners.command, 'function');
  h.listeners.command('start-recording', { id: 88 });
  h.listeners.command('stop-recording', { id: 17 });
  h.listeners.command('start-video', { id: 88 });
  h.listeners.command('stop-video', { id: 17 });
  await settle();
  assert.deepEqual(h.calls, [
    { type: 'BROWSER_START', targetTabId: 88 },
    { type: 'PAGE_STOP', targetTabId: 17 },
    { type: 'OPEN_VIDEO_SELECTOR', targetTabId: 88 },
    { type: 'STOP_VIDEO', targetTabId: 17 },
  ]);
  h.calls.length = 0;
  for (const tab of [undefined, null, {}, { id: '17' }, { id: NaN }, { id: 17.5 }]) {
    h.listeners.command('start-recording', tab);
    h.listeners.command('stop-recording', tab);
    h.listeners.command('start-video', tab);
    h.listeners.command('stop-video', tab);
  }
  h.listeners.command('unknown-command', { id: 17 });
  await settle();
  assert.deepEqual(h.calls, []);
});

test('download, tab-close, and navigation notifications retain their controller routing', async () => {
  const h = await harness();
  const delta = { id: 91, state: { current: 'complete' } };
  h.listeners.download(delta);
  h.listeners.tabRemoved(17);
  h.listeners.tabUpdated(17, { status: 'loading' });
  await settle();
  assert.deepEqual(h.downloads, [delta]);
  assert.deepEqual(h.removedTabs, [17]);
  assert.deepEqual(h.updatedTabs, [{ tabId: 17, change: { status: 'loading' } }]);
});

test('video selector messages bind to the sender tab and forward only their allowed fields', async () => {
  const h = await harness();
  const region = { x: 0.1, y: 0.1, width: 0.5, height: 0.5, viewportWidth: 1000, viewportHeight: 800 };
  const selected = await h.dispatch({
    target: 'background', type: 'VIDEO_REGION_SELECTED', region, selectionToken: 'selection-a',
    targetTabId: 88, streamId: 'forged-stream', mode: 'audio', format: 'gif',
  }, h.page);
  assert.equal(selected.keepAlive, true);
  assert.deepEqual(h.calls.at(-1), { type: 'START_VIDEO', targetTabId: 17, region, selectionToken: 'selection-a' });
  const cancelled = await h.dispatch({
    target: 'background', type: 'CANCEL_VIDEO_SELECTION', selectionToken: 'selection-a',
    targetTabId: 88, region, expectedTabId: 88,
  }, h.page);
  assert.equal(cancelled.keepAlive, true);
  assert.deepEqual(h.calls.at(-1), { type: 'CANCEL_VIDEO', targetTabId: 17, selectionToken: 'selection-a' });
});

test('video selection callbacks reject child frames, other extensions, and missing tokens', async () => {
  const h = await harness();
  for (const type of ['VIDEO_REGION_SELECTED', 'CANCEL_VIDEO_SELECTION', 'VIDEO_VIEWPORT_CHANGED']) {
    for (const sender of [
      { ...h.page, frameId: 1 },
      { ...h.page, id: 'another-extension' },
      { ...h.page, tab: { id: '17' } },
    ]) {
      await h.dispatch({ target: 'background', type, selectionToken: 'selection-a' }, sender);
    }
    for (const selectionToken of [undefined, null, 17, {}]) {
      await h.dispatch({ target: 'background', type, selectionToken }, h.page);
    }
  }
  assert.deepEqual(h.calls, []);
});

test('viewport change notifications use the authenticated source tab and only forward their session token', async () => {
  const h = await harness();
  const response = await h.dispatch({
    target: 'background', type: 'VIDEO_VIEWPORT_CHANGED', selectionToken: 'selection-a',
    targetTabId: 88, tabId: 88, tab: { id: 88 }, mode: 'audio', streamId: 'forged-stream',
    region: { x: 0, y: 0, width: 1, height: 1 },
  }, h.page);
  assert.equal(response.keepAlive, true);
  assert.equal(response.replies.length, 1);
  assert.equal(response.replies[0].ok, true);
  assert.deepEqual(h.calls, [{
    type: 'VIDEO_VIEWPORT_CHANGED', targetTabId: 17, selectionToken: 'selection-a',
  }]);
});

test('trusted video state notifications expose only source-frame session state and deduplicate unchanged snapshots', async () => {
  const h = await harness();
  const state = {
    status: 'recording', mode: 'video', tab: { id: 17, title: 'Private title', url: 'https://example.test/private' },
    selectionToken: null, videoSessionToken: 'video-a', elapsedMs: 10,
    result: { url: 'blob:private-recording', filename: 'private.mp4', bytes: 1000 },
    gifResult: { url: 'blob:private-gif' }, rangeGifResult: { url: 'blob:private-range' },
    download: { id: 91, status: 'complete' },
  };
  const offscreen = { id: h.chrome.runtime.id, url: h.chrome.runtime.getURL('offscreen.html') };
  await h.dispatch({ target: 'background', type: 'STATE_CHANGED', state }, offscreen);
  assert.deepEqual(h.pageMessages, [{
    tabId: 17, options: { frameId: 0 }, message: {
      type: 'RECORDING_STATE', sessionToken: 'video-a', state: {
        status: 'recording', mode: 'video', tab: { id: 17 }, selectionToken: null, videoSessionToken: 'video-a',
      },
    },
  }]);
  await h.dispatch({ target: 'background', type: 'STATE_CHANGED', state: { ...state, elapsedMs: 20 } }, offscreen);
  assert.equal(h.pageMessages.length, 1, 'progress-only changes do not repeat the page notification');
  for (const sender of [h.page, h.popup, { ...offscreen, id: 'another-extension' }, { ...h.page, url: offscreen.url }]) {
    await h.dispatch({ target: 'background', type: 'STATE_CHANGED', state: { ...state, status: 'paused' } }, sender);
  }
  assert.equal(h.pageMessages.length, 1, 'untrusted updates cannot change page control visibility');
  await h.dispatch({ target: 'background', type: 'STATE_CHANGED', state: { ...state, status: 'paused' } }, offscreen);
  assert.equal(h.pageMessages.length, 2);
  assert.equal(h.pageMessages[1].message.state.status, 'paused');
});

test('normal video stop and reset notify the same session before clearing its page state', async () => {
  const h = await harness();
  const session = { mode: 'video', tab: { id: 17 }, selectionToken: null, videoSessionToken: 'video-a' };
  for (const status of ['recording', 'stopping', 'ready']) {
    await h.stateChange({ ...session, status, result: { url: 'blob:private-video' } });
  }
  await h.stateChange({ status: 'idle', mode: 'audio', tab: null, videoSessionToken: null, selectionToken: null });
  await h.stateChange({ status: 'idle', mode: 'audio', tab: null });
  assert.deepEqual(h.pageMessages.map(({ message }) => [message.sessionToken, message.state.status]), [
    ['video-a', 'recording'], ['video-a', 'stopping'], ['video-a', 'ready'], ['video-a', 'idle'],
  ]);
  assert.deepEqual(h.pageMessages.at(-1), {
    tabId: 17, options: { frameId: 0 }, message: {
      type: 'RECORDING_STATE', sessionToken: 'video-a', state: { status: 'idle', mode: 'video', tab: { id: 17 } },
    },
  });
  assert.ok(h.pageMessages.every(({ tabId }) => tabId === 17));
});

test('switching video sessions clears the old token before sending the new session state', async () => {
  for (const nextTabId of [17, 88]) {
    const h = await harness();
    await h.stateChange({ status: 'recording', mode: 'video', tab: { id: 17 }, selectionToken: null, videoSessionToken: 'old-token' });
    await h.stateChange({ status: 'selecting', mode: 'video', tab: { id: nextTabId }, selectionToken: 'new-token', videoSessionToken: null });
    assert.deepEqual(h.pageMessages.map(({ tabId, message }) => [tabId, message.sessionToken, message.state.status]), [
      [17, 'old-token', 'recording'], [17, 'old-token', 'idle'], [nextTabId, 'new-token', 'selecting'],
    ]);
    await h.stateChange({ status: 'recording', mode: 'audio', tab: { id: 99 } });
    assert.deepEqual(h.pageMessages.at(-1), {
      tabId: nextTabId, options: { frameId: 0 }, message: {
        type: 'RECORDING_STATE', sessionToken: 'new-token', state: { status: 'idle', mode: 'video', tab: { id: nextTabId } },
      },
    });
    assert.ok(h.pageMessages.every(({ tabId }) => tabId !== 99), 'audio never sends another page a video visibility command');
  }
});

test('a closed source page cannot break recording state handling', async () => {
  const h = await harness();
  h.chrome.tabs.sendMessage = async () => { throw new Error('No tab with id: 17'); };
  await assert.doesNotReject(h.stateChange({
    status: 'ready', mode: 'video', tab: { id: 17 }, selectionToken: null, videoSessionToken: 'ended-video',
  }));
  await assert.doesNotReject(h.stateChange({ status: 'idle', mode: 'audio', tab: null }));
});
