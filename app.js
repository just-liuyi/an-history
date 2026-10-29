import { openDB, getAllEntries, putEntries, removeUrls, clearAll } from './db.js';
import { fullBuild, incrementalSync } from './sync.js';
import { toEntry } from './entry.js';

const ROW_HEIGHT = { header: 56, entry: 48, footer: 24 };
const TOP_PADDING = 8;
const OVERSCAN = 480;
const DELETE_CONCURRENCY = 6;
const SIDEBAR_LIMIT = 600;
const DAY_MS = 86400000;

const $ = (id) => document.getElementById(id);

/** 元素缺失时跳过绑定，避免抛出 "Cannot read properties of null (reading 'addEventListener')"。 */
function on(target, type, handler, options) {
  if (!target || typeof target.addEventListener !== 'function') {
    console.warn('[an-history] skip listener:', type, '(element missing)');
    return;
  }
  target.addEventListener(type, handler, options);
}

const els = {
  toolbar: $('toolbar'),
  menuBtn: $('menuBtn'),
  search: $('search'),
  searchClear: $('searchClear'),
  refresh: $('refresh'),
  syncBadge: $('syncBadge'),
  selClear: $('selClear'),
  selCount: $('selCount'),
  selCancel: $('selCancel'),
  selDelete: $('selDelete'),
  scrim: $('scrim'),
  navAll: $('navAll'),
  allCount: $('allCount'),
  domainFilter: $('domainFilter'),
  domainList: $('domainList'),
  sideFoot: $('sideFoot'),
  clearData: $('clearData'),
  sort: $('sort'),
  rangeBar: $('rangeBar'),
  rangeStart: $('rangeStart'),
  rangeEnd: $('rangeEnd'),
  rangeClear: $('rangeClear'),
  list: $('list'),
  spacer: $('spacer'),
  rows: $('rows'),
  empty: $('empty'),
  emptyTitle: $('emptyTitle'),
  emptyHint: $('emptyHint'),
  loading: $('loading'),
  loadingText: $('loadingText'),
  error: $('error'),
  errorText: $('errorText'),
  retry: $('retry'),
  rowMenu: $('rowMenu'),
  menuFilter: $('menuFilter'),
  menuCopy: $('menuCopy'),
  menuRemove: $('menuRemove'),
  confirm: $('confirm'),
  confirmTitle: $('confirmTitle'),
  confirmText: $('confirmText'),
  confirmOk: $('confirmOk'),
  confirmCancel: $('confirmCancel'),
  toast: $('toast'),
};
const tabButtons = [...document.querySelectorAll('.tab')];

const state = {
  entries: new Map(), // url -> HistoryEntry
  siteGroups: [],
  dateGroups: [],
  rows: [],
  rowEntriesByKey: new Map(),
  offsets: new Float64Array(1),
  view: 'site', // 'site' | 'date'
  filterHost: null,
  query: '',
  sort: 'recent',
  rangeStart: null,
  rangeEnd: null,
  selection: new Set(),
  lastCheckedUrl: null,
  menuUrl: null,
  dirty: false,
  syncing: false,
  deleting: false,
  initialized: false,
  scrollFrame: 0,
};

let refreshTimer = 0;
let toastTimer = 0;
let pendingConfirm = null;

/* ---------------- 格式化 ---------------- */

const timeFmt = new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const dayFmt = new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: 'long', day: 'numeric', weekday: 'long' });
const monthDayFmt = new Intl.DateTimeFormat('zh-CN', { month: 'long', day: 'numeric' });
const yearDayFmt = new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: 'numeric', day: 'numeric' });
const fullFmt = new Intl.DateTimeFormat('zh-CN', {
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
});

