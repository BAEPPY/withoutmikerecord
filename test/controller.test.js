import assert from 'node:assert/strict';
import test from 'node:test';
import { createController, EMPTY_STATE } from '../extension/controller.js';

const recordedFile = {
  url: 'blob:chrome-extension://recorder/recording-1',
  filename: 'tab-audio-2026-10-13.mp4',
  bytes: 2048,
  mimeType: 'audio/mp4;codecs=mp4a.40.2',
  durationSeconds: 12,
  kind: 'audio',
};

const recordedVideo = {
  url: 'blob:chrome-extension://recorder/video-1',
  filename: 'tab-video-2026-10-14.mp4', bytes: 8192,
  mimeType: 'video/mp4', durationSeconds: 12, kind: 'video',
};

const recordedGif = {
  url: 'blob:chrome-extension://recorder/gif-1',
  filename: 'tab-video-2026-10-14.gif', bytes: 4096,
  mimeType: 'image/gif', durationSeconds: 12, kind: 'gif',
};

const selectedRegion = { x: 0.1, y: 0.2, width: 0.4, height: 0.3, viewportWidth: 1920, viewportHeight: 1080 };
const screenshot = 'data:image/png;base64,aW1hZ2U=';

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

// The offscreen document owns this state independently of each controller instance.
// All messages return copies, matching Chrome's message serialization boundary.
function browser({ status = 'idle', mode = 'audio', download, document = status !== 'idle' } = {}) {
  const calls = [];
  const state = structuredClone(EMPTY_STATE);
  Object.assign(state, {
    status, mode,
    tab: status === 'idle' ? null : { id: 17, title: 'A playing tab' },
    result: status === 'ready' ? structuredClone(mode === 'video' ? recordedVideo : recordedFile) : null,
    selection: status === 'ready' && mode === 'audio' ? { startSeconds: 0, endSeconds: 12 } : null,
  });
  if (download) state.download = structuredClone(download);
  const env = {
    calls, state, document,
    activeTab: { id: 17, title: 'A playing tab', url: 'https://example.test/player', active: true, windowId: 5 },
    tabsById: new Map(),
    items: new Map(),
    async capture() { return 'stream-for-tab-17'; },
    async download() { return 91; },
    async createDocument() {},
    async executeScript() {},
    async captureVisibleTab() { return screenshot; },
    async sendTabMessage() { return { ok: true }; },
    async prepareGif() { return structuredClone(recordedGif); },
    async startRecording() {},
    async viewportChanged() {},
    async getTab(tabId) {
      const tab = env.tabsById.get(tabId) || (env.activeTab?.id === tabId ? env.activeTab : null);
      if (!tab) throw new Error(`No tab with id: ${tabId}`);
      return structuredClone(tab);
    },
    async prepareExport(startSeconds, endSeconds) {
      return {
        url: 'blob:chrome-extension://recorder/clip-1',
        filename: 'tab-audio-2026-10-13-trim.mp4',
        bytes: 768, mimeType: recordedFile.mimeType,
        durationSeconds: endSeconds - startSeconds, startSeconds, endSeconds,
      };
    },
  };
  const record = (kind, data) => calls.push({ kind, data: structuredClone(data) });
  env.api = {
    runtime: {
      getURL: (path) => `chrome-extension://recorder/${path}`,
      async getContexts(options) {
        record('contexts', options);
        return env.document ? [{ contextType: 'OFFSCREEN_DOCUMENT' }] : [];
      },
      async sendMessage(message) {
        record('message', message);
        assert.equal(message.target, 'offscreen');
        assert.ok(env.document, 'messages require a live offscreen document');
        switch (message.type) {
          case 'STATUS': break;
          case 'START':
            Object.assign(state, { status: 'starting', mode: message.mode || 'audio', tab: message.tab, result: null });
            await env.startRecording(message);
            Object.assign(state, { status: 'recording', mode: message.mode || 'audio', tab: message.tab, result: null });
            break;
          case 'VIDEO_VIEWPORT_CHANGED':
            await env.viewportChanged(message);
            break;
          case 'SELECT_VIDEO':
            Object.assign(state, {
              status: 'selecting', mode: 'video', tab: message.tab,
              selectionToken: message.selectionToken, selectionUrl: message.tab.url,
            });
            break;
          case 'CANCEL_VIDEO': Object.assign(state, structuredClone(EMPTY_STATE)); break;
          case 'PAUSE': state.status = 'paused'; break;
          case 'RESUME': state.status = 'recording'; break;
          case 'STOP':
            Object.assign(state, { status: 'ready', result: structuredClone(state.mode === 'video' ? recordedVideo : recordedFile) });
            break;
          case 'SET_SELECTION':
            state.selection = { startSeconds: message.startSeconds, endSeconds: message.endSeconds };
            break;
          case 'PREPARE_EXPORT':
            state.status = 'trimming';
            try {
              state.exportResult = await env.prepareExport(message.startSeconds, message.endSeconds);
              state.selection = { startSeconds: message.startSeconds, endSeconds: message.endSeconds };
            } catch (error) {
              state.status = 'ready';
              return { ok: false, error: error.message, state: structuredClone(state) };
            }
            state.status = 'ready';
            break;
          case 'PREPARE_GIF':
            state.status = 'exporting';
            try {
              state.gifResult = await env.prepareGif();
            } catch (error) {
              state.status = 'ready';
              return { ok: false, error: error.message, state: structuredClone(state) };
            }
            state.status = 'ready';
            break;
          case 'DISCARD': Object.assign(state, structuredClone(EMPTY_STATE)); break;
          case 'DOWNLOAD_UPDATE': state.download = structuredClone(message.download); break;
          default: throw new Error(`Unexpected offscreen command: ${message.type}`);
        }
        return { ok: true, state: structuredClone(state) };
      },
    },
    offscreen: {
      async createDocument(options) {
        record('createDocument', options);
        await env.createDocument(options);
        env.document = true;
        record('documentReady', {});
      },
    },
    tabs: {
      async query(options) {
        record('queryTabs', options);
        return env.activeTab ? [structuredClone(env.activeTab)] : [];
      },
      async get(tabId) {
        record('getTab', tabId);
        return env.getTab(tabId);
      },
      async captureVisibleTab(windowId, options) {
        record('captureVisibleTab', { windowId, options });
        return env.captureVisibleTab(windowId, options);
      },
      async sendMessage(tabId, message, options) {
        record('sendTabMessage', { tabId, message, options });
        return env.sendTabMessage(tabId, message, options);
      },
    },
    scripting: {
      async executeScript(options) {
        record('executeScript', options);
        return env.executeScript(options);
      },
    },
    tabCapture: {
      async getMediaStreamId(options) {
        record('capture', options);
        assert.ok(env.document, 'create the document before issuing a short-lived stream ID');
        return env.capture(options);
      },
    },
    downloads: {
      async download(options) { record('download', options); return env.download(options); },
      async search(options) {
        record('searchDownloads', options);
        const item = env.items.get(options.id);
        return item ? [structuredClone(item)] : [];
      },
    },
    action: Object.fromEntries(['setBadgeText', 'setBadgeBackgroundColor', 'setTitle'].map((method) => [
      method, async (options) => record(method, options),
    ])),
  };
  env.controller = createController(env.api);
  return env;
}

const events = (env, kind) => env.calls.filter((call) => call.kind === kind);
const messages = (env, type) => events(env, 'message').filter((call) => call.data.type === type);

