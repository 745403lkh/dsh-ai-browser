/**
 * 浏览器下载的 Host 侧实现（1.0.0-beta.3 修复版）。
 *
 * 关键点：大文件（例如 248MB 的微信安装包）单次 HTTP 连接经常在几十 MB 处被
 * 中断/超时，所以这里实现「写到 .part + HTTP Range 断点续传 + Content-Length
 * 总大小校验」：每次最多跑 120 秒，断了就从已有字节处继续，直到字节数达到服务
 * 端声明的总大小才改名为最终文件。这样不会再把不完整的文件当成下载成功。
 *
 * 单独成模块（而不是塞进 runtime.js）的原因：Host 插件热更新时新模块能被重新
 * 加载，已经缓存的 runtime 单例则不会；把修复放在这里可以在不重启 DSH 的情况下
 * 生效。
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'

import { runtime } from './runtime.js'

export const MAX_DOWNLOAD_BYTES = 512 * 1024 * 1024
const ATTEMPT_TIMEOUT_MS = 120000
const MAX_ATTEMPTS = 40
const MAX_TOTAL_MS = 30 * 60000
const MAX_STALLED_ATTEMPTS = 4
const MAX_FILENAME_LENGTH = 180
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36 Edg/151.0.0.0'

/** Host 侧提供的能力标识（/health 使用）。 */
export const DOWNLOAD_FEATURES = ['download-url', 'downloads', 'download-dir', 'download-resume', 'download-progress', 'download-open']

/** 正在进行的下载任务（供 /downloads 实时显示进度、速度）。 */
const ACTIVE_DOWNLOADS = new Map()
let downloadSequence = 0

function nowMs() {
  return Date.now()
}

function createJob(sessionId, name, url) {
  const job = {
    id: `dl-${++downloadSequence}`,
    sessionId,
    name: typeof name === 'string' && name !== '' ? name : 'download',
    url: typeof url === 'string' ? url : '',
    path: '',
    bytes: 0,
    total: null,
    speed: 0,
    status: 'downloading',
    error: null,
    startedAt: nowMs(),
    updatedAt: nowMs(),
    samples: [],
  }
  ACTIVE_DOWNLOADS.set(job.id, job)
  return job
}

function noteProgress(job, bytes, total) {
  if (job === undefined || job === null) return
  if (typeof total === 'number' && Number.isFinite(total) && total > 0) job.total = total
  job.bytes = Math.max(0, Math.floor(bytes))
  job.updatedAt = nowMs()
  const samples = job.samples
  samples.push({ t: job.updatedAt, b: job.bytes })
  while (samples.length > 2 && job.updatedAt - samples[0].t > 4000) samples.shift()
  const first = samples[0]
  const seconds = (job.updatedAt - first.t) / 1000
  if (seconds > 0.15) job.speed = Math.max(0, (job.bytes - first.b) / seconds)
}

function finishJob(job, status, error) {
  if (job === undefined || job === null) return
  job.status = status
  job.error = typeof error === 'string' ? error : null
  job.speed = 0
  job.updatedAt = nowMs()
  const timer = setTimeout(() => ACTIVE_DOWNLOADS.delete(job.id), status === 'done' ? 3000 : 45000)
  if (typeof timer.unref === 'function') timer.unref()
}

/** 正在下载的任务列表（/downloads 用）。 */
export function listActiveDownloads(sessionId) {
  const entries = []
  for (const job of ACTIVE_DOWNLOADS.values()) {
    if (job.sessionId !== sessionId) continue
    entries.push({
      id: job.id,
      name: job.name,
      url: job.url,
      bytes: job.bytes,
      total: job.total,
      speed: job.speed,
      status: job.status,
      error: job.error,
      startedAt: job.startedAt,
    })
  }
  entries.sort((a, b) => b.startedAt - a.startedAt)
  return entries
}


export class DownloadError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'DownloadError'
    this.code = code
  }
}

function sanitizeFileName(value, fallback) {
  const raw = typeof value === 'string' ? value.trim() : ''
  if (raw === '') return fallback
  const cleaned = raw
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_')
    .replace(/^\.+/, '')
    .slice(0, MAX_FILENAME_LENGTH)
    .trim()
  return cleaned === '' ? fallback : cleaned
}

function uniquePath(dir, name) {
  const parsed = path.parse(name)
  let candidate = path.join(dir, name)
  let index = 1
  while (fs.existsSync(candidate)) {
    candidate = path.join(dir, `${parsed.name} (${index})${parsed.ext}`)
    index += 1
    if (index > 999) break
  }
  return candidate
}

