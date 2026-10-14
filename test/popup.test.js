import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import vm from 'node:vm';

const source = await readFile(new URL('../extension/popup.js', import.meta.url), 'utf8');
const html = await readFile(new URL('../extension/popup.html', import.meta.url), 'utf8');
const settle = () => new Promise((resolve) => setImmediate(resolve));
const idle = () => ({ status: 'idle', mode: 'audio', elapsedMs: 0, result: null, download: { status: 'idle' } });

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

class Element {
  constructor(id = '') {
    Object.assign(this, { id, textContent: '', value: '', hidden: false, disabled: false,
      dataset: {}, style: {}, currentTime: 0, duration: NaN, paused: true, playCalls: 0, attributes: {}, listeners: {} });
    this.classList = { toggle() {} };
  }
  get valueAsNumber() { return this.value === '' ? NaN : Number(this.value); }
  get src() { return this.attributes.src || ''; }
  set src(value) { this.attributes.src = value; }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  removeAttribute(name) { delete this.attributes[name]; }
  addEventListener(type, listener) { (this.listeners[type] ||= []).push(listener); }
  emit(type) { return Promise.all((this.listeners[type] || []).map((listener) => listener())); }
  closest(selector) {
    if (selector === '[hidden]') return this.hidden ? this : this.parent?.closest(selector);
    return this.editable ? this : null;
  }
  click() {
    if (this.disabled || this.closest('[hidden]')) return;
    for (const listener of this.listeners.click || []) listener();
  }
  async play() { this.playCalls += 1; this.paused = false; await this.emit('play'); }
  pause() {
    const playing = !this.paused;
    this.paused = true;
    if (playing) void this.emit('pause');
  }
  load() { this.currentTime = 0; }
}

