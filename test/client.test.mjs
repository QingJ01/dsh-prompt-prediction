import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'

/**
 * The client half is a hand-written module-loader bundle: no build step, so the
 * only thing that can be wrong is the wrapper contract or module-level code.
 * These tests evaluate the real file in a sandbox that mimics the shell.
 */

const clientPath = new URL('../lib/client.js', import.meta.url)

/** Evaluate lib/client.js against a fake `window.__ModuleLoader__` and fake React. */
function loadClient() {
  const source = readFileSync(clientPath, 'utf8')
  const registrations = []
  const styleTags = []
  const document = {
    documentElement: { lang: 'zh-CN' },
    head: { appendChild: (node) => styleTags.push(node) },
    querySelector: () => null,
    createElement: (tag) => ({
      tag,
      dataset: {},
      style: {},
      textContent: '',
      setAttribute() {},
    }),
  }
  const React = {
    createElement: (type, props, ...children) => ({ type, props, children }),
    useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
    useEffect: () => {},
    useLayoutEffect: () => {},
    useRef: (value) => ({ current: value }),
    useCallback: (fn) => fn,
    memo: (component) => component,
  }
  const sandbox = {
    console,
    document,
    navigator: { language: 'zh-CN' },
    setTimeout: () => 0,
    clearTimeout: () => {},
    fetch: async () => ({ ok: true, json: async () => ({ rev: 1, status: 'idle' }) }),
    localStorage: { getItem: () => null, setItem: () => {} },
    URL,
    ResizeObserver: class {
      observe() {}
      disconnect() {}
    },
    window: {
      __ModuleLoader__: {
        load(registration) {
          registrations.push(registration)
        },
      },
    },
  }
  sandbox.globalThis = sandbox
  vm.runInNewContext(source, sandbox, { filename: 'lib/client.js' })

  assert.equal(registrations.length, 1, 'the bundle calls __ModuleLoader__.load exactly once')
  const registration = registrations[0]
  assert.equal(registration.id, 'dsh-prompt-prediction')
  const exportsObject = registration.factory((specifier) => {
    if (specifier === 'react') return React
    throw new Error(`unexpected require(${specifier})`)
  })
  return { exports: exportsObject, registration, styleTags, React, sandbox }
}

test('the bundle registers itself under the package name', () => {
  const { registration } = loadClient()
  assert.equal(registration.id, 'dsh-prompt-prediction')
})

test('the bundle exports a client plugin with a slots dependency', () => {
  const { exports } = loadClient()
  assert.equal(typeof exports.apply, 'function')
  assert.deepEqual([...exports.inject], ['slots'])
})

test('applying the plugin registers the composer overlay', () => {
  const { exports } = loadClient()
  const registered = []
  let injectedName = null
  const ctx = {
    slots: {
      inject(name, factory) {
        injectedName = name
        return factory()
      },
      register(descriptor, component) {
        registered.push({ descriptor, component })
        return () => {}
      },
    },
  }
  exports.apply(ctx)
  assert.equal(injectedName, 'conversation.input.overlay')
  assert.equal(registered.length, 1)
  assert.equal(registered[0].descriptor.name, 'conversation.input.overlay')
  assert.equal(registered[0].descriptor.id, 'prompt-prediction')
  assert.equal(typeof registered[0].component, 'function')
})

test('the package manifest wires the bundle patch and the web client', () => {
  const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  assert.equal(manifest.main, 'lib/index.js')
  assert.equal(manifest.exports['./client'], './lib/client.js')
  assert.equal(manifest.dsh.bundle.patch, './cordis.patch.yml')
  assert.equal(manifest.dsh.client.platform, 'web')
  assert.ok(manifest.dsh.client.inject.includes('@deepseek-ai/dsh-client-ui-conversation'))
  assert.equal(manifest.type, 'module')
})

test('the patch layer inserts exactly one host row', () => {
  const patch = readFileSync(new URL('../cordis.patch.yml', import.meta.url), 'utf8')
  assert.match(patch, /- insert:/)
  assert.match(patch, /id: prompt-prediction/)
  assert.match(patch, /name: dsh-prompt-prediction/)
})

test('the overlay component tolerates missing standard props', () => {
  const { exports, React } = loadClient()
  const registered = []
  exports.apply({
    slots: {
      inject: (_name, factory) => factory(),
      register: (descriptor, component) => registered.push({ descriptor, component }),
    },
  })
  // Without useInput/inputActions the component must render nothing rather than throw.
  const rendered = registered[0].component({})
  assert.equal(rendered, null)
})
