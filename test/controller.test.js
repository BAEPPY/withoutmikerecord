import assert from 'node:assert/strict';
import test from 'node:test';
import { createController, EMPTY_STATE } from '../extension/controller.js';

const recordedFile = {
  url: 'blob:chrome-extension://recorder/recording-1',
  filename: 'tab-audio-2026-10-13.mp4',
  bytes: 2048,
  mimeType: 'audio/mp4;codecs=mp4a.40.2',
  durationSeconds: 12,
};

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

// The offscreen document owns this state independently of each controller instance.
// All messages return copies, matching Chrome's message serialization boundary.
function browser({ status = 'idle', download, document = status !== 'idle' } = {}) {
  const calls = [];
  const state = structuredClone(EMPTY_STATE);
  Object.assign(state, {
    status,
    tab: status === 'idle' ? null : { id: 17, title: 'A playing tab' },
    result: status === 'ready' ? structuredClone(recordedFile) : null,
    selection: status === 'ready' ? { startSeconds: 0, endSeconds: 12 } : null,
  });
  if (download) state.download = structuredClone(download);
  const env = {
    calls, state, document,
    activeTab: { id: 17, title: 'A playing tab', url: 'https://example.test/player' },
    items: new Map(),
    async capture() { return 'stream-for-tab-17'; },
    async download() { return 91; },
    async createDocument() {},
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
            Object.assign(state, { status: 'recording', tab: message.tab, result: null });
            break;
          case 'PAUSE': state.status = 'paused'; break;
          case 'RESUME': state.status = 'recording'; break;
          case 'STOP':
            Object.assign(state, { status: 'ready', result: structuredClone(recordedFile) });
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
  env.activeTab = { id: 88, title: 'Another tab', url: 'https://other.test/' };
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
  env.activeTab = { id: 88, title: 'Another tab', url: 'https://other.test/' };
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
  env.activeTab = { id: 88, title: 'New recording', url: 'https://other.test/' };
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
