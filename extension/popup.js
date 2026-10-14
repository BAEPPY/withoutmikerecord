"use strict";

const byId = (id) => document.getElementById(id);
const ui = {
  app: document.querySelector(".app"),
  statusPill: byId("status-pill"),
  statusLabel: byId("status-label"),
  formatTag: byId("format-tag"),
  timer: byId("timer"),
  timerCaption: byId("timer-caption"),
  level: byId("level-fill"),
  levelLabel: byId("level-label"),
  fileSize: byId("file-size"),
  source: byId("source-title"),
  error: byId("error-message"),
  notice: byId("notice-message"),
  start: byId("start-button"),
  startVideo: byId("start-video-button"),
  startLabel: byId("start-label"),
  recordingControls: byId("recording-controls"),
  pause: byId("pause-button"),
  stop: byId("stop-button"),
  stopLabel: byId("stop-label"),
  readyControls: byId("ready-controls"),
  save: byId("save-button"),
  saveFormat: byId("save-format"),
  saveFormatField: byId("save-format-field"),
  saveRange: byId("save-range-button"),
  audio: byId("audio-preview"),
  video: byId("video-preview"),
  videoNote: byId("video-note"),
  trimTitle: byId("trim-title"),
  audioTrimControls: byId("audio-trim-controls"),
  previewPosition: byId("preview-position"),
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
  shortcutStatus: byId("shortcut-status"),
  shortcutAudioStart: byId("shortcut-audio-start"),
  shortcutAudioStop: byId("shortcut-audio-stop"),
  shortcutVideoStart: byId("shortcut-video-start"),
  shortcutVideoStop: byId("shortcut-video-stop"),
  shortcutAssignmentNote: byId("shortcut-assignment-note"),
  shortcutSettings: byId("shortcut-settings"),
};

const statusLabels = {
  loading: "상태 확인 중",
  idle: "준비 완료",
  starting: "녹음 준비 중",
  selecting: "영역 선택 중",
  recording: "녹음 중",
  paused: "일시 정지",
  stopping: "파일 만드는 중",
  trimming: "구간 만드는 중",
  exporting: "GIF 만드는 중",
  ready: "녹음 완료",
  error: "녹음 확인 필요",
};

let state = { status: "loading", elapsedMs: 0, bytes: 0, level: 0 };
let busy = false;
let activeCommand = null;
let activeOperationId = null;
let queuedStop = null;
let commandError = "";
let connectionError = "";
let commandVersion = 0;
let previewUrl = "";
let previewKind = "audio";
let previewEnd = null;
let previewFrame = null;
let selectionVersion = 0;
let shortcutConnection = "pending";
let shortcutDetail = "";

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

function floorHundredths(value) {
  let units = Math.floor(value * 100);
  // Recover exact decimal hundredths such as 1.15 without rounding past value.
  if ((units + 1) / 100 <= value) units += 1;
  return units / 100;
}

function formatTime(value) {
  const seconds = Number.isFinite(value) ? Math.max(0, value) : 0;
  const totalHundredths = Math.round(floorHundredths(seconds) * 100);
  const hours = Math.floor(totalHundredths / 360000);
  const minutes = Math.floor(totalHundredths / 6000) % 60;
  const remainder = Math.floor(totalHundredths / 100) % 60;
  const hundredths = totalHundredths % 100;
  const mmss = `${String(minutes).padStart(2, "0")}:${String(remainder).padStart(2, "0")}.${String(hundredths).padStart(2, "0")}`;
  return hours ? `${hours}:${mmss}` : mmss;
}

function durationSeconds() {
  const duration = state.result?.durationSeconds;
  return typeof duration === "number" && Number.isFinite(duration) && duration > 0 ? duration : null;
}

function videoResult() {
  return state.result?.kind === "video";
}

function videoMode() {
  return state.status === "selecting" || state.mode === "video" || videoResult();
}

function pendingCaptureMode() {
  if (activeCommand === "START") return "audio";
  if (activeCommand === "OPEN_VIDEO_SELECTOR") return "video";
  if (activeCommand === "PAUSE" || activeCommand === "RESUME") return videoMode() ? "video" : "audio";
  return null;
}

function canStop(mode) {
  if (busy) return pendingCaptureMode() === mode;
  return mode === (videoMode() ? "video" : "audio")
    && ["starting", "recording", "paused", "selecting"].includes(state.status);
}

