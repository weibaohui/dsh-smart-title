'use strict'
/**
 * @weibaohui/dsh-smart-title — dsh 插件 · 会话智能标题
 *
 * 官方标题体系（@deepseek-ai/dsh-session-title）只挂了一个 first-prompt LLM
 * 提供方：只在首条用户消息时总结一次，失败后永不重试（回退标题=首 5 词一直
 * 留着），且长会话的主题漂移后标题不再更新。本插件接管唯一提供方注册位：
 *
 *  1. 首条用户消息到达 → 即时出 LLM 标题（automatic: 'first-prompt'，官方节奏）
 *  2. 每轮 turn/end（completed）→ ctx.sessionTitle.refresh() 重新生成：
 *     读完整会话日志（用户消息 + 助手回答）构建转写，做一轮总结得出标题。
 *     两道节流闸防止无谓重刷：refreshMinIntervalMs（距上次生成的最小间隔，
 *     顺带消掉首轮 first-prompt + turn/end 的背靠背重复）与 refreshMaxTurns
 *     （长会话冻结，回填路径不受限）；生成结果与现标题同题时静默返回现值，
 *     不写入不告警（吸收 LLM 措辞抖动）
 *  3. 用户手动改名（source.kind === 'user'）钉住的会话绝不覆盖
 *  4. 子代理会话（header.origin === 'subagent'）与 fork 子会话跳过
 *  5. 可选启动回填：对 live 且标题仍是 fallback 的会话逐个刷新
 *
 * 依赖解析遵循宿主沙箱惯例（hermes-loop/dsh-continue 同款）：优先宿主 dsh
 * 全局安装里的 vendored 副本，退回标准 require；schemastery 缺席只损失设置
 * UI（loader config 仍生效），dsh-llm 缺席则 LLM 调用不可用（标题保持回退），
 * 均不让宿主 boot 失败。
 */

const { pathToFileURL } = require('node:url')
const { homedir } = require('node:os')
const { join } = require('node:path')

// ── 依赖解析 ────────────────────────────────────────────────────────────────

// 宿主 dsh 全局安装里的 vendored 副本路径。跟随 dsh bin 的真实位置：
// process.execPath 可能指向捆绑的 node 运行时，不能从它推导；用
// DSH_GLOBAL_PREFIX 与 ~/.local 兜底。路径形如
// <prefix>/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/<pkg>/…
function hostCandidatePaths(pkgName, rel) {
  const prefixes = [process.env.DSH_GLOBAL_PREFIX, homedir() + '/.local'].filter(Boolean)
  return prefixes.map((prefix) =>
    join(prefix, 'lib', 'node_modules', '@deepseek-ai', 'dsh', 'node_modules', '@deepseek-ai', pkgName, rel)
  )
}

const loadErrors = []

// dsh-llm 与 schemastery 都是 ESM（schemastery 另有 CJS 副本），宿主沙箱里
// createRequire 碰 ESM 会抛「Cannot require() ES Module」，因此统一走动态
// import()（CJS 顶层无法 await：先拼候选路径，apply 阶段发起加载，使用点
// await promise）。加载失败只降级不让宿主 boot 失败。
function importFirstAvailable(pkgName, rel, label, bareSpecifier) {
  const candidates = [...hostCandidatePaths(pkgName, rel), bareSpecifier]
  let index = 0
  const attempt = async () => {
    for (; index < candidates.length; index++) {
      const target = candidates[index]
      try {
        const isPath = target === candidates[index] && index < candidates.length - 1
        const specifier = isPath ? pathToFileURL(target).href : target
        const mod = await import(specifier)
        loadErrors.push(`OK ${label} <- ${target}`)
        return mod
      } catch (e) {
        loadErrors.push(`${label}@${target}: ${String((e && e.message) || e).slice(0, 160)}`)
      }
    }
    return null
  }
  return attempt()
}

// 应用启动时赋值；generate/settings 使用点 await。测试环境直接注入 mock。
let dshLlmPromise = null
let schemaPromise = null

function startLoaders() {
  if (!dshLlmPromise) {
    dshLlmPromise = importFirstAvailable('dsh-llm', 'lib/index.js', '@deepseek-ai/dsh-llm', '@deepseek-ai/dsh-llm')
  }
  if (!schemaPromise) {
    // schemastery 的 CJS 副本 import() 后 default 即 Schema 函数；优先 CJS 保持与宿主 settings 服务同源
    schemaPromise = importFirstAvailable('schemastery', 'lib/index.cjs', '@deepseek-ai/schemastery', '@deepseek-ai/schemastery')
  }
  return { dshLlmPromise, schemaPromise }
}

async function resolveSchema() {
  const mod = await schemaPromise
  if (!mod) return null
  const Schema = mod.default || mod.Schema || (typeof mod === 'function' ? mod : null)
  return Schema && typeof Schema.object === 'function' ? Schema : null
}