test('creates a persistent media document before routing the selected tab stream ID', async () => {
  const env = browser();
  const reply = await env.controller.handle({ type: 'START' });
  assert.equal(reply.ok, true);
  assert.equal(reply.state.status, 'recording');
  assert.deepEqual(events(env, 'capture').map(({ data }) => data), [{ targetTabId: 17 }]);
  assert.deepEqual(events(env, 'createDocument')[0].data.reasons, ['USER_MEDIA']);
  assert.ok(env.calls.findIndex((call) => call.kind === 'documentReady') <
    env.calls.findIndex((call) => call.kind === 'capture'));
  assert.deepEqual(messages(env, 'START')[0].data, {
    target: 'offscreen', type: 'START', streamId: 'stream-for-tab-17',
    tab: { id: 17, title: 'A playing tab' },
  });
  assert.equal(events(env, 'setBadgeText').at(-1).data.text, 'REC');
});

test('serializes simultaneous starts so only one capture and offscreen document are created', async () => {
  const env = browser();
  const entered = deferred();
  const release = deferred();
  env.createDocument = async () => { entered.resolve(); await release.promise; };
  const first = env.controller.handle({ type: 'START' });
  const second = env.controller.handle({ type: 'START' });
  await entered.promise;
  assert.equal(events(env, 'createDocument').length, 1);
  assert.equal(events(env, 'capture').length, 0);
  release.resolve();
  const [started, duplicate] = await Promise.all([first, second]);
  assert.equal(started.ok, true);
  assert.equal(duplicate.ok, false);
  assert.equal(duplicate.state.status, 'recording');
  assert.equal(events(env, 'capture').length, 1);
  assert.equal(messages(env, 'START').length, 1);
});

test('rejects browser and extension-store pages before asking for capture access', async (t) => {
  for (const url of [
    'chrome://settings/', 'edge://extensions/', 'about:blank',
    'chrome-extension://other-extension/page.html',
    'https://chromewebstore.google.com/detail/example/123',
    'https://chrome.google.com/webstore/detail/example/123',
    'https://microsoftedge.microsoft.com/addons/detail/example/123',
  ]) {
    await t.test(url, async () => {
      const env = browser();
      env.activeTab.url = url;
      const reply = await env.controller.handle({ type: 'START' });
      assert.equal(reply.ok, false);
      assert.equal(reply.state.status, 'idle');
      assert.equal(events(env, 'capture').length, 0);
      assert.equal(events(env, 'createDocument').length, 0);
    });
  }
});

test('a capture permission failure is reported and a later start can recover', async () => {
  const env = browser();
  env.capture = async () => { throw new Error('Extension has not been invoked for this tab'); };
  const failed = await env.controller.handle({ type: 'START' });
  assert.equal(failed.ok, false);
  assert.match(failed.error, /다시 클릭/);
  assert.equal(messages(env, 'START').length, 0);
  env.capture = async () => 'valid-stream';
  const retried = await env.controller.handle({ type: 'START' });
  assert.equal(retried.ok, true);
  assert.equal(events(env, 'createDocument').length, 1);
});

test('closing another active tab leaves the original recording running', async () => {
  const env = browser({ status: 'recording' });
  env.activeTab = { id: 88, title: 'Another tab', url: 'https://other.test/', active: true };
  await env.controller.onTabRemoved(88);
  assert.equal(env.state.status, 'recording');
  assert.equal(messages(env, 'STOP').length, 0);
  await env.controller.onTabRemoved(17);
  assert.equal(env.state.status, 'ready');
  assert.equal(messages(env, 'STOP').length, 1);
  assert.equal(events(env, 'queryTabs').length, 0);
});

test('manual stop targets the existing recording even after the active tab changes', async () => {
  const env = browser({ status: 'recording' });
  env.activeTab = { id: 88, title: 'Another tab', url: 'https://other.test/', active: true };
  const reply = await env.controller.handle({ type: 'STOP' });
  assert.equal(reply.ok, true);
  assert.equal(reply.state.tab.id, 17);
  assert.equal(reply.state.status, 'ready');
  assert.equal(events(env, 'queryTabs').length, 0);
});

test('cancelled Save As preserves the recording and permits a successful retry', async () => {
  const env = browser({ status: 'ready' });
  env.download = async () => { throw new Error('USER_CANCELED'); };
  const cancelled = await env.controller.handle({ type: 'SAVE' });
  assert.equal(cancelled.ok, false);
  assert.equal(cancelled.state.status, 'ready');
  assert.equal(cancelled.state.download.status, 'interrupted');
  assert.deepEqual(cancelled.state.result, recordedFile);
  env.download = async () => 92;
  env.items.set(92, { id: 92, state: 'complete' });
  const retried = await env.controller.handle({ type: 'SAVE' });
  assert.equal(retried.ok, true);
  assert.equal(retried.state.download.status, 'complete');
  assert.deepEqual(retried.state.result, recordedFile);
  assert.deepEqual(events(env, 'download').at(-1).data, {
    url: recordedFile.url, filename: recordedFile.filename,
    saveAs: true, conflictAction: 'uniquify',
  });
  assert.equal(messages(env, 'DISCARD').length, 0);
});

test('status remains readable while the native Save As dialog is unresolved', async () => {
  const env = browser({ status: 'ready' });
  const entered = deferred();
  const dialog = deferred();
  env.download = async () => { entered.resolve(); return dialog.promise; };
  const saving = env.controller.handle({ type: 'SAVE' });
  await entered.promise;
  const status = await env.controller.handle({ type: 'STATUS' });
  assert.equal(status.ok, true);
  assert.equal(status.state.download.status, 'pending');
  assert.equal(status.state.download.id, null);
  assert.deepEqual(status.state.result, recordedFile);
  env.items.set(93, { id: 93, state: 'complete' });
  dialog.resolve(93);
  assert.equal((await saving).state.download.status, 'complete');
});

test('a recreated worker recovers a Save As request that never acquired a download ID', async () => {
  const env = browser({
    status: 'ready', download: { id: null, status: 'pending', error: null },
  });
  const restarted = createController(env.api);
  const recovered = await restarted.handle({ type: 'STATUS' });
  assert.equal(recovered.ok, true);
  assert.equal(recovered.state.download.status, 'interrupted');
  assert.deepEqual(recovered.state.result, recordedFile);
  env.items.set(91, { id: 91, state: 'complete' });
  const retried = await restarted.handle({ type: 'SAVE' });
  assert.equal(retried.ok, true);
  assert.equal(retried.state.download.status, 'complete');
});

test('recreated workers reconcile completed, interrupted, and missing downloads', async (t) => {
  for (const finalState of ['complete', 'interrupted', 'missing']) {
    await t.test(finalState, async () => {
      const env = browser({ status: 'ready' });
      env.items.set(91, { id: 91, state: 'in_progress' });
      const pending = await env.controller.handle({ type: 'SAVE' });
      assert.equal(pending.state.download.status, 'pending');
      if (finalState === 'missing') env.items.delete(91);
      else env.items.set(91, { id: 91, state: finalState });
      const restarted = createController(env.api);
      const recovered = await restarted.handle({ type: 'STATUS' });
      assert.equal(recovered.ok, true);
      assert.equal(recovered.state.download.id, 91);
      assert.equal(recovered.state.download.status, finalState === 'complete' ? 'complete' : 'interrupted');
      assert.deepEqual(recovered.state.result, recordedFile);
      assert.equal(recovered.state.status, 'ready');
      assert.equal(events(env, 'download').length, 1);
    });
  }
});