function startOfDay(ts) {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function daysAgo(ts) {
  return Math.round((startOfDay(Date.now()) - startOfDay(ts)) / DAY_MS);
}

function dayLabel(dayStart) {
  const base = dayFmt.format(dayStart);
  const diff = daysAgo(dayStart);
  if (diff === 0) return `今天 - ${base}`;
  if (diff === 1) return `昨天 - ${base}`;
  return base;
}

/** 按网站视图里显示的访问时间：今天只显示时刻，其他日期带上日期。 */
function visitLabel(ts) {
  if (!ts) return '';
  const diff = daysAgo(ts);
  if (diff === 0) return timeFmt.format(ts);
  if (diff === 1) return `昨天 ${timeFmt.format(ts)}`;
  if (new Date(ts).getFullYear() === new Date().getFullYear()) {
    return `${monthDayFmt.format(ts)} ${timeFmt.format(ts)}`;
  }
  return yearDayFmt.format(ts);
}

function fullTime(ts) {
  return ts ? fullFmt.format(ts) : '';
}

/* ---------------- 时间范围 ---------------- */

function toDateInputValue(ts) {
  if (ts == null) return '';
  const d = new Date(ts);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function syncRangeInputs() {
  if (!els.rangeStart || !els.rangeEnd) return;
  els.rangeStart.value = toDateInputValue(state.rangeStart);
  els.rangeEnd.value = toDateInputValue(state.rangeEnd);
}

function readRangeFromInputs() {
  const parseDay = (value) => {
    if (!value) return null;
    const ts = new Date(`${value}T00:00:00`).getTime();
    return Number.isFinite(ts) ? ts : null;
  };

  let startDay = parseDay(els.rangeStart.value);
  let endDay = parseDay(els.rangeEnd.value);
  if (startDay != null && endDay != null && startDay > endDay) {
    [startDay, endDay] = [endDay, startDay];
  }

  state.rangeStart = startDay;
  state.rangeEnd = endDay != null ? endDay + DAY_MS - 1 : null;
  syncRangeInputs();
  refreshView({ resetScroll: true });
}

function clearRange() {
  state.rangeStart = null;
  state.rangeEnd = null;
  syncRangeInputs();
  refreshView({ resetScroll: true });
}

function prettyUrl(url) {
  try {
    const u = new URL(url);
    return u.hostname + (u.pathname === '/' ? '' : u.pathname) + u.search;
  } catch {
    return url;
  }
}

function prettyPath(url) {
  try {
    const u = new URL(url);
    let path = u.pathname + u.search;
    try {
      path = decodeURI(path);
    } catch {}
    return path.length > 200 ? `${path.slice(0, 200)}…` : path;
  } catch {
    return url;
  }
}

function matchEntry(entry, query) {
  return (entry.title || '').toLowerCase().includes(query) || entry.url.toLowerCase().includes(query);
}

/* ---------------- 提示与状态层 ---------------- */

function setSyncBadge(text) {
  els.syncBadge.textContent = text || '';
  els.syncBadge.hidden = !text;
}

function toast(message) {
  els.toast.textContent = message;
  els.toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    els.toast.hidden = true;
  }, 3500);
}

function showLoading(text) {
  els.error.classList.add('hidden');
  els.empty.classList.add('hidden');
  els.loading.classList.remove('hidden');
  els.loadingText.textContent = text;
}

function hideLoading() {
  els.loading.classList.add('hidden');
}

function showError(message) {
  hideLoading();
  els.empty.classList.add('hidden');
  els.error.classList.remove('hidden');
  els.errorText.textContent = message;
}

/* ---------------- 分组 ---------------- */

function summarizeGroup(entries) {
  let visits = 0;
  let latest = 0;
  for (const entry of entries) {
    visits += entry.visitCount || 1;
    if (entry.lastVisitTime > latest) latest = entry.lastVisitTime;
  }
  return { count: entries.length, visitCount: visits, lastVisitTime: latest };
}

const byRecent = (a, b) => b.lastVisitTime - a.lastVisitTime || a.url.localeCompare(b.url);

function buildSiteGroups() {
  const map = new Map();
  for (const entry of state.entries.values()) {
    let list = map.get(entry.hostname);
    if (!list) map.set(entry.hostname, (list = []));
    list.push(entry);
  }

  const groups = [];
  for (const [hostname, entries] of map) {
    entries.sort(byRecent);
    groups.push({ key: hostname, kind: 'site', hostname, entries, ...summarizeGroup(entries) });
  }

  groups.sort(
    state.sort === 'alpha'
      ? (a, b) => a.hostname.localeCompare(b.hostname)
      : (a, b) => b.lastVisitTime - a.lastVisitTime || a.hostname.localeCompare(b.hostname),
  );
  return groups;
}

function buildDateGroups() {
  const all = [...state.entries.values()].sort(byRecent);
  const groups = [];
  let current = null;
  for (const entry of all) {
    const day = startOfDay(entry.lastVisitTime);
    if (!current || current.dayStart !== day) {
      current = { key: `day-${day}`, kind: 'date', dayStart: day, entries: [] };
      groups.push(current);
    }
    current.entries.push(entry);
  }
  for (const group of groups) Object.assign(group, summarizeGroup(group.entries));
  return groups;
}

function hasRange() {
  return state.rangeStart != null || state.rangeEnd != null;
}

function rangeBounds() {
  if (!hasRange()) return null;
  return {
    start: state.rangeStart != null ? state.rangeStart : 0,
    end: state.rangeEnd != null ? state.rangeEnd : Number.MAX_SAFE_INTEGER,
  };
}

