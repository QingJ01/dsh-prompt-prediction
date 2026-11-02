import assert from 'node:assert/strict'
import test from 'node:test'

import { apply, inject, name } from '../lib/index.js'

/**
 * These tests drive the host half against a fake cordis context: the plugin is
 * a plain ESM Cordis plugin, so everything except the HTTP listener and the real
 * LLM adapter can run without the app.
 */

function textMessage(role, text) {
  return { role, content: [{ type: 'text', text }] }
}

/** One streamed completion: the JSON payload Codex-style predictions return. */
function streamOf(payload, { finish = { kind: 'stop' }, usage, toolCall = false } = {}) {
  return async function* stream() {
    if (toolCall) yield { type: 'block-end', index: 0, block: { type: 'tool-call', name: 'bash' } }
    else {
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: payload }
    }
    if (usage !== undefined) yield { type: 'usage', usage }
    yield { type: 'finish', reason: finish }
  }
}

function makeSession(overrides = {}) {
  const messages = overrides.messages ?? [
    { role: 'system', content: [{ type: 'text', text: 'SYSTEM PROMPT' }] },
    textMessage('user', '帮我修一下构建'),
    textMessage('assistant', '修好了，测试也过了。'),
  ]
  return {
    id: overrides.id ?? 'session-1',
    header: overrides.header ?? { isSeeded: false },
    deriveMessages: () => messages,
    requestHeader: () =>
      overrides.header === undefined || overrides.header === null
        ? { config: { provider: 'deepseek-official', model: 'deepseek-flash', temperature: 0.2 }, tools: [{ name: 'bash', description: 'run', parameters: {} }] }
        : overrides.requestHeader ?? { config: { provider: 'deepseek-official', model: 'deepseek-flash' } },
    toolHistory: () => undefined,
    snapshotEvents: () => overrides.events ?? [{ type: 'turn/end', seq: 9, data: { turn: 1, reason: { kind: 'completed' } } }],
  }
}

function makeHarness({ session, stream, config } = {}) {
  const handlers = new Map()
  const routes = new Map()
  const calls = []
  const sessions = new Map()
  if (session !== undefined) sessions.set(session.id, session)

  const connection = { fetch: {
    register(route) {
      routes.set(route.path, route)
      return () => routes.delete(route.path)
    },
  }

  }

  const llm = {
    async prepareCall(prepared, signal, configure) {
      calls.push({ prepared, configure })
      return {
        config: { ...prepared },
        async *stream(options) {
          calls[calls.length - 1].options = options
          yield* stream(options)
        },
      }
    },
  }

  const ctx = {
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    on(type, handler) {
      const list = handlers.get(type) ?? []
      list.push(handler)
      handlers.set(type, list)
    },
    effect(factory) {
      const disposer = factory()
      return () => disposer?.()
    },
    inject(_services, callback) {
      callback({ ...ctx, webServer })
    },
    connection,
    sessions: { get: (id) => sessions.get(id) },
    llm,
  }

  apply(ctx, { auditLog: false, ...config })

  const emit = (type, ...args) => {
    for (const handler of handlers.get(type) ?? []) handler(...args)
  }

  const call = async (path, { query = {}, body } = {}) => {
    const route = routes.get(path)
    assert.ok(route !== undefined, `route ${path} is registered`)
    const url = new URL(`http://127.0.0.1${path}`)
    for (const [key, value] of Object.entries(query)) url.searchParams.set(key, String(value))
    const method = body === undefined ? 'GET' : 'POST'
    if (!route.methods.includes(method)) return { status: 405, body: null }
    const response = await route.fetch(new Request(url, {
      method,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }))
    return { status: response.status, body: await response.json() }
  }

  return { emit, call, routes, calls, sessions, llm }
}

