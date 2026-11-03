/**
 * Host half of the composer prompt prediction: it watches completed turns,
 * asks the model the same question Codex's "Cumberbatch" asks after a reply,
 * and serves the answer to the browser over one small HTTP bridge.
 *
 * Design notes that matter for behaviour:
 *
 * - The prediction request reuses the session's own logged route, tools and
 *   derived history, so everything up to the final assistant message is
 *   byte-identical to the next real request and the provider's prefix cache
 *   still hits. A configured `provider`/`model` pair opts out of that reuse and
 *   switches to a short compact history instead.
 * - Nothing model-visible is appended to the session: predictions stay in
 *   process memory, so the main agent's history and KV cache are untouched.
 * - The browser never receives a prediction it did not ask for; `eagerWindowMs`
 *   keeps background work to sessions somebody is actually looking at.
 *
 * @module dsh-prompt-prediction
 */
import { appendFile, mkdir, rename, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import Schema from '@deepseek-ai/schemastery'

import {
  assembleChunks,
  compactHistory,
  historyChars,
  isDerivedSession,
  lastAssistantText,
  reasoningEffortPolicy,
  messageText,
  normalizeConfig,
  parseSuggestion,
  predictionInstruction,
  styleExemplars,
  turnIsPredictable,
} from './prediction.js'

export const name = 'dsh-prompt-prediction'

export const Config = Schema.object({
  enabled: Schema.boolean().default(true).volatile(),
  maxSuggestionChars: Schema.number().step(1).min(1).default(200).volatile(),
  timeoutMs: Schema.number().step(1).min(1).max(2147483647).default(20000).volatile(),
  maxOutputTokens: Schema.number().step(1).min(1).default(1000).volatile(),
  auditLog: Schema.boolean().default(true).volatile(),
  reasoningEffort: Schema.string().default('inherit').volatile(),
})

/** Prediction needs the session log and a model route; the web bridge is optional. */
export const inject = ['sessions', 'llm', 'connection']

/** Bridge namespace shared with `lib/client.js`. */
const ROUTE_PREFIX = '/api/dsh-prompt-prediction'

/** Terminal reason recorded when our own deadline fires. */
const TIMEOUT_CODE = 'PROMPT_PREDICTION_TIMEOUT'

/** Concurrent predictions across all sessions; a background guess must not queue up. */
const MAX_CONCURRENT = 2

/** Body cap for the feedback endpoint. */
const MAX_BODY_BYTES = 8 * 1024

/** Audit log size that triggers a single `.1` rotation (checked every 100 writes). */
const AUDIT_ROTATE_BYTES = 4 * 1024 * 1024

/**
 * Mount the prediction service and its bridge.
 * @param {object} ctx - host plugin context (cordis).
 * @param {unknown} rawConfig - the `config:` block of the loader row.
 */
export function apply(ctx, rawConfig) {
  const readConfig = () => normalizeConfig(Object.fromEntries(
    Object.entries(rawConfig ?? {}).map(([key, value]) => [key,
      typeof value?.get === 'function' ? value.get() : value]),
  ))
  let config = readConfig()
  /** @type {Map<string, object>} per-session prediction state */
  const states = new Map()
  let running = 0
  let disposed = false

  ctx.on('loader/volatile-update', () => {
    const previous = config
    config = readConfig()
    if (['enabled', 'maxSuggestionChars', 'timeoutMs', 'maxOutputTokens']
      .every(key => previous[key] === config[key])) return
    for (const state of states.values()) {
      abort(state, 'settings-changed')
      publish(state, {
        status: 'idle', text: null, turnSeq: null, reason: null,
        latencyMs: null, usage: null, candidateTurnSeq: null, catchupScanned: false,
      })
    }
  })

  const log = makeLogger(ctx)

  const now = () => Date.now()

  /** Path of the audit log, resolved lazily so importing never touches the disk. */
  const auditPath = join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'prompt-prediction', 'events.jsonl')

  let auditWrites = 0

  let auditQueue = Promise.resolve()

  function audit(entry) {
    if (!config.auditLog) return
    const line = `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`
    auditWrites += 1
    const rotate = auditWrites % 100 === 0
    auditQueue = auditQueue.then(() => mkdir(join(auditPath, '..'), { recursive: true }))
      .then(async () => {
        await appendFile(auditPath, line, 'utf8')
        if (rotate && (await fileSize(auditPath)) > AUDIT_ROTATE_BYTES) {
          await rename(auditPath, `${auditPath}.1`).catch(() => {})
        }
      })
      .catch(() => {})
  }

  function stateOf(sessionId) {
    let state = states.get(sessionId)
    if (state === undefined) {
      state = {
        rev: 0,
        status: 'idle',
        turnSeq: null,
        turn: null,
        text: null,
        reason: null,
        trigger: null,
        latencyMs: null,
        usage: null,
        accepted: null,
        /** True between turn/start and turn/end: nothing to predict mid-turn. */
        turnOpen: false,
        catchupScanned: false,
        awaitingTurn: false,
        candidateTurnSeq: null,
        lastWatchedAt: 0,
        inflight: null,
      }
      states.set(sessionId, state)
    }
    return state
  }

  /** Merge a patch and bump the revision the browser polls with. */
  function publish(state, patch) {
    Object.assign(state, patch)
    state.rev += 1
  }

  function abort(state, reason) {
    if (state.inflight === null) return
    const controller = state.inflight
    state.inflight = null
    try {
      controller.abort(new Error(reason))
    } catch {
      /* an already-aborted controller is harmless */
    }
  }

  function snapshot(sessionId) {
    const state = stateOf(sessionId)
    return {
      rev: state.rev,
      status: state.status,
      turnSeq: state.turnSeq,
      text: state.text,
      reason: state.reason,
      trigger: state.trigger,
      latencyMs: state.latencyMs,
      promptVersion: state.promptVersion ?? config.promptVersion,
      usage: state.usage,
    }
  }

  /**
   * Schedule one prediction for a session turn.
   * @param {object} session - live DSH session.
   * @param {number} turnSeq - log position identifying the turn.
   * @param {'live'|'catch_up'} trigger - why we are running.
   */
  function schedule(session, turnSeq, trigger) {
    if (disposed || !config.enabled) return
    const state = stateOf(session.id)
    if (state.inflight !== null) return
    // One prediction per turn: a second request for the same turn is a no-op.
    if (state.turnSeq === turnSeq && (state.status === 'ready' || state.status === 'pending')) return
    if (running >= MAX_CONCURRENT) {
      log('debug', `prompt-prediction: skipping ${trigger} prediction for "${session.id}" (busy)`)
      return
    }

    const controller = new AbortController()
    state.inflight = controller
    running += 1
    publish(state, {
      status: 'pending',
      turnSeq,
      text: null,
      reason: null,
      trigger,
      latencyMs: null,
      usage: null,
    })

    const startedAt = now()
    void run(session, state, controller.signal)
      .then((result) => {
        if (state.inflight !== controller || controller.signal.aborted) return
        if (result.status === 'ready') {
          publish(state, {
            status: 'ready',
            text: result.text,
            reason: null,
            latencyMs: now() - startedAt,
            usage: result.usage,
            promptVersion: config.promptVersion,
          })
          audit({
            kind: 'prediction',
            sessionId: session.id,
            turnSeq,
            trigger,
            promptVersion: config.promptVersion,
            route: result.route,
            reusedPrefix: result.reusedPrefix,
            latencyMs: now() - startedAt,
            inputTokens: result.usage?.inputTokens ?? null,
            cachedInputTokens: result.usage?.cachedInputTokens ?? null,
            cacheWriteTokens: result.usage?.cacheWriteTokens ?? null,
            outputTokens: result.usage?.outputTokens ?? null,
            text: result.text,
          })
        } else {
          publish(state, {
            status: result.status,
            text: null,
            reason: result.reason ?? null,
            latencyMs: now() - startedAt,
            promptVersion: config.promptVersion,
          })
          audit({
            kind: result.status,
            sessionId: session.id,
            turnSeq,
            trigger,
            reason: result.reason ?? null,
            latencyMs: now() - startedAt,
          })
        }
      })
      .catch((error) => {
        if (state.inflight !== controller) return
        publish(state, { status: 'failed', text: null, reason: 'exception', latencyMs: now() - startedAt })
        log('debug', `prompt-prediction: prediction failed for "${session.id}": ${String(error?.message ?? error)}`)
      })
      .finally(() => {
        running -= 1
        if (state.inflight === controller) state.inflight = null
      })
  }

  /**
   * Build and run the auxiliary request.
   * @returns {Promise<{status: string, text?: string, reason?: string, usage?: object, route?: object, reusedPrefix?: boolean}>}
   */
  async function run(session, state, signal) {
    if (!config.enabled) return { status: 'ineligible', reason: 'disabled' }
    const header = typeof session.requestHeader === 'function' ? session.requestHeader() : undefined
    if (header === undefined || header.config === undefined) return { status: 'ineligible', reason: 'no-route' }
    if (isDerivedSession(session.header)) return { status: 'ineligible', reason: 'derived-session' }

    const messages = session.deriveMessages()
    const assistantText = lastAssistantText(messages)
    if (assistantText.length === 0) return { status: 'ineligible', reason: 'no-assistant-reply' }

    const overrideRoute = config.provider !== null && config.model !== null
    const provider = overrideRoute ? config.provider : header.config.provider
    const model = overrideRoute ? config.model : header.config.model
    if (typeof provider !== 'string' || typeof model !== 'string') return { status: 'ineligible', reason: 'no-route' }

    const budget = new AbortController()
    const timed = AbortSignal.any([signal, budget.signal, AbortSignal.timeout(config.timeoutMs)])
    const cancelled = () => signal.aborted
      ? { status: 'idle', reason: 'cancelled' }
      : { status: 'failed', reason: 'timeout' }

    let call
    try {
      call = await abortable(ctx.llm.prepareCall(
        { ...header.config, provider, model, maxTokens: config.maxOutputTokens },
        timed,
        reasoningEffortPolicy(config.reasoningEffort),
      ), timed)
    } catch (error) {
      if (timed.aborted) return cancelled()
      return { status: 'failed', reason: `prepare:${String(error?.code ?? error?.message ?? error)}` }
    }

    if (timed.aborted) return cancelled()

    const history = overrideRoute ? compactHistory(messages, config.compactTurns) : messages
    if (config.maxHistoryChars > 0 && historyChars(history) > config.maxHistoryChars) {
      return { status: 'ineligible', reason: 'history-too-large' }
    }

    // Anchors come from the user's own turns, which the model already sees; they
    // only steer length and vocabulary toward how this person actually writes.
    const exemplars = styleExemplars(messages, 3, 120)
    const instruction = {
      id: randomUUID(),
      source: { kind: 'user' },
      role: 'user',
      content: [{ type: 'text', text: predictionInstruction({ exemplars, maxSuggestionChars: config.maxSuggestionChars }) }],
    }
    const requestMessages = [...history, instruction]

    /** @type {Record<string, unknown>} */
    const options = {
      ...call.config,
      messages: requestMessages,
      sessionId: session.id,
      signal: timed,
    }
    // Reusing the loop's tool schemas is what keeps the cached prefix intact;
    // an override route has no prefix to protect and skips them to stay cheap.
    if (!overrideRoute) {
      if (Array.isArray(header.tools)) options.tools = header.tools
      if (typeof session.toolHistory === 'function') {
        try {
          const toolHistory = session.toolHistory()
          if (toolHistory !== undefined && toolHistory !== null) options.toolHistory = toolHistory
        } catch {
          /* a missing projection only costs tool-update fidelity */
        }
      }
    }

    /** @type {unknown[]} */
    const chunks = []
    let responseBytes = 0
    try {
      const iterator = call.stream(options)[Symbol.asyncIterator]()
      try {
        while (true) {
          const item = await abortable(iterator.next(), timed)
          if (timed.aborted) return cancelled()
          if (item.done) break
          responseBytes += Buffer.byteLength(JSON.stringify(item.value), 'utf8')
          if (chunks.length >= 8192 || responseBytes > 1024 * 1024) {
            budget.abort(new Error('prediction response budget exceeded'))
            return { status: 'none', reason: 'response-too-large' }
          }
          chunks.push(item.value)
        }
      } finally {
        // Do not wait for an uncooperative generator's return while next() hangs.
        if (timed.aborted) void Promise.resolve(iterator.return?.()).catch(() => {})
      }
    } catch (error) {
      if (timed.aborted && !signal.aborted) return { status: 'failed', reason: 'timeout' }
      return { status: 'failed', reason: `stream:${String(error?.code ?? error?.message ?? error)}` }
    }
    if (timed.aborted) return cancelled()

    const assembled = assembleChunks(chunks)
    if (assembled.toolCall) return { status: 'none', reason: 'tool-call' }
    const finish = assembled.finish
    if (finish === undefined) return { status: 'failed', reason: 'no-finish' }
    if (finish.kind !== 'stop') {
      return { status: 'failed', reason: `finish:${finish.kind}`, usage: pickUsage(assembled.usage) }
    }

    const parsed = parseSuggestion(assembled.text, {
      maxSuggestionChars: config.maxSuggestionChars,
      previousAssistantText: assistantText,
      lastUserText: lastUserText(messages),
    })
    if (!parsed.ok) return { status: 'none', reason: parsed.reason, usage: pickUsage(assembled.usage) }

    return {
      status: 'ready',
      text: parsed.text,
      usage: pickUsage(assembled.usage),
      route: { provider, model },
      reusedPrefix: !overrideRoute,
    }
  }

  // ---------------------------------------------------------------------------
  // Session observation
  // ---------------------------------------------------------------------------

  ctx.on('session/event', (session, event) => {
    if (disposed || session === undefined || event === undefined) return
    const state = stateOf(session.id)
    switch (event.type) {
      case 'turn/start': {
        // A new turn makes the previous guess stale, exactly like Codex drops
        // its cached prediction when the next turn starts.
        abort(state, 'turn-start')
        state.turnOpen = true
        state.awaitingTurn = false
        state.catchupScanned = true
        state.candidateTurnSeq = null
        publish(state, { status: 'idle', turnSeq: null, turn: null, text: null, reason: null, trigger: null, usage: null })
        break
      }
      case 'user/message': {
        const source = event.data?.source
        if (source !== undefined && source !== null && source.kind !== 'user') break
        state.awaitingTurn = true
        state.catchupScanned = true
        state.candidateTurnSeq = null
        recordSubmission(session, state, event)
        abort(state, 'user-message')
        publish(state, { status: 'idle', turnSeq: null, text: null, reason: null, trigger: null, usage: null })
        break
      }
      case 'turn/end': {
        state.turnOpen = false
        state.awaitingTurn = false
        state.catchupScanned = true
        state.candidateTurnSeq = turnIsPredictable(event.data?.reason) ? event.seq : null
        if (!turnIsPredictable(event.data?.reason)) break
        const watchedRecently = now() - state.lastWatchedAt < config.eagerWindowMs
        if (!watchedRecently) break
        schedule(session, event.seq, 'live')
        break
      }
      default:
        break
    }
  })

  ctx.on('session/disposed', (session) => {
    const state = states.get(session.id)
    if (state === undefined) return
    abort(state, 'session-disposed')
    states.delete(session.id)
  })

  /**
   * Compare the accepted suggestion with what the user actually sent.
   *
   * This is the only quality signal the plugin has: Codex records the same
   * accepted-versus-submitted pair, and it is what tells us whether a prompt
   * revision helped.
   */
  function recordSubmission(session, state, event) {
    const accepted = state.accepted
    if (accepted === null) return
    state.accepted = null
    const submitted = messageTextOf(event.data)
    if (submitted === null) return
    audit({
      kind: 'submitted',
      sessionId: session.id,
      turnSeq: accepted.turnSeq,
      promptVersion: accepted.promptVersion,
      acceptedText: accepted.text,
      submittedText: submitted.slice(0, 2000),
      identical: submitted.trim() === accepted.text,
      editDistance: boundedEditDistance(accepted.text, submitted.trim(), 2000),
    })
  }

  ctx.effect(() => () => {
    disposed = true
    for (const state of states.values()) abort(state, 'plugin-disposed')
    states.clear()
  }, 'prompt-prediction lifecycle')

  // ---------------------------------------------------------------------------
  // Browser bridge
  // ---------------------------------------------------------------------------

  // Use the carrier-neutral, owner-authenticated Fetch registry. Registering
  // raw webServer routes would bypass the connection's Host/Origin and login fence.
  for (const [path, method, handler] of [
    ['ping', 'GET', pingHandler],
    ['state', 'GET', stateHandler],
    ['feedback', 'POST', feedbackHandler],
    ['config', 'GET', configHandler],
  ]) {
    ctx.connection.fetch.register({
      path: `${ROUTE_PREFIX}/${path}`,
      methods: [method],
      // DSH's streaming HTTP bridge always supplies a body; GET forbids one.
      requestBody: method === 'POST' ? 'streaming' : 'buffered',
      fetch: async (request) => {
        if (request.method !== method) return new Response(null, { status: 405 })
        // Adapt the small existing handlers; the connection owns authentication
        // and transports this same Fetch route over HTTP and Desktop IPC.
        let response
        const req = {
          url: request.url,
          async *[Symbol.asyncIterator]() {
            if (request.body !== null) {
              for await (const chunk of request.body) yield Buffer.from(chunk)
            }
          },
        }
        let status = 200
        let headers = {}
        await handler(req, {
          writeHead(code, values) { status = code; headers = values ?? {} },
          end(body) { response = new Response(body, { status, headers }) },
        })
        return response
      },
    })
  }

  audit({ kind: 'bridge-ready', transport: 'connection.fetch', routes: 4 })

  /** Authenticated liveness and build probe. */
  function pingHandler(_req, res) {
    sendJson(res, 200, {
      name,
      build: 'pp-host-10',
      promptVersion: config.promptVersion,
      uptimeMs: Math.round(process.uptime() * 1000),
      trackedSessions: states.size,
      running,
    })
  }

  function configHandler(_req, res) {
    sendJson(res, 200, {
      enabled: config.enabled,
      promptVersion: config.promptVersion,
      acceptOnEnter: false,
      acceptKeys: ['Tab', 'ArrowRight'],
    })
  }

  /**
   * Report the current prediction for one session.
   *
   * The browser polls this while the composer is empty; `catch_up` computes the
   * missing prediction for a turn nobody was watching when it ended.
   */
  async function stateHandler(req, res) {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const sessionId = url.searchParams.get('sessionId')
    if (typeof sessionId !== 'string' || sessionId.length === 0) {
      sendJson(res, 400, { error: 'sessionId is required' })
      return
    }
    const session = ctx.sessions.get(sessionId)
    if (session === undefined) {
      sendJson(res, 200, { rev: -1, status: 'unknown-session', text: null })
      return
    }
    const state = stateOf(sessionId)
    state.lastWatchedAt = now()

    // Catch up only when this session produced a completed turn we never
    // predicted (page opened later, Host restarted, feature just enabled).
    if (config.enabled && state.status === 'idle' && state.turnSeq === null &&
        !state.turnOpen && !state.awaitingTurn) {
      if (!state.catchupScanned) {
        state.candidateTurnSeq = lastPredictableTurnSeq(session)
        state.catchupScanned = true
      }
      if (state.candidateTurnSeq !== null) schedule(session, state.candidateTurnSeq, 'catch_up')
    }

    const since = url.searchParams.get('rev')
    const payload = snapshot(sessionId)
    if (since !== null && Number(since) === payload.rev) {
      sendJson(res, 200, { rev: payload.rev, unchanged: true })
      return
    }
    sendJson(res, 200, payload)
  }

  /** Record one browser interaction with a shown prediction. */
  async function feedbackHandler(req, res) {
    const body = await readJsonBody(req)
    if (body === undefined) {
      sendJson(res, 400, { error: 'invalid-body' })
      return
    }
    const { sessionId, turnSeq, action, text } = body
    if (typeof sessionId !== 'string' || typeof action !== 'string') {
      sendJson(res, 400, { error: 'sessionId and action are required' })
      return
    }
    if (ctx.sessions.get(sessionId) === undefined) {
      sendJson(res, 404, { error: 'unknown-session' })
      return
    }
    const actions = ['mounted', 'inactive', 'shown', 'dismissed', 'accepted', 'conflict', 'blocked']
    if (!actions.includes(action) || (text !== undefined && text !== null &&
        (typeof text !== 'string' || text.length > config.maxSuggestionChars))) {
      sendJson(res, 400, { error: 'invalid-feedback' })
      return
    }
    const state = stateOf(sessionId)
    state.lastWatchedAt = now()
    if (action === 'accepted') {
      if (state.status !== 'ready' || turnSeq !== state.turnSeq || text !== state.text) {
        sendJson(res, 409, { error: 'stale-prediction' })
        return
      }
      state.accepted = { turnSeq, text, promptVersion: config.promptVersion }
    }
    // A dismissal in another window must not erase an actual acceptance.
    audit({
      kind: `feedback:${action}`,
      sessionId,
      turnSeq: typeof turnSeq === 'number' ? turnSeq : state.turnSeq,
      promptVersion: config.promptVersion,
      text: typeof text === 'string' ? text : null,
      ...(typeof body.reason === 'string' ? { reason: body.reason.slice(0, 80) } : {}),
      ...(action === 'inactive' ? {
        draftChars: body.draftChars, phase: body.phase, queue: body.queue,
        attachments: body.attachments, occurrences: body.occurrences,
      } : {}),
      // Ghost geometry, so a misplaced overlay is diagnosable from the log alone.
      ...(body.box !== undefined && body.box !== null ? { box: body.box } : {}),
    })
    sendJson(res, 200, { ok: true })
  }
}

