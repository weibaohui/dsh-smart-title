import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { __internals } = require('../src/index.js')
const {
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

function makeMockCtx({ titleSource = 'fallback', session }) {
  const effects = []
  const registered = []
  let eventHandler = null
  const refreshCalls = []
  const ctx = {
    logger: { info() {}, warn() {} },
    settings: {
      register(ns, schema, opts) {
        return { get: () => ({ ...opts.base }) }
      }
    },
    sessionTitle: {
      register(p) {
        registered.push(p)
        return () => {}
      },
      get() {
        return titleSource === 'none' ? undefined : { source: { kind: titleSource }, title: '旧标题' }
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

test('apply: generate() 走通 happy path（mock llm.stream）', async () => {
  const apply = loadApply()
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
