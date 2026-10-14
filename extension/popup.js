"use strict";

const byId = (id) => document.getElementById(id);
const ui = {
  app: document.querySelector(".app"),
  statusPill: byId("status-pill"),
  statusLabel: byId("status-label"),
  timer: byId("timer"),
  timerCaption: byId("timer-caption"),
  level: byId("level-fill"),
  levelLabel: byId("level-label"),
  fileSize: byId("file-size"),
  source: byId("source-title"),
  error: byId("error-message"),
  notice: byId("notice-message"),
  start: byId("start-button"),
  startLabel: byId("start-label"),
  recordingControls: byId("recording-controls"),
  pause: byId("pause-button"),
  stop: byId("stop-button"),
  readyControls: byId("ready-controls"),
  save: byId("save-button"),
  saveRange: byId("save-range-button"),
  audio: byId("audio-preview"),
  trimStart: byId("trim-start"),
  trimEnd: byId("trim-end"),
  setTrimStart: byId("set-trim-start"),
  setTrimEnd: byId("set-trim-end"),
  previewRange: byId("preview-range"),
  trimSummary: byId("trim-summary"),
  trimError: byId("trim-error"),
  trimUnavailable: byId("trim-unavailable"),
  discard: byId("discard-button"),
  hint: byId("control-hint"),
};

const statusLabels = {
  loading: "상태 확인 중",
  idle: "준비 완료",
  starting: "녹음 준비 중",
  recording: "녹음 중",
  paused: "일시 정지",
  stopping: "파일 만드는 중",
  trimming: "구간 만드는 중",
  ready: "녹음 완료",
  error: "녹음 확인 필요",
};

let state = { status: "loading", elapsedMs: 0, bytes: 0, level: 0 };
let busy = false;
let commandError = "";
let connectionError = "";
let commandVersion = 0;
let previewUrl = "";
let previewEnd = null;
let previewFrame = null;
let selectionVersion = 0;

function setText(element, value) {
  // Avoid repeatedly announcing unchanged live-region content on each poll.
  if (element.textContent !== value) element.textContent = value;
}

