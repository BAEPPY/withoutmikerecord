import { createController } from './controller.js';

const controller = createController(chrome);
chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (sender.id !== chrome.runtime.id || message?.target !== 'background') return;
  if (sender.tab) {
    if (message.type !== 'PAGE_SHORTCUT' || sender.frameId !== 0 ||
        !['1', '2'].includes(message.key) || !Number.isInteger(sender.tab.id)) return;
    controller.handle({
      type: message.key === '1' ? 'START' : 'PAGE_STOP', targetTabId: sender.tab.id,
    }).then(respond);
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
    : command === 'stop-recording' ? 'PAGE_STOP' : null;
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
controller.handle({ type: 'STATUS' }).then(({ state }) => controller.badge(state)).catch(console.error);