/** Wait until the session state settles out of `pending`. */
async function settle(call, sessionId, { attempts = 60 } = {}) {
  let last = null
  for (let index = 0; index < attempts; index += 1) {
    const response = await call('/api/dsh-prompt-prediction/state', { query: { sessionId } })
    last = response.body
    if (last !== null && last.status !== 'pending' && last.unchanged !== true) return last
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  return last
}

test('the module exports a plain Cordis plugin', () => {
  assert.equal(name, 'dsh-prompt-prediction')
  assert.deepEqual(inject, ['sessions', 'llm', 'connection'])
  assert.equal(typeof apply, 'function')
})

test('registers the bridge routes', async () => {
  const harness = makeHarness({ session: makeSession() })
  assert.deepEqual(
    [...harness.routes.keys()].sort(),
    [
      '/api/dsh-prompt-prediction/config',
      '/api/dsh-prompt-prediction/feedback',
      '/api/dsh-prompt-prediction/ping',
      '/api/dsh-prompt-prediction/state',
    ],
  )
  const ping = await harness.call('/api/dsh-prompt-prediction/ping')
  assert.equal(ping.status, 200)
  assert.equal(ping.body.name, 'dsh-prompt-prediction')
  assert.equal(typeof ping.body.build, 'string')
  const config = await harness.call('/api/dsh-prompt-prediction/config')
  assert.equal(config.status, 200)
  assert.equal(config.body.enabled, true)
  assert.deepEqual(config.body.acceptKeys, ['Tab', 'ArrowRight'])
})

test('completed turn produces a ready prediction that reuses the logged route', async () => {
  const session = makeSession()
  const harness = makeHarness({ session, stream: streamOf('{"suggestion":"跑一下测试"}') })

  // Mark the session as watched, which is what enables eager work.
  await harness.call('/api/dsh-prompt-prediction/state', { query: { sessionId: session.id } })

  harness.emit('session/event', session, { type: 'turn/start', seq: 8, data: { turn: 1 } })
  harness.emit('session/event', session, { type: 'turn/end', seq: 9, data: { turn: 1, reason: { kind: 'completed' } } })

  const state = await settle(harness.call, session.id)
  assert.equal(state.status, 'ready')
  assert.equal(state.text, '跑一下测试')
  assert.equal(state.trigger, 'live')

  const call = harness.calls.at(-1)
  assert.equal(call.prepared.provider, 'deepseek-official', 'inherits the session route')
  assert.equal(call.prepared.model, 'deepseek-flash')
  assert.equal(call.options.tools.length, 1, 'loop tool schemas are reused for prefix identity')
  assert.equal(call.options.messages.length, 4, 'system + user + assistant + instruction')
  assert.match(call.options.messages.at(-1).content[0].text, /Composer prediction/)
  assert.equal(call.options.system, undefined, 'the loop carries its system prompt in history')
})

test('a configured route switches to a compact history without tools', async () => {
  const session = makeSession()
  const harness = makeHarness({
    session,
    stream: streamOf('{"suggestion":"继续"}'),
    config: { provider: 'cheap-provider', model: 'cheap-model' },
  })
  await harness.call('/api/dsh-prompt-prediction/state', { query: { sessionId: session.id } })
  harness.emit('session/event', session, { type: 'turn/end', seq: 9, data: { turn: 1, reason: { kind: 'completed' } } })

  const state = await settle(harness.call, session.id)
  assert.equal(state.status, 'ready')
  const call = harness.calls.at(-1)
  assert.equal(call.prepared.provider, 'cheap-provider')
  assert.equal(call.options.tools, undefined, 'an override route has no prefix to protect')
  assert.ok(call.options.messages.every((message) => message.role === 'user' || message.role === 'assistant'))
})

test('turn/start invalidates the previous prediction', async () => {
  const session = makeSession()
  const harness = makeHarness({ session, stream: streamOf('{"suggestion":"跑一下测试"}') })
  await harness.call('/api/dsh-prompt-prediction/state', { query: { sessionId: session.id } })
  harness.emit('session/event', session, { type: 'turn/end', seq: 9, data: { turn: 1, reason: { kind: 'completed' } } })
  assert.equal((await settle(harness.call, session.id)).status, 'ready')

  harness.emit('session/event', session, { type: 'turn/start', seq: 10, data: { turn: 2 } })
  const cleared = await harness.call('/api/dsh-prompt-prediction/state', { query: { sessionId: session.id } })
  assert.equal(cleared.body.status, 'idle', 'an open turn clears the ghost and blocks catch-up')
  assert.equal(cleared.body.text, null)
})

test('only completed turns are predicted', async () => {
  // No completed turn in the log, so the first state read has nothing to catch up on.
  const session = makeSession({ events: [] })
  const harness = makeHarness({ session, stream: streamOf('{"suggestion":"x"}') })
  await harness.call('/api/dsh-prompt-prediction/state', { query: { sessionId: session.id, rev: 0 } })

  for (const kind of ['aborted', 'error', 'max-tokens', 'blocked']) {
    harness.emit('session/event', session, { type: 'turn/end', seq: 20, data: { turn: 2, reason: { kind } } })
  }
  const state = await harness.call('/api/dsh-prompt-prediction/state', { query: { sessionId: session.id } })
  assert.notEqual(state.body.status, 'ready')
  assert.equal(harness.calls.length, 0, 'no model call is made')
})

test('a declined prediction becomes a quiet none state', async () => {
  const session = makeSession()
  const harness = makeHarness({ session, stream: streamOf('{"suggestion":null}') })
  await harness.call('/api/dsh-prompt-prediction/state', { query: { sessionId: session.id } })
  harness.emit('session/event', session, { type: 'turn/end', seq: 9, data: { turn: 1, reason: { kind: 'completed' } } })
  const state = await settle(harness.call, session.id)
  assert.equal(state.status, 'none')
  assert.equal(state.reason, 'declined')
  assert.equal(state.text, null)
})

test('a tool call is discarded instead of shown', async () => {
  const session = makeSession()
  const harness = makeHarness({ session, stream: streamOf('', { toolCall: true, finish: { kind: 'tool-calls' } }) })
  await harness.call('/api/dsh-prompt-prediction/state', { query: { sessionId: session.id } })
  harness.emit('session/event', session, { type: 'turn/end', seq: 9, data: { turn: 1, reason: { kind: 'completed' } } })
  const state = await settle(harness.call, session.id)
  assert.equal(state.status, 'none')
  assert.equal(state.reason, 'tool-call')
})

test('subagent sessions are ineligible', async () => {
  const session = makeSession({ header: { isSeeded: false, origin: 'subagent' } })
  const harness = makeHarness({ session, stream: streamOf('{"suggestion":"x"}') })
  await harness.call('/api/dsh-prompt-prediction/state', { query: { sessionId: session.id } })
  harness.emit('session/event', session, { type: 'turn/end', seq: 9, data: { turn: 1, reason: { kind: 'completed' } } })
  const state = await settle(harness.call, session.id)
  assert.equal(state.status, 'ineligible')
  assert.equal(state.reason, 'derived-session')
  assert.equal(harness.calls.length, 0)
})

test('a session with no assistant reply is not predicted', async () => {
  const session = makeSession({ messages: [textMessage('user', 'hi')] })
  const harness = makeHarness({ session, stream: streamOf('{"suggestion":"x"}') })
  await harness.call('/api/dsh-prompt-prediction/state', { query: { sessionId: session.id } })
  harness.emit('session/event', session, { type: 'turn/end', seq: 9, data: { turn: 1, reason: { kind: 'completed' } } })
  const state = await settle(harness.call, session.id)
  assert.equal(state.reason, 'no-assistant-reply')
})

test('unknown sessions answer without a model call', async () => {
  const harness = makeHarness({})
  const response = await harness.call('/api/dsh-prompt-prediction/state', { query: { sessionId: 'nope' } })
  assert.equal(response.body.status, 'unknown-session')
  assert.equal(harness.calls.length, 0)
})

test('a missing sessionId is a 400', async () => {
  const harness = makeHarness({})
  const response = await harness.call('/api/dsh-prompt-prediction/state')
  assert.equal(response.status, 400)
})

test('an unchanged revision answers with a tiny envelope', async () => {
  const session = makeSession()
  const harness = makeHarness({ session, stream: streamOf('{"suggestion":"ok"}') })
  const first = await harness.call('/api/dsh-prompt-prediction/state', { query: { sessionId: session.id } })
  const second = await harness.call('/api/dsh-prompt-prediction/state', { query: { sessionId: session.id, rev: first.body.rev } })
  assert.deepEqual(second.body, { rev: first.body.rev, unchanged: true })
})

test('feedback records an acceptance and submission statistics', async () => {
  const session = makeSession()
  const harness = makeHarness({ session, stream: streamOf('{"suggestion":"跑测试"}') })
  await harness.call('/api/dsh-prompt-prediction/state', { query: { sessionId: session.id } })
  harness.emit('session/event', session, { type: 'turn/end', seq: 9, data: { turn: 1, reason: { kind: 'completed' } } })
  await settle(harness.call, session.id)

  const accepted = await harness.call('/api/dsh-prompt-prediction/feedback', {
    body: { sessionId: session.id, turnSeq: 9, action: 'accepted', text: '跑测试' },
  })
  assert.equal(accepted.status, 200)

  // The submitted message the user actually sent is compared in the audit log.
  harness.emit('session/event', session, {
    type: 'user/message',
    seq: 11,
    data: { role: 'user', content: [{ type: 'text', text: '跑测试吧' }], source: { kind: 'user' } },
  })
  const reset = await harness.call('/api/dsh-prompt-prediction/state', { query: { sessionId: session.id } })
  assert.notEqual(reset.body.status, 'ready')
})

test('synthetic user messages do not count as the user speaking', async () => {
  const session = makeSession()
  const harness = makeHarness({ session, stream: streamOf('{"suggestion":"ok"}') })
  await harness.call('/api/dsh-prompt-prediction/state', { query: { sessionId: session.id } })
  harness.emit('session/event', session, { type: 'turn/end', seq: 9, data: { turn: 1, reason: { kind: 'completed' } } })
  assert.equal((await settle(harness.call, session.id)).status, 'ready')

  harness.emit('session/event', session, {
    type: 'user/message',
    seq: 10,
    data: { role: 'user', content: [{ type: 'text', text: 'AGENTS.md notice' }], source: { kind: 'inject' } },
  })
  const still = await harness.call('/api/dsh-prompt-prediction/state', { query: { sessionId: session.id } })
  assert.equal(still.body.status, 'ready', 'an injected context row must not clear the prediction')
})

test('an error finish is reported as failed, not shown', async () => {
  const session = makeSession()
  const harness = makeHarness({
    session,
    stream: streamOf('', { finish: { kind: 'error', failure: { code: 'AUTH', message: 'bad key' } } }),
  })
  await harness.call('/api/dsh-prompt-prediction/state', { query: { sessionId: session.id } })
  harness.emit('session/event', session, { type: 'turn/end', seq: 9, data: { turn: 1, reason: { kind: 'completed' } } })
  const state = await settle(harness.call, session.id)
  assert.equal(state.status, 'failed')
  assert.match(state.reason, /finish:error/)
})

test('disabled configuration makes no calls', async () => {
  const session = makeSession()
  const harness = makeHarness({ session, stream: streamOf('{"suggestion":"x"}'), config: { enabled: false } })
  await harness.call('/api/dsh-prompt-prediction/state', { query: { sessionId: session.id } })
  harness.emit('session/event', session, { type: 'turn/end', seq: 9, data: { turn: 1, reason: { kind: 'completed' } } })
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.equal(harness.calls.length, 0)
})

test('usage tokens travel to the browser for cost inspection', async () => {
  const session = makeSession()
  const harness = makeHarness({
    session,
    stream: streamOf('{"suggestion":"继续"}', { usage: { inputTokens: 5000, cacheReadTokens: 4800, outputTokens: 12 } }),
  })
  await harness.call('/api/dsh-prompt-prediction/state', { query: { sessionId: session.id } })
  harness.emit('session/event', session, { type: 'turn/end', seq: 9, data: { turn: 1, reason: { kind: 'completed' } } })
  const state = await settle(harness.call, session.id)
  assert.equal(state.status, 'ready')
  assert.deepEqual(state.usage, {
    inputTokens: 5000,
    outputTokens: 12,
    cachedInputTokens: 4800,
    cacheWriteTokens: null,
    reasoningTokens: null,
    totalTokens: null,
  })
})

test('maxHistoryChars skips an oversized history', async () => {
  const session = makeSession({
    messages: [
      textMessage('user', 'x'.repeat(500)),
      textMessage('assistant', 'y'.repeat(500)),
    ],
  })
  const harness = makeHarness({ session, stream: streamOf('{"suggestion":"x"}'), config: { maxHistoryChars: 100 } })
  await harness.call('/api/dsh-prompt-prediction/state', { query: { sessionId: session.id } })
  harness.emit('session/event', session, { type: 'turn/end', seq: 9, data: { turn: 1, reason: { kind: 'completed' } } })
  const state = await settle(harness.call, session.id)
  assert.equal(state.status, 'ineligible')
  assert.equal(state.reason, 'history-too-large')
})

test('a prediction runs once per turn', async () => {
  const session = makeSession()
  const harness = makeHarness({ session, stream: streamOf('{"suggestion":"ok"}') })
  await harness.call('/api/dsh-prompt-prediction/state', { query: { sessionId: session.id } })
  harness.emit('session/event', session, { type: 'turn/end', seq: 9, data: { turn: 1, reason: { kind: 'completed' } } })
  harness.emit('session/event', session, { type: 'turn/end', seq: 9, data: { turn: 1, reason: { kind: 'completed' } } })
  await settle(harness.call, session.id)
  await harness.call('/api/dsh-prompt-prediction/state', { query: { sessionId: session.id } })
  assert.equal(harness.calls.length, 1, 'the second turn/end for the same turn makes no call')
})

test('a new turn aborts the in-flight prediction', async () => {
  const session = makeSession()
  let observedAbort = false
  const harness = makeHarness({
    session,
    stream: async function* stream(options) {
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, 2000)
        options.signal?.addEventListener('abort', () => {
          observedAbort = true
          clearTimeout(timer)
          resolve()
        })
      })
      yield { type: 'finish', reason: { kind: 'aborted', failure: { code: 'ABORTED', message: 'x' } } }
    },
  })
  await harness.call('/api/dsh-prompt-prediction/state', { query: { sessionId: session.id } })
  harness.emit('session/event', session, { type: 'turn/end', seq: 9, data: { turn: 1, reason: { kind: 'completed' } } })
  // Let the prediction start, then start a new turn.
  await new Promise((resolve) => setTimeout(resolve, 10))
  harness.emit('session/event', session, { type: 'turn/start', seq: 10, data: { turn: 2 } })
  await new Promise((resolve) => setTimeout(resolve, 30))
  assert.equal(observedAbort, true, 'the stream saw the abort')
  const state = await harness.call('/api/dsh-prompt-prediction/state', { query: { sessionId: session.id } })
  assert.equal(state.body.status, 'idle')
  assert.equal(state.body.text, null)
})

