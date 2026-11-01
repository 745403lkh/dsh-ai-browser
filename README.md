# dsh-ai-browser：AI 浏览器 / AI Browser

## 中文

Harness 里的一个应用内浏览器模式：在会话右侧打开浏览器面板，AI 可以读取页面、点击、输入、滚动、截图和下载文件；同时提供按窗口细分的四级浏览器权限、风险警告与限制性授权越权。

底层是 DSH 桌面版的应用内 `<webview>`（不启动外部浏览器、不碰系统鼠标），Host 只负责命令队列、权限与文件保存。

### 功能

#### 1. AI 浏览器模式（Agent Preset）

- 新建对话时在「标准模式 / 创造模式」之外多一个「AI 浏览器模式」（preset id：`ai-browser`）。
- 不影响模型与思考强度设置：模型选择、reasoning effort 均沿用原有配置。
- 选中模式后，会话右侧自动打开浏览器面板，对话区收窄到左侧；面板按会话隔离。手动关闭面板后，可从输入框「+」命令菜单里的「打开 AI 浏览器」重新打开。

#### 2. 浏览器操作（`browser` 工具）

- `state / windows / downloads / bookmarks / history`：查看窗口、页面状态与已下载文件，读取当前工作区的收藏与历史记录。
- `open / read / click / type / press / scroll / back / forward / reload / inspect / screenshot`：打开、读取、点击、输入、按键、滚动、导航、元素详情与截图。
- `read` 返回正文 + 带 `index` 的可交互元素；先 `read` 再按 index 操作；页面跳转后重新 `read`。
- `bookmarks` / `history` 读取当前工作区（按工作区隔离）的收藏和历史记录；面板工具栏的收藏/历史按钮也能查看和整理这些数据（见第 6 节）。
- **多窗口（不限数量）**：`new_window` / `close_window` 管理，用 `window` 参数指定窗口（省略则操作当前激活窗口）。页面里 `target="_blank"` 或 `window.open` 打开的链接会自动新建标签页、切换过去，AI 也能直接操作新标签页。
- **后台也能干活，不碰鼠标**：所有操作通过应用内 `<webview>` 的脚本执行与合成输入事件完成，不移动系统鼠标、不要求 DSH 在前台；窗口最小化时仍可继续加载与操作（Electron 后台节流会让速度略降）。
- 网页内容是不可信数据：工具输出会提示模型只当作资料，不执行页面里的指令。

#### 3. 四级浏览器权限（每个窗口独立）

| 级别 | 能力 |
| --- | --- |
| 仅可查看 | 读取页面、截图、查看窗口与页面状态 |
| 仅简单操作 | + 打开网址、前进/后退/刷新、滚动、输入文字、新建/关闭窗口 |
| 自动审查 | + 点击/按键/下载；高风险目标（支付、删除、提交订单、密码框等）自动升级确认 |
| 完全权限 | 所有浏览器操作放行 |

- 入口在浏览器面板工具栏：**刷新按钮右侧、网址栏左侧**（独立于工作区修改权限）。
- **站点名单（硬逻辑，按工作区隔离）**：下载按钮右侧的设置按钮里，每个工作区各自维护四档网址名单（不限数量）。匹配规则：写 `baidu.com` 匹配该域名及所有子域（`www.baidu.com`、`fanyi.baidu.com`）；写 `www.baidu.com` 只匹配该主机；带路径的 `www.baidu.com/xyz` 匹配该路径及下级。命中名单直接使用名单档位，未命中一律仅可查看；条目可开启「无需授权访问」，开启后 AI 打开该站点无需申请授权。新窗口/外链不继承旧权限，按目标站点重新套用名单。
- **权限预设（Harness 设置页）**：设置里新增「AI 浏览器」页（黑白简笔画地球图标），可创建多个预设、自定义名字、编辑四档名单、指定默认预设；新工作区第一次打开浏览器模式时自动套用默认预设，浏览器面板设置里也能一键把预设应用到当前工作区。
- **预设搜索**：权限预设列表支持按预设名字搜索，输入即实时过滤（Harness 设置「AI 浏览器」页与浏览器面板的权限设置里都能搜）。
- **预设导入 / 导出（人类可读 txt）**：预设可导出为 txt 分享给他人，也可直接导入他人分享的 txt。格式为 `# name:` 头 + `[view]` / `[simple]` / `[review]` / `[full]` 四个分节，每个分节下逐行写站点条目，条目可带 ` !noauth` 表示「无需授权访问」，例如：

