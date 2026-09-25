import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { __internals } = require('../src/index.js')
const {
  reasonKind,
  isExcluded,
  isUserPinned,
  normalizeTitle,
  sessionEventsOf,
  isSameTitle,
  countUserTurns,
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
  DEFAULTS
} = __internals

// ── reasonKind ──────────────────────────────────────────────────────────────

test('reasonKind: {kind:"completed"} → completed', async () => {
  assert.equal(reasonKind({ kind: 'completed' }), 'completed')
})
test('reasonKind: {kind:"error",...} → error', async () => {
  assert.equal(reasonKind({ kind: 'error', error: {} }), 'error')
})
test('reasonKind: 裸字符串容忍', async () => {
  assert.equal(reasonKind('interrupted'), 'interrupted')
})
test('reasonKind: null/undefined/异形 → undefined', async () => {
  assert.equal(reasonKind(null), undefined)
  assert.equal(reasonKind(undefined), undefined)
  assert.equal(reasonKind(42), undefined)
  assert.equal(reasonKind({}), undefined)
})

// ── 会话排除 ────────────────────────────────────────────────────────────────

const cfg = (over = {}) => ({ ...DEFAULTS, ...over })

test('isExcluded: 子代理会话按 header.origin 排除', async () => {
  const s = { id: 'session-1', header: { origin: 'subagent' } }
  assert.equal(isExcluded(s, cfg()), true)
})
test('isExcluded: fork 子会话按 parentSession 排除（可关）', async () => {
  const s = { id: 'session-2', header: { parentSession: 'p1' } }
  assert.equal(isExcluded(s, cfg()), true)
  assert.equal(isExcluded(s, cfg({ excludeForks: false })), false)
})
test('isExcluded: id 前缀命中排除', async () => {
  const s = { id: 'hermes-loop-review-abc', header: {} }
  assert.equal(isExcluded(s, cfg({ excludeIdPrefixes: 'hermes-loop-review-, review-' })), true)
})
test('isExcluded: 正常会话不排除；无 id/无会话排除', async () => {
  assert.equal(isExcluded({ id: 'session-x', header: {} }, cfg()), false)
  assert.equal(isExcluded({ header: {} }, cfg()), true)
  assert.equal(isExcluded(null, cfg()), true)
})

// ── 用户钉住 ────────────────────────────────────────────────────────────────

test('isUserPinned: source.kind=user → true；其余 → false', async () => {
  assert.equal(isUserPinned({ source: { kind: 'user' } }), true)
  assert.equal(isUserPinned({ source: { kind: 'fallback' } }), false)
  assert.equal(isUserPinned({ source: { kind: 'provider', provider: 'x' } }), false)
  assert.equal(isUserPinned(undefined), false)
  assert.equal(isUserPinned({}), false)
})

// ── 文本抽取 ────────────────────────────────────────────────────────────────

test('messageText: 只取 text 块、空白折叠、跳过 reasoning/tool', async () => {
  const content = [
    { type: 'reasoning', text: 'let me think' },
    { type: 'text', text: '你好\n世界' },
    { type: 'tool-call', name: 'x' },
    { type: 'text', text: '  第二段 ' }
  ]
  assert.equal(messageText(content), '你好 世界 第二段')
})
test('messageText: 非数组/空 → 空串', async () => {
  assert.equal(messageText(undefined), '')
  assert.equal(messageText([]), '')
  assert.equal(messageText([{ type: 'text', text: '   ' }]), '')
})

// ── 转写条目 ────────────────────────────────────────────────────────────────

const EVENTS = [
  { type: 'sandbox/mode', seq: 0, data: { mode: 'x' } },
  { type: 'user/message', seq: 7, data: { role: 'user', content: [{ type: 'text', text: '帮我修标题 bug' }] } },
  { type: 'assistant/message', seq: 8, data: { message: { content: [{ type: 'text', text: '好的，我来修' }] } } },
  { type: 'user/message', seq: 9, data: { role: 'user', content: [{ type: 'text', text: '继续' }] } },
  // 越出快照的用户消息（必须在 allowed 集之外）
  { type: 'user/message', seq: 10, data: { role: 'user', content: [{ type: 'text', text: '快照外消息' }] } },
  { type: 'assistant/message', seq: 11, data: { message: { content: [{ type: 'reasoning', text: 'think' }] } } }
]

