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
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

class Element {
  constructor(id = '') {
    Object.assign(this, { id, textContent: '', value: '', hidden: false, disabled: false,
      dataset: {}, style: {}, currentTime: 0, duration: NaN, paused: true, attributes: {}, listeners: {} });
    this.classList = { toggle() {} };
  }
  get valueAsNumber() { return this.value === '' ? NaN : Number(this.value); }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  removeAttribute(name) { delete this.attributes[name]; }
  addEventListener(type, listener) { (this.listeners[type] ||= []).push(listener); }
  closest(selector) {
    if (selector === '[hidden]') return this.hidden ? this : this.parent?.closest(selector);
    return this.editable ? this : null;
  }
  click() {
    if (this.disabled || this.closest('[hidden]')) return;
    for (const listener of this.listeners.click || []) listener();
  }
  pause() { this.paused = true; }
  load() {}
}

async function popup({ initialState = idle(), assignments = [], assignmentError = false, userAgent = 'Chrome/135' } = {}) {
  const elements = new Map([...html.matchAll(/\bid="([^"]+)"/g)].map((match) => [match[1], new Element(match[1])]));
  const listeners = {};
  const env = { state: initialState, sent: [], closed: 0, tabs: [], assignmentReads: 0, elements };
  env.respond = async () => ({ ok: true, state: structuredClone(env.state) });
  for (const id of ['pause-button', 'stop-button']) elements.get(id).parent = elements.get('recording-controls');
  elements.get('save-format').value = 'mp4';
  const context = vm.createContext({
    Element, crypto: { randomUUID }, navigator: { userAgent },
    document: {
      hidden: false,
      getElementById(id) { assert.ok(elements.has(id), `Missing popup element: ${id}`); return elements.get(id); },
      querySelector() { return new Element(); },
      addEventListener(type, listener) { (listeners[type] ||= []).push(listener); },
    },
    window: { setTimeout() {}, requestAnimationFrame() {}, cancelAnimationFrame() {},
      addEventListener() {}, close() { env.closed += 1; }, confirm() { return true; } },
    chrome: {
      runtime: { async sendMessage(message) { env.sent.push(structuredClone(message)); return env.respond(message); } },
      commands: { async getAll() {
        env.assignmentReads += 1;
        if (assignmentError) throw new Error('Could not read commands');
        return assignments;
      } },
      tabs: { async create(options) { env.tabs.push(structuredClone(options)); } },
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
