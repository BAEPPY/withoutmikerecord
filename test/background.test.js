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
  const downloads = [];
  const listeners = {};
  const chrome = {
    runtime: {
      id: 'withoutmic-test',
      getURL: (path) => `chrome-extension://withoutmic-test/${path}`,
      onMessage: { addListener: (listener) => { listeners.message = listener; } },
    },
    downloads: { onChanged: { addListener: (listener) => { listeners.download = listener; } } },
    tabs: { onRemoved: { addListener: (listener) => { listeners.tabRemoved = listener; } } },
    commands: { onCommand: { addListener: (listener) => { listeners.command = listener; } } },
  };
  const controller = {
    async handle(message) {
      calls.push(structuredClone(message));
      return { ok: true, state: structuredClone(idleState) };
    },
    async badge(state) { badges.push(structuredClone(state)); },
    async onDownloadChanged(delta) { downloads.push(structuredClone(delta)); },
    async onTabRemoved(tabId) { removedTabs.push(tabId); },
  };
  vm.runInNewContext(backgroundSource.replace(controllerImport, ''), {
    chrome, console, createController: () => controller,
  }, { filename: 'extension/background.js' });
  await settle();
  calls.length = 0;
  badges.length = 0;
  return {
    chrome, calls, badges, removedTabs, downloads, listeners,
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
  for (const [key, type] of [['1', 'START'], ['2', 'PAGE_STOP']]) {
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
    'START', 'STOP', 'PAUSE', 'RESUME', 'SAVE', 'SAVE_RANGE', 'DISCARD',
    'SET_SELECTION', 'ARM_SHORTCUTS', 'STATUS', 'STATE_CHANGED',
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
  await h.dispatch({ ...valid, key: '3' }, h.page);
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
  await settle();
  assert.deepEqual(h.calls, [
    { type: 'START', targetTabId: 88 },
    { type: 'PAGE_STOP', targetTabId: 17 },
  ]);
  h.calls.length = 0;
  for (const tab of [undefined, null, {}, { id: '17' }, { id: NaN }, { id: 17.5 }]) {
    h.listeners.command('start-recording', tab);
    h.listeners.command('stop-recording', tab);
  }
  h.listeners.command('unknown-command', { id: 17 });
  await settle();
  assert.deepEqual(h.calls, []);
});

test('download and tab-close notifications retain their controller routing', async () => {
  const h = await harness();
  const delta = { id: 91, state: { current: 'complete' } };
  h.listeners.download(delta);
  h.listeners.tabRemoved(17);
  await settle();
  assert.deepEqual(h.downloads, [delta]);
  assert.deepEqual(h.removedTabs, [17]);
});
