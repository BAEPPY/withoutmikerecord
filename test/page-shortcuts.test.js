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
function page({ runtimeMessages = false, configure = () => {} } = {}) {
  const listeners = new Set();
  const windowListeners = new Map([['keydown', listeners]]);
  const messageListeners = new Set();
  const sent = [];
  const selections = [];
  const messageReplies = [];
  const body = element('body');
  const timers = new Map();
  let nextTimer = 0;
  const env = {
    listeners, windowListeners, messageListeners, sent, selections, messageReplies, selectorCancels: 0,
    async respond() { return { ok: true }; },
    async selectRegion() { return null; },
    cancelRegion() {},
    toast() {
      return body.children.filter((child) => child.isConnected).at(-1)?.shadow?.children.at(-1)?.textContent || '';
    },
  };
  const runtime = {
    id: 'test-extension',
    async sendMessage(message) { sent.push(structuredClone(message)); return env.respond(message); },
  };
  if (runtimeMessages) {
    runtime.onMessage = {
      addListener(listener) { messageListeners.add(listener); },
      removeListener(listener) { messageListeners.delete(listener); },
    };
  }
  const context = vm.createContext({
    document: { body, documentElement: body, createElement: element },
    chrome: { runtime },
    async __withoutMikeSelectRegion(options) {
      selections.push(structuredClone(options));
      return env.selectRegion(options);
    },
    __withoutMikeCancelRegion() {
      env.selectorCancels += 1;
      env.cancelRegion();
    },
    window: {
      innerWidth: 1000,
      innerHeight: 800,
      addEventListener(type, listener, capture) {
        if (type === 'keydown') assert.equal(capture, true);
        if (!windowListeners.has(type)) windowListeners.set(type, new Set());
        windowListeners.get(type).add(listener);
      },
      removeEventListener(type, listener) { windowListeners.get(type)?.delete(listener); },
      setTimeout(callback) { const id = ++nextTimer; timers.set(id, callback); return id; },
      clearTimeout(id) { timers.delete(id); },
    },
  });
  env.context = context;
  env.runtime = runtime;
  env.install = () => vm.runInContext(source, context);
  env.press = (key, overrides = {}, targets = listeners) => {
    const event = {
      key, isTrusted: true, defaultPrevented: false, repeat: false, isComposing: false,
      keyCode: typeof key === 'string' ? key.charCodeAt(0) : 0,
      composedPath: () => [element('video')],
      preventDefault() { this.prevented = true; },
      stopImmediatePropagation() { this.stopped = true; },
      ...overrides,
    };
    return { event, completion: Promise.all([...targets].map((listener) => listener(event))) };
  };
  env.message = (message) => Promise.all([...messageListeners].map((listener) => (
    listener(message, { id: 'test-extension' }, (reply) => { messageReplies.push(structuredClone(reply)); })
  )));
  env.runTimers = () => Promise.all([...timers].map(([id, callback]) => {
    timers.delete(id);
    return callback();
  }));
  env.resize = (width, height) => {
    context.window.innerWidth = width;
    context.window.innerHeight = height;
  };
  env.windowEvent = (type) => Promise.all([...(windowListeners.get(type) || [])].map((listener) => (
    listener({ type })
  )));
  configure(context, env);
  env.install();
  return env;
}

