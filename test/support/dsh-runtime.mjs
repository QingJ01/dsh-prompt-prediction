// Integration fixtures exercise exact functions from the locally extracted DSH
// runtime. They are not substitutes or reimplementations of its HTTP/LLM bridge.
import { readFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { Readable } from 'node:stream'
import { apply } from '../../lib/index.js'

export const extractedRoot = process.env.DSH_EXTRACTED_ROOT ?? '/tmp/dshx'
export function readRuntime(pkg) {
  return readFileSync(`${extractedRoot}/${pkg}/lib/index.js`, 'utf8')
}
function topFunction(source, name) {
  const start = source.indexOf(`function ${name}(`)
  if (start < 0) throw Error(`DSH function ${name} not found`)
  const end = source.indexOf('\n}', start)
  return (source.slice(start - 6, start) === 'async ' ? 'async ' : '') + source.slice(start, end + 2)
}
function classMethod(source, signature, nextSignature) {
  const start = source.indexOf(signature)
  const end = source.indexOf(nextSignature, start + signature.length)
  if (start < 0 || end < 0) throw Error(`DSH method ${signature} not found`)
  return `function ${source.slice(start, end).trim()}`
}
export function loadRuntimeBoundaries() {
  const connection = readRuntime('dsh-client-connection')
  const llm = readRuntime('dsh-llm')
  const bridge = new Function('Readable', 'DEFAULT_MAX_REQUEST_BODY_BYTES', `return ${topFunction(connection, 'bridge')}`)(Readable, 300 * 1024 * 1024)
  const endpointGrammar = connection.match(/const ENDPOINT_SEGMENT_PATTERN = [^\n]+/)[0]
  const endpoint = new Function(`${endpointGrammar}\nreturn ${topFunction(connection, 'endpointFromPath')}`)()
  const shared = new Function('endpointFromPath', `return ${classMethod(connection, 'createSharedFetchHandler(channel)', '\n\tregisterFetchRoute(')}`)(endpoint)
  const forAdapter = new Function('freezeMessage', 'deepFreeze', `return ${classMethod(llm, 'forAdapter(options, adapter)', '\n\t\t/**')}`)(Object.freeze, Object.freeze)
  return { bridge, shared, forAdapter }
}
export async function createHostFixture({ override = false, suggestionText = '跑一下测试吧' } = {}) {
  const runtime = loadRuntimeBoundaries()
  const routes = new Map()
  const events = new Map()
  const requests = []
  const adapter = {}
  let turnSeq = 9
  const session = {
    id: 'review-session', header: { isSeeded: false },
    requestHeader: () => ({ config: { provider: 'original', model: 'original-model' }, tools: [] }),
    deriveMessages: () => [
      { id: 'u1', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '帮我修复构建' }] },
      { id: 'a1', role: 'assistant', source: { kind: 'model', provider: 'original', model: 'original-model', replayState: { private: true } }, content: [{ type: 'text', text: '已修复，请验证。' }] },
    ],
    toolHistory: () => ({ tools: [{ name: 'old_tool', parameters: { type: 'object' } }], updates: [] }),
    snapshotEvents: () => [{ type: 'turn/end', seq: turnSeq, data: { reason: { kind: 'completed' } } }],
  }
  const owner = {
    fetchRoutes: routes, interceptors: new Map(),
  }
  const ctx = {
    on(event, callback) { events.set(event, callback) },
    effect(factory) { return factory() },
    sessions: { get: id => ['first', 'other', session.id].includes(id) ? { ...session, id } : undefined },
    connection: { fetch: { register(route) { routes.set(route.path, { ...route, methods: new Set(route.methods) }) } } },
    llm: {
      async prepareCall(config) {
        return { config, async *stream(options) {
          // Run the actual DSH provenance boundary before simulated provider I/O.
          const projected = runtime.forAdapter.call({ adapters: new Map([['original', { adapter }]]) }, options, adapter)
          requests.push(projected)
          yield { type: 'text-delta', text: JSON.stringify({ suggestion: options.sessionId === 'other' ? '另一个会话的预测' : suggestionText }) }
          yield { type: 'finish', reason: { kind: 'stop' } }
        } }
      },
    },
  }
  apply(ctx, { auditLog: false, ...(override ? { provider: 'alternate', model: 'alternate-model' } : {}) })
  const handler = runtime.shared.call(owner, '/api')
  const server = createServer(async (req, res) => {
    try {
      // A fixture admission identity; authentication itself belongs to DSH.
      if (req.headers['x-review-principal'] === 'none') { res.writeHead(401); res.end(); return }
      const principal = req.headers['x-review-principal'] === 'guest' ? 'guest' : 'owner'
      await runtime.bridge(req, res, handler, { principal: { kind: principal } })
    } catch (error) { res.writeHead(500); res.end(String(error)) }
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const origin = `http://127.0.0.1:${server.address().port}`
  return {
    origin, routes, requests, runtime, handler,
    async close() { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) },
    startTurn(id = session.id) { events.get('session/event')({ ...session, id }, { type: 'turn/start', seq: ++turnSeq, data: {} }) },
    endTurn(id = session.id) { events.get('session/event')({ ...session, id }, { type: 'turn/end', seq: ++turnSeq, data: { reason: { kind: 'completed' } } }) },
  }
}
