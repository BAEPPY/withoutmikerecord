import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const source = (await readFile(new URL('../extension/extract.js', import.meta.url), 'utf8'))
  .replace(/^import \{ extractFileAudio \} from '\.\/file-audio\.js';\s*/, '');
const html = await readFile(new URL('../extension/extract.html', import.meta.url), 'utf8');
const settle = () => new Promise((resolve) => setImmediate(resolve));
const MAX_FILE_BYTES = 128 * 1024 * 1024;
const file = (name = 'holiday.final.webm', size = 2048) => ({ name, size, type: 'video/webm' });
const output = (method = 'copy') => ({
  blob: new Blob(['extracted audio'], { type: 'audio/mp4' }), mimeType: 'audio/mp4',
  durationSeconds: 12.34, method,
});

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

class Element {
  constructor(id, env) {
    Object.assign(this, {
      id, textContent: '', value: '', hidden: false, disabled: false, src: '',
      files: [], paused: true, listeners: {}, loads: 0,
    });
    return new Proxy(this, {
      set(target, name, value) {
        env.domWrites += 1;
        target[name] = value;
        return true;
      },
    });
  }
  addEventListener(type, callback) { (this.listeners[type] ||= []).push(callback); }
  emit(type, event = {}) { return Promise.all((this.listeners[type] || []).map((listener) => listener(event))); }
  click() { if (!this.disabled && !this.hidden) void this.emit('click'); }
  pause() { this.paused = true; }
  load() { this.loads += 1; }
  removeAttribute(name) { if (name === 'src') this.src = ''; }
}

function extractor() {
  const env = {
    elements: new Map(), domWrites: 0, extractionCalls: [], downloads: [], searches: [],
    urls: [], revoked: [], confirms: [], confirmResult: true, timers: new Map(),
    downloadListeners: new Set(), windowListeners: new Map(),
  };
  for (const match of html.matchAll(/\bid="([^"]+)"/g)) {
    env.elements.set(match[1], new Element(match[1], env));
  }
  env.extract = async () => output();
  env.download = async () => 91;
  env.search = async ({ id }) => [{ id, state: 'in_progress' }];
  let nextTimer = 0;
  const context = vm.createContext({
    AbortController,
    extractFileAudio(blob, options) {
      env.extractionCalls.push({ blob, options });
      return env.extract(blob, options);
    },
    document: {
      getElementById(id) {
        assert.ok(env.elements.has(id), `Missing extractor element: ${id}`);
        return env.elements.get(id);
      },
    },
    URL: {
      createObjectURL(blob) {
        const url = `blob:extracted-${env.urls.length + 1}`;
        env.urls.push({ url, blob });
        return url;
      },
      revokeObjectURL(url) { env.revoked.push(url); },
    },
    window: {
      confirm(message) { env.confirms.push(message); return env.confirmResult; },
      addEventListener(type, callback) {
        const listeners = env.windowListeners.get(type) || [];
        listeners.push(callback);
        env.windowListeners.set(type, listeners);
      },
      setTimeout(callback) { const id = ++nextTimer; env.timers.set(id, callback); return id; },
      clearTimeout(id) { env.timers.delete(id); },
    },
    chrome: {
      downloads: {
        async download(options) { env.downloads.push(structuredClone(options)); return env.download(options); },
        async search(options) { env.searches.push(structuredClone(options)); return env.search(options); },
        onChanged: {
          addListener(callback) { env.downloadListeners.add(callback); },
          removeListener(callback) { env.downloadListeners.delete(callback); },
        },
      },
    },
  });
  env.get = (id) => env.elements.get(id);
  env.text = (id) => env.get(id).textContent;
  env.click = (id) => env.get(id).click();
  env.choose = async (selected) => {
    env.get('source-file').files = selected ? [selected] : [];
    await env.get('source-file').emit('change');
  };
  env.emitDownload = (delta) => { for (const listener of env.downloadListeners) listener(delta); };
  env.emitWindow = (type) => {
    const event = { prevented: false, preventDefault() { this.prevented = true; } };
    for (const listener of env.windowListeners.get(type) || []) listener(event);
    return event;
  };
  env.tick = async () => {
    const entry = env.timers.entries().next().value;
    assert.ok(entry, 'Expected a scheduled download check');
    const [id, callback] = entry;
    env.timers.delete(id);
    callback();
    await settle();
  };
  vm.runInContext(source, context, { filename: 'extension/extract.js' });
  return env;
}

