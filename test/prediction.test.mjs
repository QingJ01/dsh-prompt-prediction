import assert from 'node:assert/strict'
import test from 'node:test'

import {
  PROMPT_VERSION,
  assembleChunks,
  compactHistory,
  extractJsonObject,
  historyChars,
  isDerivedSession,
  lastAssistantText,
  leastReasoningEffort,
  messageText,
  normalizeConfig,
  parseSuggestion,
  predictionInstruction,
  stripFences,
  turnIsPredictable,
} from '../lib/prediction.js'

test('normalizeConfig applies defaults and drops half a route', () => {
  const defaults = normalizeConfig(undefined)
  assert.equal(defaults.enabled, true)
  assert.equal(defaults.provider, null)
  assert.equal(defaults.model, null)
  assert.equal(defaults.maxOutputTokens, 1024)
  assert.equal(defaults.timeoutMs, 20000)
  assert.equal(defaults.promptVersion, PROMPT_VERSION)

  const halfRoute = normalizeConfig({ provider: 'deepseek-official' })
  assert.equal(halfRoute.provider, null, 'a provider without a model must not become a route')
  assert.equal(halfRoute.model, null)

  const full = normalizeConfig({ provider: 'p', model: 'm', maxOutputTokens: 32.9, timeoutMs: 0 })
  assert.equal(full.provider, 'p')
  assert.equal(full.model, 'm')
  assert.equal(full.maxOutputTokens, 32)
  assert.equal(full.timeoutMs, 20000, 'non-positive timeout falls back')

  assert.equal(normalizeConfig({ enabled: false }).enabled, false)
  assert.equal(normalizeConfig(null).enabled, true)
})

test('turnIsPredictable only accepts completed turns', () => {
  assert.equal(turnIsPredictable({ kind: 'completed' }), true)
  for (const kind of ['aborted', 'blocked', 'error', 'max-tokens', 'interrupted', 'forked']) {
    assert.equal(turnIsPredictable({ kind }), false, kind)
  }
  assert.equal(turnIsPredictable(undefined), false)
})

test('positive configuration rejects fractions that would round down to zero', () => {
  const keys = ['maxOutputTokens', 'timeoutMs', 'maxSuggestionChars', 'compactTurns', 'eagerWindowMs']
  const defaults = normalizeConfig({})
  for (const value of [0.5, Number.MIN_VALUE, 0, -1, NaN, Infinity]) {
    const config = normalizeConfig(Object.fromEntries(keys.map(key => [key, value])))
    for (const key of keys) assert.equal(config[key], defaults[key], `${key}: ${value}`)
  }
  const config = normalizeConfig(Object.fromEntries(keys.map(key => [key, 1.9])))
  for (const key of keys) assert.equal(config[key], 1)
})

test('isDerivedSession rejects subagent children and fork seeds', () => {
  assert.equal(isDerivedSession(undefined), false)
  assert.equal(isDerivedSession({ isSeeded: false }), false)
  assert.equal(isDerivedSession({ origin: 'subagent' }), true)
  assert.equal(isDerivedSession({ delegationDepth: 1 }), true)
  assert.equal(isDerivedSession({ parentSession: 'p' }), true)
  assert.equal(isDerivedSession({ delegationDepth: 0 }), false)
})

const textMessage = (role, text) => ({ role, content: [{ type: 'text', text }] })

test('messageText concatenates text blocks and ignores the rest', () => {
  assert.equal(messageText(textMessage('user', 'hello')), 'hello')
  assert.equal(messageText({ role: 'assistant', content: [{ type: 'reasoning', text: 'x' }, { type: 'text', text: 'a' }, { type: 'tool-call' }] }), 'a')
  assert.equal(messageText(undefined), '')
  assert.equal(messageText({ role: 'user', content: 'not-an-array' }), '')
})

