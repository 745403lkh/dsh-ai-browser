# Changelog

## 1.0.0 — 2026-10-31

首个正式版本：AI 浏览器模式。

- **AI 浏览器模式（Agent Preset `ai-browser`）**：新建对话时在「标准模式 / 创造模式」之外多一个「AI 浏览器模式」，不影响模型与思考强度设置；选中后会话右侧自动打开浏览器面板，对话区收窄到左侧。
- **应用内浏览器面板**：DSH 桌面版应用内 `<webview>`，不启动外部浏览器、不碰系统鼠标；同一会话最多 12 个窗口，顶部页签条切换/新建/关闭，AI 用 `window` 参数指定窗口。
- **浏览器操作（`browser` 工具）**：`state / windows / downloads / open / read / click / type / press / scroll / back / forward / reload / inspect / screenshot / download / new_window / close_window / request_access`；`read` 返回正文与带 index 的可交互元素，先读再按 index 操作。
- **后台执行**：操作全部通过 `<webview>` 脚本执行与合成输入事件完成，不移动系统鼠标、不要求 DSH 在前台；窗口最小化时仍可继续（后台节流会略降速）。
- **每窗口四级浏览器权限**：仅可查看 / 仅简单操作 / 自动审查 / 完全权限；入口在面板工具栏刷新按钮右侧、网址栏左侧；新窗口继承当前窗口级别；权限按「会话 + 窗口」持久化到 `$DSH_HOME/storages/dsh-ai-browser/permissions.json`。
- **风险警告**：切换到「自动审查」或「完全权限」时弹出确认，需勾选「我已了解风险」。
- **权限不足时主动申请授权**：工具会主动弹出一次性授权申请，弹窗写明目标窗口/页面、具体操作和原因（`reason`）；被拒后向用户解释而不是静默结束；`request_access` 可先申请再执行（需带目标动作参数）。
- **下载**：页面文件链接自动拦截 + `download` 动作；页面内取回失败时回退 Host 直连下载（绕页面 CORS、流式写盘、512MB 上限、拒绝本机/内网地址防 SSRF）；大文件 HTTP Range 断点续传 + 总大小校验，只有完整才改名最终文件，中断保留 `.part` 供续传。
- **浏览器式下载面板**：地址栏右侧下载按钮打开；进行中任务显示进度条、百分比、已下载/总大小、实时速度；完成的文件可直接「打开」（系统默认程序）或复制路径；隐藏 `.part` 临时文件。
- **下载位置**：当前工作区 `browser download/`；工作区不可用时回退 `$DSH_HOME/storages/dsh-ai-browser/downloads/`。下载属「自动审查」级别，可执行文件等高风险类型升级确认。
- **截图**：保存到 `$DSH_HOME/storages/dsh-ai-browser/screenshots/`，最多 40 张；模型支持图片输入时作为图片附件返回。
- **自检**：`GET /.dsh-ai-browser/health` 返回版本与运行时真实能力；Host/Client 版本不一致时面板提示重启 DSH。
- **安全**：所有 HTTP 接口必须带 `x-dsh-ai-browser: 1` 请求头并来自本机回环来源，不返回 CORS 头；下载 URL 拒绝本机/内网地址；打开下载文件仅限下载目录内；应用内 `<webview>` 由 DSH 主进程强制安全策略（无 Node、禁 devTools、禁系统下载、拒绝系统权限、禁止访问 DSH 自身地址）。
- **依赖**：不依赖任何第三方 npm 包；不调用其它插件的接口。