async function withResult(name = 'holiday.final.webm') {
  const env = extractor();
  await env.choose(file(name));
  env.click('extract-button');
  await settle();
  assert.equal(env.get('result-section').hidden, false);
  return env;
}

test('empty and oversized files are rejected before extraction, while exactly 128 MiB is accepted', async () => {
  for (const [size, message] of [[0, /비어 있는 파일/], [MAX_FILE_BYTES + 1, /128 MiB 이하/]]) {
    const env = extractor();
    await env.choose(file('input.mp4', size));
    assert.equal(env.get('extract-button').disabled, true);
    assert.equal(env.get('source-file').value, '');
    assert.match(env.text('extract-error'), message);
    await env.get('extract-button').emit('click');
    assert.equal(env.extractionCalls.length, 0);
  }
  const env = extractor();
  const boundary = file('boundary.mp4', MAX_FILE_BYTES);
  await env.choose(boundary);
  assert.equal(env.get('extract-button').disabled, false);
  env.click('extract-button');
  await settle();
  assert.equal(env.extractionCalls[0].blob, boundary);
});

test('successful extraction owns its output URL and filename independently of the next selected file', async () => {
  const env = await withResult('holiday.final.webm');
  assert.equal(env.text('result-name'), 'holiday.final-audio.mp4');
  assert.equal(env.get('result-audio').src, 'blob:extracted-1');
  assert.equal(env.urls[0].blob.type, 'audio/mp4');
  assert.match(env.text('result-details'), /0:12\.34.*원본 소리 그대로 추출/);
  assert.equal(env.text('extract-progress-label'), '100%');
  assert.equal(env.get('save-extracted-button').disabled, false);
  await env.choose(file('different-source.mp4'));
  env.search = async ({ id }) => [{ id, state: 'complete' }];
  env.click('save-extracted-button');
  await settle();
  assert.deepEqual(env.downloads, [{
    url: 'blob:extracted-1', filename: 'holiday.final-audio.mp4', saveAs: true, conflictAction: 'uniquify',
  }]);
  assert.deepEqual(env.revoked, []);
});

test('a replacement is committed and its prior URL revoked only after successful extraction', async () => {
  const env = await withResult();
  const replacement = deferred();
  env.extract = () => replacement.promise;
  await env.choose(file('bad/name:.mov'));
  env.click('extract-button');
  assert.equal(env.get('result-audio').src, 'blob:extracted-1');
  assert.deepEqual(env.revoked, []);
  replacement.resolve(output('encode'));
  await settle();
  assert.equal(env.get('result-audio').src, 'blob:extracted-2');
  assert.equal(env.text('result-name'), 'bad_name_-audio.mp4');
  assert.match(env.text('result-details'), /소리 MP4로 변환/);
  assert.deepEqual(env.revoked, ['blob:extracted-1']);
});

test('failed, cancelled, and empty replacements retain the old result and allow saving it', async () => {
  for (const outcome of ['failure', 'cancel', 'empty']) {
    const env = await withResult();
    const replacement = deferred();
    env.extract = () => replacement.promise;
    await env.choose(file('replacement.mp4'));
    env.click('extract-button');
    const { options } = env.extractionCalls.at(-1);
    options.onProgress(0.4);
    if (outcome === 'failure') replacement.reject(new Error('이 파일의 소리를 읽을 수 없어요.'));
    else if (outcome === 'empty') replacement.resolve({ ...output(), blob: new Blob([]) });
    else {
      env.click('cancel-extract-button');
      assert.equal(options.signal.aborted, true);
      assert.equal(env.get('cancel-extract-button').disabled, true);
      const writes = env.domWrites;
      options.onProgress(0.9);
      options.onStage('finishing');
      assert.equal(env.domWrites, writes, 'cancelled callbacks cannot update progress');
      replacement.resolve(output());
    }
    await settle();
    assert.equal(env.get('result-audio').src, 'blob:extracted-1', outcome);
    assert.equal(env.text('result-name'), 'holiday.final-audio.mp4', outcome);
    assert.equal(env.get('save-extracted-button').disabled, false, outcome);
    assert.deepEqual(env.revoked, [], outcome);
    assert.equal(env.urls.length, 1, outcome);
    if (outcome === 'cancel') {
      assert.match(env.text('extract-status'), /취소/);
      assert.equal(env.get('extract-error').hidden, true);
    } else assert.equal(env.get('extract-error').hidden, false);
  }
});