// -----------------------------------------------------------------------------
// Local helpers
// -----------------------------------------------------------------------------

/** Text of the user's most recent real turn, used to reject a restated message. */
function lastUserText(messages) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message === undefined || message === null || message.role !== 'user') continue
    const text = messageText(message).trim()
    if (text.length > 0) return text
  }
  return ''
}

/** Race external work against cancellation even if its adapter ignores the signal. */
function abortable(promise, signal) {
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason ?? new Error('aborted'))
    const cleanup = () => signal.removeEventListener('abort', abort)
    Promise.resolve(promise).then(
      value => { cleanup(); resolve(value) },
      error => { cleanup(); reject(error) },
    )
    if (signal.aborted) abort()
    else signal.addEventListener('abort', abort, { once: true })
  })
}

/** Size of one file in bytes, or 0 when it does not exist yet. */
async function fileSize(path) {
  try {
    return (await stat(path)).size
  } catch {
    return 0
  }
}

/** A logger call that never throws, because logging must not fail a prediction. */
function makeLogger(ctx) {
  return (level, message) => {
    try {
      const logger = ctx.logger
      const sink = logger?.[level]
      if (typeof sink === 'function') sink.call(logger, message)
    } catch {
      /* ignore */
    }
  }
}

/**
 * Keep only the token counts the browser and the audit log display.
 *
 * `@deepseek-ai/dsh-llm` reports provider cache hits as `cacheReadTokens`;
 * `cachedInputTokens` stays as an alias because that is the name other harness
 * adapters have used for the same number.
 */
