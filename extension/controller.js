import { getVideoQuality } from './video-quality.js';

export const EMPTY_STATE = {
  status: 'idle', tab: null, elapsedMs: 0, bytes: 0, level: 0,
  error: null, notice: null, result: null, selection: null, exportResult: null, videoExportResult: null,
  mode: 'audio', selectionToken: null, selectionUrl: null, videoSessionToken: null, gifResult: null, rangeGifResult: null, exportProgress: 0,
  exportFormat: null, exportContent: null, exportQuality: null,
  download: { id: null, status: 'idle', error: null },
};

export function createController(api, { onStateChange = () => {} } = {}) {
  let creatingDocument;
  let saveInFlight = false;
  let commands = Promise.resolve();
  let previousControlRequest = null;
  const offscreenUrl = api.runtime.getURL('offscreen.html');

  async function hasDocument() {
    const contexts = await api.runtime.getContexts({
      contextTypes: ['OFFSCREEN_DOCUMENT'], documentUrls: [offscreenUrl],
    });
    return contexts.length > 0;
  }

  async function ensureDocument() {
    if (creatingDocument) return creatingDocument;
    creatingDocument = (async () => {
      if (!await hasDocument()) {
        await api.offscreen.createDocument({
          url: 'offscreen.html', reasons: ['USER_MEDIA'],
          justification: 'Record tab audio while the extension popup is closed.',
        });
      }
    })();
    try { await creatingDocument; } finally { creatingDocument = undefined; }
  }

  async function send(type, data = {}) {
    const reply = await api.runtime.sendMessage({ target: 'offscreen', type, ...data });
    if (!reply) throw new Error('녹음 창에 연결하지 못했어요. 확장 프로그램을 다시 열어 주세요.');
    return reply;
  }

  async function state() {
    if (!await hasDocument()) return structuredClone(EMPTY_STATE);
    const reply = await send('STATUS');
    if (!reply.ok) throw new Error(reply.error);
    return reply.state;
  }

  async function badge(current) {
    const labels = { selecting: '영역', starting: '…', recording: 'REC', paused: 'Ⅱ', stopping: '…', trimming: '…', exporting: 'GIF', ready: '↓', error: '!' };
    await Promise.all([
      api.action.setBadgeText({ text: labels[current.status] || '' }),
      api.action.setBadgeBackgroundColor({ color: current.status === 'recording' ? '#da4761' : '#247e76' }),
      api.action.setTitle({ title: current.status === 'recording'
        ? current.mode === 'video' ? '화면과 소리 녹화 중 — 4로 종료' : '탭 소리 녹음 중 — 2로 종료'
        : '탭 소리 · 화면 녹화' }),
      onStateChange(current),
    ]);
  }

  async function reconcileDownload(current) {
    if (current.download.status !== 'pending') return current;
    if (current.download.id === null) {
      if (saveInFlight) return current;
      const reply = await send('DOWNLOAD_UPDATE', { download: {
        id: null, status: 'interrupted',
        error: '저장 요청이 중단되었어요. 다운로드 목록을 확인한 후 다시 저장해 주세요.',
      } });
      return reply.state;
    }
    const [item] = await api.downloads.search({ id: current.download.id });
    const status = item?.state === 'complete' ? 'complete'
      : !item || item.state === 'interrupted' ? 'interrupted' : 'pending';
    if (status === 'pending') return current;
    const reply = await send('DOWNLOAD_UPDATE', { download: {
      id: current.download.id, status,
      error: status === 'interrupted' ? '저장이 취소되었거나 실패했어요. 다시 저장할 수 있어요.' : null,
    } });
    return reply.state;
  }

  async function activeWebTab(targetTabId) {
    let tab;
    if (targetTabId !== undefined) {
      if (!Number.isInteger(targetTabId) || targetTabId < 0) throw new Error('녹음할 탭을 다시 선택해 주세요.');
      try { tab = await api.tabs.get(targetTabId); }
      catch { throw new Error('탭이 닫혔어요. 녹음할 탭에서 확장 프로그램을 다시 열어 주세요.'); }
      const [active] = await api.tabs.query({ active: true, currentWindow: true });
      if (!tab?.active || active?.id !== targetTabId) throw new Error('녹음할 탭을 선택한 상태에서 다시 눌러 주세요.');
    } else {
      [tab] = await api.tabs.query({ active: true, currentWindow: true });
    }
    if (!Number.isInteger(tab?.id) || !/^https?:\/\//i.test(tab.url || '') ||
        /^https:\/\/(chromewebstore\.google\.com|chrome\.google\.com\/webstore|microsoftedge\.microsoft\.com\/addons)(\/|$)/i.test(tab.url)) {
      throw new Error('소리가 재생되는 일반 웹페이지에서 확장 프로그램을 열어 주세요. 브라우저 설정이나 스토어 페이지는 녹음할 수 없어요.');
    }
    return tab;
  }

  function connectShortcuts(tabId) {
    return api.scripting.executeScript({
      target: { tabId }, files: ['region-selector.js', 'youtube-controls.js', 'page-shortcuts.js'],
    });
  }

  function selectedVideoRange(message, current) {
    const { startSeconds, endSeconds } = message;
    const duration = current.result?.durationSeconds;
    if (!Number.isFinite(startSeconds) || !Number.isFinite(endSeconds) ||
        !Number.isFinite(duration) || startSeconds < 0 || endSeconds <= startSeconds || endSeconds > duration) {
      throw new Error('시작과 끝을 영상 길이 안에서 입력해 주세요. 끝은 시작보다 뒤여야 해요.');
    }
    return { startSeconds, endSeconds };
  }

  async function run(message) {
    if (message.type === 'CANCEL_EXPORT') {
      if (!await hasDocument()) return { ok: true, state: structuredClone(EMPTY_STATE) };
      const reply = await send('CANCEL_EXPORT');
      await badge(reply.state);
      return reply;
    }
    if (message.type === 'VIDEO_VIEWPORT_CHANGED') {
      if (!Number.isInteger(message.targetTabId) || typeof message.selectionToken !== 'string') {
        throw new Error('화면 변경 요청이 올바르지 않아요.');
      }
      if (!await hasDocument()) return { ok: true, state: structuredClone(EMPTY_STATE) };
      const reply = await send('VIDEO_VIEWPORT_CHANGED', { tabId: message.targetTabId, selectionToken: message.selectionToken });
      await badge(reply.state);
      return reply;
    }
    let current = await reconcileDownload(await state());
    if (message.type === 'STATUS') return { ok: true, state: current };
    if (message.type === 'ARM_SHORTCUTS' || message.type === 'OPEN_VIDEO_SELECTOR') {
      if (message.type === 'OPEN_VIDEO_SELECTOR' && !['idle', 'error'].includes(current.status)) {
        throw new Error('진행 중인 녹음을 마치고 새 녹음을 준비해 주세요.');
      }
      const tab = await activeWebTab(message.targetTabId);
      try {
        await connectShortcuts(tab.id);
      } catch {
        throw new Error('단축키 연결 권한을 확인하지 못했어요. 이 탭에서 확장 프로그램을 다시 눌러 주세요.');
      }
      if (message.type === 'OPEN_VIDEO_SELECTOR') {
        const response = await api.tabs.sendMessage(tab.id, { type: 'SHOW_VIDEO_SELECTOR' }, { frameId: 0 });
        if (!response?.ok) throw new Error('영역 선택 화면을 열지 못했어요. 페이지를 새로고침하고 다시 연결해 주세요.');
      }
      return { ok: true, state: current, shortcutTabId: tab.id };
    }
    if (message.type === 'BEGIN_VIDEO') {
      if (!['idle', 'error'].includes(current.status)) throw new Error('진행 중인 녹음을 마치고 새 녹음을 준비해 주세요.');
      const tab = await activeWebTab(message.targetTabId);
      let imageDataUrl;
      try { imageDataUrl = await api.tabs.captureVisibleTab(tab.windowId, { format: 'png' }); }
      catch { throw new Error('화면을 가져오지 못했어요. 녹화할 페이지에서 확장 아이콘을 다시 눌러 주세요.'); }
      const latest = await activeWebTab(tab.id);
      if (latest.url !== tab.url) throw new Error('페이지가 바뀌었어요. 3을 눌러 영역을 다시 선택해 주세요.');
      const selectionToken = crypto.randomUUID();
      await ensureDocument();
      const reply = await send('SELECT_VIDEO', { tab: { id: tab.id, title: tab.title, url: tab.url }, selectionToken });
      await badge(reply.state);
      return reply.ok ? { ...reply, imageDataUrl, selectionToken } : reply;
    }
    if (['CANCEL_VIDEO', 'STOP_VIDEO'].includes(message.type) &&
        message.selectionToken === undefined && ['idle', 'error'].includes(current.status)) {
      // Opening the selector is acknowledged before its page task starts.
      // A quick stop must cancel that task even before SELECT_VIDEO exists.
      const tabId = message.targetTabId === undefined ? (await activeWebTab()).id : message.targetTabId;
      if (!Number.isInteger(tabId) || tabId < 0) throw new Error('취소할 탭을 확인하지 못했어요.');
      const response = await api.tabs.sendMessage(tabId, { type: 'CANCEL_VIDEO_SELECTOR' }, { frameId: 0 }).catch(() => null);
      if (response?.cancelled) return { ok: true, state: current };
    }
    if (message.type === 'CANCEL_VIDEO' || (message.type === 'STOP_VIDEO' && current.status === 'selecting')) {
      if (current.status !== 'selecting' ||
          (message.targetTabId !== undefined && current.tab?.id !== message.targetTabId) ||
          (message.selectionToken !== undefined && current.selectionToken !== message.selectionToken)) {
        throw new Error('진행 중인 영역 선택이 아니에요.');
      }
      const reply = await send('CANCEL_VIDEO', { selectionToken: current.selectionToken });
      await api.tabs.sendMessage(current.tab.id, { type: 'CANCEL_VIDEO_SELECTOR' }, { frameId: 0 }).catch(() => {});
      await badge(reply.state);
      return reply;
    }
    if (message.type === 'START_VIDEO') {
      if (current.status !== 'selecting' || current.tab?.id !== message.targetTabId ||
          typeof message.selectionToken !== 'string' || current.selectionToken !== message.selectionToken) {
        throw new Error('영역 선택이 만료됐어요. 3을 눌러 다시 선택해 주세요.');
      }
      try {
        const tab = await activeWebTab(message.targetTabId);
        if (tab.url !== current.selectionUrl) throw new Error('페이지가 바뀌었어요. 영역을 다시 선택해 주세요.');
        const r = message.region;
        if (!r || !['x', 'y', 'width', 'height', 'viewportWidth', 'viewportHeight'].every((key) => Number.isFinite(r[key])) ||
            r.x < 0 || r.y < 0 || r.width <= 0 || r.height <= 0 || r.x + r.width > 1.000001 || r.y + r.height > 1.000001 ||
            r.viewportWidth <= 0 || r.viewportHeight <= 0 || r.viewportWidth > 32768 || r.viewportHeight > 32768 ||
            r.width * r.viewportWidth < 16 || r.height * r.viewportHeight < 16) {
          throw new Error('가로·세로 16픽셀 이상의 영역을 선택해 주세요.');
        }
        const streamId = await api.tabCapture.getMediaStreamId({ targetTabId: tab.id });
        const reply = await send('START', { mode: 'video', streamId, tab: { id: tab.id, title: tab.title },
          region: r, selectionToken: message.selectionToken });
        await badge(reply.state);
        return reply;
      } catch (error) {
        await send('CANCEL_VIDEO', { selectionToken: message.selectionToken }).catch(() => {});
        await badge(await state());
        throw error;
      }
    }
    if (message.type === 'STOP_VIDEO') {
      if (current.mode !== 'video' || current.tab?.id !== message.targetTabId || !['recording', 'paused'].includes(current.status)) {
        throw new Error('이 탭에서 진행 중인 화면 녹화가 없어요.');
      }
      const reply = await send('STOP');
      await badge(reply.state);
      return reply;
    }
    if (message.type === 'PAGE_STOP') {
      if (!Number.isInteger(message.targetTabId) || current.tab?.id !== message.targetTabId ||
          current.mode === 'video' || !['recording', 'paused'].includes(current.status)) {
        throw new Error('이 탭에서 진행 중인 녹음이 없어요. 녹음한 탭에서 2를 눌러 주세요.');
      }
      const reply = await send('STOP');
      await badge(reply.state);
      return reply;
    }
    if (message.type === 'STOP' && message.expectedTabId !== undefined &&
        (current.tab?.id !== message.expectedTabId || !['recording', 'paused'].includes(current.status))) {
      return { ok: true, state: current };
    }
    if (message.type === 'START' || message.type === 'BROWSER_START') {
      if (!['idle', 'error'].includes(current.status)) {
        throw new Error('진행 중인 녹음을 마치고 새 녹음을 시작해 주세요.');
      }
      const tab = await activeWebTab(message.targetTabId);
      if (message.type === 'BROWSER_START') {
        // Browser commands grant activeTab too; plain 2 should then work.
        // Keep the browser command usable if a page rejects script injection.
        await connectShortcuts(tab.id).catch(() => {});
      }
      await ensureDocument();
      let streamId;
      try { streamId = await api.tabCapture.getMediaStreamId({ targetTabId: tab.id }); }
      catch { throw new Error('탭에 연결하지 못했어요. 녹음할 탭에서 확장 프로그램을 다시 클릭해 주세요.'); }
      const reply = await send('START', { streamId, tab: { id: tab.id, title: tab.title || '제목 없는 탭' } });
      await badge(reply.state);
      return reply;
    }
    if (message.type === 'PREPARE_GIF_COPY') {
      if (current.status !== 'ready' || current.result?.kind !== 'video' || !['whole', 'range'].includes(message.scope)) {
        throw new Error('화면 녹화를 마친 뒤 복사할 GIF 구간을 선택해 주세요.');
      }
      if (current.download.status === 'pending') throw new Error('파일 저장이 진행 중이에요.');
      const quality = getVideoQuality(message.quality).id;
      const prepared = await send('PREPARE_GIF', {
        ...(message.scope === 'range' ? selectedVideoRange(message, current) : {}),
        ...(message.quality === undefined ? {} : { quality }),
      });
      if (!prepared.ok) return prepared;
      const output = message.scope === 'range' ? prepared.state.rangeGifResult : prepared.state.gifResult;
      if (!output?.url) throw new Error('복사할 GIF를 만들지 못했어요. 다시 시도해 주세요.');
      return { ...prepared, output };
    }
    if (['SAVE', 'SAVE_RANGE', 'SAVE_VIDEO', 'SAVE_VIDEO_RANGE'].includes(message.type)) {
      if (current.status !== 'ready' || !current.result) throw new Error('녹음을 먼저 마쳐 주세요.');
      if (current.download.status === 'pending') throw new Error('파일 저장이 진행 중이에요.');
      const content = message.content === undefined ? 'both' : message.content;
      let quality = 'original';
      let qualityOptions = {};
      if (message.type === 'SAVE_VIDEO' || message.type === 'SAVE_VIDEO_RANGE') {
        if (current.result.kind !== 'video' || !['mp4', 'gif'].includes(message.format)) throw new Error('영상 저장 형식을 선택해 주세요.');
        quality = getVideoQuality(message.quality).id;
        if (message.format === 'mp4' && content === 'audio') quality = 'original';
        qualityOptions = message.quality === undefined ? {} : { quality };
        if (message.format === 'mp4' && !['both', 'video', 'audio'].includes(content)) {
          throw new Error('저장할 구성을 선택해 주세요. 영상과 소리, 영상만, 소리만 중에서 고를 수 있어요.');
        }
        if (message.format === 'gif' && message.content !== undefined && message.content !== 'video') {
          throw new Error('GIF는 소리 없는 영상으로 저장해요. 소리를 저장하려면 MP4를 선택해 주세요.');
        }
        if (message.type === 'SAVE_VIDEO_RANGE') selectedVideoRange(message, current);
        if (message.format === 'gif') {
          const prepared = await send('PREPARE_GIF', {
            ...(message.type === 'SAVE_VIDEO_RANGE' ? {
              startSeconds: message.startSeconds, endSeconds: message.endSeconds,
            } : {}),
            ...qualityOptions,
          });
          if (!prepared.ok) return prepared;
          current = prepared.state;
        }
        if (message.type === 'SAVE_VIDEO' && message.format === 'mp4' && (content !== 'both' || quality !== 'original')) {
          const prepared = await send('PREPARE_VIDEO_EXPORT', { content, ...qualityOptions });
          if (!prepared.ok) return prepared;
          current = prepared.state;
        }
      }
      if (message.type === 'SAVE_RANGE' || (message.type === 'SAVE_VIDEO_RANGE' && message.format === 'mp4')) {
        const prepared = await send('PREPARE_EXPORT', {
          startSeconds: message.startSeconds, endSeconds: message.endSeconds,
          ...(message.type === 'SAVE_VIDEO_RANGE' ? { content, ...qualityOptions } : {}),
        });
        if (!prepared.ok) return prepared;
        current = prepared.state;
      }
      const output = message.type === 'SAVE_VIDEO_RANGE' ? message.format === 'gif' ? current.rangeGifResult : current.exportResult
        : message.type === 'SAVE_RANGE' ? current.exportResult
        : message.type === 'SAVE_VIDEO' && message.format === 'gif' ? current.gifResult
        : message.type === 'SAVE_VIDEO' && (content !== 'both' || quality !== 'original') ? current.videoExportResult : current.result;
      if (!output?.url) throw new Error('저장할 파일을 준비하지 못했어요. 다시 시도해 주세요.');
      saveInFlight = true;
      try {
        await send('DOWNLOAD_UPDATE', { download: { id: null, status: 'pending', error: null } });
        const id = await api.downloads.download({
          url: output.url, filename: output.filename,
          saveAs: true, conflictAction: 'uniquify',
        });
        if (typeof id !== 'number') throw new Error('No download id');
        const reply = await send('DOWNLOAD_UPDATE', { download: { id, status: 'pending', error: null } });
        return { ok: true, state: await reconcileDownload(reply.state) };
      } catch {
        const error = '저장이 취소되었거나 실패했어요. 녹음은 남아 있으니 다시 저장해 주세요.';
        const reply = await send('DOWNLOAD_UPDATE', { download: { id: null, status: 'interrupted', error } });
        return { ok: false, error, state: reply.state };
      } finally { saveInFlight = false; }
    }
    if (!['PAUSE', 'RESUME', 'STOP', 'DISCARD', 'SET_SELECTION'].includes(message.type)) throw new Error('지원하지 않는 요청이에요.');
    if (!await hasDocument()) throw new Error('진행 중인 녹음이 없어요.');
    const reply = await send(message.type, message.type === 'SET_SELECTION' ? {
      startSeconds: message.startSeconds, endSeconds: message.endSeconds,
    } : {});
    await badge(reply.state);
    return reply;
  }

  async function safeRun(message) {
    try { return await run(message); }
    catch (error) {
      return { ok: false, error: error.message || '요청을 처리하지 못했어요.', state: await state().catch(() => structuredClone(EMPTY_STATE)) };
    }
  }

  async function stopPending(message, previous) {
    // The popup sends this immediately, so closing its document cannot erase
    // an early stop. Bind it to that exact preceding operation, never whatever
    // capture happens to be active after an unrelated or failed start.
    if (typeof message.operationId !== 'string' || !message.operationId ||
        message.operationId !== previous?.operationId ||
        !['START', 'OPEN_VIDEO_SELECTOR', 'PAUSE', 'RESUME'].includes(previous?.type) ||
        !['audio', 'video'].includes(message.mode)) {
      return { ok: false, error: '종료 요청이 만료됐어요. 종료 키를 다시 눌러 주세요.', state: await state() };
    }
    const original = await previous.result;
    if (previous.type === 'OPEN_VIDEO_SELECTOR') {
      if (message.mode !== 'video') return { ok: false, error: '영상 종료 키는 4예요.', state: await state() };
      if (!original.ok) return original;
      return safeRun({ type: 'CANCEL_VIDEO', targetTabId: original.shortcutTabId });
    }
    if (previous.type === 'START' && !original.ok) return original;
    const source = original.state;
    const current = await state();
    if (!Number.isInteger(source?.tab?.id) || source.mode !== message.mode ||
        current.tab?.id !== source.tab.id || current.mode !== message.mode) {
      return { ok: false, error: '종료할 녹음이 바뀌었어요. 상태를 확인해 주세요.', state: current };
    }
    if (!['starting', 'recording', 'paused'].includes(current.status)) return { ok: true, state: current };
    return safeRun({ type: message.mode === 'video' ? 'STOP_VIDEO' : 'PAGE_STOP', targetTabId: source.tab.id });
  }

  return {
    badge,
    // Reads remain responsive while a native Save As dialog is open.
    handle(message) {
      if (['STATUS', 'VIDEO_VIEWPORT_CHANGED', 'CANCEL_EXPORT'].includes(message.type)) return safeRun(message);
      const previous = previousControlRequest;
      const result = commands.then(() => message.type === 'STOP_PENDING'
        ? stopPending(message, previous).catch((error) => ({ ok: false, error: error.message }))
        : safeRun(message));
      commands = result.catch(() => {});
      if (message.type !== 'ARM_SHORTCUTS') {
        previousControlRequest = { type: message.type, operationId: message.operationId, result };
      }
      return result;
    },
    async onDownloadChanged(delta) {
      const current = await state();
      if (current.download.id === delta.id) await badge(await reconcileDownload(current));
    },
    async onTabRemoved(tabId) {
      const current = await state();
      if (current.tab?.id === tabId && current.status === 'selecting') {
        await this.handle({ type: 'CANCEL_VIDEO', targetTabId: tabId, selectionToken: current.selectionToken });
      }
      if (current.tab?.id === tabId && ['recording', 'paused', 'starting'].includes(current.status)) {
        await this.handle({ type: 'STOP', expectedTabId: tabId });
      }
    },
    async onTabUpdated(tabId, change) {
      if (change.status === 'complete') {
        // activeTab survives same-origin reloads but injected listeners do not.
        // Chrome enforces the temporary grant here; ungranted tabs and a new
        // origin reject injection without requesting additional permissions.
        await connectShortcuts(tabId).catch(() => {});
        return;
      }
      if (change.status !== 'loading') return;
      const current = await state();
      if (current.tab?.id === tabId && current.status === 'selecting') {
        await this.handle({ type: 'CANCEL_VIDEO', targetTabId: tabId, selectionToken: current.selectionToken });
      } else if (current.tab?.id === tabId && current.mode === 'video' &&
          ['starting', 'recording', 'paused'].includes(current.status)) {
        // A replaced document no longer owns the viewport watcher. End only
        // its session, even if a newer recording starts before this is handled.
        await this.handle({ type: 'VIDEO_VIEWPORT_CHANGED', targetTabId: tabId, selectionToken: current.videoSessionToken });
      }
    },
  };
}
