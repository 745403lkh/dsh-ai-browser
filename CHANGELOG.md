# 更新日志 / Changelog

## [1.1.1] - 2026-11-01

### 中文

**新增**
- 收藏与历史记录：工具栏新增收藏（星形）和历史按钮，内联面板可查看、打开、删除收藏，查看和清空历史；两者都按工作区独立存储（历史最多 500 条，同 URL 连续访问自动去重）。
- AI 可以通过浏览器工具的 `bookmarks` / `history` 动作读取当前工作区的收藏和历史记录。
- 权限预设：Harness 设置新增「AI 浏览器」页，可创建多个预设、自定义名字、编辑四档站点名单、设默认预设；新工作区第一次打开浏览器模式时自动套用默认预设，浏览器面板设置里可一键把预设应用到当前工作区。
- 预设搜索：设置页和面板设置里的预设列表都支持按名字搜索（不区分大小写）。
- 预设导入/导出：使用人类可读的 `.txt` 格式（`# name:` 头 + `[view]/[simple]/[review]/[full]` 分节，条目可带 ` !noauth`），方便分享；面板支持「存为预设 / 导出当前工作区 / 导入到当前工作区」，设置页支持导入预设和逐条导出。
- 权限设置里的站点名单超过 3 条时自动折叠（每档独立展开/收起）。
- 黑白简笔画地球作为 AI 浏览器核心视觉：会话列表左侧图标、输入框「+」菜单的「打开 AI 浏览器」、Harness 设置页入口都使用地球。

**改进**
- 站点名单改为按工作区隔离；工作区解析改为优先 `workingDirectory.get(session)`，并加入 2 秒缓存与强制刷新，切换工作区立即生效。
- 站点权限随页面站点动态计算：新窗口、外链、新标签页不再继承旧窗口权限，主机名变化立即按目标站点名单重算。
- 侧边栏地球只在浏览器模式会话真正执行任务时旋转；新增侧栏会话行状态桥接，离开对话界面后仍按真实运行状态显示静态/旋转地球。
- 下载型弹窗不再残留空白标签页：自动识别并关闭 `window.open` 下载弹窗以及加载后仍空白/无标题的弹窗。

**修复**
- 修复站点名单跨工作区串数据：Host 侧两个 `ctx.inject` 回调互相覆盖 `workingDirectory` 服务，导致所有会话退回默认工作区。
- 修复手动关闭 AI 浏览器面板后无法再打开、「+」菜单入口不显示的问题。
- 修复浏览器运行状态离开对话页后变回通用转圈的问题。
- 修复下载任务 `pause_download / resume_download / cancel_download` 的 `downloadId` 参数被归一化丢弃、导致无法控制任务的问题。
- 修复旧版全局收藏/历史数据迁移，统一升级为按工作区的 v2 存储。

**测试**
- 全部自测通过：下载 25 项、Host/工具 61 项、客户端 51 项、1.1.1 Host 用例 131 项，合计 268 项。

### English

**Added**
- Bookmarks and history: new star and history buttons in the toolbar; inline panels list/open/delete bookmarks and view/clear history; both are stored per workspace (history capped at 500 entries, consecutive visits to the same URL are de-duplicated).
- The AI can read the current workspace's bookmarks and history through the browser tool's `bookmarks` / `history` actions.
- Permission presets: a new "AI Browser" page in Harness Settings to create multiple presets, name them, edit the four site lists and set a default preset. A new workspace applies the default preset automatically the first time AI Browser mode is used, and the browser panel settings can apply a preset to the current workspace in one click.
- Preset search: preset lists in both Settings and the browser panel can be filtered by name (case-insensitive).
- Preset import/export in a human-readable `.txt` format (`# name:` header plus `[view]/[simple]/[review]/[full]` sections, entries may end with ` !noauth`) for sharing; the panel offers "Save as preset / Export current workspace / Import into current workspace", and Settings supports importing presets and exporting each preset.
- Site lists in permission settings automatically collapse when a level has more than 3 entries (independently expandable per level).
- Black-and-white line-art Earth as the core AI Browser visual: the sidebar session marker, the "Open AI browser" item in the composer "+" menu and the Harness Settings page entry all use the Earth icon.

