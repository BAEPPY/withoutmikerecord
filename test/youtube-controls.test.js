import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const source = await readFile(new URL('../extension/youtube-controls.js', import.meta.url), 'utf8');

function eventTarget(target = {}) {
  const listeners = new Map();
  return Object.assign(target, {
    listeners,
    addEventListener(type, callback) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(callback);
    },
    removeEventListener(type, callback) { listeners.get(type)?.delete(callback); },
    dispatch(type, detail = {}) {
      const event = { type, ...detail };
      for (const callback of [...(listeners.get(type) || [])]) callback(event);
      return event;
    },
  });
}

function descendants(node) {
  return node.children.flatMap((child) => [child, ...descendants(child)]);
}

function node(tagName, attributes = {}) {
  const element = eventTarget({
    tagName: tagName.toUpperCase(), nodeType: 1, children: [], style: {}, textContent: '', parentNode: null,
    get isConnected() { return this.rootConnected || Boolean(this.parentNode?.isConnected); },
    get id() { return attributes.id || ''; },
    set id(value) { attributes.id = value; },
    setAttribute(name, value) { attributes[name] = String(value); },
    getAttribute(name) { return attributes[name] ?? null; },
    removeAttribute(name) { delete attributes[name]; },
    appendChild(child) {
      child.remove();
      this.children.push(child);
      child.parentNode = this;
      return child;
    },
    append(...children) { children.forEach((child) => this.appendChild(child)); },
    remove() {
      if (this.parentNode) this.parentNode.children = this.parentNode.children.filter((child) => child !== this);
      this.parentNode = null;
    },
    querySelectorAll(selector) {
      const tags = selector.split(',').map((part) => part.trim().toUpperCase());
      return descendants(this).filter((child) => tags.includes(child.tagName));
    },
  });
  return element;
}

function browserDocument(href, parentWindow = null) {
  const location = new URL(href);
  const html = node('html');
  html.rootConnected = true;
  const head = node('head');
  const body = node('body');
  html.append(head, body);
  const document = eventTarget({
    location, URL: href, documentURI: href, baseURI: href, documentElement: html, head, body,
    createElement(tagName) {
      const element = node(tagName);
      element.ownerDocument = document;
      return element;
    },
    querySelectorAll(selector) { return html.querySelectorAll(selector); },
    getElementById(id) { return descendants(html).find((element) => element.id === id) || null; },
  });
  const window = eventTarget({ document, location });
  window.self = window;
  window.parent = parentWindow || window;
  window.top = parentWindow?.top || window;
  document.defaultView = window;
  return { window, document };
}

function page(href = 'https://www.youtube.com/watch?v=test') {
  const top = browserDocument(href);
  const animationFrames = new Map();
  const intervals = new Map();
  let nextId = 0;
  const requestAnimationFrame = (callback) => {
    const id = ++nextId;
    animationFrames.set(id, callback);
    return id;
  };
  const cancelAnimationFrame = (id) => animationFrames.delete(id);
  const setInterval = (callback, delay) => { const id = ++nextId; intervals.set(id, { callback, delay }); return id; };
  const clearInterval = (id) => intervals.delete(id);
  Object.assign(top.window, { requestAnimationFrame, cancelAnimationFrame, setInterval, clearInterval });
  const runtime = { id: 'test-extension', getManifest: () => ({ version: 'test' }) };
  const context = vm.createContext({
    window: top.window, document: top.document, location: top.window.location, URL,
    requestAnimationFrame, cancelAnimationFrame, setInterval, clearInterval,
    chrome: { runtime },
  });
  const env = {
    ...top, context, runtime, animationFrames, intervals,
    get controls() { return context.__withoutMikeYouTubeControls; },
    inject() { vm.runInContext(source, context); },
    styles(document = top.document) { return document.querySelectorAll('style'); },
    frame() {
      const callbacks = [...animationFrames.values()];
      animationFrames.clear();
      for (const callback of callbacks) callback(0);
    },
    async painted(promise) {
      for (let count = 0; count < 6; count += 1) {
        env.frame();
        await Promise.resolve();
      }
      return promise;
    },
    async tick() {
      for (const { callback } of [...intervals.values()]) callback();
      await Promise.resolve();
    },
    addFrame(parentDocument = top.document, childHref = href, { crossOrigin = false } = {}) {
      const child = browserDocument(childHref, parentDocument.defaultView);
      const frame = parentDocument.createElement('iframe');
      frame.contentWindow = child.window;
      frame.contentDocument = child.document;
      if (crossOrigin) {
        Object.defineProperty(frame, 'contentDocument', { get() { throw new Error('Cross-origin access denied'); } });
        Object.defineProperty(child.window, 'document', { get() { throw new Error('Cross-origin access denied'); } });
        Object.defineProperty(child.window, 'location', { get() { throw new Error('Cross-origin access denied'); } });
      }
      parentDocument.body.append(frame);
      return { frame, ...child };
    },
  };
  env.inject();
  return env;
}

