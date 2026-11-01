/**
 * dsh-ai-browser 的 Host 侧运行时（进程内单例）。
 *
 * 模型：
 * - 每个会话一个 SessionRuntime：客户端上报的浏览器窗口列表、命令队列（长轮询取走）、
 *   在途命令的 pending promise、以及按窗口保存的权限级别。
 * - Host 工具 `browser` 调用 runtime.run() 下发命令，Client 在对应窗口的 `<webview>`
 *   里执行后回传结果；命令通过 args.window 指定目标窗口。
 * - 下载由 Client 端在页面内取回字节，POST 到 /download，由 Host 写入当前工作区的
 *   `browser download/` 目录。
 */

import fs from 'node:fs'
import path from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'

import { BrowserPermissionStore, DEFAULT_LEVEL } from './browser-permissions.js'
import { normalizeLevel } from './permissions.js'
import { DEFAULT_WORKSPACE, SitePolicyStore, normalizeWorkspaceKey } from './site-policies.js'
import { BrowserLibrary } from './library.js'
import { PermissionPresetStore } from './presets.js'

/** 单条命令默认等待上限（毫秒）。 */
export const COMMAND_TIMEOUT_MS = 60000
/** Host 兜底超时多 5s。 */
export const HOST_TIMEOUT_MS = COMMAND_TIMEOUT_MS + 5000
/** 长轮询挂起上限。 */
export const POLL_TIMEOUT_MS = 25000
/** 命令缓冲上限。 */
const MAX_BUFFERED_COMMANDS = 64
/** 会话状态条目上限。 */
const MAX_SESSIONS = 256
/** 每个会话最多窗口数。 */
export const MAX_WINDOWS = 12
/** 单次下载大小上限（字节，base64 解码后）。 */
export const MAX_DOWNLOAD_BYTES = 128 * 1024 * 1024
/** Host 直连下载大小上限（流式写盘，允许更大文件）。 */
export const MAX_FETCH_DOWNLOAD_BYTES = 512 * 1024 * 1024
/** Host 直连下载超时。 */
const FETCH_DOWNLOAD_TIMEOUT_MS = 180000
/** 直连下载使用的通用 UA（部分下载站会拒绝 Node 默认 UA）。 */
const DOWNLOAD_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36 Edg/151.0.0.0'
const MAX_URL_LENGTH = 4096
const MAX_TITLE_LENGTH = 512


export class BrowserBridgeError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'BrowserBridgeError'
    this.code = code
  }
}

class SessionRuntime {
  constructor(id) {
    this.id = id
    this.sequence = 0
    this.commands = []
    this.pollWaiters = new Set()
    this.pending = new Map()
    this.connected = false
    /** @type {Array<{id:string,url:string,title:string,ready:boolean,loading:boolean}>} */
    this.windows = []
    this.activeWindowId = ''
    this.lastUsedAt = Date.now()
  }

  wakePollers() {
    for (const waiter of [...this.pollWaiters]) {
      this.pollWaiters.delete(waiter)
      try {
        waiter.wake()
      } catch {
        /* 忽略 */
      }
    }
  }
}

function shortString(value, max) {
  return typeof value === 'string' ? value.slice(0, max) : ''
}

/** 清洗文件名。 */
function sanitizeFileName(name, fallback) {
  const raw = typeof name === 'string' && name !== '' ? name : fallback
  let base = raw.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').replace(/\s+/g, ' ').trim()
  if (base === '' || base === '.' || base === '..') base = fallback
  if (base.length > 160) {
    const dot = base.lastIndexOf('.')
    const ext = dot > 0 ? base.slice(dot) : ''
    base = base.slice(0, 160 - ext.length) + ext
  }
  return base
}

/** 唯一文件名。 */
function uniquePath(dir, name) {
  const ext = path.extname(name)
  const stem = ext === '' ? name : name.slice(0, -ext.length)
  let candidate = path.join(dir, name)
  let index = 1
  while (fs.existsSync(candidate)) {
    candidate = path.join(dir, `${stem}-${index}${ext}`)
    index += 1
    if (index > 999) break
  }
  return candidate
}

