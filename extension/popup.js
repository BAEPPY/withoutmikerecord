"use strict";

const byId = (id) => document.getElementById(id);
const ui = {
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
  ready: "녹음 완료",
  error: "녹음 확인 필요",
};

let state = { status: "loading", elapsedMs: 0, bytes: 0, level: 0 };
let busy = false;
let commandError = "";
let connectionError = "";
let commandVersion = 0;

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

function render() {
  const status = state.status;
  const recording = status === "recording";
  const paused = status === "paused";
  const ready = status === "ready";
  const transitional = status === "starting" || status === "stopping";
  const download = state.download || {};
  const pending = download.status === "pending";
  const complete = download.status === "complete";
  const interrupted = download.status === "interrupted";
  const totalSeconds = Math.max(0, Math.floor((Number(state.elapsedMs) || 0) / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const mmss = `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
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
  ui.save.disabled = busy || pending || !state.result;
  ui.discard.disabled = busy || pending;
  setText(ui.save, pending ? "다운로드 진행 중…" : interrupted ? "저장 다시 시도 · .mp4" : complete ? "다시 저장 · .mp4" : "파일 저장 · .mp4");
  setText(ui.hint, ready ? pending ? "저장이 끝날 때까지 녹음 파일을 보관해요." : complete ? "저장 완료 · 새 녹음을 시작할 수 있어요." : "브라우저를 닫기 전에 파일을 저장해 주세요." : recording || paused ? "현재 탭만 녹음해요 · 최대 2시간 또는 128 MB" : transitional ? "잠시만 기다려 주세요." : "먼저 페이지에서 소리를 재생해 주세요.");

  const error = commandError || connectionError || state.error || (interrupted ? download.error || "다운로드가 중단됐어요. 저장을 다시 시도해 주세요." : "");
  setText(ui.error, error);
  ui.error.hidden = !error;
  const notice = [state.notice, ready && complete ? "다운로드가 완료됐어요. 브라우저의 다운로드 목록에서 확인하세요." : ""].filter(Boolean).join(" ");
  setText(ui.notice, notice);
  ui.notice.hidden = !notice;
}

async function request(type) {
  const response = await chrome.runtime.sendMessage({ target: "background", type });
  if (!response || typeof response.ok !== "boolean") {
    throw new Error("확장 프로그램에 연결하지 못했어요. 팝업을 다시 열어 주세요.");
  }
  return response;
}

async function command(type) {
  if (busy) return;
  busy = true;
  commandVersion += 1;
  commandError = "";
  connectionError = "";
  render();
  try {
    const response = await request(type);
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

async function poll() {
  if (!busy) {
    const version = commandVersion;
    try {
      const response = await request("STATUS");
      if (!busy && version === commandVersion) {
        if (response.state) state = response.state;
        connectionError = response.ok ? "" : response.error || "녹음 상태를 확인하지 못했어요.";
        render();
      }
    } catch (error) {
      if (!busy && version === commandVersion) {
        connectionError = error.message || "연결을 확인하고 팝업을 다시 열어 주세요.";
        render();
      }
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
ui.save.addEventListener("click", () => {
  if (state.status === "ready" && state.result && state.download?.status !== "pending") void command("SAVE");
});
ui.discard.addEventListener("click", () => {
  if (busy || state.status !== "ready" || state.download?.status === "pending") return;
  if (state.download?.status !== "complete" && !window.confirm("아직 저장하지 않은 녹음이 있어요. 이 녹음을 삭제하고 새 녹음을 준비할까요?")) return;
  void command("DISCARD");
});

render();
void poll();