test('hiding YouTube controls waits two painted frames and changes only narrow player UI opacity',
  { timeout: 2000 }, async () => {
    const env = page();
    let completed = false;
    const hiding = env.controls.hide('video-1').then((result) => { completed = true; return result; });
    assert.equal(env.styles().length, 1);
    const css = env.styles()[0].textContent.replace(/\/\*[\s\S]*?\*\//g, '');
    const rules = [...css.matchAll(/([^{}]+)\{([^{}]+)\}/g)];
    assert.ok(rules.length > 0);
    const selectors = rules.flatMap(([, selectorList]) => selectorList.split(',').map((selector) => selector.trim()));
    for (const selector of selectors) {
      assert.match(selector, /^\.html5-video-player\s+\.ytp-[a-z-]+$/);
      assert.doesNotMatch(selector, /caption|subtitle|video-stream|html5-main-video/);
    }
    for (const name of ['chrome-top', 'chrome-bottom', 'gradient-top', 'gradient-bottom', 'large-play-button', 'bezel', 'tooltip']) {
      assert.ok(selectors.includes(`.html5-video-player .ytp-${name}`), `missing ${name} overlay`);
    }
    for (const [, , declarations] of rules) {
      assert.match(declarations, /opacity\s*:\s*0\s*!important/);
      assert.match(declarations, /transition\s*:\s*none\s*!important/);
      assert.doesNotMatch(declarations, /display\s*:|visibility\s*:|pointer-events\s*:/);
    }
    for (const target of [env.window, env.document]) {
      for (const type of ['keydown', 'keyup', 'click', 'mousedown', 'mousemove', 'pointerdown', 'pointermove']) {
        assert.equal(target.listeners.get(type)?.size || 0, 0, `${type} must remain native`);
      }
    }
    await Promise.resolve();
    assert.equal(completed, false);
    env.frame();
    await Promise.resolve();
    assert.equal(completed, false);
    env.frame();
    assert.equal(await hiding, true);
  });

test('only real YouTube hostnames receive recording styles', { timeout: 2000 }, async () => {
  for (const hostname of [
    'youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com',
    'youtube-nocookie.com', 'www.youtube-nocookie.com',
  ]) {
    const env = page(`https://${hostname}/watch?v=test`);
    assert.equal(await env.painted(env.controls.hide('allowed')), true, hostname);
    assert.equal(env.styles().length, 1, hostname);
    env.controls.dispose();
  }
  for (const hostname of [
    'example.com', 'notyoutube.com', 'fake-youtube.com', 'youtube.com.evil.test',
    'youtube-nocookie.com.evil.test', 'youtu.be',
  ]) {
    const env = page(`https://${hostname}/watch?v=test`);
    assert.equal(await env.painted(env.controls.hide('blocked')), false, hostname);
    assert.equal(env.styles().length, 0, hostname);
    assert.equal(env.intervals.size, 0, hostname);
  }
});

test('repeated hiding shares one stylesheet and one paint wait while replacement players inherit it',
  { timeout: 2000 }, async () => {
    const env = page();
    const first = env.controls.hide('video-1');
    const second = env.controls.hide('video-1');
    assert.equal(env.styles().length, 1);
    assert.equal(env.animationFrames.size, 1);
    assert.equal(env.intervals.size, 1);
    assert.equal([...env.intervals.values()][0].delay, 1000);
    const stylesheet = env.styles()[0];
    const player = env.document.createElement('div');
    player.setAttribute('class', 'html5-video-player');
    env.document.body.append(player);
    env.controls.refresh();
    player.remove();
    const replacement = env.document.createElement('div');
    replacement.setAttribute('class', 'html5-video-player');
    env.document.body.append(replacement);
    env.controls.refresh();
    assert.deepEqual(env.styles(), [stylesheet]);
    await env.painted(first);
    assert.equal(await first, true);
    assert.equal(await second, true);
  });

test('token-scoped restore ignores an old session and cancels its unfinished paint wait',
  { timeout: 2000 }, async () => {
    const env = page();
    const oldHide = env.controls.hide('old-session');
    const currentHide = env.controls.hide('current-session');
    assert.equal(env.controls.restore('old-session'), false);
    assert.equal(env.styles().length, 1);
    await env.painted(currentHide);
    assert.equal(await oldHide, false);
    assert.equal(await currentHide, true);
    assert.equal(env.controls.restore('old-session'), false);
    assert.equal(env.styles().length, 1);
    assert.equal(env.controls.restore('current-session'), true);
    assert.equal(env.styles().length, 0);
    assert.equal(env.intervals.size, 0);
    assert.equal(env.controls.restore('current-session'), false);
    assert.equal(await env.painted(env.controls.hide('force-restored-session')), true);
    assert.equal(env.controls.restore(), true);
    assert.equal(env.styles().length, 0);
  });

test('same-origin nested and inherited-origin frames hide controls while foreign frames remain inaccessible',
  { timeout: 2000 }, async () => {
    const env = page();
    const child = env.addFrame();
    const nested = env.addFrame(child.document);
    const blank = env.addFrame(env.document, 'about:blank');
    const srcdoc = env.addFrame(env.document, 'about:srcdoc');
    const foreign = env.addFrame(env.document, 'https://example.com/embed', { crossOrigin: true });
    assert.equal(await env.painted(env.controls.hide('video-1')), true);
    for (const document of [env.document, child.document, nested.document, blank.document, srcdoc.document]) {
      assert.equal(env.styles(document).length, 1);
    }
    assert.equal(env.styles(foreign.document).length, 0);
    env.controls.restore('video-1');
    for (const document of [env.document, child.document, nested.document, blank.document, srcdoc.document]) {
      assert.equal(env.styles(document).length, 0);
    }
  });

test('refresh applies styles to new frame documents and cleans up removed frame documents',
  { timeout: 2000 }, async () => {
    const env = page();
    await env.painted(env.controls.hide('video-1'));
    const added = env.addFrame();
    env.controls.refresh();
    assert.equal(env.styles(added.document).length, 1);
    const replacement = browserDocument('https://www.youtube.com/embed/next', env.window);
    added.frame.contentWindow = replacement.window;
    added.frame.contentDocument = replacement.document;
    env.controls.refresh();
    assert.equal(env.styles(added.document).length, 0);
    assert.equal(env.styles(replacement.document).length, 1);
    added.frame.remove();
    env.controls.refresh();
    assert.equal(env.styles(replacement.document).length, 0);
    assert.equal(env.styles().length, 1);
  });

test('pagehide restores top and child controls and releases the liveness interval',
  { timeout: 2000 }, async () => {
    const env = page();
    const child = env.addFrame();
    await env.painted(env.controls.hide('video-1'));
    env.window.dispatch('pagehide');
    assert.equal(env.styles().length, 0);
    assert.equal(env.styles(child.document).length, 0);
    assert.equal(env.intervals.size, 0);
    assert.equal(env.controls.restore('video-1'), false);
  });

for (const invalidation of ['invalid API', 'missing runtime id']) {
  test(`${invalidation} restores controls even without a recording-state push`,
    { timeout: 2000 }, async () => {
      const env = page();
      await env.painted(env.controls.hide('video-1'));
      if (invalidation === 'invalid API') {
        env.runtime.getManifest = () => { throw new Error('Extension context invalidated.'); };
      } else {
        delete env.runtime.id;
      }
      await env.tick();
      assert.equal(env.styles().length, 0);
      assert.equal(env.intervals.size, 0);
    });
}

test('live reinjection preserves the hidden style and session without a visible reset',
  { timeout: 2000 }, async () => {
    const env = page();
    const controls = env.controls;
    await env.painted(controls.hide('video-1'));
    const stylesheet = env.styles()[0];
    let removals = 0;
    const removeStyle = stylesheet.remove;
    stylesheet.remove = function remove() { removals += 1; return removeStyle.call(this); };
    assert.equal(controls.version, 1);
    assert.equal(controls.isAlive(), true);
    env.inject();
    assert.equal(env.controls, controls);
    assert.deepEqual(env.styles(), [stylesheet]);
    assert.equal(removals, 0, 'even removing and reattaching the same style could expose controls to capture');
    assert.equal(env.intervals.size, 1);
    assert.equal(env.animationFrames.size, 0);
    assert.equal(env.window.listeners.get('pagehide')?.size, 1);
    assert.equal(env.controls.restore('video-1'), true);
  });

test('stale reinjection disposes the old style and makes old callbacks unable to restore it',
  { timeout: 2000 }, async () => {
    const env = page();
    const oldControls = env.controls;
    const pending = oldControls.hide('old-session');
    oldControls.isAlive = () => false;
    env.inject();
    const currentControls = env.controls;
    assert.notEqual(currentControls, oldControls);
    assert.equal(env.styles().length, 0);
    assert.equal(env.intervals.size, 0);
    const next = env.controls.hide('new-session');
    await env.painted(next);
    assert.equal(await pending, false);
    assert.equal(await next, true);
    assert.equal(oldControls.restore('old-session'), false);
    oldControls.dispose();
    assert.equal(env.styles().length, 1);
    currentControls.dispose();
    currentControls.dispose();
    assert.equal(env.styles().length, 0);
    assert.equal(env.intervals.size, 0);
    assert.equal(env.window.listeners.get('pagehide')?.size || 0, 0);
  });