test('compactHistory keeps the last N turns of plain text', () => {
  const messages = [
    { role: 'system', content: [{ type: 'text', text: 'SYSTEM' }] },
    textMessage('user', 'first'),
    textMessage('assistant', 'answer one'),
    { role: 'tool', content: [{ type: 'text', text: 'tool output' }] },
    textMessage('user', 'second'),
    textMessage('assistant', 'answer two'),
    textMessage('user', 'third'),
    textMessage('assistant', 'answer three'),
  ]
  const compact = compactHistory(messages, 2)
  assert.deepEqual(
    compact.map((m) => `${m.role}:${m.content[0].text}`),
    ['user:second', 'assistant:answer two', 'user:third', 'assistant:answer three'],
    'two user turns, tool and system rows dropped',
  )
  assert.ok(compact.every((m) => Array.isArray(m.content) && m.content[0].type === 'text'))
})

test('compactHistory never rewrites message order', () => {
  const messages = [textMessage('user', 'a'), textMessage('assistant', 'b'), textMessage('user', 'c')]
  assert.deepEqual(
    compactHistory(messages, 5).map((m) => m.role),
    ['user', 'assistant', 'user'],
  )
})

test('lastAssistantText finds the final assistant reply', () => {
  assert.equal(lastAssistantText([textMessage('user', 'a'), textMessage('assistant', ' b ')]), 'b')
  assert.equal(lastAssistantText([textMessage('user', 'a')]), '')
  assert.equal(lastAssistantText([]), '')
})

test('lastAssistantText skips tool-only assistant steps', () => {
  // A step that calls tools carries reasoning + tool-call blocks and no text;
  // the prediction must look past it to the last thing the assistant said.
  const messages = [
    textMessage('user', 'fix the build'),
    textMessage('assistant', 'Let me look at the failing test.'),
    { role: 'assistant', content: [{ type: 'reasoning', text: 'thinking' }, { type: 'tool-call', name: 'bash' }] },
  ]
  assert.equal(lastAssistantText(messages), 'Let me look at the failing test.')

  const noSpeech = [
    textMessage('user', 'go'),
    { role: 'assistant', content: [{ type: 'tool-call', name: 'bash' }] },
  ]
  assert.equal(lastAssistantText(noSpeech), '')
})

test('historyChars sums visible characters', () => {
  assert.equal(historyChars([textMessage('user', 'abc'), textMessage('assistant', 'de')]), 5)
})

test('stripFences unwraps fenced JSON', () => {
  assert.equal(stripFences('```json\n{"a":1}\n```'), '{"a":1}')
  assert.equal(stripFences('```\n{"a":1}'), '{"a":1}')
  assert.equal(stripFences('{"a":1}'), '{"a":1}')
  assert.equal(stripFences('```'), '')
})

test('extractJsonObject tolerates prose around the payload', () => {
  assert.deepEqual(extractJsonObject('Sure: {"suggestion":"ok"} hope that helps'), { suggestion: 'ok' })
  assert.equal(extractJsonObject('no json here'), undefined)
  assert.equal(extractJsonObject('{"broken":'), undefined)
  assert.equal(extractJsonObject('[1,2]'), undefined)
  assert.equal(extractJsonObject('null'), undefined)
})

test('parseSuggestion accepts a plain suggestion', () => {
  const result = parseSuggestion('{"suggestion":"run the tests"}')
  assert.deepEqual(result, { ok: true, text: 'run the tests' })
})

test('parseSuggestion normalizes whitespace and trims to the cap', () => {
  assert.deepEqual(parseSuggestion('{"suggestion":"  run\\n\\n the   tests  "}', { maxSuggestionChars: 100 }), {
    ok: true,
    text: 'run the tests',
  })
  const long = parseSuggestion(JSON.stringify({ suggestion: 'x'.repeat(50) }), { maxSuggestionChars: 10 })
  assert.equal(long.ok, true)
  assert.equal(long.text.length, 10)
})

test('parseSuggestion rejects the model declining', () => {
  assert.deepEqual(parseSuggestion('{"suggestion":null}'), { ok: false, reason: 'declined' })
})