function computeRows() {
  const query = state.query.trim().toLowerCase();
  const groups = state.view === 'date' ? state.dateGroups : state.siteGroups;
  const bounds = state.view === 'date' ? rangeBounds() : null;
  const rows = [];
  const byKey = new Map();

  for (const group of groups) {
    let list = group.entries;
    if (state.filterHost) {
      if (group.kind === 'site') {
        if (group.key !== state.filterHost) continue;
      } else {
        list = list.filter((entry) => entry.hostname === state.filterHost);
      }
    }
    if (bounds) {
      list = list.filter((entry) => entry.lastVisitTime >= bounds.start && entry.lastVisitTime <= bounds.end);
    }
    if (query) list = list.filter((entry) => matchEntry(entry, query));
    if (!list.length) continue;

    rows.push({ kind: 'header', group, entries: list });
    byKey.set(group.key, list);
    for (const entry of list) rows.push({ kind: 'entry', entry });
    rows.push({ kind: 'footer' });
  }

  const offsets = new Float64Array(rows.length + 1);
  let y = TOP_PADDING;
  for (let i = 0; i < rows.length; i++) {
    offsets[i] = y;
    y += ROW_HEIGHT[rows[i].kind];
  }
  offsets[rows.length] = y;

  state.rows = rows;
  state.rowEntriesByKey = byKey;
  state.offsets = offsets;
  els.spacer.style.height = `${rows.length ? y + 16 : 0}px`;
  els.rows.classList.toggle('view-date', state.view === 'date');
  els.rows.classList.toggle('view-site', state.view === 'site');
}

/* ---------------- 渲染 ---------------- */

function faviconEl(hostname, pageUrl) {
  const box = document.createElement('span');
  box.className = 'fav';

  const letter = document.createElement('span');
  letter.textContent = (hostname || '?').replace(/^www\./, '').slice(0, 1).toUpperCase();
  box.appendChild(letter);

  if (globalThis.chrome && chrome.runtime && chrome.runtime.getURL) {
    const img = document.createElement('img');
    img.className = 'fav-img';
    img.alt = '';
    img.width = 16;
    img.height = 16;
    img.addEventListener('load', () => letter.remove(), { once: true });
    img.addEventListener('error', () => img.remove(), { once: true });
    img.src = `${chrome.runtime.getURL('/_favicon/')}?pageUrl=${encodeURIComponent(pageUrl)}&size=32`;
    box.appendChild(img);
  }
  return box;
}

const MORE_ICON =
  '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 8a2 2 0 1 0 0-4 2 2 0 0 0 0 4m0 2a2 2 0 1 0 0 4 2 2 0 0 0 0-4m0 6a2 2 0 1 0 0 4 2 2 0 0 0 0-4"/></svg>';

function vrow(index, kind) {
  const el = document.createElement('div');
  el.className = `vrow vrow-${kind}`;
  el.style.top = `${state.offsets[index]}px`;
  el.style.height = `${ROW_HEIGHT[kind]}px`;
  return el;
}

function makeCheckbox(action, checked, label) {
  const box = document.createElement('input');
  box.type = 'checkbox';
  box.className = 'row-check';
  box.dataset.action = action;
  box.checked = checked;
  box.setAttribute('aria-label', label);
  return box;
}

function makeHeader(row, index) {
  const { group, entries } = row;
  const el = vrow(index, 'header');
  const card = document.createElement('div');
  card.className = 'card-part card-head';

  let selected = 0;
  for (const entry of entries) if (state.selection.has(entry.url)) selected++;
  const titleText = group.kind === 'site' ? group.hostname : dayLabel(group.dayStart);
  const checkbox = makeCheckbox('select-group', selected > 0 && selected === entries.length, `选择“${titleText}”中的全部记录`);
  checkbox.indeterminate = selected > 0 && selected < entries.length;
  checkbox.dataset.key = group.key;
  card.appendChild(checkbox);

  if (group.kind === 'site') card.appendChild(faviconEl(group.hostname, `https://${group.hostname}/`));

  const title = document.createElement('span');
  title.className = 'card-title';
  title.textContent = titleText;
  title.title = titleText;

  const meta = document.createElement('span');
  meta.className = 'card-meta';
  if (group.kind === 'site') {
    let text = `${group.count} 条记录 · 最近访问 ${visitLabel(group.lastVisitTime)}`;
    if (entries.length !== group.count) text += ` · 匹配 ${entries.length} 条`;
    meta.textContent = text;
  } else {
    meta.textContent = `${entries.length} 条记录`;
  }
  card.append(title, meta);

  if (group.kind === 'site') {
    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'text-btn';
    del.dataset.action = 'del-group';
    del.dataset.key = group.key;
    del.textContent = '全部删除';
    del.title = `删除 ${group.hostname} 的全部历史记录`;
    card.appendChild(del);
  }

  el.appendChild(card);
  return el;
}

