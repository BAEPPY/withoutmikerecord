import assert from 'node:assert/strict';
import test from 'node:test';
import { createController, EMPTY_STATE } from '../extension/controller.js';

const recordedFile = {
  url: 'blob:chrome-extension://recorder/recording-1',
  filename: 'tab-audio-2026-10-13.mp4',
  bytes: 2048,
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
  });
  if (download) state.download = structuredClone(download);
  const env = {
    calls, state, document,
    activeTab: { id: 17, title: 'A playing tab', url: 'https://example.test/player' },
    items: new Map(),
    async capture() { return 'stream-for-tab-17'; },
    async download() { return 91; },
    async createDocument() {},
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