test('pending downloads cannot be started twice and unrelated download events are ignored', async () => {
  const env = browser({ status: 'ready', download: { id: 91, status: 'pending', error: null } });
  env.items.set(91, { id: 91, state: 'in_progress' });
  const duplicate = await env.controller.handle({ type: 'SAVE' });
  assert.equal(duplicate.ok, false);
  assert.equal(events(env, 'download').length, 0);
  await env.controller.onDownloadChanged({ id: 999, state: { current: 'complete' } });
  assert.equal(messages(env, 'DOWNLOAD_UPDATE').length, 0);
  env.items.set(91, { id: 91, state: 'complete' });
  await env.controller.onDownloadChanged({ id: 91, state: { current: 'complete' } });
  assert.equal(env.state.download.status, 'complete');
});

test('the badge follows recording, pause, resume, stop, and discard', async () => {
  const env = browser();
  for (const [type, expected] of [
    ['START', 'REC'], ['PAUSE', 'Ⅱ'], ['RESUME', 'REC'], ['STOP', '↓'], ['DISCARD', ''],
  ]) {
    const reply = await env.controller.handle({ type });
    assert.equal(reply.ok, true, `${type} should succeed`);
    assert.equal(events(env, 'setBadgeText').at(-1).data.text, expected);
  }
});

test('a recreated worker reads an ongoing recording from the offscreen document', async () => {
  const env = browser({ status: 'paused' });
  env.state.elapsedMs = 4321;
  const restarted = createController(env.api);
  const reply = await restarted.handle({ type: 'STATUS' });
  assert.equal(reply.state.status, 'paused');
  assert.equal(reply.state.elapsedMs, 4321);
  assert.equal(reply.state.tab.id, 17);
  assert.equal(events(env, 'createDocument').length, 0);
  assert.equal(events(env, 'capture').length, 0);
});

test('a delayed tab-close notification cannot stop a newer recording in another tab', async () => {
  const env = browser({ status: 'recording' });
  const entered = deferred();
  const release = deferred();
  const send = env.api.runtime.sendMessage;
  let delayFirstStatus = true;
  env.api.runtime.sendMessage = async (message) => {
    const reply = await send(message);
    if (message.type === 'STATUS' && delayFirstStatus) {
      delayFirstStatus = false;
      entered.resolve();
      await release.promise;
    }
    return reply;
  };
  const removed = env.controller.onTabRemoved(17);
  await entered.promise;
  await env.controller.handle({ type: 'STOP' });
  await env.controller.handle({ type: 'DISCARD' });
  env.activeTab = { id: 88, title: 'New recording', url: 'https://other.test/', active: true };
  await env.controller.handle({ type: 'START' });
  release.resolve();
  await removed;
  assert.equal(env.state.tab.id, 88);
  assert.equal(env.state.status, 'recording');
  assert.equal(messages(env, 'STOP').length, 1, 'the stale close must not issue a second stop');
});

test('selection commands forward fractional boundaries and persist across a worker restart', async () => {
  const env = browser({ status: 'ready' });
  const range = { startSeconds: 1.125, endSeconds: 9.875 };
  const selected = await env.controller.handle({ type: 'SET_SELECTION', ...range });
  assert.equal(selected.ok, true);
  assert.deepEqual(selected.state.selection, range);
  assert.deepEqual(messages(env, 'SET_SELECTION')[0].data, { target: 'offscreen', type: 'SET_SELECTION', ...range });
  const restarted = createController(env.api);
  assert.deepEqual((await restarted.handle({ type: 'STATUS' })).state.selection, range);
  assert.equal(events(env, 'capture').length, 0);
  assert.equal(events(env, 'download').length, 0);
});

test('SAVE_RANGE downloads the prepared clip while SAVE still downloads the full original', async () => {
  const env = browser({ status: 'ready' });
  env.items.set(91, { id: 91, state: 'complete' });
  const range = { startSeconds: 1.25, endSeconds: 7.75 };
  const saved = await env.controller.handle({ type: 'SAVE_RANGE', ...range });
  assert.equal(saved.ok, true);
  assert.equal(saved.state.download.status, 'complete');
  assert.deepEqual(saved.state.result, recordedFile);
  assert.deepEqual(messages(env, 'PREPARE_EXPORT')[0].data, { target: 'offscreen', type: 'PREPARE_EXPORT', ...range });
  assert.deepEqual(events(env, 'download')[0].data, {
    url: saved.state.exportResult.url, filename: saved.state.exportResult.filename,
    saveAs: true, conflictAction: 'uniquify',
  });
  assert.notEqual(saved.state.exportResult.url, recordedFile.url);
  assert.equal(messages(env, 'START').length, 0, 'trimming never captures the tab again');
  const full = await env.controller.handle({ type: 'SAVE' });
  assert.equal(full.ok, true);
  assert.deepEqual(events(env, 'download')[1].data, {
    url: recordedFile.url, filename: recordedFile.filename,
    saveAs: true, conflictAction: 'uniquify',
  });
  assert.deepEqual(full.state.exportResult, saved.state.exportResult);
  assert.equal(messages(env, 'PREPARE_EXPORT').length, 1);
});

test('failed trim never opens a Save As dialog and preserves any prior exported clip', async () => {
  const env = browser({ status: 'ready' });
  const prior = await env.prepareExport(1, 4);
  env.state.exportResult = structuredClone(prior);
  env.prepareExport = async () => { throw new Error('선택한 구간을 자를 수 없어요.'); };
  const reply = await env.controller.handle({ type: 'SAVE_RANGE', startSeconds: 5, endSeconds: 9 });
  assert.equal(reply.ok, false);
  assert.match(reply.error, /자를 수 없어요/);
  assert.equal(reply.state.status, 'ready');
  assert.deepEqual(reply.state.result, recordedFile);
  assert.deepEqual(reply.state.exportResult, prior);
  assert.equal(events(env, 'download').length, 0);
  assert.equal(messages(env, 'DOWNLOAD_UPDATE').length, 0);
});

test('cancelled range saving retains selection and both files, allowing a successful retry', async () => {
  const env = browser({ status: 'ready' });
  const range = { startSeconds: 2, endSeconds: 10 };
  env.download = async () => { throw new Error('USER_CANCELED'); };
  const cancelled = await env.controller.handle({ type: 'SAVE_RANGE', ...range });
  assert.equal(cancelled.ok, false);
  assert.equal(cancelled.state.download.status, 'interrupted');
  assert.deepEqual(cancelled.state.result, recordedFile);
  assert.deepEqual(cancelled.state.selection, range);
  assert.ok(cancelled.state.exportResult.url);
  env.download = async () => 92;
  env.items.set(92, { id: 92, state: 'complete' });
  const retried = await env.controller.handle({ type: 'SAVE_RANGE', ...range });
  assert.equal(retried.ok, true);
  assert.equal(retried.state.download.status, 'complete');
  assert.deepEqual(retried.state.result, recordedFile);
  assert.deepEqual(retried.state.exportResult, cancelled.state.exportResult);
  assert.equal(messages(env, 'DISCARD').length, 0);
  assert.equal(events(env, 'download').length, 2);
});

