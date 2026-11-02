import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'

/**
 * Interaction coverage for the ghost overlay.
 *
 * The client half is one hand-written module bundle, so this test evaluates the
 * real file and then drives the registered component through a miniature DOM and
 * React hook runtime. It covers exactly the parts no unit test could reach and no
 * screenshot can prove: which key is intercepted, under which conditions, and
 * what the composer is asked to write.
 */

const clientPath = new URL('../lib/client.js', import.meta.url)

// ---------------------------------------------------------------------------
// Tiny DOM
// ---------------------------------------------------------------------------

const SELECTORS = [
  { test: (el) => el.attributes['data-composer-card'] !== undefined, key: 'data-composer-card' },
  { test: (el) => el.attributes['role'] === 'listbox', key: 'role' },
  { test: (el) => el.attributes['contenteditable'] === 'true', key: 'contenteditable', value: 'true' },
  { test: (el) => el.attributes['contenteditable'] !== undefined, key: 'contenteditable' },
]

/** The document the currently mounted component should focus into. */
let activeDocument = null

const kebab = (name) => name.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)

/**
 * Match the small selector grammar the client uses: an optional tag name
 * followed by any number of `[attr]` / `[attr="value"]` terms, e.g.
 * `[contenteditable][data-placeholder]` or `style[data-plugin-css="x"]`.
 */