function stopCapture(mode) {
  if (!canStop(mode)) return false;
  if (busy) {
    // Send immediately: the background binds this stop to the pending operation,
    // so closing the popup before its reply cannot discard the stop intent.
    queuedStop ||= {
      promise: request("STOP_PENDING", { operationId: activeOperationId, mode }).catch((error) => ({
        ok: false, error: error.message || "종료 요청을 보내지 못했어요. 다시 종료해 주세요.",
      })),
    };
    render();
  } else {
    void command(state.status === "selecting" ? "CANCEL_VIDEO" : "STOP");
  }
  return true;
}

function activePreview() {
  return videoResult() ? ui.video : ui.audio;
}

function trimAvailable() {
  const duration = durationSeconds();
  return !videoResult() && duration !== null && duration >= 0.01;
}

function readSelection() {
  const duration = durationSeconds();
  if (!trimAvailable()) return { error: "" };
  const startSeconds = ui.trimStart.valueAsNumber;
  const endSeconds = ui.trimEnd.valueAsNumber;
  if (!Number.isFinite(startSeconds) || !Number.isFinite(endSeconds)) {
    return { error: "시작과 끝 시간을 숫자로 입력해 주세요." };
  }
  if (startSeconds < 0 || endSeconds < 0) return { error: "시간은 0초 이상이어야 해요." };
  if (endSeconds > duration) return { error: `끝 시간은 전체 길이 ${floorHundredths(duration).toFixed(2)}초 이하여야 해요.` };
  if (startSeconds >= endSeconds) return { error: "끝 시간을 시작 시간보다 크게 입력해 주세요." };
  return { startSeconds, endSeconds, error: "" };
}

function stopRangePreview(pauseAudio = true) {
  previewEnd = null;
  if (previewFrame !== null) window.cancelAnimationFrame(previewFrame);
  previewFrame = null;
  if (pauseAudio) {
    ui.audio.pause();
    ui.video.pause();
  }
  setText(ui.previewRange, "선택 구간 듣기");
  renderPreviewPosition();
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
  renderPreviewPosition();
  if (!activePreview().paused && !document.hidden) previewFrame = window.requestAnimationFrame(trackRangePreview);
}

function startPreviewClock() {
  if (previewFrame === null && !activePreview().paused && !document.hidden) previewFrame = window.requestAnimationFrame(trackRangePreview);
}

function renderPreviewPosition() {
  const media = activePreview();
  const duration = durationSeconds() ?? (Number.isFinite(media.duration) ? media.duration : null);
  const position = duration === null ? media.currentTime : Math.min(media.currentTime, duration);
  setText(ui.previewPosition, `${formatTime(position)} / ${duration === null ? "--:--.--" : formatTime(duration)}`);
}