```txt
# name: 我的常用预设
[view]
example.com
[simple]
baidu.com !noauth
[review]
docs.example.org
[full]
intranet.example.com
```

- **浏览器面板设置**：权限设置里新增「存为预设」（把当前工作区四档名单保存成一个预设）、「导出当前工作区」（把当前工作区名单导出为 txt）、「导入到当前工作区」（从 txt 导入名单到当前工作区）。
- **设置页导入 / 导出**：Harness 设置 →「AI 浏览器」页同样提供预设导入 / 导出与搜索，可直接导入他人分享的预设 txt，不用手抄名单。
- **名单折叠**：某一档站点名单超过 3 条时自动折叠，每一档独立展开/收起。
- 每个窗口有自己的级别；新窗口继承当前窗口级别。
- 切换到「自动审查」或「完全权限」时弹出风险确认（需勾选「我已了解风险」）。
- **权限不足时 AI 不会直接结束**：工具会主动发起一次性授权申请，弹窗写明目标窗口/页面、要执行的具体操作和原因（`reason`）；被拒后 AI 向用户解释而不是静默停止。`request_access` 可先申请再执行（需带上目标动作的 URL/index 等参数）。
- 应用内 `<webview>` 是原生视图、会盖住页面 DOM 覆盖层：打开权限菜单、警告弹窗或下载弹窗时会临时隐藏 webview 区域，关闭后恢复。

#### 4. 下载

- 页面里的文件链接会被自动拦截，或由 AI 调用 `download`（url 或 index）。
- 先尝试页面内 `fetch` 取回（可带页面登录态）；跨域失败时自动回退到 **Host 直连下载**（绕过页面 CORS，流式写盘，上限 512MB，拒绝本机/内网地址防 SSRF）。
- 大文件用 HTTP Range **断点续传** + `Content-Length` 总大小校验：只有字节数达到服务端声明的总大小才改名为最终文件；中断时保留 `.part` 供下次续传，不会把半成品当成下载成功。
- 文件保存到当前工作区 `browser download/`（同名自动加序号）；工作区不可用时回退到 `$DSH_HOME/storages/dsh-ai-browser/downloads/`。
- 地址栏右侧的下载按钮打开**浏览器式下载弹窗**：像浏览器一样挂在按钮下方，不遮挡页面操作；下载任务创建时自动弹出，点击其它地方或按 Esc 自动收回。权限菜单和下载面板都在工具栏下方**内嵌展开**，不覆盖、不隐藏浏览器画面，展开时网页仍然可见可点；再次点按钮、点其它地方或按 Esc 即可收回。进行中的任务显示进度条、百分比、已下载/总大小、实时速度（约 1 秒刷新），可**暂停/继续/取消**；任务超过 3 个时默认只显示 3 个，点「查看更多」展开。完成的文件可**直接「打开」**（系统默认程序），也可复制路径或打开下载文件夹。AI 也能通过 `downloads` 查看任务状态，用 `pause_download / resume_download / cancel_download` 控制。
- **下载弹窗不残留空白标签页**：部分网站用 `window.open` 打开下载链接、下载一开始就立刻关闭弹窗，以前浏览器会留下一个空白页面；现在会自动识别并关闭这类下载型弹窗，加载后仍是空白/无标题的弹窗也会被自动关闭。
- 下载属于「自动审查」级别；`.exe / .msi / .apk` 等高风险类型会升级确认。

#### 5. 截图

- `screenshot` 截图保存到 `$DSH_HOME/storages/dsh-ai-browser/screenshots/`，最多保留 40 张。
- 模型支持图片输入时会同时作为图片附件返回。

#### 6. 收藏与历史

- 工具栏新增收藏（星形）和历史按钮，点击后以内联面板展开在工具栏下方，不遮挡网页；再次点按钮、点其它地方或按 Esc 收回。
- 收藏：查看、打开、删除当前工作区的收藏；同一网址只收藏一次（重复收藏会更新标题）。
- 历史：查看、打开历史记录、清空历史；页面地址变化时记录，自动去重并保留最近 500 条。
- 两者都按工作区独立存储，切换工作区不会看到别的工作区的数据。
- AI 可以通过 `browser` 工具的 `bookmarks` / `history` 动作读取当前工作区的收藏和历史记录。

### 界面