test('suggestion truncation preserves complete Unicode surrogate pairs', () => {
  for (const character of ['😀', '𠮷']) {
    const split = parseSuggestion(JSON.stringify({ suggestion: 'a'.repeat(199) + character }))
    assert.deepEqual(split, { ok: true, text: 'a'.repeat(199) })
    assert.ok(split.text.isWellFormed())
    const fits = parseSuggestion(JSON.stringify({ suggestion: 'a'.repeat(198) + character + 'x' }))
    assert.equal(fits.text, 'a'.repeat(198) + character)
    assert.ok(fits.text.isWellFormed())
    assert.deepEqual(parseSuggestion(JSON.stringify({ suggestion: character }), { maxSuggestionChars: 1 }), {
      ok: false, reason: 'blank-suggestion',
    })
  }
})

test('parseSuggestion rejects unusable payloads', () => {
  assert.deepEqual(parseSuggestion(''), { ok: false, reason: 'empty-output' })
  assert.deepEqual(parseSuggestion('not json'), { ok: false, reason: 'invalid-json' })
  assert.deepEqual(parseSuggestion('{"suggestion":42}'), { ok: false, reason: 'invalid-shape' })
  assert.deepEqual(parseSuggestion('{"suggestion":"   "}'), { ok: false, reason: 'blank-suggestion' })
  assert.deepEqual(parseSuggestion('{"suggestion":"/goal"}'), { ok: false, reason: 'reserved-lead' })
  assert.deepEqual(parseSuggestion('{"suggestion":"@file"}'), { ok: false, reason: 'reserved-lead' })
})

test('parseSuggestion rejects an echo of the assistant reply', () => {
  const raw = JSON.stringify({ suggestion: 'The tests all pass.' })
  assert.deepEqual(parseSuggestion(raw, { previousAssistantText: 'The tests all pass.' }), {
    ok: false,
    reason: 'echoed-assistant',
  })
  assert.deepEqual(parseSuggestion(raw, { previousAssistantText: 'Something else.' }), {
    ok: true,
    text: 'The tests all pass.',
  })
})

test('leastReasoningEffort picks the first advertised effort', () => {
  const controls = { maxTokens: 10 }
  const picked = leastReasoningEffort(controls, { reasoning: { efforts: [{ id: 'low' }, { id: 'high' }] } })
  assert.deepEqual(picked, { maxTokens: 10, reasoningEffort: 'low' })
  assert.equal(leastReasoningEffort(controls, {}), controls, 'no efforts leaves controls untouched')
})

test('assembleChunks joins text and records the terminal finish', () => {
  const result = assembleChunks([
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text: '{"sug' },
    { type: 'text-delta', index: 0, text: 'gestion":"hi"}' },
    { type: 'usage', usage: { inputTokens: 100, cachedInputTokens: 90, outputTokens: 8 } },
    { type: 'finish', reason: { kind: 'stop' } },
  ])
  assert.equal(result.text, '{"suggestion":"hi"}')
  assert.equal(result.finish.kind, 'stop')
  assert.equal(result.usage.cachedInputTokens, 90)
  assert.equal(result.toolCall, false)
})

test('assembleChunks flags a tool call and keeps an error finish', () => {
  const toolCall = assembleChunks([
    { type: 'block-end', index: 0, block: { type: 'tool-call', name: 'x' } },
    { type: 'finish', reason: { kind: 'tool-calls' } },
  ])
  assert.equal(toolCall.toolCall, true)

  const failed = assembleChunks([{ type: 'finish', reason: { kind: 'error', failure: { code: 'AUTH' } } }])
  assert.equal(failed.finish.kind, 'error')
  assert.equal(failed.toolCall, false)
})

test('the instruction asks for JSON and forbids work', () => {
  const instruction = predictionInstruction()
  assert.match(instruction, /"suggestion"/)
  assert.match(instruction, /Do not call tools/)
  assert.match(instruction, /most likely to type/)
  assert.ok(instruction.length < 1200, 'instruction stays small enough to be cheap')
})