test('extractTranscriptItems: 提取 user+assistant，seq 限定快照集，纯 reasoning 的 assistant 丢弃', async () => {
  const items = extractTranscriptItems(EVENTS, [7, 9], true)
  assert.deepEqual(items, [
    { role: 'user', seq: 7, text: '帮我修标题 bug' },
    { role: 'assistant', text: '好的，我来修' },
    { role: 'user', seq: 9, text: '继续' }
  ])
})
test('extractTranscriptItems: includeAssistant=false 时只剩用户消息', async () => {
  const items = extractTranscriptItems(EVENTS, [7, 9], false)
  assert.deepEqual(items, [
    { role: 'user', seq: 7, text: '帮我修标题 bug' },
    { role: 'user', seq: 9, text: '继续' }
  ])
})
test('extractTranscriptItems: 非数组日志 → 空数组', async () => {
  assert.deepEqual(extractTranscriptItems(undefined, [7], true), [])
})

// ── 字节裁剪 ────────────────────────────────────────────────────────────────

test('truncateTextUtf8: 不破码点地截断并加省略号', async () => {
  const s = '你'.repeat(100)
  const out = truncateTextUtf8(s, 20)
  assert.ok(Buffer.byteLength(out, 'utf8') <= 20)
  assert.ok(out.endsWith('…'))
})
test('truncateTextUtf8: 短文本原样返回', async () => {
  assert.equal(truncateTextUtf8('abc', 10), 'abc')
})

test('trimTranscript: 预算内全保留且顺序不变', async () => {
  const items = [
    { role: 'user', seq: 1, text: '第一个问题' },
    { role: 'assistant', text: '回答一' },
    { role: 'user', seq: 2, text: '第二个问题' }
  ]
  const out = trimTranscript(items, 10000)
  assert.deepEqual(out, items)
})

test('trimTranscript: 超预算时丢中间保首条用户消息与最新尾部', async () => {
  const big = 'x'.repeat(900) // 每条 ~900B
  const items = [
    { role: 'user', seq: 1, text: '第一个问题' },
    { role: 'assistant', text: big },
    { role: 'user', seq: 2, text: big },
    { role: 'assistant', text: big },
    { role: 'user', seq: 3, text: '最新问题' }
  ]
  const out = trimTranscript(items, 3000)
  const framed = frameTranscript(out)
  assert.ok(Buffer.byteLength(framed, 'utf8') <= 3000, `framed ${Buffer.byteLength(framed)}B must fit 3000B`)
  assert.equal(out[0].role, 'user')
  assert.equal(out[0].seq, 1)
  assert.equal(out[out.length - 1].seq, 3) // 最新消息必须在
})

test('trimTranscript: 单条巨大消息被硬截断后仍在预算内', async () => {
  const items = [{ role: 'user', seq: 1, text: 'y'.repeat(50000) }]
  const out = trimTranscript(items, 2000)
  assert.equal(out.length, 1)
  const framed = frameTranscript(out)
  assert.ok(Buffer.byteLength(framed, 'utf8') <= 2000, `framed ${Buffer.byteLength(framed)}B must fit 2000B`)
})

test('trimTranscript: 空输入 → 空数组', async () => {
  assert.deepEqual(trimTranscript([], 1000), [])
})

// ── 封帧与系统提示词 ───────────────────────────────────────────────────────