function pickUsage(usage) {
  if (usage === undefined || usage === null || typeof usage !== 'object') return null
  const number = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : null)
  return {
    inputTokens: number(usage.inputTokens),
    outputTokens: number(usage.outputTokens),
    cachedInputTokens: number(usage.cacheReadTokens ?? usage.cachedInputTokens),
    cacheWriteTokens: number(usage.cacheWriteTokens),
    reasoningTokens: number(usage.reasoningTokens),
    totalTokens: number(usage.totalTokens),
  }
}

/** Text of a logged `user/message` payload, or null when it carries none. */
function messageTextOf(data) {
  if (data === undefined || data === null || !Array.isArray(data.content)) return null
  let text = ''
  for (const block of data.content) {
    if (block !== null && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string') {
      text += block.text
    }
  }
  return text.length === 0 ? null : text
}

/**
 * The log position of the session's most recent completed turn.
 *
 * The newest turn boundary decides: a trailing `turn/start` means the agent is
 * still working and there is nothing to predict yet, and a `turn/end` that did
 * not complete leaves nothing worth guessing. Reading the full snapshot is
 * deprecated but necessary here — the tail alone cannot prove which boundary
 * came last — and it runs at most once per page visit.
 *
 * @returns {number | null} the `turn/end` seq, or null when no completed turn
 *   is available.
 */
