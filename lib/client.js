window.__ModuleLoader__.load({
  id: 'dsh-prompt-prediction',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports

    const react = require('react')
    const h = react.createElement

    // -------------------------------------------------------------------------
    // Bridge (mirrors the host routes registered in lib/index.js)
    // -------------------------------------------------------------------------

    const PREFIX = '/api/dsh-prompt-prediction'
    /** Poll period while the composer is empty; the payload is revision-gated. */
    const POLL_MS = 700
    const POLL_TIMEOUT_MS = 5000
    const MAX_RETRY_MS = 30000
    let nextDescriptionId = 0
    const ACCEPTED_FLAG = 'dsh.prompt-prediction.hasAccepted'
    const CSS_ID = 'dsh-prompt-prediction/style'

    const strings = detectStrings()

    function detectStrings() {
      const fromDocument = typeof document !== 'undefined' ? document.documentElement?.lang : undefined
      const fromNavigator = typeof navigator !== 'undefined' ? navigator.language : undefined
      const lang = fromDocument || fromNavigator || 'en'
      const zh = String(lang).toLowerCase().startsWith('zh')
      return zh
        ? { tabToAccept: 'Tab 填入', ghostLabel: '预测的下一句', acceptHint: '按 Tab 或右方向键填入草稿；按 Esc 忽略后，可用 Tab 移动焦点。' }
        : { tabToAccept: 'Tab to fill', ghostLabel: 'Predicted next message', acceptHint: 'Press Tab or ArrowRight to fill the draft; press Escape to dismiss and use Tab to move focus.' }
    }

    async function readState(sessionId, rev, signal) {
      const url = `${PREFIX}/state?sessionId=${encodeURIComponent(sessionId)}&rev=${encodeURIComponent(String(rev))}`
      let onAbort
      const aborted = new Promise((_, reject) => {
        onAbort = () => reject(signal.reason ?? new Error('state request aborted'))
        if (signal.aborted) onAbort()
        else signal.addEventListener('abort', onAbort, { once: true })
      })
      try {
        return await Promise.race([
          fetch(url, { headers: { accept: 'application/json' }, signal }).then(response => {
            if (!response.ok) throw new Error(`state ${response.status}`)
            return response.json()
          }),
          aborted,
        ])
      } finally {
        signal.removeEventListener('abort', onAbort)
      }
    }

    function sendFeedback(payload) {
      void fetch(`${PREFIX}/feedback`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      }).catch(() => {})
    }

    // -------------------------------------------------------------------------
    // Styles
    // -------------------------------------------------------------------------

    function installStyles() {
      if (typeof document === 'undefined') return
      const existing = document.querySelector(`style[data-plugin-css="${CSS_ID}"]`)
      const style = existing ?? document.createElement('style')
      style.dataset.plugin = 'dsh-prompt-prediction'
      style.dataset.pluginCss = CSS_ID
      style.textContent = [
        // DraftEditor renders a sibling DOM placeholder, not a pseudo-element.
        // Scope ownership to this card; CSS also covers placeholders remounted by React.
        '[data-dsh-pp-active] [data-composer-placeholder]{visibility:hidden !important}',
        '[data-dsh-pp-active] [contenteditable]::before{content:"" !important;opacity:0 !important}',
        '.dsh-pp-settings-heading{margin:0;font-size:15px;font-weight:600;line-height:1.5;color:var(--dsw-alias-label-primary)}',
        '.dsh-pp-settings-description{margin:6px 0 16px;font-size:12px;line-height:1.6;color:var(--dsw-alias-label-secondary)}',
        '.dsh-pp-settings-field+.dsh-pp-settings-field{border-top:0.5px solid var(--dsw-alias-border-l2)}',
        '.dsh-pp-settings-toggle{display:flex;align-items:flex-start;justify-content:space-between;gap:24px;padding:16px 0}',
        '.dsh-pp-settings-copy{flex:1;min-width:0}',
        '.dsh-pp-settings-label{font-size:13px;font-weight:500;line-height:1.5;color:var(--dsw-alias-label-primary)}',
        '.dsh-pp-settings-hint{margin:6px 0 0;font-size:12px;line-height:1.6;color:var(--dsw-alias-label-tertiary)}',
        '.dsh-pp-settings-control{display:flex;align-items:center;gap:8px;flex:none;min-height:24px}',
        '.dsh-pp-settings-state{font-size:12px;line-height:1.5;color:var(--dsw-alias-label-secondary)}',
        '.dsh-pp-settings-override{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-top:6px}',
        '@media(max-width:480px){.dsh-pp-settings-toggle{gap:12px}.dsh-pp-settings-state{display:none}}',
      ].join('')
      if (existing === null) document.head.appendChild(style)
    }

    // -------------------------------------------------------------------------
    // Geometry: draw the ghost exactly where the first line of text starts
    // -------------------------------------------------------------------------

    /**
     * The composer editor: the editable root that carries the shell's own
     * `data-placeholder`/`data-phase` markers. Falling back to the first
     * contenteditable can pick an accessory editor instead.
     */
    function findEditor(card) {
      if (card === null) return null
      return (
        card.querySelector('[data-composer-input][contenteditable]') ??
        card.querySelector('[contenteditable][data-placeholder]') ??
        card.querySelector('[data-phase][contenteditable]') ??
        card.querySelector('[contenteditable="true"]') ??
        card.querySelector('[contenteditable]')
      )
    }

    /** True when an opened menu occupies the card right now. */
    function menuOpen(card) {
      if (card === null) return false
      const menus = card.querySelectorAll?.('[role="listbox"]') ?? []
      for (const menu of menus) {
        // A closed popover can stay mounted with zero size; only a laid-out one
        // owns the keyboard.
        const rect = menu.getBoundingClientRect?.()
        if (rect === undefined || rect.height > 0) return true
      }
      const single = card.querySelector('[role="listbox"]')
      if (single !== null) {
        const rect = single.getBoundingClientRect?.()
        return rect === undefined || rect.height > 0
      }
      return false
    }

    function measure(card) {
      if (card === null) return null
      const editor = findEditor(card)
      if (menuOpen(card) || editor === null || editor.getAttribute('contenteditable') !== 'true' ||
          editor.getAttribute('aria-disabled') === 'true' || editor.hasAttribute('data-composer-composing')) return null
      const box = editor
      if (typeof box.getBoundingClientRect !== 'function') return null
      const rect = box.getBoundingClientRect()
      if (rect.width <= 0 || rect.height <= 0) return null
      const style = editor === null ? null : window.getComputedStyle(editor)
      const paddingLeft = style === null ? 0 : Number.parseFloat(style.paddingLeft || '0') || 0
      const paddingRight = style === null ? 0 : Number.parseFloat(style.paddingRight || '0') || 0
      const paddingTop = style === null ? 0 : Number.parseFloat(style.paddingTop || '0') || 0
      // The first paragraph of the Lexical document is the exact line box the
      // caret occupies; measuring it beats reconstructing padding + line-height.
      const line = firstLineBox(editor)
      if (line !== null) {
        return {
          left: line.left,
          top: line.top,
          width: Math.max(48, rect.right - paddingRight - line.left),
          fontFamily: style?.fontFamily ?? 'inherit',
          fontSize: style?.fontSize ?? 'inherit',
          lineHeight: style?.lineHeight ?? '1.4',
          letterSpacing: style?.letterSpacing ?? 'normal',
          fontWeight: style?.fontWeight ?? 'inherit',
        }
      }
      return {
        left: rect.left + paddingLeft,
        top: rect.top + paddingTop,
        width: Math.max(48, rect.width - paddingLeft - paddingRight),
        fontFamily: style?.fontFamily ?? 'inherit',
        fontSize: style?.fontSize ?? 'inherit',
        lineHeight: style?.lineHeight ?? '1.4',
        letterSpacing: style?.letterSpacing ?? 'normal',
        fontWeight: style?.fontWeight ?? 'inherit',
      }
    }

    /**
     * The client rect of the editor's first line box, or null when the document
     * has no measurable element yet (the caller then falls back to padding math).
     */
    function firstLineBox(editor) {
      if (editor === null || editor === undefined) return null
      // Only a child element is a line box; the editor itself is the scroll
      // container and would misplace the ghost above its own padding.
      const candidate = editor.firstElementChild ?? editor.children?.[0] ?? null
      if (candidate === null || typeof candidate.getBoundingClientRect !== 'function') return null
      try {
        const rect = candidate.getBoundingClientRect()
        if (rect.width <= 0 || rect.height <= 0) return null
        return { left: rect.left, top: rect.top, right: rect.right }
      } catch {
        return null
      }
    }

    /** Tab/→ belong to this editor only, never to buttons, dialogs or another card. */
    function focusBelongsElsewhere(editor) {
      const active = document.activeElement
      return editor === null || active == null ||
        !(active === editor || editor.contains(active))
    }

    // Multiple overlay instances can coexist during a slot refresh. Keep the
    // placeholder hidden until the last owner releases it; never mutate React's text.
    const placeholderOwners = new WeakMap()
    function hidePlaceholder(card) {
      if (card === null) return () => {}
      placeholderOwners.set(card, (placeholderOwners.get(card) ?? 0) + 1)
      card.setAttribute('data-dsh-pp-active', '')
      return () => {
        const remaining = (placeholderOwners.get(card) ?? 1) - 1
        if (remaining > 0) placeholderOwners.set(card, remaining)
        else {
          placeholderOwners.delete(card)
          card.removeAttribute('data-dsh-pp-active')
        }
      }
    }

    // -------------------------------------------------------------------------
    // Ghost surface
    // -------------------------------------------------------------------------

    /**
     * The visible prediction. Mounted only for a session-scope overlay slot, so
     * `useInput` and `inputActions` are supplied by the conversation shell.
     */
    function GhostPrediction(props) {
      const useInput = props.useInput
      const inputActions = props.inputActions
      if (typeof useInput !== 'function' || inputActions === undefined || inputActions === null) {
        warnMissingStandardProps(props)
        return null
      }
      return h(GhostSurface, props)
    }

    let warned = false

    /** One console hint when the shell did not supply the standard session props. */
    function warnMissingStandardProps(props) {
      if (warned) return
      warned = true
      try {
        console.warn(
          'dsh-prompt-prediction: the composer slot did not supply useInput/inputActions; ghost text stays hidden.',
          Object.keys(props ?? {}),
        )
      } catch {
        /* console unavailable */
      }
    }

    const useAbsentSession = select => select(undefined)
    const useAbsentProjection = (_key, select) => select(undefined)

    function GhostSurface({ sessionId, useInput, inputActions,
      useSession = useAbsentSession, useProjection = useAbsentProjection }) {
      const input = useInput((state) => state)
      const session = useSession(state => state)
      const planActive = useProjection('plan', plan => plan != null &&
        (plan.pending ? !plan.active : plan.active))
      const sessionBusy = session !== undefined &&
        (session.running || session.removed || session.openState !== 'open')
      const containerRef = react.useRef(null)
      const [snap, setSnap] = react.useState(null)
      const [dismissed, setDismissed] = react.useState(null)
      const descriptionId = react.useRef(null)
      if (descriptionId.current === null) descriptionId.current = `dsh-pp-description-${++nextDescriptionId}`
      const [box, setBox] = react.useState(null)
      const geometryRef = react.useRef(null)
      const [composing, setComposing] = react.useState(false)
      const blockedRef = react.useRef(new Set())
      const acceptedRef = react.useRef(false)
      const restorePlaceholderRef = react.useRef(null)
      const [hasAccepted, setHasAccepted] = react.useState(() => {
        try {
          return window.localStorage.getItem(ACCEPTED_FLAG) === '1'
        } catch {
          return false
        }
      })

      react.useEffect(() => {
        installStyles()
      }, [])

      // Mount heartbeat: distinguishes "the bundle never loaded in this window"
      // from "it loaded and the composer was not empty", which otherwise look
      // identical from the host side.
      react.useEffect(() => {
        sendFeedback({ sessionId, action: 'mounted' })
      }, [sessionId])

      const draft = typeof input?.draft === 'string' ? input.draft : ''
      const attachments = input?.attachmentIds?.length ?? 0
      const occurrences = input?.occurrences?.length ?? 0
      const queueLength = input?.queue?.length ?? 0
      const phase = input?.phase ?? 'plain'
      // Codex parity: a prediction only occupies a completely empty composer.
      const composerEmpty = draft === '' && attachments === 0 && occurrences === 0
      const active = composerEmpty && phase === 'plain' && queueLength === 0 && !composing &&
        !sessionBusy && !planActive

      const isDismissed = dismissed !== null && dismissed.sessionId === sessionId &&
        dismissed.turnSeq === snap?.turnSeq && dismissed.text === snap?.text
      const text = active && !isDismissed && snap?.sessionId === sessionId && snap.status === 'ready' && typeof snap.text === 'string' ? snap.text : ''
      const turnSeq = snap?.turnSeq ?? null

      // Poll the bridge only while the ghost could be shown.
      react.useEffect(() => {
        if (!active) return undefined
        let cancelled = false
        let timer = null
        let controller = null
        let retryMs = POLL_MS
        // A new session, reactivation or host restart must return a full snapshot.
        let revision = -1
        const tick = async () => {
          if (cancelled) return
          controller = new AbortController()
          const request = controller
          const deadline = window.setTimeout(() => request.abort(new Error('state request timed out')), POLL_TIMEOUT_MS)
          try {
            const next = await readState(sessionId, revision, request.signal)
            retryMs = POLL_MS
            if (cancelled || next === null || typeof next !== 'object') return
            if (typeof next.rev === 'number' && next.unchanged !== true) {
              revision = next.rev
              setSnap({ ...next, sessionId })
            }
          } catch {
            // An unavailable or unauthorized bridge cannot vouch for a cached guess.
            if (!cancelled) {
              revision = -1
              setSnap(null)
              retryMs = Math.min(retryMs * 2, MAX_RETRY_MS)
            }
          } finally {
            window.clearTimeout(deadline)
            if (controller === request) controller = null
            if (!cancelled) timer = window.setTimeout(tick, retryMs)
          }
        }
        void tick()
        return () => {
          cancelled = true
          if (timer !== null) window.clearTimeout(timer)
          controller?.abort(new Error('prediction overlay inactive'))
        }
      }, [active, sessionId])

      // One reason report when the composer keeps the ghost hidden: a silent
      // feature is impossible to debug without it.
      react.useEffect(() => {
        if (active) return undefined
        const timer = window.setTimeout(() => {
          sendFeedback({
            sessionId,
            action: 'inactive',
            draftChars: draft.length,
            phase,
            queue: queueLength,
            attachments,
            occurrences,
          })
        }, 5000)
        return () => window.clearTimeout(timer)
      }, [active, sessionId, draft.length, phase, queueLength, attachments, occurrences])

      // Non-empty drafts invalidate the shown suggestion immediately.
      react.useEffect(() => {
        if (active) return
        setSnap((current) => (current === null ? current : null))
      }, [active])

      // The shell may not publish draft text until IME composition completes.
      react.useEffect(() => {
        const card = containerRef.current?.closest('[data-composer-card]') ?? null
        if (card === null) return undefined
        let timer = null
        setComposing(false)
        const start = () => {
          if (timer !== null) window.clearTimeout(timer)
          setComposing(true)
        }
        const end = () => {
          if (timer !== null) window.clearTimeout(timer)
          timer = window.setTimeout(() => setComposing(false), 100)
        }
        const fallback = event => {
          if (event.keyCode === 229 || event.isComposing) {
            start()
            end()
          }
        }
        card.addEventListener('keydown', fallback, true)
        card.addEventListener('compositionstart', start, true)
        card.addEventListener('compositionend', end, true)
        return () => {
          card.removeEventListener('keydown', fallback, true)
          card.removeEventListener('compositionstart', start, true)
          card.removeEventListener('compositionend', end, true)
          if (timer !== null) window.clearTimeout(timer)
        }
      }, [sessionId])

      const visible = text.length > 0
      const painted = visible && box !== null

      react.useLayoutEffect(() => {
        if (!painted) return undefined
        const card = containerRef.current?.closest('[data-composer-card]') ?? null
        const editor = findEditor(card)
        if (editor === null) return undefined
        const id = descriptionId.current
        const ids = (editor.getAttribute('aria-describedby') ?? '').split(/\s+/u).filter(Boolean)
        editor.setAttribute('aria-describedby', [...new Set([...ids, id])].join(' '))
        return () => {
          const remaining = (editor.getAttribute('aria-describedby') ?? '').split(/\s+/u).filter(value => value && value !== id)
          if (remaining.length > 0) editor.setAttribute('aria-describedby', remaining.join(' '))
          else editor.removeAttribute('aria-describedby')
        }
      }, [painted, sessionId])

      // Geometry follows the composer through layout, scroll and resize.
      react.useLayoutEffect(() => {
        if (!visible) {
          setBox(null)
          return undefined
        }
        const card = containerRef.current?.closest('[data-composer-card]') ?? null
        const update = () => {
          const next = measure(card)
          geometryRef.current = next
          setBox((current) => {
            if (current === null || next === null) return next
            if (
              Math.abs(current.left - next.left) < 0.5 &&
              Math.abs(current.top - next.top) < 0.5 &&
              Math.abs(current.width - next.width) < 0.5 &&
              current.fontSize === next.fontSize &&
              current.lineHeight === next.lineHeight
            ) {
              return current
            }
            return next
          })
        }
        update()
        const onScroll = () => update()
        window.addEventListener('scroll', onScroll, true)
        window.addEventListener('resize', onScroll)
        const observer = typeof ResizeObserver === 'function' && card !== null ? new ResizeObserver(onScroll) : null
        if (observer !== null && card !== null) observer.observe(card)
        const editor = findEditor(card)
        const mutations = typeof MutationObserver === 'function' && editor !== null
          ? new MutationObserver(update) : null
        mutations?.observe(card, {
          attributes: true, attributeFilter: ['contenteditable', 'aria-disabled', 'data-composer-composing', 'class', 'style', 'hidden', 'role'],
          childList: true, subtree: true,
        })
        return () => {
          window.removeEventListener('scroll', onScroll, true)
          window.removeEventListener('resize', onScroll)
          observer?.disconnect()
          mutations?.disconnect()
        }
      }, [visible, text, draft, sessionId])

      // Placeholder ownership: blank it while the ghost draws, restore on hide.
      react.useLayoutEffect(() => {
        if (!painted) return undefined
        const card = containerRef.current?.closest('[data-composer-card]') ?? null
        restorePlaceholderRef.current = hidePlaceholder(card)
        return () => {
          restorePlaceholderRef.current?.()
          restorePlaceholderRef.current = null
        }
      }, [painted, sessionId])

      // Stable primitive dependencies report actual visibility transitions only;
      // a menu/IME hide followed by a reappearance starts a new visible interval.
      react.useEffect(() => {
        if (!painted) return undefined
        sendFeedback({
          sessionId,
          turnSeq,
          action: 'shown',
          text,
          box: {
            top: Math.round(geometryRef.current?.top ?? -1),
            left: Math.round(geometryRef.current?.left ?? -1),
            width: Math.round(geometryRef.current?.width ?? -1),
            viewportHeight: typeof window !== 'undefined' ? window.innerHeight : null,
          },
        })
        return () => {
          if (acceptedRef.current) {
            acceptedRef.current = false
            return
          }
          sendFeedback({ sessionId, turnSeq, action: 'dismissed', text })
        }
      }, [painted, text, turnSeq, sessionId])

      const accept = react.useCallback(() => {
        if (!painted) return false
        const card = containerRef.current?.closest('[data-composer-card]') ?? null
        if (card === null || menuOpen(card)) return false
        try {
          const editor = findEditor(card)
          if (focusBelongsElsewhere(editor) || editor.getAttribute('contenteditable') !== 'true' ||
              editor.hasAttribute('data-composer-composing') ||
              editor.getAttribute('aria-disabled') === 'true' ||
              (typeof editor.textContent === 'string' && editor.textContent !== '')) return false
          // `insertText` is the shell's revision-guarded, undoable edit; an empty
          // draft makes it equivalent to "replace the draft" while remaining a
          // single Cmd+Z step (unlike `setDraft`, which merges into history).
          const span = inputActions.captureInsertion()
          // The real input store may synchronously commit a React update here.
          acceptedRef.current = true
          if (!inputActions.insertText(text, span)) {
            acceptedRef.current = false
            sendFeedback({ sessionId, turnSeq, action: 'conflict', text })
            return false
          }
        } catch {
          acceptedRef.current = false
          return false
        }
        setHasAccepted(true)
        try {
          window.localStorage.setItem(ACCEPTED_FLAG, '1')
        } catch {
          /* private mode */
        }
        sendFeedback({ sessionId, turnSeq, action: 'accepted', text })
        setSnap(null)
        return true
      }, [painted, text, inputActions, sessionId, turnSeq])

      /**
       * Report why an accept key did nothing, once per reason.
       *
       * Without this a refused Tab is indistinguishable from a Tab nobody
       * pressed, which is exactly the dead end this cost us during development.
       */
      const reportBlocked = react.useCallback(
        (reason, extra) => {
          if (blockedRef.current.has(reason)) return
          blockedRef.current.add(reason)
          sendFeedback({ sessionId, turnSeq, action: 'blocked', reason, ...extra })
        },
        [sessionId, turnSeq],
      )

      // Escape dismisses so the next Tab can navigate instead of accepting.
      react.useEffect(() => {
        if (!painted) return undefined
        const onKeyDown = (event) => {
          if (event.defaultPrevented || event.repeat) return
          if (event.isComposing || event.keyCode === 229) return
          if (event.key !== 'Tab' && event.key !== 'ArrowRight' && event.key !== 'Escape') return
          if (event.shiftKey || event.altKey || event.ctrlKey || event.metaKey) {
            reportBlocked('modifier', { key: event.key })
            return
          }
          const card = containerRef.current?.closest('[data-composer-card]') ?? null
          if (card === null) {
            reportBlocked('no-card')
            return
          }
          const editor = findEditor(card)
          if (editor === null) {
            reportBlocked('no-editor')
            return
          }
          if (menuOpen(card)) {
            reportBlocked('menu-open')
            return
          }
          if (focusBelongsElsewhere(editor)) {
            reportBlocked('focus-elsewhere')
            return
          }
          if (event.key === 'Escape') {
            setDismissed({ sessionId, turnSeq, text })
            event.preventDefault()
            event.stopImmediatePropagation()
            return
          }
          if (!accept()) {
            reportBlocked('insert-refused')
            return
          }
          event.preventDefault()
          event.stopImmediatePropagation()
        }
        window.addEventListener('keydown', onKeyDown, true)
        return () => window.removeEventListener('keydown', onKeyDown, true)
      }, [painted, accept, reportBlocked, sessionId, turnSeq, text])

      const ghost =
        painted
          ? h(
              'div',
              {
                'data-dsh-prediction': 'ghost',
                'aria-hidden': 'true',
                style: {
                  position: 'fixed',
                  left: `${box.left}px`,
                  top: `${box.top}px`,
                  width: `${box.width}px`,
                  zIndex: 4,
                  pointerEvents: 'none',
                  display: 'flex',
                  flexWrap: 'nowrap',
                  alignItems: 'center',
                  columnGap: '6px',
                  fontFamily: box.fontFamily,
                  fontSize: box.fontSize,
                  lineHeight: box.lineHeight,
                  letterSpacing: box.letterSpacing,
                  fontWeight: box.fontWeight,
                  color: 'inherit',
                  opacity: 0.42,
                  whiteSpace: 'nowrap',
                  wordBreak: 'break-word',
                  overflow: 'hidden',
                  maxHeight: box.lineHeight,
                },
              },
              h('span', { key: 'text', style: { minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, text),
              hasAccepted
                ? null
                : h(
                    'span',
                    {
                      key: 'pill',
                      style: {
                        flex: 'none',
                        alignSelf: 'center',
                        fontFamily: 'inherit',
                        fontSize: '11px',
                        lineHeight: '16px',
                        fontWeight: 400,
                        padding: '0 5px',
                        borderRadius: '5px',
                        background: 'rgba(127,127,127,0.16)',
                        whiteSpace: 'nowrap',
                      },
                    },
                    strings.tabToAccept,
                  ),
            )
          : null

      const announcement = h('span', {
        id: descriptionId.current,
        role: 'status',
        'aria-live': 'polite',
        'aria-atomic': 'true',
        style: { position: 'absolute', width: '1px', height: '1px', padding: 0, margin: '-1px', overflow: 'hidden', clipPath: 'inset(50%)', whiteSpace: 'nowrap', border: 0 },
      }, painted ? `${strings.ghostLabel}：${text} ${strings.acceptHint}` : '')

      return h('div', { ref: containerRef, 'data-dsh-prediction': 'anchor' }, ghost, announcement)
    }

    // -------------------------------------------------------------------------
    // Plugin
    // -------------------------------------------------------------------------

    const inject = ['slots']

    function installSettings(ctx) {
      const { SettingsFormModel, SettingsForm, SettingsValueField, settingsNumberField, Switch, Button, Tag } =
        require('@deepseek-ai/dsh-client-ui-primitives')
      const ns = 'promptPrediction.settings'
      const dictionaries = {
        zh: {
          title: '预测设置', description: '保存后立即生效，不会自动发送消息。',
          enabled: '启用预测', enabledHint: '关闭后取消待处理预测并清除灰字建议；开启后可能额外请求模型并计费。',
          auditLog: '本地审计日志', auditLogHint: '可能记录预测、采纳及提交文本。关闭仅停止后续写入，不删除已有日志。',
          maxSuggestionChars: '建议长度上限', maxSuggestionCharsHint: 'UTF-16 单元数；默认 200，截断不会拆开代理对。',
          timeoutMs: '模型请求超时（毫秒）', timeoutMsHint: '默认 20000 毫秒；不是输入框状态轮询的超时。',
          maxOutputTokens: '模型输出预算（token）', maxOutputTokensHint: '默认 1024；模型支持推理时也计入推理 token。',
          on: '开启', off: '关闭', reset: '恢复默认', overridden: '已覆盖',
          invalidNumber: '请输入大于零的整数；超时不能超过 2147483647 毫秒。留空恢复默认。',
          unavailable: '该插件当前未加载，暂时无法配置。', readOnly: '本部署的设置为只读。',
          save: '保存', saving: '保存中…', saveFailed: '保存失败，已保留修改。请检查数值或重新打开页面后重试。',
        },
        en: {
          title: 'Prediction settings', description: 'Changes apply on save. Messages are never sent automatically.',
          enabled: 'Enable predictions', enabledHint: 'Disabling cancels pending predictions and clears ghost text. Enabling may make additional, billable model requests.',
          auditLog: 'Local audit log', auditLogHint: 'May record predicted, accepted and submitted text. Disabling stops future writes but does not delete existing logs.',
          maxSuggestionChars: 'Suggestion length limit', maxSuggestionCharsHint: 'UTF-16 units; default 200. Truncation preserves surrogate pairs.',
          timeoutMs: 'Model request timeout (ms)', timeoutMsHint: 'Default 20000 ms. Separate from composer state polling timeouts.',
          maxOutputTokens: 'Model output budget (tokens)', maxOutputTokensHint: 'Default 1024; includes reasoning tokens when applicable.',
          on: 'On', off: 'Off', reset: 'Reset to default', overridden: 'Overridden',
          invalidNumber: 'Enter a positive integer; timeout must not exceed 2147483647 ms. Leave blank to reset.',
          unavailable: 'This plugin is not loaded, so its settings are unavailable.', readOnly: 'This deployment stores settings read-only.',
          save: 'Save', saving: 'Saving…', saveFailed: 'Save failed; edits were kept. Check the values or reopen this page and retry.',
        },
      }
      ctx.effect(() => ctx.locale.register(ns, dictionaries))
      const fields = ['enabled', 'maxSuggestionChars', 'timeoutMs', 'maxOutputTokens', 'auditLog']
      const booleanFields = new Set(['enabled', 'auditLog'])
      const specs = fields.map(field => {
        if (booleanFields.has(field)) return {
          field,
          format: value => String(value ?? true),
          parse: text => text === 'true' || text === 'false'
            ? { kind: 'set', value: text === 'true' } : undefined,
        }
        const spec = settingsNumberField(field)
        return { ...spec, parse: text => {
          const result = spec.parse(text)
          if (result?.kind === 'set' && (!Number.isSafeInteger(result.value) || result.value < 1 ||
            (field === 'timeoutMs' && result.value > 2147483647))) return undefined
          return result
        } }
      })
      const form = new SettingsFormModel(ctx.configForms.get('prompt-prediction'), specs)
      const store = form.bind(() => ({ ...form.shell(),
        fields: Object.fromEntries(fields.map(field => [field, form.field(field)])),
      }))
      ctx.effect(() => () => form.dispose())

      function PredictionSettings(props) {
        const { t } = props
        const state = props.usePredictionSettings(snapshot => snapshot)
        if (props.view === 'summary') return t('description')
        const disabled = !state.writable || state.saving
        return h(SettingsForm, {
          state, labels: Object.fromEntries(['unavailable', 'readOnly', 'saveFailed', 'save', 'saving']
            .map(key => [key, t(key)])),
          onSave: props.save, onDiscard: props.discard,
        }, h('h3', { className: 'dsh-pp-settings-heading' }, t('title')),
        h('p', { className: 'dsh-pp-settings-description' }, t('description')),
        h('div', null,
        ...fields.map(field => {
          const id = `prompt-prediction-setting-${field}`
          const value = state.fields[field]
          if (!booleanFields.has(field)) return h('div', { key: field, className: 'dsh-pp-settings-field' }, h(SettingsValueField, {
            id, label: t(field), hint: t(`${field}Hint`),
            ...value, numeric: true, disabled,
            overriddenLabel: t('overridden'), resetLabel: t('reset'), invalidLabel: t('invalidNumber'),
            onEdit: text => props.edit(field, text), onReset: () => props.resetField(field),
          }))
          return h('div', { key: field, className: 'dsh-pp-settings-field dsh-pp-settings-toggle',
            role: 'group', 'aria-labelledby': `${id}-label`, 'aria-describedby': `${id}-hint` },
            h('div', { className: 'dsh-pp-settings-copy' },
              h('div', { id: `${id}-label`, className: 'dsh-pp-settings-label' }, t(field)),
              h('p', { id: `${id}-hint`, className: 'dsh-pp-settings-hint' }, t(`${field}Hint`)),
              value.overridden && h('div', { className: 'dsh-pp-settings-override' },
                h(Tag, { tone: 'neutral' }, t('overridden')),
                h(Button, { type: 'button', variant: 'ghost', size: 'sm', disabled,
                  'aria-label': `${t('reset')} · ${t(field)}`,
                  onClick: () => props.resetField(field) }, t('reset')))),
            h('div', { className: 'dsh-pp-settings-control' },
              h('span', { className: 'dsh-pp-settings-state', 'aria-hidden': true }, t(value.text === 'true' ? 'on' : 'off')),
              h(Switch, { checked: value.text === 'true', disabled, label: t(field), title: t(`${field}Hint`),
                onChange: checked => props.edit(field, String(checked)) })))
        })))
      }
      ctx.effect(() => ctx.configForms.whileServed(['prompt-prediction'], () =>
        ctx.slots.inject('plugins.bundle.config', () => ctx.slots.register({
          name: 'plugins.bundle.config', id: 'prompt-prediction-settings',
          key: 'dsh-prompt-prediction', locale: ns,
          inject: () => ({ hooks: { predictionSettings: store }, ...form.actions() }),
        }, PredictionSettings))))
    }

    function apply(ctx) {
      installStyles()
      ctx.inject(['locale', 'configForms'], installSettings)
      ctx.slots.inject('conversation.input.overlay', () =>
        ctx.slots.register(
          {
            name: 'conversation.input.overlay',
            id: 'prompt-prediction',
            // Below menu overlays: a command list must always paint above a guess.
            order: 5,
          },
          GhostPrediction,
        ),
      )
    }

    exports.apply = apply
    exports.inject = inject
    return module.exports
  },
})