test('frameTranscript: 产出合法 JSON 且 user 条目带 seq、assistant 不带', async () => {
  const framed = frameTranscript([
    { role: 'user', seq: 7, text: '你好' },
    { role: 'assistant', text: '你好！' }
  ])
  const m = framed.match(/\[\s*[\s\S]*\]\s*$/)
  assert.ok(m, '尾部必须是 JSON 数组')
  const arr = JSON.parse(m[0])
  assert.deepEqual(arr, [
    { role: 'user', seq: 7, text: '你好' },
    { role: 'assistant', text: '你好！' }
  ])
})

test('systemPrompt: 包含词数与 CJK 字符目标', async () => {
  const s = systemPrompt({ targetWords: 6, targetCjkCharacters: 12 })
  assert.ok(s.includes('6 words'))
  assert.ok(s.includes('12 CJK'))
})

// ── 路由覆盖 ────────────────────────────────────────────────────────────────

test('resolveRouteOverride: 成对生效、半配对视为未提供、空缺为 undefined', async () => {
  assert.deepEqual(resolveRouteOverride('zhanlu', 'zhanlu/kimi-k3'), { provider: 'zhanlu', model: 'zhanlu/kimi-k3' })
  assert.equal(resolveRouteOverride('zhanlu', ''), null)
  assert.equal(resolveRouteOverride('', 'zhanlu/kimi-k3'), null)
  assert.equal(resolveRouteOverride('', ''), undefined)
  assert.equal(resolveRouteOverride(undefined, undefined), undefined)
})

// ── 端到端（mock ctx）：turn/end → refresh，钉住/排除路径不 refresh ────────

function makeMockCtx({ titleSource = 'fallback', titleText = '旧标题', session, rejection } = {}) {
  const effects = []
  const registered = []
  let eventHandler = null
  const refreshCalls = []
  const ctx = {
    logger: { info() {}, warn() {} },
    connection: { requestRejection: () => rejection },
    settings: {
      register(ns, schema, opts) {
        // 模拟真实 settings 服务：base 可被 update（深合并在宿主侧，平键直接覆盖）
        const base = { ...opts.base }
        return { get: () => ({ ...base }), update: async (patch) => { Object.assign(base, patch) } }
      }
    },
    sessionTitle: {
      register(p) {
        registered.push(p)
        return () => {}
      },
      get() {
        return titleSource === 'none' ? undefined : { source: { kind: titleSource }, title: titleText }
      },
      refresh(session) {
        refreshCalls.push(session.id)
        return Promise.resolve({ title: '新标题', source: { kind: 'provider' } })
      }
    },
    sessions: { list: () => [session] },
    llm: {},
    on(name, handler) {
      eventHandler = handler
      return () => {}
    },
    effect(fn, label) {
      effects.push({ ret: fn(), label })
    }
  }
  return { ctx, effects, registered, getHandler: () => eventHandler, refreshCalls }
}

function loadApply() {
  return require('../src/index.js').apply
}

test('apply: 注册提供方（automatic=first-prompt）并订阅 session/event', async () => {
  const apply = loadApply()
  const session = { id: 's1', header: {} }
  const { ctx, registered, effects, getHandler } = makeMockCtx({ session })
  await apply(ctx, {})
  assert.equal(registered.length, 1)
  assert.equal(registered[0].id, 'dsh-smart-title')
  assert.equal(registered[0].automatic, 'first-prompt')
  assert.equal(typeof registered[0].generate, 'function')
  assert.equal(effects.length, 2)
  assert.equal(typeof getHandler(), 'function')
})

test('apply: completed turn/end 触发 refresh；error turn 不触发', async () => {
  const apply = loadApply()
  const session = { id: 's1', header: {} }
  const { ctx, refreshCalls, getHandler } = makeMockCtx({ session })
  await apply(ctx, {})
  const handler = getHandler()
  handler(session, { type: 'turn/end', data: { reason: { kind: 'completed' }, turn: 1 } })
  handler(session, { type: 'turn/end', data: { reason: { kind: 'error', error: {} }, turn: 2 } })
  await new Promise((r) => setTimeout(r, 10))
  assert.deepEqual(refreshCalls, ['s1'])
})