function lastPredictableTurnSeq(session) {
  try {
    const events = session.snapshotEvents()
    for (let index = events.length - 1; index >= 0; index -= 1) {
      const event = events[index]
      if (event.type === 'turn/start') return null
      if (event.type === 'user/message' &&
          (event.data?.source == null || event.data.source.kind === 'user')) return null
      if (event.type !== 'turn/end') continue
      if (!turnIsPredictable(event.data?.reason)) return null
      return event.seq
    }
    return null
  } catch {
    return null
  }
}

/** Levenshtein distance capped so a pathological pair cannot burn the loop. */
function boundedEditDistance(left, right, cap) {
  if (left === right) return 0
  if (Math.abs(left.length - right.length) > cap) return cap + 1
  const previous = new Array(right.length + 1)
  const current = new Array(right.length + 1)
  for (let index = 0; index <= right.length; index += 1) previous[index] = index
  for (let i = 1; i <= left.length; i += 1) {
    current[0] = i
    for (let j = 1; j <= right.length; j += 1) {
      const cost = left[i - 1] === right[j - 1] ? 0 : 1
      current[j] = Math.min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + cost)
    }
    for (let j = 0; j <= right.length; j += 1) previous[j] = current[j]
  }
  return previous[right.length]
}

/** Write one JSON response. */
function sendJson(res, status, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  })
  res.end(body)
}

/** Read a small JSON request body; returns undefined for malformed input. */
async function readJsonBody(req) {
  const chunks = []
  let size = 0
  try {
    for await (const chunk of req) {
      size += chunk.length
      if (size > MAX_BODY_BYTES) return undefined
      chunks.push(chunk)
    }
    if (size === 0) return undefined
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : undefined
  } catch {
    return undefined
  }
}
