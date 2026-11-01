/**
 * 权限预设（v1）：一组可复用的四档站点名单。
 * - 可创建多个预设、自定义名字、指定默认预设；
 * - 可一键把预设应用到某个工作区；
 * - 新工作区第一次使用浏览器模式时自动套用默认预设。
 *
 * 存储：`$DSH_HOME/storages/dsh-ai-browser/presets.json`。
 */

import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'

import { aiBrowserDataDir } from './home.js'
import { PERMISSION_LEVELS as LEVELS } from './permissions.js'
import { DEFAULT_WORKSPACE, parseSiteEntry } from './site-policies.js'

const FILE_VERSION = 1

function newId() {
  return crypto.randomUUID()
}

function emptyLists() {
  const lists = {}
  for (const level of LEVELS) lists[level] = []
  return lists
}

function normalizeName(value, fallback) {
  const name = typeof value === 'string' ? value.trim().slice(0, 60) : ''
  return name === '' ? fallback : name
}

/** 把客户端传来的名单规范化为 { level: [{raw,noAuth}] }。 */
export function normalizeLists(input) {
  const lists = emptyLists()
  if (input === null || typeof input !== 'object') return lists
  for (const level of LEVELS) {
    const entries = Array.isArray(input[level]) ? input[level] : []
    const seen = new Set()
    for (const item of entries) {
      const entry = parseSiteEntry(item?.raw ?? item?.host)
      if (entry === null) continue
      const key = entry.host + entry.path
      if (seen.has(key)) continue
      seen.add(key)
      lists[level].push({ raw: entry.raw, noAuth: item?.noAuth === true })
    }
  }
  return lists
}

export class PermissionPresetStore {
  constructor(filePath) {
    this.filePath = filePath ?? path.join(aiBrowserDataDir(), 'presets.json')
    this.presets = []
    this.defaultPresetId = ''
    /** @type {Set<string>} 已经初始化过（不再自动套预设）的工作区 key */
    this.initialized = new Set()
    this.loaded = false
    this.writeTimer = null
  }

  load() {
    if (this.loaded) return
    this.loaded = true
    try {
      const parsed = JSON.parse(fs.readFileSync(this.filePath, 'utf8'))
      if (parsed === null || typeof parsed !== 'object') return
      if (Array.isArray(parsed.presets)) {
        for (const item of parsed.presets) {
          const id = typeof item?.id === 'string' && item.id !== '' ? item.id : newId()
          if (this.presets.some((preset) => preset.id === id)) continue
          this.presets.push({ id, name: normalizeName(item?.name, '未命名预设'), lists: normalizeLists(item?.lists), createdAt: Number(item?.createdAt) || Date.now() })
        }
      }
      if (typeof parsed.defaultPresetId === 'string') this.defaultPresetId = parsed.defaultPresetId
      if (Array.isArray(parsed.initialized)) {
        for (const key of parsed.initialized) if (typeof key === 'string' && key !== '') this.initialized.add(key)
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
        fs.writeFileSync(
          this.filePath,
          JSON.stringify({ version: FILE_VERSION, presets: this.presets, defaultPresetId: this.defaultPresetId, initialized: [...this.initialized] }, null, 2) + '\n',
          'utf8',
        )
      } catch {
        /* 忽略持久化失败 */
      }
    }, 150)
    if (typeof this.writeTimer.unref === 'function') this.writeTimer.unref()
  }

  snapshot() {
    this.load()
    return {
      presets: this.presets.map((preset) => ({ id: preset.id, name: preset.name, lists: normalizeLists(preset.lists), createdAt: preset.createdAt })),
      defaultPresetId: this.defaultPresetId,
    }
  }

  create(name, lists) {
    this.load()
    const preset = { id: newId(), name: normalizeName(name, '未命名预设'), lists: normalizeLists(lists), createdAt: Date.now() }
    this.presets.push(preset)
    this.persist()
    return { id: preset.id, name: preset.name, lists: preset.lists, createdAt: preset.createdAt }
  }

  update(id, patch) {
    this.load()
    const preset = this.presets.find((item) => item.id === id)
    if (preset === undefined) throw new Error('预设不存在')
    if (typeof patch.name === 'string') preset.name = normalizeName(patch.name, preset.name)
    if (patch.lists !== undefined) preset.lists = normalizeLists(patch.lists)
    this.persist()
    return { id: preset.id, name: preset.name, lists: preset.lists, createdAt: preset.createdAt }
  }

  remove(id) {
    this.load()
    const before = this.presets.length
    this.presets = this.presets.filter((item) => item.id !== id)
    if (this.defaultPresetId === id) this.defaultPresetId = ''
    if (this.presets.length !== before) this.persist()
    return this.presets.length !== before
  }

  setDefault(id) {
    this.load()
    if (id !== '' && !this.presets.some((item) => item.id === id)) throw new Error('预设不存在')
    this.defaultPresetId = id
    this.persist()
    return this.defaultPresetId
  }

  find(id) {
    this.load()
    return this.presets.find((item) => item.id === id) ?? null
  }

  markInitialized(workspaceKey) {
    this.load()
    const key = typeof workspaceKey === 'string' && workspaceKey !== '' ? workspaceKey : DEFAULT_WORKSPACE
    if (this.initialized.has(key)) return
    this.initialized.add(key)
    this.persist()
  }

  /**
   * 把预设写入站点名单存储；replace 为 true 时替换该工作区原有名单。
   * 返回 false 表示预设不存在。
   */
  applyToWorkspace(id, sitePolicies, workspaceKey, replace = true) {
    const preset = this.find(id)
    if (preset === null) return false
    sitePolicies.replaceLists(normalizeLists(preset.lists), workspaceKey, replace)
    this.markInitialized(workspaceKey)
    return true
  }

  /**
   * 工作区第一次使用浏览器时自动套用默认预设；已有名单或已初始化则跳过。
   * 返回被套用的预设名字，未套用返回空串。
   */
  seedWorkspace(sitePolicies, workspaceKey) {
    this.load()
    if (this.defaultPresetId === '') return ''
    const preset = this.find(this.defaultPresetId)
    if (preset === null) return ''
    const key = typeof workspaceKey === 'string' && workspaceKey !== '' ? workspaceKey : DEFAULT_WORKSPACE
    if (this.initialized.has(key)) return ''
    const initialized = sitePolicies.isInitialized?.(key) === true
    if (initialized) {
      this.markInitialized(key)
      return ''
    }
    this.applyToWorkspace(preset.id, sitePolicies, key, true)
    return preset.name
  }
}