function isPrivateHostname(hostname) {
  const host = String(hostname).toLowerCase().replace(/^\[|\]$/g, '')
  if (['localhost', '0.0.0.0', '::1', '::', 'metadata.google.internal'].includes(host)) return true
  if (host.endsWith('.local') || host.endsWith('.internal')) return true
  const ipv4 = host.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/)
  if (ipv4 !== null) {
    const a = Number(ipv4[1])
    const b = Number(ipv4[2])
    if (a === 10 || a === 127 || a === 0) return true
    if (a === 169 && b === 254) return true
    if (a === 172 && b >= 16 && b <= 31) return true
    if (a === 192 && b === 168) return true
    if (a === 100 && b >= 64 && b <= 127) return true
    return false
  }
  if (host.includes(':') && (host.startsWith('fc') || host.startsWith('fd') || host.startsWith('fe8') || host.startsWith('fe9') || host.startsWith('fea') || host.startsWith('feb'))) return true
  return false
}

/** 校验下载直连 URL（禁止本机/内网地址，防 SSRF）。 */
export function assertFetchableUrl(value) {
  let url
  try {
    url = new URL(String(value))
  } catch {
    throw new DownloadError('PROTOCOL', '下载地址无效')
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new DownloadError('PROTOCOL', '下载只支持 http/https 地址')
  if (url.username !== '' || url.password !== '') throw new DownloadError('PROTOCOL', '下载地址不能包含用户名或密码')
  if (isPrivateHostname(url.hostname)) throw new DownloadError('PROTOCOL', '出于安全考虑，不能直连下载本机/内网地址')
  return url
}

/** 解析会话工作区的下载目录；工作区不可用时回退到 DSH 数据目录。 */
export async function resolveDownloadDir(sessionId) {
  let baseDir = ''
  try {
    const services = runtime.hostServices
    if (services !== null && services !== undefined) {
      const agent = services.agents?.get?.(String(sessionId ?? ''))
      if (agent !== undefined && agent !== null && services.workingDirectory !== undefined) {
        baseDir = await services.workingDirectory.ensure(agent)
      }
    }
  } catch {
    baseDir = ''
  }
  const usable = typeof baseDir === 'string' && baseDir !== ''
  const home = typeof process.env.DSH_HOME === 'string' && process.env.DSH_HOME !== '' ? process.env.DSH_HOME : path.join(os.homedir(), '.dsh')
  const dir = usable ? path.join(baseDir, 'browser download') : path.join(home, 'storages', 'dsh-ai-browser', 'downloads')
  fs.mkdirSync(dir, { recursive: true })
  return { dir, fallback: !usable }
}

/** 从 Content-Disposition 或 URL 推导文件名。 */
function filenameFromResponse(url, response, fallback) {
  const disposition = response.headers.get('content-disposition') ?? ''
  const encoded = disposition.match(/filename\*=UTF-8''([^;]+)/i)
  if (encoded !== null) {
    try {
      return decodeURIComponent(encoded[1].trim().replace(/^"|"$/g, ''))
    } catch {
      /* 继续 */
    }
  }
  const plain = disposition.match(/filename\s*=\s*"?([^";]+)"?/i)
  if (plain !== null && plain[1].trim() !== '') return plain[1].trim()
  try {
    const pathname = new URL(url).pathname
    const base = pathname.slice(pathname.lastIndexOf('/') + 1)
    const decoded = decodeURIComponent(base)
    if (decoded !== '') return decoded
  } catch {
    /* 忽略 */
  }
  return fallback
}