test('apply: 用户钉住 / 子代理 / refreshOnTurnEnd=false 均不 refresh', async () => {
  const apply = loadApply()
  const pinned = { id: 's-pinned', header: {} }
  const sub = { id: 's-sub', header: { origin: 'subagent' } }
  const a = makeMockCtx({ titleSource: 'user', session: pinned })
  await apply(a.ctx, {})
  a.getHandler()(pinned, { type: 'turn/end', data: { reason: { kind: 'completed' } } })
  await new Promise((r) => setTimeout(r, 10))
  assert.deepEqual(a.refreshCalls, [])

  const b = makeMockCtx({ session: sub })
  await apply(b.ctx, {})
  b.getHandler()(sub, { type: 'turn/end', data: { reason: { kind: 'completed' } } })
  await new Promise((r) => setTimeout(r, 10))
  assert.deepEqual(b.refreshCalls, [])

  const c = makeMockCtx({ session: pinned })
  await apply(c.ctx, { refreshOnTurnEnd: false })
  c.getHandler()(pinned, { type: 'turn/end', data: { reason: { kind: 'completed' } } })
  await new Promise((r) => setTimeout(r, 10))
  assert.deepEqual(c.refreshCalls, [])
})

test('apply: 无标题会话（snapshot undefined）也触发 refresh（fallback 尚未物化的新会话）', async () => {
  const apply = loadApply()
  const session = { id: 's-fresh', header: {} }
  const { ctx, refreshCalls, getHandler } = makeMockCtx({ titleSource: 'none', session })
  await apply(ctx, {})
  getHandler()(session, { type: 'turn/end', data: { reason: { kind: 'completed' } } })
  await new Promise((r) => setTimeout(r, 10))
  assert.deepEqual(refreshCalls, ['s-fresh'])
})

test('apply: generate() 走通 happy path（seed 假 dsh-llm + mock llm.stream，不依赖宿主安装）', async () => {
  const apply = loadApply()
  const internals = require('../src/index.js').__internals

  // 假 BlockAssembler：实现与真实契约对齐的 push/blocks/finish（覆盖我们消费的形状）
  class FakeBlockAssembler {
    constructor() {
      this.parts = []
      this.finish = undefined
    }
    push(chunk) {
      if (chunk.type === 'text-delta') {
        if (typeof this.parts[this.parts.length - 1] !== 'string') this.parts.push('')
        this.parts[this.parts.length - 1] += chunk.text
      } else if (chunk.type === 'finish') {
        this.finish = chunk.reason
      }
    }
    blocks() {
      return this.parts.filter((p) => p.length > 0).map((p) => ({ type: 'text', text: p }))
    }
  }
  const fakeDshLlm = {
    BlockAssembler: FakeBlockAssembler,
    createUserMessage: (input) => ({ role: 'user', content: input.content, source: input.source }),
    deepFreeze: (value) => value
  }
  // 注入前先重置（模块级 promise 只 seed 一次；多次 seed 无害，apply 只读一次）
  internals.__seedDshLlm(fakeDshLlm)

  const session = {
    id: 's-gen',
    header: {},
    events: [
      { type: 'user/message', seq: 7, data: { content: [{ type: 'text', text: '帮我写个插件' }] } },
      { type: 'assistant/message', seq: 8, data: { message: { content: [{ type: 'text', text: '好的，正在写' }] } } }
    ]
  }
  const { ctx, registered } = makeMockCtx({ session })
  // 注入 mock llm：stream 产出真实 StreamChunk 形状（text-delta / finish）
  const chunks = [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text: '会话标题' },
    { type: 'text-delta', index: 0, text: '插件' },
    { type: 'block-end', index: 0, block: { type: 'text', text: '会话标题插件' } },
    { type: 'usage', usage: { inputTokens: 1, outputTokens: 2 } },
    { type: 'finish', reason: { kind: 'stop' } }
  ]
  ctx.llm = { stream: async function* () { for (const c of chunks) yield c } }
  await apply(ctx, {})
  const provider = registered[0]
  const result = await provider.generate({
    session,
    messages: [{ seq: 7, text: '帮我写个插件' }],
    route: { provider: 'zhanlu', model: 'zhanlu/glm-5.2' },
    signal: { throwIfAborted() {} }
  })
  assert.equal(result.title, '会话标题插件')
  assert.deepEqual(result.messageSeqs, [7])
  assert.deepEqual(result.model, { provider: 'zhanlu', model: 'zhanlu/glm-5.2' })
})