test('STATUS remains readable while a range is being prepared and during its Save As dialog', async () => {
  const env = browser({ status: 'ready' });
  const entered = deferred();
  const releaseTrim = deferred();
  const pickerOpened = deferred();
  const dialog = deferred();
  const prepare = env.prepareExport;
  env.prepareExport = async (start, end) => {
    entered.resolve();
    await releaseTrim.promise;
    return prepare(start, end);
  };
  env.download = async () => { pickerOpened.resolve(); return dialog.promise; };
  const saving = env.controller.handle({ type: 'SAVE_RANGE', startSeconds: 2, endSeconds: 8 });
  await entered.promise;
  const busy = await env.controller.handle({ type: 'STATUS' });
  assert.equal(busy.ok, true);
  assert.equal(busy.state.status, 'trimming');
  assert.deepEqual(busy.state.result, recordedFile);
  assert.equal(events(env, 'download').length, 0);
  releaseTrim.resolve();
  await pickerOpened.promise;
  const pending = await env.controller.handle({ type: 'STATUS' });
  assert.equal(pending.state.status, 'ready');
  assert.equal(pending.state.download.status, 'pending');
  assert.equal(pending.state.download.id, null);
  assert.ok(pending.state.exportResult.url);
  env.items.set(93, { id: 93, state: 'complete' });
  dialog.resolve(93);
  assert.equal((await saving).state.download.status, 'complete');
});

test('a pending download blocks SAVE_RANGE before any trim is started', async () => {
  const env = browser({ status: 'ready', download: { id: 91, status: 'pending', error: null } });
  env.items.set(91, { id: 91, state: 'in_progress' });
  const reply = await env.controller.handle({ type: 'SAVE_RANGE', startSeconds: 0, endSeconds: 5 });
  assert.equal(reply.ok, false);
  assert.equal(messages(env, 'PREPARE_EXPORT').length, 0);
  assert.equal(events(env, 'download').length, 0);
  assert.deepEqual(reply.state.result, recordedFile);
});

test('a recreated worker recovers a cancelled clip picker without losing the clip or selection', async () => {
  const env = browser({ status: 'ready', download: { id: null, status: 'pending', error: null } });
  const range = { startSeconds: 1, endSeconds: 5 };
  const clip = await env.prepareExport(range.startSeconds, range.endSeconds);
  env.state.selection = structuredClone(range);
  env.state.exportResult = structuredClone(clip);
  const restarted = createController(env.api);
  const status = await restarted.handle({ type: 'STATUS' });
  assert.equal(status.state.download.status, 'interrupted');
  assert.deepEqual(status.state.result, recordedFile);
  assert.deepEqual(status.state.exportResult, clip);
  assert.deepEqual(status.state.selection, range);
  env.items.set(91, { id: 91, state: 'complete' });
  const saved = await restarted.handle({ type: 'SAVE_RANGE', ...range });
  assert.equal(saved.ok, true);
  assert.equal(saved.state.download.status, 'complete');
  assert.deepEqual(events(env, 'download')[0].data, {
    url: clip.url, filename: clip.filename, saveAs: true, conflictAction: 'uniquify',
  });
});

test('arming page shortcuts injects only into the active tab without starting capture', async () => {
  const env = browser();
  const reply = await env.controller.handle({ type: 'ARM_SHORTCUTS' });
  assert.equal(reply.ok, true);
  assert.equal(reply.state.status, 'idle');
  assert.deepEqual(events(env, 'queryTabs').map(({ data }) => data), [{ active: true, currentWindow: true }]);
  assert.deepEqual(events(env, 'executeScript').map(({ data }) => data), [{
    target: { tabId: 17 }, files: ['region-selector.js', 'page-shortcuts.js'],
  }]);
  assert.equal(events(env, 'capture').length, 0);
  assert.equal(events(env, 'createDocument').length, 0);
  assert.equal(messages(env, 'START').length, 0);
});

test('arming shortcuts on browser and store pages fails before any injection', async (t) => {
  for (const url of [
    'chrome://settings/', 'edge://extensions/', 'about:blank',
    'chrome-extension://other-extension/page.html',
    'https://chromewebstore.google.com/detail/example/123',
    'https://chrome.google.com/webstore/detail/example/123',
    'https://microsoftedge.microsoft.com/addons/detail/example/123',
  ]) {
    await t.test(url, async () => {
      const env = browser();
      env.activeTab.url = url;
      const reply = await env.controller.handle({ type: 'ARM_SHORTCUTS' });
      assert.equal(reply.ok, false);
      assert.ok(reply.error);
      assert.equal(events(env, 'executeScript').length, 0);
      assert.equal(events(env, 'capture').length, 0);
      assert.equal(events(env, 'createDocument').length, 0);
    });
  }
});

test('missing tabs and denied script access give an actionable shortcut activation error', async () => {
  const missing = browser();
  missing.activeTab = null;
  const absent = await missing.controller.handle({ type: 'ARM_SHORTCUTS' });
  assert.equal(absent.ok, false);
  assert.ok(absent.error);
  assert.equal(events(missing, 'executeScript').length, 0);

  const denied = browser();
  denied.executeScript = async () => { throw new Error('Cannot access contents of the page'); };
  const reply = await denied.controller.handle({ type: 'ARM_SHORTCUTS' });
  assert.equal(reply.ok, false);
  assert.match(reply.error, /확장 프로그램|다시|권한/);
  assert.equal(reply.state.status, 'idle');
  assert.equal(events(denied, 'capture').length, 0);
  assert.equal(events(denied, 'createDocument').length, 0);
});

test('arming another page does not replace or stop the original recording', async () => {
  const env = browser({ status: 'recording' });
  env.activeTab = { id: 88, title: 'Another tab', url: 'https://other.test/', active: true };
  const reply = await env.controller.handle({ type: 'ARM_SHORTCUTS' });
  assert.equal(reply.ok, true);
  assert.equal(reply.state.status, 'recording');
  assert.equal(reply.state.tab.id, 17);
  assert.deepEqual(events(env, 'executeScript')[0].data.target, { tabId: 88 });
  assert.equal(messages(env, 'STOP').length, 0);
  assert.equal(events(env, 'capture').length, 0);
});

test('page START resolves and captures the explicit source tab', async () => {
  const env = browser();
  env.activeTab = { id: 88, title: 'Page key source', url: 'https://other.test/player', active: true };
  const reply = await env.controller.handle({ type: 'START', targetTabId: 88 });
  assert.equal(reply.ok, true);
  assert.equal(reply.state.status, 'recording');
  assert.deepEqual(events(env, 'getTab').map(({ data }) => data), [88]);
  assert.deepEqual(events(env, 'capture').map(({ data }) => data), [{ targetTabId: 88 }]);
  assert.deepEqual(messages(env, 'START')[0].data.tab, { id: 88, title: 'Page key source' });
  assert.equal(reply.state.tab.id, 88);
});

test('closed, malformed, restricted, and inactive page START targets never fall back to another tab', async (t) => {
  const cases = [
    { name: 'closed target', targetTabId: 88 },
    { name: 'negative target', targetTabId: -1 },
    { name: 'text target', targetTabId: '17' },
    { name: 'null target', targetTabId: null },
    { name: 'fractional target', targetTabId: 17.5 },
    { name: 'nonfinite target', targetTabId: NaN },
    { name: 'inactive target', targetTabId: 88, tab: { id: 88, title: 'Background', url: 'https://other.test/', active: false } },
    { name: 'different active window', targetTabId: 88, tab: { id: 88, title: 'Other window', url: 'https://other.test/', active: true } },
    { name: 'restricted target', targetTabId: 17, tab: { id: 17, title: 'Settings', url: 'chrome://settings/', active: true } },
    { name: 'store target', targetTabId: 17, tab: { id: 17, title: 'Store', url: 'https://chromewebstore.google.com/detail/example/123', active: true } },
  ];
  for (const item of cases) {
    await t.test(item.name, async () => {
      const env = browser();
      if (item.tab) env.tabsById.set(item.tab.id, item.tab);
      const reply = await env.controller.handle({ type: 'START', targetTabId: item.targetTabId });
      assert.equal(reply.ok, false);
      assert.ok(reply.error);
      assert.equal(reply.state.status, 'idle');
      assert.equal(events(env, 'capture').length, 0);
      assert.equal(events(env, 'createDocument').length, 0);
      assert.equal(messages(env, 'START').length, 0);
    });
  }
});

