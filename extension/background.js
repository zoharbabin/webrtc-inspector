// #37 "Test this stream" — registers the right-click menu entry and relays
// the click to extension/overlay.js (a content script; the service worker
// itself has no DOM to overlay onto).
chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: 'wrtc-test-stream',
      title: 'Test this stream',
      contexts: ['video', 'audio'],
    });
  });
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId !== 'wrtc-test-stream' || !tab || tab.id === undefined) return;
  chrome.tabs.sendMessage(tab.id, { type: 'wrtc-test-stream' }, info.frameId !== undefined ? { frameId: info.frameId } : undefined);
});