test('a prediction that outruns the deadline is reported as a timeout', async () => {
  const session = makeSession()
  const harness = makeHarness({
    session,
    config: { timeoutMs: 30 },
    stream: async function* stream(options) {
      await new Promise((resolve) => {
        if (options.signal?.aborted) return resolve()
        options.signal?.addEventListener('abort', resolve)
        setTimeout(resolve, 500)
      })
      throw Object.assign(new Error('aborted'), { code: 'ABORTED' })
    },
  })
  await harness.call('/api/dsh-prompt-prediction/state', { query: { sessionId: session.id } })
  harness.emit('session/event', session, { type: 'turn/end', seq: 9, data: { turn: 1, reason: { kind: 'completed' } } })
  const state = await settle(harness.call, session.id, { attempts: 80 })
  assert.equal(state.status, 'failed')
  assert.equal(state.reason, 'timeout')
})

test('a trailing turn/start blocks catch-up even after a reload', async () => {
  // A page reload loses the live turnOpen flag; the log is the source of truth.
  const session = makeSession({
    events: [
      { type: 'turn/end', seq: 9, data: { turn: 1, reason: { kind: 'completed' } } },
      { type: 'turn/start', seq: 10, data: { turn: 2 } },
    ],
  })
  const harness = makeHarness({ session, stream: streamOf('{"suggestion":"x"}') })
  const response = await harness.call('/api/dsh-prompt-prediction/state', { query: { sessionId: session.id } })
  assert.equal(response.body.status, 'idle')
  assert.equal(harness.calls.length, 0, 'the agent is mid-turn; nothing to predict')
})