/** 私有地址/回环地址判断（下载直连的 SSRF 防护）。 */
function isPrivateHostname(hostname) {
  const host = String(hostname).toLowerCase().replace(/^\[|\]$/g, '')
  if (['localhost', '0.0.0.0', '::1', '::', 'metadata.google.internal'].includes(host)) return true
  if (host.endsWith('.local') || host.endsWith('.internal')) return true
  const ipv4 = host.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/)
  if (ipv4 !== null) {
    const [, a, b] = ipv4.map((part) => Number(part))
    if (a === 10 || a === 127 || a === 0) return true
    if (a === 169 && b === 254) return true
    if (a === 172 && b >= 16 && b <= 31) return true
    if (a === 192 && b === 168) return true
    if (a === 100 && b >= 64 && b <= 127) return true
    return false
  }
  // IPv6 私网/链路本地粗判
  if (host.includes(':') && (host.startsWith('fc') || host.startsWith('fd') || host.startsWith('fe8') || host.startsWith('fe9') || host.startsWith('fea') || host.startsWith('feb'))) return true
  return false
}

/** 校验下载直连 URL。 */
export function assertFetchableUrl(value) {
  let url
  try {
    url = new URL(String(value))
  } catch {
    throw new BrowserBridgeError('PROTOCOL', '下载地址无效')
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new BrowserBridgeError('PROTOCOL', '下载只支持 http/https 地址')
  if (url.username !== '' || url.password !== '') throw new BrowserBridgeError('PROTOCOL', '下载地址不能包含用户名或密码')
  if (isPrivateHostname(url.hostname)) throw new BrowserBridgeError('PROTOCOL', '出于安全考虑，不能直连下载本机/内网地址')
  return url
}

/** 从 Content-Disposition 或 URL 推导文件名。 */
function fileNameFromResponse(url, response, fallback) {
  const disposition = response.headers.get('content-disposition') ?? ''
  const encoded = disposition.match(/filename\*=UTF-8''([^;]+)/i)
  if (encoded !== null) {
    try {
      return decodeURIComponent(encoded[1].trim().replace(/^"|"$/g, ''))
    } catch {
      /* 继续尝试普通 filename */
    }
  }
  const plain = disposition.match(/filename\s*=\s*"?([^";]+)"?/i)
  if (plain !== null && plain[1].trim() !== '') return plain[1].trim()
  let pathname = ''
  try {
    pathname = new URL(url).pathname
  } catch {
    pathname = ''
  }
  const base = pathname.slice(pathname.lastIndexOf('/') + 1)
  try {
    const decoded = decodeURIComponent(base)
    if (decoded !== '') return decoded
  } catch {
    /* 忽略 */
  }
  return fallback
}

export class AiBrowserRuntime {
  constructor() {
    /** @type {Map<string, SessionRuntime>} */
    this.sessions = new Map()
    this.permissions = new BrowserPermissionStore()
    this.sitePolicies = new SitePolicyStore()
    this.library = new BrowserLibrary()
    this.presets = new PermissionPresetStore()
    /** @type {Map<string, {key:string, path:string}>} */
    this.workspaceCache = new Map()
    this.disposed = false
    /** @type {{agents:object, agentPresets:object, workingDirectory:object}|null} */
    this.hostServices = null
  }

  bindHostServices(services) {
    this.hostServices = services
    this.workspaceCache.clear()
  }

