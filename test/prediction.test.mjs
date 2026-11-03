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
  reasoningEffortPolicy,
  stripFences,
  styleExemplars,
  turnIsPredictable,
} from '../lib/prediction.js'

test('normalizeConfig applies defaults and drops half a route', () => {
  const defaults = normalizeConfig(undefined)
  assert.equal(defaults.enabled, true)
  assert.equal(defaults.provider, null)
  assert.equal(defaults.model, null)
  assert.equal(defaults.maxOutputTokens, 1000)
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
  // Paragraph breaks survive (a prediction may be multi-paragraph, like Codex's
  // parsed prompt text); runs of spaces inside a paragraph collapse.
  assert.deepEqual(parseSuggestion('{"suggestion":"  run\\n\\n the   tests  "}', { maxSuggestionChars: 100 }), {
    ok: true,
    text: 'run\nthe tests',
  })
  assert.deepEqual(parseSuggestion('{"suggestion":"run   the   tests"}', { maxSuggestionChars: 100 }), {
    ok: true,
    text: 'run the tests',
  })
  assert.equal(parseSuggestion('{"suggestion":"a\\nb\\nc\\nd"}', { maxLines: 2 }).text, 'a\nb')
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
  // Behavioural rules added after reviewing real predictions.
  assert.match(instruction, /ONE short sentence/)
  assert.match(instruction, /Never output credentials/)
  assert.match(instruction, /Do not restate the user's own previous message/)
  assert.match(instruction, /Abstaining is expected/)
})

test('the instruction carries the user as a style anchor, not as new context', () => {
  const plain = predictionInstruction()
  const anchored = predictionInstruction({ exemplars: ['先把 iOS 这条接起来，开个独立 PR'] })
  assert.ok(!plain.includes('Style anchors'))
  assert.match(anchored, /Style anchors/)
  assert.ok(anchored.includes('先把 iOS 这条接起来'))
  assert.ok(anchored.length - plain.length < 300, 'anchors stay cheap')
})

test('styleExemplars keeps the user\'s own recent messages only', () => {
  const messages = [
    textMessage('system', 'SYSTEM'),
    textMessage('user', '先把 iOS 这条接起来，开个独立 PR'),
    textMessage('assistant', '好的，已经开好'),
    textMessage('user', '/compact'),
    textMessage('user', '再做一轮对抗审查，重点把 Desktop IPC 这条也跑通'),
    textMessage('user', '  再做一轮对抗审查，重点把 Desktop IPC 这条也跑通  '),
  ]
  const anchors = styleExemplars(messages, 3, 120)
  assert.deepEqual(anchors, [
    '先把 iOS 这条接起来，开个独立 PR',
    '再做一轮对抗审查，重点把 Desktop IPC 这条也跑通',
  ], 'assistant text, commands and duplicates are skipped')
  assert.equal(styleExemplars(messages, 0).length, 0)
  assert.equal(styleExemplars(undefined).length, 0)
})

test('a credential-shaped guess is dropped instead of shown', () => {
  // Regression: real output was `验证码：123456` while npm 2FA was in context.
  for (const value of ['验证码：123456', '验证码 123456', 'password: hunter2', 'otp=918273', 'sk-abcdefghijklmnopqrstuvwx']) {
    const result = parseSuggestion(JSON.stringify({ suggestion: value }))
    assert.equal(result.ok, false, value)
    assert.equal(result.reason, 'credential-shaped', value)
  }
  // Merely mentioning the word is fine; only an invented value is refused.
  const benign = parseSuggestion(JSON.stringify({ suggestion: '继续推进，验证码那步我来处理' }))
  assert.equal(benign.ok, true)
})

test('markdown decoration and wrapping quotes never reach the composer', () => {
  assert.equal(parseSuggestion(JSON.stringify({ suggestion: '**跑一下测试**' })).text, '跑一下测试')
  assert.equal(parseSuggestion(JSON.stringify({ suggestion: '“好，先跑测试”' })).text, '好，先跑测试')
  assert.equal(parseSuggestion(JSON.stringify({ suggestion: '「继续」' })).text, '继续')
})

test('a restated user message is not a prediction', () => {
  const lastUserText = '再做一轮对抗审查，重点把 Desktop IPC 这条也跑通，版本号别改。'
  const result = parseSuggestion(
    JSON.stringify({ suggestion: '再做一轮对抗审查，重点把 Desktop IPC 这条也跑通，版本号别改' }),
    { lastUserText },
  )
  assert.equal(result.ok, false)
  assert.equal(result.reason, 'repeated-user')
  const different = parseSuggestion(
    JSON.stringify({ suggestion: '再跑一遍测试确认' }),
    { lastUserText },
  )
  assert.equal(different.ok, true)
})

test('a multi-paragraph guess keeps its paragraphs and respects the cap', () => {
  const two = parseSuggestion(JSON.stringify({ suggestion: '先跑测试\n再提交 PR' }))
  assert.equal(two.ok, true)
  assert.equal(two.text, '先跑测试\n再提交 PR', 'acceptance inserts the whole draft')

  const many = parseSuggestion(JSON.stringify({ suggestion: '一\n二\n三\n四\n五' }), { maxLines: 3 })
  assert.equal(many.text, '一\n二\n三')
  assert.equal(many.text.split('\n').length, 3)

  // Blank paragraphs never produce empty lines in the composer.
  const sparse = parseSuggestion(JSON.stringify({ suggestion: 'a\n\n\n b ' }))
  assert.equal(sparse.text, 'a\nb')
})

test('reasoning effort inherits by default instead of forcing the cheapest tier', () => {
  const model = { reasoning: { efforts: [{ id: 'low' }, { id: 'high' }] } }
  // Default policy must not downgrade a high-effort parent conversation.
  assert.equal(reasoningEffortPolicy('inherit')({ reasoningEffort: 'high' }, model).reasoningEffort, 'high')
  assert.equal(reasoningEffortPolicy(undefined)({ reasoningEffort: 'high' }, model).reasoningEffort, 'high')
  // The previous behaviour stays available on request.
  assert.equal(reasoningEffortPolicy('min')({ reasoningEffort: 'high' }, model).reasoningEffort, 'low')
  assert.equal(reasoningEffortPolicy('high')({ reasoningEffort: 'low' }, model).reasoningEffort, 'high')
  // An effort the model does not advertise leaves the call untouched.
  assert.equal(reasoningEffortPolicy('xhigh')({ reasoningEffort: 'low' }, model).reasoningEffort, 'low')
  assert.equal(normalizeConfig({}).reasoningEffort, 'inherit')
  assert.equal(normalizeConfig({ reasoningEffort: ' min ' }).reasoningEffort, 'min')
})

test('the instruction tells the model when abstaining is expected', () => {
  const instruction = predictionInstruction()
  assert.match(instruction, /Abstaining is expected/)
  assert.match(instruction, /open question/)
  assert.match(instruction, /generic filler/)
  assert.match(instruction, /worse than no suggestion/)
  assert.match(instruction, /short paragraphs/)
})