/** 一次 HTTP 尝试：把响应体追加/写入 .part 文件。返回本次结束后的状态。 */
async function downloadOnce(url, partPath, offset, onBytes) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), ATTEMPT_TIMEOUT_MS)
  let response
  try {
    const headers = { 'user-agent': USER_AGENT, accept: '*/*' }
    if (offset > 0) headers.range = `bytes=${offset}-`
    response = await fetch(url, { redirect: 'follow', signal: controller.signal, headers })
    if (response.status === 416) {
      return { total: offset, attemptBytes: 0, status: 416 }
    }
    if (!response.ok) {
      throw new DownloadError('DOWNLOAD_FAILED', `下载失败：HTTP ${response.status} ${response.statusText}`.trim())
    }
    const isPartial = response.status === 206
    const contentRange = response.headers.get('content-range') ?? ''
    const rangeMatch = contentRange.match(/\/(\d+)$/)
    let total = null
    const declared = Number(response.headers.get('content-length') ?? '0')
    if (rangeMatch !== null) total = Number(rangeMatch[1])
    else if (isPartial && Number.isFinite(declared)) total = offset + declared
    else if (Number.isFinite(declared) && declared > 0) total = declared
    if (total !== null && total > MAX_DOWNLOAD_BYTES) {
      throw new DownloadError('TOO_LARGE', '文件超过 512MB 上限')
    }
    // 服务器忽略了 Range（返回 200）时只能从头写
    const append = isPartial && offset > 0
    const startOffset = append ? offset : 0
    if (typeof onBytes === 'function') onBytes(total, startOffset)
    let attemptBytes = 0
    const sink = fs.createWriteStream(partPath, { flags: append ? 'a' : 'w' })
    const source = Readable.fromWeb(response.body)
    source.on('data', (chunk) => {
      attemptBytes += chunk.length
      if (typeof onBytes === 'function') onBytes(total, startOffset + attemptBytes)
      if (startOffset + attemptBytes > MAX_DOWNLOAD_BYTES) source.destroy(new DownloadError('TOO_LARGE', '文件超过 512MB 上限'))
    })
    try {
      await pipeline(source, sink)
    } catch (error) {
      if (error instanceof DownloadError) throw error
      try {
        sink.destroy()
      } catch {
        /* 忽略 */
      }
      return { total, attemptBytes, status: response.status, interrupted: true, error: error instanceof Error ? error.message : String(error) }
    }
    return { total, attemptBytes, status: response.status }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Host 直连下载：Range 断点续传 + 大小校验，成功后写入工作区并返回路径。
 * 内部实现（runFetchDownload）由下面的 fetchDownload 包装，负责登记进度任务。
 */
async function runFetchDownload(sessionId, payload, job) {
  const url = assertFetchableUrl(payload?.url)
  const { dir, fallback } = await resolveDownloadDir(sessionId)
  const requested = sanitizeFileName(payload?.filename, '')
  const startedAt = Date.now()
  let total = null
  let finalPath = ''
  let partPath = ''

  const probeName = requested !== '' ? requested : filenameHintFallback(url.href)
  finalPath = uniquePath(dir, sanitizeFileName(probeName, `download-${Date.now().toString(36)}.bin`))
  partPath = `${finalPath}.part`
  job.name = path.basename(finalPath)
  job.path = finalPath
  job.url = url.href
  noteProgress(job, 0)

  let stalled = 0
  let lastSize = -1
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    if (Date.now() - startedAt > MAX_TOTAL_MS) break
    let offset = 0
    try {
      offset = fs.existsSync(partPath) ? fs.statSync(partPath).size : 0
    } catch {
      offset = 0
    }
    const result = await downloadOnce(url.href, partPath, offset, (declaredTotal, bytes) => noteProgress(job, bytes, declaredTotal))
    if (result.total !== null) total = result.total
    if (total !== null) job.total = total
    let size = 0
    try {
      size = fs.existsSync(partPath) ? fs.statSync(partPath).size : 0
    } catch {
      size = 0
    }
    noteProgress(job, size, total)
    if (total !== null && size >= total) {
      try {
        fs.rmSync(finalPath, { force: true })
        fs.renameSync(partPath, finalPath)
      } catch (error) {
        throw new DownloadError('DOWNLOAD_FAILED', `下载完成但保存失败：${error instanceof Error ? error.message : String(error)}`)
      }
      job.path = finalPath
      return {
        path: finalPath,
        name: path.basename(finalPath),
        bytes: size,
        total,
        contentType: null,
        url: url.href,
        fallback,
        attempts: attempt,
      }
    }
    const interrupted = result.interrupted === true
    if (size <= lastSize) stalled += 1
    else stalled = 0
    lastSize = size
    if (stalled >= MAX_STALLED_ATTEMPTS) {
      const sizeNow = fs.existsSync(partPath) ? fs.statSync(partPath).size : 0
      throw new DownloadError(
        'DOWNLOAD_FAILED',
        `下载中断且无法继续（已下载 ${(sizeNow / 1048576).toFixed(1)}MB${total === null ? '' : ` / ${(total / 1048576).toFixed(1)}MB`}）${interrupted ? `：${result.error ?? ''}` : ''}`,
      )
    }
    await new Promise((resolve) => setTimeout(resolve, interrupted ? 800 : 200))
  }
  const sizeNow = fs.existsSync(partPath) ? fs.statSync(partPath).size : 0
  throw new DownloadError(
    'DOWNLOAD_FAILED',
    `下载未完成（已下载 ${(sizeNow / 1048576).toFixed(1)}MB${total === null ? '' : ` / ${(total / 1048576).toFixed(1)}MB`}），请稍后重试；临时文件保留为 ${path.basename(partPath)}`,
  )
}