  /**
   * 解析会话当前工作区（供站点名单使用）。
   * @returns {Promise<{key:string, path:string}>}
   */
  async resolveWorkspace(sessionId, force = false) {
    const id = String(sessionId ?? '')
    if (id === '') return { key: DEFAULT_WORKSPACE, path: '', at: 0 }
    const cached = this.workspaceCache.get(id)
    if (!force && cached !== undefined && Date.now() - cached.at < 2000) return cached
    let workspacePath = ''
    const services = this.hostServices
    if (services !== null && services !== undefined) {
      try {
        const agent = services.agents?.get?.(id)
        if (agent !== undefined && agent !== null && services.workingDirectory !== undefined) {
          const workingDirectory = services.workingDirectory
          // 同步读取已记录的目录（不会做文件系统操作），比 ensure 更稳。
          if (typeof workingDirectory.get === 'function') {
            try {
              const value = workingDirectory.get(agent.session)
              if (typeof value === 'string') workspacePath = value
            } catch {
              workspacePath = ''
            }
          }
          if (workspacePath === '' && typeof workingDirectory.ensure === 'function') {
            const value = await workingDirectory.ensure(agent)
            if (typeof value === 'string') workspacePath = value
          }
        }
      } catch {
        workspacePath = ''
      }
    }
    if (typeof workspacePath !== 'string') workspacePath = ''
    const resolved = { key: normalizeWorkspaceKey(workspacePath), path: workspacePath, at: Date.now() }
    this.workspaceCache.set(id, resolved)
    return resolved
  }

  /** 诊断：当前会话的工作区解析链路（只读）。 */
  async debugWorkspace(sessionId) {
    const id = String(sessionId ?? '')
    const services = this.hostServices
    const result = {
      hasHostServices: services !== null && services !== undefined,
      hasAgents: typeof services?.agents?.get === 'function',
      hasWorkingDirectory: services?.workingDirectory !== undefined,
      getType: typeof services?.workingDirectory?.get,
      ensureType: typeof services?.workingDirectory?.ensure,
      agentFound: false,
      sessionFound: false,
      getValue: '',
      getError: '',
      ensureValue: '',
      ensureError: '',
    }
    if (services !== null && services !== undefined) {
      try {
        const agent = services.agents?.get?.(id)
        result.agentFound = agent !== undefined && agent !== null
        result.sessionFound = agent?.session !== undefined && agent?.session !== null
        if (agent !== undefined && agent !== null && services.workingDirectory !== undefined) {
          const workingDirectory = services.workingDirectory
          if (typeof workingDirectory.get === 'function') {
            try {
              result.getValue = String(workingDirectory.get(agent.session))
            } catch (error) {
              result.getError = error instanceof Error ? error.message : String(error)
            }
          }
          if (typeof workingDirectory.ensure === 'function') {
            try {
              result.ensureValue = String(await workingDirectory.ensure(agent))
            } catch (error) {
              result.ensureError = error instanceof Error ? error.message : String(error)
            }
          }
        }
      } catch (error) {
        result.getError = error instanceof Error ? error.message : String(error)
      }
    }
    const resolved = await this.resolveWorkspace(id, true)
    return { ...result, key: resolved.key, path: resolved.path }
  }

  isBrowserSession(sessionId) {
    const services = this.hostServices
    if (services === null || services === undefined) return false
    try {
      const agents = services.agents
      const presets = services.agentPresets
      if (agents === undefined || typeof agents.get !== 'function') return false
      if (presets === undefined || typeof presets.composedPreset !== 'function') return false
      const agent = agents.get(sessionId)
      if (agent === undefined || agent === null) return false
      return presets.composedPreset(agent.ctx) === 'ai-browser'
    } catch {
      return false
    }
  }

  session(sessionId) {
    const id = String(sessionId ?? '')
    let state = this.sessions.get(id)
    if (state === undefined) {
      if (this.sessions.size >= MAX_SESSIONS) {
        const candidates = [...this.sessions.entries()]
          .filter(([, entry]) => entry.pending.size === 0)
          .sort((a, b) => a[1].lastUsedAt - b[1].lastUsedAt)
        for (const [key] of candidates.slice(0, Math.max(1, candidates.length - MAX_SESSIONS + 1))) {
          this.sessions.delete(key)
        }
      }
      state = new SessionRuntime(id)
      this.sessions.set(id, state)
    }
    state.lastUsedAt = Date.now()
    return state
  }