function formatBytes(value) {
  const bytes = Math.max(0, Number(value) || 0);
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function durationSeconds() {
  const duration = state.result?.durationSeconds;
  return typeof duration === "number" && Number.isFinite(duration) && duration > 0 ? duration : null;
}

function readSelection() {
  const duration = durationSeconds();
  if (duration === null) return { error: "" };
  const startSeconds = ui.trimStart.valueAsNumber;
  const endSeconds = ui.trimEnd.valueAsNumber;
  if (!Number.isFinite(startSeconds) || !Number.isFinite(endSeconds)) {
    return { error: "시작과 끝 시간을 숫자로 입력해 주세요." };
  }
  if (startSeconds < 0 || endSeconds < 0) return { error: "시간은 0초 이상이어야 해요." };
  if (endSeconds > duration) return { error: `끝 시간은 전체 길이 ${duration.toFixed(3)}초 이하여야 해요.` };
  if (startSeconds >= endSeconds) return { error: "끝 시간을 시작 시간보다 크게 입력해 주세요." };
  return { startSeconds, endSeconds, error: "" };
}

function stopRangePreview(pauseAudio = true) {
  previewEnd = null;
  if (previewFrame !== null) window.cancelAnimationFrame(previewFrame);
  previewFrame = null;
  if (pauseAudio) ui.audio.pause();
  setText(ui.previewRange, "선택 구간 듣기");
}

function checkRangePreview() {
  if (previewEnd === null) return;
  if (ui.audio.currentTime >= previewEnd) {
    const end = previewEnd;
    stopRangePreview();
    ui.audio.currentTime = end;
  }
}

function trackRangePreview() {
  previewFrame = null;
  checkRangePreview();
  if (previewEnd !== null && !ui.audio.paused) previewFrame = window.requestAnimationFrame(trackRangePreview);
}

function renderEditor() {
  const url = state.result?.url || "";
  if (url !== previewUrl) {
    stopRangePreview();
    previewUrl = url;
    selectionVersion += 1;
    if (url) ui.audio.src = url;
    else {
      ui.audio.removeAttribute("src");
      ui.audio.load();
    }
    const duration = durationSeconds();
    const selection = state.selection || {};
    const validSavedSelection = Number.isFinite(selection.startSeconds) && Number.isFinite(selection.endSeconds)
      && selection.startSeconds >= 0 && selection.endSeconds > selection.startSeconds && selection.endSeconds <= duration;
    ui.trimStart.value = duration === null ? "" : String(validSavedSelection ? selection.startSeconds : 0);
    ui.trimEnd.value = duration === null ? "" : String(validSavedSelection ? selection.endSeconds : duration);
  }
  const duration = durationSeconds();
  const selection = readSelection();
  const locked = busy || state.status !== "ready" || state.download?.status === "pending";
  ui.trimUnavailable.hidden = duration !== null;
  ui.trimStart.disabled = locked || duration === null;
  ui.trimEnd.disabled = locked || duration === null;
  ui.setTrimStart.disabled = locked || duration === null;
  ui.setTrimEnd.disabled = locked || duration === null;
  ui.trimStart.max = duration === null ? "" : String(duration);
  ui.trimEnd.max = duration === null ? "" : String(duration);
  ui.trimStart.setAttribute("aria-invalid", String(Boolean(selection.error)));
  ui.trimEnd.setAttribute("aria-invalid", String(Boolean(selection.error)));
  ui.previewRange.disabled = locked || duration === null || Boolean(selection.error);
  ui.saveRange.disabled = locked || duration === null || Boolean(selection.error);
  setText(ui.trimError, selection.error);
  ui.trimError.hidden = !selection.error;
  setText(ui.trimSummary, duration === null ? "구간 편집 불가" : selection.error ? `전체 ${duration.toFixed(2)}초` : `선택 ${(selection.endSeconds - selection.startSeconds).toFixed(2)}초 / 전체 ${duration.toFixed(2)}초`);
  setText(ui.saveRange, state.status === "trimming" ? "구간 만드는 중…" : "선택 구간 저장 · .mp4");
}

function render() {
  const status = state.status;
  const recording = status === "recording";
  const paused = status === "paused";
  const ready = status === "ready" || status === "trimming";
  const transitional = status === "starting" || status === "stopping" || status === "trimming";
  const download = state.download || {};
  const pending = download.status === "pending";
  const complete = download.status === "complete";
  const interrupted = download.status === "interrupted";
  const totalSeconds = Math.max(0, Math.floor((Number(state.elapsedMs) || 0) / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const mmss = `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
  ui.app.dataset.ready = String(ready);
  setText(ui.timer, hours ? `${hours}:${mmss}` : mmss);
  ui.timer.setAttribute("aria-label", `녹음 시간 ${hours}시간 ${minutes}분 ${seconds}초`);
  ui.statusPill.dataset.status = status;
  setText(ui.statusLabel, statusLabels[status] || "상태 확인 중");
  setText(ui.timerCaption, recording ? "팝업을 닫아도 계속 녹음돼요" : paused ? "잠시 쉬는 중 · 정지한 시간은 제외돼요" : ready ? "녹음 파일을 기기에 저장하세요" : status === "stopping" ? "오디오 파일을 정리하고 있어요" : "녹음할 탭에서 시작해 주세요");
  ui.level.style.transform = `scaleX(${recording ? Math.max(0, Math.min(1, Number(state.level) || 0)) : 0})`;
  setText(ui.levelLabel, recording ? "현재 탭 오디오" : paused ? "오디오 일시 정지" : ready ? "녹음 파일 크기" : "오디오 대기 중");
  setText(ui.fileSize, formatBytes(state.result?.bytes ?? state.bytes));
  const title = state.tab?.title || "시작할 때 열려 있는 탭";
  setText(ui.source, title);
  ui.source.title = title;

  ui.start.hidden = ready || recording || paused || status === "stopping";
  ui.start.disabled = busy || !(status === "idle" || status === "error");
  setText(ui.startLabel, status === "starting" ? "녹음 준비 중…" : "녹음 시작");
  ui.recordingControls.hidden = !(recording || paused || status === "stopping");
  ui.pause.disabled = busy || transitional;
  setText(ui.pause, paused ? "녹음 재개" : "일시 정지");
  ui.stop.disabled = busy || transitional;
  ui.readyControls.hidden = !ready;
  ui.save.disabled = busy || pending || status !== "ready" || !state.result;
  ui.discard.disabled = busy || pending || status !== "ready";
  setText(ui.save, "전체 저장 · .mp4");
  setText(ui.hint, ready ? pending ? "저장이 끝날 때까지 녹음 파일을 보관해요." : complete ? "저장 완료 · 새 녹음을 시작할 수 있어요." : "브라우저를 닫기 전에 파일을 저장해 주세요." : recording || paused ? "현재 탭만 녹음해요 · 최대 2시간 또는 128 MB" : transitional ? "잠시만 기다려 주세요." : "먼저 페이지에서 소리를 재생해 주세요.");

  const error = commandError || connectionError || state.error || (interrupted ? download.error || "다운로드가 중단됐어요. 저장을 다시 시도해 주세요." : "");
  setText(ui.error, error);
  ui.error.hidden = !error;
  const notice = [state.notice, ready && complete ? "다운로드가 완료됐어요. 브라우저의 다운로드 목록에서 확인하세요." : ""].filter(Boolean).join(" ");
  setText(ui.notice, notice);
  ui.notice.hidden = !notice;
  renderEditor();
}

async function request(type, payload = {}) {
  const response = await chrome.runtime.sendMessage({ target: "background", type, ...payload });
  if (!response || typeof response.ok !== "boolean") {
    throw new Error("확장 프로그램에 연결하지 못했어요. 팝업을 다시 열어 주세요.");
  }
  return response;
}

async function command(type, payload = {}) {
  if (busy) return;
  busy = true;
  commandVersion += 1;
  commandError = "";
  connectionError = "";
  render();
  try {
    const response = await request(type, payload);
    if (response.state) state = response.state;
    if (!response.ok) commandError = response.error || "요청을 처리하지 못했어요. 다시 시도해 주세요.";
  } catch (error) {
    commandError = error.message || "요청을 처리하지 못했어요. 팝업을 다시 열어 주세요.";
  } finally {
    busy = false;
    commandVersion += 1;
    render();
  }
}

function selectionChanged() {
  stopRangePreview();
  const selection = readSelection();
  renderEditor();
  if (durationSeconds() === null || selection.error || busy || state.status !== "ready" || state.download?.status === "pending") return;
  const version = ++selectionVersion;
  const url = previewUrl;
  const { startSeconds, endSeconds } = selection;
  // Persist each valid edit immediately so closing the popup keeps the selection.
  // STATUS responses never overwrite the in-progress input values.
  void request("SET_SELECTION", { startSeconds, endSeconds }).then((response) => {
    if (version !== selectionVersion || url !== previewUrl) return;
    if (!response.ok) commandError = response.error || "선택 구간을 기억하지 못했어요. 다시 입력해 주세요.";
    else {
      commandError = "";
      state.selection = { startSeconds, endSeconds };
    }
    render();
  }).catch((error) => {
    if (version !== selectionVersion || url !== previewUrl) return;
    commandError = error.message || "선택 구간을 기억하지 못했어요. 다시 입력해 주세요.";
    render();
  });
}

async function poll() {
  const version = commandVersion;
  try {
    const response = await request("STATUS");
    if (version === commandVersion) {
      if (response.state) state = response.state;
      connectionError = response.ok ? "" : response.error || "녹음 상태를 확인하지 못했어요.";
      render();
    }
  } catch (error) {
    if (version === commandVersion) {
      connectionError = error.message || "연결을 확인하고 팝업을 다시 열어 주세요.";
      render();
    }
  }
  window.setTimeout(poll, 500);
}

ui.start.addEventListener("click", () => {
  if (state.status === "idle" || state.status === "error") void command("START");
});
ui.pause.addEventListener("click", () => {
  if (state.status === "recording" || state.status === "paused") {
    void command(state.status === "paused" ? "RESUME" : "PAUSE");
  }
});
ui.stop.addEventListener("click", () => {
  if (state.status === "recording" || state.status === "paused") void command("STOP");
});
document.addEventListener("keydown", (event) => {
  // Shortcuts belong to this popup; preserve typing and native media controls.
  if (busy || event.defaultPrevented || event.repeat || event.isComposing || event.keyCode === 229
    || event.ctrlKey || event.altKey || event.metaKey || event.shiftKey) return;
  const target = event.target;
  if (target instanceof Element && (target.isContentEditable
    || target.closest('input, textarea, select, audio, video, [role="textbox"], [role="spinbutton"]'))) return;
  const button = event.key === "1" && ["idle", "error"].includes(state.status) ? ui.start
    : event.key === "2" && ["recording", "paused"].includes(state.status) ? ui.stop : null;
  if (!button || button.disabled || button.closest("[hidden]")) return;
  event.preventDefault();
  button.click();
});
ui.save.addEventListener("click", () => {
  if (state.status === "ready" && state.result && state.download?.status !== "pending") {
    stopRangePreview();
    void command("SAVE");
  }
});
ui.saveRange.addEventListener("click", () => {
  const selection = readSelection();
  if (busy || state.status !== "ready" || state.download?.status === "pending" || durationSeconds() === null || selection.error) return;
  stopRangePreview();
  void command("SAVE_RANGE", { startSeconds: selection.startSeconds, endSeconds: selection.endSeconds });
});
ui.trimStart.addEventListener("input", selectionChanged);
ui.trimEnd.addEventListener("input", selectionChanged);
ui.setTrimStart.addEventListener("click", () => {
  ui.trimStart.value = String(Math.max(0, Math.floor(ui.audio.currentTime * 100) / 100));
  selectionChanged();
});
ui.setTrimEnd.addEventListener("click", () => {
  const position = Math.min(ui.audio.currentTime, durationSeconds() || 0);
  ui.trimEnd.value = String(position === durationSeconds() ? position : Math.floor(position * 100) / 100);
  selectionChanged();
});
ui.previewRange.addEventListener("click", async () => {
  if (previewEnd !== null) {
    stopRangePreview();
    return;
  }
  const selection = readSelection();
  if (busy || state.status !== "ready" || state.download?.status === "pending" || durationSeconds() === null || selection.error) return;
  try {
    ui.audio.currentTime = selection.startSeconds;
    previewEnd = selection.endSeconds;
    await ui.audio.play();
    if (previewEnd === null || document.hidden) {
      stopRangePreview();
      return;
    }
    setText(ui.previewRange, "구간 듣기 정지");
    trackRangePreview();
  } catch {
    stopRangePreview();
    commandError = "미리 듣기를 시작하지 못했어요. 다시 시도하거나 전체 파일을 저장해 주세요.";
    render();
  }
});
ui.audio.addEventListener("timeupdate", checkRangePreview);
ui.audio.addEventListener("pause", () => stopRangePreview(false));
ui.audio.addEventListener("ended", () => stopRangePreview(false));
document.addEventListener("visibilitychange", () => {
  if (document.hidden) stopRangePreview();
});
window.addEventListener("pagehide", () => stopRangePreview());
window.addEventListener("unload", () => stopRangePreview());
ui.discard.addEventListener("click", () => {
  if (busy || state.status !== "ready" || state.download?.status === "pending") return;
  const warning = state.exportResult
    ? "새 녹음을 시작하면 전체 원본과 선택 구간이 삭제돼요. 필요한 파일을 모두 저장했나요?"
    : "아직 저장하지 않은 녹음이 있어요. 이 녹음을 삭제하고 새 녹음을 준비할까요?";
  if ((state.download?.status !== "complete" || state.exportResult) && !window.confirm(warning)) return;
  void command("DISCARD");
});

render();
void poll();