- 右侧栏页签「AI 浏览器」，顶部是窗口页签条（切换/新建/关闭）。
- 工具栏：后退、前进、刷新、浏览器权限控件、地址栏、下载按钮、设置按钮，以及收藏（星形）和历史按钮。
- 收藏与历史都以内联面板展开在工具栏下方，不覆盖浏览器画面；再次点按钮、点其它地方或按 Esc 即可收回。
- 黑白简笔画地球是浏览器模式的核心视觉：会话列表运行状态、输入框「+」菜单的「打开 AI 浏览器」、Harness 设置「AI 浏览器」页入口都使用地球图标；浏览器模式会话在侧边栏左侧显示地球标识，运行中显示旋转地球，不再显示通用转圈状态。
- 地球只在浏览器模式会话真正执行任务时旋转；空闲时保持静止，不会一直转。
- 地球状态不只在对话页生效：新增侧栏会话行状态桥接，离开对话界面后，侧栏会话行仍按真实的运行状态显示静态或旋转地球，不会退回通用转圈。
- 左侧对话区保留完整的 AI 对话与授权弹窗（DSH 自带）。

### 本机数据

`$DSH_HOME/storages/dsh-ai-browser/`：

| 路径 | 内容 |
| --- | --- |
| `permissions.json` | 四级权限状态（按会话 + 窗口持久化） |
| `sites.json` | 四档站点名单（按工作区隔离） |
| `library.json` | 收藏与历史记录（按工作区隔离，历史最多 500 条） |
| `presets.json` | 权限预设、默认预设与已初始化工作区列表 |
| `screenshots/` | 截图，最多 40 张 |
| `downloads/` | 工作区不可用时的下载回退目录 |

### 接口