// ── 刷新节流 / 长会话冻结 / 同题抑制（纯函数）────────────────────────────

test('normalizeTitle: 空值→空串、空白折叠、大小写归一', async () => {
  assert.equal(normalizeTitle(null), '')
  assert.equal(normalizeTitle(undefined), '')
  assert.equal(normalizeTitle('  '), '')
  assert.equal(normalizeTitle('  Fix   DSH Deps '), 'fix dsh deps')
})

test('isSameTitle: 空标题永不同题（首题正常落库），大小写/空白差异算同题', async () => {
  assert.equal(isSameTitle('', 'x'), false)
  assert.equal(isSameTitle('  ', 'x'), false)
  assert.equal(isSameTitle('修复 DSH 依赖', '修复 dsh  依赖'), true)
  assert.equal(isSameTitle('修复依赖', '修复 依赖 bug'), false)
})

test('countUserTurns: 只数 user/message；优先 snapshotEvents()，events 兜底，全缺席 → null', async () => {
  const events = [
    { type: 'user/message', seq: 1, data: {} },
    { type: 'assistant/message', seq: 2, data: {} },
    { type: 'user/message', seq: 3, data: {} },
    { type: 'turn/end', data: {} }
  ]
  assert.equal(countUserTurns({ id: 's', events }), 2)
  assert.equal(countUserTurns({ id: 's', snapshotEvents: () => events }), 2)
  // spill 场景：events 属性非数组，snapshotEvents() 才是真日志
  assert.equal(countUserTurns({ id: 's', events: 'spilled', snapshotEvents: () => events }), 2)
  assert.equal(countUserTurns({ id: 's', events: 'spilled' }), null)
  assert.equal(countUserTurns({ id: 's' }), null)
  assert.equal(countUserTurns(null), null)
})

test('sessionEventsOf: snapshotEvents() 优先、异常吞掉、无访问器回退 events 属性', async () => {
  const evs = [{ type: 'user/message', seq: 1 }]
  assert.equal(sessionEventsOf({ snapshotEvents: () => evs, events: 'spilled' }), evs)
  assert.equal(sessionEventsOf({ events: evs }), evs)
  assert.deepEqual(sessionEventsOf({ snapshotEvents: () => { throw new Error('boom') } }), [])
  assert.deepEqual(sessionEventsOf({ events: 'spilled' }), [])
  assert.deepEqual(sessionEventsOf(null), [])
})

test('isThrottled: 0=不节流、无记录放行、窗口内拦截、过期放行', async () => {
  assert.equal(isThrottled(undefined, 10000, 5000), false)
  assert.equal(isThrottled(9000, 10000, 5000), true)
  assert.equal(isThrottled(4999, 10000, 5000), false)
  assert.equal(isThrottled(0, 10000, 0), false)
})

test('isFrozen: 0=不限、未知轮数放行、超过 cap 冻结、等于 cap 不冻', async () => {
  assert.equal(isFrozen(5, 0), false)
  assert.equal(isFrozen(null, 100), false)
  assert.equal(isFrozen(3, 2), true)
  assert.equal(isFrozen(2, 2), false)
})

// ── sanitizePatch / safeSettings ────────────────────────────────────────

