/**
 * AI 浏览器面板使用的同源 HTTP 接口。
 *
 * 前缀 `/.dsh-ai-browser` 由 Host 的 webServer 注册；页面（client.js）用
 * `fetch('/.dsh-ai-browser/...')` 调用（Desktop 壳会把请求转发到 Host 并带 cookie）。
 *
 * 安全模型（默认拒绝）：
 * 1. 所有接口（含 GET）都必须携带本地客户端请求头 `x-dsh-ai-browser: 1`。
 *    跨站简单请求无法设置自定义头，本接口也从不返回 CORS 头。
 * 2. Host 必须是本机回环地址；请求带 Origin 时，Origin 也必须是回环或桌面壳协议。
 * 3. 只接受 POST（/health 除外），响应带 nosniff / no-referrer / no-store。
 */

import * as downloads from './downloads.js'
import { MAX_DOWNLOAD_BYTES } from './runtime.js'
import { normalizeLevel } from './permissions.js'

/** 路由前缀：与 client.js 中的常量保持一致。 */
export const ROUTE_PREFIX = '/.dsh-ai-browser'
/** 本地客户端必须携带的请求头。 */
export const CLIENT_HEADER = 'x-dsh-ai-browser'
export const CLIENT_HEADER_VALUE = '1'
/** 默认请求体上限。 */
const BODY_LIMIT_BYTES = 1024 * 1024
/** 下载请求体上限（base64 后比原始字节多约 1/3）。 */
const DOWNLOAD_BODY_LIMIT = Math.ceil((MAX_DOWNLOAD_BYTES * 4) / 3) + 1024 * 1024
const LOOPBACK_HOSTNAMES = new Set(['localhost', '127.0.0.1', '[::1]'])

function loopbackAuthority(authority) {
  try {
    const parsed = new URL(`http://${authority}`)
    if (!LOOPBACK_HOSTNAMES.has(parsed.hostname.toLowerCase())) return null
    return `loopback:${parsed.port === '' ? '80' : parsed.port}`
  } catch {
    return null
  }
}

function isTrustedRequest(request) {
  const host = request.headers.host
  const hostKey = host === undefined ? null : loopbackAuthority(host)
  if (hostKey === null) return false
  const origin = request.headers.origin
  if (origin === undefined || origin === '') return true
  try {
    const parsed = new URL(origin)
    if (parsed.protocol === 'dsh-app:') return true
    return loopbackAuthority(parsed.host) === hostKey
  } catch {
    return false
  }
}

function hasClientHeader(request) {
  const value = request.headers[CLIENT_HEADER]
  return typeof value === 'string' && value === CLIENT_HEADER_VALUE
}

function sendJson(response, status, body) {
  response.statusCode = status
  response.setHeader('content-type', 'application/json; charset=utf-8')
  response.setHeader('cache-control', 'no-store')
  response.setHeader('x-content-type-options', 'nosniff')
  response.setHeader('referrer-policy', 'no-referrer')
  response.end(JSON.stringify(body))
}

function readJsonBody(request, limitBytes) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    request.on('data', (chunk) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      size += buffer.length
      if (size > limitBytes) {
        reject(new Error('请求体过大'))
        request.destroy()
        return
      }
      chunks.push(buffer)
    })
    request.on('error', reject)
    request.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8').trim()
      if (text === '') return resolve({})
      try {
        const parsed = JSON.parse(text)
        if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
          reject(new Error('请求体必须是 JSON 对象'))
          return
        }
        resolve(parsed)
      } catch {
        reject(new Error('请求体不是合法 JSON'))
      }
    })
  })
}

function sessionIdOf(body) {
  const id = body.sessionId
  if (typeof id !== 'string' || id === '' || id.length > 256) throw new Error('缺少合法的 sessionId')
  return id
}