test('declining replacement of an unsaved result starts no work and preserves its URL', async () => {
  const env = await withResult();
  await env.choose(file('replacement.mp4'));
  env.confirmResult = false;
  env.click('extract-button');
  await settle();
  assert.equal(env.confirms.length, 1);
  assert.equal(env.extractionCalls.length, 1);
  assert.equal(env.get('result-audio').src, 'blob:extracted-1');
  assert.equal(env.get('extract-button').disabled, false);
  assert.deepEqual(env.revoked, []);
});

test('progress is monotonic and finite, and callbacks from a finished operation cannot change its replacement', async () => {
  const env = extractor();
  const first = deferred();
  env.extract = () => first.promise;
  await env.choose(file());
  env.click('extract-button');
  const old = env.extractionCalls[0].options;
  old.onProgress(0.6);
  old.onProgress(0.2);
  old.onProgress(Infinity);
  old.onProgress(NaN);
  assert.equal(env.get('extract-progress').value, 0.6);
  first.resolve(output());
  await settle();
  const second = deferred();
  env.extract = () => second.promise;
  env.click('extract-button');
  const writes = env.domWrites;
  old.onProgress(1);
  old.onStage('finishing');
  assert.equal(env.domWrites, writes);
  second.resolve(output());
  await settle();
});

test('pagehide aborts extraction and releases the old URL once; late callbacks and resolution cannot write', async () => {
  const env = await withResult();
  const replacement = deferred();
  env.extract = () => replacement.promise;
  env.click('extract-button');
  const { options } = env.extractionCalls.at(-1);
  env.emitWindow('pagehide');
  assert.equal(options.signal.aborted, true);
  assert.equal(env.get('result-audio').src, '');
  assert.equal(env.get('result-audio').loads, 1);
  assert.deepEqual(env.revoked, ['blob:extracted-1']);
  assert.equal(env.downloadListeners.size, 0);
  const writes = env.domWrites;
  options.onProgress(1);
  options.onStage('finishing');
  replacement.resolve(output());
  await settle();
  await env.get('result-audio').emit('loadeddata');
  await env.get('result-audio').emit('error');
  env.emitWindow('pagehide');
  assert.equal(env.domWrites, writes);
  assert.equal(env.urls.length, 1);
  assert.deepEqual(env.revoked, ['blob:extracted-1']);
});

test('terminal download events arriving before the ID are matched without accepting unrelated events', async () => {
  for (const state of ['complete', 'interrupted']) {
    const env = await withResult();
    const picker = deferred();
    env.download = () => picker.promise;
    env.click('save-extracted-button');
    env.emitDownload({ id: 999, state: { current: 'complete' } });
    env.emitDownload({ id: 91, state: { current: state } });
    assert.equal(env.get('save-extracted-button').disabled, true);
    picker.resolve(91);
    await settle();
    assert.equal(env.get('save-extracted-button').disabled, false, state);
    assert.equal(env.searches.length, 0, state);
    assert.equal(env.timers.size, 0, state);
    assert.equal(env.get('result-audio').src, 'blob:extracted-1');
    assert.deepEqual(env.revoked, []);
    if (state === 'complete') {
      assert.match(env.text('download-status'), /저장 완료/);
      assert.equal(env.emitWindow('beforeunload').prevented, false);
    } else {
      assert.match(env.text('extract-error'), /취소되었거나 실패/);
      assert.equal(env.emitWindow('beforeunload').prevented, true);
    }
  }
});

test('search reconciles a completed download without an event and marks the preserved result as saved', async () => {
  const env = await withResult();
  env.search = async ({ id }) => [{ id, state: 'complete' }];
  env.click('save-extracted-button');
  await settle();
  assert.deepEqual(env.searches, [{ id: 91 }]);
  assert.match(env.text('download-status'), /저장 완료/);
  assert.equal(env.get('source-file').disabled, false);
  assert.equal(env.emitWindow('beforeunload').prevented, false);
  assert.deepEqual(env.revoked, []);
  env.click('extract-button');
  await settle();
  assert.equal(env.confirms.length, 0, 'already saved output does not need a replacement confirmation');
});