**Changed**
- Site lists are now scoped per workspace; workspace resolution prefers `workingDirectory.get(session)` with a 2-second cache and forced refresh, so switching workspaces takes effect immediately.
- Site permission is derived from the current page host: new windows, external links and popup tabs no longer inherit the previous window level; changing the hostname re-applies the target site's list entry.
- The sidebar Earth rotates only while an AI Browser session is actually running; a new sidebar session-row bridge keeps the real state outside the conversation view.
- Download popups no longer leave a blank tab: `window.open` download popups and popups that stay blank/title-less after loading are detected and closed automatically.

**Fixed**
- Site lists leaked across workspaces because two Host `ctx.inject` callbacks overwrote each other's `workingDirectory` service, making every session fall back to the default workspace.
- The AI browser panel could not be reopened after being closed manually, and the "+" menu entry was hidden.
- The sidebar running state fell back to the generic spinner after leaving the conversation view.
- `pause_download / resume_download / cancel_download` lost their `downloadId` during argument normalization, so real download jobs could not be controlled.
- Legacy global bookmark/history data is migrated to the per-workspace v2 storage.

**Testing**
- All suites pass: 25 download, 61 host/tool, 51 client and 131 new 1.1.1 host checks — 268 checks in total.

## [1.1.0] - 2026-11-01

### 中文

**新增**
- 站点名单（按工作区隔离）：工具栏下载按钮右侧新增设置按钮，四个权限档位各自维护一份网址名单，不设数量上限；每个条目带「无需授权访问」开关。
- 硬逻辑匹配：`baidu.com` 匹配该域名及所有子域（`www.baidu.com`、`fanyi.baidu.com` 都生效）；`www.baidu.com` 只匹配该主机；`www.baidu.com/xyz` 匹配该路径及其下级；多条同时命中时取更具体的一条。
- 命中名单的站点，窗口权限直接采用名单档位；未命中一律仅可查看，AI 打开前必须申请授权；开启「无需授权访问」的站点，AI 可以直接打开。
- AI 浏览器模式会话的输入框「+」命令菜单新增「打开 AI 浏览器」，手动关闭右侧浏览器面板后可随时重新打开。
- 新增只读诊断接口 `/debug-workspace`，可查看某个会话的工作区解析链路。

**改进**
- 站点权限改为随页面站点动态计算：新窗口、外链、新标签页不再继承旧窗口权限，主机名变化时立即按目标站点名单重算。
- 工作区解析更稳：优先用 `workingDirectory.get(session)` 同步读取，失败再回退 `ensure`；名单读写和打开站点前强制刷新工作区缓存（2 秒 TTL），切换工作区后立即生效。

**修复**
- 修复站点名单跨工作区串数据：Host 侧两个 `ctx.inject` 回调会互相覆盖 `workingDirectory` 服务，导致所有会话退回默认工作区、名单变成全局共享。
- 修复手动关闭 AI 浏览器面板后再也无法打开的问题。
- 修复「+」命令菜单取不到会话模式、导致「打开 AI 浏览器」入口不显示的问题。

**测试**
- 3 个自测套件全部通过：下载 25 项、Host/工具 61 项、Client 40 项。

### English

**Added**
- Site lists (per workspace): a settings button to the right of the download button; each of the four permission levels keeps its own URL list with no entry limit, and every entry has a "No authorization needed" toggle.
- Hard-logic matching: `baidu.com` matches the domain and all its subdomains (`www.baidu.com`, `fanyi.baidu.com`); `www.baidu.com` matches that host only; `www.baidu.com/xyz` matches that path and its children; when several entries match, the most specific one wins.
- Listed sites adopt that list's level; unlisted sites are view-only and the AI must request approval before opening them; with "No authorization needed" enabled the AI opens the site directly.
- "Open AI browser" in the composer's "+" command menu of AI Browser conversations, so the panel can be reopened after being closed manually.
- A read-only `/debug-workspace` diagnostic endpoint for inspecting a session's workspace resolution chain.

**Changed**
- Site permission is now derived from the current page's host: new windows, external links and popup tabs no longer inherit the previous window level; changing the hostname re-applies the target site's list entry.
- More robust workspace resolution: prefer the synchronous `workingDirectory.get(session)`, fall back to `ensure`; list reads/writes and opening a site force-refresh the workspace cache (2s TTL), so switching workspaces takes effect immediately.

**Fixed**
- Site lists leaked across workspaces: two Host `ctx.inject` callbacks overwrote each other's `workingDirectory` service, making every session fall back to the default workspace and the lists effectively global.
- The AI browser panel could not be reopened after being closed manually.
- The "+" command menu could not read the session preset, so the "Open AI browser" entry was hidden.