/**
 * 下载入口：登记进度任务（供下载面板显示进度条/速度），并负责结束状态。
 */
export async function fetchDownload(sessionId, payload) {
  const job = createJob(sessionId, payload?.filename, payload?.url)
  try {
    const saved = await runFetchDownload(sessionId, payload, job)
    noteProgress(job, saved.bytes, saved.total)
    finishJob(job, 'done')
    return { ...saved, id: job.id }
  } catch (error) {
    finishJob(job, 'error', error instanceof Error ? error.message : String(error))
    throw error
  }
}

function filenameHintFallback(url) {
  try {
    const pathname = new URL(url).pathname
    const base = decodeURIComponent(pathname.slice(pathname.lastIndexOf('/') + 1))
    return base === '' ? '' : base
  } catch {
    return ''
  }
}

/** 列出会话下载目录中的文件。 */
export async function listDownloads(sessionId) {
  const { dir, fallback } = await resolveDownloadDir(sessionId)
  let names = []
  try {
    names = fs.readdirSync(dir)
  } catch {
    names = []
  }
  const files = []
  for (const name of names) {
    if (name.endsWith('.part')) continue
    try {
      const target = path.join(dir, name)
      const stat = fs.statSync(target)
      if (!stat.isFile()) continue
      files.push({
        name,
        path: target,
        bytes: stat.size,
        mtime: stat.mtimeMs,
        partial: fs.existsSync(`${target}.part`),
      })
    } catch {
      /* 忽略单个文件错误 */
    }
  }
  files.sort((a, b) => b.mtime - a.mtime)
  return { folderPath: dir, files: files.slice(0, 200), active: listActiveDownloads(sessionId), fallback }
}

/** 校验一个文件确实位于该会话的下载目录内，返回真实路径。 */
export async function resolveDownloadPath(sessionId, rawPath) {
  const { dir } = await resolveDownloadDir(sessionId)
  let dirReal = dir
  try {
    dirReal = fs.realpathSync(dir)
  } catch {
    dirReal = dir
  }
  let targetReal = ''
  try {
    targetReal = fs.realpathSync(String(rawPath ?? ''))
  } catch {
    throw new DownloadError('NO_FILE', '文件不存在或已被移动')
  }
  const prefix = dirReal.endsWith(path.sep) ? dirReal : dirReal + path.sep
  if (targetReal !== dirReal && !targetReal.startsWith(prefix)) {
    throw new DownloadError('PROTOCOL', '只能打开下载目录里的文件')
  }
  let stat
  try {
    stat = fs.statSync(targetReal)
  } catch {
    throw new DownloadError('NO_FILE', '文件不存在或已被移动')
  }
  if (!stat.isFile()) throw new DownloadError('PROTOCOL', '只能打开文件')
  return { path: targetReal, dir: dirReal, bytes: stat.size }
}

/** 用系统默认程序打开下载目录里的文件。 */
export async function openDownload(sessionId, rawPath) {
  const target = await resolveDownloadPath(sessionId, rawPath)
  const command = process.platform === 'win32' ? 'explorer.exe' : process.platform === 'darwin' ? 'open' : 'xdg-open'
  const child = spawn(command, [target.path], { detached: true, stdio: 'ignore', windowsHide: true })
  child.on('error', () => {})
  child.unref()
  return { ok: true, path: target.path }
}

/** 保存 Client 上交的字节（页面内取回路径）。 */
export async function saveDownloadBytes(sessionId, payload) {
  const data = payload !== null && typeof payload === 'object' && typeof payload.data === 'string' ? payload.data : ''
  if (data === '') throw new DownloadError('PROTOCOL', '下载数据为空')
  const bytes = Buffer.from(data, 'base64')
  if (bytes.length === 0) throw new DownloadError('PROTOCOL', '下载数据为空')
  if (bytes.length > 128 * 1024 * 1024) throw new DownloadError('TOO_LARGE', '下载文件超过 128MB 上限')
  const { dir, fallback } = await resolveDownloadDir(sessionId)
  const safeName = sanitizeFileName(payload?.name, `download-${Date.now().toString(36)}.bin`)
  const target = uniquePath(dir, safeName)
  fs.writeFileSync(target, bytes)
  return { path: target, name: path.basename(target), bytes: bytes.length, fallback }
}
