/**
 * 浏览器权限模型（Host/Client 共用的纯数据与纯函数）。
 *
 * 四级权限（每个浏览器窗口独立）：
 * - view   仅可查看：只能读取页面、截图、查询状态；
 * - simple 仅简单操作：可跳转、刷新、前进/后退、滚动、输入文字、开关窗口；
 * - review 自动审查：可点击/按键/下载，并做保守启发式审查；
 * - full   完全权限：所有浏览器操作放行。
 *
 * 权限不足时，工具通过 DSH 审批弹窗请求一次「限制性越权」，并说明具体操作与原因；
 * 用户允许则只执行这一次。
 */

/** 权限级别（由弱到强）。 */
export const PERMISSION_LEVELS = ['view', 'simple', 'review', 'full']

/** 级别中文/英文展示名。 */
export const LEVEL_LABELS = {
  view: { zh: '仅可查看', en: 'View only' },
  simple: { zh: '仅简单操作', en: 'Simple actions' },
  review: { zh: '自动审查', en: 'Auto review' },
  full: { zh: '完全权限', en: 'Full access' },
}

/** 能力 -> 最低权限级别。 */
export const CAPABILITY_LEVELS = {
  read: 'view',
  screenshot: 'view',
  state: 'view',
  windows: 'view',
  downloads: 'view',

  navigate: 'simple',
  back: 'simple',
  forward: 'simple',
  reload: 'simple',
  scroll: 'simple',
  type: 'simple',
  newWindow: 'simple',
  closeWindow: 'simple',

  click: 'review',
  press: 'review',
  select: 'review',
  hover: 'review',
  submit: 'review',
  download: 'review',
  pauseDownload: 'simple',
  resumeDownload: 'simple',
  cancelDownload: 'simple',
}

/** 能力 -> 用户可读描述。 */
export const CAPABILITY_TITLES = {
  read: { zh: '读取页面内容', en: 'read page content' },
  screenshot: { zh: '页面截图', en: 'screenshot the page' },
  state: { zh: '查询页面状态', en: 'read page state' },
  windows: { zh: '查看浏览器窗口', en: 'list browser windows' },
  downloads: { zh: '查看已下载文件', en: 'list downloaded files' },
  navigate: { zh: '打开网页', en: 'open a web page' },
  back: { zh: '后退', en: 'go back' },
  forward: { zh: '前进', en: 'go forward' },
  reload: { zh: '刷新页面', en: 'reload the page' },
  scroll: { zh: '滚动页面', en: 'scroll the page' },
  type: { zh: '输入文字', en: 'type text' },
  newWindow: { zh: '新建浏览器窗口', en: 'open a new browser window' },
  closeWindow: { zh: '关闭浏览器窗口', en: 'close a browser window' },
  pauseDownload: { zh: '暂停下载任务', en: 'pause a download' },
  resumeDownload: { zh: '继续下载任务', en: 'resume a download' },
  cancelDownload: { zh: '取消下载任务', en: 'cancel a download' },
  click: { zh: '点击页面', en: 'click on the page' },
  press: { zh: '按键', en: 'press a key' },
  select: { zh: '选择下拉项', en: 'select an option' },
  hover: { zh: '悬停元素', en: 'hover an element' },
  submit: { zh: '提交表单', en: 'submit a form' },
  download: { zh: '下载文件', en: 'download a file' },
}

/** 级别序号。 */
export function levelRank(level) {
  return PERMISSION_LEVELS.indexOf(level)
}

/** 级别是否满足能力要求。 */
export function levelAllows(level, capability) {
  const required = CAPABILITY_LEVELS[capability]
  if (required === undefined) return false
  return levelRank(level) >= levelRank(required)
}

/** 规范化权限值。 */
export function normalizeLevel(value, fallback = 'view') {
  return PERMISSION_LEVELS.includes(value) ? value : fallback
}

/** 是否需要高风险警告弹窗。 */
export function levelNeedsWarning(level) {
  return level === 'review' || level === 'full'
}

/** 能力的用户可读描述。 */
export function capabilityTitle(capability, locale = 'zh') {
  const entry = CAPABILITY_TITLES[capability]
  if (entry === undefined) return capability
  return entry[locale] ?? entry.zh
}

/** 浏览器工具动作 -> 所需能力。 */
export const ACTION_CAPABILITIES = {
  state: 'state',
  windows: 'windows',
  downloads: 'downloads',
  read: 'read',
  screenshot: 'screenshot',
  inspect: 'state',
  open: 'navigate',
  back: 'back',
  forward: 'forward',
  reload: 'reload',
  scroll: 'scroll',
  type: 'type',
  click: 'click',
  press: 'press',
  download: 'download',
  new_window: 'newWindow',
  close_window: 'closeWindow',
  pause_download: 'pauseDownload',
  resume_download: 'resumeDownload',
  cancel_download: 'cancelDownload',
}

/** 工具动作集合（request_access 单独处理）。 */
export const TOOL_ACTIONS = Object.keys(ACTION_CAPABILITIES)

/** 需要自动审查的保守复杂动作。 */
export const AUTO_REVIEW_ACTIONS = new Set(['click', 'type', 'press'])

/** 下载时应升级为用户授权的高风险扩展名。 */
export const RISKY_DOWNLOAD_EXTENSIONS = [
  '.exe',
  '.msi',
  '.bat',
  '.cmd',
  '.ps1',
  '.sh',
  '.apk',
  '.dmg',
  '.pkg',
  '.iso',
  '.scr',
  '.vbs',
]

/** 自动审查关键词：命中即升级为用户授权。 */
export const RISK_WORDS = [
  '支付',
  '付款',
  '转账',
  '汇款',
  '购买',
  '下单',
  '提交订单',
  '确认支付',
  '结账',
  '提现',
  '充值',
  '预订',
  '删除',
  '注销',
  '解绑',
  '卸载',
  '格式化',
  '重置密码',
  '修改密码',
  '出售',
  '买入',
  '清空',
  'pay',
  'payment',
  'checkout',
  'purchase',
  'buy',
  'transfer',
  'withdraw',
  'delete',
  'remove account',
  'unsubscribe',
  'subscribe',
  'confirm payment',
]
