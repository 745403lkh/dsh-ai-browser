/**
 * 浏览器收藏与历史记录（v1，全局共享，按 `$DSH_HOME/storages/dsh-ai-browser/library.json` 持久化）。
 * 历史记录只在页面地址变化时写入，自动去重并限制总量。
 */

import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'

import { aiBrowserDataDir } from './home.js'
import { DEFAULT_WORKSPACE } from './site-policies.js'

const FILE_VERSION = 2
const MAX_HISTORY = 500

function newId() {
  return crypto.randomUUID()
}

function normalizeUrl(value) {
  return typeof value === 'string' ? value.trim().slice(0, 4096) : ''
}

function normalizeTitle(value) {
  return typeof value === 'string' ? value.trim().slice(0, 300) : ''
}

export class BrowserLibrary {
  constructor(filePath) {
    this.filePath = filePath ?? path.join(aiBrowserDataDir(), 'library.json')
    /** @type {Map<string, {bookmarks: Array<object>, history: Array<object>}>} */
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
      let workspaces = parsed.workspaces
      // v1 旧格式（全局 bookmarks/history）迁移到默认工作区
      if ((workspaces === null || typeof workspaces !== 'object') && (Array.isArray(parsed.bookmarks) || Array.isArray(parsed.history))) {
        workspaces = { [DEFAULT_WORKSPACE]: { bookmarks: parsed.bookmarks ?? [], history: parsed.history ?? [] } }
      }
      if (workspaces !== null && typeof workspaces === 'object') {
        for (const [key, value] of Object.entries(workspaces)) {
          const bucket = { bookmarks: [], history: [] }
          for (const item of Array.isArray(value?.bookmarks) ? value.bookmarks : []) {
            const url = normalizeUrl(item?.url)
            if (url === '') continue
            bucket.bookmarks.push({ id: String(item?.id ?? newId()), title: normalizeTitle(item?.title) || url, url, createdAt: Number(item?.createdAt) || Date.now() })
          }
          for (const item of Array.isArray(value?.history) ? value.history : []) {
            const url = normalizeUrl(item?.url)
            if (url === '') continue
            bucket.history.push({ id: String(item?.id ?? newId()), title: normalizeTitle(item?.title) || url, url, visitedAt: Number(item?.visitedAt) || Date.now() })
          }
          this.workspaces.set(String(key), bucket)
        }
      }
    } catch {
      /* 不存在或损坏时按空状态 */
    }
  }

  persist() {
    if (this.writeTimer !== null) clearTimeout(this.writeTimer)
    this.writeTimer = setTimeout(() => {
      this.writeTimer = null
      try {
        fs.mkdirSync(path.dirname(this.filePath), { recursive: true })
        const workspaces = {}
        for (const [key, value] of this.workspaces) workspaces[key] = { bookmarks: value.bookmarks, history: value.history }
        fs.writeFileSync(this.filePath, JSON.stringify({ version: FILE_VERSION, workspaces }, null, 2) + '\n', 'utf8')
      } catch {
        /* 忽略持久化失败 */
      }
    }, 150)
    if (typeof this.writeTimer.unref === 'function') this.writeTimer.unref()
  }

  bucket(workspaceKey) {
    this.load()
    const key = typeof workspaceKey === 'string' && workspaceKey !== '' ? workspaceKey : DEFAULT_WORKSPACE
    let bucket = this.workspaces.get(key)
    if (bucket === undefined) {
      bucket = { bookmarks: [], history: [] }
      this.workspaces.set(key, bucket)
    }
    return bucket
  }

  bookmarkOf(workspaceKey, url) {
    const target = normalizeUrl(url)
    if (target === '') return null
    return this.bucket(workspaceKey).bookmarks.find((item) => item.url === target) ?? null
  }

  addBookmark(workspaceKey, title, url) {
    const target = normalizeUrl(url)
    if (target === '' || !/^https?:\/\//i.test(target)) throw new Error('网址无效')
    const bucket = this.bucket(workspaceKey)
    const existing = bucket.bookmarks.find((item) => item.url === target)
    if (existing !== null && existing !== undefined) {
      existing.title = normalizeTitle(title) || existing.title
      this.persist()
      return existing
    }
    const entry = { id: newId(), title: normalizeTitle(title) || target, url: target, createdAt: Date.now() }
    bucket.bookmarks.unshift(entry)
    this.persist()
    return entry
  }

  removeBookmark(workspaceKey, idOrUrl) {
    const bucket = this.bucket(workspaceKey)
    const key = String(idOrUrl ?? '')
    const before = bucket.bookmarks.length
    bucket.bookmarks = bucket.bookmarks.filter((item) => item.id !== key && item.url !== normalizeUrl(key))
    if (bucket.bookmarks.length !== before) this.persist()
    return bucket.bookmarks.length !== before
  }

  addHistory(workspaceKey, title, url) {
    const target = normalizeUrl(url)
    if (target === '' || !/^https?:\/\//i.test(target)) return null
    const bucket = this.bucket(workspaceKey)
    const first = bucket.history[0]
    if (first !== undefined && first.url === target) {
      first.title = normalizeTitle(title) || first.title
      first.visitedAt = Date.now()
      this.persist()
      return first
    }
    const entry = { id: newId(), title: normalizeTitle(title) || target, url: target, visitedAt: Date.now() }
    bucket.history.unshift(entry)
    if (bucket.history.length > MAX_HISTORY) bucket.history.length = MAX_HISTORY
    this.persist()
    return entry
  }

  clearHistory(workspaceKey) {
    this.bucket(workspaceKey).history = []
    this.persist()
  }

  snapshot(workspaceKey) {
    const bucket = this.bucket(workspaceKey)
    return {
      bookmarks: bucket.bookmarks.map((item) => ({ ...item })),
      history: bucket.history.map((item) => ({ ...item })),
    }
  }
}