所有接口（含 GET）都必须携带本地客户端请求头 `x-dsh-ai-browser: 1`，且只接受本机回环来源（`Host` 必须是 `localhost` / `127.0.0.1` / `[::1]`；带 `Origin` 时必须是同源或桌面壳协议）。接口从不返回 CORS 头，跨站页面无法触发。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/.dsh-ai-browser/health` | 插件版本与运行时能力清单（用于 Host/Client 版本自检） |
| POST | `/.dsh-ai-browser/session` | 会话窗口列表与各窗口权限级别 |
| POST | `/.dsh-ai-browser/level` | 设置指定窗口的权限级别 `{ sessionId, windowId, level }` |
| POST | `/.dsh-ai-browser/report` | 面板上报窗口状态（URL/标题/激活窗口） |
| POST | `/.dsh-ai-browser/poll` | 长轮询拉取待执行命令 |
| POST | `/.dsh-ai-browser/result` | 回传命令结果 |
| POST | `/.dsh-ai-browser/download` | 保存页面内取回的字节（≤128MB，base64） |
| POST | `/.dsh-ai-browser/download-url` | Host 直连下载（断点续传，≤512MB） |
| POST | `/.dsh-ai-browser/downloads` | 列出已下载文件与进行中的下载任务（含进度/速度） |
| POST | `/.dsh-ai-browser/open-download` | 用系统默认程序打开下载目录内的文件 |
| GET | `/.dsh-ai-browser/library?sessionId=` | 当前工作区的收藏与历史记录 |
| POST | `/.dsh-ai-browser/library` | 收藏/历史操作 `{ sessionId, action: bookmark-add / bookmark-remove / history-clear }` |
| GET | `/.dsh-ai-browser/presets` | 权限预设列表与默认预设 |
| POST | `/.dsh-ai-browser/presets` | 权限预设操作 `{ action: create / update / delete / set-default / apply }` |

浏览器工具的 `bookmarks` / `history` 动作读取当前工作区的收藏与历史记录（见第 2 节）。

错误响应统一为 `{ ok: false, error: { code, message } }`。

### 前提与限制

- 需要 **DSH 桌面版**（应用内 webview）。用浏览器打开的 Web GUI 没有浏览器载体，面板会提示不支持。
- 内嵌 `<webview>` 的安全策略由 DSH 主进程强制：无 Node 权限、禁用插件与 devTools（打包版）、禁用系统下载、拒绝系统权限、禁止打开 DSH 应用自身地址（含 localhost 回环服务）。因此下载由 Host 负责写盘，而不是交给 Chromium 原生下载。
- 浏览器存储按会话隔离（`session:<id>` 分区），重启应用后登录状态不保留；同一会话刷新面板会重建隔离分区。
- Host 直连下载不携带页面 Cookie：需要登录态的文件优先走页面内取回路径。
- 不依赖任何第三方 npm 包；不调用其它插件的接口（侧边栏页签、输入框工具行、shell 覆盖层都用 DSH 自带槽位）。
- **安全边界**：浏览器权限是产品层的操作边界，用于约束 AI 在面板里的动作；它不是一个能对抗本机任意代码执行的沙箱。AI 浏览器模式的 preset 仍带 shell/文件系统工具，拥有 shell 的模型理论上可通过本机 HTTP 接口绕过权限控件。需要更强隔离时，可在 profile patch 里覆盖 `preset-ai-browser` 的 plugins 列表，移除 shell/文件系统工具。

### 结构

| 文件 | 作用 |
| --- | --- |
| `index.js` | Host 入口：注入服务、注册 HTTP 路由、版本/能力自检 |
| `preset.js` | Agent Preset：`browser` 工具、权限校验与主动授权、系统提示词 |
| `lib/runtime.js` | 会话运行时：窗口状态、命令队列、截图保存、会话权限 |
| `lib/downloads.js` | 下载：断点续传、大小校验、进度任务、打开下载文件 |
| `lib/routes.js` | 同源 HTTP 接口与安全守卫（请求头 + 回环来源） |
| `lib/permissions.js` | 四级权限定义、动作能力映射与高风险启发式 |
| `lib/browser-permissions.js` | 按「会话 + 窗口」持久化权限状态 |
| `lib/library.js` | 收藏与历史记录：按工作区存储、自动去重与数量上限 |
| `lib/presets.js` | 权限预设：创建/编辑/删除、默认预设、应用与工作区自动初始化 |
| `lib/home.js` | DSH home 路径解析 |
| `client.js` | 浏览器半侧：面板、`<webview>` 租约、下载面板、权限 UI、收藏/历史面板、设置页 |
| `cordis.patch.yml` | Loader 补丁：Host 行 + Agent Preset 行 |
| `locale/zh.json` / `locale/en.json` | 界面文案 |
| `icon.svg` | 插件图标 |

### 依赖

不依赖任何第三方 npm 包：Host 只用 Node 内置能力与 Harness 服务（`agents` / `agentPresets` / `workingDirectory` / `webServer` / `approval`）；Client 通过 `window.__ModuleLoader__.load` 请求平台自带的 React，应用内浏览器通过 `window.dshDesktop.browser` 租约创建 `<webview>`。

### 备注

- 下载与截图都在后台完成，不需要 DSH 位于前台，也不需要用户操作鼠标。
- 命令默认超时 60 秒；下载由独立模块计时（单次连接 120 秒后自动断点续传，整体最长 30 分钟）。
- `/health` 会返回版本与运行时实际能力；Host 代码版本与 Client 不一致时，面板会提示「请重启 DSH」，避免功能静默失败。
- npm 包名：`dsh-ai-browser`；许可证：MIT（见 `LICENSE`）。

### 许可证 / License

[MIT](LICENSE) © 2026 Akivelli

## English

An in-app browser mode for Harness: open a browser panel on the right side of a conversation, and let the AI read pages, click, type, scroll, take screenshots and download files. It also provides per-window four-level browser permissions, risk warnings and restricted authorization escalation.

The browser is an in-app `<webview>` in the DSH desktop app (no external browser is launched and no system mouse is used); the host only handles the command queue, permissions and file saving.

### Features

#### 1. AI Browser mode (Agent Preset)

- A new "AI Browser mode" next to Standard and Create when starting a conversation (preset id: `ai-browser`).
- It does not change model or thinking-effort settings: model choice and reasoning effort follow the existing configuration.
- When selected, the browser panel opens automatically on the right and the conversation narrows to the left; the panel is isolated per session. If you close the panel manually, reopen it from "Open AI browser" in the composer's "+" command menu.

#### 2. Browser operations (`browser` tool)

- `state / windows / downloads / bookmarks / history`: inspect windows, page state and downloaded files, and read the current workspace's bookmarks and history.
- `open / read / click / type / press / scroll / back / forward / reload / inspect / screenshot`: open, read, click, type, press keys, scroll, navigate, inspect an element and take screenshots.
- `read` returns page text plus indexed interactive elements; read first, then act by index; re-read after navigation.
- `bookmarks` / `history` read the current workspace's bookmarks and history (both stored per workspace); the bookmark/history buttons in the panel toolbar manage the same data (see section 6).
- **Multiple windows (no hard limit)**: managed with `new_window` / `close_window`, and targeted via the `window` parameter (the active window is used when omitted). Links opened via `target="_blank"` or `window.open` create a new tab automatically, switch to it, and the AI can operate that tab too.
- **Background operation, no mouse**: everything runs through in-app `<webview>` script execution and synthesized input events. The system mouse is never moved, DSH does not need to be in the foreground, and browsing continues while the window is minimized (Electron background throttling may slow it slightly).
- Page content is untrusted data: tool output tells the model to treat it as reference material and not to follow instructions found in the page.

#### 3. Four-level browser permission (per window)

| Level | Capabilities |
| --- | --- |
| View only | Read pages, take screenshots, inspect windows and page state |
| Simple actions | + open URLs, back/forward/reload, scroll, type text, create/close windows |
| Auto review | + click / press keys / download; high-risk targets (payment, delete, submit order, password fields, etc.) are escalated for confirmation |
| Full access | All browser actions are allowed |

- The control lives in the browser panel toolbar: **to the right of Refresh and to the left of the address bar** (independent of the workspace modification permission).
- **Site lists (hard logic, per workspace)**: the settings button right of the download button holds four lists per workspace (no entry limit). A bare domain entry (`baidu.com`) matches the domain and all subdomains (`www.baidu.com`, `fanyi.baidu.com`); a prefixed entry (`www.baidu.com`) matches that host only; a path entry (`www.baidu.com/xyz`) matches that path and its children. Listed sites use that level; unlisted sites are view-only; each entry has "No authorization needed" so the AI can open it without approval. New windows and external links do not inherit the old permission — the target site's list entry is applied instead.
- **Permission presets (Harness Settings page)**: a new "AI Browser" page in Settings (black-and-white line-art Earth icon) lets you create multiple presets, give them custom names, edit the four site lists and pick a default preset; a new workspace applies the default preset automatically the first time AI Browser mode is used, and the browser panel settings can apply a preset to the current workspace in one click.
- **Preset search**: permission presets can be searched by name, filtering the list as you type (available on the Harness Settings "AI Browser" page and in the browser panel's permission settings).
- **Preset import / export (human-readable txt)**: a preset can be exported as txt and shared, and a txt shared by others can be imported directly. The format is a `# name:` header plus `[view]` / `[simple]` / `[review]` / `[full]` sections; each section lists site entries one per line, and an entry may end with ` !noauth` meaning "no authorization needed", for example:

