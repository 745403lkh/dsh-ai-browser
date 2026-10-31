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
      var CLIENT_VERSION = '1.0.1'
      /** Host 侧提供下载/下载列表能力所需的最小 feature 集。 */
      var REQUIRED_HOST_FEATURES = ['download-url', 'downloads']

      var PLUGIN_CTX = null
      var AUTO_OPENED = {}
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
        pause: ['M8 5v14', 'M16 5v14'],
      }

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
      // 会话锚点：无可见 UI，只负责自动打开面板
      // ------------------------------------------------------------------
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
        var [serverEnabled, setServerEnabled] = React.useState(null)
        var enabled = projected === PRESET_ID || (projected === undefined && serverEnabled === true)

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
                  return { url: window.url, title: window.title, canGoBack: window.canGoBack, canGoForward: window.canGoForward }
                })
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
            function createWindow(url) {
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
                env.windows.set(window.id, window)
                if (typeof env.desktop.onOpenRequested === 'function') {
                  try {
                    window.unsubscribeOpen = env.desktop.onOpenRequested(reservation.lease, function (popupUrl) {
                      if (!env.alive || typeof popupUrl !== 'string' || popupUrl === '') return
                      createWindow(popupUrl)
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
                var inherited = env.levels[previousActive] || env.defaultLevel || 'view'
                env.levels[window.id] = inherited
                requestJson('/level', { method: 'POST', body: { sessionId: sessionId, windowId: window.id, level: inherited } }).catch(function () {})
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
        var [acknowledged, setAcknowledged] = React.useState(false)

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
            h('button', { type: 'button', className: 'dsh-ab-tool dsh-ab-tool-download', title: t('panel.downloads'), onClick: openDownloads }, icon(ICONS.download, 16)),
          ),
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
`

      // ------------------------------------------------------------------
      // Cordis Client 插件
      // ------------------------------------------------------------------
      function apply(ctx) {
        PLUGIN_CTX = ctx
        ctx.effect(function () {
          var styleElement = document.createElement('style')
          styleElement.setAttribute('data-dsh-ai-browser', '')
          styleElement.textContent = CSS
          document.head.appendChild(styleElement)
          var disposeDismiss = installDismissListeners()
          return function () {
            if (styleElement.parentNode !== null) styleElement.parentNode.removeChild(styleElement)
            disposeDismiss()
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
            return ctx.slots.inject('conversation.input.left', function () {
              return ctx.slots.register({ name: 'conversation.input.left', id: TAB_ID, order: 40, locale: NS }, SessionAnchor)
            })
          } catch (error) {
            return function () {}
          }
        }, NS + ': session anchor')
      }

      return { name: NS, inject: ['slots', 'locale', 'sidebarRight', 'sidebarRightTabs'], apply: apply }
    },
  })
})()
