// 将 chrome.history.HistoryItem 归一化为本插件使用的 HistoryEntry。
// 只保留 http/https 记录：chrome://、file://、扩展页等不参与域名分组。
export function toEntry(item) {
  const url = item && item.url;
  if (!url) return null;

  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;

  const hostname = parsed.hostname.toLowerCase();
  if (!hostname) return null;

  return {
    url,
    title: item.title || '',
    hostname,
    lastVisitTime: item.lastVisitTime || 0,
    visitCount: item.visitCount || 0,
    typedCount: item.typedCount || 0,
  };
}