test('PAGE_STOP stops only its source recording, including a paused source after switching tabs', async (t) => {
  for (const status of ['recording', 'paused']) {
    await t.test(status, async () => {
      const env = browser({ status });
      env.activeTab = { id: 88, title: 'Another tab', url: 'https://other.test/', active: true };
      const reply = await env.controller.handle({ type: 'PAGE_STOP', targetTabId: 17 });
      assert.equal(reply.ok, true);
      assert.equal(reply.state.status, 'ready');
      assert.equal(reply.state.tab.id, 17);
      assert.equal(messages(env, 'STOP').length, 1);
      assert.equal(events(env, 'capture').length, 0);
      assert.equal(events(env, 'queryTabs').length, 0);
    });
  }
});

test('PAGE_STOP from another page cannot stop the original source and ordinary STOP still can', async () => {
  const env = browser({ status: 'recording' });
  env.activeTab = { id: 88, title: 'Another tab', url: 'https://other.test/', active: true };
  const wrongSource = await env.controller.handle({ type: 'PAGE_STOP', targetTabId: 88 });
  assert.equal(wrongSource.ok, false);
  assert.ok(wrongSource.error);
  assert.equal(wrongSource.state.status, 'recording');
  assert.equal(wrongSource.state.tab.id, 17);
  assert.equal(messages(env, 'STOP').length, 0);
  const stopped = await env.controller.handle({ type: 'STOP' });
  assert.equal(stopped.ok, true);
  assert.equal(stopped.state.status, 'ready');
  assert.equal(stopped.state.tab.id, 17);
  assert.equal(messages(env, 'STOP').length, 1);
});

test('PAGE_STOP cannot stop idle, finalizing, ready, or trimming state', async (t) => {
  for (const status of ['idle', 'starting', 'stopping', 'ready', 'trimming', 'error']) {
    await t.test(status, async () => {
      const env = browser({ status });
      const reply = await env.controller.handle({ type: 'PAGE_STOP', targetTabId: 17 });
      assert.equal(reply.ok, false);
      assert.ok(reply.error);
      assert.equal(reply.state.status, status);
      assert.equal(messages(env, 'STOP').length, 0);
      assert.equal(events(env, 'capture').length, 0);
    });
  }
});

test('BEGIN_VIDEO captures a still image before reserving the source tab for region selection', async () => {
  const env = browser();
  const reply = await env.controller.handle({ type: 'BEGIN_VIDEO', targetTabId: 17 });
  assert.equal(reply.ok, true);
  assert.equal(reply.imageDataUrl, screenshot);
  assert.equal(typeof reply.selectionToken, 'string');
  assert.ok(reply.selectionToken.length > 0);
  assert.equal(reply.state.status, 'selecting');
  assert.equal(reply.state.mode, 'video');
  assert.equal(reply.state.tab.id, 17);
  assert.equal(reply.state.selectionToken, reply.selectionToken);
  assert.deepEqual(events(env, 'captureVisibleTab').map(({ data }) => data), [{ windowId: 5, options: { format: 'png' } }]);
  assert.equal(events(env, 'capture').length, 0, 'stream capture begins only after a region is selected');
  assert.equal(messages(env, 'SELECT_VIDEO').length, 1);
  assert.equal(messages(env, 'SELECT_VIDEO')[0].data.selectionToken, reply.selectionToken);
  const again = await env.controller.handle({ type: 'BEGIN_VIDEO', targetTabId: 17 });
  assert.equal(again.ok, false);
  assert.equal(events(env, 'captureVisibleTab').length, 1);
});

test('switching tabs while the selection screenshot is captured cannot reserve the wrong page', async () => {
  const env = browser();
  const entered = deferred();
  const imageReady = deferred();
  env.captureVisibleTab = async () => { entered.resolve(); return imageReady.promise; };
  const beginning = env.controller.handle({ type: 'BEGIN_VIDEO', targetTabId: 17 });
  await entered.promise;
  env.activeTab = { id: 88, title: 'Different tab', url: 'https://other.test/', active: true, windowId: 5 };
  imageReady.resolve(screenshot);
  const reply = await beginning;
  assert.equal(reply.ok, false);
  assert.equal(reply.state.status, 'idle');
  assert.equal(messages(env, 'SELECT_VIDEO').length, 0);
  assert.equal(events(env, 'capture').length, 0);
});

test('failed screenshots and an existing audio recording never begin a video selection', async () => {
  const denied = browser();
  denied.captureVisibleTab = async () => { throw new Error('capture denied'); };
  const failed = await denied.controller.handle({ type: 'BEGIN_VIDEO', targetTabId: 17 });
  assert.equal(failed.ok, false);
  assert.ok(failed.error);
  assert.equal(failed.state.status, 'idle');
  assert.equal(messages(denied, 'SELECT_VIDEO').length, 0);
  const busy = browser({ status: 'recording' });
  const blocked = await busy.controller.handle({ type: 'BEGIN_VIDEO', targetTabId: 17 });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.state.status, 'recording');
  assert.equal(blocked.state.mode, 'audio');
  assert.equal(events(busy, 'captureVisibleTab').length, 0);
  assert.equal(messages(busy, 'SELECT_VIDEO').length, 0);
});

test('START_VIDEO requires the current selection token and its canonical source tab', async () => {
  const env = browser();
  const selection = await env.controller.handle({ type: 'BEGIN_VIDEO', targetTabId: 17 });
  assert.equal(selection.ok, true);
  for (const args of [
    { targetTabId: 17, selectionToken: 'forged-token' },
    { targetTabId: 88, selectionToken: selection.selectionToken },
    { targetTabId: 17 },
    { selectionToken: selection.selectionToken },
  ]) {
    const failed = await env.controller.handle({ type: 'START_VIDEO', ...args, region: selectedRegion });
    assert.equal(failed.ok, false);
    assert.equal(failed.state.status, 'selecting');
    assert.equal(failed.state.selectionToken, selection.selectionToken);
  }
  assert.equal(events(env, 'capture').length, 0);
  const started = await env.controller.handle({
    type: 'START_VIDEO', targetTabId: 17, selectionToken: selection.selectionToken, region: selectedRegion,
  });
  assert.equal(started.ok, true);
  assert.equal(started.state.status, 'recording');
  assert.equal(started.state.mode, 'video');
  assert.deepEqual(events(env, 'capture').map(({ data }) => data), [{ targetTabId: 17 }]);
  const command = messages(env, 'START')[0].data;
  assert.equal(command.mode, 'video');
  assert.equal(command.tab.id, 17);
  assert.equal(command.selectionToken, selection.selectionToken);
  assert.deepEqual(command.region, selectedRegion);
  const replayed = await env.controller.handle({
    type: 'START_VIDEO', targetTabId: 17, selectionToken: selection.selectionToken, region: selectedRegion,
  });
  assert.equal(replayed.ok, false);
  assert.equal(events(env, 'capture').length, 1);
});