async function popup({ initialState = idle(), assignments = [], assignmentError = false, armError = '', userAgent = 'Chrome/135' } = {}) {
  const elements = new Map([...html.matchAll(/\bid="([^"]+)"/g)].map((match) => [match[1], new Element(match[1])]));
  const listeners = {};
  const env = { state: initialState, sent: [], closed: 0, tabs: [], assignmentReads: 0, elements, fetched: [], copied: [] };
  env.respond = async (message) => message.type === 'ARM_SHORTCUTS' && armError
    ? { ok: false, error: armError } : { ok: true, state: structuredClone(env.state) };
  env.createTab = async (options) => { env.tabs.push(structuredClone(options)); };
  env.fetch = async (url) => { env.fetched.push(url); return { ok: true, blob: async () => new Blob(['GIF89a'], { type: 'image/gif' }) }; };
  env.copyGif = async (blob) => { env.copied.push(blob); return { mode: 'html-gif' }; };
  for (const id of ['pause-button', 'stop-button']) elements.get(id).parent = elements.get('recording-controls');
  elements.get('save-format').value = 'mp4';
  elements.get('save-content').value = 'both';
  const context = vm.createContext({
    Element, crypto: { randomUUID }, navigator: { userAgent },
    fetch: (...args) => env.fetch(...args), __withoutMikeCopyGif: (...args) => env.copyGif(...args),
    document: {
      hidden: false,
      getElementById(id) { assert.ok(elements.has(id), `Missing popup element: ${id}`); return elements.get(id); },
      querySelector() { return new Element(); },
      addEventListener(type, listener) { (listeners[type] ||= []).push(listener); },
    },
    window: { setTimeout() {}, requestAnimationFrame() {}, cancelAnimationFrame() {},
      addEventListener() {}, close() { env.closed += 1; }, confirm() { return true; } },
    chrome: {
      runtime: {
        async sendMessage(message) { env.sent.push(structuredClone(message)); return env.respond(message); },
        getURL(path) { return `chrome-extension://test/${path}`; },
      },
      commands: { async getAll() {
        env.assignmentReads += 1;
        if (assignmentError) throw new Error('Could not read commands');
        return assignments;
      } },
      tabs: { create: (options) => env.createTab(options) },
    },
  });
  env.press = (key, overrides = {}) => {
    const event = { key, target: new Element(), preventDefault() { this.prevented = true; }, ...overrides };
    for (const listener of listeners.keydown || []) listener(event);
    return event;
  };
  env.click = (id) => elements.get(id).click();
  env.text = (id) => elements.get(id).textContent;
  env.commands = () => env.sent.filter(({ type }) => !['STATUS', 'ARM_SHORTCUTS'].includes(type));
  env.poll = () => vm.runInContext('poll()', context);
  vm.runInContext(source, context, { filename: 'extension/popup.js' });
  await settle();
  return env;
}

test('popup sends one bound stop immediately, before the start reply or popup closure', async () => {
  const env = await popup();
  const start = deferred();
  const stopping = deferred();
  const stop = deferred();
  env.respond = (message) => {
    if (message.type === 'START') return start.promise;
    stopping.resolve();
    return stop.promise;
  };
  env.press('1');
  assert.equal(env.elements.get('stop-button').disabled, false);
  assert.ok(env.press('2').prevented);
  env.press('2');
  env.press('1');
  assert.deepEqual(env.commands().map(({ type }) => type), ['START', 'STOP_PENDING']);
  assert.match(env.commands()[0].operationId, /^[0-9a-f-]{36}$/);
  assert.equal(env.commands()[1].operationId, env.commands()[0].operationId);
  assert.equal(env.commands()[1].mode, 'audio');
  assert.match(env.text('stop-label'), /종료 요청 대기/);
  assert.match(env.text('control-hint'), /종료 요청을 기억/);
  start.resolve({ ok: true, state: { ...idle(), status: 'recording' } });
  await stopping.promise;
  assert.deepEqual(env.commands().map(({ type }) => type), ['START', 'STOP_PENDING']);
  env.press('2');
  stop.resolve({ ok: true, state: { ...idle(), status: 'ready' } });
  await settle();
  assert.equal(env.commands().length, 2);
});

test('failed starts preserve their error and never retry a normal unbound stop', async () => {
  const env = await popup();
  const start = deferred();
  env.respond = () => start.promise;
  env.press('1');
  env.press('2');
  start.resolve({ ok: false, error: '다른 녹음이 진행 중이에요.', state: { ...idle(), status: 'recording' } });
  await settle();
  assert.deepEqual(env.commands().map(({ type }) => type), ['START', 'STOP_PENDING']);
  assert.match(env.text('error-message'), /다른 녹음/);
  assert.doesNotMatch(env.text('stop-label'), /대기/);
});

test('an early stop reply takes precedence over a later arriving start reply', async () => {
  const env = await popup();
  const start = deferred();
  env.respond = (message) => message.type === 'START' ? start.promise
    : Promise.resolve({ ok: true, state: { ...idle(), status: 'ready' } });
  env.press('1');
  env.press('2');
  await settle();
  start.resolve({ ok: true, state: { ...idle(), status: 'recording' } });
  await settle();
  assert.equal(env.elements.get('status-pill').dataset.status, 'ready');
  assert.equal(env.text('status-label'), '녹음 완료');
  assert.equal(env.commands().length, 2);
});

test('popup sends bound video cancellation before selector state exists and stays open', async () => {
  const env = await popup();
  const opening = deferred();
  env.respond = (message) => message.type === 'OPEN_VIDEO_SELECTOR'
    ? opening.promise : Promise.resolve({ ok: true, state: idle() });
  env.press('3');
  assert.equal(env.press('2').prevented, undefined);
  assert.ok(env.press('4').prevented);
  env.press('4');
  assert.deepEqual(env.commands().map(({ type }) => type), ['OPEN_VIDEO_SELECTOR', 'STOP_PENDING']);
  assert.equal(env.commands()[1].mode, 'video');
  assert.equal(env.commands()[1].operationId, env.commands()[0].operationId);
  opening.resolve({ ok: true, state: idle() });
  await settle();
  assert.deepEqual(env.commands().map(({ type }) => type), ['OPEN_VIDEO_SELECTOR', 'STOP_PENDING']);
  assert.equal(env.closed, 0);
});

test('popup selector opens normally when no stop was queued', async () => {
  const env = await popup();
  env.press('3');
  await settle();
  assert.deepEqual(env.commands().map(({ type }) => type), ['OPEN_VIDEO_SELECTOR']);
  assert.equal(env.closed, 1);
});

test('stop button sends a bound stop during pause and stop works while backend is starting', async () => {
  const env = await popup({ initialState: { ...idle(), status: 'recording' } });
  const pause = deferred();
  env.respond = (message) => message.type === 'PAUSE' ? pause.promise
    : Promise.resolve({ ok: true, state: { ...idle(), status: 'ready' } });
  env.click('pause-button');
  env.click('stop-button');
  pause.resolve({ ok: true, state: { ...idle(), status: 'paused' } });
  await settle();
  assert.deepEqual(env.commands().map(({ type }) => type), ['PAUSE', 'STOP_PENDING']);
  assert.equal(env.commands()[1].operationId, env.commands()[0].operationId);

  const reopening = await popup({ initialState: { ...idle(), status: 'starting', mode: 'video' } });
  assert.equal(reopening.press('2').prevented, undefined);
  assert.ok(reopening.press('4').prevented);
  await settle();
  assert.deepEqual(reopening.commands().map(({ type }) => type), ['STOP']);
});

test('queued stop still respects mode, repeat, IME, modifiers, and editable fields', async () => {
  const env = await popup();
  const start = deferred();
  env.respond = () => start.promise;
  env.press('1');
  const input = new Element();
  input.editable = true;
  for (const overrides of [{ repeat: true }, { isComposing: true }, { keyCode: 229 },
    { ctrlKey: true }, { altKey: true }, { metaKey: true }, { shiftKey: true },
    { defaultPrevented: true }, { target: input }]) {
    assert.equal(env.press('2', overrides).prevented, undefined);
  }
  assert.equal(env.press('4').prevented, undefined);
  start.resolve({ ok: true, state: { ...idle(), status: 'recording' } });
  await settle();
  assert.deepEqual(env.commands().map(({ type }) => type), ['START']);
});

test('shows actual customized assignments and missing keys without promising suggested defaults', async () => {
  const env = await popup({ assignments: [
    { name: 'start-recording', shortcut: 'Ctrl+Shift+8' },
    { name: 'stop-recording', shortcut: '' },
    { name: 'start-video', shortcut: 'Alt+V' },
  ] });
  assert.equal(env.text('shortcut-audio-start'), 'Ctrl+Shift+8');
  assert.equal(env.text('shortcut-audio-stop'), '미지정');
  assert.equal(env.text('shortcut-video-start'), 'Alt+V');
  assert.equal(env.text('shortcut-video-stop'), '미지정');
  assert.equal(env.elements.get('shortcut-audio-stop').dataset.assigned, 'false');
  assert.match(env.text('shortcut-assignment-note'), /설정에서 등록/);
  assert.doesNotMatch(html, /Alt\+Shift\+[1-4]/);
  assert.equal(env.assignmentReads, 1);
});

test('assignment lookup failures do not disable recording or become recorder errors', async () => {
  const env = await popup({ assignmentError: true });
  assert.equal(env.text('shortcut-audio-start'), '확인 불가');
  assert.match(env.text('shortcut-assignment-note'), /설정에서 확인/);
  assert.equal(env.elements.get('start-button').disabled, false);
  assert.equal(env.elements.get('error-message').hidden, true);
});

test('shortcut settings opens the correct Chrome or Edge settings page', async () => {
  for (const [userAgent, scheme] of [['Chrome/135', 'chrome'], ['Chrome/135 Edg/135', 'edge']]) {
    const env = await popup({ userAgent });
    env.click('shortcut-settings');
    await settle();
    assert.deepEqual(env.tabs, [{ url: `${scheme}://extensions/shortcuts` }]);
    assert.equal(env.elements.get('shortcut-settings').disabled, false);
  }
});

function videoReady() {
  return {
    ...idle(), status: 'ready', mode: 'video',
    result: { kind: 'video', url: 'blob:original-video', durationSeconds: 6.25, bytes: 1000 },
    selection: { startSeconds: 1.12, endSeconds: 4.56 },
  };
}

test('video editor uses the video position and plays only the selected interval', async () => {
  const env = await popup({ initialState: videoReady() });
  const get = (id) => env.elements.get(id);
  assert.equal(get('audio-trim-controls').hidden, false);
  assert.equal(get('save-range-button').hidden, false);
  assert.equal(get('trim-start').value, '1.12');
  assert.equal(get('trim-end').value, '4.56');
  assert.equal(env.text('preview-range'), '선택 구간 보기');
  const video = get('video-preview');
  const audio = get('audio-preview');
  audio.currentTime = 5.99;
  video.currentTime = 2.349;
  env.click('set-trim-start');
  await settle();
  assert.equal(get('trim-start').value, '2.34');
  video.currentTime = 3.456;
  env.click('set-trim-end');
  await settle();
  assert.equal(get('trim-end').value, '3.45');
  assert.deepEqual(env.commands().filter(({ type }) => type === 'SET_SELECTION').at(-1), {
    target: 'background', type: 'SET_SELECTION', startSeconds: 2.34, endSeconds: 3.45,
  });
  env.click('preview-range');
  await settle();
  assert.equal(video.currentTime, 2.34);
  assert.equal(video.playCalls, 1);
  assert.equal(audio.playCalls, 0);
  video.currentTime = 3.50;
  await video.emit('timeupdate');
  assert.equal(video.paused, true);
  assert.equal(video.currentTime, 3.45);
  assert.equal(audio.currentTime, 5.99);
  assert.equal(env.text('preview-range'), '선택 구간 보기');
});

test('stopping a pending video preview does not report its expected playback rejection', async () => {
  const env = await popup({ initialState: videoReady() });
  const playing = deferred();
  const video = env.elements.get('video-preview');
  video.play = () => { video.paused = false; return playing.promise; };
  env.click('preview-range');
  env.click('preview-range');
  playing.reject(new Error('Playback aborted by pause'));
  await settle();
  assert.equal(video.paused, true);
  assert.equal(env.elements.get('error-message').hidden, true);
  assert.equal(env.text('preview-range'), '선택 구간 보기');
});

test('video save format applies to both whole and selected output without changing the source', async () => {
  const env = await popup({ initialState: videoReady() });
  const format = env.elements.get('save-format');
  format.value = 'gif';
  await format.emit('change');
  assert.equal(env.text('save-button'), '전체 저장 · .gif');
  assert.equal(env.text('save-range-button'), '선택 구간 저장 · .gif');
  env.click('save-range-button');
  await settle();
  assert.deepEqual(env.commands().at(-1), {
    target: 'background', type: 'SAVE_VIDEO_RANGE', format: 'gif', startSeconds: 1.12, endSeconds: 4.56,
  });
  env.click('save-button');
  await settle();
  assert.deepEqual(env.commands().at(-1), { target: 'background', type: 'SAVE_VIDEO', format: 'gif' });
  format.value = 'mp4';
  await format.emit('change');
  env.click('save-range-button');
  await settle();
  assert.equal(env.commands().at(-1).format, 'mp4');
  assert.equal(env.elements.get('video-preview').src, 'blob:original-video');
});

test('switching media kind even at the same URL clears inactive preview and preserves audio MP4 behavior', async () => {
  const env = await popup({ initialState: videoReady() });
  const video = env.elements.get('video-preview');
  await video.play();
  env.elements.get('save-format').value = 'gif';
  env.state = { ...videoReady(), mode: 'audio',
    result: { ...videoReady().result, kind: 'audio' }, selection: { startSeconds: 0, endSeconds: 2.5 } };
  await env.poll();
  assert.equal(video.paused, true);
  assert.equal(video.src, '');
  assert.equal(env.elements.get('audio-preview').src, 'blob:original-video');
  assert.equal(env.elements.get('trim-end').value, '2.50');
  assert.equal(env.elements.get('save-format-field').hidden, true);
  assert.equal(env.text('save-button'), '전체 저장 · .mp4');
  assert.equal(env.text('save-range-button'), '선택 구간 저장 · .mp4');
  assert.equal(env.text('preview-range'), '선택 구간 듣기');
  env.click('save-range-button');
  await settle();
  assert.deepEqual(env.commands().at(-1), {
    target: 'background', type: 'SAVE_RANGE', startSeconds: 0, endSeconds: 2.5,
  });
});

test('polling and failed video exports preserve edited bounds and the original for retry', async () => {
  const env = await popup({ initialState: videoReady() });
  const start = env.elements.get('trim-start');
  start.value = '';
  await start.emit('input');
  await env.poll();
  assert.equal(start.value, '');
  assert.equal(env.elements.get('save-range-button').disabled, true);
  assert.equal(env.elements.get('save-button').disabled, false);
  start.value = '2.20';
  await start.emit('input');
  await settle();
  let fail = true;
  env.respond = async (message) => message.type === 'SAVE_VIDEO_RANGE' && fail
    ? { ok: false, error: '변환 실패', state: structuredClone(env.state) }
    : { ok: true, state: { ...structuredClone(env.state), exportResult: { url: 'blob:short-clip' } } };
  env.click('save-range-button');
  await settle();
  assert.match(env.text('error-message'), /변환 실패/);
  assert.equal(start.value, '2.20');
  assert.equal(env.elements.get('video-preview').src, 'blob:original-video');
  assert.equal(env.elements.get('save-range-button').disabled, false);
  fail = false;
  env.click('save-range-button');
  await settle();
  assert.equal(env.elements.get('error-message').hidden, true);
  assert.equal(env.elements.get('video-preview').src, 'blob:original-video');
  assert.equal(start.value, '2.20');
});

test('video processing locks edits and cancellation bypasses the pending export without discarding it', async () => {
  const env = await popup({ initialState: videoReady() });
  const conversion = deferred();
  env.respond = async (message) => {
    if (message.type === 'SAVE_VIDEO_RANGE') {
      env.state = { ...env.state, status: 'trimming', exportProgress: 0.42, exportFormat: 'mp4' };
      return conversion.promise;
    }
    if (message.type === 'CANCEL_EXPORT') env.state = { ...env.state, status: 'ready', notice: '중지했어요. 원본은 유지돼요.' };
    return { ok: true, state: structuredClone(env.state) };
  };
  env.click('save-range-button');
  await env.poll();
  assert.equal(env.text('status-label'), '영상 구간 만드는 중 42%');
  for (const id of ['trim-start', 'trim-end', 'save-button', 'save-range-button', 'save-format', 'discard-button']) {
    assert.equal(env.elements.get(id).disabled, true, id);
  }
  assert.equal(env.elements.get('cancel-export-button').hidden, false);
  env.click('cancel-export-button');
  await settle();
  assert.deepEqual(env.commands().map(({ type }) => type), ['SAVE_VIDEO_RANGE', 'CANCEL_EXPORT']);
  assert.equal(env.elements.get('save-button').disabled, true, 'original export is still pending');
  conversion.resolve({ ok: false, cancelled: true, state: structuredClone(env.state) });
  await settle();
  assert.equal(env.elements.get('save-button').disabled, false);
  assert.equal(env.elements.get('trim-start').value, '1.12');
  assert.equal(env.elements.get('video-preview').src, 'blob:original-video');
  assert.equal(env.elements.get('error-message').hidden, true);
});

test('reopened GIF processing restores format and videos without editable duration keep whole save', async () => {
  const pending = await popup({ initialState: {
    ...videoReady(), status: 'exporting', exportProgress: 0.43, exportFormat: 'gif',
  } });
  assert.equal(pending.elements.get('save-format').value, 'gif');
  assert.equal(pending.text('status-label'), 'GIF 만드는 중 43%');
  assert.equal(pending.text('save-button'), '전체 저장 · .gif');
  assert.equal(pending.text('save-range-button'), '선택 구간 저장 · .gif');
  assert.equal(pending.elements.get('cancel-export-button').disabled, false);
  for (const durationSeconds of [null, NaN, Infinity, 0.005]) {
    const env = await popup({ initialState: {
      ...videoReady(), result: { ...videoReady().result, durationSeconds }, selection: null,
    } });
    assert.equal(env.elements.get('save-range-button').disabled, true);
    assert.equal(env.elements.get('preview-range').disabled, true);
    assert.equal(env.elements.get('save-button').disabled, false);
  }
});

test('short video ranges keep preview and GIF available while MP4 requires 0.04 seconds', async () => {
  const env = await popup({ initialState: {
    ...videoReady(), selection: { startSeconds: 1.12, endSeconds: 1.15 },
  } });
  assert.equal(env.elements.get('preview-range').disabled, false);
  assert.equal(env.elements.get('save-button').disabled, false);
  assert.equal(env.elements.get('save-range-button').disabled, true);
  assert.match(env.text('trim-error'), /0\.04초 이상/);
  env.elements.get('save-format').value = 'gif';
  await env.elements.get('save-format').emit('change');
  assert.equal(env.elements.get('save-range-button').disabled, false);
  assert.equal(env.elements.get('copy-range-gif-button').disabled, false);
  assert.equal(env.elements.get('trim-error').hidden, true);
});

test('whole and selected GIF copies prepare without downloading and describe actual clipboard support', async () => {
  const env = await popup({ initialState: videoReady() });
  assert.equal(env.elements.get('copy-gif-button').hidden, true);
  env.elements.get('save-format').value = 'gif';
  await env.elements.get('save-format').emit('change');
  for (const id of ['copy-gif-button', 'copy-range-gif-button']) assert.equal(env.elements.get(id).hidden, false);
  env.respond = async () => ({ ok: true, state: structuredClone(env.state), output: { url: 'blob:animated-gif' } });
  env.click('copy-range-gif-button');
  await settle();
  assert.deepEqual(env.commands(), [{
    target: 'background', type: 'PREPARE_GIF_COPY', scope: 'range', startSeconds: 1.12, endSeconds: 4.56,
  }]);
  assert.deepEqual(env.fetched, ['blob:animated-gif']);
  assert.equal(env.copied[0].type, 'image/gif');
  assert.equal(env.elements.get('copy-status').dataset.mode, 'html-gif');
  assert.match(env.text('copy-status'), /문서·편집기/);
  assert.match(env.text('copy-status'), /메신저는 파일 첨부/);
  assert.equal(env.elements.get('video-preview').src, 'blob:original-video');
  env.copyGif = async () => ({ mode: 'native-gif' });
  env.click('copy-gif-button');
  await settle();
  assert.deepEqual(env.commands().at(-1), { target: 'background', type: 'PREPARE_GIF_COPY', scope: 'whole' });
  assert.match(env.text('copy-status'), /일부 앱은 GIF 붙여넣기를 지원하지 않아요/);
  assert.equal(env.elements.get('copy-status').dataset.mode, 'native-gif');
  env.state = { ...videoReady(), mode: 'audio', result: { ...videoReady().result, kind: 'audio' } };
  await env.poll();
  assert.equal(env.elements.get('copy-gif-button').hidden, true);
  assert.equal(env.elements.get('copy-range-gif-button').hidden, true);
  assert.equal(env.elements.get('copy-status').hidden, true);
});

test('copy keeps edits locked through clipboard write and never reports success for rejected writes', async () => {
  const env = await popup({ initialState: videoReady() });
  env.elements.get('save-format').value = 'gif';
  await env.elements.get('save-format').emit('change');
  const writing = deferred();
  env.respond = async () => ({ ok: true, state: structuredClone(env.state), output: { url: 'blob:animated-gif' } });
  env.copyGif = () => writing.promise;
  env.click('copy-gif-button');
  await settle();
  for (const id of ['trim-start', 'save-button', 'save-range-button', 'save-format', 'copy-gif-button', 'copy-range-gif-button', 'discard-button']) {
    assert.equal(env.elements.get(id).disabled, true, id);
  }
  assert.match(env.text('copy-status'), /창을 열어 두세요/);
  assert.doesNotMatch(env.text('copy-status'), /완료/);
  writing.reject(new Error('클립보드 권한을 확인해 주세요.'));
  await settle();
  assert.equal(env.elements.get('copy-status').hidden, true);
  assert.match(env.text('error-message'), /클립보드 권한/);
  assert.equal(env.elements.get('copy-gif-button').disabled, false);
  assert.equal(env.elements.get('video-preview').src, 'blob:original-video');
});

test('invalid ranges block selected copy only and cancelled preparation never touches the clipboard', async () => {
  const env = await popup({ initialState: videoReady() });
  env.elements.get('save-format').value = 'gif';
  env.elements.get('trim-start').value = '';
  await env.elements.get('trim-start').emit('input');
  assert.equal(env.elements.get('copy-range-gif-button').disabled, true);
  assert.equal(env.elements.get('copy-gif-button').disabled, false);
  const preparing = deferred();
  env.respond = async (message) => {
    if (message.type === 'PREPARE_GIF_COPY') {
      env.state = { ...env.state, status: 'exporting', exportFormat: 'gif', exportProgress: 0.2 };
      return preparing.promise;
    }
    if (message.type === 'CANCEL_EXPORT') env.state = { ...env.state, status: 'ready' };
    return { ok: true, state: structuredClone(env.state) };
  };
  env.click('copy-range-gif-button');
  env.click('copy-gif-button');
  await env.poll();
  env.click('cancel-export-button');
  await settle();
  assert.deepEqual(env.commands().map(({ type }) => type), ['PREPARE_GIF_COPY', 'CANCEL_EXPORT']);
  assert.equal(env.elements.get('copy-gif-button').disabled, true);
  preparing.resolve({ ok: false, cancelled: true, state: structuredClone(env.state) });
  await settle();
  assert.equal(env.elements.get('copy-gif-button').disabled, false);
  assert.equal(env.elements.get('error-message').hidden, true);
  assert.equal(env.elements.get('copy-status').hidden, true);
  assert.equal(env.fetched.length, 0);
  assert.equal(env.copied.length, 0);
});

test('late selection acknowledgements cannot erase later video export or clipboard errors', async () => {
  for (const action of ['save-range-button', 'copy-range-gif-button']) {
    const env = await popup({ initialState: videoReady() });
    env.elements.get('save-format').value = 'gif';
    const selection = deferred();
    env.respond = async (message) => {
      if (message.type === 'SET_SELECTION') return selection.promise;
      if (message.type === 'SAVE_VIDEO_RANGE') return { ok: false, error: '영상 변환 실패', state: structuredClone(env.state) };
      return { ok: true, state: structuredClone(env.state), output: { url: 'blob:animated-gif' } };
    };
    env.copyGif = async () => { throw new Error('클립보드 쓰기 실패'); };
    env.elements.get('trim-start').value = '1.23';
    await env.elements.get('trim-start').emit('input');
    env.click(action);
    await settle();
    const failure = env.text('error-message');
    assert.match(failure, /실패/);
    selection.resolve({ ok: true, state: structuredClone(env.state) });
    await settle();
    assert.equal(env.text('error-message'), failure);
    assert.equal(env.elements.get('error-message').hidden, false);
    assert.equal(env.elements.get('trim-start').value, '1.23');
  }
});

test('invalidating a pending selection ignores its obsolete persistence error', async () => {
  const env = await popup({ initialState: videoReady() });
  const selection = deferred();
  env.respond = () => selection.promise;
  env.elements.get('trim-start').value = '1.23';
  await env.elements.get('trim-start').emit('input');
  env.elements.get('trim-start').value = '';
  await env.elements.get('trim-start').emit('input');
  selection.resolve({ ok: false, error: 'Old invalid selection' });
  await settle();
  assert.equal(env.elements.get('error-message').hidden, true);
  assert.equal(env.elements.get('trim-start').value, '');
  assert.match(env.text('trim-error'), /숫자로 입력/);
});

test('video MP4 whole and range saves carry the chosen content while preview and bounds stay original', async () => {
  const env = await popup({ initialState: videoReady() });
  const content = env.elements.get('save-content');
  assert.equal(content.value, 'both');
  assert.equal(env.elements.get('save-content-field').hidden, false);
  env.elements.get('video-preview').currentTime = 2.34;
  for (const [value, label, description] of [
    ['both', '영상+소리', '영상과 소리를 함께'],
    ['video', '무음 영상', '소리 없이 영상만'],
    ['audio', '소리만', '영상 없이 소리만'],
  ]) {
    content.value = value;
    await content.emit('change');
    assert.equal(env.text('save-button'), `전체 저장 · ${label} .mp4`);
    assert.equal(env.text('save-range-button'), `선택 구간 저장 · ${label} .mp4`);
    assert.ok(env.text('video-note').includes(description));
    assert.match(env.text('video-note'), /미리보기는 원본 영상과 소리/);
    env.click('save-button');
    await settle();
    assert.deepEqual(env.commands().at(-1), { target: 'background', type: 'SAVE_VIDEO', format: 'mp4', content: value });
    env.click('save-range-button');
    await settle();
    assert.deepEqual(env.commands().at(-1), {
      target: 'background', type: 'SAVE_VIDEO_RANGE', format: 'mp4', content: value, startSeconds: 1.12, endSeconds: 4.56,
    });
    assert.equal(env.elements.get('video-preview').src, 'blob:original-video');
    assert.equal(env.elements.get('video-preview').currentTime, 2.34);
    assert.equal(env.elements.get('trim-start').value, '1.12');
    assert.equal(env.elements.get('trim-end').value, '4.56');
  }
});

test('GIF ignores remembered MP4 content and audio recording keeps its original save behavior', async () => {
  const env = await popup({ initialState: videoReady() });
  const format = env.elements.get('save-format');
  const content = env.elements.get('save-content');
  content.value = 'audio';
  format.value = 'gif';
  await format.emit('change');
  assert.equal(env.elements.get('save-content-field').hidden, true);
  assert.equal(env.text('save-button'), '전체 저장 · .gif');
  env.click('save-button');
  await settle();
  assert.deepEqual(env.commands().at(-1), { target: 'background', type: 'SAVE_VIDEO', format: 'gif' });
  env.click('save-range-button');
  await settle();
  assert.deepEqual(env.commands().at(-1), {
    target: 'background', type: 'SAVE_VIDEO_RANGE', format: 'gif', startSeconds: 1.12, endSeconds: 4.56,
  });
  env.state = { ...env.state, status: 'exporting', exportFormat: 'gif', exportContent: 'video' };
  await env.poll();
  assert.equal(content.value, 'audio', 'GIF processing does not overwrite the remembered MP4 choice');
  env.state = { ...env.state, status: 'ready' };
  await env.poll();
  format.value = 'mp4';
  await format.emit('change');
  assert.equal(content.value, 'audio');
  assert.equal(env.elements.get('save-content-field').hidden, false);
  assert.equal(env.text('save-range-button'), '선택 구간 저장 · 소리만 .mp4');
  env.state = { ...videoReady(), mode: 'audio', result: { ...videoReady().result, kind: 'audio' } };
  await env.poll();
  assert.equal(env.elements.get('save-content-field').hidden, true);
  env.click('save-button');
  await settle();
  assert.deepEqual(env.commands().at(-1), { target: 'background', type: 'SAVE' });
  assert.equal(env.text('save-button'), '전체 저장 · .mp4');
});

test('content extraction locks its choice, shows progress and preserves it after cancellation', async () => {
  const env = await popup({ initialState: videoReady() });
  const conversion = deferred();
  env.elements.get('save-content').value = 'audio';
  env.respond = async (message) => {
    if (message.type === 'SAVE_VIDEO') {
      env.state = { ...env.state, status: 'trimming', exportFormat: 'mp4', exportContent: 'audio', exportProgress: 0.42 };
      return conversion.promise;
    }
    if (message.type === 'CANCEL_EXPORT') env.state = { ...env.state, status: 'ready' };
    return { ok: true, state: structuredClone(env.state) };
  };
  env.click('save-button');
  await env.poll();
  assert.equal(env.elements.get('save-content').disabled, true);
  assert.equal(env.text('status-label'), '소리만 만드는 중 42%');
  assert.equal(env.text('save-button'), '소리만 만드는 중 42%');
  assert.equal(env.elements.get('cancel-export-button').hidden, false);
  env.click('cancel-export-button');
  await settle();
  conversion.resolve({ ok: false, cancelled: true, state: structuredClone(env.state) });
  await settle();
  assert.equal(env.elements.get('save-content').disabled, false);
  assert.equal(env.elements.get('save-content').value, 'audio');
  assert.equal(env.elements.get('video-preview').src, 'blob:original-video');
  assert.equal(env.elements.get('error-message').hidden, true);
  const reopening = await popup({ initialState: {
    ...videoReady(), status: 'trimming', exportFormat: 'mp4', exportContent: 'video', exportProgress: 0.52,
  } });
  assert.equal(reopening.elements.get('save-content').value, 'video');
  assert.equal(reopening.elements.get('save-content').disabled, true);
  assert.equal(reopening.text('status-label'), '무음 영상 만드는 중 52%');
});

test('file extraction opens independently of unsupported pages, unsaved results and pending recorder commands', async () => {
  const env = await popup({ initialState: videoReady(), armError: '이 페이지에 연결할 수 없어요.' });
  assert.match(env.text('shortcut-status'), /연결 불가/);
  assert.equal(env.elements.get('open-extract-button').disabled, false);
  env.click('open-extract-button');
  await settle();
  assert.deepEqual(env.tabs, [{ url: 'chrome-extension://test/extract.html' }]);
  assert.equal(env.commands().length, 0);
  assert.equal(env.elements.get('video-preview').src, 'blob:original-video');
  const starting = await popup({ armError: '브라우저 설정 페이지예요.' });
  const start = deferred();
  starting.respond = () => start.promise;
  starting.press('1');
  starting.click('open-extract-button');
  await settle();
  assert.deepEqual(starting.tabs, [{ url: 'chrome-extension://test/extract.html' }]);
  assert.deepEqual(starting.commands().map(({ type }) => type), ['START']);
  start.resolve({ ok: true, state: { ...idle(), status: 'recording' } });
  await settle();
});

test('opening the file extractor deduplicates clicks and recovers from tab creation failure', async () => {
  const env = await popup();
  const opening = deferred();
  let attempts = 0;
  env.createTab = async () => { attempts += 1; return opening.promise; };
  env.click('open-extract-button');
  env.click('open-extract-button');
  assert.equal(attempts, 1);
  opening.reject(new Error('Could not open tab'));
  await settle();
  assert.equal(env.elements.get('open-extract-button').disabled, false);
  assert.match(env.text('error-message'), /추출 창을 열지 못/);
  assert.equal(env.elements.get('start-button').disabled, false);
});
