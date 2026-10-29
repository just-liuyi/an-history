# an-history 浏览器历史记录增强插件 · 需求分析与技术方案

| 项目 | 内容 |
| --- | --- |
| 文档版本 | v0.1（草案，待评审） |
| 日期 | 2026-10-29 |
| 当前环境 | Windows；Chrome 154.0.8037.98；Edge 156.0.4314.50 |
| 状态 | 需求已梳理，技术路线已确定，待确认问题见第 10 章 |

---

## 1. 背景与目标

### 1.1 现状痛点

Chrome 原生历史记录页（`chrome://history`）有两个明显不足：

1. **只能平铺**：所有访问按时间混在一起，找某个站点的记录只能搜索或翻页，无法"按站点聚合"。
2. **删除粒度粗、操作繁琐**：删除一条记录要逐条点击；而且删完之后，地址栏（omnibox）仍然会把访问过的 URL 作为自动补全候选，除非去清空全部历史。

### 1.2 产品目标

用浏览器扩展**接管 `chrome://history` 页面**，提供一个"以域名为中心"的历史管理界面：

- 按域名分组展示历史记录；
- 组内按访问时间倒序，分组本身按最近访问时间倒序；
- 支持单条删除、按域名整组删除、多选批量删除；
- 删除直接作用于浏览器历史数据库，使该 URL 不再出现在地址栏的历史补全中（边界见 4.4）。

### 1.3 一句话定义

> 一个纯本地、零网络的 Chrome 扩展：把"按时间平铺"的原生历史页，替换成"按域名分组 + 时间倒序 + 精准删除"的历史管理器。

---

## 2. 需求范围

### 2.1 核心诉求拆解（来自用户描述）

| # | 原始诉求 | 需求解读 | 对应能力 |
| --- | --- | --- | --- |
| R1 | 重写浏览器的历史记录功能 | 不是旁路做一个侧边栏，而是**替换 `chrome://history` 页面本身** | `chrome_url_overrides.history` |
| R2 | 历史记录支持按域名分类 | 以 URL 的 hostname 为分组键聚合 | `chrome.history.search` + hostname 归一化 |
| R3 | 分类后记录按时间排序 | 组内 `lastVisitTime` 倒序；域名列表按组内最近时间倒序 | 前端排序 |
| R4 | 支持删除对应的访问记录 | 删除浏览器历史库中的对应条目 | `chrome.history.deleteUrl` |
| R5 | 避免地址栏自动补全访问记录 | 删除历史后，omnibox 的历史来源补全不再命中该 URL | 依赖 R4（边界见 4.4） |

### 2.2 用户故事

- **US-01**：作为用户，我打开 `Ctrl+H` 或菜单"历史记录"，看到的是按域名分组的新界面，而不是原生平铺列表。
- **US-02**：作为用户，我在左侧点击 `github.com`，右侧只显示该域名的访问记录，最新的在最上面。
- **US-03**：作为用户，我搜索"发票"，能跨域名找到标题或 URL 含该关键词的记录。
- **US-04**：作为用户，我删除一条记录后，再在地址栏输入该 URL 的前几个字符，它不再作为历史建议出现。
- **US-05**：作为用户，我可以一键清空某个域名下的全部历史（例如误访问的站点）。
- **US-06**：作为用户，我勾选多条记录批量删除，删除前有明确确认，知道影响范围。
- **US-07**：作为用户，我删除后立刻看到列表更新，不需要刷新页面。
- **US-08**：作为用户，我的历史数据始终留在本机，扩展不发起任何网络请求。

### 2.3 功能需求（FR）

优先级：P0 = MVP 必须；P1 = 首个正式版应有；P2 = 后续迭代。

