// 历史数据同步：首次全量分页构建、之后按游标增量补齐。
import { putEntries, getMeta, setMeta } from './db.js';
import { toEntry } from './entry.js';

const BATCH = 1000;

async function searchPage(startTime, endTime) {
  return chrome.history.search({
    text: '',
    startTime,
    endTime,
    maxResults: BATCH,
  });
}

function minLastVisit(items) {
  let min = Infinity;
  for (const item of items) {
    const t = item.lastVisitTime || 0;
    if (t < min) min = t;
  }
  return min;
}

/**
 * 全量构建索引。按 lastVisitTime 倒序分页（search 无 offset，只能用 endTime 游标）。
 * @param {{onProgress?: (info: {count: number, done: boolean}) => void}} options
 */
export async function fullBuild({ onProgress } = {}) {
  let endTime = Date.now() + 1000;
  let fetched = 0;
  let maxLvt = 0;

  for (let guard = 0; guard < 10000; guard++) {
    const items = await searchPage(0, endTime);
    if (!items.length) break;

    const entries = items.map(toEntry).filter(Boolean);
    if (entries.length) {
      await putEntries(entries);
      fetched += entries.length;
      for (const entry of entries) {
        if (entry.lastVisitTime > maxLvt) maxLvt = entry.lastVisitTime;
      }
      onProgress?.({ count: fetched, done: false });
    }

    if (items.length < BATCH) break;

    const min = minLastVisit(items);
    if (!Number.isFinite(min)) break;

    const nextEnd = min - 1;
    if (nextEnd >= endTime) break;
    endTime = nextEnd;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  const now = Date.now();
  await setMeta('lastSyncTime', maxLvt || now);
  await setMeta('builtAt', now);
  onProgress?.({ count: fetched, done: true });
  return fetched;
}

/**
 * 增量同步：拉取 lastSyncTime 之后（留 1s 余量）的记录并 upsert。
 */
export async function incrementalSync({ onProgress } = {}) {
  const last = (await getMeta('lastSyncTime')) || 0;
  if (!last) return fullBuild({ onProgress });

  const startTime = Math.max(0, last - 1000);
  let endTime = Date.now() + 1000;
  let added = 0;
  let maxLvt = last;

  for (let guard = 0; guard < 10000 && endTime >= startTime; guard++) {
    const items = await searchPage(startTime, endTime);
    if (!items.length) break;

    const entries = items.map(toEntry).filter(Boolean);
    if (entries.length) {
      await putEntries(entries);
      added += entries.length;
      for (const entry of entries) {
        if (entry.lastVisitTime > maxLvt) maxLvt = entry.lastVisitTime;
      }
      onProgress?.({ count: added });
    }

    if (items.length < BATCH) break;

    const min = minLastVisit(items);
    if (!Number.isFinite(min)) break;

    const nextEnd = min - 1;
    if (nextEnd >= endTime) break;
    endTime = nextEnd;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  await setMeta('lastSyncTime', Math.max(maxLvt, last));
  return added;
}