test('late search results cannot regress a terminal download or affect a newer save job', async () => {
  const env = await withResult();
  const firstSearch = deferred();
  const secondSearch = deferred();
  let nextId = 91;
  env.download = async () => nextId++;
  env.search = ({ id }) => id === 91 ? firstSearch.promise : secondSearch.promise;
  env.click('save-extracted-button');
  await settle();
  env.emitDownload({ id: 91, state: { current: 'complete' } });
  assert.equal(env.get('save-extracted-button').disabled, false);
  env.click('save-extracted-button');
  await settle();
  assert.deepEqual(env.searches, [{ id: 91 }, { id: 92 }]);
  const writes = env.domWrites;
  firstSearch.resolve([{ id: 91, state: 'in_progress' }]);
  await settle();
  assert.equal(env.domWrites, writes, 'a prior job must not render over the new download');
  assert.equal(env.get('save-extracted-button').disabled, true);
  env.emitDownload({ id: 91, state: { current: 'interrupted' } });
  assert.equal(env.get('extract-error').hidden, true, 'an old download event cannot interrupt the new one');
  env.emitDownload({ id: 92, state: { current: 'complete' } });
  const terminalWrites = env.domWrites;
  secondSearch.resolve([{ id: 92, state: 'in_progress' }]);
  await settle();
  assert.equal(env.domWrites, terminalWrites);
  assert.match(env.text('download-status'), /저장 완료/);
  assert.equal(env.get('save-extracted-button').disabled, false);
  assert.equal(env.timers.size, 0);
});

test('rejecting the native save dialog keeps the result available for a successful retry', async () => {
  const env = await withResult();
  env.download = async () => { throw new Error('USER_CANCELED'); };
  env.click('save-extracted-button');
  await settle();
  assert.match(env.text('extract-error'), /취소되었거나 시작되지/);
  assert.equal(env.get('save-extracted-button').disabled, false);
  assert.equal(env.get('result-audio').src, 'blob:extracted-1');
  assert.deepEqual(env.revoked, []);
  env.download = async () => 92;
  env.search = async ({ id }) => [{ id, state: 'complete' }];
  env.click('save-extracted-button');
  await settle();
  assert.equal(env.downloads.length, 2);
  assert.deepEqual(env.downloads[0], env.downloads[1]);
  assert.match(env.text('download-status'), /저장 완료/);
  assert.equal(env.get('extract-error').hidden, true);
  assert.equal(env.extractionCalls.length, 1);
});

test('a failed state search retains the pending download until manual retry confirms its outcome', async () => {
  const env = await withResult();
  env.search = async () => { throw new Error('Temporary search error'); };
  env.click('save-extracted-button');
  await settle();
  assert.equal(env.get('save-extracted-button').disabled, true);
  assert.equal(env.get('source-file').disabled, true);
  assert.equal(env.get('refresh-download-button').hidden, false);
  assert.match(env.text('download-status'), /저장 상태를 확인하지 못했어요/);
  assert.equal(env.get('extract-error').hidden, true);
  assert.deepEqual(env.revoked, []);
  env.search = async ({ id }) => [{ id, state: 'complete' }];
  env.click('refresh-download-button');
  await settle();
  assert.equal(env.searches.length, 2);
  assert.equal(env.get('save-extracted-button').disabled, false);
  assert.match(env.text('download-status'), /저장 완료/);
  assert.equal(env.timers.size, 0);
});

test('only three successful missing-record searches unlock a missing download; rejected searches do not count', async () => {
  const env = await withResult();
  let attempt = 0;
  env.search = async () => {
    if (++attempt === 2) throw new Error('Temporary search error');
    return [];
  };
  env.click('save-extracted-button');
  await settle();
  assert.equal(env.get('save-extracted-button').disabled, true);
  await env.tick();
  assert.equal(env.get('save-extracted-button').disabled, true);
  await env.tick();
  assert.equal(env.get('save-extracted-button').disabled, true);
  await env.tick();
  assert.equal(env.searches.length, 4);
  assert.equal(env.get('save-extracted-button').disabled, false);
  assert.match(env.text('extract-error'), /다운로드 기록을 찾을 수 없어요/);
  assert.equal(env.get('result-audio').src, 'blob:extracted-1');
  assert.deepEqual(env.revoked, []);
  assert.equal(env.timers.size, 0);
});

