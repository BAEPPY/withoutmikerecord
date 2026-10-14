import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const source = await readFile(new URL('../extension/page-shortcuts.js', import.meta.url), 'utf8');

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function element(tagName, attributes = {}) {
  return {
    tagName, style: {}, children: [], isConnected: false, textContent: '',
    setAttribute(name, value) { attributes[name] = value; },
    getAttribute(name) { return attributes[name] ?? null; },
    attachShadow() { this.shadow = element('shadow'); return this.shadow; },
    append(...children) {
      this.children.push(...children);
      children.forEach((child) => { child.isConnected = true; });
    },
    remove() { this.isConnected = false; },
  };
}

// Browser integration verifies actual trusted keyboard events. This isolated
// context makes message timing and extension invalidation deterministic.
function page() {
  const listeners = new Set();
  const sent = [];
  const body = element('body');
  const timers = new Map();
  let nextTimer = 0;
  const env = {
    listeners, sent,
    async respond() { return { ok: true }; },
    toast() { return body.children.at(-1)?.shadow?.children.at(-1)?.textContent || ''; },
  };
  const context = vm.createContext({
    document: { body, documentElement: body, createElement: element },
    chrome: {
      runtime: {
        id: 'test-extension',
        async sendMessage(message) { sent.push(structuredClone(message)); return env.respond(message); },
      },
    },
    window: {
      addEventListener(type, listener, capture) {
        assert.equal(type, 'keydown');
        assert.equal(capture, true);
        listeners.add(listener);
      },
      removeEventListener(type, listener) { listeners.delete(listener); },
      setTimeout(callback) { const id = ++nextTimer; timers.set(id, callback); return id; },
      clearTimeout(id) { timers.delete(id); },
    },
  });
  env.install = () => vm.runInContext(source, context);
  env.press = (key, overrides = {}) => {
    const event = {
      key, isTrusted: true, defaultPrevented: false, repeat: false, isComposing: false,
      keyCode: key === '1' ? 49 : 50,
      composedPath: () => [element('video')],
      preventDefault() { this.prevented = true; },
      stopImmediatePropagation() { this.stopped = true; },
      ...overrides,
    };
    return { event, completion: Promise.all([...listeners].map((listener) => listener(event))) };
  };
  env.install();
  return env;
}

test('queues one stop until a pending start succeeds, without duplicate commands', async () => {
  const env = page();
  const startReply = deferred();
  const stopEntered = deferred();
  const stopReply = deferred();
  env.respond = (message) => {
    if (message.key === '1') return startReply.promise;
    stopEntered.resolve();
    return stopReply.promise;
  };
  const start = env.press('1');
  const stop = env.press('2');
  await stop.completion;
  await env.press('2').completion;
  await env.press('1').completion;
  assert.deepEqual(env.sent.map((message) => message.key), ['1']);
  assert.ok(stop.event.prevented && stop.event.stopped);

  startReply.resolve({ ok: true });
  await stopEntered.promise;
  assert.deepEqual(env.sent, [
    { target: 'background', type: 'PAGE_SHORTCUT', key: '1' },
    { target: 'background', type: 'PAGE_SHORTCUT', key: '2' },
  ]);
  await env.press('2').completion;
  await env.press('2', { repeat: true }).completion;
  assert.equal(env.sent.length, 2);
  stopReply.resolve({ ok: true });
  await start.completion;
  assert.match(env.toast(), /녹음을 마쳤어요/);
});

test('a failed start drops the queued stop and clears it before the next start', async () => {
  const env = page();
  const startReply = deferred();
  env.respond = () => startReply.promise;
  const start = env.press('1');
  await env.press('2').completion;
  startReply.resolve({ ok: false, error: '탭 권한이 없습니다.' });
  await start.completion;
  assert.deepEqual(env.sent.map((message) => message.key), ['1']);
  assert.equal(env.toast(), '탭 권한이 없습니다.');

  env.respond = async () => ({ ok: true });
  await env.press('1').completion;
  assert.deepEqual(env.sent.map((message) => message.key), ['1', '1']);
  assert.match(env.toast(), /녹음을 시작했어요/);
});

test('ignores repeats, synthetic keys, IME, modifiers, and editable controls', async () => {
  const env = page();
  for (const overrides of [
    { repeat: true }, { isTrusted: false }, { defaultPrevented: true },
    { isComposing: true }, { keyCode: 229 },
    { ctrlKey: true }, { altKey: true }, { metaKey: true }, { shiftKey: true },
    ...['input', 'textarea', 'select'].map((tag) => ({ composedPath: () => [element(tag)] })),
    { composedPath: () => [{ isContentEditable: true }] },
    ...['textbox', 'spinbutton', 'combobox'].map((role) => ({
      composedPath: () => [element('div', { role })],
    })),
  ]) {
    const { event, completion } = env.press('1', overrides);
    await completion;
    assert.equal(event.prevented, undefined);
  }
  assert.equal(env.sent.length, 0);
});

test('focused video and audio controls still support recording shortcuts', async () => {
  const env = page();
  for (const [key, tag] of [['1', 'video'], ['2', 'audio']]) {
    const { event, completion } = env.press(key, { composedPath: () => [element(tag)] });
    await completion;
    assert.ok(event.prevented && event.stopped);
  }
  assert.deepEqual(env.sent.map((message) => message.key), ['1', '2']);
});

test('repeated injection installs only one listener', async () => {
  const env = page();
  env.install();
  env.install();
  assert.equal(env.listeners.size, 1);
  await env.press('1').completion;
  assert.equal(env.sent.length, 1);
});

test('an invalidated extension context releases page keys and clears installation state', async () => {
  const env = page();
  env.respond = async () => { throw new Error('Extension context invalidated.'); };
  await env.press('1').completion;
  assert.equal(env.listeners.size, 0);
  assert.match(env.toast(), /새로고침/);
  const { event, completion } = env.press('2');
  await completion;
  assert.equal(event.prevented, undefined);
  assert.equal(env.sent.length, 1);

  env.respond = async () => ({ ok: true });
  env.install();
  assert.equal(env.listeners.size, 1);
  await env.press('1').completion;
  assert.equal(env.sent.length, 2);
});