async function resolveDshLlm() {
  const mod = await dshLlmPromise
  if (!mod) return null
  return mod && typeof mod.BlockAssembler === 'function' && typeof mod.createUserMessage === 'function' ? mod : null
}

// 测试缝隙：预先注入已解析的模块，让单测不依赖本机宿主安装（CI 上无 ~/.local 宿主目录）
function __seedDshLlm(mod) {
  dshLlmPromise = Promise.resolve(mod)
}
function __seedSchema(Schema) {
  schemaPromise = Promise.resolve(Schema ? { default: Schema } : null)
}

// ── 默认配置（DEFAULTS 与 settingsSchema 共用同一份，防止漂移）─────────────

const DEFAULTS = Object.freeze({
  enabled: true,
  // 标题语言目标：非 CJK 词数 / CJK 字符数
  targetWords: 6,
  targetCjkCharacters: 12,
  // 完整转写（JSON 封帧后）的 UTF-8 字节预算
  maxInputBytes: 12000,
  // 输出 token 上限：给思考型适配器（zhanlu/glm 等不随 purpose 关思考）留余量
  maxOutputTokens: 512,
  // 端到端时限（ms）；上限 MAX_TIMER_DELAY_MS
  timeoutMs: 60000,
  // 显式路由覆盖；二者必须同时提供或同时省略（省略=继承会话已记录路由）
  provider: '',
  model: '',
  // 转写是否包含助手回答（false=仅用户消息，官方 first-prompt-llm 的语义）
  includeAssistant: true,
  // 每轮 turn/end（completed）后刷新标题
  refreshOnTurnEnd: true,
  // 同一次标题生成之后的最小刷新间隔（ms），0 = 不节流。节流同时消掉首轮
  // 「first-prompt 首题 + turn/end 刷新」的背靠背重复生成（首次生成总是放行）
  refreshMinIntervalMs: 120000,
  // 会话用户消息数超过该值后冻结 turn/end 自动刷新（0 = 不限制）。
  // 启动回填不受冻结影响——回填正是长会话存量标题的修复路径
  refreshMaxTurns: 100,
  // 跳过 fork 子会话（父会话派生）
  excludeForks: true,
  // 跳过这些会话 id 前缀（逗号分隔）
  excludeIdPrefixes: '',
  // 启动回填：对 live 且最新标题来源是 fallback 的会话逐个刷新
  backfillOnStart: false,
  backfillMaxSessions: 30,
  // 回填节奏间隔（ms），避免启动瞬间挤爆 LLM
  backfillIntervalMs: 2000
})

const SETTINGS_NS = 'dsh-smart-title'

// 0.1.7 settings 服务：字段标 .volatile() 才能被设置 UI 投影、才能经
// ctx.settings.update 在线写回（对齐 dsh-settings-ui / hermes-loop）。
function settingsSchema(Schema) {
  if (!Schema || typeof Schema.object !== 'function') return null
  return Schema.object({
    enabled: Schema.boolean().default(DEFAULTS.enabled).volatile(),
    targetWords: Schema.number().step(1).min(1).max(20).default(DEFAULTS.targetWords).volatile(),
    targetCjkCharacters: Schema.number().step(1).min(1).max(40).default(DEFAULTS.targetCjkCharacters).volatile(),
    maxInputBytes: Schema.number().step(1).min(512).max(200000).default(DEFAULTS.maxInputBytes).volatile(),
    maxOutputTokens: Schema.number().step(1).min(16).max(8192).default(DEFAULTS.maxOutputTokens).volatile(),
    timeoutMs: Schema.number().step(1).min(1000).max(2147483647).default(DEFAULTS.timeoutMs).volatile(),
    provider: Schema.string().default(DEFAULTS.provider).volatile(),
    model: Schema.string().default(DEFAULTS.model).volatile(),
    includeAssistant: Schema.boolean().default(DEFAULTS.includeAssistant).volatile(),
    refreshOnTurnEnd: Schema.boolean().default(DEFAULTS.refreshOnTurnEnd).volatile(),
    refreshMinIntervalMs: Schema.number().step(1000).min(0).max(3600000).default(DEFAULTS.refreshMinIntervalMs).volatile(),
    refreshMaxTurns: Schema.number().step(1).min(0).max(100000).default(DEFAULTS.refreshMaxTurns).volatile(),
    excludeForks: Schema.boolean().default(DEFAULTS.excludeForks).volatile(),
    excludeIdPrefixes: Schema.string().default(DEFAULTS.excludeIdPrefixes).volatile(),
    backfillOnStart: Schema.boolean().default(DEFAULTS.backfillOnStart).volatile(),
    backfillMaxSessions: Schema.number().step(1).min(1).max(200).default(DEFAULTS.backfillMaxSessions).volatile(),
    backfillIntervalMs: Schema.number().step(1).min(0).max(60000).default(DEFAULTS.backfillIntervalMs).volatile()
  })
}