**Testing**
- All 3 test suites pass: 25 download checks, 61 host/tool checks and 40 client checks.

## [1.0.1] - 2026-10-31

### 中文

**新增**
- 浏览器式下载面板：挂在工具栏下方内联展开，下载任务创建时自动弹出；显示进度条、百分比、已下载/总大小、实时速度和文件类型图标；完成的文件可直接打开、复制路径或打开下载文件夹；任务超过 3 个时折叠为「查看更多 / 收起」。
- 下载任务支持暂停 / 继续 / 取消。AI 可通过 `downloads` 动作查看任务状态（downloading / paused / error / cancelled）、速度与进度，并用 `pause_download / resume_download / cancel_download`（`download_id`）控制任务。
- 支持页面里 `target="_blank"` / `window.open` 打开的链接：自动新建标签页、跳转到目标网址并切换过去；新标签页和普通窗口一样可被 AI 读取、点击、输入和下载，并继承当前窗口权限。
- 标签页数量不再设上限（只受内存影响）。

**改进**
- 下载界面从弹窗列表改为内嵌下载面板，展开时不再遮挡浏览器画面，网页保持可见可点；再点下载按钮、点其它地方或按 Esc 即可收回。
- 浏览器权限菜单同样改为工具栏下方内联展开，切换级别时页面不会被遮挡。
- 下载面板与权限面板状态与 AI 工具双向同步：面板里的暂停/继续/取消，AI 也能看到并操作。

**修复**
- 页面中会新建标签页的按钮（`target="_blank"`、`window.open`）点了没反应：现在会自动创建新标签页并跳转到目标网址。
- 打开下载/权限界面时浏览器画面闪烁、变白、之后点不了网页：改为内联展开，不再隐藏原生 webview。
- 取消下载后任务不及时消失、暂停后取消反而继续下载、暂停/继续状态错乱：取消/完成立即从列表移除，取消后不再发起新请求，控制按钮即时反馈并防止重复点击。

**测试**
- 3 个自测套件全部通过：下载 25 项、Host/工具 43 项、Client 34 项。

### English

**Added**
- Browser-style download panel: expands inline below the toolbar and opens automatically when a download starts. It shows a progress bar, percentage, downloaded/total size, live speed and file-type icons; completed files can be opened, their path copied, or revealed in the download folder; more than 3 tasks are folded behind "Show more / Show less".
- Download tasks can be paused / resumed / cancelled. The AI can inspect task status (downloading / paused / error / cancelled), speed and progress through the `downloads` action, and control tasks with `pause_download / resume_download / cancel_download` plus `download_id`.
- Links opened via `target="_blank"` / `window.open` now create a new tab, navigate to the target URL and switch to it; popup tabs are ordinary browser windows for the AI (read, click, type, download) and inherit the current permission level.
- No hard cap on the number of tabs anymore (memory is the only limit).

**Changed**
- The download UI is now an inline panel instead of a modal list: opening it no longer covers the page, which stays visible and clickable; click the download button again, click elsewhere or press Esc to close it.
- The browser permission menu also expands inline below the toolbar, so switching levels no longer covers the page.
- Download and permission panel state is synchronised with the AI tools in both directions: actions taken in the panel are visible to and controllable by the AI.

**Fixed**
- Buttons that open a new tab (`target="_blank"`, `window.open`) did nothing; they now create a new tab and navigate it to the target URL.
- Opening the download/permission UI flashed or blanked the page and made it unclickable; both panels now expand inline without hiding the native webview.
- Cancelled downloads lingered, cancel-after-pause resumed downloading, and pause/resume could get stuck; cancelled/completed tasks are removed immediately, no new request starts after cancel, and control buttons update instantly with duplicate-click protection.

**Testing**
- All 3 test suites pass: 25 download checks, 43 host/tool checks and 34 client checks.

## [1.0.0] - 2026-10-31

### 中文