function makeEntry(row, index) {
  const entry = row.entry;
  const el = vrow(index, 'entry');
  const card = document.createElement('div');
  const selected = state.selection.has(entry.url);
  card.className = `card-part card-entry${selected ? ' selected' : ''}`;
  card.dataset.url = entry.url;

  const titleText = entry.title || prettyUrl(entry.url);
  const checkbox = makeCheckbox('select-entry', selected, `选择“${titleText}”`);
  checkbox.dataset.url = entry.url;

  const time = document.createElement('span');
  time.className = 'entry-time';
  time.textContent = state.view === 'date' ? timeFmt.format(entry.lastVisitTime) : visitLabel(entry.lastVisitTime);
  time.title = fullTime(entry.lastVisitTime);

  const link = document.createElement('a');
  link.className = 'entry-title';
  link.href = entry.url;
  link.textContent = titleText;
  link.title = entry.url;

  const sub = document.createElement('span');
  sub.className = 'entry-sub';
  sub.textContent = state.view === 'date' ? entry.hostname : prettyPath(entry.url);
  sub.title = entry.url;

  const more = document.createElement('button');
  more.type = 'button';
  more.className = 'icon-btn entry-more';
  more.dataset.action = 'menu';
  more.dataset.url = entry.url;
  more.title = '更多操作';
  more.setAttribute('aria-label', `“${titleText}”的更多操作`);
  more.setAttribute('aria-haspopup', 'menu');
  more.innerHTML = MORE_ICON;

  card.append(checkbox, time, faviconEl(entry.hostname, entry.url), link, sub, more);
  el.appendChild(card);
  return el;
}

function makeFooter(index) {
  const el = vrow(index, 'footer');
  const card = document.createElement('div');
  card.className = 'card-part card-foot';
  el.appendChild(card);
  return el;
}