// 0.1.7 loader 通过 entry.fiber.runtime.Config 自动发现 schema，必须在模块顶层
// 同步构建导出。schemastery 的 CJS 副本可直接 require（与宿主 settings 服务同源）；
// ESM 副本留给原异步路径（apply 内降级用）。
function loadSchemasterySync() {
  const { createRequire } = require('node:module')
  for (const target of hostCandidatePaths('schemastery', 'lib/index.cjs')) {
    try { return createRequire(target)(target) } catch {}
  }
  try { return require('@deepseek-ai/schemastery') } catch {}
  return null
}
// schemastery <3.18.4 没有 .volatile()（独立安装场景）：降级为无 Config，
// 设置写回不可用，但模块加载与插件运行不受影响。
let Config = null
try { Config = settingsSchema(loadSchemasterySync()) } catch {}

/** 校验路由覆盖：成对出现才有意义；空串视为未提供。 */
function resolveRouteOverride(provider, model) {
  const p = typeof provider === 'string' ? provider.trim() : ''
  const m = typeof model === 'string' ? model.trim() : ''
  if (p && m) return { provider: p, model: m }
  if (p || m) return null // 配置不完整：视为未提供
  return undefined
}

// ── 纯函数：turn/end reason 分类（对齐 dsh-continue 的容忍语义）────────────

/** `turn/end` reason 形如 {kind: 'completed'}；容忍裸字符串与缺省。 */
function reasonKind(reason) {
  if (reason === null || reason === undefined) return undefined
  if (typeof reason === 'string') return reason
  if (typeof reason === 'object' && typeof reason.kind === 'string') return reason.kind
  return undefined
}

// ── 纯函数：会话排除与钉住判定 ─────────────────────────────────────────────

function parseIdPrefixes(raw) {
  if (typeof raw !== 'string') return []
  return raw.split(',').map((s) => s.trim()).filter(Boolean)
}

/** 是否跳过该会话（子代理 / fork / 前缀命中）。 */
function isExcluded(session, cfg) {
  if (!session) return true
  const sid = session.id
  if (typeof sid !== 'string' || sid === '') return true
  const header = session.header || {}
  if (header.origin === 'subagent') return true
  if (cfg.excludeForks && header.parentSession) return true
  for (const p of parseIdPrefixes(cfg.excludeIdPrefixes)) {
    if (sid.startsWith(p)) return true
  }
  return false
}

/** 用户手动改名钉住的会话不自动刷新（显式 rename 的 source.kind === 'user'）。 */
function isUserPinned(snapshot) {
  return Boolean(snapshot && snapshot.source && snapshot.source.kind === 'user')
}

// ── 纯函数：刷新节流 / 长会话冻结 / 同题抑制 ───────────────────────────────

/** 标题归一化：去首尾、内部空白折叠、忽略大小写——同题判定用。 */
function normalizeTitle(s) {
  return String(s ?? '').replace(/\s+/g, ' ').trim().toLowerCase()
}

/** 同题：两边都非空且归一化相等（空标题不算同题，让首题正常落库）。 */
function isSameTitle(a, b) {
  const na = normalizeTitle(a)
  return na !== '' && na === normalizeTitle(b)
}

/** 会话当前用户消息数（从事件日志统计；日志不可得返回 null = 未知，判定放行）。 */
function countUserTurns(session) {
  const events = sessionEventsOf(session)
  if (events.length === 0 && !(session && (typeof session.snapshotEvents === 'function' || Array.isArray(session.events)))) return null
  let n = 0
  for (const e of events) if (e && e.type === 'user/message') n++
  return n
}

/** 节流：minIntervalMs<=0 或无生成记录放行；距上次生成不足窗口则拦截。 */
function isThrottled(lastAt, now, minIntervalMs) {
  if (!(minIntervalMs > 0)) return false
  if (!lastAt) return false
  return now - lastAt < minIntervalMs
}

/** 冻结：cap<=0 不限；轮数未知放行；超过 cap 冻结。 */
function isFrozen(turns, cap) {
  if (!(cap > 0)) return false
  if (typeof turns !== 'number') return false
  return turns > cap
}

// ── 纯函数：设置清洗（PUT /settings 的白名单 + 夹取）───────────────────────