  /** 会话默认级别。 */
  defaultLevelOf(sessionId) {
    return this.permissions.defaultLevelOf(String(sessionId ?? ''))
  }

  /** 某窗口当前级别（未知窗口回退默认）。 */
  levelOf(sessionId, windowId) {
    return this.permissions.levelOf(String(sessionId ?? ''), windowId)
  }

  /** 设置窗口级别。 */
  setWindowLevel(sessionId, windowId, level) {
    return this.permissions.setWindowLevel(String(sessionId ?? ''), windowId, normalizeLevel(level))
  }

  /** 当前窗口列表（带级别与激活标记）。 */
  listWindows(sessionId) {
    const id = String(sessionId ?? '')
    const state = this.session(id)
    return state.windows.map((window) => ({
      id: window.id,
      url: window.url,
      title: window.title,
      ready: window.ready,
      loading: window.loading,
      active: window.id === state.activeWindowId,
      level: this.permissions.levelOf(id, window.id),
    }))
  }

  /** 解析目标窗口；未指定时用激活窗口，再退回第一个。 */
  resolveWindow(sessionId, requestedId) {
    const state = this.session(sessionId)
    if (typeof requestedId === 'string' && requestedId !== '') {
      const found = state.windows.find((window) => window.id === requestedId)
      if (found === undefined) throw new BrowserBridgeError('NO_WINDOW', `浏览器窗口 ${requestedId} 不存在`)
      return found
    }
    const active = state.windows.find((window) => window.id === state.activeWindowId)
    if (active !== undefined) return active
    if (state.windows.length > 0) return state.windows[0]
    throw new BrowserBridgeError('NO_WINDOW', '浏览器面板还没有打开的窗口')
  }

  stateOf(sessionId) {
    const id = String(sessionId ?? '')
    return {
      sessionId: id,
      defaultLevel: this.permissions.defaultLevelOf(id),
      activeWindowId: this.session(id).activeWindowId,
      windows: this.listWindows(id),
    }
  }

