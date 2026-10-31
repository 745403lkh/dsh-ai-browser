/**
 * 路径定位：与 Host 侧一致的 `$DSH_HOME`。
 */

import os from 'node:os'
import path from 'node:path'

/** 解析 DSH_HOME（环境变量优先，否则 ~/.dsh）。 */
export function resolveDshHome() {
  const fromEnv = process.env.DSH_HOME
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') return fromEnv.trim()
  return path.join(os.homedir(), '.dsh')
}

/** AI 浏览器自己的数据目录。 */
export function aiBrowserDataDir() {
  return path.join(resolveDshHome(), 'storages', 'dsh-ai-browser')
}