const NUM_RANGES = Object.freeze({
  targetWords: [1, 20],
  targetCjkCharacters: [1, 40],
  maxInputBytes: [512, 200000],
  maxOutputTokens: [16, 8192],
  timeoutMs: [1000, 2147483647],
  refreshMinIntervalMs: [0, 3600000],
  refreshMaxTurns: [0, 100000],
  backfillMaxSessions: [1, 200],
  backfillIntervalMs: [0, 60000]
})
const BOOL_KEYS = Object.freeze(['enabled', 'includeAssistant', 'refreshOnTurnEnd', 'excludeForks', 'backfillOnStart'])
const STR_KEYS = Object.freeze(['provider', 'model', 'excludeIdPrefixes'])

/**
 * 白名单清洗设置 patch：布尔只收真布尔、数字夹取进 schema 同款范围、字符串收
 * 去尾空。路由 provider/model 必须成对（与 resolveRouteOverride 的「半配对视
 * 为未提供」一致：只给一边时两边都丢弃，避免静默退回会话路由）。
 */
function sanitizePatch(body) {
  const patch = {}
  if (!body || typeof body !== 'object') return patch
  for (const key of BOOL_KEYS) {
    if (typeof body[key] === 'boolean') patch[key] = body[key]
  }
  for (const [key, [min, max]] of Object.entries(NUM_RANGES)) {
    const n = Number(body[key])
    if (Number.isFinite(n)) patch[key] = Math.min(max, Math.max(min, n))
  }
  for (const key of STR_KEYS) {
    if (typeof body[key] === 'string') patch[key] = body[key].trim()
  }
  const hasP = typeof patch.provider === 'string' && patch.provider !== ''
  const hasM = typeof patch.model === 'string' && patch.model !== ''
  if (hasP !== hasM) {
    delete patch.provider
    delete patch.model
  }
  return patch
}

/** 只透出已知设置键（不漏内部状态）。 */
function safeSettings(eff) {
  const out = {}
  for (const key of Object.keys(DEFAULTS)) out[key] = eff[key]
  return out
}

// ── 纯函数：会话日志 → 转写条目 ────────────────────────────────────────────

/**
 * 会话事件日志的防御性取用。宿主会话的正规入口是 snapshotEvents()（live/
 * persisted 通吃）；裸读 `session.events` 在事件 spill 到盘后不是数组
 * （hermes-loop 真机同款坑），取不到转写还静默失败。
 */
function sessionEventsOf(session) {
  if (!session) return []
  try {
    const evs = typeof session.snapshotEvents === 'function' ? session.snapshotEvents() : session.events
    if (Array.isArray(evs)) return evs
  } catch {}
  return []
}

/** 从一条 message 的 content 块里抽取纯文本（只取 text 块，空白折叠）。 */
function messageText(content) {
  if (!Array.isArray(content)) return ''
  const parts = []
  for (const block of content) {
    if (block && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string') {
      parts.push(block.text)
    }
  }
  return parts.join('\n').replace(/\s+/g, ' ').trim()
}

/**
 * 把会话日志事件流折叠成转写条目。
 * - user/message：data 即 UserMessage；seq 必须在允许集内（request.messages
 *   快照）——归属 seq 一旦越出快照，服务的 validateResult 会拒绝整个结果。
 * - assistant/message：data.message.content 的 text 块；不参与 seq 归属。
 * 返回 [{role:'user', seq, text} | {role:'assistant', text}]，日志顺序。
 */
function extractTranscriptItems(events, allowedUserSeqs, includeAssistant) {
  const allowed = allowedUserSeqs instanceof Set ? allowedUserSeqs : new Set(allowedUserSeqs || [])
  const items = []
  if (!Array.isArray(events)) return items
  for (const event of events) {
    if (!event || typeof event !== 'object') continue
    const type = event.type
    const data = event.data
    if (type === 'user/message') {
      const seq = event.seq
      if (typeof seq !== 'number' || !allowed.has(seq)) continue
      const text = messageText(data && data.content)
      if (text) items.push({ role: 'user', seq, text })
    } else if (type === 'assistant/message' && includeAssistant) {
      const msg = data && data.message
      const text = messageText(msg && msg.content)
      if (text) items.push({ role: 'assistant', text })
    }
  }
  return items
}

const TURN_LABEL = { user: '用户', assistant: '助手' }

/**
 * 字节预算内裁剪转写：始终保留首条用户消息（意图锚点），从尾部按预算回填，
 * 放不下的从前往后丢；单条超预算时硬截断该条文本（按 UTF-8 字节，不破码点）。
 * 返回新数组，不改动入参。
 */
function truncateTextUtf8(text, maxBytes) {
  const s = String(text)
  if (Buffer.byteLength(s, 'utf8') <= maxBytes) return s
  let out = s
  while (out.length > 0 && Buffer.byteLength(out + '…', 'utf8') > maxBytes) {
    out = out.slice(0, -1)
  }
  return out ? out + '…' : ''
}

function itemBytes(item) {
  return Buffer.byteLength(JSON.stringify(item), 'utf8')
}

