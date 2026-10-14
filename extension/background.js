import { createController } from './controller.js';

const controller = createController(chrome);
chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (sender.id !== chrome.runtime.id || message?.target !== 'background') return;
  if (sender.tab) {
    if (sender.frameId !== 0 || !Number.isInteger(sender.tab.id)) return;
    let command;
    if (message.type === 'PAGE_SHORTCUT' && ['1', '2', '3', '4'].includes(message.key)) {
      command = { type: { 1: 'START', 2: 'PAGE_STOP', 3: 'BEGIN_VIDEO', 4: 'STOP_VIDEO' }[message.key] };
    } else if (message.type === 'VIDEO_REGION_SELECTED' && typeof message.selectionToken === 'string') {
      command = { type: 'START_VIDEO', region: message.region, selectionToken: message.selectionToken };
    } else if (message.type === 'CANCEL_VIDEO_SELECTION' && typeof message.selectionToken === 'string') {
      command = { type: 'CANCEL_VIDEO', selectionToken: message.selectionToken };
    } else return;
    controller.handle({ ...command, targetTabId: sender.tab.id }).then(respond);
    return true;
  }
  if (message.type === 'STATE_CHANGED') {
    if (sender.url === chrome.runtime.getURL('offscreen.html')) {
      controller.badge(message.state).catch(console.error);
    }
    return;
  }
  if (sender.url !== chrome.runtime.getURL('popup.html') || message.type === 'PAGE_SHORTCUT') return;
  controller.handle(message).then(respond);
  return true;
});

chrome.commands.onCommand.addListener((command, tab) => {
  if (!Number.isInteger(tab?.id)) return;
  const type = command === 'start-recording' ? 'START'
    : command === 'stop-recording' ? 'PAGE_STOP'
      : command === 'start-video' ? 'OPEN_VIDEO_SELECTOR'
        : command === 'stop-video' ? 'STOP_VIDEO' : null;
  if (type) controller.handle({ type, targetTabId: tab.id }).then(async (reply) => {
    if (!reply.ok) {
      await chrome.action.setBadgeText({ text: '!' });
      await chrome.action.setTitle({ title: reply.error });
    }
  }).catch(console.error);
});

chrome.downloads.onChanged.addListener((delta) => {
  controller.onDownloadChanged(delta).catch(console.error);
});
chrome.tabs.onRemoved.addListener((tabId) => {
  controller.onTabRemoved(tabId).catch(console.error);
});
chrome.tabs.onUpdated.addListener((tabId, change) => {
  controller.onTabUpdated(tabId, change).catch(console.error);
});
controller.handle({ type: 'STATUS' }).then(({ state }) => controller.badge(state)).catch(console.error);
