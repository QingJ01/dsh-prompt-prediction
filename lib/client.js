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
    const ACCEPTED_FLAG = 'dsh.prompt-prediction.hasAccepted'
    const CSS_ID = 'dsh-prompt-prediction/style'

    const strings = detectStrings()

    function detectStrings() {
      const fromDocument = typeof document !== 'undefined' ? document.documentElement?.lang : undefined
      const fromNavigator = typeof navigator !== 'undefined' ? navigator.language : undefined
      const lang = fromDocument || fromNavigator || 'en'
      const zh = String(lang).toLowerCase().startsWith('zh')
      return zh
        ? { tabToAccept: 'Tab 填入', ghostLabel: '预测的下一句' }
        : { tabToAccept: 'Tab to fill', ghostLabel: 'Predicted next message' }
    }

    async function readState(sessionId, rev) {
      const url = `${PREFIX}/state?sessionId=${encodeURIComponent(sessionId)}&rev=${encodeURIComponent(String(rev))}`
      const response = await fetch(url, { headers: { accept: 'application/json' } })
      if (!response.ok) throw new Error(`state ${response.status}`)
      return response.json()
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

      const text = active && snap?.sessionId === sessionId && snap.status === 'ready' && typeof snap.text === 'string' ? snap.text : ''
      const turnSeq = snap?.turnSeq ?? null

      // Poll the bridge only while the ghost could be shown.
      react.useEffect(() => {
        if (!active) return undefined
        let cancelled = false
        let timer = null
        // A new session, reactivation or host restart must return a full snapshot.
        let revision = -1
        const tick = async () => {
          if (cancelled) return
          try {
            const next = await readState(sessionId, revision)
            if (cancelled || next === null || typeof next !== 'object') return
            if (typeof next.rev === 'number' && next.unchanged !== true) {
              revision = next.rev
              setSnap({ ...next, sessionId })
            }
          } catch {
            // An unavailable or unauthorized bridge cannot vouch for a cached guess.
            if (!cancelled) { revision = -1; setSnap(null) }
          } finally {
            if (!cancelled) timer = window.setTimeout(tick, POLL_MS)
          }
        }
        void tick()
        return () => {
          cancelled = true
          if (timer !== null) window.clearTimeout(timer)
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

      // Tab / ArrowRight fill the draft; Enter remains owned by DSH submission.
      react.useEffect(() => {
        if (!painted) return undefined
        const onKeyDown = (event) => {
          if (event.defaultPrevented || event.repeat) return
          if (event.isComposing || event.keyCode === 229) return
          if (event.key !== 'Tab' && event.key !== 'ArrowRight') return
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
          if (!accept()) {
            reportBlocked('insert-refused')
            return
          }
          event.preventDefault()
          event.stopImmediatePropagation()
        }
        window.addEventListener('keydown', onKeyDown, true)
        return () => window.removeEventListener('keydown', onKeyDown, true)
      }, [painted, accept, reportBlocked])

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

      return h('div', { ref: containerRef, 'data-dsh-prediction': 'anchor' }, ghost)
    }

    // -------------------------------------------------------------------------
    // Plugin
    // -------------------------------------------------------------------------

    const inject = ['slots']

    function apply(ctx) {
      installStyles()
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