function findRowIndex(offset) {
  const offsets = state.offsets;
  let lo = 0;
  let hi = state.rows.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (offsets[mid + 1] <= offset) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function render() {
  const total = state.rows.length;
  if (!total) {
    els.rows.replaceChildren();
    return;
  }
  const top = els.list.scrollTop;
  const viewport = els.list.clientHeight || 800;
  const start = findRowIndex(top - OVERSCAN);
  const end = Math.min(total, findRowIndex(top + viewport + OVERSCAN) + 1);

  const fragment = document.createDocumentFragment();
  for (let i = start; i < end; i++) {
    const row = state.rows[i];
    if (row.kind === 'header') fragment.appendChild(makeHeader(row, i));
    else if (row.kind === 'entry') fragment.appendChild(makeEntry(row, i));
    else fragment.appendChild(makeFooter(i));
  }
  els.rows.replaceChildren(fragment);
}

let sidebarSignature = '';

function renderSidebar() {
  els.navAll.classList.toggle('active', !state.filterHost);
  els.navAll.setAttribute('aria-current', state.filterHost ? 'false' : 'page');
  els.allCount.textContent = state.entries.size ? String(state.entries.size) : '';

  const query = els.domainFilter.value.trim().toLowerCase();
  const groups = query ? state.siteGroups.filter((g) => g.hostname.includes(query)) : state.siteGroups;
  const footprint = `${query}|${state.filterHost || ''}|${groups
    .slice(0, SIDEBAR_LIMIT)
    .map((g) => `${g.hostname}:${g.count}`)
    .join(',')}|${groups.length}|${state.entries.size}`;

  // 内容没有变化时保留已有 DOM：频繁重建会在点击瞬间把按钮换掉，造成“点了没反应”。
  if (footprint === sidebarSignature) {
    els.sideFoot.textContent = `${state.siteGroups.length} 个网站 · ${state.entries.size} 条记录`;
    return;
  }
  sidebarSignature = footprint;

  const fragment = document.createDocumentFragment();

  for (const group of groups.slice(0, SIDEBAR_LIMIT)) {
    const button = document.createElement('button');
    button.type = 'button';
    const active = state.filterHost === group.hostname;
    button.className = `nav-item domain-item${active ? ' active' : ''}`;
    button.dataset.host = group.hostname;
    button.title = `${group.hostname}（${group.count} 条记录）`;
    if (active) button.setAttribute('aria-current', 'page');

    const label = document.createElement('span');
    label.className = 'nav-label';
    label.textContent = group.hostname;

    const count = document.createElement('span');
    count.className = 'nav-count';
    count.textContent = String(group.count);

    button.append(faviconEl(group.hostname, `https://${group.hostname}/`), label, count);
    fragment.appendChild(button);
  }

  if (groups.length > SIDEBAR_LIMIT) {
    const note = document.createElement('div');
    note.className = 'nav-note';
    note.textContent = `还有 ${groups.length - SIDEBAR_LIMIT} 个网站，请使用上方筛选`;
    fragment.appendChild(note);
  } else if (!groups.length && state.siteGroups.length) {
    const note = document.createElement('div');
    note.className = 'nav-note';
    note.textContent = '没有匹配的网站';
    fragment.appendChild(note);
  }

  els.domainList.replaceChildren(fragment);
  els.sideFoot.textContent = `${state.siteGroups.length} 个网站 · ${state.entries.size} 条记录`;
}

function updateEmptyState() {
  const show = state.initialized && state.rows.length === 0;
  els.empty.classList.toggle('hidden', !show);
  if (!show) return;

  if (state.entries.size === 0) {
    els.emptyTitle.textContent = '暂无历史记录';
    els.emptyHint.textContent = '浏览网页后，记录会显示在这里。';
  } else if (state.query.trim()) {
    els.emptyTitle.textContent = '未找到任何结果';
    els.emptyHint.textContent = state.filterHost
      ? `在 ${state.filterHost} 中没有匹配“${state.query.trim()}”的记录。`
      : `没有匹配“${state.query.trim()}”的记录。`;
  } else if (state.view === 'date' && hasRange()) {
    els.emptyTitle.textContent = '所选时间范围内没有记录';
    els.emptyHint.textContent = '调整开始或结束日期，或点击“清除”查看全部时间。';
  } else {
    els.emptyTitle.textContent = '该网站没有历史记录';
    els.emptyHint.textContent = '在左侧选择“全部网站”查看其他记录。';
  }
}

function updateSelectionBar() {
  const count = state.selection.size;
  els.toolbar.classList.toggle('selecting', count > 0);
  els.selCount.textContent = `已选择 ${count} 项`;
}

function updateTabs() {
  for (const tab of tabButtons) {
    const active = tab.dataset.view === state.view;
    tab.classList.toggle('active', active);
    tab.setAttribute('aria-selected', String(active));
  }
  els.sort.hidden = state.view !== 'site';
  if (els.rangeBar) els.rangeBar.hidden = state.view !== 'date';
}

function refreshView({ resetScroll = false } = {}) {
  computeRows();
  if (resetScroll) els.list.scrollTop = 0;
  render();
  updateEmptyState();
}

function refreshAll() {
  state.siteGroups = buildSiteGroups();
  state.dateGroups = buildDateGroups();
  if (state.filterHost && !state.siteGroups.some((g) => g.key === state.filterHost)) {
    state.filterHost = null;
  }
  for (const url of [...state.selection]) {
    if (!state.entries.has(url)) state.selection.delete(url);
  }
  computeRows();
  renderSidebar();
  render();
  updateEmptyState();
  updateSelectionBar();
}

function scheduleRefresh() {
  // 批量删除期间不重建界面：每删一条都会触发 onVisitRemoved，
  // 逐条刷新会造成卡顿，也会让侧边栏在点击瞬间被重建，出现“点了没反应”。
  if (state.deleting) return;
  if (document.hidden) {
    state.dirty = true;
    return;
  }
  if (refreshTimer) return;
  refreshTimer = setTimeout(() => {
    refreshTimer = 0;
    refreshAll();
  }, 180);
}

/* ---------------- 导航动作 ---------------- */

function closeDrawer() {
  document.body.classList.remove('drawer-open');
  els.scrim.hidden = true;
}

function setFilterHost(host) {
  state.filterHost = host || null;
  closeMenu();
  closeDrawer();
  renderSidebar();
  refreshView({ resetScroll: true });
}

function setView(view) {
  if (view !== 'site' && view !== 'date') return;
  if (state.view === view) return;
  state.view = view;
  closeMenu();
  updateTabs();
  refreshView({ resetScroll: true });
}

function setQuery(value) {
  state.query = value;
  els.searchClear.hidden = !value;
  closeMenu();
  refreshView({ resetScroll: true });
}

/* ---------------- 选择 ---------------- */

/**
 * 只更新可见行的选中样式，不重建列表 DOM。
 * 重建会让正在点击的复选框被替换掉，表现为“连续勾选只生效一条”。
 */
function syncSelectionDom() {
  for (const card of els.rows.querySelectorAll('.card-entry')) {
    const box = card.querySelector('input.row-check');
    const selected = state.selection.has(card.dataset.url);
    card.classList.toggle('selected', selected);
    if (box) box.checked = selected;
  }
  for (const head of els.rows.querySelectorAll('.card-head')) {
    const box = head.querySelector('input.row-check');
    if (!box) continue;
    const entries = state.rowEntriesByKey.get(box.dataset.key) || [];
    let selected = 0;
    for (const entry of entries) if (state.selection.has(entry.url)) selected++;
    box.checked = entries.length > 0 && selected === entries.length;
    box.indeterminate = selected > 0 && selected < entries.length;
  }
  updateSelectionBar();
}

function setSelected(urls, selected) {
  for (const url of urls) {
    if (selected) state.selection.add(url);
    else state.selection.delete(url);
  }
  syncSelectionDom();
}

function entryUrlsBetween(fromUrl, toUrl) {
  const urls = [];
  let inside = false;
  for (const row of state.rows) {
    if (row.kind !== 'entry') continue;
    const url = row.entry.url;
    const edge = url === fromUrl || url === toUrl;
    if (edge && !inside) {
      inside = true;
      urls.push(url);
      if (fromUrl === toUrl) break;
      continue;
    }
    if (inside) {
      urls.push(url);
      if (edge) break;
    }
  }
  return urls;
}

function clearSelection() {
  state.selection.clear();
  state.lastCheckedUrl = null;
  syncSelectionDom();
}

/* ---------------- 行菜单 ---------------- */

function openMenu(url, anchor) {
  const entry = state.entries.get(url);
  if (!entry) return;
  state.menuUrl = url;
  els.menuFilter.textContent = `更多来自 ${entry.hostname} 的记录`;
  els.menuFilter.hidden = state.filterHost === entry.hostname;
  els.rowMenu.hidden = false;

  const rect = anchor.getBoundingClientRect();
  const width = els.rowMenu.offsetWidth;
  const height = els.rowMenu.offsetHeight;
  let top = rect.bottom + 4;
  if (top + height > window.innerHeight - 8) top = Math.max(8, rect.top - height - 4);
  const left = Math.max(8, Math.min(rect.right - width, window.innerWidth - width - 8));
  els.rowMenu.style.top = `${top}px`;
  els.rowMenu.style.left = `${left}px`;

  const first = [...els.rowMenu.querySelectorAll('.menu-item')].find((item) => !item.hidden);
  first?.focus();
}

function closeMenu() {
  if (els.rowMenu.hidden) return;
  els.rowMenu.hidden = true;
  state.menuUrl = null;
}

/* ---------------- 加载 ---------------- */

async function loadData() {
  showLoading('正在读取历史记录…');

  let all = await getAllEntries();
  state.entries = new Map(all.map((entry) => [entry.url, entry]));

  if (state.entries.size === 0) {
    showLoading('正在整理历史记录…');
    await fullBuild({
      onProgress: ({ count }) => {
        if (count) showLoading(`正在整理历史记录… 已读取 ${count.toLocaleString('zh-CN')} 条`);
      },
    });
  } else {
    setSyncBadge('正在同步…');
    try {
      await incrementalSync();
    } catch (err) {
      console.warn('[an-history] incremental sync failed', err);
    }
    setSyncBadge('');
  }

  all = await getAllEntries();
  state.entries = new Map(all.map((entry) => [entry.url, entry]));
  hideLoading();
}

function applyUrlParams() {
  const params = new URLSearchParams(location.search);
  const query = params.get('q');
  if (query) {
    els.search.value = query;
    state.query = query;
    els.searchClear.hidden = false;
  }
  const host = params.get('host');
  if (host) state.filterHost = host.toLowerCase();
  if (params.get('view') === 'date') state.view = 'date';
}

async function init() {
  const missing = Object.entries(els)
    .filter(([, el]) => !el)
    .map(([name]) => name);
  if (missing.length) {
    console.error('[an-history] 页面缺少元素：', missing.join(', '));
    const notice = document.createElement('p');
    notice.style.cssText = 'margin:48px auto;max-width:520px;text-align:center;font:14px/1.6 system-ui,sans-serif;';
    notice.textContent = '页面文件与脚本版本不一致，请在 chrome://extensions 中重新加载 an-history，然后刷新本页。';
    document.body.replaceChildren(notice);
    return;
  }

  bindEvents();
  applyUrlParams();
  updateTabs();
  syncRangeInputs();

  if (!globalThis.chrome || !chrome.history) {
    showError('当前环境无法访问浏览器历史记录接口，请通过扩展打开本页。');
    return;
  }

  try {
    await openDB();
    await loadData();
  } catch (err) {
    console.error('[an-history] init failed', err);
    showError(`读取历史记录失败：${err && err.message ? err.message : err}`);
    return;
  }

  state.initialized = true;
  refreshAll();
  startRealtime();

  let lastDay = startOfDay(Date.now());
  setInterval(() => {
    if (document.hidden) return;
    const today = startOfDay(Date.now());
    if (today !== lastDay) {
      lastDay = today;
      refreshAll();
    } else {
      render();
    }
  }, 60000);
}

/* ---------------- 实时事件 ---------------- */

function startRealtime() {
  chrome.history.onVisited.addListener((item) => {
    const entry = toEntry(item);
    if (!entry) return;
    state.entries.set(entry.url, entry);
    putEntries([entry]).catch(() => {});
    scheduleRefresh();
  });

  chrome.history.onVisitRemoved.addListener(({ allHistory, urls }) => {
    if (allHistory) {
      state.entries.clear();
      state.selection.clear();
      clearAll().catch(() => {});
    } else if (urls && urls.length) {
      for (const url of urls) {
        state.entries.delete(url);
        state.selection.delete(url);
      }
    }
    scheduleRefresh();
  });

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && state.dirty) {
      state.dirty = false;
      refreshAll();
    }
  });
}