test('a tool-only final step still predicts from the last spoken line', async () => {
  const session = makeSession({
    messages: [
      textMessage('user', '修一下构建'),
      textMessage('assistant', '我先看看失败的用例。'),
      { role: 'assistant', content: [{ type: 'reasoning', text: 'thinking' }, { type: 'tool-call', name: 'bash' }] },
    ],
  })
  const harness = makeHarness({ session, stream: streamOf('{"suggestion":"跑一下测试"}') })
  await harness.call('/api/dsh-prompt-prediction/state', { query: { sessionId: session.id } })
  harness.emit('session/event', session, { type: 'turn/end', seq: 9, data: { turn: 1, reason: { kind: 'completed' } } })
  const state = await settle(harness.call, session.id)
  assert.equal(state.status, 'ready', 'the tool-only step must not cancel the prediction')
  assert.equal(state.text, '跑一下测试')
})

test('a session that never had a completed turn is not caught up', async () => {
  const session = makeSession({ events: [{ type: 'turn/end', seq: 5, data: { turn: 1, reason: { kind: 'aborted' } } }] })
  const harness = makeHarness({ session, stream: streamOf('{"suggestion":"x"}') })
  const response = await harness.call('/api/dsh-prompt-prediction/state', { query: { sessionId: session.id } })
  assert.equal(response.body.status, 'idle')
  assert.equal(harness.calls.length, 0)
})