| ID | 功能 | 说明 | 优先级 |
| --- | --- | --- | --- |
| FR-01 | 接管 `chrome://history` | `chrome_url_overrides: { "history": "history.html" }`；`Ctrl+H`、菜单"历史记录"、地址栏输入均进入新页面 | P0 |
| FR-02 | 按域名分组 | 以 hostname 为分组键；`www.` 前缀默认保留，可选合并（见 10-Q2） | P0 |
| FR-03 | 组内时间倒序 | 组内按 `lastVisitTime` 降序；同时间按 URL 字典序稳定排序 | P0 |
| FR-04 | 分组排序 | 默认按组内最近访问时间倒序；可切换为按域名 A–Z | P0 |
| FR-05 | 域名侧栏 | 显示域名、记录条数、最近访问时间；支持过滤域名 | P0 |
| FR-06 | 单条删除 | 删除该 URL 在历史库中的**全部访问**（API 限制，见 4.5），确认框明确提示访问次数 | P0 |
| FR-07 | 按域名删除 | 删除该域名下所有 URL 的全部历史；二次确认 | P0 |
| FR-08 | 删除确认 | 展示影响范围（域名 / URL / 访问次数），明示"不可撤销" | P0 |
| FR-09 | 搜索 | 按标题 + URL 模糊匹配；输入防抖 200ms | P0 |
| FR-10 | 实时更新 | 监听 `onVisited`、`onVisitRemoved`，列表自动增删 | P0 |
| FR-11 | 加载/空态/错误 | 骨架屏、无历史空态、读取失败重试 | P0 |
| FR-12 | 分页与虚拟滚动 | 大数据量下只渲染可视区域；数据分批加载 | P0 |
| FR-13 | 站点图标 | 使用 `_favicon` API 显示站点图标，失败回退首字母 | P1 |
| FR-14 | 多选批量删除 | 复选框、全选当前组、底部操作条 | P1 |
| FR-15 | 相对时间 | "3 分钟前 / 昨天 14:20"，悬浮显示绝对时间 | P1 |
| FR-16 | 深色模式 | 跟随系统 `prefers-color-scheme` | P1 |
| FR-17 | 键盘操作 | `/` 聚焦搜索、`j/k` 移动、`Delete` 删除、`Esc` 取消 | P1 |
| FR-18 | 设置项 | 分组粒度、是否隐藏搜索页/内网地址、默认排序 | P1 |
| FR-19 | 删除前导出 | 可选：导出待删除记录为 JSON 备份 | P2 |
| FR-20 | Edge 降级入口 | 非 Chrome 浏览器通过工具栏按钮 / 快捷键打开独立页面 | P1 |
| FR-21 | 国际化 | 中英双语，`chrome.i18n` | P2 |
| FR-22 | 统计概览 | 域名数、总记录数、最近 7 天访问量 | P2 |

### 2.4 非功能需求（NFR）

| ID | 类别 | 要求 |
| --- | --- | --- |
| NFR-01 | 性能 | 1 万条历史首屏 < 1.5s；10 万条首屏 < 3s（缓存命中后 < 1s）；滚动 60fps |
| NFR-02 | 隐私 | 全部数据本地处理，**零网络请求**；不申请 `tabs`、`<all_urls>` 等无关权限；代码可审计 |
| NFR-03 | 权限最小化 | 仅 `history`、`favicon`、`storage`（如需缓存设置） |
| NFR-04 | 安全 | MV3；无内联脚本；不加载远程代码；不使用 `eval` |
| NFR-05 | 兼容性 | Chrome ≥ 116（与现有调试扩展一致）；Edge 降级可用；Firefox 暂不支持 |
| NFR-06 | 可维护性 | TypeScript + Vite；UI 与数据层分离；核心逻辑可单测 |
| NFR-07 | 可访问性 | 语义化标签、焦点可见、对比度 ≥ 4.5:1、屏幕阅读器可读 |
| NFR-08 | 体积 | 安装包 < 500KB（不含图标） |

### 2.5 明确不做（Out of Scope）

- 不伪造、不注入历史记录（不调用 `addUrl`）。
- 不做云端同步、账号体系、统计上报。
- 不接管书签、下载记录、最近关闭的标签页。
- 不承诺清理**表单自动填充**（Autofill）和**搜索引擎联想词**——它们与历史库无关，见 4.4。
- 不接管 Chrome"清除浏览数据"对话框（那是原生设置页，扩展无法也不应改写）。
- 不提供"把某条记录隐藏但保留"的能力（历史库不支持，见 4.5）。

---

## 3. 关键概念与数据模型

### 3.1 概念