test('invalid, out-of-bounds, and tiny video regions fail before requesting a stream', async () => {
  const env = browser();
  for (const region of [
    null, {}, { ...selectedRegion, x: NaN }, { ...selectedRegion, y: Infinity },
    { ...selectedRegion, x: -0.1 }, { ...selectedRegion, y: 0.9 },
    { ...selectedRegion, x: 0.9 }, { ...selectedRegion, width: 0 },
    { ...selectedRegion, width: '0.4' }, { ...selectedRegion, height: -0.2 },
    { ...selectedRegion, viewportWidth: 0 }, { ...selectedRegion, viewportHeight: NaN },
    { ...selectedRegion, width: 0.001 }, { ...selectedRegion, height: 0.001 },
  ]) {
    const selection = await env.controller.handle({ type: 'BEGIN_VIDEO', targetTabId: 17 });
    assert.equal(selection.ok, true);
    const reply = await env.controller.handle({
      type: 'START_VIDEO', targetTabId: 17, selectionToken: selection.selectionToken, region,
    });
    assert.equal(reply.ok, false, `invalid region: ${JSON.stringify(region)}`);
    assert.equal(reply.state.status, 'idle', 'a failed region releases the video selection');
  }
  assert.equal(events(env, 'capture').length, 0);
  assert.equal(messages(env, 'START').length, 0);
});

test('an inactive source cannot start video after selection and releases its reservation', async () => {
  const env = browser();
  const selection = await env.controller.handle({ type: 'BEGIN_VIDEO', targetTabId: 17 });
  env.tabsById.set(17, { ...env.activeTab, active: false });
  env.activeTab = { id: 88, title: 'Different tab', url: 'https://other.test/', active: true, windowId: 5 };
  const reply = await env.controller.handle({
    type: 'START_VIDEO', targetTabId: 17, selectionToken: selection.selectionToken, region: selectedRegion,
  });
  assert.equal(reply.ok, false);
  assert.equal(reply.state.status, 'idle');
  assert.equal(events(env, 'capture').length, 0);
  assert.equal(messages(env, 'CANCEL_VIDEO').length, 1);
});

test('late selector callbacks cannot start or cancel a newer video selection', async () => {
  const env = browser();
  const first = await env.controller.handle({ type: 'BEGIN_VIDEO', targetTabId: 17 });
  const wrongTab = await env.controller.handle({ type: 'CANCEL_VIDEO', targetTabId: 88, selectionToken: first.selectionToken });
  assert.equal(wrongTab.ok, false);
  assert.equal(wrongTab.state.status, 'selecting');
  const cancelled = await env.controller.handle({ type: 'CANCEL_VIDEO', targetTabId: 17, selectionToken: first.selectionToken });
  assert.equal(cancelled.ok, true);
  assert.equal(cancelled.state.status, 'idle');
  const second = await env.controller.handle({ type: 'BEGIN_VIDEO', targetTabId: 17 });
  assert.equal(second.ok, true);
  assert.notEqual(second.selectionToken, first.selectionToken);
  for (const type of ['START_VIDEO', 'CANCEL_VIDEO']) {
    const stale = await env.controller.handle({ type, targetTabId: 17, selectionToken: first.selectionToken, region: selectedRegion });
    assert.equal(stale.ok, false);
    assert.equal(stale.state.status, 'selecting');
    assert.equal(stale.state.selectionToken, second.selectionToken);
  }
  assert.equal(events(env, 'capture').length, 0);
  const popupCancel = await env.controller.handle({ type: 'CANCEL_VIDEO' });
  assert.equal(popupCancel.ok, true);
  assert.equal(popupCancel.state.status, 'idle');
});

test('video stop cancels a selection and never stops audio or another tab recording', async () => {
  const selecting = browser();
  await selecting.controller.handle({ type: 'BEGIN_VIDEO', targetTabId: 17 });
  const cancelled = await selecting.controller.handle({ type: 'STOP_VIDEO', targetTabId: 17 });
  assert.equal(cancelled.ok, true);
  assert.equal(cancelled.state.status, 'idle');
  assert.equal(messages(selecting, 'STOP').length, 0);
  for (const [mode, targetTabId] of [['audio', 17], ['video', 88]]) {
    const env = browser({ status: 'recording', mode });
    const reply = await env.controller.handle({ type: 'STOP_VIDEO', targetTabId });
    assert.equal(reply.ok, false);
    assert.equal(reply.state.status, 'recording');
    assert.equal(messages(env, 'STOP').length, 0);
  }
});

test('the audio stop key cannot terminate video, while the matching video key can stop or pause-finish it', async () => {
  for (const status of ['recording', 'paused']) {
    const env = browser({ status, mode: 'video' });
    const audioStop = await env.controller.handle({ type: 'PAGE_STOP', targetTabId: 17 });
    assert.equal(audioStop.ok, false);
    assert.equal(audioStop.state.status, status);
    assert.equal(messages(env, 'STOP').length, 0);
    const videoStop = await env.controller.handle({ type: 'STOP_VIDEO', targetTabId: 17 });
    assert.equal(videoStop.ok, true);
    assert.equal(videoStop.state.status, 'ready');
    assert.equal(videoStop.state.result.kind, 'video');
    assert.equal(messages(env, 'STOP').length, 1);
  }
});

test('opening the video selector injects the page UI and waits for acknowledgement without capturing', async () => {
  const env = browser();
  const reply = await env.controller.handle({ type: 'OPEN_VIDEO_SELECTOR', targetTabId: 17 });
  assert.equal(reply.ok, true);
  assert.deepEqual(events(env, 'executeScript')[0].data, {
    target: { tabId: 17 }, files: ['region-selector.js', 'page-shortcuts.js'],
  });
  const shown = events(env, 'sendTabMessage')[0].data;
  assert.equal(shown.tabId, 17);
  assert.equal(shown.message.type, 'SHOW_VIDEO_SELECTOR');
  assert.deepEqual(shown.options, { frameId: 0 });
  assert.equal(events(env, 'captureVisibleTab').length, 0);
  assert.equal(events(env, 'capture').length, 0);
  assert.equal(messages(env, 'SELECT_VIDEO').length, 0);
  for (const acknowledgement of [undefined, { ok: false }]) {
    env.sendTabMessage = async () => acknowledgement;
    const failed = await env.controller.handle({ type: 'OPEN_VIDEO_SELECTOR', targetTabId: 17 });
    assert.equal(failed.ok, false);
    assert.ok(failed.error);
  }
});

test('SAVE_VIDEO chooses MP4 or the prepared GIF while retaining the original video', async () => {
  const env = browser({ status: 'ready', mode: 'video' });
  env.items.set(91, { id: 91, state: 'complete' });
  const gif = await env.controller.handle({ type: 'SAVE_VIDEO', format: 'gif' });
  assert.equal(gif.ok, true);
  assert.equal(gif.state.download.status, 'complete');
  assert.deepEqual(gif.state.result, recordedVideo);
  assert.deepEqual(gif.state.gifResult, recordedGif);
  assert.equal(messages(env, 'PREPARE_GIF').length, 1);
  assert.deepEqual(events(env, 'download')[0].data, {
    url: recordedGif.url, filename: recordedGif.filename, saveAs: true, conflictAction: 'uniquify',
  });
  const mp4 = await env.controller.handle({ type: 'SAVE_VIDEO', format: 'mp4' });
  assert.equal(mp4.ok, true);
  assert.deepEqual(mp4.state.result, recordedVideo);
  assert.deepEqual(events(env, 'download')[1].data, {
    url: recordedVideo.url, filename: recordedVideo.filename, saveAs: true, conflictAction: 'uniquify',
  });
  assert.equal(messages(env, 'PREPARE_GIF').length, 1);
});