test('negative catch-up scans are cached instead of projecting the log on every poll', async () => {
  const session = makeSession({ events: [] })
  let scans = 0
  session.snapshotEvents = () => { scans += 1; return [] }
  const harness = makeHarness({ session })
  for (let index = 0; index < 3; index++) await harness.call('/api/dsh-prompt-prediction/state', { query: { sessionId: session.id } })
  assert.equal(scans, 1)
})

test('a newer human message blocks catch-up of the preceding completed turn', async () => {
  const session = makeSession({ events: [
    { type: 'turn/end', seq: 9, data: { reason: { kind: 'completed' } } },
    { type: 'user/message', seq: 10, data: { source: { kind: 'user' } } },
  ] })
  const harness = makeHarness({ session })
  const result = await harness.call('/api/dsh-prompt-prediction/state', { query: { sessionId: session.id } })
  assert.equal(result.body.status, 'idle')
  assert.equal(harness.calls.length, 0)
})

test('human submission invalidates catch-up before turn/start arrives', async () => {
  const session = makeSession()
  const harness = makeHarness({ session, stream: streamOf('{"suggestion":"继续"}') })
  await harness.call('/api/dsh-prompt-prediction/state', { query: { sessionId: session.id } })
  await settle(harness.call, session.id)
  const count = harness.calls.length
  harness.emit('session/event', session, { type: 'user/message', seq: 10, data: { source: { kind: 'user' } } })
  const result = await harness.call('/api/dsh-prompt-prediction/state', { query: { sessionId: session.id } })
  assert.equal(result.body.status, 'idle')
  assert.equal(harness.calls.length, count)
})

