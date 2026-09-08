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
 *     读完整会话日志（用户消息 + 助手回答）构建转写，做一轮总结得出标题
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

function settingsSchema(Schema) {
  if (!Schema || typeof Schema.object !== 'function') return null
  return Schema.object({
    enabled: Schema.boolean().default(DEFAULTS.enabled),
    targetWords: Schema.number().step(1).min(1).max(20).default(DEFAULTS.targetWords),
    targetCjkCharacters: Schema.number().step(1).min(1).max(40).default(DEFAULTS.targetCjkCharacters),
    maxInputBytes: Schema.number().step(1).min(512).max(200000).default(DEFAULTS.maxInputBytes),
    maxOutputTokens: Schema.number().step(1).min(16).max(8192).default(DEFAULTS.maxOutputTokens),
    timeoutMs: Schema.number().step(1).min(1000).max(2147483647).default(DEFAULTS.timeoutMs),
    provider: Schema.string().default(DEFAULTS.provider),
    model: Schema.string().default(DEFAULTS.model),
    includeAssistant: Schema.boolean().default(DEFAULTS.includeAssistant),
    refreshOnTurnEnd: Schema.boolean().default(DEFAULTS.refreshOnTurnEnd),
    excludeForks: Schema.boolean().default(DEFAULTS.excludeForks),
    excludeIdPrefixes: Schema.string().default(DEFAULTS.excludeIdPrefixes),
    backfillOnStart: Schema.boolean().default(DEFAULTS.backfillOnStart),
    backfillMaxSessions: Schema.number().step(1).min(1).max(200).default(DEFAULTS.backfillMaxSessions),
    backfillIntervalMs: Schema.number().step(1).min(0).max(60000).default(DEFAULTS.backfillIntervalMs)
  })
}

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

// ── 纯函数：会话日志 → 转写条目 ────────────────────────────────────────────

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

  // ── 设置命名空间（schemastery；zod 不兼容）。loader config 作为 base，
  //    settings.yaml 的 dsh-smart-title: 节与设置 UI 可覆盖，2s 内热生效。──
  let settingsScope = null
  const Schema = await resolveSchema()
  const schema = settingsSchema(Schema)
  if (schema && ctx.settings && typeof ctx.settings.register === 'function') {
    try {
      settingsScope = ctx.settings.register(SETTINGS_NS, schema, { base: { ...DEFAULTS, ...config } })
      trace('settings-registered', {})
    } catch (e) {
      warn(`settings register 失败（仅 loader config 生效）: ${(e && e.message) || e}`)
    }
  }
  const effective = () => {
    const fromSettings = settingsScope && typeof settingsScope.get === 'function' ? settingsScope.get() : null
    return { ...DEFAULTS, ...config, ...fromSettings }
  }

  trace('armed', { pid: process.pid, llmAvailable: Boolean(dshLlm) })

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

      const allowedSeqs = new Set(request.messages.map((m) => m.seq))
      const items = extractTranscriptItems(request.session.events, allowedSeqs, cfg.includeAssistant !== false)
      if (items.length === 0) {
        // 快照里没有任何可用文本（纯附件消息等）：交给服务维持原状
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
      const options = dshLlm.deepFreeze({
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
  inject: ['sessionTitle', 'llm', 'sessions', 'settings'],
  __internals: {
    reasonKind,
    isExcluded,
    isUserPinned,
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
