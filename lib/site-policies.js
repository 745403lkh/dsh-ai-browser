/**
 * 站点名单（v2）：按「工作区」隔离，四个权限档位各维护一份网址名单，
 * 每个网址带「无需授权访问」开关。
 *
 * 匹配是硬逻辑：
 * - 写 `baidu.com`（没有子域前缀）→ 匹配 baidu.com 本身及所有子域
 *   （www.baidu.com / fanyi.baidu.com 都生效）。
 * - 写 `www.baidu.com`（带前缀）→ 只精确匹配该主机（不受其它子域影响）。
 * - 写路径 `www.baidu.com/xyz` → 匹配该路径及其下级路径
 *   （www.baidu.com/xyz、www.baidu.com/xyz/xxx），不匹配 /xyz2。
 * - 不在任何名单中的站点：窗口权限按「仅可查看」处理，AI 打开必须申请授权。
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { aiBrowserDataDir } from './home.js'
import { PERMISSION_LEVELS as LEVELS } from './permissions.js'

const FILE_VERSION = 2
export const DEFAULT_WORKSPACE = '__default__'

function isWindows() {
  return process.platform === 'win32'
}

/** 工作区目录 → 稳定 key（Windows 不区分大小写）。 */
export function normalizeWorkspaceKey(workspaceDir) {
  const raw = typeof workspaceDir === 'string' ? workspaceDir.trim() : ''
  if (raw === '') return DEFAULT_WORKSPACE
  try {
    const resolved = path.resolve(raw)
    return isWindows() ? resolved.toLowerCase() : resolved
  } catch {
    return raw
  }
}

function isIpHost(host) {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host === 'localhost' || host.includes(':')
}

/** 解析用户输入，得到 host / path / 是否子域通配；非法返回 null。 */
export function parseSiteEntry(input) {
  const raw = typeof input === 'string' ? input.trim() : ''
  if (raw === '' || raw.length > 1024) return null
  let candidate = raw
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(candidate)) candidate = 'https://' + candidate
  try {
    const parsed = new URL(candidate)
    const host = parsed.hostname.toLowerCase().replace(/\.$/, '')
    if (host === '' || host.includes(' ') || host.includes('..')) return null
    let pathName = parsed.pathname
    if (pathName === '/') pathName = ''
    pathName = pathName.replace(/\/+$/, '')
    const suffix = !isIpHost(host) && host.split('.').length <= 2
    return { raw, host, path: pathName, suffix }
  } catch {
    return null
  }
}

/** 兼容旧接口：只取主机名。 */
export function normalizeHost(input) {
  const entry = parseSiteEntry(input)
  return entry === null ? '' : entry.host
}

function emptyLists() {
  const lists = {}
  for (const level of LEVELS) lists[level] = []
  return lists
}

function entryKey(entry) {
  return entry.host + (entry.path === '' ? '' : entry.path)
}

function matches(entry, urlHost, urlPath) {
  const hostOk = entry.suffix === true ? urlHost === entry.host || urlHost.endsWith('.' + entry.host) : urlHost === entry.host
  if (!hostOk) return false
  if (entry.path === '') return true
  const currentPath = urlPath === '' ? '/' : urlPath
  return currentPath === entry.path || currentPath.startsWith(entry.path + '/')
}

export class SitePolicyStore {
  constructor(filePath) {
    this.filePath = filePath ?? path.join(aiBrowserDataDir(), 'sites.json')
    /** @type {Map<string, object>} workspaceKey -> lists */
    this.workspaces = new Map()
    this.loaded = false
    this.writeTimer = null
  }

  load() {
    if (this.loaded) return
    this.loaded = true
    try {
      const parsed = JSON.parse(fs.readFileSync(this.filePath, 'utf8'))
      if (parsed === null || typeof parsed !== 'object') return
      if (parsed.version === FILE_VERSION && parsed.workspaces !== null && typeof parsed.workspaces === 'object') {
        for (const [key, value] of Object.entries(parsed.workspaces)) {
          const lists = emptyLists()
          for (const level of LEVELS) {
            const entries = value?.[level]
            if (!Array.isArray(entries)) continue
            for (const item of entries) {
              const entry = parseSiteEntry(item?.raw)
              if (entry === null) continue
              lists[level].push({ ...entry, noAuth: item?.noAuth === true })
            }
          }
          this.workspaces.set(key, lists)
        }
        return
      }
      // v1 全局名单迁移到默认工作区
      if (parsed.version === 1 && parsed.lists !== null && typeof parsed.lists === 'object') {
        const lists = emptyLists()
        for (const level of LEVELS) {
          const entries = parsed.lists[level]
          if (!Array.isArray(entries)) continue
          for (const item of entries) {
            const entry = parseSiteEntry(item?.host)
            if (entry === null) continue
            lists[level].push({ ...entry, noAuth: item?.noAuth === true })
          }
        }
        this.workspaces.set(DEFAULT_WORKSPACE, lists)
        this.persist()
      }
    } catch {
      /* 不存在或损坏时按空状态 */
    }
  }