test('cancel while preparing never starts a stale stream', async () => {
  const session = makeSession({ events: [] })
  const harness = makeHarness({ session })
  let release
  let streamed = false
  harness.llm.prepareCall = () => new Promise(resolve => { release = resolve })
  await harness.call('/api/dsh-prompt-prediction/state', { query: { sessionId: session.id } })
  harness.emit('session/event', session, { type: 'turn/end', seq: 9, data: { reason: { kind: 'completed' } } })
  assert.equal(typeof release, 'function')
  harness.emit('session/event', session, { type: 'turn/start', seq: 10, data: {} })
  release({ config: {}, async *stream() { streamed = true } })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(streamed, false)
})

test('a stream returning normally after its deadline cannot publish ready', async () => {
  const session = makeSession()
  const harness = makeHarness({ session, config: { timeoutMs: 5 }, stream: async function* (options) {
    await new Promise(resolve => {
      if (options.signal.aborted) resolve()
      else options.signal.addEventListener('abort', resolve, { once: true })
    })
    yield { type: 'text-delta', text: '{"suggestion":"过期"}' }
    yield { type: 'finish', reason: { kind: 'stop' } }
  } })
  await harness.call('/api/dsh-prompt-prediction/state', { query: { sessionId: session.id } })
  const result = await settle(harness.call, session.id)
  assert.equal(result.status, 'failed')
  assert.equal(result.reason, 'timeout')
})

