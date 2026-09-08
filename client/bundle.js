/* Generated from client/index.js by scripts/build-client.mjs — do not edit by hand.
 * Regenerate with: npm run build:client
 */
window.__ModuleLoader__.load({
  id: "@weibaohui/dsh-smart-title",
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" })
    var React = require("react")
    /**
     * @weibaohui/dsh-smart-title - Browser half.
     *
     * Single surface: the host settings page section (a `settings.section` slot =
     * one nav entry in the settings window). All colors come from the ui-theme
     * `--dsw-*` token layers so light/dark follows the shell; all copy comes from
     * the locale registry (`zh`/`en`). The client is a thin editor over the
     * plugin's HTTP API (GET /status, PUT /settings, GET /models) — the host
     * plugin owns the sessionTitle provider and the turn/end refresh loop.
     */

    // React is a loader platform module. Under plain Node (contract tests) a
    // minimal createElement/hook shim keeps the source loadable for assertions.
    let __React = null
    try { __React = require('react') } catch {}
    if (!__React || typeof __React.createElement !== 'function') {
      __React = {
        createElement(type, props, ...kids) {
          return { type, props: props || {}, kids: kids.flat(9).filter(k => k !== null && k !== undefined && k !== false && k !== true || true) }
        },
        useState(init) { const v = [typeof init === 'function' ? init() : init]; return [v[0], x => { v[0] = typeof x === 'function' ? x(v[0]) : x }] },
        useEffect() {}, useMemo(fn) { return fn() }, useRef(v = null) { return { current: v } },
      }
    }
    const { createElement: h, useState, useEffect } = __React

    // Platform module — always present in the loader's seeded require table.
    // Under plain Node (tests) it is absent; a tagged-element shim keeps the
    // tree structurally testable while the save button ships a real primitive.
    let P = null
    try { P = require('@deepseek-ai/dsh-client-ui-primitives') } catch {}

    /** Idempotent stylesheet injection. */
    function ensureStyles() {
      if (typeof document === 'undefined' || document.getElementById('dshst-styles')) return
      const holder = document.createElement('div')
      holder.id = 'dshst-styles'
      holder.style.display = 'none'
      holder.innerHTML = STYLE
      document.head.appendChild(holder)
    }

    const prim = (name) => P && P[name]
      ? P[name]
      : function Shim(props) {
          const { children, ...rest } = props
          return h('button', { ...rest, 'data-p-shim': name }, children)
        }

    // ── Locale ───────────────────────────────────────────────────────────────

    const NS = 'dshSmartTitle'

    const ZH = {
      title: '会话智能标题',
      armed: '已接管标题',
      notArmed: '未就绪',
      notArmedHint: 'LLM 加载失败，标题生成不可用（保持回退标题）',
      hint: '每轮对话结束后用 LLM 总结完整转写改写会话标题；首条消息即时出题，手动改过的标题不会被覆盖。',
      secBasics: '基础',
      enabled: '启用会话智能标题',
      includeAssistant: '转写包含助手回答',
      includeAssistantHint: '关闭后只用用户消息出题（官方 first-prompt 的语义），更省 token',
      targetWordsLabel: '标题词数目标（非 CJK）',
      targetCjkLabel: '标题字数目标（CJK）',
      maxInputBytesLabel: '转写字节预算',
      maxInputBytesHint: '完整转写封帧后的 UTF-8 字节上限，超预算从最旧的消息开始丢弃（首条用户消息始终保留）',
      maxOutputTokensLabel: '输出 token 上限',
      maxOutputTokensHint: '给思考型模型留余量，正常标题远用不满',
      timeoutMsLabel: '生成超时（毫秒）',
      secRefresh: '刷新策略',
      refreshOnTurnEnd: '每轮结束后刷新标题',
      refreshIntervalLabel: '刷新最小间隔（毫秒，0 = 不节流）',
      refreshIntervalHint: '距上次标题生成不足该间隔就不再重复生成；同时消掉首轮「即时出题 + 回合结束刷新」的背靠背重复。默认 120000 = 2 分钟',
      refreshMaxTurnsLabel: '长会话冻结阈值（条用户消息，0 = 不限制）',
      refreshMaxTurnsHint: '会话用户消息超过该数量后停止自动刷新（启动回填不受限）；长会话后期主题漂移概率低，冻结可省掉无谓调用',
      sameTitleNote: '新生成的标题与现标题相同（忽略大小写与空白差异）时自动跳过写入，侧栏不会闪烁，也不会产生失败告警。',
      secRoute: '标题模型路由',
      routeHint: '为标题单独指定一条便宜/快速的模型路由；不配置则跟随会话当前模型。两项必须同时配置或同时留空。',
      routeProviderLabel: 'provider（可选）',
      routeModelLabel: 'model（可选）',
      useCurrent: '沿用当前',
      currentSetting: '当前设置',
      catalogUnavailable: '模型目录不可用——仍可手改 settings.yaml 的 provider/model',
      secScope: '范围与启动回填',
      excludeForks: '跳过 fork 子会话',
      excludePrefixesLabel: '跳过的会话 id 前缀（逗号分隔）',
      excludePrefixesHint: '命中的会话完全不处理；如 hermes-loop-review-',
      backfillOnStart: '启动回填存量会话',
      backfillHint: '启动时对标题仍是回退文案的活跃会话逐个重写（默认关闭；手动改名过的不动）',
      backfillMaxSessionsLabel: '回填会话上限',
      backfillIntervalMsLabel: '回填间隔（毫秒）',
      save: '保存',
      saved: '设置已保存',
      loading: '…',
      operationFailed: '操作失败',
    }

    const EN = {
      title: 'Smart Session Titles',
      armed: 'title provider armed',
      notArmed: 'not ready',
      notArmedHint: 'LLM unavailable — title generation disabled (fallback titles stay)',
      hint: 'After each turn an LLM summarizes the full transcript into the session title; the first message titles instantly, and titles you renamed by hand are never overwritten.',
      secBasics: 'Basics',
      enabled: 'Enable smart session titles',
      includeAssistant: 'Include assistant replies in transcript',
      includeAssistantHint: 'Off = user messages only (official first-prompt semantics), cheaper',
      targetWordsLabel: 'Target word count (non-CJK)',
      targetCjkLabel: 'Target character count (CJK)',
      maxInputBytesLabel: 'Transcript byte budget',
      maxInputBytesHint: 'UTF-8 byte cap for the framed transcript; over budget drops oldest messages first (first user message always kept)',
      maxOutputTokensLabel: 'Max output tokens',
      maxOutputTokensHint: 'Headroom for thinking models; a normal title needs far less',
      timeoutMsLabel: 'Generation timeout (ms)',
      secRefresh: 'Refresh policy',
      refreshOnTurnEnd: 'Refresh after every turn',
      refreshIntervalLabel: 'Min refresh interval (ms, 0 = no throttle)',
      refreshIntervalHint: 'Skips regeneration within this window after the last title generation; also removes the first-turn back-to-back double generation. Default 120000 = 2 min',
      refreshMaxTurnsLabel: 'Long-session freeze (user messages, 0 = unlimited)',
      refreshMaxTurnsHint: 'Stops auto-refresh once a session exceeds this many user messages (startup backfill unaffected); late-session topic drift is rare, freezing saves calls',
      sameTitleNote: 'When a generated title matches the current one (ignoring case/whitespace), the write is skipped silently — no sidebar flicker, no failure logs.',
      secRoute: 'Title model route',
      routeHint: 'Route titles to a cheap/fast model; leave empty to follow the session model. Both fields must be set together or both empty.',
      routeProviderLabel: 'provider (optional)',
      routeModelLabel: 'model (optional)',
      useCurrent: 'Keep current',
      currentSetting: 'current setting',
      catalogUnavailable: 'Model catalog unavailable — edit provider/model in settings.yaml directly',
      secScope: 'Scope & startup backfill',
      excludeForks: 'Skip fork child sessions',
      excludePrefixesLabel: 'Excluded session id prefixes (comma separated)',
      excludePrefixesHint: 'Matching sessions are never touched; e.g. hermes-loop-review-',
      backfillOnStart: 'Backfill existing sessions on start',
      backfillHint: 'On startup, rewrites titles that are still fallback text (off by default; manually renamed titles untouched)',
      backfillMaxSessionsLabel: 'Backfill session cap',
      backfillIntervalMsLabel: 'Backfill interval (ms)',
      save: 'Save',
      saved: 'Settings saved',
      loading: '…',
      operationFailed: 'Operation failed',
    }

    // ── Pure helpers ────────────────────────────────────────────────────────

    const API = '/dsh-smart-title/api'

    async function getJson(url) {
      const r = await fetch(url)
      if (!r.ok) throw new Error('HTTP ' + r.status)
      return r.json()
    }

    function num(v, fallback) { const n = Number(v); return Number.isFinite(n) ? n : fallback }

    // ── Token-based stylesheet (light/dark adaptive by construction) ────────

    const STYLE = `<style>
    .dst-page{position:relative;display:flex;flex-direction:column;gap:14px;color:var(--dsw-alias-label-primary);font-family:var(--dsw-font-family);font-size:var(--dsw-font-sm-14,14px)}
    .dst-body{display:flex;flex-direction:column;gap:14px}
    .dst-toolbar{display:flex;gap:10px;align-items:center;flex-wrap:wrap}
    .dst-spacer{flex:1}
    .dst-hint{color:var(--dsw-alias-label-secondary)}
    .dst-dir{color:var(--dsw-alias-label-tertiary);font-size:var(--dsw-font-xs-13,12px)}
    .dst-tag{display:inline-flex;align-items:center;padding:2px 9px;border-radius:999px;background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary);font-size:11.5px}
    .dst-tag.accent{color:var(--dsw-alias-state-business-primary);border-color:var(--dsw-alias-state-business-primary)}
    .dst-card{display:flex;flex-direction:column;gap:10px;padding:16px;border-radius:12px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1)}
    .dst-title{font-size:13px;font-weight:600;color:var(--dsw-alias-label-primary)}
    .dst-row{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
    .dst-field{display:flex;flex-direction:column;gap:4px}
    .dst-toggle{display:flex;align-items:center;gap:8px;padding:8px 12px;border:1px solid var(--dsw-alias-border-l2);border-radius:10px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-secondary);font-size:13px;cursor:pointer}
    .dst-toggle.on{border-color:var(--dsw-alias-state-business-primary);color:var(--dsw-alias-state-business-primary);background:var(--dsw-alias-interactive-bg-hover)}
    .dst-btn{display:inline-flex;align-items:center;justify-content:center;gap:6px;min-height:32px;padding:6px 16px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);font-size:13px;font-weight:500;cursor:pointer;font-family:var(--dsw-font-family);white-space:nowrap}
    .dst-btn:hover{border-color:var(--dsw-alias-border-l3);background:var(--dsw-alias-interactive-bg-hover)}
    .dst-btn:disabled{opacity:.5;cursor:not-allowed}
    .dst-btn-primary{background:var(--dsw-alias-state-business-primary);border-color:transparent;color:var(--dsw-alias-label-primary-inverted,#fff)}
    .dst-input{min-height:32px;padding:6px 12px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);font-size:13px;font-family:var(--dsw-font-family);outline:none;box-sizing:border-box}
    .dst-input:focus{border-color:var(--dsw-alias-state-business-primary)}
    .dst-toast{position:fixed;left:50%;bottom:28px;transform:translateX(-50%);z-index:40;background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-primary);border:1px solid var(--dsw-alias-border-l2);border-radius:999px;padding:8px 18px;font-size:13px;box-shadow:var(--dsw-shadow-lv2)}
    .dst-spin{width:22px;height:22px;border-radius:50%;border:3px solid var(--dsw-alias-border-l2);border-top-color:var(--dsw-alias-brand-primary,var(--dsw-alias-state-business-primary));animation:dstspin .7s linear infinite}
    @keyframes dstspin{to{transform:rotate(360deg)}}
    </style>`

    // ── Small building blocks ────────────────────────────────────────────────

    const Tag = ({ tone, children }) =>
      h('span', { className: 'dst-tag' + (tone ? ' ' + tone : '') }, children)

    function ButtonLite({ primary, children, ...rest }) {
      const cls = 'dst-btn' + (primary ? ' dst-btn-primary' : '')
      if (prim('Button')) {
        return h(P.Button, { variant: primary ? 'primary' : 'outline', size: 'md', className: cls, ...rest }, children)
      }
      return h('button', { className: cls, ...rest }, children)
    }

    function InToast({ text }) {
      return h('div', { className: 'dst-toast' }, text)
    }

    // ── Settings section: the single entrance (host settings page section) ──

    function SettingsSection({ t }) {
      const [status, setStatus] = useState(null)
      const [busy, setBusy] = useState(false)
      const [toastText, setToastText] = useState(null)
      const [modelCatalog, setModelCatalog] = useState(null)
      // 分态受控值（保存前只改本地，保存统一走 PUT）
      const [s, setS] = useState(null) // settings 快照的工作副本

      const onToast = (text, ms = 3000) => { setToastText(text); setTimeout(() => setToastText(null), ms) }
      const set = (key, value) => setS(prev => ({ ...prev, [key]: value }))

      const refresh = () => getJson(API + '/status').then(d => {
        setStatus(d)
        if (d && d.settings) setS({ ...d.settings })
      }).catch(() => {})
      const refreshCatalog = () => getJson(API + '/models')
        .then(d => setModelCatalog(d && Array.isArray(d.providers) && d.providers.length > 0 ? d : null))
        .catch(() => setModelCatalog(null))
      useEffect(() => {
        refresh()
        refreshCatalog()
      }, [])

      const doSave = async () => {
        setBusy(true)
        try {
          const r = await fetch(API + '/settings', {
            method: 'PUT', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(s || {}),
          })
          const d = await r.json().catch(() => ({}))
          if (!r.ok) throw new Error(d.error || 'HTTP ' + r.status)
          if (d.settings) setS({ ...d.settings })
          onToast(t('saved'), 2200)
          refresh()
        } catch (e) { onToast(e.message || t('operationFailed'), 4000) }
        finally { setBusy(false) }
      }

      const toggle = (key, label) => h('label', { className: 'dst-toggle' + (s && s[key] ? ' on' : '') },
        h('input', { type: 'checkbox', checked: Boolean(s && s[key]), onChange: e => set(key, e.target.checked) }), label)

      const numField = (key, label, hint, min, max, width = 130) => h('div', { className: 'dst-field' },
        h('label', { className: 'dst-dir' }, label),
        h('input', { className: 'dst-input', type: 'number', min, max, value: num(s && s[key], min), style: { width },
          onChange: e => set(key, Math.min(max, Math.max(min, num(e.target.value, min)))) }),
        hint ? h('div', { className: 'dst-dir', style: { maxWidth: 420 } }, hint) : null)

      const textField = (key, label, hint, placeholder, width = '100%') => h('div', { className: 'dst-field', style: { flex: 1, minWidth: 220 } },
        h('label', { className: 'dst-dir' }, label),
        h('input', { className: 'dst-input', value: String((s && s[key]) ?? ''), placeholder, style: { width },
          onChange: e => set(key, e.target.value) }),
        hint ? h('div', { className: 'dst-dir' }, hint) : null)

      // provider+model 下拉（实时目录）；目录缺失时仅显示「沿用当前」与已存值，
      // 保证受控 select 有匹配项。清 provider 时连带清 model（成对语义）。
      const routePicker = () => {
        const catalog = modelCatalog
        const providerVal = String((s && s.provider) ?? '')
        const modelVal = String((s && s.model) ?? '')
        const pe = catalog && providerVal ? catalog.providers.find(p => p.id === providerVal) : null
        const missingProvider = providerVal && !(catalog && catalog.providers.some(p => p.id === providerVal))
        const missingModel = providerVal && modelVal && !(pe && pe.models.some(m => m.id === modelVal))
        const defLabel = (d, k) => d && d[k] ? '（' + d[k] + '）' : ''
        return h('div', { className: 'dst-row' },
          h('div', { className: 'dst-field', style: { flex: 1, minWidth: 200 } },
            h('label', { className: 'dst-dir' }, t('routeProviderLabel')),
            h('select', { className: 'dst-input', value: providerVal, style: { width: '100%' },
              onChange: e => {
                const v = e.target.value
                set('provider', v)
                const np = catalog ? catalog.providers.find(p => p.id === v) : null
                if (!np || !np.models.some(m => m.id === modelVal)) set('model', '')
              } },
              h('option', { value: '' }, t('useCurrent') + defLabel(catalog && catalog.default, 'provider')),
              catalog ? catalog.providers.map(p => h('option', { key: p.id, value: p.id }, p.name && p.name !== p.id ? p.name + '（' + p.id + '）' : p.id)) : null,
              missingProvider ? h('option', { key: '__prov__', value: providerVal }, providerVal + '（' + t('currentSetting') + '）') : null)),
          h('div', { className: 'dst-field', style: { flex: 1, minWidth: 200 } },
            h('label', { className: 'dst-dir' }, t('routeModelLabel')),
            h('select', { className: 'dst-input', value: providerVal ? modelVal : '', disabled: !providerVal, style: { width: '100%' },
              onChange: e => set('model', e.target.value) },
              !providerVal
                ? h('option', { value: '' }, t('useCurrent') + defLabel(catalog && catalog.default, 'model'))
                : [h('option', { key: '__keep__', value: '' }, t('useCurrent')),
                   pe ? pe.models.map(m => h('option', { key: m.id, value: m.id }, m.name && m.name !== m.id ? m.name + '（' + m.id + '）' : m.id)) : null,
                   missingModel ? h('option', { key: '__custom__', value: modelVal }, modelVal + '（' + t('currentSetting') + '）') : null])))
      }

      let body
      try {
        body = s === null
          ? h('div', { style: { display: 'flex', alignItems: 'center', gap: 10, padding: 24, color: 'var(--dsw-alias-label-secondary)' } },
              h('div', { className: 'dst-spin' }), t('loading'))
          : h('div', { className: 'dst-body' },
              h('div', { className: 'dst-toolbar' },
                h(Tag, { tone: status && status.armed ? 'accent' : '' }, status && status.armed ? t('armed') : t('notArmed')),
                h('span', { className: 'dst-spacer' }),
                status && !status.armed && h(Tag, null, t('notArmed'))),
              h('div', { className: 'dst-hint' }, t('hint')),
              // ── 卡1：基础 ──
              h('div', { className: 'dst-card' },
                h('div', { className: 'dst-title' }, t('secBasics')),
                toggle('enabled', t('enabled')),
                toggle('includeAssistant', t('includeAssistant')),
                h('div', { className: 'dst-dir' }, t('includeAssistantHint')),
                h('div', { className: 'dst-row' },
                  numField('targetWords', t('targetWordsLabel'), '', 1, 20, 100),
                  numField('targetCjkCharacters', t('targetCjkLabel'), '', 1, 40, 100),
                  numField('maxOutputTokens', t('maxOutputTokensLabel'), '', 16, 8192),
                  numField('timeoutMs', t('timeoutMsLabel'), '', 1000, 2147483647)),
                numField('maxInputBytes', t('maxInputBytesLabel'), t('maxInputBytesHint'), 512, 200000)),
              // ── 卡2：刷新策略 ──
              h('div', { className: 'dst-card' },
                h('div', { className: 'dst-title' }, t('secRefresh')),
                toggle('refreshOnTurnEnd', t('refreshOnTurnEnd')),
                h('div', { className: 'dst-row' },
                  numField('refreshMinIntervalMs', t('refreshIntervalLabel'), '', 0, 3600000),
                  numField('refreshMaxTurns', t('refreshMaxTurnsLabel'), '', 0, 100000)),
                h('div', { className: 'dst-dir' }, t('refreshIntervalHint')),
                h('div', { className: 'dst-dir' }, t('refreshMaxTurnsHint')),
                h('div', { className: 'dst-dir' }, t('sameTitleNote'))),
              // ── 卡3：标题模型路由 ──
              h('div', { className: 'dst-card' },
                h('div', { className: 'dst-title' }, t('secRoute')),
                h('div', { className: 'dst-dir' }, t('routeHint')),
                routePicker(),
                !modelCatalog ? h('div', { className: 'dst-dir' }, t('catalogUnavailable')) : null),
              // ── 卡4：范围与启动回填 ──
              h('div', { className: 'dst-card' },
                h('div', { className: 'dst-title' }, t('secScope')),
                toggle('excludeForks', t('excludeForks')),
                textField('excludeIdPrefixes', t('excludePrefixesLabel'), t('excludePrefixesHint'), 'hermes-loop-review-'),
                toggle('backfillOnStart', t('backfillOnStart')),
                h('div', { className: 'dst-dir' }, t('backfillHint')),
                h('div', { className: 'dst-row' },
                  numField('backfillMaxSessions', t('backfillMaxSessionsLabel'), '', 1, 200, 100),
                  numField('backfillIntervalMs', t('backfillIntervalMsLabel'), '', 0, 60000))),
              h('div', { className: 'dst-toolbar' },
                h(ButtonLite, { primary: true, disabled: busy, onClick: doSave }, t('save'))))
      } catch (renderErr) {
        ;(globalThis.__skErrors = globalThis.__skErrors || []).push('body: ' + (renderErr && renderErr.message))
        body = h('div', { className: 'dst-card', style: { color: 'var(--dsw-alias-state-error-primary)' } },
          '\u26A0\uFE0F ' + String((renderErr && renderErr.message) || renderErr))
      }

      return h('div', { className: 'dst-page' },
        h('div', { className: 'dst-body' }, body),
        toastText && h(InToast, { text: toastText }),
      )
    }

    function SettingsSlotComponent(props) {
      useEffect(ensureStyles, [])
      return h(SettingsSection, { t: props.__t })
    }

    // ── Plugin plane contract ────────────────────────────────────────────────

    const CLIENT_NAME = '@weibaohui/dsh-smart-title'

    module.exports = {
      name: CLIENT_NAME,
      inject: ['slots', 'locale'],
      __internals: { NS, ZH, EN },
      __boot(container, opts = {}) {
        ensureStyles()
        let t = opts.t || ((key) => ZH[key] ?? EN[key] ?? key)
        const root = require('react-dom/client').createRoot(container)
        root.render(h(SettingsSection, { t }))
        return root
      },
      apply(ctx) {
        let t = (key) => ZH[key] ?? EN[key] ?? key
        try {
          if (ctx.locale && typeof ctx.locale.register === 'function') {
            ctx.locale.register(NS, 'zh', ZH)
            ctx.locale.register(NS, 'en', EN)
            const bound = typeof ctx.locale.bind === 'function' ? ctx.locale.bind(NS) : null
            if (bound) t = (key) => bound(key) || (ZH[key] ?? EN[key] ?? key)
          }
        } catch (e) { try { console.error('[dsh-smart-title] locale init:', e) } catch {} }
        ctx.effect(() => {
          try {
            ctx.slots.inject('settings.section', () => ctx.slots.register({
              name: 'settings.section',
              id: CLIENT_NAME,
              order: 95,
              locale: NS,
              label: () => t('title'),
              inject: () => ({}),
            }, function SettingsSectionSlot() {
              return h(SettingsSlotComponent, { __t: t })
            }))
          } catch (e) { (globalThis.__skErrors = globalThis.__skErrors || []).push('settings:' + (e && e.message)); throw e }
        }, 'dsh-smart-title: settings section')
      },
    }

    return module.exports
  }
})
