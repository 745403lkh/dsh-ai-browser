/**
 * dsh-ai-browser 的浏览器半侧（1.0.0-beta.2）。
 *
 * 座位：
 * - 右侧栏页签类型 `ai-browser`：多窗口应用内浏览器（每个窗口一个 Desktop
 *   `<webview>` 租约）+ 窗口页签条 + 地址栏/前进后退/刷新 + 每窗口权限控件
 *   （权限入口位于刷新按钮右侧、网址栏左侧）；
 * - `conversation.input.left`：无可见 UI 的会话锚点，负责在 AI 浏览器模式会话
 *   进入时自动打开右侧面板；
 * - `shell.overlay`：每窗口权限菜单与高风险权限警告弹窗。
 *
 * 下载：页面内拦截文件链接 / AI 的 download 动作都会把文件取回，POST 给 Host
 * 保存到当前工作区 `browser download/` 文件夹。
 *
 * 这是外部 classic script，由 shell 以 window.__ModuleLoader__.load 加载。
 */

(function () {
  window.__ModuleLoader__.load({
    id: 'dsh-ai-browser',
    factory: function (require) {
      var React = require('react')
      var h = React.createElement

      var NS = 'dsh-ai-browser'
      var TAB_ID = 'dsh-ai-browser'
      var TAB_KIND = 'ai-browser'
      var ROUTE = '/.dsh-ai-browser'
      var PRESET_ID = 'ai-browser'
      var LEVELS = ['view', 'simple', 'review', 'full']
      var DOWNLOAD_CHUNK = 524288
      /** 客户端版本：与 Host /health 返回的版本比对，用于提示「Host 代码仍是旧的，需要重启 DSH」。 */
      var CLIENT_VERSION = '1.1.1'
      /** Host 侧提供下载/下载列表能力所需的最小 feature 集。 */
      var REQUIRED_HOST_FEATURES = ['download-url', 'downloads']
      /** Harness 设置页的 section id（设置导航里的「AI 浏览器」）。 */
      var SETTINGS_SECTION = 'ai-browser'

      var PLUGIN_CTX = null
      var AUTO_OPENED = {}
      /** sessionId -> 是否 AI 浏览器模式（由 SessionAnchor 的 agentPreset 投影维护）。 */
      var BROWSER_SESSIONS = {}
      /**
       * sessionId -> 是否正在运行（由 SessionAnchor 通过 slot 标准 prop
       * `useSessionStatus` 写入）。会话行地球只认这个缓存：running 为 true 才旋转。
       * useSessionStatus 不可用时缓存永远没有 true，因此一律不旋转。
       */
      var RUNNING_SESSIONS = {}
      var UI = { state: { menu: null, warning: null, downloads: null, error: null, tick: 0 }, listeners: [] }

      function uiNotify() {
        UI.state = Object.assign({}, UI.state, { tick: UI.state.tick + 1 })
        var listeners = UI.listeners.slice()
        for (var index = 0; index < listeners.length; index += 1) {
          try {
            listeners[index]()
          } catch (error) {
            /* 忽略 */
          }
        }
      }
      function uiSet(patch) {
        UI.state = Object.assign({}, UI.state, patch)
        uiNotify()
      }
      function uiSubscribe(listener) {
        UI.listeners.push(listener)
        return function () {
          var at = UI.listeners.indexOf(listener)
          if (at >= 0) UI.listeners.splice(at, 1)
        }
      }

      var ZH = {
        'tab.title': 'AI 浏览器',
        'perm.current': '当前窗口浏览器权限：{name}',
        'perm.window': '窗口：{name}',
        'perm.menu.title': '浏览器权限（仅作用于当前窗口）',
        'perm.view': '仅可查看',
        'perm.simple': '仅简单操作',
        'perm.review': '自动审查',
        'perm.full': '完全权限',
        'perm.view.hint': 'AI 只能读取页面、截图，不能跳转或操作页面。',
        'perm.simple.hint': 'AI 可以跳转、刷新、前进后退、滚动、输入文字、开关窗口，不能点击或提交表单。',
        'perm.review.hint': 'AI 可以点击页面、按键和下载文件，自动审查会检查高风险目标。',
        'perm.full.hint': 'AI 可以执行任何浏览器操作，不再额外确认。请仅在信任的站点和任务中使用。',
        'perm.warning.title': '确认开启更高的浏览器权限？',
        'perm.warning.review':
          '「自动审查」允许 AI 在该窗口点击页面、按键和下载文件，并自动检查高风险目标。自动审查可能漏判，请确认窗口里访问的网站和任务是可信的。',
        'perm.warning.full': '「完全权限」允许 AI 在该窗口执行任何浏览器操作，不再经过确认，可能造成不可撤销的后果。',
        'perm.warning.ack': '我已了解风险，并愿意继续',
        'perm.warning.cancel': '取消',
        'perm.warning.confirm': '仍要开启',
        'perm.failed': '浏览器权限切换失败',
        'panel.newWindow': '新建窗口',
        'panel.closeWindow': '关闭窗口',
        'panel.addressPlaceholder': '输入网址后回车',
        'panel.back': '后退',
        'panel.forward': '前进',
        'panel.reload': '刷新',
        'panel.empty': '点击「新建窗口」开始浏览，或直接在对话里告诉 AI 要做什么。',
        'panel.starting': '正在启动应用内浏览器…',
        'panel.unsupported': 'AI 浏览器面板需要 DSH 桌面版（应用内 webview）。',
        'panel.failed': '应用内浏览器启动失败',
        'panel.loading': '加载中…',
        'panel.window': '窗口 {n}',
        'panel.settings': '设置',
        'settings.title': '站点名单（当前工作区）',
        'settings.workspace': '工作区',
        'settings.hint': '名单按当前工作区保存。写 baidu.com 会匹配所有子域；写 www.baidu.com 只匹配该主机；带路径（www.baidu.com/xyz）会匹配该路径及其下级。未命中名单一律仅可查看，开启「无需授权访问」后 AI 打开该站点无需申请授权。',
        'settings.empty': '暂无站点',
        'settings.add': '添加',
        'settings.placeholder': '输入网址，如 www.baidu.com',
        'settings.noAuth': '无需授权访问',
        'settings.delete': '删除',
        'command.open': '打开 AI 浏览器',
        'command.open.description': '在右侧打开当前会话的 AI 浏览器面板',
        'panel.downloads': '下载内容',
        'downloads.title': '下载',
        'downloads.more': '查看更多',
        'downloads.less': '收起',
        'downloads.folder': '打开文件夹',
        'downloads.done': '已完成',
        'downloads.pause': '暂停',
        'downloads.resume': '继续',
        'downloads.cancel': '取消任务',
        'downloads.paused': '已暂停',
        'downloads.empty': '还没有下载文件。',
        'downloads.refresh': '刷新',
        'downloads.close': '关闭',
        'downloads.copy': '复制路径',
        'downloads.copied': '已复制',
        'downloads.open': '打开',
        'downloads.opening': '正在打开…',
        'downloads.openFailed': '打开失败',
        'downloads.active': '下载中 {percent}% · {done} / {total} · {speed}/s',
        'downloads.waiting': '正在连接…',
        'downloads.failedStatus': '下载失败：{message}',
        'downloads.fallback': '（工作区不可用，保存在 DSH 数据目录）',
        'panel.hostStale': 'Host 侧插件版本较旧（{host}，客户端 {client}），请重启 DSH 后再试下载等功能。',
        'panel.hostNotReady': 'Host 侧插件能力未完全生效（缺少 {missing}），请重启一次 DSH 后再试下载等功能。',
        'panel.downloading': '正在下载「{name}」…',
        'panel.downloaded': '已下载「{name}」，保存到 {path}',
        'panel.downloadFailed': '下载失败：{message}',
        'panel.bookmark': '收藏当前页',
        'panel.bookmarked': '已收藏（点击取消）',
        'panel.history': '历史记录',
        'bookmark.title': '收藏（当前工作区）',
        'bookmark.hint': '收藏按当前工作区保存；点击条目可在当前窗口打开。',
        'bookmark.empty': '还没有收藏。打开网页后点星标即可收藏。',
        'bookmark.add': '收藏当前页',
        'bookmark.remove': '取消收藏当前页',
        'bookmark.delete': '删除收藏',
        'bookmark.failed': '收藏操作失败',
        'bookmark.openList': '查看收藏列表',
        'history.title': '历史记录（当前工作区）',
        'history.hint': '按访问时间倒序；点击条目可在当前窗口打开。',
        'history.empty': '还没有历史记录。',
        'history.clear': '清空历史',
        'settings.presets': '权限预设',
        'settings.presets.empty': '还没有预设。可在「设置 → AI 浏览器」中新建。',
        'settings.presets.isDefault': '默认',
        'settings.presets.noDefault': '尚未设置默认预设',
        'settings.presets.defaultName': '默认：{name}',
        'settings.presets.apply': '应用',
        'settings.presets.applied': '已应用预设「{name}」',
        'settings.presets.seeded': '已自动套用默认预设：{name}',
        'settings.presets.search': '搜索预设',
        'settings.presets.searchClear': '清空搜索',
        'settings.presets.searchEmpty': '没有匹配的预设',
        'settings.presets.export': '导出',
        'settings.presets.exported': '已导出预设「{name}」',
        'settings.presets.exportFailed': '导出失败：{message}',
        'settings.presets.exportWorkspace': '导出当前工作区',
        'settings.presets.workspaceExported': '已导出当前工作区名单',
        'settings.presets.importWorkspace': '导入到当前工作区',
        'settings.presets.workspaceImported': '已导入到当前工作区（{count} 条）',
        'settings.presets.importFailed': '导入失败：{message}',
        'settings.presets.importInvalid': '文件里没有可导入的有效分节，或名单为空',
        'settings.presets.save': '存为预设',
        'settings.presets.saveNamePlaceholder': '新预设名称（留空用默认名）',
        'settings.presets.saveDefaultName': '工作区预设',
        'settings.presets.saved': '已存为预设「{name}」',
        'settings.presets.workspaceName': '当前工作区',
        'settings.more': '展开（{count}）',
        'settings.less': '收起',
        'settingsPage.nav': 'AI 浏览器',
        'settingsPage.title': 'AI 浏览器',
        'settingsPage.intro': '浏览器权限预设：一套可复用的四档站点名单。新工作区会自动套用默认预设，也可以把预设手动应用到任意工作区。',
        'settingsPage.autoApply': '新工作区第一次打开 AI 浏览器时，会自动应用默认预设。',
        'settingsPage.applyHint': '在浏览器面板的「设置」里，可以把任一预设一键应用到当前工作区。',
        'settingsPage.presets': '权限预设',
        'settingsPage.noDefault': '尚未设置默认预设',
        'settingsPage.defaultPreset': '默认预设：{name}',
        'settingsPage.create': '新建',
        'settingsPage.namePlaceholder': '预设名称',
        'settingsPage.baseEmpty': '空名单',
        'settingsPage.baseSelected': '复制选中预设',
        'settingsPage.created': '已创建预设「{name}」',
        'settingsPage.empty': '还没有预设。新建一个预设即可复用到不同工作区。',
        'settingsPage.setDefault': '设为默认',
        'settingsPage.defaultBadge': '默认',
        'settingsPage.rename': '重命名',
        'settingsPage.renameSave': '保存',
        'settingsPage.renameCancel': '取消',
        'settingsPage.editLists': '编辑名单',
        'settingsPage.hideLists': '收起名单',
        'settingsPage.delete': '删除',
        'settingsPage.deleteConfirm': '确定删除预设「{name}」？',
        'settingsPage.deleteYes': '确认删除',
        'settingsPage.cancel': '取消',
        'settingsPage.saved': '已保存',
        'settingsPage.adopted': '已设为默认预设',
        'settingsPage.import': '导入预设',
        'settingsPage.importedName': '导入的预设',
        'settingsPage.imported': '已导入预设「{name}」',
        'settingsPage.export': '导出',
      }
      var EN = {
        'tab.title': 'AI Browser',
        'perm.current': 'Current window permission: {name}',
        'perm.window': 'Window: {name}',
        'perm.menu.title': 'Browser permission (this window only)',
        'perm.view': 'View only',
        'perm.simple': 'Simple actions',
        'perm.review': 'Auto review',
        'perm.full': 'Full access',
        'perm.view.hint': 'The AI can read the page and take screenshots only.',
        'perm.simple.hint': 'The AI can navigate, reload, scroll, type text and manage windows.',
        'perm.review.hint': 'The AI can click, press keys and download files; risky targets are reviewed automatically.',
        'perm.full.hint': 'The AI can perform any browser action in this window without further confirmation.',
        'perm.warning.title': 'Enable a higher browser permission?',
        'perm.warning.review': 'Auto review lets the AI click, press keys and download files in this window, with an automatic risk check that can miss things.',
        'perm.warning.full': 'Full access lets the AI perform any browser action in this window without further confirmation.',
        'perm.warning.ack': 'I understand the risks and want to continue',
        'perm.warning.cancel': 'Cancel',
        'perm.warning.confirm': 'Enable anyway',
        'perm.failed': 'Failed to change browser permission',
        'panel.newWindow': 'New window',
        'panel.closeWindow': 'Close window',
        'panel.addressPlaceholder': 'Enter a URL and press Enter',
        'panel.back': 'Back',
        'panel.forward': 'Forward',
        'panel.reload': 'Reload',
        'panel.empty': 'Click "New window" to start, or just tell the AI what to do in the conversation.',
        'panel.starting': 'Starting the in-app browser…',
        'panel.unsupported': 'The AI browser panel requires the DSH desktop app (in-app webview).',
        'panel.failed': 'Could not start the in-app browser',
        'panel.loading': 'Loading…',
        'panel.window': 'Window {n}',
        'panel.settings': 'Settings',
        'settings.title': 'Site lists (current workspace)',
        'settings.workspace': 'Workspace',
        'settings.hint': 'Lists are saved per workspace. A bare domain such as baidu.com matches all subdomains; www.baidu.com matches that host only; a path entry (www.baidu.com/xyz) matches that path and its children. Sites not in any list are view-only; with "No authorization needed" the AI can open the site without approval.',
        'settings.empty': 'No sites yet',
        'settings.add': 'Add',
        'settings.placeholder': 'Enter a URL, e.g. www.baidu.com',
        'settings.noAuth': 'No authorization needed',
        'settings.delete': 'Delete',
        'command.open': 'Open AI browser',
        'command.open.description': 'Open the AI browser panel for this conversation',
        'panel.downloads': 'Downloads',
        'downloads.title': 'Downloads',
        'downloads.more': 'Show more',
        'downloads.less': 'Show less',
        'downloads.folder': 'Open folder',
        'downloads.done': 'Completed',
        'downloads.pause': 'Pause',
        'downloads.resume': 'Resume',
        'downloads.cancel': 'Cancel task',
        'downloads.paused': 'Paused',
        'downloads.empty': 'No downloaded files yet.',
        'downloads.refresh': 'Refresh',
        'downloads.close': 'Close',
        'downloads.copy': 'Copy path',
        'downloads.copied': 'Copied',
        'downloads.open': 'Open',
        'downloads.opening': 'Opening…',
        'downloads.openFailed': 'Failed to open',
        'downloads.active': 'Downloading {percent}% · {done} / {total} · {speed}/s',
        'downloads.waiting': 'Connecting…',
        'downloads.failedStatus': 'Download failed: {message}',
        'downloads.fallback': '(workspace unavailable; stored in the DSH data directory)',
        'panel.hostStale': 'The host-side plugin is older ({host}, client {client}). Restart DSH before using downloads.',
        'panel.hostNotReady': 'The host-side plugin is not fully active (missing {missing}). Restart DSH before using downloads.',
        'panel.downloading': 'Downloading "{name}"…',
        'panel.downloaded': 'Downloaded "{name}" to {path}',
        'panel.downloadFailed': 'Download failed: {message}',
        'panel.bookmark': 'Bookmark this page',
        'panel.bookmarked': 'Bookmarked (click to remove)',
        'panel.history': 'History',
        'bookmark.title': 'Bookmarks (current workspace)',
        'bookmark.hint': 'Bookmarks are saved per workspace; click an entry to open it in the current window.',
        'bookmark.empty': 'No bookmarks yet. Open a page and click the star to add one.',
        'bookmark.add': 'Bookmark this page',
        'bookmark.remove': 'Remove this bookmark',
        'bookmark.delete': 'Delete bookmark',
        'bookmark.failed': 'Bookmark action failed',
        'bookmark.openList': 'Show bookmarks',
        'history.title': 'History (current workspace)',
        'history.hint': 'Newest first; click an entry to open it in the current window.',
        'history.empty': 'No history yet.',
        'history.clear': 'Clear history',
        'settings.presets': 'Permission presets',
        'settings.presets.empty': 'No presets yet. Create one in Settings → AI Browser.',
        'settings.presets.isDefault': 'Default',
        'settings.presets.noDefault': 'No default preset yet',
        'settings.presets.defaultName': 'Default: {name}',
        'settings.presets.apply': 'Apply',
        'settings.presets.applied': 'Applied preset "{name}"',
        'settings.presets.seeded': 'Default preset applied automatically: {name}',
        'settings.presets.search': 'Search presets',
        'settings.presets.searchClear': 'Clear search',
        'settings.presets.searchEmpty': 'No presets match your search',
        'settings.presets.export': 'Export',
        'settings.presets.exported': 'Exported preset "{name}"',
        'settings.presets.exportFailed': 'Export failed: {message}',
        'settings.presets.exportWorkspace': 'Export workspace',
        'settings.presets.workspaceExported': 'Exported the current workspace lists',
        'settings.presets.importWorkspace': 'Import into workspace',
        'settings.presets.workspaceImported': 'Imported into the current workspace ({count} entries)',
        'settings.presets.importFailed': 'Import failed: {message}',
        'settings.presets.importInvalid': 'The file has no valid sections, or all lists are empty',
        'settings.presets.save': 'Save as preset',
        'settings.presets.saveNamePlaceholder': 'New preset name (leave empty for a default name)',
        'settings.presets.saveDefaultName': 'Workspace preset',
        'settings.presets.saved': 'Saved as preset "{name}"',
        'settings.presets.workspaceName': 'Current workspace',
        'settings.more': 'Show all ({count})',
        'settings.less': 'Show less',
        'settingsPage.nav': 'AI Browser',
        'settingsPage.title': 'AI Browser',
        'settingsPage.intro': 'Browser permission presets: a reusable set of four site lists. New workspaces apply the default preset automatically, and a preset can be applied to any workspace by hand.',
        'settingsPage.autoApply': 'A new workspace applies the default preset the first time the AI browser opens.',
        'settingsPage.applyHint': 'In the browser panel settings you can apply any preset to the current workspace in one click.',
        'settingsPage.presets': 'Permission presets',
        'settingsPage.noDefault': 'No default preset yet',
        'settingsPage.defaultPreset': 'Default preset: {name}',
        'settingsPage.create': 'Create',
        'settingsPage.namePlaceholder': 'Preset name',
        'settingsPage.baseEmpty': 'Empty lists',
        'settingsPage.baseSelected': 'Copy selected preset',
        'settingsPage.created': 'Created preset "{name}"',
        'settingsPage.empty': 'No presets yet. Create one to reuse it across workspaces.',
        'settingsPage.setDefault': 'Set as default',
        'settingsPage.defaultBadge': 'Default',
        'settingsPage.rename': 'Rename',
        'settingsPage.renameSave': 'Save',
        'settingsPage.renameCancel': 'Cancel',
        'settingsPage.editLists': 'Edit lists',
        'settingsPage.hideLists': 'Hide lists',
        'settingsPage.delete': 'Delete',
        'settingsPage.deleteConfirm': 'Delete preset "{name}"?',
        'settingsPage.deleteYes': 'Delete',
        'settingsPage.cancel': 'Cancel',
        'settingsPage.saved': 'Saved',
        'settingsPage.adopted': 'Default preset updated',
        'settingsPage.import': 'Import preset',
        'settingsPage.importedName': 'Imported preset',
        'settingsPage.imported': 'Imported preset "{name}"',
        'settingsPage.export': 'Export',
      }

      function pickLang(locale) {
        try {
          var snapshot = locale.getSnapshot()
          var id = snapshot && (snapshot.id || snapshot.locale)
          if (typeof id === 'string' && id.toLowerCase().indexOf('en') === 0) return 'en'
        } catch (error) {
          /* 忽略 */
        }
        return 'zh'
      }
      function makeTranslate(locale) {
        return function (key, params) {
          var dict = pickLang(locale) === 'en' ? EN : ZH
          var text = dict[key] || ZH[key] || key
          if (params) for (var name of Object.keys(params)) text = text.split('{' + name + '}').join(String(params[name]))
          return text
        }
      }
      function getT(props) {
        if (props && typeof props.t === 'function') return props.t
        if (PLUGIN_CTX !== null && PLUGIN_CTX.locale !== undefined) return makeTranslate(PLUGIN_CTX.locale)
        return function (key) {
          return ZH[key] || key
        }
      }

      function requestJson(path, options) {
        var init = { cache: 'no-store', headers: { 'x-dsh-ai-browser': '1' } }
        if (options) {
          if (options.method !== undefined) init.method = options.method
          if (options.body !== undefined) {
            init.headers['content-type'] = 'application/json'
            init.body = JSON.stringify(options.body)
          }
          if (options.signal !== undefined) init.signal = options.signal
        }
        return fetch(ROUTE + path, init).then(function (response) {
          return response
            .json()
            .catch(function () {
              return null
            })
            .then(function (payload) {
              if (!response.ok || payload === null || payload.ok !== true) {
                var error = payload && payload.error
                var message = error && typeof error === 'object' ? error.message : error || 'HTTP ' + response.status
                throw new Error(String(message))
              }
              return payload
            })
        })
      }
      function errorText(error) {
        if (error === null || error === undefined) return '未知错误'
        if (typeof error === 'string') return error
        return typeof error.message === 'string' ? error.message : String(error)
      }
      function bridgeError(code, message) {
        var error = new Error(message)
        error.bridgeCode = code
        return error
      }
      function sleep(ms) {
        return new Promise(function (resolve) {
          setTimeout(resolve, ms)
        })
      }
      function icon(paths, size) {
        return h(
          'svg',
          { viewBox: '0 0 24 24', width: size || 16, height: size || 16, fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true, focusable: false },
          paths.map(function (d, index) {
            return h('path', { key: index, d })
          }),
        )
      }
      /** 与 icon 相同，但用当前颜色填充（用于「已收藏」的实心星形）。 */
      function iconFilled(paths, size) {
        return h(
          'svg',
          { viewBox: '0 0 24 24', width: size || 16, height: size || 16, fill: 'currentColor', stroke: 'currentColor', strokeWidth: 1.2, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true, focusable: false },
          paths.map(function (d, index) {
            return h('path', { key: index, d })
          }),
        )
      }
      var ICONS = {
        shield: ['M12 3l7 3v5c0 4.5-3 7.7-7 9-4-1.3-7-4.5-7-9V6l7-3Z', 'M9 12l2 2 4-4'],
        back: ['M14.5 5.5 8 12l6.5 6.5'],
        forward: ['M9.5 5.5 16 12l-6.5 6.5'],
        reload: ['M20 12a8 8 0 1 1-2.34-5.66', 'M20 4v5h-5'],
        plus: ['M12 5v14', 'M5 12h14'],
        close: ['M6 6l12 12', 'M18 6 6 18'],
        download: ['M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2', 'M12 4v9', 'm8.5 9.5 3.5 3.5 3.5-3.5'],
        folder: ['M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z'],
        play: ['M8 5v14l11-7z'],
        copy: ['M9 9h10v10H9z', 'M5 15V5h10'],
        settings: ['M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z', 'M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1-1.5 1.7 1.7 0 0 0-1.9.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.9 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1 1.7 1.7 0 0 0-.3-1.9l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.9.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.9-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.9V9c.2.6.7 1 1.5 1H21a2 2 0 1 1 0 4h-.1c-.8 0-1.3.4-1.5 1Z'],
        pause: ['M8 5v14', 'M16 5v14'],
        star: ['M12 3.4l2.7 5.4 6 .9-4.3 4.2 1 5.9-5.4-2.8-5.4 2.8 1-5.9L3.3 9.7l6-.9Z'],
        history: ['M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Z', 'M12 7.4V12l3.3 1.9'],
        trash: ['M4.5 7h15', 'M9.5 7V5.3A1.3 1.3 0 0 1 10.8 4h2.4a1.3 1.3 0 0 1 1.3 1.3V7', 'M6.6 7l.8 12.2a1.4 1.4 0 0 0 1.4 1.3h6.4a1.4 1.4 0 0 0 1.4-1.3L17.4 7'],
        caret: ['m9 10.5 3 3 3-3'],
        /* 黑白简笔画地球：圆 + 赤道 + 中央经线 + 两条回归线 + 两块大陆轮廓（stroke currentColor，fill none）。 */
        earth: [
          'M12 2.6a9.4 9.4 0 1 0 0 18.8 9.4 9.4 0 0 0 0-18.8Z',
          'M3.4 12h17.2',
          'M12 2.6c2.7 2.6 4.2 5.9 4.2 9.4s-1.5 6.8-4.2 9.4c-2.7-2.6-4.2-5.9-4.2-9.4s1.5-6.8 4.2-9.4Z',
          'M4.6 7.4c4.5 1.8 10.3 1.8 14.8 0',
          'M4.6 16.6c4.5-1.8 10.3-1.8 14.8 0',
          'M5.9 5.3l1.5-.9 1.7.6.4 1.5-.9 1.2-1.5.1-1.3-1Z',
          'M16.8 9.4l1.5-.3 1.3.9.3 1.6-.7 1.4-1.4.2-1-1.1-.2-1.5Z',
        ],
      }

      /** 可复用的黑白简笔画地球组件：h(EarthGlyph, { size }) 或直接 EarthGlyph(16)。 */
      function EarthGlyph(size, className) {
        var props = size !== null && typeof size === 'object' ? size : null
        var value = props !== null ? props.size : size
        if (typeof value !== 'number' || !(value > 0)) value = 16
        var extra = props !== null ? props.className : className
        return h(
          'svg',
          {
            viewBox: '0 0 24 24',
            width: value,
            height: value,
            fill: 'none',
            stroke: 'currentColor',
            strokeWidth: 1.8,
            strokeLinecap: 'round',
            strokeLinejoin: 'round',
            className: extra === undefined || extra === null ? undefined : extra,
            'aria-hidden': true,
            focusable: false,
            'data-dsh-ab-earth': '',
          },
          ICONS.earth.map(function (d, index) {
            return h('path', { key: index, d })
          }),
        )
      }
      /** 命令菜单贡献的 icon：自定义图标组件（接收 { size }）。 */
      function EarthIcon(props) {
        var value = props !== null && typeof props === 'object' && typeof props.size === 'number' && props.size > 0 ? props.size : 16
        return icon(ICONS.earth, value)
      }
      /** CSS mask 用的地球 SVG（纯线条，mask 取 alpha，所以描边颜色无所谓）。 */
      var EARTH_MASK_SVG =
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="black" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">' +
        ICONS.earth.map(function (d) {
          return '<path d="' + d + '"/>'
        }).join('') +
        '</svg>'
      /** 会话行 / 设置导航图标共用的地球 mask data URI（CSS url(...) 可用）。 */
      var EARTH_MASK_URI = 'data:image/svg+xml,' + encodeURIComponent(EARTH_MASK_SVG)

      function formatBytes(value) {
        if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return ''
        if (value < 1024) return value + ' B'
        if (value < 1024 * 1024) return (value / 1024).toFixed(1) + ' KiB'
        if (value < 1024 * 1024 * 1024) return (value / (1024 * 1024)).toFixed(1) + ' MiB'
        return (value / (1024 * 1024 * 1024)).toFixed(2) + ' GiB'
      }

      function formatSpeed(value) {
        if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return '0 B'
        if (value < 1024) return Math.round(value) + ' B'
        if (value < 1024 * 1024) return (value / 1024).toFixed(1) + ' KB'
        return (value / (1024 * 1024)).toFixed(1) + ' MB'
      }

      var EXT_COLORS = {
        exe: '#0078d4', msi: '#0078d4', zip: '#f0a30a', rar: '#f0a30a', '7z': '#f0a30a',
        pdf: '#d13438', png: '#107c10', jpg: '#107c10', jpeg: '#107c10', gif: '#107c10', webp: '#107c10',
        mp4: '#8764b8', mov: '#8764b8', mkv: '#8764b8', mp3: '#8764b8', wav: '#8764b8',
        doc: '#2b579a', docx: '#2b579a', xls: '#217346', xlsx: '#217346', ppt: '#d24726', pptx: '#d24726',
        txt: '#605e5c', json: '#605e5c', md: '#605e5c', csv: '#217346',
      }

      function fileBadge(name) {
        var ext = String(name).split('.').pop().toLowerCase()
        if (ext === '' || ext.length > 4 || ext === String(name).toLowerCase()) ext = 'file'
        return h('div', { className: 'dsh-ab-dl-badge', style: { background: EXT_COLORS[ext] || '#8a8886' } }, ext.slice(0, 4).toUpperCase())
      }

      /** 浏览器式下载弹窗：挂在下载按钮下方，不遮挡页面操作，点其它地方自动收回。 */
      function DownloadsPopup(props) {
        var t = props.t
        var sessionId = props.sessionId
        var anchor = props.anchor || null
        var [state, setState] = React.useState({ status: 'loading', folderPath: '', files: [], active: [], fallback: false, error: '', copied: '', opening: '', openError: '', expanded: false, controlling: '' })
        React.useEffect(
          function () {
            var alive = true
            function load() {
              requestJson('/downloads', { method: 'POST', body: { sessionId: sessionId } })
                .then(function (payload) {
                  if (!alive) return
                  setState(function (previous) {
                    return Object.assign({}, previous, {
                      status: 'ready',
                      folderPath: payload.folderPath || '',
                      files: Array.isArray(payload.files) ? payload.files : [],
                      active: Array.isArray(payload.active) ? payload.active : [],
                      fallback: payload.fallback === true,
                      error: '',
                    })
                  })
                })
                .catch(function (error) {
                  if (!alive) return
                  setState(function (previous) {
                    return Object.assign({}, previous, { status: 'error', error: errorText(error) })
                  })
                })
            }
            load()
            var timer = setInterval(load, 1000)
            return function () {
              alive = false
              clearInterval(timer)
            }
          },
          [sessionId],
        )
        function copy(path) {
          try {
            if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') navigator.clipboard.writeText(path)
          } catch (error) {
            /* 忽略剪贴板失败 */
          }
          setState(function (previous) {
            return Object.assign({}, previous, { copied: path })
          })
        }
        function openFile(path) {
          setState(function (previous) {
            return Object.assign({}, previous, { opening: path, openError: '' })
          })
          requestJson('/open-download', { method: 'POST', body: { sessionId: sessionId, path: path } })
            .then(function () {
              setState(function (previous) {
                return Object.assign({}, previous, { opening: '' })
              })
            })
            .catch(function (error) {
              setState(function (previous) {
                return Object.assign({}, previous, { opening: '', openError: errorText(error) })
              })
            })
        }
        function control(jobId, action) {
          setState(function (previous) {
            if (previous.controlling === jobId) return previous
            var active = previous.active
            if (action === 'cancel') active = active.filter(function (job) { return job.id !== jobId })
            else active = active.map(function (job) { return job.id === jobId ? Object.assign({}, job, { status: action === 'pause' ? 'paused' : 'downloading', paused: action === 'pause' }) : job })
            return Object.assign({}, previous, { openError: '', controlling: jobId, active: active })
          })
          requestJson('/download-control', { method: 'POST', body: { sessionId: sessionId, id: jobId, action: action } })
            .catch(function (error) {
              setState(function (previous) {
                return Object.assign({}, previous, { openError: errorText(error) })
              })
            })
            .then(function () {
              setState(function (previous) {
                return Object.assign({}, previous, { controlling: '' })
              })
            })
        }
        function openFolder() {
          setState(function (previous) {
            return Object.assign({}, previous, { openError: '' })
          })
          requestJson('/open-download-folder', { method: 'POST', body: { sessionId: sessionId } }).catch(function (error) {
            setState(function (previous) {
              return Object.assign({}, previous, { openError: errorText(error) })
            })
          })
        }
        function actionButton(iconPaths, title, onClick, disabled) {
          return h('button', { type: 'button', className: 'dsh-ab-dl-icon-btn', title: title, disabled: disabled ? true : undefined, onClick: onClick }, icon(iconPaths, 15))
        }
        function activeRow(job) {
          var total = typeof job.total === 'number' && job.total > 0 ? job.total : 0
          var percent = total > 0 ? Math.min(100, Math.max(0, Math.round((job.bytes / total) * 100))) : 0
          var failed = job.status === 'error'
          var statusText
          if (failed) statusText = t('downloads.failedStatus', { message: job.error || '' })
          else if (total > 0) statusText = formatSpeed(job.speed) + '/s · ' + formatBytes(job.bytes) + ' / ' + formatBytes(total)
          else statusText = t('downloads.waiting')
          var paused = job.status === 'paused' || job.paused === true
          var finished = job.status === 'cancelled' || job.status === 'done'
          if (paused) statusText = t('downloads.paused') + ' · ' + formatBytes(job.bytes) + (total > 0 ? ' / ' + formatBytes(total) : '')
          return h(
            'div',
            { key: job.id, className: 'dsh-ab-dl-row is-active' + (failed ? ' is-error' : '') },
            fileBadge(job.name),
            h(
              'div',
              { className: 'dsh-ab-dl-main' },
              h('div', { className: 'dsh-ab-dl-name', title: job.url || job.name }, job.name),
              failed || finished ? null : h('div', { className: 'dsh-ab-dl-bar-wrap' }, h('div', { className: 'dsh-ab-dl-bar', style: { width: percent + '%' } })),
              h('div', { className: 'dsh-ab-dl-status' + (failed ? ' is-error' : '') }, statusText),
            ),
            h(
              'div',
              { className: 'dsh-ab-dl-actions' },
              finished
                ? null
                : actionButton(paused ? ICONS.play : ICONS.pause, paused ? t('downloads.resume') : t('downloads.pause'), function () { control(job.id, paused ? 'resume' : 'pause') }),
              finished ? null : actionButton(ICONS.close, t('downloads.cancel'), function () { control(job.id, 'cancel') }),
            ),
          )
        }
        function fileRow(file) {
          var opening = state.opening === file.path
          return h(
            'div',
            { key: file.path, className: 'dsh-ab-dl-row' },
            fileBadge(file.name),
            h(
              'div',
              { className: 'dsh-ab-dl-main' },
              h('div', { className: 'dsh-ab-dl-name', title: file.path }, file.name),
              h('div', { className: 'dsh-ab-dl-status' }, formatBytes(file.bytes) + ' · ' + t('downloads.done')),
            ),
            h(
              'div',
              { className: 'dsh-ab-dl-actions' },
              actionButton(ICONS.play, opening ? t('downloads.opening') : t('downloads.open'), function () { openFile(file.path) }, opening),
              actionButton(ICONS.copy, state.copied === file.path ? t('downloads.copied') : t('downloads.copy'), function () { copy(file.path) }),
            ),
          )
        }
        var rows = []
        state.active.forEach(function (job) {
          rows.push(activeRow(job))
        })
        state.files.forEach(function (file) {
          rows.push(fileRow(file))
        })
        return h(
          'div',
          {
            className: 'dsh-ab-dl-popup',
            role: 'dialog',
            onMouseDown: function (event) { event.stopPropagation() },
          },
          h(
            'div',
            { className: 'dsh-ab-dl-head' },
            h('span', { className: 'dsh-ab-dl-title' }, t('downloads.title')),
            h(
              'div',
              { className: 'dsh-ab-dl-head-actions' },
              actionButton(ICONS.folder, t('downloads.folder'), openFolder),
              actionButton(ICONS.close, t('downloads.close'), function () { uiSet({ downloads: null }) }),
            ),
          ),
          state.openError !== '' ? h('div', { className: 'dsh-ab-dl-error' }, t('downloads.openFailed') + '：' + state.openError) : null,
          h(
            'div',
            { className: 'dsh-ab-dl-list' },
            rows.length === 0
              ? h('div', { className: 'dsh-ab-dl-empty' }, t('downloads.empty'))
              : (state.expanded ? rows : rows.slice(0, 3)).map(function (row) {
                  return row
                }),
          ),
          rows.length > 3
            ? h(
                'button',
                {
                  type: 'button',
                  className: 'dsh-ab-dl-more',
                  onClick: function () {
                    setState(function (previous) {
                      return Object.assign({}, previous, { expanded: !previous.expanded })
                    })
                  },
                },
                state.expanded ? t('downloads.less') : t('downloads.more'),
              )
            : null,
        )
      }

      // ------------------------------------------------------------------
      // 四档站点名单（浏览器面板设置与 Harness 设置页共用）。
      // 每档超过 3 条自动折叠，展开状态由调用方按档位维护。
      // ------------------------------------------------------------------
      function SiteListSections(options) {
        var t = options.t
        var lists = options.lists !== null && typeof options.lists === 'object' ? options.lists : {}
        var inputs = options.inputs !== null && typeof options.inputs === 'object' ? options.inputs : {}
        var expanded = options.expanded !== null && typeof options.expanded === 'object' ? options.expanded : {}
        var labelOf =
          typeof options.labelOf === 'function'
            ? options.labelOf
            : function (entry) {
                return String((entry && (entry.host || entry.raw)) || '')
              }
        var keyOf = typeof options.keyOf === 'function' ? options.keyOf : labelOf
        return LEVELS.map(function (level) {
          var entries = Array.isArray(lists[level]) ? lists[level] : []
          var open = expanded[level] === true
          var shown = open ? entries : entries.slice(0, 3)
          return h(
            'div',
            { key: level, className: 'dsh-ab-sites-section' },
            h('div', { className: 'dsh-ab-sites-head' }, t('perm.' + level)),
            entries.length === 0
              ? h('div', { className: 'dsh-ab-sites-empty' }, options.emptyText === undefined ? t('settings.empty') : options.emptyText)
              : shown.map(function (entry, index) {
                  var label = labelOf(entry)
                  return h(
                    'div',
                    { key: keyOf(entry) + ':' + String(index), className: 'dsh-ab-sites-row' },
                    h('span', { className: 'dsh-ab-sites-host', title: label }, label),
                    h(
                      'label',
                      { className: 'dsh-ab-sites-toggle', title: t('settings.noAuth') },
                      h('input', {
                        type: 'checkbox',
                        checked: entry.noAuth === true,
                        onChange: function () {
                          options.onToggleNoAuth(level, entry)
                        },
                      }),
                      h('span', null, t('settings.noAuth')),
                    ),
                    h(
                      'button',
                      {
                        type: 'button',
                        className: 'dsh-ab-dl-icon-btn',
                        title: t('settings.delete'),
                        onClick: function () {
                          options.onRemove(level, entry)
                        },
                      },
                      icon(ICONS.close, 12),
                    ),
                  )
                }),
            entries.length > 3
              ? h(
                  'button',
                  {
                    type: 'button',
                    className: 'dsh-ab-dl-more',
                    onClick: function () {
                      options.onToggleExpand(level)
                    },
                  },
                  open ? t('settings.less') : t('settings.more', { count: entries.length }),
                )
              : null,
            h(
              'div',
              { className: 'dsh-ab-sites-add' },
              h('input', {
                type: 'text',
                className: 'dsh-ab-sites-input',
                value: inputs[level] === undefined ? '' : inputs[level],
                placeholder: t('settings.placeholder'),
                spellCheck: false,
                onChange: function (event) {
                  options.onInput(level, event.target.value)
                },
                onKeyDown: function (event) {
                  if (event.key !== 'Enter') return
                  event.preventDefault()
                  options.onAdd(level, String(inputs[level] === undefined ? '' : inputs[level]).trim())
                },
              }),
              h(
                'button',
                {
                  type: 'button',
                  className: 'dsh-ab-btn',
                  onClick: function () {
                    options.onAdd(level, String(inputs[level] === undefined ? '' : inputs[level]).trim())
                  },
                },
                t('settings.add'),
              ),
            ),
          )
        })
      }

      // ------------------------------------------------------------------
      // 权限预设 txt 导入 / 导出（人类可读，方便分享）
      //
      // 唯一格式（v1），解析/导出一律走下面两个函数：
      //
      //   # DSH AI Browser Preset v1
      //   # name: 我的预设
      //   [view]
      //   baidu.com
      //   [simple]
      //   example.com !noauth
      //   [review]
      //   [full]
      //   www.baidu.com/xyz !noauth
      //
      // 规则：
      // - `#` 开头的行是注释，其中 `# name: xxx` 同时给出预设名（只取最后一个）；
      // - `[view|simple|review|full]` 是分节；同一分节可重复出现，条目累加；
      // - 每行一个网址，可带 ` !noauth`（忽略大小写）后缀表示「无需授权访问」；
      // - 空行忽略；未知分节忽略（连同其下条目，直到下一个已知分节）；
      // - 解析结果 lists 形如 {view:[{raw,noAuth}], simple:[...], review:[...], full:[...]}，
      //   可以直接作为 body.lists POST 给 Host（Host 侧会再规范化/去重）。
      // - 没有任何有效条目（无分节 / 全空）时解析返回 null，调用方显示失败提示。
      // ------------------------------------------------------------------
      var PRESET_TEXT_TITLE = 'DSH AI Browser Preset v1'
      /** 导出文本里的「无需授权访问」后缀。 */
      var PRESET_TEXT_NOAUTH = ' !noauth'
      /** 解析「!noauth」后缀用的正则。 */
      var PRESET_TEXT_NOAUTH_RE = /\s+!noauth\s*$/i

      function emptyPresetLists() {
        var lists = {}
        for (var index = 0; index < LEVELS.length; index += 1) lists[LEVELS[index]] = []
        return lists
      }

      /** lists -> 上述唯一格式文本（四档分节总是完整输出，空档保留空节）。 */
      function serializePresetText(name, lists) {
        var safeName = String(name === undefined || name === null ? '' : name)
          .replace(/[\r\n]+/g, ' ')
          .trim()
        var lines = ['# ' + PRESET_TEXT_TITLE]
        if (safeName !== '') lines.push('# name: ' + safeName)
        var source = lists !== null && typeof lists === 'object' ? lists : {}
        for (var index = 0; index < LEVELS.length; index += 1) {
          var level = LEVELS[index]
          lines.push('[' + level + ']')
          var entries = Array.isArray(source[level]) ? source[level] : []
          for (var at = 0; at < entries.length; at += 1) {
            var entry = entries[at] !== null && typeof entries[at] === 'object' ? entries[at] : {}
            var raw =
              entry.raw !== undefined && entry.raw !== null && entry.raw !== ''
                ? entry.raw
                : entry.host !== undefined && entry.host !== null
                  ? entry.host
                  : ''
            raw = String(raw)
              .replace(/[\r\n]+/g, ' ')
              .trim()
            if (raw === '') continue
            lines.push(entry.noAuth === true ? raw + PRESET_TEXT_NOAUTH : raw)
          }
        }
        return lines.join('\n') + '\n'
      }

      /** 解析唯一格式文本；没有有效分节或全部为空时返回 null。 */
      function parsePresetText(text) {
        if (typeof text !== 'string' || text === '') return null
        var lists = emptyPresetLists()
        var name = ''
        var section = ''
        var count = 0
        var lines = text.split(/\r?\n/)
        for (var index = 0; index < lines.length; index += 1) {
          var value = lines[index] === undefined || lines[index] === null ? '' : String(lines[index]).trim()
          if (value === '') continue
          if (value.charAt(0) === '#') {
            var named = /^#\s*name\s*:\s*(.*)$/i.exec(value)
            if (named !== null) name = String(named[1] || '').trim()
            continue
          }
          if (value.charAt(0) === '[' && value.charAt(value.length - 1) === ']') {
            var label = value.slice(1, value.length - 1).trim().toLowerCase()
            // 未知分节把 section 置空，后续条目忽略，直到下一个已知分节。
            section = LEVELS.indexOf(label) >= 0 ? label : ''
            continue
          }
          if (section === '') continue
          var noAuth = PRESET_TEXT_NOAUTH_RE.test(value)
          var raw = noAuth ? value.replace(PRESET_TEXT_NOAUTH_RE, '').trim() : value
          if (raw === '') continue
          lists[section].push({ raw: raw, noAuth: noAuth })
          count += 1
        }
        if (count === 0) return null
        return { name: name, lists: lists, count: count }
      }

      /** 预设名 -> 安全下载文件名（保留中文，替换 Windows 非法字符）。 */
      function presetTextFileName(name, fallback) {
        var base = String(name === undefined || name === null ? '' : name)
          .replace(/[\r\n\t]+/g, ' ')
          .replace(/[\\/:*?"<>|]+/g, '_')
          .replace(/\s+/g, ' ')
          .trim()
        base = base.replace(/^\.+/, '').replace(/[. ]+$/, '').slice(0, 80)
        if (base === '') base = fallback === undefined || fallback === null || fallback === '' ? 'preset' : String(fallback)
        return base + '.txt'
      }

      /** 纯客户端下载文本：Blob + objectURL + 临时 <a download>，不经过 Host。 */
      function triggerTextDownload(fileName, text) {
        if (typeof document === 'undefined' || document === null || typeof document.createElement !== 'function') {
          throw new Error('当前环境无法下载文件')
        }
        if (typeof Blob !== 'function' || typeof URL === 'undefined' || URL === null || typeof URL.createObjectURL !== 'function') {
          throw new Error('当前环境无法下载文件')
        }
        var blob = new Blob([String(text === undefined || text === null ? '' : text)], { type: 'text/plain;charset=utf-8' })
        var url = URL.createObjectURL(blob)
        var anchor = document.createElement('a')
        anchor.href = url
        anchor.download = fileName
        anchor.rel = 'noopener'
        if (anchor.style !== undefined && anchor.style !== null) anchor.style.display = 'none'
        var host = document.body !== undefined && document.body !== null ? document.body : document.documentElement
        if (host !== undefined && host !== null && typeof host.appendChild === 'function') host.appendChild(anchor)
        try {
          anchor.click()
        } finally {
          setTimeout(function () {
            try {
              var parent = anchor.parentNode
              if (parent !== null && parent !== undefined && typeof parent.removeChild === 'function') parent.removeChild(anchor)
            } catch (error) {
              /* 忽略 */
            }
            try {
              URL.revokeObjectURL(url)
            } catch (error) {
              /* 忽略 */
            }
          }, 0)
        }
      }

      /** 读取 <input type="file"> 选中的文本文件（优先 file.text()，回退 FileReader）。 */
      function readTextFile(file) {
        if (file === null || file === undefined) return Promise.reject(new Error('没有选择文件'))
        if (typeof file.text === 'function') return Promise.resolve(file.text())
        return new Promise(function (resolve, reject) {
          try {
            var reader = new FileReader()
            reader.onload = function () {
              resolve(String(reader.result === undefined || reader.result === null ? '' : reader.result))
            }
            reader.onerror = function () {
              reject(new Error('读取文件失败'))
            }
            reader.readAsText(file)
          } catch (error) {
            reject(error)
          }
        })
      }

      /** 工作区路径 -> 末级目录名（导出文件名用；拿不到时空串）。 */
      function workspaceLabelOf(path) {
        var value = String(path === undefined || path === null ? '' : path)
        if (value === '') return ''
        var parts = value.split(/[\\/]+/)
        for (var index = parts.length - 1; index >= 0; index -= 1) {
          var part = String(parts[index]).trim()
          if (part !== '') return part
        }
        return ''
      }

      // ------------------------------------------------------------------
      // 权限覆盖层（菜单 + 警告弹窗 + 下载内容）
      // ------------------------------------------------------------------
      function PermissionOverlay(props) {
        var t = getT(props)
        var state = UI.state
        var [, forceRender] = React.useState(0)
        var [acknowledged, setAcknowledged] = React.useState(false)
        React.useEffect(function () {
          return uiSubscribe(function () {
            forceRender(function (value) {
              return value + 1
            })
          })
        }, [])
        React.useEffect(function () {
          setAcknowledged(false)
        }, [state.warning === null ? null : state.warning.level])
        if (state.menu === null && state.warning === null && state.downloads === null) return null

        var menu = null
        if (state.menu !== null) {
          var rect = state.menu.rect || { left: 80, top: 80 }
          menu = h(
            'div',
            {
              className: 'dsh-ab-menu',
              role: 'menu',
              style: { position: 'fixed', left: Math.max(8, Math.round(rect.left)) + 'px', top: Math.max(8, Math.round(rect.top)) + 'px', width: '268px', zIndex: 2147483000 },
              onMouseDown: function (event) {
                event.stopPropagation()
              },
            },
            h('div', { className: 'dsh-ab-menu-title' }, t('perm.menu.title')),
            state.menu.windowLabel ? h('div', { className: 'dsh-ab-menu-window' }, state.menu.windowLabel) : null,
            LEVELS.map(function (level) {
              var active = state.menu.level === level
              return h(
                'button',
                {
                  key: level,
                  type: 'button',
                  role: 'menuitemradio',
                  'aria-checked': active ? 'true' : 'false',
                  className: 'dsh-ab-menu-item' + (active ? ' is-active' : ''),
                  onClick: function () {
                    if (level === state.menu.level) return uiSet({ menu: null })
                    if (level === 'review' || level === 'full') {
                      return uiSet({ menu: null, warning: { level: level, sessionId: state.menu.sessionId, windowId: state.menu.windowId } })
                    }
                    commitLevel(state.menu.sessionId, state.menu.windowId, level)
                  },
                },
                h('span', { className: 'dsh-ab-menu-check', 'aria-hidden': true }, active ? '✓' : ''),
                h('span', { className: 'dsh-ab-menu-text' }, h('span', { className: 'dsh-ab-menu-label' }, t('perm.' + level)), h('span', { className: 'dsh-ab-menu-hint' }, t('perm.' + level + '.hint'))),
              )
            }),
            state.error ? h('div', { className: 'dsh-ab-menu-error', role: 'alert' }, t('perm.failed') + '：' + state.error) : null,
          )
        }
        var warning = null
        if (state.warning !== null) {
          var warningLevel = state.warning.level
          warning = h(
            'div',
            { className: 'dsh-ab-modal-backdrop', onMouseDown: function () { uiSet({ warning: null }) } },
            h(
              'div',
              { className: 'dsh-ab-modal', role: 'dialog', 'aria-modal': 'true', onMouseDown: function (event) { event.stopPropagation() } },
              h('div', { className: 'dsh-ab-modal-title' }, t('perm.warning.title')),
              h('div', { className: 'dsh-ab-modal-desc' }, t(warningLevel === 'full' ? 'perm.warning.full' : 'perm.warning.review')),
              h(
                'label',
                { className: 'dsh-ab-modal-ack' },
                h('input', { type: 'checkbox', checked: acknowledged, onChange: function (event) { setAcknowledged(event.target.checked) } }),
                h('span', null, t('perm.warning.ack')),
              ),
              state.error ? h('div', { className: 'dsh-ab-menu-error', role: 'alert' }, t('perm.failed') + '：' + state.error) : null,
              h(
                'div',
                { className: 'dsh-ab-modal-actions' },
                h('button', { type: 'button', className: 'dsh-ab-btn', onClick: function () { uiSet({ warning: null }) } }, t('perm.warning.cancel')),
                h(
                  'button',
                  {
                    type: 'button',
                    className: 'dsh-ab-btn dsh-ab-btn-primary',
                    disabled: !acknowledged,
                    onClick: function () {
                      commitLevel(state.warning.sessionId, state.warning.windowId, state.warning.level)
                    },
                  },
                  t('perm.warning.confirm'),
                ),
              ),
            ),
          )
        }
        var downloads = null
        if (state.downloads !== null) {
          downloads = h(DownloadsPopup, { t: t, sessionId: state.downloads.sessionId, anchor: state.downloads.rect })
        }
        return h(React.Fragment, null, menu, warning, downloads)
      }

      function commitLevel(sessionId, windowId, level) {
        return requestJson('/level', { method: 'POST', body: { sessionId: sessionId, windowId: windowId, level: level } })
          .then(function () {
            uiSet({ menu: null, warning: null, error: null })
          })
          .catch(function (error) {
            uiSet({ error: errorText(error) })
          })
      }

      function installDismissListeners() {
        var onDown = function (event) {
          if (UI.state.menu === null && UI.state.warning === null && UI.state.downloads === null) return
          var target = event.target
          var inside =
            target !== null && typeof target.closest === 'function' && (target.closest('.dsh-ab-sheet') !== null || target.closest('.dsh-ab-dl-popup') !== null || target.closest('.dsh-ab-perm-btn') !== null || target.closest('.dsh-ab-tool-download') !== null)
          if (!inside) uiSet({ menu: null, warning: null, downloads: null })
        }
        var onKey = function (event) {
          if (event.key !== 'Escape') return
          if (UI.state.menu === null && UI.state.warning === null && UI.state.downloads === null) return
          uiSet({ menu: null, warning: null, downloads: null })
        }
        document.addEventListener('mousedown', onDown, true)
        document.addEventListener('keydown', onKey, true)
        return function () {
          document.removeEventListener('mousedown', onDown, true)
          document.removeEventListener('keydown', onKey, true)
        }
      }

      // ------------------------------------------------------------------
      // 侧栏会话行地球：浏览器模式会话在 leading 位置显示地球，运行中把状态转圈
      // 换成旋转地球。用 MutationObserver + 行属性 + CSS ::after + mask 实现，
      // 不直接删改 React 节点。是否运行只认 SessionAnchor 通过 slot 标准 prop
      // useSessionStatus 写入的 RUNNING_SESSIONS（DOM 子元素不能可靠代表运行中）。
      // ------------------------------------------------------------------
      var SESSION_MARK = 'data-dsh-ab-browser-session'
      var SESSION_RUNNING_MARK = 'data-dsh-ab-browser-running'
      var SESSION_MARK_SYNC = null

      /** BROWSER_SESSIONS / RUNNING_SESSIONS 更新后触发标记刷新（观察器未安装时是空操作）。 */
      function notifySessionMarks() {
        var sync = SESSION_MARK_SYNC
        if (typeof sync !== 'function') return
        try {
          sync()
        } catch (error) {
          /* 忽略：标记失败不影响面板 */
        }
      }

      /** 扫描侧栏会话行并打标记；返回清理函数。 */
      function installBrowserSessionMarks() {
        if (typeof document === 'undefined' || typeof document.body === 'undefined' || document.body === null || typeof MutationObserver !== 'function' || typeof document.querySelectorAll !== 'function') {
          return function () {}
        }
        var disposed = false
        var frame = null
        var timer = null
        function sync() {
          if (disposed) return
          var rows
          try {
            rows = document.querySelectorAll('[data-row-key^="session:"]')
          } catch (error) {
            return
          }
          for (var index = 0; index < rows.length; index += 1) {
            var row = rows[index]
            if (row === null || typeof row.getAttribute !== 'function') continue
            var key = row.getAttribute('data-row-key')
            var sessionId = typeof key === 'string' ? key.slice('session:'.length) : ''
            var browser = sessionId !== '' && BROWSER_SESSIONS[sessionId] === true
            // 可靠来源：useSessionStatus 维护的 RUNNING_SESSIONS。
            // 旧实现用 leading.childElementCount > 0 猜运行中，空闲会话挂着状态点时
            // 也会误转地球；现在没有 true 就绝不旋转。
            var running = browser && RUNNING_SESSIONS[sessionId] === true
            if (browser) {
              if (row.getAttribute(SESSION_MARK) === null) row.setAttribute(SESSION_MARK, '')
            } else if (row.getAttribute(SESSION_MARK) !== null) {
              row.removeAttribute(SESSION_MARK)
            }
            if (running) {
              if (row.getAttribute(SESSION_RUNNING_MARK) === null) row.setAttribute(SESSION_RUNNING_MARK, '')
            } else if (row.getAttribute(SESSION_RUNNING_MARK) !== null) {
              row.removeAttribute(SESSION_RUNNING_MARK)
            }
          }
        }
        function schedule() {
          if (disposed) return
          if (typeof requestAnimationFrame !== 'function') {
            sync()
            return
          }
          if (frame !== null) return
          frame = requestAnimationFrame(function () {
            frame = null
            sync()
          })
        }
        SESSION_MARK_SYNC = sync
        var observer = new MutationObserver(schedule)
        observer.observe(document.body, { childList: true, subtree: true })
        // 状态点变化偶尔只改属性、不触发 childList，用低代价定时兜底。
        timer = setInterval(sync, 2500)
        sync()
        return function () {
          disposed = true
          if (SESSION_MARK_SYNC === sync) SESSION_MARK_SYNC = null
          observer.disconnect()
          if (timer !== null) clearInterval(timer)
          if (frame !== null && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(frame)
          frame = null
          timer = null
          try {
            var marked = document.querySelectorAll('[' + SESSION_MARK + '], [' + SESSION_RUNNING_MARK + ']')
            for (var index = 0; index < marked.length; index += 1) {
              marked[index].removeAttribute(SESSION_MARK)
              marked[index].removeAttribute(SESSION_RUNNING_MARK)
            }
          } catch (error) {
            /* 忽略 */
          }
        }
      }

      // ------------------------------------------------------------------
      // 设置导航图标：settings.section 契约没有 icon 字段，shell 按 section id
      // 固定映射（未知 id 显示齿轮）。给导航按钮加 class，由 CSS ::before + mask
      // 换成地球并隐藏原 svg；幂等，且不观察属性避免死循环。
      // ------------------------------------------------------------------
      var SETTINGS_NAV_CLASS = 'dsh-ab-settings-nav'
      function registerSettingsNavIcon(labelGetter) {
        if (typeof document === 'undefined' || typeof document.body === 'undefined' || document.body === null || typeof MutationObserver !== 'function' || typeof document.querySelectorAll !== 'function') {
          return function () {}
        }
        var disposed = false
        var frame = null
        function sync() {
          if (disposed) return
          var labels = []
          try {
            var raw = typeof labelGetter === 'function' ? labelGetter() : labelGetter
            var list = Array.isArray(raw) ? raw : [raw]
            for (var at = 0; at < list.length; at += 1) {
              var text = String(list[at] === undefined || list[at] === null ? '' : list[at]).trim()
              if (text !== '') labels.push(text)
            }
          } catch (error) {
            labels = []
          }
          if (labels.length === 0) return
          var buttons
          try {
            buttons = document.querySelectorAll('[role="dialog"] nav button')
          } catch (error) {
            return
          }
          for (var index = 0; index < buttons.length; index += 1) {
            var button = buttons[index]
            if (button === null || button === undefined) continue
            var text = String(button.textContent || '').trim()
            var wanted = labels.indexOf(text) >= 0
            var marked = typeof button.classList !== 'undefined' && button.classList !== null && typeof button.classList.contains === 'function' ? button.classList.contains(SETTINGS_NAV_CLASS) : false
            if (wanted && !marked && typeof button.classList.add === 'function') button.classList.add(SETTINGS_NAV_CLASS)
            else if (!wanted && marked && typeof button.classList.remove === 'function') button.classList.remove(SETTINGS_NAV_CLASS)
          }
        }
        function schedule() {
          if (disposed) return
          if (typeof requestAnimationFrame !== 'function') {
            sync()
            return
          }
          if (frame !== null) return
          frame = requestAnimationFrame(function () {
            frame = null
            sync()
          })
        }
        sync()
        var observer = new MutationObserver(schedule)
        // 只观察 childList 与 class 变化：React 重渲染导航按钮会覆盖 class，需要再次打标记；
        // 加/删 class 都是幂等的，不会造成循环。
        observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['class'] })
        return function () {
          disposed = true
          observer.disconnect()
          if (frame !== null && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(frame)
          frame = null
          try {
            var marked = document.querySelectorAll('.' + SETTINGS_NAV_CLASS)
            for (var index = 0; index < marked.length; index += 1) {
              if (marked[index] !== null && typeof marked[index].classList !== 'undefined') marked[index].classList.remove(SETTINGS_NAV_CLASS)
            }
          } catch (error) {
            /* 忽略 */
          }
        }
      }

      // ------------------------------------------------------------------
      // 会话锚点：无可见 UI，只负责自动打开面板
      // ------------------------------------------------------------------
      /**
       * 侧栏会话行桥接：renderless，挂在每一行右侧的 row.action 座位上，
       * 这样即使当前不在对话视图、SessionAnchor 已卸载，也能从
       * useProjection / useSessionStatus 维护浏览器模式与运行状态缓存。
       */
      function SessionRowBridge(props) {
        var sessionId = props.sessionId
        var projected
        try {
          projected = typeof props.useProjection === 'function' ? props.useProjection('agentPreset') : undefined
        } catch (error) {
          projected = undefined
        }
        var preset = projected
        if (preset !== null && typeof preset === 'object') preset = preset.current !== undefined ? preset.current : preset.value
        var running = false
        if (typeof props.useSessionStatus === 'function') {
          try {
            running =
              props.useSessionStatus(function (state) {
                if (typeof sessionId !== 'string' || sessionId === '') return false
                if (state === null || state === undefined || typeof state.get !== 'function') return false
                var status = state.get(sessionId)
                return status !== null && status !== undefined && status.running === true
              }) === true
          } catch (error) {
            running = false
          }
        }
        React.useEffect(
          function () {
            if (typeof sessionId !== 'string' || sessionId === '') return undefined
            if (preset !== undefined) BROWSER_SESSIONS[sessionId] = preset === PRESET_ID
            RUNNING_SESSIONS[sessionId] = running === true
            notifySessionMarks()
            return undefined
          },
          [preset, running, sessionId],
        )
        return null
      }

      function SessionAnchor(props) {
        var sessionId = props.sessionId
        var projectionValue
        try {
          projectionValue = typeof props.useProjection === 'function' ? props.useProjection('agentPreset') : undefined
        } catch (error) {
          projectionValue = undefined
        }
        var projected = projectionValue
        if (projected !== null && typeof projected === 'object') projected = projected.current !== undefined ? projected.current : projected.value
        // 运行状态：slot 标准 prop `useSessionStatus`（selector 订阅会话状态快照，
        // 与 dsh-client-experimental-agent-team 的
        // `useSessionStatus((state) => state.get(member.id)?.running)` 一致）。
        // 拿不到或抛错时视为未运行——宁可静态地球，也不空闲乱转。
        var running = false
        if (typeof props.useSessionStatus === 'function') {
          try {
            running =
              props.useSessionStatus(function (state) {
                if (typeof sessionId !== 'string' || sessionId === '') return false
                if (state === null || state === undefined || typeof state.get !== 'function') return false
                var status = state.get(sessionId)
                return status !== null && status !== undefined && status.running === true
              }) === true
          } catch (error) {
            running = false
          }
        }
        var [serverEnabled, setServerEnabled] = React.useState(null)
        var enabled = projected === PRESET_ID || (projected === undefined && serverEnabled === true)
        React.useEffect(
          function () {
            if (typeof sessionId !== 'string' || sessionId === '') return undefined
            BROWSER_SESSIONS[sessionId] = enabled === true
            notifySessionMarks()
            return undefined
          },
          [enabled, sessionId],
        )

        React.useEffect(
          function () {
            if (typeof sessionId !== 'string' || sessionId === '') return undefined
            RUNNING_SESSIONS[sessionId] = running === true
            notifySessionMarks()
            // 不在卸载时清空：离开对话视图后侧栏的 SessionRowBridge 仍在维护状态。
            return undefined
          },
          [running, sessionId],
        )

        React.useEffect(
          function () {
            if (projected !== undefined || typeof sessionId !== 'string' || sessionId === '') return undefined
            var alive = true
            requestJson('/session', { method: 'POST', body: { sessionId: sessionId } })
              .then(function (payload) {
                if (alive) setServerEnabled(payload.enabled === true)
              })
              .catch(function () {})
            return function () {
              alive = false
            }
          },
          [projected, sessionId],
        )

        React.useEffect(
          function () {
            if (!enabled) return undefined
            if (typeof sessionId !== 'string' || sessionId === '') return undefined
            if (AUTO_OPENED[sessionId] === true) return undefined
            var cancelled = false
            var delays = [0, 180, 450, 900, 1800]
            var at = 0
            var timers = []
            function attempt() {
              if (cancelled) return
              var ctx = PLUGIN_CTX
              if (ctx === null || ctx.sidebarRight === undefined || typeof ctx.sidebarRight.openTab !== 'function') return
              try {
                ctx.sidebarRight.openTab(TAB_KIND, {})
                AUTO_OPENED[sessionId] = true
                return
              } catch (error) {
                /* 右侧栏 store 未 mint，退避重试 */
              }
              at += 1
              if (at >= delays.length) return
              timers.push(setTimeout(attempt, delays[at]))
            }
            timers.push(setTimeout(attempt, delays[0]))
            return function () {
              cancelled = true
              for (var index = 0; index < timers.length; index += 1) clearTimeout(timers[index])
            }
          },
          [enabled, sessionId],
        )
        return null
      }

      // ------------------------------------------------------------------
      // 页面脚本
      // ------------------------------------------------------------------
      function readScript(maxChars) {
        return (
          '(function(){var MAX=' + JSON.stringify(maxChars) + ';' +
          'var body=document.body?document.body.innerText:"";var text=body.slice(0,MAX);' +
          'var nodes=document.querySelectorAll("a,button,input,textarea,select,summary,[role=\\"button\\"],[role=\\"link\\"],[role=\\"checkbox\\"],[role=\\"tab\\"],[role=\\"menuitem\\"],[role=\\"option\\"],[contenteditable=\\"true\\"]");' +
          'var items=[];var index=0;' +
          'for(var i=0;i<nodes.length&&items.length<80;i++){var el=nodes[i];var rect=el.getBoundingClientRect();' +
          'if(rect.width<=0||rect.height<=0)continue;var style=getComputedStyle(el);if(style.visibility==="hidden"||style.display==="none")continue;' +
          'el.setAttribute("data-dsh-ab-i",String(index));' +
          'var label=(el.innerText||el.value||el.getAttribute("aria-label")||el.getAttribute("placeholder")||el.getAttribute("title")||"").trim().slice(0,120);' +
          'items.push({i:index,tag:el.tagName.toLowerCase(),type:el.getAttribute("type")||"",role:el.getAttribute("role")||"",text:label,name:el.getAttribute("name")||"",placeholder:el.getAttribute("placeholder")||""});' +
          'index++;}' +
          'return {url:location.href,title:document.title,text:text,truncated:body.length>MAX,items:items};})()'
        )
      }
      function locateExpression(args) {
        if (args && Number.isInteger(args.index)) return 'document.querySelector(\'[data-dsh-ab-i="' + args.index + '"]\')'
        if (args && typeof args.selector === 'string' && args.selector !== '') return 'document.querySelector(' + JSON.stringify(args.selector) + ')'
        return 'null'
      }
      function inspectScript(args) {
        var target =
          args && Number.isInteger(args.index)
            ? 'document.querySelector(\'[data-dsh-ab-i="' + args.index + '"]\')'
            : args && typeof args.selector === 'string' && args.selector !== ''
              ? 'document.querySelector(' + JSON.stringify(args.selector) + ')'
              : 'document.activeElement'
        return (
          '(function(){var el=' + target + ';if(!el)return {found:false};' +
          'return {found:true,tag:el.tagName.toLowerCase(),type:el.getAttribute("type")||"",role:el.getAttribute("role")||"",' +
          'text:(el.innerText||"").trim().slice(0,200),name:el.getAttribute("name")||"",placeholder:el.getAttribute("placeholder")||"",' +
          'ariaLabel:el.getAttribute("aria-label")||"",value:(el.value!==undefined?String(el.value).slice(0,100):"")};})()'
        )
      }
      function clickScript(args) {
        return (
          '(function(){var el=' + locateExpression(args) + ';if(!el)return {ok:false,error:"NO_ELEMENT"};' +
          'try{el.scrollIntoView({block:"center",inline:"center"});}catch(e){}' +
          'var text=(el.innerText||el.value||el.getAttribute("aria-label")||"").trim().slice(0,120);' +
          'if(typeof el.click==="function")el.click();' +
          'else{var rect=el.getBoundingClientRect();var x=rect.left+rect.width/2,y=rect.top+rect.height/2;' +
          'var opts={bubbles:true,cancelable:true,clientX:x,clientY:y};el.dispatchEvent(new PointerEvent("pointerdown",opts));el.dispatchEvent(new MouseEvent("mousedown",opts));el.dispatchEvent(new PointerEvent("pointerup",opts));el.dispatchEvent(new MouseEvent("mouseup",opts));el.dispatchEvent(new MouseEvent("click",opts));}' +
          'return {ok:true,text:text};})()'
        )
      }
      function typeScript(args) {
        var text = args && typeof args.text === 'string' ? args.text : ''
        return (
          '(function(){var el=' + locateExpression(args) + ';if(!el)return {ok:false,error:"NO_ELEMENT"};' +
          'try{el.scrollIntoView({block:"center"});el.focus();}catch(e){}' +
          'var text=' + JSON.stringify(text) + ';var tag=el.tagName;' +
          'if(tag==="INPUT"||tag==="TEXTAREA"){var proto=tag==="TEXTAREA"?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;var setter=Object.getOwnPropertyDescriptor(proto,"value").set;setter.call(el,text);}' +
          'else if(el.isContentEditable){el.textContent=text;}else{el.value=text;}' +
          'el.dispatchEvent(new Event("input",{bubbles:true}));el.dispatchEvent(new Event("change",{bubbles:true}));' +
          'return {ok:true};})()'
        )
      }
      function scrollScript(args) {
        var up = args && args.direction === 'up'
        var amount = args && typeof args.amount === 'number' ? args.amount : 1
        return (
          '(function(){var delta=' + (up ? -1 : 1) * Math.max(1, Math.min(10, amount)) +
          '*Math.max(400,window.innerHeight*0.85);window.scrollBy({top:delta,left:0,behavior:"instant"});' +
          'return {ok:true,scrollY:window.scrollY};})()'
        )
      }
      var CLICK_INTERCEPT_JS =
        '(function(){if(window.__dshAbClickHook)return "ok";window.__dshAbClickHook=true;window.__dshAbClicks=[];' +
        'var exts=/\\.(zip|rar|7z|pdf|exe|msi|dmg|pkg|tar|gz|tgz|csv|xlsx?|docx?|pptx?|png|jpe?g|gif|webp|mp3|mp4|wav|apk|iso|txt|json|epub)([?#]|$)/i;' +
        'document.addEventListener("click",function(ev){try{var el=ev.target&&ev.target.closest?ev.target.closest("a[href]"):null;if(!el)return;var href=el.href||"";var dl=el.hasAttribute("download");' +
        'if(!dl&&!exts.test(href))return;ev.preventDefault();ev.stopPropagation();window.__dshAbClicks.push({url:href,name:el.getAttribute("download")||"",at:Date.now()});}catch(e){}},true);return "ok";})()'
      function startFetchScript(url) {
        return (
          '(function(url){window.__dshAbFetch={state:"loading",b64:null,error:null,name:"",mime:"",size:0,off:0};' +
          'fetch(url,{credentials:"include"}).then(function(r){if(!r.ok)throw new Error("HTTP "+r.status);return r.blob()})' +
          '.then(function(b){window.__dshAbFetch.mime=b.type||"";window.__dshAbFetch.size=b.size;' +
          'return new Promise(function(res){var fr=new FileReader();fr.onload=function(){window.__dshAbFetch.b64=String(fr.result||"");window.__dshAbFetch.state="ready";res()};' +
          'fr.onerror=function(){window.__dshAbFetch.state="error";window.__dshAbFetch.error="read failed";res()};fr.readAsDataURL(b)})})' +
          '.catch(function(e){window.__dshAbFetch.state="error";window.__dshAbFetch.error=String(e&&e.message||e)});return "started"})(' +
          JSON.stringify(url) + ')'
        )
      }
      var NEXT_CHUNK_JS =
        '(function(){var f=window.__dshAbFetch;if(!f)return {state:"none"};if(f.state==="error")return {state:"error",error:f.error||"fetch failed"};' +
        'if(f.state!=="ready")return {state:f.state};var b=f.b64||"";var off=f.off||0;var chunk=b.slice(off,off+' + DOWNLOAD_CHUNK + ');f.off=off+chunk.length;' +
        'return {state:"ready",chunk:chunk,done:f.off>=b.length,mime:f.mime||"",size:f.size||0};})()'

      function filenameFromUrl(url) {
        try {
          var clean = String(url).split('#')[0].split('?')[0]
          var base = clean.slice(clean.lastIndexOf('/') + 1)
          base = decodeURIComponent(base)
          return base === '' ? 'download.bin' : base
        } catch (error) {
          return 'download.bin'
        }
      }

      // ------------------------------------------------------------------
      // 浏览器面板（多窗口）
      // ------------------------------------------------------------------
      function BrowserPanel(props) {
        var t = getT(props)
        var sessionId = props.sessionId
        var envRef = React.useRef(null)
        var [ui, setUi] = React.useState({ status: 'starting', windows: [], activeId: '', address: '', error: '', notice: '', levels: {} })
        var editingRef = React.useRef(false)
        var containerRefs = React.useRef({})

        function patch(next) {
          setUi(function (previous) {
            return Object.assign({}, previous, next)
          })
        }

        React.useEffect(
          function () {
            var env = {
              alive: true,
              desktop: null,
              windows: new Map(),
              nextId: 1,
              activeId: '',
              levels: {},
              defaultLevel: 'view',
              polling: false,
              cursor: 0,
              reportTimer: null,
              noticeTimer: null,
              drainTimer: null,
            }
            envRef.current = env
            var disposed = false

            function snapshotWindows() {
              var windows = []
              env.windows.forEach(function (window) {
                windows.push({
                  id: window.id,
                  url: window.url,
                  title: window.title,
                  ready: window.ready,
                  loading: window.loading,
                  canGoBack: window.canGoBack,
                  canGoForward: window.canGoForward,
                })
              })
              return windows
            }
            function sync(extra) {
              if (!env.alive) return
              var windows = snapshotWindows()
              if (!disposed) {
                setUi(function (previous) {
                  return Object.assign({}, previous, extra || {}, { windows: windows, activeId: env.activeId, levels: Object.assign({}, env.levels) })
                })
              }
            }
            function notice(text) {
              if (!env.alive) return
              patch({ notice: text })
              if (env.noticeTimer !== null) clearTimeout(env.noticeTimer)
              env.noticeTimer = setTimeout(function () {
                env.noticeTimer = null
                patch({ notice: '' })
              }, 6000)
            }
            function report(force) {
              if (env.reportTimer !== null && force !== true) return
              if (env.reportTimer !== null) clearTimeout(env.reportTimer)
              var send = function () {
                env.reportTimer = null
                var windows = []
                env.windows.forEach(function (window) {
                  windows.push({ id: window.id, url: window.url, title: window.title, ready: window.ready, loading: window.loading })
                })
                requestJson('/report', {
                  method: 'POST',
                  body: { sessionId: sessionId, connected: env.windows.size > 0, activeWindowId: env.activeId, windows: windows },
                }).catch(function () {})
              }
              if (force === true) send()
              else env.reportTimer = setTimeout(send, 400)
            }
            function loadLevels() {
              return requestJson('/session', { method: 'POST', body: { sessionId: sessionId } })
                .then(function (payload) {
                  if (!env.alive) return
                  env.defaultLevel = payload.defaultLevel || 'view'
                  var levels = {}
                  var list = Array.isArray(payload.windows) ? payload.windows : []
                  list.forEach(function (window) {
                    levels[window.id] = window.level || env.defaultLevel
                  })
                  env.windows.forEach(function (window) {
                    if (levels[window.id] === undefined) levels[window.id] = env.levels[window.id] || env.defaultLevel
                  })
                  env.levels = levels
                  sync()
                })
                .catch(function () {})
            }
            function windowOf(requested) {
              if (typeof requested === 'string' && requested !== '') {
                var exact = env.windows.get(requested)
                if (exact !== undefined) return exact
              }
              var active = env.windows.get(env.activeId)
              if (active !== undefined) return active
              var first = env.windows.values().next()
              return first.done ? null : first.value
            }
            function execPage(window, script) {
              if (window === null || window.webview === null || window.ready !== true) {
                return Promise.reject(bridgeError('NOT_CONNECTED', '浏览器窗口尚未就绪'))
              }
              return Promise.resolve(window.webview.executeJavaScript(script, true)).catch(function (error) {
                throw bridgeError('FAILED', '页面脚本执行失败：' + errorText(error))
              })
            }
            function readState(window) {
              if (window === null) return Promise.resolve({})
              if (window.ready !== true || window.webview === null) return Promise.resolve({ url: window.url, title: window.title })
              return Promise.resolve(window.webview.executeJavaScript('({url:location.href,title:document.title})', true))
                .catch(function () {
                  return { url: window.url, title: window.title }
                })
                .then(function (info) {
                  var raw = typeof info.url === 'string' ? info.url : ''
                  window.url = raw.indexOf('about:blank') === 0 ? '' : raw
                  window.title = window.url === '' ? '' : typeof info.title === 'string' ? info.title : ''
                  window.loading = typeof window.webview.isLoading === 'function' ? window.webview.isLoading() : false
                  window.canGoBack = typeof window.webview.canGoBack === 'function' ? window.webview.canGoBack() : false
                  window.canGoForward = typeof window.webview.canGoForward === 'function' ? window.webview.canGoForward() : false
                  if (env.activeId === window.id && !editingRef.current) patch({ address: window.url })
                  sync()
                  report(false)
                  syncWindowPolicy(window)
                  return { url: window.url, title: window.title, canGoBack: window.canGoBack, canGoForward: window.canGoForward }
                })
            }
            function syncWindowPolicy(window) {
              if (window === null || typeof window.url !== 'string' || window.url === '') return
              var host = ''
              try {
                host = new URL(window.url).hostname.toLowerCase()
              } catch (error) {
                return
              }
              if (window.policyHost === host) return
              window.policyHost = host
              requestJson('/policy', { method: 'POST', body: { sessionId: sessionId, url: window.url } })
                .then(function (policy) {
                  if (!env.alive) return
                  var level = policy !== null && typeof policy.level === 'string' ? policy.level : 'view'
                  env.levels[window.id] = level
                  sync()
                  report(true)
                })
                .catch(function () {})
            }
            function windowsPayload() {
              var windows = []
              env.windows.forEach(function (window) {
                windows.push({ id: window.id, url: window.url, title: window.title, ready: window.ready, loading: window.loading, active: window.id === env.activeId })
              })
              return { windows: windows, activeWindowId: env.activeId }
            }
            function installInterceptor(window) {
              return execPage(window, CLICK_INTERCEPT_JS).catch(function () {})
            }
            function releaseWindow(window) {
              try {
                if (typeof window.unsubscribeOpen === 'function') window.unsubscribeOpen()
              } catch (error) {
                /* 忽略 */
              }
              window.unsubscribeOpen = null
              try {
                if (window.webview !== null) window.webview.remove()
              } catch (error) {
                /* 忽略 */
              }
              window.webview = null
              if (window.lease !== null && env.desktop !== null) {
                try {
                  Promise.resolve(env.desktop.release(window.lease)).catch(function () {})
                } catch (error) {
                  /* 忽略 */
                }
                window.lease = null
              }
            }
            function applyLevel(windowId, level) {
              env.levels[windowId] = level
              report(true)
              sync()
              return requestJson('/level', { method: 'POST', body: { sessionId: sessionId, windowId: windowId, level: level } }).catch(function () {})
            }
            function createWindow(url, options) {
              if (env.desktop === null) return Promise.reject(bridgeError('FAILED', '当前环境不支持应用内浏览器'))
              var previousActive = env.activeId
              return env.desktop.acquire('session:' + sessionId).then(function (reservation) {
                if (!env.alive) {
                  try {
                    env.desktop.release(reservation.lease)
                  } catch (error) {
                    /* 忽略 */
                  }
                  throw bridgeError('FAILED', '面板已卸载')
                }
                var window = {
                  id: 'w' + env.nextId++,
                  lease: reservation.lease,
                  partition: reservation.partition,
                  webview: null,
                  ready: false,
                  url: '',
                  title: '',
                  loading: false,
                  canGoBack: false,
                  canGoForward: false,
                  pendingUrl: typeof url === 'string' ? url : '',
                  popupUrl: options !== null && options !== undefined && options.fromPopup === true && typeof url === 'string' ? url : '',
                  processing: new Set(),
                  unsubscribeOpen: null,
                }
                var webview = document.createElement('webview')
                webview.className = 'dsh-ab-webview'
                webview.setAttribute('name', reservation.lease)
                webview.setAttribute('partition', reservation.partition)
                webview.setAttribute('allowpopups', '')
                webview.setAttribute('src', 'about:blank#' + reservation.lease)
                window.webview = webview
                var on = function (name, handler) {
                  webview.addEventListener(name, handler)
                }
                on('dom-ready', function () {
                  window.ready = true
                  sync()
                  report(true)
                  readState(window)
                  installInterceptor(window)
                  if (window.pendingUrl !== '') {
                    var pending = window.pendingUrl
                    window.pendingUrl = ''
                    navigateAndWait(window, pending).catch(function () {})
                  }
                })
                on('did-navigate', function () {
                  readState(window)
                })
                on('did-navigate-in-page', function () {
                  readState(window)
                })
                on('page-title-updated', function () {
                  readState(window)
                })
                on('did-start-loading', function () {
                  window.loading = true
                  sync()
                  report(false)
                })
                on('did-stop-loading', function () {
                  readState(window)
                })
                on('did-fail-load', function (event) {
                  if (!event || event.isMainFrame !== true || event.errorCode === -3) return
                  notice('页面加载失败（' + (event.errorCode || '?') + '）：' + (event.errorDescription || ''))
                  report(false)
                })
                on('render-process-gone', function () {
                  notice('浏览器窗口进程已退出，可关闭该窗口后新建。')
                  window.ready = false
                  sync()
                  report(false)
                })
                // 下载触发的弹窗（window.open 后立刻关闭）会留下空白标签页：
                // 该弹窗内发起下载时直接关掉这个标签；另加空白兜底。
                on('will-download', function () {
                  if (options !== null && options !== undefined && options.fromPopup === true) {
                    closeWindow(window.id).catch(function () {})
                  }
                })
                env.windows.set(window.id, window)
                if (options !== null && options !== undefined && options.fromPopup === true) {
                  setTimeout(function () {
                    if (!env.alive) return
                    var current = env.windows.get(window.id)
                    if (current === undefined || current.loading === true) return
                    var currentUrl = typeof current.url === 'string' ? current.url : ''
                    var popupUrl = typeof current.popupUrl === 'string' ? current.popupUrl : ''
                    var staysOnPopupUrl = popupUrl !== '' && currentUrl === popupUrl && (current.title === '' || current.title === undefined || current.title === null)
                    if (currentUrl === '' || currentUrl === 'about:blank' || staysOnPopupUrl) closeWindow(window.id).catch(function () {})
                  }, 3000)
                }
                if (typeof env.desktop.onOpenRequested === 'function') {
                  try {
                    window.unsubscribeOpen = env.desktop.onOpenRequested(reservation.lease, function (popupUrl) {
                      if (!env.alive || typeof popupUrl !== 'string' || popupUrl === '') return
                      createWindow(popupUrl, { fromPopup: true })
                        .then(function (created) {
                          if (created === undefined || created === null || created.id === undefined) return
                          env.activeId = created.id
                          sync()
                          report(true)
                        })
                        .catch(function (error) {
                          notice('打开新标签页失败：' + errorText(error))
                        })
                    })
                  } catch (error) {
                    /* 忽略：旧版宿主没有该接口 */
                  }
                }
                env.activeId = window.id
                env.levels[window.id] = 'view'
                requestJson('/level', { method: 'POST', body: { sessionId: sessionId, windowId: window.id, level: 'view' } }).catch(function () {})
                sync()
                report(true)
                var host = containerRefs.current[window.id]
                if (host !== undefined && host !== null && webview.parentNode !== host) host.appendChild(webview)
                if (window.ready === true && window.pendingUrl !== '') {
                  var target = window.pendingUrl
                  window.pendingUrl = ''
                  navigateAndWait(window, target).catch(function () {})
                }
                return window
              })
            }
            function closeWindow(id) {
              var window = env.windows.get(id)
              if (window === undefined) return Promise.reject(bridgeError('NO_WINDOW', '窗口不存在'))
              env.windows.delete(id)
              delete env.levels[id]
              releaseWindow(window)
              if (env.activeId === id) {
                var first = env.windows.values().next()
                env.activeId = first.done ? '' : first.value.id
              }
              sync()
              report(true)
              return Promise.resolve(windowsPayload())
            }
            function navigateAndWait(window, url) {
              if (window === null || window.webview === null || window.ready !== true) return Promise.reject(bridgeError('NOT_CONNECTED', '浏览器窗口尚未就绪'))
              if (typeof url !== 'string' || url === '') return Promise.reject(bridgeError('PROTOCOL', '缺少网址'))
              return new Promise(function (resolve, reject) {
                var settled = false
                var timer = null
                var webview = window.webview
                function cleanup() {
                  if (timer !== null) clearTimeout(timer)
                  webview.removeEventListener('did-stop-loading', onStop)
                  webview.removeEventListener('did-fail-load', onFail)
                }
                function finish() {
                  if (settled) return
                  settled = true
                  cleanup()
                  readState(window).then(resolve)
                }
                function onStop() {
                  finish()
                }
                function onFail(event) {
                  if (event && event.isMainFrame && event.errorCode !== -3 && !settled) {
                    settled = true
                    cleanup()
                    reject(bridgeError('NAVIGATION_BLOCKED', '页面加载失败（' + (event.errorCode || '?') + '）：' + (event.errorDescription || '')))
                  }
                }
                timer = setTimeout(finish, 25000)
                webview.addEventListener('did-stop-loading', onStop)
                webview.addEventListener('did-fail-load', onFail)
                Promise.resolve(webview.loadURL(url)).catch(function (error) {
                  var code = error && error.code ? String(error.code) : ''
                  if (code === 'ERR_ABORTED' || settled) return
                  settled = true
                  cleanup()
                  reject(bridgeError('NAVIGATION_BLOCKED', '页面无法打开：' + errorText(error)))
                })
              })
            }
            function sendKey(window, key) {
              if (window === null || window.webview === null || window.ready !== true) return Promise.reject(bridgeError('NOT_CONNECTED', '浏览器窗口尚未就绪'))
              try {
                if (typeof window.webview.focus === 'function') window.webview.focus()
              } catch (error) {
                /* 忽略 */
              }
              if (typeof window.webview.sendInputEvent === 'function') {
                try {
                  window.webview.sendInputEvent({ type: 'keyDown', keyCode: key })
                  window.webview.sendInputEvent({ type: 'keyUp', keyCode: key })
                  return readState(window)
                } catch (error) {
                  /* 回退 */
                }
              }
              var jsonKey = JSON.stringify(String(key))
              return execPage(
                window,
                '(function(){var el=document.activeElement||document.body;var t=' + jsonKey + ';var down=new KeyboardEvent("keydown",{key:t,bubbles:true,cancelable:true});el.dispatchEvent(down);var up=new KeyboardEvent("keyup",{key:t,bubbles:true,cancelable:true});el.dispatchEvent(up);return {ok:true};})()',
              )
            }
            function capturePage(window) {
              if (window === null || window.webview === null || window.ready !== true) return Promise.reject(bridgeError('NOT_CONNECTED', '浏览器窗口尚未就绪'))
              if (typeof window.webview.capturePage !== 'function') return Promise.reject(bridgeError('FAILED', '当前浏览器载体不支持截图'))
              return Promise.resolve(window.webview.capturePage())
                .then(function (image) {
                  if (image === null || image === undefined || typeof image.toDataURL !== 'function') throw bridgeError('FAILED', '截图失败')
                  var size = typeof image.getSize === 'function' ? image.getSize() : { width: 0, height: 0 }
                  return { dataUrl: image.toDataURL(), width: size.width, height: size.height, url: window.url, title: window.title }
                })
                .catch(function (error) {
                  if (error && error.bridgeCode) throw error
                  throw bridgeError('FAILED', '截图失败：' + errorText(error))
                })
            }
            /** 页面内取回文件（同源或允许 CORS 时可用）。 */
            function downloadViaPage(window, url, filenameHint) {
              return execPage(window, startFetchScript(url))
                .then(function () {
                  var base64 = ''
                  var mime = ''
                  var step = function () {
                    return execPage(window, NEXT_CHUNK_JS).then(function (chunk) {
                      if (chunk.state === 'none') throw bridgeError('FAILED', '页面没有下载数据')
                      if (chunk.state === 'error') throw bridgeError('FAILED', '页面取回文件失败：' + (chunk.error || '未知'))
                      if (chunk.state !== 'ready') return sleep(150).then(step)
                      mime = chunk.mime || mime
                      if (typeof chunk.chunk === 'string') base64 += chunk.chunk
                      if (base64.length > 180 * 1024 * 1024) throw bridgeError('TOO_LARGE', '文件超过 128MB 上限')
                      if (chunk.done === true) return null
                      return sleep(30).then(step)
                    })
                  }
                  return step().then(function () {
                    var name = filenameHint !== '' ? filenameHint : filenameFromUrl(url)
                    return requestJson('/download', { method: 'POST', body: { sessionId: sessionId, name: name, mime: mime, data: base64 } })
                  })
                })
                .then(function (saved) {
                  return { path: saved.path, name: saved.name, bytes: saved.bytes, url: url, title: window.title }
                })
            }
            /** Host 直连下载：绕过页面跨域限制（CORS）。 */
            function downloadViaHost(window, url, filenameHint) {
              var name = filenameHint !== '' ? filenameHint : filenameFromUrl(url)
              return requestJson('/download-url', { method: 'POST', body: { sessionId: sessionId, url: url, filename: name } }).then(function (saved) {
                return { path: saved.path, name: saved.name, bytes: saved.bytes, url: url, title: window.title }
              })
            }
            /** 先尝试页面内取回（可带登录态），失败后退回 Host 直连下载。 */
            function downloadInPage(window, url, filenameHint) {
              if (typeof url !== 'string' || !/^https?:/i.test(url)) return Promise.reject(bridgeError('PROTOCOL', '下载需要 http/https 地址'))
              return downloadViaPage(window, url, filenameHint).catch(function (pageError) {
                return downloadViaHost(window, url, filenameHint).catch(function (hostError) {
                  throw bridgeError(
                    'DOWNLOAD_FAILED',
                    '页面取回失败（' + errorText(pageError) + '）；Host 直连下载也失败（' + errorText(hostError) + '）',
                  )
                })
              })
            }
            function drainClickQueue() {
              env.windows.forEach(function (window) {
                if (window.ready !== true) return
                execPage(window, 'window.__dshAbClicks&&window.__dshAbClicks.length?window.__dshAbClicks.splice(0,4):[]')
                  .then(function (items) {
                    if (!Array.isArray(items)) return
                    if (items.length > 0) ensureDownloadsOpen()
                    items.forEach(function (item) {
                      if (!item || typeof item.url !== 'string' || window.processing.has(item.url)) return
                      window.processing.add(item.url)
                      patch({ notice: t('panel.downloading', { name: item.name || filenameFromUrl(item.url) }) })
                      downloadInPage(window, item.url, item.name || '')
                        .then(function (saved) {
                          window.processing.delete(item.url)
                          notice(t('panel.downloaded', { name: saved.name, path: saved.path }))
                        })
                        .catch(function (error) {
                          window.processing.delete(item.url)
                          notice(t('panel.downloadFailed', { message: errorText(error) }))
                        })
                    })
                  })
                  .catch(function () {})
              })
            }
            function elementHref(window, args) {
              return execPage(
                window,
                '(function(){var el=' + locateExpression(args) + ';if(!el)return {found:false};var href=el.href||el.getAttribute("href")||"";var dl=el.getAttribute("download")||"";return {found:true,href:href||"",name:dl};})()',
              )
            }
            function handleCommand(command) {
              var args = command.args !== null && typeof command.args === 'object' ? command.args : {}
              var op = command.op
              if (op === 'new_window') return createWindow(typeof args.url === 'string' ? args.url : '').then(windowsPayload)
              if (op === 'close_window') {
                var targetId = typeof args.window === 'string' && args.window !== '' ? args.window : env.activeId
                return closeWindow(targetId)
              }
              var window = windowOf(args.window)
              if (window === null) throw bridgeError('NO_WINDOW', '浏览器面板还没有打开的窗口')
              switch (op) {
                case 'windows':
                case 'state':
                  return readState(window).then(windowsPayload)
                case 'open':
                  return navigateAndWait(window, typeof args.url === 'string' ? args.url : '')
                case 'back':
                  if (window.webview && typeof window.webview.canGoBack === 'function' && window.webview.canGoBack()) {
                    window.webview.goBack()
                    return sleep(400).then(function () {
                      return readState(window)
                    })
                  }
                  throw bridgeError('NAVIGATION_BLOCKED', '当前没有可后退的历史')
                case 'forward':
                  if (window.webview && typeof window.webview.canGoForward === 'function' && window.webview.canGoForward()) {
                    window.webview.goForward()
                    return sleep(400).then(function () {
                      return readState(window)
                    })
                  }
                  throw bridgeError('NAVIGATION_BLOCKED', '当前没有可前进的历史')
                case 'reload':
                  if (window.webview && typeof window.webview.reload === 'function') {
                    window.webview.reload()
                    return sleep(600).then(function () {
                      return readState(window)
                    })
                  }
                  throw bridgeError('NAVIGATION_BLOCKED', '无法刷新')
                case 'read':
                  return execPage(window, readScript(typeof args.maxChars === 'number' ? args.maxChars : 12000))
                case 'inspect':
                  return execPage(window, inspectScript(args))
                case 'click':
                  return execPage(window, clickScript(args))
                case 'type':
                  return execPage(window, typeScript(args))
                case 'scroll':
                  return execPage(window, scrollScript(args)).then(function (value) {
                    return sleep(200).then(function () {
                      return readState(window)
                    }).then(function (state) {
                      return Object.assign({}, state, value)
                    })
                  })
                case 'press':
                  return sendKey(window, typeof args.key === 'string' ? args.key : 'Enter')
                case 'screenshot':
                  return capturePage(window)
                case 'download':
                  ensureDownloadsOpen()
                  if (typeof args.url === 'string' && args.url !== '') return downloadInPage(window, args.url, typeof args.filename === 'string' ? args.filename : '')
                  return elementHref(window, args).then(function (element) {
                    if (!element || element.found !== true || element.href === '') throw bridgeError('NO_ELEMENT', '没有找到可下载的链接')
                    return downloadInPage(window, element.href, element.name || (typeof args.filename === 'string' ? args.filename : ''))
                  })
                default:
                  throw bridgeError('PROTOCOL', '未知的浏览器命令：' + String(op))
              }
            }
            function presentResult(value, window) {
              var result = value !== null && typeof value === 'object' ? Object.assign({}, value) : {}
              if (window !== undefined && window !== null) {
                if (typeof result.url !== 'string' || result.url === '') result.url = window.url
                if (typeof result.title !== 'string' || result.title === '') result.title = window.title
              }
              return result
            }
            function runCommand(command) {
              var window = null
              return Promise.resolve()
                .then(function () {
                  window = windowOf(command.args && command.args.window)
                  return handleCommand(command)
                })
                .then(function (value) {
                  return { ok: true, value: presentResult(value, window) }
                })
                .catch(function (error) {
                  return { ok: false, error: { code: (error && error.bridgeCode) || 'FAILED', message: errorText(error) } }
                })
                .then(function (payload) {
                  var body = { sessionId: sessionId, id: command.id, ok: payload.ok }
                  if (payload.ok) body.value = payload.value
                  else body.error = payload.error
                  return requestJson('/result', { method: 'POST', body: body }).catch(function () {})
                })
            }
            function pollLoop() {
              if (!env.alive || !env.polling) return
              var controller = typeof AbortController === 'function' ? new AbortController() : null
              var abortTimer = setTimeout(function () {
                if (controller !== null) controller.abort()
              }, 40000)
              requestJson('/poll', { method: 'POST', body: { sessionId: sessionId, cursor: env.cursor }, signal: controller === null ? undefined : controller.signal })
                .then(function (payload) {
                  clearTimeout(abortTimer)
                  if (!env.alive) return
                  if (typeof payload.cursor === 'number') env.cursor = payload.cursor
                  var commands = Array.isArray(payload.commands) ? payload.commands : []
                  var chain = Promise.resolve()
                  commands.forEach(function (command) {
                    chain = chain.then(function () {
                      return runCommand(command)
                    })
                  })
                  return chain
                })
                .catch(function () {
                  clearTimeout(abortTimer)
                  return sleep(1200)
                })
                .then(function () {
                  if (!env.alive || !env.polling) return
                  setTimeout(pollLoop, 60)
                })
            }
            function start() {
              var carrier = typeof globalThis !== 'undefined' ? globalThis.dshDesktop : undefined
              var desktop = carrier !== null && typeof carrier === 'object' && carrier.protocolVersion === 1 ? carrier.browser : undefined
              if (desktop === undefined || desktop === null || typeof desktop.acquire !== 'function') {
                patch({ status: 'unsupported' })
                return
              }
              env.desktop = desktop
              patch({ status: 'ready' })
              // 自检：Host 侧代码若还是旧版本（安装了但没重启 DSH），明确提示用户，而不是让下载等功能静默失败。
              requestJson('/health', { method: 'GET' })
                .then(function (info) {
                  if (!env.alive || info === null || typeof info !== 'object') return
                  var hostVersion = typeof info.version === 'string' ? info.version : ''
                  var features = Array.isArray(info.features) ? info.features : []
                  var missing = REQUIRED_HOST_FEATURES.filter(function (feature) {
                    return features.indexOf(feature) < 0
                  })
                  if (hostVersion !== '' && hostVersion !== CLIENT_VERSION) {
                    notice(t('panel.hostStale', { host: hostVersion, client: CLIENT_VERSION }))
                  } else if (features.length > 0 && missing.length > 0) {
                    notice(t('panel.hostNotReady', { missing: missing.join(', ') }))
                  }
                })
                .catch(function () {})
              requestJson('/session', { method: 'POST', body: { sessionId: sessionId } })
                .then(function (payload) {
                  if (!env.alive) return
                  env.defaultLevel = payload.defaultLevel || 'view'
                  var levels = {}
                  var list = Array.isArray(payload.windows) ? payload.windows : []
                  list.forEach(function (window) {
                    levels[window.id] = window.level || env.defaultLevel
                  })
                  env.levels = levels
                  sync()
                  return createWindow('')
                })
                .catch(function () {
                  return createWindow('').catch(function (error) {
                    patch({ status: 'failed', error: errorText(error) })
                  })
                })
                .then(function () {
                  if (!env.alive) return
                  env.polling = true
                  pollLoop()
                  env.drainTimer = setInterval(drainClickQueue, 900)
                })
                .catch(function () {})
            }
            function dispose() {
              env.alive = false
              env.polling = false
              if (env.reportTimer !== null) clearTimeout(env.reportTimer)
              if (env.noticeTimer !== null) clearTimeout(env.noticeTimer)
              if (env.drainTimer !== null) clearInterval(env.drainTimer)
              env.windows.forEach(function (window) {
                releaseWindow(window)
              })
              env.windows.clear()
              requestJson('/report', { method: 'POST', body: { sessionId: sessionId, connected: false, activeWindowId: '', windows: [] } }).catch(function () {})
            }

            env.actions = {
              setActive: function (id) {
                if (!env.windows.has(id)) return
                env.activeId = id
                editingRef.current = false
                var window = env.windows.get(id)
                patch({ address: window === undefined ? '' : window.url })
                sync()
                report(true)
                loadLevels()
              },
              createWindow: function (url) {
                return createWindow(url || '').catch(function (error) {
                  notice(errorText(error))
                })
              },
              closeWindowById: function (id) {
                closeWindow(id).catch(function (error) {
                  notice(errorText(error))
                })
              },
              closeActive: function () {
                if (env.activeId === '') return
                closeWindow(env.activeId).catch(function (error) {
                  notice(errorText(error))
                })
              },
              navigate: function (text) {
                var window = windowOf(env.activeId)
                if (window === null) return
                var value = String(text).trim()
                if (value === '') return
                var url = value
                if (!/^https?:\/\//i.test(url)) {
                  if (/^[\w-]+(\.[\w-]+)+([/:?#].*)?$/.test(url)) url = 'https://' + url
                  else url = 'https://www.bing.com/search?q=' + encodeURIComponent(url)
                }
                navigateAndWait(window, url).catch(function (error) {
                  notice(errorText(error))
                })
              },
              back: function () {
                var window = windowOf(env.activeId)
                if (window && window.webview && typeof window.webview.canGoBack === 'function' && window.webview.canGoBack()) window.webview.goBack()
              },
              forward: function () {
                var window = windowOf(env.activeId)
                if (window && window.webview && typeof window.webview.canGoForward === 'function' && window.webview.canGoForward()) window.webview.goForward()
              },
              reload: function () {
                var window = windowOf(env.activeId)
                if (window && window.webview && typeof window.webview.reload === 'function') window.webview.reload()
              },
              loadLevels: loadLevels,
              levelOf: function (id) {
                return env.levels[id] || env.defaultLevel || 'view'
              },
              windowTitle: function (id) {
                var window = env.windows.get(id)
                if (window === undefined) return ''
                return window.title !== '' ? window.title : window.url
              },
            }
            start()
            return function () {
              disposed = true
              dispose()
            }
          },
          [sessionId],
        )

        var active = ui.windows.find(function (window) {
          return window.id === ui.activeId
        })
        var activeLevel = ui.levels[ui.activeId] || 'view'
        var [uiSheets, setUiSheets] = React.useState({ menu: null, warning: null, downloads: null })
        var [settingsOpen, setSettingsOpen] = React.useState(false)
        var [sites, setSites] = React.useState({ loading: false, lists: { view: [], simple: [], review: [], full: [] }, workspacePath: '', seededPreset: '', error: '' })
        var [siteInputs, setSiteInputs] = React.useState({ view: '', simple: '', review: '', full: '' })
        var [acknowledged, setAcknowledged] = React.useState(false)
        var [expandedLists, setExpandedLists] = React.useState({ view: false, simple: false, review: false, full: false })
        var [presets, setPresets] = React.useState({ loading: false, list: [], defaultPresetId: '', error: '', busy: '', message: '' })
        /** 预设列表搜索词（只过滤列表，不影响选中/应用）。 */
        var [presetQuery, setPresetQuery] = React.useState('')
        /** 「存为预设」的预设名（留空用默认名）。 */
        var [presetSaveName, setPresetSaveName] = React.useState('')
        /** 「导入到当前工作区」用的隐藏文件选择框。 */
        var workspaceImportRef = React.useRef(null)
        var [library, setLibrary] = React.useState({ loaded: false, bookmarks: [], history: [], workspacePath: '', error: '' })
        var [libraryView, setLibraryView] = React.useState(null)
        var activeUrl = active !== undefined && active !== null && typeof active.url === 'string' ? active.url : ''

        React.useEffect(
          function () {
            loadLibrary()
            return undefined
          },
          [sessionId, activeUrl],
        )

        React.useEffect(function () {
          return uiSubscribe(function () {
            setUiSheets({ menu: UI.state.menu, warning: UI.state.warning, downloads: UI.state.downloads })
            var env = envRef.current
            if (env !== null && env.actions !== undefined) env.actions.loadLevels()
          })
        }, [])

        React.useEffect(
          function () {
            setAcknowledged(false)
          },
          [uiSheets.warning === null ? null : uiSheets.warning.level],
        )

        function closeSheets() {
          uiSet({ menu: null, warning: null, downloads: null })
        }

        function openDownloads(event) {
          var fromClick = event !== undefined && event !== null && event.currentTarget !== undefined && event.currentTarget !== null
          if (fromClick && UI.state.downloads !== null) {
            uiSet({ downloads: null })
            return
          }
          setSettingsOpen(false)
          setLibraryView(null)
          uiSet({ menu: null, warning: null, error: null, downloads: { sessionId: sessionId } })
        }

        function ensureDownloadsOpen() {
          if (UI.state.downloads === null) openDownloads()
        }

        function selectLevel(level) {
          var menu = UI.state.menu
          if (menu === null) return
          if (level === menu.level) {
            uiSet({ menu: null })
            return
          }
          if (level === 'review' || level === 'full') {
            uiSet({ menu: null, warning: { level: level, sessionId: menu.sessionId, windowId: menu.windowId } })
            return
          }
          commitLevel(menu.sessionId, menu.windowId, level)
        }

        function permissionSheet() {
          var menu = uiSheets.menu
          if (menu === null) return null
          return h(
            'div',
            { className: 'dsh-ab-sheet' },
            h(
              'div',
              { className: 'dsh-ab-sheet-head' },
              h('span', { className: 'dsh-ab-sheet-title' }, t('perm.menu.title')),
              h('button', { type: 'button', className: 'dsh-ab-dl-icon-btn', title: t('downloads.close'), onClick: closeSheets }, icon(ICONS.close, 14)),
            ),
            menu.windowLabel ? h('div', { className: 'dsh-ab-sheet-desc' }, menu.windowLabel) : null,
            LEVELS.map(function (level) {
              var isActive = menu.level === level
              return h(
                'button',
                {
                  key: level,
                  type: 'button',
                  className: 'dsh-ab-sheet-item' + (isActive ? ' is-active' : ''),
                  onClick: function () {
                    selectLevel(level)
                  },
                },
                h('span', { className: 'dsh-ab-sheet-check', 'aria-hidden': true }, isActive ? '✓' : ''),
                h(
                  'span',
                  { className: 'dsh-ab-sheet-text' },
                  h('span', { className: 'dsh-ab-sheet-label' }, t('perm.' + level)),
                  h('span', { className: 'dsh-ab-sheet-hint' }, t('perm.' + level + '.hint')),
                ),
              )
            }),
          )
        }

        function warningSheet() {
          var warning = uiSheets.warning
          if (warning === null) return null
          return h(
            'div',
            { className: 'dsh-ab-sheet dsh-ab-sheet-warning' },
            h(
              'div',
              { className: 'dsh-ab-sheet-head' },
              h('span', { className: 'dsh-ab-sheet-title' }, t('perm.warning.title')),
              h('button', { type: 'button', className: 'dsh-ab-dl-icon-btn', title: t('perm.warning.cancel'), onClick: function () { uiSet({ warning: null }) } }, icon(ICONS.close, 14)),
            ),
            h('div', { className: 'dsh-ab-sheet-desc' }, t(warning.level === 'full' ? 'perm.warning.full' : 'perm.warning.review')),
            h(
              'label',
              { className: 'dsh-ab-sheet-ack' },
              h('input', {
                type: 'checkbox',
                checked: acknowledged,
                onChange: function (event) {
                  setAcknowledged(event.target.checked)
                },
              }),
              h('span', null, t('perm.warning.ack')),
            ),
            h(
              'div',
              { className: 'dsh-ab-sheet-actions' },
              h('button', { type: 'button', className: 'dsh-ab-btn', onClick: function () { uiSet({ warning: null }) } }, t('perm.warning.cancel')),
              h(
                'button',
                {
                  type: 'button',
                  className: 'dsh-ab-btn dsh-ab-btn-primary',
                  disabled: !acknowledged,
                  onClick: function () {
                    commitLevel(warning.sessionId, warning.windowId, warning.level)
                  },
                },
                t('perm.warning.confirm'),
              ),
            ),
          )
        }

        function loadSites() {
          setSites(function (previous) {
            return Object.assign({}, previous, { loading: true, error: '' })
          })
          requestJson('/sites?sessionId=' + encodeURIComponent(sessionId), { method: 'GET' })
            .then(function (payload) {
              setSites({
                loading: false,
                lists: payload.lists || { view: [], simple: [], review: [], full: [] },
                workspacePath: payload.workspacePath || '',
                seededPreset: typeof payload.seededPreset === 'string' ? payload.seededPreset : '',
                error: '',
              })
            })
            .catch(function (error) {
              setSites(function (previous) {
                return Object.assign({}, previous, { loading: false, error: errorText(error) })
              })
            })
        }

        function openSettings() {
          setSettingsOpen(function (previous) {
            if (!previous) {
              loadSites()
              loadPresets()
              setLibraryView(null)
              uiSet({ menu: null, warning: null, downloads: null })
            }
            return !previous
          })
        }

        function saveSite(level, host, noAuth) {
          requestJson('/sites', { method: 'POST', body: { sessionId: sessionId, action: 'set', level: level, host: host, noAuth: noAuth === true } })
            .then(function (payload) {
              setSites({
                loading: false,
                lists: payload.lists || sites.lists,
                workspacePath: payload.workspacePath || sites.workspacePath || '',
                seededPreset: sites.seededPreset,
                error: '',
              })
            })
            .catch(function (error) {
              setSites(function (previous) {
                return Object.assign({}, previous, { error: errorText(error) })
              })
            })
        }

        function removeSite(host) {
          requestJson('/sites', { method: 'POST', body: { sessionId: sessionId, action: 'remove', host: host } })
            .then(function (payload) {
              setSites({
                loading: false,
                lists: payload.lists || sites.lists,
                workspacePath: payload.workspacePath || sites.workspacePath || '',
                seededPreset: sites.seededPreset,
                error: '',
              })
            })
            .catch(function (error) {
              setSites(function (previous) {
                return Object.assign({}, previous, { error: errorText(error) })
              })
            })
        }

        // ---- 权限预设（面板设置顶部 + Harness 设置页共用 /presets 路由） ----
        function loadPresets() {
          setPresets(function (previous) {
            return Object.assign({}, previous, { loading: true, error: '', message: '' })
          })
          requestJson('/presets', { method: 'GET' })
            .then(function (payload) {
              setPresets({
                loading: false,
                list: Array.isArray(payload.presets) ? payload.presets : [],
                defaultPresetId: typeof payload.defaultPresetId === 'string' ? payload.defaultPresetId : '',
                error: '',
                busy: '',
                message: '',
              })
            })
            .catch(function (error) {
              setPresets(function (previous) {
                return Object.assign({}, previous, { loading: false, error: errorText(error) })
              })
            })
        }

        function applyPreset(preset) {
          if (preset === null || preset === undefined) return
          setPresets(function (previous) {
            return Object.assign({}, previous, { busy: preset.id, error: '', message: '' })
          })
          requestJson('/presets', { method: 'POST', body: { action: 'apply', sessionId: sessionId, id: preset.id } })
            .then(function (payload) {
              setSites(function (previous) {
                return Object.assign({}, previous, {
                  lists: payload.lists || previous.lists,
                  workspacePath: typeof payload.workspacePath === 'string' ? payload.workspacePath : previous.workspacePath,
                  seededPreset: '',
                  error: '',
                })
              })
              setPresets({
                loading: false,
                list: Array.isArray(payload.presets) ? payload.presets : [],
                defaultPresetId: typeof payload.defaultPresetId === 'string' ? payload.defaultPresetId : '',
                error: '',
                busy: '',
                message: t('settings.presets.applied', { name: preset.name }),
              })
            })
            .catch(function (error) {
              setPresets(function (previous) {
                return Object.assign({}, previous, { busy: '', error: errorText(error) })
              })
            })
        }

        function patchPresets(patch) {
          setPresets(function (previous) {
            return Object.assign({}, previous, patch)
          })
        }

        /** 默认预设名：「工作区预设 2026/11/1 14:00:00」，避免同名靠时间区分。 */
        function defaultWorkspacePresetName() {
          var stamp = ''
          try {
            stamp = new Date().toLocaleString()
          } catch (error) {
            stamp = ''
          }
          return stamp === '' ? t('settings.presets.saveDefaultName') : t('settings.presets.saveDefaultName') + ' ' + stamp
        }

        /** 导出单个预设为 txt（纯客户端 Blob 下载）。 */
        function exportPresetToFile(preset) {
          if (preset === null || preset === undefined) return
          try {
            triggerTextDownload(presetTextFileName(preset.name, 'preset'), serializePresetText(preset.name, preset.lists))
            patchPresets({ error: '', message: t('settings.presets.exported', { name: preset.name }) })
          } catch (error) {
            patchPresets({ message: '', error: t('settings.presets.exportFailed', { message: errorText(error) }) })
          }
        }

        /** 把当前工作区的 sites.lists 存成一个新预设（名字来自输入框，留空用默认名）。 */
        function saveWorkspaceAsPreset() {
          if (presets.busy !== '') return
          var name = presetSaveName.trim()
          if (name === '') name = defaultWorkspacePresetName()
          patchPresets({ busy: 'save', error: '', message: '' })
          requestJson('/presets', { method: 'POST', body: { action: 'create', name: name, lists: sites.lists } })
            .then(function (payload) {
              setPresets(function (previous) {
                return Object.assign({}, previous, {
                  loading: false,
                  list: Array.isArray(payload.presets) ? payload.presets : previous.list,
                  defaultPresetId: typeof payload.defaultPresetId === 'string' ? payload.defaultPresetId : previous.defaultPresetId,
                  busy: '',
                  error: '',
                  message: t('settings.presets.saved', { name: name }),
                })
              })
              setPresetSaveName('')
            })
            .catch(function (error) {
              patchPresets({ busy: '', message: '', error: errorText(error) })
            })
        }

        /** 导出当前工作区名单为 txt（名字取工作区末级目录，拿不到用「当前工作区」）。 */
        function exportWorkspaceToFile() {
          var label = workspaceLabelOf(sites.workspacePath)
          if (label === '') label = t('settings.presets.workspaceName')
          try {
            triggerTextDownload(presetTextFileName(label, 'workspace'), serializePresetText(label, sites.lists))
            patchPresets({ error: '', message: t('settings.presets.workspaceExported') })
          } catch (error) {
            patchPresets({ message: '', error: t('settings.presets.exportFailed', { message: errorText(error) }) })
          }
        }

        /** 选 txt 文件后整体替换当前工作区名单（POST /sites action:replace，Host 会规范化）。 */
        function importWorkspaceFile(event) {
          var input = event !== null && event !== undefined ? event.target : null
          var file = null
          try {
            file = input !== null && input !== undefined && input.files !== undefined && input.files !== null ? input.files[0] : null
          } catch (error) {
            file = null
          }
          if (file === null || file === undefined) return
          if (presets.busy !== '') {
            try {
              input.value = ''
            } catch (error) {
              /* 忽略 */
            }
            return
          }
          patchPresets({ busy: 'import', error: '', message: '' })
          var importedCount = 0
          readTextFile(file)
            .then(function (text) {
              var parsed = parsePresetText(text)
              if (parsed === null) throw new Error(t('settings.presets.importInvalid'))
              importedCount = parsed.count
              return requestJson('/sites', { method: 'POST', body: { sessionId: sessionId, action: 'replace', lists: parsed.lists } })
            })
            .then(function (payload) {
              setSites(function (previous) {
                return Object.assign({}, previous, {
                  loading: false,
                  lists: payload.lists || previous.lists,
                  workspacePath: typeof payload.workspacePath === 'string' ? payload.workspacePath : previous.workspacePath,
                  seededPreset: '',
                  error: '',
                })
              })
              patchPresets({ busy: '', error: '', message: t('settings.presets.workspaceImported', { count: importedCount }) })
            })
            .catch(function (error) {
              patchPresets({ busy: '', message: '', error: t('settings.presets.importFailed', { message: errorText(error) }) })
            })
            .then(function () {
              try {
                if (input !== null && input !== undefined) input.value = ''
              } catch (error) {
                /* 忽略 */
              }
            })
        }

        function toggleExpandedList(level) {
          setExpandedLists(function (previous) {
            return Object.assign({}, previous, { [level]: previous[level] !== true })
          })
        }

        function setSiteInput(level, value) {
          setSiteInputs(function (previous) {
            return Object.assign({}, previous, { [level]: value })
          })
        }

        function closeLibrary() {
          setLibraryView(null)
        }

        function normalizeCompareUrl(value) {
          return String(value === undefined || value === null ? '' : value).trim()
        }

        function currentPageUrl() {
          if (active === undefined || active === null) return ''
          var url = normalizeCompareUrl(active.url)
          return /^https?:\/\//i.test(url) ? url : ''
        }

        function bookmarkOfUrl(url) {
          var target = normalizeCompareUrl(url)
          if (target === '') return null
          for (var index = 0; index < library.bookmarks.length; index += 1) {
            if (normalizeCompareUrl(library.bookmarks[index].url) === target) return library.bookmarks[index]
          }
          return null
        }

        function applyLibrarySnapshot(payload) {
          setLibrary({
            loaded: true,
            bookmarks: Array.isArray(payload.bookmarks) ? payload.bookmarks : [],
            history: Array.isArray(payload.history) ? payload.history : [],
            workspacePath: typeof payload.workspacePath === 'string' ? payload.workspacePath : '',
            error: '',
          })
        }

        function loadLibrary() {
          requestJson('/library?sessionId=' + encodeURIComponent(sessionId), { method: 'GET' })
            .then(function (payload) {
              applyLibrarySnapshot(payload)
            })
            .catch(function (error) {
              setLibrary(function (previous) {
                return Object.assign({}, previous, { loaded: true, error: errorText(error) })
              })
            })
        }

        function toggleBookmark() {
          var url = currentPageUrl()
          if (url === '') return
          var existing = bookmarkOfUrl(url)
          var body =
            existing === null
              ? { sessionId: sessionId, action: 'bookmark-add', title: active !== null && active.title !== undefined && active.title !== '' ? active.title : url, url: url }
              : { sessionId: sessionId, action: 'bookmark-remove', id: existing.id }
          requestJson('/library', { method: 'POST', body: body })
            .then(function (payload) {
              applyLibrarySnapshot(payload)
            })
            .catch(function (error) {
              notice(t('bookmark.failed') + '：' + errorText(error))
            })
        }

        function removeBookmark(entry) {
          if (entry === null || entry === undefined) return
          requestJson('/library', { method: 'POST', body: { sessionId: sessionId, action: 'bookmark-remove', id: entry.id } })
            .then(function (payload) {
              applyLibrarySnapshot(payload)
            })
            .catch(function (error) {
              setLibrary(function (previous) {
                return Object.assign({}, previous, { error: errorText(error) })
              })
            })
        }

        function clearHistory() {
          requestJson('/library', { method: 'POST', body: { sessionId: sessionId, action: 'history-clear' } })
            .then(function (payload) {
              applyLibrarySnapshot(payload)
            })
            .catch(function (error) {
              setLibrary(function (previous) {
                return Object.assign({}, previous, { error: errorText(error) })
              })
            })
        }

        /** 在当前窗口打开网址（没有窗口时新建一个），并收起浮层。 */
        function openInPage(url) {
          if (typeof url !== 'string' || url === '') return
          setLibraryView(null)
          setSettingsOpen(false)
          var env = envRef.current
          if (env === null || env.actions === undefined) return
          if (ui.activeId !== '') env.actions.navigate(url)
          else env.actions.createWindow(url)
        }

        function openLibrarySheet(mode) {
          setSettingsOpen(false)
          setLibraryView(mode)
          loadLibrary()
        }

        function openBookmarks() {
          openLibrarySheet('bookmarks')
        }

        function openHistory() {
          openLibrarySheet('history')
        }

        function formatVisitedAt(value) {
          var time = Number(value)
          if (!Number.isFinite(time) || time <= 0) return ''
          try {
            return new Date(time).toLocaleString()
          } catch (error) {
            return ''
          }
        }

        /** 收藏/历史浮层（内联在工具栏下方）。 */
        function librarySheet() {
          if (libraryView === null) return null
          var bookmarksMode = libraryView === 'bookmarks'
          var rows = bookmarksMode
            ? library.bookmarks.map(function (entry) {
                return { id: entry.id, title: entry.title || entry.url, url: entry.url, time: '', entry: entry }
              })
            : library.history
                .slice()
                .sort(function (a, b) {
                  return (Number(b.visitedAt) || 0) - (Number(a.visitedAt) || 0)
                })
                .map(function (entry) {
                  return { id: entry.id, title: entry.title || entry.url, url: entry.url, time: formatVisitedAt(entry.visitedAt), entry: entry }
                })
          var pageUrl = currentPageUrl()
          var bookmarked = bookmarkOfUrl(pageUrl) !== null
          return h(
            'div',
            { className: 'dsh-ab-sheet dsh-ab-sites dsh-ab-library' },
            h(
              'div',
              { className: 'dsh-ab-sheet-head' },
              h('span', { className: 'dsh-ab-sheet-title' }, bookmarksMode ? t('bookmark.title') : t('history.title')),
              h(
                'div',
                { className: 'dsh-ab-lib-head-actions' },
                bookmarksMode
                  ? null
                  : h(
                      'button',
                      {
                        type: 'button',
                        className: 'dsh-ab-lib-clear',
                        disabled: library.history.length === 0,
                        onClick: clearHistory,
                      },
                      t('history.clear'),
                    ),
                h('button', { type: 'button', className: 'dsh-ab-dl-icon-btn', title: t('downloads.close'), onClick: closeLibrary }, icon(ICONS.close, 14)),
              ),
            ),
            h('div', { className: 'dsh-ab-sheet-desc' }, bookmarksMode ? t('bookmark.hint') : t('history.hint')),
            bookmarksMode
              ? h(
                  'button',
                  {
                    type: 'button',
                    className: 'dsh-ab-btn dsh-ab-bookmark-current',
                    disabled: pageUrl === '',
                    onClick: toggleBookmark,
                  },
                  h('span', { className: 'dsh-ab-bookmark-current-icon' }, bookmarked ? iconFilled(ICONS.star, 14) : icon(ICONS.star, 14)),
                  h('span', null, bookmarked ? t('bookmark.remove') : t('bookmark.add')),
                )
              : null,
            library.error !== '' ? h('div', { className: 'dsh-ab-dl-error' }, library.error) : null,
            rows.length === 0
              ? h('div', { className: 'dsh-ab-dl-empty' }, bookmarksMode ? t('bookmark.empty') : t('history.empty'))
              : h(
                  'div',
                  { className: 'dsh-ab-lib-list' },
                  rows.map(function (row) {
                    return h(
                      'div',
                      { key: row.id, className: 'dsh-ab-lib-row' },
                      h(
                        'button',
                        {
                          type: 'button',
                          className: 'dsh-ab-lib-main',
                          title: row.url,
                          onClick: function () {
                            openInPage(row.url)
                          },
                        },
                        h('span', { className: 'dsh-ab-lib-title' }, row.title),
                        h('span', { className: 'dsh-ab-lib-url' }, row.url),
                        row.time === '' ? null : h('span', { className: 'dsh-ab-lib-time' }, row.time),
                      ),
                      bookmarksMode
                        ? h(
                            'button',
                            { type: 'button', className: 'dsh-ab-dl-icon-btn', title: t('bookmark.delete'), onClick: function () { removeBookmark(row.entry) } },
                            icon(ICONS.trash, 13),
                          )
                        : null,
                    )
                  }),
                ),
          )
        }

        /**
         * 面板设置顶部的「权限预设」区：搜索、列出预设、标记默认、一键应用、
         * 导出预设；以及把当前工作区名单「存为预设 / 导出 / 导入」。
         * 搜索只过滤列表，不影响选中与应用。
         */
        function presetSection() {
          var defaultPreset = null
          for (var index = 0; index < presets.list.length; index += 1) {
            if (presets.list[index].id === presets.defaultPresetId) defaultPreset = presets.list[index]
          }
          var query = presetQuery.trim().toLowerCase()
          var visiblePresets =
            query === ''
              ? presets.list
              : presets.list.filter(function (preset) {
                  return String(preset.name === undefined || preset.name === null ? '' : preset.name)
                    .toLowerCase()
                    .indexOf(query) >= 0
                })
          var listBody
          if (presets.loading) listBody = h('div', { className: 'dsh-ab-sites-empty' }, t('panel.loading'))
          else if (presets.list.length === 0) listBody = h('div', { className: 'dsh-ab-sites-empty' }, t('settings.presets.empty'))
          else if (visiblePresets.length === 0) listBody = h('div', { className: 'dsh-ab-sites-empty' }, t('settings.presets.searchEmpty'))
          else
            listBody = visiblePresets.map(function (preset) {
              var isDefault = preset.id === presets.defaultPresetId
              return h(
                'div',
                { key: preset.id, className: 'dsh-ab-preset-row' },
                h(
                  'div',
                  { className: 'dsh-ab-preset-main' },
                  h('span', { className: 'dsh-ab-preset-name', title: preset.name }, preset.name),
                  isDefault ? h('span', { className: 'dsh-ab-preset-badge' }, t('settings.presets.isDefault')) : null,
                ),
                h(
                  'button',
                  { type: 'button', className: 'dsh-ab-btn dsh-ab-preset-apply', title: t('settings.presets.export'), onClick: function () { exportPresetToFile(preset) } },
                  t('settings.presets.export'),
                ),
                h(
                  'button',
                  {
                    type: 'button',
                    className: 'dsh-ab-btn dsh-ab-preset-apply',
                    disabled: presets.busy !== '',
                    onClick: function () {
                      applyPreset(preset)
                    },
                  },
                  presets.busy === preset.id ? t('panel.loading') : t('settings.presets.apply'),
                ),
              )
            })
          return h(
            'div',
            { className: 'dsh-ab-sites-section dsh-ab-presets' },
            h(
              'div',
              { className: 'dsh-ab-sites-head dsh-ab-presets-head' },
              h('span', null, t('settings.presets')),
              h(
                'span',
                { className: 'dsh-ab-presets-default', title: defaultPreset === null ? t('settings.presets.noDefault') : defaultPreset.name },
                defaultPreset === null ? t('settings.presets.noDefault') : t('settings.presets.defaultName', { name: defaultPreset.name }),
              ),
            ),
            h(
              'div',
              { className: 'dsh-ab-presets-search' },
              h('input', {
                type: 'search',
                className: 'dsh-ab-sites-input',
                value: presetQuery,
                placeholder: t('settings.presets.search'),
                'aria-label': t('settings.presets.search'),
                spellCheck: false,
                onChange: function (event) {
                  setPresetQuery(event.target.value)
                },
              }),
              presetQuery !== ''
                ? h(
                    'button',
                    { type: 'button', className: 'dsh-ab-lib-clear', title: t('settings.presets.searchClear'), onClick: function () { setPresetQuery('') } },
                    '×',
                  )
                : null,
            ),
            presets.error !== '' ? h('div', { className: 'dsh-ab-dl-error' }, presets.error) : null,
            presets.message !== '' ? h('div', { className: 'dsh-ab-foot-note' }, presets.message) : null,
            listBody,
            h(
              'div',
              { className: 'dsh-ab-presets-save' },
              h('input', {
                type: 'text',
                className: 'dsh-ab-sites-input',
                value: presetSaveName,
                placeholder: t('settings.presets.saveNamePlaceholder'),
                'aria-label': t('settings.presets.saveNamePlaceholder'),
                spellCheck: false,
                onChange: function (event) {
                  setPresetSaveName(event.target.value)
                },
                onKeyDown: function (event) {
                  if (event.key !== 'Enter') return
                  event.preventDefault()
                  saveWorkspaceAsPreset()
                },
              }),
              h(
                'button',
                { type: 'button', className: 'dsh-ab-btn', disabled: presets.busy !== '' || sites.loading, onClick: saveWorkspaceAsPreset },
                presets.busy === 'save' ? t('panel.loading') : t('settings.presets.save'),
              ),
            ),
            h(
              'div',
              { className: 'dsh-ab-presets-actions' },
              h('button', { type: 'button', className: 'dsh-ab-btn', disabled: sites.loading, onClick: exportWorkspaceToFile }, t('settings.presets.exportWorkspace')),
              h(
                'button',
                {
                  type: 'button',
                  className: 'dsh-ab-btn',
                  disabled: sites.loading || presets.busy !== '',
                  onClick: function () {
                    if (workspaceImportRef.current !== null && workspaceImportRef.current !== undefined) workspaceImportRef.current.click()
                  },
                },
                t('settings.presets.importWorkspace'),
              ),
              h('input', { type: 'file', accept: '.txt,text/plain', style: { display: 'none' }, ref: workspaceImportRef, onChange: importWorkspaceFile }),
            ),
          )
        }

        function settingsSheet() {
          if (!settingsOpen) return null
          return h(
            'div',
            { className: 'dsh-ab-sheet dsh-ab-sites' },
            h(
              'div',
              { className: 'dsh-ab-sheet-head' },
              h('span', { className: 'dsh-ab-sheet-title' }, t('settings.title')),
              h(
                'button',
                { type: 'button', className: 'dsh-ab-dl-icon-btn', title: t('downloads.close'), onClick: function () { setSettingsOpen(false) } },
                icon(ICONS.close, 14),
              ),
            ),
            presetSection(),
            sites.workspacePath !== '' ? h('div', { className: 'dsh-ab-dl-status' }, t('settings.workspace') + '：' + sites.workspacePath) : null,
            sites.seededPreset !== '' ? h('div', { className: 'dsh-ab-seeded-note' }, t('settings.presets.seeded', { name: sites.seededPreset })) : null,
            h('div', { className: 'dsh-ab-sheet-desc' }, t('settings.hint')),
            sites.error !== '' ? h('div', { className: 'dsh-ab-dl-error' }, sites.error) : null,
            LEVELS.map(function (level) {
              var entries = sites.lists[level] || []
              return h(
                'div',
                { key: level, className: 'dsh-ab-sites-section' },
                h('div', { className: 'dsh-ab-sites-head' }, t('perm.' + level)),
                entries.length === 0
                  ? h('div', { className: 'dsh-ab-sites-empty' }, t('settings.empty'))
                  : (expandedLists[level] === true ? entries : entries.slice(0, 3)).map(function (entry) {
                      return h(
                        'div',
                        { key: entry.host, className: 'dsh-ab-sites-row' },
                        h('span', { className: 'dsh-ab-sites-host', title: entry.host }, entry.host),
                        h(
                          'label',
                          { className: 'dsh-ab-sites-toggle', title: t('settings.noAuth') },
                          h('input', {
                            type: 'checkbox',
                            checked: entry.noAuth === true,
                            onChange: function () {
                              saveSite(level, entry.host, entry.noAuth !== true)
                            },
                          }),
                          h('span', null, t('settings.noAuth')),
                        ),
                        h(
                          'button',
                          { type: 'button', className: 'dsh-ab-dl-icon-btn', title: t('settings.delete'), onClick: function () { removeSite(entry.host) } },
                          icon(ICONS.close, 12),
                        ),
                      )
                    }),
                entries.length > 3
                  ? h(
                      'button',
                      {
                        type: 'button',
                        className: 'dsh-ab-dl-more',
                        onClick: function () {
                          toggleExpandedList(level)
                        },
                      },
                      expandedLists[level] === true ? t('settings.less') : t('settings.more', { count: entries.length }),
                    )
                  : null,
                h(
                  'div',
                  { className: 'dsh-ab-sites-add' },
                  h('input', {
                    type: 'text',
                    className: 'dsh-ab-sites-input',
                    value: siteInputs[level] || '',
                    placeholder: t('settings.placeholder'),
                    spellCheck: false,
                    onChange: function (event) {
                      var value = event.target.value
                      setSiteInputs(function (previous) {
                        return Object.assign({}, previous, { [level]: value })
                      })
                    },
                    onKeyDown: function (event) {
                      if (event.key !== 'Enter') return
                      event.preventDefault()
                      var value = (siteInputs[level] || '').trim()
                      if (value === '') return
                      saveSite(level, value, false)
                      setSiteInputs(function (previous) {
                        return Object.assign({}, previous, { [level]: '' })
                      })
                    },
                  }),
                  h(
                    'button',
                    {
                      type: 'button',
                      className: 'dsh-ab-btn',
                      onClick: function () {
                        var value = (siteInputs[level] || '').trim()
                        if (value === '') return
                        saveSite(level, value, false)
                        setSiteInputs(function (previous) {
                          return Object.assign({}, previous, { [level]: '' })
                        })
                      },
                    },
                    t('settings.add'),
                  ),
                ),
              )
            }),
          )
        }

        function permissionButton() {
          return h(
            'button',
            {
              type: 'button',
              className: 'dsh-ab-perm-btn',
              title: t('perm.current', { name: t('perm.' + activeLevel) }),
              onClick: function (event) {
                event.stopPropagation()
                if (ui.activeId === '') return
                setSettingsOpen(false)
                setLibraryView(null)
                if (UI.state.menu !== null) {
                  uiSet({ menu: null })
                  return
                }
                var env = envRef.current
                var windowTitle = env !== null && env.actions !== undefined ? env.actions.windowTitle(ui.activeId) : ''
                uiSet({
                  menu: {
                    sessionId: sessionId,
                    windowId: ui.activeId,
                    level: activeLevel,
                    windowLabel: t('perm.window', { name: windowTitle || ui.activeId }),
                  },
                  warning: null,
                  downloads: null,
                  error: null,
                })
              },
            },
            h('span', { className: 'dsh-ab-perm-btn-icon', 'aria-hidden': true }, icon(ICONS.shield, 14)),
            h('span', { className: 'dsh-ab-perm-btn-label' }, t('perm.' + activeLevel)),
          )
        }

        function bookmarkButton() {
          var pageUrl = currentPageUrl()
          var bookmarked = bookmarkOfUrl(pageUrl) !== null
          return h(
            'button',
            {
              type: 'button',
              className: 'dsh-ab-tool dsh-ab-tool-bookmark' + (bookmarked ? ' is-bookmarked' : ''),
              title: bookmarked ? t('panel.bookmarked') : t('panel.bookmark'),
              disabled: pageUrl === '',
              onClick: toggleBookmark,
            },
            bookmarked ? iconFilled(ICONS.star, 16) : icon(ICONS.star, 16),
          )
        }

        function bookmarkCaret() {
          return h(
            'button',
            { type: 'button', className: 'dsh-ab-tool dsh-ab-tool-caret', title: t('bookmark.openList'), onClick: openBookmarks },
            icon(ICONS.caret, 12),
          )
        }

        function historyButton() {
          return h('button', { type: 'button', className: 'dsh-ab-tool', title: t('panel.history'), onClick: openHistory }, icon(ICONS.history, 16))
        }

        return h(
          'div',
          { className: 'dsh-ab-root' },
          h(
            'div',
            { className: 'dsh-ab-tabs' },
            ui.windows.map(function (window) {
              return h(
                'div',
                { key: window.id, className: 'dsh-ab-tab' + (window.id === ui.activeId ? ' is-active' : '') },
                h(
                  'button',
                  { type: 'button', className: 'dsh-ab-tab-main', title: window.url || window.id, onClick: function () { envRef.current.actions.setActive(window.id) } },
                  window.title || window.url || t('panel.window', { n: window.id.slice(1) }),
                ),
                h(
                  'button',
                  {
                    type: 'button',
                    className: 'dsh-ab-tab-close',
                    title: t('panel.closeWindow'),
                    onClick: function (event) {
                      event.stopPropagation()
                      envRef.current.actions.closeWindowById(window.id)
                    },
                  },
                  icon(ICONS.close, 12),
                ),
              )
            }),
            h(
              'button',
              { type: 'button', className: 'dsh-ab-tab-new', title: t('panel.newWindow'), onClick: function () { envRef.current.actions.createWindow('') } },
              icon(ICONS.plus, 14),
            ),
          ),
          h(
            'div',
            { className: 'dsh-ab-toolbar' },
            h('button', { type: 'button', className: 'dsh-ab-tool', title: t('panel.back'), disabled: !active || !active.canGoBack, onClick: function () { envRef.current.actions.back() } }, icon(ICONS.back, 16)),
            h('button', { type: 'button', className: 'dsh-ab-tool', title: t('panel.forward'), disabled: !active || !active.canGoForward, onClick: function () { envRef.current.actions.forward() } }, icon(ICONS.forward, 16)),
            h('button', { type: 'button', className: 'dsh-ab-tool' + (active && active.loading ? ' is-spinning' : ''), title: t('panel.reload'), onClick: function () { envRef.current.actions.reload() } }, icon(ICONS.reload, 16)),
            permissionButton(),
            h(
              'div',
              { className: 'dsh-ab-address' },
              h('input', {
                type: 'text',
                className: 'dsh-ab-address-input',
                value: ui.address,
                placeholder: t('panel.addressPlaceholder'),
                spellCheck: false,
                onChange: function (event) {
                  editingRef.current = true
                  patch({ address: event.target.value })
                },
                onKeyDown: function (event) {
                  if (event.key !== 'Enter') return
                  event.preventDefault()
                  editingRef.current = false
                  envRef.current.actions.navigate(ui.address)
                },
                onBlur: function () {
                  editingRef.current = false
                  patch({ address: active ? active.url : '' })
                },
              }),
            ),
            bookmarkButton(),
            bookmarkCaret(),
            h('button', { type: 'button', className: 'dsh-ab-tool dsh-ab-tool-download', title: t('panel.downloads'), onClick: openDownloads }, icon(ICONS.download, 16)),
            historyButton(),
            h('button', { type: 'button', className: 'dsh-ab-tool', title: t('panel.settings'), onClick: openSettings }, icon(ICONS.settings, 16)),
          ),
          settingsOpen ? settingsSheet() : null,
          libraryView !== null ? librarySheet() : null,
          uiSheets.downloads !== null ? h(DownloadsPopup, { t: t, sessionId: sessionId }) : null,
          uiSheets.warning !== null ? warningSheet() : null,
          uiSheets.menu !== null && uiSheets.warning === null ? permissionSheet() : null,
          h(
            'div',
            {
              className: 'dsh-ab-viewport',
              ref: function (node) {
                if (node === null) return
                var env = envRef.current
                if (env === null) return
                env.windows.forEach(function (window) {
                  var host = containerRefs.current[window.id]
                  if (host !== undefined && host !== null && window.webview !== null && window.webview.parentNode !== host) host.appendChild(window.webview)
                })
              },
            },
            ui.windows.map(function (window) {
              return h('div', {
                key: window.id,
                className: 'dsh-ab-window',
                style: { display: window.id === ui.activeId ? 'flex' : 'none' },
                ref: function (node) {
                  if (node === null) return
                  containerRefs.current[window.id] = node
                  var env = envRef.current
                  if (env === null) return
                  var live = env.windows.get(window.id)
                  if (live !== undefined && live.webview !== null && live.webview.parentNode !== node) node.appendChild(live.webview)
                },
              })
            }),
          ),
          ui.status === 'starting' ? h('div', { className: 'dsh-ab-notice' }, h('div', { className: 'dsh-ab-spinner' }), h('div', null, t('panel.starting'))) : null,
          ui.status === 'unsupported' ? h('div', { className: 'dsh-ab-notice' }, h('div', { className: 'dsh-ab-notice-text' }, t('panel.unsupported'))) : null,
          ui.status === 'failed' ? h('div', { className: 'dsh-ab-notice' }, h('div', { className: 'dsh-ab-notice-text' }, t('panel.failed') + '：' + ui.error)) : null,
          ui.windows.length === 0 && ui.status === 'ready'
            ? h(
                'div',
                { className: 'dsh-ab-empty' },
                h('div', { className: 'dsh-ab-empty-text' }, t('panel.empty')),
                h('button', { type: 'button', className: 'dsh-ab-btn', onClick: function () { envRef.current.actions.createWindow('') } }, t('panel.newWindow')),
              )
            : null,
          ui.notice !== '' ? h('div', { className: 'dsh-ab-toast' }, ui.notice) : null,
        )
      }

      // ------------------------------------------------------------------
      // Harness 设置页：AI 浏览器（黑白简笔画地球主视觉 + 权限预设管理）
      // ------------------------------------------------------------------
      function SettingsPage(props) {
        var t = getT(props)
        var [loading, setLoading] = React.useState(true)
        var [presetList, setPresetList] = React.useState([])
        var [defaultPresetId, setDefaultPresetId] = React.useState('')
        var [selectedId, setSelectedId] = React.useState('')
        var [error, setError] = React.useState('')
        var [message, setMessage] = React.useState('')
        var [busy, setBusy] = React.useState('')
        var [createName, setCreateName] = React.useState('')
        var [createBase, setCreateBase] = React.useState('empty')
        var [renaming, setRenaming] = React.useState(false)
        var [renameDraft, setRenameDraft] = React.useState('')
        var [editingId, setEditingId] = React.useState('')
        var [confirmDeleteId, setConfirmDeleteId] = React.useState('')
        var [expanded, setExpanded] = React.useState({ view: false, simple: false, review: false, full: false })
        var [inputs, setInputs] = React.useState({ view: '', simple: '', review: '', full: '' })
        /** 预设列表搜索词（只过滤列表，不影响选中与编辑区域）。 */
        var [presetQuery, setPresetQuery] = React.useState('')
        /** 「导入预设」用的隐藏文件选择框。 */
        var presetImportRef = React.useRef(null)

        function pickSelected(list, wantedDefault) {
          return function (previous) {
            if (previous !== '' && list.some(function (preset) { return preset.id === previous })) return previous
            if (wantedDefault !== '' && list.some(function (preset) { return preset.id === wantedDefault })) return wantedDefault
            return list.length > 0 ? list[0].id : ''
          }
        }

        function applySnapshot(payload) {
          var list = Array.isArray(payload.presets) ? payload.presets : []
          var nextDefault = typeof payload.defaultPresetId === 'string' ? payload.defaultPresetId : ''
          setPresetList(list)
          setDefaultPresetId(nextDefault)
          setSelectedId(pickSelected(list, nextDefault))
        }

        function loadPresets() {
          setLoading(true)
          setError('')
          requestJson('/presets', { method: 'GET' })
            .then(function (payload) {
              applySnapshot(payload)
              setLoading(false)
            })
            .catch(function (err) {
              setError(errorText(err))
              setLoading(false)
            })
        }

        React.useEffect(function () {
          loadPresets()
          return undefined
        }, [])

        function findPreset(id) {
          for (var index = 0; index < presetList.length; index += 1) {
            if (presetList[index].id === id) return presetList[index]
          }
          return null
        }

        function cloneLists(lists) {
          var result = {}
          for (var index = 0; index < LEVELS.length; index += 1) {
            var level = LEVELS[index]
            var entries = lists !== null && lists !== undefined && typeof lists === 'object' && Array.isArray(lists[level]) ? lists[level] : []
            result[level] = entries
              .map(function (entry) {
                var item = entry !== null && typeof entry === 'object' ? entry : {}
                return { raw: String(item.raw || item.host || ''), noAuth: item.noAuth === true }
              })
              .filter(function (entry) {
                return entry.raw !== ''
              })
          }
          return result
        }

        function postPreset(body, done) {
          if (busy !== '') return
          setBusy('action')
          setError('')
          setMessage('')
          requestJson('/presets', { method: 'POST', body: body })
            .then(function (payload) {
              applySnapshot(payload)
              setBusy('')
              if (typeof done === 'function') done(payload)
            })
            .catch(function (err) {
              setBusy('')
              setError(errorText(err))
            })
        }

        function createPreset() {
          var name = createName.trim()
          if (name === '' || busy !== '') return
          var base = createBase === 'empty' ? null : findPreset(createBase)
          var lists = base === null ? undefined : cloneLists(base.lists)
          postPreset({ action: 'create', name: name, lists: lists }, function (payload) {
            var created = payload !== null && payload !== undefined ? payload.preset : undefined
            if (created !== undefined && created !== null && typeof created.id === 'string') setSelectedId(created.id)
            setCreateName('')
            setCreateBase('empty')
            setMessage(t('settingsPage.created', { name: name }))
          })
        }

        function setDefaultPreset(preset) {
          if (preset === null || preset === undefined || busy !== '') return
          postPreset({ action: 'set-default', id: preset.id }, function () {
            setMessage(t('settingsPage.adopted'))
          })
        }

        function startRename(preset) {
          if (preset === null || preset === undefined) return
          setSelectedId(preset.id)
          setRenaming(true)
          setRenameDraft(preset.name)
          setEditingId('')
          setConfirmDeleteId('')
        }

        function saveRename() {
          var preset = findPreset(selectedId)
          if (preset === null || busy !== '') return
          var name = renameDraft.trim()
          if (name === '' || name === preset.name) {
            setRenaming(false)
            return
          }
          postPreset({ action: 'update', id: preset.id, name: name }, function () {
            setRenaming(false)
            setMessage(t('settingsPage.saved'))
          })
        }

        function deletePreset(preset) {
          if (preset === null || preset === undefined || busy !== '') return
          postPreset({ action: 'delete', id: preset.id }, function () {
            setEditingId('')
            setConfirmDeleteId('')
            setRenaming(false)
            setMessage(t('settingsPage.saved'))
          })
        }

        /** 导出单个预设为 txt（纯客户端 Blob 下载）。 */
        function exportPresetToFile(preset) {
          if (preset === null || preset === undefined) return
          try {
            triggerTextDownload(presetTextFileName(preset.name, 'preset'), serializePresetText(preset.name, preset.lists))
            setError('')
            setMessage(t('settings.presets.exported', { name: preset.name }))
          } catch (err) {
            setMessage('')
            setError(t('settings.presets.exportFailed', { message: errorText(err) }))
          }
        }

        /** 选 txt 文件后解析并创建新预设（名字取文件里的 `# name:`，否则用「导入的预设」）。 */
        function importPresetFile(event) {
          var input = event !== null && event !== undefined ? event.target : null
          var file = null
          try {
            file = input !== null && input !== undefined && input.files !== undefined && input.files !== null ? input.files[0] : null
          } catch (err) {
            file = null
          }
          if (file === null || file === undefined) return
          if (busy !== '') {
            try {
              input.value = ''
            } catch (err) {
              /* 忽略 */
            }
            return
          }
          setError('')
          setMessage('')
          readTextFile(file)
            .then(function (text) {
              var parsed = parsePresetText(text)
              if (parsed === null) throw new Error(t('settings.presets.importInvalid'))
              var name = parsed.name !== '' ? parsed.name : t('settingsPage.importedName')
              postPreset({ action: 'create', name: name, lists: parsed.lists }, function () {
                setMessage(t('settingsPage.imported', { name: name }))
              })
            })
            .catch(function (err) {
              setError(t('settings.presets.importFailed', { message: errorText(err) }))
            })
            .then(function () {
              try {
                if (input !== null && input !== undefined) input.value = ''
              } catch (err) {
                /* 忽略 */
              }
            })
        }

        function updatePresetLists(preset, mutate) {
          if (preset === null || preset === undefined || busy !== '') return
          var lists = cloneLists(preset.lists)
          mutate(lists)
          postPreset({ action: 'update', id: preset.id, lists: lists }, function () {
            setMessage(t('settingsPage.saved'))
          })
        }

        function setLevelInput(level, value) {
          setInputs(function (previous) {
            return Object.assign({}, previous, { [level]: value })
          })
        }

        function toggleExpanded(level) {
          setExpanded(function (previous) {
            return Object.assign({}, previous, { [level]: previous[level] !== true })
          })
        }

        var selected = findPreset(selectedId)
        var defaultPreset = findPreset(defaultPresetId)
        var presetFilter = presetQuery.trim().toLowerCase()
        var visiblePresets =
          presetFilter === ''
            ? presetList
            : presetList.filter(function (preset) {
                return String(preset.name === undefined || preset.name === null ? '' : preset.name)
                  .toLowerCase()
                  .indexOf(presetFilter) >= 0
              })
        var presetRows = visiblePresets.map(function (preset) {
          var isDefault = preset.id === defaultPresetId
          var isSelected = preset.id === selectedId
          var isEditing = editingId === preset.id
          var isRenaming = renaming && isSelected
          var isConfirming = confirmDeleteId === preset.id
          return h(
            'div',
            { key: preset.id, className: 'dsh-ab-set-preset' + (isSelected ? ' is-selected' : '') },
            isRenaming
              ? h(
                  'div',
                  { className: 'dsh-ab-set-rename' },
                  h('input', {
                    type: 'text',
                    className: 'dsh-ab-set-name-input',
                    value: renameDraft,
                    placeholder: t('settingsPage.namePlaceholder'),
                    spellCheck: false,
                    autoFocus: true,
                    onChange: function (event) {
                      setRenameDraft(event.target.value)
                    },
                    onKeyDown: function (event) {
                      if (event.key === 'Enter') {
                        event.preventDefault()
                        saveRename()
                      } else if (event.key === 'Escape') {
                        event.preventDefault()
                        setRenaming(false)
                      }
                    },
                  }),
                  h('button', { type: 'button', className: 'dsh-ab-set-action', disabled: busy !== '', onClick: saveRename }, t('settingsPage.renameSave')),
                  h('button', { type: 'button', className: 'dsh-ab-set-action', onClick: function () { setRenaming(false) } }, t('settingsPage.renameCancel')),
                )
              : h(
                  'div',
                  { className: 'dsh-ab-set-preset-head' },
                  h(
                    'button',
                    {
                      type: 'button',
                      className: 'dsh-ab-set-preset-pick',
                      title: preset.name,
                      onClick: function () {
                        setSelectedId(preset.id)
                      },
                    },
                    preset.name,
                  ),
                  isDefault ? h('span', { className: 'dsh-ab-set-badge' }, t('settingsPage.defaultBadge')) : null,
                  h(
                    'div',
                    { className: 'dsh-ab-set-preset-row-actions' },
                    h(
                      'button',
                      {
                        type: 'button',
                        className: 'dsh-ab-set-action',
                        disabled: isDefault || busy !== '',
                        onClick: function () {
                          setDefaultPreset(preset)
                        },
                      },
                      t('settingsPage.setDefault'),
                    ),
                    h(
                      'button',
                      { type: 'button', className: 'dsh-ab-set-action', disabled: busy !== '', onClick: function () { startRename(preset) } },
                      t('settingsPage.rename'),
                    ),
                    h(
                      'button',
                      {
                        type: 'button',
                        className: 'dsh-ab-set-action',
                        disabled: busy !== '',
                        onClick: function () {
                          setSelectedId(preset.id)
                          setEditingId(isEditing ? '' : preset.id)
                          setConfirmDeleteId('')
                        },
                      },
                      isEditing ? t('settingsPage.hideLists') : t('settingsPage.editLists'),
                    ),
                    h(
                      'button',
                      { type: 'button', className: 'dsh-ab-set-action', onClick: function () { exportPresetToFile(preset) } },
                      t('settingsPage.export'),
                    ),
                    h(
                      'button',
                      {
                        type: 'button',
                        className: 'dsh-ab-set-action is-danger',
                        disabled: busy !== '',
                        onClick: function () {
                          setSelectedId(preset.id)
                          setConfirmDeleteId(isConfirming ? '' : preset.id)
                        },
                      },
                      t('settingsPage.delete'),
                    ),
                  ),
                ),
            isConfirming
              ? h(
                  'div',
                  { className: 'dsh-ab-set-confirm' },
                  h('span', null, t('settingsPage.deleteConfirm', { name: preset.name })),
                  h('button', { type: 'button', className: 'dsh-ab-set-action is-danger', disabled: busy !== '', onClick: function () { deletePreset(preset) } }, t('settingsPage.deleteYes')),
                  h('button', { type: 'button', className: 'dsh-ab-set-action', onClick: function () { setConfirmDeleteId('') } }, t('settingsPage.cancel')),
                )
              : null,
            isEditing
              ? h(
                  'div',
                  { className: 'dsh-ab-set-editor' },
                  SiteListSections({
                    t: t,
                    lists: preset.lists || {},
                    inputs: inputs,
                    expanded: expanded,
                    labelOf: function (entry) {
                      return String((entry && (entry.raw || entry.host)) || '')
                    },
                    keyOf: function (entry) {
                      return String((entry && (entry.raw || entry.host)) || '')
                    },
                    emptyText: t('settings.empty'),
                    onInput: setLevelInput,
                    onToggleExpand: toggleExpanded,
                    onAdd: function (level, value) {
                      if (value === '') return
                      updatePresetLists(preset, function (lists) {
                        lists[level].push({ raw: value, noAuth: false })
                      })
                      setLevelInput(level, '')
                    },
                    onToggleNoAuth: function (level, entry) {
                      updatePresetLists(preset, function (lists) {
                        lists[level] = lists[level].map(function (item) {
                          if (item.raw !== entry.raw) return item
                          return { raw: item.raw, noAuth: item.noAuth !== true }
                        })
                      })
                    },
                    onRemove: function (level, entry) {
                      updatePresetLists(preset, function (lists) {
                        lists[level] = lists[level].filter(function (item) {
                          return item.raw !== entry.raw
                        })
                      })
                    },
                  }),
                )
              : null,
          )
        })

        return h(
          'div',
          { className: 'dsh-ab-set' },
          h(
            'div',
            { className: 'dsh-ab-set-hero' },
            h('div', { className: 'dsh-ab-set-earth' }, h(EarthGlyph, { size: 88 })),
            h(
              'div',
              { className: 'dsh-ab-set-hero-text' },
              h('div', { className: 'dsh-ab-set-title' }, t('settingsPage.title')),
              h('div', { className: 'dsh-ab-set-desc' }, t('settingsPage.intro')),
            ),
          ),
          h(
            'div',
            { className: 'dsh-ab-set-hints' },
            h('div', { className: 'dsh-ab-set-hint' }, t('settingsPage.autoApply')),
            h('div', { className: 'dsh-ab-set-hint' }, t('settingsPage.applyHint')),
          ),
          h(
            'div',
            { className: 'dsh-ab-set-section' },
            h(
              'div',
              { className: 'dsh-ab-set-section-head' },
              h('span', { className: 'dsh-ab-set-section-title' }, t('settingsPage.presets')),
              h(
                'span',
                { className: 'dsh-ab-set-default' },
                defaultPreset === null ? t('settingsPage.noDefault') : t('settingsPage.defaultPreset', { name: defaultPreset.name }),
              ),
            ),
            error !== '' ? h('div', { className: 'dsh-ab-set-error' }, error) : null,
            message !== '' ? h('div', { className: 'dsh-ab-set-message' }, message) : null,
            h(
              'div',
              { className: 'dsh-ab-set-search' },
              h('input', {
                type: 'search',
                className: 'dsh-ab-set-name-input',
                value: presetQuery,
                placeholder: t('settings.presets.search'),
                'aria-label': t('settings.presets.search'),
                spellCheck: false,
                onChange: function (event) {
                  setPresetQuery(event.target.value)
                },
              }),
              presetQuery !== ''
                ? h('button', { type: 'button', className: 'dsh-ab-set-action', onClick: function () { setPresetQuery('') } }, t('settings.presets.searchClear'))
                : null,
            ),
            h(
              'div',
              { className: 'dsh-ab-set-create' },
              h('input', {
                type: 'text',
                className: 'dsh-ab-set-name-input',
                value: createName,
                placeholder: t('settingsPage.namePlaceholder'),
                spellCheck: false,
                onChange: function (event) {
                  setCreateName(event.target.value)
                },
                onKeyDown: function (event) {
                  if (event.key !== 'Enter') return
                  event.preventDefault()
                  createPreset()
                },
              }),
              h(
                'div',
                { className: 'dsh-ab-set-base' },
                h(
                  'button',
                  {
                    type: 'button',
                    className: 'dsh-ab-set-chip' + (createBase === 'empty' ? ' is-active' : ''),
                    onClick: function () {
                      setCreateBase('empty')
                    },
                  },
                  t('settingsPage.baseEmpty'),
                ),
                h(
                  'button',
                  {
                    type: 'button',
                    className: 'dsh-ab-set-chip' + (createBase !== 'empty' ? ' is-active' : ''),
                    disabled: selected === null,
                    onClick: function () {
                      if (selected !== null) setCreateBase(selected.id)
                    },
                  },
                  t('settingsPage.baseSelected'),
                ),
              ),
              h(
                'button',
                {
                  type: 'button',
                  className: 'dsh-ab-btn dsh-ab-btn-primary',
                  disabled: busy !== '' || createName.trim() === '',
                  onClick: createPreset,
                },
                t('settingsPage.create'),
              ),
              h(
                'button',
                {
                  type: 'button',
                  className: 'dsh-ab-btn',
                  disabled: busy !== '',
                  onClick: function () {
                    if (presetImportRef.current !== null && presetImportRef.current !== undefined) presetImportRef.current.click()
                  },
                },
                t('settingsPage.import'),
              ),
              h('input', { type: 'file', accept: '.txt,text/plain', style: { display: 'none' }, ref: presetImportRef, onChange: importPresetFile }),
            ),
            loading
              ? h('div', { className: 'dsh-ab-set-loading' }, t('panel.loading'))
              : presetList.length === 0
                ? h('div', { className: 'dsh-ab-set-empty' }, t('settingsPage.empty'))
                : visiblePresets.length === 0
                  ? h('div', { className: 'dsh-ab-set-empty' }, t('settings.presets.searchEmpty'))
                  : h('div', { className: 'dsh-ab-set-list' }, presetRows),
          ),
        )
      }

      // ------------------------------------------------------------------
      // 样式
      // ------------------------------------------------------------------
      var CSS = `
.dsh-ab-root{display:flex;flex-direction:column;height:100%;min-height:0;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);position:relative}
.dsh-ab-tabs{display:flex;align-items:center;gap:2px;height:34px;padding:3px 6px 0;border-bottom:.5px solid var(--dsw-alias-border-l3);flex:none;overflow-x:auto}
.dsh-ab-tab{display:flex;align-items:center;max-width:180px;min-width:60px;height:28px;border-radius:var(--dsw-radius-sm) var(--dsw-radius-sm) 0 0;background:transparent}
.dsh-ab-tab.is-active{background:var(--dsw-alias-bg-layer-1);border:.5px solid var(--dsw-alias-border-l2);border-bottom-color:transparent}
.dsh-ab-tab-main{flex:1;min-width:0;height:100%;padding:0 6px;border:0;background:transparent;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px;text-align:left;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;cursor:pointer}
.dsh-ab-tab.is-active .dsh-ab-tab-main{color:var(--dsw-alias-label-primary)}
.dsh-ab-tab-close{width:20px;height:20px;border:0;background:transparent;color:var(--dsw-alias-label-tertiary);cursor:pointer;display:inline-flex;align-items:center;justify-content:center;border-radius:4px;padding:0;margin-right:2px}
.dsh-ab-tab-close:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.dsh-ab-tab-new{width:24px;height:24px;flex:none;border:0;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;display:inline-flex;align-items:center;justify-content:center;border-radius:4px}
.dsh-ab-tab-new:hover{background:var(--dsw-alias-interactive-bg-hover)}
.dsh-ab-toolbar{display:flex;align-items:center;gap:4px;height:38px;padding:5px 6px;border-bottom:.5px solid var(--dsw-alias-border-l3);flex:none}
.dsh-ab-tool{width:28px;height:28px;flex:none;display:inline-flex;align-items:center;justify-content:center;padding:0;border:0;background:transparent;color:var(--dsw-alias-label-secondary);border-radius:var(--dsw-radius-sm);cursor:pointer}
.dsh-ab-tool:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.dsh-ab-tool:disabled{color:var(--dsw-alias-label-quaternary);cursor:default}
.dsh-ab-tool.is-spinning svg{animation:dsh-ab-spin 1s linear infinite}
@keyframes dsh-ab-spin{to{transform:rotate(360deg)}}
.dsh-ab-perm-btn{display:inline-flex;align-items:center;gap:4px;height:26px;flex:none;padding:0 7px;border:.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-sm);background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;font-size:12px;line-height:18px;white-space:nowrap}
.dsh-ab-perm-btn:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.dsh-ab-perm-btn-icon{display:inline-flex;flex:none}
.dsh-ab-address{flex:1;min-width:0;display:flex}
.dsh-ab-address-input{box-sizing:border-box;width:100%;height:28px;padding:0 9px;border-radius:var(--dsw-radius-sm);border:.5px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:var(--dsw-font-xxs-12);outline:none}
.dsh-ab-address-input:focus{border-color:var(--dsw-alias-state-business-primary)}
.dsh-ab-status{flex:none;font:var(--dsw-font-xxxs-11);color:var(--dsw-alias-label-tertiary)}
.dsh-ab-viewport{flex:1;min-height:0;display:flex;position:relative;overflow:hidden}
.dsh-ab-window{flex:1;min-width:0;min-height:0;display:flex;position:relative}
.dsh-ab-webview{flex:1;width:100%;height:100%;border:0;background:var(--dsw-alias-bg-base)}
.dsh-ab-notice{position:absolute;inset:72px 0 0 0;display:flex;flex-direction:column;gap:12px;align-items:center;justify-content:center;padding:24px;text-align:center;color:var(--dsw-alias-label-tertiary);font:var(--dsw-font-xs-13)}
.dsh-ab-notice-text{max-width:360px;line-height:1.6}
.dsh-ab-spinner{width:22px;height:22px;border-radius:50%;border:2px solid var(--dsw-alias-border-l2);border-top-color:var(--dsw-alias-state-business-primary);animation:dsh-ab-spin .9s linear infinite}
.dsh-ab-empty{position:absolute;inset:72px 0 0 0;display:flex;flex-direction:column;gap:12px;align-items:center;justify-content:center;padding:24px;color:var(--dsw-alias-label-tertiary);text-align:center}
.dsh-ab-empty-text{max-width:300px;font:var(--dsw-font-xs-13);line-height:1.6}
.dsh-ab-toast{position:absolute;left:8px;right:8px;bottom:8px;padding:6px 10px;border-radius:var(--dsw-radius-sm);background:var(--dsw-alias-bg-layer-1);border:.5px solid var(--dsw-alias-border-l2);font:var(--dsw-font-xxs-12);color:var(--dsw-alias-label-secondary);box-shadow:0 4px 16px rgba(0,0,0,.16);z-index:5;overflow-wrap:anywhere}
.dsh-ab-menu{pointer-events:auto;background:var(--dsw-alias-bg-layer-1);border:.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-md,10px);box-shadow:0 8px 28px rgba(0,0,0,.22);padding:6px;display:flex;flex-direction:column;gap:2px}
.dsh-ab-menu-title{font:var(--dsw-font-xxxs-11);color:var(--dsw-alias-label-tertiary);padding:4px 8px 2px}
.dsh-ab-menu-window{font:var(--dsw-font-xxxs-11);color:var(--dsw-alias-label-tertiary);padding:0 8px 6px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsh-ab-menu-item{display:flex;align-items:flex-start;gap:6px;width:100%;padding:7px 8px;border:0;border-radius:var(--dsw-radius-sm);background:transparent;color:var(--dsw-alias-label-primary);cursor:pointer;text-align:left}
.dsh-ab-menu-item:hover{background:var(--dsw-alias-interactive-bg-hover)}
.dsh-ab-menu-item.is-active{background:var(--dsw-alias-interactive-bg-active,rgba(128,128,128,.16))}
.dsh-ab-menu-check{flex:none;width:14px;color:var(--dsw-alias-state-business-primary);font-size:12px;line-height:18px}
.dsh-ab-menu-text{display:flex;flex-direction:column;gap:2px;min-width:0}
.dsh-ab-menu-label{font-size:13px;line-height:18px;font-weight:500}
.dsh-ab-menu-hint{font:var(--dsw-font-xxxs-11);line-height:15px;color:var(--dsw-alias-label-tertiary);white-space:normal}
.dsh-ab-menu-error{padding:6px 8px;font:var(--dsw-font-xxxs-11);color:var(--dsw-alias-state-error-primary)}
.dsh-ab-modal-backdrop{pointer-events:auto;position:fixed;inset:0;background:rgba(0,0,0,.45);display:flex;align-items:center;justify-content:center;z-index:2147483646;padding:24px}
.dsh-ab-modal{width:min(460px,100%);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);border:.5px solid var(--dsw-alias-border-l2);border-radius:12px;box-shadow:0 18px 60px rgba(0,0,0,.35);padding:20px;display:flex;flex-direction:column;gap:12px}
.dsh-ab-modal-title{font-size:16px;font-weight:600;line-height:24px}
.dsh-ab-modal-desc{font-size:13px;line-height:20px;color:var(--dsw-alias-label-secondary)}
.dsh-ab-modal-ack{display:flex;align-items:flex-start;gap:8px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);cursor:pointer}
.dsh-ab-modal-ack input{margin-top:2px}
.dsh-ab-modal-actions{display:flex;justify-content:flex-end;gap:8px;margin-top:4px}
.dsh-ab-btn{height:30px;padding:0 12px;border-radius:var(--dsw-radius-sm);border:.5px solid var(--dsw-alias-border-l2);background:transparent;color:var(--dsw-alias-label-primary);cursor:pointer;font-size:13px}
.dsh-ab-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}
.dsh-ab-btn:disabled{opacity:.5;cursor:default}
.dsh-ab-btn-primary{background:var(--dsw-alias-state-business-primary);border-color:var(--dsw-alias-state-business-primary);color:#fff}
.dsh-ab-btn-primary:hover:not(:disabled){opacity:.9;background:var(--dsw-alias-state-business-primary)}
.dsh-ab-dl-popup{pointer-events:auto;flex:none;margin:8px 8px 0;background:var(--dsw-alias-bg-layer-1);border:.5px solid var(--dsw-alias-border-l2);border-radius:10px;box-shadow:0 6px 20px rgba(0,0,0,.16);display:flex;flex-direction:column;max-height:min(46vh,420px);overflow:hidden}
.dsh-ab-sheet{pointer-events:auto;flex:none;margin:8px 8px 0;background:var(--dsw-alias-bg-layer-1);border:.5px solid var(--dsw-alias-border-l2);border-radius:10px;box-shadow:0 6px 20px rgba(0,0,0,.16);padding:6px 8px 8px;display:flex;flex-direction:column;gap:2px;max-height:52vh;overflow-y:auto}
.dsh-ab-sheet-head{display:flex;align-items:center;justify-content:space-between;padding:2px 2px 4px}
.dsh-ab-sheet-title{font-size:12px;font-weight:600;color:var(--dsw-alias-label-secondary)}
.dsh-ab-sheet-desc{font:var(--dsw-font-xxxs-11);line-height:16px;color:var(--dsw-alias-label-tertiary);padding:0 4px 4px}
.dsh-ab-sheet-item{display:flex;align-items:flex-start;gap:8px;width:100%;padding:6px 8px;border:0;border-radius:6px;background:transparent;color:var(--dsw-alias-label-primary);cursor:pointer;text-align:left}
.dsh-ab-sheet-item:hover{background:var(--dsw-alias-interactive-bg-hover)}
.dsh-ab-sheet-item.is-active{background:var(--dsw-alias-interactive-bg-active,rgba(128,128,128,.16))}
.dsh-ab-sheet-check{flex:none;width:14px;color:var(--dsw-alias-state-business-primary);font-size:12px;line-height:18px}
.dsh-ab-sheet-text{display:flex;flex-direction:column;gap:1px;min-width:0}
.dsh-ab-sheet-label{font-size:12px;line-height:18px;font-weight:500}
.dsh-ab-sheet-hint{font:var(--dsw-font-xxxs-11);line-height:15px;color:var(--dsw-alias-label-tertiary);white-space:normal}
.dsh-ab-sheet-ack{display:flex;align-items:flex-start;gap:8px;padding:2px 4px 6px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);cursor:pointer}
.dsh-ab-sheet-ack input{margin-top:2px}
.dsh-ab-sheet-actions{display:flex;justify-content:flex-end;gap:8px;padding-top:2px}
.dsh-ab-sites{max-height:60vh}
.dsh-ab-sites-section{display:flex;flex-direction:column;gap:4px;padding:6px 0;border-top:.5px solid var(--dsw-alias-border-l3)}
.dsh-ab-sites-head{font-size:12px;font-weight:600;color:var(--dsw-alias-label-secondary);padding:0 4px}
.dsh-ab-sites-empty{font:var(--dsw-font-xxxs-11);color:var(--dsw-alias-label-tertiary);padding:0 4px}
.dsh-ab-sites-row{display:flex;align-items:center;gap:8px;padding:2px 4px}
.dsh-ab-sites-host{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px;line-height:18px}
.dsh-ab-sites-toggle{display:flex;align-items:center;gap:4px;font:var(--dsw-font-xxxs-11);color:var(--dsw-alias-label-tertiary);cursor:pointer;white-space:nowrap}
.dsh-ab-sites-add{display:flex;gap:6px;padding:4px}
.dsh-ab-sites-input{flex:1;min-width:0;height:26px;padding:0 8px;border-radius:var(--dsw-radius-sm);border:.5px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font-size:12px;outline:none}
.dsh-ab-sites-input:focus{border-color:var(--dsw-alias-state-business-primary)}
.dsh-ab-dl-head{display:flex;align-items:center;justify-content:space-between;padding:10px 10px 8px 14px;flex:none}
.dsh-ab-dl-title{font-size:14px;font-weight:600;line-height:20px}
.dsh-ab-dl-head-actions{display:flex;gap:2px}
.dsh-ab-dl-icon-btn{width:28px;height:28px;border:0;border-radius:6px;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;display:inline-flex;align-items:center;justify-content:center;padding:0}
.dsh-ab-dl-icon-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.dsh-ab-dl-icon-btn:disabled{opacity:.5;cursor:default}
.dsh-ab-dl-error{padding:4px 14px 6px;font:var(--dsw-font-xxxs-11);color:var(--dsw-alias-state-error-primary);overflow-wrap:anywhere}
.dsh-ab-dl-list{flex:1;min-height:0;overflow-y:auto;padding:0 6px 2px}
.dsh-ab-dl-row{display:flex;align-items:center;gap:10px;padding:8px;border-radius:8px}
.dsh-ab-dl-row:hover{background:var(--dsw-alias-interactive-bg-hover)}
.dsh-ab-dl-badge{width:30px;height:30px;border-radius:6px;flex:none;display:flex;align-items:center;justify-content:center;color:#fff;font-size:9px;font-weight:700;letter-spacing:.4px}
.dsh-ab-dl-main{flex:1;min-width:0;display:flex;flex-direction:column;gap:3px}
.dsh-ab-dl-name{font-size:12px;line-height:17px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsh-ab-dl-status{font:var(--dsw-font-xxxs-11);line-height:15px;color:var(--dsw-alias-label-tertiary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsh-ab-dl-status.is-error{color:var(--dsw-alias-state-error-primary)}
.dsh-ab-dl-bar-wrap{height:4px;border-radius:999px;background:var(--dsw-alias-interactive-bg-hover);overflow:hidden}
.dsh-ab-dl-bar{height:100%;border-radius:999px;background:var(--dsw-alias-state-business-primary);transition:width .25s linear;min-width:2px}
.dsh-ab-dl-actions{display:flex;gap:2px;flex:none}
.dsh-ab-dl-more{flex:none;margin:4px 8px 8px;height:30px;border-radius:8px;border:.5px solid var(--dsw-alias-border-l2);background:transparent;color:var(--dsw-alias-label-primary);cursor:pointer;font-size:12px}
.dsh-ab-dl-more:hover{background:var(--dsw-alias-interactive-bg-hover)}
.dsh-ab-dl-empty{padding:30px 14px;text-align:center;color:var(--dsw-alias-label-tertiary);font:var(--dsw-font-xs-13)}
/* ---- 1.1.1-beta.1：收藏 / 历史 / 权限预设 / 地球 ---- */
.dsh-ab-tool-bookmark.is-bookmarked{color:var(--dsw-alias-state-business-primary)}
.dsh-ab-tool-caret{width:16px;color:var(--dsw-alias-label-tertiary)}
.dsh-ab-tool-caret:hover:not(:disabled){color:var(--dsw-alias-label-primary)}
.dsh-ab-lib-head-actions{display:flex;align-items:center;gap:4px}
.dsh-ab-lib-clear{height:26px;padding:0 8px;border:0;border-radius:var(--dsw-radius-sm);background:transparent;color:var(--dsw-alias-label-tertiary);cursor:pointer;font-size:12px;white-space:nowrap}
.dsh-ab-lib-clear:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.dsh-ab-lib-clear:disabled{opacity:.5;cursor:default}
.dsh-ab-lib-list{display:flex;flex-direction:column;gap:2px;min-height:0;overflow-y:auto;padding:0 2px}
.dsh-ab-lib-row{display:flex;align-items:center;gap:4px;border-radius:8px;padding:2px}
.dsh-ab-lib-row:hover{background:var(--dsw-alias-interactive-bg-hover)}
.dsh-ab-lib-main{flex:1;min-width:0;display:flex;flex-direction:column;gap:1px;border:0;background:transparent;color:var(--dsw-alias-label-primary);text-align:left;padding:5px 6px;border-radius:6px;cursor:pointer}
.dsh-ab-lib-title{font-size:12px;line-height:17px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsh-ab-lib-url{font:var(--dsw-font-xxxs-11);line-height:15px;color:var(--dsw-alias-label-tertiary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsh-ab-lib-time{font:var(--dsw-font-xxxs-11);line-height:15px;color:var(--dsw-alias-label-quaternary)}
.dsh-ab-bookmark-current{display:flex;align-items:center;gap:6px;justify-content:center;margin:2px 4px 6px}
.dsh-ab-bookmark-current-icon{display:inline-flex;flex:none}
.dsh-ab-seeded-note{padding:2px 4px 4px;font:var(--dsw-font-xxxs-11);line-height:16px;color:var(--dsw-alias-state-business-primary);overflow-wrap:anywhere}
.dsh-ab-presets{margin-bottom:2px}
.dsh-ab-presets-head{display:flex;align-items:center;justify-content:space-between;gap:8px}
.dsh-ab-presets-default{font:var(--dsw-font-xxxs-11);color:var(--dsw-alias-label-tertiary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.dsh-ab-preset-row{display:flex;align-items:center;gap:8px;padding:2px 4px}
.dsh-ab-preset-main{flex:1;min-width:0;display:flex;align-items:center;gap:6px}
.dsh-ab-preset-name{font-size:12px;line-height:18px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsh-ab-preset-badge{flex:none;padding:0 5px;height:16px;line-height:16px;border-radius:999px;font-size:10px;color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-interactive-bg-hover)}
.dsh-ab-preset-apply{flex:none;height:24px;padding:0 8px;font-size:11px}
.dsh-ab-foot-note{padding:0 4px 4px;font:var(--dsw-font-xxxs-11);line-height:16px;color:var(--dsw-alias-label-secondary)}
/* 预设搜索 / txt 导入导出（面板设置） */
.dsh-ab-presets-search{display:flex;align-items:center;gap:6px;padding:2px 4px}
.dsh-ab-presets-save{display:flex;align-items:center;gap:6px;padding:4px 4px 2px}
.dsh-ab-presets-actions{display:flex;flex-wrap:wrap;gap:6px;padding:2px 4px 4px}
/* 侧栏会话行：浏览器模式会话在 leading 位置显示地球，运行中显示旋转地球 */
[data-row-key^="session:"][data-dsh-ab-browser-session] > span:first-child{position:relative}
[data-row-key^="session:"][data-dsh-ab-browser-session][data-dsh-ab-browser-running] > span:first-child > *{visibility:hidden!important}
[data-row-key^="session:"][data-dsh-ab-browser-session]:not([data-dsh-ab-browser-running]) > span:first-child:not(:has(*))::after{content:'';position:absolute;left:50%;top:50%;width:15px;height:15px;margin:-7.5px 0 0 -7.5px;background:currentColor;-webkit-mask:url("${EARTH_MASK_URI}") center / contain no-repeat;mask:url("${EARTH_MASK_URI}") center / contain no-repeat;pointer-events:none}
[data-row-key^="session:"][data-dsh-ab-browser-session][data-dsh-ab-browser-running] > span:first-child::after{content:'';position:absolute;left:50%;top:50%;width:15px;height:15px;margin:-7.5px 0 0 -7.5px;background:currentColor;-webkit-mask:url("${EARTH_MASK_URI}") center / contain no-repeat;mask:url("${EARTH_MASK_URI}") center / contain no-repeat;pointer-events:none;animation:dsh-ab-spin 2.4s linear infinite}
/* 设置导航里的「AI 浏览器」用地球图标（settings.section 契约不带 icon，只能打标记 + mask 替换） */
.dsh-ab-settings-nav > svg:first-child{display:none}
.dsh-ab-settings-nav::before{content:'';flex:none;width:16px;height:16px;background:currentColor;-webkit-mask:url("${EARTH_MASK_URI}") center / contain no-repeat;mask:url("${EARTH_MASK_URI}") center / contain no-repeat}
/* Harness 设置页：AI 浏览器 */
.dsh-ab-set{display:flex;flex-direction:column;gap:18px;padding:6px 0 24px;max-width:640px}
.dsh-ab-set-hero{display:flex;align-items:center;gap:20px;padding:18px 20px;border:.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-lg,12px);background:var(--dsw-alias-bg-layer-2)}
.dsh-ab-set-earth{flex:none;display:inline-flex;color:var(--dsw-alias-label-primary);opacity:.92}
.dsh-ab-set-hero-text{display:flex;flex-direction:column;gap:6px;min-width:0}
.dsh-ab-set-title{font-size:18px;font-weight:600;line-height:26px;color:var(--dsw-alias-label-primary)}
.dsh-ab-set-desc{font-size:13px;line-height:20px;color:var(--dsw-alias-label-secondary)}
.dsh-ab-set-hints{display:flex;flex-direction:column;gap:6px;padding:0 4px}
.dsh-ab-set-hint{position:relative;padding-left:14px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}
.dsh-ab-set-hint::before{content:'';position:absolute;left:2px;top:7px;width:5px;height:5px;border-radius:50%;background:var(--dsw-alias-label-tertiary);opacity:.7}
.dsh-ab-set-section{display:flex;flex-direction:column;gap:10px;border-top:.5px solid var(--dsw-alias-border-l3);padding-top:14px;min-width:0}
.dsh-ab-set-section-head{display:flex;align-items:baseline;justify-content:space-between;gap:12px}
.dsh-ab-set-section-title{font-size:14px;font-weight:600;line-height:22px;color:var(--dsw-alias-label-primary)}
.dsh-ab-set-default{font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsh-ab-set-search{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.dsh-ab-set-search .dsh-ab-set-name-input{flex:1 1 220px}
.dsh-ab-set-create{display:flex;flex-wrap:wrap;align-items:center;gap:8px}
.dsh-ab-set-name-input{box-sizing:border-box;flex:1 1 180px;min-width:120px;height:30px;padding:0 10px;border-radius:var(--dsw-radius-sm);border:.5px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font-size:12px;outline:none}
.dsh-ab-set-name-input:focus{border-color:var(--dsw-alias-state-business-primary)}
.dsh-ab-set-base{display:flex;gap:6px}
.dsh-ab-set-chip{height:28px;padding:0 10px;border-radius:999px;border:.5px solid var(--dsw-alias-border-l2);background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;font-size:12px;white-space:nowrap}
.dsh-ab-set-chip:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}
.dsh-ab-set-chip.is-active{background:var(--dsw-alias-interactive-bg-active,rgba(128,128,128,.16));color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-border-l1,var(--dsw-alias-border-l2))}
.dsh-ab-set-chip:disabled{opacity:.5;cursor:default}
.dsh-ab-set-list{display:flex;flex-direction:column;gap:8px;min-width:0}
.dsh-ab-set-empty,.dsh-ab-set-loading{font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary);padding:8px 2px}
.dsh-ab-set-error{font-size:12px;line-height:18px;color:var(--dsw-alias-state-error-primary);overflow-wrap:anywhere}
.dsh-ab-set-message{font-size:12px;line-height:18px;color:var(--dsw-alias-state-business-primary)}
.dsh-ab-set-preset{border:.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-md,10px);padding:8px 10px;display:flex;flex-direction:column;gap:6px;background:var(--dsw-alias-bg-layer-1);min-width:0}
.dsh-ab-set-preset.is-selected{border-color:var(--dsw-alias-state-business-primary)}
.dsh-ab-set-preset-head{display:flex;align-items:center;gap:6px;flex-wrap:wrap;min-width:0}
.dsh-ab-set-preset-pick{border:0;background:transparent;padding:0;color:var(--dsw-alias-label-primary);font-size:13px;line-height:20px;font-weight:500;cursor:pointer;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:260px}
.dsh-ab-set-preset-pick:hover{text-decoration:underline}
.dsh-ab-set-badge{flex:none;padding:0 6px;height:16px;line-height:16px;border-radius:999px;font-size:10px;color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-interactive-bg-hover)}
.dsh-ab-set-preset-row-actions{display:flex;align-items:center;gap:4px;margin-left:auto;flex-wrap:wrap}
.dsh-ab-set-action{height:24px;padding:0 8px;border-radius:var(--dsw-radius-sm);border:.5px solid var(--dsw-alias-border-l2);background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;font-size:12px;white-space:nowrap}
.dsh-ab-set-action:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.dsh-ab-set-action:disabled{opacity:.5;cursor:default}
.dsh-ab-set-action.is-danger{color:var(--dsw-alias-state-error-primary)}
.dsh-ab-set-confirm{display:flex;align-items:center;gap:8px;padding:4px 6px;border-radius:var(--dsw-radius-sm);background:var(--dsw-alias-interactive-bg-hover);font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);flex-wrap:wrap}
.dsh-ab-set-rename{display:flex;align-items:center;gap:6px;flex-wrap:wrap}
.dsh-ab-set-rename .dsh-ab-set-name-input{height:28px;flex:1 1 160px}
.dsh-ab-set-editor{display:flex;flex-direction:column;gap:6px;padding-top:6px;border-top:.5px dashed var(--dsw-alias-border-l3);min-width:0}
.dsh-ab-set-editor .dsh-ab-sites-section:first-child{border-top:0;padding-top:0}
.dsh-ab-set .dsh-ab-sites-input{background:var(--dsw-alias-bg-base)}
.dsh-ab-set .dsh-ab-sites-head{font-size:12px}
`

      // ------------------------------------------------------------------
      // Cordis Client 插件
      // ------------------------------------------------------------------
      /** 会话是否为 AI 浏览器模式（供命令菜单过滤）。 */
      function isBrowserPresetSession(session) {
        try {
          if (session !== null && session !== undefined && session.agentPreset === PRESET_ID) return true
          var face = session !== null && session !== undefined && session.projections !== undefined && typeof session.projections.faceOf === 'function' ? session.projections.faceOf('agentPreset') : null
          var value = face !== null && typeof face.getSnapshot === 'function' ? face.getSnapshot() : undefined
          if (value !== null && typeof value === 'object') value = value.current !== undefined ? value.current : value.value
          return value === PRESET_ID
        } catch (error) {
          return false
        }
      }

      function apply(ctx) {
        PLUGIN_CTX = ctx
        ctx.effect(function () {
          var styleElement = document.createElement('style')
          styleElement.setAttribute('data-dsh-ai-browser', '')
          styleElement.textContent = CSS
          document.head.appendChild(styleElement)
          var disposeDismiss = installDismissListeners()
          var disposeSessionMarks = installBrowserSessionMarks()
          var disposeSettingsNavIcon = registerSettingsNavIcon(function () {
            // 中英两种显示名都匹配，避免语言回退差异导致导航图标换不掉。
            return [ZH['settingsPage.nav'], EN['settingsPage.nav']]
          })
          return function () {
            if (styleElement.parentNode !== null) styleElement.parentNode.removeChild(styleElement)
            disposeDismiss()
            disposeSessionMarks()
            disposeSettingsNavIcon()
          }
        }, NS + ': styles')
        ctx.effect(function () {
          return ctx.locale.register(NS, { zh: ZH, en: EN })
        }, NS + ': locale')
        var t = ctx.locale.bind(NS)
        ctx.effect(function () {
          try {
            return ctx.sidebarRightTabs.register({
              id: TAB_ID,
              kind: TAB_KIND,
              keepMounted: true,
              title: function () {
                return t('tab.title')
              },
            })
          } catch (error) {
            console.error('[dsh-ai-browser] 右侧栏页签类型注册失败：', error)
            return function () {}
          }
        }, NS + ': sidebar tab type')
        ctx.effect(function () {
          try {
            return ctx.slots.inject('sidebar.right.pane.tab', function () {
              return ctx.slots.register(
                { name: 'sidebar.right.pane.tab', key: TAB_ID, locale: NS, inject: function (sessionId) { return { sessionId: sessionId } } },
                BrowserPanel,
              )
            })
          } catch (error) {
            console.error('[dsh-ai-browser] 浏览器面板注册失败：', error)
            return function () {}
          }
        }, NS + ': browser panel')
        ctx.effect(function () {
          try {
            return ctx.slots.inject('sidebar.workspaces.session.row.action', function () {
              return ctx.slots.register(
                { name: 'sidebar.workspaces.session.row.action', id: 'dsh-ai-browser-status', order: 90, locale: NS },
                SessionRowBridge,
              )
            })
          } catch (error) {
            console.error('[dsh-ai-browser] 侧栏会话状态桥接注册失败：', error)
            return function () {}
          }
        }, NS + ': session row bridge')
        ctx.effect(function () {
          try {
            return ctx.slots.inject('conversation.input.left', function () {
              return ctx.slots.register({ name: 'conversation.input.left', id: TAB_ID, order: 40, locale: NS }, SessionAnchor)
            })
          } catch (error) {
            return function () {}
          }
        }, NS + ': session anchor')
        ctx.effect(function () {
          try {
            return ctx.slots.inject('settings.section', function () {
              return ctx.slots.register(
                {
                  name: 'settings.section',
                  id: SETTINGS_SECTION,
                  order: 75,
                  label: function () {
                    return t('settingsPage.nav')
                  },
                  locale: NS,
                },
                SettingsPage,
              )
            })
          } catch (error) {
            console.error('[dsh-ai-browser] 设置页注册失败：', error)
            return function () {}
          }
        }, NS + ': settings section')
        ctx.inject(['commandUi'], function (scope) {
          try {
            var command = typeof scope.get === 'function' ? scope.get('commandUi') : scope.commandUi
            if (command === null || command === undefined || typeof command.register !== 'function') return
            scope.effect(function () {
              return command.register({
                name: 'ai-browser-open',
                label: function () {
                  return t('command.open')
                },
                description: function () {
                  return t('command.open.description')
                },
                icon: EarthIcon,
                available: function (session) {
                  if (session !== null && session !== undefined && typeof session.sessionId === 'string' && BROWSER_SESSIONS[session.sessionId] === true) return true
                  return isBrowserPresetSession(session)
                },
                ui: {
                  kind: 'action',
                  run: function () {
                    try {
                      ctx.sidebarRight.openTab(TAB_KIND, {})
                    } catch (error) {
                      console.error('[dsh-ai-browser] 打开浏览器面板失败：', error)
                    }
                  },
                },
              })
            }, NS + ': command contribution')
          } catch (error) {
            console.error('[dsh-ai-browser] 注册命令菜单入口失败：', error)
          }
        }, NS + ': commandUi')
      }

      return { name: NS, inject: ['slots', 'locale', 'sidebarRight', 'sidebarRightTabs'], apply: apply }
    },
  })
})()