function framePage() {
  const observers = [];
  function documentWithFrames(document = { documentElement: {} }) {
    document.frames = [];
    document.scans = 0;
    document.querySelectorAll = (selector) => {
      assert.equal(selector, 'iframe, frame');
      document.scans += 1;
      return document.frames;
    };
    return document;
  }
  function frame(parentDocument, { crossOrigin = false } = {}) {
    const listeners = new Set();
    const loads = new Set();
    const target = {
      document: documentWithFrames(),
      addEventListener(type, listener, capture) {
        assert.equal(type, 'keydown');
        assert.equal(capture, true);
        listeners.add(listener);
      },
      removeEventListener(type, listener) { listeners.delete(listener); },
    };
    if (crossOrigin) Object.defineProperty(target, 'document', {
      configurable: true,
      get() { throw new Error('Cross-origin access denied'); },
    });
    const node = {
      tagName: 'IFRAME', contentWindow: target, listeners, loads,
      addEventListener(type, listener) { assert.equal(type, 'load'); loads.add(listener); },
      removeEventListener(type, listener) { loads.delete(listener); },
      async load() { for (const callback of loads) callback(); await Promise.resolve(); },
    };
    parentDocument.frames.push(node);
    return node;
  }
  const env = page({
    runtimeMessages: true,
    configure(context, env) {
      const document = documentWithFrames(context.document);
      env.firstFrame = frame(document);
      env.nestedFrame = frame(env.firstFrame.contentWindow.document);
      env.foreignFrame = frame(document, { crossOrigin: true });
      context.MutationObserver = class {
        constructor(callback) { this.callback = callback; observers.push(this); }
        observe(target) { this.target = target; this.active = true; }
        disconnect() { this.active = false; }
      };
    },
  });
  env.documentWithFrames = documentWithFrames;
  env.addFrame = frame;
  env.observers = observers;
  env.mutate = (document, addedNodes = [], removedNodes = []) => {
    for (const observer of observers) {
      if (observer.active && observer.target === document.documentElement) {
        observer.callback([{ addedNodes, removedNodes }]);
      }
    }
  };
  env.pressFrame = (target, key, overrides = {}) => env.press(key, overrides, target.listeners);
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
  startReply.resolve({ ok: false, error: '탭 권한이 없습니다.', state: { mode: 'audio', status: 'idle' } });
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
    { repeat: true }, { isTrusted: false },
    { isComposing: true }, { keyCode: 229 },
    { ctrlKey: true }, { altKey: true }, { metaKey: true }, { shiftKey: true },
    ...['input', 'textarea', 'select'].map((tag) => ({ composedPath: () => [element(tag)] })),
    { composedPath: () => [{ isContentEditable: true }] },
    ...['textbox', 'spinbutton', 'combobox'].map((role) => ({
      composedPath: () => [element('div', { role })],
    })),
  ]) {
    const { event, completion } = env.press('1', { code: 'Digit1', ...overrides });
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

test('native non-text input controls permit recording shortcuts', async () => {
  const env = page();
  const types = ['range', 'button', 'submit', 'reset', 'checkbox', 'radio', 'image', 'color', 'file', 'hidden'];
  for (const type of types) {
    const input = Object.assign(element('input', { type }), { type });
    for (const key of ['1', '2']) {
      const { event, completion } = env.press(key, { composedPath: () => [input] });
      await completion;
      assert.ok(event.prevented && event.stopped, `${type} should allow key ${key}`);
    }
  }
  assert.equal(env.sent.length, types.length * 2);
});

test('text, numeric, and date input controls retain their editing keys', async () => {
  const env = page();
  for (const type of ['text', 'number', 'search', 'email', 'password', 'tel', 'url', 'date', 'datetime-local', 'month', 'week', 'time']) {
    const input = Object.assign(element('input', { type }), { type });
    for (const key of ['1', '2', '3', '4']) {
      const { event, completion } = env.press(key, {
        code: `Digit${key}`, defaultPrevented: true, composedPath: () => [input],
      });
      await completion;
      assert.equal(event.prevented, undefined, `${type} must keep key ${key} for editing`);
    }
  }
  assert.deepEqual(env.sent, []);
});

test('a trusted recorder key still works after the site prevented its default action', async () => {
  const env = page();
  for (const key of ['1', '2']) {
    const { event, completion } = env.press(key, { defaultPrevented: true });
    await completion;
    assert.ok(event.prevented && event.stopped);
  }
  assert.deepEqual(env.sent.map((message) => message.key), ['1', '2']);
});

test('physical digit keys normalize differing keyboard layouts without changing numeric key priority', async () => {
  const env = page();
  env.respond = async () => ({ ok: false, error: 'test response' });
  const cases = [
    { key: '&', code: 'Digit1', expected: '1' },
    { key: 'é', code: 'Digit2', expected: '2' },
    { key: '"', code: 'Digit3', expected: '3' },
    { key: "'", code: 'Digit4', expected: '4' },
    { key: '2', code: 'Digit1', expected: '2' },
  ];
  for (const { key, code, expected } of cases) {
    const { event, completion } = env.press(key, { code });
    await completion;
    assert.ok(event.prevented && event.stopped, `${code} should normalize to ${expected}`);
    assert.equal(env.sent.at(-1).key, expected);
  }
  assert.equal(env.sent.length, cases.length);
});

test('numpad digit keys work when numeric or unidentified but preserve NumLock-off navigation', async () => {
  const env = page();
  env.respond = async () => ({ ok: false, error: 'test response' });
  for (const number of ['1', '2', '3', '4']) {
    for (const key of [number, undefined, 'Unidentified']) {
      const { event, completion } = env.press(key, { code: `Numpad${number}` });
      await completion;
      assert.ok(event.prevented && event.stopped);
      assert.equal(env.sent.at(-1).key, number);
    }
  }
  const sentBeforeNavigation = env.sent.length;
  for (const [key, code] of [
    ['End', 'Numpad1'], ['ArrowDown', 'Numpad2'], ['PageDown', 'Numpad3'], ['ArrowLeft', 'Numpad4'],
  ]) {
    const { event, completion } = env.press(key, { code });
    await completion;
    assert.equal(event.prevented, undefined, `${key} must remain a navigation key`);
  }
  assert.equal(env.sent.length, sentBeforeNavigation);
});

test('layout normalization still ignores IME and modified physical digit keys', async () => {
  const env = page();
  for (const overrides of [
    { repeat: true }, { isTrusted: false }, { isComposing: true }, { keyCode: 229 },
    { ctrlKey: true }, { altKey: true }, { metaKey: true }, { shiftKey: true },
  ]) {
    const { event, completion } = env.press('&', { code: 'Digit1', ...overrides });
    await completion;
    assert.equal(event.prevented, undefined);
  }
  assert.deepEqual(env.sent, []);
});

test('a rejected audio start preserves queued 2 when that reply confirms audio is already recording',
  { timeout: 2000 }, async () => {
    const env = page();
    const startReply = deferred();
    env.respond = (message) => message.key === '1'
      ? startReply.promise : { ok: true, state: { mode: 'audio', status: 'ready' } };
    const start = env.press('1');
    await env.press('2').completion;
    await env.press('2').completion;
    startReply.resolve({ ok: false, error: '이미 녹음 중입니다.', state: { mode: 'audio', status: 'recording' } });
    await start.completion;
    assert.deepEqual(env.sent.map((message) => message.key), ['1', '2']);
    assert.match(env.toast(), /녹음을 마쳤어요/);
  });

test('a rejected audio start does not send queued 2 to an active video session', async () => {
  const env = page();
  const startReply = deferred();
  env.respond = () => startReply.promise;
  const start = env.press('1');
  await env.press('2').completion;
  startReply.resolve({ ok: false, error: '화면 녹화 중입니다.', state: { mode: 'video', status: 'recording' } });
  await start.completion;
  assert.deepEqual(env.sent.map((message) => message.key), ['1']);
});

test('repeated injection installs only one listener', async () => {
  const env = page();
  env.install();
  env.install();
  assert.equal(env.listeners.size, 1);
  await env.press('1').completion;
  assert.equal(env.sent.length, 1);
});

test('legacy installation markers do not block a new usable installation', async () => {
  for (const marker of [true, {}]) {
    const env = page();
    env.context.__withoutMikePageShortcuts.dispose();
    env.context.__withoutMikePageShortcuts = marker;
    env.install();
    assert.equal(env.listeners.size, 1);
    assert.equal(env.context.__withoutMikePageShortcuts.isAlive(), true);
    await env.press('1').completion;
    assert.equal(env.sent.length, 1);
  }
});

test('reinjection replaces a dead runtime even when its id remains and cancels its scheduled selector', async () => {
  const env = page({ runtimeMessages: true });
  const oldInstallation = env.context.__withoutMikePageShortcuts;
  await env.message({ type: 'SHOW_VIDEO_SELECTOR' });
  env.runtime.getManifest = () => { throw new Error('Extension context invalidated.'); };
  assert.equal(env.runtime.id, 'test-extension');
  assert.equal(oldInstallation.isAlive(), false);
  env.install();
  env.runtime.getManifest = () => ({ version: 'test' });
  assert.equal(oldInstallation.active, false);
  assert.notEqual(env.context.__withoutMikePageShortcuts, oldInstallation);
  assert.equal(env.listeners.size, 1);
  assert.equal(env.messageListeners.size, 1);
  await env.runTimers();
  assert.deepEqual(env.sent, []);
  await env.press('1').completion;
  assert.deepEqual(env.sent.map((message) => message.key), ['1']);
});

test('same-origin frame and nested-frame keys share the top command queue without crossing origin boundaries', async () => {
  const env = framePage();
  assert.equal(env.firstFrame.listeners.size, 1);
  assert.equal(env.nestedFrame.listeners.size, 1);
  assert.equal(env.foreignFrame.listeners.size, 0);
  const started = deferred();
  env.respond = (message) => message.key === '1' ? started.promise : { ok: true };
  const start = env.pressFrame(env.nestedFrame, '1');
  await env.press('2').completion;
  assert.deepEqual(env.sent.map((message) => message.key), ['1']);
  started.resolve({ ok: true });
  await start.completion;
  assert.deepEqual(env.sent.map((message) => message.key), ['1', '2']);
  const editable = env.pressFrame(env.firstFrame, '1', { composedPath: () => [element('input')] });
  await editable.completion;
  assert.equal(editable.event.prevented, undefined);
});

test('frame discovery batches additions, ignores unrelated mutations, and detaches removed frames', async () => {
  const env = framePage();
  const document = env.context.document;
  const initialScans = document.scans;
  env.mutate(document, [element('div'), { nodeType: 3 }]);
  await Promise.resolve();
  assert.equal(document.scans, initialScans);
  const added = env.addFrame(document);
  env.mutate(document, [added]);
  env.mutate(document, [added]);
  await Promise.resolve();
  assert.equal(document.scans, initialScans + 1);
  assert.equal(added.listeners.size, 1);
  await env.pressFrame(added, '1').completion;
  assert.equal(env.sent.length, 1);
  const removedObserver = env.observers.find((observer) => observer.target === added.contentWindow.document.documentElement);
  document.frames.splice(document.frames.indexOf(added), 1);
  env.mutate(document, [], [added]);
  await Promise.resolve();
  assert.equal(added.listeners.size, 0);
  assert.equal(added.loads.size, 0);
  assert.equal(removedObserver.active, false);
  const removedKey = env.pressFrame(added, '2');
  await removedKey.completion;
  assert.equal(removedKey.event.prevented, undefined);
});

test('frame reload replaces its document observer and disconnect releases every frame listener', async () => {
  const env = framePage();
  const frame = env.firstFrame;
  const oldDocument = frame.contentWindow.document;
  const oldObserver = env.observers.find((observer) => observer.target === oldDocument.documentElement);
  frame.contentWindow.document = env.documentWithFrames();
  await frame.load();
  assert.equal(frame.listeners.size, 1);
  assert.equal(oldObserver.active, false);
  assert.equal(env.nestedFrame.listeners.size, 0);
  assert.equal(env.nestedFrame.loads.size, 0);
  await env.pressFrame(frame, '1').completion;
  assert.equal(env.sent.length, 1);
  env.runtime.getManifest = () => { throw new Error('Extension context invalidated.'); };
  const rejected = env.pressFrame(frame, '2');
  await rejected.completion;
  assert.equal(rejected.event.prevented, undefined);
  assert.equal(env.listeners.size, 0);
  assert.equal(frame.listeners.size, 0);
  assert.equal(frame.loads.size, 0);
  assert.equal(env.observers.filter((observer) => observer.active).length, 0);
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

const videoSelection = {
  ok: true,
  state: { status: 'selecting', mode: 'video' },
  imageDataUrl: 'data:image/png;base64,dGVzdA==',
  selectionToken: 'selection-test-token',
};
const videoRegion = {
  x: 0.1, y: 0.2, width: 0.5, height: 0.4, viewportWidth: 1000, viewportHeight: 800,
};

test('a rejected video BEGIN preserves queued 4 when that reply confirms video is already recording',
  { timeout: 2000 }, async () => {
    const env = page();
    const beginReply = deferred();
    env.respond = (message) => message.key === '3'
      ? beginReply.promise : { ok: true, state: videoState('ready') };
    const start = env.press('3');
    await env.press('4').completion;
    await env.press('4').completion;
    beginReply.resolve({ ok: false, error: '이미 화면 녹화 중입니다.', state: videoState('recording') });
    await start.completion;
    assert.deepEqual(env.sent, [
      { target: 'background', type: 'PAGE_SHORTCUT', key: '3' },
      { target: 'background', type: 'PAGE_SHORTCUT', key: '4' },
    ]);
    assert.deepEqual(env.selections, []);
    assert.doesNotMatch(env.toast(), /이미 화면 녹화 중/);
  });

test('a rejected idle video BEGIN drops queued 4 and releases the next shortcut', async () => {
  const env = page();
  const beginReply = deferred();
  env.respond = () => beginReply.promise;
  const start = env.press('3');
  await env.press('4').completion;
  beginReply.resolve({ ok: false, error: '탭 권한이 없습니다.', state: videoState('idle', null) });
  await start.completion;
  assert.deepEqual(env.sent.map((message) => message.key), ['3']);
  assert.equal(env.toast(), '탭 권한이 없습니다.');

  env.respond = async () => ({ ok: true });
  await env.press('1').completion;
  assert.deepEqual(env.sent.map((message) => message.key), ['3', '1']);
});

test('4 cancels a pending 3 as soon as its selection token arrives, without opening the selector',
  { timeout: 2000 }, async () => {
    const env = page();
    const beginReply = deferred();
    env.respond = (message) => message.type === 'PAGE_SHORTCUT'
      ? beginReply.promise : { ok: true };

    const start = env.press('3');
    const stop = env.press('4');
    await stop.completion;
    await env.press('4').completion;
    await env.press('3').completion;
    assert.ok(stop.event.prevented && stop.event.stopped);
    assert.deepEqual(env.sent, [
      { target: 'background', type: 'PAGE_SHORTCUT', key: '3' },
    ]);

    beginReply.resolve(videoSelection);
    await start.completion;
    assert.deepEqual(env.selections, []);
    assert.deepEqual(env.sent, [
      { target: 'background', type: 'PAGE_SHORTCUT', key: '3' },
      { target: 'background', type: 'CANCEL_VIDEO_SELECTION', selectionToken: videoSelection.selectionToken },
    ]);
  });

test('3 routes the accepted normalized region and selection token without showing a captured start toast',
  { timeout: 2000 }, async () => {
    const env = page();
    env.respond = (message) => message.type === 'PAGE_SHORTCUT'
      ? videoSelection : { ok: true, state: { status: 'recording', mode: 'video' } };
    env.selectRegion = async () => videoRegion;

    const { event, completion } = env.press('3');
    await completion;
    assert.ok(event.prevented && event.stopped);
    assert.deepEqual(env.selections, [{
      imageDataUrl: videoSelection.imageDataUrl,
      selectionToken: videoSelection.selectionToken,
    }]);
    assert.deepEqual(env.sent, [
      { target: 'background', type: 'PAGE_SHORTCUT', key: '3' },
      {
        target: 'background', type: 'VIDEO_REGION_SELECTED',
        selectionToken: videoSelection.selectionToken, region: videoRegion,
      },
    ]);
    assert.equal(env.toast(), '');
  });

test('4 dismisses an open region selector and sends cancellation through the pending 3 flow',
  { timeout: 2000 }, async () => {
    const env = page();
    const selectorEntered = deferred();
    const selected = deferred();
    env.respond = (message) => message.type === 'PAGE_SHORTCUT'
      ? videoSelection : { ok: true };
    env.selectRegion = () => { selectorEntered.resolve(); return selected.promise; };
    env.cancelRegion = () => selected.resolve(null);

    const start = env.press('3');
    await selectorEntered.promise;
    await env.press('4').completion;
    await start.completion;
    assert.equal(env.selectorCancels, 1);
    assert.deepEqual(env.sent, [
      { target: 'background', type: 'PAGE_SHORTCUT', key: '3' },
      { target: 'background', type: 'CANCEL_VIDEO_SELECTION', selectionToken: videoSelection.selectionToken },
    ]);
  });

test('dismissing region selection sends cancellation and releases shortcuts for the next selection',
  { timeout: 2000 }, async () => {
    const env = page();
    env.respond = (message) => message.type === 'PAGE_SHORTCUT'
      ? videoSelection : { ok: true };
    await env.press('3').completion;
    assert.deepEqual(env.sent.at(-1), {
      target: 'background', type: 'CANCEL_VIDEO_SELECTION', selectionToken: videoSelection.selectionToken,
    });

    env.selectRegion = async () => videoRegion;
    await env.press('3').completion;
    assert.equal(env.selections.length, 2);
    assert.equal(env.sent.at(-1).type, 'VIDEO_REGION_SELECTED');
  });

test('4 stops an established video recording with the normal page shortcut message', async () => {
  const env = page();
  env.respond = (message) => message.key === '3'
    ? videoSelection : { ok: true, state: { status: message.key === '4' ? 'ready' : 'recording', mode: 'video' } };
  env.selectRegion = async () => videoRegion;
  await env.press('3').completion;
  await env.press('4').completion;
  assert.deepEqual(env.sent.at(-1), { target: 'background', type: 'PAGE_SHORTCUT', key: '4' });
  assert.equal(env.selectorCancels, 0);
});

test('SHOW_VIDEO_SELECTOR uses the same token and region flow as pressing 3',
  { timeout: 2000 }, async () => {
    const env = page({ runtimeMessages: true });
    const regionSent = deferred();
    env.respond = (message) => {
      if (message.type === 'PAGE_SHORTCUT') return videoSelection;
      if (message.type === 'VIDEO_REGION_SELECTED') regionSent.resolve();
      return { ok: true, state: { status: 'recording', mode: 'video' } };
    };
    env.selectRegion = async () => videoRegion;
    env.install();
    assert.equal(env.messageListeners.size, 1);

    await env.message({ type: 'SHOW_VIDEO_SELECTOR' });
    assert.deepEqual(env.messageReplies, [{ ok: true }]);
    assert.deepEqual(env.sent, [], 'acknowledge the command before requesting BEGIN');
    await env.runTimers();
    await regionSent.promise;
    assert.deepEqual(env.sent, [
      { target: 'background', type: 'PAGE_SHORTCUT', key: '3' },
      {
        target: 'background', type: 'VIDEO_REGION_SELECTED',
        selectionToken: videoSelection.selectionToken, region: videoRegion,
      },
    ]);
    assert.equal(env.toast(), '');
  });

test('CANCEL_VIDEO_SELECTOR acknowledges immediately and dismisses active selection',
  { timeout: 2000 }, async () => {
    const env = page({ runtimeMessages: true });
    const selectorEntered = deferred();
    const selected = deferred();
    env.respond = (message) => message.type === 'PAGE_SHORTCUT'
      ? videoSelection : { ok: true };
    env.selectRegion = () => { selectorEntered.resolve(); return selected.promise; };
    env.cancelRegion = () => selected.resolve(null);

    const start = env.press('3');
    await selectorEntered.promise;
    await env.message({ type: 'CANCEL_VIDEO_SELECTOR' });
    assert.deepEqual(env.messageReplies, [{ ok: true, cancelled: true }]);
    await start.completion;
    assert.equal(env.selectorCancels, 1);
    assert.equal(env.sent.at(-1).type, 'CANCEL_VIDEO_SELECTION');
    assert.equal(env.sent.at(-1).selectionToken, videoSelection.selectionToken);
    assert.equal(env.sent.some((message) => message.type === 'VIDEO_REGION_SELECTED'), false);
    await env.message({ type: 'CANCEL_VIDEO_SELECTOR' });
    assert.deepEqual(env.messageReplies, [
      { ok: true, cancelled: true }, { ok: true, cancelled: false },
    ]);
  });

test('resizing while BEGIN is pending cancels the stale screenshot selection',
  { timeout: 2000 }, async () => {
    const env = page();
    const beginReply = deferred();
    env.respond = (message) => message.type === 'PAGE_SHORTCUT'
      ? beginReply.promise : { ok: true };
    const start = env.press('3');
    env.resize(800, 600);
    beginReply.resolve(videoSelection);
    await start.completion;
    assert.deepEqual(env.selections, []);
    assert.deepEqual(env.sent.at(-1), {
      target: 'background', type: 'CANCEL_VIDEO_SELECTION', selectionToken: videoSelection.selectionToken,
    });
  });

test('3 removes a previous audio toast before requesting the video screenshot', async () => {
  const env = page();
  await env.press('1').completion;
  assert.match(env.toast(), /녹음을 시작했어요/);
  env.respond = (message) => {
    if (message.key === '3') {
      assert.equal(env.toast(), '', 'the screenshot must not include an old recorder toast');
      return videoSelection;
    }
    return { ok: true };
  };
  env.selectRegion = async () => videoRegion;
  await env.press('3').completion;
  assert.equal(env.sent.at(-1).type, 'VIDEO_REGION_SELECTED');
  assert.equal(env.toast(), '');
});

test('4 during accepted-region startup stops as soon as recording starts',
  { timeout: 2000 }, async () => {
    const env = page();
    const regionSent = deferred();
    const started = deferred();
    env.respond = (message) => {
      if (message.key === '3') return videoSelection;
      if (message.type === 'VIDEO_REGION_SELECTED') {
        regionSent.resolve();
        return started.promise;
      }
      return { ok: true };
    };
    env.selectRegion = async () => videoRegion;
    const start = env.press('3');
    await regionSent.promise;
    await env.press('4').completion;
    await env.press('4').completion;
    assert.equal(env.sent.length, 2);
    started.resolve({ ok: true, state: { status: 'recording', mode: 'video' } });
    await start.completion;
    assert.deepEqual(env.sent.at(-1), { target: 'background', type: 'PAGE_SHORTCUT', key: '4' });
    assert.equal(env.sent.length, 3);
  });

test('background cancellation before the scheduled selector launch prevents BEGIN', async () => {
  const env = page({ runtimeMessages: true });
  env.respond = async () => videoSelection;
  await env.message({ type: 'SHOW_VIDEO_SELECTOR' });
  await env.message({ type: 'CANCEL_VIDEO_SELECTOR' });
  assert.deepEqual(env.messageReplies, [{ ok: true }, { ok: true, cancelled: true }]);
  await env.runTimers();
  assert.deepEqual(env.sent, []);
  assert.deepEqual(env.selections, []);
});

test('4 before the scheduled selector launch prevents a later BEGIN', async () => {
  const env = page({ runtimeMessages: true });
  env.respond = (message) => message.key === '3' ? videoSelection : { ok: true };
  await env.message({ type: 'SHOW_VIDEO_SELECTOR' });
  await env.press('4').completion;
  await env.runTimers();
  assert.equal(env.sent.some((message) => message.key === '3'), false);
  assert.deepEqual(env.selections, []);
});

for (const key of ['1', '2', '3']) {
  test(`failed ${key} during video recording keeps errors out of captured frames until 4 stops recording`, async () => {
    const env = page();
    // The video can have started via a browser command or popup; even the
    // first response observed here must suppress page UI while it is live.
    env.respond = (message) => message.key === '4'
      ? { ok: true, state: { mode: 'video', status: 'ready' } }
      : {
        ok: false,
        error: '화면 녹화가 진행 중입니다.',
        state: { mode: 'video', status: 'recording' },
      };

    await env.press(key).completion;
    assert.equal(env.toast(), '', 'an error toast would become part of the video');
    assert.deepEqual(env.sent, [{ target: 'background', type: 'PAGE_SHORTCUT', key }]);

    await env.press('4').completion;
    assert.match(env.toast(), /화면 녹화를 마쳤어요/);
    assert.deepEqual(env.sent.at(-1), { target: 'background', type: 'PAGE_SHORTCUT', key: '4' });
  });
}

function videoState(status, selectionToken = videoSelection.selectionToken) {
  return { mode: 'video', status, videoSessionToken: selectionToken };
}

function youtubeControls(env) {
  const controls = {
    activeToken: null, hidden: [], restored: [],
    async paint() {},
    async hide(token) {
      this.activeToken = token;
      this.hidden.push(token);
      await this.paint();
    },
    restore(token) {
      if (token && token !== this.activeToken) return false;
      this.restored.push(token);
      this.activeToken = null;
      return true;
    },
    refresh() {},
  };
  env.context.__withoutMikeYouTubeControls = controls;
  return controls;
}

test('audio-only recording and dismissed video selection leave YouTube controls untouched', async () => {
  const env = page();
  const controls = youtubeControls(env);
  env.respond = (message) => message.key === '3' ? videoSelection : { ok: true };
  await env.press('1').completion;
  await env.press('2').completion;
  await env.press('3').completion;
  assert.deepEqual(controls.hidden, []);
  assert.deepEqual(controls.restored, []);
});

test('video START waits for hidden controls to paint and stopping restores the same session', async () => {
  const env = page();
  const controls = youtubeControls(env);
  const hiding = deferred();
  const painted = deferred();
  controls.paint = () => { hiding.resolve(); return painted.promise; };
  env.selectRegion = async () => videoRegion;
  env.respond = (message) => message.key === '3' ? videoSelection
    : { ok: true, state: videoState(message.key === '4' ? 'ready' : 'recording') };
  const starting = env.press('3');
  await hiding.promise;
  assert.equal(controls.activeToken, videoSelection.selectionToken);
  assert.deepEqual(env.sent.map((message) => message.type), ['PAGE_SHORTCUT']);
  painted.resolve();
  await starting.completion;
  assert.deepEqual(env.sent.map((message) => message.type), ['PAGE_SHORTCUT', 'VIDEO_REGION_SELECTED']);
  assert.equal(controls.activeToken, videoSelection.selectionToken);
  await env.press('4').completion;
  assert.equal(controls.activeToken, null);
});

test('cancelling while controls paint restores them and never starts video capture', async () => {
  const env = page();
  const controls = youtubeControls(env);
  const hiding = deferred();
  const painted = deferred();
  controls.paint = () => { hiding.resolve(); return painted.promise; };
  env.selectRegion = async () => videoRegion;
  env.respond = (message) => message.key === '3' ? videoSelection : { ok: true };
  const starting = env.press('3');
  await hiding.promise;
  await env.press('4').completion;
  painted.resolve();
  await starting.completion;
  assert.equal(controls.activeToken, null);
  assert.deepEqual(env.sent.map((message) => message.type), ['PAGE_SHORTCUT', 'CANCEL_VIDEO_SELECTION']);
});

test('a failed video start restores controls even when the failure has no state', async () => {
  const env = page();
  const controls = youtubeControls(env);
  env.selectRegion = async () => videoRegion;
  env.respond = (message) => message.key === '3' ? videoSelection
    : message.type === 'VIDEO_REGION_SELECTED' ? { ok: false, error: 'capture failed' } : { ok: true };
  await env.press('3').completion;
  assert.equal(controls.activeToken, null);
  assert.match(env.toast(), /capture failed/);
});

test('background recording states retain hidden controls through stopping and restore them at completion', async () => {
  const env = page({ runtimeMessages: true });
  const controls = youtubeControls(env);
  for (const status of ['starting', 'recording', 'paused', 'stopping']) {
    await env.message({ type: 'RECORDING_STATE', state: videoState(status), sessionToken: videoSelection.selectionToken });
    assert.equal(controls.activeToken, videoSelection.selectionToken);
  }
  await env.message({ type: 'RECORDING_STATE', state: videoState('ready'), sessionToken: videoSelection.selectionToken });
  assert.equal(controls.activeToken, null);
  await env.message({ type: 'RECORDING_STATE', state: videoState('recording'), sessionToken: videoSelection.selectionToken });
  assert.equal(controls.activeToken, null, 'a late active snapshot must not hide a completed recording again');
});

test('stale video completion cannot restore a newer session and a scoped reset can restore it', async () => {
  const env = page({ runtimeMessages: true });
  const controls = youtubeControls(env);
  await env.message({ type: 'RECORDING_STATE', state: videoState('recording', 'old'), sessionToken: 'old' });
  await env.message({ type: 'RECORDING_STATE', state: videoState('ready', 'old'), sessionToken: 'old' });
  await env.message({ type: 'RECORDING_STATE', state: videoState('recording', 'new'), sessionToken: 'new' });
  await env.message({ type: 'RECORDING_STATE', state: videoState('ready', 'old'), sessionToken: 'old' });
  assert.equal(controls.activeToken, 'new');
  await env.message({ type: 'RECORDING_STATE', state: { status: 'idle', mode: 'audio' }, sessionToken: 'new' });
  assert.equal(controls.activeToken, null);
});

for (const reason of ['pagehide', 'disconnect']) {
  test(`${reason} restores YouTube controls for a running page recording`, async () => {
    const env = page();
    const controls = youtubeControls(env);
    env.selectRegion = async () => videoRegion;
    env.respond = (message) => message.key === '3' ? videoSelection : { ok: true, state: videoState('recording') };
    await env.press('3').completion;
    assert.equal(controls.activeToken, videoSelection.selectionToken);
    if (reason === 'pagehide') await env.windowEvent('pagehide');
    else env.context.__withoutMikePageShortcuts.dispose();
    assert.equal(controls.activeToken, null);
  });
}

function watcherCount(env, type) {
  return env.windowListeners.get(type)?.size || 0;
}

function settleCallbacks() {
  return new Promise((resolve) => setImmediate(resolve));
}

test('a real viewport resize reports its session token once while same-size resize events are ignored',
  { timeout: 2000 }, async () => {
    const env = page();
    const changedReply = deferred();
    env.respond = (message) => {
      if (message.key === '3') return videoSelection;
      if (message.type === 'VIDEO_VIEWPORT_CHANGED') return changedReply.promise;
      return { ok: true, state: videoState('recording') };
    };
    env.selectRegion = async () => videoRegion;
    await env.press('3').completion;
    assert.equal(watcherCount(env, 'resize'), 1);
    assert.equal(watcherCount(env, 'pagehide'), 1);
    const retainedResize = [...env.windowListeners.get('resize')][0];

    await env.windowEvent('resize');
    assert.equal(env.sent.some((message) => message.type === 'VIDEO_VIEWPORT_CHANGED'), false);

    env.resize(1100, 800);
    const resizing = env.windowEvent('resize');
    await env.windowEvent('resize');
    await retainedResize({ type: 'resize' });
    assert.deepEqual(env.sent.filter((message) => message.type === 'VIDEO_VIEWPORT_CHANGED'), [{
      target: 'background', type: 'VIDEO_VIEWPORT_CHANGED', selectionToken: videoSelection.selectionToken,
    }]);

    changedReply.resolve({ ok: true, state: videoState('ready', null) });
    await resizing;
    await settleCallbacks();
    assert.equal(watcherCount(env, 'resize'), 0);
    assert.equal(watcherCount(env, 'pagehide'), 0);
  });

test('resize protection is installed before START replies and queues a stop after that start succeeds',
  { timeout: 2000 }, async () => {
    const env = page();
    const startEntered = deferred();
    const started = deferred();
    env.respond = (message) => {
      if (message.key === '3') return videoSelection;
      if (message.type === 'VIDEO_REGION_SELECTED') {
        startEntered.resolve();
        return started.promise;
      }
      if (message.type === 'VIDEO_VIEWPORT_CHANGED') return { ok: true, state: videoState('starting') };
      return { ok: true, state: videoState('ready', null) };
    };
    env.selectRegion = async () => videoRegion;
    const start = env.press('3');
    await startEntered.promise;
    assert.equal(watcherCount(env, 'resize'), 1);
    env.resize(1000, 700);
    await env.windowEvent('resize');
    await env.windowEvent('resize');
    assert.equal(env.sent.filter((message) => message.type === 'VIDEO_VIEWPORT_CHANGED').length, 1);
    assert.deepEqual(env.sent.at(-1), {
      target: 'background', type: 'VIDEO_VIEWPORT_CHANGED', selectionToken: videoSelection.selectionToken,
    });
    assert.equal(env.sent.some((message) => message.key === '4'), false);

    started.resolve({ ok: true, state: videoState('recording') });
    await start.completion;
    assert.deepEqual(env.sent.at(-1), { target: 'background', type: 'PAGE_SHORTCUT', key: '4' });
    assert.equal(watcherCount(env, 'resize'), 0);
    assert.equal(watcherCount(env, 'pagehide'), 0);
  });

test('old viewport callbacks and a delayed old stop reply cannot remove a newer session watcher',
  { timeout: 2000 }, async () => {
    const env = page();
    const oldToken = videoSelection.selectionToken;
    const newToken = 'selection-next-token';
    const oldChangedReply = deferred();
    let currentToken = oldToken;
    let currentRegion = videoRegion;
    env.respond = (message) => {
      if (message.key === '3') return { ...videoSelection, selectionToken: currentToken };
      if (message.type === 'VIDEO_VIEWPORT_CHANGED' && message.selectionToken === oldToken) {
        return oldChangedReply.promise;
      }
      if (message.key === '4' || message.type === 'VIDEO_VIEWPORT_CHANGED') {
        return { ok: true, state: videoState('ready', null) };
      }
      return { ok: true, state: videoState('recording', currentToken) };
    };
    env.selectRegion = async () => currentRegion;
    await env.press('3').completion;
    const oldResize = [...(env.windowListeners.get('resize') || [])][0];
    const oldPagehide = [...(env.windowListeners.get('pagehide') || [])][0];
    assert.equal(typeof oldResize, 'function');
    env.resize(1100, 800);
    const oldResizeCompletion = env.windowEvent('resize');
    await env.press('4').completion;
    currentToken = newToken;
    currentRegion = { ...videoRegion, viewportWidth: 1100 };
    await env.press('3').completion;
    assert.equal(watcherCount(env, 'resize'), 1);
    assert.equal(watcherCount(env, 'pagehide'), 1);
    const newResize = [...env.windowListeners.get('resize')][0];

    const sentBeforeStaleCallbacks = env.sent.length;
    await oldResize({ type: 'resize' });
    await oldPagehide({ type: 'pagehide' });
    assert.equal(env.sent.length, sentBeforeStaleCallbacks);
    oldChangedReply.resolve({ ok: true, state: videoState('ready', null) });
    await oldResizeCompletion;
    await settleCallbacks();
    assert.equal(watcherCount(env, 'resize'), 1);
    assert.equal(watcherCount(env, 'pagehide'), 1);
    assert.ok(env.windowListeners.get('resize').has(newResize));

    env.resize(1200, 800);
    await env.windowEvent('resize');
    await settleCallbacks();
    assert.deepEqual(env.sent.filter((message) => message.type === 'VIDEO_VIEWPORT_CHANGED').map((message) => (
      message.selectionToken
    )), [oldToken, newToken]);
  });

test('failed video startup removes viewport watchers and makes retained callbacks inert', async () => {
  const env = page();
  let failedResize;
  let failedPagehide;
  env.respond = (message) => {
    if (message.key === '3') return videoSelection;
    if (message.type === 'VIDEO_REGION_SELECTED') {
      [failedResize] = env.windowListeners.get('resize') || [];
      [failedPagehide] = env.windowListeners.get('pagehide') || [];
      return { ok: false, error: '화면 녹화를 시작하지 못했어요.', state: videoState('error', null) };
    }
    return { ok: true, state: videoState('idle', null) };
  };
  env.selectRegion = async () => videoRegion;
  await env.press('3').completion;
  assert.equal(typeof failedResize, 'function');
  assert.equal(typeof failedPagehide, 'function');
  assert.equal(watcherCount(env, 'resize'), 0);
  assert.equal(watcherCount(env, 'pagehide'), 0);
  const sentAfterFailure = env.sent.length;
  env.resize(800, 600);
  await failedResize({ type: 'resize' });
  await failedPagehide({ type: 'pagehide' });
  assert.equal(env.sent.length, sentAfterFailure);
});

for (const cleanup of ['stop', 'pagehide', 'disconnect']) {
  test(`${cleanup} releases active video viewport watchers`, async () => {
    const env = page({ runtimeMessages: true });
    env.respond = (message) => {
      if (message.key === '3') return videoSelection;
      if (message.key === '4') return { ok: true, state: videoState('ready', null) };
      return { ok: true, state: videoState('recording') };
    };
    env.selectRegion = async () => videoRegion;
    await env.press('3').completion;
    assert.equal(watcherCount(env, 'resize'), 1);
    assert.equal(watcherCount(env, 'pagehide'), 1);
    if (cleanup === 'stop') await env.press('4').completion;
    if (cleanup === 'pagehide') {
      const retainedPagehide = [...env.windowListeners.get('pagehide')][0];
      await env.windowEvent('pagehide');
      await env.windowEvent('pagehide');
      await retainedPagehide({ type: 'pagehide' });
      assert.deepEqual(env.sent.filter((message) => message.type === 'VIDEO_VIEWPORT_CHANGED'), [{
        target: 'background', type: 'VIDEO_VIEWPORT_CHANGED', selectionToken: videoSelection.selectionToken,
      }], 'pagehide reports the session exactly once even when its viewport size has not changed');
    }
    if (cleanup === 'disconnect') {
      env.respond = async () => { throw new Error('Extension context invalidated.'); };
      await env.press('1').completion;
      assert.equal(env.listeners.size, 0);
      assert.equal(env.messageListeners.size, 0);
    }
    assert.equal(watcherCount(env, 'resize'), 0);
    assert.equal(watcherCount(env, 'pagehide'), 0);
  });
}

for (const scenario of [
  ...['stopping', 'ready', 'error'].map((status) => ({
    name: `already ${status} in the same video session`, state: videoState(status), benign: true,
  })),
  {
    name: 'ready in a different video session',
    state: videoState('ready', 'another-selection-token'), foreignSession: true,
  },
  {
    name: 'ready in audio mode',
    state: { ...videoState('ready'), mode: 'audio' },
  },
]) {
  test(`queued resize stop handles a failed 4 response ${scenario.name}`, { timeout: 2000 }, async () => {
    const env = page();
    const startEntered = deferred();
    const started = deferred();
    env.respond = (message) => {
      if (message.key === '3') return videoSelection;
      if (message.type === 'VIDEO_REGION_SELECTED') {
        startEntered.resolve();
        return started.promise;
      }
      if (message.type === 'VIDEO_VIEWPORT_CHANGED') return { ok: true, state: videoState('starting') };
      if (message.key === '4') return { ok: false, error: 'no recording', state: scenario.state };
      return { ok: true };
    };
    env.selectRegion = async () => videoRegion;
    const start = env.press('3');
    await startEntered.promise;
    env.resize(1000, 700);
    await env.windowEvent('resize');
    started.resolve({ ok: true, state: videoState('recording') });
    await start.completion;
    assert.deepEqual(env.sent.at(-1), { target: 'background', type: 'PAGE_SHORTCUT', key: '4' });
    assert.equal(env.sent.filter((message) => message.type === 'VIDEO_VIEWPORT_CHANGED').length, 1);

    if (scenario.benign) {
      assert.doesNotMatch(env.toast(), /no recording/);
      if (scenario.state.status === 'stopping') assert.equal(env.toast(), '');
    } else if (scenario.foreignSession) {
      // The foreign reply cannot confirm this session stopped, so preserve its
      // watcher and keep error/success page UI out of a potentially live video.
      assert.equal(watcherCount(env, 'resize'), 1);
      assert.equal(watcherCount(env, 'pagehide'), 1);
      assert.equal(env.toast(), '');
    } else {
      assert.equal(env.toast(), 'no recording');
    }
  });
}
