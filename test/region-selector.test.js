import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const source = await readFile(new URL('../extension/region-selector.js', import.meta.url), 'utf8');

function page() {
  const listeners = new Map();
  const frames = [];
  const dialogs = [];
  let focusRestored = 0;
  function element(tagName) {
    const node = {
      tagName, style: {}, children: [], open: false, isConnected: false,
      setAttribute() {}, addEventListener() {},
      append(...children) { this.children.push(...children); children.forEach((child) => { child.isConnected = true; }); },
      attachShadow() {
        // A real HTMLDialogElement cannot be a shadow host.
        if (tagName === 'dialog') throw new Error('NotSupportedError');
        this.shadow = element('shadow');
        return this.shadow;
      },
      showModal() { this.open = true; }, close() { this.open = false; },
      focus() {}, remove() { this.isConnected = false; },
      setPointerCapture() {}, releasePointerCapture() {},
    };
    if (tagName === 'dialog') dialogs.push(node);
    return node;
  }
  const body = element('body');
  const window = {
    innerWidth: 1000, innerHeight: 800, scrollX: 0, scrollY: 120,
    addEventListener(type, callback) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(callback);
    },
    removeEventListener(type, callback) { listeners.get(type)?.delete(callback); },
    requestAnimationFrame(callback) { frames.push(callback); },
    scrollTo(x, y) { this.scrollX = x; this.scrollY = y; },
  };
  const context = vm.createContext({
    window,
    document: {
      body, documentElement: body, visibilityState: 'visible',
      activeElement: { focus() { focusRestored += 1; } },
      createElement: element,
    },
  });
  vm.runInContext(source, context);
  return {
    window, dialogs, frames, context,
    begin: () => context.__withoutMikeSelectRegion({
      imageDataUrl: 'data:image/png;base64,c25hcHNob3Q=', selectionToken: 'selection-1',
    }),
    dispatch(type, overrides = {}) {
      const event = {
        isTrusted: true, button: 0, isPrimary: true, pointerId: 1, cancelable: true,
        preventDefault() { this.prevented = true; },
        stopImmediatePropagation() { this.stopped = true; },
        ...overrides,
      };
      for (const listener of [...(listeners.get(type) || [])]) listener(event);
      return event;
    },
    frame() { frames.shift()?.(); },
    listenerCount: () => [...listeners.values()].reduce((sum, set) => sum + set.size, 0),
    focusRestored: () => focusRestored,
  };
}

test('reverse dragging returns viewport-normalized coordinates only after removing the overlay and two frames', async () => {
  const env = page();
  let resolved = false;
  const result = env.begin().then((region) => { resolved = true; return region; });
  assert.equal(env.dialogs[0].open, true);
  env.dispatch('pointerdown', { clientX: 800, clientY: 600 });
  env.dispatch('pointermove', { clientX: 200, clientY: 100 });
  env.dispatch('pointerup', { clientX: 200, clientY: 100 });
  assert.equal(env.dialogs[0].isConnected, false);
  assert.equal(env.listenerCount(), 0);
  await Promise.resolve();
  assert.equal(resolved, false);
  env.frame();
  await Promise.resolve();
  assert.equal(resolved, false);
  env.frame();
  assert.deepEqual(structuredClone(await result), {
    x: 0.2, y: 0.125, width: 0.6, height: 0.625, viewportWidth: 1000, viewportHeight: 800,
  });
  assert.equal(env.focusRestored(), 1);
});

test('tiny regions stay open for another drag and coordinates are clamped to the viewport', async () => {
  const env = page();
  const result = env.begin();
  env.dispatch('pointerdown', { clientX: 10, clientY: 10 });
  env.dispatch('pointerup', { clientX: 15, clientY: 15 });
  assert.equal(env.dialogs[0].open, true);
  assert.equal(env.frames.length, 0);
  env.dispatch('pointerdown', { clientX: -40, clientY: -30 });
  env.dispatch('pointerup', { clientX: 1400, clientY: 900 });
  env.frame();
  env.frame();
  assert.deepEqual(structuredClone(await result), {
    x: 0, y: 0, width: 1, height: 1, viewportWidth: 1000, viewportHeight: 800,
  });
});

test('Escape, 4, resize, scrolling, and navigation cancel with complete cleanup', async (t) => {
  for (const [type, details] of [
    ['keydown', { key: 'Escape' }], ['keydown', { key: '4' }],
    ['resize', {}], ['scroll', {}], ['pagehide', {}], ['popstate', {}],
  ]) {
    await t.test(`${type} ${details.key || ''}`, async () => {
      const env = page();
      const result = env.begin();
      env.window.scrollY = 200;
      env.dispatch(type, details);
      assert.equal(await result, null);
      assert.equal(env.listenerCount(), 0);
      assert.equal(env.dialogs[0].isConnected, false);
      assert.equal(env.window.scrollY, 120);
      assert.equal(env.focusRestored(), 1);
    });
  }
});

test('external cancellation resolves the selection and untrusted events cannot confirm it', async () => {
  const env = page();
  const result = env.begin();
  env.dispatch('pointerdown', { clientX: 10, clientY: 10, isTrusted: false });
  env.dispatch('pointerup', { clientX: 500, clientY: 500, isTrusted: false });
  assert.equal(env.dialogs[0].open, true);
  env.context.__withoutMikeCancelRegion();
  assert.equal(await result, null);
  assert.equal(env.listenerCount(), 0);
});
