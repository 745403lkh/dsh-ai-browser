# 更新日志 / Changelog

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