test('failed GIF conversion never opens a picker and leaves MP4 available to save', async () => {
  const env = browser({ status: 'ready', mode: 'video' });
  env.prepareGif = async () => { throw new Error('GIF conversion failed'); };
  const failed = await env.controller.handle({ type: 'SAVE_VIDEO', format: 'gif' });
  assert.equal(failed.ok, false);
  assert.match(failed.error, /GIF conversion failed/);
  assert.deepEqual(failed.state.result, recordedVideo);
  assert.equal(events(env, 'download').length, 0);
  assert.equal(messages(env, 'DOWNLOAD_UPDATE').length, 0);
  env.items.set(91, { id: 91, state: 'complete' });
  const original = await env.controller.handle({ type: 'SAVE_VIDEO', format: 'mp4' });
  assert.equal(original.ok, true);
  assert.equal(events(env, 'download')[0].data.url, recordedVideo.url);
});

test('cancelled GIF saving preserves both files across worker restart and a successful retry', async () => {
  const env = browser({ status: 'ready', mode: 'video' });
  env.download = async () => { throw new Error('USER_CANCELED'); };
  const cancelled = await env.controller.handle({ type: 'SAVE_VIDEO', format: 'gif' });
  assert.equal(cancelled.ok, false);
  assert.equal(cancelled.state.download.status, 'interrupted');
  assert.deepEqual(cancelled.state.result, recordedVideo);
  assert.deepEqual(cancelled.state.gifResult, recordedGif);
  const restarted = createController(env.api);
  const status = await restarted.handle({ type: 'STATUS' });
  assert.deepEqual(status.state.gifResult, recordedGif);
  env.download = async () => 92;
  env.items.set(92, { id: 92, state: 'complete' });
  const retry = await restarted.handle({ type: 'SAVE_VIDEO', format: 'gif' });
  assert.equal(retry.ok, true);
  assert.equal(retry.state.download.status, 'complete');
  assert.deepEqual(retry.state.result, recordedVideo);
  assert.deepEqual(retry.state.gifResult, recordedGif);
  assert.equal(events(env, 'download').at(-1).data.url, recordedGif.url);
  assert.equal(messages(env, 'DISCARD').length, 0);
});

test('video saving rejects audio, unknown formats, and a second pending download before conversion', async () => {
  const audio = browser({ status: 'ready' });
  assert.equal((await audio.controller.handle({ type: 'SAVE_VIDEO', format: 'gif' })).ok, false);
  assert.equal(messages(audio, 'PREPARE_GIF').length, 0);
  assert.equal(events(audio, 'download').length, 0);
  const video = browser({ status: 'ready', mode: 'video' });
  assert.equal((await video.controller.handle({ type: 'SAVE_VIDEO', format: 'webm' })).ok, false);
  assert.equal(events(video, 'download').length, 0);
  video.state.download = { id: 91, status: 'pending', error: null };
  video.items.set(91, { id: 91, state: 'in_progress' });
  assert.equal((await video.controller.handle({ type: 'SAVE_VIDEO', format: 'gif' })).ok, false);
  assert.equal(messages(video, 'PREPARE_GIF').length, 0);
  assert.equal(events(video, 'download').length, 0);
});

test('page navigation or closing cancels only the matching source selector even when its UI is gone', async () => {
  for (const event of ['navigation', 'close']) {
    const env = browser();
    const selection = await env.controller.handle({ type: 'BEGIN_VIDEO', targetTabId: 17 });
    await env.controller.onTabUpdated(88, { status: 'loading' });
    await env.controller.onTabUpdated(17, { status: 'complete' });
    await env.controller.onTabRemoved(88);
    assert.equal(env.state.status, 'selecting');
    assert.equal(messages(env, 'CANCEL_VIDEO').length, 0);
    env.sendTabMessage = async () => { throw new Error('No receiver after navigation'); };
    if (event === 'navigation') await env.controller.onTabUpdated(17, { status: 'loading' });
    else await env.controller.onTabRemoved(17);
    assert.equal(env.state.status, 'idle');
    assert.equal(messages(env, 'CANCEL_VIDEO').length, 1);
    assert.equal(messages(env, 'CANCEL_VIDEO')[0].data.selectionToken, selection.selectionToken);
    assert.deepEqual(events(env, 'sendTabMessage').at(-1).data, {
      tabId: 17, message: { type: 'CANCEL_VIDEO_SELECTOR' }, options: { frameId: 0 },
    });
  }
});

test('a delayed navigation notification cannot cancel a newer selection in the same tab', async () => {
  const env = browser();
  const first = await env.controller.handle({ type: 'BEGIN_VIDEO', targetTabId: 17 });
  const entered = deferred();
  const release = deferred();
  const send = env.api.runtime.sendMessage;
  let delayStatus = true;
  env.api.runtime.sendMessage = async (message) => {
    const reply = await send(message);
    if (message.type === 'STATUS' && delayStatus) {
      delayStatus = false;
      entered.resolve();
      await release.promise;
    }
    return reply;
  };
  const navigation = env.controller.onTabUpdated(17, { status: 'loading' });
  await entered.promise;
  await env.controller.handle({ type: 'CANCEL_VIDEO' });
  const newer = await env.controller.handle({ type: 'BEGIN_VIDEO', targetTabId: 17 });
  assert.notEqual(newer.selectionToken, first.selectionToken);
  release.resolve();
  await navigation;
  assert.equal(env.state.status, 'selecting');
  assert.equal(env.state.selectionToken, newer.selectionToken);
  assert.equal(messages(env, 'CANCEL_VIDEO').length, 1, 'only the explicit cancellation may reach offscreen');
});

test('a changed source URL invalidates a selected region even when the tab ID remains the same', async () => {
  const env = browser();
  const selection = await env.controller.handle({ type: 'BEGIN_VIDEO', targetTabId: 17 });
  env.activeTab.url = 'https://example.test/different-page';
  const reply = await env.controller.handle({
    type: 'START_VIDEO', targetTabId: 17, selectionToken: selection.selectionToken, region: selectedRegion,
  });
  assert.equal(reply.ok, false);
  assert.equal(reply.state.status, 'idle');
  assert.equal(events(env, 'capture').length, 0);
  assert.equal(messages(env, 'START').length, 0);
});

test('STATUS remains readable during GIF conversion and the later Save As dialog', async () => {
  const env = browser({ status: 'ready', mode: 'video' });
  const conversionEntered = deferred();
  const conversion = deferred();
  const pickerEntered = deferred();
  const picker = deferred();
  env.prepareGif = async () => { conversionEntered.resolve(); return conversion.promise; };
  env.download = async () => { pickerEntered.resolve(); return picker.promise; };
  const saving = env.controller.handle({ type: 'SAVE_VIDEO', format: 'gif' });
  await conversionEntered.promise;
  const converting = await env.controller.handle({ type: 'STATUS' });
  assert.equal(converting.ok, true);
  assert.equal(converting.state.status, 'exporting');
  assert.deepEqual(converting.state.result, recordedVideo);
  assert.equal(events(env, 'download').length, 0);
  conversion.resolve(structuredClone(recordedGif));
  await pickerEntered.promise;
  const downloading = await env.controller.handle({ type: 'STATUS' });
  assert.equal(downloading.state.download.status, 'pending');
  assert.equal(downloading.state.download.id, null);
  assert.deepEqual(downloading.state.result, recordedVideo);
  assert.deepEqual(downloading.state.gifResult, recordedGif);
  env.items.set(93, { id: 93, state: 'complete' });
  picker.resolve(93);
  assert.equal((await saving).state.download.status, 'complete');
});