test('sanitizePatch: 布尔白名单、数字夹取、字符串去尾空、未知键丢弃', async () => {
  const patch = sanitizePatch({
    enabled: false,
    includeAssistant: 'yes', // 非布尔 → 丢弃
    refreshOnTurnEnd: true,
    targetWords: 999, // 夹到 20
    maxInputBytes: 10, // 夹到 512
    refreshMinIntervalMs: -5, // 夹到 0
    refreshMaxTurns: '50', // 数字串 → 50
    excludeIdPrefixes: ' a , b ',
    provider: 'p1',
    bogus: 'x'
  })
  assert.equal(patch.enabled, false)
  assert.equal(patch.includeAssistant, undefined)
  assert.equal(patch.refreshOnTurnEnd, true)
  assert.equal(patch.targetWords, 20)
  assert.equal(patch.maxInputBytes, 512)
  assert.equal(patch.refreshMinIntervalMs, 0)
  assert.equal(patch.refreshMaxTurns, 50)
  assert.equal(patch.excludeIdPrefixes, 'a , b')
  assert.equal(patch.bogus, undefined)
})

test('sanitizePatch: 路由半配对两边都丢弃，成对保留；非对象输入 → 空 patch', async () => {
  assert.equal(sanitizePatch({ provider: 'p1', model: '' }).provider, undefined)
  assert.equal(sanitizePatch({ provider: '', model: 'm1' }).model, undefined)
  assert.deepEqual(sanitizePatch({ provider: ' p1 ', model: ' m1 ' }), { provider: 'p1', model: 'm1' })
  assert.deepEqual(sanitizePatch(null), {})
  assert.deepEqual(sanitizePatch('x'), {})
})

test('safeSettings: 只透出 DEFAULTS 键集合', async () => {
  const out = safeSettings({ ...DEFAULTS, extra: 'x' })
  assert.deepEqual(Object.keys(out).sort(), Object.keys(DEFAULTS).sort())
  assert.equal(out.extra, undefined)
})

// ── apply 级：同题静默 / 节流 / 冻结 / 回填豁免 / HTTP API ────────────────

const genChunks = (text) => [
  { type: 'block-start', index: 0, blockType: 'text' },
  { type: 'text-delta', index: 0, text },
  { type: 'block-end', index: 0, block: { type: 'text', text } },
  { type: 'finish', reason: { kind: 'stop' } }
]

function seedFakeLlm() {
  class FakeBlockAssembler {
    constructor() { this.parts = []; this.finish = undefined }
    push(chunk) {
      if (chunk.type === 'text-delta') {
        if (typeof this.parts[this.parts.length - 1] !== 'string') this.parts.push('')
        this.parts[this.parts.length - 1] += chunk.text
      } else if (chunk.type === 'finish') this.finish = chunk.reason
    }
    blocks() { return this.parts.filter((p) => p.length > 0).map((p) => ({ type: 'text', text: p })) }
  }
  require('../src/index.js').__internals.__seedDshLlm({
    BlockAssembler: FakeBlockAssembler,
    createUserMessage: (input) => ({ role: 'user', content: input.content, source: input.source }),
    deepFreeze: (value) => value
  })
}

const genSession = (id = 's-gen') => ({
  id,
  header: {},
  events: [
    { type: 'user/message', seq: 7, data: { content: [{ type: 'text', text: '帮我写个插件' }] } },
    { type: 'assistant/message', seq: 8, data: { message: { content: [{ type: 'text', text: '好的，正在写' }] } } }
  ]
})

async function runGenerate(ctx, registered, session, text) {
  ctx.llm = { stream: async function* () { for (const c of genChunks(text)) yield c } }
  return registered[0].generate({
    session,
    messages: [{ seq: 7, text: '帮我写个插件' }],
    route: { provider: 'zhanlu', model: 'zhanlu/glm-5.2' },
    signal: { throwIfAborted() {} }
  })
}