function renderEditor() {
  const url = state.result?.url || "";
  const video = videoResult();
  const kind = video ? "video" : "audio";
  ui.audio.hidden = video;
  ui.video.hidden = !video;
  ui.videoNote.hidden = !video;
  ui.audioTrimControls.hidden = video;
  ui.saveRange.hidden = video;
  ui.saveFormatField.hidden = !video;
  setText(ui.trimTitle, video ? "녹화 영상 미리 보기" : "듣고, 원하는 구간만 저장하기");
  ui.previewPosition.setAttribute("aria-label", video ? "영상 현재 위치와 전체 길이" : "미리 듣기 현재 위치와 전체 길이");
  if (url !== previewUrl || kind !== previewKind) {
    stopRangePreview();
    previewUrl = url;
    previewKind = kind;
    selectionVersion += 1;
    for (const media of [ui.audio, ui.video]) {
      if (media === activePreview() && url) media.src = url;
      else {
        media.removeAttribute("src");
        media.load();
      }
    }
    const duration = durationSeconds();
    const selection = state.selection || {};
    const validSavedSelection = Number.isFinite(selection.startSeconds) && Number.isFinite(selection.endSeconds)
      && selection.startSeconds >= 0 && selection.endSeconds > selection.startSeconds && selection.endSeconds <= duration;
    ui.trimStart.value = duration === null || video ? "" : floorHundredths(validSavedSelection ? selection.startSeconds : 0).toFixed(2);
    ui.trimEnd.value = duration === null || video ? "" : floorHundredths(validSavedSelection ? selection.endSeconds : duration).toFixed(2);
  }
  const duration = durationSeconds();
  const available = trimAvailable();
  const selection = readSelection();
  const locked = busy || state.status !== "ready" || state.download?.status === "pending";
  ui.trimUnavailable.hidden = available;
  setText(ui.trimUnavailable, duration === null
    ? "이 녹음의 길이를 확인할 수 없어 구간을 자를 수 없어요. 전체 파일은 저장할 수 있어요."
    : "녹음이 0.01초보다 짧아 구간을 나눌 수 없어요. 전체 파일을 저장해 주세요.");
  ui.trimStart.disabled = locked || !available;
  ui.trimEnd.disabled = locked || !available;
  ui.setTrimStart.disabled = locked || !available;
  ui.setTrimEnd.disabled = locked || !available;
  ui.trimStart.max = duration === null ? "" : floorHundredths(duration).toFixed(2);
  ui.trimEnd.max = duration === null ? "" : floorHundredths(duration).toFixed(2);
  ui.trimStart.setAttribute("aria-invalid", String(Boolean(selection.error)));
  ui.trimEnd.setAttribute("aria-invalid", String(Boolean(selection.error)));
  ui.previewRange.disabled = locked || !available || Boolean(selection.error);
  ui.saveRange.disabled = locked || !available || Boolean(selection.error);
  setText(ui.trimError, selection.error);
  ui.trimError.hidden = !selection.error;
  setText(ui.trimSummary, !available ? "구간 편집 불가" : selection.error ? `전체 ${floorHundredths(duration).toFixed(2)}초` : `선택 ${(selection.endSeconds - selection.startSeconds).toFixed(2)}초 / 전체 ${floorHundredths(duration).toFixed(2)}초`);
  setText(ui.saveRange, state.status === "trimming" ? "구간 만드는 중…" : "선택 구간 저장 · .mp4");
  renderPreviewPosition();
}