function matches(el, selector) {
  // Comma-separated selector lists are an OR for `closest`.
  if (selector.includes(',')) return selector.split(',').some((part) => matches(el, part.trim()))
  const parsed = /^([a-z]*)((?:\[[a-z-]+(?:="[^"]*")?\])*)$/.exec(selector)
  if (parsed === null) throw new Error(`harness does not understand selector ${selector}`)
  const [, tagName, terms] = parsed
  if (tagName !== '' && el.tagName !== tagName.toUpperCase()) return false
  for (const term of terms.match(/\[[^\]]+\]/g) ?? []) {
    const body = term.slice(1, -1)
    const equals = body.indexOf('=')
    if (equals === -1) {
      if (!(body in el.attributes)) return false
      continue
    }
    const name = body.slice(0, equals)
    const value = body.slice(equals + 1).replace(/^"|"$/g, '')
    if (el.attributes[name] !== value) return false
  }
  return true
}

function createElement(tag) {
  const element = {
    tagName: String(tag).toUpperCase(),
    ownerDocument: undefined,
    attributes: {},
    dataset: null,
    style: {},
    children: [],
    parent: null,
    listeners: {},
    rect: { left: 0, top: 0, width: 0, height: 0, right: 0, bottom: 0 },
    setAttribute(name, value) {
      element.attributes[name] = String(value)
    },
    getAttribute(name) {
      return name in element.attributes ? element.attributes[name] : null
    },
    hasAttribute(name) {
      return name in element.attributes
    },
    removeAttribute(name) {
      delete element.attributes[name]
    },
    appendChild(child) {
      child.parent = element
      element.children.push(child)
      return child
    },
    removeChild(child) {
      element.children = element.children.filter((item) => item !== child)
      child.parent = null
      return child
    },
    append(...nodes) {
      for (const node of nodes) element.appendChild(node)
    },
    addEventListener(type, handler) {
      ;(element.listeners[type] ??= []).push(handler)
    },
    removeEventListener(type, handler) {
      element.listeners[type] = (element.listeners[type] ?? []).filter((item) => item !== handler)
    },
    getBoundingClientRect() {
      return element.rect
    },
    focused: false,
    focus() {
      element.focused = true
      if (activeDocument !== null) activeDocument.activeElement = element
    },
    get firstElementChild() {
      return element.children[0] ?? null
    },
    closest(selector) {
      let node = element
      while (node !== null) {
        if (matches(node, selector)) return node
        node = node.parent
      }
      return null
    },
    querySelector(selector) {
      const queue = [...element.children]
      while (queue.length > 0) {
        const node = queue.shift()
        if (matches(node, selector)) return node
        queue.push(...node.children)
      }
      return null
    },
    querySelectorAll(selector) {
      const found = []
      const queue = [...element.children]
      while (queue.length > 0) {
        const node = queue.shift()
        if (matches(node, selector)) found.push(node)
        queue.push(...node.children)
      }
      return found
    },
    contains(node) {
      let current = node
      while (current !== null) {
        if (current === element) return true
        current = current.parent
      }
      return false
    },
  }
  // `dataset.fooBar = x` must behave like `data-foo-bar="x"`, which is what the
  // client's style-tag bookkeeping relies on.
  element.dataset = new Proxy(
    {},
    {
      get: (_target, key) => element.attributes[`data-${kebab(String(key))}`],
      set: (_target, key, value) => {
        element.attributes[`data-${kebab(String(key))}`] = String(value)
        return true
      },
      has: (_target, key) => `data-${kebab(String(key))}` in element.attributes,
    },
  )
  return element
}

// ---------------------------------------------------------------------------
// Tiny React hook runtime
// ---------------------------------------------------------------------------

function createReact() {
  const hooks = []
  let cursor = 0
  const pendingEffects = []
  let rerenderRequested = false
  let scheduler = null

  function slot(index) {
    hooks[index] ??= { value: undefined, deps: undefined, cleanup: undefined }
    return hooks[index]
  }

  const React = {
    createElement: (type, props, ...children) => ({
      type,
      props: { ...(props ?? {}), children: children.length > 1 ? children : children[0] },
    }),
    useState(initial) {
      const index = cursor
      cursor += 1
      const entry = slot(index)
      if (!('initialized' in entry)) {
        entry.value = typeof initial === 'function' ? initial() : initial
        entry.initialized = true
      }
      return [
        entry.value,
        (next) => {
          const value = typeof next === 'function' ? next(entry.value) : next
          if (Object.is(value, entry.value)) return
          entry.value = value
          rerenderRequested = true
          scheduler?.()
        },
      ]
    },
    useRef(initial) {
      const index = cursor
      cursor += 1
      const entry = slot(index)
      if (!('initialized' in entry)) {
        entry.value = { current: initial }
        entry.initialized = true
      }
      return entry.value
    },
    useCallback(fn, deps) {
      const index = cursor
      cursor += 1
      const entry = slot(index)
      const changed = entry.deps === undefined || !sameDeps(entry.deps, deps)
      if (changed) {
        entry.value = fn
        entry.deps = deps
      }
      return entry.value
    },
    useEffect(fn, deps) {
      const index = cursor
      cursor += 1
      const entry = slot(index)
      const changed = deps === undefined || entry.deps === undefined || !sameDeps(entry.deps, deps)
      if (changed) pendingEffects.push({ entry, fn })
      entry.deps = deps
    },
    useLayoutEffect(fn, deps) {
      React.useEffect(fn, deps)
    },
  }

  function sameDeps(left, right) {
    if (left === undefined || right === undefined) return false
    if (left.length !== right.length) return false
    return left.every((value, index) => Object.is(value, right[index]))
  }

  return {
    React,
    /** Render once, flushing layout effects, and report whether a re-render was queued. */
    render(component, props) {
      cursor = 0
      pendingEffects.length = 0
      rerenderRequested = false
      const element = component(props)
      return { element, queued: rerenderRequested, effects: pendingEffects.slice() }
    },
    flush(effects) {
      for (const { entry, fn } of effects) {
        if (entry.cleanup !== undefined) {
          entry.cleanup()
          entry.cleanup = undefined
        }
        entry.cleanup = fn()
      }
    },
    onRerender(handler) {
      scheduler = handler
    },
    cleanupAll() {
      for (const entry of hooks) {
        if (entry.cleanup !== undefined) {
          entry.cleanup()
          entry.cleanup = undefined
        }
      }
    },
  }
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

async function flushMicrotasks(times = 6) {
  for (let index = 0; index < times; index += 1) await Promise.resolve()
}

/**
 * Build a page: a composer card holding an overlay anchor, an editor, and an
 * optional open menu, then mount the real overlay component into it.
 */
async function mountOverlay({
  prediction = '跑一下测试吧',
  menuOpen = false,
  focusEditor = true,
  draft = '',
  firstLine = null,
  decoyEditor = false,
  staleMenu = false,
  sessionState = { running: false, openState: 'open' },
  planState = undefined,
} = {}) {
  const source = readFileSync(clientPath, 'utf8')
  const head = createElement('head')
  const card = createElement('div')
  card.setAttribute('data-composer-card', '')

  const anchor = createElement('div')
  card.appendChild(anchor)
  if (decoyEditor) {
    // An accessory editable earlier in the card must not be mistaken for the
    // composer: only the composer carries data-placeholder.
    const decoy = createElement('div')
    decoy.setAttribute('contenteditable', 'true')
    decoy.setAttribute('data-placeholder', 'Accessory editor')
    decoy.rect = { left: 10, top: 20, width: 100, height: 20, right: 110, bottom: 40 }
    card.appendChild(decoy)
  }
  const editor = createElement('div')
  editor.setAttribute('contenteditable', 'true')
  editor.setAttribute('data-composer-input', '')
  editor.setAttribute('data-placeholder', '给 DeepSeek 发送消息')
  editor.rect = { left: 435, top: 676, width: 686, height: 40, right: 1121, bottom: 716 }
  if (firstLine !== null) {
    const paragraph = createElement('p')
    paragraph.rect = { height: 22, ...firstLine }
    editor.appendChild(paragraph)
  }
  card.appendChild(editor)
  if (menuOpen || staleMenu) {
    const menu = createElement('div')
    menu.setAttribute('role', 'listbox')
    // A closed popover can stay mounted with zero height; an open one is laid out.
    menu.rect = menuOpen
      ? { left: 447, top: 600, width: 300, height: 120, right: 747, bottom: 720 }
      : { left: 0, top: 0, width: 0, height: 0, right: 0, bottom: 0 }
    card.appendChild(menu)
  }

  const documentSandbox = {
    documentElement: { lang: 'zh-CN' },
    head,
    activeElement: focusEditor ? editor : head,
    createElement,
    querySelector: (selector) => head.querySelector(selector),
    addEventListener() {},
    removeEventListener() {},
  }

  activeDocument = documentSandbox
  const feedback = []
  const insertions = []
  const timers = []
  const stateResponse = {
    rev: 3,
    status: 'ready',
    turnSeq: 42,
    text: prediction,
    promptVersion: 'pp-1',
    usage: { inputTokens: 141, outputTokens: 16, cachedInputTokens: null },
  }

  const sandbox = {
    console,
    document: documentSandbox,
    navigator: { language: 'zh-CN' },
    localStorage: { store: new Map(), getItem(key) { return this.store.get(key) ?? null }, setItem(key, value) { this.store.set(key, String(value)) } },
    setTimeout: (fn) => {
      timers.push(fn)
      return timers.length
    },
    clearTimeout: () => {},
    URL,
    ResizeObserver: class {
      observe() {}
      disconnect() {}
    },
    fetch: async (url, init) => {
      if (String(url).includes('/state')) {
        return { ok: true, json: async () => stateResponse }
      }
      if (String(url).includes('/feedback')) {
        feedback.push(JSON.parse(init.body))
        return { ok: true, json: async () => ({ ok: true }) }
      }
      throw new Error(`unexpected fetch ${url}`)
    },
    window: {
      innerHeight: 798,
      listeners: {},
      // Poll timers are recorded, never fired: one explicit poll per paint is
      // enough and a live interval would outlive the test.
      setTimeout: (fn) => {
        timers.push(fn)
        return timers.length
      },
      clearTimeout: () => {},
      localStorage: null,
      addEventListener(type, handler) {
        ;(sandbox.window.listeners[type] ??= []).push(handler)
      },
      removeEventListener(type, handler) {
        sandbox.window.listeners[type] = (sandbox.window.listeners[type] ?? []).filter((item) => item !== handler)
      },
      getComputedStyle: () => ({
        paddingLeft: '12px',
        paddingRight: '12px',
        paddingTop: '10px',
        fontFamily: 'PingFang SC',
        fontSize: '14px',
        lineHeight: '22px',
        letterSpacing: 'normal',
        fontWeight: '400',
      }),
      __ModuleLoader__: { load: (registration) => sandbox.__registration = registration },
    },
    globalThis: null,
  }
  sandbox.window.localStorage = sandbox.localStorage
  sandbox.globalThis = sandbox
  vm.runInNewContext(source, sandbox, { filename: 'lib/client.js' })

  const runtime = createReact()
  const exportsObject = sandbox.__registration.factory((specifier) => {
    if (specifier === 'react') return runtime.React
    throw new Error(`unexpected require(${specifier})`)
  })

  let slotComponent = null
  exportsObject.apply({
    slots: {
      inject: (_name, factory) => factory(),
      register: (_descriptor, component) => {
        slotComponent = component
      },
    },
  })

  const inputActions = {
    captureInsertion: () => ({ draftRev: 0, anchor: 0, focus: 0 }),
    insertText: (text, span) => {
      insertions.push({ text, span })
      return true
    },
  }
  const useInput = (selector) => selector({ draft, attachmentIds: [], draftRev: 0, phase: 'plain', occurrences: [], queue: [] })

  let mounted = null

  /** One commit: render the slot component, render its element, then flush effects. */
  function paint() {
    const outer = runtime.render(slotComponent, { sessionId: 'session-test', useInput, inputActions, useSession: select => select(sessionState), useProjection: (_key, select) => select(planState) })
    const inner = runtime.render(outer.element.type, outer.element.props)
    if (mounted === null) {
      mounted = createElement('div')
      anchor.appendChild(mounted)
      if (inner.element.props.ref !== null && typeof inner.element.props.ref === 'object') {
        inner.element.props.ref.current = mounted
      }
    }
    runtime.flush(inner.effects)
    return inner.element
  }

  // The poll is async: paint, let microtasks settle, paint again until the
  // suggestion is visible (bounded so a regression cannot hang the suite).
  for (let index = 0; index < 6; index += 1) {
    paint()
    await flushMicrotasks()
  }

  function pressTab({ shift = false, meta = false, target = editor, defaultPrevented = false } = {}) {
    const event = {
      key: 'Tab',
      keyCode: 9,
      shiftKey: shift,
      altKey: false,
      ctrlKey: false,
      metaKey: meta,
      repeat: false,
      isComposing: false,
      defaultPrevented,
      target,
      prevented: false,
      stopped: false,
      preventDefault() {
        event.prevented = true
      },
      stopImmediatePropagation() {
        event.stopped = true
      },
    }
    for (const handler of sandbox.window.listeners.keydown ?? []) handler(event)
    return event
  }

  function pressKey(key) {
    const event = {
      key,
      keyCode: 0,
      shiftKey: false,
      altKey: false,
      ctrlKey: false,
      metaKey: false,
      repeat: false,
      isComposing: false,
      target: editor,
      prevented: false,
      stopped: false,
      preventDefault() {
        event.prevented = true
      },
      stopImmediatePropagation() {
        event.stopped = true
      },
    }
    for (const handler of sandbox.window.listeners.keydown ?? []) handler(event)
    return event
  }

  return {
    feedback,
    insertions,
    pressTab,
    pressKey,
    editor,
    card,
    runtime,
    sandbox,
    repaint: () => paint(),
    fireTimers: () => {
      for (const fn of timers.splice(0)) fn()
    },
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test('Tab fills the draft with the prediction and reports acceptance', async () => {
  const harness = await mountOverlay()
  const event = harness.pressTab()

  assert.equal(harness.insertions.length, 1, 'the composer is asked for exactly one insertion')
  assert.equal(harness.insertions[0].text, '跑一下测试吧')
  assert.equal(event.prevented, true, 'the browser default is suppressed')
  assert.equal(event.stopped, true, 'the shell never sees the key')

  const accepted = harness.feedback.find((item) => item.action === 'accepted')
  assert.ok(accepted, 'acceptance is reported')
  assert.equal(accepted.text, '跑一下测试吧')
  assert.equal(accepted.turnSeq, 42)
})

test('mounting reports a heartbeat so the host can see the bundle loaded', async () => {
  const harness = await mountOverlay()
  assert.ok(harness.feedback.some((item) => item.action === 'mounted'), 'a mounted overlay announces itself')
})

test('the ghost anchors on the editor first line box', async () => {
  // Lexical keeps the caret line inside a paragraph; its rect is the truth.
  const harness = await mountOverlay({ firstLine: { left: 460, top: 690, width: 640, right: 1100 } })
  const shown = harness.feedback.find((item) => item.action === 'shown')
  assert.ok(shown, 'a visible prediction reports itself once')
  assert.equal(shown.box.left, 460, 'left follows the paragraph, not the padding guess')
  assert.equal(shown.box.top, 690, 'top follows the paragraph line box')
  assert.equal(shown.box.width, 1121 - 12 - 460, 'width stops at the editor content edge')
  assert.equal(shown.box.viewportHeight, 798)
})

test('the ghost falls back to padding math when no line box exists', async () => {
  const harness = await mountOverlay()
  const shown = harness.feedback.find((item) => item.action === 'shown')
  assert.equal(shown.box.left, 435 + 12)
  assert.equal(shown.box.top, 676 + 10)
  assert.equal(shown.box.width, 686 - 24)
})

test('a prediction is reported once, not once per poll', async () => {
  const harness = await mountOverlay()
  // Extra paint cycles emulate the 700 ms poll returning the same revision.
  for (let index = 0; index < 4; index += 1) {
    harness.repaint()
    await flushMicrotasks()
  }
  assert.equal(harness.feedback.filter((item) => item.action === 'shown').length, 1)
  assert.equal(harness.feedback.filter((item) => item.action === 'dismissed').length, 0)
})

test('a composer menu keeps Tab for itself', async () => {
  const harness = await mountOverlay({ menuOpen: true })
  const event = harness.pressTab()
  assert.equal(harness.insertions.length, 0)
  assert.equal(event.prevented, false)
  assert.equal(harness.feedback.some((item) => item.action === 'shown'), false, 'menus hide the ghost as well as blocking acceptance')
  assert.equal(harness.card.hasAttribute('data-dsh-pp-active'), false)
})

test('a key another handler already claimed is respected', async () => {
  const harness = await mountOverlay()
  const event = harness.pressTab({ defaultPrevented: true })
  assert.equal(harness.insertions.length, 0)
  assert.equal(event.prevented, false)
})

test('a mounted but closed menu popover does not block Tab', async () => {
  const harness = await mountOverlay({ staleMenu: true })
  const event = harness.pressTab()
  assert.equal(harness.insertions.length, 1, 'zero-height menus do not own the keyboard')
  assert.equal(event.prevented, true)
})

test('the composer editor is preferred over another editable in the card', async () => {
  const harness = await mountOverlay({ decoyEditor: true, firstLine: { left: 460, top: 690, width: 640, right: 1100 } })
  const shown = harness.feedback.find((item) => item.action === 'shown')
  assert.equal(shown.box.left, 460, 'geometry follows the composer, not the decoy at left=10')
  assert.equal(harness.pressTab().prevented, true)
})

test('Tab on plain chrome preserves keyboard focus traversal', async () => {
  const harness = await mountOverlay({ focusEditor: false })
  const button = createElement('button')
  harness.card.appendChild(button)
  harness.sandbox.document.activeElement = button
  const event = harness.pressTab({ target: button })
  assert.equal(harness.insertions.length, 0)
  assert.equal(event.prevented, false)
})

test('Tab inside another text surface is left alone', async () => {
  const harness = await mountOverlay()
  const input = createElement('input')
  harness.card.appendChild(input)
  harness.sandbox.document.activeElement = input
  const event = harness.pressTab({ target: input })
  assert.equal(harness.insertions.length, 0)
  assert.equal(event.prevented, false)
  harness.sandbox.document.activeElement = harness.editor
})

test('Tab inside an open dialog keeps its own handling', async () => {
  const harness = await mountOverlay()
  const dialog = createElement('div')
  dialog.setAttribute('role', 'dialog')
  const button = createElement('button')
  dialog.appendChild(button)
  harness.card.appendChild(dialog)
  harness.sandbox.document.activeElement = button
  const event = harness.pressTab({ target: button })
  assert.equal(harness.insertions.length, 0)
  assert.equal(event.prevented, false)
  harness.sandbox.document.activeElement = harness.editor
})

test('modified Tab is never intercepted', async () => {
  const harness = await mountOverlay()
  const shifted = harness.pressTab({ shift: true })
  assert.equal(harness.insertions.length, 0)
  assert.equal(shifted.prevented, false)
  const meta = harness.pressTab({ meta: true })
  assert.equal(harness.insertions.length, 0)
  assert.equal(meta.prevented, false)
})

test('other keys reach the composer untouched', async () => {
  const harness = await mountOverlay()
  for (const key of ['Enter', 'Escape', 'ArrowLeft', 'ArrowDown']) {
    const event = harness.pressKey(key)
    assert.equal(event.prevented, false, key)
    assert.equal(event.stopped, false, key)
  }
  assert.equal(harness.insertions.length, 0)
})

test('ArrowRight accepts like Codex does', async () => {
  const harness = await mountOverlay()
  const event = harness.pressKey('ArrowRight')
  assert.equal(harness.insertions.length, 1)
  assert.equal(event.prevented, true)
})

test('a non-empty draft keeps the ghost hidden and Tab alone', async () => {
  const harness = await mountOverlay({ draft: '我正在写' })
  const event = harness.pressTab()
  assert.equal(harness.insertions.length, 0)
  assert.equal(event.prevented, false)
  assert.equal(harness.feedback.filter((item) => item.action === 'shown').length, 0)
  assert.ok(harness.feedback.some((item) => item.action === 'mounted'), 'the overlay still announces itself')
})

test('an inactive composer explains itself instead of staying silent', async () => {
  const harness = await mountOverlay({ draft: '我正在写' })
  // Fire the 5 s inactivity timer the client scheduled.
  harness.fireTimers()
  await flushMicrotasks()
  const report = harness.feedback.find((item) => item.action === 'inactive')
  assert.ok(report, 'an inactive composer reports why')
  assert.equal(report.draftChars, 4)
  assert.equal(report.phase, 'plain')
})

test('a running session hides the old guess before another host poll', async () => {
  const harness = await mountOverlay({ sessionState: { running: true, openState: 'open' } })
  assert.equal(harness.feedback.some(item => item.action === 'shown'), false)
  assert.equal(harness.pressTab().prevented, false)
})

test('plan mode suppresses predictions through the actual projection shape', async () => {
  const harness = await mountOverlay({ planState: { active: true, pending: false } })
  assert.equal(harness.feedback.some(item => item.action === 'shown'), false)
  assert.equal(harness.pressTab().prevented, false)
})

test('editability is rechecked synchronously, not just by the observer', async () => {
  const harness = await mountOverlay()
  harness.editor.setAttribute('contenteditable', 'false')
  harness.pressTab()
  assert.equal(harness.insertions.length, 0)
})