test('apply: generate 同题静默——返回现标题原文，不抛错', async () => {
  seedFakeLlm()
  const apply = loadApply()
  const session = genSession('s-same')
  // 现标题带尾随空格；生成结果归一化后与之相同 → 返回现标题原文
  const { ctx, registered } = makeMockCtx({ session, titleText: '会话标题插件 ' })
  await apply(ctx, {})
  const result = await runGenerate(ctx, registered, session, '会话标题插件')
  assert.equal(result.title, '会话标题插件 ')
  assert.deepEqual(result.messageSeqs, [7])
})

test('apply: generate 不同题 → 返回新生成标题', async () => {
  seedFakeLlm()
  const apply = loadApply()
  const session = genSession('s-diff')
  const { ctx, registered } = makeMockCtx({ session, titleText: '完全不同的旧标题' })
  await apply(ctx, {})
  const result = await runGenerate(ctx, registered, session, '会话标题插件')
  assert.equal(result.title, '会话标题插件')
})

test('apply: 节流——generate 后窗口内的 turn/end 不再 refresh；窗口过期放行', async () => {
  seedFakeLlm()
  const apply = loadApply()

  // 窗口 60s：generate 之后立刻来的 turn/end 被节流
  const session = genSession('s-throttle')
  const a = makeMockCtx({ session })
  await apply(a.ctx, { refreshMinIntervalMs: 60000 })
  await runGenerate(a.ctx, a.registered, session, '第一个标题')
  a.getHandler()(session, { type: 'turn/end', data: { reason: { kind: 'completed' } } })
  await new Promise((r) => setTimeout(r, 10))
  assert.deepEqual(a.refreshCalls, [])

  // 窗口 20ms：过期后 turn/end 正常 refresh
  const session2 = genSession('s-throttle2')
  const b = makeMockCtx({ session: session2 })
  await apply(b.ctx, { refreshMinIntervalMs: 20 })
  await runGenerate(b.ctx, b.registered, session2, '第二个标题')
  await new Promise((r) => setTimeout(r, 60))
  b.getHandler()(session2, { type: 'turn/end', data: { reason: { kind: 'completed' } } })
  await new Promise((r) => setTimeout(r, 10))
  assert.deepEqual(b.refreshCalls, ['s-throttle2'])
})

test('apply: 长会话冻结——用户消息超过 refreshMaxTurns 的 turn/end 不 refresh', async () => {
  seedFakeLlm()
  const apply = loadApply()
  const session = {
    id: 's-long',
    header: {},
    events: [
      { type: 'user/message', seq: 1, data: { content: [{ type: 'text', text: '一' }] } },
      { type: 'user/message', seq: 2, data: { content: [{ type: 'text', text: '二' }] } },
      { type: 'user/message', seq: 3, data: { content: [{ type: 'text', text: '三' }] } }
    ]
  }
  const { ctx, refreshCalls, getHandler } = makeMockCtx({ session })
  await apply(ctx, { refreshMaxTurns: 2, refreshMinIntervalMs: 0 })
  getHandler()(session, { type: 'turn/end', data: { reason: { kind: 'completed' } } })
  await new Promise((r) => setTimeout(r, 10))
  assert.deepEqual(refreshCalls, [])

  // cap=0（不限制）→ 正常 refresh
  const { ctx: ctx2, refreshCalls: rc2, getHandler: gh2 } = makeMockCtx({ session })
  await apply(ctx2, { refreshMaxTurns: 0, refreshMinIntervalMs: 0 })
  gh2()(session, { type: 'turn/end', data: { reason: { kind: 'completed' } } })
  await new Promise((r) => setTimeout(r, 10))
  assert.deepEqual(rc2, ['s-long'])
})