function trimTranscript(items, maxInputBytes) {
  if (!Array.isArray(items) || items.length === 0) return []
  const firstUserIdx = items.findIndex((it) => it.role === 'user')
  const anchor = firstUserIdx >= 0 ? items[firstUserIdx] : null
  // 单帧开销：JSON 数组的括号与逗号，留 256 字节余量给系统提示词以外的封装
  const budget = Math.max(512, maxInputBytes) - 256

  const rest = items.filter((_, i) => i !== firstUserIdx)
  const kept = []
  let used = 0
  for (let i = rest.length - 1; i >= 0; i--) {
    const item = rest[i]
    const cost = itemBytes(item)
    if (used + cost > budget) continue
    kept.unshift(item)
    used += cost
  }
  const result = []
  if (anchor) {
    const anchorBudget = budget - used
    const a = { ...anchor }
    if (itemBytes(a) > anchorBudget) {
      // 首条消息自己超预算：按比例硬截断
      const textBudget = Math.max(64, anchorBudget - itemBytes({ ...a, text: '' }) - 16)
      a.text = truncateTextUtf8(a.text, textBudget)
    }
    result.push(a)
  }
  result.push(...kept)
  return result
}

/** 把条目封帧成用户提示词（JSON 数组，防结构性注入）。 */
function frameTranscript(items) {
  const framed = items.map((it) =>
    it.role === 'user' ? { role: 'user', seq: it.seq, text: it.text } : { role: 'assistant', text: it.text }
  )
  return `从下面这段「用户与 AI 编码助手」的对话 JSON 中，总结出这条会话的标题：\n${JSON.stringify(framed)}`
}

function systemPrompt(cfg) {
  return [
    'Create a concise title for an AI coding-assistant session from the supplied conversation excerpt (user messages and assistant replies).',
    'The title should reflect what the session is actually about or trying to accomplish, not merely repeat the first sentence.',
    'Return only the title on one line, **in plain text of natural language**, with no quotes, prefix, explanation, Markdown, XML, or terminal control codes. No code is allowed.',
    'Use the dominant language of the conversation.',
    `Aim for about ${cfg.targetWords} words in non-CJK languages or ${cfg.targetCjkCharacters} CJK characters.`
  ].join('\n')
}

// ── HTTP 辅助（对齐 dsh-continue）──────────────────────────────────────────

const MAX_BODY_BYTES = 64 * 1024

function readJsonBody(req) {
  return new Promise((fulfil, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) { reject(new Error('request body too large')); req.destroy(); return }
      chunks.push(chunk)
    })
    req.on('end', () => {
      try { fulfil(chunks.length === 0 ? {} : JSON.parse(Buffer.concat(chunks).toString('utf8'))) }
      catch (error) { reject(new Error(`invalid JSON body: ${error && error.message}`)) }
    })
    req.on('error', reject)
  })
}

function sendJson(res, status, payload) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(payload))
}

// ── 插件本体 ────────────────────────────────────────────────────────────────

const PLUGIN_ID = 'dsh-smart-title'
const PROVIDER_ID = 'dsh-smart-title'

function apply(ctx, config = {}) {
  return Promise.resolve(applyAsync(ctx, config))
}

