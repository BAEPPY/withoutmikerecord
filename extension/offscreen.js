import { TabAudioRecorder } from './recorder.js';

// The offscreen document owns the stream, recording and Blob URL even while the
// service worker sleeps or the popup is closed.
const recorder = new TabAudioRecorder({
  onStateChange: (state) => chrome.runtime.sendMessage({
    target: 'background',
    type: 'STATE_CHANGED',
    state,
  }),
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id || sender.tab || message?.target !== 'offscreen') {
    return false;
  }
  recorder.handle(message).then(sendResponse, (error) => sendResponse({
    ok: false,
    error: error?.message || '녹음 요청을 처리하지 못했습니다.',
    state: recorder.getState(),
  }));
  return true;
});
