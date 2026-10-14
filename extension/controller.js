export const EMPTY_STATE = {
  status: 'idle', tab: null, elapsedMs: 0, bytes: 0, level: 0,
  error: null, notice: null, result: null, selection: null, exportResult: null,
  download: { id: null, status: 'idle', error: null },
};

export function createController(api) {
  let creatingDocument;
  let saveInFlight = false;
  let commands = Promise.resolve();
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
    const labels = { starting: '…', recording: 'REC', paused: 'Ⅱ', stopping: '…', trimming: '…', ready: '↓', error: '!' };
    await Promise.all([
      api.action.setBadgeText({ text: labels[current.status] || '' }),
      api.action.setBadgeBackgroundColor({ color: current.status === 'recording' ? '#da4761' : '#247e76' }),
      api.action.setTitle({ title: current.status === 'recording' ? '탭 소리 녹음 중 — 클릭하여 중지' : '탭 소리 녹음' }),
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

  async function run(message) {
    let current = await reconcileDownload(await state());
    if (message.type === 'STATUS') return { ok: true, state: current };
    if (message.type === 'ARM_SHORTCUTS') {
      const tab = await activeWebTab();
      try {
        await api.scripting.executeScript({ target: { tabId: tab.id }, files: ['page-shortcuts.js'] });
      } catch {
        throw new Error('단축키 연결 권한을 확인하지 못했어요. 이 탭에서 확장 프로그램을 다시 눌러 주세요.');
      }
      return { ok: true, state: current };
    }
    if (message.type === 'PAGE_STOP') {
      if (!Number.isInteger(message.targetTabId) || current.tab?.id !== message.targetTabId ||
          !['recording', 'paused'].includes(current.status)) {
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
    if (message.type === 'START') {
      if (!['idle', 'error'].includes(current.status)) {
        throw new Error('진행 중인 녹음을 마치고 새 녹음을 시작해 주세요.');
      }
      const tab = await activeWebTab(message.targetTabId);
      await ensureDocument();
      let streamId;
      try { streamId = await api.tabCapture.getMediaStreamId({ targetTabId: tab.id }); }
      catch { throw new Error('탭에 연결하지 못했어요. 녹음할 탭에서 확장 프로그램을 다시 클릭해 주세요.'); }
      const reply = await send('START', { streamId, tab: { id: tab.id, title: tab.title || '제목 없는 탭' } });
      await badge(reply.state);
      return reply;
    }
    if (message.type === 'SAVE' || message.type === 'SAVE_RANGE') {
      if (current.status !== 'ready' || !current.result) throw new Error('녹음을 먼저 마쳐 주세요.');
      if (current.download.status === 'pending') throw new Error('파일 저장이 진행 중이에요.');
      if (message.type === 'SAVE_RANGE') {
        const prepared = await send('PREPARE_EXPORT', {
          startSeconds: message.startSeconds, endSeconds: message.endSeconds,
        });
        if (!prepared.ok) return prepared;
        current = prepared.state;
      }
      const output = message.type === 'SAVE_RANGE' ? current.exportResult : current.result;
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

  return {
    badge,
    // Reads remain responsive while a native Save As dialog is open.
    handle(message) {
      if (message.type === 'STATUS') return safeRun(message);
      const result = commands.then(() => safeRun(message));
      commands = result.catch(() => {});
      return result;
    },
    async onDownloadChanged(delta) {
      const current = await state();
      if (current.download.id === delta.id) await badge(await reconcileDownload(current));
    },
    async onTabRemoved(tabId) {
      const current = await state();
      if (current.tab?.id === tabId && ['recording', 'paused', 'starting'].includes(current.status)) {
        await this.handle({ type: 'STOP', expectedTabId: tabId });
      }
    },
  };
}