/* ---------------- 删除 ---------------- */

async function performDelete(urls) {
  const unique = [...new Set(urls)].filter((url) => state.entries.has(url));
  if (!unique.length || state.deleting) return;

  const snapshot = new Map(unique.map((url) => [url, state.entries.get(url)]));

  // 先在界面上移除，删除在后台继续，避免弹窗卡住或界面长时间无响应。
  state.deleting = true;
  for (const url of unique) {
    state.entries.delete(url);
    state.selection.delete(url);
  }
  refreshAll();
  setSyncBadge(`正在删除 0/${unique.length}`);

  const result = { ok: 0, fail: 0 };
  const failed = [];
  const queue = unique.slice();
  let done = 0;
  const bump = () => {
    done++;
    if (done % 20 === 0 || done === unique.length) setSyncBadge(`正在删除 ${done}/${unique.length}`);
  };

  const workers = Array.from({ length: Math.min(DELETE_CONCURRENCY, queue.length) }, async () => {
    while (queue.length) {
      const url = queue.pop();
      try {
        await chrome.history.deleteUrl({ url });
        result.ok++;
      } catch (err) {
        result.fail++;
        failed.push(url);
        console.warn('[an-history] deleteUrl failed', url, err);
      }
      bump();
      // 让出主线程，保证删除过程中界面仍可点击
      if (done % 10 === 0) await new Promise((resolve) => setTimeout(resolve, 0));
    }
  });
  await Promise.all(workers);

  const failedSet = new Set(failed);
  try {
    await removeUrls(unique.filter((url) => !failedSet.has(url)));
  } catch (err) {
    console.warn('[an-history] db remove failed', err);
  }

  for (const url of failed) {
    const entry = snapshot.get(url);
    if (entry) state.entries.set(url, entry);
  }

  state.deleting = false;
  setSyncBadge('');
  refreshAll();
  toast(result.fail ? `已删除 ${result.ok} 条，${result.fail} 条删除失败` : `已删除 ${result.ok} 条记录`);
}