export function createRouteHandler(runtime, options = {}) {
  const version = typeof options.version === 'string' ? options.version : 'unknown'
  const featuresOption = options.features ?? []
  return async (request, response) => {
    try {
      if (!isTrustedRequest(request)) return sendJson(response, 403, { ok: false, error: 'forbidden' })
      if (!hasClientHeader(request)) return sendJson(response, 403, { ok: false, error: 'forbidden' })

      const url = new URL(request.url ?? '/', 'http://127.0.0.1')
      const path = url.pathname.slice(ROUTE_PREFIX.length) || '/'
      const method = request.method ?? 'GET'

      if (path === '/sites' && method === 'GET') {
        const querySessionId = url.searchParams.get('sessionId') ?? ''
        if (querySessionId === '') return sendJson(response, 400, { ok: false, error: '缺少 sessionId' })
        const workspace = await runtime.resolveWorkspace(querySessionId, true)
        return sendJson(response, 200, {
          ok: true,
          workspacePath: workspace.path,
          lists: runtime.sitePolicies.snapshot(workspace.key),
        })
      }

      if (path === '/health' && method === 'GET') {
        let features = []
        try {
          features = typeof featuresOption === 'function' ? featuresOption() : featuresOption
        } catch {
          features = []
        }
        return sendJson(response, 200, { ok: true, version, features: Array.isArray(features) ? features : [] })
      }
      if (method !== 'POST') return sendJson(response, 405, { ok: false, error: 'method not allowed' })

      const isDownload = path === '/download'
      const body = await readJsonBody(request, isDownload ? DOWNLOAD_BODY_LIMIT : BODY_LIMIT_BYTES)

      if (path === '/debug-workspace') {
        const sessionId = sessionIdOf(body)
        const debug = await runtime.debugWorkspace(sessionId)
        return sendJson(response, 200, { ok: true, ...debug })
      }

      if (path === '/policy') {
        const targetUrl = typeof body.url === 'string' ? body.url : ''
        const workspace = await runtime.resolveWorkspace(sessionIdOf(body), true)
        const policy = runtime.sitePolicies.lookup(targetUrl, workspace.key)
        return sendJson(response, 200, {
          ok: true,
          host: policy === null ? '' : policy.host,
          matched: policy !== null,
          level: policy === null ? 'view' : policy.level,
          noAuth: policy === null ? false : policy.noAuth === true,
        })
      }

      if (path === '/sites') {
        const action = typeof body.action === 'string' ? body.action : ''
        const workspace = await runtime.resolveWorkspace(sessionIdOf(body), true)
        try {
          if (action === 'set') {
            const saved = runtime.sitePolicies.setHost(body.level, body.host, body.noAuth === true, workspace.key)
            return sendJson(response, 200, {
              ok: true,
              workspacePath: workspace.path,
              lists: runtime.sitePolicies.snapshot(workspace.key),
              host: saved.host,
              level: saved.level,
              noAuth: saved.noAuth,
            })
          }
          if (action === 'remove') {
            runtime.sitePolicies.removeHost(body.host, workspace.key)
            return sendJson(response, 200, { ok: true, workspacePath: workspace.path, lists: runtime.sitePolicies.snapshot(workspace.key) })
          }
          return sendJson(response, 400, { ok: false, error: 'action 必须是 set / remove' })
        } catch (error) {
          return sendJson(response, 400, { ok: false, error: error instanceof Error ? error.message : String(error) })
        }
      }

      if (path === '/session') {
        const sessionId = sessionIdOf(body)
        return sendJson(response, 200, { ok: true, enabled: runtime.isBrowserSession(sessionId), ...runtime.stateOf(sessionId) })
      }

      if (path === '/level') {
        const sessionId = sessionIdOf(body)
        const windowId = typeof body.windowId === 'string' ? body.windowId : ''
        if (windowId === '') return sendJson(response, 400, { ok: false, error: '缺少 windowId' })
        const saved = runtime.setWindowLevel(sessionId, windowId, normalizeLevel(body.level))
        return sendJson(response, 200, { ok: true, level: saved, windowId })
      }

      if (path === '/report') {
        const sessionId = sessionIdOf(body)
        const workspace = await runtime.resolveWorkspace(sessionId)
        runtime.report(sessionId, body, workspace.key)
        return sendJson(response, 200, { ok: true })
      }

      if (path === '/poll') {
        const sessionId = sessionIdOf(body)
        const cursor = typeof body.cursor === 'number' ? body.cursor : 0
        const result = await runtime.poll(sessionId, cursor)
        return sendJson(response, 200, { ok: true, ...result })
      }

      if (path === '/result') {
        const sessionId = sessionIdOf(body)
        if (typeof body.id !== 'string' || body.id === '') return sendJson(response, 400, { ok: false, error: '缺少命令 id' })
        const accepted = runtime.settle(sessionId, body.id, { ok: body.ok === true, value: body.value, error: body.error })
        return sendJson(response, 200, { ok: true, accepted })
      }

      if (path === '/download') {
        const sessionId = sessionIdOf(body)
        const saved = await runtime.saveDownload(sessionId, body)
        return sendJson(response, 200, { ok: true, ...saved })
      }

      if (path === '/download-url') {
        const sessionId = sessionIdOf(body)
        const saved = await downloads.fetchDownload(sessionId, body)
        return sendJson(response, 200, { ok: true, ...saved })
      }

      if (path === '/downloads') {
        const sessionId = sessionIdOf(body)
        const listing = await downloads.listDownloads(sessionId)
        return sendJson(response, 200, { ok: true, ...listing })
      }

      if (path === '/download-control') {
        const sessionId = sessionIdOf(body)
        if (typeof body.id !== 'string' || body.id === '') return sendJson(response, 400, { ok: false, error: '缺少下载任务 id' })
        const action = body.action
        let job
        if (action === 'pause') job = downloads.pauseDownload(sessionId, body.id)
        else if (action === 'resume') job = downloads.resumeDownload(sessionId, body.id)
        else if (action === 'cancel') job = downloads.cancelDownload(sessionId, body.id)
        else return sendJson(response, 400, { ok: false, error: 'action 必须是 pause / resume / cancel' })
        return sendJson(response, 200, { ok: true, job })
      }

      if (path === '/open-download-folder') {
        const sessionId = sessionIdOf(body)
        const opened = await downloads.openDownloadFolder(sessionId)
        return sendJson(response, 200, { ok: true, ...opened })
      }

      if (path === '/open-download') {
        const sessionId = sessionIdOf(body)
        if (typeof body.path !== 'string' || body.path === '') return sendJson(response, 400, { ok: false, error: '缺少文件路径' })
        const opened = await downloads.openDownload(sessionId, body.path)
        return sendJson(response, 200, { ok: true, ...opened })
      }

      return sendJson(response, 404, { ok: false, error: 'not found' })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const code = error && typeof error.code === 'string' ? error.code : 'FAILED'
      console.error('[dsh-ai-browser] 路由处理失败：', message)
      if (response.headersSent) {
        response.destroy()
        return
      }
      sendJson(response, 400, { ok: false, error: { code, message } })
    }
  }
}