function render() {
  const status = state.status;
  const recording = status === "recording";
  const paused = status === "paused";
  const selecting = status === "selecting";
  const starting = status === "starting" || activeCommand === "START" || activeCommand === "OPEN_VIDEO_SELECTOR";
  const mode = pendingCaptureMode() || (videoMode() ? "video" : "audio");
  const video = mode === "video";
  const ready = status === "ready" || status === "trimming" || status === "exporting";
  const transitional = status === "starting" || status === "stopping" || status === "trimming" || status === "exporting";
  const download = state.download || {};
  const pending = download.status === "pending";
  const complete = download.status === "complete";
  const interrupted = download.status === "interrupted";
  const elapsedSeconds = Math.max(0, (Number(state.elapsedMs) || 0) / 1000);
  const time = formatTime(elapsedSeconds);
  ui.app.dataset.ready = String(ready);
  setText(ui.timer, time);
  ui.timer.setAttribute("aria-label", `${video ? "녹화" : "녹음"} 시간 ${time}`);
  ui.statusPill.dataset.status = status;
  const exportPercent = Math.floor(Math.max(0, Math.min(1, Number(state.exportProgress) || 0)) * 100);
  const statusLabel = video ? { starting: "녹화 준비 중", recording: "영상 녹화 중", ready: "녹화 완료", error: "녹화 확인 필요", exporting: `GIF 만드는 중 ${exportPercent}%` }[status] : null;
  setText(ui.statusLabel, statusLabel || statusLabels[status] || "상태 확인 중");
  setText(ui.formatTag, video ? "MP4 / VIDEO + AUDIO" : "MP4 / AUDIO");
  setText(ui.timerCaption, selecting ? "페이지에서 녹화할 사각형 영역을 드래그해 주세요" : recording ? `팝업을 닫아도 계속 ${video ? "녹화" : "녹음"}돼요` : paused ? "잠시 쉬는 중 · 정지한 시간은 제외돼요" : ready ? `${video ? "녹화" : "녹음"} 파일을 기기에 저장하세요` : status === "stopping" ? "MP4 파일을 정리하고 있어요" : "녹음할 탭에서 시작해 주세요");
  ui.level.style.transform = `scaleX(${recording ? Math.max(0, Math.min(1, Number(state.level) || 0)) : 0})`;
  setText(ui.levelLabel, recording ? "현재 탭 오디오" : paused ? "오디오 일시 정지" : ready ? `${video ? "녹화" : "녹음"} 파일 크기` : "오디오 대기 중");
  setText(ui.fileSize, formatBytes(state.result?.bytes ?? state.bytes));
  const title = state.tab?.title || "시작할 때 열려 있는 탭";
  setText(ui.source, title);
  ui.source.title = title;

  ui.start.hidden = ready || recording || paused || selecting || starting || status === "stopping";
  ui.start.disabled = busy || !(status === "idle" || status === "error");
  ui.startVideo.hidden = ui.start.hidden;
  ui.startVideo.disabled = ui.start.disabled;
  setText(ui.startLabel, status === "starting" ? "녹음 준비 중…" : "녹음 시작");
  ui.recordingControls.hidden = !(recording || paused || selecting || starting || status === "stopping");
  ui.recordingControls.classList.toggle("recording-selecting", selecting || starting);
  ui.pause.hidden = selecting || starting;
  ui.pause.disabled = busy || transitional;
  setText(ui.pause, paused ? "녹음 재개" : "일시 정지");
  ui.stop.disabled = Boolean(queuedStop) || !canStop(mode);
  setText(ui.stopLabel, queuedStop ? "종료 요청 대기 중…" : selecting || activeCommand === "OPEN_VIDEO_SELECTOR" ? "영역 선택 취소" : video ? "영상 끝내기" : "녹음 끝내기");
  ui.stop.setAttribute("aria-keyshortcuts", video ? "4" : "2");
  ui.stop.title = selecting ? "영역 선택 취소 (키보드 4)" : video ? "영상 끝내기 (키보드 4)" : "녹음 끝내기 (키보드 2)";
  ui.readyControls.hidden = !ready;
  ui.save.disabled = busy || pending || status !== "ready" || !state.result;
  ui.saveFormat.disabled = busy || pending || status !== "ready";
  ui.discard.disabled = busy || pending || status !== "ready";
  setText(ui.discard, videoResult() ? "새 녹화" : "새 녹음");
  ui.save.classList.toggle("primary", videoResult());
  ui.save.classList.toggle("secondary", !videoResult());
  setText(ui.save, status === "exporting" ? `GIF 만드는 중 ${exportPercent}%` : videoResult() ? ui.saveFormat.value === "gif" ? "GIF 저장 · 소리 없음" : "영상 저장 · .mp4" : "전체 저장 · .mp4");
  setText(ui.hint, queuedStop ? "종료 요청을 기억했어요. 진행 중인 준비가 끝나면 바로 종료해요." : selecting ? "이 창을 닫고 페이지에서 영역을 선택하면 녹화가 시작돼요." : ready ? pending ? "저장이 끝날 때까지 파일을 보관해요." : complete ? "저장 완료 · 새 녹음을 시작할 수 있어요." : "브라우저를 닫기 전에 파일을 저장해 주세요." : recording || paused ? video ? "선택 영역 영상과 현재 탭 소리를 함께 녹화해요." : "현재 탭만 녹음해요 · 최대 2시간 또는 128 MB" : starting ? "잠시만 기다려 주세요. 준비 중에도 종료할 수 있어요." : transitional ? "잠시만 기다려 주세요." : "소리만 녹음하거나, 영역을 선택해 영상으로 저장하세요.");

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

async function armShortcuts() {
  try {
    const response = await request("ARM_SHORTCUTS");
    shortcutConnection = response.ok ? "connected" : "unavailable";
    shortcutDetail = response.ok ? "" : response.error || "이 페이지에 단축키를 연결할 수 없어요.";
  } catch (error) {
    shortcutConnection = "unavailable";
    shortcutDetail = error.message || "이 페이지에 단축키를 연결할 수 없어요.";
  }
  // Permission/injection failures do not interfere with recorder controls or errors.
  ui.shortcutStatus.dataset.status = shortcutConnection;
  ui.shortcutStatus.title = shortcutDetail;
  setText(ui.shortcutStatus, shortcutConnection === "connected"
    ? "이 탭에 연결됨 · 창을 닫아도 1/2 소리 · 3/4 영상"
    : "페이지 숫자키 연결 불가 · 아래 등록 상태와 단축키 설정을 확인해 주세요.");
}

async function loadShortcutAssignments() {
  const assignments = [
    ["start-recording", ui.shortcutAudioStart], ["stop-recording", ui.shortcutAudioStop],
    ["start-video", ui.shortcutVideoStart], ["stop-video", ui.shortcutVideoStop],
  ];
  try {
    const commands = await chrome.commands.getAll();
    if (!Array.isArray(commands)) throw new Error("단축키 목록을 가져오지 못했어요.");
    let missing = false;
    for (const [name, element] of assignments) {
      const shortcut = commands.find((item) => item.name === name)?.shortcut?.trim() || "";
      setText(element, shortcut || "미지정");
      element.dataset.assigned = String(Boolean(shortcut));
      if (!shortcut) missing = true;
    }
    setText(ui.shortcutAssignmentNote, missing
      ? "미지정 키는 설정에서 등록하세요. 다른 단축키와 겹치면 키를 바꿔 주세요."
      : "실제 등록된 키예요. 동작하지 않으면 설정에서 다른 키로 바꿔 주세요.");
  } catch {
    for (const [, element] of assignments) {
      setText(element, "확인 불가");
      element.dataset.assigned = "false";
    }
    setText(ui.shortcutAssignmentNote, "단축키 등록 상태를 가져오지 못했어요. 설정에서 확인해 주세요.");
  }
}

async function command(type, payload = {}) {
  if (busy) return;
  const operationId = ["START", "OPEN_VIDEO_SELECTOR", "PAUSE", "RESUME"].includes(type) ? crypto.randomUUID() : null;
  busy = true;
  activeCommand = type;
  activeOperationId = operationId;
  commandVersion += 1;
  commandError = "";
  connectionError = "";
  render();
  let successful = false;
  try {
    const response = await request(type, operationId ? { ...payload, operationId } : payload);
    if (response.state) state = response.state;
    if (!response.ok) commandError = response.error || "요청을 처리하지 못했어요. 다시 시도해 주세요.";
    successful = response.ok;
  } catch (error) {
    commandError = error.message || "요청을 처리하지 못했어요. 팝업을 다시 열어 주세요.";
  } finally {
    if (queuedStop) {
      const response = await queuedStop.promise;
      // Apply the follow-up last even if its reply arrived before the start reply.
      if (response.state) state = response.state;
      if (!response.ok && !commandError) commandError = response.error || "종료 요청을 처리하지 못했어요. 다시 종료해 주세요.";
      // Keep the popup open after a requested video cancellation.
      successful = false;
    }
    queuedStop = null;
    activeCommand = null;
    activeOperationId = null;
    busy = false;
    commandVersion += 1;
    render();
  }
  return successful;
}

function selectionChanged() {
  stopRangePreview();
  const selection = readSelection();
  renderEditor();
  if (!trimAvailable() || selection.error || busy || state.status !== "ready" || state.download?.status === "pending") return;
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
ui.startVideo.addEventListener("click", () => {
  if (state.status !== "idle" && state.status !== "error") return;
  void command("OPEN_VIDEO_SELECTOR").then((ok) => {
    if (ok) window.close();
  });
});
ui.pause.addEventListener("click", () => {
  if (state.status === "recording" || state.status === "paused") {
    void command(state.status === "paused" ? "RESUME" : "PAUSE");
  }
});
ui.stop.addEventListener("click", () => {
  stopCapture(pendingCaptureMode() || (videoMode() ? "video" : "audio"));
});
document.addEventListener("keydown", (event) => {
  // Shortcuts belong to this popup; preserve typing and native media controls.
  if (event.defaultPrevented || event.repeat || event.isComposing || event.keyCode === 229
    || event.ctrlKey || event.altKey || event.metaKey || event.shiftKey) return;
  const target = event.target;
  if (target instanceof Element && (target.isContentEditable
    || target.closest('input, textarea, select, audio, video, [role="textbox"], [role="spinbutton"]'))) return;
  const stopMode = event.key === "2" ? "audio" : event.key === "4" ? "video" : null;
  if (stopMode && stopCapture(stopMode)) {
    event.preventDefault();
    return;
  }
  if (busy) return;
  const button = event.key === "1" && ["idle", "error"].includes(state.status) ? ui.start
    : event.key === "3" && ["idle", "error"].includes(state.status) ? ui.startVideo : null;
  if (!button || button.disabled || button.closest("[hidden]")) return;
  event.preventDefault();
  button.click();
});
ui.save.addEventListener("click", () => {
  if (state.status === "ready" && state.result && state.download?.status !== "pending") {
    stopRangePreview();
    if (videoResult()) void command("SAVE_VIDEO", { format: ui.saveFormat.value });
    else void command("SAVE");
  }
});
ui.saveFormat.addEventListener("change", render);
ui.shortcutSettings.addEventListener("click", async () => {
  const scheme = /\bEdg\//.test(navigator.userAgent) ? "edge" : "chrome";
  const url = `${scheme}://extensions/shortcuts`;
  ui.shortcutSettings.disabled = true;
  try {
    await chrome.tabs.create({ url });
  } catch {
    setText(ui.shortcutAssignmentNote, `설정을 열지 못했어요. 주소창에 ${url}를 입력해 주세요.`);
  } finally {
    ui.shortcutSettings.disabled = false;
  }
});
ui.saveRange.addEventListener("click", () => {
  const selection = readSelection();
  if (busy || state.status !== "ready" || state.download?.status === "pending" || !trimAvailable() || selection.error) return;
  stopRangePreview();
  void command("SAVE_RANGE", { startSeconds: selection.startSeconds, endSeconds: selection.endSeconds });
});
ui.trimStart.addEventListener("input", selectionChanged);
ui.trimEnd.addEventListener("input", selectionChanged);
for (const input of [ui.trimStart, ui.trimEnd]) {
  input.addEventListener("blur", () => {
    if (!Number.isFinite(input.valueAsNumber)) return;
    const formatted = floorHundredths(input.valueAsNumber).toFixed(2);
    if (input.value !== formatted) {
      input.value = formatted;
      selectionChanged();
    }
  });
}
ui.setTrimStart.addEventListener("click", () => {
  const position = Math.min(Math.max(0, ui.audio.currentTime), durationSeconds() || 0);
  ui.trimStart.value = floorHundredths(position).toFixed(2);
  selectionChanged();
});
ui.setTrimEnd.addEventListener("click", () => {
  const position = Math.min(ui.audio.currentTime, durationSeconds() || 0);
  ui.trimEnd.value = floorHundredths(position).toFixed(2);
  selectionChanged();
});
ui.previewRange.addEventListener("click", async () => {
  if (previewEnd !== null) {
    stopRangePreview();
    return;
  }
  const selection = readSelection();
  if (busy || state.status !== "ready" || state.download?.status === "pending" || !trimAvailable() || selection.error) return;
  try {
    ui.audio.currentTime = selection.startSeconds;
    previewEnd = selection.endSeconds;
    await ui.audio.play();
    if (previewEnd === null || document.hidden) {
      stopRangePreview();
      return;
    }
    setText(ui.previewRange, "구간 듣기 정지");
    startPreviewClock();
  } catch {
    stopRangePreview();
    commandError = "미리 듣기를 시작하지 못했어요. 다시 시도하거나 전체 파일을 저장해 주세요.";
    render();
  }
});
for (const media of [ui.audio, ui.video]) {
  media.addEventListener("timeupdate", () => {
    if (media !== activePreview()) return;
    checkRangePreview();
    renderPreviewPosition();
  });
  media.addEventListener("play", startPreviewClock);
  media.addEventListener("loadedmetadata", renderPreviewPosition);
  media.addEventListener("seeked", renderPreviewPosition);
  media.addEventListener("pause", () => {
    if (media === activePreview()) stopRangePreview(false);
  });
  media.addEventListener("ended", () => {
    if (media === activePreview()) stopRangePreview(false);
  });
}
document.addEventListener("visibilitychange", () => {
  if (document.hidden) stopRangePreview();
});
window.addEventListener("pagehide", () => stopRangePreview());
window.addEventListener("unload", () => stopRangePreview());
ui.discard.addEventListener("click", () => {
  if (busy || state.status !== "ready" || state.download?.status === "pending") return;
  const warning = videoResult()
    ? "새 녹화를 준비하면 현재 영상이 삭제돼요. 필요한 형식으로 모두 저장했나요?"
    : state.exportResult
    ? "새 녹음을 시작하면 전체 원본과 선택 구간이 삭제돼요. 필요한 파일을 모두 저장했나요?"
    : "아직 저장하지 않은 녹음이 있어요. 이 녹음을 삭제하고 새 녹음을 준비할까요?";
  if ((state.download?.status !== "complete" || state.exportResult) && !window.confirm(warning)) return;
  void command("DISCARD");
});

render();
void armShortcuts();
void loadShortcutAssignments();
void poll();
