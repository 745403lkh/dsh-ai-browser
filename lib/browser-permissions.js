/**
 * 浏览器权限状态的持久化存储（按会话 + 每窗口独立）。
 *
 * 文件结构（v2）：
 *   { version: 2, sessions: { [sessionId]: { default: 'view', windows: { [windowId]: 'simple' } } } }
 * v1（sessionId -> level）迁移为 default。
 *
 * 默认级别 view（仅可查看）；新窗口创建时由客户端继承当前激活窗口的级别。
 */

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

import { normalizeLevel } from './permissions.js'

/** 默认级别。 */
export const DEFAULT_LEVEL = 'view'

function resolveDshHome() {
  const fromEnv = process.env.DSH_HOME
  if (typeof fromEnv === 'string' && fromEnv !== '') return fromEnv
  return path.join(os.homedir(), '.dsh')
}

export class BrowserPermissionStore {
  constructor(filePath) {
    this.filePath =
      filePath ?? path.join(resolveDshHome(), 'storages', 'dsh-ai-browser', 'permissions.json')
    /** @type {Map<string, {default: string, windows: Map<string,string>}>} */
    this.sessions = new Map()
    this.loaded = false
    this.writeTimer = null
  }

  load() {
    if (this.loaded) return
    this.loaded = true
    try {
      const parsed = JSON.parse(fs.readFileSync(this.filePath, 'utf8'))
      if (parsed === null || typeof parsed !== 'object') return
      const sessions = parsed.sessions
      if (sessions === null || typeof sessions !== 'object') return
      for (const [sessionId, value] of Object.entries(sessions)) {
        if (typeof sessionId !== 'string' || sessionId === '') continue
        if (typeof value === 'string') {
          this.sessions.set(sessionId, { default: normalizeLevel(value), windows: new Map() })
          continue
        }
        if (value === null || typeof value !== 'object') continue
        const windows = new Map()
        if (value.windows !== null && typeof value.windows === 'object') {
          for (const [windowId, level] of Object.entries(value.windows)) {
            if (typeof windowId === 'string' && windowId !== '') windows.set(windowId, normalizeLevel(level))
          }
        }
        this.sessions.set(sessionId, { default: normalizeLevel(value.default), windows })
      }
    } catch {
      /* 不存在或损坏时按空状态 */
    }
  }

  entry(sessionId, create = false) {
    this.load()
    const id = String(sessionId ?? '')
    if (id === '') return undefined
    let entry = this.sessions.get(id)
    if (entry === undefined && create) {
      entry = { default: DEFAULT_LEVEL, windows: new Map() }
      this.sessions.set(id, entry)
    }
    return entry
  }

  /** 会话默认级别（新窗口的初始级别来源之一）。 */
  defaultLevelOf(sessionId) {
    return this.entry(sessionId)?.default ?? DEFAULT_LEVEL
  }

  /** 某窗口的级别；未知窗口回退到会话默认。 */
  levelOf(sessionId, windowId) {
    const entry = this.entry(sessionId)
    if (entry === undefined) return DEFAULT_LEVEL
    if (typeof windowId === 'string' && windowId !== '' && entry.windows.has(windowId)) {
      return entry.windows.get(windowId)
    }
    return entry.default
  }

  /** 设置某窗口级别。 */
  setWindowLevel(sessionId, windowId, level) {
    const entry = this.entry(sessionId, true)
    if (entry === undefined) throw new Error('缺少 sessionId')
    if (typeof windowId !== 'string' || windowId === '') throw new Error('缺少 windowId')
    const next = normalizeLevel(level)
    entry.windows.set(windowId, next)
    this.schedulePersist()
    return next
  }

  /** 删除窗口级别（窗口关闭）。 */
  deleteWindow(sessionId, windowId) {
    const entry = this.entry(sessionId)
    if (entry === undefined) return
    if (entry.windows.delete(windowId)) this.schedulePersist()
  }

  schedulePersist() {
    if (this.writeTimer !== null) return
    this.writeTimer = setTimeout(() => {
      this.writeTimer = null
      this.persist()
    }, 500)
    if (typeof this.writeTimer.unref === 'function') this.writeTimer.unref()
  }

  persist() {
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true })
      const sessions = {}
      for (const [sessionId, entry] of this.sessions.entries()) {
        const windows = {}
        for (const [windowId, level] of entry.windows.entries()) windows[windowId] = level
        sessions[sessionId] = { default: entry.default, windows }
      }
      const content = JSON.stringify({ version: 2, sessions }, null, 2)
      const temp = `${this.filePath}.tmp`
      fs.writeFileSync(temp, content, 'utf8')
      fs.renameSync(temp, this.filePath)
    } catch (error) {
      console.error('[dsh-ai-browser] 浏览器权限状态写入失败：', error)
    }
  }

  dispose() {
    if (this.writeTimer !== null) {
      clearTimeout(this.writeTimer)
      this.writeTimer = null
    }
    this.persist()
  }
}