```txt
# name: My usual preset
[view]
example.com
[simple]
baidu.com !noauth
[review]
docs.example.org
[full]
intranet.example.com
```

- **Browser panel settings**: the permission settings now provide "Save as preset" (save the current workspace's four lists as a preset), "Export current workspace" (export the current workspace's lists as txt) and "Import into current workspace" (import lists from txt into the current workspace).
- **Settings page import / export**: Harness Settings → "AI Browser" also supports preset import / export and search, so a preset txt shared by someone else can be imported directly instead of copying the lists by hand.
- **List folding**: when a site list has more than 3 entries it collapses automatically, with independent expand/collapse per level.
- Each window has its own level; new windows inherit the current window's level.
- Switching to Auto review or Full access shows a risk confirmation (requires checking "I understand the risks").
- **The AI does not stop when permission is insufficient**: the tool raises a one-time approval request that names the target window/page, the exact operation and the reason (`reason`); after a rejection the AI explains instead of silently stopping. `request_access` can ask first and then execute (include the target action's URL/index parameters).
- The in-app `<webview>` is a native view that covers DOM overlays: while the permission menu, warning dialog or download dialog is open, the webview area is temporarily hidden and restored afterwards.

#### 4. Downloads

- File links on the page are intercepted automatically, or the AI calls `download` (url or index).
- The page tries an in-page `fetch` first (keeping page login state); on CORS failure it falls back to a **direct host download** (bypasses page CORS, streams to disk, 512MB cap, rejects loopback/private addresses against SSRF).
- Large files use HTTP Range **resume** plus a `Content-Length` size check: only when the byte count reaches the server-declared total is the file renamed to its final name; interrupted downloads keep a `.part` file for the next resume, so a partial file is never reported as a success.
- Files are saved to `browser download/` in the current workspace (same names get numbered suffixes); when the workspace is unavailable, they fall back to `$DSH_HOME/storages/dsh-ai-browser/downloads/`.
- The download button to the right of the address bar opens a **browser-style download popup**: anchored under the button like a real browser, it does not block the page, opens automatically when a download task starts, and closes on outside click or Esc. The permission menu and download panel expand **inline below the toolbar**, so the browser page is never covered or hidden and stays clickable while they are open; click the button again, click elsewhere, or press Esc to close them. Active tasks show a progress bar, percentage, downloaded/total size and live speed (refreshed about every second) and can be **paused / resumed / cancelled**; when there are more than 3 tasks, only 3 are shown until you click "Show more". Completed files can be **opened directly** with the system default app, copied as a path, or revealed in the download folder. The AI can also inspect task state via `downloads` and control it with `pause_download / resume_download / cancel_download`.
- Download popups no longer leave a blank tab: some sites open a download link with `window.open` and close the popup as soon as the download starts, which used to leave an empty page behind. Such download popups are now detected and closed automatically, as are popups that stay blank / title-less after loading.
- Downloads are reviewed at the "Auto review" level; risky types such as `.exe / .msi / .apk` are escalated for confirmation.

#### 5. Screenshots

- `screenshot` saves images to `$DSH_HOME/storages/dsh-ai-browser/screenshots/`, keeping the latest 40.
- When the model supports image input, the screenshot is also returned as an image attachment.

#### 6. Bookmarks and history

- New bookmark (star) and history buttons in the toolbar open inline panels below it without covering the page; click the button again, click elsewhere or press Esc to close them.
- Bookmarks: view, open and delete bookmarks in the current workspace; a URL is bookmarked only once (bookmarking it again updates its title
- History: view and open entries and clear the history; entries are recorded when the page address changes, de-duplicated automatically and capped at the latest 500.
- Both are stored per workspace, so switching workspaces never shows another workspace's data.
- The AI can read the current workspace's bookmarks and history through the browser tool's `bookmarks` / `history` actions.

### UI

- Right-sidebar tab "AI Browser", with a window tab strip on top (switch/create/close).
- Toolbar: back, forward, reload, browser permission control, address bar, download button, settings button, and bookmark (star) and history buttons.
- Bookmark and history panels expand inline below the toolbar without covering the browser page; click the button again, click elsewhere or press Esc to close them.
- Black-and-white line-art Earth as the core AI Browser visual: the session list running status, the "Open AI browser" item in the composer "+" menu and the Harness Settings "AI Browser" page entry all use the Earth icon; AI Browser sessions show an Earth marker on the left of the sidebar, and it rotates while running instead of showing the generic spinner.
- The Earth rotates only while an AI Browser session is actually running; it stays still when idle.
- The Earth status is no longer limited to the conversation view: a new sidebar session-row state bridge keeps the real running state outside the conversation, so the session row shows a static or spinning Earth instead of falling back to the generic spinner.
- The conversation on the left keeps the full AI chat and approval dialogs (provided by DSH).

### Local data

`$DSH_HOME/storages/dsh-ai-browser/`:

| Path | Content |
| --- | --- |
| `permissions.json` | Four-level permission state (persisted per session + window) |
| `sites.json` | Four-level site lists (per workspace) |
| `library.json` | Bookmarks and history (per workspace; history keeps the latest 500) |
| `presets.json` | Permission presets, the default preset and the list of initialized workspaces |
| `screenshots/` | Screenshots, keeping the latest 40 |
| `downloads/` | Download fallback directory when the workspace is unavailable |

### API

Every endpoint (including GET) must carry the local client header `x-dsh-ai-browser: 1` and only accepts loopback origins (`Host` must be `localhost` / `127.0.0.1` / `[::1]`; when `Origin` is present it must be same-origin or the desktop shell protocol). The endpoints never return CORS headers, so cross-site pages cannot trigger them.

| Method | Path | Description |
| --- | --- | --- |
| GET | `/.dsh-ai-browser/health` | Plugin version and runtime capability list (used for host/client self-check) |
| POST | `/.dsh-ai-browser/session` | Session window list and each window's permission level |
| POST | `/.dsh-ai-browser/level` | Set a window's permission level `{ sessionId, windowId, level }` |
| POST | `/.dsh-ai-browser/report` | Panel reports window state (URL/title/active window) |
| POST | `/.dsh-ai-browser/poll` | Long-poll for pending commands |
| POST | `/.dsh-ai-browser/result` | Return a command result |
| POST | `/.dsh-ai-browser/download` | Save bytes fetched in the page (≤128MB, base64) |
| POST | `/.dsh-ai-browser/download-url` | Direct host download (resumable, ≤512MB) |
| POST | `/.dsh-ai-browser/downloads` | List downloaded files and active download tasks (with progress/speed) |
| POST | `/.dsh-ai-browser/open-download` | Open a file in the download directory with the system default app |
| GET | `/.dsh-ai-browser/library?sessionId=` | Bookmarks and history of the current workspace |
| POST | `/.dsh-ai-browser/library` | Bookmark/history action `{ sessionId, action: bookmark-add / bookmark-remove / history-clear }` |
| GET | `/.dsh-ai-browser/presets` | Permission presets and the default preset |
| POST | `/.dsh-ai-browser/presets` | Permission preset action `{ action: create / update / delete / set-default / apply }` |

The browser tool's `bookmarks` / `history` actions read the current workspace's bookmarks and history (see section 2).

Error responses are uniformly `{ ok: false, error: { code, message } }`.

### Requirements & limitations

- Requires the **DSH desktop app** (in-app webview). The Web GUI opened in a browser has no browser carrier, and the panel shows that it is unsupported.
- The embedded `<webview>` is locked down by the DSH main process: no Node permission, plugins and devTools disabled (packaged build), system downloads disabled, system permissions denied, and DSH's own addresses (including localhost loopback services) blocked. Downloads are therefore written by the host instead of Chromium's native download flow.
- Browser storage is isolated per session (`session:<id>` partition); login state is not kept after restarting the app, and refreshing the panel within the same session recreates the isolated partition.
- The direct host download does not carry page cookies: files that need login state should prefer the in-page fetch path.
- No third-party npm dependencies; no other plugin's APIs are used (the sidebar tab, composer controls and shell overlay all use built-in DSH slots).
- **Security boundary**: browser permissions are a product-level operation boundary that constrains the AI's actions inside the panel; they are not a sandbox against arbitrary local code execution. The AI Browser preset still ships shell/filesystem tools, and a model with shell access could theoretically bypass the permission controls through the local HTTP API. For stronger isolation, override the `preset-ai-browser` plugins list in a profile patch and remove the shell/filesystem tools.

### Structure

| File | Purpose |
| --- | --- |
| `index.js` | Host entry: injects services, registers HTTP routes, version/capability self-check |
| `preset.js` | Agent Preset: `browser` tool, permission checks and proactive authorization, system prompt |
| `lib/runtime.js` | Session runtime: window state, command queue, screenshot saving, session permissions |
| `lib/downloads.js` | Downloads: resume, size validation, progress tasks, opening downloaded files |
| `lib/routes.js` | Same-origin HTTP endpoints and guards (header + loopback origin) |
| `lib/permissions.js` | Four-level permission definitions, action capability mapping and risk heuristics |
| `lib/browser-permissions.js` | Persists permission state per "session + window" |
| `lib/library.js` | Bookmarks and history: per-workspace storage, de-duplication and caps |
| `lib/presets.js` | Permission presets: create/edit/delete, default preset, apply and workspace auto-initialization |
| `lib/home.js` | DSH home path resolution |
| `client.js` | Browser side: panel, `<webview>` lease, download panel, permission UI, bookmark/history panels, settings page |
| `cordis.patch.yml` | Loader patch: host row + Agent Preset row |
| `locale/zh.json` / `locale/en.json` | UI strings |
| `icon.svg` | Plugin icon |

### Dependencies

No third-party npm packages: the host uses only Node built-ins and Harness services (`agents` / `agentPresets` / `workingDirectory` / `webServer` / `approval`); the client requests the platform-provided React through `window.__ModuleLoader__.load`, and the in-app browser creates its `<webview>` through the `window.dshDesktop.browser` lease.

### Notes

- Downloads and screenshots happen in the background; DSH does not need to be in the foreground and the user does not need to operate the mouse.
- Commands time out after 60s by default; downloads are timed by a separate module (each connection attempt runs up to 120s then resumes automatically, with an overall limit of 30 minutes).
- `/health` reports the version and real runtime capabilities; when the host code version differs from the client, the panel prompts to restart DSH so features do not fail silently.
- npm package name: `dsh-ai-browser`; license: MIT (see `LICENSE`).

### License

[MIT](LICENSE) © 2026 Akivelli