  ensure(workspaceKey) {
    this.load()
    const key = typeof workspaceKey === 'string' && workspaceKey !== '' ? workspaceKey : DEFAULT_WORKSPACE
    let lists = this.workspaces.get(key)
    if (lists === undefined) {
      lists = emptyLists()
      this.workspaces.set(key, lists)
    }
    return lists
  }

  persist() {
    if (this.writeTimer !== null) clearTimeout(this.writeTimer)
    this.writeTimer = setTimeout(() => {
      this.writeTimer = null
      try {
        fs.mkdirSync(path.dirname(this.filePath), { recursive: true })
        const workspaces = {}
        for (const [key, lists] of this.workspaces) {
          workspaces[key] = {}
          for (const level of LEVELS) {
            workspaces[key][level] = lists[level].map((entry) => ({ raw: entry.raw, noAuth: entry.noAuth === true }))
          }
        }
        fs.writeFileSync(this.filePath, JSON.stringify({ version: FILE_VERSION, workspaces }, null, 2) + '\n', 'utf8')
      } catch {
        /* 忽略持久化失败 */
      }
    }, 200)
    if (typeof this.writeTimer.unref === 'function') this.writeTimer.unref()
  }

  /** 名单快照（深拷贝），entries 带 raw/host/path/noAuth。 */
  snapshot(workspaceKey = DEFAULT_WORKSPACE) {
    const lists = this.ensure(workspaceKey)
    const result = {}
    for (const level of LEVELS) {
      result[level] = lists[level].map((entry) => ({ raw: entry.raw, host: entry.host, path: entry.path, noAuth: entry.noAuth === true }))
    }
    return result
  }

  /** 查找匹配的条目：越具体（精确主机 > 子域通配；更长路径）优先。 */
  lookup(urlOrHost, workspaceKey = DEFAULT_WORKSPACE) {
    const target = parseSiteEntry(urlOrHost)
    if (target === null) return null
    const lists = this.ensure(workspaceKey)
    let best = null
    let bestScore = -1
    for (const level of LEVELS) {
      for (const entry of lists[level]) {
        if (!matches(entry, target.host, target.path)) continue
        const score = entry.path.length * 10 + (entry.suffix === true ? 0 : 1000) + entry.host.length
        if (score > bestScore) {
          bestScore = score
          best = { host: entry.host, path: entry.path, level, noAuth: entry.noAuth === true }
        }
      }
    }
    return best
  }

  /** 按网址得到窗口权限级别（未命中按仅可查看）。 */
  levelFor(urlOrHost, workspaceKey = DEFAULT_WORKSPACE) {
    const policy = this.lookup(urlOrHost, workspaceKey)
    return policy === null ? 'view' : policy.level
  }

  /** 新增/更新站点；同名条目会从其它档位移除（一个条目只属于一个名单）。 */
  setHost(level, urlOrHost, noAuth, workspaceKey = DEFAULT_WORKSPACE) {
    const entry = parseSiteEntry(urlOrHost)
    if (entry === null) throw new Error('网址无效')
    if (!LEVELS.includes(level)) throw new Error('无效的权限档位')
    const lists = this.ensure(workspaceKey)
    const key = entryKey(entry)
    for (const name of LEVELS) {
      lists[name] = lists[name].filter((item) => entryKey(item) !== key)
    }
    lists[level].push({ ...entry, noAuth: noAuth === true })
    this.persist()
    return { raw: entry.raw, host: entry.host, path: entry.path, level, noAuth: noAuth === true }
  }

  /** 用一组名单替换（或合并）工作区名单；entries 为 {raw,noAuth}。 */
  replaceLists(lists, workspaceKey = DEFAULT_WORKSPACE, replace = true) {
    const target = this.ensure(workspaceKey)
    if (replace === true) {
      for (const level of LEVELS) target[level] = []
    }
    if (lists === null || typeof lists !== 'object') {
      this.persist()
      return
    }
    for (const level of LEVELS) {
      const entries = Array.isArray(lists[level]) ? lists[level] : []
      for (const item of entries) {
        const entry = parseSiteEntry(item?.raw ?? item?.host)
        if (entry === null) continue
        const key = entryKey(entry)
        if (LEVELS.some((name) => target[name].some((existing) => entryKey(existing) === key))) continue
        target[level].push({ ...entry, noAuth: item?.noAuth === true })
      }
    }
    this.persist()
  }

  /** 工作区是否已有任一站点名单（用于决定是否自动套默认预设）。 */
  isInitialized(workspaceKey = DEFAULT_WORKSPACE) {
    const lists = this.ensure(workspaceKey)
    return LEVELS.some((level) => lists[level].length > 0)
  }

  removeHost(urlOrHost, workspaceKey = DEFAULT_WORKSPACE) {
    const entry = parseSiteEntry(urlOrHost)
    if (entry === null) return false
    const lists = this.ensure(workspaceKey)
    const key = entryKey(entry)
    let removed = false
    for (const name of LEVELS) {
      const before = lists[name].length
      lists[name] = lists[name].filter((item) => entryKey(item) !== key)
      if (lists[name].length !== before) removed = true
    }
    if (removed) this.persist()
    return removed
  }
}