async function applyAsync(ctx, config = {}) {
  const trace = (event, data) => {
    const line = `[${PLUGIN_ID}] ${event} ${data ? JSON.stringify(data) : ''}`
    try {
      ctx.logger.info(line)
    } catch {}
    // 宿主可能过滤插件 logger 输出；console 走 stderr 保底可见（headless/launchd 均可查）
    try {
      console.error(`[trace] ${line}`)
    } catch {}
  }
  const warn = (message) => {
    const line = `[${PLUGIN_ID}] ${message}`
    try {
      ctx.logger.warn(line)
    } catch {}
    try {
      console.error(`[warn] ${line}`)
    } catch {}
  }

  startLoaders()
  const dshLlm = await resolveDshLlm()
  if (!dshLlm) {
    warn(`无法加载 @deepseek-ai/dsh-llm（宿主安装解析失败），LLM 标题调用不可用，插件保持惰性。解析详情: ${loadErrors.join(' | ') || '无记录'}`)
  }

  // ── 0.1.7 settings 接线（对齐 dsh-settings-ui / hermes-loop）──
  // settings 服务不再支持 ctx.settings.register：Config 已在模块顶层导出
  // （volatile 字段），读走 describe() 投影，写走 ctx.settings.update()
  // （持久化进 profile patch，重启不丢）。服务缺席/写回失败时退回
  // memoryPatch 进程内兜底（仅本次运行有效）。
  const base = { ...DEFAULTS, ...(config || {}) }
  let liveSettings = {} // settings 文档实时值（document-updated 事件驱动刷新）
  const memoryPatch = {} // 进程内兜底
  function readDescriptor() {
    try {
      if (!ctx.settings || typeof ctx.settings.describe !== 'function') return null
      return ctx.settings.describe().find((x) => x.ns === SETTINGS_NS) || null
    } catch { return null }
  }
  // apply 时 loader 可能尚未就绪（describe 投影里还没有本插件条目），间隔重试
  let liveSeen = false
  function refreshLive(attempt = 0) {
    const d = readDescriptor()
    if (d) {
      if (!liveSeen) trace('settings-live-ready', {})
      liveSeen = true
      if (d.value && typeof d.value === 'object') liveSettings = d.value
      return
    }
    if (attempt < 15) setTimeout(() => { refreshLive(attempt + 1) }, 2000).unref?.()
  }
  refreshLive()

  const effective = () => ({ ...base, ...liveSettings, ...memoryPatch })

  // settings 文档变更（dsh 自动生成的设置页、本插件面板写回）刷新实时值
  try {
    if (ctx.on && typeof ctx.on === 'function') {
      ctx.effect(() => {
        const off = ctx.on('settings/document-updated', (ns) => {
          if (ns !== SETTINGS_NS) return
          const d = readDescriptor()
          if (d && d.value && typeof d.value === 'object') liveSettings = d.value
        })
        return () => { try { off() } catch {} }
      }, 'dsh-smart-title: settings watch')
    }
  } catch { /* 事件订阅不可用：写回后靠 memoryPatch 维持本次运行 */ }

  trace('armed', { pid: process.pid, llmAvailable: Boolean(dshLlm) })

  // 每会话最近一次标题生成时刻（含官方 first-prompt 首题路径——它们都走
  // provider.generate）。refreshSession 的节流闸据此放行/拦截。
  const lastGenerateAt = new Map()

  // ── 提供方：标题生成（唯一注册位，本插件接管）──────────────────────────
  const provider = {
    id: PROVIDER_ID,
    automatic: 'first-prompt',
    async generate(request) {
      trace('generate-called', { messages: request.messages && request.messages.length })
      const cfg = effective()
      if (cfg.enabled === false) throw new Error(`${PLUGIN_ID}: disabled`)
      if (!dshLlm) throw new Error(`${PLUGIN_ID}: @deepseek-ai/dsh-llm unavailable`)
      request.signal.throwIfAborted()
      lastGenerateAt.set(request.session.id, Date.now())

      const allowedSeqs = new Set(request.messages.map((m) => m.seq))
      const items = extractTranscriptItems(sessionEventsOf(request.session), allowedSeqs, cfg.includeAssistant !== false)
      if (items.length === 0) {
        // 快照里没有任何可用文本（纯附件消息等）：交给服务维持原状
        trace('no-items', { sessionId: request.session.id, allowed: allowedSeqs.size })
        throw new Error(`${PLUGIN_ID}: no eligible transcript items in snapshot`)
      }
      const trimmed = trimTranscript(items, cfg.maxInputBytes)
      const framedInput = frameTranscript(trimmed)
      const inputBytes = Buffer.byteLength(framedInput, 'utf8')
      if (inputBytes > cfg.maxInputBytes) {
        throw new Error(`${PLUGIN_ID}: framed input ${inputBytes}B exceeds maxInputBytes ${cfg.maxInputBytes}B`)
      }

      // 路由：显式覆盖 > 会话已记录路由（request.route）
      const override = resolveRouteOverride(cfg.provider, cfg.model)
      const route = override || request.route
      if (!route) throw new Error(`${PLUGIN_ID}: no route available; configure provider/model together`)

      const system = systemPrompt(cfg)
      const deadlineAt = Date.now() + cfg.timeoutMs
      // 对齐官方 dsh-session-title-llm 的 options 形状；freeze 仅浅防误改
      //（官方的 deepFreeze 在 @deepseek-ai/dsh-util-values，dsh-llm 没有此导出）
      const options = Object.freeze({
        provider: route.provider,
        model: route.model,
        messages: [
          dshLlm.createUserMessage({
            content: [{ type: 'text', text: framedInput }],
            source: { kind: 'plugin', plugin: PLUGIN_ID }
          })
        ],
        system,
        maxTokens: cfg.maxOutputTokens,
        sessionId: request.session.id,
        purpose: 'session-title',
        signal: request.signal
      })

      const assembler = new dshLlm.BlockAssembler()
      try {
        for await (const chunk of ctx.llm.stream(options)) {
          request.signal.throwIfAborted()
          if (Date.now() > deadlineAt) throw new Error(`${PLUGIN_ID}: title request timed out after ${cfg.timeoutMs}ms`)
          assembler.push(chunk)
        }
      } catch (e) {
        trace('stream-error', { message: String((e && e.message) || e).slice(0, 300) })
        throw e
      }
      trace('stream-done', { finish: assembler.finish && assembler.finish.kind })
      request.signal.throwIfAborted()

      const finish = assembler.finish
      const finishKind = finish && finish.kind
      if (finishKind && finishKind !== 'stop') {
        throw new Error(`${PLUGIN_ID}: title finish reason "${finishKind}"`)
      }
      const blocks = assembler.blocks()
      if (blocks.some((b) => b.type === 'tool-call')) {
        throw new Error(`${PLUGIN_ID}: title output must be text only`)
      }
      const title = blocks
        .filter((b) => b.type === 'text')
        .map((b) => b.text)
        .join(' ')
        .trim()
      if (!title) throw new Error(`${PLUGIN_ID}: title model produced no text`)

      // 同题抑制：归一化后与现标题一致 → 静默返回现标题（服务写入同值，侧栏
      // 零变化、无失败告警）。LLM 非确定性导致的措辞/大小写抖动在这里被吸收。
      let currentTitle = ''
      try {
        const snap = ctx.sessionTitle.get(request.session)
        currentTitle = snap && typeof snap.title === 'string' ? snap.title : ''
      } catch {}
      if (isSameTitle(currentTitle, title)) {
        trace('same-title-skip', { sessionId: request.session.id })
        return {
          title: currentTitle,
          messageSeqs: trimmed.filter((it) => it.role === 'user').map((it) => it.seq),
          model: route
        }
      }

      return {
        title,
        messageSeqs: trimmed.filter((it) => it.role === 'user').map((it) => it.seq),
        model: route
      }
    }
  }

  ctx.effect(() => ctx.sessionTitle.register(provider), `${PLUGIN_ID}: sessionTitle provider`)

  // ── turn/end 刷新 ──────────────────────────────────────────────────────
  const inflightRefresh = new Set()

  const refreshSession = (session, why) => {
    const cfg = effective()
    if (cfg.enabled === false) return
    if (isExcluded(session, cfg)) return
    let snap
    try {
      snap = ctx.sessionTitle.get(session)
    } catch (e) {
      return
    }
    if (isUserPinned(snap)) return
    const sid = session.id
    // 长会话冻结：用户消息数超过 refreshMaxTurns 后不再自动刷新（回填不受限，
    // 它正是存量长会话的修复路径）；轮数未知（events 缺席）放行。
    if (why !== 'backfill' && isFrozen(countUserTurns(session), cfg.refreshMaxTurns)) {
      trace('frozen', { sessionId: sid, turns: countUserTurns(session), cap: cfg.refreshMaxTurns })
      return
    }
    // 节流：距上次标题生成（含官方 first-prompt 首题）不足 refreshMinIntervalMs
    // 则跳过——消掉每轮必刷与首轮 first-prompt + turn/end 的背靠背重复。
    if (isThrottled(lastGenerateAt.get(sid), Date.now(), cfg.refreshMinIntervalMs)) {
      trace('throttled', { sessionId: sid, why, sinceMs: Date.now() - (lastGenerateAt.get(sid) || 0) })
      return
    }
    if (inflightRefresh.has(sid)) return
    inflightRefresh.add(sid)
    Promise.resolve()
      .then(() => ctx.sessionTitle.refresh(session))
      .then((result) => {
        trace('refreshed', { sessionId: sid, why, title: result && result.title })
      })
      .catch((e) => {
        warn(`refresh 失败（${why}, session=${sid}）: ${(e && e.message) || e}`)
      })
      .finally(() => {
        inflightRefresh.delete(sid)
      })
  }

  const onSessionEvent = (session, event) => {
    try {
      if (!event || typeof event !== 'object') return
      if (event.type !== 'turn/end') return
      const cfg = effective()
      if (cfg.enabled === false || cfg.refreshOnTurnEnd === false) return
      if (reasonKind(event.data && event.data.reason) !== 'completed') return
      refreshSession(session, 'turn-end')
    } catch (e) {
      warn(`session/event handler: ${(e && e.message) || e}`)
    }
  }

  ctx.effect(() => {
    const dispose = ctx.on('session/event', onSessionEvent)
    return () => {
      try {
        dispose()
      } catch {}
    }
  }, `${PLUGIN_ID}: session/event subscription`)

  // ── HTTP API：设置页数据面（status 读 / settings 写 / models 目录）──────
  if (ctx.webServer && typeof ctx.webServer.register === 'function') {
    ctx.effect(() => ctx.webServer.register({
      kind: 'prefix',
      path: `/${PLUGIN_ID}/api`,
      handler: async (req, res) => {
    // 与其它 host 路由一致的信任栅栏：connection 服务的 Host/Origin 检查
    // 加浏览器认证，防止本机任意网页跨站调用。
    const rejection = ctx.connection.requestRejection(req)
    if (rejection !== undefined) {
      res.writeHead(rejection)
      res.end()
      return
    }
        try {
          const url = new URL(req.url || '/', 'http://dsh.local')
          const apiPath = url.pathname.replace(/\/+$/, '')

          // GET /dsh-smart-title/api/status
          if (req.method === 'GET' && apiPath.endsWith(`/${PLUGIN_ID}/api/status`)) {
            sendJson(res, 200, {
              armed: Boolean(dshLlm),
              settings: safeSettings(effective())
            })
            return
          }

          // GET /dsh-smart-title/api/models — 设置页路由下拉的模型目录
          //（llm.listProviders + 逐 provider listModels；缺席时降级空目录）
          if (req.method === 'GET' && apiPath.endsWith(`/${PLUGIN_ID}/api/models`)) {
            const out = { default: null, providers: [] }
            try {
              if (ctx.agentDefaultModel && typeof ctx.agentDefaultModel.currentSelection === 'function')
                out.default = ctx.agentDefaultModel.currentSelection()
            } catch {}
            try {
              const providers = ctx.llm && typeof ctx.llm.listProviders === 'function' ? ctx.llm.listProviders() : []
              for (const p of providers || []) {
                let models = []
                try { models = (await ctx.llm.listModels(p.id)) || [] } catch {}
                out.providers.push({
                  id: p.id, name: p.name || p.id,
                  models: models.map((m) => ({ id: m.id, name: m.name || m.id }))
                })
              }
            } catch {}
            sendJson(res, 200, out)
            return
          }

          // PUT /dsh-smart-title/api/settings — 白名单清洗后落 settings 服务
          //（0.1.7 持久化进 profile patch；写回失败退回 memoryPatch，仅本次进程有效）
          if (req.method === 'PUT' && apiPath.endsWith(`/${PLUGIN_ID}/api/settings`)) {
            const body = await readJsonBody(req)
            const patch = sanitizePatch(body)
            Object.assign(memoryPatch, patch)
            if (ctx.settings && typeof ctx.settings.update === 'function') {
              try { await ctx.settings.update(SETTINGS_NS, patch) }
              catch (e) { warn(`settings update 失败（仅本次运行生效）: ${(e && e.message) || e}`) }
            }
            trace('settings-updated', { keys: Object.keys(patch) })
            sendJson(res, 200, { settings: safeSettings(effective()) })
            return
          }

          sendJson(res, 404, { error: 'not found' })
        } catch (error) { sendJson(res, 400, { error: String((error && error.message) || error) }) }
      }
    }), `${PLUGIN_ID}: api route`)
  }

  // ── 启动回填（默认关）：live 且最新标题来源是 fallback 的会话逐个刷新 ──
  if (effective().backfillOnStart === true && ctx.sessions && typeof ctx.sessions.list === 'function') {
    const cfg = effective()
    const candidates = ctx.sessions
      .list()
      .filter((s) => !isExcluded(s, cfg) && !isUserPinned((() => {
        try {
          return ctx.sessionTitle.get(s)
        } catch {
          return undefined
        }
      })()))
    const targets = []
    for (const s of candidates) {
      let snap
      try {
        snap = ctx.sessionTitle.get(s)
      } catch {
        continue
      }
      if (snap && snap.source && snap.source.kind === 'fallback') targets.push(s)
      if (targets.length >= (cfg.backfillMaxSessions | 0)) break
    }
    trace('backfill-scan', { candidates: candidates.length, targets: targets.length })
    targets.forEach((session, i) => {
      const delay = (cfg.backfillIntervalMs | 0) * (i + 1)
      const t = setTimeout(() => refreshSession(session, 'backfill'), delay)
      if (typeof t.unref === 'function') t.unref()
    })
  }

  // ── 活动账本（对齐 dsh-continue：宿主会过滤 logger 输出，留独立记录）────
  // v0.1 用 trace 级别即可；账本文件视用户反馈再加，避免目录噪音。
}

module.exports = {
  name: PLUGIN_ID,
  inject: ['sessionTitle', 'llm', 'sessions', 'settings', 'webServer', 'agentDefaultModel', 'connection'],
  Config,
  __internals: {
    reasonKind,
    isExcluded,
    isUserPinned,
    normalizeTitle,
    isSameTitle,
    countUserTurns,
    sessionEventsOf,
    isThrottled,
    isFrozen,
    sanitizePatch,
    safeSettings,
    parseIdPrefixes,
    messageText,
    extractTranscriptItems,
    trimTranscript,
    truncateTextUtf8,
    frameTranscript,
    systemPrompt,
    resolveRouteOverride,
    settingsSchema,
    __seedDshLlm,
    __seedSchema,
    DEFAULTS,
    SETTINGS_NS
  },
  apply
}