function visitTotal(urls) {
  let visits = 0;
  for (const url of urls) {
    const entry = state.entries.get(url);
    if (entry) visits += entry.visitCount || 1;
  }
  return visits;
}

function askConfirm({ title, text, okText = '删除', onOk }) {
  closeMenu();
  els.confirmTitle.textContent = title;
  els.confirmText.textContent = text;
  els.confirmOk.textContent = okText;
  els.confirmOk.disabled = false;
  pendingConfirm = onOk;
  els.confirm.showModal();
  els.confirmCancel.focus();
}

function askDeleteUrls(urls) {
  const list = [...new Set(urls)].filter((url) => state.entries.has(url));
  if (!list.length) return;
  const visits = visitTotal(list);

  if (list.length === 1) {
    const entry = state.entries.get(list[0]);
    askConfirm({
      title: '从历史记录中移除？',
      text: `将移除“${entry.title || prettyUrl(entry.url)}”的全部 ${visits} 次访问记录。`,
      onOk: () => performDelete(list),
    });
    return;
  }

  askConfirm({
    title: '删除所选项？',
    text: `将删除所选的 ${list.length} 个网址，共 ${visits} 次访问记录。`,
    onOk: () => performDelete(list),
  });
}

function askDeleteGroup(key) {
  const group = state.siteGroups.find((item) => item.key === key);
  if (!group) return;
  const urls = group.entries.map((entry) => entry.url);
  askConfirm({
    title: `删除 ${group.hostname} 的全部记录？`,
    text: `该网站共有 ${group.count} 个网址、${group.visitCount} 次访问记录，将全部删除。`,
    onOk: () => performDelete(urls),
  });
}

/* ---------------- 事件绑定 ---------------- */

