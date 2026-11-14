import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const script = await readFile(new URL('../extension/gif-clipboard.js', import.meta.url), 'utf8');
const gif = (version = 'GIF89a') => new Blob([version, new Uint8Array([2, 0, 2, 0, 0, 0, 0]), 'animated-frames'], { type: 'image/gif' });

function harness(options = {}) {
  const writes = [], readers = [], timeouts = new Set();
  class Item {
    static supports(type) { return (options.supported ?? ['text/html', 'web image/gif']).includes(type); }
    constructor(values) { this.values = values; this.types = Object.keys(values); }
  }
  if (options.legacy) delete Item.supports;
  class Reader {
    static LOADING = 1;
    readyState = 0;
    constructor() { readers.push(this); }
    readAsDataURL(blob) {
      this.readyState = 1;
      if (options.readThrows) throw new Error('read throw');
      if (options.readHang) return;
      queueMicrotask(async () => {
        this.readyState = 2;
        if (options.readError) { this.onerror?.(); return; }
        if (options.readAbort) { this.onabort?.(); return; }
        this.result = options.badDataUrl ? 'not a data URL' : `data:image/gif;base64,${Buffer.from(await blob.arrayBuffer()).toString('base64')}`;
        this.onload?.();
      });
    }
    abort() { this.aborted = true; this.readyState = 2; this.onabort?.(); }
  }
  const context = vm.createContext({
    Blob, Uint8Array, FileReader: Reader, ClipboardItem: options.noItem ? undefined : Item,
    document: { hasFocus: () => options.focused !== false },
    navigator: { clipboard: options.noClipboard ? undefined : {
      write: async (items) => {
        if (options.writeError) throw options.writeError;
        writes.push(items);
      },
    } },
    setTimeout: (callback) => { timeouts.add(callback); return callback; },
    clearTimeout: (callback) => timeouts.delete(callback),
  });
  vm.runInContext(script, context);
  return { copy: context.__withoutMikeCopyGif, writes, readers, timeouts,
    timeout: () => { for (const callback of [...timeouts]) callback(); },
  };
}

function assertReaderCleanup(h) {
  assert.equal(h.timeouts.size, 0);
  for (const reader of h.readers) {
    assert.equal(reader.onload, null);
    assert.equal(reader.onerror, null);
    assert.equal(reader.onabort, null);
  }
}

test('native GIF support writes the original animated bytes without conversion', async () => {
  const h = harness({ supported: ['image/gif', 'text/html', 'web image/gif'] });
  const blob = gif();
  assert.equal((await h.copy(blob)).mode, 'native-gif');
  assert.deepEqual(h.writes[0][0].types, ['image/gif']);
  assert.equal(h.writes[0][0].values['image/gif'], blob);
  assert.equal(h.readers.length, 0);
});

test('HTML fallback embeds the complete GIF and adds raw web GIF when supported', async () => {
  const h = harness();
  const blob = gif();
  assert.equal((await h.copy(blob)).mode, 'html-gif');
  const item = h.writes[0][0];
  assert.deepEqual(item.types, ['text/html', 'web image/gif']);
  assert.equal(item.values['web image/gif'], blob);
  const html = await item.values['text/html'].text();
  const encoded = html.match(/src="data:image\/gif;base64,([^"]+)"/)[1];
  assert.deepEqual(Buffer.from(encoded, 'base64'), Buffer.from(await blob.arrayBuffer()));
  assert.doesNotMatch(html, /https?:|image\/png/);
  assert.equal(item.values['text/plain'], undefined);
  assertReaderCleanup(h);
});

test('HTML-only and older ClipboardItem implementations preserve GIF87a without static fallback', async () => {
  for (const options of [{ supported: ['text/html'] }, { legacy: true }]) {
    const h = harness(options);
    assert.equal((await h.copy(gif('GIF87a'))).mode, 'html-gif');
    assert.deepEqual(h.writes[0][0].types, ['text/html']);
    assert.match(await h.writes[0][0].values['text/html'].text(), /data:image\/gif;base64/);
    assertReaderCleanup(h);
  }
});

test('invalid signatures, types and oversized files fail before reading or writing clipboard data', async () => {
  const oversized = gif();
  Object.defineProperty(oversized, 'size', { value: 16 * 1024 * 1024 + 1 });
  for (const blob of [null, new Blob(['GIF89a']), gif('NOTGIF'), new Blob(['GIF89a'], { type: 'image/gif' }), oversized]) {
    const h = harness();
    await assert.rejects(h.copy(blob), blob === oversized ? /16 MiB/ : /GIF/);
    assert.equal(h.writes.length, 0);
    assert.equal(h.readers.length, 0);
  }
});

test('unsupported APIs and unfocused windows explain how to save or retry', async () => {
  for (const options of [{ noClipboard: true }, { noItem: true }, { supported: [] }, { focused: false }]) {
    const h = harness(options);
    await assert.rejects(h.copy(gif()), options.focused === false ? /초점/ : /지원하지/);
    assert.equal(h.writes.length, 0);
  }
});

test('permission denial and unsupported clipboard writes expose Korean actionable errors', async () => {
  for (const [name, pattern] of [['NotAllowedError', /허용되지/], ['SecurityError', /허용되지/], ['NotSupportedError', /지원하지/], ['TypeError', /지원하지/], ['UnknownError', /파일로 저장/]]) {
    const error = new Error('native clipboard failed'); error.name = name;
    const h = harness({ writeError: error });
    await assert.rejects(h.copy(gif()), pattern);
    assertReaderCleanup(h);
  }
});

test('FileReader success, failures, abort and timeout always remove handlers and timers', async () => {
  for (const options of [{ readError: true }, { readAbort: true }, { badDataUrl: true }, { readThrows: true }]) {
    const h = harness(options);
    await assert.rejects(h.copy(gif()));
    assertReaderCleanup(h);
    assert.equal(h.writes.length, 0);
  }
  const h = harness({ readHang: true });
  const pending = h.copy(gif());
  // Header reading is asynchronous; wait for the reader to have started.
  while (!h.readers.length) await new Promise((resolve) => setImmediate(resolve));
  h.timeout();
  await assert.rejects(pending, /초과/);
  assert.equal(h.readers[0].aborted, true);
  assertReaderCleanup(h);
  assert.equal(h.writes.length, 0);
});