test('a pending download blocks file replacement, extraction and duplicate saves even before it has an ID', async () => {
  const env = await withResult();
  const picker = deferred();
  env.download = () => picker.promise;
  env.click('save-extracted-button');
  assert.equal(env.get('source-file').disabled, true);
  assert.equal(env.get('extract-button').disabled, true);
  assert.equal(env.get('refresh-download-button').hidden, true);
  await env.choose(file('replacement.mp4'));
  await env.get('extract-button').emit('click');
  await env.get('save-extracted-button').emit('click');
  assert.equal(env.text('source-name'), 'holiday.final.webm');
  assert.equal(env.extractionCalls.length, 1);
  assert.equal(env.downloads.length, 1);
  assert.deepEqual(env.revoked, []);
  env.search = async ({ id }) => [{ id, state: 'complete' }];
  picker.resolve(91);
  await settle();
  assert.equal(env.get('source-file').disabled, false);
});

test('beforeunload warns for unsaved results and active extraction but cleanup waits until pagehide', async () => {
  const env = await withResult();
  const unsaved = env.emitWindow('beforeunload');
  assert.equal(unsaved.prevented, true);
  assert.equal(unsaved.returnValue, '');
  assert.equal(env.get('result-audio').src, 'blob:extracted-1');
  assert.deepEqual(env.revoked, []);
  const replacement = deferred();
  env.extract = () => replacement.promise;
  env.click('extract-button');
  const { options } = env.extractionCalls.at(-1);
  const writes = env.domWrites;
  assert.equal(env.emitWindow('beforeunload').prevented, true);
  assert.equal(options.signal.aborted, false);
  assert.equal(env.domWrites, writes);
  assert.equal(env.downloadListeners.size, 1);
  env.emitWindow('pagehide');
  assert.equal(options.signal.aborted, true);
  assert.deepEqual(env.revoked, ['blob:extracted-1']);
  replacement.reject(new DOMException('Aborted', 'AbortError'));
  await settle();
});

test('pagehide releases a pending download and prevents late ID or search responses from changing the page', async () => {
  for (const waitingFor of ['id', 'search']) {
    const env = await withResult();
    const pending = deferred();
    if (waitingFor === 'id') env.download = () => pending.promise;
    else env.search = () => pending.promise;
    env.click('save-extracted-button');
    await settle();
    const writes = env.domWrites;
    assert.equal(env.emitWindow('beforeunload').prevented, true);
    assert.equal(env.domWrites, writes);
    assert.deepEqual(env.revoked, []);
    env.emitWindow('pagehide');
    const hiddenWrites = env.domWrites;
    pending.resolve(waitingFor === 'id' ? 91 : [{ id: 91, state: 'complete' }]);
    await settle();
    assert.equal(env.domWrites, hiddenWrites, waitingFor);
    assert.equal(env.downloadListeners.size, 0, waitingFor);
    assert.equal(env.timers.size, 0, waitingFor);
    assert.deepEqual(env.revoked, ['blob:extracted-1'], waitingFor);
    if (waitingFor === 'id') assert.equal(env.searches.length, 0);
  }
});

test('an audio preview failure shows a separate notice while preserving save and clears after playback becomes ready', async () => {
  const env = await withResult();
  await env.get('result-audio').emit('error');
  assert.equal(env.get('preview-error').hidden, false);
  assert.match(env.text('preview-error'), /MP4를 저장해 다른 플레이어/);
  assert.equal(env.get('extract-error').hidden, true);
  assert.equal(env.get('save-extracted-button').disabled, false);
  env.search = async ({ id }) => [{ id, state: 'complete' }];
  env.click('save-extracted-button');
  await settle();
  assert.match(env.text('download-status'), /저장 완료/);
  assert.equal(env.get('preview-error').hidden, false);
  await env.get('result-audio').emit('loadeddata');
  assert.equal(env.get('preview-error').hidden, true);
  assert.equal(env.get('result-audio').src, 'blob:extracted-1');
});