function bindEvents() {
  let searchTimer = 0;
  on(els.search, 'input', () => {
    els.searchClear.hidden = !els.search.value;
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => setQuery(els.search.value), 150);
  });
  on(els.searchClear, 'click', () => {
    els.search.value = '';
    setQuery('');
    els.search.focus();
  });

  on(els.refresh, 'click', async () => {
    if (state.syncing || !state.initialized) return;
    state.syncing = true;
    els.refresh.disabled = true;
    setSyncBadge('正在同步…');
    try {
      await incrementalSync();
      const all = await getAllEntries();
      state.entries = new Map(all.map((entry) => [entry.url, entry]));
      refreshAll();
      toast('已同步最新历史记录');
    } catch (err) {
      console.warn('[an-history] manual sync failed', err);
      toast(`同步失败：${err && err.message ? err.message : err}`);
    } finally {
      state.syncing = false;
      els.refresh.disabled = false;
      setSyncBadge('');
    }
  });

  on(els.selClear, 'click', clearSelection);
  on(els.selCancel, 'click', clearSelection);
  on(els.selDelete, 'click', () => askDeleteUrls([...state.selection]));

  on(els.navAll, 'click', () => setFilterHost(null));
  on(els.domainList, 'click', (event) => {
    const button = event.target.closest('.domain-item');
    if (button) setFilterHost(button.dataset.host);
  });
  on(els.domainFilter, 'input', renderSidebar);

  on(els.clearData, 'click', () => {
    chrome.tabs.create({ url: 'chrome://settings/clearBrowserData' });
  });

  on(els.menuBtn, 'click', () => {
    const open = !document.body.classList.contains('drawer-open');
    document.body.classList.toggle('drawer-open', open);
    els.scrim.hidden = !open;
  });
  on(els.scrim, 'click', closeDrawer);

  for (const tab of tabButtons) {
    tab.addEventListener('click', () => setView(tab.dataset.view));
  }

  on(els.sort, 'change', () => {
    state.sort = els.sort.value;
    refreshAll();
    els.list.scrollTop = 0;
    render();
  });

  on(els.rangeStart, 'change', readRangeFromInputs);
  on(els.rangeEnd, 'change', readRangeFromInputs);
  on(els.rangeClear, 'click', clearRange);

  on(els.rows, 'click', (event) => {
    const checkbox = event.target.closest('input.row-check');
    if (checkbox) {
      if (checkbox.dataset.action === 'select-entry') {
        const url = checkbox.dataset.url;
        if (event.shiftKey && state.lastCheckedUrl && state.entries.has(state.lastCheckedUrl)) {
          setSelected(entryUrlsBetween(state.lastCheckedUrl, url), checkbox.checked);
        } else {
          setSelected([url], checkbox.checked);
        }
        state.lastCheckedUrl = url;
      } else if (checkbox.dataset.action === 'select-group') {
        setSelected(state.rowEntriesByKey.get(checkbox.dataset.key)?.map((e) => e.url) || [], checkbox.checked);
      }
      return;
    }

    const menuButton = event.target.closest('[data-action="menu"]');
    if (menuButton) {
      event.stopPropagation();
      if (state.menuUrl === menuButton.dataset.url) closeMenu();
      else openMenu(menuButton.dataset.url, menuButton);
      return;
    }

    const groupDelete = event.target.closest('[data-action="del-group"]');
    if (groupDelete) askDeleteGroup(groupDelete.dataset.key);
  });

  on(els.menuFilter, 'click', () => {
    const entry = state.entries.get(state.menuUrl);
    if (entry) setFilterHost(entry.hostname);
  });
  on(els.menuCopy, 'click', async () => {
    const url = state.menuUrl;
    closeMenu();
    try {
      await navigator.clipboard.writeText(url);
      toast('已复制链接');
    } catch {
      toast('无法复制链接');
    }
  });
  on(els.menuRemove, 'click', () => {
    const url = state.menuUrl;
    closeMenu();
    if (url) askDeleteUrls([url]);
  });

  document.addEventListener('pointerdown', (event) => {
    if (!els.rowMenu.hidden && !els.rowMenu.contains(event.target) && !event.target.closest('[data-action="menu"]')) {
      closeMenu();
    }
  });

  on(els.list, 
    'scroll',
    () => {
      closeMenu();
      if (state.scrollFrame) return;
      state.scrollFrame = requestAnimationFrame(() => {
        state.scrollFrame = 0;
        render();
      });
    },
    { passive: true },
  );

  window.addEventListener('resize', () => {
    closeMenu();
    render();
  });

  on(els.confirmCancel, 'click', () => {
    pendingConfirm = null;
    els.confirm.close();
  });
  on(els.confirmOk, 'click', () => {
    const task = pendingConfirm;
    pendingConfirm = null;
    if (!task) return;
    // 立刻关闭弹窗，删除进度通过顶栏提示展示，避免模态框长时间挡住页面。
    if (els.confirm.open) els.confirm.close();
    task().catch((err) => {
      console.error('[an-history] delete failed', err);
      toast(`删除失败：${err && err.message ? err.message : err}`);
    });
  });
  on(els.confirm, 'cancel', () => {
    pendingConfirm = null;
  });

  on(els.retry, 'click', () => location.reload());

  document.addEventListener('keydown', (event) => {
    const active = document.activeElement;
    const typing = active && (active.tagName === 'INPUT' || active.tagName === 'SELECT' || active.isContentEditable);

    if (event.key === '/' && !typing) {
      event.preventDefault();
      els.search.focus();
      return;
    }

    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'f') {
      event.preventDefault();
      els.search.focus();
      els.search.select();
      return;
    }

    if (event.key === 'Delete' && !typing && state.selection.size && !els.confirm.open) {
      event.preventDefault();
      askDeleteUrls([...state.selection]);
      return;
    }

    if (event.key === 'Escape') {
      if (els.confirm.open) return;
      if (!els.rowMenu.hidden) {
        closeMenu();
      } else if (document.body.classList.contains('drawer-open')) {
        closeDrawer();
      } else if (state.selection.size) {
        clearSelection();
      } else if (active === els.search && els.search.value) {
        els.search.value = '';
        setQuery('');
      }
    }
  });
}

init().catch((err) => console.error('[an-history] init crashed', err));