| 概念 | 定义 |
| --- | --- |
| HistoryEntry | 历史库中的一条 URL 记录，对应 `chrome.history.HistoryItem` |
| Visit | 对某个 URL 的一次访问，对应 `chrome.history.VisitItem`；**API 不支持单条 Visit 删除** |
| DomainGroup | 同一 hostname 下所有 HistoryEntry 的聚合视图 |
| 分组键 | 默认 `URL.hostname`（如 `mail.google.com`）；可选 eTLD+1（如 `google.com`），需 Public Suffix List |
| 排序键 | `lastVisitTime` 降序；同值按 `url` 升序保证稳定 |

### 3.2 数据模型（前端内存 / IndexedDB）

```ts
interface HistoryEntry {
  url: string;              // 主键
  title: string;
  hostname: string;         // 分组键（小写）
  lastVisitTime: number;    // ms since epoch
  visitCount: number;       // 历史库累计访问次数（全量，不是本次加载的条数）
  typedCount?: number;
  faviconUrl?: string;      // 懒加载，不写入缓存
}

interface DomainGroup {
  hostname: string;
  entries: HistoryEntry[];  // 已按 lastVisitTime 降序
  totalCount: number;       // 该域名记录总数
  lastVisitTime: number;    // 组内最大值
  visitCount: number;       // 组内 visitCount 之和
}

interface DeleteRequest {
  urls: string[];
  scope: 'single' | 'domain' | 'selection';
  domain?: string;
}
```

### 3.3 存储设计（可选缓存）

| Store | keyPath | 内容 | 说明 |
| --- | --- | --- | --- |
| `entries` | `url` | HistoryEntry | 全量镜像，用于秒开与离线筛选 |
| `meta` | `key` | `{ lastSyncTime, schemaVersion, totalCount }` | 增量同步游标 |

> MVP 可先不落盘（每次进入页面现查），但 10 万条场景需要缓存，建议 M1 就引入。

---

## 4. 技术可行性分析

### 4.1 接管 `chrome://history`

**做法**：在 `manifest.json` 中声明

```json
{
  "manifest_version": 3,
  "permissions": ["history", "favicon", "storage"],
  "chrome_url_overrides": { "history": "history.html" }
}
```

**效果**：用户在地址栏输入 `chrome://history`、按 `Ctrl+H`、点菜单"历史记录 → 历史记录"时，加载的是扩展的 `history.html`。

**已知限制与风险**：

| 风险 | 说明 | 应对 |
| --- | --- | --- |
| 覆盖范围有限 | 仅覆盖顶层 `chrome://history` 页面；Chrome 内部其他入口若直接读库（如"历史记录"侧边栏实验特性）不受控 | 接受；文档说明 |
| 扩展禁用即失效 | 扩展被禁用/卸载后恢复原生页 | 正常行为 |
| Edge 不支持 | Edge 的 `chrome_url_overrides` 官方仅保证 `newtab`；`history`/`bookmarks` 覆盖预计不生效（**待实测**） | 降级为独立页面 + 工具栏按钮/快捷键（FR-20） |
| 企业策略 | 组织策略可能禁止加载扩展或禁止覆盖页 | 接受 |
| 原生深链参数 | 原生页支持 `chrome://history/?q=...`、`?group=...`；覆盖后需自行解析 `location.search` | 兼容解析（MVP 可只支持 `?q=`） |
| Chrome 版本变更 | 需验证当前 Chrome 154 是否仍允许覆盖 | M0 Spike 第一项（附录 A） |

**备选方案（若覆盖不可用）**：

1. 工具栏按钮 / `commands` 快捷键（如 `Ctrl+Shift+H`）打开扩展内独立页面；
2. 无法在 `chrome://` 页面注入内容脚本（浏览器禁止），因此不存在"改造原生页"的路线；
3. 不做 `newtab` 覆盖（与需求无关，徒增打扰）。

### 4.2 `chrome.history` API 能力矩阵

| API | 签名要点 | 用途 | 限制 |
| --- | --- | --- | --- |
| `search` | `{text, startTime?, endTime?, maxResults?}` | 拉取历史 | `text` 必填（可传空串表示全部）；`maxResults` 默认 100；**无 offset**，只能靠 `endTime` 游标分页 |
| `getVisits` | `{url}` | 查看某 URL 的访问明细 | 无分页参数；返回全部 Visit |
| `deleteUrl` | `{url}` | 删除某 URL 的**全部**访问 | **无法只删一次访问** |
| `deleteRange` | `{startTime, endTime}` | 按时间区间删除所有 URL | 影响面大，本产品不使用（除"清空全部"外） |
| `deleteAll` | — | 清空全部历史 | 仅用于设置页的显式操作，MVP 不做 |
| `onVisited` | `HistoryItem` | 新访问实时入列 | Service Worker 休眠时事件可能合并/延迟 |
| `onVisitRemoved` | `{allHistory, urls?}` | 删除后校准本地缓存 | 本扩展删除也会触发，需去重 |
| `onTitleChanged` | `{url, title}` | 标题变化更新 | 可选 |