test('feedback rejects nonexistent sessions without allocating state', async () => {
  const harness = makeHarness()
  const result = await harness.call('/api/dsh-prompt-prediction/feedback', { body: { sessionId: 'invented', action: 'mounted' } })
  assert.equal(result.status, 404)
  assert.equal((await harness.call('/api/dsh-prompt-prediction/ping')).body.trackedSessions, 0)
})

test('acceptance must match current turn and text', async () => {
  const session = makeSession()
  const harness = makeHarness({ session, stream: streamOf('{"suggestion":"继续"}') })
  await harness.call('/api/dsh-prompt-prediction/state', { query: { sessionId: session.id } })
  await settle(harness.call, session.id)
  for (const body of [
    { sessionId: session.id, action: 'accepted', turnSeq: 8, text: '继续' },
    { sessionId: session.id, action: 'accepted', turnSeq: 9, text: '伪造' },
  ]) assert.equal((await harness.call('/api/dsh-prompt-prediction/feedback', { body })).status, 409)
  assert.equal((await harness.call('/api/dsh-prompt-prediction/feedback', { body: { sessionId: session.id, action: 'unknown' } })).status, 400)
  assert.equal((await harness.call('/api/dsh-prompt-prediction/feedback', { body: { sessionId: session.id, action: 'accepted', turnSeq: 9, text: '继续' } })).status, 200)
})

test('Fetch route method allowlists protect prediction and feedback endpoints', async () => {
  const harness = makeHarness()
  assert.deepEqual(harness.routes.get('/api/dsh-prompt-prediction/state').methods, ['GET'])
  assert.deepEqual(harness.routes.get('/api/dsh-prompt-prediction/feedback').methods, ['POST'])
  assert.equal((await harness.call('/api/dsh-prompt-prediction/feedback')).status, 405)
})

test('an uncooperative prepare call times out and frees its slot', async () => {
  const session = makeSession()
  const harness = makeHarness({ session, config: { timeoutMs: 5 } })
  harness.llm.prepareCall = () => new Promise(() => {})
  await harness.call('/api/dsh-prompt-prediction/state', { query: { sessionId: session.id } })
  const result = await settle(harness.call, session.id)
  assert.equal(result.reason, 'timeout')
  await new Promise(resolve => setImmediate(resolve))
  assert.equal((await harness.call('/api/dsh-prompt-prediction/ping')).body.running, 0)
})

test('an uncooperative iterator cannot occupy a prediction slot forever', async () => {
  const session = makeSession()
  const harness = makeHarness({ session, config: { timeoutMs: 5 }, stream: async function* () {
    await new Promise(() => {})
  } })
  await harness.call('/api/dsh-prompt-prediction/state', { query: { sessionId: session.id } })
  const result = await settle(harness.call, session.id)
  assert.equal(result.reason, 'timeout')
  await new Promise(resolve => setImmediate(resolve))
  assert.equal((await harness.call('/api/dsh-prompt-prediction/ping')).body.running, 0)
})

test('an overlong provider stream is bounded even if it ignores maxTokens', async () => {
  const session = makeSession()
  const harness = makeHarness({ session, config: { timeoutMs: 1000 }, stream: async function* () {
    for (let index = 0; index < 9000; index++) yield { type: 'text-delta', text: 'x' }
    yield { type: 'finish', reason: { kind: 'stop' } }
  } })
  await harness.call('/api/dsh-prompt-prediction/state', { query: { sessionId: session.id } })
  const result = await settle(harness.call, session.id)
  assert.equal(result.status, 'none')
  assert.equal(result.reason, 'response-too-large')
})

test('one oversized provider block cannot bypass the response budget', async () => {
  const session = makeSession()
  const harness = makeHarness({ session, stream: async function* () {
    yield { type: 'text-delta', text: 'x'.repeat(1024 * 1024 + 1) }
    yield { type: 'finish', reason: { kind: 'stop' } }
  } })
  await harness.call('/api/dsh-prompt-prediction/state', { query: { sessionId: session.id } })
  assert.equal((await settle(harness.call, session.id)).reason, 'response-too-large')
})