  /** Client 上报窗口状态。 */
  report(sessionId, report, workspaceKey = DEFAULT_WORKSPACE) {
    const state = this.session(sessionId)
    if (report === null || typeof report !== 'object') return
    if (typeof report.connected === 'boolean') state.connected = report.connected
    if (typeof report.activeWindowId === 'string') state.activeWindowId = report.activeWindowId.slice(0, 128)
    if (Array.isArray(report.windows)) {
      state.windows = report.windows.map((window, index) => ({
        id: shortString(window?.id, 128) || `w${index + 1}`,
        url: shortString(window?.url, MAX_URL_LENGTH),
        title: shortString(window?.title, MAX_TITLE_LENGTH),
        ready: window?.ready === true,
        loading: window?.loading === true,
      }))
      // 硬逻辑：窗口所在站点的权限由名单决定；站点（主机名）变化时立即重算，不做继承。
      if (!(state.windowHosts instanceof Map)) state.windowHosts = new Map()
      const seen = new Set()
      for (const window of state.windows) {
        if (window.url === '') continue
        let host = ''
        try {
          host = new URL(window.url).hostname.toLowerCase()
        } catch {
          host = ''
        }
        if (host === '') continue
        seen.add(window.id)
        if (state.windowHosts.get(window.id) === host) continue
        state.windowHosts.set(window.id, host)
        this.permissions.setWindowLevel(String(sessionId ?? ''), window.id, this.sitePolicies.levelFor(window.url, workspaceKey))
      }
      for (const id of [...state.windowHosts.keys()]) {
        if (!seen.has(id)) state.windowHosts.delete(id)
      }
      if (!(state.windowUrls instanceof Map)) state.windowUrls = new Map()
      for (const window of state.windows) {
        if (window.url === '' || !/^https?:\/\//i.test(window.url)) continue
        if (state.windowUrls.get(window.id) === window.url) continue
        state.windowUrls.set(window.id, window.url)
        this.library.addHistory(workspaceKey, window.title, window.url)
      }
      for (const id of [...state.windowUrls.keys()]) {
        if (!state.windows.some((window) => window.id === id)) state.windowUrls.delete(id)
      }
      if (!state.windows.some((window) => window.id === state.activeWindowId)) {
        state.activeWindowId = state.windows[0]?.id ?? ''
      }
    }
  }

  poll(sessionId, cursor) {
    const state = this.session(sessionId)
    const from = Number.isFinite(cursor) && cursor >= 0 ? Math.floor(cursor) : 0
    const collect = () => ({
      cursor: state.sequence,
      commands: state.commands.filter((command) => command.seq > from),
    })
    if (state.sequence > from) return Promise.resolve(collect())
    return new Promise((resolve) => {
      const waiter = {
        wake: () => {
          clearTimeout(waiter.timer)
          state.pollWaiters.delete(waiter)
          resolve(collect())
        },
        timer: setTimeout(() => {
          state.pollWaiters.delete(waiter)
          resolve({ cursor: state.sequence, commands: [] })
        }, POLL_TIMEOUT_MS),
      }
      state.pollWaiters.add(waiter)
    })
  }

  pruneCommands(state) {
    if (state.commands.length <= MAX_BUFFERED_COMMANDS) return
    state.commands.splice(0, state.commands.length - MAX_BUFFERED_COMMANDS)
  }

  /**
   * 下发命令并等待回执。
   * @param {string} sessionId
   * @param {string} op
   * @param {object} args
   * @param {{signal?:AbortSignal, timeoutMs?:number, windowId?:string}} [options]
   */
  run(sessionId, op, args, options = {}) {
    if (this.disposed) return Promise.reject(new BrowserBridgeError('FAILED', '插件正在卸载'))
    const id = String(sessionId ?? '')
    if (id === '') return Promise.reject(new BrowserBridgeError('PROTOCOL', '缺少 sessionId'))
    const state = this.session(id)
    if (!state.connected) {
      return Promise.reject(
        new BrowserBridgeError(
          'NOT_CONNECTED',
          'AI 浏览器面板没有打开或还没有窗口。请让用户在该会话右侧打开 AI 浏览器面板后再试。',
        ),
      )
    }
    if (state.windows.length === 0 && op !== 'new_window' && op !== 'windows') {
      return Promise.reject(new BrowserBridgeError('NO_WINDOW', '浏览器面板还没有打开的窗口，可先 new_window 新建窗口。'))
    }
    let windowId = typeof options.windowId === 'string' && options.windowId !== '' ? options.windowId : ''
    if (state.windows.length > 0) {
      if (windowId === '') {
        const active = state.windows.find((window) => window.id === state.activeWindowId)
        windowId = active?.id ?? state.windows[0]?.id ?? ''
      }
      if (windowId !== '' && !state.windows.some((window) => window.id === windowId)) {
        return Promise.reject(new BrowserBridgeError('NO_WINDOW', `浏览器窗口 ${windowId} 不存在`))
      }
    } else {
      windowId = ''
    }
    const signal = options.signal
    if (signal !== undefined && signal.aborted) {
      return Promise.reject(new BrowserBridgeError('ABORTED', '浏览器操作已取消'))
    }
    const timeoutMs =
      typeof options.timeoutMs === 'number' && options.timeoutMs > 0 ? options.timeoutMs : HOST_TIMEOUT_MS
    const seq = ++state.sequence
    const command = {
      seq,
      id: `cmd-${seq}-${Date.now().toString(36)}`,
      op,
      args: { ...(args !== null && typeof args === 'object' ? args : {}), window: windowId },
      at: Date.now(),
    }
    state.commands.push(command)
    this.pruneCommands(state)
    state.wakePollers()

    return new Promise((resolve) => {
      const finish = (value) => {
        const entry = state.pending.get(command.id)
        if (entry === undefined) return
        state.pending.delete(command.id)
        clearTimeout(entry.timer)
        if (signal !== undefined) signal.removeEventListener('abort', onAbort)
        resolve(value)
      }
      const onAbort = () => finish({ ok: false, error: { code: 'ABORTED', message: '浏览器操作已取消' } })
      const timer = setTimeout(() => {
        finish({
          ok: false,
          error: { code: 'TIMEOUT', message: '浏览器面板在限定时间内没有响应，可能页面卡住或面板已关闭。' },
        })
      }, timeoutMs)
      state.pending.set(command.id, { resolve: finish, timer })
      if (signal !== undefined) signal.addEventListener('abort', onAbort, { once: true })
    })
  }

  settle(sessionId, commandId, payload) {
    const state = this.sessions.get(String(sessionId ?? ''))
    if (state === undefined) return false
    const entry = state.pending.get(String(commandId))
    if (entry === undefined) return false
    const ok = payload !== null && typeof payload === 'object' && payload.ok === true
    const value = ok && payload.value !== null && typeof payload.value === 'object' ? payload.value : undefined
    const error =
      !ok && payload !== null && typeof payload === 'object' && payload.error !== null && typeof payload.error === 'object'
        ? { code: String(payload.error.code ?? 'FAILED'), message: String(payload.error.message ?? '浏览器操作失败') }
        : undefined
    entry.resolve({ ok, ...(value === undefined ? {} : { value }), ...(error === undefined ? {} : { error }) })
    return true
  }

  /**
   * 解析当前会话工作区的下载目录（`<cwd>/browser download`），失败时回退到
   * `$DSH_HOME/storages/dsh-ai-browser/downloads`。
   * @returns {Promise<{dir:string, baseDir:string, fallback:boolean}>}
   */
  async resolveDownloadDir(sessionId) {
    let baseDir = ''
    const services = this.hostServices
    if (services !== null && services !== undefined) {
      try {
        const agent = services.agents?.get?.(String(sessionId ?? ''))
        if (agent !== undefined && agent !== null && services.workingDirectory !== undefined) {
          baseDir = await services.workingDirectory.ensure(agent)
        }
      } catch {
        baseDir = ''
      }
    }
    const usable = typeof baseDir === 'string' && baseDir !== ''
    const dir = usable ? path.join(baseDir, 'browser download') : path.join(process.env.DSH_HOME ?? '', 'storages', 'dsh-ai-browser', 'downloads')
    fs.mkdirSync(dir, { recursive: true })
    return { dir, baseDir: usable ? baseDir : dir, fallback: !usable }
  }

  /**
   * 把字节写入会话下载目录。
   * @returns {{path:string,name:string,bytes:number}}
   */
  writeDownloadBytes(dir, name, bytes) {
    const fallback = `download-${Date.now().toString(36)}.bin`
    const safeName = sanitizeFileName(shortString(name, 200), fallback)
    const target = uniquePath(dir, safeName)
    fs.writeFileSync(target, bytes)
    return { path: target, name: path.basename(target), bytes: bytes.length }
  }

  /**
   * 保存 Client 上交的下载数据（页面内取回的字节）。
   * @returns {Promise<{path:string,name:string,bytes:number}>}
   */
  async saveDownload(sessionId, payload) {
    const data = payload !== null && typeof payload === 'object' && typeof payload.data === 'string' ? payload.data : ''
    if (data === '') throw new BrowserBridgeError('PROTOCOL', '下载数据为空')
    const bytes = Buffer.from(data, 'base64')
    if (bytes.length === 0) throw new BrowserBridgeError('PROTOCOL', '下载数据为空')
    if (bytes.length > MAX_DOWNLOAD_BYTES) throw new BrowserBridgeError('TOO_LARGE', '下载文件超过 128MB 上限')
    const { dir } = await this.resolveDownloadDir(sessionId)
    return this.writeDownloadBytes(dir, payload.name, bytes)
  }

  /**
   * Host 直连下载：绕过页面跨域限制（CORS），流式写入工作区。
   * 适用公开文件 CDN；不携带页面登录凭据。
   * @returns {Promise<{path:string,name:string,bytes:number,contentType:string,url:string}>}
   */
  async fetchDownload(sessionId, payload) {
    const url = assertFetchableUrl(payload?.url)
    const { dir } = await this.resolveDownloadDir(sessionId)
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), FETCH_DOWNLOAD_TIMEOUT_MS)
    try {
      const response = await fetch(url.href, {
        redirect: 'follow',
        signal: controller.signal,
        headers: { 'user-agent': DOWNLOAD_USER_AGENT, accept: '*/*' },
      })
      if (!response.ok || response.body === null) {
        throw new BrowserBridgeError('DOWNLOAD_FAILED', `下载失败：HTTP ${response.status} ${response.statusText}`.trim())
      }
      const declared = Number(response.headers.get('content-length') ?? '0')
      if (Number.isFinite(declared) && declared > MAX_FETCH_DOWNLOAD_BYTES) {
        throw new BrowserBridgeError('TOO_LARGE', '文件超过 512MB 上限')
      }
      const contentType = response.headers.get('content-type') ?? 'application/octet-stream'
      const requested = sanitizeFileName(shortString(payload?.filename, 200), '')
      const name = requested !== '' ? requested : fileNameFromResponse(url.href, response, `download-${Date.now().toString(36)}.bin`)
      const safeName = sanitizeFileName(name, 'download.bin')
      const target = uniquePath(dir, safeName)
      let bytes = 0
      const source = Readable.fromWeb(response.body)
      source.on('data', (chunk) => {
        bytes += chunk.length
        if (bytes > MAX_FETCH_DOWNLOAD_BYTES) {
          source.destroy(new BrowserBridgeError('TOO_LARGE', '文件超过 512MB 上限'))
        }
      })
      await pipeline(source, fs.createWriteStream(target))
      return { path: target, name: path.basename(target), bytes, contentType, url: url.href }
    } catch (error) {
      if (error instanceof BrowserBridgeError) throw error
      const message = error instanceof Error ? error.message : String(error)
      throw new BrowserBridgeError('DOWNLOAD_FAILED', `下载失败：${message}`)
    } finally {
      clearTimeout(timer)
    }
  }

  /**
   * 列出当前会话工作区下载目录中的文件。
   * @returns {Promise<{folderPath:string, files:Array<{name:string,path:string,bytes:number,mtime:number}>, fallback:boolean}>}
   */
  async listDownloads(sessionId) {
    const { dir, fallback } = await this.resolveDownloadDir(sessionId)
    let names = []
    try {
      names = fs.readdirSync(dir)
    } catch {
      names = []
    }
    const files = []
    for (const name of names) {
      try {
        const target = path.join(dir, name)
        const stat = fs.statSync(target)
        if (!stat.isFile()) continue
        files.push({ name, path: target, bytes: stat.size, mtime: stat.mtimeMs })
      } catch {
        /* 单个文件读取失败忽略 */
      }
    }
    files.sort((a, b) => b.mtime - a.mtime)
    return { folderPath: dir, files: files.slice(0, 200), fallback }
  }

  dispose() {
    this.disposed = true
    for (const state of this.sessions.values()) {
      for (const [id, entry] of state.pending) {
        clearTimeout(entry.timer)
        entry.resolve({ ok: false, error: { code: 'FAILED', message: '插件已卸载，浏览器操作被取消' } })
        state.pending.delete(id)
      }
      state.wakePollers()
    }
    this.permissions.dispose()
  }
}

/** 进程内共享单例：Host 行与 preset 行引用同一个实例。 */
export const runtime = new AiBrowserRuntime()

if (typeof process !== 'undefined' && typeof process.on === 'function') {
  process.once('exit', () => {
    try {
      runtime.dispose()
    } catch {
      /* 退出路径忽略 */
    }
  })
}

export { DEFAULT_LEVEL }
