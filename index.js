/**
 * dsh-ai-browser 的 Host 入口。
 *
 * 职责：
 * - 注册同源 HTTP 路由 `/.dsh-ai-browser/*`：客户端面板通过它上报浏览器状态、
 *   拉取待执行命令、回传命令结果；会话权限控件通过它读写浏览器权限级别。
 * - 持有跨会话运行时（lib/runtime.js）：每会话的权限级别、命令队列、长轮询
 *   等待者、命令结果回执，以及页面状态快照。
 *
 * 浏览器本身运行在 Web 渲染进程里（插件的 Client 半侧用 Desktop 桥创建
 * `<webview>`），Host 不启动任何浏览器进程。
 *
 * 注意：本文件同时被 Agent Preset 的 `dsh-ai-browser/preset` 行引用共享的
 * runtime 单例；preset.js 只注册工具与提示词，不重复注册路由。
 */

import { readFileSync } from 'node:fs'

import { runtime } from './lib/runtime.js'
import { DOWNLOAD_FEATURES } from './lib/downloads.js'
import { createRouteHandler, ROUTE_PREFIX } from './lib/routes.js'

/** Loader 行 id、包名、Client 模块 id 保持一致。 */
export const name = 'dsh-ai-browser'

/** 插件版本（从 package.json 读取），用于 /health 自检与「Host 代码是否过期」提示。 */
const PLUGIN_VERSION = (() => {
  try {
    const parsed = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'))
    return typeof parsed.version === 'string' ? parsed.version : 'unknown'
  } catch {
    return 'unknown'
  }
})()

/** Host 侧提供的能力（Client 用它判断是否需要重启 DSH）。运行时真实探测，避免热重载后新旧模块混用导致误报。 */
export function detectedFeatures() {
  const features = ['download', 'windows-v2', 'proactive-approval', 'request-access', 'site-policy', 'library', 'permission-presets', ...DOWNLOAD_FEATURES]
  if (typeof runtime.levelOf === 'function') features.push('per-window-permission')
  return features
}

/**
 * 挂载 Host 插件。
 * @param {object} ctx Host Cordis 上下文。
 */
export function apply(ctx) {
  // 合并绑定：两个 inject 回调的先后顺序不固定，后执行的不能把先前绑定的服务覆盖掉。
  const mergeServices = (patch) => {
    try {
      runtime.bindHostServices({ ...(runtime.hostServices ?? {}), ...patch })
    } catch (error) {
      console.error(`[${name}] Host 服务绑定失败：`, error)
    }
  }
  // 会话 preset 判定所需的 Agent 服务。
  ctx.inject(['agents', 'agentPresets'], (host) => {
    mergeServices({ agents: host.agents, agentPresets: host.agentPresets })
  })
  // 工作区解析（站点名单按工作区隔离）与下载保存目录所需的 services。
  ctx.inject(['agents', 'workingDirectory'], (host) => {
    mergeServices({ agents: host.agents, workingDirectory: host.workingDirectory })
  })

  // webServer 在组合里稍后就绪，通过 ctx.inject 延迟等待。
  ctx.inject(['webServer'], (host) => {
    host.effect(() => {
      try {
        return host.webServer.register({
          kind: 'prefix',
          path: ROUTE_PREFIX,
          handler: createRouteHandler(runtime, { version: PLUGIN_VERSION, features: detectedFeatures }),
        })
      } catch (error) {
        console.error(`[${name}] HTTP 路由注册失败：`, error)
        return () => {}
      }
    }, `${name}: http routes`)
  })
}