test('apply: 启动回填豁免冻结——超长 fallback 会话仍被回填', async () => {
  seedFakeLlm()
  const apply = loadApply()
  const session = {
    id: 's-backfill',
    header: {},
    events: [
      { type: 'user/message', seq: 1, data: { content: [{ type: 'text', text: '一' }] } },
      { type: 'user/message', seq: 2, data: { content: [{ type: 'text', text: '二' }] } },
      { type: 'user/message', seq: 3, data: { content: [{ type: 'text', text: '三' }] } }
    ]
  }
  const { ctx, refreshCalls } = makeMockCtx({ session })
  await apply(ctx, { refreshMaxTurns: 2, backfillOnStart: true, backfillMaxSessions: 5, backfillIntervalMs: 5 })
  await new Promise((r) => setTimeout(r, 80))
  assert.deepEqual(refreshCalls, ['s-backfill'])
})

// ── HTTP API：status 读 / settings 白名单写入 ────────────────────────────

function makeRes() {
  return {
    code: null, headers: null, body: null,
    writeHead(code, headers) { this.code = code; this.headers = headers },
    end(body) { this.body = body }
  }
}

function makeReq(method, url, bodyObj) {
  const chunk = bodyObj === undefined ? null : Buffer.from(JSON.stringify(bodyObj))
  return {
    method,
    url,
    on(ev, cb) {
      if (ev === 'data' && chunk) cb(chunk)
      else if (ev === 'end') setImmediate(cb)
    }
  }
}

test('apply: webServer 缺席时跳过 API 注册（无注入也不炸）', async () => {
  const apply = loadApply()
  const session = { id: 's-noapi', header: {} }
  const { ctx, getHandler } = makeMockCtx({ session })
  await apply(ctx, {})
  assert.equal(typeof getHandler(), 'function')
})

test('apply: GET /status 返回 armed 与设置全集；PUT /settings 白名单清洗落库', async () => {
  const apply = loadApply()
  const session = { id: 's-api', header: {} }
  const { ctx, registered } = makeMockCtx({ session })
  const apiRegisters = []
  ctx.webServer = { register(h) { apiRegisters.push(h); return () => {} } }
  await apply(ctx, {})
  assert.equal(apiRegisters.length, 1)
  const handler = apiRegisters[0].handler

  // GET /status
  const res1 = makeRes()
  await handler(makeReq('GET', '/dsh-smart-title/api/status'), res1)
  const d1 = JSON.parse(res1.body)
  assert.equal(res1.code, 200)
  assert.equal(d1.armed, true)
  assert.equal(d1.settings.refreshMinIntervalMs, DEFAULTS.refreshMinIntervalMs)
  assert.equal(d1.settings.refreshMaxTurns, DEFAULTS.refreshMaxTurns)

  // PUT /settings：夹取 + 半配对丢弃 + 未知键丢弃（走 settingsScope.update 主路径）
  const res2 = makeRes()
  await handler(makeReq('PUT', '/dsh-smart-title/api/settings', {
    refreshMinIntervalMs: 999999999,
    targetWords: 7,
    provider: 'p1',
    model: '',
    bogus: 1
  }), res2)
  const d2 = JSON.parse(res2.body)
  assert.equal(res2.code, 200)
  assert.equal(d2.settings.refreshMinIntervalMs, 3600000)
  assert.equal(d2.settings.targetWords, 7)
  assert.equal(d2.settings.provider, '')

  // 未知路径 → 404
  const res3 = makeRes()
  await handler(makeReq('GET', '/dsh-smart-title/api/nope'), res3)
  assert.equal(res3.code, 404)
})

test('every route sits behind the connection trust fence', async () => {
  const apply = loadApply()
  const session = { id: 's-fence', header: {} }
  const { ctx } = makeMockCtx({ session, rejection: 401 })
  const apiRegisters = []
  ctx.webServer = { register(h) { apiRegisters.push(h); return () => {} } }
  await apply(ctx, {})
  assert.equal(apiRegisters.length, 1)
  const handler = apiRegisters[0].handler
  const res = { statusCode: null, code: null, body: null, writeHead(c) { this.statusCode = c; this.code = c }, end(b) { this.body = b } }
  await handler({ method: 'GET', url: '/dsh-smart-title/api/status', headers: {} }, res)
  assert.equal(res.statusCode, 401, 'unauthenticated status read is refused')
})