**新增**
- **AI 浏览器模式（Agent Preset `ai-browser`）**：新建对话时在「标准模式 / 创造模式」之外多一个「AI 浏览器模式」，不影响模型与思考强度设置；选中后会话右侧自动打开浏览器面板，对话区收窄到左侧，面板按会话隔离。
- **应用内浏览器面板**：DSH 桌面版应用内 `<webview>`，不启动外部浏览器、不碰系统鼠标；同一会话可开多个窗口，顶部页签条切换 / 新建 / 关闭，AI 用 `window` 参数指定窗口。
- **浏览器操作（`browser` 工具）**：`state / windows / downloads / open / read / click / type / press / scroll / back / forward / reload / inspect / screenshot / download / new_window / close_window / request_access`；`read` 返回正文与带 index 的可交互元素，先读再按 index 操作，页面跳转后重新读。
- **后台执行**：所有操作通过 `<webview>` 脚本执行与合成输入事件完成，不移动系统鼠标、不要求 DSH 在前台；窗口最小化时仍可继续加载与操作（Electron 后台节流会略降速）。
- **每窗口四级浏览器权限**：仅可查看 / 仅简单操作 / 自动审查 / 完全权限；入口在面板工具栏刷新按钮右侧、网址栏左侧；每个窗口独立级别，新窗口继承当前窗口级别；权限按「会话 + 窗口」持久化。
- **风险警告与主动授权**：切换到自动审查 / 完全权限时弹出确认（勾选「我已了解风险」）；权限不足时工具主动发起一次性授权申请，写明目标窗口/页面、具体操作和原因（`reason`），被拒后向用户解释而不是静默结束；`request_access` 可先申请再执行。
- **下载**：页面文件链接自动拦截 + `download` 动作；页面内取回失败时回退 Host 直连下载（绕页面 CORS、流式写盘、512MB 上限、拒绝本机/内网地址防 SSRF）；大文件 HTTP Range 断点续传 + 总大小校验，完成后保存到工作区 `browser download/`。
- **截图**：`screenshot` 保存到 `$DSH_HOME/storages/dsh-ai-browser/screenshots/`（最多 40 张），模型支持图片输入时作为图片附件返回。
- **安全**：所有 HTTP 接口必须带 `x-dsh-ai-browser: 1` 请求头并来自本机回环来源，不返回 CORS 头；打开下载文件仅限下载目录内；应用内 `<webview>` 由 DSH 主进程强制安全策略。
- **依赖**：不依赖任何第三方 npm 包；不调用其它插件的接口。

**测试**
- 3 个自测套件全部通过：Host/工具 41 项、Client 29 项、下载 17 项。

### English

**Added**
- **AI Browser mode (Agent Preset `ai-browser`)**: a new mode next to Standard and Create when starting a conversation. It does not change model or thinking-effort settings; when selected, the browser panel opens on the right and the conversation narrows to the left, isolated per session.
- **In-app browser panel**: an in-app `<webview>` in the DSH desktop app. No external browser is launched and no system mouse is used; multiple windows per session with a tab strip to switch / create / close windows, targeted by the AI via the `window` parameter.
- **Browser operations (`browser` tool)**: `state / windows / downloads / open / read / click / type / press / scroll / back / forward / reload / inspect / screenshot / download / new_window / close_window / request_access`. `read` returns page text plus indexed interactive elements; read first, act by index, and re-read after navigation.
- **Background operation**: everything runs through in-app script execution and synthesized input events, so the system mouse is never moved, DSH does not need to be in the foreground, and browsing continues while the window is minimized (background throttling may slow it slightly).
- **Per-window four-level browser permission**: View only / Simple actions / Auto review / Full access. The control sits in the panel toolbar to the right of Refresh and left of the address bar; each window has its own level, new windows inherit the current one, and levels persist per session + window.
- **Risk warnings and proactive authorization**: switching to Auto review or Full access asks for confirmation with an "I understand the risks" checkbox; when permission is insufficient the tool raises a one-time approval request naming the target window/page, the exact operation and the reason (`reason`), and explains instead of silently stopping after a rejection; `request_access` can ask first and then execute.
- **Downloads**: file links on the page are intercepted automatically and the AI can call `download`. The page tries an in-page fetch first, then falls back to a direct host download on CORS failure (bypasses page CORS, streams to disk, 512MB cap, rejects loopback/private addresses against SSRF); large files use HTTP Range resume plus a size check and are saved to `browser download/` in the workspace.
- **Screenshots**: `screenshot` saves images to `$DSH_HOME/storages/dsh-ai-browser/screenshots/` (latest 40) and returns them as image attachments when the model supports image input.
- **Security**: every HTTP endpoint requires the `x-dsh-ai-browser: 1` header and a loopback origin, and never returns CORS headers; opening a downloaded file is restricted to the download directory; the in-app `<webview>` is locked down by the DSH main process.
- **Dependencies**: no third-party npm packages; no other plugin APIs are used.

**Testing**
- All 3 test suites pass: 41 host/tool checks, 29 client checks and 17 download checks.