**权限影响**：声明 `history` 会在安装时提示"读取您的浏览记录"，属敏感权限；上架商店需在描述与隐私政策中说明用途。

**能力缺口（决定产品边界）**：

- 没有"按域名删除"的原生方法 → 先 `search` 出该域名下全部 URL，再并发 `deleteUrl`。
- 没有"删除单次访问" → 产品层必须把"删除一条记录"定义为"删除该 URL 的全部访问"。
- 没有 offset 分页 → 用 `endTime = 当前批次最早 lastVisitTime - 1` 继续拉取；需处理同一毫秒多条记录的边界（用 `maxResults` 截断时，记录 `lastVisitTime` 相同的条目可能重复或遗漏，需按 URL 去重 + 游标微调）。

### 4.3 全量历史与性能

历史库规模：普通用户数万条，重度用户 10 万+。`search` 空 `text` 在大库上性能较差（Chromium 已有相关性能 issue，如 [407220725](https://issues.chromium.org/issues/407220725)）。

**方案对比**：

| 方案 | 首屏 | 实现成本 | 结论 |
| --- | --- | --- | --- |
| A. 每次进入页面全量分页拉取 | 慢（大库 3–10s） | 低 | 仅作 MVP 兜底 |
| B. IndexedDB 全量镜像 + `onVisited` 增量 | 快（< 1s） | 中 | **推荐** |
| C. 只拉最近 N 天 + 按需加载 | 快 | 中 | 会牺牲"老记录"的完整分组 |

**推荐 B**：首次安装/升级时后台分批构建索引（每批 2000 条，`requestIdleCallback` 间让出主线程），完成后页面只读本地；`onVisited` 单条 upsert，`onVisitRemoved` 批量删除。构建进度在页面顶部以细进度条展示。

### 4.4 地址栏自动补全的行为边界（必须写进产品说明）

Chrome 地址栏候选来源不止历史：书签、搜索引擎联想、已打开标签页、Chrome 内置推荐等。删除历史只能消除"历史来源"的候选。

| 删除后仍可能出现该 URL 的场景 | 原因 | 是否本插件能解决 |
| --- | --- | --- |
| 该 URL 被收藏为书签 | Bookmark provider | 否（需用户删书签） |
| 输入内容本身触发搜索引擎联想 | Search provider | 否（与历史无关） |
| 登录 Chrome Sync 且其他设备仍保留该记录 | 同步回填 | 部分（删除会同步，但冲突/延迟可能导致回流） |
| 打开了该 URL 的标签页 | "切换到该标签页"候选 | 否 |
| 表单里的输入历史 | Autofill，与 history 库无关 | 否 |
| 本地数据库已删除但 omnibox 内存索引未刷新 | 极少见 | 通常即时生效，若不复现需重启浏览器验证 |

**结论**：本插件解决"历史记录导致的地址栏补全"，这是用户核心痛点；但产品文案不能承诺"地址栏永远不再出现该网址"。验收标准也只针对"历史来源候选"。

### 4.5 删除语义（关键产品决策）

| 用户操作 | 实际效果 | UI 必须说明 |
| --- | --- | --- |
| 删除一条列表项 | `deleteUrl`，该 URL 的**全部** Visit 被删 | "此地址共访问 N 次，将全部删除" |
| 删除某域名 | 该域名下每个 URL 逐条 `deleteUrl` | "将删除 X 个地址、共 Y 条访问记录" |
| 批量删除选中项 | 逐条 `deleteUrl`（并发 ≤ 6） | 同上，列出数量 |
| （不提供）删除某一次访问 | 技术上不可行 | — |

**不可撤销**：历史删除无回收站。确认框需显著提示；P2 可提供"删除前导出 JSON"作为补救。

### 4.6 MV3 与页面结构

- `history.html` 是扩展页面（`chrome-extension://` 源），可直接调用 `chrome.history`，**无需** Service Worker 中转；SW 只负责缓存维护与事件广播。
- MV3 Service Worker 会休眠：事件监听必须在顶层同步注册；页面侧监听 `chrome.history.onVisited` 亦可（扩展页面同样能收到事件），从而减少对 SW 的依赖。
- CSP 禁止内联脚本与 `eval`，用 Vite 构建产物即可。
- favicon：MV3 使用 `chrome-extension://<id>/_favicon/?pageUrl=<encoded>&size=32`，需 `favicon` 权限；失败回退到站点首字母色块。

### 4.7 浏览器兼容性

| 浏览器 | 覆盖 `chrome://history` | 读取/删除历史 | 结论 |
| --- | --- | --- | --- |
| Chrome 116+ | ✅（待 M0 实测确认） | ✅ | 主目标 |
| Edge 116+ | ❌（预计） | ✅ | 降级：独立页面 + 快捷键 |
| Firefox | ✅（`chrome_url_overrides` 支持 history） | ✅（`browser.history`） | 暂不支持，架构预留 |
| Safari | ❌（无对应 API） | ❌ | 不支持 |

---

## 5. 架构设计

### 5.1 组件

```
┌──────────────────────────────────────────────────────────┐
│  history.html（扩展页面，UI）                              │
│  ├─ DomainSidebar   域名列表 / 过滤                        │
│  ├─ HistoryTimeline 分组时间线 / 虚拟滚动                  │
│  ├─ SearchBar       标题+URL 搜索                          │
│  ├─ ConfirmDialog   删除确认                               │
│  └─ BatchBar        多选操作                               │
└───────────────┬──────────────────────────────────────────┘
                │ 直接调用（同源扩展页面）
┌───────────────▼──────────────────────────────────────────┐
│  chrome.history API                                       │
└───────────────▲──────────────────────────────────────────┘
                │ onVisited / onVisitRemoved
┌───────────────┴──────────────────────────────────────────┐
│  background.js（Service Worker，可选）                     │
│  ├─ HistoryIndexer   全量构建 / 增量维护 IndexedDB         │
│  └─ MessageBus       广播数据变更给已打开页面              │
└───────────────┬──────────────────────────────────────────┘
                │
┌───────────────▼──────────────────────────────────────────┐
│  IndexedDB（entries / meta）                              │
└──────────────────────────────────────────────────────────┘
```

> MVP 简化：页面直接 `search` + 内存分组，不落盘；M1 引入 IndexedDB 与增量。

### 5.2 关键数据流

**首次加载**
1. 页面读取 `meta.lastSyncTime`；
2. 无缓存 → 分批 `search`（`endTime` 游标），每批归一化（hostname、去重）写入内存与 IndexedDB；
3. 分组、排序、渲染首屏；后台继续补齐剩余批次。

**实时新增**
1. `onVisited` → 归一化 → upsert IndexedDB → 广播 `{type:'visited', entry}`；
2. 页面更新对应分组（不存在则新建），若符合当前过滤条件则插入顶部并高亮 2s。

**删除**
1. 用户确认 → 页面调用 `deleteUrl`（逐条，并发 6）；
2. 成功后立即从内存/IndexedDB 移除并重渲染；
3. `onVisitRemoved` 到达时按 URL 去重，避免二次删除报错；
4. Toast 提示"已删除 N 条"，并提供"撤销"？——**不提供**（不可逆），仅提示。

**失败的删除**
- `deleteUrl` 返回 rejected（URL 已不存在等）→ 单条失败不阻断其余；汇总提示"X 条成功，Y 条失败"。

### 5.3 建议目录结构

```
an-history/
├─ .docs/                      # 本文档
├─ public/
│  ├─ icons/                   # 16/32/48/128
│  └─ _locales/{en,zh_CN}/messages.json
├─ src/
│  ├─ manifest.json
│  ├─ background.ts            # SW：索引与事件（M1）
│  ├─ history.html
│  ├─ history.tsx              # 页面入口
│  ├─ db/
│  │  ├─ schema.ts             # IndexedDB 封装
│  │  └─ indexer.ts            # 全量构建/增量
│  ├─ core/
│  │  ├─ historyApi.ts         # search 分页、deleteUrl 封装
│  │  ├─ group.ts              # 分组/排序/统计（纯函数，可测）
│  │  └─ hostname.ts           # hostname 归一化 / 可选 eTLD+1
│  ├─ ui/
│  │  ├─ DomainSidebar.tsx
│  │  ├─ HistoryTimeline.tsx
│  │  ├─ HistoryRow.tsx
│  │  ├─ ConfirmDialog.tsx
│  │  └─ VirtualList.tsx
│  └─ styles/
├─ tests/                      # Vitest：group/hostname/排序
├─ vite.config.ts
└─ package.json
```

### 5.4 核心算法要点

**分页拉取（游标）**

```ts
async function fetchAll(onBatch: (items: HistoryItem[]) => void) {
  let endTime = Date.now();
  const BATCH = 2000;
  const seen = new Set<string>();
  for (;;) {
    const items = await chrome.history.search({
      text: '', startTime: 0, endTime, maxResults: BATCH,
    });
    const fresh = items.filter(i => !seen.has(i.url));
    if (!fresh.length) break;
    fresh.forEach(i => seen.add(i.url));
    onBatch(fresh);
    const oldest = Math.min(...items.map(i => i.lastVisitTime ?? 0));
    if (items.length < BATCH) break;
    endTime = oldest;          // 注意：同毫秒多条时可能重复，用 seen 去重
    await new Promise(r => setTimeout(r, 0)); // 让出主线程
  }
}
```

**分组**

```ts
function groupByHostname(items: HistoryItem[]): DomainGroup[] {
  const map = new Map<string, HistoryEntry[]>();
  for (const it of items) {
    const host = safeHostname(it.url);       // new URL(url).hostname.toLowerCase()
    if (!host) continue;                     // 跳过 chrome://、file:// 等
    (map.get(host) ?? map.set(host, []).get(host)!).push(toEntry(it, host));
  }
  return [...map].map(([hostname, entries]) => {
    entries.sort((a, b) => b.lastVisitTime - a.lastVisitTime || a.url.localeCompare(b.url));
    return { hostname, entries, totalCount: entries.length,
             lastVisitTime: entries[0]?.lastVisitTime ?? 0,
             visitCount: entries.reduce((s, e) => s + e.visitCount, 0) };
  }).sort((a, b) => b.lastVisitTime - a.lastVisitTime);
}
```

**删除（并发限流）**

```ts
async function deleteUrls(urls: string[], concurrency = 6) {
  const results = { ok: 0, fail: 0 };
  let i = 0;
  await Promise.all(Array.from({ length: concurrency }, async () => {
    while (i < urls.length) {
      const url = urls[i++];
      try { await chrome.history.deleteUrl({ url }); results.ok++; }
      catch { results.fail++; }
    }
  }));
  return results;
}
```

---

## 6. 交互设计

### 6.1 布局

```
┌────────────────────────────────────────────────────────────────────┐
│  an-history        [🔍 搜索标题、网址…            ]   [排序 ▾] [⚙] │
├──────────────┬─────────────────────────────────────────────────────┤
│ 域名 (128)   │  github.com · 34 条 · 最近 2 分钟前      [删除整组] │
│ ───────────  │ ─────────────────────────────────────────────────── │
│ ● github.com │  ▸ Issue #42 · Fix history index     2 分钟前  [🗑] │
│   34 · 2 分  │    github.com/acme/repo/issues/42                   │
│ ● google.com │  ▸ acme/repo · Pull requests         1 小时前  [🗑] │
│   120 · 1 时 │    github.com/acme/repo/pulls                       │
│ ● bilibili…  │  …                                                   │
│   56 · 昨天  │  google.com · 120 条 · 最近 1 小时前     [删除整组] │
│ …            │  …                                                   │
└──────────────┴─────────────────────────────────────────────────────┘
```

- **左栏**：域名、条数、最近访问时间；滚动虚拟化；顶部可按域名过滤。
- **右栏**：分组卡片；每组头部含 favicon、域名、条数、最近时间、"删除整组"。
- **条目**：favicon、标题（超长省略）、URL 路径（灰色）、相对时间（悬浮绝对时间）、hover 显示删除按钮。
- **搜索**：即时过滤，命中高亮；无结果空态。
- **多选**：条目左侧复选框；组头支持"全选本组"；底部浮动操作条显示"已选 N 条 · 删除"。

### 6.2 删除确认

```
┌────────────────────────────────────────────┐
│  删除历史记录？                             │
│                                            │
│  将删除 github.com 下的 34 个地址，          │
│  共 212 次访问记录。                        │
│                                            │
│  删除后不可恢复，且这些网址将不再出现在      │
│  地址栏的历史补全中。                       │
│                                            │
│              [取消]  [删除]                 │
└────────────────────────────────────────────┘
```

- "删除"按钮为危险色（红），默认焦点在"取消"。
- 批量/整组删除需二次确认（输入域名或勾选"我已知晓"？MVP 用普通确认即可，P1 可加）。

### 6.3 状态

| 状态 | 表现 |
| --- | --- |
| 首次构建索引 | 顶部细进度条 + "正在整理历史记录… 42%" |
| 加载中 | 骨架屏（3 个分组占位） |
| 空历史 | 插画 + "还没有浏览记录" |
| 无搜索结果 | "没有找到包含「xxx」的记录" + 清除搜索 |
| 读取失败 | 错误说明 + "重试"按钮 + 权限检查提示 |
| 删除失败 | Toast："3 条删除成功，1 条失败" + 详情入口 |

### 6.4 快捷键与可访问性

- `/` 聚焦搜索；`Esc` 清空/退出多选；`↑/↓` 或 `j/k` 移动；`Delete` 删除当前项；`Ctrl/Cmd+A` 全选当前组。
- 所有可点击元素可 Tab 聚焦，`:focus-visible` 有描边；删除确认用 `role="alertdialog"`。

---

## 7. 验收标准（AC）

| ID | Given | When | Then |
| --- | --- | --- | --- |
| AC-01 | 扩展已安装并启用 | 按 `Ctrl+H` | 展示自定义历史页，无原生页闪烁 |
| AC-02 | 历史库含 3 个域名 | 打开页面 | 左栏 3 个域名，按最近访问时间倒序 |
| AC-03 | `github.com` 有 5 条记录 | 点击该域名 | 右栏 5 条，`lastVisitTime` 从新到旧 |
| AC-04 | 某条记录 URL 为 A | 删除并确认 | 列表移除；`chrome://history` 原生页中也不存在（临时禁用扩展验证） |
| AC-05 | 刚删除 URL A | 地址栏输入 A 的前缀 | A 不再出现在历史建议中 |
| AC-06 | 选中 10 条 → 删除 | 确认 | 10 条全部消失，Toast 显示"已删除 10 条" |
| AC-07 | 删除某域名全部 | 确认 | 该域名从侧栏消失；其他域名不受影响 |
| AC-08 | 页面打开时访问新网站 | 访问完成 | 新记录 1s 内出现在对应分组顶部 |
| AC-09 | 历史 10 万条 | 首次打开 | 首屏 ≤ 3s；滚动无明显卡顿 |
| AC-10 | 断网 | 全流程操作 | 功能完全正常（无网络请求） |
| AC-11 | 键盘用户 | Tab/Enter | 可完成搜索、选择、删除全流程 |
| AC-12 | 深色系统主题 | 打开页面 | 无白底闪烁，对比度达标 |

---

## 8. 里程碑与任务拆解

| 阶段 | 内容 | 预估 |
| --- | --- | --- |
| M0 Spike | ① 验证 Chrome 154 覆盖 `chrome://history`；② 验证 `deleteUrl` 后地址栏补全消失；③ 验证 Edge 覆盖是否生效；④ 验证 10 万条 `search` 耗时 | 0.5 天 |
| M1 MVP | manifest + 覆盖页 + 全量读取 + 域名分组 + 组内排序 + 单条/整组删除 + 确认框 + 空态 | 1.5–2 天 |
| M2 体验 | IndexedDB 索引 + 增量事件 + 虚拟滚动 + 搜索 + 相对时间 + favicon | 1–1.5 天 |
| M3 完善 | 多选批量 + 快捷键 + 深色模式 + 设置项 + 失败兜底 | 1 天 |
| M4 发布 | 图标/文案/i18n + 隐私政策 + 商店素材 + Edge 降级页 | 1 天 |

**M0 是硬门槛**：若覆盖在目标浏览器上不可用，则退回"独立页面 + 快捷键"方案，需求 R1 的表述需同步调整。

---

## 9. 风险与应对

| 风险 | 概率 | 影响 | 应对 |
| --- | --- | --- | --- |
| Chrome 新版本禁止覆盖 history 页 | 低 | 高 | M0 实测；备选独立页面 + 快捷键 |
| Edge 不支持覆盖 | 高 | 中 | 降级方案；文档明确"Chrome 体验最佳" |
| 10 万条性能不达标 | 中 | 中 | IndexedDB 缓存 + 分批 + 虚拟滚动；必要时限制默认时间范围 |
| 用户误删且无法恢复 | 中 | 高 | 强确认 + 影响范围明示 + P2 导出备份 |
| 删除后地址栏仍出现（书签/联想） | 中 | 中 | 产品说明 + 帮助页解释来源差异 |
| 同步导致记录回流 | 低 | 低 | 说明；不做额外处理 |
| 敏感权限审核被拒 | 中 | 中 | 隐私政策 + 最小权限 + 无网络声明 |
| 同毫秒游标分页重复/遗漏 | 中 | 中 | URL 去重 + 单测覆盖边界 |

---

## 10. 待确认问题（需要拍板）

| # | 问题 | 选项 | 建议 |
| --- | --- | --- | --- |
| Q1 | 目标浏览器 | A. 仅 Chrome；B. Chrome + Edge 降级；C. 再加 Firefox | B |
| Q2 | 分组粒度 | A. 精确 hostname（`mail.google.com` 独立）；B. eTLD+1 合并（`google.com` 一组） | A 为默认，设置项可切 B |
| Q3 | "删除一条记录"的语义 | A. 删除该 URL 全部访问（唯一可行）；B. 只删最近一次（不可行） | A，UI 明示 |
| Q4 | 是否需要删除前导出备份 | A. 需要（P2）；B. 不需要 | A |
| Q5 | 是否上架 Chrome Web Store | A. 是（需隐私政策、素材、审核）；B. 仅本地加载 | 待定 |
| Q6 | 界面语言 | A. 仅中文；B. 中英双语 | B |
| Q7 | 搜索范围 | A. 标题 + URL；B. 再加域名 | A，域名由侧栏过滤承担 |
| Q8 | 是否显示 `chrome://`、`file://`、扩展页记录 | A. 隐藏（推荐）；B. 显示在"其他"组 | A |

---

## 11. 参考

- [chrome.history API](https://developer.chrome.com/docs/extensions/reference/api/history)
- [Override Chrome pages（chrome_url_overrides）](https://developer.chrome.com/docs/extensions/develop/ui/override-chrome-pages)
- [chrome_url_overrides manifest key](https://developer.chrome.com/docs/extensions/reference/manifest/chrome-url-overrides)
- [favicon API（MV3 `_favicon`）](https://developer.chrome.com/docs/extensions/reference/api/favicon)
- [Chromium issue 407220725：history.search 性能](https://issues.chromium.org/issues/407220725)
- [MDN chrome_url_overrides（兼容性参考）](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/manifest.json/chrome_url_overrides)

---

## 附录 A：M0 Spike 验证清单

> 目的：在写业务代码前，用最小扩展验证 4 个硬假设。任一项失败都要回到第 4 章调整方案。

1. **覆盖是否生效**
   - 新建最小扩展：`manifest.json`（`chrome_url_overrides.history`）+ `h.html`（写入标记文本）。
   - 加载后访问 `chrome://history`，确认显示标记文本。
2. **删除是否影响地址栏**
   - 造一条访问记录 → 插件页删除 → 地址栏输入前缀，确认不再出现历史建议。
   - 同时确认书签/搜索联想的差异（预期仍会出现）。
3. **Edge 行为**
   - 同扩展在 Edge 加载，访问 `edge://history`，确认是否仍是原生页。
4. **性能基线**
   - 用 1 万 / 5 万 / 10 万条历史（可脚本造数或使用真实库）测量空 text `search` 全量分页耗时，决定是否必须上 IndexedDB。

**记录方式**：每项写"通过/不通过 + 现象 + 浏览器版本"，回填到本文档 4.1–4.3。
