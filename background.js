// Service Worker：维护索引增量、处理工具栏/快捷键入口、广播页面。
import { toEntry } from './entry.js';
import { putEntries, removeUrls, clearAll, openDB } from './db.js';

function openHistoryPage() {
  chrome.tabs.create({ url: chrome.runtime.getURL('history.html') });
}

/**
 * 扩展安装/更新或浏览器启动前就已经打开的 chrome://history 标签，
 * 会一直停留在原生历史页（Chrome 不会为已打开的标签重新应用覆盖页）。
 * 这里主动刷新这些标签，让它们切换到 an-history。
 */
async function refreshStaleHistoryTabs() {
  try {
    const tabs = await chrome.tabs.query({});
    await Promise.all(
      tabs
        .filter((tab) => typeof tab.url === 'string' && tab.url.startsWith('chrome://history'))
        .map((tab) => chrome.tabs.reload(tab.id).catch(() => {})),
    );
  } catch (err) {
    console.warn('[an-history] 刷新历史页标签失败', err);
  }
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
  refreshStaleHistoryTabs();
});

chrome.runtime.onStartup.addListener(() => {
  refreshStaleHistoryTabs();
});
