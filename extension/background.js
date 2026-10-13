import { createController } from './controller.js';

const controller = createController(chrome);
chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (sender.id !== chrome.runtime.id || message?.target !== 'background') return;
  if (message.type === 'STATE_CHANGED') {
    if (sender.url === chrome.runtime.getURL('offscreen.html')) {
      controller.badge(message.state).catch(console.error);
    }
    return;
  }
  controller.handle(message).then(respond);
  return true;
});

chrome.downloads.onChanged.addListener((delta) => {
  controller.onDownloadChanged(delta).catch(console.error);
});
chrome.tabs.onRemoved.addListener((tabId) => {
  controller.onTabRemoved(tabId).catch(console.error);
});
controller.handle({ type: 'STATUS' }).then(({ state }) => controller.badge(state)).catch(console.error);
