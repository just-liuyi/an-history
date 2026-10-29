// Service Worker：维护索引增量、处理工具栏/快捷键入口、广播页面。
import { toEntry } from './entry.js';
import { putEntries, removeUrls, clearAll, openDB } from './db.js';

function openHistoryPage() {
  chrome.tabs.create({ url: chrome.runtime.getURL('history.html') });
}

chrome.action.onClicked.addListener(openHistoryPage);

chrome.commands.onCommand.addListener((command) => {
  if (command === 'open-history') openHistoryPage();
});

chrome.history.onVisited.addListener((item) => {
  const entry = toEntry(item);
  if (entry) putEntries([entry]).catch(() => {});
});

chrome.history.onVisitRemoved.addListener((details) => {
  if (details.allHistory) {
    clearAll().catch(() => {});
    return;
  }
  if (details.urls && details.urls.length) {
    removeUrls(details.urls).catch(() => {});
  }
});

chrome.runtime.onInstalled.addListener(() => {
  // 安装后预热数据库结构，避免首次打开历史页时再建库。
  openDB().catch(() => {});
});