test('viewport change signals reach offscreen while video startup is awaiting capture', { timeout: 3000 }, async () => {
  for (const stage of ['stream-id', 'offscreen-start']) {
    const env = browser();
    const selected = await env.controller.handle({ type: 'BEGIN_VIDEO', targetTabId: 17 });
    assert.equal(selected.ok, true);
    const entered = deferred();
    const release = deferred();
    if (stage === 'stream-id') {
      env.capture = async () => { entered.resolve(); await release.promise; return 'video-stream'; };
    } else {
      env.startRecording = async () => { entered.resolve(); await release.promise; };
    }
    const starting = env.controller.handle({
      type: 'START_VIDEO', targetTabId: 17, selectionToken: selected.selectionToken, region: selectedRegion,
    });
    await entered.promise;
    let finished = false;
    starting.then(() => { finished = true; });
    try {
      const changed = await env.controller.handle({
        type: 'VIDEO_VIEWPORT_CHANGED', targetTabId: 17, selectionToken: selected.selectionToken,
      });
      assert.equal(changed.ok, true);
      assert.equal(finished, false, `${stage}: viewport notification must bypass the pending START command`);
      assert.deepEqual(messages(env, 'VIDEO_VIEWPORT_CHANGED').map(({ data }) => data), [{
        target: 'offscreen', type: 'VIDEO_VIEWPORT_CHANGED', tabId: 17, selectionToken: selected.selectionToken,
      }]);
      assert.equal(changed.state.status, stage === 'stream-id' ? 'selecting' : 'starting');
    } finally {
      release.resolve();
      await starting;
    }
  }
});

test('stale viewport signals retain source and session scope without controller-level stop or cancellation', async () => {
  for (const mode of ['audio', 'video']) {
    const env = browser({ status: 'recording', mode });
    env.state.selectionToken = 'new-selection';
    const before = structuredClone(env.state);
    const reply = await env.controller.handle({
      type: 'VIDEO_VIEWPORT_CHANGED', targetTabId: 88, selectionToken: 'old-selection',
    });
    assert.equal(reply.ok, true);
    assert.deepEqual(reply.state, before, 'the recorder decides whether the scoped signal belongs to its current session');
    assert.deepEqual(messages(env, 'VIDEO_VIEWPORT_CHANGED')[0].data, {
      target: 'offscreen', type: 'VIDEO_VIEWPORT_CHANGED', tabId: 88, selectionToken: 'old-selection',
    });
    assert.equal(messages(env, 'STOP').length, 0);
    assert.equal(messages(env, 'CANCEL_VIDEO').length, 0);
    assert.equal(events(env, 'capture').length, 0);
  }
});

test('viewport change signals reject malformed source or session fields before sending to offscreen', async () => {
  const env = browser({ status: 'recording', mode: 'video' });
  for (const args of [
    { selectionToken: 'selection-a' },
    { targetTabId: null, selectionToken: 'selection-a' },
    { targetTabId: '17', selectionToken: 'selection-a' },
    { targetTabId: 17.5, selectionToken: 'selection-a' },
    { targetTabId: NaN, selectionToken: 'selection-a' },
    { targetTabId: 17 },
    { targetTabId: 17, selectionToken: null },
    { targetTabId: 17, selectionToken: 1 },
    { targetTabId: 17, selectionToken: {} },
  ]) {
    const reply = await env.controller.handle({ type: 'VIDEO_VIEWPORT_CHANGED', ...args });
    assert.equal(reply.ok, false, JSON.stringify(args));
    assert.equal(reply.state.status, 'recording');
    assert.equal(reply.state.mode, 'video');
  }
  assert.equal(messages(env, 'VIDEO_VIEWPORT_CHANGED').length, 0);
  assert.equal(messages(env, 'STOP').length, 0);
  assert.equal(messages(env, 'CANCEL_VIDEO').length, 0);
});

test('source navigation forwards the active video session nonce during startup, recording, and pause', async () => {
  for (const status of ['starting', 'recording', 'paused']) {
    const env = browser({ status, mode: 'video' });
    env.state.videoSessionToken = `video-session-${status}`;
    env.state.selectionToken = 'unrelated-selection-token';
    await env.controller.onTabUpdated(88, { status: 'loading' });
    await env.controller.onTabUpdated(17, { status: 'complete' });
    assert.equal(messages(env, 'VIDEO_VIEWPORT_CHANGED').length, 0);
    await env.controller.onTabUpdated(17, { status: 'loading' });
    assert.deepEqual(messages(env, 'VIDEO_VIEWPORT_CHANGED').map(({ data }) => data), [{
      target: 'offscreen', type: 'VIDEO_VIEWPORT_CHANGED', tabId: 17, selectionToken: `video-session-${status}`,
    }]);
    assert.equal(messages(env, 'STOP').length, 0, 'navigation must use the session-scoped signal');
    assert.equal(messages(env, 'CANCEL_VIDEO').length, 0);
  }
  const audio = browser({ status: 'recording', mode: 'audio' });
  await audio.controller.onTabUpdated(17, { status: 'loading' });
  assert.equal(messages(audio, 'VIDEO_VIEWPORT_CHANGED').length, 0);
  assert.equal(messages(audio, 'STOP').length, 0);
});

test('delayed source navigation retains its old nonce and cannot end a newer video session', async () => {
  const env = browser({ status: 'recording', mode: 'video' });
  env.state.videoSessionToken = 'old-video-session';
  const entered = deferred();
  const release = deferred();
  const send = env.api.runtime.sendMessage;
  let delayStatus = true;
  env.api.runtime.sendMessage = async (message) => {
    const reply = await send(message);
    if (message.type === 'STATUS' && delayStatus) {
      delayStatus = false;
      entered.resolve();
      await release.promise;
    }
    return reply;
  };
  env.viewportChanged = async (message) => {
    if (message.selectionToken === env.state.videoSessionToken && message.tabId === env.state.tab.id) {
      env.state.status = 'ready';
    }
  };
  const navigation = env.controller.onTabUpdated(17, { status: 'loading' });
  await entered.promise;
  // The offscreen recorder has advanced to a new session while its old STATUS
  // snapshot is still in flight to the worker.
  env.state.videoSessionToken = 'new-video-session';
  release.resolve();
  await navigation;
  assert.deepEqual(messages(env, 'VIDEO_VIEWPORT_CHANGED').map(({ data }) => data), [{
    target: 'offscreen', type: 'VIDEO_VIEWPORT_CHANGED', tabId: 17, selectionToken: 'old-video-session',
  }]);
  assert.equal(env.state.status, 'recording');
  assert.equal(env.state.videoSessionToken, 'new-video-session');
  assert.equal(messages(env, 'STOP').length, 0);
  assert.equal(messages(env, 'CANCEL_VIDEO').length, 0);
});
