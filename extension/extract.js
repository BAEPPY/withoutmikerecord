import { extractFileAudio } from './file-audio.js';

const byId = (id) => document.getElementById(id);
const ui = {
  file: byId('source-file'), sourceName: byId('source-name'), sourceSize: byId('source-size'),
  extract: byId('extract-button'), cancel: byId('cancel-extract-button'),
  progressSection: byId('extract-progress-section'), progress: byId('extract-progress'),
  status: byId('extract-status'), progressLabel: byId('extract-progress-label'), error: byId('extract-error'),
  resultSection: byId('result-section'), resultName: byId('result-name'), resultDetails: byId('result-details'),
  audio: byId('result-audio'), previewError: byId('preview-error'), save: byId('save-extracted-button'),
  downloadStatus: byId('download-status'), refreshDownload: byId('refresh-download-button'),
};
const MAX_FILE_BYTES = 128 * 1024 * 1024;
const stages = { reading: '파일 확인 중', copying: '원본 소리 추출 중', encoding: '소리 MP4로 변환 중', finishing: '파일 마무리 중' };
let sourceFile = null;
let result = null;
let extraction = null;
let download = null;
let destroyed = false;
let errorMessage = '';
let progress = 0;
let statusMessage = '';
let previewError = '';

function text(element, value) {
  if (element.textContent !== value) element.textContent = value;
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

function formatDuration(seconds) {
  if (!Number.isFinite(seconds)) return '길이 확인 불가';
  const total = Math.max(0, Math.round(seconds * 100));
  const minutes = Math.floor(total / 6000);
  const remainder = (total % 6000) / 100;
  return `${minutes}:${remainder.toFixed(2).padStart(5, '0')}`;
}

function audioFilename(name) {
  const base = name.replace(/\.[^.]+$/, '').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').replace(/[. ]+$/g, '').slice(0, 100);
  return `${base || 'audio'}-audio.mp4`;
}

function downloading() {
  return download?.status === 'pending';
}

function render() {
  if (destroyed) return;
  const locked = Boolean(extraction) || downloading();
  ui.file.disabled = locked;
  ui.extract.disabled = locked || !sourceFile;
  ui.cancel.hidden = !extraction;
  ui.cancel.disabled = Boolean(extraction?.cancelled);
  text(ui.cancel, extraction?.cancelled ? '추출 중지 중…' : '추출 취소');
  text(ui.sourceName, sourceFile?.name || '선택한 파일이 없어요.');
  text(ui.sourceSize, sourceFile ? formatBytes(sourceFile.size) : '');
  ui.progressSection.hidden = !statusMessage;
  ui.progress.value = progress;
  text(ui.status, statusMessage);
  text(ui.progressLabel, `${Math.floor(progress * 100)}%`);
  const failure = errorMessage || (download?.status === 'interrupted' ? download.error : '');
  text(ui.error, failure || '');
  ui.error.hidden = !failure;
  ui.resultSection.hidden = !result;
  ui.save.disabled = locked || !result;
  text(ui.save, downloading() ? '저장 중…' : '소리 MP4 저장');
  text(ui.resultName, result?.filename || '');
  text(ui.resultDetails, result ? `${formatDuration(result.durationSeconds)} · ${formatBytes(result.blob.size)} · ${result.method === 'copy' ? '원본 소리 그대로 추출' : '소리 MP4로 변환'}` : '');
  text(ui.previewError, previewError);
  ui.previewError.hidden = !previewError;
  text(ui.downloadStatus, download?.status === 'pending' ? download.notice || '저장이 끝날 때까지 이 탭을 열어 두세요.'
    : download?.status === 'complete' ? '저장 완료 · 브라우저 다운로드 목록에서 확인하세요.'
    : result ? '결과를 확인한 뒤 기기에 저장하세요. 다시 저장할 수도 있어요.' : '');
  ui.refreshDownload.hidden = !downloading() || download.id === null;
}

ui.file.addEventListener('change', () => {
  if (destroyed || extraction || downloading()) return;
  const file = ui.file.files?.[0];
  if (!file) return;
  errorMessage = '';
  statusMessage = '';
  progress = 0;
  download = null;
  if (!file.size || file.size > MAX_FILE_BYTES) {
    sourceFile = null;
    ui.file.value = '';
    errorMessage = file.size > MAX_FILE_BYTES ? '128 MiB 이하의 파일을 선택해 주세요.' : '비어 있는 파일은 추출할 수 없어요.';
  } else sourceFile = file;
  render();
});

async function startExtraction() {
  if (destroyed || extraction || downloading() || !sourceFile) return;
  if (result && !result.saved && !window.confirm('새 추출이 성공하면 현재 결과를 바꿔요. 아직 저장하지 않은 소리가 있어요. 저장하지 않고 진행할까요?')) return;
  const operation = { controller: new AbortController(), cancelled: false, file: sourceFile };
  extraction = operation;
  errorMessage = '';
  download = null;
  progress = 0;
  statusMessage = stages.reading;
  ui.audio.pause();
  render();
  const current = () => !destroyed && extraction === operation;
  try {
    const output = await extractFileAudio(operation.file, {
      signal: operation.controller.signal,
      onProgress(value) {
        if (!current() || operation.cancelled || !Number.isFinite(value)) return;
        progress = Math.max(progress, Math.min(1, Math.max(0, value)));
        render();
      },
      onStage(stage) {
        if (!current() || operation.cancelled) return;
        statusMessage = stages[stage] || '소리 파일 만드는 중';
        render();
      },
    });
    if (!current()) return;
    if (operation.cancelled || operation.controller.signal.aborted) {
      statusMessage = '추출을 취소했어요. 다시 시작할 수 있어요.';
      return;
    }
    if (!output?.blob?.size) throw new Error('추출한 소리가 비어 있어요. 다른 파일로 다시 시도해 주세요.');
    const url = URL.createObjectURL(output.blob);
    const previous = result;
    result = { ...output, url, filename: audioFilename(operation.file.name), saved: false };
    previewError = '';
    ui.audio.src = url;
    if (previous) URL.revokeObjectURL(previous.url);
    progress = 1;
    statusMessage = '소리 추출 완료';
  } catch (error) {
    if (!current()) return;
    if (operation.cancelled || error?.name === 'AbortError') statusMessage = '추출을 취소했어요. 다시 시작할 수 있어요.';
    else {
      statusMessage = '';
      errorMessage = error?.message || '소리를 추출하지 못했어요. 다른 파일로 다시 시도해 주세요.';
    }
  } finally {
    if (current()) {
      extraction = null;
      render();
    }
  }
}

ui.extract.addEventListener('click', () => { void startExtraction(); });
ui.cancel.addEventListener('click', () => {
  if (!extraction || extraction.cancelled) return;
  extraction.cancelled = true;
  extraction.controller.abort();
  statusMessage = '추출 중지 중…';
  render();
});

function activeDownload(job) {
  return !destroyed && download === job && job.status === 'pending';
}

function finishDownload(job, state, error) {
  if (!activeDownload(job) || !['complete', 'interrupted'].includes(state)) return;
  job.status = state;
  job.error = state === 'interrupted' ? error || '저장이 취소되었거나 실패했어요. 결과는 남아 있으니 다시 저장해 주세요.' : '';
  window.clearTimeout(job.timer);
  if (state === 'complete') job.result.saved = true;
  render();
}

function applyDownloadDelta(job, delta) {
  const state = delta.state?.current;
  if (state === 'complete' || state === 'interrupted') finishDownload(job, state);
  else if (delta.error?.current && state !== 'in_progress') finishDownload(job, 'interrupted');
}

function onDownloadChanged(delta) {
  const job = download;
  if (!job || !activeDownload(job)) return;
  if (job.id === null) {
    if (delta.state?.current === 'complete' || delta.state?.current === 'interrupted' || delta.error?.current) {
      if (job.early.size >= 64) job.early.delete(job.early.keys().next().value);
      job.early.set(delta.id, delta);
    }
  } else if (delta.id === job.id) applyDownloadDelta(job, delta);
}

function scheduleDownloadCheck(job) {
  if (!activeDownload(job)) return;
  window.clearTimeout(job.timer);
  job.timer = window.setTimeout(() => { void checkDownload(job); }, 1000);
}

async function checkDownload(job) {
  if (!activeDownload(job) || job.id === null || job.checking) return;
  job.checking = true;
  try {
    const items = await chrome.downloads.search({ id: job.id });
    if (!activeDownload(job)) return;
    const item = items.find((entry) => entry.id === job.id);
    if (item?.state === 'complete' || item?.state === 'interrupted') finishDownload(job, item.state);
    else {
      job.missingChecks = item ? 0 : job.missingChecks + 1;
      if (job.missingChecks >= 3) {
        finishDownload(job, 'interrupted', '다운로드 기록을 찾을 수 없어요. 결과는 남아 있으니 다시 저장해 주세요.');
        return;
      }
      job.notice = item ? '' : '저장 상태를 아직 확인하지 못했어요. 잠시 뒤 다시 확인해요.';
      render();
    }
  } catch {
    if (activeDownload(job)) {
      job.notice = '저장 상태를 확인하지 못했어요. 이 탭을 열어 두거나 상태를 다시 확인해 주세요.';
      render();
    }
  } finally {
    job.checking = false;
    scheduleDownloadCheck(job);
  }
}

async function saveResult() {
  if (destroyed || extraction || downloading() || !result) return;
  const job = { id: null, status: 'pending', result, early: new Map(), checking: false, timer: null, notice: '', missingChecks: 0 };
  download = job;
  errorMessage = '';
  render();
  try {
    const id = await chrome.downloads.download({ url: job.result.url, filename: job.result.filename, saveAs: true, conflictAction: 'uniquify' });
    if (!activeDownload(job)) return;
    if (!Number.isInteger(id) || id < 0) throw new Error('저장 요청을 확인하지 못했어요. 다시 저장해 주세요.');
    job.id = id;
    const early = job.early.get(id);
    job.early.clear();
    if (early) applyDownloadDelta(job, early);
    if (activeDownload(job)) await checkDownload(job);
  } catch (error) {
    if (activeDownload(job)) finishDownload(job, 'interrupted', '저장이 취소되었거나 시작되지 않았어요. 결과는 남아 있으니 다시 저장해 주세요.');
  }
}

chrome.downloads.onChanged.addListener(onDownloadChanged);
ui.save.addEventListener('click', () => { void saveResult(); });
ui.refreshDownload.addEventListener('click', () => { if (download) void checkDownload(download); });
ui.audio.addEventListener('error', () => {
  if (destroyed || !result) return;
  previewError = '이 브라우저에서 소리를 미리 재생하지 못했어요. MP4를 저장해 다른 플레이어에서 확인할 수 있어요.';
  render();
});
ui.audio.addEventListener('loadeddata', () => {
  previewError = '';
  render();
});

window.addEventListener('beforeunload', (event) => {
  if (!destroyed && (extraction || downloading() || (result && !result.saved))) {
    event.preventDefault();
    event.returnValue = '';
  }
});
window.addEventListener('pagehide', () => {
  if (destroyed) return;
  destroyed = true;
  extraction?.controller.abort();
  if (download) window.clearTimeout(download.timer);
  chrome.downloads.onChanged.removeListener(onDownloadChanged);
  ui.audio.pause();
  ui.audio.removeAttribute('src');
  ui.audio.load();
  if (result) URL.revokeObjectURL(result.url);
  sourceFile = null;
  result = null;
});

render();
